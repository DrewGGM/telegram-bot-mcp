# Security audit — 2026-09-01

Audit of the real attack surfaces of this daemon, looking for concretely
exploitable issues rather than generic advice. Every finding below was proved
with a test or a command before being fixed.

## Findings

### 1. HIGH — An unclaimed bot served any stranger (fixed)

**Impact:** file disclosure and exfiltration by whoever reached the bot first.

Between first launch and the moment you tap *Claim ownership*, `config.ownerId`
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

`if (… || !check)` tested truthiness of an *object*, so it was always false and
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
  command *classes* by pattern and a determined, obfuscated command could evade
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
