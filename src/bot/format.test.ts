import { describe, it, expect } from "vitest";
import { chunkMessage, humanSize, escapeMarkdown, TELEGRAM_MAX } from "./format.js";

describe("chunkMessage", () => {
  it("returns empty array for empty string", () => {
    expect(chunkMessage("")).toEqual([]);
  });

  it("returns a single chunk when under the limit", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("keeps a message exactly at the limit as one chunk", () => {
    const text = "a".repeat(TELEGRAM_MAX);
    expect(chunkMessage(text)).toEqual([text]);
  });

  it("splits a message just over the limit into two chunks", () => {
    const text = "a".repeat(TELEGRAM_MAX + 100);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= TELEGRAM_MAX)).toBe(true);
    expect(chunks.join("").length).toBe(text.length);
  });

  it("prefers paragraph boundaries", () => {
    const para = "x".repeat(3000);
    const text = para + "\n\n" + para;
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para);
    expect(chunks[1]).toBe(para);
  });

  it("falls back to word boundaries", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkMessage(words);
    expect(chunks.every((c) => c.length <= TELEGRAM_MAX)).toBe(true);
    // No word should be split across a boundary.
    expect(chunks.some((c) => c.startsWith("ord"))).toBe(false);
  });

  it("hard-cuts a boundaryless blob and preserves length", () => {
    const text = "z".repeat(TELEGRAM_MAX * 2 + 7);
    const chunks = chunkMessage(text);
    expect(chunks.every((c) => c.length <= TELEGRAM_MAX)).toBe(true);
    expect(chunks.join("").length).toBe(text.length);
    expect(chunks.length).toBe(3);
  });

  it("respects a custom limit", () => {
    const chunks = chunkMessage("abcdefghij", 4);
    expect(chunks.every((c) => c.length <= 4)).toBe(true);
    expect(chunks.join("")).toBe("abcdefghij");
  });
});

describe("humanSize", () => {
  it("formats bytes", () => expect(humanSize(512)).toBe("512 B"));
  it("formats kilobytes", () => expect(humanSize(2048)).toBe("2.0 KB"));
  it("formats megabytes", () => expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB"));
});

describe("escapeMarkdown", () => {
  it("escapes markdown control chars", () => {
    expect(escapeMarkdown("a_b*c`d[e")).toBe("a\\_b\\*c\\`d\\[e");
  });
});
