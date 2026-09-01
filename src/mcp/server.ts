#!/usr/bin/env node
/**
 * telegram-bridge MCP server (FR-17/18, ADR-5). Launched as a stdio child of
 * each `claude` session. It gives the agent three tools to reach the owner:
 *   - telegram_send_message(text)
 *   - telegram_send_file(path, caption?)
 *   - telegram_ask_user(question, options[]) -> the owner's choice
 *
 * The agent can NEVER specify a chat/topic id: every call is routed by the
 * daemon using the per-session token in TBM_IPC_TOKEN, so a prompt injection
 * cannot redirect output to a third party. Talks to the daemon over loopback
 * IPC only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { IPC_TOKEN_HEADER } from "../ipc/protocol.js";

const IPC_URL = process.env.TBM_IPC_URL ?? "";
const IPC_TOKEN = process.env.TBM_IPC_TOKEN ?? "";

/**
 * Identity of THIS session. One Claude Code session spawns one bridge process,
 * so this id is a stable handle the owner can reply to. The daemon mints it at
 * /register; we only carry it. Empty until registration succeeds (which is
 * fine — messages still deliver, they just can't be replied to).
 */
let instanceId = "";

async function callDaemon(route: string, body: unknown): Promise<any> {
  if (!IPC_URL || !IPC_TOKEN) throw new Error("bridge not configured (missing IPC url/token)");
  const res = await fetch(`${IPC_URL}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [IPC_TOKEN_HEADER]: IPC_TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`daemon returned ${res.status}`);
  return res.json();
}

/**
 * Announce this session to the daemon so the owner can reply to it by name.
 * Best-effort: a failure here must not break the tools.
 */
async function registerInstance(): Promise<void> {
  try {
    const cwd = process.cwd();
    // basename, not a hand-rolled split: cwd uses backslashes on Windows.
    const label = process.env.TBM_LABEL || path.basename(cwd) || "claude";
    const res = await callDaemon("/register", { label, cwd });
    if (typeof res.instanceId === "string") instanceId = res.instanceId;
  } catch {
    /* the bridge still works one-way without an identity */
  }
}

export function buildBridgeServer(): McpServer {
  const server = new McpServer({ name: "telegram-bridge", version: "1.0.0" });

  server.registerTool(
    "telegram_send_message",
    {
      title: "Send a Telegram message to the owner",
      description:
        "Send a text message to the owner in this session's chat. Use for status updates, results, or notifications. The destination is fixed by the daemon. Set wait_for_reply to block until the owner replies (they reply by swiping on your message in Telegram) - use it whenever you need their answer before continuing.",
      inputSchema: {
        text: z.string().min(1).describe("The message text to send."),
        wait_for_reply: z
          .boolean()
          .optional()
          .describe("Block until the owner replies to this message. Default false."),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(1800)
          .optional()
          .describe("How long to wait when wait_for_reply is true. Default 300."),
      },
    },
    async ({ text, wait_for_reply, timeout_seconds }) => {
      await callDaemon("/send_message", { text, instanceId });
      if (!wait_for_reply) {
        return { content: [{ type: "text", text: "Message delivered to the owner." }] };
      }
      if (!instanceId) {
        return {
          content: [
            { type: "text", text: "Message delivered, but this session has no identity registered, so it cannot receive a reply." },
          ],
        };
      }
      const res = await callDaemon("/wait_reply", {
        instanceId,
        timeoutMs: (timeout_seconds ?? 300) * 1000,
      });
      return {
        content: [
          {
            type: "text",
            text: res.timedOut
              ? "Message delivered, but the owner did not reply in time."
              : `The owner replied: ${res.reply}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "telegram_send_file",
    {
      title: "Send a file to the owner",
      description:
        "Send a file from an allowed directory to the owner in this session's chat. Provide an absolute path; the daemon validates it against the folder allowlist.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path of the file to send."),
        caption: z.string().optional().describe("Optional caption."),
      },
    },
    async ({ path, caption }) => {
      await callDaemon("/send_file", { path, caption, instanceId });
      return { content: [{ type: "text", text: `File sent: ${path}` }] };
    },
  );

  server.registerTool(
    "telegram_ask_user",
    {
      title: "Ask the owner a question with buttons",
      description:
        "Ask the owner a question and wait for their answer. Provide 2-6 short options; the owner taps one. Returns the chosen option. Use for confirmations or decisions.",
      inputSchema: {
        question: z.string().min(1).describe("The question to ask."),
        options: z.array(z.string().min(1)).min(1).max(6).describe("Answer buttons (1-6)."),
      },
    },
    async ({ question, options }) => {
      const reply = await callDaemon("/ask_user", { question, options, instanceId });
      return { content: [{ type: "text", text: `The owner answered: ${reply.answer}` }] };
    },
  );

  server.registerTool(
    "telegram_wait_reply",
    {
      title: "Wait for the owner to reply on Telegram",
      description:
        "Block until the owner sends a reply to this session, then return their message. The owner replies by swiping on one of your Telegram messages. Use this after telegram_send_message when you want their input, or to poll for instructions during long-running work.",
      inputSchema: {
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(1800)
          .optional()
          .describe("How long to wait before giving up. Default 300."),
      },
    },
    async ({ timeout_seconds }) => {
      if (!instanceId) {
        return {
          content: [{ type: "text", text: "This session has no identity registered with the daemon, so it cannot receive replies." }],
        };
      }
      const res = await callDaemon("/wait_reply", {
        instanceId,
        timeoutMs: (timeout_seconds ?? 300) * 1000,
      });
      return {
        content: [
          { type: "text", text: res.timedOut ? "No reply from the owner within the timeout." : `The owner replied: ${res.reply}` },
        ],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  await registerInstance();
  const server = buildBridgeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  process.argv[1] !== undefined && /mcp[\\/]server\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  void main();
}
