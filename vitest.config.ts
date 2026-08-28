import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // The TDD-critical modules (security baseline §4.2). Their pure logic must
      // stay ≥90%. I/O glue (guardrails.ts writer, hook.ts main()) is excluded —
      // it is exercised by the real-process smoke tests instead.
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
