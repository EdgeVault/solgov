// Signer-independence per team, computed from live monitor state. Pure: no I/O, so it is unit-tested
// and shared by the independence-live scanner. See that scanner for the rationale and output contract.

export interface IndependenceGroup {
  team: string;
  context: 'live' | 'case-study';
  note?: string;
  multisigs: { label: string; address: string | null; memberCount: number }[];
  independenceScore: number;
  independencePct: number;
  totalSignerPositions: number;
  uniqueSigners: number;
  pairwiseOverlap: { a: string; b: string; shared: number; sharedPctOfMinSet: number }[];
}

// Product multisigs that belong to one team but carry no parenthetical in their monitor name.
export const FAMILY_MAP: Record<string, string> = {
  'Jupiter Perps': 'Jupiter',
  'Jupiter Lend': 'Jupiter',
  'Jupiter Agg': 'Jupiter',
};

const TEAM_NOTES: Record<string, string> = {
  Jupiter: 'Three product multisigs: Perps, Lend, Aggregator',
};

export function familyOf(name: string): string {
  if (FAMILY_MAP[name]) return FAMILY_MAP[name];
  return name.replace(/\s*\(.*\)\s*$/, '').trim();
}

// independence = (unique - minSize) / (positions - minSize): 1 when no signer sits on more than one
// multisig, 0 when every multisig is the same signer set. minSize is the smallest multisig, the
// floor of unique signers any grouping must have.
export function scoreGroup(team: string, resolved: { label: string; address: string | null; members: string[] }[]): IndependenceGroup {
  const positions = resolved.reduce((n, m) => n + m.members.length, 0);
  const uniqueSigners = new Set(resolved.flatMap(m => m.members)).size;
  const minSize = Math.max(1, Math.min(...resolved.map(m => m.members.length)));
  const raw = positions === minSize ? 1 : (uniqueSigners - minSize) / (positions - minSize);
  const independence = Math.max(0, Math.min(1, raw));
  const pairwise: IndependenceGroup['pairwiseOverlap'] = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = new Set(resolved[i].members);
      const b = new Set(resolved[j].members);
      const shared = Array.from(a).filter(x => b.has(x)).length;
      const minPair = Math.max(1, Math.min(a.size, b.size));
      pairwise.push({ a: resolved[i].label, b: resolved[j].label, shared, sharedPctOfMinSet: Math.round((shared / minPair) * 100) });
    }
  }
  return {
    team,
    context: 'live',
    ...(TEAM_NOTES[team] ? { note: TEAM_NOTES[team] } : {}),
    multisigs: resolved.map(r => ({ label: r.label, address: r.address, memberCount: r.members.length })),
    independenceScore: independence,
    independencePct: Math.round(independence * 100),
    totalSignerPositions: positions,
    uniqueSigners,
    pairwiseOverlap: pairwise,
  };
}

// Groups live monitor entries by team and scores every team running two or more multisigs.
// Entries labelled historical are excluded; entries without members are ignored.
export function computeLiveGroups(state: Record<string, any>): { computedAt: string; groups: IndependenceGroup[] } {
  const byFamily = new Map<string, { label: string; address: string | null; members: string[] }[]>();
  let newest = '';
  for (const [name, s] of Object.entries(state)) {
    if (name.startsWith('_') || !s || !Array.isArray(s.members) || s.members.length === 0) continue;
    if (/historical/i.test(name)) continue;
    const fam = familyOf(name);
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam)!.push({ label: name, address: s.address || s.multisig || null, members: s.members });
    if (s.lastChecked && s.lastChecked > newest) newest = s.lastChecked;
  }
  const groups: IndependenceGroup[] = [];
  for (const [team, resolved] of byFamily) if (resolved.length >= 2) groups.push(scoreGroup(team, resolved));
  groups.sort((a, b) => b.independencePct - a.independencePct || a.team.localeCompare(b.team));
  return { computedAt: newest || new Date().toISOString(), groups };
}
