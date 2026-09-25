// Shared duration and timestamp helpers.

// Timelock / delay label: minutes under 1h, hours under 48h, days from there.
// 600 -> "10min", 5400 -> "1h 30min", 86400 -> "24h", 604800 -> "7d". Zero or less -> "None".
export function formatTimelock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'None';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  if (seconds < 48 * 3600) {
    const totalMin = Math.round(seconds / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h ${m}min` : `${h}h`;
  }
  const totalHours = Math.round(seconds / 3600);
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

// Date.parse that returns null instead of NaN.
export function parseTime(s: unknown): number | null {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const t = typeof s === 'number' ? s : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// "just now" / "12 min ago" / "3 h ago" / "2 d ago" for a timestamp, or null when unparseable.
export function formatAge(s: unknown, now: number = Date.now()): string | null {
  const t = parseTime(s);
  if (t === null) return null;
  const ageMin = Math.max(0, Math.round((now - t) / 60000));
  return ageMin < 1 ? 'just now'
    : ageMin < 60 ? `${ageMin} min ago`
    : ageMin < 1440 ? `${Math.round(ageMin / 60)} h ago`
    : `${Math.round(ageMin / 1440)} d ago`;
}
