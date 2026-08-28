/**
 * Parser for Claude Code's `--output-format stream-json` output (T1.2, ADR-1).
 *
 * The CLI emits newline-delimited JSON, one event per line:
 *   {"type":"system","subtype":"init","session_id":"…","model":"…"}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"},
 *                                              {"type":"tool_use","name":"Bash",…}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","is_error":false,…}]}}
 *   {"type":"result","subtype":"success","result":"…","session_id":"…",
 *                    "is_error":false,"duration_ms":1234,"total_cost_usd":0.01}
 *
 * This module isolates the daemon from that format (risk mitigation §2.4): it is
 * pure, total (never throws on garbage), and TDD-covered.
 */

export interface SystemEvent {
  type: "system";
  sessionId?: string;
  model?: string;
}
export interface AssistantTextEvent {
  type: "assistant_text";
  text: string;
}
export interface ToolUseEvent {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
  id: string;
}
export interface ToolResultEvent {
  type: "tool_result";
  isError: boolean;
}
export interface ResultEvent {
  type: "result";
  sessionId?: string;
  text: string;
  isError: boolean;
  durationMs?: number;
  costUsd?: number;
}
export type StreamEvent =
  | SystemEvent
  | AssistantTextEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent;

/** Parse one NDJSON line into zero or more normalized events. Never throws. */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof obj !== "object" || obj === null) return [];
  const rec = obj as Record<string, any>;

  switch (rec.type) {
    case "system":
      return [
        {
          type: "system",
          ...(typeof rec.session_id === "string" ? { sessionId: rec.session_id } : {}),
          ...(typeof rec.model === "string" ? { model: rec.model } : {}),
        },
      ];

    case "assistant": {
      const content = rec.message?.content;
      if (!Array.isArray(content)) return [];
      const out: StreamEvent[] = [];
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          out.push({ type: "assistant_text", text: block.text });
        } else if (block?.type === "tool_use") {
          out.push({
            type: "tool_use",
            name: typeof block.name === "string" ? block.name : "tool",
            input:
              block.input && typeof block.input === "object" ? block.input : {},
            id: typeof block.id === "string" ? block.id : "",
          });
        }
      }
      return out;
    }

    case "user": {
      const content = rec.message?.content;
      if (!Array.isArray(content)) return [];
      const out: StreamEvent[] = [];
      for (const block of content) {
        if (block?.type === "tool_result") {
          out.push({ type: "tool_result", isError: block.is_error === true });
        }
      }
      return out;
    }

    case "result": {
      const subtype = typeof rec.subtype === "string" ? rec.subtype : "";
      return [
        {
          type: "result",
          ...(typeof rec.session_id === "string" ? { sessionId: rec.session_id } : {}),
          text: typeof rec.result === "string" ? rec.result : "",
          isError: rec.is_error === true || subtype.startsWith("error"),
          ...(typeof rec.duration_ms === "number" ? { durationMs: rec.duration_ms } : {}),
          ...(typeof rec.total_cost_usd === "number" ? { costUsd: rec.total_cost_usd } : {}),
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Stateful splitter for a byte stream that arrives in arbitrary chunks. `push`
 * returns complete lines seen so far; `flush` yields any trailing partial line
 * once the stream ends.
 */
export function createLineSplitter() {
  let buffer = "";
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines;
    },
    flush(): string[] {
      const rest = buffer.trim();
      buffer = "";
      return rest ? [rest] : [];
    },
  };
}

/** One-line human summary of a tool_use event, for display in a topic. */
export function summarizeToolUse(ev: ToolUseEvent): string {
  const input = ev.input;
  const detail =
    (typeof input.command === "string" && input.command) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.pattern === "string" && input.pattern) ||
    "";
  const shortDetail = detail.length > 120 ? detail.slice(0, 117) + "…" : detail;
  return shortDetail ? `🔧 ${ev.name}: ${shortDetail}` : `🔧 ${ev.name}`;
}
