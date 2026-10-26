import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { IpcServer } from "./server.js";
import { ASK_TIMEOUT_ANSWER, IPC_TOKEN_HEADER, type BridgeTarget } from "./protocol.js";

/**
 * Integration test of the real loopback IPC server. Proves the two security
 * properties that matter most: (1) requests without a valid session token are
 * rejected, and (2) the destination is derived from the token — a caller can
 * never choose where a message goes (ADR-5). Then the reply plumbing a bridge
 * process relies on: registration, presence, and long-polling.
 */

interface Call {
  route: string;
  target: BridgeTarget;
  arg: unknown;
}

let calls: Call[] = [];
let server: IpcServer;
let url: string;

const fakeBridge = {
  async sendMessage(target: BridgeTarget, text: string) {
    calls.push({ route: "send_message", target, arg: text });
    return 4242;
  },
  async sendFile(target: BridgeTarget, filePath: string, caption?: string) {
    calls.push({ route: "send_file", target, arg: { filePath, caption } });
    return { ok: true, messageId: 4243 };
  },
  async askUser(target: BridgeTarget, question: string, options: string[]) {
    calls.push({ route: "ask_user", target, arg: { question, options } });
    if (question.includes("silence")) return ASK_TIMEOUT_ANSWER;
    return options[0] ?? "";
  },
};

beforeAll(async () => {
  server = new IpcServer(fakeBridge);
  await server.listen();
  url = server.url;
});
afterAll(async () => {
  await server.close();
});

function post(route: string, token: string | undefined, body: unknown, signal?: AbortSignal) {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { [IPC_TOKEN_HEADER]: token } : {}),
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

async function register(token: string, label = "proj", push = false): Promise<string> {
  const res = await post("/register", token, { label, cwd: "/p", push });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { instanceId: string };
  return json.instanceId;
}

describe("IpcServer", () => {
  it("binds to loopback only", () => {
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("rejects requests without a token (403)", async () => {
    const res = await post("/send_message", undefined, { text: "hi" });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown token (403)", async () => {
    const res = await post("/send_message", "deadbeef", { text: "hi" });
    expect(res.status).toBe(403);
  });

  it("routes send_message to the token's fixed destination", async () => {
    calls = [];
    const token = server.registerSession("s1", { chatId: 42, topicId: 7 });
    // Note: the body carries NO chat id — the server injects the destination.
    const res = await post("/send_message", token, { text: "hello", chatId: 999 });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toEqual({ chatId: 42, topicId: 7 });
    expect(calls[0]!.arg).toBe("hello");
  });

  it("passes send_file path and caption through", async () => {
    calls = [];
    const token = server.registerSession("s2", { chatId: 5 });
    const res = await post("/send_file", token, { path: "/a/b.pdf", caption: "cap" });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      route: "send_file",
      target: { chatId: 5 },
      arg: { filePath: "/a/b.pdf", caption: "cap" },
    });
  });

  it("round-trips ask_user and returns the answer", async () => {
    const token = server.registerSession("s3", { chatId: 8 });
    const res = await post("/ask_user", token, { question: "Pick", options: ["A", "B"] });
    const json = (await res.json()) as { answer: string; timedOut: boolean };
    expect(json).toEqual({ answer: "A", timedOut: false });
  });

  it("reports an unanswered question as timedOut instead of leaking a sentinel", async () => {
    const token = server.registerSession("s3b", { chatId: 8 });
    const res = await post("/ask_user", token, { question: "silence please", options: ["A"] });
    const json = (await res.json()) as { answer: string | null; timedOut: boolean };
    expect(json).toEqual({ answer: null, timedOut: true });
  });

  it("stops routing after a session is revoked", async () => {
    const token = server.registerSession("s4", { chatId: 1 });
    server.revokeSession("s4");
    const res = await post("/send_message", token, { text: "x" });
    expect(res.status).toBe(403);
  });

  it("a persistent token resolves its destination per request (FR-19)", async () => {
    calls = [];
    let owner: number | undefined = undefined;
    server.registerPersistent("global", "fixed-token", () => (owner ? { chatId: owner } : undefined));

    // Before ownership is claimed the daemon refuses rather than misrouting.
    const early = await post("/send_message", "fixed-token", { text: "too soon" });
    expect(early.status).toBe(409);
    expect(calls).toHaveLength(0);

    // Once claimed, the SAME token now routes to the owner.
    owner = 777;
    const later = await post("/send_message", "fixed-token", { text: "hi" });
    expect(later.status).toBe(200);
    expect(calls[0]!.target).toEqual({ chatId: 777 });
  });

  it("a persistent token still cannot choose its destination", async () => {
    calls = [];
    server.registerPersistent("global2", "tok2", () => ({ chatId: 11 }));
    await post("/send_message", "tok2", { text: "x", chatId: 999, topicId: 5 });
    expect(calls[0]!.target).toEqual({ chatId: 11 });
  });
});

