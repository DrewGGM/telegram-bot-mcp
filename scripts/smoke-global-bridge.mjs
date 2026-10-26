/**
 * Proves the desktop registration path (FR-19) works against the REAL daemon:
 * the persisted token + fixed loopback port deliver an actual Telegram message
 * to the owner, through the same MCP bridge subprocess a desktop Claude Code
 * session would launch.
 *
 * Requires the daemon to be running (npm start). Sends you one real message.
 *
 * Usage: node scripts/smoke-global-bridge.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importDist = (...seg) => import(pathToFileURL(path.join(root, "dist", ...seg)).href);
const { loadConfig } = await importDist("config", "config.js");
const { loadOrCreateGlobalToken } = await importDist("ipc", "globalToken.js");

const config = loadConfig();
const token = loadOrCreateGlobalToken();
const url = `http://127.0.0.1:${config.ipcPort}`;
const serverPath = path.join(root, "dist", "mcp", "server.js");

console.log(`Connecting to the daemon at ${url} with the persisted bridge token…`);

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env, TBM_IPC_URL: url, TBM_IPC_TOKEN: token, TBM_LABEL: "smoke-global" },
});
const client = new Client({ name: "global-registration-smoke", version: "1.0.0" });
await client.connect(transport);

let pass = 0;
let total = 0;

const REQUIRED_TOOLS = ["telegram_send_message", "telegram_send_file", "telegram_ask_user", "telegram_wait_reply"];
total++;
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const ok1 = REQUIRED_TOOLS.every((t) => names.includes(t));
console.log(`\n▶ tools available to any registered session: ${names.join(", ")}`);
console.log(ok1 ? "   ✅ PASS" : `   ❌ FAIL — expected ${REQUIRED_TOOLS.join(", ")}`);
if (ok1) pass++;

total++;
const experimental = client.getServerCapabilities()?.experimental ?? {};
const ok2 = "claude/channel" in experimental;
console.log(`\n▶ channel capability declared: ${Object.keys(experimental).join(", ") || "(none)"}`);
console.log(ok2 ? "   ✅ PASS" : "   ❌ FAIL");
if (ok2) pass++;

total++;
try {
  const res = await client.callTool({
    name: "telegram_send_message",
    arguments: {
      text: "🔗 Global registration smoke test: this message comes from a Claude Code session the bot did NOT launch (FR-19).",
    },
  });
  const text = res.content?.[0]?.text ?? "";
  const ok3 = /delivered/i.test(text);
  console.log(`\n▶ send_message through the persistent token → ${text}`);
  console.log(ok3 ? "   ✅ PASS (check your Telegram)" : "   ❌ FAIL");
  if (ok3) pass++;
} catch (err) {
  console.log(`\n▶ send_message failed: ${err}`);
  console.log("   ❌ FAIL — is the daemon running? (npm start)");
}

await client.close();
console.log(`\n${pass}/${total} global-registration checks passed.`);
process.exit(pass === total ? 0 : 1);
