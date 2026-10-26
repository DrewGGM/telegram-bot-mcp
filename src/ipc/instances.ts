import { randomBytes } from "node:crypto";

/**
 * Registry of live bridge instances — one per Claude Code session that has the
 * telegram-bridge attached, whether the daemon spawned it (per-turn token) or
 * it is a desktop session reaching us through the persistent registration
 * (FR-19).
 *
 * Each session runs its own MCP bridge process, so one process == one session:
 * that 1:1 relationship is what gives us a stable identity to reply to. The
 * daemon mints the id (unguessable, so one session cannot claim another's
 * inbox) and hands it back at /register.
 *
 * Replies are pulled, not pushed: the bridge long-polls `waitForReply` for as
 * long as it lives, and decides locally whether to hand the text to a blocked
 * tool call, inject it into the Claude session as a channel event, or keep it
 * until the agent asks. A bridge that stops polling is dead within
 * {@link LIVENESS_MS}; its inbox is dropped by `prune`.
 */

export interface BridgeInstance {
  id: string;
  /** Short human label shown in Telegram, e.g. the project folder name. */
  label: string;
  cwd: string;
  /** IPC session the registering token belongs to (`global` for desktop sessions). */
  sessionId: string;
  registeredAt: number;
  /** Last time the bridge process talked to us — refreshed by every call, including polls. */
  lastSeenAt: number;
  /** The bridge can inject replies straight into its Claude session (channel mode). */
  push: boolean;
  /** The agent is blocked in a wait tool right now. */
  waiting: boolean;
  /** Owner replies not yet collected by the bridge. */
  inbox: string[];
  /** Resolvers for in-flight `waitForReply` calls, oldest first. */
  waiters: ((text: string) => void)[];
}

export interface RegisterInput {
  label: string;
  cwd: string;
  sessionId: string;
  push?: boolean;
}

export interface MessageOrigin {
  id: string;
  label: string;
  sessionId: string;
  /** The bridge process has polled recently, so a reply will actually be read. */
  alive: boolean;
  push: boolean;
  waiting: boolean;
}

/** A bridge polls at least once per minute; anything quieter than this is gone. */
export const LIVENESS_MS = 2 * 60_000;

const MAX_LABEL = 40;
const MAX_TRACKED_MESSAGES = 2000;

export class InstanceRegistry {
  private readonly byId = new Map<string, BridgeInstance>();
  /**
   * Telegram message id -> who sent it. The label and session are stored
   * alongside the id so we can still name the session in a reply after it has
   * exited.
   */
  private readonly messageOwner = new Map<number, { id: string; label: string; sessionId: string }>();

  register(input: RegisterInput): BridgeInstance {
    const id = randomBytes(12).toString("hex");
    const now = Date.now();
    const instance: BridgeInstance = {
      id,
      label: input.label.slice(0, MAX_LABEL) || "claude",
      cwd: input.cwd,
      sessionId: input.sessionId,
      registeredAt: now,
      lastSeenAt: now,
      push: input.push === true,
      waiting: false,
      inbox: [],
      waiters: [],
    };
    this.byId.set(id, instance);
    return instance;
  }

  /** Look up an instance and record that its bridge is alive. */
  get(id: string): BridgeInstance | undefined {
    const found = this.byId.get(id);
    if (found) found.lastSeenAt = Date.now();
    return found;
  }

  /** Look up without touching `lastSeenAt` (for listings and tests). */
  peek(id: string): BridgeInstance | undefined {
    return this.byId.get(id);
  }

  list(): BridgeInstance[] {
    return [...this.byId.values()];
  }

  isAlive(id: string, now: number = Date.now()): boolean {
    const inst = this.byId.get(id);
    return inst !== undefined && now - inst.lastSeenAt <= LIVENESS_MS;
  }

  setPresence(id: string, presence: { waiting?: boolean; push?: boolean }): boolean {
    const inst = this.get(id);
    if (!inst) return false;
    if (presence.waiting !== undefined) inst.waiting = presence.waiting;
    if (presence.push !== undefined) inst.push = presence.push;
    return true;
  }

  /** Remember which session a delivered Telegram message came from. */
  claimMessage(messageId: number, instanceId: string): void {
    const inst = this.byId.get(instanceId);
    this.messageOwner.set(messageId, {
      id: instanceId,
      label: inst?.label ?? "claude",
      sessionId: inst?.sessionId ?? "",
    });
    // Keep the map bounded; old messages are rarely replied to.
    if (this.messageOwner.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.messageOwner.keys().next();
      if (!oldest.done) this.messageOwner.delete(oldest.value);
    }
  }

  /**
   * Which session sent the message the owner is replying to? Returns the record
   * even when the session has since exited (`alive: false`) so the caller can
   * say so instead of silently routing the reply somewhere else.
   */
  ownerOfMessage(messageId: number, now: number = Date.now()): MessageOrigin | undefined {
    const entry = this.messageOwner.get(messageId);
    if (!entry) return undefined;
    const inst = this.byId.get(entry.id);
    return {
      id: entry.id,
      label: entry.label,
      sessionId: entry.sessionId,
      alive: inst !== undefined && now - inst.lastSeenAt <= LIVENESS_MS,
      push: inst?.push ?? false,
      waiting: inst?.waiting ?? false,
    };
  }

  /**
   * Deliver an owner reply. Hands it straight to a waiting poll when the bridge
   * is blocked in `waitForReply`, otherwise queues it for the next poll.
   */
  deliver(instanceId: string, text: string): boolean {
    const instance = this.byId.get(instanceId);
    if (!instance) return false;
    const waiter = instance.waiters.shift();
    if (waiter) waiter(text);
    else instance.inbox.push(text);
    return true;
  }

  /**
   * Collect the next reply for a session, waiting up to `timeoutMs`. Resolves to
   * undefined on timeout, or when `signal` aborts (the bridge hung up before an
   * answer arrived — the reply then stays queued instead of being handed to a
   * connection nobody is reading).
   */
  waitForReply(instanceId: string, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
    const instance = this.get(instanceId);
    if (!instance) return Promise.resolve(undefined);
    const queued = instance.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal?.aborted) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      const finish = (text: string | undefined): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        instance.waiters = instance.waiters.filter((w) => w !== onReply);
        resolve(text);
      };
      const onReply = (text: string): void => finish(text);
      const onAbort = (): void => finish(undefined);
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      instance.waiters.push(onReply);
    });
  }

  /**
   * Forget every instance registered under a per-turn session. Called when the
   * daemon revokes that session's token (its `claude -p` process has exited),
   * so a later swipe-reply is routed as a new turn instead of into a dead inbox.
   */
  dropBySession(sessionId: string): number {
    let removed = 0;
    for (const [id, inst] of this.byId) {
      if (inst.sessionId === sessionId) {
        this.byId.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Drop instances that have not called in for a while, releasing nothing that is still polling. */
  prune(maxIdleMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [id, inst] of this.byId) {
      if (now - inst.lastSeenAt > maxIdleMs && inst.waiters.length === 0) {
        this.byId.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
