import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { BridgeTarget, TelegramBridge } from "./protocol.js";
import { IPC_TOKEN_HEADER } from "./protocol.js";
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
  target: BridgeTarget;
}

export class IpcServer {
  private server: Server;
  private readonly tokens = new Map<string, Registered>();
  private boundPort = 0;

  constructor(private readonly bridge: TelegramBridge) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  /** Start listening on an ephemeral loopback port. Resolves to the port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      // 127.0.0.1 explicitly — never 0.0.0.0.
      this.server.listen(0, "127.0.0.1", () => {
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
    this.tokens.set(token, { sessionId, target });
    return token;
  }

  /** Update the destination for every token of a session (e.g. topic assigned late). */
  updateTarget(sessionId: string, target: BridgeTarget): void {
    for (const reg of this.tokens.values()) {
      if (reg.sessionId === sessionId) reg.target = target;
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

      const body = await readJson(req);
      const route = req.url ?? "";

      if (route === "/send_message") {
        await this.bridge.sendMessage(reg.target, String(body.text ?? ""));
        return json(res, 200, { ok: true });
      }
      if (route === "/send_file") {
        await this.bridge.sendFile(reg.target, String(body.path ?? ""), body.caption ? String(body.caption) : undefined);
        return json(res, 200, { ok: true });
      }
      if (route === "/ask_user") {
        const options = Array.isArray(body.options) ? body.options.map(String) : [];
        const answer = await this.bridge.askUser(reg.target, String(body.question ?? ""), options);
        return json(res, 200, { answer });
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
