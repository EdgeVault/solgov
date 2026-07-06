// Solana vs EVM aggregate risk panel: TVL, yield rate, loss rate, exploit techniques.

import { useRef, useState } from 'react';
import snapshot from '../data/chain-risk-snapshot.json';
import solHacksData from '../data/solana-hacks.json';
import evmHacksData from '../data/evm-hacks.json';
import { TechniquePie } from './TechniquePie';
import { Tooltip, InfoIcon } from './Tooltip';
import { useLiveChainTvl } from '../hooks/useLiveChainTvl';
import { displayName } from '../data/displayNames';

function formatUsd(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function formatPct(r: number): string {
  return (r * 100).toFixed(2) + '%';
}

function formatRatio(r: number | null): string {
  if (r == null) return 'n/a';
  if (r >= 100) return r.toFixed(0) + 'x';
  return r.toFixed(1) + 'x';
}

type SeriesPoint = { date: string; avgTvl: number; yieldPaid: number; grossLoss: number; yieldRate: number; lossRate: number };

type ChainRow = {
  avgTvl: number;
  yieldPaid1y: number;
  grossLoss1y: number;
  hackCount1y: number;
  fullRecoveryCount1y: number;
  partialRecoveryCount1y: number;
  noRecoveryCount1y: number;
  yieldRate: number;
  lossRate: number;
  yieldToLossRatio: number | null;
  series: SeriesPoint[];
};

function ChainColumn({ name, row, subtitle, liveTvl }: { name: string; row: ChainRow; subtitle: string; liveTvl: number | null }) {
  return (
    <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md">
      <div className="px-4 pt-3 pb-2 border-b border-white/[0.04] flex items-baseline justify-between">
        <div className="text-sm font-semibold text-white">{name}</div>
        <div className="text-[10px] text-gray-500">{subtitle}</div>
      </div>
      <div className="p-4 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center">
            Capital at risk
            <Tooltip text="Total Value Locked across all DeFi protocols on this chain (or across all EVM chains for the EVM aggregate). The headline shows current live TVL from DefiLlama; the 12-month average below is used as the denominator for yield rate and loss rate calculations."><InfoIcon /></Tooltip>
          </div>
          <div className="text-xl font-semibold text-white tabular-nums">{liveTvl !== null ? formatUsd(liveTvl) : formatUsd(row.avgTvl)}</div>
          <div className="text-[10px] text-gray-600">{liveTvl !== null ? 'current TVL, live' : 'avg TVL, trailing 365d'}</div>
          {liveTvl !== null && (
            <div className="text-[10px] text-gray-500 mt-1 pt-1 border-t border-white/[0.04] tabular-nums">
              <span className="text-gray-600">12mo avg: </span>{formatUsd(row.avgTvl)}<span className="text-gray-600"> (rate denominator)</span>
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center">
            Yield paid to suppliers
            <Tooltip text="Supply-side revenue paid to LPs, depositors and suppliers over the last 365 days. From DefiLlama's fees adapter (dataType=dailySupplySideRevenue). Does not include protocol treasury fees or token emissions."><InfoIcon /></Tooltip>
          </div>
          <div className="text-xl font-semibold text-white tabular-nums">{formatUsd(row.yieldPaid1y)}</div>
          <div className="text-[10px] text-gray-600">last 365d</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center">
            Gross stolen
            <Tooltip text="Gross amount stolen across tracked DeFi exploits in the trailing 365 days. Before recoveries. Curated from rekt.news, protocol post-mortems and public disclosures. Excludes CEX compromises, wallet drainers and incidents under $5M."><InfoIcon /></Tooltip>
          </div>
          <div className="text-xl font-semibold text-white tabular-nums">{formatUsd(row.grossLoss1y)}</div>
          <div className="text-[10px] text-gray-600">{row.hackCount1y} incident{row.hackCount1y === 1 ? '' : 's'}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center">
            Recovery status
            <Tooltip text="Count of incidents in this window by recovery outcome. Full = users made whole (e.g. Wormhole Jump backstop, Euler attacker return). Partial = some portion returned. None = no direct user recovery. Recovery dollar amounts vary too widely in quality to subtract cleanly (FTX claim tokens, future-fee-share, credit facilities, etc.) so the count is surfaced instead."><InfoIcon /></Tooltip>
          </div>
          <div className="text-xl font-semibold text-white tabular-nums">
            {row.fullRecoveryCount1y}<span className="text-gray-600 text-sm"> / </span>{row.partialRecoveryCount1y}<span className="text-gray-600 text-sm"> / </span>{row.noRecoveryCount1y}
          </div>
          <div className="text-[10px] text-gray-600">full / partial / none</div>
        </div>
      </div>
      <div className="px-4 pb-4 pt-2 border-t border-white/[0.04] grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center">
            Avg yield rate
            <Tooltip text="Yield paid to suppliers over the last 365 days divided by the 12-month average TVL. A realised-return rate over the window, not a live APY. For venues where live APYs are available, see the Live APY column in the venue table below."><InfoIcon /></Tooltip>
          </div>
          <div className="text-lg font-semibold text-white tabular-nums">{formatPct(row.yieldRate)}</div>
          <div className="text-[10px] text-gray-600">yield paid / avg TVL (12mo)</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center">
            Loss rate
            <Tooltip text="Gross amount stolen in the last 365 days divided by the 12-month average TVL. Dollar recoveries are not subtracted; per-incident recovery status is shown categorically in the Recovery card."><InfoIcon /></Tooltip>
          </div>
          <div className="text-lg font-semibold text-white tabular-nums">{formatPct(row.lossRate)}</div>
          <div className="text-[10px] text-gray-600">gross stolen / avg TVL</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center">
            Yield vs losses
            <Tooltip text="Yield paid to suppliers divided by gross stolen over the same 12 months. Higher number = more dollars paid to suppliers per dollar lost to exploits. A 20x ratio means the ecosystem paid out 20x more to LPs than was stolen; a 5x ratio is much tighter."><InfoIcon /></Tooltip>
          </div>
          <div className="text-lg font-semibold text-white tabular-nums">{formatRatio(row.yieldToLossRatio)}</div>
          <div className="text-[10px] text-gray-600">yield / gross stolen (higher = more yield per $ lost)</div>
        </div>
      </div>
    </div>
  );
}

type Metric = 'yieldRate' | 'lossRate';

type Venue = {
  name: string;
  avgTvl: number;
  latestTvl: number;
  yieldPaid1y: number | null;
  grossLoss1y: number;
  hackCount1y: number;
  yieldRate: number | null;
  lossRate: number;
  yieldToLossRatio: number | null;
  liveApy: {
    minApy: number;
    maxApy: number;
    topApy: number;
    topSymbol: string;
    topPoolTvl: number;
    poolCount: number;
  } | null;
  cascadeExposure: Array<{ incident: string; date: string }>;
  allHacksFullyRecovered: boolean;
  launchDate: string | null;
  ageYears: number | null;
  allTime: {
    avgTvl: number;
    yieldPaid: number | null;
    grossLoss: number;
    hackCount: number;
    yieldRate: number | null;
    lossRateAnnualised: number;
  } | null;
};

function formatAge(years: number | null): string {
  if (years === null) return '?';
  if (years < 1) return (years * 12).toFixed(0) + 'mo';
  return years.toFixed(1) + 'y';
}

function VenueTable({ venues }: { venues: Venue[] }) {
  const [mode, setMode] = useState<'12mo' | 'alltime'>('12mo');

  return (
    <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md overflow-hidden">
      <div className="flex gap-1 px-3 pt-2 pb-1 border-b border-white/[0.04]">
        {([
          { id: '12mo', label: 'Trailing 12mo' },
          { id: 'alltime', label: 'All time' },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setMode(t.id)}
            className={`px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider rounded transition-colors cursor-pointer ${
              mode === t.id
                ? 'bg-white/[0.08] text-white'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-[10px] text-gray-500 uppercase tracking-wider">
            <tr className="border-b border-white/[0.04]">
              <th className="text-left px-4 py-2.5 font-normal">Venue</th>
              <th className="text-right px-4 py-2.5 font-normal">
                <span className="inline-flex items-center justify-end w-full">
                  Age
                  <Tooltip text="Time since the first DefiLlama TVL data point for the protocol. Venues under 12 months are highlighted; their trailing-12mo figures include fewer data points than mature venues."><InfoIcon /></Tooltip>
                </span>
              </th>
              <th className="text-right px-4 py-2.5 font-normal">
                <span className="inline-flex items-center justify-end w-full">Avg TVL</span>
              </th>
              <th className="text-right px-4 py-2.5 font-normal">
                <span className="inline-flex items-center justify-end w-full">
                  Yield paid
                  <Tooltip text="Supply-side revenue from DefiLlama fees adapter where built, DefiLlama yields API where not, or the protocol's own live API / published APY. Source per venue noted in methodology."><InfoIcon /></Tooltip>
                </span>
              </th>
              <th className="text-right px-4 py-2.5 font-normal">
                <span className="inline-flex items-center justify-end w-full">
                  Gross stolen
                  <Tooltip text="Direct hacks only. Cascade exposure (being listed as a downstream victim) is shown as a badge on the venue name, not as a dollar figure, to avoid double-counting the upstream loss."><InfoIcon /></Tooltip>
                </span>
              </th>
              <th className="text-right px-4 py-2.5 font-normal">
                <span className="inline-flex items-center justify-end w-full">Avg yield rate</span>
              </th>
              <th className="text-right px-4 py-2.5 font-normal">
                <span className="inline-flex items-center justify-end w-full">
                  Live APY
                  <Tooltip text="Current APY range across the venue's depositor-relevant pools. Pulled live from Kamino and Lulo native APIs where available, DefiLlama yields API otherwise. n/a = no live feed available."><InfoIcon /></Tooltip>
                </span>
              </th>
              <th className="text-right px-4 py-2.5 font-normal">
                <span className="inline-flex items-center justify-end w-full">
                  Loss rate
                  <Tooltip text="A 'recovered' badge next to a loss rate indicates the incidents in the window were fully recovered (net loss to users was zero even though gross loss is the figure shown)."><InfoIcon /></Tooltip>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {venues.map((v, i) => {
              const source = mode === 'alltime' && v.allTime ? v.allTime : null;
              const avgTvl = source ? source.avgTvl : v.avgTvl;
              const yieldPaid = source ? source.yieldPaid : v.yieldPaid1y;
              const grossLoss = source ? source.grossLoss : v.grossLoss1y;
              const yieldRate = source ? source.yieldRate : v.yieldRate;
              const lossRate = source ? source.lossRateAnnualised : v.lossRate;
              const youngFlag = v.ageYears !== null && v.ageYears < 1;
              return (
                <tr key={i} className="border-b border-white/[0.04] last:border-b-0">
                  <td className="px-4 py-2.5 text-white">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{displayName(v.name)}</span>
                      {v.cascadeExposure && v.cascadeExposure.length > 0 && v.cascadeExposure.map((ce, j) => (
                        <span
                          key={j}
                          className="text-[9px] px-1.5 py-0.5 rounded border border-orange-300/20 bg-orange-300/[0.04] text-orange-200/70 uppercase tracking-wider whitespace-nowrap"
                          title={`Listed in ${ce.incident} cascade (${ce.date}). Specific dollar loss not publicly disclosed; included in primary incident's gross figure.`}
                        >
                          {ce.incident} cascade
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-400 tabular-nums">
                    <span className={youngFlag ? 'text-orange-300/70' : ''}>{formatAge(v.ageYears)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">{formatUsd(avgTvl)}</td>
                  <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">
                    {yieldPaid !== null ? formatUsd(yieldPaid) : <span className="text-gray-600 italic">not tracked</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">
                    {grossLoss > 0 ? formatUsd(grossLoss) : <span className="text-gray-600">-</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">
                    {yieldRate !== null ? formatPct(yieldRate) : <span className="text-gray-600">n/a</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">
                    {v.liveApy !== null ? (
                      v.liveApy.minApy === v.liveApy.maxApy
                        ? formatPct(v.liveApy.minApy)
                        : `${formatPct(v.liveApy.minApy)} – ${formatPct(v.liveApy.maxApy)}`
                    ) : <span className="text-gray-600">n/a</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">
                    <div className="flex items-center justify-end gap-1.5">
                      <span>{formatPct(lossRate)}</span>
                      {v.allHacksFullyRecovered && lossRate > 0 && (
                        <Tooltip text="Gross figure; all incidents in this window were fully recovered (net loss to users was zero)">
                          <span className="text-[9px] px-1.5 py-0.5 rounded border border-white/[0.08] bg-white/[0.04] text-gray-400 uppercase tracking-wider whitespace-nowrap">
                            recovered
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-white/[0.04] text-[10px] text-gray-500 min-h-[2em]">
        {mode === 'alltime'
          ? 'All-time rates are normalised per year of operation. Yield extrapolated from current rate; loss rate = total gross losses / (avg TVL × years).'
          : 'Trailing 12 months. Toggle to "All time" above to see each venue normalised per year since its launch.'}
      </div>
    </div>
  );
}

function RollingChart({ metric, title, sol, evm }: { metric: Metric; title: string; sol: SeriesPoint[]; evm: SeriesPoint[] }) {
  const width = 560;
  const height = 220;
  const padL = 44, padR = 44, padT = 12, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ t: number; solVal: number; evmVal: number; x: number; solY: number; evmY: number } | null>(null);

  const allPoints = [...sol, ...evm];
  const minTs = Math.min(...allPoints.map(p => new Date(p.date).getTime()));
  const maxTs = Math.max(...allPoints.map(p => new Date(p.date).getTime()));
  const maxVal = Math.max(...allPoints.map(p => p[metric]));

  const x = (d: string | number) => padL + (((typeof d === 'string' ? new Date(d).getTime() : d) - minTs) / Math.max(maxTs - minTs, 1)) * plotW;
  const y = (v: number) => padT + (1 - v / Math.max(maxVal, 1e-9)) * plotH;
  const linePath = (pts: SeriesPoint[]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p[metric]).toFixed(1)}`).join(' ');

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * width;
    if (sx < padL || sx > width - padR) { setHover(null); return; }
    const fraction = (sx - padL) / plotW;
    const targetTs = minTs + fraction * (maxTs - minTs);
    const nearestIn = (pts: SeriesPoint[]) => {
      let best = pts[0], bestD = Math.abs(new Date(pts[0].date).getTime() - targetTs);
      for (const p of pts) {
        const d = Math.abs(new Date(p.date).getTime() - targetTs);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    };
    const solN = nearestIn(sol);
    const evmN = nearestIn(evm);
    const useT = new Date(solN.date).getTime();
    setHover({
      t: useT,
      solVal: solN[metric],
      evmVal: evmN[metric],
      x: x(useT),
      solY: y(solN[metric]),
      evmY: y(evmN[metric]),
    });
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

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: maxVal * f, y: padT + (1 - f) * plotH }));
  const years = Array.from(new Set(allPoints.map(p => p.date.slice(0, 4)))).sort();

  const latestSol = sol[sol.length - 1];
  const latestEvm = evm[evm.length - 1];
  const displayDate = hover ? new Date(hover.t) : new Date(latestSol.date);
  const displayLabel = displayDate.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  const displaySol = hover ? hover.solVal : latestSol[metric];
  const displayEvm = hover ? hover.evmVal : latestEvm[metric];

  return (
    <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md">
      <div className="px-4 pt-3 pb-2 border-b border-white/[0.04]">
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-semibold text-white">{title}</div>
          <div className="text-[10px] text-gray-500 tabular-nums">{displayLabel}</div>
        </div>
        <div className="flex items-baseline gap-4 mt-1">
          <div className="flex items-baseline gap-1.5">
            <span className="inline-block w-2.5 border-t border-white mb-[3px]" />
            <span className="text-[10px] text-gray-500">Solana</span>
            <span className="text-sm font-semibold text-white tabular-nums">{formatPct(displaySol)}</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="inline-block w-2.5 border-t border-gray-500 border-dashed mb-[3px]" />
            <span className="text-[10px] text-gray-500">EVM</span>
            <span className="text-sm font-semibold text-gray-300 tabular-nums">{formatPct(displayEvm)}</span>
          </div>
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
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={width - padR} y2={t.y} stroke="rgba(255,255,255,0.04)" strokeDasharray="2,4" />
            <text x={padL - 6} y={t.y + 3} fontSize="10" fill="rgba(255,255,255,0.35)" textAnchor="end">{formatPct(t.v)}</text>
            <text x={width - padR + 6} y={t.y + 3} fontSize="10" fill="rgba(255,255,255,0.35)" textAnchor="start">{formatPct(t.v)}</text>
          </g>
        ))}
        {years.map((yr, i) => {
          const ts = new Date(yr + '-01-01').getTime();
          if (ts < minTs || ts > maxTs) return null;
          const xp = padL + ((ts - minTs) / Math.max(maxTs - minTs, 1)) * plotW;
          return (
            <text key={i} x={xp} y={height - 10} fontSize="10" fill="rgba(255,255,255,0.45)" textAnchor="middle">{yr}</text>
          );
        })}
        <path d={linePath(sol)} fill="none" stroke="#ffffff" strokeWidth="1.5" />
        <path d={linePath(evm)} fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeDasharray="3 3" />

        {hover && (
          <g>
            <line x1={hover.x} x2={hover.x} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.35)" strokeDasharray="3,3" />
            <circle cx={hover.x} cy={hover.solY} r="4" fill="#ffffff" stroke="#0a0a0f" strokeWidth="2" />
            <circle cx={hover.x} cy={hover.evmY} r="4" fill="#9ca3af" stroke="#0a0a0f" strokeWidth="2" />
          </g>
        )}

        <line x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} stroke="rgba(255,255,255,0.12)" />
        <line x1={padL} x2={padL} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.12)" />
        <line x1={width - padR} x2={width - padR} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.12)" />
      </svg>
    </div>
  );
}

export function ChainRiskPanel() {
  const sol = snapshot.chains.Solana as ChainRow;
  const evm = snapshot.chains.EVM as ChainRow;
  const evmSubtitle = snapshot.methodology.evmChains.join(', ');
  const venues = (snapshot as any).venues as Venue[] | undefined;
  const [showMethodology, setShowMethodology] = useState(false);
  const liveTvl = useLiveChainTvl();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">DeFi context: Solana vs EVM</h2>
        <p className="text-[11px] text-gray-500 mb-4">
          Capital at risk, yield paid to suppliers, and gross losses to exploits. Snapshot covers the trailing {snapshot.windowDays} days. Chart below shows the same rates rolling month by month. Updated {snapshot.updatedAt}.
        </p>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Trailing 12 months</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ChainColumn name="Solana" row={sol} subtitle="" liveTvl={liveTvl.solana} />
          <ChainColumn name="EVM" row={evm} subtitle={liveTvl.evmChainCount > 0 ? `all EVM chains tracked by DefiLlama` : evmSubtitle} liveTvl={liveTvl.evm} />
        </div>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">How the trailing 12-month rates have shifted, month by month</div>
        <p className="text-[10px] text-gray-600 mb-3">Each point is the trailing-12-month rate as of that month. The rightmost point matches the trailing 12-month snapshot above.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RollingChart metric="yieldRate" title="Avg yield rate (yield paid / avg TVL)" sol={sol.series} evm={evm.series} />
          <RollingChart metric="lossRate" title="Loss rate (gross stolen / avg TVL)" sol={sol.series} evm={evm.series} />
        </div>
      </div>

      {venues && venues.length > 0 && (
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Solana venues used for RWA deposits</div>
          <p className="text-[10px] text-gray-600 mb-3">Where yield-bearing RWAs (eUSX, ACRED, USDY, BUIDL) are deposited on Solana. Trailing 12 months. Some newer venues (Solstice, Huma, Lulo) have no DefiLlama fees adapter yet; their avg yield rate uses the protocol's own disclosed APY.</p>
          <VenueTable venues={venues} />
        </div>
      )}

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Exploit techniques by gross stolen</div>
        <p className="text-[10px] text-gray-600 mb-3">All-time distribution across the full curated dataset. Sums differ from the trailing-12-month figures above because the window is different.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TechniquePie
            title="Solana"
            subtitle={`${solHacksData.hacks.length} tracked incidents, first entry Feb 2022`}
            hacks={solHacksData.hacks as any}
          />
          <TechniquePie
            title="EVM"
            subtitle={`${(evmHacksData.hacks as any[]).filter((h: any) => h.category !== 'excluded').length} tracked incidents, first entry Jun 2016 (The DAO)`}
            hacks={evmHacksData.hacks as any}
          />
        </div>
      </div>

      <div>
        <button
          onClick={() => setShowMethodology(v => !v)}
          className="w-full flex items-center justify-between bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer"
        >
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">Methodology &amp; DefiLlama reconciliation</span>
          <span className="text-[10px] text-gray-500">{showMethodology ? 'Hide' : 'Show'}</span>
        </button>
        {showMethodology && (
          <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3 space-y-2 mt-2">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider">Methodology</div>
            <ul className="text-[11px] text-gray-400 space-y-1 list-disc list-inside">
              <li>TVL: DefiLlama historicalChainTvl, 365d trailing average.</li>
              <li>Yield: DefiLlama supply-side revenue (fees paid to LPs and suppliers, not protocol treasury). For venues where DefiLlama has not yet built a fees adapter (Solstice, Jupiter Lend), yield is estimated from the yields API (pool TVL times APY, annualised) or from the protocol's own published APY. Source per venue is noted in the venue table.</li>
              <li>Losses: gross stolen per incident, summed from the curated hack lists. Dollar recoveries are not subtracted from loss rates. Recovery mechanisms vary widely (attacker returns, treasury refunds, bounty programmes, credit facilities, claim tokens, future-fee-share) and the actual user payout is often phased or valued below par over time (FTX being the canonical example). Per-incident recovery status (full / partial / none) is surfaced categorically instead.</li>
              <li>Cascade attribution: when an upstream incident (e.g. Drift) lists depositor protocols as affected, the relationship is flagged via a &quot;cascade&quot; badge on the affected venue, but the upstream incident&apos;s gross loss is not split across them. That $285M is already counted once against Drift. Per-protocol cascade dollar amounts are almost never published with enough precision to allocate, and where they are (Prime Numbers Fi ~$10M, Gauntlet ~$6.4M) the protocols involved are downstream users of Drift, not deposit venues in this table.</li>
              <li>EVM aggregate: current live TVL sums all EVM chains with positive TVL on DefiLlama. 12-month average TVL and yield paid are computed across the top 13 EVM chains for which DefiLlama has a fees adapter, which covers about 97% of total EVM TVL. The remaining long-tail contributes minimal yield and minimal change to the rate calculation.</li>
              <li>Hack dataset covers top-of-leaderboard incidents by USD. Incidents under roughly $5M are excluded, which would modestly increase both gross loss figures.</li>
            </ul>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider pt-2">Reconciling with DefiLlama&apos;s $16.5B all-time hack tracker</div>
            <ul className="text-[11px] text-gray-400 space-y-1 list-disc list-inside">
              <li>CEX compromises (Bybit $1.44B, DMM $304M, WazirX $235M, BitMart, Atomic Wallet, etc.) are excluded from this dataset as non-DeFi. DefiLlama includes them in their $16.5B total. Roughly $4-6B of their headline.</li>
              <li>Wallet drainers (Inferno, Angel) and prop-trading hot-wallet losses (Wintermute $162M) are excluded as user-side or MM-side risk, not protocol risk.</li>
              <li>Non-EVM non-Solana DeFi is partially covered in the combined &quot;All tracked DeFi&quot; exploits view (Cetus $223M on Sui, Osmosis $5M on Cosmos) but does not contribute to the chain-level Solana vs EVM comparison above. Other non-major incidents on Near, Aptos, Tron and Cosmos ecosystem chains are still outside scope.</li>
              <li>Smaller incidents below $5M add up to several hundred million but are individually below the inclusion threshold.</li>
              <li>DefiLlama&apos;s own breakdown: ~$7.7B DeFi, ~$2.9B bridges, rest CEX and infrastructure. The combined figure shown here (Solana + EVM + curated non-EVM non-Solana) sits against the $7.7B + $2.9B DeFi-plus-bridges subset, with the gap being smaller incidents below threshold and non-major incidents on chains not yet curated.</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
