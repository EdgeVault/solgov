import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const GOV_URLS = [
  'https://solgov.xyz/api/state',
  'https://api.solgov.xyz/api/state',
];

const LLAMA_BASE = 'https://api.llama.fi';

const TVL_SLUGS = {
  'Orca': ['orca-dex'], 'Drift': ['drift-trade', 'drift-staked-sol'],
  'Marginfi': ['marginfi-lending', 'marginfi-lst'], 'Kamino': ['kamino-lend', 'kamino-liquidity'],
  'Jupiter Perps': ['jupiter-perpetual-exchange'], 'Jupiter Lend': ['jupiter-lend'],
  'Jupiter Agg': ['jupiter-staked-sol'], 'Magic Eden': ['magic-eden'],
  'Hylo': ['hylo-protocol', 'hylo-lsts'], 'Loopscale': ['loopscale'],
  'Exponent': ['exponent'], 'Huma Finance': ['huma-v2'],
  'Solstice': ['solstice-usx'], 'Pumpfun + PumpSwap': ['pumpswap', 'pump.fun'],
  'Lulo': ['lulo'], 'Stabble': ['stabble-stableswap', 'stabble-clmm'],
  'Sanctum': ['sanctum-validator-lsts', 'sanctum-infinity', 'sanctum-reserve'],
  'Raydium': ['raydium-amm'], 'Phoenix DEX': ['phoenix-spot'],
  'Meteora': ['meteora-dlmm', 'meteora-damm-v2', 'meteora-damm-v1', 'meteora-vaults'],
  'Parcl': ['parcl-v3', 'parcl-v2'],
  'Marinade': ['marinade-liquid-staking', 'marinade-native', 'marinade-select'],
  'Pyth': ['pyth-network'], 'Jito': ['jito-liquid-staking', 'jito-restaking'],
  'Solayer': ['solayer-restaking', 'solayer-usd'], 'Flash Trade': ['flashtrade'],
  'Save (Solend)': ['save', 'save-sol'], 'Zebec': ['zebec-protocol'],
  'SolvBTC': ['solvbtc', 'solv-basis-trading'], 'GMSOL': ['gmtrade'],
  'Carrot': ['carrot-liquidity', 'carrot-lend'],
  'DefiTuna': ['defituna-lending', 'defituna-liquidity'],
};

const DEX_SLUGS = {
  'Orca': 'orca', 'Raydium': 'raydium', 'Meteora': 'meteora',
  'Jupiter Agg': 'jupiter', 'Phoenix DEX': 'phoenix',
  'Pumpfun + PumpSwap': 'pumpswap', 'Stabble': 'stabble',
};

async function fetchWithTimeout(url, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGovernance() {
  for (const url of GOV_URLS) {
    try {
      console.log(`[gov] Fetching ${url}...`);
      const data = await fetchWithTimeout(url);
      console.log(`[gov] Success: ${Object.keys(data).length} keys`);
      return data;
    } catch (e) {
      console.log(`[gov] Failed ${url}: ${e.message}`);
    }
  }
  return {};
}

async function fetchDefiLlama() {
  const tvl = {};
  const volume24h = {};

  try {
    console.log(`[tvl] Fetching DeFiLlama protocols...`);
    const protocols = await fetchWithTimeout(`${LLAMA_BASE}/protocols`);
    const slugMap = new Map();
    for (const p of protocols) {
      if (p.slug && p.tvl) slugMap.set(p.slug, p.tvl);
    }
    for (const [name, slugs] of Object.entries(TVL_SLUGS)) {
      let total = 0;
      for (const slug of slugs) total += slugMap.get(slug) || 0;
      if (total > 0) tvl[name] = total;
    }
    console.log(`[tvl] Loaded TVL for ${Object.keys(tvl).length} protocols`);
  } catch (e) {
    console.log(`[tvl] Failed: ${e.message}`);
  }

  try {
    console.log(`[vol] Fetching DEX volumes...`);
    const dexData = await fetchWithTimeout(
      `${LLAMA_BASE}/overview/dexs/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`
    );
    if (dexData.protocols) {
      for (const [name, slug] of Object.entries(DEX_SLUGS)) {
        const found = dexData.protocols.find((p) =>
          p.name?.toLowerCase() === slug.toLowerCase() ||
          p.slug?.toLowerCase() === slug.toLowerCase() ||
          p.displayName?.toLowerCase().includes(slug.toLowerCase())
        );
        if (found && found.total24h) volume24h[name] = found.total24h;
      }
    }
    console.log(`[vol] Loaded volume for ${Object.keys(volume24h).length} protocols`);
  } catch (e) {
    console.log(`[vol] Failed: ${e.message}`);
  }

  return { tvl, volume24h };
}

async function main() {
  mkdirSync('src/data', { recursive: true });

  const [gov, llama] = await Promise.all([fetchGovernance(), fetchDefiLlama()]);

  const governance = { ...gov, _snapshotTakenAt: new Date().toISOString() };
  const defillama = { ...llama, lastUpdated: new Date().toISOString() };

  writeFileSync('src/data/live-snapshot.json', JSON.stringify(governance, null, 2));
  writeFileSync('src/data/llama-snapshot.json', JSON.stringify(defillama, null, 2));

  console.log(`[snapshot] Done. Wrote governance + DeFiLlama snapshots.`);
}

main().catch((e) => {
  console.error('[snapshot] Unexpected error:', e);
  writeFileSync('src/data/live-snapshot.json', JSON.stringify({ _snapshotTakenAt: new Date().toISOString() }, null, 2));
  writeFileSync('src/data/llama-snapshot.json', JSON.stringify({ tvl: {}, volume24h: {}, lastUpdated: null }, null, 2));
  process.exit(0);
});
