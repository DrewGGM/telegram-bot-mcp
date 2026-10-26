/**
 * Decides what happens to an owner reply once the bridge has pulled it from
 * the daemon. There is exactly one consumer per session (this process), so the
 * choice is local and deterministic:
 *
 *   1. a tool call is blocked waiting (`wait_for_reply`, `telegram_wait_reply`)
 *      → hand it to that call; the agent gets it as the tool result;
 *   2. otherwise, if the session opted in as a channel
 *      → push it into the session as a `notifications/claude/channel` event;
 *   3. otherwise → keep it until the agent asks.
 *
 * Case 1 beats case 2 on purpose: a reply must never be delivered twice (once
 * as a tool result, once as a channel event), and a blocked tool call is the
 * agent explicitly saying "I am listening here".
 */

export type Delivery = "tool" | "channel" | "queued";

export type PushSink = (text: string) => Promise<void> | void;

export class ReplyRouter {
  private readonly inbox: string[] = [];
  private waiters: ((text: string) => void)[] = [];

  /**
   * @param push Returns the channel sink when pushing is active, or null when
   *             the session did not opt in (or the transport is not ready).
   */
  constructor(private readonly push: () => PushSink | null) {}

  /** A reply arrived from the daemon. Returns how it was delivered. */
  async dispatch(text: string): Promise<Delivery> {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(text);
      return "tool";
    }
    const sink = this.push();
    if (sink) {
      await sink(text);
      return "channel";
    }
    this.inbox.push(text);
    return "queued";
  }

  /**
   * A tool wants the next reply: queued ones first, otherwise wait up to
   * `timeoutMs`. Resolves to undefined on timeout.
   */
  next(timeoutMs: number): Promise<string | undefined> {
    const queued = this.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onReply);
        resolve(undefined);
      }, timeoutMs);
      const onReply = (text: string): void => {
        clearTimeout(timer);
        resolve(text);
      };
      this.waiters.push(onReply);
    });
  }

  /** Replies collected but not yet read by the agent. */
  get queued(): number {
    return this.inbox.length;
  }

  /** Is a tool call blocked waiting right now? */
  get waiting(): boolean {
    return this.waiters.length > 0;
  }
}
