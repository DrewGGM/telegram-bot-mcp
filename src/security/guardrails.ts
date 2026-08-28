import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config/config.js";

/**
 * Generates the Claude Code settings file (`--settings`) that installs our
 * PreToolUse guardrail hook (ADR-3, T5.1). Every spawned session gets this, so
 * the deny-list + path allowlist are enforced by the harness on every Bash /
 * PowerShell / Write / Edit / NotebookEdit call — below and independent of the
 * session's permission mode.
 */

const GUARDED_TOOLS = "Bash|PowerShell|Write|Edit|NotebookEdit";

/**
 * Command that runs the hook. Resolves to the compiled hook when running from
 * `dist/`, or the TypeScript source via tsx in development — so it works the
 * same whether the daemon was started with `npm start` or `npm run dev`.
 */
export function hookCommand(): string {
  const jsHook = path.join(import.meta.dirname, "hook.js");
  const tsHook = path.join(import.meta.dirname, "hook.ts");
  if (existsSync(jsHook)) return `node "${jsHook}"`;
  return `node --import tsx "${tsHook}"`;
}

export function buildGuardrailSettings(): unknown {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: GUARDED_TOOLS,
          hooks: [{ type: "command", command: hookCommand(), timeout: 15 }],
        },
      ],
    },
  };
}

/** Write the guardrail settings file and return its path. */
export function writeGuardrails(dir: string = DATA_DIR): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "guardrails.json");
  writeFileSync(filePath, JSON.stringify(buildGuardrailSettings(), null, 2) + "\n", "utf8");
  return filePath;
}
