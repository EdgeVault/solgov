// Live state and historical aggregate hook backed by the solgov public API, with a bundled snapshot as fallback.

import { useState, useEffect } from 'react';
import type { Protocol } from '../data/protocols';
import snapshot from '../data/live-snapshot.json';

const API_URL = '/api/state';
const HISTORICAL_URL = '/api/historical';

const BUILD_SNAPSHOT: any = snapshot && Object.keys(snapshot).filter(k => k !== '_snapshotTakenAt').length > 0 ? snapshot : null;

export interface ActivityEvent {
  date: string;
  timestamp: string;
  protocol: string;
  type: string;
  detail: string;
  multisig?: string;
}

export interface DaoProfile {
  name: string;
  realm: string;
  updatedAt: string;
  quorumLabel: string;
  timelockHours: number;
  votingPeriodHours: number;
  proposalThresholdRaw: number;
  proposalThresholdTokens: number;
  tokenMcapUsd: number;
  costToSeizeUsd: number;
  governanceHeldSol: number;
  governanceHeldUsd: number;
  holdsTokens: boolean;
  holdsUnpricedTokens: boolean;
  voterWeightPlugin: boolean;
  liveProposals: number;
  totalProposals: number;
}

export interface OracleProfile {
  protocol: string;
  program: string;
  networks: string[];
  sources: { program: string; name: string; sampleFeed: string; refs: number }[];
  unclassified: string[];
  status: 'multi-source' | 'single-network' | 'review' | 'unresolved';
  scannedAt: string;
}

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

export interface PendingUpgrade {
  protocol: string;
  multisig: string;
  proposalIndex: number;
  proposalPda: string;
  status: 'Active' | 'Approved';
  approvals: number;
  rejections: number;
  threshold: number;
  timelockSeconds: number;
  kind: 'ProgramUpgrade' | 'SetUpgradeAuthority' | 'ConfigChange' | 'OtherVaultTx';
  programId: string | null;
  detail: string;
}

export interface VerifiedBuildProgram {
  programId: string;
  name: string;
  protocol: string;
  upgradeAuthority: string;
  verified: boolean;
  signer: string | null;
  signerIsUpgradeAuthority: boolean;
  pdaExists: boolean;
  repo: string | null;
  commit: string | null;
  matchesDeployed: boolean | null;
}

export interface TokenTransparency {
  scannedAt: string;
  tokens: any[];
  programs: { protocol: string; programId: string; name: string; securityMetadata: { exists: boolean; mutable: boolean | null }; securityTxt: { present: boolean; contacts?: string; policy?: string; name?: string } }[];
}

interface MonitorState {
  [name: string]: any;
}

const NAME_MAP: Record<string, string> = {
  'Pumpfun': 'Pumpfun + PumpSwap',
  'Huma': 'Huma Finance',
  'deBridge (governance multisig)': 'deBridge',
  'Raydium (treasury)': 'Raydium',
};

function decodeRole(perm: string): string {
  if (perm === 'Full') return 'Full';
  if (perm === 'Propose') return 'Propose';
  if (perm === 'Vote') return 'Vote';
  if (perm === 'Execute') return 'Execute';
  if (perm === 'Vote+Execute') return 'Vote+Execute';
  if (perm === 'Propose+Vote') return 'Propose+Vote';
  if (perm === 'None') return 'None';
  return perm;
}

export interface LiveProtocolState {
  pendingProposals?: number;
  threatAlerts?: { signer: string; category: string; severity: string; detail: string; detectedAt: string; signature?: string; precedent: string }[];
  signerBalances?: Record<string, number>;
  programAuthorities?: Record<string, string>;
  lastChecked?: string;
}

export interface HistoricalProtocolState {
  totalTxs?: number;
  approvedProposals?: number;
  rejectedProposals?: number;
  cancelledProposals?: number;
  configChanges?: number;
  configDates?: string[];
  spendingLimitUses?: number;
  programUpgrades?: number;
  uniqueFeePayers?: Record<string, number>;
  lastUpdated?: string;
}

const CACHE_KEY = 'solgov-live-state-v1';

