import { describe, it, expect, vi } from "vitest";
import { InstanceRegistry, LIVENESS_MS } from "./instances.js";

/**
 * Two-way routing for bridge sessions (FR-19). The properties that matter:
 * ids are unguessable, a swipe-reply finds the session that sent that message,
 * a blocked session is woken the instant the owner answers, and a reply never
 * disappears into a connection nobody is reading.
 */
const desktop = (label: string, cwd = "/x") => ({ label, cwd, sessionId: "global" });

describe("InstanceRegistry", () => {
  it("mints distinct, unguessable ids", () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("proj-a", "C:\\a"));
    const b = r.register(desktop("proj-b", "C:\\b"));
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("maps a sent message back to the session that sent it", () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    const b = r.register({ label: "b", cwd: "/b", sessionId: "s7" });
    r.claimMessage(1001, a.id);
    r.claimMessage(1002, b.id);
    expect(r.ownerOfMessage(1001)).toMatchObject({ id: a.id, sessionId: "global", alive: true });
    expect(r.ownerOfMessage(1002)).toMatchObject({ id: b.id, sessionId: "s7" });
    expect(r.ownerOfMessage(9999)).toBeUndefined();
  });

  it("queues a reply when nobody is waiting, and hands it over later", async () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    expect(r.deliver(a.id, "do it")).toBe(true);
    await expect(r.waitForReply(a.id, 1000)).resolves.toBe("do it");
  });

  it("wakes a session that is already blocked waiting", async () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    const pending = r.waitForReply(a.id, 5000);
    r.deliver(a.id, "approved");
    await expect(pending).resolves.toBe("approved");
  });

  it("delivers replies in order to sequential waiters", async () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    r.deliver(a.id, "first");
    r.deliver(a.id, "second");
    await expect(r.waitForReply(a.id, 100)).resolves.toBe("first");
    await expect(r.waitForReply(a.id, 100)).resolves.toBe("second");
  });

  it("never crosses replies between sessions", async () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    const b = r.register(desktop("b"));
    r.deliver(a.id, "for-a");
    await expect(r.waitForReply(b.id, 50)).resolves.toBeUndefined();
    await expect(r.waitForReply(a.id, 50)).resolves.toBe("for-a");
  });

  it("times out instead of hanging forever", async () => {
    vi.useFakeTimers();
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    const p = r.waitForReply(a.id, 1000);
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("an aborted wait releases the waiter and keeps the reply for the next poll", async () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    const hangup = new AbortController();
    const p = r.waitForReply(a.id, 5000, hangup.signal);
    hangup.abort();
    await expect(p).resolves.toBeUndefined();
    expect(r.peek(a.id)!.waiters).toHaveLength(0);
    r.deliver(a.id, "late");
    expect(r.peek(a.id)!.inbox).toEqual(["late"]);
  });

  it("reports failure for an unknown session", () => {
    const r = new InstanceRegistry();
    expect(r.deliver("nope", "hi")).toBe(false);
    expect(r.setPresence("nope", { waiting: true })).toBe(false);
  });

  it("tracks what the bridge reports about itself", () => {
    const r = new InstanceRegistry();
    const a = r.register({ ...desktop("a"), push: true });
    r.claimMessage(5, a.id);
    expect(r.ownerOfMessage(5)).toMatchObject({ push: true, waiting: false });
    r.setPresence(a.id, { waiting: true });
    expect(r.ownerOfMessage(5)).toMatchObject({ waiting: true });
    r.setPresence(a.id, { waiting: false, push: false });
    expect(r.ownerOfMessage(5)).toMatchObject({ push: false, waiting: false });
  });

  it("considers a bridge dead once it stops polling", () => {
    const r = new InstanceRegistry();
    const a = r.register(desktop("a"));
    r.claimMessage(9, a.id);
    const later = Date.now() + LIVENESS_MS + 1;
    expect(r.isAlive(a.id)).toBe(true);
    expect(r.isAlive(a.id, later)).toBe(false);
    expect(r.ownerOfMessage(9, later)?.alive).toBe(false);
    // A poll brings it back.
    r.get(a.id);
    expect(r.isAlive(a.id)).toBe(true);
  });

  it("drops the instances of a per-turn session but not desktop ones", () => {
    const r = new InstanceRegistry();
    const turn = r.register({ label: "turn", cwd: "/t", sessionId: "s3" });
    const desk = r.register(desktop("desk"));
    r.claimMessage(77, turn.id);
    expect(r.dropBySession("s3")).toBe(1);
    expect(r.peek(turn.id)).toBeUndefined();
    expect(r.peek(desk.id)).toBeDefined();
    // The message is still attributed, so the bot can route the reply sensibly.
    expect(r.ownerOfMessage(77)).toMatchObject({ sessionId: "s3", alive: false });
  });

  it("prunes idle sessions but spares ones still waiting", async () => {
    const r = new InstanceRegistry();
    const idle = r.register(desktop("idle", "/i"));
    const busy = r.register(desktop("busy", "/b"));
    void r.waitForReply(busy.id, 60_000);
    const future = Date.now() + 2 * 60 * 60_000;
    expect(r.prune(60 * 60_000, future)).toBe(1);
    expect(r.peek(idle.id)).toBeUndefined();
    expect(r.peek(busy.id)).toBeDefined();
  });
});

describe("InstanceRegistry edge cases", () => {
  it("keeps the message map bounded by evicting the oldest claim", () => {
    const r = new InstanceRegistry();
    const a = r.register({ label: "a", cwd: "/a", sessionId: "global" });
    for (let i = 1; i <= 2001; i++) r.claimMessage(i, a.id);
    expect(r.ownerOfMessage(1)).toBeUndefined();
    expect(r.ownerOfMessage(2001)?.id).toBe(a.id);
  });

  it("attributes a message claimed for an unknown instance to a generic label", () => {
    const r = new InstanceRegistry();
    r.claimMessage(3, "ghost");
    expect(r.ownerOfMessage(3)).toMatchObject({ label: "claude", sessionId: "", alive: false, push: false });
  });

  it("falls back to a generic label and resolves an already-aborted wait at once", async () => {
    const r = new InstanceRegistry();
    const a = r.register({ label: "", cwd: "/a", sessionId: "global" });
    expect(a.label).toBe("claude");
    const done = new AbortController();
    done.abort();
    await expect(r.waitForReply(a.id, 1000, done.signal)).resolves.toBeUndefined();
    await expect(r.waitForReply("nope", 10)).resolves.toBeUndefined();
  });
});
