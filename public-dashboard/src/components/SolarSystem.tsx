// Blast Radius view: cross-protocol dependency map showing how a compromise in one protocol can cascade.

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { EXPOSURES, EXPOSURE_PROTOCOLS, resolveExposureNode } from '../data/exposure';
import type { ExposureNode } from '../data/exposure';
import { getRelationships } from '../data/relationships';
import { PROTOCOLS } from '../data/protocols';
import { LOGO_FILENAMES } from '../App';

function nodeTldr(name: string, fallbackGovernance?: string): string {
  const p = PROTOCOLS.find(x => x.name === name);
  if (!p) return fallbackGovernance || '';
  if (p.version === 'Single Signer') return 'No multisig';
  if (p.version === 'Wormhole') return 'Wormhole guardian set';
  if (p.version === 'Realms DAO') return 'Realms DAO';
  if (p.version === 'Immutable') return 'Immutable';
  if (!p.threshold || !p.totalMembers) return fallbackGovernance || '';
  const voters = p.activeVoters > 0 ? p.activeVoters : p.totalMembers;
  const versionTag = p.version === 'Squads V4' ? 'V4' : p.version === 'Squads V3' ? 'V3' : p.version === 'Serum Multisig' ? 'Serum' : '';
  const timelock = p.timelockLabel || (p.hasTimelock ? 'timelock set' : 'no timelock');
  return `${p.threshold}/${voters}${versionTag ? ' ' + versionTag : ''} - ${timelock}`;
}

const ASSET_LABELS: Record<string, string> = {
  'JitoSOL': 'JitoSOL',
  'mSOL': 'mSOL',
  'Sanctum LSTs': 'LSTs',
  'Scope (aggregator)': 'Scope',
  'SOL': 'SOL',
  'USDC': 'USDC',
  'USDT': 'USDT',
  'Internal AMM': 'AMM',
  'PancakeSwap': 'PancakeSwap (Sol)',
};

