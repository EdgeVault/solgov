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
}

interface MonitorState {
  [name: string]: any;
}

const NAME_MAP: Record<string, string> = {
  'Pumpfun': 'Pumpfun + PumpSwap',
  'Huma': 'Huma Finance',
  'Onre Finance (secondary)': 'Onre Finance',
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
} {
  const [liveState, setLiveState] = useState<MonitorState | null>(() => BUILD_SNAPSHOT || readCache());
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
        }
      } catch {}
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
    return { protocols: staticProtocols, lastScan: null, isLive: false, liveStates: {}, liveActivity: [], liveIntegrity: null, liveHistorical: {}, historicalAsOf: null };
  }

  const liveIntegrity = (liveState as any)._integrity || null;

  const liveActivityRaw: ActivityEvent[] = Array.isArray(liveState._activityLog) ? liveState._activityLog : [];
  const liveActivity: ActivityEvent[] = liveActivityRaw.map(e => ({
    ...e,
    protocol: NAME_MAP[e.protocol] || e.protocol,
  }));

  const latestUpgradeByMonitorName: Record<string, string> = {};
  for (const e of liveActivityRaw) {
    if (e.type !== 'ProgramUpgrade' || !e.protocol) continue;
    const ts = e.timestamp || e.date;
    if (!ts) continue;
    const date = ts.slice(0, 10);
    const prev = latestUpgradeByMonitorName[e.protocol];
    if (!prev || date > prev) latestUpgradeByMonitorName[e.protocol] = date;
  }

  let lastScan: string | null = null;
  for (const [key, state] of Object.entries(liveState)) {
    if (key === '_activityLog') continue;
    if (state.lastChecked && (!lastScan || state.lastChecked > lastScan)) {
      lastScan = state.lastChecked;
    }
  }

  const merged = staticProtocols.map((p) => {
    const directLive = liveState[p.name];
    const fallbackKey = directLive ? null : (Object.keys(NAME_MAP).find(k => NAME_MAP[k] === p.name) || null);
    const monitorName = directLive ? p.name : (fallbackKey || p.name);
    const live = directLive || (fallbackKey ? liveState[fallbackKey] : undefined);

    const liveLatestUpgrade = latestUpgradeByMonitorName[monitorName];
    const baseUpdated = liveLatestUpgrade && (!p.lastUpgrade || liveLatestUpgrade > p.lastUpgrade)
      ? { ...p, lastUpgrade: liveLatestUpgrade }
      : p;

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

  return { protocols: merged, lastScan, isLive: true, liveStates, liveActivity, liveIntegrity, liveHistorical, historicalAsOf };
}
