# Architecture

How the daemon is put together, the decisions behind it, and the parts that are easy to get wrong.
The user-facing picture is in the [README](../README.md).

## Modules (`src/`)

| Module                   | Responsibility                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `config/`                | Zod-validated `config.json` + `.env` loading.                                                                        |
| `security/paths.ts`      | Path canonicalisation + folder allowlist (anti-traversal, anti-symlink, UNC/device rejection, Windows case-folding). |
| `security/commands.ts`   | Hard deny-list of catastrophic command classes.                                                                      |
| `security/hook.ts`       | The PreToolUse hook binary — the enforcement point. Exit 2 blocks, exit 0 allows.                                    |
| `security/guardrails.ts` | Generates the `--settings` file that installs the hook.                                                              |
| `sessions/`              | Session store (atomic JSON), CLI flag builder, stream-json parser, spawn manager.                                    |
| `files/`                 | Deterministic `ls`/`find`/`get`/upload, always through the allowlist; oversize compression/splitting.                |
| `telegram/localApi.ts`   | Client for the optional local Bot API server and the local-first grammY transformer.                                 |
| `ipc/server.ts`          | Loopback-only HTTP server: token auth, destination fixing, bridge routes.                                            |
| `ipc/instances.ts`       | Registry of bridge instances: identity, liveness, waiting/push state, inbox, message ownership.                      |
| `ipc/protocol.ts`        | The IPC contract (routes, bodies, results) shared by daemon and bridge.                                              |
| `mcp/server.ts`          | The `telegram-bridge` MCP server: tools, channel push, permission relay, reply loop.                                 |
| `mcp/channel.ts`         | Detects whether the parent `claude` opted this server in as a channel.                                               |
| `mcp/replies.ts`         | Decides where a pulled reply goes (tool → channel → inbox), exactly once.                                            |
| `mcp/daemon.ts`          | Typed HTTP client for the IPC, used by the bridge.                                                                   |
| `mcp/config.ts`          | Builds the `--mcp-config` document for sessions the daemon spawns.                                                   |
| `bot/`                   | grammY wiring: auth gate, commands, routing, uploads, questions with buttons, rate limiting.                         |
| `audit/`                 | Append-only JSONL audit trail.                                                                                       |
| `main.ts`                | Entrypoint: wires everything, long-polls Telegram, hibernation sweep, clean shutdown.                                |

## Decisions

**ADR-1 · One `claude -p --resume` process per turn.** No long-lived interactive child. Hibernation
is free (nothing to keep alive), a crash never loses conversation state (it lives in Claude Code's
own session store), and `/panic` is just "kill the children".

**ADR-2 · Long polling, never a webhook.** Zero inbound ports on the PC.

**ADR-3 · Guardrails as PreToolUse hooks, not permission modes.** Permission modes are the model's
UX; hooks are the harness's law. The hook runs before every `Bash`/`PowerShell`/`Write`/`Edit`/
`NotebookEdit` call, in all modes, and fails closed on internal errors for those tools.

**ADR-4 · Forum topics as the multi-session UX.** One topic per session; the topic id is the
routing key.

**ADR-5 · The bridge never names a recipient.** Tools take no `chat_id`. The daemon resolves the
destination from the bearer token (per-turn: the session's chat/topic; desktop: the owner's private
chat, resolved per request so it follows a late ownership claim).

**ADR-6 · Replies are pulled by the bridge and delivered exactly once.** See below.

## Reply routing (FR-19 two-way)

Every bridge process registers with the daemon at startup and gets an unguessable instance id. A
message it sends is remembered as "owned" by that instance. When you swipe-reply in Telegram:

```
owner swipe-reply ─► bot (auth gate) ─► instances.ownerOfMessage(replied id)
                                           │
              alive? ──no──► desktop session: "no longer running"
                 │            per-turn session: fall through → next turn of that chat/topic
                yes
                 ▼
        instances.deliver(id, text) ─► hands to the bridge's open long-poll, or queues
                                           │
                       bridge ReplyRouter.dispatch(text)
                         1. a tool call is blocked waiting  → resolve it   ("waiting")
                         2. session opted in as a channel   → push event   ("push")
                         3. otherwise                        → local inbox  ("queued")
```

