import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { createBot, type ManagerLike } from "./bot.js";
import { PendingQuestions } from "./pending.js";
import { SessionStore } from "../sessions/store.js";
import { InstanceRegistry } from "../ipc/instances.js";
import type { Config } from "../config/config.js";
import type { Session } from "../sessions/store.js";

/**
 * Offline integration test of the real grammY bot. We stub the Telegram API with
 * a transformer (capturing every outgoing call) and feed crafted updates through
 * `bot.handleUpdate`, so the genuine auth middleware, commands, and routing run
 * without any network. This is the "non-owner gets nothing" DoD check (FR-1).
 */

const OWNER = 555;
const GROUP = -1001;
const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "TB",
  username: "tb",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

let dir: string;
let allowed: string;
let config: Config;
let store: SessionStore;
let outgoing: { method: string; payload: any }[];
let bot: Bot;
let turns: { session: Session; prompt: string }[];
let instances: InstanceRegistry;
let bridge: import("../ipc/protocol.js").TelegramBridge;
let uploadFailuresRemaining = 0;

function baseConfig(): Config {
  return {
    ownerId: OWNER,
    allowedDirs: [allowed],
    defaultModel: "sonnet",
    defaultMode: "ro",
    turnTimeoutMinutes: 15,
    hibernateAfterMinutes: 30,
    maxConcurrentSessions: 5,
    claudeBin: "claude",
    rateLimitPerMinute: 1000,
    ipcPort: 0,
    localApiRoot: "",
  };
}

const fakeManager: ManagerLike = {
  async runTurn(session, prompt, cb) {
    turns.push({ session, prompt });
    cb.onResult?.({ text: `echo:${prompt}`, isError: false });
  },
  kill() {},
  killAll() {
    return 0;
  },
  isPanicked: false,
  setPanicked() {},
};

/** The API stub every bot in this file uses: capture calls, return plausible results. */
function stubApi(target: Bot): void {
  target.api.config.use(async (_prev, method, payload) => {
    outgoing.push({ method, payload });
    if (method === "sendDocument" && uploadFailuresRemaining > 0) {
      uploadFailuresRemaining--;
      throw new Error("request to api.telegram.org failed, reason: write ECONNRESET");
    }
    if (method === "getFile")
      return { ok: true, result: { file_id: "f", file_unique_id: "u", file_path: "x" } } as any;
    return { ok: true, result: { message_id: 1 } } as any;
  });
}

function buildBot(manager: ManagerLike = fakeManager): { bot: Bot; bridge: typeof bridge } {
  const built = createBot({
    token: "1:TEST",
    getConfig: () => config,
    setConfig: (c) => (config = c),
    store,
    manager,
    pending: new PendingQuestions(),
    startedAt: Date.now(),
    botInfo: BOT_INFO,
    instances,
  });
  stubApi(built.bot);
  return built;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tbm-bot-"));
  allowed = path.join(dir, "ws");
  mkdirSync(allowed, { recursive: true });
  writeFileSync(path.join(allowed, "readme.txt"), "hello world");
  config = baseConfig();
  store = new SessionStore(path.join(dir, "sessions.json"));
  outgoing = [];
  turns = [];
  instances = new InstanceRegistry();
  uploadFailuresRemaining = 0;
  const built = buildBot();
  bot = built.bot;
  bridge = built.bridge;
});

function afterEachCleanup() {
  rmSync(dir, { recursive: true, force: true });
}

function messageUpdate(text: string, fromId: number, chatId = fromId, threadId?: number): any {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatId === fromId ? "private" : "supergroup" },
      from: { id: fromId, is_bot: false, first_name: "U" },
      text,
      ...(threadId !== undefined ? { message_thread_id: threadId, is_topic_message: true } : {}),
      entities: text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }]
        : [],
    },
  };
}

function callbackUpdate(data: string, fromId = OWNER): any {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: String(Math.floor(Math.random() * 1e9)),
      from: { id: fromId, is_bot: false, first_name: "U" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 77,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: "private" },
        text: "question",
      },
    },
  };
}

function sent(method: string) {
  return outgoing.filter((o) => o.method === method);
}

function replyUpdate(text: string, replyToMessageId: number, fromId = OWNER): any {
  const u = messageUpdate(text, fromId);
  u.message.reply_to_message = {
    message_id: replyToMessageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: "private" },
    text: "earlier bot message",
  };
  return u;
}

