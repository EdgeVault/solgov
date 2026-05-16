// Adoption-over-time charts for governance practices across tracked teams (timelock, role separation, verified builds, etc.).

import { useMemo, useState, useRef } from 'react';
import type { Protocol } from '../data/protocols';
import metricHistory from '../data/metric-history.json';
import tokenCircuitBreakers from '../data/token-circuit-breakers.json';
import { connectionCount, RELATIONSHIPS } from '../data/relationships';

type ChartSpec = {
  key: string;
  title: string;
  subtitle: string;
  computeCurrent: (protocols: Protocol[]) => number;
  v4Only?: boolean;
};

const CHART_COLOUR = '#ffffff';

const CHARTS: ChartSpec[] = [
  {
    key: 'timelocks',
    title: 'Teams with a timelock',
    subtitle: "Approved transactions can't execute immediately. A waiting period gives signers a chance to review or cancel before changes land. Any non-zero delay works, tuned to each team's operational cadence.",
    computeCurrent: p => p.filter(x => x.hasTimelock).length,
    v4Only: true,
  },
  {
    key: 'role-separation',
    title: 'Teams with separated signer roles',
    subtitle: 'No single signer can do everything. Different people propose, approve and execute. Only counts multisigs where at least two signatures are required, so a 1-of-N with split roles does not qualify.',
    computeCurrent: p => p.filter(x => x.hasRoleSeparation === true && (x.threshold ?? 0) >= 2).length,
    v4Only: true,
  },
  {
    key: 'high-threshold',
    title: 'Teams needing at least half the signers to approve',
    subtitle: 'A majority of the signing group must agree before a change can go through. Excludes 1-of-N setups since they only require a single signature even when the ratio hits 50%.',
    computeCurrent: p => p.filter(x => x.threshold && x.totalMembers && x.threshold >= 2 && (x.threshold / x.totalMembers) >= 0.5).length,
  },
  {
    key: 'squads-v4',
    title: 'Teams on the modern Squads multisig',
    subtitle: 'Squads V4 is the current version. Older versions cannot support timelocks or separated signer roles.',
    computeCurrent: p => p.filter(x => x.version === 'Squads V4').length,
  },
];

function seriesFor(key: string, liveIntegrity: any): { t: number; v: number }[] {
  const liveSeries = liveIntegrity?.metricHistory?.metrics?.[key]?.series;
  const staticSeries = (metricHistory as any)?.metrics?.[key]?.series;
  const live = Array.isArray(liveSeries) && liveSeries.length > 0 ? liveSeries : null;
  const stat = Array.isArray(staticSeries) && staticSeries.length > 0 ? staticSeries : null;
  if (live && stat) {
    const liveLast = live[live.length - 1]?.t ?? 0;
    const staticLast = stat[stat.length - 1]?.t ?? 0;
    return liveLast >= staticLast ? live : stat;
  }
  return live || stat || [];
}

function formatDate(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs > 180 * 86400 * 1000) {
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  }
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
}

