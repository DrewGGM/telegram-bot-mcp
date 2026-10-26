import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests must never touch the real daemon's state: a `/config add` test once
// overwrote the live config.json. Every run gets a scratch data dir and config
// path; subprocesses spawned by tests inherit them through process.env.
const scratch = mkdtempSync(path.join(tmpdir(), "tbm-test-"));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: {
      TBM_DATA_DIR: scratch,
      TBM_CONFIG_PATH: path.join(scratch, "config.json"),
    },
    coverage: {
      provider: "v8",
      // The TDD-critical modules (security baseline §4.2) plus the pure routing
      // logic of the bridge. Their logic must stay ≥90%. I/O glue (guardrails.ts
      // writer, the daemon entrypoint) is excluded — it is exercised by the
      // real-process smoke tests instead.
      include: [
        "src/security/paths.ts",
        "src/security/commands.ts",
        "src/security/hook.ts",
        "src/bot/auth.ts",
        "src/bot/format.ts",
        "src/bot/args.ts",
        "src/bot/pending.ts",
        "src/sessions/stream.ts",
        "src/sessions/cli.ts",
        "src/sessions/store.ts",
        "src/files/files.ts",
        "src/ipc/instances.ts",
        "src/mcp/replies.ts",
        "src/mcp/channel.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
