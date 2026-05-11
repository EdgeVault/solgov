// Yieldbay incident feed hook, proxied through the solgov public API.

import { useEffect, useState } from 'react';

const API_URL = '/api/v1/yieldbay/incidents?limit=200';
const SUMMARY_URL = '/api/v1/yieldbay/summary';
const REFRESH_MS = 60_000;

export interface YieldbayEvent {
  id: string;
  protocol: string;
  protocol_name: string;
  entity: { name: string; address: string; type: string };
  severity: 'critical' | 'warning' | 'info';
  status: 'open' | 'detected' | 'recovered' | 'normalized';
  field: { name: string; label: string };
  display?: { summary?: string };
  values?: { delta_pct?: string; worst_delta_pct?: string };
  started_at: string;
  updated_at: string;
  resolved_at: string | null;
  links?: { app?: string; explorer?: string };
}

export const YIELDBAY_TO_SOLGOV: Record<string, string[]> = {
  'kamino': ['Kamino'],
  'meteora_dv': ['Meteora'],
  'meteora_amm_tx': ['Meteora'],
  'jupiter_borrow': ['Jupiter Lend'],
  'jupiter_earn': ['Jupiter Lend'],
  'perena': ['Perena'],
  'spl_stake_pools': ['Jito', 'Marinade', 'BlazeStake'],
};

interface UseYieldbayHealth {
  events: YieldbayEvent[];
  summary: any | null;
  fetchedAt: string | null;
  loading: boolean;
  bySolgovName: Record<string, YieldbayEvent[]>;
}

async function tryFetch(url: string): Promise<any | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export function useYieldbayHealth(): UseYieldbayHealth {
  const [events, setEvents] = useState<YieldbayEvent[]>([]);
  const [summary, setSummary] = useState<any | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const incidents = await tryFetch(API_URL);
      const sum = await tryFetch(SUMMARY_URL);
      if (cancelled) return;
      if (incidents?.events) {
        setEvents(incidents.events);
        setFetchedAt(incidents.sourceFetchedAt || incidents.asOf || null);
      }
      if (sum?.summary) setSummary(sum.summary);
      setLoading(false);
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const bySolgovName: Record<string, YieldbayEvent[]> = {};
  for (const e of events) {
    if (e.status !== 'open') continue;
    const targets = YIELDBAY_TO_SOLGOV[e.protocol] || [];
    for (const name of targets) {
      if (!bySolgovName[name]) bySolgovName[name] = [];
      bySolgovName[name].push(e);
    }
  }

  return { events, summary, fetchedAt, loading, bySolgovName };
}
