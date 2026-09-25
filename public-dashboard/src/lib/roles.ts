// Squads member permission names. The API sends compact forms ("Vote+Execute"); the dashboard's
// Member type uses spaced forms ("Vote + Execute"). Normalise once here and share one voter test.

import type { Member } from '../data/protocols';

export type MemberRole = Member['role'];

const API_ROLE_MAP: Record<string, MemberRole> = {
  'Full': 'Full',
  'Propose': 'Propose',
  'Vote': 'Vote',
  'Execute': 'Execute',
  'None': 'None',
  'Vote+Execute': 'Vote + Execute',
  'Propose+Vote': 'Propose + Vote',
  'Propose+Execute': 'Propose + Execute',
};

export function decodeRole(perm: string): MemberRole {
  const compact = String(perm ?? '').replace(/\s+/g, '');
  return API_ROLE_MAP[compact] ?? (perm as MemberRole);
}

// Members whose permission includes Vote count toward the approval threshold.
export function canVote(role: string): boolean {
  const r = decodeRole(role);
  return r === 'Full' || r === 'Vote' || r === 'Vote + Execute' || r === 'Propose + Vote';
}
