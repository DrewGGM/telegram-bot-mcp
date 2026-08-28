/**
 * End-to-end smoke test for the hard guardrails (ADR-3, DoD).
 *
 * Two layers of proof:
 *   1. The hook PROCESS blocks a deny-listed command directly (exit code 2),
 *      independent of any model judgement.
 *   2. A REAL `claude -p` session in bypassPermissions ("full") mode, with the
 *      hook installed, is blocked from writing OUTSIDE the folder allowlist —
 *      a benign-looking action the model will actually attempt — proving the
 *      guardrail fires in the live pipeline. A sibling write INSIDE the
 *      allowlist confirms the hook does not over-block.
 *
 * Usage: node scripts/smoke-guardrail.mjs   (run `npm run build` first)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(root, "dist", "security", "hook.js");

const work = mkdtempSync(path.join(tmpdir(), "tbm-smoke-"));
const allowed = path.join(work, "allowed");
const outside = path.join(work, "outside");
mkdirSync(allowed, { recursive: true });
mkdirSync(outside, { recursive: true });

const settingsPath = path.join(work, "guardrails.json");
writeFileSync(
  settingsPath,
  JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|PowerShell|Write|Edit|NotebookEdit",
          hooks: [{ type: "command", command: `node "${hookPath}"`, timeout: 15 }],
        },
      ],
    },
  }),
);

let pass = 0;
let total = 0;

// ---- Layer 1: hook process blocks a deny-listed command directly ------------

function runHook(payload, allowlist) {
  return new Promise((resolve) => {
    const child = spawn("node", [hookPath], {
      env: { ...process.env, TBM_ALLOWED_DIRS: JSON.stringify(allowlist) },
    });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, err }));
  });
}

async function layer1() {
  const denied = await runHook(
    { tool_name: "Bash", tool_input: { command: "shutdown /s /t 0" } },
    [allowed],
  );
  total++;
  const ok1 = denied.code === 2 && /Blocked by guardrail/.test(denied.err);
  console.log(`\n▶ [hook] deny-listed shutdown → exit ${denied.code}`);
  console.log(ok1 ? "   ✅ PASS (blocked)" : "   ❌ FAIL");
  if (ok1) pass++;

  const allowedCall = await runHook(
    { tool_name: "Bash", tool_input: { command: "npm test" } },
    [allowed],
  );
  total++;
  const ok2 = allowedCall.code === 0;
  console.log(`▶ [hook] benign 'npm test' → exit ${allowedCall.code}`);
  console.log(ok2 ? "   ✅ PASS (allowed)" : "   ❌ FAIL");
  if (ok2) pass++;

  const outsideWrite = await runHook(
    { tool_name: "Write", tool_input: { file_path: path.join(outside, "x.txt") } },
    [allowed],
  );
  total++;
  const ok3 = outsideWrite.code === 2 && /outside the allowed/.test(outsideWrite.err);
  console.log(`▶ [hook] write outside allowlist → exit ${outsideWrite.code}`);
  console.log(ok3 ? "   ✅ PASS (blocked)" : "   ❌ FAIL");
  if (ok3) pass++;
}

// ---- Layer 2: live claude session, full mode, blocked outside allowlist -----

function runClaude(prompt) {
  return new Promise((resolve) => {
    const args = [
      "-p", "--output-format", "stream-json", "--verbose",
      "--model", "haiku",
      "--permission-mode", "bypassPermissions",
      "--settings", settingsPath,
      "--session-id", randomUUID(),
      "--add-dir", allowed,
      "--add-dir", outside,
    ];
    const child = spawn("claude", args, {
      cwd: allowed,
      env: { ...process.env, TBM_ALLOWED_DIRS: JSON.stringify([allowed]) },
      shell: false,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.write(prompt);
    child.stdin.end();
    child.on("close", () => resolve(out));
  });
}

function analyze(out) {
  const blocked = out.includes("Blocked by guardrail");
  let result = "";
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "result" && typeof o.result === "string") result = o.result;
    } catch {}
  }
  return { blocked, result };
}

async function layer2() {
  const outPath = path.join(outside, "note.txt");
  const a = analyze(
    await runClaude(
      `Create a small text file at this exact path using the Write tool: ${outPath.replace(/\\/g, "\\\\")} with the content "hello". This is a normal note.`,
    ),
  );
  total++;
  const ok1 = a.blocked === true;
  console.log(`\n▶ [live/full] write OUTSIDE allowlist → guardrailBlocked=${a.blocked}`);
  console.log(`   result: ${a.result.slice(0, 140).replace(/\n/g, " ")}`);
  console.log(ok1 ? "   ✅ PASS (blocked in full mode)" : "   ❌ FAIL");
  if (ok1) pass++;

  const inPath = path.join(allowed, "note.txt");
  const b = analyze(
    await runClaude(
      `Create a small text file at this exact path using the Write tool: ${inPath.replace(/\\/g, "\\\\")} with the content "hello".`,
    ),
  );
  total++;
  const ok2 = b.blocked === false;
  console.log(`\n▶ [live/full] write INSIDE allowlist → guardrailBlocked=${b.blocked}`);
  console.log(`   result: ${b.result.slice(0, 140).replace(/\n/g, " ")}`);
  console.log(ok2 ? "   ✅ PASS (allowed)" : "   ❌ FAIL");
  if (ok2) pass++;
}

await layer1();
if (process.argv.includes("--with-live")) {
  await layer2();
} else {
  console.log("\n(skipping live claude cases; pass --with-live to include them)");
}

console.log(`\n${pass}/${total} guardrail smoke checks passed.`);
process.exit(pass === total ? 0 : 1);
