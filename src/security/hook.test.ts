import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateHook } from "./hook.js";

let allowed: string;
let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "tbm-hook-"));
  allowed = path.join(root, "workspace");
  mkdirSync(allowed, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("evaluateHook", () => {
  it("blocks a deny-listed Bash command even though it's 'just Bash'", () => {
    const d = evaluateHook("Bash", { command: "shutdown /s /t 0" }, [allowed]);
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/guardrail/i);
  });

  it("allows a benign Bash command", () => {
    expect(evaluateHook("Bash", { command: "npm test" }, [allowed]).block).toBe(false);
  });

  it("blocks the same class through PowerShell", () => {
    expect(evaluateHook("PowerShell", { command: "Remove-Item C:\\Windows\\x" }, [allowed]).block).toBe(true);
  });

  it("blocks a Write outside the allowlist", () => {
    const outside = path.join(root, "elsewhere", "evil.txt");
    expect(evaluateHook("Write", { file_path: outside }, [allowed]).block).toBe(true);
  });

  it("allows a Write inside the allowlist", () => {
    const inside = path.join(allowed, "notes.txt");
    expect(evaluateHook("Write", { file_path: inside }, [allowed]).block).toBe(false);
  });

  it("blocks an Edit outside the allowlist", () => {
    const outside = path.join(root, "secrets.txt");
    expect(evaluateHook("Edit", { file_path: outside }, [allowed]).block).toBe(true);
  });

  it("allows Read anywhere (destination is owner-fixed, ADR-5)", () => {
    expect(evaluateHook("Read", { file_path: "C:\\anything\\file.txt" }, [allowed]).block).toBe(false);
  });

  it("blocks writes when the allowlist is empty (deny by default)", () => {
    expect(evaluateHook("Write", { file_path: path.join(allowed, "x") }, []).block).toBe(true);
  });

  it("does not block a write tool with no path", () => {
    expect(evaluateHook("Write", {}, [allowed]).block).toBe(false);
  });
});
