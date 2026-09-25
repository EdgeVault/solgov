// Per-protocol TVL hook backed by DefiLlama with a bundled snapshot as fallback.

import { useState, useEffect } from 'react';
import snapshot from '../data/llama-snapshot.json';
import slugs from '../data/tvl-slugs.json';

const LLAMA_BASE = 'https://api.llama.fi';
const CACHE_KEY = 'solgov:llama:v2';

// Slug lists live in one JSON file shared with scripts/fetch-snapshot.mjs so the live fetch and the
// build-time fallback always cover the same protocols.
const TVL_SLUGS: Record<string, string[]> = slugs.tvl;
const DEX_SLUGS: Record<string, string> = slugs.dex;

// 'live' = fetched from DefiLlama in this session; 'cache' = this browser's last successful fetch;
// 'snapshot' = bundled at build time. Only 'live' may be labelled live in the UI.
export type TvlSource = 'live' | 'cache' | 'snapshot' | 'none';

export interface DefiLlamaData {
  tvl: Record<string, number>;
  volume24h: Record<string, number>;
  lastUpdated: string | null;
  loading: boolean;
  source: TvlSource;
}

// Solana share of a DefiLlama /protocols entry. chainTvls.Solana is used when DefiLlama breaks TVL
// down by chain; the all-chain total is only used when no breakdown exists, so a multichain protocol
// is never shown with its TVL on other chains.
export function solanaTvl(p: any): number {
  const ct = p?.chainTvls;
  if (ct && typeof ct === 'object' && Object.keys(ct).length > 0) {
    return typeof ct.Solana === 'number' ? ct.Solana : 0;
  }
  return typeof p?.tvl === 'number' ? p.tvl : 0;
}

function formatTvl(value: number): string {
  if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return '$' + (value / 1e6).toFixed(0) + 'M';
  if (value >= 1e3) return '$' + (value / 1e3).toFixed(0) + 'K';
  return '$' + value.toFixed(0);
}

function readCache(): DefiLlamaData | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || !c.tvl) return null;
    return { tvl: c.tvl, volume24h: c.volume24h || {}, lastUpdated: c.lastUpdated || null, loading: false, source: 'cache' };
  } catch { return null; }
}

function writeCache(d: DefiLlamaData) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ tvl: d.tvl, volume24h: d.volume24h, lastUpdated: d.lastUpdated }));
  } catch {}
}

function initialData(): DefiLlamaData {
  const cached = readCache();
  if (cached && Object.keys(cached.tvl).length > 0) return cached;
  if (snapshot && snapshot.tvl && Object.keys(snapshot.tvl).length > 0) {
    return {
      tvl: snapshot.tvl as Record<string, number>,
      volume24h: (snapshot.volume24h as Record<string, number>) || {},
      lastUpdated: (snapshot.lastUpdated as string | null) || null,
      loading: false,
      source: 'snapshot',
    };
  }
  return { tvl: {}, volume24h: {}, lastUpdated: null, loading: true, source: 'none' };
}

export function useDefiLlama(): DefiLlamaData {
  const [data, setData] = useState<DefiLlamaData>(initialData);

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      const tvl: Record<string, number> = {};
      const volume24h: Record<string, number> = {};
      let ok = false;

      try {
        const resp = await fetch(`${LLAMA_BASE}/protocols`);
        if (resp.ok) {
          const protocols = await resp.json();
          const slugMap = new Map<string, number>();
          if (Array.isArray(protocols)) {
            for (const p of protocols) {
              const v = solanaTvl(p);
              if (p?.slug && v > 0) slugMap.set(p.slug, v);
            }
          }
          for (const [name, list] of Object.entries(TVL_SLUGS)) {
            let total = 0;
            for (const slug of list) total += slugMap.get(slug) || 0;
            if (total > 0) tvl[name] = total;
          }
          ok = Object.keys(tvl).length > 0;
        }
      } catch {}

      try {
        const resp = await fetch(`${LLAMA_BASE}/overview/dexs/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`);
        if (resp.ok) {
          const dex = await resp.json();
          if (Array.isArray(dex?.protocols)) {
            for (const [name, slug] of Object.entries(DEX_SLUGS)) {
              const found = dex.protocols.find((p: any) =>
                p.name?.toLowerCase() === slug.toLowerCase() ||
                p.slug?.toLowerCase() === slug.toLowerCase() ||
                p.displayName?.toLowerCase().includes(slug.toLowerCase())
              );
              if (found && found.total24h) volume24h[name] = found.total24h;
            }
          }
        }
      } catch {}

      if (cancelled) return;

      if (ok) {
        const fresh: DefiLlamaData = { tvl, volume24h, lastUpdated: new Date().toISOString(), loading: false, source: 'live' };
        setData(fresh);
        writeCache(fresh);
      } else {
        setData(prev => ({ ...prev, loading: false }));
      }
    }

    fetchAll();
    const interval = setInterval(fetchAll, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return data;
}

// Honest provenance label for TVL figures: "Live from DeFiLlama" only after a successful fetch in
// this session, otherwise "Snapshot from DeFiLlama" with the date it was taken.
export function tvlSourceLabel(d: DefiLlamaData): string {
  if (d.source === 'live') return 'Live from DeFiLlama';
  const date = d.lastUpdated ? d.lastUpdated.slice(0, 10) : null;
  return `Snapshot from DeFiLlama${date ? `, ${date}` : ''}`;
}

export function formatTvlDisplay(tvl: number | undefined): string | null {
  if (!tvl || tvl === 0) return null;
  return formatTvl(tvl);
}

export function formatVolumeDisplay(vol: number | undefined): string | null {
  if (!vol || vol === 0) return null;
  return formatTvl(vol) + ' 24h';
}
