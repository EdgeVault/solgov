import { writeFileSync, mkdirSync } from 'node:fs';

const LLAMA_BASE = 'https://api.llama.fi';

const PROTOCOLS = {
  'Drift': ['drift-trade'],
  'Marginfi': ['marginfi-lending', 'marginfi-lst'],
  'Kamino': ['kamino-lend', 'kamino-liquidity'],
  'Jupiter Perps': ['jupiter-perpetual-exchange'],
  'Jupiter Lend': ['jupiter-lend'],
  'Orca': ['orca-dex'],
  'Loopscale': ['loopscale'],
  'Save (Solend)': ['save', 'save-sol'],
};

async function fetchProtocol(slug) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(`${LLAMA_BASE}/protocol/${slug}`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const d = await resp.json();
    return d.tvl || [];
  } finally {
    clearTimeout(timer);
  }
}

function aggregate(series) {
  const byDate = new Map();
  for (const points of series) {
    for (const p of points) {
      const existing = byDate.get(p.date) || 0;
      byDate.set(p.date, existing + (p.totalLiquidityUSD || 0));
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([date, tvl]) => ({ date, tvl: Math.round(tvl) }));
}

function downsampleWeekly(points) {
  if (points.length === 0) return [];
  const result = [];
  const WEEK = 7 * 86400;
  let lastDate = 0;
  for (const p of points) {
    if (p.date - lastDate >= WEEK) {
      result.push(p);
      lastDate = p.date;
    }
  }
  if (result[result.length - 1]?.date !== points[points.length - 1].date) {
    result.push(points[points.length - 1]);
  }
  return result;
}

async function main() {
  mkdirSync('src/data', { recursive: true });
  const out = { protocols: {}, lastUpdated: new Date().toISOString() };

  for (const [name, slugs] of Object.entries(PROTOCOLS)) {
    try {
      console.log(`[tvl] Fetching ${name} (${slugs.join(', ')})...`);
      const series = await Promise.all(slugs.map(fetchProtocol));
      const aggregated = aggregate(series);
      const downsampled = downsampleWeekly(aggregated);
      out.protocols[name] = downsampled;
      const first = downsampled[0];
      const last = downsampled[downsampled.length - 1];
      const peak = downsampled.reduce((m, p) => p.tvl > m.tvl ? p : m, downsampled[0] || { tvl: 0 });
      console.log(`  ${downsampled.length} points | first: ${new Date(first.date * 1000).toISOString().slice(0,10)} $${(first.tvl/1e6).toFixed(1)}M | peak: $${(peak.tvl/1e6).toFixed(1)}M | now: $${(last.tvl/1e6).toFixed(1)}M`);
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      out.protocols[name] = [];
    }
    await new Promise(r => setTimeout(r, 500));
  }

  writeFileSync('src/data/historical-tvl.json', JSON.stringify(out));
  const size = JSON.stringify(out).length;
  console.log(`[historical-tvl] Wrote ${Object.keys(out.protocols).length} protocols (${(size/1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error('[historical-tvl] Unexpected error:', e);
  process.exit(1);
});
