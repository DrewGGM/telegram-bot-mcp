/**
 * Telegram message formatting helpers. Telegram caps a single text message at
 * 4096 UTF-16 code units (FR-6), so long agent turns must be split. We split on
 * paragraph/line/word boundaries when possible and hard-cut only as a last
 * resort, so code blocks and prose stay readable across parts.
 */

export const TELEGRAM_MAX = 4096;

/** Split `text` into chunks each within `limit` code units, preferring clean boundaries. */
export function chunkMessage(text: string, limit: number = TELEGRAM_MAX): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = findBoundary(rest, limit);
    // Guarantee forward progress even with no boundary and no whitespace.
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

/** Find the best break point at or before `limit`: paragraph > newline > space. */
function findBoundary(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const para = window.lastIndexOf("\n\n");
  if (para > limit * 0.5) return para;
  const line = window.lastIndexOf("\n");
  if (line > limit * 0.5) return line;
  const space = window.lastIndexOf(" ");
  if (space > limit * 0.5) return space;
  return limit;
}

/** Escape text for Telegram's legacy Markdown (used for our own status lines). */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}

/** Human-readable byte size for captions and listings. */
export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}
