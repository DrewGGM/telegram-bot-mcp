/**
 * Proves two-way messaging with a foreign session (FR-19): the session sends,
 * the owner swipe-replies in Telegram, and the reply lands back in THAT session
 * — not in the default chat session.
 *
 * Run with the daemon running. It sends you one message and waits for you to
 * reply to it (swipe/long-press -> Reply) for up to 3 minutes.
 *
 * Usage: node scripts/smoke-reply.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importDist = (...s) => import(pathToFileURL(path.join(root, "dist", ...s)).href);
const { loadConfig } = await importDist("config", "config.js");
const { loadOrCreateGlobalToken } = await importDist("ipc", "globalToken.js");

const config = loadConfig();
const url = `http://127.0.0.1:${config.ipcPort}`;

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(root, "dist", "mcp", "server.js")],
  env: {
    ...process.env,
    TBM_IPC_URL: url,
    TBM_IPC_TOKEN: loadOrCreateGlobalToken(),
    TBM_LABEL: "prueba-respuesta",
  },
});
const client = new Client({ name: "reply-smoke", version: "1.0.0" });
await client.connect(transport);

console.log("Enviando mensaje y esperando tu respuesta en Telegram (3 min)…");
console.log("👉 Haz swipe/mantén pulsado sobre el mensaje del bot y responde.\n");

const res = await client.callTool({
  name: "telegram_send_message",
  arguments: {
    text: "🧪 Prueba de respuesta bidireccional.\n\nRESPONDE A ESTE MENSAJE (swipe → Reply) con lo que quieras. Debe volver a esta sesión concreta.",
    wait_for_reply: true,
    timeout_seconds: 180,
  },
});

const text = res.content?.[0]?.text ?? "";
console.log(`\n▶ La sesión recibió: ${text}`);
const ok = /The owner replied:/.test(text);
console.log(ok ? "   ✅ PASS — la respuesta volvió a esta sesión" : "   ❌ FAIL / timeout");

await client.close();
process.exit(ok ? 0 : 1);
