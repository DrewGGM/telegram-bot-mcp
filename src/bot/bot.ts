import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { type Config, type SessionMode, saveConfig } from "../config/config.js";
import type { SessionStore, Session } from "../sessions/store.js";
import type { TurnCallbacks } from "../sessions/manager.js";

/** The slice of SessionManager the bot depends on (kept minimal for testability). */
export interface ManagerLike {
  runTurn(session: Session, prompt: string, cb: TurnCallbacks): Promise<void>;
  kill(sessionId: string): void;
  killAll(): number;
  isPanicked: boolean;
  setPanicked(v: boolean): void;
}
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
} from "../files/files.js";
import { isPathAllowed } from "../security/paths.js";
import { writeFileSync } from "node:fs";
import type { BridgeTarget, TelegramBridge } from "../ipc/protocol.js";
import type { InstanceRegistry } from "../ipc/instances.js";
import { audit } from "../audit/audit.js";
import { log } from "../logger.js";

export interface BotDeps {
  token: string;
  getConfig: () => Config;
  setConfig: (c: Config) => void;
  store: SessionStore;
  manager: ManagerLike;
  pending: PendingQuestions;
  startedAt: number;
  /** Live foreign sessions (desktop registration), for reply routing. */
  instances?: InstanceRegistry;
  /** Preset bot identity to skip the getMe call (used in offline tests). */
  botInfo?: UserFromGetMe;
}

/**
 * Builds and wires the grammY bot: auth gate, commands, session routing, file
 * ops, and the inline-keyboard callback handling shared by confirmations and the
 * MCP ask_user tool. Also exposes a {@link TelegramBridge} the IPC server uses.
 */
