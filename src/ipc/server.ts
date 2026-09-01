import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { BridgeTarget, TelegramBridge } from "./protocol.js";
import { IPC_TOKEN_HEADER } from "./protocol.js";
import { InstanceRegistry } from "./instances.js";
import { audit } from "../audit/audit.js";
import { log } from "../logger.js";

/**
 * Loopback-only IPC server for the MCP bridge (§4.1.2). Binds strictly to
 * 127.0.0.1, authenticates every request with a per-session token, and resolves
 * the destination from that token — the caller cannot choose where a message
 * goes (ADR-5). Minted tokens live only in memory.
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

export class IpcServer {
  private server: Server;
  private readonly tokens = new Map<string, Registered>();
  private boundPort = 0;
  /** Foreign sessions reached through the desktop registration (FR-19). */
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

  revokeSession(sessionId: string): void {
    for (const [token, reg] of this.tokens) {
      if (reg.sessionId === sessionId) this.tokens.delete(token);
    }
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

      // A foreign session identifies itself so replies can find their way back.
      // The id is minted here, never supplied by the caller on /register.
      if (route === "/register") {
        const instance = this.instances.register(String(body.label ?? ""), String(body.cwd ?? ""));
        log.info({ instanceId: instance.id, label: instance.label }, "foreign session registered");
        return json(res, 200, { instanceId: instance.id, label: instance.label });
      }

      const instanceId = typeof body.instanceId === "string" ? body.instanceId : undefined;
      const instance = instanceId ? this.instances.get(instanceId) : undefined;
      // Prefix messages from foreign sessions so you can tell who is talking.
      const label = instance ? `[${instance.label}] ` : "";

      if (route === "/send_message") {
        const messageId = await this.bridge.sendMessage(target, label + String(body.text ?? ""));
        if (instance && messageId !== undefined) this.instances.claimMessage(messageId, instance.id);
        return json(res, 200, { ok: true, messageId });
      }
      if (route === "/send_file") {
        const caption = body.caption ? label + String(body.caption) : label || undefined;
        const out = await this.bridge.sendFile(target, String(body.path ?? ""), caption);
        if (instance && out.messageId !== undefined) this.instances.claimMessage(out.messageId, instance.id);
        return json(res, 200, out);
      }
      if (route === "/ask_user") {
        const options = Array.isArray(body.options) ? body.options.map(String) : [];
        const answer = await this.bridge.askUser(target, label + String(body.question ?? ""), options);
        return json(res, 200, { answer });
      }
      if (route === "/wait_reply") {
        if (!instance) return json(res, 400, { error: "unknown or expired instanceId" });
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 300_000, 1_000), 30 * 60_000);
        const reply = await this.instances.waitForReply(instance.id, timeoutMs);
        return json(res, 200, { reply: reply ?? null, timedOut: reply === undefined });
      }
      return json(res, 404, { error: "unknown route" });
    } catch (err) {
      log.error({ err }, "IPC handler error");
      return json(res, 500, { error: String(err) });
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
      if (size > 1_000_000) {
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
