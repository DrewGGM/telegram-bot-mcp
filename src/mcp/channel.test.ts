import { describe, it, expect } from "vitest";
import { commandLineOptsIn, detectChannelOptIn, parentCommandLine, tokenize } from "./channel.js";

/**
 * Whether the bridge may push replies into its Claude Code session is decided
 * from the parent process's command line. Getting it wrong either loses a
 * reply (pushed into a session that never opted in) or leaves it unread, so
 * the parsing is pinned down here.
 */
describe("tokenize", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(tokenize('"C:\\Program Files\\claude.exe" --channels "server:telegram-bridge" -p')).toEqual([
      "C:\\Program Files\\claude.exe",
      "--channels",
      "server:telegram-bridge",
      "-p",
    ]);
    expect(tokenize("a  'b c'   d")).toEqual(["a", "b c", "d"]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("commandLineOptsIn", () => {
  it("accepts the development flag with the server: form", () => {
    expect(commandLineOptsIn("claude --dangerously-load-development-channels server:telegram-bridge")).toBe(
      true,
    );
  });

  it("accepts the bare name on --channels", () => {
    expect(commandLineOptsIn("claude --channels telegram-bridge")).toBe(true);
  });

  it("accepts the = form and several values", () => {
    expect(commandLineOptsIn("claude --channels=telegram-bridge")).toBe(true);
    expect(
      commandLineOptsIn("claude --channels plugin:fakechat@official server:telegram-bridge --model opus"),
    ).toBe(true);
  });

  it("stops collecting values at the next option", () => {
    expect(commandLineOptsIn("claude --channels plugin:x --add-dir telegram-bridge")).toBe(false);
  });

  it("ignores other servers and unrelated command lines", () => {
    expect(commandLineOptsIn("claude --channels server:other-bridge")).toBe(false);
    expect(commandLineOptsIn('claude -p "mention telegram-bridge in the prompt"')).toBe(false);
    expect(commandLineOptsIn('"C:\\Users\\me\\.local\\bin\\claude.exe" --resume abc')).toBe(false);
    expect(commandLineOptsIn("")).toBe(false);
  });

  it("handles a quoted Windows command line", () => {
    expect(
      commandLineOptsIn(
        '"C:\\Users\\me\\.local\\bin\\claude.exe" --dangerously-load-development-channels "server:telegram-bridge"',
      ),
    ).toBe(true);
  });

  it("matches a custom server name", () => {
    expect(commandLineOptsIn("claude --channels server:tg", "tg")).toBe(true);
    expect(commandLineOptsIn("claude --channels server:telegram-bridge", "tg")).toBe(false);
  });
});

describe("detectChannelOptIn", () => {
  it("honours the TBM_CHANNEL override without touching the parent process", async () => {
    await expect(detectChannelOptIn("telegram-bridge", { TBM_CHANNEL: "1" })).resolves.toEqual({
      optIn: true,
      source: "env",
    });
    await expect(detectChannelOptIn("telegram-bridge", { TBM_CHANNEL: "0" })).resolves.toEqual({
      optIn: false,
      source: "env",
    });
    await expect(detectChannelOptIn("telegram-bridge", { TBM_CHANNEL: "off" })).resolves.toMatchObject({
      optIn: false,
    });
  });

  it("falls back to the parent process, which is not a channel-enabled claude here", async () => {
    const res = await detectChannelOptIn("telegram-bridge", {});
    expect(res.optIn).toBe(false);
    expect(["parent", "unknown"]).toContain(res.source);
  }, 15_000);
});

describe("commandLineOptsIn edge cases", () => {
  it("ignores an = form naming a different server", () => {
    expect(commandLineOptsIn("claude --channels=server:other --model opus")).toBe(false);
  });

  it("treats a flag with no values as no opt-in", () => {
    expect(commandLineOptsIn("claude --channels --model opus")).toBe(false);
  });
});

describe("parentCommandLine", () => {
  it("resolves to null for a process that does not exist", async () => {
    await expect(parentCommandLine(2147483646, 8000)).resolves.toBeNull();
  }, 15_000);
});
