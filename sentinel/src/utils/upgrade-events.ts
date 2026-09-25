// Pure helpers for reasoning about program-upgrade events in the activity log. Kept dependency-free
// so they can be unit-tested and shared by the API (cadence endpoint) and any scanner.

export interface UpgradeEventLike { protocol?: string; type?: string; detail?: string; timestamp?: string; date?: string }

// "Raydium (LaunchLab)" -> "Raydium". Greedy because labels nest: "Helium (Top (topqq))".
export function protocolFamily(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim();
}

// One upgrade is reported twice: in real time by the listener ("Program 6EF8... upgraded at 10:00
// UTC", whose event timestamp is the upgrade time) and later by the monitor digest ("Bonding Curve
// upgraded: 2026-09-15 11:34 BST", which carries the upgrade time in its text and can repeat across
// runs). Both collapse onto the UTC hour the upgrade happened.
export function upgradeHourKey(e: UpgradeEventLike): string | null {
  const m = /upgraded:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s*(BST|GMT)/i.exec(e.detail || '');
  if (m) {
    const utcMs = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) - (m[4].toUpperCase() === 'BST' ? 3600000 : 0);
    return new Date(utcMs).toISOString().slice(0, 13);
  }
  const ts = e.timestamp || e.date;
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 13);
}

// Distinct upgrade hours per protocol family, ignoring events the monitor could not attribute.
export function dedupeUpgradesByFamily(events: UpgradeEventLike[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    if (!e || e.type !== 'ProgramUpgrade' || !e.protocol || e.protocol === 'Unknown') continue;
    const k = upgradeHourKey(e);
    if (!k) continue;
    const fam = protocolFamily(e.protocol);
    if (!out.has(fam)) out.set(fam, new Set());
    out.get(fam)!.add(k);
  }
  return out;
}

export interface CadenceRow { observed: number; firstAt: string; lastAt: string; last30d: number; meanIntervalDays: number | null }

export function cadenceFromKeys(keys: Set<string>, nowMs: number = Date.now()): CadenceRow {
  const times = Array.from(keys).map(k => Date.parse(`${k}:00:00Z`)).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const cutoff30 = nowMs - 30 * 86400000;
  return {
    observed: times.length,
    firstAt: new Date(times[0]).toISOString(),
    lastAt: new Date(times[times.length - 1]).toISOString(),
    last30d: times.filter(t => t >= cutoff30).length,
    meanIntervalDays: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) / 86400000 * 10) / 10 : null,
  };
}
