# telegram-bot-mcp

**A Telegram ↔ Claude Code bridge for your PC.** Run a private Windows daemon that lets you — and only you — chat with Claude Code from your phone, browse and fetch files, and launch/steer headless agent sessions in specific folders, with **hard security guardrails** that hold even against prompt injection.

> Single-user by design. No inbound ports (long polling). The agent can never message anyone but you, and can never touch anything outside the folders you allow — even in its most permissive mode.

---

## What it does

- 💬 **Chat with Claude Code from Telegram**, with conversation memory per session (`--resume`).
- 📂 **Manage files**: `/ls`, `/find`, `/get` a file to your chat, or send a file to the bot to save it into a session's folder — all confined to an allowlist.
- 🖥 **Launch agent sessions** in any allowed folder, choosing the model (Opus/Sonnet/Haiku) and permission mode (`ro`/`edit`/`full`). Each session gets its own **forum topic**.
- 🛡 **Hard guardrails**: a deny-list of catastrophic command classes and a folder allowlist are enforced by Claude Code **PreToolUse hooks — outside the LLM** — so a malicious file or web page the agent reads cannot make it destroy data, escape the allowlist, or exfiltrate to a third party.
- 🛑 **Kill switch**: `/panic` terminates every running turn and locks the bridge until `/unlock`.

Full design rationale lives in the architecture blueprint (kept locally, not committed).

---

## Architecture

```
Telegram ⇄ (long polling, no open ports) ⇄ ┌──────── daemon (Node/TS) ─────────┐
                                           │ bot (grammY)                       │
                                           │  ├─ auth middleware (owner only)   │
                                           │  ├─ commands (/new /get /panic …)  │
                                           │  └─ topic ⇄ session routing        │
                                           │ session-manager                    │
                                           │  └─ spawn: claude -p --resume …    │
                                           │       --output-format stream-json  │
                                           │       --settings guardrails.json   │
                                           │       --mcp-config telegram-bridge │
                                           │ security (paths, deny-list, hook)  │
                                           │ files · ipc (127.0.0.1 + token)    │
                                           └────────────────────────────────────┘
                                              ▲ stdio               │ spawn
                                  ┌───────────┴──────────┐  ┌────────▼────────┐
                                  │ mcp telegram-bridge  │◄─┤ claude process  │
                                  │ send_msg/file/ask    │  │ (one per turn)  │
                                  └──────────────────────┘  └─────────────────┘
```

- **One `claude -p --resume` process per turn** (ADR-1). No long-lived PTYs; hibernation is free and a crash never loses the conversation.
- **Guardrails as PreToolUse hooks** (ADR-3): enforcement lives in the harness, not the model's reasoning — a prompt injection can't switch it off.
- **MCP bridge with daemon-fixed destination** (ADR-5): the agent's Telegram tools take no `chat_id`; the daemon injects it from the session token, so "send this to @someone_else" is impossible by construction.

### Modules (`src/`)

| Module | Responsibility |
|---|---|
| `config/` | Zod-validated `config.json` + `.env` loading. |
| `security/paths.ts` | Path canonicalization + folder allowlist (anti-traversal, anti-symlink, UNC/device rejection, Windows case-folding). |
| `security/commands.ts` | Hard deny-list of catastrophic command classes. |
| `security/hook.ts` | The PreToolUse hook binary — the enforcement point. |
| `security/guardrails.ts` | Generates the `--settings` file that installs the hook. |
| `sessions/` | Session store, CLI flag builder, stream-json parser, spawn manager. |
| `files/` | Deterministic `ls`/`find`/`get`/upload, always through the allowlist. |
| `ipc/` | Loopback-only HTTP server + protocol for the MCP bridge. |
| `mcp/` | The `telegram-bridge` MCP server and its spawn config. |
| `bot/` | grammY wiring: auth, commands, routing, rate limiting, pending questions. |
| `audit/` | Append-only JSONL audit trail. |

