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
 * grammY middleware enforcing {@link decideAuth}. Must be registered FIRST so no
 * downstream handler ever sees an unauthorized update. In `bootstrap` mode it
 * lets updates through (the /start handler gates itself to reveal the id); a
 * `drop` is completely silent.
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
    // `allow` and `bootstrap` both proceed; handlers behave per config.ownerId.
    return next();
  };
}