function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let prevW = 0, prevH = 0;
    const resize = () => {
      const w = canvas.offsetWidth * 2;
      const h = canvas.offsetHeight * 2;
      if (w === 0 || h === 0) return;
      if (prevW > 0 && prevH > 0) {
        for (const s of stars) {
          s.x = (s.x / prevW) * w;
          s.y = (s.y / prevH) * h;
        }
      }
      canvas.width = w;
      canvas.height = h;
      prevW = w;
      prevH = h;
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 100));

    const stars: { x: number; y: number; vx: number; vy: number; r: number; o: number }[] = [];
    for (let i = 0; i < 90; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.08 + Math.random() * 0.15;
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: 0.8 + Math.random() * 1.5,
        o: 0.08 + Math.random() * 0.25,
      });
    }

    let animId: number;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of stars) {
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < 0) s.x += canvas.width;
        if (s.x > canvas.width) s.x -= canvas.width;
        if (s.y < 0) s.y += canvas.height;
        if (s.y > canvas.height) s.y -= canvas.height;

        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${s.o})`;
        ctx.fill();
      }
      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

function BlastWave({ nodes, cascadeNode, blastKey, cx, cy, getRx, getRy }: {
  nodes: SolarNode[]; cascadeNode: string | null; blastKey: number;
  cx: number; cy: number; getRx: (r: number) => number; getRy: (r: number) => number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!cascadeNode || blastKey === 0 || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.parentElement?.querySelector('svg')?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    const scale = Math.max(0.1, canvas.width / 1000);

    const clicked = cascadeNode === '__center__' ? null : nodes.find(n => n.name === cascadeNode);
    const bx = (clicked ? cx + Math.cos((clicked.angle * Math.PI) / 180) * getRx(clicked.ring) : cx) * scale;
    const by = (clicked ? cy + Math.sin((clicked.angle * Math.PI) / 180) * getRy(clicked.ring) : cy) * scale;

    const start = performance.now();
    const duration = 800;
    let id: number;
    const draw = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const r1 = Math.max(0, 5 * scale + ease * 300 * scale);
      ctx.beginPath();
      ctx.arc(bx, by, r1, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(239,68,68,${0.4 * (1 - p)})`;
      ctx.lineWidth = (2 - p * 1.5) * scale;
      ctx.stroke();

      const p2 = Math.max(0, (now - start - 50) / (duration * 0.7));
      if (p2 > 0 && p2 <= 1) {
        const ease2 = 1 - Math.pow(1 - Math.min(p2, 1), 3);
        const r2 = Math.max(0, 5 * scale + ease2 * 200 * scale);
        ctx.beginPath();
        ctx.arc(bx, by, r2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239,68,68,${0.25 * (1 - Math.min(p2, 1))})`;
        ctx.lineWidth = (1.5 - Math.min(p2, 1) * 1.2) * scale;
        ctx.stroke();
      }

      if (p < 1) id = requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    id = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(id); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); };
  }, [blastKey]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }} />;
}

const TYPE_COLORS: Record<string, string> = {
  oracle: '#3b82f6',
  collateral: '#a855f7',
  lending: '#10b981',
  dex: '#f59e0b',
  propamm: '#ef4444',
  aggregator: '#f97316',
  external: '#6b7280',
};

const CATEGORY_COLORS: Record<string, string> = {
  DEX: '#f59e0b',
  Lending: '#10b981',
  Perps: '#ef4444',
  Aggregator: '#f97316',
  Oracle: '#3b82f6',
  'Liquid Staking': '#a855f7',
  Infrastructure: '#6b7280',
  Yield: '#14b8a6',
  NFT: '#ec4899',
  DePIN: '#8b5cf6',
  Stablecoin: '#06b6d4',
  Other: '#6b7280',
  'Prop AMM': '#ef4444',
  'Trading Bot': '#f43f5e',
  Bridge: '#0ea5e9',
  PayFi: '#22d3ee',
  Governance: '#c084fc',
};

interface SolarNode {
  name: string;
  ring: number;
  angle: number;
  type: string;
  governance: string;
  note?: string;
}

function inferType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('pyth') || lower.includes('switchboard') || lower.includes('chainlink') || lower.includes('scope') || lower.includes('redstone')) return 'oracle';
  if (lower.includes('usdc') || lower.includes('usdt') || lower.includes('sol') || lower.includes('jito') || lower.includes('msol') || lower.includes('sanctum') || lower.includes('lst')) return 'collateral';
  if (lower.includes('bison') || lower.includes('tessera') || lower.includes('humidi') || lower.includes('pancake')) return 'propamm';
  if (lower.includes('jupiter agg')) return 'aggregator';
  if (lower.includes('orca') || lower.includes('raydium') || lower.includes('meteora') || lower.includes('phoenix') || lower.includes('pump')) return 'dex';
  return 'lending';
}

const ASSET_TO_PROTOCOL: Record<string, string> = {
  'JitoSOL': 'Jito',
  'mSOL': 'Marinade',
  'Sanctum LSTs': 'Sanctum',
  'Scope (aggregator)': 'Pyth',
  'SOL': '_SOL_',
  'USDC': '_USDC_',
  'USDT': '_USDT_',
};

function seededRand(seed: number) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return s / 2147483647; };
}

function buildExposureNodes(protocolName: string): SolarNode[] {
  const rawExposure = EXPOSURES[protocolName];
  if (!rawExposure) return [];
  const exposure = {
    ...rawExposure,
    oracles: rawExposure.oracles.map(resolveExposureNode),
    collateral: rawExposure.collateral.map(resolveExposureNode),
    routing: rawExposure.routing.map(resolveExposureNode),
    settlement: rawExposure.settlement.map(resolveExposureNode),
  };

  const nodes: SolarNode[] = [];
  const existingNames = new Set<string>();
  const protocolNames = new Set<string>();
  const seed = protocolName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = seededRand(seed);

  const addNodes = (items: ExposureNode[], ring: number, offset: number, typeOverride?: string) => {
    items.forEach((n, i) => {
      if (existingNames.has(n.name)) return;
      existingNames.add(n.name);
      const mapped = ASSET_TO_PROTOCOL[n.name];
      if (mapped) protocolNames.add(mapped);
      const angleJitter = (rand() - 0.5) * 8;
      nodes.push({
        name: n.name,
        ring: ring,
        angle: (360 / Math.max(items.length, 1)) * i + offset + angleJitter,
        type: typeOverride || inferType(n.name),
        governance: n.governance,
        note: n.note,
      });
    });
  };

  addNodes(exposure.oracles, 1, 0, 'oracle');
  addNodes(exposure.collateral, 2, 15, 'collateral');
  addNodes(exposure.routing, 3, 30);
  addNodes(exposure.settlement, 4, 45);

  const { downstream } = getRelationships(protocolName);
  downstream.forEach((r, i) => {
    if (existingNames.has(r.protocol) || protocolNames.has(r.protocol)) return;
    existingNames.add(r.protocol);
    protocolNames.add(r.protocol);
    const type = inferType(r.protocol);
    const ring = type === 'oracle' ? 1 : type === 'collateral' ? 2 : type === 'dex' ? 4 : 3;
    const angleJitter = (rand() - 0.5) * 8;
    nodes.push({
      name: r.protocol,
      ring: ring,
      angle: (360 / Math.max(downstream.length, 1)) * i + 45 + angleJitter,
      type,
      governance: '',
      note: r.detail,
    });
  });

  return nodes;
}

function buildImpactNodes(protocolName: string): SolarNode[] {
  const { upstream } = getRelationships(protocolName);
  if (upstream.length === 0) return [];

  const nodes: SolarNode[] = [];
  const existingNames = new Set<string>();
  existingNames.add(protocolName);
  const seed = protocolName.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + 99;
  const rand = seededRand(seed);

  const queue: { name: string; depth: number }[] = upstream.map(r => ({ name: r.protocol, depth: 1 }));
  let idx = 0;
  while (idx < queue.length && queue.length < 30) {
    const item = queue[idx++];
    if (existingNames.has(item.name)) continue;
    existingNames.add(item.name);

    if (item.depth < 3) {
      const { upstream: nextUp } = getRelationships(item.name);
      for (const r of nextUp) {
        if (!existingNames.has(r.protocol)) {
          queue.push({ name: r.protocol, depth: item.depth + 1 });
        }
      }
    }
  }

  const collected = [...existingNames].filter(n => n !== protocolName);
  collected.forEach((name, i) => {
    const type = inferType(name);
    const depth = queue.find(q => q.name === name)?.depth || 1;
    const ring = Math.min(depth, 3);
    const angleJitter = (rand() - 0.5) * 30;
    nodes.push({
      name,
      ring: ring + (rand() - 0.5) * 0.2,
      angle: (360 / Math.max(collected.length, 1)) * i + angleJitter,
      type,
      governance: '',
      note: '',
    });
  });

  return nodes;
}

export function SolarSystem({ protocolName, tvlData }: { protocolName?: string; tvlData?: Record<string, number> }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [cascadeNode, setCascadeNode] = useState<string | null>(null);
  const [blastKey, setBlastKey] = useState(0);
  const [view, setView] = useState<'exposure' | 'impact' | 'all'>('all');
  const longPressTimer = useRef<number>(0);
  const handleTouchStart = useCallback((nodeName: string) => {
    longPressTimer.current = window.setTimeout(() => setHovered(nodeName), 400);
  }, []);
  const handleTouchEnd = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);

  const triggerCascade = (nodeName: string | null) => {
    if (nodeName && nodeName !== cascadeNode) {
      setBlastKey(k => k + 1);
    }
    setCascadeNode(nodeName);
  };

  const name = protocolName || 'Kamino';
  const exposureNodes = useMemo(() => buildExposureNodes(name), [name]);
  const impactNodes = useMemo(() => buildImpactNodes(name), [name]);

  const allNodes = useMemo(() => {
    const combined = [...exposureNodes];
    const existingNames = new Set(combined.map(n => n.name));
    impactNodes.forEach((n) => {
      if (!existingNames.has(n.name)) {
        existingNames.add(n.name);
        combined.push({ ...n });
      }
    });
    return combined;
  }, [exposureNodes, impactNodes]);

  const nodesRaw = view === 'exposure' ? exposureNodes : view === 'impact' ? impactNodes : allNodes;

  const exposureNodeNames = useMemo(() => new Set(exposureNodes.map(n => n.name)), [exposureNodes]);
  const impactNodeNames = useMemo(() => new Set(impactNodes.map(n => n.name)), [impactNodes]);

  const ringLabelsAll: Record<number, string> = { 1: 'Oracles', 2: 'Collateral', 3: 'Routing', 4: 'Settlement', 5: 'Depends on this' };
  const ringLabelsImpact: Record<number, string> = { 1: 'Direct', 2: 'Connected', 3: 'Indirect' };
  const ringLabels = view === 'impact' ? ringLabelsImpact : ringLabelsAll;

  const maxRing = nodesRaw.length > 0 ? Math.max(...nodesRaw.map(n => Math.ceil(n.ring))) : 0;

  const cx = 500;
  const cy = 230;
  const maxRx = 480;
  const maxRy = 210;
  const ringRx: number[] = [0];
  const ringRy: number[] = [0];
  for (let r = 1; r <= Math.max(maxRing, 1); r++) {
    ringRx[r] = (r / maxRing) * maxRx;
    ringRy[r] = (r / maxRing) * maxRy;
  }

  const getRx = (r: number) => {
    const lo = Math.floor(r), hi = Math.ceil(r), frac = r - lo;
    return (ringRx[lo] || 0) * (1 - frac) + (ringRx[hi] || ringRx[lo] || 0) * frac;
  };
  const getRy = (r: number) => {
    const lo = Math.floor(r), hi = Math.ceil(r), frac = r - lo;
    return (ringRy[lo] || 0) * (1 - frac) + (ringRy[hi] || ringRy[lo] || 0) * frac;
  };

  const nodes = useMemo(() => {
    if (nodesRaw.length < 2) return nodesRaw;
    const resolved = nodesRaw.map(n => ({ ...n }));
    const minDist = 72;

    for (let iter = 0; iter < 100; iter++) {
      let anyMoved = false;
      for (let i = 0; i < resolved.length; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
          const a = resolved[i], b = resolved[j];
          const aRad = (a.angle * Math.PI) / 180;
          const bRad = (b.angle * Math.PI) / 180;
          const ax = cx + Math.cos(aRad) * getRx(a.ring);
          const ay = cy + Math.sin(aRad) * getRy(a.ring);
          const bx = cx + Math.cos(bRad) * getRx(b.ring);
          const by = cy + Math.sin(bRad) * getRy(b.ring);
          const dx = bx - ax, dy = by - ay;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < minDist && dist > 0) {
            anyMoved = true;
            const overlap = (minDist - dist) / minDist;
            const push = 3 + overlap * 6;
            resolved[i].angle -= push;
            resolved[j].angle += push;
            if (Math.abs(a.ring - b.ring) < 0.5) {
              const ringPush = 0.08 + overlap * 0.1;
              if (a.ring <= b.ring) {
                resolved[i].ring = Math.max(1, a.ring - ringPush);
                resolved[j].ring = Math.min(maxRing + 0.5, b.ring + ringPush);
              } else {
                resolved[i].ring = Math.min(maxRing + 0.5, a.ring + ringPush);
                resolved[j].ring = Math.max(1, b.ring - ringPush);
              }
            }
          }
        }
      }
      if (!anyMoved) break;
    }
    return resolved;
  }, [nodesRaw, cx, cy, getRx, getRy, maxRing]);

  if (exposureNodes.length === 0 && impactNodes.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-600 text-xs">No dependency data available for {name}</p>
      </div>
    );
  }

  const hoveredNode = nodes.find(n => n.name === hovered);

  return (
    <div className="relative overflow-hidden rounded-lg">
      <Starfield />
      <div className="relative flex justify-center gap-2 mb-3 z-10">
        {([
          ['all', `All (${allNodes.length})`],
          ['exposure', `Downstream (${exposureNodes.length})`],
          ['impact', `Upstream (${impactNodes.length})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => { setView(key as 'exposure' | 'impact' | 'all'); triggerCascade(null); }}
            className={`px-3 py-1.5 text-[11px] rounded-lg border transition-colors ${
              view === key
                ? 'bg-white/[0.08] text-white border-white/[0.15]'
                : 'text-gray-500 border-white/[0.06] hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <svg viewBox="0 0 1000 490" className="relative w-full mx-auto"
        onClick={(e) => { if ((e.target as SVGElement).tagName === 'rect') triggerCascade(null); }}
      >
        <defs>
          <filter id="glow-center" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-node" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-ambient" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-cascade" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <radialGradient id="nebula" cx="50%" cy="48%" r="50%">
            <stop offset="0%" stopColor={view === 'impact' ? '#f97316' : '#10b981'} stopOpacity="0.03" />
            <stop offset="40%" stopColor={view === 'impact' ? '#f97316' : '#3b82f6'} stopOpacity="0.015" />
            <stop offset="100%" stopColor="transparent" stopOpacity="0" />
          </radialGradient>
          <filter id="ring-glow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>

        <rect width="1000" height="490" fill="transparent" />

        <ellipse cx={cx} cy={cy} rx="480" ry="220" fill="url(#nebula)" />

        {(() => {
          const isCenterClicked = cascadeNode === '__center__';
          const clickedRing = isCenterClicked ? 0 : (cascadeNode ? nodes.find(n => n.name === cascadeNode)?.ring ?? null : null);
          const isCascadeActive = clickedRing !== null;
          const isAttackPath = (ring: number) => isCascadeActive && clickedRing !== null && !isCenterClicked && ring < clickedRing && view !== 'exposure';
          const isBlastRadius = (ring: number) => isCascadeActive && clickedRing !== null && ring > clickedRing && (isCenterClicked || view !== 'impact');
          const isClickedRing = (ring: number) => isCascadeActive && !isCenterClicked && ring === clickedRing;

          return (
            <>
              {[1, 2, 3, 4, 5].filter(r => r <= maxRing && ringRx[r] > 0).map(ring => {
                const cascadeColor = isBlastRadius(ring)
                  ? 'rgba(239,68,68,0.2)'
                  : isAttackPath(ring)
                  ? 'rgba(251,146,60,0.2)'
                  : isClickedRing(ring)
                  ? 'rgba(239,68,68,0.3)'
                  : null;
                return (
                  <g key={ring}>
                    <ellipse cx={cx} cy={cy} rx={ringRx[ring]} ry={ringRy[ring]}
                      fill="none"
                      stroke={cascadeColor || 'rgba(255,255,255,0.06)'}
                      strokeWidth="3"
                      filter="url(#ring-glow)" />
                    <ellipse cx={cx} cy={cy} rx={ringRx[ring]} ry={ringRy[ring]}
                      fill="none"
                      stroke={cascadeColor || 'rgba(255,255,255,0.08)'}
                      strokeWidth="0.5" />
                  </g>
                );
              })}


              {!isCascadeActive && nodes.filter(n => n.ring <= 2).map(node => {
                const rad = (node.angle * Math.PI) / 180;
                const nx = cx + Math.cos(rad) * getRx(node.ring);
                const ny = cy + Math.sin(rad) * getRy(node.ring);
                return (
                  <line key={`line-c-${node.name}`} x1={cx} y1={cy} x2={nx} y2={ny}
                    stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
                );
              })}
              {!isCascadeActive && nodes.filter(n => n.ring === 3).map(r3node => {
                const r3rad = (r3node.angle * Math.PI) / 180;
                const r3x = cx + Math.cos(r3rad) * ringRx[3];
                const r3y = cy + Math.sin(r3rad) * ringRy[3];
                return nodes.filter(n => n.ring === 4).map(r4node => {
                  const r4rad = (r4node.angle * Math.PI) / 180;
                  const r4x = cx + Math.cos(r4rad) * ringRx[4];
                  const r4y = cy + Math.sin(r4rad) * ringRy[4];
                  return (
                    <line key={`line-${r3node.name}-${r4node.name}`}
                      x1={r3x} y1={r3y} x2={r4x} y2={r4y}
                      stroke={r4node.type === 'propamm' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.03)'}
                      strokeWidth="1" />
                  );
                });
              })}

              {isCascadeActive && clickedRing !== null && (() => {
                const clicked = isCenterClicked ? null : nodes.find(n => n.name === cascadeNode);
                const cX = clicked ? cx + Math.cos((clicked.angle * Math.PI) / 180) * getRx(clicked.ring) : cx;
                const cY = clicked ? cy + Math.sin((clicked.angle * Math.PI) / 180) * getRy(clicked.ring) : cy;
                return (
                  <>
                    {(isCenterClicked || view !== 'impact') && nodes.filter(n => n.ring > clickedRing).map(outer => {
                      const oRad = (outer.angle * Math.PI) / 180;
                      const oX = cx + Math.cos(oRad) * getRx(outer.ring);
                      const oY = cy + Math.sin(oRad) * getRy(outer.ring);
                      return (
                        <line key={`blast-${outer.name}`}
                          x1={cX} y1={cY} x2={oX} y2={oY}
                          stroke="rgba(239,68,68,0.18)" strokeWidth="1.5" />
                      );
                    })}
                    {view !== 'exposure' && nodes.filter(n => n.ring < clickedRing).map(inner => {
                      const iRad = (inner.angle * Math.PI) / 180;
                      const iX = cx + Math.cos(iRad) * getRx(inner.ring);
                      const iY = cy + Math.sin(iRad) * getRy(inner.ring);
                      return (
                        <line key={`attack-${inner.name}`}
                          x1={iX} y1={iY} x2={cX} y2={cY}
                          stroke="rgba(251,146,60,0.18)" strokeWidth="1.5" />
                      );
                    })}
                    {view !== 'exposure' && clickedRing > 0 && (
                      <line x1={cx} y1={cy} x2={cX} y2={cY}
                        stroke="rgba(251,146,60,0.25)" strokeWidth="2" />
                    )}
                  </>
                );
              })()}

              {(() => {
                const baseColor = view === 'impact' ? '#f97316' : '#10b981';
                const centerClicked = cascadeNode === '__center__';
                const showUpstream = view !== 'exposure';
                const color = centerClicked ? '#ef4444' : (isCascadeActive && !isCenterClicked && showUpstream) ? '#fb923c' : baseColor;
                const isActive = centerClicked || (isCascadeActive && showUpstream);
                return (
                  <g
                    onClick={(e) => { e.stopPropagation(); triggerCascade(centerClicked ? null : '__center__'); }}
                    onMouseEnter={() => setHovered('__center__')}
                    onMouseLeave={() => setHovered(null)}
                    style={{ cursor: 'pointer' }}
                  >
                    {(() => { const cr = centerClicked ? 35 : 32; return (
                      <>
                        <circle cx={cx} cy={cy} r={cr}
                          fill={color}
                          fillOpacity={isActive ? 0.25 : 0.15}
                          stroke={color}
                          strokeWidth={isActive ? 2 : 1.5}
                          strokeOpacity={1}
                          filter={isActive ? 'url(#glow-cascade)' : 'url(#glow-center)'} />
                        {LOGO_FILENAMES[name] && (
                          <>
                            <clipPath id="clip-center"><circle cx={cx} cy={cy} r={cr - 1} /></clipPath>
                            <image href={`/logos/${LOGO_FILENAMES[name]}.png`}
                              x={cx - cr * 1.05} y={cy - cr * 1.05}
                              width={cr * 2.1} height={cr * 2.1}
                              clipPath="url(#clip-center)"
                              opacity={isActive ? 0.2 : 0.25}
                              preserveAspectRatio="xMidYMid slice" />
                          </>
                        )}
                      </>
                    ); })()}
                  </g>
                );
              })()}

              {nodes.map((node, nodeIdx) => {
                const rad = (node.angle * Math.PI) / 180;
                const nx = cx + Math.cos(rad) * getRx(node.ring);
                const ny = cy + Math.sin(rad) * getRy(node.ring);
                const isHovered = hovered === node.name;
                const isClicked = cascadeNode === node.name;
                const isImpactNode = view === 'all' && impactNodeNames.has(node.name) && !exposureNodeNames.has(node.name);

                const onAttackPath = isAttackPath(node.ring);
                const onBlastRadius = isBlastRadius(node.ring);
                const isActive = isClicked || onAttackPath || onBlastRadius;
                const isDimmed = isCascadeActive && !isActive;

                const baseColor = isImpactNode ? '#f97316' : (TYPE_COLORS[node.type] || TYPE_COLORS.external);
                const color = isClicked ? '#ef4444' : onBlastRadius ? '#ef4444' : onAttackPath ? '#fb923c' : baseColor;
                const baseR = 20;
                const nodeR = baseR;
                const fontSize = node.name.length > 14 ? 8 : node.name.length > 10 ? 9 : 10;

                const fillOpacity = isClicked ? 0.5 : onBlastRadius ? 0.3 : onAttackPath ? 0.25 : isDimmed ? 0.04 : isHovered ? 0.4 : 0.15;
                const strokeOpacity = isClicked ? 1 : isActive ? 0.8 : isDimmed ? 0.15 : isHovered ? 1 : 0.6;
                const textFill = isClicked ? 'white' : isActive ? 'rgba(255,255,255,0.9)' : isDimmed ? 'rgba(255,255,255,0.2)' : isHovered ? 'white' : 'rgba(255,255,255,0.8)';

                const r = isClicked ? nodeR + 3 : nodeR;
                const glowFilter = isClicked ? 'url(#glow-cascade)' : isHovered ? 'url(#glow-node)' : isDimmed ? undefined : 'url(#glow-ambient)';

                return (
                  <g key={node.name}
                    onMouseEnter={() => setHovered(node.name)}
                    onMouseLeave={() => setHovered(null)}
                    onTouchStart={() => handleTouchStart(node.name)}
                    onTouchEnd={handleTouchEnd}
                    onClick={(e) => { e.stopPropagation(); triggerCascade(isClicked ? null : node.name); }}
                    style={{ cursor: 'pointer' }}
                  >
                    <circle cx={nx} cy={ny} r={r + 2}
                      fill="none" stroke={color}
                      strokeWidth="0.5"
                      strokeOpacity={isDimmed ? 0.05 : 0.2}
                      filter={glowFilter} />
                    <circle cx={nx} cy={ny} r={r}
                      fill={color}
                      fillOpacity={fillOpacity}
                      stroke={color}
                      strokeWidth={isClicked ? 2 : isHovered ? 1.5 : 0.8}
                      strokeOpacity={strokeOpacity} />
                    {LOGO_FILENAMES[node.name] && (
                      <>
                        <clipPath id={`clip-${node.name.replace(/[^a-zA-Z0-9]/g, '')}`}>
                          <circle cx={nx} cy={ny} r={r - 1} />
                        </clipPath>
                        <image
                          href={`/logos/${LOGO_FILENAMES[node.name]}.png`}
                          x={nx - r * 1.05} y={ny - r * 1.05}
                          width={r * 2.1} height={r * 2.1}
                          clipPath={`url(#clip-${node.name.replace(/[^a-zA-Z0-9]/g, '')})`}
                          opacity={isDimmed ? 0.05 : isHovered ? 0.5 : 0.35}
                          preserveAspectRatio="xMidYMid slice"
                        />
                      </>
                    )}
                    {(!LOGO_FILENAMES[node.name] || ASSET_LABELS[node.name]) && (
                      <text
                        x={nx} y={LOGO_FILENAMES[node.name] ? ny + r + 11 : ny + 4}
                        textAnchor="middle"
                        fill={textFill}
                        fontSize={LOGO_FILENAMES[node.name] ? 7 : fontSize}
                        fontWeight={isClicked ? '700' : '500'}
                      >
                        {ASSET_LABELS[node.name] || (node.name.length > 18 ? node.name.slice(0, 16) + '..' : node.name)}
                      </text>
                    )}
                  </g>
                );
              })}
            </>
          );
        })()}

        {(() => {
          const isCenterCascade = cascadeNode === '__center__';
          const cRing = isCenterCascade ? 0 : (cascadeNode ? nodes.find(n => n.name === cascadeNode)?.ring ?? null : null);
          const blastNodes = cRing !== null && view !== 'impact' ? nodes.filter(n => n.ring > cRing) : [];
          const attackNodes = cRing !== null && !isCenterCascade && view !== 'exposure' ? nodes.filter(n => n.ring < cRing) : [];
          const blastCount = blastNodes.length;
          const attackCount = attackNodes.length;
          const infoNode = isCenterCascade ? { name, governance: '', note: '' } : (cascadeNode ? nodes.find(n => n.name === cascadeNode) : hoveredNode);

          const affectedNames = isCenterCascade ? [...nodes.map(n => n.name), name] : [...blastNodes.map(n => n.name), ...attackNodes.map(n => n.name), name];
          const tvlAtRisk = tvlData ? affectedNames.reduce((sum, n) => sum + (tvlData[n] || 0), 0) : 0;
          const tvlStr = tvlAtRisk > 1e9 ? '$' + (tvlAtRisk/1e9).toFixed(1) + 'B' : tvlAtRisk > 1e6 ? '$' + Math.round(tvlAtRisk/1e6) + 'M' : '';

          if (!infoNode && hovered !== '__center__') return null;
          const displayName = (infoNode as any)?.name || name;
          return (
            <g>
              <rect x={20} y={452} width={960} height={32} rx={4} fill="rgba(0,0,0,0.85)" stroke={cascadeNode ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.08)'} />
              <text x={30} y={472} fill={cascadeNode ? '#ef4444' : 'white'} fontSize="11" fontWeight="600">{displayName}</text>
              <text x={220} y={472} fill="#9ca3af" fontSize="9">
                {isCenterCascade
                  ? `${nodes.length} protocol${nodes.length !== 1 ? 's' : ''} potentially exposed` + (tvlStr ? ` - ${tvlStr} TVL in range` : '')
                  : cascadeNode
                  ? (blastCount > 0 && attackCount > 0
                    ? `${attackCount} upstream + ${blastCount} downstream potentially exposed` + (tvlStr ? ` - ${tvlStr} TVL in range` : '')
                    : blastCount > 0
                    ? `${blastCount} downstream protocol${blastCount !== 1 ? 's' : ''} potentially exposed` + (tvlStr ? ` - ${tvlStr} TVL in range` : '')
                    : attackCount > 0
                    ? `${attackCount} upstream protocol${attackCount !== 1 ? 's' : ''} potentially exposed` + (tvlStr ? ` - ${tvlStr} TVL in range` : '')
                    : 'Centre protocol potentially exposed' + (tvlStr ? ` - ${tvlStr} TVL` : ''))
                  : nodeTldr((infoNode as any)?.name, (infoNode as any)?.governance)
                }
              </text>
            </g>
          );
        })()}

        {maxRing > 0 && (() => {
          const exposureLayers = [
            { ring: 1, label: 'Price feeds', desc: 'If compromised, may cascade incorrect data to outer layers' },
            { ring: 2, label: 'Collateral', desc: 'If depegged, may reduce borrowing capacity' },
            { ring: 3, label: 'Routing', desc: 'If disrupted, may delay or block liquidations' },
            { ring: 4, label: 'Settlement', desc: 'If impaired, may limit where assets can be sold' },
          ];
          const impactLayers = [
            { ring: 1, label: 'Direct dependents', desc: 'Protocols that rely on this one directly' },
            { ring: 2, label: 'Second-degree', desc: 'Affected via a direct dependent' },
            { ring: 3, label: 'Further cascade', desc: 'Deeper indirect exposure' },
          ];
          const hasExposure = exposureNodes.length > 0;
          const hasImpact = impactNodes.length > 0;
          let layers: typeof exposureLayers = [];
          if (view === 'exposure') layers = exposureLayers;
          else if (view === 'impact') layers = impactLayers;
          else if (hasImpact && !hasExposure) layers = impactLayers;
          else layers = exposureLayers;
          layers = layers.filter(l => nodes.some(n => Math.round(n.ring) === l.ring));
          if (layers.length === 0) return null;
          return layers.map((l, i) => (
            <g key={l.ring}>
              <text x={15} y={18 + i * 13} fill="rgba(255,255,255,0.3)" fontSize="7">
                {l.ring}. {l.label} - {l.desc}
              </text>
            </g>
          ));
        })()}

      </svg>
      <BlastWave nodes={nodes} cascadeNode={cascadeNode} blastKey={blastKey} cx={cx} cy={cy} getRx={getRx} getRy={getRy} />
    </div>
  );
}

