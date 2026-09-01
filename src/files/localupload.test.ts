import { describe, it, expect, vi, afterEach } from "vitest";
import { probeLocalServer, CLOUD_SEND_LIMIT, LOCAL_SEND_LIMIT } from "./localupload.js";

/**
 * The local Bot API server is an optional accelerator, never a dependency:
 * probing must fail closed (return false) so the caller degrades to compressing.
 */
afterEach(() => vi.unstubAllGlobals());

describe("limits", () => {
  it("local server raises the ceiling 40x", () => {
    expect(CLOUD_SEND_LIMIT).toBe(50 * 1024 * 1024);
    expect(LOCAL_SEND_LIMIT).toBe(2000 * 1024 * 1024);
    expect(LOCAL_SEND_LIMIT / CLOUD_SEND_LIMIT).toBe(40);
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
