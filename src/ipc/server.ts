import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type {
  AskUserResult,
  BridgeTarget,
  RegisterResult,
  SendMessageResult,
  TelegramBridge,
  WaitReplyResult,
} from "./protocol.js";
import {
  ASK_CANCELLED_ANSWER,
  ASK_TIMEOUT_ANSWER,
  GLOBAL_SESSION_ID,
  IPC_ROUTES,
  IPC_TOKEN_HEADER,
} from "./protocol.js";
import { InstanceRegistry } from "./instances.js";
import { audit } from "../audit/audit.js";
import { log } from "../logger.js";

/**
 * Loopback-only IPC server for the MCP bridge (§4.1.2). Binds strictly to
 * 127.0.0.1, authenticates every request with a per-session token, and resolves
 * the destination from that token — the caller cannot choose where a message
 * goes (ADR-5). Per-turn tokens live only in memory.
 */

interface Registered {
  sessionId: string;
  /**
   * Resolved per request rather than stored flat, so a long-lived token (the
   * global desktop registration, FR-19) still follows the owner even if
   * ownership is claimed after the daemon started.
   */
  getTarget: () => BridgeTarget | undefined;
  /** Present only for per-turn session tokens, whose topic can be assigned late. */
  setTarget?: (t: BridgeTarget) => void;
}

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_WAIT_MS = 300_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 30 * 60_000;

export class IpcServer {
  private server: Server;
  private readonly tokens = new Map<string, Registered>();
  private boundPort = 0;
  /** Bridge instances (desktop registrations and per-turn sessions), for reply routing. */
  readonly instances = new InstanceRegistry();

  constructor(private readonly bridge: TelegramBridge) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  /**
   * Start listening on loopback. Pass a fixed port so a registered desktop
   * bridge keeps working across restarts; 0 picks an ephemeral port (tests).
   */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      // 127.0.0.1 explicitly — never 0.0.0.0.
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : 0;
        log.info({ port: this.boundPort }, "IPC server listening on loopback");
        resolve(this.boundPort);
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  /** Mint a fresh token bound to a session's destination. */
  registerSession(sessionId: string, target: BridgeTarget): string {
    const token = randomBytes(24).toString("hex");
    let current = target;
    this.tokens.set(token, {
      sessionId,
      getTarget: () => current,
      setTarget: (t) => {
        current = t;
      },
    });
    return token;
  }

  /**
   * Register a caller-supplied token whose destination is resolved on each
   * request — used for the persistent desktop registration (FR-19), where the
   * token lives in your Claude Code config and the owner may be claimed later.
   */
  registerPersistent(sessionId: string, token: string, getTarget: () => BridgeTarget | undefined): void {
    this.tokens.set(token, { sessionId, getTarget });
  }

  /** Update the destination for every token of a session (e.g. topic assigned late). */
  updateTarget(sessionId: string, target: BridgeTarget): void {
    for (const reg of this.tokens.values()) {
      if (reg.sessionId === sessionId) reg.setTarget?.(target);
    }
  }

  /**
   * Revoke a per-turn session: its token stops working and the bridge instances
   * it registered are forgotten, so a reply to one of their messages after the
   * turn is routed as a new turn rather than parked in a dead inbox.
   */
  revokeSession(sessionId: string): void {
    for (const [token, reg] of this.tokens) {
      if (reg.sessionId === sessionId) this.tokens.delete(token);
    }
    if (sessionId !== GLOBAL_SESSION_ID) this.instances.dropBySession(sessionId);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

      const token = req.headers[IPC_TOKEN_HEADER];
      const reg = typeof token === "string" ? this.tokens.get(token) : undefined;
      if (!reg) {
        audit({ kind: "ipc.rejected", reason: "bad or missing token" });
        return json(res, 403, { error: "forbidden" });
      }

      // Destination is resolved here, by the daemon — never taken from the body.
      const target = reg.getTarget();
      if (!target) {
        audit({ kind: "ipc.rejected", reason: "no owner claimed yet" });
        return json(res, 409, { error: "no owner configured; send /start to the bot first" });
      }

      const body = await readJson(req);
      const route = req.url ?? "";

      // A bridge identifies itself so replies can find their way back. The id
      // is minted here, never supplied by the caller.
      if (route === IPC_ROUTES.register) {
        const instance = this.instances.register({
          label: String(body.label ?? ""),
          cwd: String(body.cwd ?? ""),
          sessionId: reg.sessionId,
          push: body.push === true,
        });
        log.info(
          { instanceId: instance.id, label: instance.label, push: instance.push, session: reg.sessionId },
          "bridge instance registered",
        );
        const out: RegisterResult = { instanceId: instance.id, label: instance.label };
        return json(res, 200, out);
      }

      const instanceId = typeof body.instanceId === "string" ? body.instanceId : undefined;
      const instance = instanceId ? this.instances.get(instanceId) : undefined;
      // Prefix messages from bridge sessions so you can tell who is talking.
      const label = instance ? `[${instance.label}] ` : "";

      if (route === IPC_ROUTES.presence) {
        if (!instance) return json(res, 404, { error: "unknown or expired instanceId" });
        this.instances.setPresence(instance.id, {
          ...(typeof body.waiting === "boolean" ? { waiting: body.waiting } : {}),
          ...(typeof body.push === "boolean" ? { push: body.push } : {}),
        });
        return json(res, 200, { ok: true });
      }
      if (route === IPC_ROUTES.sendMessage) {
        const messageId = await this.bridge.sendMessage(target, label + String(body.text ?? ""));
        if (instance && messageId !== undefined) this.instances.claimMessage(messageId, instance.id);
        log.info({ messageId, instance: instance?.label ?? null }, "bridge message sent");
        const out: SendMessageResult = { ok: true, ...(messageId !== undefined ? { messageId } : {}) };
        return json(res, 200, out);
      }
      if (route === IPC_ROUTES.sendFile) {
        const caption = body.caption ? label + String(body.caption) : label || undefined;
        const out = await this.bridge.sendFile(target, String(body.path ?? ""), caption);
        if (instance && out.messageId !== undefined) this.instances.claimMessage(out.messageId, instance.id);
        return json(res, 200, out);
      }
      if (route === IPC_ROUTES.askUser) {
        const options = Array.isArray(body.options) ? body.options.map(String) : [];
        const answer = await this.bridge.askUser(target, label + String(body.question ?? ""), options);
        const unanswered = answer === ASK_TIMEOUT_ANSWER || answer === ASK_CANCELLED_ANSWER;
        const out: AskUserResult = { answer: unanswered ? null : answer, timedOut: unanswered };
        return json(res, 200, out);
      }
      if (route === IPC_ROUTES.waitReply) {
        if (!instance) return json(res, 404, { error: "unknown or expired instanceId" });
        const timeoutMs = Math.min(
          Math.max(Number(body.timeoutMs) || DEFAULT_WAIT_MS, MIN_WAIT_MS),
          MAX_WAIT_MS,
        );
        // If the bridge hangs up mid-poll, release the waiter so the reply is
        // queued for its next poll instead of written to a closed socket.
        const hangup = new AbortController();
        res.once("close", () => hangup.abort());
        const reply = await this.instances.waitForReply(instance.id, timeoutMs, hangup.signal);
        if (res.writableEnded || hangup.signal.aborted) return;
        const out: WaitReplyResult = { reply: reply ?? null, timedOut: reply === undefined };
        return json(res, 200, out);
      }
      return json(res, 404, { error: "unknown route" });
    } catch (err) {
      log.error({ err }, "IPC handler error");
      if (!res.writableEnded) return json(res, 500, { error: String(err) });
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