function inferCategory(name: string): string {
  const overrides: Record<string, string> = {
    'Kamino': 'Lending', 'Project 0': 'Lending', 'Jupiter Lend': 'Lending',
    'Save (Solend)': 'Lending', 'Loopscale': 'Lending',
    'Hylo': 'Stablecoin', 'Wick': 'Lending', 'Huma Finance': 'PayFi',
    'Drift': 'Perps', 'Jupiter Perps': 'Perps', 'Flash Trade': 'Perps', 'Parcl': 'Perps',
    'Jupiter Agg': 'Aggregator', 'Lulo': 'Aggregator',
    'Orca': 'DEX', 'Raydium': 'DEX', 'Meteora': 'DEX', 'Phoenix DEX': 'DEX',
    'Stabble': 'DEX', 'Pumpfun + PumpSwap': 'DEX', 'MetaDAO': 'Governance', 'PancakeSwap': 'DEX',
    'Pyth': 'Oracle', 'Switchboard': 'Oracle',
    'Jito': 'Liquid Staking', 'Marinade': 'Liquid Staking', 'Sanctum': 'Liquid Staking', 'Solayer': 'Liquid Staking',
    'Solstice': 'Yield', 'Exponent': 'Yield', 'Titan': 'Aggregator', 'Voltr': 'Yield',
    'Magic Eden': 'NFT', 'Tensor': 'NFT', 'Nosana': 'DePIN', 'Helium': 'DePIN',
    'BisonFi': 'Prop AMM', 'Tessera V': 'Prop AMM', 'HumidiFi': 'Prop AMM',
    'Photon': 'Trading Bot', 'deBridge': 'Bridge',
    'Zebec': 'Infrastructure', 'Onre Finance': 'Other', 'SPL Stake Pool': 'Infrastructure',
    'LayerZero OFT': 'Bridge', 'SolvBTC': 'Bridge', 'GMSOL': 'Perps', 'GMSOL Deploy': 'Perps', 'Ore': 'Infrastructure',
    'Carrot': 'Yield', 'DefiTuna': 'Lending',
    'Neutral Trade': 'Yield', 'Vectis Finance': 'Yield', 'HawkFi': 'Yield', 'Perena': 'Yield',
  };
  if (overrides[name]) return overrides[name];

  const e = EXPOSURES[name];
  if (!e) return 'Other';
  const desc = e.description.toLowerCase();
  const firstSentence = desc.split('.')[0];
  if (firstSentence.includes('proprietary amm') || firstSentence.includes('dark amm')) return 'Prop AMM';
  if (firstSentence.includes('trading bot')) return 'Trading Bot';
  if (firstSentence.includes('bridge') || firstSentence.includes('cross-chain')) return 'Bridge';
  if (firstSentence.includes('oracle')) return 'Oracle';
  if (firstSentence.includes('aggregator') || name.includes('Agg')) return 'Aggregator';
  if (firstSentence.includes('perpetual') || firstSentence.includes('perp')) return 'Perps';
  if (firstSentence.includes('dex') || firstSentence.includes('swap')) return 'DEX';
  if (firstSentence.includes('lend') || firstSentence.includes('borrow')) return 'Lending';
  if (firstSentence.includes('yield') || firstSentence.includes('vault')) return 'Yield';
  if (firstSentence.includes('staking') || firstSentence.includes('restaking')) return 'Liquid Staking';
  if (firstSentence.includes('nft') || firstSentence.includes('marketplace')) return 'NFT';
  return 'Other';
}