---

## Security model (deny by default)

1. **Identity** — Only the owner's Telegram id, only in the owner's private chat or the configured forum group. Every other update is dropped **silently** (never reveals the bot exists). TDD-covered.
2. **Network** — Outbound only. The MCP IPC listens **exclusively on `127.0.0.1`** with a random per-session token minted in memory (never written to disk).
3. **Secrets** — The bot token lives only in `.env` (git-ignored). It is stripped from the environment handed to spawned agents.
4. **Filesystem** — `isPathAllowed` canonicalizes with `realpath`, rejects `..` escapes, symlink/junction escapes, UNC paths, and Windows device names (`CON`, `NUL`, …), and compares case-insensitively on Windows.
5. **Hard deny-list** — Blocks disk formatting, shutdown/reboot, registry writes, `%WINDIR%`/`Program Files` edits, credential-store access, service/scheduled-task persistence, download-and-execute (`iex`, `curl | sh`), firewall/Defender tampering, and more — **always, even in `full` mode**.
6. **Anti prompt-injection** — Guardrails outside the LLM (ADR-3), owner-fixed message destination (ADR-5), human confirmation for destructive ops, `/panic`, and a full audit log. *Principle: content the agent reads never gains capabilities — only you grant them.*
7. **Rate limiting** — Caps updates/minute and concurrent sessions.

### Permission modes

| Mode | `--permission-mode` | Behavior |
|---|---|---|
| `ro`   | `plan`             | Read-only: proposes, never edits. |
| `edit` | `acceptEdits`      | Auto-accepts file edits in the allowlist. |
| `full` | `bypassPermissions`| Auto-accepts everything **the guardrail hooks still allow**. |

The hooks fire under **all** modes — `full` is "auto-approve within the guardrails", not "no guardrails".

---

## Setup from scratch

### Prerequisites
- Windows 11, Node.js ≥ 22.5
- The `claude` CLI installed and logged in (`claude` runs with your subscription)

### 1. Create the bot
1. In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → get the token.
2. Copy `.env.example` to `.env` and paste the token:
   ```
   BOT_TOKEN=123456789:AA...your-token-here
   ```

### 2. Install & build
```bash
npm ci
npm run build
```

### 3. First run & claim ownership
```bash
npm start            # or: npm run dev
```
Open a **private chat** with your bot and send `/start`. Since no owner is set yet, the bot replies with your numeric id and a **Claim ownership** button. Tap it — from then on the bot answers only you. (First tap wins; do this immediately after first launch.)

On first run a `config.json` is created with `allowedDirs = [~/Downloads, ~/Desktop]`. Adjust with `/config add <abs path>` / `/config remove <abs path>`.

### 4. (Optional) Set up the sessions group for multi-session topics
1. Create a Telegram **group**, enable **Topics** (Forum) in its settings, and add your bot as an **admin** with *Manage topics*.
2. In that group, send `/setgroup`.
3. Now `/new Downloads sonnet edit` creates a session in its own topic.

### 5. (Optional) Register the bridge for *every* Claude Code session (FR-19)

By default the `telegram_*` tools exist only inside sessions the daemon launches.
Register the bridge once at user scope and **any** Claude Code session on this
machine can notify you on Telegram — handy for long local builds:

```bash
npm run register:global          # add --dry-run to preview
```

This runs `claude mcp add telegram-bridge -s user …` pointing at the daemon's
fixed loopback port. Undo with `claude mcp remove telegram-bridge -s user`.
The daemon must be running for the tools to work; if no owner has claimed the
bot yet, calls are refused rather than misrouted.

> **Security note.** This registration needs a token that survives restarts, so
> this single token is persisted to `data/bridge-token` (chmod 0600, git-ignored)
> — a deliberate exception to "IPC tokens never touch disk". Per-turn session
> tokens stay memory-only. The token is useless remotely (loopback only) and
> still cannot choose a recipient or escape the folder allowlist.

