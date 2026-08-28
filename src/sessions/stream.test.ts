import { describe, it, expect } from "vitest";
import {
  parseStreamLine,
  createLineSplitter,
  summarizeToolUse,
  type ResultEvent,
  type ToolUseEvent,
} from "./stream.js";

describe("parseStreamLine", () => {
  it("ignores blank lines", () => {
    expect(parseStreamLine("")).toEqual([]);
    expect(parseStreamLine("   ")).toEqual([]);
  });

  it("ignores malformed JSON without throwing", () => {
    expect(parseStreamLine("{not json")).toEqual([]);
    expect(parseStreamLine("null")).toEqual([]);
    expect(parseStreamLine("42")).toEqual([]);
  });

  it("parses a system init event with session id and model", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-sonnet-4-5",
    });
    expect(parseStreamLine(line)).toEqual([
      { type: "system", sessionId: "abc-123", model: "claude-sonnet-4-5" },
    ]);
  });

  it("extracts assistant text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello there" }] },
    });
    expect(parseStreamLine(line)).toEqual([{ type: "assistant_text", text: "Hello there" }]);
  });

  it("extracts multiple blocks including a tool_use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "assistant_text", text: "Let me check" });
    expect(events[1]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
  });

  it("parses tool_result from a user event", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] },
    });
    expect(parseStreamLine(line)).toEqual([{ type: "tool_result", isError: true }]);
  });

  it("parses a successful result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Done.",
      session_id: "abc-123",
      is_error: false,
      duration_ms: 1500,
      total_cost_usd: 0.02,
    });
    const [ev] = parseStreamLine(line) as [ResultEvent];
    expect(ev.type).toBe("result");
    expect(ev.text).toBe("Done.");
    expect(ev.isError).toBe(false);
    expect(ev.durationMs).toBe(1500);
    expect(ev.costUsd).toBe(0.02);
  });

  it("marks a result with an error subtype as an error", () => {
    const line = JSON.stringify({ type: "result", subtype: "error_max_turns" });
    const [ev] = parseStreamLine(line) as [ResultEvent];
    expect(ev.isError).toBe(true);
  });

  it("ignores unknown event types", () => {
    expect(parseStreamLine(JSON.stringify({ type: "mystery" }))).toEqual([]);
  });
});

describe("createLineSplitter", () => {
  it("reassembles lines across chunk boundaries", () => {
    const s = createLineSplitter();
    expect(s.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(s.push('2}\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual([]);
  });

  it("flushes a trailing partial line", () => {
    const s = createLineSplitter();
    expect(s.push("partial")).toEqual([]);
    expect(s.flush()).toEqual(["partial"]);
  });

  it("handles a full end-to-end stream", () => {
    const s = createLineSplitter();
    const events = [];
    const stream =
      JSON.stringify({ type: "system", session_id: "s1" }) +
      "\n" +
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }) +
      "\n" +
      JSON.stringify({ type: "result", result: "hi", is_error: false });
    // Feed it in awkward 10-char slices.
    for (let i = 0; i < stream.length; i += 10) {
      for (const line of s.push(stream.slice(i, i + 10))) {
        events.push(...parseStreamLine(line));
      }
    }
    for (const line of s.flush()) events.push(...parseStreamLine(line));
    expect(events.map((e) => e.type)).toEqual(["system", "assistant_text", "result"]);
  });
});

describe("summarizeToolUse", () => {
  it("summarizes a Bash command", () => {
    const ev: ToolUseEvent = { type: "tool_use", id: "1", name: "Bash", input: { command: "ls -la" } };
    expect(summarizeToolUse(ev)).toBe("🔧 Bash: ls -la");
  });

  it("uses file_path when present", () => {
    const ev: ToolUseEvent = { type: "tool_use", id: "1", name: "Edit", input: { file_path: "a.ts" } };
    expect(summarizeToolUse(ev)).toBe("🔧 Edit: a.ts");
  });

  it("truncates long details", () => {
    const ev: ToolUseEvent = { type: "tool_use", id: "1", name: "Bash", input: { command: "x".repeat(200) } };
    expect(summarizeToolUse(ev).length).toBeLessThan(130);
    expect(summarizeToolUse(ev).endsWith("…")).toBe(true);
  });

  it("handles a tool with no recognizable detail", () => {
    const ev: ToolUseEvent = { type: "tool_use", id: "1", name: "TodoWrite", input: {} };
    expect(summarizeToolUse(ev)).toBe("🔧 TodoWrite");
  });
});
