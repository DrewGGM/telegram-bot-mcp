/**
 * Proves the desktop registration path (FR-19) works against the REAL daemon:
 * the persisted token + fixed loopback port deliver an actual Telegram message
 * to the owner, through the same MCP bridge subprocess a foreign Claude Code
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
  env: { ...process.env, TBM_IPC_URL: url, TBM_IPC_TOKEN: token },
});
const client = new Client({ name: "global-registration-smoke", version: "1.0.0" });
await client.connect(transport);

let pass = 0;
let total = 0;

total++;
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const ok1 = names.length === 3;
console.log(`\n▶ tools available to any registered session: ${names.join(", ")}`);
console.log(ok1 ? "   ✅ PASS" : "   ❌ FAIL");
if (ok1) pass++;

total++;
try {
  const res = await client.callTool({
    name: "telegram_send_message",
    arguments: {
      text: "🔗 Prueba del registro global: este mensaje viene de una sesión de Claude Code que NO fue lanzada por el bot. FR-19 funcionando.",
    },
  });
  const text = res.content?.[0]?.text ?? "";
  const ok2 = /delivered/i.test(text);
  console.log(`\n▶ send_message through the persistent token → ${text}`);
  console.log(ok2 ? "   ✅ PASS (check your Telegram)" : "   ❌ FAIL");
  if (ok2) pass++;
} catch (err) {
  console.log(`\n▶ send_message failed: ${err}`);
  console.log("   ❌ FAIL — is the daemon running? (npm start)");
}

await client.close();
console.log(`\n${pass}/${total} global-registration checks passed.`);
process.exit(pass === total ? 0 : 1);
