import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { InputFile } from "grammy";
import {
  probeLocalServer,
  callLocalApi,
  hasInputFile,
  localFirstTransformer,
  forgetLocalServerAvailability,
  LOCAL_SEND_LIMIT,
} from "./localApi.js";
import { TELEGRAM_SEND_LIMIT } from "../files/files.js";

/**
 * The local Bot API server is an optional accelerator, never a dependency:
 * probing must fail closed (return false) so the caller degrades to the cloud
 * API, and every routed call must fall back there when the server vanishes.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  forgetLocalServerAvailability();
});

describe("limits", () => {
  it("local server raises the ceiling 40x", () => {
    expect(TELEGRAM_SEND_LIMIT).toBe(50 * 1024 * 1024);
    expect(LOCAL_SEND_LIMIT).toBe(2000 * 1024 * 1024);
    expect(LOCAL_SEND_LIMIT / TELEGRAM_SEND_LIMIT).toBe(40);
  });
});

describe("probeLocalServer", () => {
  it("reports available when the server answers ok", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(probeLocalServer("http://127.0.0.1:8081", "t")).resolves.toBe(true);
  });

  it("reports unavailable when the server is not running", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(probeLocalServer("http://127.0.0.1:8081", "t")).resolves.toBe(false);
  });

  it("reports unavailable on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 502 }));
    await expect(probeLocalServer("http://127.0.0.1:8081", "t")).resolves.toBe(false);
  });

  it("reports unavailable when something else answers on the port", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: false }), { status: 200 }));
    await expect(probeLocalServer("http://127.0.0.1:8081", "t")).resolves.toBe(false);
  });

  it("reports unavailable on malformed JSON rather than throwing", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    await expect(probeLocalServer("http://127.0.0.1:8081", "t")).resolves.toBe(false);
  });
});

describe("hasInputFile", () => {
  it("finds a file at the top level and nested in media groups", () => {
    expect(hasInputFile({ chat_id: 1, document: new InputFile(Buffer.from("x")) })).toBe(true);
    expect(hasInputFile({ media: [{ type: "document", media: new InputFile(Buffer.from("x")) }] })).toBe(
      true,
    );
  });

  it("is false for plain JSON payloads", () => {
    expect(hasInputFile({ chat_id: 1, text: "hi", reply_markup: { inline_keyboard: [] } })).toBe(false);
    expect(hasInputFile(null)).toBe(false);
    expect(hasInputFile("x")).toBe(false);
  });
});

describe("localFirstTransformer", () => {
  // A fake local Bot API server that records every call and can play dead.
  let server: Server;
  let apiRoot: string;
  let calls: { method: string; body: Record<string, unknown> }[] = [];
  let healthy = true;
  const token = "T";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (!healthy) {
          res.destroy();
          return;
        }
        const method = req.url!.split("/").pop()!;
        calls.push({ method, body: raw ? JSON.parse(raw) : {} });
        const reply =
          method === "getMe"
            ? { ok: true, result: { id: 1, is_bot: true, first_name: "t" } }
            : method === "sendMessage"
              ? { ok: true, result: { message_id: 77 } }
              : { ok: false, error_code: 400, description: "Bad Request: nope" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    apiRoot = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    calls = [];
    healthy = true;
    forgetLocalServerAvailability();
  });

  const cloud = () => vi.fn(async () => ({ ok: true, result: { message_id: 1 } }));
  const transformer = (root = () => apiRoot) => localFirstTransformer({ getApiRoot: root, token });

  it("routes a JSON method through the local server when it is up", async () => {
    const prev = cloud();
    const out = await transformer()(prev as any, "sendMessage", { chat_id: 5, text: "hi" });
    expect(out).toEqual({ ok: true, result: { message_id: 77 } });
    expect(prev).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["getMe", "sendMessage"]);
    expect(calls[1]!.body).toEqual({ chat_id: 5, text: "hi" });
  });

  it("falls back to the cloud when the local server is down", async () => {
    healthy = false;
    const prev = cloud();
    const out = await transformer()(prev as any, "sendMessage", { chat_id: 5, text: "hi" });
    expect(prev).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ok: true, result: { message_id: 1 } });
  });

  it("falls back and forgets the cached availability when the server dies mid-session", async () => {
    const prev = cloud();
    const t = transformer();
    await t(prev as any, "sendMessage", { chat_id: 5, text: "one" });
    expect(prev).not.toHaveBeenCalled();
    healthy = false;
    await t(prev as any, "sendMessage", { chat_id: 5, text: "two" });
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it("keeps cloud-only methods on the cloud", async () => {
    const prev = cloud();
    await transformer()(prev as any, "getUpdates", { timeout: 30 });
    await transformer()(prev as any, "getFile", { file_id: "x" });
    expect(prev).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(0);
  });

  it("keeps uploads on the cloud path (they need multipart, handled elsewhere)", async () => {
    const prev = cloud();
    await transformer()(prev as any, "sendDocument", {
      chat_id: 1,
      document: new InputFile(Buffer.from("x")),
    });
    expect(prev).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("returns an API-level error from the local server as-is instead of retrying on the cloud", async () => {
    const prev = cloud();
    const out = (await transformer()(prev as any, "sendChatAction", { chat_id: 1, action: "typing" })) as any;
    expect(out.ok).toBe(false);
    expect(out.description).toBe("Bad Request: nope");
    expect(prev).not.toHaveBeenCalled();
  });

  it("is a no-op without a configured apiRoot", async () => {
    const prev = cloud();
    await transformer(() => "")(prev as any, "sendMessage", { chat_id: 5, text: "hi" });
    expect(prev).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("callLocalApi distinguishes a transport failure from an API error", async () => {
    const apiErr = await callLocalApi(apiRoot, token, "sendChatAction", {});
    expect(apiErr.ok).toBe(false);
    expect(apiErr.transportError).toBeUndefined();
    healthy = false;
    const down = await callLocalApi(apiRoot, token, "sendMessage", {});
    expect(down.ok).toBe(false);
    expect(down.transportError).toBe(true);
  });
});