### 6. Auto-start on logon (Windows)
```powershell
pwsh -File scripts/install-windows.ps1     # registers a Scheduled Task
Start-ScheduledTask -TaskName TelegramBotMCP
```
Uninstall with `scripts/uninstall-windows.ps1`. The daemon runs in your user session so it uses your `claude` login, and restarts automatically on failure or reboot.

---

## Commands

| Command | Description |
|---|---|
| `/start` | Greet / claim ownership on first run. |
| `/status` | Sessions, uptime, default model/mode, allowed folders, lock state. |
| `/new <folder> [model] [mode]` | New session in a group topic. |
| `/sessions` · `/kill <id>` · `/info` | List / end / inspect sessions. |
| `/model <opus\|sonnet\|haiku>` | Set the default model. |
| `/ls [path]` · `/find <query>` · `/get <path>` | Browse, search, fetch files. |
| `/config [add\|remove\|timeout] …` | Manage the allowlist and defaults (with confirmation). |
| `/setgroup` | Register the current forum group for sessions. |
| `/panic` · `/unlock` | Kill everything & lock / resume. |
| plain message | Talk to the topic's session (in a group) or the read-only default session (in private). |
| send a file | Saved into the active session's folder (≤ 20 MB). |

The agent also has three MCP tools to reach you: `telegram_send_message`, `telegram_send_file`, `telegram_ask_user` (buttons) — all routed only to your chat.

---

## Testing & validation

```bash
npm run check              # typecheck + all unit/integration tests
npm run coverage           # coverage with ≥90% gate on security-critical modules
npm run smoke:guardrail    # REAL claude session: proves guardrails block in full mode
```

What's verified automatically:
- **164 unit/integration tests** across security, sessions, files, bot, IPC, and MCP.
- **Real guardrail E2E** (`smoke:guardrail`): a live `claude` session in `full` mode is **blocked from writing outside the allowlist** and from running deny-listed commands; benign work inside the allowlist succeeds.
- **Real MCP bridge E2E**: the actual bridge subprocess is driven by an MCP client, and every tool call routes through the loopback IPC to the token's **fixed** destination.
- **Live boot**: the daemon connects to Telegram over long polling and shuts down cleanly.
- **Offline bot integration**: real grammY handlers run via `handleUpdate` with a stubbed API — including the check that a **non-owner receives no reply**.

The final human-in-the-loop step (you chatting from your phone) is the one part that can't be automated with only a bot token — bots can't message bots. See `docs/E2E.md` for the manual checklist.

---

## Design notes & deliberate deviations

- **Session store is JSON, not SQLite.** The blueprint named SQLite; for a strictly
  single-user daemon an atomic JSON document is simpler, has no native build step,
  and is trivially inspectable (YAGNI). The interface is small, so swapping in SQLite
  later is a contained change.
- **FR-16 (destructive-op confirmation)** is realized through **permission modes +
  the guardrail hook**, not a per-edit Telegram button. `ro` never edits; `edit`/`full`
  auto-apply changes *inside* the allowlist while the hook hard-blocks writes outside it
  and all deny-listed commands — even in `full`. There is intentionally **no unconfirmed
  bot-level delete command**. Allowlist changes via `/config` still require a button
  confirmation, and the agent can ask you to confirm anything via `telegram_ask_user`.
- **Reads are allowed broadly; writes/execs are confined.** Because the message
  destination is fixed to you (ADR-5), a broad read grants no exfiltration capability,
  so the hook gates the dangerous surface (writes, commands) rather than reads.

## Project layout

```
src/
  audit/      config/     bot/       files/
  ipc/        mcp/        security/  sessions/
  main.ts     logger.ts
scripts/      smoke-guardrail.mjs  install-windows.ps1  uninstall-windows.ps1
docs/         E2E.md
```

## License
MIT — see `LICENSE`.
