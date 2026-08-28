import { describe, it, expect } from "vitest";
import { parseNewArgs, isModelAlias, isSessionMode } from "./args.js";
import { RateLimiter } from "./ratelimit.js";

describe("parseNewArgs", () => {
  it("parses folder only", () => {
    expect(parseNewArgs(["Downloads"])).toEqual({ folder: "Downloads" });
  });

  it("parses folder + model + mode in order", () => {
    expect(parseNewArgs(["Downloads", "sonnet", "edit"])).toEqual({
      folder: "Downloads",
      model: "sonnet",
      mode: "edit",
    });
  });

  it("parses model and mode in any order before/after folder", () => {
    expect(parseNewArgs(["opus", "Desktop", "full"])).toEqual({
      folder: "Desktop",
      model: "opus",
      mode: "full",
    });
  });

  it("lowercases model and mode", () => {
    expect(parseNewArgs(["Docs", "HAIKU", "RO"])).toEqual({
      folder: "Docs",
      model: "haiku",
      mode: "ro",
    });
  });

  it("treats an unknown token as the folder and keeps the first one", () => {
    expect(parseNewArgs(["my-proj", "other"]).folder).toBe("my-proj");
  });

  it("ignores empty tokens", () => {
    expect(parseNewArgs(["", "  ", "Downloads"])).toEqual({ folder: "Downloads" });
  });
});

describe("alias guards", () => {
  it("recognizes model aliases", () => {
    expect(isModelAlias("opus")).toBe(true);
    expect(isModelAlias("gpt")).toBe(false);
  });
  it("recognizes session modes", () => {
    expect(isSessionMode("full")).toBe(true);
    expect(isSessionMode("nope")).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit within the window", () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(100)).toBe(true);
    expect(rl.allow(200)).toBe(true);
    expect(rl.allow(300)).toBe(false);
  });

  it("frees capacity as the window slides", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(500)).toBe(true);
    expect(rl.allow(600)).toBe(false);
    // After the first hit ages out (>1000ms later), capacity returns.
    expect(rl.allow(1100)).toBe(true);
  });
});
