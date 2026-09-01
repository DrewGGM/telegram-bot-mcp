import { describe, it, expect } from "vitest";
import { isVideo, computeVideoBitrateKbps, planSplit } from "./oversize.js";

/** FR-13: files over Telegram's limit are compressed (video) or split (rest). */
describe("isVideo", () => {
  it("recognizes common video containers", () => {
    for (const f of ["a.mp4", "B.MOV", "c.mkv", "d.webm", "e.m4v"]) {
      expect(isVideo(f)).toBe(true);
    }
  });
  it("rejects non-video", () => {
    for (const f of ["a.pdf", "b.zip", "c.png", "d", "e.mp3"]) {
      expect(isVideo(f)).toBe(false);
    }
  });
});

describe("computeVideoBitrateKbps", () => {
  it("fits the budget: encoded size lands under the target", () => {
    const durationSec = 255; // 4:15
    const target = 46 * 1024 * 1024;
    const v = computeVideoBitrateKbps(durationSec, target, 128);
    // video + audio must not exceed the budget
    const predictedBytes = ((v + 128) * 1000 * durationSec) / 8;
    expect(predictedBytes).toBeLessThanOrEqual(target);
    expect(v).toBeGreaterThan(100);
  });

  it("scales with duration: a longer video gets a lower bitrate", () => {
    const target = 46 * 1024 * 1024;
    expect(computeVideoBitrateKbps(600, target)).toBeLessThan(computeVideoBitrateKbps(120, target));
  });

  it("returns 0 when the budget cannot fit a usable stream", () => {
    expect(computeVideoBitrateKbps(100000, 1024 * 1024)).toBe(0);
    expect(computeVideoBitrateKbps(0, 1024)).toBe(0);
    expect(computeVideoBitrateKbps(60, 0)).toBe(0);
  });
});

describe("planSplit", () => {
  it("covers the whole file with no gaps or overlaps", () => {
    const size = 79 * 1024 * 1024;
    const chunk = 47 * 1024 * 1024;
    const parts = planSplit(size, chunk);
    expect(parts[0].start).toBe(0);
    expect(parts.at(-1)!.end).toBe(size);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].start).toBe(parts[i - 1].end); // contiguous
    }
    const covered = parts.reduce((n, p) => n + (p.end - p.start), 0);
    expect(covered).toBe(size);
  });

  it("keeps every part within the chunk size", () => {
    const chunk = 1000;
    for (const p of planSplit(3500, chunk)) {
      expect(p.end - p.start).toBeLessThanOrEqual(chunk);
    }
  });

  it("numbers parts 1..total", () => {
    const parts = planSplit(3500, 1000);
    expect(parts.map((p) => p.index)).toEqual([1, 2, 3, 4]);
    expect(parts.every((p) => p.total === 4)).toBe(true);
  });

  it("returns a single part when the file already fits", () => {
    expect(planSplit(500, 1000)).toHaveLength(1);
  });

  it("handles degenerate input", () => {
    expect(planSplit(0, 100)).toEqual([]);
    expect(planSplit(100, 0)).toEqual([]);
  });
});