The bridge keeps one `POST /wait_reply` long-poll open for as long as it lives (55 s per poll, the
daemon's liveness window is 2 min). That poll is what makes "alive" meaningful: a bridge whose
Claude Code exited stops polling and is reported as gone within two minutes, and forgotten after ten.
Per-turn bridges are dropped the moment the daemon revokes the turn's token.

If the bridge hangs up mid-poll (its process died), the daemon aborts the waiter so the reply stays
queued instead of being written to a socket nobody reads.

### Channel mode

Claude Code's channels (research preview) let an MCP server push `notifications/claude/channel`
`{ content, meta }` into the session; Claude receives it as a `<channel source="telegram-bridge" …>`
user turn. The server declares `capabilities.experimental["claude/channel"]`. Claude Code only
honours the notifications for servers named on the command line
(`--dangerously-load-development-channels server:telegram-bridge` during the preview) and never
tells the server whether that happened — unsolicited notifications are simply dropped.

The bridge therefore decides its mode once at startup from the parent process's command line
(`mcp/channel.ts`, `TBM_CHANNEL=1|0` overrides) and reports it at `/register`, so the bot's
acknowledgement and `/sessions` reflect what will really happen. The failure direction is safe: an
undetected opt-in means replies are queued (readable with `telegram_wait_reply`), never lost.

Permission relay uses the same mechanism in reverse: Claude Code sends
`notifications/claude/channel/permission_request` to channel servers that declare
`claude/channel/permission`; the bridge turns it into a `telegram_ask_user`-style question with
Allow/Deny buttons and answers with `notifications/claude/channel/permission`.

## The update loop rule

grammY's built-in long polling handles updates **strictly one at a time**. Any handler that awaits
something that itself needs a later update — a whole Claude turn whose agent calls
`telegram_ask_user`, or a `/config add` confirmation button — would deadlock the bot until a timeout.
`/panic` would not be processed either. The rule in `bot/bot.ts` is therefore: handlers return
immediately; long work is `detach()`ed and its failures are logged. This is cheaper and simpler than
`@grammyjs/runner` for a single-user bot and keeps ordering for the quick commands.

## Reliability of sends

- **Local-first transformer** (`telegram/localApi.ts`). One grammY API transformer tries every JSON
  method on the local Bot API server when it is up and falls back to the cloud API on transport
  failure. Cloud-only methods (`getUpdates`, `getFile`, webhook/session management) and multipart
  uploads bypass it; uploads use `uploadViaLocalServer`, which streams from disk. Availability is
  cached for 30 s and forgotten on failure.
- **Retries on transient socket errors** for messages and uploads; `keepAlive: false` on the cloud
  agent, because reusing a socket Telegram had already closed surfaced as `write ECONNRESET` on
  anything but tiny requests.
- **Oversize files** (over 50 MB without the local server, over 2000 MB with it): video is
  re-encoded with ffmpeg (NVENC when present) to fit, anything else is split with a `copy /b` rejoin
  line. The original is never modified.
- **Captions** over 1024 characters go out as a separate message; the file keeps a short label.
- **Honest results.** A refused or failed send returns `ok: false` to the agent and is audited; it is
  never reported as sent.

## Deliberate deviations from the blueprint

- **Session store is JSON, not SQLite.** A strictly single-user daemon needs an atomic document, not
  a database; the interface is small enough to swap later.
- **FR-16 (destructive-op confirmation)** is realised through permission modes + the guardrail hook
  rather than a per-edit Telegram button. `ro` never edits; `edit`/`full` auto-apply inside the
  allowlist while the hook blocks everything outside it and all deny-listed commands. Allowlist
  changes via `/config` still require a button, and the agent can always ask through
  `telegram_ask_user`.
- **Reads are allowed broadly; writes and commands are confined.** Because the message destination
  is fixed to the owner, a broad read grants no exfiltration capability.
- **The desktop token is persisted** (`data/bridge-token`), a deliberate exception to "IPC tokens
  never touch disk": a registration in your Claude Code config must survive daemon restarts. It is
  loopback-only, cannot choose a recipient, and grants nothing outside the allowlist.
