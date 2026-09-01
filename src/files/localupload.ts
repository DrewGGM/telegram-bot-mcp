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
