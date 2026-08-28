/**
 * End-to-end smoke test of the real turn pipeline: SessionManager spawns a live
 * `claude -p --resume`, streams stream-json back, and delivers assistant text +
 * result through the callbacks — the exact path a Telegram message travels.
 * Also proves a second turn RESUMES context (FR-5) via the same session.
 *
 * Usage: npm run build && node scripts/smoke-turn.mjs
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionStore } from "../dist/sessions/store.js";
import { SessionManager } from "../dist/sessions/manager.js";
import { IpcServer } from "../dist/ipc/server.js";
import { writeGuardrails } from "../dist/security/guardrails.js";

const work = mkdtempSync(path.join(tmpdir(), "tbm-turn-"));
mkdirSync(work, { recursive: true });

const config = {
  ownerId: 1,
  allowedDirs: [work],
  defaultModel: "haiku",
  defaultMode: "ro",
  turnTimeoutMinutes: 5,
  hibernateAfterMinutes: 30,
  maxConcurrentSessions: 5,
  claudeBin: "claude",
  rateLimitPerMinute: 1000,
};

const ipc = new IpcServer({
  async sendMessage() {},
  async sendFile() {},
  async askUser() {
    return "";
  },
});
await ipc.listen();

const guardrailsPath = writeGuardrails(work);
const store = new SessionStore(path.join(work, "sessions.json"));
const manager = new SessionManager(store, () => config, guardrailsPath, ipc);

const session = store.create({ cwd: work, model: "haiku", mode: "ro", chatId: 1, isDefault: true });

function capture() {
  const events = { text: [], tools: [], result: null, error: null };
  return {
    events,
    cb: {
      onText: (t) => events.text.push(t),
      onTool: (s) => events.tools.push(s),
      onResult: (r) => (events.result = r),
      onError: (e) => (events.error = e),
    },
  };
}

let pass = 0;
let total = 0;

// Turn 1
total++;
const c1 = capture();
await manager.runTurn(session, "Remember the secret word is BANANA. Reply with exactly: OK", c1.cb);
const r1ok = c1.events.result && /OK/i.test(c1.events.result.text) && !c1.events.error;
console.log(`▶ turn 1 result: ${JSON.stringify(c1.events.result?.text)?.slice(0, 80)} error=${c1.events.error}`);
console.log(r1ok ? "   ✅ PASS (streamed a result)" : "   ❌ FAIL");
if (r1ok) pass++;

// Turn 2 — must resume context.
total++;
const fresh = store.get(session.id); // firstTurnDone now true
const c2 = capture();
await manager.runTurn(fresh, "What is the secret word? Reply with only that word.", c2.cb);
const r2ok = c2.events.result && /BANANA/i.test(c2.events.result.text);
console.log(`▶ turn 2 result: ${JSON.stringify(c2.events.result?.text)?.slice(0, 80)}`);
console.log(r2ok ? "   ✅ PASS (resumed context, remembered BANANA)" : "   ❌ FAIL");
if (r2ok) pass++;

await ipc.close();
console.log(`\n${pass}/${total} turn-pipeline checks passed.`);
process.exit(pass === total ? 0 : 1);
