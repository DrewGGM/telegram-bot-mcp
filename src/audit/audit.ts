import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config/config.js";

/**
 * Append-only JSONL audit log (FR-21). Every security-relevant action — command
 * received, session created, file sent/received, confirmation, guardrail block —
 * lands here with a timestamp. Separate from the operational pino log on purpose:
 * this is the tamper-evident trail, one JSON object per line.
 */

export type AuditEvent =
  | { kind: "command"; command: string; userId: number }
  | { kind: "auth.denied"; userId: number; chatId: number }
  | { kind: "session.created"; sessionId: string; cwd: string; model: string; mode: string }
  | { kind: "session.killed"; sessionId: string; reason: string }
  | { kind: "session.hibernated"; sessionId: string }
  | { kind: "turn.start"; sessionId: string; chars: number }
  | { kind: "turn.end"; sessionId: string; ok: boolean; ms: number }
  | { kind: "file.sent"; path: string; bytes: number }
  | { kind: "file.received"; path: string; bytes: number }
  | { kind: "file.deleted"; path: string }
  | { kind: "confirm.requested"; action: string; target: string }
  | { kind: "confirm.resolved"; action: string; target: string; approved: boolean }
  | { kind: "guardrail.blocked"; tool: string; rule: string; detail: string }
  | { kind: "panic"; active: boolean }
  | { kind: "config.changed"; field: string; detail: string }
  | { kind: "ipc.rejected"; reason: string };

const AUDIT_PATH = path.join(DATA_DIR, "audit.jsonl");

export function audit(event: AuditEvent): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  appendFileSync(AUDIT_PATH, line, "utf8");
}

export { AUDIT_PATH };
