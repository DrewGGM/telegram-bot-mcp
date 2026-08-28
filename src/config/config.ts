import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const SessionMode = z.enum(["ro", "edit", "full"]);
export type SessionMode = z.infer<typeof SessionMode>;

const ConfigSchema = z.object({
  /** Telegram user id of the single allowed user. 0 = not configured yet (bot refuses everything). */
  ownerId: z.number().int().default(0),
  /** Forum supergroup used for session topics. Optional until M2 setup is done. */
  groupId: z.number().int().optional(),
  /** Absolute directories the agent (and file commands) may touch. Everything else is denied. */
  allowedDirs: z.array(z.string().min(1)).default([]),
  defaultModel: z.string().default("sonnet"),
  defaultMode: SessionMode.default("ro"),
  /** cwd of the implicit "default" chat session. Must be inside allowedDirs. */
  defaultCwd: z.string().optional(),
  /** Kill an in-flight claude turn after this many minutes. */
  turnTimeoutMinutes: z.number().int().positive().default(15),
  /** Hibernate a session after this many idle minutes (FR-11). */
  hibernateAfterMinutes: z.number().int().positive().default(30),
  maxConcurrentSessions: z.number().int().positive().default(5),
  /** Path or name of the claude executable. */
  claudeBin: z.string().default("claude"),
  /** Incoming messages per minute accepted before throttling. */
  rateLimitPerMinute: z.number().int().positive().default(30),
});

export type Config = z.infer<typeof ConfigSchema>;

export const PROJECT_ROOT = path.resolve(path.join(import.meta.dirname, "..", ".."));
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");

export function loadConfig(): Config {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    const initial = ConfigSchema.parse({
      allowedDirs: [path.join(homedir(), "Downloads"), path.join(homedir(), "Desktop")],
    });
    saveConfig(initial);
    return initial;
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return ConfigSchema.parse(raw);
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function loadBotToken(): string {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error("BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
  }
  return token;
}
