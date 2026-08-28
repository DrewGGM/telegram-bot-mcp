import { spawn, type ChildProcess } from "node:child_process";
import type { Config } from "../config/config.js";
import type { Session, SessionStore } from "./store.js";
import { buildClaudeArgs } from "./cli.js";
import { parseStreamLine, createLineSplitter, summarizeToolUse } from "./stream.js";
import { writeMcpConfig } from "../mcp/config.js";
import type { IpcServer } from "../ipc/server.js";
import { audit } from "../audit/audit.js";
import { log } from "../logger.js";

/**
 * Orchestrates Claude Code turns (ADR-1). Each user message spawns a fresh
 * `claude -p --resume` process; there is no long-lived interactive child, so
 * hibernation is free and a crash never loses conversation state. Tracks live
 * children so `/panic` and `/kill` can terminate them immediately.
 */

export interface TurnCallbacks {
  onText?(text: string): void;
  onTool?(summary: string): void;
  onResult?(result: { text: string; isError: boolean; ms?: number }): void;
  onError?(message: string): void;
}

export class SessionManager {
  private readonly children = new Map<string, ChildProcess>();
  private panicked = false;

  constructor(
    private readonly store: SessionStore,
    private readonly getConfig: () => Config,
    private readonly guardrailsPath: string,
    private readonly ipc: IpcServer,
  ) {}

  get isPanicked(): boolean {
    return this.panicked;
  }

  setPanicked(v: boolean): void {
    this.panicked = v;
  }

  isRunning(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  /** Run one turn for `session` with `prompt`; stream events to callbacks. */
  async runTurn(session: Session, prompt: string, cb: TurnCallbacks): Promise<void> {
    if (this.panicked) {
      cb.onError?.("The bridge is locked (/panic). Send /unlock to resume.");
      return;
    }
    if (this.children.has(session.id)) {
      cb.onError?.("This session is still working on the previous message.");
      return;
    }

    const config = this.getConfig();
    const token = this.ipc.registerSession(session.id, {
      chatId: session.chatId,
      ...(session.topicId !== undefined ? { topicId: session.topicId } : {}),
    });
    const mcpConfigPath = writeMcpConfig(session.id, this.ipc.url, token);

    const args = buildClaudeArgs({
      claudeSessionId: session.claudeSessionId,
      firstTurn: !session.firstTurnDone,
      model: session.model,
      mode: session.mode,
      addDirs: config.allowedDirs,
      settingsPath: this.guardrailsPath,
      mcpConfigPath,
    });

    // The agent must never see the Telegram bot token; give it only the allowlist.
    const env: Record<string, string | undefined> = {
      ...process.env,
      TBM_ALLOWED_DIRS: JSON.stringify(config.allowedDirs),
    };
    delete env.BOT_TOKEN;

    audit({ kind: "turn.start", sessionId: session.id, chars: prompt.length });
    this.store.update(session.id, { state: "running", lastActiveAt: new Date().toISOString() });
    const started = Date.now();

    const child = spawn(config.claudeBin, args, {
      cwd: session.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.children.set(session.id, child);

    const timeoutMs = config.turnTimeoutMinutes * 60_000;
    const timer = setTimeout(() => {
      log.warn({ sessionId: session.id }, "turn timed out, killing");
      child.kill();
    }, timeoutMs);

    const splitter = createLineSplitter();
    let sawResult = false;

    const handleLine = (line: string): void => {
      for (const ev of parseStreamLine(line)) {
        switch (ev.type) {
          case "system":
            break;
          case "assistant_text":
            if (ev.text.trim()) cb.onText?.(ev.text);
            break;
          case "tool_use":
            cb.onTool?.(summarizeToolUse(ev));
            break;
          case "result":
            sawResult = true;
            cb.onResult?.({ text: ev.text, isError: ev.isError, ...(ev.durationMs !== undefined ? { ms: ev.durationMs } : {}) });
            break;
        }
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // Feed the prompt on stdin (avoids argv length limits and shell quoting).
    child.stdin?.write(prompt);
    child.stdin?.end();

    await new Promise<void>((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timer);
        for (const line of splitter.flush()) handleLine(line);
        this.children.delete(session.id);
        this.ipc.revokeSession(session.id);

        const ms = Date.now() - started;
        this.store.update(session.id, {
          state: "idle",
          firstTurnDone: true,
          lastActiveAt: new Date().toISOString(),
        });
        audit({ kind: "turn.end", sessionId: session.id, ok: code === 0 && sawResult, ms });

        if (code !== 0 && !sawResult) {
          cb.onError?.(stderr.trim() ? `Claude exited (code ${code}): ${stderr.trim().slice(0, 500)}` : `Claude exited with code ${code}.`);
        }
        resolve();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        this.children.delete(session.id);
        this.ipc.revokeSession(session.id);
        cb.onError?.(`Failed to launch Claude: ${err.message}`);
        resolve();
      });
    });
  }

  /** Kill one session's in-flight process, if any. */
  kill(sessionId: string): void {
    const child = this.children.get(sessionId);
    if (child) {
      child.kill();
      this.children.delete(sessionId);
      this.ipc.revokeSession(sessionId);
    }
  }

  /** /panic — terminate every running child immediately. */
  killAll(): number {
    const n = this.children.size;
    for (const [id, child] of this.children) {
      child.kill();
      this.ipc.revokeSession(id);
    }
    this.children.clear();
    return n;
  }
}
