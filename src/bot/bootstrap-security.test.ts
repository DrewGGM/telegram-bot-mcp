import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { createBot, type ManagerLike } from "../bot/bot.js";
import { PendingQuestions } from "../bot/pending.js";
import { SessionStore } from "../sessions/store.js";
import type { Config } from "../config/config.js";

const ATTACKER = 999;
let dir: string, allowed: string, config: Config, bot: Bot;
let outgoing: { method: string; payload: any }[];

const noopManager: ManagerLike = {
  async runTurn() {}, kill() {}, killAll() { return 0; },
  isPanicked: false, setPanicked() {},
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tbm-exploit-"));
  allowed = path.join(dir, "ws");
  mkdirSync(allowed, { recursive: true });
  writeFileSync(path.join(allowed, "SECRETO.txt"), "datos privados del owner");
  config = {
    ownerId: 0, // <-- recien instalado, nadie ha reclamado todavia
    allowedDirs: [allowed], defaultModel: "sonnet", defaultMode: "ro",
    turnTimeoutMinutes: 15, hibernateAfterMinutes: 30, maxConcurrentSessions: 5,
    claudeBin: "claude", rateLimitPerMinute: 1000, ipcPort: 8765,
    localApiRoot: "http://127.0.0.1:8081",
  };
  outgoing = [];
  const built = createBot({
    token: "1:TEST", getConfig: () => config, setConfig: (c) => (config = c),
    store: new SessionStore(path.join(dir, "s.json")), manager: noopManager,
    pending: new PendingQuestions(), startedAt: Date.now(),
    botInfo: { id: 1, is_bot: true, first_name: "TB", username: "tb",
      can_join_groups: true, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false },
  });
  bot = built.bot;
  bot.api.config.use(async (_p, method, payload) => {
    outgoing.push({ method, payload });
    return { ok: true, result: { message_id: 1 } } as any;
  });
});

function cmd(text: string) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9), date: 1,
      chat: { id: ATTACKER, type: "private" },
      from: { id: ATTACKER, is_bot: false, first_name: "Mallory" },
      text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
    },
  } as any;
}

describe("SECURITY: unclaimed bot must not serve a stranger", () => {
  it("a stranger cannot list the owner's files with /ls", async () => {
    await bot.handleUpdate(cmd(`/ls ${allowed}`));
    const texts = outgoing.filter(o => o.method === "sendMessage").map(o => o.payload.text).join("\n");
    rmSync(dir, { recursive: true, force: true });
    expect(texts).not.toContain("SECRETO.txt");
  });

  it("a stranger cannot search filenames with /find", async () => {
    await bot.handleUpdate(cmd("/find SECRETO"));
    const texts = outgoing.filter(o => o.method === "sendMessage").map(o => o.payload.text).join("\n");
    rmSync(dir, { recursive: true, force: true });
    expect(texts).not.toContain("SECRETO");
  });

  it("a stranger cannot exfiltrate a file with /get", async () => {
    await bot.handleUpdate(cmd(`/get ${path.join(allowed, "SECRETO.txt")}`));
    const sentDocs = outgoing.filter(o => o.method === "sendDocument");
    rmSync(dir, { recursive: true, force: true });
    expect(sentDocs).toHaveLength(0);
  });

  it("a stranger cannot widen the allowlist with /config", async () => {
    await bot.handleUpdate(cmd("/config"));
    const texts = outgoing.filter(o => o.method === "sendMessage").map(o => o.payload.text).join("\n");
    rmSync(dir, { recursive: true, force: true });
    expect(texts).not.toContain(allowed);
  });

  it("a stranger CAN still see /start (that is the bootstrap path)", async () => {
    await bot.handleUpdate(cmd("/start"));
    const texts = outgoing.filter(o => o.method === "sendMessage").map(o => o.payload.text).join("\n");
    rmSync(dir, { recursive: true, force: true });
    expect(texts).toMatch(/owner|Claim/i);
  });
});
