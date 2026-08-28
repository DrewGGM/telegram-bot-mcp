import pino from "pino";

/**
 * Operational structured logger. Human-facing diagnostics; security-relevant
 * events go additionally (and separately) to the JSONL audit trail in audit/.
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: null, // no pid/hostname noise for a single-user daemon
});
