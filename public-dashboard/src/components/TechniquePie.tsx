import { useState } from 'react';

type HackLike = { category: string; amountUsd: number; recovered?: 'full' | 'partial' | 'none'; recoveryNote?: string };

const CATEGORY_LABEL: Record<string, string> = {
  signer: 'Signer / admin key',
  contract: 'Contract bug',
  oracle: 'Oracle / pricing',
  wallet: 'Wallet-level',
  exchange: 'Exchange hot wallet',
};

function formatUsd(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

const PALETTE = ['#e5e7eb', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937'];

export function TechniquePie({
  title,
  subtitle,
  hacks,
  metric = 'gross',
}: {
  title: string;
  subtitle?: string;
  hacks: HackLike[];
  metric?: 'gross' | 'count';
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const filtered = hacks.filter(h => h.category !== 'excluded');

  const byCategory: Record<string, { value: number; count: number }> = {};
  for (const h of filtered) {
    const amt = metric === 'count' ? 1 : h.amountUsd;
    if (!byCategory[h.category]) byCategory[h.category] = { value: 0, count: 0 };
    byCategory[h.category].value += amt;
    byCategory[h.category].count += 1;
  }
  const total = Object.values(byCategory).reduce((s, v) => s + v.value, 0);
  const ordered = Object.entries(byCategory).sort((a, b) => b[1].value - a[1].value);

  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 72;
  const rInner = 44;
  const rOuterHover = 76;

  let angleAcc = -Math.PI / 2;
  const slices = ordered.map(([category, data], i) => {
    const frac = total > 0 ? data.value / total : 0;
    const angleStart = angleAcc;
    const angleEnd = angleAcc + frac * Math.PI * 2;
    angleAcc = angleEnd;

    const buildPath = (outerR: number) => {
      const x1 = cx + outerR * Math.cos(angleStart);
      const y1 = cy + outerR * Math.sin(angleStart);
      const x2 = cx + outerR * Math.cos(angleEnd);
      const y2 = cy + outerR * Math.sin(angleEnd);
      const x3 = cx + rInner * Math.cos(angleEnd);
      const y3 = cy + rInner * Math.sin(angleEnd);
      const x4 = cx + rInner * Math.cos(angleStart);
      const y4 = cy + rInner * Math.sin(angleStart);
      const largeArc = frac > 0.5 ? 1 : 0;
      if (frac >= 1) {
        return `M ${cx - outerR},${cy} A ${outerR},${outerR} 0 1 1 ${cx + outerR},${cy} A ${outerR},${outerR} 0 1 1 ${cx - outerR},${cy} Z M ${cx - rInner},${cy} A ${rInner},${rInner} 0 1 0 ${cx + rInner},${cy} A ${rInner},${rInner} 0 1 0 ${cx - rInner},${cy} Z`;
      }
      return `M ${x1},${y1} A ${outerR},${outerR} 0 ${largeArc} 1 ${x2},${y2} L ${x3},${y3} A ${rInner},${rInner} 0 ${largeArc} 0 ${x4},${y4} Z`;
    };

    return {
      category,
      label: CATEGORY_LABEL[category] || category,
      value: data.value,
      count: data.count,
      frac,
      pathD: buildPath(rOuter),
      pathDHover: buildPath(rOuterHover),
      color: PALETTE[i % PALETTE.length],
    };
  });

  const hovered = hoverIdx !== null ? slices[hoverIdx] : null;
  const centreTop = hovered
    ? (metric === 'count' ? String(hovered.count) : formatUsd(hovered.value))
    : (metric === 'count' ? String(filtered.length) : formatUsd(total));
  const centreMid = hovered
    ? hovered.label
    : (metric === 'count' ? (filtered.length === 1 ? 'incident' : 'incidents') : 'gross stolen');
  const centreBottom = hovered
    ? `${(hovered.frac * 100).toFixed(1)}% · ${hovered.count} incident${hovered.count === 1 ? '' : 's'}`
    : '';

  return (
    <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md">
      <div className="px-4 pt-3 pb-2 border-b border-white/[0.04] flex items-baseline justify-between">
        <div className="text-xs font-semibold text-white">{title}</div>
        {subtitle && <div className="text-[10px] text-gray-500">{subtitle}</div>}
      </div>
      <div className="p-4 flex gap-4 items-center">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="w-[180px] h-[180px] shrink-0 cursor-pointer"
          style={{ touchAction: 'manipulation' }}
        >
          {slices.map((s, i) => {
            const isHover = hoverIdx === i;
            return (
              <path
                key={i}
                d={isHover ? s.pathDHover : s.pathD}
                fill={s.color}
                stroke="#0a0a0f"
                strokeWidth="1"
                fillOpacity={hoverIdx === null || isHover ? 1 : 0.45}
                onPointerEnter={() => setHoverIdx(i)}
                onPointerLeave={() => setHoverIdx(prev => (prev === i ? null : prev))}
                onPointerDown={() => setHoverIdx(i)}
                onPointerCancel={() => setHoverIdx(null)}
                style={{ transition: 'fill-opacity 120ms, d 120ms' }}
              />
            );
          })}
          <text x={cx} y={cy - (hovered ? 10 : 4)} fontSize="14" fill="#ffffff" textAnchor="middle" fontWeight="600">{centreTop}</text>
          <text x={cx} y={cy + (hovered ? 4 : 12)} fontSize={hovered ? '9' : '9'} fill={hovered ? '#d1d5db' : '#6b7280'} textAnchor="middle">{centreMid}</text>
          {hovered && (
            <text x={cx} y={cy + 16} fontSize="8" fill="#6b7280" textAnchor="middle">{centreBottom}</text>
          )}
        </svg>
        <div className="flex-1 min-w-0 space-y-1.5 text-[11px]">
          {slices.map((s, i) => {
            const isHover = hoverIdx === i;
            return (
              <div
                key={i}
                className={`flex items-center gap-2 cursor-pointer transition-colors ${
                  isHover ? 'text-white' : 'text-gray-400'
                }`}
                onPointerEnter={() => setHoverIdx(i)}
                onPointerLeave={() => setHoverIdx(prev => (prev === i ? null : prev))}
              >
                <span className="inline-block w-2.5 h-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
                <span className={`${isHover ? 'text-white' : 'text-gray-300'} truncate`}>{s.label}</span>
                <span className="ml-auto text-gray-500 tabular-nums shrink-0">{formatUsd(s.value)}</span>
                <span className="text-gray-500 tabular-nums shrink-0 w-8 text-right">{(s.frac * 100).toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
