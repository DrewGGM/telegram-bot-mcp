# End-to-end validation

This project separates **what can be proven automatically** from **the steps that need a human** (a
real Telegram user account, or an interactive Claude Code terminal — bots cannot message bots, and
channel mode is interactive-only).

## Automated (run these)

| Check                         | Command                                            | Proves                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + integration suite      | `npm run check`                                    | All module logic; typecheck, lint and formatting; non-owner gets no reply (FR-1); routing; guards.                                                                                                          |
| Coverage gate                 | `npm run coverage`                                 | ≥90 % statements / ≥85 % branches on the security-critical and reply-routing modules.                                                                                                                       |
| Hook binary contract          | `npx vitest run src/security/hook-process.test.ts` | The real PreToolUse hook process: exit 2 + reason to block, exit 0 to allow, deny by default.                                                                                                               |
| MCP bridge E2E                | `npx vitest run src/mcp/server.test.ts`            | Real bridge subprocess → loopback IPC → daemon, destination fixed by token; a reply is pushed as a channel event, or resolves a blocked wait tool, never both; permission prompts round-trip to Allow/Deny. |
| Local-first sends             | `npx vitest run src/telegram/localApi.test.ts`     | Against a fake Bot API server: local routing, cloud fallback, cloud-only methods, uploads bypass.                                                                                                           |
| Guardrail smoke (real Claude) | `npm run smoke:guardrail`                          | In `full` mode a live agent is **blocked** outside the allowlist and on deny-listed commands.                                                                                                               |
| Turn pipeline (real Claude)   | `npm run smoke:turn`                               | `SessionManager` spawns a live `claude`, streams a result back, and a second turn **resumes context**.                                                                                                      |
| MCP tools in a live agent     | `npm run smoke:mcp`                                | A real `claude` session is offered the bridge tools, invokes one, and it lands on the daemon-chosen destination.                                                                                            |
| Desktop bridge, live          | `npm run smoke:global`                             | With the daemon running, a bridge started **outside** it delivers a real Telegram message and declares the channel capability.                                                                              |
| Two-way reply, live           | `npm run smoke:reply`                              | You swipe-reply in Telegram and the reply returns to THAT session through the wait tool.                                                                                                                    |
| Live boot                     | `TBM_SMOKE_EXIT_MS=6000 npm run start:dev`         | The daemon connects to Telegram (long polling) and shuts down cleanly.                                                                                                                                      |

### Latest automated results (2026-10-26, v0.3.0)

- ✅ 268/268 tests in 21 files; typecheck, lint and format clean; coverage 95.6 % statements /
  89.4 % branches on the gated set.
- ✅ Bridge E2E through a real subprocess: tools, capabilities, label prefix, channel push, blocked
  wait, permission relay.
- ✅ Hook binary: 4/4 process-level contract checks.
- ✅ Desktop bridge live (`smoke:global`): 3/3 against the running daemon — four tools, channel
  capability declared, and Telegram accepted the message.
- ✅ Channel mode live (2026-10-26): a session started with `scriptsclaude-tg.cmd` sent a message, the owner swipe-replied from the phone, the daemon routed it in push mode (`reply.routed` in the audit log) and the session answered on Telegram 4 s later with no terminal input.
- ✅ Earlier live runs (v0.2.0): guardrail smoke 5/5, turn pipeline 2/2, MCP tools in a live agent 3/3,
  swipe-reply returned to the asking session, production use from a phone including a guardrail
  block recorded in the audit log.

## Manual checklist (from your phone)

Do this once after setup. Each maps to a functional requirement.

1. **Ownership (FR-1)** — Fresh install, send `/start` in private chat → you get your id + a Claim
   button. Tap it. From a _second_ Telegram account, message the bot → **no response at all**.
2. **Chat with memory (FR-4/5/6)** — Send "remember my favorite number is 7", then "what is it?" →
   the agent answers "7". Long replies arrive split into ≤4096-char parts.
3. **Files (FR-12/13)** — `/ls`, `/find <name>`, `/get <path>` → the file arrives in chat (in the
   same topic when sent from one). A path outside the allowlist is refused.
4. **Upload (FR-14)** — Send a document → it is saved into the session folder with a confirmation.
5. **Sessions & topics (FR-7/8/9)** — In the forum group, `/new Downloads sonnet edit` → a topic
   appears; messages there talk only to that session; `/kill <id>` ends it.
6. **Modes & guardrails (FR-10, ADR-3)** — In a `full` session, ask the agent to delete something
   outside the allowlist → blocked. Ask it to `shutdown` → blocked.
7. **ask_user during a turn (FR-17)** — Prompt the agent to ask you a yes/no question → buttons
   appear **while the turn is still running**; your tap continues the turn. (This is the check that
   catches a blocked update loop.)
8. **Panic during a turn (FR-2)** — Start a long task, then `/panic` → the turn dies immediately and
   new ones are refused until `/unlock`.
9. **Config confirmation (FR-20)** — `/config add <folder>` → the Yes/No question appears and your
   tap applies it.
10. **Survives reboot** — With auto-start installed, reboot → the bot is back online without
    intervention.

## Desktop sessions and channel mode (FR-19)

1. **Registration** — `claude mcp list` shows `telegram-bridge — ✔ Connected` at User scope.
   `npm run smoke:global` delivers a message.
2. **Reply to a waiting session** — `npm run smoke:reply`, then swipe-reply: the script prints the
   text you sent and PASS; the bot acknowledged with "it was waiting for this".
3. **Reply to an idle session** — In a normal `claude` terminal ask: "send me a Telegram message
   saying hi and finish". Swipe-reply to it. The bot answers "queued until it next waits". Back in
   the terminal ask Claude to call `telegram_wait_reply`: it returns your text.
4. **Channel mode** — Start `scripts\claude-tg.cmd`, accept the development-channels dialog, and
   confirm the dim notice `Channels (experimental) messages from server:telegram-bridge inject
directly in this session`. Ask: "send me a Telegram message asking what to do next, then stop".
   Swipe-reply from the phone. The bot answers "pushed straight into the session" and the terminal
   shows `← telegram-bridge: …` followed by Claude acting on it, with `/sessions` listing the
   session as 📡 live.
5. **Permission relay** — In the same session press `Shift+Tab` until manual permission mode is on
   and ask Claude to run a shell command. The approval dialog opens in the terminal **and** a
   Telegram question with ✅ Allow / ❌ Deny arrives; tapping one closes the dialog.
6. **Exited session** — Close that terminal, swipe-reply to one of its old messages → "is no longer
   running" (within two minutes of closing).
