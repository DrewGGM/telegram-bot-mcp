/**
 * Contract between the daemon's IPC server and the per-session MCP bridge.
 *
 * Transport is HTTP on 127.0.0.1 only (security baseline §4.1.2). Every request
 * is a POST carrying a bearer token in {@link IPC_TOKEN_HEADER}: a per-turn
 * token minted at spawn time and kept in memory, or the persisted desktop token
 * (FR-19). The bridge NEVER sends a chat/topic id — the daemon derives the
 * destination from the token alone (ADR-5, anti-exfiltration).
 */

export interface BridgeTarget {
  chatId: number;
  topicId?: number;
}

export const IPC_TOKEN_HEADER = "x-tbm-token";

/** Session id under which the persistent desktop token is registered. */
export const GLOBAL_SESSION_ID = "global";

/** Routes the IPC server understands. All are POST with a JSON body. */
export const IPC_ROUTES = {
  /** Announce a bridge process; the daemon mints its instance id. */
  register: "/register",
  /** Tell the daemon whether the agent is blocked waiting and whether it can receive pushes. */
  presence: "/presence",
  sendMessage: "/send_message",
  sendFile: "/send_file",
  askUser: "/ask_user",
  /** Long-poll for the next owner reply addressed to an instance. */
  waitReply: "/wait_reply",
} as const;

export interface RegisterBody {
  label: string;
  cwd: string;
  /** True when the bridge can inject replies straight into its Claude session (channel mode). */
  push?: boolean;
}
export interface RegisterResult {
  instanceId: string;
  label: string;
}

export interface PresenceBody {
  instanceId: string;
  /** The agent is blocked in a wait tool right now. */
  waiting?: boolean;
  push?: boolean;
}

export interface SendMessageBody {
  text: string;
  instanceId?: string;
}
export interface SendMessageResult {
  ok: true;
  messageId?: number;
}

export interface SendFileBody {
  path: string;
  caption?: string;
  instanceId?: string;
}
export interface SendFileResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export interface AskUserBody {
  question: string;
  options: string[];
  instanceId?: string;
}
/** `answer` is null when the owner never tapped a button (timeout or /panic). */
export interface AskUserResult {
  answer: string | null;
  timedOut: boolean;
}

export interface WaitReplyBody {
  instanceId: string;
  timeoutMs?: number;
}
export interface WaitReplyResult {
  reply: string | null;
  timedOut: boolean;
}

/**
 * Sentinel answers the bot's question registry resolves with when nobody
 * tapped. They never reach the agent as text: the IPC layer turns them into
 * `{ answer: null, timedOut: true }`.
 */
export const ASK_TIMEOUT_ANSWER = "__timeout__";
export const ASK_CANCELLED_ANSWER = "__cancelled__";

/** The daemon-side handlers the IPC server dispatches to. */
export interface TelegramBridge {
  /** Returns the delivered Telegram message id, so replies can be routed back. */
  sendMessage(target: BridgeTarget, text: string): Promise<number | undefined>;
  /**
   * Delivering a file can legitimately fail (outside the allowlist, too large).
   * Report that instead of a bare id, so the agent is never told "sent" when the
   * daemon refused it.
   */
  sendFile(target: BridgeTarget, filePath: string, caption?: string): Promise<SendFileResult>;
  /** Resolves with the chosen option, or a sentinel answer when nobody tapped. */
  askUser(target: BridgeTarget, question: string, options: string[]): Promise<string>;
}
