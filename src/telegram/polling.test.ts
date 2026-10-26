import { describe, it, expect, vi } from "vitest";
import { AbortController as PolyfillAbortController } from "abort-controller";
import { pollingWatchdog, POLL_MARGIN_MS } from "./polling.js";

/**
 * A long poll whose response is lost must not hang the bot: the watchdog
 * aborts it shortly after the server-side timeout so grammY retries.
 */
describe("pollingWatchdog", () => {
  it("passes other methods through untouched", async () => {
    const prev = vi.fn(async () => ({ ok: true, result: true }));
    const signal = new AbortController().signal;
    await pollingWatchdog()(prev as any, "sendMessage", { chat_id: 1, text: "x" }, signal as any);
    expect(prev).toHaveBeenCalledWith("sendMessage", { chat_id: 1, text: "x" }, signal);
  });

  it("aborts a getUpdates call that outlives its deadline", async () => {
    const prev = vi.fn(
      (_m: string, _p: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const stats = { lastOkAt: 0, consecutiveFailures: 0 };
    const started = Date.now();
    await expect(pollingWatchdog(stats, 50)(prev as any, "getUpdates", { timeout: 0 })).rejects.toThrow(
      "aborted",
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stats.consecutiveFailures).toBe(1);
  });

  it("uses a margin longer than any normal long poll by default", () => {
    expect(POLL_MARGIN_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("records success and resets the failure count", async () => {
    const stats = { lastOkAt: 0, consecutiveFailures: 3 };
    const prev = vi.fn(async () => ({ ok: true, result: [] }));
    await pollingWatchdog(stats)(prev as any, "getUpdates", { timeout: 30 });
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.lastOkAt).toBeGreaterThan(0);
  });

  it("does not count a deliberate stop as a failure", async () => {
    const stats = { lastOkAt: 0, consecutiveFailures: 0 };
    const stop = new AbortController();
    const prev = vi.fn(
      (_m: string, _p: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("stopped"))),
        ),
    );
    const call = pollingWatchdog(stats)(prev as any, "getUpdates", { timeout: 30 }, stop.signal as any);
    stop.abort();
    await expect(call).rejects.toThrow("stopped");
    expect(stats.consecutiveFailures).toBe(0);
  });

  it("accepts grammY's polyfill AbortSignal (regression: every poll failed before reaching the network)", async () => {
    // grammY passes a signal from the abort-controller polyfill; Node's
    // AbortSignal.any rejects it, which made every getUpdates throw.
    const stop = new PolyfillAbortController();
    const prev = vi.fn(async () => ({ ok: true, result: [] }));
    const stats = { lastOkAt: 0, consecutiveFailures: 0 };
    await expect(
      pollingWatchdog(stats)(prev as any, "getUpdates", { timeout: 30 }, stop.signal as any),
    ).resolves.toEqual({ ok: true, result: [] });
    expect(stats.consecutiveFailures).toBe(0);
  });

  it("propagates a stop from grammY's polyfill signal to the request", async () => {
    const stop = new PolyfillAbortController();
    const prev = vi.fn(
      (_m: string, _p: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("stopped"))),
        ),
    );
    const call = pollingWatchdog()(prev as any, "getUpdates", { timeout: 30 }, stop.signal as any);
    stop.abort();
    await expect(call).rejects.toThrow("stopped");
  });
});
