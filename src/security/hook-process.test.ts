import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The hook's contract with Claude Code is process-level: payload on stdin,
 * exit code 2 + reason on stderr to block, exit code 0 to allow. This runs the
 * real hook binary (the TypeScript source via tsx, exactly as the dev daemon
 * installs it) so a regression in main() cannot hide behind the pure
 * `evaluateHook` tests.
 */

let root: string;
let allowed: string;
const hookSrc = path.resolve(import.meta.dirname, "hook.ts");

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "tbm-hookproc-"));
  allowed = path.join(root, "workspace");
  mkdirSync(allowed, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runHook(payload: unknown, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn("node", ["--import", "tsx", hookSrc], {
      env: { ...process.env, TBM_ALLOWED_DIRS: JSON.stringify([allowed]), ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

describe("hook binary (PreToolUse contract)", () => {
  it("blocks a deny-listed command with exit 2 and a reason on stderr", async () => {
    const res = await runHook({ tool_name: "Bash", tool_input: { command: "shutdown /s /t 0" } });
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/guardrail/i);
  }, 20_000);

  it("blocks a write outside the allowlist", async () => {
    const res = await runHook({
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "outside", "x.txt"), content: "x" },
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/outside the allowed directories/);
  }, 20_000);

  it("allows a write inside the allowlist and a benign command", async () => {
    const inside = await runHook({
      tool_name: "Write",
      tool_input: { file_path: path.join(allowed, "ok.txt") },
    });
    expect(inside.code).toBe(0);
    const benign = await runHook({ tool_name: "Bash", tool_input: { command: "npm test" } });
    expect(benign.code).toBe(0);
  }, 20_000);

  it("fails closed on garbage input for a write tool, open for a read tool", async () => {
    // Unparseable payload: no tool name is known, so nothing dangerous is
    // identified and the call is allowed (Claude Code would not send this).
    const garbage = await runHook("{not json");
    expect(garbage.code).toBe(0);
    // A write tool with an empty allowlist is denied by default.
    const denied = await runHook(
      { tool_name: "Edit", tool_input: { file_path: path.join(allowed, "a.txt") } },
      { TBM_ALLOWED_DIRS: "[]" },
    );
    expect(denied.code).toBe(2);
  }, 20_000);
});
