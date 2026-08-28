/**
 * Hard deny-list for shell commands. This is the non-negotiable safety net that
 * applies to EVERY session, including `full` (bypassPermissions) mode: it runs
 * inside a Claude Code PreToolUse hook, outside the reach of the LLM.
 *
 * It is a net, not a sandbox: it blocks catastrophic command *classes*, while
 * path confinement is handled separately by the allowlist (paths.ts).
 */

export interface CommandCheck {
  allowed: boolean;
  /** Human-readable name of the rule that fired, when denied. */
  rule?: string;
}

interface DenyRule {
  name: string;
  pattern: RegExp;
}

const DENY_RULES: DenyRule[] = [
  { name: "disk destruction", pattern: /\b(format(\.com)?\s+[a-z]:|diskpart|mkfs(\.\w+)?|fdisk|dd\s+if=)/i },
  { name: "system power", pattern: /\b(shutdown(\.exe)?\b|restart-computer|stop-computer|reboot\b|logoff\b)/i },
  {
    name: "registry write",
    pattern: /\b(reg(\.exe)?\s+(add|delete|import)|regedit(\s|$)|(set|new|remove)-itemproperty\s+[^|]*hk(lm|cu|:))/i,
  },
  {
    name: "persistence (services/tasks)",
    pattern: /\b(schtasks\s+\/create|sc(\.exe)?\s+(create|config)|register-scheduledtask|new-service)\b/i,
  },
  { name: "boot/recovery tampering", pattern: /\b(bcdedit|vssadmin\s+delete|wbadmin\s+delete|cipher\s+\/w)/i },
  {
    name: "system dir modification",
    pattern:
      /\b(rm|del|erase|rmdir|rd|remove-item|move|mv|ren|rename|copy-item|takeown|icacls|attrib)\b[^|&;]*\\(windows|system32|program files( \(x86\))?)\\/i,
  },
  {
    name: "recursive delete at drive root",
    pattern: /\b(rm|del|erase|rmdir|rd|remove-item)\b[^|&;]*(\s|["'])([a-z]:[\\/]|[\\/])(\s|["']|\*|$|-)/i,
  },
  {
    name: "download-and-execute",
    pattern: /\b(iex\b|invoke-expression|powershell[^|]*-enc(odedcommand)?\b|(curl|wget|iwr|invoke-webrequest)[^|]*\|\s*(sh|bash|pwsh|powershell|iex|node|python))/i,
  },
  {
    name: "credential access",
    pattern:
      /\b(cmdkey|vaultcmd|mimikatz|lsass|procdump[^|]*lsass)\b|\\(credentials|login data|cookies)\b|dpapi(::|\s)/i,
  },
  { name: "firewall/defender tampering", pattern: /\b(netsh\s+(advfirewall|firewall)\s+(set|add|delete)|set-mppreference|add-mppreference|defender[^|]*-disable)/i },
  { name: "user/group manipulation", pattern: /\b(net\s+(user|localgroup)\b[^|&;]*(\/add|\/delete)|new-localuser|add-localgroupmember)\b/i },
  { name: "shutdown of this bridge", pattern: /\b(stop-process|taskkill)\b[^|&;]*(telegram-bot-mcp|tbm-daemon)/i },
];

export function checkCommand(command: string): CommandCheck {
  if (typeof command !== "string") return { allowed: false, rule: "non-string command" };
  for (const rule of DENY_RULES) {
    if (rule.pattern.test(command)) {
      return { allowed: false, rule: rule.name };
    }
  }
  return { allowed: true };
}

/** Exported for documentation generation and tests. */
export const denyRuleNames = DENY_RULES.map((r) => r.name);
