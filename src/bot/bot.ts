import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import path from "node:path";
import { Agent } from "node:https";
import { homedir } from "node:os";
import { existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { type Config, type SessionMode, saveConfig } from "../config/config.js";
import type { SessionStore, Session } from "../sessions/store.js";
import type { TurnCallbacks } from "../sessions/manager.js";
import { PendingQuestions } from "./pending.js";
import { authMiddleware } from "./auth.js";
import { RateLimiter } from "./ratelimit.js";
import { chunkMessage, humanSize } from "./format.js";
import { parseNewArgs, MODEL_ALIASES } from "./args.js";
import {
  listDir,
  findFiles,
  resolveForGet,
  resolveUploadTarget,
  TELEGRAM_SEND_LIMIT,
  TELEGRAM_RECEIVE_LIMIT,
  TELEGRAM_CAPTION_LIMIT,
} from "../files/files.js";
import { isPathAllowed } from "../security/paths.js";
import { prepareOversize } from "../files/oversize.js";
import {
  isLocalServerUp,
  uploadViaLocalServer,
  forgetLocalServerAvailability,
  localFirstTransformer,
  LOCAL_SEND_LIMIT,
} from "../telegram/localApi.js";
import { pollingWatchdog } from "../telegram/polling.js";
import {
  GLOBAL_SESSION_ID,
  type BridgeTarget,
  type SendFileResult,
  type TelegramBridge,
} from "../ipc/protocol.js";
import type { InstanceRegistry } from "../ipc/instances.js";
import { audit } from "../audit/audit.js";
import { log } from "../logger.js";

/** The slice of SessionManager the bot depends on (kept minimal for testability). */
export interface ManagerLike {
  runTurn(session: Session, prompt: string, cb: TurnCallbacks): Promise<void>;
  kill(sessionId: string): void;
  killAll(): number;
  isPanicked: boolean;
  setPanicked(v: boolean): void;
}

export interface BotDeps {
  token: string;
  getConfig: () => Config;
  setConfig: (c: Config) => void;
  store: SessionStore;
  manager: ManagerLike;
  pending: PendingQuestions;
  startedAt: number;
  /** Live bridge sessions (desktop registration and per-turn), for reply routing. */
  instances?: InstanceRegistry;
  /** Preset bot identity to skip the getMe call (used in offline tests). */
  botInfo?: UserFromGetMe;
}

const YES_LABEL = "✅ Yes";
const NO_LABEL = "❌ No";
const MAX_LIST_ENTRIES = 100;
/** Messages older than this when they reach the daemon are logged and skipped. */
const STALE_UPDATE_SECONDS = 15 * 60;

/** Error messages that mean "the network hiccuped", worth one more try. */
const TRANSIENT_ERROR = /ECONNRESET|socket hang up|ETIMEDOUT|EPIPE|ENOTFOUND|ECONNREFUSED|network|failed/i;

/**
 * grammY handles long-polling updates strictly one at a time. A handler that
 * awaited a whole Claude turn (minutes) or a button tap would therefore freeze
 * every other update — including the very tap it was waiting for, and /panic.
 * Long work is detached: the handler returns at once and failures are logged.
 */
function detach(work: Promise<unknown>, what: string): void {
  work.catch((err) => log.error({ err, what }, "detached task failed"));
}

/**
 * Retry a Telegram call on transient network failures. grammY keeps HTTP
 * sockets alive and the long-polling loop leaves idle ones behind; when
 * Telegram has already closed one, reusing it surfaces as `write ECONNRESET`.
 * A retry gets a fresh socket.
 */
async function withRetry<T>(fn: () => Promise<T>, what: string, attempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_ERROR.test(String(err)) || attempt === attempts) throw err;
      log.warn({ attempt, what, err: String(err) }, "transient Telegram failure, retrying");
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
  throw lastErr;
}

function threadOpts(target: BridgeTarget): { message_thread_id?: number } {
  return target.topicId !== undefined ? { message_thread_id: target.topicId } : {};
}

/**
 * Builds and wires the grammY bot: auth gate, commands, session routing, file
 * ops, and the inline-keyboard callback handling shared by confirmations and the
 * MCP ask_user tool. Also exposes a {@link TelegramBridge} the IPC server uses.
 */
