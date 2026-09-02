import { openAsBlob } from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

/**
 * Uploads through a **local Bot API server** (core.telegram.org/bots/api,
 * "Using a local Bot API server"), which raises the send limit from 50 MB to
 * 2000 MB. That lets big files go out untouched instead of being re-encoded.
 *
 * Deliberately used only for the oversize path, as a side channel:
 * grammY keeps polling the cloud API, so the bot needs no `logOut` and keeps
 * working normally if this server is down — we simply fall back to compressing.
 * A full switch (apiRoot) would move getUpdates here too and require logOut,
 * making Docker a hard dependency for the bot to work at all.
 */

/** Bot API limits, in bytes. */
export const CLOUD_SEND_LIMIT = 50 * 1024 * 1024;
export const LOCAL_SEND_LIMIT = 2000 * 1024 * 1024;

export interface LocalUploadResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

/**
 * Availability is cached briefly: `send` consults it on every message, and a
 * probe per message would add a round-trip to the common case. A short TTL
 * still notices the container going up or down within seconds.
 */
let availability: { at: number; ok: boolean } | null = null;
const AVAILABILITY_TTL_MS = 30_000;

/** Cached {@link probeLocalServer}. Pass force to bypass the cache. */
export async function isLocalServerUp(apiRoot: string, token: string, force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && availability && now - availability.at < AVAILABILITY_TTL_MS) return availability.ok;
  const ok = await probeLocalServer(apiRoot, token);
  availability = { at: now, ok };
  return ok;
}

/** Invalidate the cache, e.g. after a send through the local server failed. */
export function forgetLocalServerAvailability(): void {
  availability = null;
}

/**
 * Send a text message through the local server.
 *
 * Worth doing for ordinary messages too, not just big files: on a connection
 * where `api.telegram.org` is unreliable, the local server reaches Telegram over
 * MTProto instead, which measured 5/5 against 3/5 for direct HTTPS.
 */
export async function sendMessageViaLocalServer(
  apiRoot: string,
  token: string,
  chatId: number,
  text: string,
  topicId?: number,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  try {
    const body = new URLSearchParams({ chat_id: String(chatId), text });
    if (topicId !== undefined) body.set("message_thread_id", String(topicId));
    const res = await fetch(`${apiRoot}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!json.ok) return { ok: false, error: json.description ?? `HTTP ${res.status}` };
    return { ok: true, ...(json.result?.message_id !== undefined ? { messageId: json.result.message_id } : {}) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Is a local Bot API server reachable and serving this bot? */
export async function probeLocalServer(apiRoot: string, token: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(`${apiRoot}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
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
    const body = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!body.ok) {
      return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    }
    log.info({ filePath, messageId: body.result?.message_id }, "uploaded via local Bot API server");
    return { ok: true, ...(body.result?.message_id !== undefined ? { messageId: body.result.message_id } : {}) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
