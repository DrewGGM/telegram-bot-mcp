import type { Transformer } from "grammy";
import { log } from "../logger.js";

/**
 * Watchdog for grammY's long polling.
 *
 * grammY sends `getUpdates` with a 30 s server-side timeout but its HTTP client
 * waits up to 500 s by default, and polling errors that are not Bot API errors
 * are retried silently. On a link where `api.telegram.org` drops packets, the
 * response to one long poll can vanish into a half-open socket: the bot then
 * keeps *sending* perfectly (each send is a fresh connection) while it hears
 * nothing for minutes — every reply you type is lost in that window.
 *
 * This transformer gives every `getUpdates` call its own deadline (server
 * timeout + margin), so a dead socket is abandoned and grammY retries on a
 * fresh one within seconds, and it logs each failure so the problem is visible.
 */

export const POLL_MARGIN_MS = 15_000;
const DEFAULT_SERVER_TIMEOUT_S = 30;

export interface PollingStats {
  lastOkAt: number;
  consecutiveFailures: number;
}

export function pollingWatchdog(
  stats: PollingStats = { lastOkAt: 0, consecutiveFailures: 0 },
  marginMs: number = POLL_MARGIN_MS,
): Transformer {
  return async (prev, method, payload, signal) => {
    if (method !== "getUpdates") return prev(method, payload, signal);

    const serverTimeoutS = Number((payload as { timeout?: number }).timeout ?? DEFAULT_SERVER_TIMEOUT_S);
    const deadline = AbortSignal.timeout(serverTimeoutS * 1000 + marginMs);
    // grammY types the signal with the `abort-controller` polyfill; at runtime it is the global one.
    const outer = signal as unknown as AbortSignal | undefined;
    const combined = outer ? AbortSignal.any([outer, deadline]) : deadline;
    try {
      const res = await prev(method, payload, combined as unknown as typeof signal);
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
          {
            err: String(err),
            stalled: deadline.aborted,
            consecutiveFailures: stats.consecutiveFailures,
          },
          deadline.aborted ? "long poll stalled, retrying on a fresh connection" : "long poll failed",
        );
      }
      throw err;
    }
  };
}
