import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config/config.js";

/**
 * Builds the `--mcp-config` document that attaches the telegram-bridge to a
 * spawned session, injecting the loopback IPC url + per-session token via env
 * (FR-17, T4.2). Resolves to the compiled bridge in production or the tsx source
 * in development, matching how the daemon itself is running.
 */

function bridgeLauncher(): { command: string; args: string[] } {
  const jsServer = path.join(import.meta.dirname, "server.js");
  const tsServer = path.join(import.meta.dirname, "server.ts");
  if (existsSync(jsServer)) return { command: "node", args: [jsServer] };
  return { command: "node", args: ["--import", "tsx", tsServer] };
}

export function buildMcpConfig(ipcUrl: string, token: string): unknown {
  const { command, args } = bridgeLauncher();
  return {
    mcpServers: {
      "telegram-bridge": {
        command,
        args,
        env: { TBM_IPC_URL: ipcUrl, TBM_IPC_TOKEN: token },
      },
    },
  };
}

/** Write a session-scoped mcp-config file and return its path. */
export function writeMcpConfig(
  sessionId: string,
  ipcUrl: string,
  token: string,
  dir: string = path.join(DATA_DIR, "mcp"),
): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify(buildMcpConfig(ipcUrl, token), null, 2) + "\n", "utf8");
  return filePath;
}
