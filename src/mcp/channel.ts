import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Claude Code "channels" (research preview): an MCP server that declares the
 * `claude/channel` capability can push `notifications/claude/channel` events,
 * which Claude receives as a user turn — the only supported way for the daemon
 * to wake an idle session with the owner's Telegram reply instead of making the
 * agent block in `telegram_wait_reply`.
 *
 * Claude Code only honours those notifications for servers the user opted in
 * when starting the session:
 *
 *     claude --dangerously-load-development-channels server:telegram-bridge
 *
 * (`--channels` is reserved for Anthropic-allowlisted plugins during the
 * preview.) Notifications sent to a session that did NOT opt in are dropped
 * silently, with no error returned to the server — so the bridge must know
 * which mode it is in, or a reply could be pushed into the void. Claude Code
 * never tells the server; the one reliable signal is the parent process's own
 * command line, which this module reads once at startup.
 */

export const SERVER_NAME = "telegram-bridge";

const CHANNEL_FLAGS = new Set(["--channels", "--dangerously-load-development-channels"]);

/** Split a command line into arguments, honouring double and single quotes. */
export function tokenize(cmdline: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of cmdline) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Does this Claude Code command line opt `serverName` in as a channel?
 * Accepts `--flag a b c`, `--flag=a`, and both `name` and `server:name` forms.
 * Pure, so the parsing is unit-testable without a parent process.
 */
export function commandLineOptsIn(cmdline: string, serverName: string = SERVER_NAME): boolean {
  const args = tokenize(cmdline);
  const accepted = new Set([serverName, `server:${serverName}`]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!CHANNEL_FLAGS.has(flag)) continue;
    if (eq !== -1) {
      if (accepted.has(arg.slice(eq + 1))) return true;
      continue;
    }
    // Variadic: consume values up to the next option.
    for (let j = i + 1; j < args.length && !args[j]!.startsWith("-"); j++) {
      if (accepted.has(args[j]!)) return true;
    }
  }
  return false;
}

export interface ChannelDetection {
  optIn: boolean;
  /** Where the answer came from, for the log. */
  source: "env" | "parent" | "unknown";
  detail?: string;
}

/** Read the command line of the process that spawned us, best effort. */
export async function parentCommandLine(
  ppid: number = process.ppid,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${ppid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    }
    const [cmd, args] =
      process.platform === "win32"
        ? [
            "powershell",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId = ${ppid}").CommandLine`,
            ],
          ]
        : ["ps", ["-o", "command=", "-p", String(ppid)]];
    const out = await new Promise<string>((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      });
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether replies should be pushed into the session as channel events.
 * `TBM_CHANNEL=1|0` overrides detection (useful for tests and for launchers
 * that know what they started).
 */
export async function detectChannelOptIn(
  serverName: string = SERVER_NAME,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelDetection> {
  const override = (env.TBM_CHANNEL ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(override)) return { optIn: true, source: "env" };
  if (["0", "false", "off", "no"].includes(override)) return { optIn: false, source: "env" };

  const cmdline = await parentCommandLine();
  if (cmdline === null) return { optIn: false, source: "unknown" };
  return { optIn: commandLineOptsIn(cmdline, serverName), source: "parent", detail: cmdline.slice(0, 200) };
}
