/**
 * Contract between the daemon's IPC server and the per-session MCP bridge.
 * Transport is HTTP on 127.0.0.1 only (security baseline §4.1.2). Every request
 * carries a per-session bearer token minted at spawn time and never written to
 * disk. The bridge NEVER sends a chat/topic id — the daemon derives the
 * destination from the token alone (ADR-5, anti-exfiltration).
 */

export interface BridgeTarget {
  chatId: number;
  topicId?: number;
}

export interface SendMessageBody {
  text: string;
}
export interface SendFileBody {
  path: string;
  caption?: string;
}
export interface AskUserBody {
  question: string;
  options: string[];
}
export interface AskUserReply {
  answer: string;
}

/** The daemon-side handlers the IPC server dispatches to. */
export interface TelegramBridge {
  sendMessage(target: BridgeTarget, text: string): Promise<void>;
  sendFile(target: BridgeTarget, filePath: string, caption?: string): Promise<void>;
  askUser(target: BridgeTarget, question: string, options: string[]): Promise<string>;
}

export const IPC_TOKEN_HEADER = "x-tbm-token";
