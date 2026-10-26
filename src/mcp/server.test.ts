import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IpcServer } from "../ipc/server.js";
import type { BridgeTarget } from "../ipc/protocol.js";
import {
  CHANNEL_NOTIFICATION,
  PERMISSION_REQUEST_NOTIFICATION,
  PERMISSION_VERDICT_NOTIFICATION,
} from "./server.js";

/**
 * Full bridge path, for real: spawn the telegram-bridge MCP server as a
 * subprocess, drive it with an MCP client, and confirm each tool call travels
 * bridge → IPC → daemon and lands on the token's fixed destination (ADR-5).
 * Then the push path: an owner reply delivered on the daemon side arrives in
 * the session as a channel event, or as the result of a blocked wait tool —
 * never both. No Telegram network involved; the daemon side is a capturing fake.
 */

interface Call {
  kind: string;
  target: BridgeTarget;
  payload: unknown;
}

let calls: Call[] = [];
let answerWith: (options: string[]) => string = (o) => o[1] ?? o[0] ?? "";
let server: IpcServer;
let client: Client;
let transport: StdioClientTransport;

const fakeBridge = {
  async sendMessage(target: BridgeTarget, text: string) {
    calls.push({ kind: "message", target, payload: text });
    return 100 + calls.length;
  },
  async sendFile(target: BridgeTarget, filePath: string, caption?: string) {
    calls.push({ kind: "file", target, payload: { filePath, caption } });
    return { ok: true, messageId: 200 + calls.length };
  },
  async askUser(target: BridgeTarget, question: string, options: string[]) {
    calls.push({ kind: "ask", target, payload: { question, options } });
    return answerWith(options);
  },
};

const ChannelEvent = z.object({
  method: z.literal(CHANNEL_NOTIFICATION),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});
const Verdict = z.object({
  method: z.literal(PERMISSION_VERDICT_NOTIFICATION),
  params: z.object({ request_id: z.string(), behavior: z.enum(["allow", "deny"]) }),
});
const channelEvents: z.infer<typeof ChannelEvent>["params"][] = [];
const verdicts: z.infer<typeof Verdict>["params"][] = [];

function instanceId(): string {
  const inst = server.instances.list()[0];
  if (!inst) throw new Error("bridge did not register");
  return inst.id;
}

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
      TBM_LABEL: "proj",
      // Pretend the parent claude opted in to the channel, as if started with
      // --dangerously-load-development-channels server:telegram-bridge.
      TBM_CHANNEL: "1",
    },
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  client.setNotificationHandler(ChannelEvent, async (n) => {
    channelEvents.push(n.params);
  });
  client.setNotificationHandler(Verdict, async (n) => {
    verdicts.push(n.params);
  });
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

  it("declares itself as a Claude Code channel with permission relay", () => {
    const experimental = client.getServerCapabilities()?.experimental ?? {};
    expect(experimental).toHaveProperty("claude/channel");
    expect(experimental).toHaveProperty("claude/channel/permission");
    expect(client.getInstructions()).toMatch(/pushed into this session automatically/);
  });

  it("registers itself with the daemon under its label, in push mode", () => {
    const inst = server.instances.list();
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({ label: "proj", push: true });
  });

  it("send_message reaches the daemon at the token's fixed destination", async () => {
    calls = [];
    const res = (await client.callTool({
      name: "telegram_send_message",
      arguments: { text: "hi from agent" },
    })) as {
      content: { text: string }[];
    };
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("message");
    expect(calls[0]!.target).toEqual({ chatId: 123, topicId: 9 });
    // The daemon prefixes a session's messages with its label, so you can tell
    // which project is talking and swipe-reply to that one.
    expect(calls[0]!.payload).toBe("[proj] hi from agent");
    expect(res.content[0]!.text).toMatch(/arrive in this session automatically/);
  });

  it("send_file reports a refusal instead of claiming success", async () => {
    calls = [];
    const res = (await client.callTool({
      name: "telegram_send_file",
      arguments: { path: "/tmp/x.pdf", caption: "c" },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(calls[0]).toMatchObject({
      kind: "file",
      payload: { filePath: "/tmp/x.pdf", caption: "[proj] c" },
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/File sent/);
  });

  it("ask_user returns the owner's answer to the agent", async () => {
    calls = [];
    const res = (await client.callTool({
      name: "telegram_ask_user",
      arguments: { question: "Deploy now?", options: ["Yes", "No"] },
    })) as { content: { type: string; text: string }[] };
    expect(calls[0]!.kind).toBe("ask");
    // answerWith returns options[1] = "No"
    expect(res.content[0]!.text).toContain("No");
  });

  it("a swipe-reply is pushed into the session as a channel event", async () => {
    server.instances.deliver(instanceId(), "go ahead");
    await vi.waitFor(() => expect(channelEvents).toHaveLength(1), { timeout: 10_000 });
    expect(channelEvents[0]).toEqual({
      content: "go ahead",
      meta: { from: "owner", via: "telegram", label: "proj" },
    });
  }, 15_000);

  it("a reply resolves a blocked wait tool instead of being pushed", async () => {
    const pending = client.callTool({ name: "telegram_wait_reply", arguments: { timeout_seconds: 20 } });
    await vi.waitFor(() => expect(server.instances.peek(instanceId())!.waiting).toBe(true), {
      timeout: 10_000,
    });
    server.instances.deliver(instanceId(), "approved");
    const res = (await pending) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("The owner replied: approved");
    await new Promise((r) => setTimeout(r, 300));
    expect(channelEvents).toHaveLength(1); // still only the earlier push
    await vi.waitFor(() => expect(server.instances.peek(instanceId())!.waiting).toBe(false));
  }, 15_000);

  it("relays a permission prompt to Telegram buttons and sends the verdict back", async () => {
    calls = [];
    answerWith = (o) => o[0]!; // tap "✅ Allow"
    await client.notification({
      method: PERMISSION_REQUEST_NOTIFICATION,
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "List files",
        input_preview: '{"command":"ls"}',
      },
    } as never);
    await vi.waitFor(() => expect(verdicts).toHaveLength(1), { timeout: 10_000 });
    expect(verdicts[0]).toEqual({ request_id: "abcde", behavior: "allow" });
    const ask = calls.find((c) => c.kind === "ask")!;
    expect(ask.payload).toMatchObject({ options: ["✅ Allow", "❌ Deny"] });
    expect((ask.payload as { question: string }).question).toMatch(/Bash/);
    expect((ask.payload as { question: string }).question).toMatch(/abcde/);
  }, 15_000);
}, 30_000);