const desktop = (label: string, cwd = "/x", push = false) => ({ label, cwd, sessionId: "global", push });

describe("replying to a bridge session (FR-19 two-way)", () => {
  it("routes a swipe-reply to the session that sent that message", async () => {
    const inst = instances.register(desktop("fineract", "C:\\proj\\fineract"));
    instances.claimMessage(500, inst.id);

    await bot.handleUpdate(replyUpdate("dale, continua", 500));

    // Delivered to that session's inbox...
    await expect(instances.waitForReply(inst.id, 50)).resolves.toBe("dale, continua");
    // ...and it did NOT start a Claude turn in the default session.
    await new Promise((r) => setTimeout(r, 20));
    expect(turns).toHaveLength(0);
    const ack = sent("sendMessage").at(-1)!.payload.text;
    expect(ack).toContain("fineract");
    expect(ack).toMatch(/queued/);
    afterEachCleanup();
  });

  it("says when the session was waiting for it, or gets it pushed live", async () => {
    const waiting = instances.register(desktop("w"));
    instances.setPresence(waiting.id, { waiting: true });
    instances.claimMessage(501, waiting.id);
    await bot.handleUpdate(replyUpdate("yes", 501));
    expect(sent("sendMessage").at(-1)!.payload.text).toMatch(/waiting/);

    const live = instances.register(desktop("l", "/l", true));
    instances.claimMessage(502, live.id);
    await bot.handleUpdate(replyUpdate("go", 502));
    expect(sent("sendMessage").at(-1)!.payload.text).toMatch(/pushed/);
    afterEachCleanup();
  });

  it("keeps two sessions separate", async () => {
    const a = instances.register(desktop("proj-a", "/a"));
    const b = instances.register(desktop("proj-b", "/b"));
    instances.claimMessage(601, a.id);
    instances.claimMessage(602, b.id);

    await bot.handleUpdate(replyUpdate("para A", 601));
    await bot.handleUpdate(replyUpdate("para B", 602));

    await expect(instances.waitForReply(a.id, 50)).resolves.toBe("para A");
    await expect(instances.waitForReply(b.id, 50)).resolves.toBe("para B");
    afterEachCleanup();
  });

  it("tells you when a desktop session has already exited", async () => {
    const gone = instances.register(desktop("gone", "/g"));
    instances.claimMessage(700, gone.id);
    instances.prune(0, Date.now() + 10_000); // session goes away
    await bot.handleUpdate(replyUpdate("hola?", 700));
    expect(sent("sendMessage").at(-1)!.payload.text).toMatch(/no longer running/);
    await new Promise((r) => setTimeout(r, 20));
    expect(turns).toHaveLength(0); // and it must NOT fall through to a new turn
    afterEachCleanup();
  });

  it("a reply to a finished daemon-run session becomes that chat's next turn", async () => {
    // Per-turn sessions register under their session id and are dropped when
    // the turn's claude process exits; the reply is then just the next message.
    const turn = instances.register({ label: "Downloads", cwd: "/d", sessionId: "s1" });
    instances.claimMessage(800, turn.id);
    instances.dropBySession("s1");
    await bot.handleUpdate(replyUpdate("sigue con eso", 800));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.prompt).toBe("sigue con eso");
    afterEachCleanup();
  });

  it("a normal (non-reply) message still runs the default session", async () => {
    const inst = instances.register(desktop("x"));
    instances.claimMessage(900, inst.id);
    await bot.handleUpdate(messageUpdate("mensaje normal", OWNER));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    afterEachCleanup();
  });
});

