import type { SessionMode } from "../config/config.js";

/**
 * Pure builder for the `claude` CLI argument vector (ADR-1). Kept separate from
 * the spawn so the flag logic — the security-sensitive mode→permission mapping
 * especially — is unit-testable in isolation.
 */

/**
 * Session mode → Claude Code `--permission-mode` (ADR-3, FR-10).
 * - `ro`   → plan            : read-only, proposes but never edits.
 * - `edit` → acceptEdits     : auto-accepts file edits, still gated on other tools.
 * - `full` → bypassPermissions: auto-accepts everything the hard guardrail hooks allow.
 *
 * Crucially, even `bypassPermissions` runs UNDER the PreToolUse guardrail hooks
 * injected via --settings, so the deny-list still fires (ADR-3).
 */
export function modeToPermission(mode: SessionMode): string {
  switch (mode) {
    case "ro":
      return "plan";
    case "edit":
      return "acceptEdits";
    case "full":
      return "bypassPermissions";
  }
}

export interface ClaudeInvocation {
  claudeSessionId: string;
  /** True on the very first turn of a session (use --session-id, not --resume). */
  firstTurn: boolean;
  model: string;
  mode: SessionMode;
  addDirs: readonly string[];
  settingsPath?: string;
  mcpConfigPath?: string;
}

/** Build the argv (excluding the `claude` binary itself). Prompt is passed on stdin. */
export function buildClaudeArgs(inv: ClaudeInvocation): string[] {
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];

  args.push("--model", inv.model);
  args.push("--permission-mode", modeToPermission(inv.mode));

  if (inv.firstTurn) {
    args.push("--session-id", inv.claudeSessionId);
  } else {
    args.push("--resume", inv.claudeSessionId);
  }

  if (inv.settingsPath) args.push("--settings", inv.settingsPath);
  if (inv.mcpConfigPath) {
    args.push("--mcp-config", inv.mcpConfigPath, "--strict-mcp-config");
  }
  for (const dir of inv.addDirs) args.push("--add-dir", dir);

  return args;
}
