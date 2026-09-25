// Telegram parse_mode=HTML helpers. Any text that did not originate in solgov's own templates (on-chain
// strings, labels from third-party APIs, user input, LLM output) must pass through escapeHtml before it
// is interpolated, or a stray <, > or & makes Telegram reject the whole message and a tag in the text
// becomes live markup.

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const TELEGRAM_MAX = 4096;

// Splits an HTML message into parts no longer than `max`, breaking on line boundaries and never inside
// a tag. Tags solgov emits are line-local (<b>, <i>, <code>, <a>), so a line-boundary split keeps them
// balanced. A single line longer than `max` is cut and any tag left open in it is closed.
export function splitTelegramHtml(text: string, max = TELEGRAM_MAX - 96): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const piece = line.length > max ? closeOpenTags(line.slice(0, max - 16)) : line;
    if (cur.length + piece.length + 1 > max) {
      if (cur) parts.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function closeOpenTags(fragment: string): string {
  // Drop a trailing partial tag or entity, then close anything still open.
  let s = fragment.replace(/<[^>]*$/, '').replace(/&[a-zA-Z#0-9]*$/, '');
  const open: string[] = [];
  for (const m of s.matchAll(/<(\/?)([a-z]+)[^>]*>/gi)) {
    const tag = m[2].toLowerCase();
    if (m[1]) { const i = open.lastIndexOf(tag); if (i >= 0) open.splice(i, 1); }
    else open.push(tag);
  }
  for (const t of open.reverse()) s += `</${t}>`;
  return s + '…';
}