function TradingChart({ series, max, colour }: { series: { t: number; v: number }[]; max: number; colour: string }) {
  const width = 560;
  const height = 220;
  const padL = 40, padR = 40, padT = 12, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ t: number; v: number; x: number; y: number } | null>(null);

  if (series.length === 0) return null;
  const minTs = series[0].t;
  const maxTs = series[series.length - 1].t;
  const x = (t: number) => padL + ((t - minTs) / Math.max(maxTs - minTs, 1)) * plotW;
  const y = (v: number) => padT + (1 - v / Math.max(max, 1)) * plotH;

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * width;
    if (sx < padL || sx > width - padR) { setHover(null); return; }
    const fraction = (sx - padL) / plotW;
    const targetTs = minTs + fraction * (maxTs - minTs);
    let nearest = series[0];
    let best = Math.abs(series[0].t - targetTs);
    for (const p of series) {
      const d = Math.abs(p.t - targetTs);
      if (d < best) { best = d; nearest = p; }
    }
    setHover({ t: nearest.t, v: nearest.v, x: x(nearest.t), y: y(nearest.v) });
  }
  function handlePointerLeave() { setHover(null); }
  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    handlePointerMove(e);
  }
  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    setHover(null);
  }

  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = path + ` L${x(maxTs).toFixed(1)},${padT + plotH} L${x(minTs).toFixed(1)},${padT + plotH} Z`;

  const latest = series[series.length - 1];
  const first = series[0];
  const delta = latest.v - first.v;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: Math.round(max * f), y: padT + (1 - f) * plotH }));
  const spanMs = maxTs - minTs;
  const xTickCount = 6;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const f = i / (xTickCount - 1);
    const t = minTs + spanMs * f;
    return { t, x: padL + f * plotW };
  });

  const uid = `${colour}-${Math.random().toString(36).slice(2, 7)}`;

  const displayValue = hover ? hover.v : latest.v;
  const displayDate = hover ? new Date(hover.t) : new Date(latest.t);
  const displayLabel = displayDate.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="bg-[#0a0a0f] rounded-md">
      <div className="flex items-baseline justify-between px-4 pt-3 pb-2 border-b border-white/[0.04]">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-white tabular-nums">{displayValue}</span>
          <span className="text-[11px] text-gray-500">/ {max}</span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-[10px] text-gray-500 tabular-nums">{displayLabel}</span>
          <span className="text-sm font-medium tabular-nums text-gray-300">
            {delta > 0 ? '+' : ''}{delta}
          </span>
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full cursor-crosshair"
        style={{ touchAction: 'none' }}
        preserveAspectRatio="none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerUp}
      >
        <defs>
          <linearGradient id={`fill-${uid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity="0.3" />
            <stop offset="100%" stopColor={colour} stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.04)" strokeWidth="1" strokeDasharray="2,4" />
            <text x={padL - 6} y={t.y + 3} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize="10" className="tabular-nums">{t.v}</text>
            <text x={width - padR + 6} y={t.y + 3} textAnchor="start" fill="rgba(255,255,255,0.45)" fontSize="10" className="tabular-nums">{t.v}</text>
          </g>
        ))}

        {xTicks.map((t, i) => (
          i > 0 && i < xTicks.length - 1 ? (
            <line key={i} x1={t.x} x2={t.x} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
          ) : null
        ))}

        <path d={area} fill={`url(#fill-${uid})`} />
        <path d={path} stroke={colour} strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round" />

        {!hover && (
          <>
            <line x1={x(latest.t)} x2={x(latest.t)} y1={padT} y2={padT + plotH} stroke={colour} strokeOpacity="0.3" strokeWidth="1" strokeDasharray="2,3" />
            <circle cx={x(latest.t)} cy={y(latest.v)} r="4" fill={colour} stroke="#0a0a0f" strokeWidth="2" />
          </>
        )}

        {hover && (
          <g>
            <line x1={hover.x} x2={hover.x} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="3,3" />
            <line x1={padL} x2={width - padR} y1={hover.y} y2={hover.y} stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeDasharray="3,3" />
            <circle cx={hover.x} cy={hover.y} r="4" fill={colour} stroke="#0a0a0f" strokeWidth="2" />
            <rect x={width - padR + 2} y={hover.y - 8} width={30} height={16} fill="#fff" rx="2" />
            <text x={width - padR + 17} y={hover.y + 3} textAnchor="middle" fill="#0a0a0f" fontSize="10" fontWeight="600" className="tabular-nums">{hover.v}</text>
          </g>
        )}

        <line x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        <line x1={padL} x2={padL} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        <line x1={width - padR} x2={width - padR} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.12)" strokeWidth="1" />

        {!hover && (
          <g>
            <rect x={width - padR + 2} y={y(latest.v) - 8} width={30} height={16} fill={colour} rx="2" />
            <text x={width - padR + 17} y={y(latest.v) + 3} textAnchor="middle" fill="#0a0a0f" fontSize="10" fontWeight="600" className="tabular-nums">{latest.v}</text>
          </g>
        )}

        {xTicks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={padT + plotH + 14}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fill="rgba(255,255,255,0.45)"
            fontSize="10"
            className="tabular-nums"
          >
            {formatDate(t.t, spanMs)}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function GovernanceCharts({ protocols, liveIntegrity, liveActivity }: { protocols: Protocol[]; liveIntegrity?: any; liveActivity?: any[] }) {
  const total = protocols.length;
  const v4Count = protocols.filter(p => p.version === 'Squads V4').length;

  const data = useMemo(() => CHARTS.map(c => {
    const current = c.computeCurrent(protocols);
    const denominator = c.v4Only ? v4Count : total;
    const histSeries = seriesFor(c.key, liveIntegrity);
    // Append a live "now" point so the chart's right edge reflects current
    // on-chain state, not whatever was last in the static metric history file.
    const series = [...histSeries, { t: Date.now(), v: current }];
    return { ...c, current, denominator, series };
  }), [protocols, v4Count, total, liveIntegrity]);

  return (
    <>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white mb-1">Governance Charts</h2>
        <p className="text-xs text-gray-500">
          Adoption of governance practices across tracked teams. Each chart's historical dates come from on-chain events that can be verified for every team.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.map(d => (
          <div key={d.key} className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <h3 className="text-[11px] font-semibold text-white uppercase tracking-wider">{d.title}</h3>
              {d.v4Only && (
                <span className="text-[9px] px-1.5 py-0.5 rounded border text-gray-400 border-white/[0.12] bg-white/[0.04] tracking-wider">V4 ONLY</span>
              )}
            </div>
            <p className="text-[11px] text-gray-500 px-4 pb-2 min-h-[2.5em]">{d.subtitle}</p>
            <TradingChart series={d.series} max={d.denominator} colour={CHART_COLOUR} />
          </div>
        ))}
      </div>

      <CurrentStateBars protocols={protocols} liveIntegrity={liveIntegrity} liveActivity={liveActivity} />

      <div className="mt-6 p-3 rounded-lg border border-white/[0.04] bg-white/[0.01]">
        <p className="text-[11px] text-gray-500">
          Methodology: current counts come from live on-chain reads of each tracked multisig and protocol-issued token. Historical adoption dates come from the earliest on-chain activity that can be verified for each multisig. Each chart's ceiling is the number of tracked teams that could express the metric.
        </p>
      </div>
    </>
  );
}

