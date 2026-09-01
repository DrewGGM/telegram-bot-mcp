import { randomBytes } from "node:crypto";

/**
 * Registry of live *foreign* bridge instances — Claude Code sessions that the
 * daemon did NOT spawn, reaching us through the desktop registration (FR-19).
 *
 * Each session runs its own MCP bridge process, so one process == one session:
 * that 1:1 relationship is what gives us a stable identity to reply to. The
 * daemon mints the id (unguessable, so one session cannot claim another's
 * inbox) and hands it back at /register.
 *
 * Replies flow the only way MCP allows: the daemon parks them in an inbox and
 * the session collects them when it calls telegram_wait_reply. A session that
 * has already finished its turn simply never collects — see README.
 */

export interface ForeignInstance {
  id: string;
  /** Short human label shown in Telegram, e.g. the project folder name. */
  label: string;
  cwd: string;
  registeredAt: number;
  lastSeenAt: number;
  /** Owner replies waiting to be collected by this session. */
  inbox: string[];
  /** Resolvers for in-flight telegram_wait_reply calls. */
  waiters: ((text: string) => void)[];
}

export class InstanceRegistry {
  private readonly byId = new Map<string, ForeignInstance>();
  /**
   * Telegram message id -> who sent it. The label is stored alongside the id so
   * we can still name the session in a reply even after it has exited.
   */
  private readonly messageOwner = new Map<number, { id: string; label: string }>();

  register(label: string, cwd: string): ForeignInstance {
    const id = randomBytes(12).toString("hex");
    const now = Date.now();
    const instance: ForeignInstance = {
      id,
      label: label.slice(0, 40) || "claude",
      cwd,
      registeredAt: now,
      lastSeenAt: now,
      inbox: [],
      waiters: [],
    };
    this.byId.set(id, instance);
    return instance;
  }

  get(id: string): ForeignInstance | undefined {
    const found = this.byId.get(id);
    if (found) found.lastSeenAt = Date.now();
    return found;
  }

  list(): ForeignInstance[] {
    return [...this.byId.values()];
  }

  /** Remember which session a delivered Telegram message came from. */
  claimMessage(messageId: number, instanceId: string): void {
    const label = this.byId.get(instanceId)?.label ?? "claude";
    this.messageOwner.set(messageId, { id: instanceId, label });
    // Keep the map bounded; old messages are rarely replied to.
    if (this.messageOwner.size > 2000) {
      const oldest = this.messageOwner.keys().next();
      if (!oldest.done) this.messageOwner.delete(oldest.value);
    }
  }

  /**
   * Which session sent the message the owner is replying to? Returns the record
   * even when the session has since exited (`alive: false`) so the caller can
   * say so instead of silently routing the reply somewhere else.
   */
  ownerOfMessage(messageId: number): { id: string; label: string; alive: boolean } | undefined {
    const entry = this.messageOwner.get(messageId);
    if (!entry) return undefined;
    return { id: entry.id, label: entry.label, alive: this.get(entry.id) !== undefined };
  }

  /**
   * Deliver an owner reply. Hands it straight to a waiting call when the
   * session is blocked on telegram_wait_reply, otherwise queues it.
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
   * Collect the next reply for a session, waiting up to `timeoutMs`.
   * Resolves to undefined on timeout so the agent can decide what to do.
   */
  waitForReply(instanceId: string, timeoutMs: number): Promise<string | undefined> {
    const instance = this.byId.get(instanceId);
    if (!instance) return Promise.resolve(undefined);
    const queued = instance.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        instance.waiters = instance.waiters.filter((w) => w !== onReply);
        resolve(undefined);
      }, timeoutMs);
      const onReply = (text: string): void => {
        clearTimeout(timer);
        resolve(text);
      };
      instance.waiters.push(onReply);
    });
  }

  /** Drop instances that have not called in for a while, releasing waiters. */
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
