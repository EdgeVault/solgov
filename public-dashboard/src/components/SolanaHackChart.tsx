// Cumulative Solana-native hack losses since 2022, plotted against TVL context.

import { useMemo, useState, useRef } from 'react';
import hacksData from '../data/solana-hacks.json';

type Hack = {
  date: string;
  protocol: string;
  amountUsd: number;
  category: string;
  rootCause: string;
  recovered?: 'full' | 'partial' | 'none';
  recoveryNote?: string;
  affectedProtocols: string[];
  link?: string;
};

const CATEGORY_LABEL: Record<string, string> = {
  signer: 'Signer / key compromise',
  bridge: 'Bridge / cross-chain',
  oracle: 'Oracle manipulation',
  contract: 'Contract bug',
  wallet: 'Wallet-level',
  exchange: 'Exchange hot wallet',
};

function formatUsd(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

export function SolanaHackChart({ onJumpTo }: { onJumpTo?: (protocol: string) => void }) {
  const hacks = (hacksData.hacks as Hack[]).slice().sort((a, b) => a.date.localeCompare(b.date));
  const latest = hacksData.updatedAt;
  const [showIncidents, setShowIncidents] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ idx: number; xp: number; yp: number } | null>(null);

  const totals = useMemo(() => {
    const total = hacks.reduce((s, h) => s + h.amountUsd, 0);
    const netLost = hacks.reduce((s, h) => {
      if (h.recovered === 'full') return s;
      if (h.recovered === 'partial') return s + h.amountUsd * 0.5;
      return s + h.amountUsd;
    }, 0);
    const byCategory: Record<string, number> = {};
    const countByCategory: Record<string, number> = {};
    for (const h of hacks) {
      byCategory[h.category] = (byCategory[h.category] || 0) + h.amountUsd;
      countByCategory[h.category] = (countByCategory[h.category] || 0) + 1;
    }
    const recoveredCount = hacks.filter(h => h.recovered === 'full' || h.recovered === 'partial').length;
    return { total, netLost, byCategory, countByCategory, recoveredCount };
  }, [hacks]);

  const cumulative = useMemo(() => {
    let running = 0;
    return hacks.map(h => {
      running += h.amountUsd;
      return { date: h.date, value: running, protocol: h.protocol, amount: h.amountUsd };
    });
  }, [hacks]);

  const width = 760;
  const height = 240;
  const padL = 50;
  const padR = 12;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxValue = cumulative[cumulative.length - 1]?.value || 1;
  const minTs = new Date(cumulative[0]?.date || Date.now()).getTime();
  const maxTs = new Date(cumulative[cumulative.length - 1]?.date || Date.now()).getTime();
  const x = (d: string) => padL + ((new Date(d).getTime() - minTs) / Math.max(maxTs - minTs, 1)) * plotW;
  const y = (v: number) => padT + (1 - v / maxValue) * plotH;

  const path = cumulative.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = cumulative.length > 0
    ? path + ` L${x(cumulative[cumulative.length - 1].date).toFixed(1)},${padT + plotH} L${x(cumulative[0].date).toFixed(1)},${padT + plotH} Z`
    : '';

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: maxValue * f, y: padT + (1 - f) * plotH }));
  const firstYear = new Date(minTs).getUTCFullYear();
  const lastYear = new Date(maxTs).getUTCFullYear();
  const xTicks: { t: number; x: number; year: number }[] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const t = Date.UTC(year, 0, 1);
    if (t < minTs || t > maxTs) continue;
    xTicks.push({ t, x: padL + ((t - minTs) / Math.max(maxTs - minTs, 1)) * plotW, year });
  }

  const categoryOrder = Object.keys(totals.byCategory).sort((a, b) => totals.byCategory[b] - totals.byCategory[a]);

  const recentHacks = hacks.slice().reverse().slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Solana DeFi Exploits</h2>
        <p className="text-[11px] text-gray-500 mb-4">
          Cumulative losses across tracked Solana DeFi exploits since 2022. Curated from public post-mortems and protocol disclosures. Last updated {latest}.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3">
          <div className="text-2xl font-semibold text-white tabular-nums">{formatUsd(totals.total)}</div>
          <div className="text-[11px] text-gray-500">Gross stolen since 2022</div>
        </div>
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3">
          <div className="text-2xl font-semibold text-white tabular-nums">{formatUsd(totals.netLost)}</div>
          <div className="text-[11px] text-gray-500">Estimated net user loss</div>
        </div>
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3">
          <div className="text-2xl font-semibold text-white tabular-nums">{hacks.length}</div>
          <div className="text-[11px] text-gray-500">Tracked incidents</div>
        </div>
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3">
          <div className="text-2xl font-semibold text-white tabular-nums">{formatUsd(Math.max(...hacks.map(h => h.amountUsd)))}</div>
          <div className="text-[11px] text-gray-500">Largest single incident</div>
        </div>
      </div>

      {(() => {
        function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
          if (!svgRef.current) return;
          const rect = svgRef.current.getBoundingClientRect();
          const sx = ((e.clientX - rect.left) / rect.width) * width;
          if (sx < padL || sx > width - padR) { setHover(null); return; }
          let nearestIdx = 0;
          let bestD = Infinity;
          for (let i = 0; i < cumulative.length; i++) {
            const px = x(cumulative[i].date);
            const d = Math.abs(px - sx);
            if (d < bestD) { bestD = d; nearestIdx = i; }
          }
          const p = cumulative[nearestIdx];
          setHover({ idx: nearestIdx, xp: x(p.date), yp: y(p.value) });
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

        const latestPt = cumulative[cumulative.length - 1];
        const displayPt = hover ? cumulative[hover.idx] : latestPt;
        const displayDate = new Date(displayPt.date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });

        return (
          <div className="bg-[#0a0a0f] rounded-md border border-white/[0.04]">
            <div className="flex items-baseline justify-between px-4 pt-3 pb-2 border-b border-white/[0.04]">
              <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Cumulative losses</div>
                <div className="text-2xl font-semibold text-white tabular-nums mt-0.5">{formatUsd(displayPt.value)}</div>
                <div className="text-[10px] text-gray-500 mt-0.5 min-h-[1em]">
                  {hover ? `${displayPt.protocol} • ${formatUsd(displayPt.amount)} this incident` : `Latest: ${latestPt.protocol}`}
                </div>
              </div>
              <div className="text-[11px] text-gray-500 tabular-nums">{displayDate}</div>
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
                <linearGradient id="hack-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.08" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                </linearGradient>
              </defs>

              {yTicks.map((t, i) => (
                <g key={i}>
                  <line x1={padL} y1={t.y} x2={width - padR} y2={t.y} stroke="rgba(255,255,255,0.04)" strokeDasharray="2,4" />
                  <text x={padL - 8} y={t.y + 3} fontSize="10" fill="rgba(255,255,255,0.35)" textAnchor="end">
                    {formatUsd(t.v)}
                  </text>
                </g>
              ))}
              {xTicks.map((t, i) => (
                <text key={i} x={t.x} y={height - 10} fontSize="10" fill="rgba(255,255,255,0.45)" textAnchor="middle">
                  {t.year}
                </text>
              ))}

              {area && <path d={area} fill="url(#hack-fill)" />}
              {path && <path d={path} fill="none" stroke="#ffffff" strokeWidth="1.5" />}

              {cumulative.map((p, i) => (
                <circle key={i} cx={x(p.date)} cy={y(p.value)} r={2.5} fill="#ffffff" fillOpacity={hover && hover.idx === i ? 0 : 1} />
              ))}

              {hover && (
                <g>
                  <line x1={hover.xp} x2={hover.xp} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.35)" strokeDasharray="3,3" />
                  <circle cx={hover.xp} cy={hover.yp} r="5" fill="#ffffff" stroke="#0a0a0f" strokeWidth="2" />
                </g>
              )}
            </svg>
          </div>
        );
      })()}

      {(() => {
        const withCascade = hacks.filter(h => h.affectedProtocols.length > 0);
        if (withCascade.length === 0) return null;
        const maxCascade = withCascade.reduce((a, b) => a.affectedProtocols.length > b.affectedProtocols.length ? a : b);
        const earliestCascade = withCascade.reduce((a, b) => a.date < b.date ? a : b);
        return (
          <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Blast radius trend</div>
            <div className="text-[11px] text-gray-400 leading-relaxed">
              <span className="text-gray-300">{earliestCascade.protocol} ({earliestCascade.date.slice(0, 4)})</span> cascaded to {earliestCascade.affectedProtocols.length} downstream protocol{earliestCascade.affectedProtocols.length === 1 ? '' : 's'}.
              {' '}
              <span className="text-gray-300">{maxCascade.protocol} ({maxCascade.date.slice(0, 4)})</span> cascaded to {maxCascade.affectedProtocols.length}.
              {' '}
              Interconnection has grown faster than the governance standards meant to contain it.
            </div>
          </div>
        );
      })()}

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">By root cause</div>
        <div className="space-y-1.5">
          {categoryOrder.map(cat => {
            const pct = (totals.byCategory[cat] / totals.total) * 100;
            return (
              <div key={cat} className="flex items-center gap-3 text-xs">
                <div className="w-40 text-gray-400">{CATEGORY_LABEL[cat] || cat}</div>
                <div className="flex-1 h-2 bg-white/[0.03] rounded-sm overflow-hidden">
                  <div className="h-full bg-white/[0.35]" style={{ width: `${pct}%` }} />
                </div>
                <div className="w-20 text-right text-gray-300 tabular-nums">{formatUsd(totals.byCategory[cat])}</div>
                <div className="w-12 text-right text-gray-500 tabular-nums">{totals.countByCategory[cat]}x</div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <button
          onClick={() => setShowIncidents(v => !v)}
          className="w-full flex items-center justify-between bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer"
        >
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">Recent incidents ({recentHacks.length})</span>
          <span className="text-[10px] text-gray-500">{showIncidents ? 'Hide' : 'Show'}</span>
        </button>
        {showIncidents && (
          <div className="space-y-2 mt-2">
            {recentHacks.map((h, i) => (
              <div key={i} className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-white">{h.protocol}</span>
                  <span className="text-sm font-medium text-white tabular-nums whitespace-nowrap">{formatUsd(h.amountUsd)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[10px] text-gray-500 tabular-nums whitespace-nowrap">{h.date}</span>
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider whitespace-nowrap">{CATEGORY_LABEL[h.category] || h.category}</span>
                  {h.recovered === 'full' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-300 border border-white/[0.08] whitespace-nowrap">Fully recovered</span>
                  )}
                  {h.recovered === 'partial' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-300 border border-white/[0.08] whitespace-nowrap">Partially recovered</span>
                  )}
                </div>
                <div className="text-[11px] text-gray-500 mt-2">{h.rootCause}</div>
                {h.recoveryNote && (
                  <div className="text-[10px] text-gray-500 mt-1 italic">{h.recoveryNote}</div>
                )}
                {h.affectedProtocols.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-gray-500 mr-1">Cascaded to:</span>
                    {h.affectedProtocols.map(p => (
                      <button
                        key={p}
                        onClick={() => onJumpTo?.(p)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-300 border border-white/[0.08] hover:bg-white/[0.08] transition-colors"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
