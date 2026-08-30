/**
 * Register the telegram-bridge in your *user-level* Claude Code config (FR-19),
 * so ANY Claude Code session on this machine — not just ones the daemon spawns —
 * can message you, send you a file, or ask you a question on Telegram.
 *
 * Prints the exact `claude mcp add` command and, unless --dry-run, runs it.
 * Undo any time with:  claude mcp remove telegram-bridge -s user
 *
 * Usage:
 *   node scripts/register-global-mcp.mjs [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Windows absolute paths must be file:// URLs for dynamic import.
const importDist = (...seg) => import(pathToFileURL(path.join(root, "dist", ...seg)).href);
const { loadConfig } = await importDist("config", "config.js");
const { loadOrCreateGlobalToken } = await importDist("ipc", "globalToken.js");

const serverPath = path.join(root, "dist", "mcp", "server.js");
if (!existsSync(serverPath)) {
  console.error("dist/mcp/server.js not found — run `npm run build` first.");
  process.exit(1);
}

const config = loadConfig();
const token = loadOrCreateGlobalToken();
const url = `http://127.0.0.1:${config.ipcPort}`;

const args = [
  "mcp", "add", "telegram-bridge",
  "-s", "user",
  "-e", `TBM_IPC_URL=${url}`,
  "-e", `TBM_IPC_TOKEN=${token}`,
  "--", "node", serverPath,
];

console.log("Registering the telegram-bridge for every Claude Code session on this machine.\n");
console.log(`  IPC:   ${url}   (loopback only)`);
console.log(`  bridge: ${serverPath}`);
console.log(`  owner:  ${config.ownerId || "UNCLAIMED — send /start to the bot first"}\n`);
console.log(`  claude ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);

if (process.argv.includes("--dry-run")) {
  console.log("(dry run — nothing changed)");
  process.exit(0);
}

const res = spawnSync("claude", args, { stdio: "inherit", shell: process.platform === "win32" });
if (res.status !== 0) {
  console.error("\nRegistration failed. You can run the command above manually.");
  process.exit(res.status ?? 1);
}
console.log("\n✅ Registered. Any Claude Code session can now reach you on Telegram.");
console.log("   The daemon must be running for the tools to work.");
console.log("   Undo with:  claude mcp remove telegram-bridge -s user");