export function createBot(deps: BotDeps): { bot: Bot; bridge: TelegramBridge } {
  const { getConfig, setConfig, store, manager, pending } = deps;
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});
  const rate = new RateLimiter(getConfig().rateLimitPerMinute);

  // ---- low-level send helpers -------------------------------------------------

  /** Send (chunked) and return the id of the LAST part — the one you'd reply to. */
  async function send(target: BridgeTarget, text: string): Promise<number | undefined> {
    let lastId: number | undefined;
    for (const part of chunkMessage(text)) {
      const sent = await bot.api.sendMessage(target.chatId, part, {
        ...(target.topicId !== undefined ? { message_thread_id: target.topicId } : {}),
      });
      lastId = sent.message_id;
    }
    return lastId;
  }

  async function typing(target: BridgeTarget): Promise<void> {
    try {
      await bot.api.sendChatAction(target.chatId, "typing", {
        ...(target.topicId !== undefined ? { message_thread_id: target.topicId } : {}),
      });
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
    await bot.api.sendMessage(target.chatId, question, {
      reply_markup: kb,
      ...(target.topicId !== undefined ? { message_thread_id: target.topicId } : {}),
    });
    return promise;
  }

  async function confirm(target: BridgeTarget, prompt: string): Promise<boolean> {
    const answer = await ask(target, prompt, ["✅ Sí", "❌ No"]);
    return answer.includes("Sí");
  }

  function targetOf(session: Session): BridgeTarget {
    return { chatId: session.chatId, ...(session.topicId !== undefined ? { topicId: session.topicId } : {}) };
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
          await ctx.editMessageText(`✅ You are now the owner (id ${uid}). The bot will only respond to you.`);
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
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("status", async (ctx) => {
    const cfg = getConfig();
    const up = Math.floor((Date.now() - deps.startedAt) / 1000);
    const active = store.list().filter((s) => s.state !== "hibernated");
    const lines = [
      `🤖 Bridge ${manager.isPanicked ? "🔒 LOCKED (/panic)" : "online"}`,
      `⏱ uptime: ${formatDuration(up)}`,
      `🧠 default model: ${cfg.defaultModel} · default mode: ${cfg.defaultMode}`,
      `📂 allowed folders:\n${cfg.allowedDirs.map((d) => `  • ${d}`).join("\n") || "  (none)"}`,
      "",
      `🗂 sessions (${active.length}):`,
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
      await ctx.reply("Run /setgroup inside your forum supergroup (with topics enabled), where I'm an admin.");
      return;
    }
    const cfg = { ...getConfig(), groupId: ctx.chat.id };
    saveConfig(cfg);
    setConfig(cfg);
    audit({ kind: "config.changed", field: "groupId", detail: String(ctx.chat.id) });
    await ctx.reply(`✅ This group (${ctx.chat.id}) is now the sessions group. Use /new to create sessions here.`);
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
      await ctx.reply("No sessions group configured. Create a forum supergroup, add me as admin, and run /setgroup there.");
      return;
    }
    if (ctx.chat.id !== cfg.groupId) {
      await ctx.reply("Run /new inside the configured sessions group.");
      return;
    }
    if (store.list().filter((s) => s.state !== "hibernated").length >= cfg.maxConcurrentSessions) {
      await ctx.reply(`Reached the max of ${cfg.maxConcurrentSessions} concurrent sessions. /kill one first.`);
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
    const foreign = deps.instances?.list() ?? [];
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
    if (foreign.length) {
      // Foreign = Claude Code sessions elsewhere on this machine that registered
      // the bridge. You answer one by swiping on a message it sent.
      parts.push(
        "🖥 Connected Claude Code sessions (reply to their messages to answer):\n" +
          foreign
            .map((i) => {
              const idleMin = Math.round((Date.now() - i.lastSeenAt) / 60_000);
              const waiting = i.waiters.length > 0 ? " · ⏳ waiting for you" : "";
              return `[${i.label}] · ${i.cwd}\n   last seen ${idleMin}m ago${waiting}`;
            })
            .join("\n"),
      );
    }
    await ctx.reply(parts.join("\n\n") || "No sessions. Use /new in the sessions group.");
  });

  bot.command("kill", async (ctx) => {
    const id = ctx.match.trim();
    const session = store.get(id) ?? (ctx.msg?.message_thread_id ? store.byTopic(ctx.msg.message_thread_id) : undefined);
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
    const lines = res.value!.slice(0, 100).map((e) => (e.isDir ? `📁 ${e.name}` : `📄 ${e.name} (${humanSize(e.size)})`));
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
    if (res.value!.size > TELEGRAM_SEND_LIMIT) {
      await ctx.reply(`⚠️ File is ${humanSize(res.value!.size)}, over Telegram's 50 MB limit. Compress or split it first.`);
      return;
    }
    await ctx.replyWithChatAction("upload_document");
    await ctx.replyWithDocument(new InputFile(res.value!.path));
    audit({ kind: "file.sent", path: res.value!.path, bytes: res.value!.size });
  });

  bot.command("config", async (ctx) => {
    const cfg = getConfig();
    const [sub, ...rest] = ctx.match.trim().split(/\s+/).filter(Boolean);
    const value = rest.join(" ");
    if (sub === "add" && value) {
      const check = isPathAllowed(value, [path.parse(value).root || value]); // sanity: absolute
      if (!path.isAbsolute(value) || !existsSync(value) || !check) {
        await ctx.reply("Provide an absolute path to an existing folder: /config add C:\\Users\\me\\Docs");
        return;
      }
      const ok = await confirm({ chatId: ctx.chat.id }, `Add this folder to the allowlist?\n${value}`);
      if (!ok) return void ctx.reply("Cancelled.");
      const next = { ...cfg, allowedDirs: [...new Set([...cfg.allowedDirs, path.resolve(value)])] };
      saveConfig(next);
      setConfig(next);
      audit({ kind: "config.changed", field: "allowedDirs.add", detail: value });
      await ctx.reply(`✅ Added. Allowed folders:\n${next.allowedDirs.map((d) => `• ${d}`).join("\n")}`);
    } else if (sub === "remove" && value) {
      const next = { ...cfg, allowedDirs: cfg.allowedDirs.filter((d) => d.toLowerCase() !== path.resolve(value).toLowerCase()) };
      saveConfig(next);
      setConfig(next);
      audit({ kind: "config.changed", field: "allowedDirs.remove", detail: value });
      await ctx.reply(`✅ Removed. Allowed folders:\n${next.allowedDirs.map((d) => `• ${d}`).join("\n") || "(none)"}`);
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
      : store.defaultFor(ctx.chat.id) ?? ensureDefaultSession(ctx.chat.id, cfg);
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
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
      const resp = await fetch(url);
      const buf = Buffer.from(await resp.arrayBuffer());
      writeFileSync(dest.value!.path, buf);
      audit({ kind: "file.received", path: dest.value!.path, bytes: buf.length });
      await ctx.reply(`✅ Saved to ${dest.value!.path} (${humanSize(buf.length)}).`);
    } catch (e) {
      await ctx.reply(`⚠️ Could not save the file: ${String(e)}`);
    }
  });

  // ---- plain text → route to a session ---------------------------------------

  bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    if (text.startsWith("/")) return; // unknown command; ignore quietly
    const cfg = getConfig();

    // Replying to a message a foreign Claude Code session sent? Deliver it to
    // that session's inbox instead of running a turn here (FR-19 two-way).
    const repliedTo = ctx.msg.reply_to_message?.message_id;
    if (repliedTo !== undefined && deps.instances) {
      const origin = deps.instances.ownerOfMessage(repliedTo);
      if (origin) {
        const delivered = origin.alive && deps.instances.deliver(origin.id, text);
        await ctx.reply(
          delivered
            ? `📨 Sent to [${origin.label}].`
            : `⚠️ [${origin.label}] is no longer running, so it can't receive this.`,
          { reply_to_message_id: ctx.msg.message_id },
        );
        return;
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
    await runTurn(session, text);
  });

  /** Create the implicit read-only default session for the owner's private chat (FR-4). */
  function ensureDefaultSession(chatId: number, cfg: Config): Session | undefined {
    const cwd = cfg.defaultCwd && isPathAllowed(cfg.defaultCwd, cfg.allowedDirs).allowed
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
        return send(target, `⚠️ Agent tried to send a disallowed file: ${res.error}`);
      }
      if (res.value!.size > TELEGRAM_SEND_LIMIT) {
        return send(target, `⚠️ File too large to send (${humanSize(res.value!.size)}).`);
      }
      const sent = await bot.api.sendDocument(target.chatId, new InputFile(res.value!.path), {
        ...(caption ? { caption } : {}),
        ...(target.topicId !== undefined ? { message_thread_id: target.topicId } : {}),
      });
      audit({ kind: "file.sent", path: res.value!.path, bytes: res.value!.size });
      return sent.message_id;
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