function readCache(): MonitorState | null {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(CACHE_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(state: MonitorState) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {}
}

export function useLiveData(staticProtocols: Protocol[]): {
  protocols: Protocol[];
  lastScan: string | null;
  isLive: boolean;
  liveStates: Record<string, LiveProtocolState>;
  liveActivity: ActivityEvent[];
  liveIntegrity: any | null;
  liveHistorical: Record<string, HistoricalProtocolState>;
  historicalAsOf: string | null;
  liveDaos: DaoProfile[];
  liveOracles: OracleProfile[];
  liveIndependence: { computedAt: string; groups: IndependenceGroup[] } | null;
  livePendingUpgrades: { scannedAt: string; results: PendingUpgrade[] } | null;
  liveVerifiedBuilds: { scannedAt: string; programs: VerifiedBuildProgram[]; protocols: Record<string, { anyVerified: boolean; verifiedCount: number; totalPrograms: number }> } | null;
  liveTokenTransparency: TokenTransparency | null;
  liveMeta: { generatedAt: string; stateFileWrittenAt: string } | null;
  liveOracleConfig: { scannedAt: string; results: any[] } | null;
} {
  const [liveState, setLiveState] = useState<MonitorState | null>(null);
  const [historical, setHistorical] = useState<Record<string, HistoricalProtocolState> | null>(null);

  useEffect(() => {
    const fetchOpts: RequestInit = { cache: 'no-store' };
    async function fetchState() {
      try {
        const resp = await fetch(API_URL, fetchOpts);
        if (resp.ok) {
          const data = await resp.json();
          setLiveState(data);
          writeCache(data);
          return;
        }
        throw new Error(`status ${resp.status}`);
      } catch {
        setLiveState(prev => prev ?? readCache() ?? BUILD_SNAPSHOT);
      }
    }
    async function fetchHistorical() {
      try {
        const resp = await fetch(HISTORICAL_URL, fetchOpts);
        if (resp.ok) {
          const data = await resp.json();
          if (data && typeof data === 'object') setHistorical(data);
        }
      } catch {}
    }
    fetchState();
    fetchHistorical();
    const stateInterval = setInterval(fetchState, 2 * 60 * 1000);
    const historicalInterval = setInterval(fetchHistorical, 15 * 60 * 1000);
    return () => {
      clearInterval(stateInterval);
      clearInterval(historicalInterval);
    };
  }, []);

  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick(n => n + 1), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  if (!liveState) {
    return { protocols: staticProtocols, lastScan: null, isLive: false, liveStates: {}, liveActivity: [], liveIntegrity: null, liveHistorical: {}, historicalAsOf: null, liveDaos: [], liveOracles: [], liveIndependence: null, livePendingUpgrades: null, liveVerifiedBuilds: null, liveTokenTransparency: null, liveMeta: null, liveOracleConfig: null };
  }

  const liveIntegrity = (liveState as any)._integrity || null;

  const liveActivityRaw: ActivityEvent[] = Array.isArray(liveState._activityLog) ? liveState._activityLog : [];
  const liveActivity: ActivityEvent[] = liveActivityRaw.map(e => ({
    ...e,
    protocol: NAME_MAP[e.protocol] || e.protocol,
  }));

  // Resolve an activity-log label to a dashboard protocol. Upgrade events arrive either as the plain
  // protocol ("Ore") or with the specific program appended ("Raydium (LaunchLab)"). Match the full
  // label first, because one tracked protocol is genuinely named "Save (Solend)", and only then strip
  // the trailing parenthetical to reach the family. The strip is greedy because labels can nest,
  // for example "Helium (Top (topqq))" and "Parcl (Parcl Perps Aux (3parc))".
  const knownNames = new Set(staticProtocols.map(p => p.name));
  const resolveProtocolName = (label: string): string | null => {
    const direct = NAME_MAP[label] || label;
    if (knownNames.has(direct)) return direct;
    const family = label.replace(/\s*\(.*\)\s*$/, '').trim();
    const mapped = NAME_MAP[family] || family;
    return knownNames.has(mapped) ? mapped : null;
  };

  // One upgrade is reported twice: in real time by the listener ("Program 6EF8... upgraded at 10:00
  // UTC") and again in the monitor digest ("Bonding Curve upgraded: 2026-09-15 11:34 BST"), and the
  // digest can repeat across runs. Both are collapsed onto the hour the upgrade actually happened.
  // The digest carries that time in its text; for a listener event the event timestamp is the time.
  const upgradeHourKey = (e: ActivityEvent): string | null => {
    const m = /upgraded:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s*(BST|GMT)/i.exec(e.detail || '');
    if (m) {
      const utcMs = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) - (m[4].toUpperCase() === 'BST' ? 3600000 : 0);
      return new Date(utcMs).toISOString().slice(0, 13);
    }
    const ts = e.timestamp || e.date;
    return ts ? new Date(ts).toISOString().slice(0, 13) : null;
  };

  const upgradeCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const latestUpgradeByProtocol: Record<string, string> = {};
  const upgradeKeysByProtocol: Record<string, Set<string>> = {};

  for (const e of liveActivityRaw) {
    if (e.type !== 'ProgramUpgrade' || !e.protocol) continue;
    const name = resolveProtocolName(e.protocol);
    if (!name) continue;
    const hourKey = upgradeHourKey(e);
    if (!hourKey) continue;

    const date = hourKey.slice(0, 10);
    const prev = latestUpgradeByProtocol[name];
    if (!prev || date > prev) latestUpgradeByProtocol[name] = date;

    if (Date.parse(`${hourKey}:00:00Z`) >= upgradeCutoffMs) {
      (upgradeKeysByProtocol[name] = upgradeKeysByProtocol[name] || new Set()).add(hourKey);
    }
  }

  let lastScan: string | null = null;
  for (const [key, state] of Object.entries(liveState)) {
    if (key === '_activityLog') continue;
    if (state.lastChecked && (!lastScan || state.lastChecked > lastScan)) {
      lastScan = state.lastChecked;
    }
  }

  const liveVerifiedBuilds = (liveState as any)._verifiedBuilds && Array.isArray((liveState as any)._verifiedBuilds.programs) ? (liveState as any)._verifiedBuilds : null;

  const merged = staticProtocols.map((p) => {
    const directLive = liveState[p.name];
    const fallbackKey = directLive ? null : (Object.keys(NAME_MAP).find(k => NAME_MAP[k] === p.name) || null);
    const monitorName = directLive ? p.name : (fallbackKey || p.name);
    const live = directLive || (fallbackKey ? liveState[fallbackKey] : undefined);

    // upgradesLast30d is a rolling window, so it is always derived from the live log rather than the
    // static value, which would otherwise stay frozen at whatever it was when protocols.ts was last
    // edited and contradict a live-corrected lastUpgrade.
    const liveLatestUpgrade = latestUpgradeByProtocol[p.name];
    let baseUpdated = { ...p, upgradesLast30d: upgradeKeysByProtocol[p.name]?.size ?? 0 };
    if (liveLatestUpgrade && (!p.lastUpgrade || liveLatestUpgrade > p.lastUpgrade)) {
      baseUpdated = { ...baseUpdated, lastUpgrade: liveLatestUpgrade };
    }
    // Verified builds from the live otter-verify scan replace the static flag. The scan re-validates
    // the deployed hash locally and follows the Solana Explorer's signer policy, so it also catches a
    // build that was verified once and then superseded by a later upgrade, which a static flag cannot.
    const vb = liveVerifiedBuilds?.protocols?.[p.name];
    if (vb && vb.totalPrograms > 0) {
      const progs = liveVerifiedBuilds!.programs.filter(x => x.protocol === p.name);
      const superseded = !vb.anyVerified && progs.some(x => x.pdaExists && x.matchesDeployed === false);
      baseUpdated = {
        ...baseUpdated,
        verifiedBuild: vb.anyVerified ? (vb.verifiedCount === vb.totalPrograms ? true : 'partial') : false,
        verifiedBuildNote: superseded ? 'A verified build was published, but the deployed program has been upgraded since and no longer matches it' : undefined,
      };
    }

    if (!live || live.threshold === 0) return baseUpdated;

    const updated = { ...baseUpdated };

    updated.threshold = live.threshold;
    updated.totalMembers = live.members.length;

    if (live.timeLock >= 0 && p.timelockSeconds !== -1) {
      updated.timelockSeconds = live.timeLock;
      if (live.timeLock === 0) {
        updated.timelockLabel = 'None';
        updated.hasTimelock = false;
      } else {
        const mins = Math.round(live.timeLock / 60);
        const hours = live.timeLock / 3600;
        updated.timelockLabel = hours >= 1 ? `${Math.round(hours)}h` : `${mins}min`;
        updated.hasTimelock = true;
      }
    }

    if (live.memberPerms && Object.keys(live.memberPerms).length > 0) {
      updated.members = live.members.map((key: string) => ({
        key,
        role: decodeRole(live.memberPerms![key] || 'None') as 'Full' | 'Propose + Vote' | 'Propose + Execute' | 'Vote + Execute' | 'Propose' | 'Vote' | 'Execute' | 'None',
      }));
      const roles = new Set(updated.members!.map(m => m.role));
      updated.hasRoleSeparation = roles.size > 1;
      const canVote = (r: string) => r === 'Full' || r === 'Vote' || r === 'Vote + Execute' || r === 'Propose + Vote' || r === 'Vote+Execute' || r === 'Propose+Vote';
      updated.activeVoters = updated.members!.filter(m => canVote(m.role)).length;
    } else if (live.members && live.members.length > 0) {
      updated.members = live.members.map((key: string) => ({
        key,
        role: 'Full' as 'Full',
      }));
      updated.activeVoters = live.members.length;
      if (updated.version === 'Squads V3' || updated.version === 'Serum Multisig') {
        updated.hasRoleSeparation = false;
      }
    }

    if (updated.version === 'Squads V4') {
      const ratio = updated.totalMembers > 0 ? updated.threshold / updated.totalMembers : 0;
      updated.meetsMinThreshold = ratio >= 0.6 && updated.threshold >= 4;
    }

    if (typeof live.configAuthority === 'string') {
      updated.configAuthority = live.configAuthority === '11111111111111111111111111111111'
        ? 'autonomous'
        : live.configAuthority;
    }

    return updated;
  });

  const liveStates: Record<string, LiveProtocolState> = {};
  for (const [monitorName, state] of Object.entries(liveState)) {
    if (monitorName === '_activityLog') continue;
    const dashName = NAME_MAP[monitorName] || monitorName;
    liveStates[dashName] = {
      pendingProposals: state.pendingProposals,
      threatAlerts: state.threatAlerts,
      signerBalances: state.signerBalances,
      programAuthorities: state.programAuthorities,
      lastChecked: state.lastChecked,
    };
  }

  const liveHistorical: Record<string, HistoricalProtocolState> = {};
  let historicalAsOf: string | null = null;
  if (historical) {
    for (const [monitorName, h] of Object.entries(historical)) {
      if (!h || typeof h !== 'object') continue;
      const dashName = NAME_MAP[monitorName] || monitorName;
      liveHistorical[dashName] = h as HistoricalProtocolState;
      const lu = (h as HistoricalProtocolState).lastUpdated;
      if (lu && (!historicalAsOf || lu > historicalAsOf)) historicalAsOf = lu;
    }
  }

  const liveDaos: DaoProfile[] = Array.isArray((liveState as any)._daos) ? (liveState as any)._daos : [];
  const liveOracles: OracleProfile[] = Array.isArray((liveState as any)._oracles) ? (liveState as any)._oracles : [];
  const ls: any = liveState;
  const liveIndependence = ls._independence && Array.isArray(ls._independence.groups) ? ls._independence : null;
  const livePendingUpgrades = ls._pendingUpgrades && Array.isArray(ls._pendingUpgrades.results) ? ls._pendingUpgrades : null;
  const liveTokenTransparency = ls._tokenTransparency && Array.isArray(ls._tokenTransparency.programs) ? ls._tokenTransparency : null;
  const liveMeta = ls._meta && typeof ls._meta.generatedAt === 'string' ? ls._meta : null;
  const liveOracleConfig = ls._oracleConfig && Array.isArray(ls._oracleConfig.results) ? ls._oracleConfig : null;

  return { protocols: merged, lastScan, isLive: true, liveStates, liveActivity, liveIntegrity, liveHistorical, historicalAsOf, liveDaos, liveOracles, liveIndependence, livePendingUpgrades, liveVerifiedBuilds, liveTokenTransparency, liveMeta, liveOracleConfig };
}
