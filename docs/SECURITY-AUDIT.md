# Security audit — 2026-09-01

Audit of the real attack surfaces of this daemon, looking for concretely
exploitable issues rather than generic advice. Every finding below was proved
with a test or a command before being fixed.

## Findings

### 1. HIGH — An unclaimed bot served any stranger (fixed)

**Impact:** file disclosure and exfiltration by whoever reached the bot first.

Between first launch and the moment you tap _Claim ownership_, `config.ownerId`
is `0`. `decideAuth` correctly returned `bootstrap` for a private chat, but the
middleware then called `next()` for **every** update, and the `/ls`, `/find`,
`/get` and `/config` handlers never re-checked the owner. A stranger who knew
the bot's username could, during that window:

- `/ls <dir>` — list any allowed directory
- `/find <name>` — search filenames across the allowlist
- `/get <path>` — **receive any file inside the allowlist**
- `/config` — read the allowlist, and widen it

Proved with `src/bot/bootstrap-security.test.ts`, which drives the real bot with
a stranger's update: before the fix, `sendDocument` actually fired with the
victim's file.

**Fix:** the bootstrap window is now narrowed in the middleware itself
(`isOwnershipHandshake`) to `/start` and the `claim:` callback. Everything else
is dropped silently. Doing it centrally means a newly added command cannot
accidentally become reachable before an owner exists.

### 2. LOW — Misleading claim of `chmod 0600` on Windows (fixed)

`loadOrCreateGlobalToken` called `chmodSync(…, 0o600)` on the persisted bridge
token and the comment claimed the file was locked down. `chmod` is a no-op on
Windows. An `icacls /inheritance:r /grant:r` attempt reported success on this
path yet left the ACL unchanged, so the code now does the honest thing: a real
`0600` on POSIX, and on Windows it documents that protection comes from the
inherited user-profile ACL — verified as `SYSTEM`, `Administrators`, and the
owning user, with **no `Everyone` or `Users` entry**. Removing SYSTEM and
Administrators would buy nothing: an administrator can read the process memory
holding the same token.

### 3. LOW — Dead validation in `/config add` (fixed)

`if (… || !check)` tested truthiness of an _object_, so it was always false and
never fired. The path was also not required to be a directory, so a plain file
could be added to the folder allowlist. Now requires absolute + existing +
`isDirectory()`.

## Verified as sound (no change needed)

- **Owner gate.** A non-owner receives no reply at all — no error, no hint the
  bot exists. Covered by `auth.test.ts` and an end-to-end offline bot test.
- **Destination fixing (ADR-5).** The MCP tools accept no `chat_id`; the daemon
  derives it from the session token. A live agent test confirms a call lands on
  the daemon-chosen destination even when the body carries a different id, so a
  prompt injection cannot redirect output to a third party.
- **IPC exposure.** Binds `127.0.0.1` only; unknown or missing token → 403;
  no owner yet → 409 rather than misrouting. Tokens are 192-bit random.
- **Guardrails.** Deny-listed commands and writes outside the allowlist are
  blocked by the PreToolUse hook even in `bypassPermissions` mode, proved
  against a live `claude` session (`npm run smoke:guardrail`).
- **Command injection.** ffmpeg and `claude` are spawned with argument arrays
  and `shell: false`; no user string ever reaches a shell.
- **Local Bot API server.** Published on `127.0.0.1:8081` only. Container logs
  were checked and contain no bot token. Note that the server does keep a
  working directory named after the bot token inside its Docker volume — that is
  how the upstream software organises per-bot state, and it is reachable only by
  someone who already has Docker access.
- **Secrets.** `git grep` over the committed tree finds no bot token, no API
  hash and no bridge token. `.env`, `config.json` and `data/` are git-ignored.
- **Dependencies.** `npm audit` reports 0 vulnerabilities.

## Known and accepted limits

- The command deny-list is a **net, not a sandbox**: it blocks catastrophic
  command _classes_ by pattern and a determined, obfuscated command could evade
  it. Path confinement, not the deny-list, is the load-bearing control for
  writes; `/panic` is the backstop.
- `Read` is deliberately allowed outside the allowlist. Because the message
  destination is owner-fixed, a broad read grants no exfiltration capability,
  and confining it would break ordinary use.
- The IPC has no rate limit. A runaway local agent could spam your chat; it
  cannot reach anyone else.