export function createBot(deps: BotDeps): { bot: Bot; bridge: TelegramBridge } {
  const { getConfig, setConfig, store, manager, pending } = deps;
  // Large uploads died with `write ECONNRESET`: grammY reuses keep-alive sockets
  // and the long-polling loop leaves idle ones behind, which Telegram closes.
  // A fresh connection per request costs a handshake and makes big files work.
  const bot = new Bot(deps.token, {
    ...(deps.botInfo ? { botInfo: deps.botInfo } : {}),
    client: { baseFetchConfig: { agent: new Agent({ keepAlive: false }) } },
  });
  // Every outgoing call prefers the local Bot API server when one is running:
  // on a link where api.telegram.org is lossy it reaches Telegram over MTProto
  // and is markedly more reliable. Falls back to the cloud API transparently.
  bot.api.config.use(
    localFirstTransformer({ getApiRoot: () => getConfig().localApiRoot, token: deps.token }),
  );
  // A lost long-poll response must not leave the bot deaf for minutes.
  bot.api.config.use(pollingWatchdog());
  const rate = new RateLimiter(getConfig().rateLimitPerMinute);

  // ---- low-level send helpers -------------------------------------------------

  /** Send (chunked) and return the id of the LAST part - the one you would reply to. */
  async function send(target: BridgeTarget, text: string): Promise<number | undefined> {
    let lastId: number | undefined;
    for (const part of chunkMessage(text)) {
      const msg = await withRetry(
        () => bot.api.sendMessage(target.chatId, part, threadOpts(target)),
        "sendMessage",
      );
      lastId = msg.message_id;
    }
    return lastId;
  }

  /**
   * Upload a document through the cloud API. The InputFile is rebuilt from the
   * path on every attempt: one that has begun streaming cannot be replayed.
   */
  function sendDocument(target: BridgeTarget, filePath: string, caption?: string) {
    return withRetry(
      () =>
        bot.api.sendDocument(target.chatId, new InputFile(filePath), {
          ...(caption ? { caption } : {}),
          ...threadOpts(target),
        }),
      `sendDocument ${filePath}`,
      3,
      750,
    );
  }

  /**
   * Deliver a file that is over Telegram's upload limit (FR-13). Video is
   * re-encoded to fit - a compressed video is still watchable on a phone,
   * whereas half a video is useless - and anything else is split into parts.
   * Derivatives come from an already-validated source, so they are not
   * re-checked against the allowlist.
   */
  async function deliverOversize(
    target: BridgeTarget,
    filePath: string,
    size: number,
    caption?: string,
  ): Promise<SendFileResult> {
    // Preferred route: a local Bot API server lifts the limit to 2000 MB, so the
    // file goes out untouched. Only if it is unavailable do we degrade to
    // compressing or splitting.
    const apiRoot = getConfig().localApiRoot;
    if (size <= LOCAL_SEND_LIMIT && (await isLocalServerUp(apiRoot, deps.token, true))) {
      await send(target, `📦 ${humanSize(size)} - sending in full via the local Bot API server...`);
      const up = await uploadViaLocalServer(apiRoot, deps.token, target.chatId, filePath, {
        ...(caption ? { caption } : {}),
        ...(target.topicId !== undefined ? { topicId: target.topicId } : {}),
      });
      if (up.ok) {
        audit({ kind: "file.sent", path: filePath, bytes: size });
        return { ok: true, ...(up.messageId !== undefined ? { messageId: up.messageId } : {}) };
      }
      log.warn({ filePath, err: up.error }, "local Bot API upload failed, falling back to compression");
    }

    await send(target, `📦 ${humanSize(size)} exceeds Telegram's 50 MB limit. Preparing it...`);
    const plan = await prepareOversize(filePath, TELEGRAM_SEND_LIMIT);
    if (plan.kind === "failed" || plan.files.length === 0) {
      await send(target, `⚠️ ${plan.note}`);
      return { ok: false, error: plan.note };
    }
    await send(target, plan.note);
    try {
      let lastId: number | undefined;
      for (const [i, part] of plan.files.entries()) {
        const label =
          plan.files.length > 1 ? `${path.basename(part)} (${i + 1}/${plan.files.length})` : caption;
        const sentPart = await sendDocument(target, part, label);
        lastId = sentPart.message_id;
      }
      audit({ kind: "file.sent", path: filePath, bytes: size });
      return { ok: true, ...(lastId !== undefined ? { messageId: lastId } : {}) };
    } catch (err) {
      await send(target, `⚠️ Upload failed: ${String(err)}`);
      return { ok: false, error: String(err) };
    } finally {
      if (plan.cleanupDir) rmSync(plan.cleanupDir, { recursive: true, force: true });
    }
  }

  async function typing(target: BridgeTarget): Promise<void> {
    try {
      await bot.api.sendChatAction(target.chatId, "typing", threadOpts(target));
    } catch {
      /* best effort */
    }
  }

  /** Ask a question with buttons and await the owner's tap (FR-16/17). */
  async function ask(target: BridgeTarget, question: string, options: string[]): Promise<string> {
    const opts = options.length ? options.slice(0, 6) : ["OK"];
    const { id, promise } = pending.register(opts);
    const kb = new InlineKeyboard();
    opts.forEach((opt, i) => {
      kb.text(opt, pending.callbackData(id, i));
      if ((i + 1) % 2 === 0) kb.row();
    });
    const parts = chunkMessage(question);
    for (const [i, part] of parts.entries()) {
      // Buttons go on the last part, the one the owner sees at the bottom.
      const last = i === parts.length - 1;
      await withRetry(
        () =>
          bot.api.sendMessage(target.chatId, part, {
            ...(last ? { reply_markup: kb } : {}),
            ...threadOpts(target),
          }),
        "ask",
      );
    }
    return promise;
  }

  async function confirm(target: BridgeTarget, prompt: string): Promise<boolean> {
    const answer = await ask(target, prompt, [YES_LABEL, NO_LABEL]);
    return answer === YES_LABEL;
  }

  function targetOf(session: Session): BridgeTarget {
    return { chatId: session.chatId, ...(session.topicId !== undefined ? { topicId: session.topicId } : {}) };
  }

  /** Where a reply to this update belongs: same chat, same forum topic. */
  function targetOfCtx(ctx: { chat: { id: number }; msg?: { message_thread_id?: number } }): BridgeTarget {
    const topicId = ctx.msg?.message_thread_id;
    return { chatId: ctx.chat.id, ...(topicId !== undefined ? { topicId } : {}) };
  }

  // ---- allowlist / folder resolution -----------------------------------------

  /** Resolve a user-supplied folder token to an allowed absolute directory. */
  function resolveFolder(input: string): { ok: true; dir: string } | { ok: false; error: string } {
    const cfg = getConfig();
    const candidates = path.isAbsolute(input)
      ? [input]
      : [
          path.join(homedir(), input),
          ...cfg.allowedDirs.map((d) => path.join(d, input)),
          ...cfg.allowedDirs.filter((d) => path.basename(d).toLowerCase() === input.toLowerCase()),
        ];
    for (const c of candidates) {
      const check = isPathAllowed(c, cfg.allowedDirs);
      if (check.allowed && existsSync(check.resolved)) return { ok: true, dir: check.resolved };
    }
    return { ok: false, error: `'${input}' is not inside an allowed folder or does not exist.` };
  }

  // ---- turn execution ---------------------------------------------------------

  async function runTurn(session: Session, prompt: string): Promise<void> {
    const target = targetOf(session);
    await typing(target);
    let delivered = false;
    await manager.runTurn(session, prompt, {
      onTool: (summary) => void send(target, summary).catch(() => {}),
      onResult: (r) => {
        delivered = true;
        const text = r.text.trim() || (r.isError ? "⚠️ The turn ended with an error." : "(no output)");
        void send(target, text).catch((e) => log.error({ e }, "send failed"));
      },
      onError: (msg) => {
        delivered = true;
        void send(target, `⚠️ ${msg}`).catch(() => {});
      },
    });
    if (!delivered) await send(target, "(no response)");
  }

  // ---- middleware -------------------------------------------------------------

  // One line per incoming update (no message text), so "my reply never
  // arrived" can be told apart from "it arrived and was routed somewhere else".
  bot.use(async (ctx, next) => {
    log.debug(
      {
        update: ctx.update.update_id,
        kind: Object.keys(ctx.update).find((k) => k !== "update_id"),
        chat: ctx.chat?.id,
        from: ctx.from?.id,
        replyTo: ctx.message?.reply_to_message?.message_id,
      },
      "update received",
    );
    // Pending updates are kept across restarts (a reply typed while the daemon
    // restarts must not vanish), but a message that waited longer than this is
    // more likely a stale command than something you still want executed.
    const sentAt = ctx.message?.date;
    if (sentAt !== undefined && Date.now() / 1000 - sentAt > STALE_UPDATE_SECONDS) {
      log.info(
        { update: ctx.update.update_id, ageSeconds: Math.round(Date.now() / 1000 - sentAt) },
        "ignored stale update",
      );
      return;
    }
    return next();
  });

  bot.use(authMiddleware(getConfig));

  bot.use(async (ctx, next) => {
    // Light rate limit on messages/callbacks (not on our own sends).
    if ((ctx.message || ctx.callbackQuery) && !rate.allow()) {
      log.warn("rate limited an update");
      return;
    }
    return next();
  });

  // ---- callback queries (buttons) --------------------------------------------

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Owner self-registration (bootstrap).
    if (data.startsWith("claim:")) {
      const cfg = getConfig();
      if (cfg.ownerId === 0) {
        const uid = Number(data.slice("claim:".length));
        if (uid === ctx.from.id) {
          const next = { ...cfg, ownerId: uid };
          saveConfig(next);
          setConfig(next);
          audit({ kind: "config.changed", field: "ownerId", detail: String(uid) });
          await ctx.editMessageText(
            `✅ You are now the owner (id ${uid}). The bot will only respond to you.`,
          );
        }
      } else {
        await ctx.editMessageText("Owner already configured.");
      }
      await ctx.answerCallbackQuery();
      return;
    }

    const res = pending.resolve(data);
    if (res.matched) {
      await ctx.answerCallbackQuery({ text: `You chose: ${res.chosen}` });
      try {
        await ctx.editMessageReplyMarkup(); // remove buttons
      } catch {
        /* ignore */
      }
    } else {
      await ctx.answerCallbackQuery({ text: "This question expired." });
    }
  });

  // ---- commands ---------------------------------------------------------------

  bot.command("start", async (ctx) => {
    const cfg = getConfig();
    if (cfg.ownerId === 0) {
      const kb = new InlineKeyboard().text("👑 Claim ownership", `claim:${ctx.from!.id}`);
      await ctx.reply(
        `Welcome. This bridge has no owner yet.\nYour Telegram id is *${ctx.from!.id}*.\nTap the button to become the only user allowed to control this bot.`,
        { reply_markup: kb, parse_mode: "Markdown" },
      );
      return;
    }
    await ctx.reply(
      "🤖 Telegram ↔ Claude Code bridge is online.\nSend a message to chat with the default session, or /help for commands.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "*Commands*",
        "/status — sessions, uptime, config",
        "/new <folder> [model] [mode] — new session in a group topic",
        "/sessions — list active sessions",
        "/kill <id> — end a session",
        "/info — this topic's session details",
        "/model <opus|sonnet|haiku> — set default model",
        "/ls [path] — list a folder",
        "/find <query> — search files by name",
        "/get <path> — send a file to this chat",
        "/config — manage allowed folders & defaults",
        "/setgroup — register this forum group for sessions",
        "/panic — kill everything & lock  ·  /unlock — resume",
        "",
        "Modes: ro (read-only) · edit (auto-edit) · full (auto, still guarded)",
        "Reply (swipe) to a message from a Claude Code session to answer that session.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("status", async (ctx) => {
    const cfg = getConfig();
    const up = Math.floor((Date.now() - deps.startedAt) / 1000);
    const active = store.list().filter((s) => s.state !== "hibernated");
    const live = (deps.instances?.list() ?? []).filter((i) => deps.instances!.isAlive(i.id)).length;
    const lines = [
      `🤖 Bridge ${manager.isPanicked ? "🔒 LOCKED (/panic)" : "online"}`,
      `⏱ uptime: ${formatDuration(up)}`,
      `🧠 default model: ${cfg.defaultModel} · default mode: ${cfg.defaultMode}`,
      `📂 allowed folders:\n${cfg.allowedDirs.map((d) => `  • ${d}`).join("\n") || "  (none)"}`,
      "",
      `🗂 sessions (${active.length}) · 🖥 connected Claude Code sessions: ${live}`,
      ...store.list().map((s) => `  ${s.id} · ${path.basename(s.cwd)} · ${s.model}/${s.mode} · ${s.state}`),
    ];
    await ctx.reply(lines.join("\n"));
  });

  bot.command("panic", async (ctx) => {
    const n = manager.killAll();
    manager.setPanicked(true);
    pending.clear();
    audit({ kind: "panic", active: true });
    await ctx.reply(`🛑 PANIC: killed ${n} running turn(s). New turns are blocked. Send /unlock to resume.`);
  });

  bot.command("unlock", async (ctx) => {
    manager.setPanicked(false);
    audit({ kind: "panic", active: false });
    await ctx.reply("🔓 Unlocked. Sessions can run again.");
  });

  bot.command("setgroup", async (ctx) => {
    if (ctx.chat.type !== "supergroup") {
      await ctx.reply(
        "Run /setgroup inside your forum supergroup (with topics enabled), where I'm an admin.",
      );
      return;
    }
    const cfg = { ...getConfig(), groupId: ctx.chat.id };
    saveConfig(cfg);
    setConfig(cfg);
    audit({ kind: "config.changed", field: "groupId", detail: String(ctx.chat.id) });
    await ctx.reply(
      `✅ This group (${ctx.chat.id}) is now the sessions group. Use /new to create sessions here.`,
    );
  });

  bot.command("model", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if (!MODEL_ALIASES.includes(arg as (typeof MODEL_ALIASES)[number])) {
      await ctx.reply(`Usage: /model <${MODEL_ALIASES.join("|")}>`);
      return;
    }
    const cfg = { ...getConfig(), defaultModel: arg };
    saveConfig(cfg);
    setConfig(cfg);
    audit({ kind: "config.changed", field: "defaultModel", detail: arg });
    await ctx.reply(`✅ Default model set to ${arg}.`);
  });

  bot.command("new", async (ctx) => {
    const cfg = getConfig();
    if (cfg.groupId === undefined) {
      await ctx.reply(
        "No sessions group configured. Create a forum supergroup, add me as admin, and run /setgroup there.",
      );
      return;
    }
    if (ctx.chat.id !== cfg.groupId) {
      await ctx.reply("Run /new inside the configured sessions group.");
      return;
    }
    if (store.list().filter((s) => s.state !== "hibernated").length >= cfg.maxConcurrentSessions) {
      await ctx.reply(
        `Reached the max of ${cfg.maxConcurrentSessions} concurrent sessions. /kill one first.`,
      );
      return;
    }

    const args = parseNewArgs(ctx.match.trim().split(/\s+/).filter(Boolean));
    if (!args.folder) {
      await ctx.reply("Usage: /new <folder> [opus|sonnet|haiku] [ro|edit|full]");
      return;
    }
    const folder = resolveFolder(args.folder);
    if (!folder.ok) {
      await ctx.reply(`⚠️ ${folder.error}`);
      return;
    }
    const model = args.model ?? cfg.defaultModel;
    const mode: SessionMode = args.mode ?? cfg.defaultMode;
    const name = `📂 ${path.basename(folder.dir)} · ${model} · ${mode}`;

    let topicId: number;
    try {
      const topic = await ctx.api.createForumTopic(cfg.groupId, name);
      topicId = topic.message_thread_id;
    } catch (e) {
      await ctx.reply(`⚠️ Could not create a topic (am I an admin with 'Manage topics'?). ${String(e)}`);
      return;
    }
    const session = store.create({ cwd: folder.dir, model, mode, chatId: cfg.groupId, topicId });
    audit({ kind: "session.created", sessionId: session.id, cwd: folder.dir, model, mode });
    await bot.api.sendMessage(
      cfg.groupId,
      `✅ Session ${session.id} ready in ${folder.dir}\nModel ${model} · mode ${mode}. Send messages here to talk to it.`,
      { message_thread_id: topicId },
    );
  });

  bot.command("sessions", async (ctx) => {
    const list = store.list();
    const registry = deps.instances;
    const connected = registry ? registry.list().filter((i) => registry.isAlive(i.id)) : [];
    const parts: string[] = [];

    if (list.length) {
      parts.push(
        "🗂 Bridge sessions:\n" +
          list
            .map(
              (s) =>
                `${s.id} · ${s.cwd}\n   ${s.model}/${s.mode} · ${s.state}${s.isDefault ? " · default" : ""}`,
            )
            .join("\n"),
      );
    }
    if (connected.length) {
      // Claude Code sessions elsewhere on this machine with the bridge attached.
      // You answer one by swiping on a message it sent.
      parts.push(
        "🖥 Connected Claude Code sessions (reply to their messages to answer):\n" +
          connected
            .map((i) => {
              const idle = Math.round((Date.now() - i.lastSeenAt) / 1000);
              const mode = i.waiting
                ? "⏳ waiting for your reply"
                : i.push
                  ? "📡 live — replies go straight into the session"
                  : "📥 inbox — replies are read when it next waits";
              return `[${i.label}] · ${i.cwd}\n   ${mode} · seen ${idle}s ago`;
            })
            .join("\n"),
      );
    }
    await ctx.reply(parts.join("\n\n") || "No sessions. Use /new in the sessions group.");
  });

  bot.command("kill", async (ctx) => {
    const id = ctx.match.trim();
    const session =
      store.get(id) ?? (ctx.msg?.message_thread_id ? store.byTopic(ctx.msg.message_thread_id) : undefined);
    if (!session) {
      await ctx.reply("Usage: /kill <session-id> (see /sessions)");
      return;
    }
    manager.kill(session.id);
    store.remove(session.id);
    audit({ kind: "session.killed", sessionId: session.id, reason: "kill command" });
    if (session.topicId !== undefined && session.chatId === getConfig().groupId) {
      try {
        await ctx.api.closeForumTopic(session.chatId, session.topicId);
      } catch {
        /* ignore */
      }
    }
    await ctx.reply(`🗑 Session ${session.id} terminated.`);
  });

  bot.command("info", async (ctx) => {
    const session = ctx.msg?.message_thread_id
      ? store.byTopic(ctx.msg.message_thread_id)
      : store.defaultFor(ctx.chat.id);
    if (!session) {
      await ctx.reply("No session bound to this chat/topic.");
      return;
    }
    await ctx.reply(
      `Session ${session.id}\ncwd: ${session.cwd}\nmodel: ${session.model}\nmode: ${session.mode}\nstate: ${session.state}\nclaudeId: ${session.claudeSessionId}`,
    );
  });

  bot.command("ls", async (ctx) => {
    const cfg = getConfig();
    const arg = ctx.match.trim();
    const dir = arg ? resolveFolder(arg) : { ok: true as const, dir: cfg.allowedDirs[0] ?? homedir() };
    if (!dir.ok) {
      await ctx.reply(`⚠️ ${dir.error}`);
      return;
    }
    const res = listDir(dir.dir, cfg.allowedDirs);
    if (!res.ok) {
      await ctx.reply(`⚠️ ${res.error}`);
      return;
    }
    const lines = res
      .value!.slice(0, MAX_LIST_ENTRIES)
      .map((e) => (e.isDir ? `📁 ${e.name}` : `📄 ${e.name} (${humanSize(e.size)})`));
    await ctx.reply(`📂 ${dir.dir}\n\n${lines.join("\n") || "(empty)"}`);
  });

  bot.command("find", async (ctx) => {
    const q = ctx.match.trim();
    if (!q) {
      await ctx.reply("Usage: /find <name fragment>");
      return;
    }
    const hits = findFiles(q, getConfig().allowedDirs);
    if (!hits.length) {
      await ctx.reply("No matches inside the allowed folders.");
      return;
    }
    await ctx.reply(hits.map((h) => `📄 ${h.path} (${humanSize(h.size)})`).join("\n"));
  });

  bot.command("get", async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply("Usage: /get <path> (absolute, or found via /find)");
      return;
    }
    const res = resolveForGet(arg, getConfig().allowedDirs);
    if (!res.ok) {
      await ctx.reply(`⚠️ ${res.error}`);
      return;
    }
    await ctx.replyWithChatAction("upload_document").catch(() => {});
    // Same path as the agent's telegram_send_file: local server first, oversize
    // handling, and delivery into the topic the command came from.
    detach(bridge.sendFile(targetOfCtx(ctx), res.value!.path), "/get");
  });

  bot.command("config", async (ctx) => {
    const cfg = getConfig();
    const [sub, ...rest] = ctx.match.trim().split(/\s+/).filter(Boolean);
    const value = rest.join(" ");
    if (sub === "add" && value) {
      // Must be an absolute path to a real DIRECTORY, otherwise a plain file
      // could be added to the allowlist as if it were a folder.
      const isDir = existsSync(value) && statSync(value).isDirectory();
      if (!path.isAbsolute(value) || !isDir) {
        await ctx.reply("Provide an absolute path to an existing folder: /config add C:\\Users\\me\\Docs");
        return;
      }
      const target = targetOfCtx(ctx);
      // Detached: the confirmation tap is itself an update, which could not be
      // processed while this handler sat waiting for it.
      detach(
        (async () => {
          audit({ kind: "confirm.requested", action: "allowlist.add", target: value });
          const ok = await confirm(target, `Add this folder to the allowlist?\n${value}`);
          audit({ kind: "confirm.resolved", action: "allowlist.add", target: value, approved: ok });
          if (!ok) {
            await send(target, "Cancelled.");
            return;
          }
          const current = getConfig();
          const next = {
            ...current,
            allowedDirs: [...new Set([...current.allowedDirs, path.resolve(value)])],
          };
          saveConfig(next);
          setConfig(next);
          audit({ kind: "config.changed", field: "allowedDirs.add", detail: value });
          await send(
            target,
            `✅ Added. Allowed folders:\n${next.allowedDirs.map((d) => `• ${d}`).join("\n")}`,
          );
        })(),
        "/config add",
      );
    } else if (sub === "remove" && value) {
      const next = {
        ...cfg,
        allowedDirs: cfg.allowedDirs.filter((d) => d.toLowerCase() !== path.resolve(value).toLowerCase()),
      };
      saveConfig(next);
      setConfig(next);
      audit({ kind: "config.changed", field: "allowedDirs.remove", detail: value });
      await ctx.reply(
        `✅ Removed. Allowed folders:\n${next.allowedDirs.map((d) => `• ${d}`).join("\n") || "(none)"}`,
      );
    } else if (sub === "timeout" && value && Number.isFinite(Number(value))) {
      const next = { ...cfg, turnTimeoutMinutes: Math.max(1, Math.floor(Number(value))) };
      saveConfig(next);
      setConfig(next);
      await ctx.reply(`✅ Turn timeout set to ${next.turnTimeoutMinutes} min.`);
    } else {
      await ctx.reply(
        [
          "*Config*",
          `allowed folders:\n${cfg.allowedDirs.map((d) => `• ${d}`).join("\n") || "(none)"}`,
          `default model: ${cfg.defaultModel}`,
          `default mode: ${cfg.defaultMode}`,
          `turn timeout: ${cfg.turnTimeoutMinutes} min`,
          "",
          "Usage: /config add <abs path> · /config remove <abs path> · /config timeout <min>",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    }
  });

  // ---- file uploads (FR-14) ---------------------------------------------------

  bot.on([":document", ":photo"], async (ctx) => {
    const cfg = getConfig();
    const session = ctx.msg.message_thread_id
      ? store.byTopic(ctx.msg.message_thread_id)
      : (store.defaultFor(ctx.chat.id) ?? ensureDefaultSession(ctx.chat.id, cfg));
    if (!session) {
      await ctx.reply("No session to receive this file. Open a topic session first.");
      return;
    }
    const doc = ctx.msg.document;
    const photo = ctx.msg.photo?.at(-1);
    const fileId = doc?.file_id ?? photo?.file_id;
    const size = doc?.file_size ?? photo?.file_size ?? 0;
    const name = doc?.file_name ?? `photo_${Date.now()}.jpg`;
    if (!fileId) return;
    if (size > TELEGRAM_RECEIVE_LIMIT) {
      await ctx.reply(`⚠️ ${humanSize(size)} exceeds Telegram's 20 MB download limit.`);
      return;
    }

    const dest = resolveUploadTarget(session.cwd, name, cfg.allowedDirs);
    if (!dest.ok) {
      await ctx.reply(`⚠️ ${dest.error}`);
      return;
    }
    const target = targetOfCtx(ctx);
    detach(
      (async () => {
        try {
          const file = await ctx.getFile();
          const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
          const resp = await fetch(url);
          const buf = Buffer.from(await resp.arrayBuffer());
          writeFileSync(dest.value!.path, buf);
          audit({ kind: "file.received", path: dest.value!.path, bytes: buf.length });
          await send(target, `✅ Saved to ${dest.value!.path} (${humanSize(buf.length)}).`);
        } catch (e) {
          await send(target, `⚠️ Could not save the file: ${String(e)}`);
        }
      })(),
      "upload",
    );
  });

  // ---- plain text → route to a session ---------------------------------------

  bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    if (text.startsWith("/")) return; // unknown command; ignore quietly
    const cfg = getConfig();

    // Replying to a message a Claude Code session sent? Hand it to that
    // session instead of running a turn here (FR-19 two-way).
    const repliedTo = ctx.msg.reply_to_message?.message_id;
    if (repliedTo !== undefined && deps.instances) {
      const origin = deps.instances.ownerOfMessage(repliedTo);
      log.debug(
        {
          repliedTo,
          origin: origin
            ? { label: origin.label, alive: origin.alive, push: origin.push, waiting: origin.waiting }
            : null,
        },
        "owner reply received",
      );
      if (origin) {
        if (origin.alive && deps.instances.deliver(origin.id, text)) {
          const mode = origin.waiting ? "waiting" : origin.push ? "push" : "queued";
          audit({ kind: "reply.routed", label: origin.label, mode });
          const how =
            mode === "waiting"
              ? "it was waiting for this"
              : mode === "push"
                ? "pushed straight into the session"
                : "queued until it next waits for a reply";
          await ctx.reply(`📨 Sent to [${origin.label}] — ${how}.`, {
            reply_parameters: { message_id: ctx.msg.message_id },
          });
          return;
        }
        if (origin.sessionId === GLOBAL_SESSION_ID || origin.sessionId === "") {
          await ctx.reply(`⚠️ [${origin.label}] is no longer running, so it can't receive this.`, {
            reply_parameters: { message_id: ctx.msg.message_id },
          });
          return;
        }
        // The message came from a session this daemon runs. Its turn is over,
        // so the reply is simply the next message for that chat/topic below.
      }
    }

    let session: Session | undefined;
    if (ctx.msg.message_thread_id && ctx.chat.id === cfg.groupId) {
      session = store.byTopic(ctx.msg.message_thread_id);
      if (!session) {
        await ctx.reply("This topic has no session (it may have been killed). Use /new.");
        return;
      }
    } else if (ctx.chat.id === cfg.ownerId) {
      session = store.defaultFor(ctx.chat.id) ?? ensureDefaultSession(ctx.chat.id, cfg);
    }
    if (!session) return;

    audit({ kind: "command", command: "<message>", userId: ctx.from!.id });
    // Detached: a turn can take minutes, and the update loop must stay free
    // for button taps, replies to other sessions, and /panic meanwhile.
    detach(runTurn(session, text), `turn ${session.id}`);
  });

  /** Create the implicit read-only default session for the owner's private chat (FR-4). */
  function ensureDefaultSession(chatId: number, cfg: Config): Session | undefined {
    const cwd =
      cfg.defaultCwd && isPathAllowed(cfg.defaultCwd, cfg.allowedDirs).allowed
        ? cfg.defaultCwd
        : cfg.allowedDirs[0];
    if (!cwd) return undefined;
    const s = store.create({ cwd, model: cfg.defaultModel, mode: "ro", chatId, isDefault: true });
    audit({ kind: "session.created", sessionId: s.id, cwd, model: cfg.defaultModel, mode: "ro" });
    return s;
  }

  // ---- the bridge exposed to the IPC/MCP layer -------------------------------

  const bridge: TelegramBridge = {
    async sendMessage(target, text) {
      return send(target, text);
    },
    async sendFile(target, filePath, caption) {
      const res = resolveForGet(filePath, getConfig().allowedDirs);
      if (!res.ok) {
        // Name the path and record it: without this you get identical, useless
        // warnings and no way to tell which folder needs allowing.
        audit({
          kind: "guardrail.blocked",
          tool: "telegram_send_file",
          rule: "path allowlist",
          detail: filePath,
        });
        await send(
          target,
          `⚠️ Blocked file send: ${res.error}\n${filePath}\n\nAllow it with: /config add <folder>`,
        );
        return { ok: false, error: `${res.error}: ${filePath}` };
      }

      // A caption over Telegram's 1024-character cap fails the entire send, so
      // long text goes out as its own message and the file keeps a short label.
      let fileCaption = caption;
      if (caption && caption.length > TELEGRAM_CAPTION_LIMIT) {
        await send(target, caption);
        fileCaption = path.basename(res.value!.path);
      }

      // The local Bot API server is both more reliable on a lossy link and not
      // bound by the 50 MB cap, so prefer it for EVERY upload, not just the big
      // ones.
      const apiRoot = getConfig().localApiRoot;
      const localUp = await isLocalServerUp(apiRoot, deps.token);
      const limit = localUp ? LOCAL_SEND_LIMIT : TELEGRAM_SEND_LIMIT;
      if (res.value!.size > limit) {
        return deliverOversize(target, res.value!.path, res.value!.size, fileCaption);
      }

      if (localUp) {
        const up = await uploadViaLocalServer(apiRoot, deps.token, target.chatId, res.value!.path, {
          ...(fileCaption ? { caption: fileCaption } : {}),
          ...(target.topicId !== undefined ? { topicId: target.topicId } : {}),
        });
        if (up.ok) {
          audit({ kind: "file.sent", path: res.value!.path, bytes: res.value!.size });
          return up;
        }
        forgetLocalServerAvailability();
        log.warn({ filePath, err: up.error }, "local Bot API upload failed, falling back to the cloud API");
      }

      try {
        const sent = await sendDocument(target, res.value!.path, fileCaption);
        audit({ kind: "file.sent", path: res.value!.path, bytes: res.value!.size });
        return { ok: true, messageId: sent.message_id };
      } catch (err) {
        const error = `upload failed: ${String(err)}`;
        await send(target, `⚠️ Could not upload ${filePath}\n${String(err)}`);
        return { ok: false, error };
      }
    },
    async askUser(target, question, options) {
      return ask(target, question, options);
    },
  };

  bot.catch((err) => log.error({ err: err.error }, "bot error"));

  return { bot, bridge };
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", `${s}s`].filter(Boolean).join(" ");
}
