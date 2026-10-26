# Changelog

All notable changes to this project are documented here. This repository doubles
as the public build report — each milestone from the design blueprint is landed
and validated below.

## [0.3.1] — 2026-10-26

### Fixed

- **The bot could send but never receive.** Incoming messages were lost in three ways: a
  long-poll response lost on a lossy link left grammY waiting up to 500 s while retrying
  silently; the first watchdog for that passed grammY's polyfill AbortSignal to
  `AbortSignal.any`, which made every `getUpdates` fail before reaching the network; and
  `drop_pending_updates` discarded everything sent while the daemon restarted. Each poll now
  has its own deadline (linked by hand to grammY's signal, with a regression test on the real
  polyfill), polling failures are logged, pending updates survive restarts, and messages older
  than 15 minutes are skipped.
- **A turn whose `claude` failed to launch was reported twice** (Node emits `error` and then
  `close`), wrote to the session store after the turn had ended, and marked the conversation as
  started although it never ran. A turn now finishes exactly once.
- **Per-turn tokens were left on disk.** The generated `data/mcp/<session>.json` (which carries
  the turn's IPC token to `claude`) is now deleted when the turn ends.
- The live smoke scripts were out of date (three tools expected, a fake that broke the IPC
  contract) and wrote to the daemon's audit log; they now run against a scratch data dir.

### Changed

- Dead code removed: `escapeMarkdown`, `denyRuleNames`, `SessionStore.active/touch`,
  `SessionManager.isRunning`, the unused `onText` callback, `IpcServer.updateTarget` and its
  "late target" plumbing, `CLOUD_SEND_LIMIT` (duplicated `TELEGRAM_SEND_LIMIT`), the never-emitted
  `file.deleted` audit kind; ten exports that were only used internally are now module-private.
  `noUnusedLocals` / `noUnusedParameters` are enforced.
- `/config add` now records `confirm.requested` / `confirm.resolved` in the audit log (FR-21).
- Diagnostic logs (per update, per bridge message, per routed reply) are `debug` level, and the
  bridge no longer writes the owner's reply text into Claude Code's MCP log.
- Bridges of daemon-run sessions skip channel detection (`claude -p` never honours channels),
  saving a PowerShell launch per turn.
- `ForeignInstance` → `BridgeInstance`: the registry also holds daemon-run sessions.
- `package.json`: license, author, repository metadata.

## [0.3.0] — 2026-10-26

### Added

- **Replies pushed into the session (channel mode).** The bridge is now a Claude Code
  _channel_: it declares the `claude/channel` capability, pulls your swipe-replies from the
  daemon, and delivers each one exactly once — to a blocked `wait_for_reply` /
  `telegram_wait_reply` call if the agent is waiting, otherwise pushed into the session as a
  `notifications/claude/channel` event when the session was started with
  `--dangerously-load-development-channels server:telegram-bridge` (`scripts/claude-tg.cmd`),
  otherwise queued for the next wait. The agent no longer has to block to hear from you. The
  opt-in is detected from the parent `claude` command line (`TBM_CHANNEL=1|0` overrides).
- **Permission prompts answered from the phone.** In channel mode Claude Code relays tool
  approval dialogs to the bridge; they arrive as a Telegram question with ✅ Allow / ❌ Deny
  buttons and the verdict goes back (`claude/channel/permission`).
- **Honest reply acknowledgements and `/sessions` state.** The daemon tracks each bridge's
  liveness (it long-polls while alive), whether its agent is waiting, and whether it can
  receive pushes; the bot tells you "it was waiting", "pushed straight into the session",
  "queued until it next waits" or "no longer running", and `/sessions` shows 📡/⏳/📥.
- **Hook binary contract test** (`hook-process.test.ts`): the real PreToolUse process is run
  with exit-code assertions.
- Tooling: ESLint (typescript-eslint), Prettier, `.editorconfig`, `.gitattributes`, GitHub
  Actions CI on Windows, `npm run check` as the single gate.

### Fixed

- **`/panic`, button taps and confirmations were blocked while a turn ran.** grammY handles
  long-polling updates one at a time and the handlers awaited whole Claude turns and button
  taps, so a `telegram_ask_user` during a turn and `/config add` could only resolve after a
  10–15 minute timeout, and `/panic` was not processed during a turn. Long work is now detached
  from the handler.
- **Questions with buttons bypassed the reliable send path.** Every outgoing Bot API call now
  goes through one local-first grammY transformer (messages, questions, chat actions, `/get`),
  with cloud fallback and retries.
- **`/get` inside a forum topic** delivered the file to the General topic.
- **A reply to a message from a finished daemon session** was parked in a dead inbox; it is now
  the next turn of that chat/topic. Per-turn bridge instances are forgotten when the turn ends.
- **Unanswered questions** returned the literal `__timeout__` to the agent.
- **Tests could overwrite the live `config.json`** (any test exercising `/config` or `/model`
  wrote through the real `saveConfig`). Test runs now get a scratch data dir and config path
  via `TBM_DATA_DIR` / `TBM_CONFIG_PATH`.
- **A reply could be lost** if the bridge hung up on its long-poll just as the reply arrived.
- **The second video-compression attempt could never succeed**: the comma in ffmpeg's
  `min(720\,ih)` filter was never escaped in the JavaScript string.
- Dependencies: `@modelcontextprotocol/sdk` 1.32 (fixes several advisories), zod 4, vitest 5;
  `npm audit` reports 0 vulnerabilities.

### Changed

- `src/files/localupload.ts` became `src/telegram/localApi.ts` (local Bot API client + transformer).
- IPC: `/register` takes `push`, new `/presence` route, `/wait_reply` returns 404 for an unknown
  instance and honours client hang-ups, `/ask_user` returns `{ answer, timedOut }`.
- Documentation restructured: README (usage), `docs/ARCHITECTURE.md` (design), `docs/E2E.md`
  (validation), `docs/SECURITY-AUDIT.md` (findings).

## [0.2.0] — 2026-09-01

### Added

- **Local Bot API server support.** Files up to 2000 MB are sent **untouched**
  instead of being compressed: a 75 MB video goes out in ~27 s with no quality
  loss versus ~150 s re-encoded. Used only as a side channel for oversize
  uploads, so the bot needs no `logOut` and degrades to compression when Docker
  is stopped — verified by stopping the container mid-test.
- **Oversize handling (FR-13, previously unimplemented).** Video is re-encoded
  with ffmpeg/h264_nvenc to fit; anything else is split with a `copy /b` rejoin
  line. The original is never modified.
- **Two-way replies to registered sessions (FR-19).** Swipe-reply to a message
  and it returns to the session that sent it; `telegram_wait_reply` and
  `wait_for_reply` let an agent block for your answer.
- **`scripts/setup.ps1`** — idempotent one-command install: prerequisites,
  build, local Bot API server, auto-start, global MCP registration, launch.
- **Startup-folder auto-start fallback** for machines where Scheduled Task
  registration needs elevation, with a supervisor loop that restarts on failure.

### Fixed

- **Small files were the only ones that failed.** Uploads used the local Bot API
  server only when over 50 MB, so everything smaller took the flaky cloud path —
  backwards. Every upload now prefers the local server, whatever its size.
- **A long caption failed the whole send** (`message caption is too long`).
  Telegram caps captions at 1024 characters; longer text now goes out as its own
  message and the file keeps a short label.
- **Outgoing messages now survive a lossy link to `api.telegram.org`.** Every
  send prefers the local Bot API server (MTProto) when it is up and falls back
  to the cloud API with bounded retries. Diagnosed on a connection where general
  internet was perfect but `api.telegram.org` answered 3/5 while the local route
  answered 5/5, leaving the bridge returning 500s.
- **SECURITY (high): an unclaimed bot served any stranger.** Before ownership was
  claimed, `/ls`, `/find`, `/get` and `/config` were reachable by anyone who
  found the bot — including file exfiltration via `/get`. The bootstrap window is
  now limited, in the middleware, to `/start` and the claim callback. See
  `docs/SECURITY-AUDIT.md`.
- **Large uploads always failed** with `write ECONNRESET`: grammY reused
  keep-alive sockets the server had closed. Now `keepAlive: false`, plus retries.
- **False success on blocked sends.** `telegram_send_file` reported "File sent"
  even when the daemon refused the file; failures now propagate as `isError`.
- Blocked sends name the offending path and are recorded in the audit log.
- The daemon no longer dies when the network is unavailable at logon; the
  Telegram handshake and command-menu publication retry with backoff.
- `/config add` accepted a file as a folder and had a dead validation clause.
- Misleading `chmod 0600` claim on Windows replaced with an accurate one.

## [0.1.0] — 2026-08-28

First complete, end-to-end validated version. All milestones M0–M5 implemented.

### Added — Security core (TDD first)

- `security/paths.ts` — path canonicalization + folder allowlist: anti-traversal,
  anti-symlink/junction escape, UNC and Windows device-name rejection,
  case-insensitive comparison on Windows, deny-by-default on an empty allowlist.
- `security/commands.ts` — hard deny-list of catastrophic command classes
  (disk/format, power, registry, persistence, system dirs, credential access,
  download-and-execute, firewall/Defender, drive-root recursive delete, …).
- `security/hook.ts` — the PreToolUse hook binary; blocks deny-listed commands and
  writes outside the allowlist even in `bypassPermissions` mode (ADR-3).
- `security/guardrails.ts` — generates the `--settings` file that installs the hook.

### Added — Engine (M1)

- `sessions/stream.ts` — total, throw-free parser for `claude --output-format stream-json`.
- `sessions/cli.ts` — pure CLI flag builder; `ro/edit/full` → permission-mode mapping.
- `sessions/store.ts` — atomic JSON-backed session store with hibernation support.
- `sessions/manager.ts` — spawns one `claude -p --resume` per turn (ADR-1), streams
  events, enforces per-turn timeout, and supports `/kill` and `/panic`.

### Added — Files (M3)

- `files/files.ts` — deterministic `ls`/`find`/`get`/upload, always through the allowlist,
  with Telegram size limits.

### Added — MCP bridge (M4)

- `ipc/` — loopback-only (`127.0.0.1`) HTTP server with per-session tokens; destination
  fixed by the daemon (ADR-5, anti-exfiltration).
- `mcp/server.ts` — the `telegram-bridge` MCP server exposing `telegram_send_message`,
  `telegram_send_file`, `telegram_ask_user`.

### Added — Bot & daemon (M0, M2, M5)

- `bot/auth.ts` — owner-only identity gate (FR-1), silent drop for everyone else.
- `bot/bot.ts` — grammY wiring: commands, session routing, uploads, inline-keyboard
  confirmations/questions, rate limiting, first-run owner self-registration.
- `bot/{format,args,pending,ratelimit}.ts` — chunking, arg parsing, pending questions, throttle.
- `audit/audit.ts` — append-only JSONL audit trail (FR-21).
- `main.ts` — daemon entrypoint: long polling (ADR-2), hibernation sweep, clean shutdown.
- `scripts/install-windows.ps1` / `uninstall-windows.ps1` — Scheduled-Task auto-start (T5.4).

### Validation

- 164 unit/integration tests; ≥90% coverage on security-critical modules.
- Real-Claude guardrail smoke test (5/5): `full`-mode session blocked outside the allowlist.
- Real MCP bridge subprocess driven by an MCP client through the loopback IPC.
- Live daemon boot against Telegram (long polling) with clean shutdown.
