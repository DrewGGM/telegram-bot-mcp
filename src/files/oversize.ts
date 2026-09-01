import { spawn } from "node:child_process";
import { statSync, openSync, readSync, writeSync, closeSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config/config.js";
import { log } from "../logger.js";

/**
 * Handling for files above Telegram's 50 MB bot-upload limit (FR-13: "offer to
 * compress or split").
 *
 * Video is re-encoded to fit, because a compressed video is still watchable on a
 * phone whereas half a video is useless. Everything else is split losslessly into
 * parts you rejoin on the PC.
 */

const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg"]);

export function isVideo(filePath: string): boolean {
  return VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * Bitrate (kbps) for the video stream so that video+audio lands just under
 * `targetBytes`. Returns 0 when the budget cannot fit even a minimal stream.
 */
export function computeVideoBitrateKbps(
  durationSec: number,
  targetBytes: number,
  audioKbps = 128,
): number {
  if (!(durationSec > 0) || !(targetBytes > 0)) return 0;
  const totalKbps = (targetBytes * 8) / durationSec / 1000;
  const videoKbps = Math.floor(totalKbps - audioKbps);
  return videoKbps > 100 ? videoKbps : 0;
}

export interface SplitPart {
  index: number;
  total: number;
  start: number;
  end: number; // exclusive
}

/** Plan contiguous byte ranges, each at most `chunkSize`. */
export function planSplit(size: number, chunkSize: number): SplitPart[] {
  if (size <= 0 || chunkSize <= 0) return [];
  const total = Math.ceil(size / chunkSize);
  const parts: SplitPart[] = [];
  for (let i = 0; i < total; i++) {
    parts.push({
      index: i + 1,
      total,
      start: i * chunkSize,
      end: Math.min(size, (i + 1) * chunkSize),
    });
  }
  return parts;
}

export interface OversizePlan {
  kind: "compressed" | "split" | "failed";
  /** Absolute paths to deliver, in order. */
  files: string[];
  /** Human explanation to show alongside the delivery. */
  note: string;
  /** Directory to remove once the files have been sent. */
  cleanupDir?: string;
}

function run(cmd: string, args: string[], timeoutMs = 20 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (c) => (out += c));
    child.stderr?.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, out });
    });
  });
}

async function probeDurationSec(filePath: string): Promise<number> {
  const { code, out } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    60_000,
  );
  if (code !== 0) return 0;
  const n = Number(String(out).trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : 0;
}

async function hasNvenc(): Promise<boolean> {
  const { out } = await run("ffmpeg", ["-hide_banner", "-encoders"], 60_000);
  return /h264_nvenc/.test(out);
}

/** Re-encode a video to fit under `limit`. Returns the new path, or null. */
async function compressVideo(filePath: string, limit: number, workDir: string): Promise<string | null> {
  const duration = await probeDurationSec(filePath);
  if (duration <= 0) return null;

  const gpu = await hasNvenc();
  // Two attempts: the first aims just under the limit, the second backs off and
  // caps resolution, because a bitrate target is not an exact size guarantee.
  const attempts = [
    { headroom: 0.92, scale: null as string | null },
    { headroom: 0.75, scale: "scale=-2:min(720\,ih)" },
  ];

  for (const [i, a] of attempts.entries()) {
    const kbps = computeVideoBitrateKbps(duration, limit * a.headroom);
    if (kbps <= 0) return null;
    const out = path.join(workDir, `${path.parse(filePath).name}_compressed${i}.mp4`);
    const args = [
      "-y", "-i", filePath,
      ...(a.scale ? ["-vf", a.scale] : []),
      "-c:v", gpu ? "h264_nvenc" : "libx264",
      "-b:v", `${kbps}k`,
      "-maxrate", `${Math.floor(kbps * 1.3)}k`,
      "-bufsize", `${kbps * 2}k`,
      ...(gpu ? ["-preset", "p4"] : ["-preset", "veryfast"]),
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      out,
    ];
    log.info({ filePath, kbps, gpu, attempt: i + 1 }, "compressing oversize video");
    const { code } = await run("ffmpeg", args);
    if (code === 0) {
      try {
        if (statSync(out).size <= limit) return out;
      } catch {
        /* fall through to next attempt */
      }
    }
  }
  return null;
}

/** Split a file into `limit`-sized parts inside `workDir`. */
function splitFile(filePath: string, limit: number, workDir: string): string[] {
  const size = statSync(filePath).size;
  const chunk = Math.floor(limit * 0.95);
  const parts = planSplit(size, chunk);
  const base = path.basename(filePath);
  const fd = openSync(filePath, "r");
  const outPaths: string[] = [];
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (const p of parts) {
      const outPath = path.join(workDir, `${base}.part${String(p.index).padStart(2, "0")}of${p.total}`);
      const outFd = openSync(outPath, "w");
      try {
        let pos = p.start;
        while (pos < p.end) {
          const want = Math.min(buf.length, p.end - pos);
          const read = readSync(fd, buf, 0, want, pos);
          if (read <= 0) break;
          writeSync(outFd, buf, 0, read);
          pos += read;
        }
      } finally {
        closeSync(outFd);
      }
      outPaths.push(outPath);
    }
  } finally {
    closeSync(fd);
  }
  return outPaths;
}

/**
 * Prepare an oversize file for delivery: compress if it is video, otherwise
 * split. The caller sends `files` in order and then removes `cleanupDir`.
 */
export async function prepareOversize(filePath: string, limit: number): Promise<OversizePlan> {
  const workDir = path.join(DATA_DIR, "oversize", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workDir, { recursive: true });
  const original = statSync(filePath).size;

  if (isVideo(filePath)) {
    const compressed = await compressVideo(filePath, limit, workDir);
    if (compressed) {
      const newSize = statSync(compressed).size;
      return {
        kind: "compressed",
        files: [compressed],
        cleanupDir: workDir,
        note:
          `Compressed to fit Telegram's 50 MB limit ` +
          `(${mb(original)} -> ${mb(newSize)}). This is a preview; the original is at:\n${filePath}`,
      };
    }
    log.warn({ filePath }, "video compression failed, falling back to split");
  }

  try {
    const parts = splitFile(filePath, limit, workDir);
    return {
      kind: "split",
      files: parts,
      cleanupDir: workDir,
      note:
        `Too big for Telegram (${mb(original)}), so it is split into ${parts.length} parts.\n` +
        `Rejoin on the PC with:\n  copy /b "${parts.map((p) => path.basename(p)).join('"+"')}" "${path.basename(filePath)}"`,
    };
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    return { kind: "failed", files: [], note: `Could not prepare the file: ${String(err)}` };
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