describe("the update loop never blocks on long work", () => {
  it("answers /status while a turn is still running", async () => {
    let release: (() => void) | undefined;
    const slowManager: ManagerLike = {
      ...fakeManager,
      runTurn: (session, prompt, cb) =>
        new Promise<void>((resolve) => {
          turns.push({ session, prompt });
          release = () => {
            cb.onResult?.({ text: "done", isError: false });
            resolve();
          };
        }),
    };
    const b = buildBot(slowManager).bot;
    outgoing = [];

    await b.handleUpdate(messageUpdate("take your time", OWNER));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // The turn has not finished, yet the next update is processed at once.
    await b.handleUpdate(messageUpdate("/status", OWNER));
    expect(sent("sendMessage").some((m) => String(m.payload.text).includes("Bridge"))).toBe(true);

    release!();
    await vi.waitFor(() => expect(sent("sendMessage").some((m) => m.payload.text === "done")).toBe(true));
    afterEachCleanup();
  });

  it("/config add completes through the confirmation button", async () => {
    const more = path.join(dir, "more");
    mkdirSync(more);
    await bot.handleUpdate(messageUpdate(`/config add ${more}`, OWNER));

    // The question with buttons went out and the handler returned without the answer.
    const question = await vi.waitFor(() => {
      const q = sent("sendMessage").find((m) => m.payload.reply_markup?.inline_keyboard);
      expect(q).toBeDefined();
      return q!;
    });
    expect(config.allowedDirs).not.toContain(more);

    const yes = question.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    await bot.handleUpdate(callbackUpdate(yes));
    await vi.waitFor(() => expect(config.allowedDirs).toContain(more));
    expect(sent("sendMessage").some((m) => String(m.payload.text).startsWith("✅ Added"))).toBe(true);
    afterEachCleanup();
  });

  it("/get inside a forum topic delivers into that topic", async () => {
    config = { ...config, groupId: GROUP };
    await bot.handleUpdate(messageUpdate(`/get ${path.join(allowed, "readme.txt")}`, OWNER, GROUP, 42));
    await vi.waitFor(() => expect(sent("sendDocument")).toHaveLength(1));
    expect(sent("sendDocument")[0]!.payload.message_thread_id).toBe(42);
    expect(sent("sendDocument")[0]!.payload.chat_id).toBe(GROUP);
    afterEachCleanup();
  });
});

describe("blocked file sends are diagnosable", () => {
  it("names the offending path so you know what to allow", async () => {
    const outside = path.join(dir, "outside", "kael.png");
    await bridge.sendFile({ chatId: OWNER }, outside);
    const res = await bridge.sendFile({ chatId: OWNER }, outside);
    const text = sent("sendMessage").at(-1)!.payload.text;
    expect(text).toContain(outside); // the path, not just a generic error
    expect(text).toMatch(/config add/); // and how to fix it
    // And the caller is told it FAILED - never a false "sent".
    expect(res.ok).toBe(false);
    expect(res.error).toContain(outside);
    afterEachCleanup();
  });

  it("still sends a file that is inside the allowlist", async () => {
    const res = await bridge.sendFile({ chatId: OWNER }, path.join(allowed, "readme.txt"));
    expect(res.ok).toBe(true);
    expect(sent("sendDocument")).toHaveLength(1);
    afterEachCleanup();
  });
});

describe("captions longer than Telegram allows", () => {
  it("sends the long text as its own message and keeps a short caption", async () => {
    const long = "x".repeat(1500); // Telegram caps captions at 1024
    const res = await bridge.sendFile({ chatId: OWNER }, path.join(allowed, "readme.txt"), long);
    expect(res.ok).toBe(true);
    // The full text went out as a message...
    expect(sent("sendMessage").some((m) => m.payload.text.includes("x".repeat(100)))).toBe(true);
    // ...and the file caption is short enough to be accepted.
    const doc = sent("sendDocument").at(-1)!;
    expect((doc.payload.caption ?? "").length).toBeLessThanOrEqual(1024);
    afterEachCleanup();
  });

  it("leaves a short caption attached to the file", async () => {
    const res = await bridge.sendFile({ chatId: OWNER }, path.join(allowed, "readme.txt"), "corto");
    expect(res.ok).toBe(true);
    expect(sent("sendDocument").at(-1)!.payload.caption).toBe("corto");
    afterEachCleanup();
  });
});

describe("uploads survive a stale keep-alive socket", () => {
  it("retries a write ECONNRESET and succeeds", async () => {
    uploadFailuresRemaining = 1; // first attempt dies mid-upload
    const res = await bridge.sendFile({ chatId: OWNER }, path.join(allowed, "readme.txt"));
    expect(res.ok).toBe(true);
    expect(sent("sendDocument")).toHaveLength(2); // failed once, then succeeded
    afterEachCleanup();
  }, 10_000);

  it("gives up after repeated failures and reports it, never a false success", async () => {
    uploadFailuresRemaining = 99;
    const res = await bridge.sendFile({ chatId: OWNER }, path.join(allowed, "readme.txt"));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/upload failed/i);
    expect(sent("sendDocument")).toHaveLength(3); // bounded retries
    afterEachCleanup();
  }, 15_000);
});