describe("bridge instances over IPC", () => {
  it("/register mints an id the caller cannot choose and records push mode", async () => {
    const token = server.registerSession("s-reg", { chatId: 1 });
    const res = await post("/register", token, { label: "proj", cwd: "/p", push: true, instanceId: "mine" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { instanceId: string; label: string };
    expect(json.instanceId).toMatch(/^[0-9a-f]{24}$/);
    expect(json.label).toBe("proj");
    expect(server.instances.peek(json.instanceId)).toMatchObject({ push: true, sessionId: "s-reg" });
  });

  it("messages from a registered instance are labelled and claimable for replies", async () => {
    calls = [];
    const token = server.registerSession("s-lab", { chatId: 1 });
    const id = await register(token, "fineract");
    await post("/send_message", token, { text: "build done", instanceId: id });
    expect(calls[0]!.arg).toBe("[fineract] build done");
    expect(server.instances.ownerOfMessage(4242)?.id).toBe(id);
  });

  it("/presence updates the waiting flag", async () => {
    const token = server.registerSession("s-pres", { chatId: 1 });
    const id = await register(token);
    const res = await post("/presence", token, { instanceId: id, waiting: true });
    expect(res.status).toBe(200);
    expect(server.instances.peek(id)!.waiting).toBe(true);
    await post("/presence", token, { instanceId: id, waiting: false });
    expect(server.instances.peek(id)!.waiting).toBe(false);
  });

  it("/wait_reply hands over a reply delivered meanwhile", async () => {
    const token = server.registerSession("s-wait", { chatId: 1 });
    const id = await register(token);
    const pending = post("/wait_reply", token, { instanceId: id, timeoutMs: 5000 });
    await vi.waitFor(() => expect(server.instances.peek(id)!.waiters).toHaveLength(1));
    server.instances.deliver(id, "yes");
    const json = (await (await pending).json()) as { reply: string | null; timedOut: boolean };
    expect(json).toEqual({ reply: "yes", timedOut: false });
  });

  it("/wait_reply times out cleanly", async () => {
    const token = server.registerSession("s-to", { chatId: 1 });
    const id = await register(token);
    const res = await post("/wait_reply", token, { instanceId: id, timeoutMs: 1 }); // clamped to 1 s
    const json = (await res.json()) as { reply: string | null; timedOut: boolean };
    expect(json).toEqual({ reply: null, timedOut: true });
  });

  it("a poll the bridge hung up on does not swallow the reply", async () => {
    const token = server.registerSession("s-hang", { chatId: 1 });
    const id = await register(token);
    const hangup = new AbortController();
    const pending = post("/wait_reply", token, { instanceId: id, timeoutMs: 5000 }, hangup.signal);
    await vi.waitFor(() => expect(server.instances.peek(id)!.waiters).toHaveLength(1));
    hangup.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(server.instances.peek(id)!.waiters).toHaveLength(0));
    server.instances.deliver(id, "still here");
    expect(server.instances.peek(id)!.inbox).toEqual(["still here"]);
  });

  it("/wait_reply and /presence refuse an unknown instance (404)", async () => {
    const token = server.registerSession("s-unk", { chatId: 1 });
    expect((await post("/wait_reply", token, { instanceId: "nope" })).status).toBe(404);
    expect((await post("/presence", token, { instanceId: "nope", waiting: true })).status).toBe(404);
  });

  it("revoking a per-turn session forgets its instances; the desktop one survives", async () => {
    const token = server.registerSession("s-rev", { chatId: 1 });
    const turnId = await register(token, "turn");
    server.registerPersistent("global", "tok-global", () => ({ chatId: 1 }));
    const deskId = await register("tok-global", "desk");
    server.revokeSession("s-rev");
    expect(server.instances.peek(turnId)).toBeUndefined();
    expect(server.instances.peek(deskId)).toBeDefined();
  });
});
