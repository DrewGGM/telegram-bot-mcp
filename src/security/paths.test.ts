import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPathAllowed } from "./paths.js";

let root: string;
let allowed: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "tbm-paths-"));
  allowed = path.join(root, "allowed");
  outside = path.join(root, "outside");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(path.join(allowed, "sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(allowed, "file.txt"), "hi");
  writeFileSync(path.join(outside, "secret.txt"), "no");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("isPathAllowed", () => {
  it("allows a file directly inside an allowed dir", () => {
    expect(isPathAllowed(path.join(allowed, "file.txt"), [allowed]).allowed).toBe(true);
  });

  it("allows a nested path inside an allowed dir", () => {
    expect(isPathAllowed(path.join(allowed, "sub", "new.txt"), [allowed]).allowed).toBe(true);
  });

  it("allows the allowed dir itself", () => {
    expect(isPathAllowed(allowed, [allowed]).allowed).toBe(true);
  });

  it("denies a sibling outside the allowed dir", () => {
    expect(isPathAllowed(path.join(outside, "secret.txt"), [allowed]).allowed).toBe(false);
  });

  it("denies traversal escape with ..", () => {
    const escape = path.join(allowed, "..", "outside", "secret.txt");
    expect(isPathAllowed(escape, [allowed]).allowed).toBe(false);
  });

  it("denies a prefix-collision sibling (allowed vs allowed-evil)", () => {
    const sibling = allowed + "-evil";
    mkdirSync(sibling, { recursive: true });
    expect(isPathAllowed(path.join(sibling, "x.txt"), [allowed]).allowed).toBe(false);
  });

  it("denies everything when allowlist is empty", () => {
    expect(isPathAllowed(path.join(allowed, "file.txt"), []).allowed).toBe(false);
  });

  it("denies UNC paths", () => {
    expect(isPathAllowed("\\\\server\\share\\x", [allowed]).allowed).toBe(false);
  });

  it("denies Windows device names", () => {
    expect(isPathAllowed(path.join(allowed, "NUL"), [allowed]).allowed).toBe(false);
  });

  it("denies empty input", () => {
    expect(isPathAllowed("", [allowed]).allowed).toBe(false);
  });

  it("is case-insensitive on win32 for the allowlist comparison", () => {
    const check = isPathAllowed(path.join(allowed.toUpperCase(), "file.txt"), [allowed]);
    if (process.platform === "win32") {
      expect(check.allowed).toBe(true);
    } else {
      expect(check.allowed).toBe(false);
    }
  });
});
