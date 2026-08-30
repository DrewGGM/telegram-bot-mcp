import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IpcServer } from "./server.js";
import { IPC_TOKEN_HEADER, type BridgeTarget } from "./protocol.js";

/**
 * Integration test of the real loopback IPC server. Proves the two security
 * properties that matter most: (1) requests without a valid session token are
 * rejected, and (2) the destination is derived from the token — a caller can
 * never choose where a message goes (ADR-5).
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
  },
  async sendFile(target: BridgeTarget, filePath: string, caption?: string) {
    calls.push({ route: "send_file", target, arg: { filePath, caption } });
  },
  async askUser(target: BridgeTarget, question: string, options: string[]) {
    calls.push({ route: "ask_user", target, arg: { question, options } });
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

function post(route: string, token: string | undefined, body: unknown) {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { [IPC_TOKEN_HEADER]: token } : {}),
    },
    body: JSON.stringify(body),
  });
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
    expect(calls[0].target).toEqual({ chatId: 42, topicId: 7 });
    expect(calls[0].arg).toBe("hello");
  });

  it("passes send_file path and caption through", async () => {
    calls = [];
    const token = server.registerSession("s2", { chatId: 5 });
    const res = await post("/send_file", token, { path: "/a/b.pdf", caption: "cap" });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ route: "send_file", target: { chatId: 5 }, arg: { filePath: "/a/b.pdf", caption: "cap" } });
  });

  it("round-trips ask_user and returns the answer", async () => {
    const token = server.registerSession("s3", { chatId: 8 });
    const res = await post("/ask_user", token, { question: "Pick", options: ["A", "B"] });
    const json = (await res.json()) as { answer: string };
    expect(json.answer).toBe("A");
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
    server.registerPersistent("global", "fixed-token", () =>
      owner ? { chatId: owner } : undefined,
    );

    // Before ownership is claimed the daemon refuses rather than misrouting.
    const early = await post("/send_message", "fixed-token", { text: "too soon" });
    expect(early.status).toBe(409);
    expect(calls).toHaveLength(0);

    // Once claimed, the SAME token now routes to the owner.
    owner = 777;
    const later = await post("/send_message", "fixed-token", { text: "hi" });
    expect(later.status).toBe(200);
    expect(calls[0].target).toEqual({ chatId: 777 });
  });

  it("a persistent token still cannot choose its destination", async () => {
    calls = [];
    server.registerPersistent("global2", "tok2", () => ({ chatId: 11 }));
    await post("/send_message", "tok2", { text: "x", chatId: 999, topicId: 5 });
    expect(calls[0].target).toEqual({ chatId: 11 });
  });

  it("updateTarget changes where a live token delivers", async () => {
    calls = [];
    const token = server.registerSession("s5", { chatId: 10 });
    server.updateTarget("s5", { chatId: 20, topicId: 3 });
    await post("/send_message", token, { text: "y" });
    expect(calls[0].target).toEqual({ chatId: 20, topicId: 3 });
  });
});
