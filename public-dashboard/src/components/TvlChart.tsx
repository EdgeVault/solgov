// Historical TVL chart for tracked protocols, sourced from DefiLlama.

import React, { useMemo } from 'react';
import historical from '../data/historical-tvl.json';

type Point = { date: number; tvl: number };
type Marker = { date: string; label: string; colour?: string };

interface TvlChartProps {
  protocol: string;
  height?: number;
  markers?: Marker[];
  from?: string;
  to?: string;
}

function formatTvl(v: number): string {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}

export function TvlChart({ protocol, height = 180, markers = [], from, to }: TvlChartProps) {
  const data = useMemo(() => {
    const all: Point[] = (historical.protocols as any)[protocol] || [];
    if (all.length === 0) return [];
    const fromTs = from ? new Date(from).getTime() / 1000 : 0;
    const toTs = to ? new Date(to).getTime() / 1000 : Infinity;
    return all.filter(p => p.date >= fromTs && p.date <= toTs);
  }, [protocol, from, to]);

  if (data.length === 0) {
    return <div className="text-[11px] text-gray-500">No historical TVL data for {protocol}</div>;
  }

  const width = 600;
  const padL = 40;
  const padR = 12;
  const padT = 8;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const minTs = data[0].date;
  const maxTs = data[data.length - 1].date;
  const maxTvl = Math.max(...data.map(d => d.tvl), 1);

  const x = (ts: number) => padL + ((ts - minTs) / Math.max(maxTs - minTs, 1)) * plotW;
  const y = (v: number) => padT + (1 - v / maxTvl) * plotH;

  const pathD = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.tvl).toFixed(1)}`).join(' ');
  const areaD = pathD + ` L${x(maxTs).toFixed(1)},${padT + plotH} L${x(minTs).toFixed(1)},${padT + plotH} Z`;

  const peak = data.reduce((m, p) => p.tvl > m.tvl ? p : m, data[0]);
  const latest = data[data.length - 1];

  const yTicks = [0, 0.33, 0.66, 1].map(f => ({ v: maxTvl * f, y: padT + (1 - f) * plotH }));
  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  };

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`tvl-fill-${protocol}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <text x={padL - 4} y={t.y + 3} textAnchor="end" fill="rgba(255,255,255,0.4)" fontSize="9">
              {formatTvl(t.v)}
            </text>
          </g>
        ))}

        <path d={areaD} fill={`url(#tvl-fill-${protocol})`} />
        <path d={pathD} stroke="#3b82f6" strokeWidth="1.5" fill="none" />

        {markers.map((m, i) => {
          const ts = new Date(m.date).getTime() / 1000;
          if (ts < minTs || ts > maxTs) return null;
          const mx = x(ts);
          const colour = m.colour || '#ef4444';
          return (
            <g key={i}>
              <line x1={mx} x2={mx} y1={padT} y2={padT + plotH} stroke={colour} strokeWidth="1" strokeDasharray="2,3" opacity="0.7" />
              <text x={mx} y={padT - 1} textAnchor="middle" fill={colour} fontSize="9" fontWeight="600">
                {m.label}
              </text>
            </g>
          );
        })}

        <text x={padL} y={height - 6} fill="rgba(255,255,255,0.4)" fontSize="9">
          {formatDate(minTs)}
        </text>
        <text x={width - padR} y={height - 6} textAnchor="end" fill="rgba(255,255,255,0.4)" fontSize="9">
          {formatDate(maxTs)}
        </text>

        <circle cx={x(latest.date)} cy={y(latest.tvl)} r="3" fill="#3b82f6" stroke="#0a0a0f" strokeWidth="1.5" />
      </svg>

      <div className="flex gap-4 mt-1 text-[10px] text-gray-500">
        <span>Peak: <span className="text-gray-300">{formatTvl(peak.tvl)}</span> ({formatDate(peak.date)})</span>
        <span>Now: <span className="text-gray-300">{formatTvl(latest.tvl)}</span></span>
        {peak.tvl > latest.tvl && (
          <span>Change: <span className="text-gray-300">{(((latest.tvl - peak.tvl) / peak.tvl) * 100).toFixed(1)}%</span></span>
        )}
      </div>
    </div>
  );
}
