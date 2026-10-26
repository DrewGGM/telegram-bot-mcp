import { openAsBlob } from "node:fs";
import path from "node:path";
import { InputFile, type Transformer } from "grammy";
import { log } from "../logger.js";

/**
 * Client for an optional **local Bot API server** (core.telegram.org/bots/api,
 * "Using a local Bot API server"). Running one lifts the upload limit from
 * 50 MB to 2000 MB and, because it talks to Telegram over MTProto, it is
 * markedly more reliable on links where `api.telegram.org` itself is lossy.
 *
 * It is an accelerator, never a dependency: grammY keeps long-polling the cloud
 * API for updates, so no `logOut` is needed and the bot keeps working when the
 * server is down. Every *outgoing* call is tried on the local server first via
 * {@link localFirstTransformer} and falls back to the cloud API transparently.
 * A full `apiRoot` switch would move `getUpdates` there too and make Docker a
 * hard dependency for the bot to work at all; that trade was deliberately
 * refused.
 */

/** Upload limit of a local Bot API server, in bytes (the cloud's is TELEGRAM_SEND_LIMIT). */
export const LOCAL_SEND_LIMIT = 2000 * 1024 * 1024;

/**
 * Methods that must stay on the cloud API. `getUpdates` because the local
 * server would need a `logOut` first; `getFile` because a local server returns
 * a path on its own disk rather than a downloadable URL; the webhook/session
 * methods because they manage the cloud session itself.
 */
const CLOUD_ONLY_METHODS = new Set([
  "getUpdates",
  "getFile",
  "logOut",
  "close",
  "setWebhook",
  "deleteWebhook",
  "getWebhookInfo",
]);

export interface LocalApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  /** True when the server could not be reached at all, as opposed to an API error. */
  transportError?: boolean;
}

export interface LocalUploadResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

/**
 * Availability is cached briefly: every outgoing call consults it, and a probe
 * per call would add a round-trip to the common case. A short TTL still
 * notices the container going up or down within seconds.
 */
let availability: { at: number; ok: boolean } | null = null;
const AVAILABILITY_TTL_MS = 30_000;
const CALL_TIMEOUT_MS = 30_000;

/** Cached {@link probeLocalServer}. Pass force to bypass the cache. */
export async function isLocalServerUp(apiRoot: string, token: string, force = false): Promise<boolean> {
  if (!apiRoot) return false;
  const now = Date.now();
  if (!force && availability && now - availability.at < AVAILABILITY_TTL_MS) return availability.ok;
  const ok = await probeLocalServer(apiRoot, token);
  availability = { at: now, ok };
  return ok;
}

/** Invalidate the cache, e.g. after a call through the local server failed. */
export function forgetLocalServerAvailability(): void {
  availability = null;
}

/** Is a local Bot API server reachable and serving this bot? */
export async function probeLocalServer(apiRoot: string, token: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(`${apiRoot}/bot${token}/getMe`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/**
 * Call any JSON Bot API method on the local server. The response is Telegram's
 * own `{ ok, result | description }` envelope, so callers (and grammY) handle
 * it exactly like a cloud response.
 */
export async function callLocalApi<T = unknown>(
  apiRoot: string,
  token: string,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LocalApiResult<T>> {
  try {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const res = await fetch(`${apiRoot}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = (await res.json()) as { ok?: boolean; description?: string; result?: T };
    if (body.ok !== true) return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    return { ok: true, ...(body.result !== undefined ? { result: body.result } : {}) };
  } catch (err) {
    return { ok: false, error: String(err), transportError: true };
  }
}

/** Does a grammY payload carry a file to upload (which needs multipart, not JSON)? */
export function hasInputFile(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== "object") return false;
  if (value instanceof InputFile) return true;
  if (Array.isArray(value)) return value.some((v) => hasInputFile(v, depth + 1));
  return Object.values(value as Record<string, unknown>).some((v) => hasInputFile(v, depth + 1));
}

/**
 * grammY API transformer: route every plain JSON method through the local
 * server when it is up, falling back to the cloud API (`prev`) when the server
 * is unreachable, when the method must stay on the cloud, or when the payload
 * carries a file (uploads go through {@link uploadViaLocalServer} instead).
 *
 * An API-level error from the local server (bad chat id, caption too long…)
 * is returned as-is: the cloud would say the same, and retrying there would
 * only mask the mistake.
 */
export function localFirstTransformer(opts: { getApiRoot: () => string; token: string }): Transformer {
  return async (prev, method, payload, signal) => {
    const apiRoot = opts.getApiRoot();
    if (!apiRoot || CLOUD_ONLY_METHODS.has(method) || hasInputFile(payload)) {
      return prev(method, payload, signal);
    }
    if (!(await isLocalServerUp(apiRoot, opts.token))) return prev(method, payload, signal);

    // grammY types the signal with the `abort-controller` polyfill; at runtime it is the global one.
    const res = await callLocalApi(
      apiRoot,
      opts.token,
      method,
      payload as Record<string, unknown>,
      signal as unknown as AbortSignal | undefined,
    );
    if (res.transportError) {
      forgetLocalServerAvailability();
      log.warn({ method, err: res.error }, "local Bot API server unreachable, falling back to the cloud API");
      return prev(method, payload, signal);
    }
    if (res.ok) return { ok: true, result: res.result } as Awaited<ReturnType<typeof prev>>;
    return { ok: false, error_code: 400, description: res.error ?? "local Bot API error" } as Awaited<
      ReturnType<typeof prev>
    >;
  };
}

/**
 * Send a document through the local server. The file is streamed from disk via
 * openAsBlob rather than buffered, so a 2 GB upload does not need 2 GB of heap.
 */
export async function uploadViaLocalServer(
  apiRoot: string,
  token: string,
  chatId: number,
  filePath: string,
  opts: { caption?: string; topicId?: number } = {},
): Promise<LocalUploadResult> {
  try {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (opts.caption) form.set("caption", opts.caption);
    if (opts.topicId !== undefined) form.set("message_thread_id", String(opts.topicId));
    form.set("document", await openAsBlob(filePath), path.basename(filePath));

    const res = await fetch(`${apiRoot}/bot${token}/sendDocument`, { method: "POST", body: form });
    const body = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (!body.ok) {
      return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    }
    log.info({ filePath, messageId: body.result?.message_id }, "uploaded via local Bot API server");
    return {
      ok: true,
      ...(body.result?.message_id !== undefined ? { messageId: body.result.message_id } : {}),
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
