import type { Transformer } from "grammy";
import { log } from "../logger.js";

/**
 * Watchdog for grammY's long polling.
 *
 * grammY sends `getUpdates` with a 30 s server-side timeout but its HTTP client
 * waits up to 500 s by default, and polling errors that are not Bot API errors
 * are retried silently. On a link where `api.telegram.org` drops packets, the
 * response to one long poll can vanish into a half-open socket: the bot keeps
 * *sending* (each send is a fresh connection) while it hears nothing.
 *
 * This transformer gives every `getUpdates` call its own deadline (server
 * timeout + margin), so a dead socket is abandoned and grammY retries on a
 * fresh one within seconds, and it logs every polling failure.
 *
 * grammY passes an AbortSignal from the `abort-controller` polyfill, which
 * Node's `AbortSignal.any` rejects. The signals are therefore linked by hand
 * through `addEventListener`, which both implementations support.
 */

export const POLL_MARGIN_MS = 15_000;
const DEFAULT_SERVER_TIMEOUT_S = 30;

export interface PollingStats {
  lastOkAt: number;
  consecutiveFailures: number;
}

interface SignalLike {
  aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export function pollingWatchdog(
  stats: PollingStats = { lastOkAt: 0, consecutiveFailures: 0 },
  marginMs: number = POLL_MARGIN_MS,
): Transformer {
  return async (prev, method, payload, signal) => {
    if (method !== "getUpdates") return prev(method, payload, signal);

    const outer = signal as unknown as SignalLike | undefined;
    const controller = new AbortController();
    let stalled = false;
    const onOuterAbort = (): void => controller.abort();
    const serverTimeoutS = Number((payload as { timeout?: number }).timeout ?? DEFAULT_SERVER_TIMEOUT_S);
    const timer = setTimeout(
      () => {
        stalled = true;
        controller.abort();
      },
      serverTimeoutS * 1000 + marginMs,
    );
    try {
      if (outer?.aborted) controller.abort();
      else outer?.addEventListener("abort", onOuterAbort);
      const res = await prev(method, payload, controller.signal as unknown as typeof signal);
      if (stats.consecutiveFailures > 0) {
        log.info({ after: stats.consecutiveFailures }, "long polling recovered");
      }
      stats.lastOkAt = Date.now();
      stats.consecutiveFailures = 0;
      return res;
    } catch (err) {
      // A stop() aborts the outer signal on purpose; that is not a failure.
      if (!outer?.aborted) {
        stats.consecutiveFailures++;
        log.warn(
          { err: String(err), stalled, consecutiveFailures: stats.consecutiveFailures },
          stalled ? "long poll stalled, retrying on a fresh connection" : "long poll failed",
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  };
}
