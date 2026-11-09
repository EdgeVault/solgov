// Replay engine core. Pure: takes a scenario and cached histories, rebuilds account state over time,
// and runs the production detectors at every change. No RPC here, so it runs in tests from fixtures.
//
// Each output event records what the live alert path would have done with it (risk-team thread by
// severity, public channel or not), using the same routing rules as solgov-listener.ts. Creation and
// first-seen states are recorded as observations: facts that were visible, which the live rules do not
// alert on by themselves.

import type { CompactTx } from './history';
import { ixData } from './history';
import { rebuildV4, toSnapshot, vaultPda, SQUADS_V4, V4_CONFIG_DISCRIMINATORS, type V4State } from './squads-v4';
import { rebuildProgram, programDataAddress, LOADER } from './program';
import { classifyV4Change, timelockLabel, type Severity } from '../detectors/multisig-config';
import { decideProgramEvent, classifyProgramSeverity, type ProgramRole } from '../detectors/program-upgrade';
import { describeHolder, type HolderFacts } from '../detectors/holder';
import { rebuildAdmin, anchorDisc, type AdminTarget } from './admin';
import { classifyAdminChange } from '../detectors/admin-watch';

export interface Scenario {
  id: string;
  title: string;
  note?: string;
  windows: { label: string; from: string; to: string }[];
  multisigs: { name: string; address: string }[];
  programs: { name: string; programId: string; role: ProgramRole }[];
  admin?: AdminTarget[];
}

export type Detector = 'multisig-config' | 'program-upgrade' | 'admin-watch' | 'observation';

export interface ReplayEvent {
  time: number;
  date: string;          // ISO UTC
  slot: number;
  signature: string;
  window: string | null; // label of the scenario window the event falls in
  source: string;        // multisig / program / admin target name
  detector: Detector;
  type: string;
  severity: Severity | null; // null for observations
  detail: string;
  // What the live alert path would do if this account is watched. watchedLive says whether it is on the
  // live watch list today; an event on an unwatched account would not reach anyone as configured.
  routing: { riskTeam: Severity | null; public: boolean; watchedLive: boolean };
}

// Accounts the live services watch today (multisig addresses, program ids, admin state accounts).
export interface LiveCoverage { multisigs: Set<string>; programs: Set<string>; adminAccounts: Set<string> }
const ALL_WATCHED: LiveCoverage = { multisigs: new Set(), programs: new Set(), adminAccounts: new Set() };

export function historyAddresses(s: Scenario): string[] {
  const out = new Set<string>();
  for (const m of s.multisigs) out.add(m.address);
  for (const p of s.programs) out.add(programDataAddress(p.programId));
  for (const a of s.admin || []) for (const h of a.historyFrom) out.add(h);
  return [...out];
}

const iso = (t: number) => new Date(t * 1000).toISOString();

function windowOf(s: Scenario, t: number): string | null {
  for (const w of s.windows) if (t >= Date.parse(w.from) / 1000 && t < Date.parse(w.to) / 1000) return w.label;
  return null;
}

function createSummary(st: V4State): string {
  const tl = st.timeLock > 0 ? `${timelockLabel(st.timeLock)} timelock` : 'no timelock';
  const ext = st.configAuthority !== 'autonomous' ? `, external admin key ${st.configAuthority.slice(0, 8)}...` : ', no external admin key';
  return `Multisig created: ${st.threshold} of ${st.members.length} signers, ${tl}${ext}`;
}

export interface ReplayResult {
  scenario: string;
  title: string;
  events: ReplayEvent[];
  undecoded: Record<string, string[]>;
}

