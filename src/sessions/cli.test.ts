import { describe, it, expect } from "vitest";
import { buildClaudeArgs, modeToPermission } from "./cli.js";

describe("modeToPermission", () => {
  it("maps ro to plan", () => expect(modeToPermission("ro")).toBe("plan"));
  it("maps edit to acceptEdits", () => expect(modeToPermission("edit")).toBe("acceptEdits"));
  it("maps full to bypassPermissions", () => expect(modeToPermission("full")).toBe("bypassPermissions"));
});

describe("buildClaudeArgs", () => {
  const base = {
    claudeSessionId: "uuid-1",
    model: "sonnet",
    mode: "ro" as const,
    addDirs: ["/a", "/b"],
  };

  it("always requests stream-json with --verbose (CLI requires it)", () => {
    const args = buildClaudeArgs({ ...base, firstTurn: true });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("-p");
  });

  it("uses --session-id on the first turn", () => {
    const args = buildClaudeArgs({ ...base, firstTurn: true });
    expect(args).toContain("--session-id");
    expect(args).toContain("uuid-1");
    expect(args).not.toContain("--resume");
  });

  it("uses --resume on later turns", () => {
    const args = buildClaudeArgs({ ...base, firstTurn: false });
    expect(args).toContain("--resume");
    expect(args).toContain("uuid-1");
    expect(args).not.toContain("--session-id");
  });

  it("passes model and mapped permission mode", () => {
    const args = buildClaudeArgs({ ...base, mode: "full", firstTurn: true });
    const i = args.indexOf("--permission-mode");
    expect(args[i + 1]).toBe("bypassPermissions");
    const m = args.indexOf("--model");
    expect(args[m + 1]).toBe("sonnet");
  });

  it("includes each allowed dir with --add-dir", () => {
    const args = buildClaudeArgs({ ...base, firstTurn: true });
    const dirs = args.filter((_, i) => args[i - 1] === "--add-dir");
    expect(dirs).toEqual(["/a", "/b"]);
  });

  it("injects settings and strict mcp-config when provided", () => {
    const args = buildClaudeArgs({
      ...base,
      firstTurn: true,
      settingsPath: "/g.json",
      mcpConfigPath: "/m.json",
    });
    expect(args[args.indexOf("--settings") + 1]).toBe("/g.json");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/m.json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("omits settings/mcp flags when not provided", () => {
    const args = buildClaudeArgs({ ...base, firstTurn: true });
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--mcp-config");
  });
});
