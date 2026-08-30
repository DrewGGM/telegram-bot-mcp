/**
 * End-to-end proof that a LIVE `claude` session actually receives and can use
 * the telegram-bridge MCP tools (FR-17/18).
 *
 * Spawns a real agent with the same --mcp-config the daemon generates, asks it
 * to send a file through `telegram_send_file`, and asserts the call arrived at
 * the daemon side with the destination the DAEMON chose — not one the agent
 * picked (ADR-5). The Telegram network is replaced by a capturing fake so this
 * runs without touching your chat.
 *
 * Usage: npm run build && node scripts/smoke-mcp-live.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { IpcServer } from "../dist/ipc/server.js";
import { writeMcpConfig } from "../dist/mcp/config.js";
import { writeGuardrails } from "../dist/security/guardrails.js";

const work = mkdtempSync(path.join(tmpdir(), "tbm-mcplive-"));
mkdirSync(work, { recursive: true });
const filePath = path.join(work, "report.txt");
writeFileSync(filePath, "quarterly numbers");

// Daemon side: capture what the bridge delivers.
const received = [];
const ipc = new IpcServer({
  async sendMessage(target, text) {
    received.push({ kind: "message", target, text });
  },
  async sendFile(target, p, caption) {
    received.push({ kind: "file", target, path: p, caption });
  },
  async askUser(target, question, options) {
    received.push({ kind: "ask", target, question, options });
    return options[0] ?? "";
  },
});
await ipc.listen();

// The destination is chosen HERE, by the daemon — the agent never sees it.
const DAEMON_CHOSEN = { chatId: 424242, topicId: 77 };
const token = ipc.registerSession("live", DAEMON_CHOSEN);
const mcpConfigPath = writeMcpConfig("live", ipc.url, token, path.join(work, "mcp"));
const guardrailsPath = writeGuardrails(work);

function runAgent(prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p", "--output-format", "stream-json", "--verbose",
        "--model", "haiku",
        "--permission-mode", "bypassPermissions",
        "--settings", guardrailsPath,
        "--mcp-config", mcpConfigPath,
        "--strict-mcp-config",
        "--session-id", randomUUID(),
        "--add-dir", work,
      ],
      {
        cwd: work,
        env: { ...process.env, TBM_ALLOWED_DIRS: JSON.stringify([work]) },
        shell: false,
      },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.write(prompt);
    child.stdin.end();
    child.on("close", () => resolve(out));
  });
}

function toolsFrom(out) {
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "system" && o.subtype === "init" && Array.isArray(o.tools)) return o.tools;
    } catch {}
  }
  return [];
}

let pass = 0;
let total = 0;

// --- Case 1: the agent is actually offered the three bridge tools ------------
const out1 = await runAgent(
  `Use the telegram_send_file tool to send this file to the owner: ${filePath.replace(/\\/g, "\\\\")} with the caption "here you go". Then reply done.`,
);
const tools = toolsFrom(out1);
const bridgeTools = tools.filter((t) => t.startsWith("mcp__telegram-bridge__"));

total++;
const ok1 = bridgeTools.length === 3;
console.log(`\n▶ tools exposed to the live agent: ${bridgeTools.join(", ") || "(none)"}`);
console.log(ok1 ? "   ✅ PASS (all 3 bridge tools present)" : "   ❌ FAIL");
if (ok1) pass++;

// --- Case 2: the agent's call actually reached the daemon --------------------
total++;
const fileCall = received.find((r) => r.kind === "file");
const ok2 = Boolean(fileCall);
console.log(`\n▶ daemon received: ${JSON.stringify(received)}`);
console.log(ok2 ? "   ✅ PASS (agent really invoked telegram_send_file)" : "   ❌ FAIL");
if (ok2) pass++;

// --- Case 3: destination came from the daemon, not the agent (ADR-5) --------
total++;
const ok3 =
  fileCall &&
  fileCall.target.chatId === DAEMON_CHOSEN.chatId &&
  fileCall.target.topicId === DAEMON_CHOSEN.topicId;
console.log(`\n▶ destination: ${JSON.stringify(fileCall?.target)} (daemon chose ${JSON.stringify(DAEMON_CHOSEN)})`);
console.log(ok3 ? "   ✅ PASS (daemon-fixed destination)" : "   ❌ FAIL");
if (ok3) pass++;

await ipc.close();
console.log(`\n${pass}/${total} live-MCP checks passed.`);
process.exit(pass === total ? 0 : 1);
