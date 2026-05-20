// Per-protocol TVL hook backed by DefiLlama with a bundled snapshot as fallback.

import { useState, useEffect } from 'react';
import snapshot from '../data/llama-snapshot.json';

const LLAMA_BASE = 'https://api.llama.fi';
const CACHE_KEY = 'solgov:llama:v1';

const TVL_SLUGS: Record<string, string[]> = {
  'Orca': ['orca-dex'],
  'Drift': ['drift-trade', 'drift-staked-sol'],
  'Project 0': ['marginfi-lending', 'marginfi-lst'],
  'Kamino': ['kamino-lend', 'kamino-liquidity'],
  'Jupiter Perps': ['jupiter-perpetual-exchange'],
  'Jupiter Lend': ['jupiter-lend'],
  'Jupiter Agg': ['jupiter-staked-sol'],
  'Magic Eden': ['magic-eden'],
  'Hylo': ['hylo-protocol', 'hylo-lsts'],
  'Loopscale': ['loopscale'],
  'Exponent': ['exponent'],
  'Huma Finance': ['huma-v2'],
  'Solstice': ['solstice-usx'],
  'Pumpfun + PumpSwap': ['pumpswap', 'pump.fun'],
  'Lulo': ['lulo'],
  'Stabble': ['stabble-stableswap', 'stabble-clmm'],
  'Sanctum': ['sanctum-validator-lsts', 'sanctum-infinity', 'sanctum-reserve'],
  'Raydium': ['raydium-amm'],
  'Phoenix DEX': ['phoenix-spot'],
  'Meteora': ['meteora-dlmm', 'meteora-damm-v2', 'meteora-damm-v1', 'meteora-vaults'],
  'Parcl': ['parcl-v3', 'parcl-v2'],
  'Marinade': ['marinade-liquid-staking', 'marinade-native', 'marinade-select'],
  'Pyth': ['pyth-network'],
  'Jito': ['jito-liquid-staking', 'jito-restaking'],
  'Solayer': ['solayer-restaking', 'solayer-usd'],
  'Flash Trade': ['flashtrade'],
  'Save (Solend)': ['save', 'save-sol'],
  'Zebec': ['zebec-protocol'],
  'SolvBTC': ['solvbtc', 'solv-basis-trading'],
  'GMSOL': ['gmtrade'],
  'Carrot': ['carrot-liquidity', 'carrot-lend'],
  'DefiTuna': ['defituna-lending', 'defituna-liquidity'],
  'Onre Finance': ['onre'],
  'deBridge': ['debridge'],
  'Titan': ['titan-aggregator'],
  'Phoenix Eternal': ['phoenix-perp'],
  'Adrena': ['adrena-protocol'],
  'Bullet': ['bullet-perps'],
};

const DEX_SLUGS: Record<string, string> = {
  'Orca': 'orca',
  'Raydium': 'raydium',
  'Meteora': 'meteora',
  'Jupiter Agg': 'jupiter',
  'Phoenix DEX': 'phoenix',
  'Pumpfun + PumpSwap': 'pumpswap',
  'Stabble': 'stabble',
};

export interface DefiLlamaData {
  tvl: Record<string, number>;
  volume24h: Record<string, number>;
  lastUpdated: string | null;
  loading: boolean;
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
    return { tvl: c.tvl, volume24h: c.volume24h || {}, lastUpdated: c.lastUpdated || null, loading: false };
  } catch { return null; }
}

function writeCache(d: DefiLlamaData) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(d));
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
    };
  }
  return { tvl: {}, volume24h: {}, lastUpdated: null, loading: true };
}

export function useDefiLlama(): DefiLlamaData {
  const [data, setData] = useState<DefiLlamaData>(initialData);

  useEffect(() => {
    let cancelled = false;

    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (raw) {
          const c = JSON.parse(raw);
          if (c && c.lastUpdated) {
            const age = Date.now() - Date.parse(c.lastUpdated);
            if (age < 60 * 1000) {
              const interval = setInterval(() => fetchAll(), 10 * 60 * 1000);
              return () => { cancelled = true; clearInterval(interval); };
            }
          }
        }
      }
    } catch {}

    async function fetchAll() {
      const tvl: Record<string, number> = {};
      const volume24h: Record<string, number> = {};
      let ok = false;

      try {
        const resp = await fetch(`${LLAMA_BASE}/protocols`);
        if (resp.ok) {
          const protocols = await resp.json();
          const slugMap = new Map<string, number>();
          for (const p of protocols) {
            if (p.slug && p.tvl) slugMap.set(p.slug, p.tvl);
          }
          for (const [name, slugs] of Object.entries(TVL_SLUGS)) {
            let total = 0;
            for (const slug of slugs) total += slugMap.get(slug) || 0;
            if (total > 0) tvl[name] = total;
          }
          ok = Object.keys(tvl).length > 0;
        }
      } catch {}

      try {
        const resp = await fetch(`${LLAMA_BASE}/overview/dexs/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`);
        if (resp.ok) {
          const dex = await resp.json();
          if (dex.protocols) {
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
        const fresh: DefiLlamaData = { tvl, volume24h, lastUpdated: new Date().toISOString(), loading: false };
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

export function formatTvlDisplay(tvl: number | undefined): string | null {
  if (!tvl || tvl === 0) return null;
  return formatTvl(tvl);
}

export function formatVolumeDisplay(vol: number | undefined): string | null {
  if (!vol || vol === 0) return null;
  return formatTvl(vol) + ' 24h';
}
