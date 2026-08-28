import { SessionMode } from "../config/config.js";

/**
 * Parsing helpers for command arguments (e.g. `/new Downloads sonnet edit`).
 * Pure and order-independent for model/mode so the user can type them either way.
 */

export const MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export function isModelAlias(s: string): s is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(s.toLowerCase());
}

export function isSessionMode(s: string): s is "ro" | "edit" | "full" {
  return SessionMode.safeParse(s.toLowerCase()).success;
}

export interface NewSessionArgs {
  folder?: string;
  model?: ModelAlias;
  mode?: "ro" | "edit" | "full";
}

/**
 * Parse the tail of `/new <folder> [model] [mode]`. The first token that is not
 * a known model/mode is taken as the folder; model and mode may appear in any
 * order afterwards.
 */
export function parseNewArgs(tokens: string[]): NewSessionArgs {
  const out: NewSessionArgs = {};
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    if (isModelAlias(t) && !out.model) {
      out.model = t.toLowerCase() as ModelAlias;
    } else if (isSessionMode(t) && !out.mode) {
      out.mode = t.toLowerCase() as "ro" | "edit" | "full";
    } else if (!out.folder) {
      out.folder = t;
    }
  }
  return out;
}
