import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export interface PathCheck {
  allowed: boolean;
  /** Canonical absolute path (symlinks resolved as far as the deepest existing ancestor). */
  resolved: string;
  reason?: string;
}

/** Windows reserved device names — writing to e.g. `CON` or `NUL.txt` targets a device, not a file. */
const WINDOWS_DEVICES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

function normalizeForCompare(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve symlinks for the deepest ancestor of `p` that exists, then re-append
 * the non-existing tail. This prevents symlink/junction escapes for both
 * existing paths and paths about to be created.
 */
export function canonicalize(p: string): string {
  const absolute = path.resolve(p);
  let existing = absolute;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached filesystem root
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing;
  }
  return tail.length > 0 ? path.join(real, ...tail) : real;
}

/**
 * Core security check: is `target` inside one of `allowedDirs`?
 * Deny by default: empty allowlist means nothing is allowed.
 */
export function isPathAllowed(target: string, allowedDirs: readonly string[]): PathCheck {
  if (typeof target !== "string" || target.trim() === "") {
    return { allowed: false, resolved: "", reason: "empty path" };
  }

  // UNC / device-namespace paths are never allowed (\\server\share, \\.\pipe, \\?\...).
  if (/^[\\/]{2}/.test(target)) {
    return { allowed: false, resolved: target, reason: "UNC/device namespace path" };
  }

  if (WINDOWS_DEVICES.test(path.basename(target))) {
    return { allowed: false, resolved: target, reason: "Windows reserved device name" };
  }

  const resolved = canonicalize(target);
  const resolvedCmp = normalizeForCompare(resolved);

  for (const dir of allowedDirs) {
    const dirCanonical = canonicalize(dir);
    const dirCmp = normalizeForCompare(dirCanonical);
    if (resolvedCmp === dirCmp || resolvedCmp.startsWith(dirCmp + path.sep)) {
      return { allowed: true, resolved };
    }
  }
  return { allowed: false, resolved, reason: "outside the allowed directories" };
}
