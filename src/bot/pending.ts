/**
 * Registry of in-flight inline-keyboard questions. Backs both destructive-op
 * confirmations (FR-16) and the MCP `telegram_ask_user` tool (FR-17): a message
 * with buttons is sent, and the promise resolves when the owner taps one. Each
 * question has a short id encoded into callback_data as `q:<id>:<index>`.
 */

interface Pending {
  options: string[];
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingQuestions {
  private readonly map = new Map<string, Pending>();
  private seq = 0;

  /** Register a question; returns its id and a promise that resolves on answer. */
  register(options: string[], timeoutMs = 10 * 60_000): { id: string; promise: Promise<string> } {
    const id = (++this.seq).toString(36);
    const promise = new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        resolve("__timeout__");
      }, timeoutMs);
      this.map.set(id, { options, resolve, timer });
    });
    return { id, promise };
  }

  callbackData(id: string, index: number): string {
    return `q:${id}:${index}`;
  }

  /** Parse a callback_data string produced by {@link callbackData}. */
  parse(data: string): { id: string; index: number } | null {
    const m = /^q:([0-9a-z]+):(\d+)$/.exec(data);
    if (!m) return null;
    return { id: m[1]!, index: Number(m[2]) };
  }

  /** Resolve a pending question from a callback; returns the chosen option text. */
  resolve(data: string): { matched: boolean; chosen?: string } {
    const parsed = this.parse(data);
    if (!parsed) return { matched: false };
    const pending = this.map.get(parsed.id);
    if (!pending) return { matched: false };
    const chosen = pending.options[parsed.index];
    if (chosen === undefined) return { matched: false };
    clearTimeout(pending.timer);
    this.map.delete(parsed.id);
    pending.resolve(chosen);
    return { matched: true, chosen };
  }

  /** Reject/close all pending questions (e.g. on /panic). */
  clear(answer = "__cancelled__"): void {
    for (const [, p] of this.map) {
      clearTimeout(p.timer);
      p.resolve(answer);
    }
    this.map.clear();
  }
}
