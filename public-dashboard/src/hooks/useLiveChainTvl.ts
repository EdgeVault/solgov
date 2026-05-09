import { useState, useEffect } from 'react';

const CACHE_KEY = 'solgov:chain-tvl:v2';

export interface LiveChainTvl {
  solana: number | null;
  evm: number | null;
  evmChainCount: number;
  lastUpdated: string | null;
  loading: boolean;
}

function readCache(): LiveChainTvl | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (typeof c?.solana !== 'number') return null;
    return c;
  } catch { return null; }
}

function writeCache(d: LiveChainTvl) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(d));
  } catch {}
}

export function useLiveChainTvl(): LiveChainTvl {
  const [state, setState] = useState<LiveChainTvl>(() => {
    const cached = readCache();
    if (cached) return { ...cached, loading: false };
    return { solana: null, evm: null, evmChainCount: 0, lastUpdated: null, loading: true };
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      try {
        const r = await fetch('https://api.llama.fi/v2/chains');
        if (!r.ok) return;
        const chains = await r.json();
        let solana: number | null = null;
        let evmSum = 0, evmCount = 0;
        for (const c of chains) {
          if (c.name === 'Solana' && typeof c.tvl === 'number') solana = c.tvl;
          if (typeof c.chainId === 'number' && typeof c.tvl === 'number' && c.tvl > 0) {
            evmSum += c.tvl;
            evmCount += 1;
          }
        }
        if (cancelled) return;
        const fresh: LiveChainTvl = {
          solana,
          evm: evmCount > 0 ? evmSum : null,
          evmChainCount: evmCount,
          lastUpdated: new Date().toISOString(),
          loading: false,
        };
        setState(fresh);
        writeCache(fresh);
      } catch {
        if (!cancelled) setState(prev => ({ ...prev, loading: false }));
      }
    }

    fetchAll();
    const interval = setInterval(fetchAll, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return state;
}
