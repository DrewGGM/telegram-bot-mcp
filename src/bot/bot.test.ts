import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { createBot, type ManagerLike } from "./bot.js";
import { PendingQuestions } from "./pending.js";
import { SessionStore } from "../sessions/store.js";
import type { Config } from "../config/config.js";
import type { Session } from "../sessions/store.js";

/**
 * Offline integration test of the real grammY bot. We stub the Telegram API with
 * a transformer (capturing every outgoing call) and feed crafted updates through
 * `bot.handleUpdate`, so the genuine auth middleware, commands, and routing run
 * without any network. This is the "non-owner gets nothing" DoD check (FR-1).
 */

const OWNER = 555;
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

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tbm-bot-"));
  allowed = path.join(dir, "ws");
  mkdirSync(allowed, { recursive: true });
  writeFileSync(path.join(allowed, "readme.txt"), "hello world");
  config = baseConfig();
  store = new SessionStore(path.join(dir, "sessions.json"));
  outgoing = [];
  turns = [];

  const built = createBot({
    token: "1:TEST",
    getConfig: () => config,
    setConfig: (c) => (config = c),
    store,
    manager: fakeManager,
    pending: new PendingQuestions(),
    startedAt: Date.now(),
    botInfo: BOT_INFO,
  });
  bot = built.bot;
  // Stub the Telegram API: capture calls, return plausible results.
  bot.api.config.use(async (_prev, method, payload) => {
    outgoing.push({ method, payload });
    if (method === "getFile") return { ok: true, result: { file_id: "f", file_unique_id: "u", file_path: "x" } } as any;
    return { ok: true, result: true } as any;
  });
});

function afterEachCleanup() {
  rmSync(dir, { recursive: true, force: true });
}

function messageUpdate(text: string, fromId: number, chatId = fromId): any {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatId === fromId ? "private" : "supergroup" },
      from: { id: fromId, is_bot: false, first_name: "U" },
      text,
      entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : [],
    },
  };
}

function sent(method: string) {
  return outgoing.filter((o) => o.method === method);
}

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
    expect(msgs[0].payload.text).toContain("Bridge");
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
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("hello there");
    expect(turns[0].session.isDefault).toBe(true);
    const replies = sent("sendMessage").map((m) => m.payload.text);
    expect(replies.some((t) => t.includes("echo:hello there"))).toBe(true);
    afterEachCleanup();
  });

  it("reuses the same default session on the next message (FR-5)", async () => {
    await bot.handleUpdate(messageUpdate("first", OWNER));
    await bot.handleUpdate(messageUpdate("second", OWNER));
    expect(turns).toHaveLength(2);
    expect(turns[0].session.id).toBe(turns[1].session.id);
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
    const built = createBot({
      token: "1:TEST",
      getConfig: () => config,
      setConfig: (c) => (config = c),
      store,
      manager: m,
      pending: new PendingQuestions(),
      startedAt: Date.now(),
      botInfo: BOT_INFO,
    });
    const b = built.bot;
    b.api.config.use(async (_p, method, payload) => {
      outgoing.push({ method, payload });
      return { ok: true, result: true } as any;
    });
    outgoing = [];
    await b.handleUpdate(messageUpdate("/panic", OWNER));
    expect(panicked).toBe(true);
    expect(sent("sendMessage").at(-1)!.payload.text).toContain("PANIC");
    await b.handleUpdate(messageUpdate("/unlock", OWNER));
    expect(panicked).toBe(false);
    afterEachCleanup();
  });
});
