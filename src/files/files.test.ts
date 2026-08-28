import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDir, findFiles, resolveForGet, resolveUploadTarget } from "./files.js";

let root: string;
let allowed: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "tbm-files-"));
  allowed = path.join(root, "allowed");
  outside = path.join(root, "outside");
  mkdirSync(path.join(allowed, "sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(allowed, "invoice-july.pdf"), "x".repeat(100));
  writeFileSync(path.join(allowed, "notes.txt"), "hello");
  writeFileSync(path.join(allowed, "sub", "invoice-august.pdf"), "y".repeat(50));
  writeFileSync(path.join(outside, "secret.pdf"), "z");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("listDir", () => {
  it("lists entries with dirs first", () => {
    const r = listDir(allowed, [allowed]);
    expect(r.ok).toBe(true);
    expect(r.value![0].name).toBe("sub");
    expect(r.value!.some((e) => e.name === "notes.txt")).toBe(true);
  });

  it("refuses a directory outside the allowlist", () => {
    expect(listDir(outside, [allowed]).ok).toBe(false);
  });

  it("errors on a non-directory", () => {
    expect(listDir(path.join(allowed, "notes.txt"), [allowed]).ok).toBe(false);
  });
});

describe("findFiles", () => {
  it("finds files by case-insensitive substring across subdirs", () => {
    const hits = findFiles("INVOICE", [allowed]);
    const names = hits.map((h) => h.name).sort();
    expect(names).toEqual(["invoice-august.pdf", "invoice-july.pdf"]);
  });

  it("never returns files outside the allowlist", () => {
    const hits = findFiles("secret", [allowed]);
    expect(hits).toHaveLength(0);
  });

  it("respects the result limit", () => {
    expect(findFiles("invoice", [allowed], { limit: 1 })).toHaveLength(1);
  });

  it("returns nothing for an empty query", () => {
    expect(findFiles("   ", [allowed])).toHaveLength(0);
  });
});

describe("resolveForGet", () => {
  it("accepts an allowed file and reports its size", () => {
    const r = resolveForGet(path.join(allowed, "invoice-july.pdf"), [allowed]);
    expect(r.ok).toBe(true);
    expect(r.value!.size).toBe(100);
  });

  it("rejects a file outside the allowlist", () => {
    expect(resolveForGet(path.join(outside, "secret.pdf"), [allowed]).ok).toBe(false);
  });

  it("rejects a directory", () => {
    expect(resolveForGet(allowed, [allowed]).ok).toBe(false);
  });

  it("rejects a missing file", () => {
    expect(resolveForGet(path.join(allowed, "nope.pdf"), [allowed]).ok).toBe(false);
  });
});

describe("resolveUploadTarget", () => {
  it("builds a safe destination inside the allowlist", () => {
    const r = resolveUploadTarget(allowed, "report.pdf", [allowed]);
    expect(r.ok).toBe(true);
    expect(r.value!.path.endsWith("report.pdf")).toBe(true);
  });

  it("strips traversal from the filename", () => {
    const r = resolveUploadTarget(allowed, "../../evil.exe", [allowed]);
    // basename keeps only evil.exe, which lands inside allowed → ok
    expect(r.ok).toBe(true);
    expect(path.dirname(r.value!.path)).toBe(allowed);
  });

  it("refuses a destination dir outside the allowlist", () => {
    expect(resolveUploadTarget(outside, "x.txt", [allowed]).ok).toBe(false);
  });
});
