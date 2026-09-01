# Changelog

All notable changes to this project are documented here. This repository doubles
as the public build report — each milestone from the design blueprint is landed
and validated below.

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
