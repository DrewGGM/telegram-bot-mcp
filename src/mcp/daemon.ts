import type {
  AskUserBody,
  AskUserResult,
  PresenceBody,
  RegisterBody,
  RegisterResult,
  SendFileBody,
  SendFileResult,
  SendMessageBody,
  SendMessageResult,
  WaitReplyBody,
  WaitReplyResult,
} from "../ipc/protocol.js";
import { IPC_ROUTES, IPC_TOKEN_HEADER } from "../ipc/protocol.js";

/**
 * Typed HTTP client for the daemon's loopback IPC, used by the bridge process.
 * Every call carries the session token; the daemon decides the destination.
 */

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "DaemonError";
  }
  /** The daemon is not running (or not on this port) — nothing to retry quickly. */
  get unreachable(): boolean {
    return this.status === null;
  }
}

export class DaemonClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  get configured(): boolean {
    return this.baseUrl !== "" && this.token !== "";
  }

  register(body: RegisterBody): Promise<RegisterResult> {
    return this.call(IPC_ROUTES.register, body);
  }
  presence(body: PresenceBody): Promise<{ ok: true }> {
    return this.call(IPC_ROUTES.presence, body);
  }
  sendMessage(body: SendMessageBody): Promise<SendMessageResult> {
    return this.call(IPC_ROUTES.sendMessage, body);
  }
  sendFile(body: SendFileBody): Promise<SendFileResult> {
    return this.call(IPC_ROUTES.sendFile, body);
  }
  askUser(body: AskUserBody): Promise<AskUserResult> {
    return this.call(IPC_ROUTES.askUser, body);
  }
  /** Long-poll; the daemon holds the request open up to `timeoutMs`. */
  waitReply(body: WaitReplyBody): Promise<WaitReplyResult> {
    return this.call(IPC_ROUTES.waitReply, body);
  }

  private async call<T>(route: string, body: unknown): Promise<T> {
    if (!this.configured) throw new DaemonError("bridge not configured (missing IPC url/token)", null);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", [IPC_TOKEN_HEADER]: this.token },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new DaemonError(`daemon unreachable at ${this.baseUrl}: ${String(err)}`, null);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const err = (await res.json()) as { error?: string };
        detail = err.error ? `: ${err.error}` : "";
      } catch {
        /* non-JSON error body */
      }
      throw new DaemonError(`daemon returned ${res.status}${detail}`, res.status);
    }
    return (await res.json()) as T;
  }
}
