import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IpcServer } from "../ipc/server.js";
import type { BridgeTarget } from "../ipc/protocol.js";

/**
 * Full M4 path, for real: spawn the telegram-bridge MCP server as a subprocess,
 * drive it with an MCP client, and confirm each tool call travels bridge → IPC →
 * daemon and lands on the token's fixed destination (ADR-5). No Telegram network
 * involved — the daemon side is a capturing fake.
 */

interface Call {
  kind: string;
  target: BridgeTarget;
  payload: unknown;
}

let calls: Call[] = [];
let server: IpcServer;
let client: Client;
let transport: StdioClientTransport;

const fakeBridge = {
  async sendMessage(target: BridgeTarget, text: string) {
    calls.push({ kind: "message", target, payload: text });
  },
  async sendFile(target: BridgeTarget, filePath: string, caption?: string) {
    calls.push({ kind: "file", target, payload: { filePath, caption } });
  },
  async askUser(target: BridgeTarget, question: string, options: string[]) {
    calls.push({ kind: "ask", target, payload: { question, options } });
    return options[1] ?? options[0] ?? "";
  },
};

beforeAll(async () => {
  server = new IpcServer(fakeBridge);
  await server.listen();
  const token = server.registerSession("mcp-test", { chatId: 123, topicId: 9 });

  const serverSrc = path.resolve(import.meta.dirname, "server.ts");
  transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", serverSrc],
    env: {
      ...(process.env as Record<string, string>),
      TBM_IPC_URL: server.url,
      TBM_IPC_TOKEN: token,
    },
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
});

describe("telegram-bridge MCP server", () => {
  it("exposes the four bridge tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "telegram_ask_user",
      "telegram_send_file",
      "telegram_send_message",
      "telegram_wait_reply",
    ]);
  });

  it("send_message reaches the daemon at the token's fixed destination", async () => {
    calls = [];
    await client.callTool({ name: "telegram_send_message", arguments: { text: "hi from agent" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("message");
    expect(calls[0].target).toEqual({ chatId: 123, topicId: 9 });
    // The daemon prefixes a foreign session's messages with its label, so you
    // can tell which project is talking and swipe-reply to that one.
    expect(calls[0].payload).toMatch(/^\[.+\] hi from agent$/);
  });

  it("ask_user returns the owner's answer to the agent", async () => {
    calls = [];
    const res = (await client.callTool({
      name: "telegram_ask_user",
      arguments: { question: "Deploy now?", options: ["Yes", "No"] },
    })) as { content: { type: string; text: string }[] };
    expect(calls[0].kind).toBe("ask");
    // fakeBridge returns options[1] = "No"
    expect(res.content[0].text).toContain("No");
  });
}, 30_000);
