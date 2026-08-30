import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../config/config.js";

/**
 * The long-lived token for the desktop registration (FR-19), which lets ANY
 * Claude Code session on this machine reach you on Telegram — not just the ones
 * the daemon spawns.
 *
 * Security note (deliberate deviation from §4.1.3, which says IPC tokens never
 * touch disk): a registration living in your Claude Code config must survive
 * daemon restarts, so this one token is persisted. It is mitigated by the
 * properties that actually matter:
 *   - the IPC listens on 127.0.0.1 only, so the token is useless remotely;
 *   - the token grants exactly three capabilities — message the owner, send the
 *     owner a file from inside the allowlist, ask the owner a question. It
 *     cannot choose a recipient (ADR-5) or reach a path outside the allowlist;
 *   - the file is chmod 0600 and lives in the git-ignored data/ directory.
 * Per-turn session tokens remain memory-only.
 */

const TOKEN_PATH = path.join(DATA_DIR, "bridge-token");

/** Read the persisted global token, creating one on first use. */
export function loadOrCreateGlobalToken(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(TOKEN_PATH)) {
    const existing = readFileSync(TOKEN_PATH, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_PATH, token + "\n", "utf8");
  try {
    chmodSync(TOKEN_PATH, 0o600); // best-effort; a no-op on some Windows setups
  } catch {
    /* non-fatal */
  }
  return token;
}

export { TOKEN_PATH };
