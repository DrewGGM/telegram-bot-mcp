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
import { z } from "zod";
import { IPC_TOKEN_HEADER } from "../ipc/protocol.js";

const IPC_URL = process.env.TBM_IPC_URL ?? "";
const IPC_TOKEN = process.env.TBM_IPC_TOKEN ?? "";

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

export function buildBridgeServer(): McpServer {
  const server = new McpServer({ name: "telegram-bridge", version: "1.0.0" });

  server.registerTool(
    "telegram_send_message",
    {
      title: "Send a Telegram message to the owner",
      description:
        "Send a text message to the owner in this session's chat. Use for status updates, results, or notifications. The destination is fixed by the daemon.",
      inputSchema: { text: z.string().min(1).describe("The message text to send.") },
    },
    async ({ text }) => {
      await callDaemon("/send_message", { text });
      return { content: [{ type: "text", text: "Message delivered to the owner." }] };
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
      await callDaemon("/send_file", { path, caption });
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
      const reply = await callDaemon("/ask_user", { question, options });
      return { content: [{ type: "text", text: `The owner answered: ${reply.answer}` }] };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildBridgeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  process.argv[1] !== undefined && /mcp[\\/]server\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  void main();
}
