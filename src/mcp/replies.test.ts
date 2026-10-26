import { describe, it, expect, vi } from "vitest";
import { ReplyRouter } from "./replies.js";

/**
 * One reply, exactly one destination: a blocked tool call wins over the
 * channel, the channel wins over the inbox, and nothing is ever delivered
 * twice.
 */
describe("ReplyRouter", () => {
  it("hands a reply to a blocked tool call before anything else", async () => {
    const sink = vi.fn(async () => {});
    const router = new ReplyRouter(() => sink);
    const pending = router.next(1000);
    await expect(router.dispatch("go")).resolves.toBe("tool");
    await expect(pending).resolves.toBe("go");
    expect(sink).not.toHaveBeenCalled();
  });

  it("pushes into the channel when nobody is waiting", async () => {
    const sink = vi.fn(async () => {});
    const router = new ReplyRouter(() => sink);
    await expect(router.dispatch("news")).resolves.toBe("channel");
    expect(sink).toHaveBeenCalledWith("news");
    expect(router.queued).toBe(0);
  });

  it("queues when there is no channel, and drains the queue before waiting", async () => {
    const router = new ReplyRouter(() => null);
    await expect(router.dispatch("first")).resolves.toBe("queued");
    await expect(router.dispatch("second")).resolves.toBe("queued");
    expect(router.queued).toBe(2);
    await expect(router.next(10)).resolves.toBe("first");
    await expect(router.next(10)).resolves.toBe("second");
    await expect(router.next(10)).resolves.toBeUndefined();
  });

  it("never delivers the same reply twice", async () => {
    const sink = vi.fn(async () => {});
    const router = new ReplyRouter(() => sink);
    const pending = router.next(1000);
    await router.dispatch("only-once");
    await expect(pending).resolves.toBe("only-once");
    await router.dispatch("after");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("after");
    expect(router.queued).toBe(0);
  });

  it("times out instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const router = new ReplyRouter(() => null);
      const p = router.next(500);
      expect(router.waiting).toBe(true);
      vi.advanceTimersByTime(501);
      await expect(p).resolves.toBeUndefined();
      expect(router.waiting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-evaluates the channel on every dispatch", async () => {
    let active = false;
    const sink = vi.fn(async () => {});
    const router = new ReplyRouter(() => (active ? sink : null));
    await expect(router.dispatch("a")).resolves.toBe("queued");
    active = true;
    await expect(router.dispatch("b")).resolves.toBe("channel");
    // The earlier reply is still waiting for the agent to ask.
    await expect(router.next(10)).resolves.toBe("a");
  });
});
