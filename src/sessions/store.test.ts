import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "./store.js";

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tbm-store-"));
  storePath = path.join(dir, "sessions.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SessionStore", () => {
  it("creates a session with a unique id and a claude uuid", () => {
    const store = new SessionStore(storePath);
    const a = store.create({ cwd: "/x", model: "sonnet", mode: "ro", chatId: 1 });
    const b = store.create({ cwd: "/y", model: "opus", mode: "edit", chatId: 1 });
    expect(a.id).toBe("s1");
    expect(b.id).toBe("s2");
    expect(a.claudeSessionId).not.toBe(b.claudeSessionId);
    expect(a.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.firstTurnDone).toBe(false);
  });

  it("persists across instances (atomic write)", () => {
    const s1 = new SessionStore(storePath);
    const created = s1.create({ cwd: "/x", model: "sonnet", mode: "ro", chatId: 1, topicId: 42 });
    const s2 = new SessionStore(storePath);
    expect(s2.get(created.id)?.cwd).toBe("/x");
    expect(s2.byTopic(42)?.id).toBe(created.id);
  });

  it("finds the default session for a chat", () => {
    const store = new SessionStore(storePath);
    store.create({ cwd: "/x", model: "sonnet", mode: "ro", chatId: 100, isDefault: true });
    expect(store.defaultFor(100)?.isDefault).toBe(true);
    expect(store.defaultFor(999)).toBeUndefined();
  });

  it("updates and touches sessions", () => {
    const store = new SessionStore(storePath);
    const s = store.create({ cwd: "/x", model: "sonnet", mode: "ro", chatId: 1 });
    store.update(s.id, { state: "running", firstTurnDone: true });
    expect(store.get(s.id)?.state).toBe("running");
    expect(store.get(s.id)?.firstTurnDone).toBe(true);
  });

  it("removes sessions", () => {
    const store = new SessionStore(storePath);
    const s = store.create({ cwd: "/x", model: "sonnet", mode: "ro", chatId: 1 });
    expect(store.remove(s.id)).toBe(true);
    expect(store.get(s.id)).toBeUndefined();
    expect(store.remove("nope")).toBe(false);
  });

  it("identifies stale sessions past the timeout", () => {
    const store = new SessionStore(storePath);
    const s = store.create({ cwd: "/x", model: "sonnet", mode: "ro", chatId: 1 });
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    store.update(s.id, { lastActiveAt: old });
    expect(store.staleSessions(20).map((x) => x.id)).toContain(s.id);
    expect(store.staleSessions(60)).toHaveLength(0);
  });

  it("excludes already-hibernated sessions from stale set", () => {
    const store = new SessionStore(storePath);
    const s = store.create({ cwd: "/x", model: "sonnet", mode: "ro", chatId: 1 });
    store.update(s.id, {
      lastActiveAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      state: "hibernated",
    });
    expect(store.staleSessions(20)).toHaveLength(0);
  });
});
