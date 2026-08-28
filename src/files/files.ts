import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { isPathAllowed } from "../security/paths.js";

/**
 * Deterministic file operations for the bot's /ls, /find, /get and upload flows
 * (FR-12/13/14). Every path is validated against the folder allowlist BEFORE any
 * FS access, so these commands never reach outside the permitted directories —
 * no LLM involved (§3.2).
 */

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface FileResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** List the immediate contents of an allowed directory. */
export function listDir(target: string, allowedDirs: readonly string[]): FileResult<DirEntry[]> {
  const check = isPathAllowed(target, allowedDirs);
  if (!check.allowed) return { ok: false, error: check.reason ?? "not allowed" };
  if (!existsSync(check.resolved)) return { ok: false, error: "path does not exist" };
  const st = statSync(check.resolved);
  if (!st.isDirectory()) return { ok: false, error: "not a directory" };

  const entries: DirEntry[] = readdirSync(check.resolved, { withFileTypes: true }).map((d) => {
    const full = path.join(check.resolved, d.name);
    let size = 0;
    try {
      size = d.isFile() ? statSync(full).size : 0;
    } catch {
      size = 0;
    }
    return { name: d.name, path: full, isDir: d.isDirectory(), size };
  });
  // Directories first, then files, both alphabetical.
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { ok: true, value: entries };
}

/** Recursively search allowed dirs for files whose name contains `query`. */
export function findFiles(
  query: string,
  allowedDirs: readonly string[],
  opts: { limit?: number; maxDepth?: number } = {},
): DirEntry[] {
  const limit = opts.limit ?? 50;
  const maxDepth = opts.maxDepth ?? 6;
  const needle = query.toLowerCase().trim();
  const results: DirEntry[] = [];
  if (!needle) return results;

  const walk = (dir: string, depth: number): void => {
    if (results.length >= limit || depth > maxDepth) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (results.length >= limit) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        walk(full, depth + 1);
      } else if (d.name.toLowerCase().includes(needle)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          size = 0;
        }
        results.push({ name: d.name, path: full, isDir: false, size });
      }
    }
  };

  for (const dir of allowedDirs) {
    const check = isPathAllowed(dir, allowedDirs);
    if (check.allowed && existsSync(check.resolved)) walk(check.resolved, 0);
  }
  return results.slice(0, limit);
}

/** Validate a file path for sending to the user (/get, telegram_send_file). */
export function resolveForGet(
  target: string,
  allowedDirs: readonly string[],
): FileResult<{ path: string; size: number }> {
  const check = isPathAllowed(target, allowedDirs);
  if (!check.allowed) return { ok: false, error: check.reason ?? "not allowed" };
  if (!existsSync(check.resolved)) return { ok: false, error: "file does not exist" };
  const st = statSync(check.resolved);
  if (!st.isFile()) return { ok: false, error: "not a regular file" };
  return { ok: true, value: { path: check.resolved, size: st.size } };
}

/** Validate a destination directory + filename for an uploaded file (FR-14). */
export function resolveUploadTarget(
  dir: string,
  filename: string,
  allowedDirs: readonly string[],
): FileResult<{ path: string }> {
  // Reject filenames that try to traverse; keep only the basename.
  const base = path.basename(filename);
  if (!base || base === "." || base === "..") return { ok: false, error: "invalid filename" };
  const dest = path.join(dir, base);
  const check = isPathAllowed(dest, allowedDirs);
  if (!check.allowed) return { ok: false, error: check.reason ?? "not allowed" };
  return { ok: true, value: { path: check.resolved } };
}

/** Telegram hard limits (bytes): 50 MB bot upload, 20 MB bot download. */
export const TELEGRAM_SEND_LIMIT = 50 * 1024 * 1024;
export const TELEGRAM_RECEIVE_LIMIT = 20 * 1024 * 1024;