type BarSpec = {
  key: string;
  count: number;
  total: number;
  label: string;
  description: string;
};

function RiskBars({ bars }: { bars: BarSpec[] }) {
  return (
    <div className="space-y-3">
      {bars.map(b => {
        const pct = b.total > 0 ? (b.count / b.total) * 100 : 0;
        return (
          <div key={b.key} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-center gap-4">
              <div className="w-20 flex-shrink-0 text-right">
                <span className="text-2xl font-semibold tabular-nums text-white">{b.count}</span>
                <span className="text-[10px] text-gray-500 ml-1">/{b.total}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="h-4 bg-black/40 border border-white/[0.08] rounded-sm overflow-hidden">
                  {b.count > 0 && (
                    <div className="h-full bg-white" style={{ width: `${pct}%` }} />
                  )}
                </div>
                <div className="mt-1.5 text-[11px] font-medium text-white">{b.label}</div>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-gray-400">{b.description}</div>
          </div>
        );
      })}
    </div>
  );
}

function CurrentStateBars({ protocols, liveIntegrity, liveActivity }: { protocols: Protocol[]; liveIntegrity?: any; liveActivity?: any[] }) {
  const totalProtocols = protocols.length;
  const tokens = (liveIntegrity?.tokenAuthorities as any[]) || (tokenCircuitBreakers as any).results || [];
  const totalTokens = tokens.length;

  const now = Date.now();
  const thirtyDaysMs = 30 * 86400 * 1000;
  const recentFromLive = new Set<string>();
  if (Array.isArray(liveActivity)) {
    for (const ev of liveActivity) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type !== 'ProgramUpgrade') continue;
      const t = Date.parse(ev.timestamp || ev.date);
      if (!isNaN(t) && now - t <= thirtyDaysMs) recentFromLive.add(ev.protocol);
    }
  }
  const recentUpgrades = protocols.filter(p => {
    if (recentFromLive.has(p.name)) return true;
    if (!p.lastUpgrade) return false;
    const t = Date.parse(p.lastUpgrade);
    return !isNaN(t) && now - t <= thirtyDaysMs;
  }).length;

  const externalCa = protocols.filter(p => {
    const ca = (p as any).configAuthority;
    if (!ca) return false;
    return ca !== 'autonomous' && ca !== '11111111111111111111111111111111' && typeof ca === 'string' && ca.length > 20;
  }).length;

  const singleSigner = protocols.filter(p => p.version === 'Single Signer').length;
  const meetsSquadsRec = protocols.filter(p => {
    if (!p.threshold || !p.totalMembers) return false;
    return p.threshold >= 4 && (p.threshold / p.totalMembers) >= 0.67;
  }).length;

  const allKnown = new Set<string>(Object.keys(RELATIONSHIPS));
  for (const rels of Object.values(RELATIONSHIPS)) for (const r of rels) allKnown.add(r.protocol);
  const hubCount = [...allKnown].filter(name => connectionCount(name) >= 5).length;
  const token2022 = tokens.filter((t: any) => t.isToken2022).length;
  const transferHook = tokens.filter((t: any) => t.hasTransferHook).length;
  const cbWrapped = tokens.filter((t: any) => t.circuitBreakerWrapped).length;
  const kelpClass = tokens.filter((t: any) => t.mintAuthority?.type === 'spl-multisig' && t.mintAuthority.m === 1).length;
  const freezeAuth = tokens.filter((t: any) => t.freezeAuthority?.type && t.freezeAuthority.type !== 'null').length;
  const renounced = tokens.filter((t: any) => t.mintAuthority?.type === 'null').length;

  const bars: BarSpec[] = [
    {
      key: 'transfer-hook',
      count: transferHook,
      total: totalTokens,
      label: 'Tokens with an active transfer hook',
      description: 'Transfer hooks run on every transfer regardless of which function called it. Counted when a hook program is set (non-null programId). Tokens with the extension initialised but no hook program set do not count.',
    },
    {
      key: 'token-2022',
      count: token2022,
      total: totalTokens,
      label: 'Tokens using Token-2022',
      description: 'Token-2022 is the only token standard that supports transfer hooks.',
    },
    {
      key: 'circuit-breaker-wrapped',
      count: cbWrapped,
      total: totalTokens,
      label: "Mint authorities wrapped by Helium's open-source circuit breaker",
      description: 'Mint authority is set to a PDA of the Helium circuit-breaker program (circAbx64...). The program enforces rate-limit rules on every mint, so a compromised protocol authority cannot skip them. Audited by Sec3 and open-source since 2023.',
    },
    {
      key: 'kelp-class-mint',
      count: kelpClass,
      total: totalTokens,
      label: 'Tokens with a threshold-1 SPL Multisig mint authority',
      description: 'The SPL Token Multisig has N signers but only 1 is required to approve. Any one of the N keys can mint unilaterally.',
    },
    {
      key: 'single-signer',
      count: singleSigner,
      total: totalProtocols,
      label: 'Programs controlled by one key',
      description: 'One person can push a new version of the program at any time. No committee, no timelock, no review window.',
    },
    {
      key: 'squads-recommendation',
      count: meetsSquadsRec,
      total: totalProtocols,
      label: "Teams meeting Squads' threshold recommendation",
      description: 'Squads best practice: at least 4 signers with at least 67% approval threshold. Only counts the "Above" case in the main table, not Partial. Different governance models (Pythian Council, Wormhole Guardians, Realms DAO, Single Signer) are not Squads multisigs and are not directly comparable to this recommendation.',
    },
    {
      key: 'connection-hubs',
      count: hubCount,
      total: totalProtocols,
      label: 'Protocols with 5 or more known connections',
      description: 'Upstream plus downstream relationships (oracle, collateral, routing, settlement, lending), deduplicated. Sourced from the blast-radius dependency map. Mix of on-chain, docs and news verification. Edges can be stale if a listing or integration changes and the map has not been refreshed.',
    },
    {
      key: 'recent-upgrades',
      count: recentUpgrades,
      total: totalProtocols,
      label: 'Protocols with a program upgrade in the last 30 days',
      description: 'Latest program upgrade date within the 30-day window. Reflects active maintenance cadence, separate from whether those upgrades went through the multisig or were single-signer.',
    },
    {
      key: 'external-ca',
      count: externalCa,
      total: totalProtocols,
      label: 'Multisigs with an external config authority set',
      description: 'A Squads "Controlled Multisig". A single external key can change threshold, members or timelock on the multisig without going through a vote. Squads documents this as not recommended for most use cases.',
    },
    {
      key: 'freeze-authority',
      count: freezeAuth,
      total: totalTokens,
      label: 'Tokens with a freeze authority',
      description: 'Mechanism to halt transfers in an emergency. Enables both incident response and censorship.',
    },
    {
      key: 'renounced',
      count: renounced,
      total: totalTokens,
      label: 'Tokens with renounced mint authority',
      description: 'Supply is permanently fixed. No mint key exists.',
    },
  ];

  return (
    <div className="mt-6">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-white mb-1">Current state</h2>
        <p className="text-xs text-gray-500">
          Counts across tracked teams and protocol-issued tokens for practices that came into focus after recent high-profile incidents. Each row shows the count and a short description of what the metric measures.
        </p>
      </div>
      <RiskBars bars={bars} />
    </div>
  );
}
