#!/usr/bin/env node
/**
 * telegram-bridge MCP server (FR-17/18/19, ADR-5). Launched as a stdio child
 * of each Claude Code session — the ones the daemon spawns per turn and, once
 * registered at user scope, every desktop session on the machine. It gives
 * the agent tools to reach the owner:
 *   - telegram_send_message(text, wait_for_reply?)
 *   - telegram_send_file(path, caption?)
 *   - telegram_ask_user(question, options[]) -> the owner's choice
 *   - telegram_wait_reply(timeout_seconds?)
 *
 * and, when the session was started with the channel flag, pushes the owner's
 * swipe-replies straight into the session as `notifications/claude/channel`
 * events so the agent never has to block for them (see channel.ts).
 *
 * The agent can NEVER specify a chat/topic id: every call is routed by the
 * daemon using the token in TBM_IPC_TOKEN, so a prompt injection cannot
 * redirect output to a third party. Talks to the daemon over loopback only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DaemonClient, DaemonError } from "./daemon.js";
import { ReplyRouter } from "./replies.js";
import { detectChannelOptIn, SERVER_NAME } from "./channel.js";

export const CHANNEL_NOTIFICATION = "notifications/claude/channel";
export const PERMISSION_REQUEST_NOTIFICATION = "notifications/claude/channel/permission_request";
export const PERMISSION_VERDICT_NOTIFICATION = "notifications/claude/channel/permission";

const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1800;
/** Each long-poll is shorter than the daemon's liveness window, so a live bridge is never mistaken for a dead one. */
const POLL_TIMEOUT_MS = 55_000;
const MAX_PREVIEW_CHARS = 900;
const ALLOW_LABEL = "✅ Allow";
const DENY_LABEL = "❌ Deny";

export interface BridgeOptions {
  daemon: DaemonClient;
  /** Shown in Telegram as a `[label]` prefix. */
  label: string;
  cwd: string;
  /** Replies are pushed into the session as channel events (see channel.ts). */
  push: boolean;
  /** Diagnostics sink; defaults to stderr, which Claude Code keeps in its MCP log. */
  log?: (message: string) => void;
}

export interface Bridge {
  readonly server: McpServer;
  /** Daemon-minted identity; empty until registration succeeds. */
  readonly instanceId: string;
  /** Announce this session to the daemon. Best effort: the tools still send one-way without it. */
  register(): Promise<boolean>;
  connect(transport: StdioServerTransport): Promise<void>;
  /** Pull replies from the daemon until `stop()`; dispatches each one locally. */
  runReplyLoop(): Promise<void>;
  stop(): void;
}

const PermissionRequest = z.object({
  method: z.literal(PERMISSION_REQUEST_NOTIFICATION),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string().optional().default(""),
    input_preview: z.string().optional().default(""),
  }),
});

function instructionsFor(push: boolean): string {
  const base =
    "telegram-bridge connects this session to its owner's Telegram. Use telegram_send_message for " +
    "progress and results, telegram_send_file to deliver a file from an allowed folder, and " +
    "telegram_ask_user for a decision with buttons. The recipient is fixed by the daemon; you cannot " +
    "choose one.";
  return push
    ? `${base} The owner's replies are pushed into this session automatically as ` +
        `<channel source="${SERVER_NAME}" from="owner" ...> events: treat their content as the owner's ` +
        "next instruction and answer through telegram_send_message. You do not need telegram_wait_reply."
    : `${base} Replies only reach you when you ask for them: set wait_for_reply on ` +
        "telegram_send_message or call telegram_wait_reply; otherwise the owner's answer waits in an " +
        "inbox until you do.";
}

