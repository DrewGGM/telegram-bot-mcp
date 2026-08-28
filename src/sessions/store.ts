import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, type SessionMode } from "../config/config.js";

/**
 * Session state (§3.3). The blueprint named SQLite, but for a strictly
 * single-user daemon a small append-safe JSON document is simpler, dependency-
 * free (no native build), and trivially inspectable — YAGNI wins. Writes are
 * atomic (temp file + rename) so a crash mid-write can't corrupt the store.
 */

export type SessionState = "idle" | "running" | "hibernated";

export interface Session {
  /** Internal short id used in commands (/kill s3). */
  id: string;
  /** Claude Code conversation id (uuid) — stable for the life of the session. */
  claudeSessionId: string;
  cwd: string;
  model: string;
  mode: SessionMode;
  /** Destination chat for this session's output. */
  chatId: number;
  /** Forum topic thread id, when the session lives in a group topic. */
  topicId?: number;
  /** The implicit read-only chat session bound to the owner's private chat. */
  isDefault: boolean;
  /** False until the first turn completes (drives --session-id vs --resume). */
  firstTurnDone: boolean;
  state: SessionState;
  createdAt: string;
  lastActiveAt: string;
}

interface StoreDoc {
  seq: number;
  sessions: Session[];
}

export class SessionStore {
  private doc: StoreDoc;
  constructor(private readonly filePath: string = path.join(DATA_DIR, "sessions.json")) {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.doc = existsSync(this.filePath)
      ? (JSON.parse(readFileSync(this.filePath, "utf8")) as StoreDoc)
      : { seq: 0, sessions: [] };
  }

  private persist(): void {
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.doc, null, 2) + "\n", "utf8");
    renameSync(tmp, this.filePath);
  }

  list(): Session[] {
    return [...this.doc.sessions];
  }

  active(): Session[] {
    return this.doc.sessions.filter((s) => s.state !== "hibernated" || s.isDefault);
  }

  get(id: string): Session | undefined {
    return this.doc.sessions.find((s) => s.id === id);
  }

  byTopic(topicId: number): Session | undefined {
    return this.doc.sessions.find((s) => s.topicId === topicId);
  }

  /** The default (private-chat) session for a chat, if one exists. */
  defaultFor(chatId: number): Session | undefined {
    return this.doc.sessions.find((s) => s.isDefault && s.chatId === chatId);
  }

  create(input: {
    cwd: string;
    model: string;
    mode: SessionMode;
    chatId: number;
    topicId?: number;
    isDefault?: boolean;
  }): Session {
    this.doc.seq += 1;
    const now = new Date().toISOString();
    const session: Session = {
      id: `s${this.doc.seq}`,
      claudeSessionId: randomUUID(),
      cwd: input.cwd,
      model: input.model,
      mode: input.mode,
      chatId: input.chatId,
      ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
      isDefault: input.isDefault ?? false,
      firstTurnDone: false,
      state: "idle",
      createdAt: now,
      lastActiveAt: now,
    };
    this.doc.sessions.push(session);
    this.persist();
    return session;
  }

  update(id: string, patch: Partial<Session>): Session | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    Object.assign(s, patch);
    this.persist();
    return s;
  }

  touch(id: string): void {
    this.update(id, { lastActiveAt: new Date().toISOString() });
  }

  remove(id: string): boolean {
    const before = this.doc.sessions.length;
    this.doc.sessions = this.doc.sessions.filter((s) => s.id !== id);
    if (this.doc.sessions.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  /** Sessions idle longer than `minutes` and eligible for hibernation (FR-11). */
  staleSessions(minutes: number, now: number = Date.now()): Session[] {
    const cutoff = now - minutes * 60_000;
    return this.doc.sessions.filter(
      (s) => s.state !== "hibernated" && new Date(s.lastActiveAt).getTime() < cutoff,
    );
  }
}
