import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Slug lists are shared with src/hooks/useDefiLlama.ts so the build-time fallback covers the same
// protocols as the live fetch.
const SLUGS = JSON.parse(readFileSync(new URL('../src/data/tvl-slugs.json', import.meta.url), 'utf-8'));

const GOV_URLS = [
  'https://solgov.xyz/api/state',
  'https://api.solgov.xyz/api/state',
];

const LLAMA_BASE = 'https://api.llama.fi';

const TVL_SLUGS = SLUGS.tvl;
const DEX_SLUGS = SLUGS.dex;

// Solana share of a DefiLlama /protocols entry (same rule as solanaTvl in useDefiLlama.ts):
// chainTvls.Solana when a per-chain breakdown exists, the all-chain total only when it does not.
function solanaTvl(p) {
  const ct = p?.chainTvls;
  if (ct && typeof ct === 'object' && Object.keys(ct).length > 0) {
    return typeof ct.Solana === 'number' ? ct.Solana : 0;
  }
  return typeof p?.tvl === 'number' ? p.tvl : 0;
}

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
      const v = solanaTvl(p);
      if (p.slug && v > 0) slugMap.set(p.slug, v);
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
