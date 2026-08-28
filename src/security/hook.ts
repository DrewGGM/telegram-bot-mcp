#!/usr/bin/env node
/**
 * Claude Code **PreToolUse hook** — the hard guardrail that lives OUTSIDE the LLM
 * (ADR-3). Claude Code runs this before every tool call; we block catastrophic
 * commands (deny-list) and writes outside the folder allowlist, and this fires
 * even in `full`/bypassPermissions mode. A prompt injection cannot disable it
 * because it is enforced by the harness, not reasoned about by the model.
 *
 * Contract: read the hook payload as JSON on stdin. To BLOCK, exit with code 2
 * and print the reason to stderr (Claude Code feeds stderr back to the model).
 * To ALLOW, exit 0. Any internal error fails OPEN-ly to exit 0 is NOT acceptable
 * here — we fail CLOSED (block) on unexpected errors touching a write/exec tool.
 *
 * The folder allowlist is passed by the daemon via TBM_ALLOWED_DIRS (JSON array)
 * in the spawn environment, so the hook needs no config file access.
 */
import { checkCommand } from "./commands.js";
import { isPathAllowed } from "./paths.js";

export interface HookDecision {
  block: boolean;
  reason?: string;
}

const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Pure decision for a tool call. `Read`/search tools are allowed anywhere:
 * exfiltration is already prevented by the daemon fixing the message destination
 * to the owner (ADR-5), so broad reads gain no capability. Writes/execs are the
 * dangerous surface and are gated hard.
 */
export function evaluateHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  allowedDirs: readonly string[],
): HookDecision {
  if (COMMAND_TOOLS.has(toolName)) {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const check = checkCommand(command);
    if (!check.allowed) {
      return { block: true, reason: `Blocked by guardrail (${check.rule}): this command class is never allowed.` };
    }
    return { block: false };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const filePath =
      (typeof toolInput.file_path === "string" && toolInput.file_path) ||
      (typeof toolInput.path === "string" && toolInput.path) ||
      (typeof toolInput.notebook_path === "string" && toolInput.notebook_path) ||
      "";
    if (!filePath) return { block: false };
    const check = isPathAllowed(filePath, allowedDirs);
    if (!check.allowed) {
      return {
        block: true,
        reason: `Blocked by guardrail: '${filePath}' is outside the allowed directories (${check.reason}).`,
      };
    }
    return { block: false };
  }

  return { block: false };
}

function readAllowedDirs(): string[] {
  try {
    const raw = process.env.TBM_ALLOWED_DIRS;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    payload = {};
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput =
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};

  let decision: HookDecision;
  try {
    decision = evaluateHook(toolName, toolInput, readAllowedDirs());
  } catch (err) {
    // Fail closed for dangerous tools, open for everything else.
    const dangerous = COMMAND_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName);
    decision = dangerous
      ? { block: true, reason: `Guardrail error, blocking defensively: ${String(err)}` }
      : { block: false };
  }

  if (decision.block) {
    // Best-effort audit from within the hook process (shares the JSONL file).
    try {
      const { audit } = await import("../audit/audit.js");
      audit({ kind: "guardrail.blocked", tool: toolName, rule: "hook", detail: decision.reason ?? "" });
    } catch {
      /* audit is best-effort here */
    }
    process.stderr.write((decision.reason ?? "Blocked by guardrail.") + "\n");
    process.exit(2);
  }
  process.exit(0);
}

// Run main only when executed directly as the hook (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined &&
  /security[\\/]hook\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  void main();
}
