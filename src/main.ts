import "dotenv/config";
import { loadConfig, loadBotToken, type Config } from "./config/config.js";
import { SessionStore } from "./sessions/store.js";
import { SessionManager } from "./sessions/manager.js";
import { PendingQuestions } from "./bot/pending.js";
import { IpcServer } from "./ipc/server.js";
import { loadOrCreateGlobalToken } from "./ipc/globalToken.js";
import { writeGuardrails } from "./security/guardrails.js";
import { createBot } from "./bot/bot.js";
import type { TelegramBridge } from "./ipc/protocol.js";
import { audit } from "./audit/audit.js";
import { log } from "./logger.js";

/**
 * Daemon entrypoint. Wires the modules, starts the loopback IPC server, long-
 * polls Telegram (ADR-2, no inbound ports), and runs the hibernation sweep
 * (FR-11). A late-bound bridge reference breaks the ipc↔bot↔manager cycle.
 */
async function main(): Promise<void> {
  let config: Config = loadConfig();
  const getConfig = (): Config => config;
  const setConfig = (c: Config): void => {
    config = c;
  };
  const token = loadBotToken();

  const store = new SessionStore();
  const pending = new PendingQuestions();

  // The real bridge is created with the bot; the IPC server calls through a
  // late-bound reference so we can construct everything in a valid order.
  let bridge: TelegramBridge | null = null;
  const ipc = new IpcServer({
    sendMessage: (t, x) => bridge!.sendMessage(t, x),
    sendFile: (t, p, c) => bridge!.sendFile(t, p, c),
    askUser: (t, q, o) => bridge!.askUser(t, q, o),
  });
  await ipc.listen(config.ipcPort);

  // Desktop registration (FR-19): a stable token whose destination resolves to
  // the owner's private chat at request time, so any Claude Code session on this
  // machine can notify you once registered — and it keeps working after restarts.
  const globalToken = loadOrCreateGlobalToken();
  ipc.registerPersistent("global", globalToken, () =>
    getConfig().ownerId ? { chatId: getConfig().ownerId } : undefined,
  );

  const guardrailsPath = writeGuardrails();
  log.info({ guardrailsPath }, "guardrails written");

  const manager = new SessionManager(store, getConfig, guardrailsPath, ipc);

  const startedAt = Date.now();
  const { bot, bridge: realBridge } = createBot({
    token,
    getConfig,
    setConfig,
    store,
    manager,
    pending,
    startedAt,
    instances: ipc.instances,
  });
  bridge = realBridge;

  // Hibernation sweep (FR-11): mark idle sessions dormant; they resume on the
  // next message via --resume. Default sessions are kept.
  const sweep = setInterval(() => {
    const stale = store.staleSessions(getConfig().hibernateAfterMinutes).filter((s) => !s.isDefault);
    for (const s of stale) {
      store.update(s.id, { state: "hibernated" });
      audit({ kind: "session.hibernated", sessionId: s.id });
    }
    // Forget foreign sessions that have gone quiet for an hour.
    ipc.instances.prune(60 * 60_000);
  }, 60_000);
  sweep.unref?.();

  // Cosmetic and best-effort: at logon the network is often not up yet, and a
  // failure here must never stop the bridge from starting. grammY's polling
  // reconnects on its own, so we just retry the menu in the background.
  const publishCommands = async (): Promise<void> => {
    await bot.api.setMyCommands([
    { command: "status", description: "Sessions, uptime, config" },
    { command: "new", description: "New session: /new <folder> [model] [mode]" },
    { command: "sessions", description: "List sessions" },
    { command: "kill", description: "End a session: /kill <id>" },
    { command: "info", description: "This topic's session details" },
    { command: "model", description: "Set default model" },
    { command: "ls", description: "List a folder" },
    { command: "find", description: "Search files by name" },
    { command: "get", description: "Send a file here: /get <path>" },
    { command: "config", description: "Manage folders & defaults" },
    { command: "setgroup", description: "Register this forum group" },
    { command: "panic", description: "Kill everything and lock" },
    { command: "unlock", description: "Resume after /panic" },
    { command: "help", description: "Show help" },
    ]);
  };
  void retryForever(publishCommands, "setMyCommands");

  const shutdown = async (sig: string): Promise<void> => {
    log.info({ sig }, "shutting down");
    clearInterval(sweep);
    manager.killAll();
    await ipc.close();
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Boot smoke test hook: if set, shut down cleanly after N ms (used by CI to
  // verify the daemon connects and long-polls without leaving a process behind).
  const smokeMs = Number(process.env.TBM_SMOKE_EXIT_MS);
  if (Number.isFinite(smokeMs) && smokeMs > 0) {
    setTimeout(() => void shutdown("SMOKE"), smokeMs);
  }

  log.info(
    { owner: config.ownerId || "UNCLAIMED (send /start to claim)", allowed: config.allowedDirs, ipcPort: config.ipcPort },
    "bridge starting (long polling)",
  );

  // bot.init() is the getMe handshake. At logon the network is frequently not
  // ready yet, so retry it instead of dying — this is what makes the daemon
  // survive a reboot unattended. bot.start() then reuses the initialized state.
  await retryForever(() => bot.init(), "telegram handshake");

  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => log.info({ bot: info.username }, "long polling started"),
  });
}

/**
 * Retry a non-critical startup task with backoff, forever. Used for cosmetics
 * (the command menu) that must never prevent the bridge from coming up when the
 * network is still settling after a reboot.
 */
async function retryForever(fn: () => Promise<void>, label: string): Promise<void> {
  let delay = 5_000;
  for (;;) {
    try {
      await fn();
      log.info({ task: label }, "startup task completed");
      return;
    } catch (err) {
      log.warn({ task: label, err: String(err), retryInMs: delay }, "startup task failed, will retry");
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5 * 60_000);
    }
  }
}

main().catch((err) => {
  // Exit non-zero so the supervisor (scripts/tbm-run.cmd) restarts us.
  log.error({ err }, "fatal");
  process.exit(1);
});
