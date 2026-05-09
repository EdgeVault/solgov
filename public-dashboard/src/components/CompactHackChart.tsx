import { useMemo, useRef, useState } from 'react';

type Hack = {
  date: string;
  protocol: string;
  amountUsd: number;
  category: string;
  recovered?: 'full' | 'partial' | 'none';
};

const CATEGORY_LABEL: Record<string, string> = {
  signer: 'Signer / key',
  bridge: 'Bridge',
  oracle: 'Oracle',
  contract: 'Contract',
  wallet: 'Wallet',
  exchange: 'Exchange',
};

function formatUsd(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

export function CompactHackChart({
  title,
  subtitle,
  hacks,
}: {
  title: string;
  subtitle: string;
  hacks: Hack[];
}) {
  const sorted = useMemo(
    () => hacks.filter(h => h.category !== 'excluded').slice().sort((a, b) => a.date.localeCompare(b.date)),
    [hacks]
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ idx: number; xp: number; yp: number } | null>(null);

  const totals = useMemo(() => {
    const total = sorted.reduce((s, h) => s + h.amountUsd, 0);
    const largest = sorted.reduce((a, b) => (a.amountUsd > b.amountUsd ? a : b), sorted[0]);
    const byCategory: Record<string, number> = {};
    for (const h of sorted) byCategory[h.category] = (byCategory[h.category] || 0) + h.amountUsd;
    const categoryOrder = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    return { total, largest, categoryOrder };
  }, [sorted]);

  const cumulative = useMemo(() => {
    let running = 0;
    return sorted.map(h => {
      running += h.amountUsd;
      return { date: h.date, value: running, protocol: h.protocol, amount: h.amountUsd };
    });
  }, [sorted]);

  const width = 400;
  const height = 140;
  const padL = 40, padR = 10, padT = 10, padB = 22;
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

  const firstYear = new Date(minTs).getUTCFullYear();
  const lastYear = new Date(maxTs).getUTCFullYear();
  const xTicks: { t: number; xp: number; year: number }[] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const t = Date.UTC(year, 0, 1);
    if (t < minTs || t > maxTs) continue;
    xTicks.push({ t, xp: padL + ((t - minTs) / Math.max(maxTs - minTs, 1)) * plotW, year });
  }

  const yTicks = [0, 0.5, 1].map(f => ({ v: maxValue * f, y: padT + (1 - f) * plotH }));

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * width;
    if (sx < padL || sx > width - padR) { setHover(null); return; }
    let nearestIdx = 0, bestD = Infinity;
    for (let i = 0; i < cumulative.length; i++) {
      const px = x(cumulative[i].date);
      const d = Math.abs(px - sx);
      if (d < bestD) { bestD = d; nearestIdx = i; }
    }
    const p = cumulative[nearestIdx];
    setHover({ idx: nearestIdx, xp: x(p.date), yp: y(p.value) });
  }
  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    handlePointerMove(e);
  }
  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    setHover(null);
  }

  const displayPt = hover ? cumulative[hover.idx] : cumulative[cumulative.length - 1];
  const displayDate = new Date(displayPt.date).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

  return (
    <div className="bg-[#0a0a0f] rounded-md border border-white/[0.04]">
      <div className="px-4 pt-3 pb-2 border-b border-white/[0.04]">
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-semibold text-white">{title}</div>
          <div className="text-[10px] text-gray-500">{subtitle}</div>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <div className="text-lg font-semibold text-white tabular-nums">{formatUsd(displayPt.value)}</div>
          <div className="text-[10px] text-gray-500 tabular-nums">{displayDate}</div>
        </div>
        <div className="text-[10px] text-gray-500 min-h-[1em] mt-0.5">
          {hover ? `${displayPt.protocol} • ${formatUsd(displayPt.amount)} this incident` : 'cumulative gross stolen'}
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
        onPointerLeave={() => setHover(null)}
        onPointerCancel={handlePointerUp}
      >
        <defs>
          <linearGradient id={`compact-fill-${title.replace(/\s+/g, '-')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={width - padR} y2={t.y} stroke="rgba(255,255,255,0.04)" strokeDasharray="2,4" />
            <text x={padL - 6} y={t.y + 3} fontSize="9" fill="rgba(255,255,255,0.35)" textAnchor="end">{formatUsd(t.v)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={t.xp} y={height - 8} fontSize="9" fill="rgba(255,255,255,0.45)" textAnchor="middle">{t.year}</text>
        ))}

        {area && <path d={area} fill={`url(#compact-fill-${title.replace(/\s+/g, '-')})`} />}
        {path && <path d={path} fill="none" stroke="#ffffff" strokeWidth="1.5" />}

        {hover && (
          <g>
            <line x1={hover.xp} x2={hover.xp} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.35)" strokeDasharray="3,3" />
            <circle cx={hover.xp} cy={hover.yp} r="4" fill="#ffffff" stroke="#0a0a0f" strokeWidth="2" />
          </g>
        )}
      </svg>
      <div className="px-4 py-2 border-t border-white/[0.04] grid grid-cols-3 gap-2 text-[10px]">
        <div>
          <div className="text-gray-500 uppercase tracking-wider">Incidents</div>
          <div className="text-sm font-semibold text-white tabular-nums">{sorted.length}</div>
        </div>
        <div>
          <div className="text-gray-500 uppercase tracking-wider">Largest</div>
          <div className="text-sm font-semibold text-white tabular-nums">{formatUsd(totals.largest?.amountUsd || 0)}</div>
          <div className="text-[9px] text-gray-600 truncate">{totals.largest?.protocol}</div>
        </div>
        <div>
          <div className="text-gray-500 uppercase tracking-wider">Top cause</div>
          <div className="text-sm font-semibold text-white tabular-nums">{formatUsd(totals.categoryOrder[0]?.[1] || 0)}</div>
          <div className="text-[9px] text-gray-600 truncate">{CATEGORY_LABEL[totals.categoryOrder[0]?.[0] || ''] || totals.categoryOrder[0]?.[0]}</div>
        </div>
      </div>
    </div>
  );
}