interface OverviewNode {
  name: string;
  category: string;
  angle: number;
  ring: number;
  connections: number;
}

function buildOverviewNodes(): OverviewNode[] {
  const BLAST_ONLY = new Set(['Neutral Trade', 'Vectis Finance', 'HawkFi', 'Perena']);
  const allNodes: OverviewNode[] = EXPOSURE_PROTOCOLS.filter(name => !BLAST_ONLY.has(name)).map(name => {
    const cat = inferCategory(name);
    const { upstream, downstream } = getRelationships(name);
    const connections = upstream.length + downstream.length;
    const ring = connections > 5 ? 1 : connections > 2 ? 2 : 3;
    return { name, category: cat, angle: 0, ring, connections };
  });

  const byRing: Record<number, OverviewNode[]> = { 1: [], 2: [], 3: [] };
  for (const n of allNodes) byRing[n.ring].push(n);

  for (const ring of [1, 2, 3]) {
    const group = byRing[ring];
    group.sort((a, b) => a.category.localeCompare(b.category));
    const offset = ring * 15;
    group.forEach((n, i) => {
      n.angle = (360 / group.length) * i + offset;
    });
  }

  return allNodes;
}

export function OverviewSolarSystem({ onSelect }: { onSelect: (name: string) => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const nodes = useMemo(() => buildOverviewNodes(), []);

  const cx = 500;
  const cy = 230;
  const ringRx = [0, 175, 310, 460];
  const ringRy = [0, 70, 120, 180];
  const ringRadii = ringRx;

  const hoveredNode = nodes.find(n => n.name === hovered);

  return (
    <div className="relative overflow-hidden rounded-lg">
      <Starfield />
      <svg viewBox="0 0 1000 490" className="relative w-full mx-auto">
        <defs>
          <filter id="ring-glow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
          <filter id="glow-ov" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <radialGradient id="nebula-ov" cx="50%" cy="49%" r="50%">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.025" />
            <stop offset="50%" stopColor="#3b82f6" stopOpacity="0.012" />
            <stop offset="100%" stopColor="transparent" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1000" height="490" fill="transparent" />
        <ellipse cx={cx} cy={cy} rx="480" ry="220" fill="url(#nebula-ov)" />

        {[1, 2, 3].map(ring => (
          <g key={ring}>
            <ellipse cx={cx} cy={cy} rx={ringRx[ring]} ry={ringRy[ring]}
              fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" filter="url(#ring-glow)" />
            <ellipse cx={cx} cy={cy} rx={ringRx[ring]} ry={ringRy[ring]}
              fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
          </g>
        ))}

        <circle cx={cx} cy={cy} r={40} fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        <clipPath id="clip-solana-center"><circle cx={cx} cy={cy} r={39} /></clipPath>
        <image href="/logos/solana.png"
          x={cx - 40} y={cy - 40} width={80} height={80}
          clipPath="url(#clip-solana-center)"
          opacity="0.2" preserveAspectRatio="xMidYMid slice" />

        {nodes.filter(n => n.connections > 5).map(mainNode => {
          const mRad = (mainNode.angle * Math.PI) / 180;
          const mx = cx + Math.cos(mRad) * ringRx[mainNode.ring];
          const my = cy + Math.sin(mRad) * ringRy[mainNode.ring];
          return (
            <line key={`hub-${mainNode.name}`}
              x1={cx} y1={cy} x2={mx} y2={my}
              stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
          );
        })}

        {nodes.map(node => {
          const rad = (node.angle * Math.PI) / 180;
          const nx = cx + Math.cos(rad) * ringRx[node.ring];
          const ny = cy + Math.sin(rad) * ringRy[node.ring];
          const isHovered = hovered === node.name;
          const color = CATEGORY_COLORS[node.category] || CATEGORY_COLORS.Other;
          const baseR = node.connections > 5 ? 21 : node.connections > 2 ? 18 : 15;
          const nodeR = isHovered ? baseR + 2 : baseR;
          const fontSize = node.name.length > 12 ? 6.5 : node.name.length > 8 ? 7.5 : 8;

          return (
            <g key={node.name}
              onMouseEnter={() => setHovered(node.name)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onSelect(node.name)}
              style={{ cursor: 'pointer' }}
            >
              <circle cx={nx} cy={ny} r={nodeR + 2}
                fill="none" stroke={color} strokeWidth="0.5" strokeOpacity={0.2}
                filter={isHovered ? 'url(#glow-ov)' : 'url(#ring-glow)'} />
              <circle
                cx={nx} cy={ny} r={nodeR}
                fill={color}
                fillOpacity={isHovered ? 0.45 : 0.15}
                stroke={color}
                strokeWidth={isHovered ? 1.5 : 0.8}
                strokeOpacity={isHovered ? 1 : 0.5}
              />
              {LOGO_FILENAMES[node.name] && (
                <>
                  <clipPath id={`ov-clip-${node.name.replace(/[^a-zA-Z0-9]/g, '')}`}>
                    <circle cx={nx} cy={ny} r={nodeR - 1} />
                  </clipPath>
                  <image
                    href={`/logos/${LOGO_FILENAMES[node.name]}.png`}
                    x={nx - nodeR * 1.05} y={ny - nodeR * 1.05}
                    width={nodeR * 2.1} height={nodeR * 2.1}
                    clipPath={`url(#ov-clip-${node.name.replace(/[^a-zA-Z0-9]/g, '')})`}
                    opacity={isHovered ? 0.5 : 0.35}
                    preserveAspectRatio="xMidYMid slice"
                  />
                </>
              )}
              {!LOGO_FILENAMES[node.name] && (
                <text
                  x={nx} y={ny + 4}
                  textAnchor="middle"
                  fill={isHovered ? 'white' : 'rgba(255,255,255,0.75)'}
                  fontSize={fontSize}
                  fontWeight={isHovered ? '600' : '500'}
                >
                  {node.name.length > 16 ? node.name.slice(0, 14) + '..' : node.name}
                </text>
              )}
            </g>
          );
        })}

        {hoveredNode && (
          <g>
            <rect x={20} y={452} width={960} height={32} rx={4} fill="rgba(0,0,0,0.85)" stroke="rgba(255,255,255,0.08)" />
            <text x={30} y={472} fill="white" fontSize="11" fontWeight="600">{ASSET_LABELS[hoveredNode.name] || hoveredNode.name}</text>
            <text x={200} y={472} fill="#9ca3af" fontSize="9">{hoveredNode.category} - {hoveredNode.connections} connections - Click to explore</text>
          </g>
        )}

      </svg>
    </div>
  );
}

interface CaseStudyNode {
  name: string;
  loss: string;
  chainDepth: number;
  lossValue: number;
}

function parseLoss(loss: string): number {
  if (loss === 'Undisclosed') return 0;
  const cleaned = loss.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  if (loss.includes('M')) return num * 1000000;
  if (loss.includes('K')) return num * 1000;
  return num || 0;
}

export function DriftCaseStudySolar({ affected }: { affected: { name: string; loss: string; chainDepth: number }[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const nodes: CaseStudyNode[] = useMemo(() =>
    affected.map(p => ({ ...p, lossValue: parseLoss(p.loss) }))
  , [affected]);

  const cx = 500;
  const cy = 230;

  const ringRx = [0, 200, 350, 460];
  const ringRy = [0, 100, 160, 200];
  const getRx = (r: number) => { const cr = Math.max(0, Math.min(r, 3)); const lo = Math.floor(cr), hi = Math.min(Math.ceil(cr), 3), f = cr - lo; return (ringRx[lo]||0)*(1-f) + (ringRx[hi]||ringRx[lo]||0)*f; };
  const getRy = (r: number) => { const cr = Math.max(0, Math.min(r, 3)); const lo = Math.floor(cr), hi = Math.min(Math.ceil(cr), 3), f = cr - lo; return (ringRy[lo]||0)*(1-f) + (ringRy[hi]||ringRy[lo]||0)*f; };

  const positioned = useMemo(() => {
    const byDepth: Record<number, CaseStudyNode[]> = {};
    for (const n of nodes) {
      const d = Math.min(n.chainDepth, 3);
      if (!byDepth[d]) byDepth[d] = [];
      byDepth[d].push(n);
    }
    for (const d of Object.keys(byDepth)) {
      byDepth[Number(d)].sort((a, b) => b.lossValue - a.lossValue);
    }

    const rand = seededRand(285);
    const result: (CaseStudyNode & { angle: number; ring: number })[] = [];
    for (const [depth, group] of Object.entries(byDepth)) {
      const baseRing = Number(depth);
      if (baseRing === 1 && group.length > 6) {
        const quantified = group.filter(n => n.lossValue > 0);
        const undisclosed = group.filter(n => n.lossValue === 0);
        const sorted = [...quantified, ...undisclosed];
        sorted.forEach((n, i) => {
          const ringPos = 0.6 + (i / (sorted.length - 1 || 1)) * 1.2;
          const angle = i * 137.508;
          const jitter = (rand() - 0.5) * 15;
          result.push({ ...n, ring: ringPos + (rand() - 0.5) * 0.1, angle: angle + jitter });
        });
      } else {
        group.forEach((n, i) => {
          const offset = baseRing * 20;
          const jitter = (rand() - 0.5) * 20;
          result.push({ ...n, ring: baseRing + (rand() - 0.5) * 0.2, angle: (360 / group.length) * i + offset + jitter });
        });
      }
    }

    const minDist = 55;
    for (let iter = 0; iter < 10; iter++) {
      for (let i = 0; i < result.length; i++) {
        for (let j = i + 1; j < result.length; j++) {
          const a = result[i], b = result[j];
          const aRad = (a.angle * Math.PI) / 180, bRad = (b.angle * Math.PI) / 180;
          const ax = cx + Math.cos(aRad) * getRx(a.ring), ay = cy + Math.sin(aRad) * getRy(a.ring);
          const bx = cx + Math.cos(bRad) * getRx(b.ring), by = cy + Math.sin(bRad) * getRy(b.ring);
          const dist = Math.sqrt((bx-ax)**2 + (by-ay)**2);
          if (dist < minDist && dist > 0) {
            const overlap = (minDist - dist) / minDist;
            const push = 2 + overlap * 3;
            result[i].angle -= push;
            result[j].angle += push;
            if (Math.abs(a.ring - b.ring) < 0.3) {
              result[i].ring = Math.max(0.3, result[i].ring - 0.05);
              result[j].ring = Math.min(2.9, result[j].ring + 0.05);
            }
          }
        }
      }
    }
    return result;
  }, [nodes, cx, getRx, getRy]);

  const hoveredNode = positioned.find(n => n.name === hovered);
  const maxLoss = Math.max(...nodes.map(n => n.lossValue), 1);

  return (
    <div className="relative overflow-hidden rounded-lg">
      <Starfield />
      <svg viewBox="0 0 1000 490" className="relative w-full mx-auto">
        <defs>
          <filter id="glow-drift" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="ring-glow-d" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
          <radialGradient id="nebula-drift" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.04" />
            <stop offset="50%" stopColor="#ef4444" stopOpacity="0.015" />
            <stop offset="100%" stopColor="transparent" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1000" height="490" fill="transparent" />
        <ellipse cx={cx} cy={cy} rx="480" ry="240" fill="url(#nebula-drift)" />

        {[1, 2, 3].map(ring => {
          if (!positioned.some(n => Math.round(n.ring) === ring)) return null;
          return (
            <g key={ring}>
              <ellipse cx={cx} cy={cy} rx={ringRx[ring]} ry={ringRy[ring]}
                fill="none" stroke="rgba(239,68,68,0.08)" strokeWidth="3" filter="url(#ring-glow-d)" />
              <ellipse cx={cx} cy={cy} rx={ringRx[ring]} ry={ringRy[ring]}
                fill="none" stroke="rgba(239,68,68,0.1)" strokeWidth="0.5" />
            </g>
          );
        })}

        {positioned.map(node => {
          const rad = (node.angle * Math.PI) / 180;
          const nx = cx + Math.cos(rad) * getRx(node.ring);
          const ny = cy + Math.sin(rad) * getRy(node.ring);
          const opacity = node.lossValue > 0 ? 0.06 + (node.lossValue / maxLoss) * 0.1 : 0.03;
          return (
            <line key={`line-${node.name}`}
              x1={cx} y1={cy} x2={nx} y2={ny}
              stroke={`rgba(239,68,68,${opacity})`} strokeWidth="1" />
          );
        })}

        <circle cx={cx} cy={cy} r={36} fill="#ef4444" fillOpacity="0.2" stroke="#ef4444" strokeWidth="2" filter="url(#glow-drift)" />
        <clipPath id="clip-drift-center"><circle cx={cx} cy={cy} r={35} /></clipPath>
        <image href="/logos/drift.png"
          x={cx - 37} y={cy - 37} width={74} height={74}
          clipPath="url(#clip-drift-center)"
          opacity="0.2" preserveAspectRatio="xMidYMid slice" />
        <text x={cx} y={cy + 6} textAnchor="middle" fill="rgba(239,68,68,0.8)" fontSize="9">$285M+</text>

        {positioned.map(node => {
          const rad = (node.angle * Math.PI) / 180;
          const nx = cx + Math.cos(rad) * getRx(node.ring);
          const ny = cy + Math.sin(rad) * getRy(node.ring);
          const isHovered = hovered === node.name;

          const baseR = node.lossValue > 5000000 ? 28 : node.lossValue > 1000000 ? 24 : node.lossValue > 0 ? 20 : 16;
          const nodeR = isHovered ? baseR + 3 : baseR;

          const intensity = node.lossValue > 0 ? 0.15 + (node.lossValue / maxLoss) * 0.25 : 0.08;
          const strokeIntensity = node.lossValue > 0 ? 0.5 + (node.lossValue / maxLoss) * 0.5 : 0.3;
          const fontSize = node.name.length > 14 ? 7.5 : node.name.length > 10 ? 8.5 : 9.5;

          return (
            <g key={node.name}
              onMouseEnter={() => setHovered(node.name)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={nx} cy={ny} r={nodeR}
                fill="#ef4444"
                fillOpacity={isHovered ? intensity + 0.2 : intensity}
                stroke="#ef4444"
                strokeWidth={isHovered ? 2 : 1}
                strokeOpacity={isHovered ? 1 : strokeIntensity}
              />
              <text
                x={nx} y={ny + (node.lossValue > 0 ? 0 : 4)}
                textAnchor="middle"
                fill={isHovered ? 'white' : `rgba(255,255,255,${node.lossValue > 0 ? 0.85 : 0.6})`}
                fontSize={fontSize}
                fontWeight="500"
              >
                {node.name.length > 16 ? node.name.slice(0, 14) + '..' : node.name}
              </text>
              {node.lossValue > 0 && (
                <text
                  x={nx} y={ny + 12}
                  textAnchor="middle"
                  fill="rgba(239,68,68,0.7)"
                  fontSize="8"
                >
                  {node.loss}
                </text>
              )}
            </g>
          );
        })}

        {hoveredNode && (
          <g>
            <rect x={20} y={452} width={960} height={32} rx={4} fill="rgba(0,0,0,0.85)" stroke="rgba(255,255,255,0.08)" />
            <text x={30} y={472} fill="white" fontSize="11" fontWeight="600">{hoveredNode.name}</text>
            <text x={220} y={472} fill="#9ca3af" fontSize="9">
              {hoveredNode.loss !== 'Undisclosed' ? hoveredNode.loss + ' lost' : 'Loss undisclosed'} - Chain depth {hoveredNode.chainDepth}
            </text>
          </g>
        )}

        <text x={cx} y={18} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="9">
          22 protocols affected - $37.1M quantified downstream losses - April 1, 2026
        </text>

        {[
          { label: 'Quantified loss', opacity: 0.35 },
          { label: 'Undisclosed', opacity: 0.08 },
        ].map((item, i) => (
          <g key={item.label}>
            <circle cx={400 + i * 150} cy={36} r={5} fill="#ef4444" fillOpacity={item.opacity} stroke="#ef4444" strokeWidth="1" strokeOpacity={0.5} />
            <text x={410 + i * 150} y={40} fill="rgba(255,255,255,0.4)" fontSize="8">{item.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