describe("questions with buttons", () => {
  it("askUser resolves with the tapped option and removes the buttons", async () => {
    const pending = bridge.askUser({ chatId: OWNER }, "Deploy?", ["Yes", "No"]);
    const question = await vi.waitFor(() => {
      const q = sent("sendMessage").find((m) => m.payload.reply_markup?.inline_keyboard);
      expect(q).toBeDefined();
      return q!;
    });
    const no = question.payload.reply_markup.inline_keyboard[0][1].callback_data as string;
    await bot.handleUpdate(callbackUpdate(no));
    await expect(pending).resolves.toBe("No");
    expect(sent("editMessageReplyMarkup")).toHaveLength(1);
    afterEachCleanup();
  });
});

describe("bot (offline integration)", () => {
  it("drops updates from a non-owner with NO reply (FR-1)", async () => {
    await bot.handleUpdate(messageUpdate("/status", 999));
    afterEachCleanup();
    expect(outgoing).toHaveLength(0);
  });

  it("answers /status to the owner", async () => {
    await bot.handleUpdate(messageUpdate("/status", OWNER));
    const msgs = sent("sendMessage");
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.payload.text).toContain("Bridge");
    afterEachCleanup();
  });

  it("/sessions shows connected Claude Code sessions and how they receive replies", async () => {
    const live = instances.register(desktop("live-proj", "/l", true));
    const idle = instances.register(desktop("idle-proj", "/i"));
    instances.setPresence(idle.id, { waiting: true });
    await bot.handleUpdate(messageUpdate("/sessions", OWNER));
    const text = sent("sendMessage").at(-1)!.payload.text as string;
    expect(text).toContain("[live-proj]");
    expect(text).toMatch(/live/);
    expect(text).toContain("[idle-proj]");
    expect(text).toMatch(/waiting/);
    expect(live.id).not.toBe(idle.id);
    afterEachCleanup();
  });

  it("/ls lists an allowed folder for the owner", async () => {
    await bot.handleUpdate(messageUpdate(`/ls ${allowed}`, OWNER));
    const text = sent("sendMessage").at(-1)!.payload.text;
    expect(text).toContain("readme.txt");
    afterEachCleanup();
  });

  it("/ls refuses a folder outside the allowlist", async () => {
    await bot.handleUpdate(messageUpdate(`/ls ${path.join(dir, "nope")}`, OWNER));
    const text = sent("sendMessage").at(-1)!.payload.text;
    expect(text).toMatch(/not inside an allowed|does not exist|not allowed/i);
    afterEachCleanup();
  });

  it("/find locates a file by fragment", async () => {
    await bot.handleUpdate(messageUpdate("/find readme", OWNER));
    const text = sent("sendMessage").at(-1)!.payload.text;
    expect(text).toContain("readme.txt");
    afterEachCleanup();
  });

  it("a plain message creates the default session and runs a turn (FR-4)", async () => {
    await bot.handleUpdate(messageUpdate("hello there", OWNER));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.prompt).toBe("hello there");
    expect(turns[0]!.session.isDefault).toBe(true);
    await vi.waitFor(() => {
      const replies = sent("sendMessage").map((m) => m.payload.text);
      expect(replies.some((t) => t.includes("echo:hello there"))).toBe(true);
    });
    afterEachCleanup();
  });

  it("reuses the same default session on the next message (FR-5)", async () => {
    await bot.handleUpdate(messageUpdate("first", OWNER));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await bot.handleUpdate(messageUpdate("second", OWNER));
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[0]!.session.id).toBe(turns[1]!.session.id);
    afterEachCleanup();
  });

  it("/panic locks and blocks; /unlock restores (FR-2)", async () => {
    // Use a manager whose panic flag actually toggles.
    let panicked = false;
    const m: ManagerLike = {
      ...fakeManager,
      get isPanicked() {
        return panicked;
      },
      setPanicked(v: boolean) {
        panicked = v;
      },
      killAll: () => 0,
    };
    const b = buildBot(m).bot;
    outgoing = [];
    await b.handleUpdate(messageUpdate("/panic", OWNER));
    expect(panicked).toBe(true);
    expect(sent("sendMessage").at(-1)!.payload.text).toContain("PANIC");
    await b.handleUpdate(messageUpdate("/unlock", OWNER));
    expect(panicked).toBe(false);
    afterEachCleanup();
  });
});