- **First-tap-wins ownership.** Whoever sends `/start` first becomes the owner.
  Claim the bot immediately after the first launch; finding #1 above is what made
  that window dangerous, and it is now limited to the handshake alone.

---

# Follow-up audit — 2026-10-26 (v0.3.0)

Second pass over the running daemon, prompted by "some things fail in practice".
The automated suite was green, so the findings below came from reading the code
paths against the runtime behaviour of the libraries, and each was proved with
a test before being fixed.

## Findings

### 4. MEDIUM — The kill switch and every button were dead while a turn ran (fixed)

**Impact:** `/panic` (FR-2) could not be processed while a Claude turn was in
flight — exactly when it matters — and an agent that asked a question with
`telegram_ask_user` during a turn deadlocked until the 10-minute question
timeout, because the tap that would have answered it could not be processed
either. `/config add` had the same flaw with its own confirmation button.

**Cause:** grammY's built-in long polling handles updates strictly one at a
time (`handleUpdates` in `grammy/out/bot.js`: "handle updates sequentially"),
and the text handler awaited the whole turn (`await runTurn(...)`) while
`/config add` awaited `confirm(...)`.

**Fix:** handlers now return immediately and detach long work
(`detach()` in `bot/bot.ts`); the per-session "still working" guard in the
session manager remains. Proved by `bot.test.ts` ("answers /status while a turn
is still running", "/config add completes through the confirmation button").

### 5. LOW — A late reply could be silently lost (fixed)

If the bridge process died while its `/wait_reply` long-poll was open and a
reply arrived before the poll timed out, the daemon handed the reply to a
closed socket. The IPC now aborts the waiter when the client hangs up, so the
reply stays queued (`server.test.ts`: "a poll the bridge hung up on does not
swallow the reply").

### 6. LOW — Unanswered questions leaked a sentinel to the agent (fixed)

`telegram_ask_user` returned the literal `__timeout__` as "the owner answered".
The IPC now returns `{ answer: null, timedOut: true }` and the tool says so.

### 7. INFO — Dependency advisories (fixed)

`@modelcontextprotocol/sdk` ≤ 1.31 carried five advisories (OAuth credential
leakage to a server-chosen authorization server, cross-origin redirect header
replay, bearer tokens for another service accepted, task/session confusion,
memory exhaustion on validation). None of the affected code paths (HTTP
transports, OAuth, experimental tasks) is used here — the bridge is stdio-only —
but the dependency was upgraded to 1.32.2 anyway, together with zod 4 (memory
exhaustion on oversized constrained collections) and vitest 5. `npm audit`: 0.

## New surface reviewed: channel push and permission relay

- **Who can push text into a Claude session?** Only the owner. A channel event
  is built exclusively from a swipe-reply that passed the owner-only auth
  middleware, routed by the daemon to the instance that owns the replied-to
  message. The bridge token cannot be used remotely (loopback) and the IPC has
  no route that lets a caller inject a reply for another instance without the
  daemon's own message-ownership map.
- **Who can approve tool permissions remotely?** Only the owner, by tapping a
  button in their own chat. Verdicts carry a request id issued by Claude Code,
  which drops verdicts for ids it did not issue or has already closed. The
  terminal dialog stays live, so a lost phone answer never blocks the session.
- **The development-channels flag.** Claude Code shows a full-screen warning at
  every start and the flag only lifts the allowlist for the named server. The
  bridge does not and cannot read anything from the session; the flag only
  permits Claude Code to accept the bridge's events.
- **Mode detection reads the parent command line.** This is local process
  metadata, readable by the same user anyway. A wrong "off" verdict queues
  replies (nothing lost); a wrong "on" verdict is prevented by matching the exact
  server name on an explicit channel flag.
- **Prompt-injection surface.** A pushed reply is the owner's own text; content
  the agent reads from files or the web still cannot cause a push, because
  pushes originate only from authenticated Telegram updates.

## Known and accepted limits (updated)

- The command deny-list remains a net, not a sandbox; path confinement is the
  load-bearing control and `/panic` the backstop.
- `Read` is deliberately allowed outside the allowlist (owner-fixed destination).
- The IPC has no rate limit; a runaway local agent could spam your chat, never
  anyone else's.
- First-tap-wins ownership: claim the bot immediately after the first launch.
- Channel mode depends on a research-preview feature whose flag syntax may
  change; the fallback (inbox + `telegram_wait_reply`) does not.
