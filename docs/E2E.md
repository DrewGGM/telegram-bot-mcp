# End-to-end validation

This project separates **what can be proven automatically** from **the one step that needs a human** (a real Telegram user account sending messages — bots cannot message bots, so it can't be scripted with only a bot token).

## Automated (run these)

| Check | Command | Proves |
|---|---|---|
| Unit + integration suite | `npm run check` | All module logic; non-owner gets no reply (FR-1); routing; parsing; path/command guards. |
| Coverage gate | `npm run coverage` | ≥90% statements on security-critical modules. |
| Guardrail smoke (real Claude) | `npm run smoke:guardrail` | In `full`/bypassPermissions mode, a live agent is **blocked** outside the allowlist and on deny-listed commands; allowed work succeeds. |
| Turn pipeline (real Claude) | `npm run smoke:turn` | `SessionManager` spawns a live `claude`, streams a result back, and a second turn **resumes context** (FR-5). |
| MCP bridge E2E | `npx vitest run src/mcp/server.test.ts` | Real bridge subprocess → loopback IPC → daemon, destination fixed by token (ADR-5). |
| MCP tools in a live agent | `npm run smoke:mcp` | A real `claude` session is offered all three `telegram_*` tools, actually **invokes** `telegram_send_file`, and the call lands on the **daemon-chosen** destination (FR-17/18, ADR-5). |
| Live boot | `TBM_SMOKE_EXIT_MS=6000 npm run start:dev` | Daemon connects to Telegram (long polling) and shuts down cleanly. |

### Latest automated results
- ✅ 164/164 tests passing, typecheck clean.
- ✅ Coverage 90.5% overall on the security-critical set (commands/paths/auth/args/cli/pending/format at 95–100%).
- ✅ Guardrail smoke: **5/5** — including a live `full`-mode session blocked from writing outside the allowlist.
- ✅ Turn pipeline: **2/2** — live `claude` streamed a result and resumed context (recalled a secret word across turns).
- ✅ MCP bridge E2E: 3/3 through a real subprocess.
- ✅ MCP tools in a live agent: **3/3** — a real `claude` session saw all three `telegram_*` tools, invoked `telegram_send_file`, and delivery went to the daemon-chosen destination (not one the agent could pick).
- ✅ Verified in production from a phone: ownership claim, chat with context, `/sessions` `/status` `/model`, a real agent task exploring an Obsidian vault, and a **guardrail block recorded in the audit log** (`Write` to `~/.claude/plans` refused as outside the allowlist).
- ✅ Live boot: connected as the configured bot, long polling started, clean shutdown.

## Manual checklist (from your phone)

Do this once after setup. Each maps to a functional requirement.

1. **Ownership (FR-1)** — Fresh install, send `/start` in private chat → you get your id + a Claim button. Tap it. From a *second* Telegram account, message the bot → **no response at all**.
2. **Chat with memory (FR-4/5/6)** — Send "remember my favorite number is 7", then "what is it?" → the agent answers "7". Long replies arrive split into ≤4096-char parts.
3. **Files (FR-12/13)** — `/ls`, `/find <name>`, `/get <path>` → the file arrives in chat. A path outside the allowlist is refused.
4. **Upload (FR-14)** — Send a document → it's saved into the session folder with a confirmation.
5. **Sessions & topics (FR-7/8/9)** — In the forum group, `/new Downloads sonnet edit` → a topic appears; messages there talk only to that session; `/kill <id>` ends it.
6. **Modes & guardrails (FR-10, ADR-3)** — In a `full` session, ask the agent to delete something outside the allowlist → blocked. Ask it to `shutdown` → blocked.
7. **ask_user (FR-17)** — Prompt the agent to ask you a yes/no question → buttons appear; your tap continues the turn.
8. **Panic (FR-2)** — `/panic` → running turns die and new ones are refused until `/unlock`.
9. **Survives reboot** — With the Scheduled Task installed, reboot → the bot is back online without intervention.