export function runReplay(s: Scenario, histories: Record<string, CompactTx[]>, live?: LiveCoverage): ReplayResult {
  const events: ReplayEvent[] = [];
  const undecoded: Record<string, string[]> = {};
  const cov = live ?? ALL_WATCHED;
  const watched = (set: Set<string>, key: string) => !live || set.has(key);
  type Pushed = Omit<ReplayEvent, 'date' | 'window' | 'routing'> & { routing: { riskTeam: Severity | null; public: boolean } };
  const pushFor = (isWatched: boolean) => (e: Pushed) => events.push({ ...e, date: iso(e.time), window: windowOf(s, e.time), routing: { ...e.routing, watchedLive: isWatched } });

  // Multisig timelines, kept for holder descriptions at any moment.
  const msTimelines = new Map<string, { name: string; vault: string; points: { time: number; slot: number; state: V4State }[] }>();
  for (const m of s.multisigs) {
    const push = pushFor(watched(cov.multisigs, m.address));
    const { changes, undecoded: u } = rebuildV4(m.address, histories[m.address] || []);
    if (u.length) undecoded[m.name] = u;
    msTimelines.set(m.address, { name: m.name, vault: vaultPda(m.address), points: changes.map(c => ({ time: c.tx.time, slot: c.tx.slot, state: c.after })) });
    for (const c of changes) {
      if (!c.before) {
        push({ time: c.tx.time, slot: c.tx.slot, signature: c.tx.sig, source: m.name, detector: 'observation', type: 'MultisigCreated', severity: null, detail: createSummary(c.after), routing: { riskTeam: null, public: false } });
        continue;
      }
      for (const ch of classifyV4Change(toSnapshot(c.before), toSnapshot(c.after))) {
        const how = c.how === 'config-authority' ? ' (changed directly by the external admin key, no proposal)' : '';
        push({
          time: c.tx.time, slot: c.tx.slot, signature: c.tx.sig, source: m.name, detector: 'multisig-config', type: ch.type, severity: ch.severity,
          detail: ch.detail + how,
          routing: { riskTeam: ch.severity, public: ch.severity === 'CRITICAL' || ch.severity === 'HIGH' },
        });
      }
    }
  }

  // Facts about a key at a moment (slot), resolved against the replayed multisigs.
  const holderAt = (key: string, slot: number): HolderFacts => {
    if (key === 'IMMUTABLE') return { kind: 'immutable' };
    for (const [address, tl] of msTimelines) {
      if (tl.vault !== key) continue;
      let st: V4State | null = null;
      for (const p of tl.points) { if (p.slot <= slot) st = p.state; else break; }
      if (st) return { kind: 'multisig-vault', address, multisigName: tl.name, threshold: st.threshold, memberCount: st.members.length, timeLock: st.timeLock, configAuthority: st.configAuthority };
    }
    return { kind: 'untracked', address: key, scope: 'replay' };
  };

  for (const p of s.programs) {
    const push = pushFor(watched(cov.programs, p.programId));
    const pd = programDataAddress(p.programId);
    const { changes } = rebuildProgram(pd, histories[pd] || []);
    for (const c of changes) {
      if (!c.before) {
        push({ time: c.tx.time, slot: c.tx.slot, signature: c.tx.sig, source: p.name, detector: 'observation', type: 'ProgramDeployed', severity: null, detail: `Program deployed; upgradeable by ${describeHolder(holderAt(c.after.authority, c.tx.slot))}`, routing: { riskTeam: null, public: false } });
        continue;
      }
      const d = decideProgramEvent({ prevAuthority: c.before.authority, authority: c.after.authority, prevDeploySlot: c.before.deploySlot, deploySlot: c.after.deploySlot, deployTime: c.after.deployTime, nowSec: c.tx.time });
      if (!d.isAuthorityChange && !d.isRealUpgrade) continue;
      const { severity } = classifyProgramSeverity({ name: p.name, role: p.role, isAuthorityChange: d.isAuthorityChange, hourUtc: new Date(c.tx.time * 1000).getUTCHours() });
      const detail = d.isAuthorityChange
        ? `Who can upgrade it: ${describeHolder(holderAt(c.before.authority, c.tx.slot - 1))} → ${describeHolder(holderAt(c.after.authority, c.tx.slot))}`
        : `Program code updated; upgradeable by ${describeHolder(holderAt(c.after.authority, c.tx.slot))}`;
      push({
        time: c.tx.time, slot: c.tx.slot, signature: c.tx.sig, source: p.name, detector: 'program-upgrade', type: d.isAuthorityChange ? 'AuthorityChange' : 'ProgramUpgrade', severity, detail,
        routing: { riskTeam: severity, public: d.isAuthorityChange && (severity === 'CRITICAL' || severity === 'HIGH') },
      });
    }
  }

  for (const a of s.admin || []) {
    const push = pushFor(watched(cov.adminAccounts, a.account));
    const merged = mergeHistories(a.historyFrom.map(h => histories[h] || []));
    for (const c of rebuildAdmin(a, merged)) {
      const ch = classifyAdminChange({ target: a, field: c.field, before: c.before, after: c.after, beforeHolder: c.before ? holderAt(c.before, c.tx.slot - 1) : null, afterHolder: holderAt(c.after, c.tx.slot) });
      push({ time: c.tx.time, slot: c.tx.slot, signature: c.tx.sig, source: a.name, detector: 'admin-watch', type: ch.type, severity: ch.severity, detail: ch.detail, routing: { riskTeam: ch.severity, public: ch.public } });
    }
  }

  events.sort((x, y) => x.slot - y.slot || x.source.localeCompare(y.source));
  return { scenario: s.id, title: s.title, events, undecoded };
}

// Keeps only the instructions the rebuild reads (Squads V4 on a scenario multisig, loader on a scenario
// ProgramData, admin setters on a scenario state account) and drops transactions left empty. Used to
// freeze small regression fixtures from a full cached history; runReplay gives the same result on both.
export function relevantSubset(s: Scenario, histories: Record<string, CompactTx[]>): Record<string, CompactTx[]> {
  const ms = new Set(s.multisigs.map(m => m.address));
  const pds = new Set(s.programs.map(p => programDataAddress(p.programId)));
  const adminPrograms = new Set((s.admin || []).map(a => a.programId));
  const keep = (ix: CompactTx['ixs'][number]) =>
    (ix.p === SQUADS_V4 && ix.a.some(k => ms.has(k)) && V4_CONFIG_DISCRIMINATORS.has(ixData(ix).subarray(0, 8).toString('hex'))) ||
    (ix.p === LOADER && ix.a.some(k => pds.has(k))) ||
    (adminPrograms.has(ix.p) && (s.admin || []).some(a => a.programId === ix.p && ix.a.includes(a.account) && a.setters.some(st => ix.d && anchorDiscB58Prefix(st.ix, ix))));
  const out: Record<string, CompactTx[]> = {};
  for (const [addr, txs] of Object.entries(histories)) {
    out[addr] = txs.map(t => ({ ...t, ixs: t.ixs.filter(keep) })).filter(t => t.ixs.length > 0);
  }
  return out;
}

function anchorDiscB58Prefix(ixName: string, ix: CompactTx['ixs'][number]): boolean {
  return ixData(ix).subarray(0, 8).toString('hex') === anchorDisc(ixName);
}

export function mergeHistories(lists: CompactTx[][]): CompactTx[] {
  const bySig = new Map<string, CompactTx>();
  for (const l of lists) for (const t of l) bySig.set(t.sig, t);
  return [...bySig.values()].sort((a, b) => a.slot - b.slot);
}
