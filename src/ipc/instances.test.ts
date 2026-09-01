import { describe, it, expect, vi } from "vitest";
import { InstanceRegistry } from "./instances.js";

/**
 * Two-way routing for foreign sessions (FR-19). The properties that matter:
 * ids are unguessable, a swipe-reply finds the session that sent that message,
 * and a blocked session is woken the instant the owner answers.
 */
describe("InstanceRegistry", () => {
  it("mints distinct, unguessable ids", () => {
    const r = new InstanceRegistry();
    const a = r.register("proj-a", "C:\a");
    const b = r.register("proj-b", "C:\b");
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("maps a sent message back to the session that sent it", () => {
    const r = new InstanceRegistry();
    const a = r.register("a", "/a");
    const b = r.register("b", "/b");
    r.claimMessage(1001, a.id);
    r.claimMessage(1002, b.id);
    expect(r.ownerOfMessage(1001)?.id).toBe(a.id);
    expect(r.ownerOfMessage(1002)?.id).toBe(b.id);
    expect(r.ownerOfMessage(9999)).toBeUndefined();
  });

  it("queues a reply when nobody is waiting, and hands it over later", async () => {
    const r = new InstanceRegistry();
    const a = r.register("a", "/a");
    expect(r.deliver(a.id, "do it")).toBe(true);
    await expect(r.waitForReply(a.id, 1000)).resolves.toBe("do it");
  });

  it("wakes a session that is already blocked waiting", async () => {
    const r = new InstanceRegistry();
    const a = r.register("a", "/a");
    const pending = r.waitForReply(a.id, 5000);
    r.deliver(a.id, "approved");
    await expect(pending).resolves.toBe("approved");
  });

  it("delivers replies in order to sequential waiters", async () => {
    const r = new InstanceRegistry();
    const a = r.register("a", "/a");
    r.deliver(a.id, "first");
    r.deliver(a.id, "second");
    await expect(r.waitForReply(a.id, 100)).resolves.toBe("first");
    await expect(r.waitForReply(a.id, 100)).resolves.toBe("second");
  });

  it("never crosses replies between sessions", async () => {
    const r = new InstanceRegistry();
    const a = r.register("a", "/a");
    const b = r.register("b", "/b");
    r.deliver(a.id, "for-a");
    await expect(r.waitForReply(b.id, 50)).resolves.toBeUndefined();
    await expect(r.waitForReply(a.id, 50)).resolves.toBe("for-a");
  });

  it("times out instead of hanging forever", async () => {
    vi.useFakeTimers();
    const r = new InstanceRegistry();
    const a = r.register("a", "/a");
    const p = r.waitForReply(a.id, 1000);
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("reports failure for an unknown session", () => {
    const r = new InstanceRegistry();
    expect(r.deliver("nope", "hi")).toBe(false);
  });

  it("prunes idle sessions but spares ones still waiting", async () => {
    const r = new InstanceRegistry();
    const idle = r.register("idle", "/i");
    const busy = r.register("busy", "/b");
    void r.waitForReply(busy.id, 60_000);
    const future = Date.now() + 2 * 60 * 60_000;
    expect(r.prune(60 * 60_000, future)).toBe(1);
    expect(r.get(idle.id)).toBeUndefined();
    expect(r.get(busy.id)).toBeDefined();
  });
});
