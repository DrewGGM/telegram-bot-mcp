# telegram-bot-mcp

[![CI](https://github.com/DrewGGM/telegram-bot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/DrewGGM/telegram-bot-mcp/actions/workflows/ci.yml)

**A Telegram ↔ Claude Code bridge for your PC.** A private Windows daemon that lets you — and only you —
chat with Claude Code from your phone, fetch files, launch headless agent sessions in specific folders,
and get notified by any Claude Code session running on your desktop. Hard security guardrails hold even
against prompt injection, and your Telegram replies reach the session that asked without the agent
having to sit and wait for them.

> Single-user by design. No inbound ports (long polling). The agent can never message anyone but you,
> and can never touch anything outside the folders you allow — even in its most permissive mode.

---

## What it does

- 💬 **Chat with Claude Code from Telegram**, with conversation memory per session (`--resume`).
- 📂 **Manage files**: `/ls`, `/find`, `/get` a file to your chat, or send a file to the bot to save
  it into a session's folder — all confined to a folder allowlist.
- 🖥 **Launch agent sessions** in any allowed folder, choosing the model (Opus/Sonnet/Haiku) and
  permission mode (`ro`/`edit`/`full`). Each session gets its own forum topic.
- 📱 **Any desktop Claude Code session can reach you.** Register the bridge once and every
  `claude` you run can send you progress, files and button questions.
- 🔁 **Replies go back to the right session.** Swipe-reply to a message in Telegram and it is handed
  to the session that sent it. Start that session in _channel mode_ and the reply is pushed straight
  into it as a new instruction — no `wait` tool, no polling. Tool-permission prompts can be
  approved from the phone too.
- 🛡 **Hard guardrails**: a deny-list of catastrophic command classes and the folder allowlist are
  enforced by Claude Code **PreToolUse hooks — outside the LLM** — so a malicious file or web page
  the agent reads cannot make it destroy data, escape the allowlist, or exfiltrate to a third party.
- 📦 **Big files**: with an optional local Bot API server, files up to 2 GB go out untouched; without
  it, video is compressed and other files are split to fit Telegram's 50 MB bot limit.
- 🛑 **Kill switch**: `/panic` terminates every running turn and locks the bridge until `/unlock`.

## How it works

```
Telegram ⇄ (long polling, no open ports) ⇄ ┌──────── daemon (Node/TS) ─────────┐
                                           │ bot (grammY)                       │
                                           │  ├─ auth middleware (owner only)   │
                                           │  ├─ commands (/new /get /panic …)  │
                                           │  └─ topic ⇄ session routing        │
                                           │ session-manager                    │
                                           │  └─ spawn: claude -p --resume …    │
                                           │       --settings guardrails.json   │
                                           │       --mcp-config telegram-bridge │
                                           │ security (paths, deny-list, hook)  │
                                           │ ipc (127.0.0.1 + token)            │
                                           └──────┬─────────────────────┬───────┘
                                                  │ loopback IPC        │ spawn
                             ┌────────────────────▼───┐        ┌────────▼────────┐
                             │ telegram-bridge (MCP)  │◄───────┤ claude process  │
                             │ one per claude session │ stdio  │ (yours or ours) │
                             │ tools + channel push   │        └─────────────────┘
                             └────────────────────────┘
```

- **One `claude -p --resume` process per turn** for sessions the daemon runs. No long-lived PTYs;
  hibernation is free and a crash never loses the conversation.
- **Guardrails as PreToolUse hooks**: enforcement lives in the harness, not the model's reasoning —
  a prompt injection cannot switch it off.
- **MCP bridge with daemon-fixed destination**: the agent's Telegram tools take no `chat_id`; the
  daemon injects it from the session token, so "send this to someone else" is impossible by
  construction.
- **Replies are pulled by the bridge and delivered exactly once**: to a blocked `wait` tool if the
  agent is waiting, otherwise pushed into the session as a channel event, otherwise queued.

Design details, decisions and deviations are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quick start

**Prerequisites:** Windows 11, Node.js ≥ 22.5, the `claude` CLI installed and logged in.

1. In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Clone and run the setup:

   ```powershell
   git clone https://github.com/DrewGGM/telegram-bot-mcp
   cd telegram-bot-mcp
   pwsh -File scripts/setup.ps1
   ```

   The first run creates `.env` and stops so you can paste `BOT_TOKEN=…` into it; re-run the script.
   It installs and builds, starts the optional local Bot API server if you gave it credentials,
   installs auto-start at logon, registers the bridge for every Claude Code session, and starts the
   daemon. It is idempotent — re-run it any time. Flags: `-SkipLocalApi`, `-SkipGlobalMcp`.

3. Open a private chat with your bot and send `/start`, then tap **Claim ownership**. From then on
   the bot answers only you. Do this immediately after the first launch: first tap wins.

Prefer doing it by hand? See [Manual setup](#manual-setup).

---

## Using it from Telegram

| Command                          | Description                                                            |
| -------------------------------- | ---------------------------------------------------------------------- |
| `/start`                         | Greet / claim ownership on first run.                                  |
| `/status`                        | Sessions, connected Claude Code sessions, uptime, config, lock state.  |
| `/sessions`                      | List daemon sessions and connected desktop sessions (with reply mode). |
| `/new <folder> [model] [mode]`   | New session in a group topic.                                          |
| `/kill <id>` · `/info`           | End / inspect a session.                                               |
| `/model <opus\|sonnet\|haiku>`   | Set the default model.                                                 |
| `/ls [path]` · `/find <query>`   | Browse and search the allowed folders.                                 |
| `/get <path>`                    | Send a file to this chat (or topic).                                   |
| `/config [add\|remove\|timeout]` | Manage the allowlist and defaults (with confirmation).                 |
| `/setgroup`                      | Register the current forum group for sessions.                         |
| `/panic` · `/unlock`             | Kill everything and lock / resume.                                     |
| plain message                    | Talk to the topic's session (group) or the read-only default session.  |
| send a file                      | Saved into the active session's folder (≤ 20 MB).                      |
| **reply (swipe) to a message**   | Answer the Claude Code session that sent it.                           |

**Sessions in topics.** Create a Telegram group, enable Topics, add the bot as admin with _Manage
topics_, and send `/setgroup` there. `/new Downloads sonnet edit` then creates a session in its own
topic; messages in that topic talk only to that session.

**Permission modes** (chosen per session, default `ro`):

| Mode   | `--permission-mode` | Behavior                                                     |
| ------ | ------------------- | ------------------------------------------------------------ |
| `ro`   | `plan`              | Read-only: proposes, never edits.                            |
| `edit` | `acceptEdits`       | Auto-accepts file edits inside the allowlist.                |
| `full` | `bypassPermissions` | Auto-accepts everything **the guardrail hooks still allow**. |

The hooks fire under **all** modes — `full` is "auto-approve within the guardrails", not "no guardrails".

---

## Using it from Claude Code on your desktop

### 1. Register the bridge once

```bash
npm run register:global          # add --dry-run to preview
```

This runs `claude mcp add telegram-bridge -s user …` pointing at the daemon's fixed loopback port.
Any Claude Code session on this machine now has four tools — `telegram_send_message`,
`telegram_send_file`, `telegram_ask_user`, `telegram_wait_reply` — all routed only to your chat.
Undo with `claude mcp remove telegram-bridge -s user`. The daemon must be running for the tools to
work; if no owner has claimed the bot yet, calls are refused rather than misrouted.

Messages from a desktop session are prefixed with its label, e.g. `[fineract] build finished`.

### 2. Reply from your phone

**Swipe-reply** to a message a session sent and the daemon hands your text to _that_ session. The
bot tells you what happened:

| Acknowledgement                                      | Meaning                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `📨 Sent to [x] — it was waiting for this.`          | The agent was blocked in `wait_for_reply`/`telegram_wait_reply`; it got your text now. |
| `📨 Sent to [x] — pushed straight into the session.` | The session runs in channel mode; your text arrived as its next instruction.           |
| `📨 Sent to [x] — queued until it next waits.`       | The session is alive but idle; it will read your text the next time it asks for one.   |
| `⚠️ [x] is no longer running.`                       | That `claude` has exited. Start a new one.                                             |

`/sessions` lists connected sessions and their mode (📡 live, ⏳ waiting, 📥 inbox).

### 3. Channel mode: replies without waiting

MCP is request/response: by itself a server cannot speak into a running agent's loop. Claude Code's
[channels](https://code.claude.com/docs/en/channels) (research preview) close that gap: a server
that declares the `claude/channel` capability may push `notifications/claude/channel` events, and
Claude receives each one as a user turn. The bridge is such a server. Start Claude Code with the
channel enabled and your swipe-replies are injected into the session the moment you send them:

```powershell
claude --dangerously-load-development-channels server:telegram-bridge
# or the shortcut in this repo:
scripts\claude-tg.cmd
```

Claude Code shows a one-screen **"Loading development channels"** confirmation at startup; choose
_I am using this for local development_. A dim notice under the banner then confirms
`Channels (experimental) messages from server:telegram-bridge inject directly in this session`.

To make it the default for every terminal, add a function to your PowerShell `$PROFILE`:

```powershell
function claude-tg { claude --dangerously-load-development-channels server:telegram-bridge @args }
```

What the agent sees:

```text
<channel source="telegram-bridge" from="owner" via="telegram" label="fineract">
yes, deploy it
</channel>
```

The bridge's instructions tell the agent to treat that as your next instruction and answer through
`telegram_send_message`. If the agent happens to be blocked in a wait tool at that moment, the reply
goes to the tool instead — never to both.

**Permission prompts from the phone.** In channel mode Claude Code also relays tool-approval
dialogs (`Bash`, `Write`, `Edit`, …) to the bridge. They arrive as a Telegram question with
**✅ Allow / ❌ Deny** buttons; the terminal dialog stays open and whichever answer comes first wins.

**Limits of the research preview**, straight from the docs and verified against Claude Code 2.1.310:

- During the preview, `--channels` only accepts Anthropic-allowlisted plugins; a user-scope MCP
  server like this one needs `--dangerously-load-development-channels`, and the confirmation dialog
  appears at every start.
- The flag is ignored in non-interactive mode (`claude -p`) and through the Agent SDK. Sessions the
  daemon itself runs are `-p` processes, so for them replies route through the topic as the next
  turn — that path needs no channel.
- Team/Enterprise organisations must enable channels (`channelsEnabled`) in managed settings; Pro
  and Max accounts skip that check. Channels are not available on Bedrock, Vertex or Foundry.
- Claude Code does not acknowledge pushed events. The bridge decides whether pushing is possible
  by reading the parent `claude` command line (`TBM_CHANNEL=1|0` overrides it); when it is not,
  replies are queued for `telegram_wait_reply` exactly as before, so nothing is lost.

### The agent's tools

| Tool                    | What it does                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `telegram_send_message` | Send text to you. `wait_for_reply: true` blocks until you swipe-reply (`timeout_seconds`, default 300).                        |
| `telegram_send_file`    | Send a file from an allowed folder; the daemon validates the path and handles oversize files. Never claims success on refusal. |
| `telegram_ask_user`     | A question with 1–6 buttons; returns the tapped option, or says you did not answer in time.                                    |
| `telegram_wait_reply`   | Block until you reply (default 300 s). Rarely needed in channel mode.                                                          |

---

## Optional: local Bot API server (2 GB uploads, more reliable sends)

Telegram publishes its Bot API server as software you can run yourself. Doing so lifts the bot
upload limit from 50 MB to 2000 MB and, because it reaches Telegram over MTProto, it is markedly
more reliable on links where `api.telegram.org` itself is lossy (measured 5/5 vs 3/5 on such a link).

1. Get `api_id` and `api_hash` at [my.telegram.org](https://my.telegram.org) and put them in `.env`
   as `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
2. Install Docker Desktop and start it.
3. Run `pwsh -File scripts/setup.ps1`, or start the container directly:

   ```powershell
   docker run -d --name telegram-bot-api --restart unless-stopped `
     -p 127.0.0.1:8081:8081 `
     -e TELEGRAM_API_ID=<id> -e TELEGRAM_API_HASH=<hash> `
     -v tbapi-data:/var/lib/telegram-bot-api `
     aiogram/telegram-bot-api:latest
   ```

Bound to `127.0.0.1` only. **Every** outgoing call (messages, questions, uploads of any size) is
tried on the local server first and falls back to the cloud API when it is down, so it is an
accelerator, never a dependency: polling for updates stays on the cloud, no `logOut` is needed, and
stopping Docker just degrades big files to compression/splitting. Telegram Premium does not help
here — it raises limits for user accounts, not bots.

## Auto-start on logon

`scripts/setup.ps1` installs it. By hand:

```powershell
pwsh -File scripts/install-windows.ps1     # Scheduled Task, or Startup-folder launcher if that needs elevation
Start-ScheduledTask -TaskName TelegramBotMCP
```

Uninstall with `scripts/uninstall-windows.ps1`. The daemon runs in your user session so it uses your
`claude` login, survives network-less logons (the Telegram handshake retries with backoff) and is
restarted on failure.

---

## Security model (deny by default)

1. **Identity** — Only the owner's Telegram id, only in the owner's private chat or the configured
   forum group. Every other update is dropped **silently**. Before an owner exists, only the
   `/start` handshake is reachable.
2. **Network** — Outbound only. The IPC listens **exclusively on `127.0.0.1`**. Per-turn tokens
   are random, handed to that turn's `claude` through a generated MCP config that is deleted when
   the turn ends, and revoked at the same moment. The one persisted desktop token is useless
   remotely and cannot choose a recipient.
3. **Secrets** — The bot token lives only in `.env` (git-ignored) and is stripped from the
   environment handed to spawned agents.
4. **Filesystem** — Paths are canonicalised with `realpath`; `..` escapes, symlink/junction escapes,
   UNC paths and Windows device names are rejected; comparison is case-insensitive on Windows.
5. **Hard deny-list** — Disk formatting, shutdown/reboot, registry writes, system-directory edits,
   credential-store access, service/scheduled-task persistence, download-and-execute, firewall and
   Defender tampering, and more — **always, even in `full` mode**.
6. **Anti prompt-injection** — Guardrails outside the LLM, owner-fixed message destination, button
   confirmations, `/panic`, and a full audit log. _Content the agent reads never gains
   capabilities — only you grant them._ Channel events are built only from your own authenticated
   replies, and permission verdicts only from your button taps.
7. **Rate limiting** — Caps updates per minute and concurrent sessions.

The audit trail (`data/audit.jsonl`) records commands, sessions, files, guardrail blocks, routed
replies and IPC rejections. Findings and accepted limits: [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).

---

## Configuration

`config.json` is created on first run and edited through `/config`; you can also edit it by hand
(restart the daemon afterwards).

| Field                          | Default                    | Meaning                                                             |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------- |
| `ownerId`                      | `0` (unclaimed)            | Your Telegram user id; set by the claim button.                     |
| `groupId`                      | —                          | Forum supergroup for session topics (`/setgroup`).                  |
| `allowedDirs`                  | `~/Downloads`, `~/Desktop` | The folder allowlist.                                               |
| `defaultModel` / `defaultMode` | `sonnet` / `ro`            | Defaults for new sessions and the private-chat session.             |
| `defaultCwd`                   | first allowed dir          | Working directory of the private-chat session.                      |
| `turnTimeoutMinutes`           | `15`                       | Kill a turn that runs longer.                                       |
| `hibernateAfterMinutes`        | `30`                       | Idle sessions are hibernated (resumed on the next message).         |
| `maxConcurrentSessions`        | `5`                        |                                                                     |
| `claudeBin`                    | `claude`                   | Path or name of the Claude Code executable.                         |
| `rateLimitPerMinute`           | `30`                       |                                                                     |
| `ipcPort`                      | `8765`                     | Fixed loopback port, so the desktop registration survives restarts. |
| `localApiRoot`                 | `http://127.0.0.1:8081`    | The optional local Bot API server.                                  |

`.env`: `BOT_TOKEN` (required), `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` (optional, local server),
`LOG_LEVEL` (optional; `debug` adds one line per incoming update and per bridge message, without
message text). Runtime state lives in `data/` (sessions, audit log, bridge token, logs).
`TBM_DATA_DIR` and `TBM_CONFIG_PATH` redirect both, which is how the test suite keeps its hands off
the live daemon's files.

---

## Development

```bash
npm run check           # typecheck + lint + format check + tests  (what CI runs)
npm test                # vitest
npm run coverage        # ≥90 % statements gate on security-critical and routing modules
npm run lint / format   # eslint / prettier
npm run dev             # daemon from source with reload
```

Live checks that need a real `claude` and/or the running daemon:

| Script                    | Proves                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run smoke:guardrail` | A live `full`-mode session is blocked outside the allowlist and on deny-listed commands.      |
| `npm run smoke:turn`      | `SessionManager` streams a live turn and resumes context on the next one.                     |
| `npm run smoke:mcp`       | A live agent is offered the bridge tools and its call lands on the daemon-chosen destination. |
| `npm run smoke:global`    | The desktop registration delivers a real Telegram message through the running daemon.         |
| `npm run smoke:reply`     | Your swipe-reply comes back to the session that asked.                                        |

Channel mode is interactive-only, so it is verified by hand: see [docs/E2E.md](docs/E2E.md).

### Project layout

```
src/
  audit/      append-only JSONL audit trail
  bot/        grammY wiring: auth, commands, routing, questions, rate limit
  config/     zod-validated config.json + .env
  files/      ls/find/get/upload through the allowlist; oversize compression/splitting
  ipc/        loopback IPC server, token registry, bridge instance registry, protocol
  mcp/        the telegram-bridge MCP server, channel detection, reply router, daemon client
  security/   path allowlist, command deny-list, the PreToolUse hook, guardrail settings
  sessions/   session store, CLI flag builder, stream-json parser, spawn manager
  telegram/   local Bot API server client + local-first transformer
scripts/      setup, install/uninstall, launcher, smoke tests
docs/         ARCHITECTURE.md · E2E.md · SECURITY-AUDIT.md
```

## Troubleshooting

- **The bot ignores me.** Until ownership is claimed only `/start` works; after that only the
  owner's id in the owner's chat or the registered group. Check `data/daemon.log`.
- **My reply says "queued".** The session is alive but neither waiting nor in channel mode. Start
  Claude Code with `scripts\claude-tg.cmd` (or ask the agent to use `wait_for_reply`).
- **No channel notice at startup.** Make sure the flag is `--dangerously-load-development-channels
server:telegram-bridge` (not `--channels`), the session is interactive (not `-p`), and run `/mcp`
  inside Claude Code to see the server's status. Organisation policy may block channels.
- **`claude mcp list` shows the bridge but tools fail.** The daemon is not running, or no owner is
  claimed (409). Start it with `npm start` or the launcher, then `/start` in Telegram.
- **Big files are compressed although Docker runs.** The local server is probed before each send;
  check `docker logs telegram-bot-api` and that `.env` has the API credentials.
- **Nothing works right after logon.** The daemon retries the Telegram handshake with backoff until
  the network is up; wait a minute or check the log.
- **The bot sends but never receives.** Check whether Telegram is holding your messages:
  `getWebhookInfo` shows `pending_update_count`. If it is above zero the daemon is not polling;
  look for `long poll` warnings in `data/daemon.log`, or stop the supervisor and run
  `DEBUG='grammy*' node dist/main.js` to see grammY's own retries.

## Manual setup

1. `npm ci && npm run build`
2. Copy `.env.example` to `.env` and set `BOT_TOKEN`.
3. `npm start`, then `/start` in a private chat with the bot and tap **Claim ownership**.
4. Optional: `/setgroup` in a forum group (sessions in topics), `npm run register:global`
   (desktop sessions), the local Bot API server, `scripts/install-windows.ps1` (auto-start).

## License

MIT — see `LICENSE`.