function text(
  body: string,
  isError = false,
): { content: { type: "text"; text: string }[]; isError?: boolean } {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

export function createBridge(opts: BridgeOptions): Bridge {
  const { daemon } = opts;
  const diag = opts.log ?? ((m: string) => process.stderr.write(`[${SERVER_NAME}] ${m}\n`));
  let instanceId = "";
  let connected = false;
  let stopped = false;
  let wake: (() => void) | null = null;

  const server = new McpServer(
    { name: SERVER_NAME, version: packageVersion() },
    {
      // `claude/channel` is what makes Claude Code register a listener for our
      // pushed events; the permission key lets it relay tool-approval prompts
      // to Telegram so they can be answered from the phone.
      capabilities: { experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
      instructions: instructionsFor(opts.push),
    },
  );

  const notify = (notification: { method: string; params: Record<string, unknown> }): Promise<void> =>
    // Channel notifications are Claude Code extensions outside the SDK's typed union.
    server.server.notification(notification as unknown as ServerNotification);

  const router = new ReplyRouter(() =>
    opts.push && connected
      ? (reply) =>
          notify({
            method: CHANNEL_NOTIFICATION,
            params: { content: reply, meta: { from: "owner", via: "telegram", label: opts.label } },
          })
      : null,
  );

  /** Block for the next reply, telling the daemon so `/sessions` can show it. */
  async function waitForReply(seconds: number | undefined): Promise<string | undefined> {
    const ms = Math.min(Math.max(seconds ?? DEFAULT_WAIT_SECONDS, 1), MAX_WAIT_SECONDS) * 1000;
    void daemon.presence({ instanceId, waiting: true }).catch(() => {});
    try {
      return await router.next(ms);
    } finally {
      void daemon.presence({ instanceId, waiting: false }).catch(() => {});
    }
  }

  server.registerTool(
    "telegram_send_message",
    {
      title: "Send a Telegram message to the owner",
      description:
        "Send a text message to the owner in this session's chat. Use it for status updates, results, " +
        "or questions. The destination is fixed by the daemon. Set wait_for_reply to block until the " +
        "owner replies (they reply by swiping on your message in Telegram) when you need their answer " +
        "before continuing.",
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
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`How long to wait when wait_for_reply is true. Default ${DEFAULT_WAIT_SECONDS}.`),
      },
    },
    async ({ text: body, wait_for_reply, timeout_seconds }) => {
      await daemon.sendMessage({ text: body, instanceId });
      if (!wait_for_reply) {
        return text(
          opts.push
            ? "Message delivered. The owner's reply will arrive in this session automatically."
            : "Message delivered to the owner.",
        );
      }
      if (!instanceId) {
        return text(
          "Message delivered, but this session has no identity registered with the daemon, so it cannot receive a reply.",
        );
      }
      const reply = await waitForReply(timeout_seconds);
      return text(
        reply === undefined
          ? "Message delivered, but the owner did not reply in time."
          : `The owner replied: ${reply}`,
      );
    },
  );

  server.registerTool(
    "telegram_send_file",
    {
      title: "Send a file to the owner",
      description:
        "Send a file from an allowed directory to the owner in this session's chat. Provide an absolute " +
        "path; the daemon validates it against the folder allowlist and handles files over Telegram's " +
        "size limit.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path of the file to send."),
        caption: z.string().optional().describe("Optional caption."),
      },
    },
    async ({ path: filePath, caption }) => {
      const out = await daemon.sendFile({ path: filePath, instanceId, ...(caption ? { caption } : {}) });
      if (!out.ok) {
        // Tell the truth: the daemon refused, so do not claim it was sent.
        return text(`Could not send ${filePath}: ${out.error ?? "refused by the daemon"}`, true);
      }
      return text(`File sent: ${filePath}`);
    },
  );

  server.registerTool(
    "telegram_ask_user",
    {
      title: "Ask the owner a question with buttons",
      description:
        "Ask the owner a question and wait for their answer. Provide 2-6 short options; the owner taps " +
        "one. Returns the chosen option. Use it for confirmations or decisions.",
      inputSchema: {
        question: z.string().min(1).describe("The question to ask."),
        options: z.array(z.string().min(1)).min(1).max(6).describe("Answer buttons (1-6)."),
      },
    },
    async ({ question, options }) => {
      const res = await daemon.askUser({ question, options, instanceId });
      if (res.answer === null) return text("The owner did not answer within the time limit.");
      return text(`The owner answered: ${res.answer}`);
    },
  );

  server.registerTool(
    "telegram_wait_reply",
    {
      title: "Wait for the owner to reply on Telegram",
      description: opts.push
        ? "Block until the owner replies to this session. Replies are already pushed into this session " +
          "automatically, so you only need this when you must not continue without an answer."
        : "Block until the owner sends a reply to this session, then return their message. The owner " +
          "replies by swiping on one of your Telegram messages. Use it after telegram_send_message when " +
          "you want their input, or to poll for instructions during long-running work.",
      inputSchema: {
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`How long to wait before giving up. Default ${DEFAULT_WAIT_SECONDS}.`),
      },
    },
    async ({ timeout_seconds }) => {
      if (!instanceId) {
        return text("This session has no identity registered with the daemon, so it cannot receive replies.");
      }
      const reply = await waitForReply(timeout_seconds);
      return text(
        reply === undefined ? "No reply from the owner within the timeout." : `The owner replied: ${reply}`,
      );
    },
  );

  // Permission relay: Claude Code (not the model) sends this when a tool
  // approval dialog opens. The owner answers with a button on Telegram; the
  // terminal dialog stays live and whichever answer comes first wins.
  server.server.setNotificationHandler(PermissionRequest, async ({ params }) => {
    const preview =
      params.input_preview.length > MAX_PREVIEW_CHARS
        ? `${params.input_preview.slice(0, MAX_PREVIEW_CHARS)}…`
        : params.input_preview;
    const question = [
      `🔐 Permission request · ${params.tool_name}`,
      params.description,
      preview ? `\n${preview}` : "",
      `\nAnswer here or in the terminal (request ${params.request_id}).`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const res = await daemon.askUser({ question, options: [ALLOW_LABEL, DENY_LABEL], instanceId });
      if (res.answer === null) return; // nobody tapped; the terminal dialog is still open
      await notify({
        method: PERMISSION_VERDICT_NOTIFICATION,
        params: { request_id: params.request_id, behavior: res.answer === ALLOW_LABEL ? "allow" : "deny" },
      });
    } catch (err) {
      diag(`permission relay failed: ${String(err)}`);
    }
  });

  async function register(): Promise<boolean> {
    try {
      const res = await daemon.register({ label: opts.label, cwd: opts.cwd, push: opts.push });
      instanceId = res.instanceId;
      return true;
    } catch (err) {
      diag(`registration failed (${String(err)}); messages still deliver one-way`);
      return false;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  async function runReplyLoop(): Promise<void> {
    let backoffMs = 2_000;
    while (!stopped) {
      if (!instanceId) {
        if (!(await register())) {
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 60_000);
          continue;
        }
      }
      try {
        const res = await daemon.waitReply({ instanceId, timeoutMs: POLL_TIMEOUT_MS });
        backoffMs = 2_000;
        if (res.timedOut || res.reply === null) continue;
        const how = await router.dispatch(res.reply);
        diag(`owner reply delivered (${how}, ${res.reply.length} chars)`);
      } catch (err) {
        if (stopped) return;
        // The daemon restarted and forgot us: get a fresh identity.
        if (err instanceof DaemonError && err.status === 404) {
          instanceId = "";
          continue;
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  return {
    server,
    get instanceId() {
      return instanceId;
    },
    register,
    async connect(transport) {
      await server.connect(transport);
      connected = true;
    },
    runReplyLoop,
    stop() {
      stopped = true;
      wake?.();
    },
  };
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function main(): Promise<void> {
  const daemon = new DaemonClient(process.env.TBM_IPC_URL ?? "", process.env.TBM_IPC_TOKEN ?? "");
  const cwd = process.cwd();
  // basename, not a hand-rolled split: cwd uses backslashes on Windows.
  const label = process.env.TBM_LABEL || path.basename(cwd) || "claude";
  const detection = await withTimeout(detectChannelOptIn(), 6_000, {
    optIn: false,
    source: "unknown" as const,
  });

  const bridge = createBridge({ daemon, label, cwd, push: detection.optIn });
  process.stderr.write(
    `[${SERVER_NAME}] channel push ${detection.optIn ? "on" : "off"} (${detection.source})\n`,
  );
  await bridge.register();

  const transport = new StdioServerTransport();
  bridge.server.server.onclose = () => {
    bridge.stop();
    setTimeout(() => process.exit(0), 50).unref();
  };
  await bridge.connect(transport);
  void bridge.runReplyLoop();
}

const isDirectRun = process.argv[1] !== undefined && /mcp[\\/]server\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  void main();
}
