import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { IpcServer } from "../ipc/server.js";
import { DATA_DIR, type Config } from "../config/config.js";

/**
 * Lifecycle of one turn without a real Claude: `claudeBin` points at Node,
 * which rejects the claude flags and exits at once. That is enough to prove
 * what a finished turn must leave behind — nothing: the IPC token is revoked,
 * the bridge instances it registered are gone, and the mcp-config file that
 * carried the token to claude is deleted.
 */

let dir: string;
let ipc: IpcServer;
let store: SessionStore;

const noopBridge = {
  sendMessage: async () => undefined,
  sendFile: async () => ({ ok: true }),
  askUser: async () => "",
};

function config(): Config {
  return {
    ownerId: 1,
    allowedDirs: [dir],
    defaultModel: "haiku",
    defaultMode: "ro",
    turnTimeoutMinutes: 1,
    hibernateAfterMinutes: 30,
    maxConcurrentSessions: 5,
    claudeBin: process.execPath,
    rateLimitPerMinute: 1000,
    ipcPort: 0,
    localApiRoot: "",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "tbm-manager-"));
  ipc = new IpcServer(noopBridge);
  await ipc.listen();
  store = new SessionStore(path.join(dir, "sessions.json"));
});
afterEach(async () => {
  await ipc.close();
  rmSync(dir, { recursive: true, force: true });
});

const mcpConfigFor = (sessionId: string) => path.join(DATA_DIR, "mcp", `${sessionId}.json`);

describe("SessionManager", () => {
  it("cleans up everything a turn held once claude exits", async () => {
    const manager = new SessionManager(store, config, path.join(dir, "guardrails.json"), ipc);
    const session = store.create({ cwd: dir, model: "haiku", mode: "ro", chatId: 1 });
    const errors: string[] = [];

    await manager.runTurn(session, "hello", { onError: (m) => errors.push(m) });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/exited/);
    expect(existsSync(mcpConfigFor(session.id))).toBe(false);
    expect(store.get(session.id)).toMatchObject({ state: "idle", firstTurnDone: true });
    expect(manager.killAll()).toBe(0);
  }, 20_000);

  it("refuses to start a turn while locked by /panic", async () => {
    const manager = new SessionManager(store, config, path.join(dir, "guardrails.json"), ipc);
    const session = store.create({ cwd: dir, model: "haiku", mode: "ro", chatId: 1 });
    manager.setPanicked(true);
    const errors: string[] = [];
    await manager.runTurn(session, "hello", { onError: (m) => errors.push(m) });
    expect(errors[0]).toMatch(/locked/);
    expect(
      existsSync(path.join(DATA_DIR, "mcp")) ? readdirSync(path.join(DATA_DIR, "mcp")) : [],
    ).not.toContain(`${session.id}.json`);
  });

  it("reports a binary that cannot be launched", async () => {
    const missing = { ...config(), claudeBin: path.join(dir, "no-such-claude.exe") };
    const manager = new SessionManager(store, () => missing, path.join(dir, "guardrails.json"), ipc);
    const session = store.create({ cwd: dir, model: "haiku", mode: "ro", chatId: 1 });
    const errors: string[] = [];
    await manager.runTurn(session, "hello", { onError: (m) => errors.push(m) });
    expect(errors).toHaveLength(1); // reported once, not once per error+close event
    expect(errors[0]).toMatch(/Failed to launch Claude/);
    expect(existsSync(mcpConfigFor(session.id))).toBe(false);
    // Never ran, so the next turn must still start a new conversation.
    expect(store.get(session.id)).toMatchObject({ state: "idle", firstTurnDone: false });
  }, 20_000);
});
