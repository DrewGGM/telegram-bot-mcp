import type { Context, MiddlewareFn } from "grammy";
import type { Config } from "../config/config.js";
import { audit } from "../audit/audit.js";
import { log } from "../logger.js";

/**
 * Identity gate (FR-1, security baseline §4.1.1 — deny by default).
 *
 * The bot must be invisible to everyone but the owner: any update whose sender
 * is not the owner, or whose chat is neither the owner's private chat nor the
 * configured forum group, is dropped WITHOUT a reply (never leak the bot's
 * existence). This logic is pure and TDD-covered; the middleware is a thin shell.
 */

export interface Identity {
  userId: number;
  chatId: number;
}

export type AuthDecision =
  /** Owner, in an allowed chat — process normally. */
  | "allow"
  /** No owner configured yet; a private-chat sender may self-register via /start. */
  | "bootstrap"
  /** Anyone/anything else — drop silently. */
  | "drop";

export function decideAuth(id: Identity, ctx: Pick<Config, "ownerId" | "groupId">): AuthDecision {
  // In a private chat, Telegram uses chatId === userId. A positive chatId that
  // equals the userId is the sender's own private chat.
  const isOwnPrivateChat = id.chatId === id.userId;

  if (ctx.ownerId === 0) {
    // Un-owned bot: only a private-chat sender can bootstrap ownership.
    return isOwnPrivateChat ? "bootstrap" : "drop";
  }

  if (id.userId !== ctx.ownerId) return "drop";

  const inOwnerPrivate = isOwnPrivateChat && id.chatId === ctx.ownerId;
  const inGroup = ctx.groupId !== undefined && id.chatId === ctx.groupId;
  return inOwnerPrivate || inGroup ? "allow" : "drop";
}

/**
 * Is this update one of the only two things an UNCLAIMED bot may answer?
 *
 * Before an owner exists we cannot authenticate anybody, so the bootstrap
 * window must expose nothing but the ownership handshake. Anything else - /ls,
 * /find, /get, /config - would let whoever finds the bot first read and
 * exfiltrate files from the allowlist.
 */
function isOwnershipHandshake(ctx: Context): boolean {
  const text = ctx.message?.text ?? "";
  if (/^\/start(@\w+)?(\s|$)/.test(text)) return true;
  return ctx.callbackQuery?.data?.startsWith("claim:") === true;
}

/**
 * grammY middleware enforcing {@link decideAuth}. Must be registered FIRST so no
 * downstream handler ever sees an unauthorized update. A `drop` is completely
 * silent, and `bootstrap` is narrowed to the ownership handshake alone, so a new
 * command can never accidentally be reachable before the bot has an owner.
 */
export function authMiddleware(getConfig: () => Config): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId === undefined || chatId === undefined) return; // channel posts etc.

    const decision = decideAuth({ userId, chatId }, getConfig());
    if (decision === "drop") {
      audit({ kind: "auth.denied", userId, chatId });
      log.warn({ userId, chatId }, "dropped unauthorized update");
      return; // silent
    }
    if (decision === "bootstrap" && !isOwnershipHandshake(ctx)) {
      audit({ kind: "auth.denied", userId, chatId });
      log.warn({ userId, chatId }, "dropped non-handshake update on an unclaimed bot");
      return; // silent
    }
    return next();
  };
}
