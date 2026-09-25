// Single source for the Squads threshold benchmark (4/6 and above, a two-thirds ratio). Every table
// cell, checklist line, chart bar and live merge compares against this, so the dashboard can never
// show two different verdicts for the same multisig. Integer maths keeps 4/6 exactly on the line.

import { SQUADS_MINIMUM } from '../data/protocols';

type Signers = { threshold: number; totalMembers: number; activeVoters: number };

// Denominator used everywhere the benchmark is shown: members who can vote, falling back to all
// members when the voting set is unknown.
export function effectiveVoters(p: Signers): number {
  return p.activeVoters > 0 ? p.activeVoters : p.totalMembers;
}

// Ratio half of the benchmark: threshold is at least two thirds of the signer set.
export function meetsSquadsRatio(threshold: number, signers: number): boolean {
  return signers > 0 && 3 * threshold >= 2 * signers;
}

// Signer-count half of the benchmark: at least SQUADS_MINIMUM.threshold approvals required.
export function meetsSquadsSignerCount(threshold: number): boolean {
  return threshold >= SQUADS_MINIMUM.threshold;
}

export function meetsSquadsBenchmark(threshold: number, signers: number): boolean {
  return meetsSquadsSignerCount(threshold) && meetsSquadsRatio(threshold, signers);
}

export function ratioPct(threshold: number, signers: number): number {
  return signers > 0 ? Math.round((threshold / signers) * 100) : 0;
}

// Parses a "4/6" style role threshold string.
export function parseThreshold(s: unknown): { threshold: number; signers: number } | null {
  const m = String(s ?? '').match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { threshold: +m[1], signers: +m[2] } : null;
}
