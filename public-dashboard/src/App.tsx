// This is the top-level React dashboard at solgov.xyz. It renders the four tabbed views (Dashboard table, GovWatch activity feed, Blast Radius dependency map, and Charts) and wires live API data into the UI.

import { useState, useMemo, useRef, Fragment, useEffect } from 'react';

function Dropdown({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = options.find(o => o.value === value)?.label || value;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        className="bg-white/[0.03] border border-white/[0.08] rounded-md px-3 py-1.5 text-[13px] text-gray-300 flex items-center gap-2 min-w-[140px] justify-between hover:border-white/[0.15] transition-colors"
        onClick={() => setOpen(!open)}
      >
        {label}
        <span className="text-gray-400 text-[10px]">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-[#0e0e14] border border-white/[0.08] rounded-md shadow-2xl z-50 min-w-[160px] py-1">
          {options.map(o => (
            <button
              key={o.value}
              className={`block w-full text-left px-3 py-1.5 text-[13px] hover:bg-white/[0.04] transition-colors ${o.value === value ? 'text-white bg-white/[0.04]' : 'text-gray-400'}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
import { PROTOCOLS, STATS, SQUADS_MINIMUM } from './data/protocols';
import { GOV_PROFILES, GOV_PROFILES_AS_OF } from './data/governance';
import { displayName } from './data/displayNames';
import { EXPOSURES, EXPOSURE_PROTOCOLS, resolveExposureNode } from './data/exposure';
import type { ExposureNode } from './data/exposure';
import { getRelationships } from './data/relationships';
import { DRIFT_CASE_STUDY } from './data/driftCaseStudy';
import { SolarSystem, OverviewSolarSystem, DriftCaseStudySolar } from './components/SolarSystem';
import { IndependenceScorePanel, findLiveGroupForProtocol, findCaseStudyGroup } from './components/IndependenceScore';
import { GovernanceCharts } from './components/GovernanceCharts';
import { SolanaHackChart } from './components/SolanaHackChart';
import { ChainRiskPanel } from './components/ChainRiskPanel';
import { CompactHackChart } from './components/CompactHackChart';
import solanaHacksData from './data/solana-hacks.json';
import evmHacksData from './data/evm-hacks.json';
import tokenCustodyData from './data/token-custody.json';
import otherChainHacksData from './data/other-chain-hacks.json';
import { TvlChart } from './components/TvlChart';
import { useLiveData } from './hooks/useLiveData';
import { useDefiLlama, formatTvlDisplay, formatVolumeDisplay, type DefiLlamaData } from './hooks/useDefiLlama';
import { useYieldbayHealth } from './hooks/useYieldbayHealth';
import './index.css';
import ACTIVITY_FEED from './data/activity-feed.json';

import { Tooltip, InfoIcon } from './components/Tooltip';

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  ConfigChange: 'Config change',
  VaultTx: 'Vault transaction executed',
  SpendingLimit: 'Spending limit used',
  ProgramUpgrade: 'Program upgrade',
  Approval: 'Proposal approved',
  Rejection: 'Proposal rejected',
  Cancellation: 'Proposal cancelled',
  ProposalCreated: 'Proposal created',
  AuthorityActivity: 'Authority activity',
  AuthorityChange: 'Authority changed',
  ProposalPending: 'Proposal pending',
  GovernanceActivity: 'Governance activity',
  MintAuthorityChange: 'Mint authority change',
  DVNConfigChange: 'DVN config change',
  OFTRouteChange: 'OFT route change',
  IntegrityChange: 'Integrity change',
  TimelockAdded: 'Timelock added',
  TimelockRemoved: 'Timelock removed',
  TimelockChanged: 'Timelock changed',
  ThresholdRaised: 'Threshold raised',
  ThresholdLowered: 'Threshold lowered',
  SignersAdded: 'Signers added',
  SignersRemoved: 'Signers removed',
  SignerRotation: 'Signer rotation',
  ExternalAdminKeyAdded: 'External admin key set',
  ExternalAdminKeyCleared: 'External admin key cleared',
};

// Governance-change event types where the detail string is more informative
// than the generic label (e.g. "Signers: 8 → 7"). cleanLiveActivity surfaces
// detail for these so the feed shows what actually changed, not just the kind.
const GOV_CHANGE_TYPES: Set<string> = new Set([
  'ConfigChange',
  'TimelockAdded', 'TimelockRemoved', 'TimelockChanged',
  'ThresholdRaised', 'ThresholdLowered',
  'SignersAdded', 'SignersRemoved', 'SignerRotation',
  'ExternalAdminKeyAdded', 'ExternalAdminKeyCleared',
]);

function canonProtoName(raw: string): string {
  let s = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
  s = s.replace(/\s+Program$/i, '').trim();
  return s || raw;
}

function cleanLiveActivity(raw: { date: string; protocol: string; type: string; timestamp: string; detail?: string; multisig?: string }[]): { date: string; protocol: string; type: string; timestamp: string; rawType: string; multisig?: string }[] {
  const decisionKeys = new Set<string>();
  for (const e of raw) {
    if (e.type === 'Approval' || e.type === 'Rejection' || e.type === 'Cancellation') {
      decisionKeys.add(`${e.date}|${canonProtoName(e.protocol)}`);
    }
  }
  const out: { date: string; protocol: string; type: string; timestamp: string; rawType: string; multisig?: string }[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (!e.protocol || e.protocol === 'Unknown') continue;
    if (e.type === 'Watching') continue;
    const proto = canonProtoName(e.protocol);
    if (e.type === 'VaultTx' && decisionKeys.has(`${e.date}|${proto}`)) continue;
    let label = ACTIVITY_TYPE_LABELS[e.type] || e.type;
    // Governance-change events carry a specific detail string ("Timelock: none -> 24h", "Threshold: 2 -> 3") - surface it over the generic label so the feed shows exactly what changed.
    if (GOV_CHANGE_TYPES.has(e.type) && e.detail) label = e.detail;
    const key = `${e.date}|${proto}|${label}|${e.multisig || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: e.date, protocol: proto, type: label, timestamp: e.timestamp, rawType: e.type, multisig: e.multisig });
  }
  return out;
}

function Check({ pass, label }: { pass: boolean; label?: string }) {
  return (
    <span className={`font-bold ${pass ? 'text-white' : 'text-gray-500'}`}>
      {pass ? '\u2713' : '\u2717'} {label || ''}
    </span>
  );
}

export const LOGO_FILENAMES: Record<string, string> = {
  'Hastra PRIME': 'hastra',
  'Orca': 'orca',
  'Drift': 'velocity',
  'Kamino': 'kamino',
  'Jupiter Perps': 'jupiter',
  'Jupiter Lend': 'juplend',
  'Jupiter Agg': 'jupiter',
  'Magic Eden': 'magiceden',
  'Hylo': 'hylo',
  'Loopscale': 'loopscale',
  'Exponent': 'exponent',
  'Huma Finance': 'huma',
  'Solstice': 'solstice',
  'Pumpfun + PumpSwap': 'pumpfun',
  'Lulo': 'lulo',
  'Nosana': 'nosana',
  'Switchboard': 'switchboard',
  'Stabble': 'stabble',
  'Titan': 'titan',
  'Sanctum': 'sanctum',
  'Raydium': 'raydium',
  'Tensor': 'tensor',
  'Phoenix DEX': 'phoenix',
  'Meteora': 'meteora',
  'Marinade': 'marinade',
  'Pyth': 'pyth',
  'Jito': 'jito',
  'Solayer': 'solayer',
  'Flash Trade': 'flash',
  'Parcl': 'parcl',
  'Save (Solend)': 'save',
  'Zebec': 'zebec',
  'Wick': 'wick',
  'deBridge': 'debridge',
  'Helium': 'helium',
  'Tessera V': 'tesserav',
  'Voltr': 'voltr',
  'BisonFi': 'bisonfi',
  'HumidiFi': 'humidifi',
  'Photon': 'photon',
  'MetaDAO': 'metadao',
  'Onre Finance': 'onre',
  'Edge (Chaos Labs)': 'chaos',
  'PancakeSwap': 'pancakeswap',
  'SPL Stake Pool': 'solana-program',
  'LayerZero OFT': 'layerzero',
  'SolvBTC': 'solv',
  'GMSOL': 'gmtrade',
  'Ore': 'ore',
  'Carrot': 'carrot',
  'DefiTuna': 'tuna',
  'BULK': 'bulk.jpg',
  'Phoenix Eternal': 'phoenix',
  'Adrena': 'adrena.jpg',
  'Bullet': 'bullet.jpg',
  'Bulk': 'bulktrade.jpg',
  'Project 0': 'project0',
  'HawkFi': 'hawkfi',
  'Perena': 'perena',
  'Vectis Finance': 'vectis',
  'Neutral Trade': 'neutral',
  'USDC': 'usdc',
  'JitoSOL': 'jito',
  'mSOL': 'marinade',
  'Sanctum LSTs': 'sanctum',
  'Scope (aggregator)': 'kamino',
  'SOL': 'solana',
  'Chainlink': 'chainlink',
  'RedStone': 'redstone',
  'USDT': 'usdt',
  'Internal AMM': 'driftamm',
};

function ProtocolLogo({ name }: { name: string }) {
  const [failed, setFailed] = useState(false);
  const filename = LOGO_FILENAMES[name];

  if (!filename || failed) {
    return (
      <span className="w-5 h-5 rounded-full bg-gray-700 text-[10px] text-gray-400 flex items-center justify-center font-bold flex-shrink-0">
        {name.charAt(0)}
      </span>
    );
  }

  const src = filename.includes('.') ? `/logos/${filename}` : `/logos/${filename}.png`;
  return (
    <img
      src={src}
      alt=""
      className="w-5 h-5 rounded-full flex-shrink-0"
      onError={() => setFailed(true)}
    />
  );
}

// Identity-aware custody upgrade. The structural classifier returns 'single-key' for any
// System Program owned account. That's misleading because Squads vault PDAs, Realms treasury
// PDAs, CEX hot wallets, and genuine single keys all look identical at that layer. Use the
// Helius identity overlay (name + tags) to upgrade to a more accurate label where possible.
// When no override fires, label as 'unverified' rather than 'single-key' to be honest about
// the limit of what we can confirm.
function effectiveCustody(rawCustody: string, identityName?: string, identityTags?: string[]): string {
  const name = (identityName || '').toLowerCase();
  const tagsJoined = (identityTags || []).join(' ').toLowerCase();
  const combined = `${name} ${tagsJoined}`;

  // Multisig signals (highest confidence, Helius explicitly labels these)
  if (combined.includes('squads multisig v4')) return 'squads-v4';
  if (combined.includes('squads multisig v3')) return 'squads-v3';
  if (combined.includes('squads')) return 'squads-v4';

  // Identity provider has named it a multisig. Lower confidence than an explicit Squads tag, but a
  // named multisig must never fall through to a single-key / unverified label.
  if (combined.includes('multisig') || combined.includes(' msig') || / ms ?#/i.test(name)) return 'multisig';

  // DAO / Realms signals
  if (combined.includes('realms') || combined.includes('spl governance')) return 'dao-realms';
  if (name.includes('dao treasury') || name.includes('dao vault') || name.includes('realm treasury')) return 'dao-realms';

  // CEX custody signals (Helius tags / known CEX names in identity)
  const cexNames = ['binance', 'coinbase', 'okx', 'kucoin', 'bybit', 'kraken', 'gate', 'crypto.com', 'huobi', 'mexc', 'bitkub', 'bitstamp', 'gemini', 'upbit'];
  const cexCustodyTags = ['fireblocks', 'coinbase prime', 'bitgo', 'copper', 'bitkub deposit', 'fireblocks custody'];
  if (cexNames.some(n => combined.includes(n)) ||
      cexCustodyTags.some(t => combined.includes(t)) ||
      name.includes('hot wallet') ||
      name.includes('exchange deposit') ||
      name.endsWith('deposit')) {
    return 'cex-custody';
  }

  // Foundation / team treasury (gentle label, Helius identified, just not as DAO)
  if (name.includes('foundation') || name.includes('treasury')) return 'foundation-treasury';

  // Vesting / lockup / protocol vault
  if (name.includes('vesting') || name.includes('lockup') || name.includes('cliff') || name.includes('escrow')) return 'vesting';
  if (name.endsWith(' vault') || name.includes('insurance fund') || name.includes('protocol vault') || / vault$/i.test(name)) return 'protocol-vault';

  // Pass through known structural classifications
  if (rawCustody === 'squads-v4' || rawCustody === 'squads-v3' || rawCustody === 'serum-multisig' || rawCustody === 'spl-governance') return rawCustody;
  if (rawCustody === 'program-pda' || rawCustody === 'token-account') return rawCustody;

  // System Program owned with no identity signal, honest fallback
  if (rawCustody === 'single-key' || rawCustody === 'system-program') return 'unverified';
  return rawCustody;
}

function custodyLabel(c: string | null | undefined): string {
  if (!c) return '';
  return ({
    'squads-v4': 'Squads V4',
    'squads-v3': 'Squads V3',
    'multisig': 'Multisig',
    'serum-multisig': 'Serum multisig',
    'spl-governance': 'Realms DAO',
    'dao-realms': 'DAO / Realms',
    'cex-custody': 'CEX custody',
    'foundation-treasury': 'Foundation treasury',
    'vesting': 'Vesting / lockup',
    'protocol-vault': 'Protocol vault',
    'program-pda': 'Program-controlled',
    'token-account': 'Token account',
    'system-program': 'System',
    'single-key': 'Single key',
    'unverified': 'Unverified',
    'unknown': 'Unknown',
  } as Record<string, string>)[c] || c;
}

function custodyClass(c: string | null | undefined): string {
  if (!c) return 'text-gray-500';
  if (c === 'unverified' || c === 'single-key') return 'text-amber-300/80';
  if (c === 'unknown') return 'text-gray-500';
  if (c === 'cex-custody') return 'text-blue-300/80';
  if (c === 'dao-realms' || c === 'foundation-treasury' || c === 'protocol-vault') return 'text-emerald-300/80';
  return 'text-gray-300';
}

function fmtTokenAmount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function fmtUSD(n: number | undefined | null, prefix: string = '$'): string {
  if (n == null) return '-';
  if (n >= 1e9) return prefix + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return prefix + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return prefix + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return prefix + n.toFixed(2);
  if (n > 0) return prefix + n.toPrecision(3);
  return prefix + '0';
}

function TokenCustodySection({
  protocolName: _protocolName,
  tokenSymbol,
  snapshot,
}: {
  protocolName: string;
  tokenSymbol: string;
  snapshot: any;
}) {
  const [expanded, setExpanded] = useState(false);

  const upgradedHolders = snapshot.topHolders.map((h: any) => ({
    ...h,
    effectiveCustody: effectiveCustody(h.ownerCustody, h.identityName, h.identityTags),
  }));

  let unverifiedCount = 0;
  let multisigOrDaoCount = 0;
  let cexCount = 0;
  let programCount = 0;
  for (const h of upgradedHolders) {
    const c = h.effectiveCustody;
    if (c === 'unverified' || c === 'single-key' || c === 'unknown') unverifiedCount++;
    else if (c === 'cex-custody') cexCount++;
    else if (c.startsWith('squads') || c === 'serum-multisig' || c === 'spl-governance' || c === 'dao-realms' || c === 'foundation-treasury') multisigOrDaoCount++;
    else if (c === 'program-pda' || c === 'token-account' || c === 'vesting' || c === 'protocol-vault') programCount++;
  }

  const fundingClusters = (snapshot.fundingClusters as any[]) || [];
  // Map each clustered owner address to a cluster index so we can draw a small marker
  // on the table row in a matching colour to the callout above. Distinct colour per cluster
  // so two separate groups of linked wallets don't get visually mixed.
  const ownerToClusterIdx = new Map<string, number>();
  fundingClusters.forEach((c: any, idx: number) => {
    for (const owner of c.holderOwners) ownerToClusterIdx.set(owner, idx);
  });
  const clusterDotColors = [
    'bg-amber-300/80',
    'bg-sky-300/80',
    'bg-violet-300/80',
    'bg-emerald-300/80',
    'bg-rose-300/80',
  ];
  const colorForCluster = (idx: number) => clusterDotColors[idx % clusterDotColors.length];

  return (
    <>
      <h4 className="font-bold text-white mt-4 mb-2">
        Token Custody
        <Tooltip text="Top holders of the protocol's native token with on-chain custody classification (single-key vs multisig vs program-controlled), Helius identity labels where available, and a note on holders that share a common first-funder on chain."><InfoIcon /></Tooltip>
      </h4>

      {/* Compact market + authority row */}
      <div className="grid grid-cols-2 md:grid-cols-2 gap-2 mb-2">
        <div className="bg-white/[0.03] rounded p-2">
          <p className="text-gray-400 text-[10px]">{tokenSymbol} market cap</p>
          <p className="text-gray-300 text-[11px]">{fmtUSD(snapshot.marketCapUsd)}</p>
        </div>
        <div className="bg-white/[0.03] rounded p-2">
          <p className="text-gray-400 text-[10px]">Spot price</p>
          <p className="text-gray-300 text-[11px]">{fmtUSD(snapshot.priceUsd)}</p>
        </div>
        <div className="bg-white/[0.03] rounded p-2">
          <p className="text-gray-400 text-[10px]">Mint authority</p>
          <p className={`text-[11px] ${custodyClass(effectiveCustody(snapshot.mintAuthorityCustody || ''))}`}>
            {snapshot.mintAuthority === null ? 'Disabled (immutable)' : custodyLabel(effectiveCustody(snapshot.mintAuthorityCustody || ''))}
          </p>
        </div>
        <div className="bg-white/[0.03] rounded p-2">
          <p className="text-gray-400 text-[10px]">Freeze authority</p>
          <p className={`text-[11px] ${custodyClass(effectiveCustody(snapshot.freezeAuthorityCustody || ''))}`}>
            {snapshot.freezeAuthority === null ? 'Disabled' : custodyLabel(effectiveCustody(snapshot.freezeAuthorityCustody || ''))}
          </p>
        </div>
      </div>

      {/* Funding-cluster note. One line per cluster, each with its own dot colour.
          The dots match the markers next to the affected rows in the table below. */}
      {fundingClusters.length > 0 && (
        <div className="mb-2 p-2 rounded border border-white/[0.06] bg-white/[0.02]">
          {fundingClusters.map((c: any, i: number) => (
            <p key={c.funder} className={`text-[11px] text-gray-300 ${i > 0 ? 'mt-1' : ''}`}>
              <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${colorForCluster(i)}`} />
              {c.count} of the top wallets share the same first funder
            </p>
          ))}
        </div>
      )}

      {/* Expandable top-10 summary */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between bg-white/[0.03] hover:bg-white/[0.05] rounded p-2 text-left transition-colors"
      >
        <span className="text-[11px] text-gray-400">
          Top 10 holders control <span className="text-white font-medium">{snapshot.summary.topNPct.toFixed(1)}%</span> of supply
          <span className="text-gray-500 ml-2 block md:inline">
            ({multisigOrDaoCount} multisig/DAO, {cexCount} CEX, {programCount} program/lock, {unverifiedCount} unverified)
          </span>
        </span>
        <span className="text-[10px] text-gray-400 ml-2">{expanded ? '▴ hide' : '▾ show'}</span>
      </button>

      {expanded && (
        <>
          <div className="overflow-x-auto mt-2">
            <div className="overflow-hidden rounded border border-white/[0.04] min-w-[480px] md:min-w-0">
              <table className="w-full text-[11px]">
                <thead className="bg-white/[0.03]">
                  <tr className="text-gray-500">
                    <th className="text-left px-2 py-1.5 font-medium">#</th>
                    <th className="text-left px-2 py-1.5 font-medium">Holder</th>
                    <th className="text-right px-2 py-1.5 font-medium">USD value</th>
                    <th className="text-right px-2 py-1.5 font-medium">% supply</th>
                    <th className="text-left px-2 py-1.5 font-medium">Custody</th>
                  </tr>
                </thead>
                <tbody>
                  {upgradedHolders.map((h: any, i: number) => {
                    const clusterIdx = ownerToClusterIdx.get(h.owner);
                    return (
                    <tr key={h.address} className="border-t border-white/[0.03]">
                      <td className="px-2 py-1.5 text-gray-500">{i + 1}</td>
                      <td className="px-2 py-1.5">
                        {clusterIdx !== undefined && (
                          <span
                            className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${colorForCluster(clusterIdx)}`}
                            title="Linked wallet (shares first funder with another top holder)"
                          />
                        )}
                        {h.identityName ? (
                          <span>
                            <span className="text-gray-300">{h.identityName}</span>
                            {h.identityTags && h.identityTags.length > 0 && (
                              <span className="text-gray-500 ml-1 text-[10px]">({h.identityTags.join(', ')})</span>
                            )}
                          </span>
                        ) : (
                          <a href={`https://solscan.io/account/${h.owner}`} target="_blank" rel="noopener" className="font-mono text-gray-400 hover:text-gray-300 underline decoration-gray-700">
                            {h.owner.slice(0, 4)}...{h.owner.slice(-4)}
                          </a>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-300 font-mono">{fmtUSD(h.usdValue)}</td>
                      <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{h.pctOfSupply.toFixed(2)}%</td>
                      <td className={`px-2 py-1.5 ${custodyClass(h.effectiveCustody)} whitespace-nowrap`}>{custodyLabel(h.effectiveCustody)}</td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[10px] text-gray-400 mt-2">
            Mint: <a href={`https://solscan.io/token/${snapshot.mint}`} target="_blank" rel="noopener" className="font-mono hover:text-gray-300 underline decoration-gray-700">{snapshot.mint.slice(0, 6)}...{snapshot.mint.slice(-4)}</a>
            {' · '}Snapshot {snapshot.fetchedAt.split('T')[0]}
            {' · '}Identity via Helius, prices via Jupiter
          </p>
        </>
      )}
    </>
  );
}

function ProgramsList({ p }: { p: typeof PROTOCOLS[0] }) {
  const programs = p.programs ?? [];
  const isScrollable = programs.length > 5;

  return (
    <>
      <h4 className="font-bold text-white mt-4 mb-2">
        Programs ({programs.length})
        {p.sharedAuthority === false && (
          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-white/[0.12] text-gray-400 font-normal">Split authority</span>
        )}
        <Tooltip text={p.sharedAuthority ? 'All programs share the same upgrade authority.' : 'Programs have different upgrade authorities, each may have independent governance.'}><InfoIcon /></Tooltip>
      </h4>
      <div className={isScrollable ? 'space-y-1 max-h-[140px] overflow-y-auto pr-2' : 'space-y-1'}>
        {programs.map((prog, i) => {
          const shortAuth = prog.authority.length > 20 ? prog.authority.slice(0, 6) + '...' + prog.authority.slice(-4) : prog.authority;
          return (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className="text-gray-400">{prog.name}</span>
              <a href={`https://solscan.io/account/${prog.id}`} target="_blank" rel="noopener" className="font-mono text-gray-500 hover:text-white">{prog.id.slice(0, 6)}...{prog.id.slice(-4)}</a>
              <span className="text-gray-500">→</span>
              {prog.authority === 'IMMUTABLE' ? (
                <span className="text-white">Immutable</span>
              ) : prog.authority === 'N/A' ? (
                <span className="text-gray-500">N/A</span>
              ) : p.version === 'Squads V4' ? (
                <a href={`https://app.squads.so/squads/${prog.authority}/home`} target="_blank" rel="noopener" className="font-mono text-gray-500 hover:text-white">{shortAuth}</a>
              ) : (
                <a href={`https://solscan.io/account/${prog.authority}`} target="_blank" rel="noopener" className="font-mono text-gray-500 hover:text-white">{shortAuth}</a>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// Maps a governance multisig address to its protocol + role, for protocols that run more than
// one multisig. Lets the activity feed name the exact multisig a change hit (e.g. "Kamino · kLend"
// vs "Kamino · Liquidity") rather than just the protocol. Only built for multi-multisig protocols,
// so single-multisig entries stay labelled by protocol name alone.
const ROLE_BY_MULTISIG: Record<string, { protocol: string; role: string }> = (() => {
  const m: Record<string, { protocol: string; role: string }> = {};
  for (const p of PROTOCOLS) {
    const roles = (p as any).governanceRoles as { role: string; address: string | null }[] | undefined;
    if (!roles) continue;
    const addressed = roles.filter(r => r.address);
    if (addressed.length < 2) continue;
    for (const r of addressed) if (r.address) m[r.address] = { protocol: p.name, role: r.role };
  }
  return m;
})();

// Display label for an activity event: "Protocol · Role" when the changed multisig is one of a
// protocol's several, otherwise the protocol name on its own.
function activityLabel(e: { protocol: string; multisig?: string }): string {
  const hit = e.multisig ? ROLE_BY_MULTISIG[e.multisig] : undefined;
  return hit ? `${displayName(hit.protocol)} · ${hit.role}` : displayName(e.protocol);
}

// Compact hover summaries for role-separated governance (cold/warm/pause style splits).
// Full per-role breakdown lives in the expanded dropdown; these are the table-cell tooltips.
function rolesThresholdTip(roles: any[]): string {
  return ['Per-role thresholds', ...roles.map(r => `${r.role}: ${r.threshold || 'pending'}`), 'Full breakdown in the dropdown'].join('\n');
}
function rolesTimelockTip(roles: any[]): string {
  return ['Per-role timelocks', ...roles.map(r => `${r.role}: ${r.timelock || 'pending'}`), 'Full breakdown in the dropdown'].join('\n');
}
// Tooltip text for the Squads Safety Benchmark heading on multi-multisig protocols. Each
// multisig's threshold + timelock is shown inline on its card; this hover gives the aggregate
// so it stays compact even when a protocol runs many multisigs. Role separation is omitted here
// because it is only member-verified for the primary multisig.
function rolesBenchmarkTip(p: any): string {
  const roles = (p.governanceRoles || []).filter((r: any) => r.threshold);
  const n = roles.length;
  const withTl = roles.filter((r: any) => r.timelock && r.timelock !== 'None').length;
  const meetsRatio = roles.filter((r: any) => {
    const m = String(r.threshold).match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return false;
    const pct = +m[2] > 0 ? (+m[1] / +m[2]) * 100 : 0;
    return +m[1] >= 4 && pct >= 67;
  }).length;
  return [
    `Benchmark across all ${n} multisigs`,
    '',
    `${withTl}/${n} carry a governance timelock.`,
    `${meetsRatio}/${n} meet the Squads 4/6+ (67%) ratio.`,
    'Per-multisig threshold and timelock are shown on each card.',
  ].join('\n');
}

// Per-multisig Squads benchmark for the info icon on each role card. One multisig per hover,
// so it stays compact regardless of how many a protocol runs. Role separation reads from the
// per-role flag (null = members not yet scanned), so it never over-claims.
function roleBenchmarkTip(r: any): string {
  if (!r.threshold) return `${r.role}: not yet on-chain`;
  const m = String(r.threshold).match(/(\d+)\s*\/\s*(\d+)/);
  const thr = m ? +m[1] : 0, tot = m ? +m[2] : 0, pct = tot > 0 ? Math.round((thr / tot) * 100) : 0;
  const hasTl = r.timelock && r.timelock !== 'None';
  const thrMeets = thr >= 4 && pct >= 67;
  return [
    `${r.role} Squads benchmark`,
    '',
    `${thrMeets ? '✓' : '✗'} Threshold ${r.threshold} (${pct}%)${thrMeets ? ', meets 4/6+ (67%)' : pct >= 67 ? ', meets 67% ratio' : thr >= 4 ? ', meets signer count, ratio below 67%' : ', below 4/6+'}`,
    `${hasTl ? '✓' : '✗'} ${hasTl ? `Timelock ${r.timelock}` : 'No governance timelock'}`,
    r.roleSeparation == null ? 'Role separation not yet verified' : (r.roleSeparation ? '✓ Role separation' : '✗ No role separation, all signers full'),
  ].join('\n');
}

type SortKey = 'name' | 'threshold' | 'timelockSeconds' | 'totalMembers';

function App() {
  const { protocols: liveProtocols, lastScan, isLive, liveStates, liveActivity, liveIntegrity, liveHistorical, historicalAsOf } = useLiveData(PROTOCOLS);
  const llama = useDefiLlama();
  const [sortKey, setSortKey] = useState<SortKey>('timelockSeconds');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterVersion, setFilterVersion] = useState('all');
  const [filterTimelock, setFilterTimelock] = useState('all');
  const [filterInsurance, setFilterInsurance] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  // When a protocol row expands, scroll its detail panel into view, so clicking a row near the
  // bottom of the table doesn't look like nothing happened (the panel renders below the fold).
  const detailRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const id = requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [expanded]);
  type Tab = 'dashboard' | 'govwatch' | 'blast' | 'charts';
  type ChartsSub = 'exploits' | 'risk' | 'governance';
  const VALID_TABS: Tab[] = ['dashboard', 'govwatch', 'blast', 'charts'];
  const VALID_SUBS: ChartsSub[] = ['exploits', 'risk', 'governance'];
  function parseLocation(): { tab: Tab; sub: ChartsSub } {
    if (typeof window === 'undefined') return { tab: 'dashboard', sub: 'exploits' };
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const hash = window.location.hash.replace(/^#/, '');
    let t = '', s = '';
    if (path) {
      const [p1, p2] = path.split('/');
      t = p1; s = p2 || '';
    } else if (hash) {
      const [h1, h2] = hash.split(':');
      t = h1; s = h2 || '';
    }
    const tab = VALID_TABS.includes(t as Tab) ? (t as Tab) : 'dashboard';
    const sub = VALID_SUBS.includes(s as ChartsSub) ? (s as ChartsSub) : 'exploits';
    return { tab, sub };
  }
  const initial = parseLocation();
  const [activeTab, setActiveTab] = useState<Tab>(initial.tab);
  const [chartsSubTab, setChartsSubTab] = useState<ChartsSub>(initial.sub);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const desired = activeTab === 'dashboard'
      ? '/'
      : activeTab === 'charts' && chartsSubTab !== 'exploits'
        ? `/charts/${chartsSubTab}`
        : `/${activeTab}`;
    const current = window.location.pathname + window.location.hash;
    if (current !== desired) {
      window.history.replaceState(null, '', desired + window.location.search);
    }
  }, [activeTab, chartsSubTab]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => {
      const next = parseLocation();
      setActiveTab(next.tab);
      setChartsSubTab(next.sub);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const sorted = useMemo(() => {
    let data = [...liveProtocols];
    if (filterVersion !== 'all') data = data.filter(p => p.version === filterVersion);
    if (filterTimelock === 'yes') data = data.filter(p => p.hasTimelock);
    if (filterTimelock === 'no') data = data.filter(p => !p.hasTimelock);
    if (filterInsurance === 'none') data = data.filter(p => !p.insuranceFund || p.insuranceFund.fundType === 'none');
    if (filterInsurance === 'has') data = data.filter(p => p.insuranceFund && p.insuranceFund.fundType !== 'none');
    data.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'string') return sortAsc ? (av as string).localeCompare(bv as string) : (bv as string).localeCompare(av as string);
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return data;
  }, [sortKey, sortAsc, filterVersion, filterTimelock, filterInsurance, liveProtocols]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  };

  const lastScanLabel = (() => {
    if (!isLive || !lastScan) return null;
    const ageMin = Math.round((Date.now() - new Date(lastScan).getTime()) / 60000);
    return ageMin < 1 ? 'just now'
      : ageMin < 60 ? `${ageMin} min ago`
      : ageMin < 1440 ? `${Math.round(ageMin / 60)} h ago`
      : `${Math.round(ageMin / 1440)} d ago`;
  })();

  const ContactLink = (
    <Tooltip text="To add a protocol or disclose security information, DM on X. Changes go live after the team is verified.">
      <a
        href="https://x.com/Trader_CSK"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-gray-400 hover:text-white transition-colors border border-white/[0.08] hover:border-white/[0.2] rounded-md px-2 py-1 md:px-3 md:py-1.5 flex items-center gap-1.5 whitespace-nowrap"
      >
        Contact
      </a>
    </Tooltip>
  );

  const TabBar = (
    <div className="border-b border-white/[0.06]">
      <div className="max-w-[1400px] mx-auto px-4">
        <div className="flex gap-1">
          {(['dashboard', 'govwatch', 'blast', 'charts'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-xs font-medium rounded-t-md transition-colors ${
                activeTab === tab
                  ? 'bg-white/[0.06] text-white border border-white/[0.1] border-b-transparent'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab === 'dashboard' ? 'Dashboard' : tab === 'govwatch' ? 'GovWatch' : tab === 'blast' ? 'Blast Radius' : 'Charts'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#08080d] text-gray-200 overflow-x-hidden">
      {activeTab === 'dashboard' ? (
        <section>
          <div className="max-w-[1400px] mx-auto px-4 pt-8 pb-6 md:pt-10 md:pb-8 relative">
            <div className="absolute top-3 right-4 md:top-4 md:right-4">
              {ContactLink}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-12 items-start">
              <div className="md:pr-12">
                <h1 className="text-3xl md:text-5xl font-semibold text-white tracking-tight leading-none">solgov</h1>
                <p className="mt-3 text-[14px] md:text-[15px] text-gray-400 leading-relaxed">
                  Audits inspect code. Transaction monitors fire on on-chain activity.
                  {' '}<span className="text-white">solgov reads the governance setup itself</span>, across 50+ Solana protocols.
                </p>
                <p className="mt-3 text-[12px] md:text-[13px] text-gray-500 leading-relaxed">
                  Continuous reads on every threshold, signer, timelock, config authority and program upgrade. Nine pattern detection rules tuned to the early warning signs in multisig setups, giving teams time to fix gaps and users a clear view of what they are trusting.
                </p>
                <p className="mt-3 text-[12px] md:text-[13px] text-gray-300 leading-relaxed">
                  Drift's $285M April exploit was compromised signers approving pre-positioned transactions, per Drift's post-mortem. The configuration that let those signatures execute instantly was on chain before the attack: zero timelock, a stale external config authority, a multisig migrated days before. solgov reads configuration like this.
                </p>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Tooltip text="OpenAPI 3.1 reference. 11 endpoints, live data, try-it-out enabled.">
                    <a
                      href="/api-docs.html"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3.5 py-1.5 text-[13px] text-gray-300 hover:text-white border border-white/[0.1] hover:border-white/[0.25] rounded-md flex items-center gap-2 transition-colors"
                    >
                      API
                      <span className="text-[10px] uppercase tracking-[0.08em] text-gray-500 border border-white/[0.08] rounded px-1.5 py-[1px]">live</span>
                    </a>
                  </Tooltip>
                  <Tooltip text="Public Telegram channel. Every governance event the listener picks up across all tracked protocols.">
                    <a
                      href="https://t.me/SolGovActivity"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3.5 py-1.5 text-[13px] text-gray-300 hover:text-white border border-white/[0.1] hover:border-white/[0.25] rounded-md flex items-center gap-2 transition-colors"
                    >
                      Telegram
                      <span className="text-[10px] uppercase tracking-[0.08em] text-gray-500 border border-white/[0.08] rounded px-1.5 py-[1px]">live</span>
                    </a>
                  </Tooltip>
                </div>
              </div>

              {(() => {
                const THIRTY_DAYS = 30 * 86400 * 1000;
                // Routine-ops types are surfaced in the full GovWatch feed,
                // not on the homepage Live Activity panel which focuses on
                // governance-health events (timelock, threshold, signer,
                // configAuthority, authority-key changes).
                const LIVE_ACTIVITY_NOISE = new Set([
                  'ProgramUpgrade', 'VaultTx', 'AuthorityActivity',
                  'Approval', 'Rejection', 'Cancellation',
                  'ProposalCreated', 'ProposalPending',
                  'GovernanceActivity', 'SpendingLimit',
                ]);
                const recentEvents = cleanLiveActivity(liveActivity || [])
                  .filter(e => !LIVE_ACTIVITY_NOISE.has(e.rawType))
                  .filter(e => {
                    const ts = Date.parse(e.timestamp || e.date);
                    return !isNaN(ts) && Date.now() - ts < THIRTY_DAYS;
                  })
                  .sort((a, b) => {
                    const ta = Date.parse(a.timestamp || a.date) || 0;
                    const tb = Date.parse(b.timestamp || b.date) || 0;
                    return tb - ta;
                  })
                  .slice(0, 5);
                const hasRecent24h = recentEvents.some(e => {
                  const ts = Date.parse(e.timestamp || e.date);
                  return !isNaN(ts) && Date.now() - ts < 86400 * 1000;
                });
                return (
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden md:mt-[60px]">
                    <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/[0.06]">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full bg-emerald-400/80 ${hasRecent24h ? 'animate-pulse' : ''}`}></span>
                        <span className="text-[10px] uppercase tracking-[0.08em] text-gray-400">Live activity</span>
                      </div>
                      {lastScanLabel && (
                        <span className="text-[10px] text-gray-400 font-mono">scan {lastScanLabel}</span>
                      )}
                    </div>
                    {recentEvents.length > 0 ? (
                      <div className="divide-y divide-white/[0.04]">
                        {recentEvents.map((e, i) => (
                          <div
                            key={i}
                            className={`px-3.5 py-2 flex items-center gap-3 text-[11px] ${i >= 3 ? 'hidden md:flex' : ''}`}
                          >
                            <span className="text-gray-500 font-mono w-[68px] flex-shrink-0">{e.date}</span>
                            <span className="text-white font-medium w-[150px] truncate flex-shrink-0">{activityLabel(e)}</span>
                            <span className="text-gray-400 truncate">{e.type}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="px-3.5 py-6 text-center text-[11px] text-gray-500">
                        No governance activity in the last 30 days.
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </section>
      ) : (
        <header className="border-b border-white/[0.06]">
          <div className="max-w-[1400px] mx-auto px-4 pt-5 pb-4 flex items-center justify-between gap-4">
            <Tooltip text="Back to dashboard">
              <button
                onClick={() => setActiveTab('dashboard')}
                className="text-left group"
              >
                <h1 className="text-[20px] font-semibold text-white tracking-tight group-hover:text-gray-200 transition-colors">solgov</h1>
                <p className="text-[12px] text-gray-500 mt-0.5">On-chain governance transparency for Solana DeFi</p>
              </button>
            </Tooltip>
            {ContactLink}
          </div>
        </header>
      )}

      {TabBar}

      <main className="max-w-[1400px] mx-auto px-4 py-5">
      {activeTab === 'dashboard' && (<>
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-gray-500">
          <Tooltip text="Filter table to protocols with a governance timelock">
            <button
              onClick={() => setFilterTimelock('yes')}
              className={`flex items-center gap-1.5 hover:text-white transition-colors ${filterTimelock === 'yes' ? 'text-white' : ''}`}
            >
              <span className="text-white font-medium tabular-nums">{liveProtocols.filter(p => p.hasTimelock).length}</span>
              with timelock
            </button>
          </Tooltip>
          <Tooltip text="Filter table to protocols without a governance timelock">
            <button
              onClick={() => setFilterTimelock('no')}
              className={`flex items-center gap-1.5 hover:text-white transition-colors ${filterTimelock === 'no' ? 'text-white' : ''}`}
            >
              <span className="text-white font-medium tabular-nums">{liveProtocols.filter(p => !p.hasTimelock).length}</span>
              without
            </button>
          </Tooltip>
          <span className="flex items-center gap-1.5">
            <span className="text-white font-medium tabular-nums">{STATS.verifiedBuilds}</span>
            verified builds
            <Tooltip text="On-chain verified build confirms deployed bytecode matches published source code. Checked via Ellipsis Labs verifier."><InfoIcon /></Tooltip>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-white font-medium tabular-nums">{STATS.noInsurance}</span>
            no insurance found
            <Tooltip text="No insurance fund or reimbursement mechanism found in public documentation. Protocols are invited to disclose."><InfoIcon /></Tooltip>
          </span>
          {filterTimelock !== 'all' && (
            <button
              onClick={() => setFilterTimelock('all')}
              className="text-[11px] text-gray-500 hover:text-gray-300 underline decoration-gray-700"
            >
              clear timelock filter
            </button>
          )}
        </div>

        <div className="rounded-md border border-white/[0.04] px-3 md:px-4 py-2.5 mb-4 text-[10px] md:text-[11px] text-gray-500 leading-relaxed">
          <span className="text-gray-400">Squads safety benchmark:</span>
          <span className="ml-2"></span>
          <Tooltip text="The Squads benchmark is a 4/6 threshold (67%+ ratio)."><span className="text-gray-500 cursor-help">Threshold 4/6+<InfoIcon /></span></Tooltip>
          <span className="mx-1.5 text-gray-700">&middot;</span>
          <Tooltip text="Mandatory delay between approval and execution. Gives time to detect and cancel malicious transactions."><span className="text-gray-500 cursor-help">Timelocks<InfoIcon /></span></Tooltip>
          <span className="mx-1.5 text-gray-700">&middot;</span>
          <Tooltip text="The Squads benchmark separates proposer, voter, and executor permissions."><span className="text-gray-500 cursor-help">Role separation<InfoIcon /></span></Tooltip>
          <span className="mx-1.5 text-gray-700">&middot;</span>
          <Tooltip text="On-chain proof that deployed bytecode matches published source code. Confirms what's running is what was audited."><span className="text-gray-500 cursor-help">Verified builds<InfoIcon /></span></Tooltip>
          <span className="mx-1.5 text-gray-700">&middot;</span>
          <Tooltip text="Scanning multisig signers for durable nonce accounts."><span className="text-gray-500 cursor-help">Nonce detection<InfoIcon /></span></Tooltip>
          <span className="mx-1.5 text-gray-700">&middot;</span>
          <Tooltip text="Signers use dedicated hardware wallets for multisig transactions."><span className="text-gray-500 cursor-help">Hardware wallets<InfoIcon /></span></Tooltip>
          <span className="mx-1.5 text-gray-700">&middot;</span>
          <Tooltip text="Regular rotation of signer keys."><span className="text-gray-500 cursor-help">Key rotation<InfoIcon /></span></Tooltip>
          <span className="mx-2 text-gray-700">|</span>
          <a href={`https://${SQUADS_MINIMUM.source}`} target="_blank" rel="noopener" className="text-gray-500 underline decoration-gray-700 hover:text-gray-400">Source</a>
          <br className="md:hidden" />
          <div className="mt-1">
            <span className="text-gray-400">Additional:</span>
            <span className="ml-2"></span>
            <Tooltip text="Whether the protocol has a fund to cover user losses in the event of an exploit."><span className="text-gray-500 cursor-help">Insurance fund<InfoIcon /></span></Tooltip>
            <span className="mx-1.5 text-gray-700">&middot;</span>
            <Tooltip text="Separating operations wallet from reserve funds."><span className="text-gray-500 cursor-help">Treasury segmentation<InfoIcon /></span></Tooltip>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          <Dropdown
            value={filterVersion}
            onChange={setFilterVersion}
            options={[
              { value: 'all', label: 'All Versions' },
              { value: 'Squads V4', label: 'Squads V4' },
              { value: 'Squads V3', label: 'Squads V3' },
              { value: 'Serum Multisig', label: 'Serum Multisig' },
              { value: 'Realms DAO', label: 'Realms DAO' },
              { value: 'Single Signer', label: 'Single Signer' },
              { value: 'Wormhole', label: 'Wormhole' },
              { value: 'Immutable', label: 'Immutable' },
            ]}
          />
          <Dropdown
            value={filterTimelock}
            onChange={setFilterTimelock}
            options={[
              { value: 'all', label: 'All Timelocks' },
              { value: 'yes', label: 'Has Timelock' },
              { value: 'no', label: 'No Timelock' },
            ]}
          />
          <Dropdown
            value={filterInsurance}
            onChange={setFilterInsurance}
            options={[
              { value: 'all', label: 'All Insurance' },
              { value: 'none', label: 'No Insurance' },
              { value: 'has', label: 'Has Insurance' },
            ]}
          />
        </div>

        <div className="overflow-auto max-h-[80vh] border border-white/[0.06] rounded-md scroll-thin">
          <table className="w-full text-sm">
            <thead className="bg-[#0e0e14] sticky top-0 z-20">
              <tr>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap cursor-pointer" onClick={() => handleSort('name')}>Protocol</th>
                <th className="px-3 py-2.5 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  TVL {!llama.loading && <Tooltip text="Live from DeFiLlama"><span className="inline-block w-1.5 h-1.5 rounded-full bg-white ml-1" /></Tooltip>}
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">Version</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap cursor-pointer" onClick={() => handleSort('threshold')}>
                  Signers <Tooltip text="Threshold / active voters who can sign. Total members shown if different."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap cursor-pointer" onClick={() => handleSort('timelockSeconds')}>
                  Gov. TL <Tooltip text="Governance-level timelock configured in the multisig. On-chain verified."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Prog. TL <Tooltip text="Timelock in the program code itself. From protocol docs or team disclosure."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Last Upgrade <Tooltip text="Most recent program upgrade transaction on-chain."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  30d <Tooltip text="Program upgrade transactions in the last 30 days."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Threshold <Tooltip text="Green: 4+ signers with 67%+ ratio (Squads 4/6+). Amber: 3 signers or below 67%. Red: fewer than 3 or below 50%."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Roles <Tooltip text="The Squads benchmark separates Proposer, Voter, and Executor roles."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Status <Tooltip text="Governance version capability. V4 supports timelocks natively. V3/legacy does not."><InfoIcon /></Tooltip>
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                  Insurance <Tooltip text="Funded insurance mechanism based on public documentation."><InfoIcon /></Tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <Fragment key={p.name}>
                  <tr className="border-t border-white/[0.04] hover:bg-white/[0.02] cursor-pointer" onClick={() => setExpanded(expanded === p.name ? null : p.name)}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <ProtocolLogo name={p.name} />
                        <span className="font-medium text-white whitespace-nowrap">{displayName(p.name)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-right text-gray-400 whitespace-nowrap">
                      {formatTvlDisplay(llama.tvl[p.name]) || <span className="text-gray-500">-</span>}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {p.version === 'Single Signer' ? (
                        <Tooltip text="No multisig configuration found on-chain. The upgrade authority is a regular wallet address. Whether it is controlled by a single key or by a custom off-chain process cannot be confirmed externally.">
                          <span className="text-gray-400 cursor-help">No multisig<InfoIcon /></span>
                        </Tooltip>
                      ) : (
                        <span>{p.version}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.version === 'Single Signer' ? (
                        <span className="text-gray-500">-</span>
                      ) : p.totalMembers === 0 ? (
                        <span className="text-gray-500">-</span>
                      ) : (
                        <span className="font-mono">
                          <span className="text-gray-300">{p.threshold}/{p.activeVoters > 0 ? p.activeVoters : p.totalMembers}</span>
                          {p.activeVoters > 0 && p.activeVoters !== p.totalMembers && (
                            <span className="text-[10px] text-gray-400 ml-1">({p.totalMembers} total)</span>
                          )}
                          {p.governanceRoles && p.governanceRoles.length > 0 && (
                            <Tooltip text={rolesThresholdTip(p.governanceRoles)} align="left">
                              <span className={`ml-1 text-[10px] cursor-help align-middle ${p.governanceRoles.some((r: any) => r.status === 'announced' || r.status === 'disclosed') ? 'text-amber-300/70' : 'text-gray-400'}`}>&#9432;</span>
                            </Tooltip>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.timelockSeconds === -1 ? (
                        <span className="text-gray-500 whitespace-nowrap">{p.timelockLabel}</span>
                      ) : p.hasTimelock ? (
                        <span className="text-white whitespace-nowrap">{p.timelockLabel}</span>
                      ) : (
                        <span className="text-gray-400 whitespace-nowrap">None</span>
                      )}
                      {p.governanceRoles && p.governanceRoles.length > 0 && (
                        <Tooltip text={rolesTimelockTip(p.governanceRoles)} align="left">
                          <span className={`ml-1 text-[10px] cursor-help align-middle ${p.governanceRoles.some((r: any) => r.status === 'announced' || r.status === 'disclosed') ? 'text-amber-300/70' : 'text-gray-400'}`}>&#9432;</span>
                        </Tooltip>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {p.programTimelock === 'verified' ? (
                        <Tooltip text={p.programTimelockNote || 'Program-level timelock verified in code.'}>
                          <span className="text-white cursor-help">Verified<InfoIcon /></span>
                        </Tooltip>
                      ) : p.programTimelock === 'self-reported' ? (
                        <Tooltip text={p.programTimelockNote || 'From public documentation, not independently verified on-chain.'}>
                          <span className="text-gray-300 cursor-help whitespace-nowrap">Yes (docs)<InfoIcon /></span>
                        </Tooltip>
                      ) : (
                        <span className="text-gray-500">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-400">{p.lastUpgrade}</td>
                    <td className="px-3 py-2 text-xs text-gray-400 text-center">{p.upgradesLast30d}</td>
                    <td className="px-3 py-2 text-center text-xs">
                      {(() => {
                        if (p.version === 'Appchain') return (
                          <Tooltip text="Appchain architecture. Governance multisig not yet on Solana mainnet, or address not disclosed. Comparison to the Squads benchmark is not applicable until configuration is on-chain.">
                            <span className="text-gray-500 cursor-help">N/A<InfoIcon /></span>
                          </Tooltip>
                        );
                        const effectiveTotal = p.activeVoters > 0 ? p.activeVoters : p.totalMembers;
                        const pct = effectiveTotal > 0 ? p.threshold / effectiveTotal : 0;
                        const ratioText = `${p.threshold}/${effectiveTotal} (${Math.round(pct*100)}%)`;
                        if (p.threshold >= 4 && pct >= 0.67) return (
                          <Tooltip text={`${ratioText}. The Squads benchmark is 4/6+ (67%+).`}>
                            <span className="text-white cursor-help">Above<InfoIcon /></span>
                          </Tooltip>
                        );
                        if (p.threshold >= 4 && pct < 0.67) return (
                          <Tooltip text={`${ratioText}. Meets signer count but below 67% ratio. The Squads benchmark is 4/6+ (67%+).`}>
                            <span className="text-gray-300 cursor-help">Partial<InfoIcon /></span>
                          </Tooltip>
                        );
                        if (p.threshold >= 3 && pct >= 0.67) return (
                          <Tooltip text={`${ratioText}. Ratio meets 67%+ but fewer than 4 signers. Squads recommends 4/6+ (67%+).`}>
                            <span className="text-gray-300 cursor-help">Partial<InfoIcon /></span>
                          </Tooltip>
                        );
                        return (
                          <Tooltip text={`${ratioText}. Below the Squads benchmark of 4/6+ (67%+).`}>
                            <span className="text-gray-400 cursor-help">Below<InfoIcon /></span>
                          </Tooltip>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {p.hasRoleSeparation === null || p.version === 'Single Signer' || p.version === 'Realms DAO' || p.version === 'Wormhole' || p.version === 'Immutable' || p.version === 'Appchain' ? (
                        <span className="text-gray-500">N/A</span>
                      ) : p.hasRoleSeparation && (p.threshold ?? 0) >= 2 ? (
                        <span className="text-white">Separated</span>
                      ) : p.hasRoleSeparation ? (
                        <Tooltip text="Permissions are split but threshold is 1, so a single signer can still execute without co-approval. Effectively no separation in practice.">
                          <span className="text-gray-400 cursor-help">Split (trivial)<InfoIcon /></span>
                        </Tooltip>
                      ) : (
                        <span className="text-gray-400">All equal</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {(() => {
                        const pctThreshold = p.totalMembers > 0 ? p.threshold / p.totalMembers : 0;
                        const thresholdOk = p.threshold >= 4 && pctThreshold >= 0.67;
                        const needsFix = (!p.hasTimelock && p.timelockSeconds !== -1) || !thresholdOk || p.hasRoleSeparation === false;
                        if (p.version === 'Immutable') return <span className="text-gray-500">N/A</span>;
                        if (p.version === 'Appchain') return (
                          <Tooltip text="Appchain architecture. Most logic lives at the rollup or executor layer, not on Solana mainnet. Governance address pending or not applicable until mainnet configuration is published.">
                            <span className="text-gray-500 whitespace-nowrap">Appchain<InfoIcon /></span>
                          </Tooltip>
                        );
                        if (p.version === 'Wormhole') return (
                          <Tooltip text="Wormhole guardian consensus, 13 of 19 independent operators must agree. Different security model.">
                            <span className="text-gray-500 whitespace-nowrap">Different model<InfoIcon /></span>
                          </Tooltip>
                        );
                        if (p.version === 'Single Signer') return (
                          <Tooltip text="No multisig configuration found on-chain. The upgrade authority is a regular wallet address. Whether it is controlled by a single key or by a custom off-chain signing process cannot be confirmed externally.">
                            <span className="text-gray-400">No multisig<InfoIcon /></span>
                          </Tooltip>
                        );
                        if (p.version === 'Realms DAO') return (
                          <Tooltip text="This protocol uses token-weighted DAO voting (SPL Governance), not a multisig. Different security model, not directly comparable to Squads.">
                            <span className="text-gray-500 whitespace-nowrap">Different model<InfoIcon /></span>
                          </Tooltip>
                        );
                        if (p.version === 'Squads V3' || p.version === 'Serum Multisig') return (
                          <Tooltip text="This multisig version does not support timelocks or role separation natively. V4 supports governance-level timelocks.">
                            <span className="text-gray-300/70 whitespace-nowrap">V3/Legacy<InfoIcon /></span>
                          </Tooltip>
                        );
                        if (!needsFix) return <span className="text-gray-500">N/A</span>;
                        if (p.canAddTimelock) return <span className="text-white/70">Yes</span>;
                        return <span className="text-gray-500">N/A</span>;
                      })()}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {!p.insuranceFund || p.insuranceFund.fundType === 'none' ? (
                        <Tooltip text="No insurance fund or reimbursement mechanism found in public documentation. Awaiting clarification from protocol.">
                          <span className="text-gray-500 cursor-help">Not found<InfoIcon /></span>
                        </Tooltip>
                      ) : p.insuranceFund.fundType === 'stablecoin' ? (
                        <Tooltip text={p.insuranceFund.reimbursementPolicy}>
                          <span className="text-gray-300 cursor-help whitespace-nowrap">Small fund<InfoIcon /></span>
                        </Tooltip>
                      ) : (
                        <Tooltip text={p.insuranceFund.reimbursementPolicy}>
                          <span className="text-gray-300 cursor-help">
                            {p.insuranceFund.fundType === 'socialized_loss' ? 'Socialised' :
                             p.insuranceFund.fundType === 'token_treasury' ? 'Token' : 'Mixed'}
                            <InfoIcon />
                          </span>
                        </Tooltip>
                      )}
                    </td>
                  </tr>
                  {expanded === p.name && (
                    <tr key={`${p.name}-detail`} ref={detailRef} className="bg-white/[0.01] scroll-mt-2">
                      <td colSpan={12} className="px-2 md:px-6 py-4" style={{width: 0}}>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 text-xs min-w-0 overflow-hidden" style={{maxWidth: 'calc(100vw - 48px)'}}>
                          <div className="min-w-0 overflow-hidden">
                            {formatTvlDisplay(llama.tvl[p.name]) && (
                              <div className="mb-3 pb-3 border-b border-white/[0.06]">
                                <h4 className="font-bold text-white mb-1">TVL</h4>
                                <p className="text-lg text-white font-semibold">{formatTvlDisplay(llama.tvl[p.name])}</p>
                                <p className="text-[10px] text-gray-400">Live from DeFiLlama{
                                  p.name === 'Pumpfun + PumpSwap' ? ' (PumpSwap DEX only - bonding curve SOL not tracked)'
                                  : p.name === 'Drift' ? ' (Drift Trade + Drift Staked SOL combined)'
                                  : p.name === 'Sanctum' ? ' (Validator LSTs + Infinity + Reserve combined)'
                                  : p.name === 'Marinade' ? ' (Liquid + Native + Select staking combined)'
                                  : p.name === 'Meteora' ? ' (DLMM + DAMM V1/V2 + Vaults combined)'
                                  : p.name === 'Jito' ? ' (Liquid Staking + Restaking combined)'
                                  : ''
                                }</p>
                              </div>
                            )}
                            <h4 className="font-bold text-white mb-2">Configuration</h4>
                            <p><span className="text-gray-500">Threshold:</span> {p.threshold} of {p.totalMembers} total members</p>
                            {p.activeVoters !== p.totalMembers && p.activeVoters > 0 && (
                              <p><span className="text-gray-500">Active voters:</span> {p.activeVoters} of {p.totalMembers}
                                <Tooltip text="Some members have reduced permissions and cannot currently vote. They could be reinstated via a governance transaction."><InfoIcon /></Tooltip>
                              </p>
                            )}
                            <p><span className="text-gray-500">Gov. Timelock:</span> {p.timelockLabel}</p>
                            <p><span className="text-gray-500">Program Timelock:</span> {p.programTimelock === 'verified' ? (
                              <Tooltip text={p.programTimelockNote || 'Program-level timelock verified in code.'}><span className="text-white cursor-help">Yes<InfoIcon /></span></Tooltip>
                            ) : p.programTimelock === 'self-reported' ? (
                              <Tooltip text={p.programTimelockNote || 'From public documentation, not independently verified on-chain.'}><span className="text-gray-300 cursor-help whitespace-nowrap">Yes (docs)<InfoIcon /></span></Tooltip>
                            ) : 'Not reported'}</p>
                            <p><span className="text-gray-500">Version:</span> {p.version}</p>
                            <p><span className="text-gray-500">Can add timelock:</span> {p.canAddTimelock ? 'Yes (V4 config transaction)' : 'Not available on this version'}</p>

                            {p.governanceRoles && p.governanceRoles.length > 0 && (
                              <>
                                <h4 className="font-bold text-white mt-4 mb-1">
                                  Role-separated governance
                                  {p.governanceRoles.some((r: any) => r.status === 'announced') && (
                                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-300/[0.25] bg-amber-300/[0.05] text-amber-200/80 font-normal align-middle">Not yet on-chain</span>
                                  )}
                                  {p.governanceRoles.some((r: any) => r.status === 'disclosed') && (
                                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-300/[0.25] bg-amber-300/[0.05] text-amber-200/80 font-normal align-middle">Some via disclosure</span>
                                  )}
                                </h4>
                                {p.governanceRolesNote && (
                                  <p className="text-[11px] text-gray-400 mb-2">{p.governanceRolesNote}{p.governanceRolesSource && (<> <a href={p.governanceRolesSource} target="_blank" rel="noopener" className="text-gray-500 hover:text-gray-300 underline">Source</a></>)}</p>
                                )}
                                <div className="space-y-2">
                                  {p.governanceRoles.map((r: any, i: number) => (
                                    <div key={i} className="bg-white/[0.03] rounded p-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-gray-300 text-[12px] font-medium flex items-center">{r.role}{r.threshold && <Tooltip text={roleBenchmarkTip(r)} align="left"><InfoIcon /></Tooltip>}</span>
                                        {(r.threshold || r.timelock) && (
                                          <span className="text-[10px] text-gray-400 whitespace-nowrap shrink-0">{r.threshold}{r.threshold && r.timelock ? ' · ' : ''}{r.timelock === 'None' ? 'no timelock' : r.timelock}</span>
                                        )}
                                      </div>
                                      <p className="text-[11px] text-gray-400 mt-0.5">{r.scope}</p>
                                      {r.address ? (
                                        <a href={`https://solscan.io/account/${r.address}`} target="_blank" rel="noopener" className="font-mono text-[10px] text-gray-500 hover:text-gray-300 underline decoration-gray-700 break-all">{r.address}</a>
                                      ) : (
                                        <span className="text-[10px] text-gray-500">{r.status === 'disclosed' ? 'Per team disclosure, address not yet verified on-chain' : 'Address pending deployment'}</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}

                            <h4 className="font-bold text-white mt-4 mb-2">Upgrade Activity</h4>
                            <p><span className="text-gray-500">Last upgrade:</span> {p.lastUpgrade}</p>
                            <p><span className="text-gray-500">Upgrades (30d):</span> {p.upgradesLast30d}</p>

                            <h4 className="font-bold text-white mt-4 mb-2">On-Chain Addresses</h4>
                            <p><span className="text-gray-500">Multisig:</span></p>
                            {p.multisigAddress.length === 44 || p.multisigAddress.length === 43 ? (
                              <p className="font-mono text-[11px] text-gray-400 break-all">
                                <a href={`https://solscan.io/account/${p.multisigAddress}`} target="_blank" rel="noopener" className="hover:text-white underline">{p.multisigAddress}</a>
                              </p>
                            ) : (
                              <p className="text-[12px] text-gray-400">{p.multisigAddress}</p>
                            )}
                            <p className="mt-2">
                              <span className="text-gray-500">Authority:</span>
                              {p.authorityRole && (
                                <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-normal ${
                                  p.authorityRole === 'both' ? 'bg-emerald-900/30 text-emerald-300/80 border border-emerald-700/30' :
                                  p.authorityRole === 'program-upgrade' ? 'bg-blue-900/30 text-blue-300/80 border border-blue-700/30' :
                                  p.authorityRole === 'treasury' ? 'bg-amber-900/30 text-amber-300/80 border border-amber-700/30' :
                                  'bg-gray-700/40 text-gray-400 border border-gray-600/40'
                                }`}>
                                  {p.authorityRole === 'both' ? 'Program upgrade + Treasury' :
                                   p.authorityRole === 'program-upgrade' ? 'Program upgrade' :
                                   p.authorityRole === 'treasury' ? 'Treasury' :
                                   'Role unverified'}
                                </span>
                              )}
                            </p>
                            {p.authorityAddress.length === 44 || p.authorityAddress.length === 43 ? (
                              <p className="font-mono text-[11px] text-gray-400 break-all">
                                {p.version === 'Squads V4' ? (
                                  <a href={`https://app.squads.so/squads/${p.authorityAddress}/home`} target="_blank" rel="noopener" className="hover:text-white underline">{p.authorityAddress}</a>
                                ) : (
                                  <a href={`https://solscan.io/account/${p.authorityAddress}`} target="_blank" rel="noopener" className="hover:text-white underline">{p.authorityAddress}</a>
                                )}
                              </p>
                            ) : (
                              <p className="text-[12px] text-gray-400">{p.authorityAddress}</p>
                            )}
                            {p.authorityRoleNote && (
                              <p className="text-[10px] text-gray-400 mt-1">{p.authorityRoleNote}</p>
                            )}
                            {p.secondaryVaults && p.secondaryVaults.length > 0 && (
                              <>
                                <p className="mt-2"><span className="text-gray-500">Other vaults in this multisig:</span></p>
                                {p.secondaryVaults.map((v, i) => (
                                  <p key={i} className="font-mono text-[11px] text-gray-400 break-all">
                                    <span className="text-gray-500">{v.label}:</span>{' '}
                                    {p.version === 'Squads V4' ? (
                                      <a href={`https://app.squads.so/squads/${v.address}/home`} target="_blank" rel="noopener" className="hover:text-white underline">{v.address}</a>
                                    ) : (
                                      <a href={`https://solscan.io/account/${v.address}`} target="_blank" rel="noopener" className="hover:text-white underline">{v.address}</a>
                                    )}
                                    {v.note && <span className="block text-gray-400 text-[10px] mt-0.5">{v.note}</span>}
                                  </p>
                                ))}
                              </>
                            )}
                            {p.squadsProfilePublic === false && (
                              <p className="mt-2 text-[11px] text-amber-400/70">Squads profile: private. UI hidden from non-members, but threshold, members, and balance are still fully readable on-chain via RPC. Solgov uses RPC reads, not the Squads UI.</p>
                            )}

                            {p.tokenMint && (tokenCustodyData.snapshots as any)[p.name] && (
                              <TokenCustodySection
                                protocolName={p.name}
                                tokenSymbol={p.tokenSymbol!}
                                snapshot={(tokenCustodyData.snapshots as any)[p.name]}
                              />
                            )}
                          </div>

                          <div className="min-w-0 overflow-hidden">
                            <h4 className="font-bold text-white mb-2">Members ({p.totalMembers})
                              <Tooltip text={p.version === 'Squads V4' ? "Squads V4 has three permissions: Propose, Vote, Execute. Voter counts toward threshold. Propose / Execute members can submit and/or execute approved transactions but cannot vote. Execution still requires the vote threshold and any timelock first. None = inactive." : "All members have equal permissions on " + p.version + ". No role separation available."}><InfoIcon /></Tooltip>
                            </h4>
                            {p.members ? (
                              <div className="space-y-1">
                                {(() => {
                                  const canVote = (r: string) => r === 'Full' || r === 'Vote' || r === 'Propose + Vote' || r === 'Vote + Execute';
                                  const voters = p.members!.filter(m => canVote(m.role));
                                  const nonVoters = p.members!.filter(m => !canVote(m.role) && m.role !== 'None');
                                  const inactive = p.members!.filter(m => m.role === 'None');
                                  return (
                                    <>
                                      {voters.length > 0 && <p className="text-[10px] text-white/70 font-medium mb-0.5">Voters ({voters.length})</p>}
                                      {voters.map((m, i) => (
                                        <div key={`v${i}`} className="flex items-center gap-2">
                                          <span className="text-gray-500 w-4 text-right">{i + 1}</span>
                                          <a href={`https://solscan.io/account/${m.key}`} target="_blank" rel="noopener" className="font-mono text-[11px] text-gray-400 hover:text-white">{m.key.slice(0, 4)}...{m.key.slice(-4)}</a>
                                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">{
                                            m.role === 'Full' ? 'Full' :
                                            m.role === 'Vote' ? 'Vote only' :
                                            m.role
                                          }</span>
                                        </div>
                                      ))}
                                      {nonVoters.length > 0 && <p className="text-[10px] text-orange-400/70 font-medium mt-1.5 mb-0.5">Propose / Execute ({nonVoters.length})</p>}
                                      {nonVoters.map((m, i) => (
                                        <div key={`p${i}`} className="flex items-center gap-2">
                                          <span className="text-gray-500 w-4 text-right">{voters.length + i + 1}</span>
                                          <a href={`https://solscan.io/account/${m.key}`} target="_blank" rel="noopener" className="font-mono text-[11px] text-gray-400 hover:text-white">{m.key.slice(0, 4)}...{m.key.slice(-4)}</a>
                                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-400">{m.role}</span>
                                        </div>
                                      ))}
                                      {inactive.length > 0 && <p className="text-[10px] text-gray-400/70 font-medium mt-1.5 mb-0.5">Inactive ({inactive.length})</p>}
                                      {inactive.map((m, i) => (
                                        <div key={`n${i}`} className="flex items-center gap-2">
                                          <span className="text-gray-500 w-4 text-right">{voters.length + nonVoters.length + i + 1}</span>
                                          <a href={`https://solscan.io/account/${m.key}`} target="_blank" rel="noopener" className="font-mono text-[11px] text-gray-400 hover:text-white">{m.key.slice(0, 4)}...{m.key.slice(-4)}</a>
                                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-400">None</span>
                                        </div>
                                      ))}
                                    </>
                                  );
                                })()}
                              </div>
                            ) : (
                              <p className="text-gray-500">Not available ({p.version})</p>
                            )}
                          </div>

                          <div className="min-w-0 overflow-hidden">
                            {(p.version === 'Squads V4' || p.version === 'Squads V3') ? (
                              <>
                                <h4 className="font-bold text-white mb-2">Squads Safety Benchmark{p.governanceRoles && p.governanceRoles.length > 0 ? <Tooltip text={rolesBenchmarkTip(p)} align="left"><InfoIcon /></Tooltip> : null}</h4>
                                <p>{(() => {
                                  const effectiveTotal = p.activeVoters > 0 ? p.activeVoters : p.totalMembers;
                        const pct = effectiveTotal > 0 ? p.threshold / effectiveTotal : 0;
                                  if (p.threshold >= 4 && pct >= 0.67) return <Check pass={true} label={`Threshold ${p.threshold}/${effectiveTotal} (${Math.round(pct*100)}%) meets Squads 4/6+ (67%+)`} />;
                                  if (p.threshold >= 4 && pct < 0.67) return <span className="text-gray-300 font-bold">{'\u2713'} Threshold {p.threshold}/{effectiveTotal} ({Math.round(pct*100)}%) - meets signer count, ratio below 67%</span>;
                                  if (p.threshold >= 3 && pct >= 0.67) return <span className="text-gray-300 font-bold">{'\u2713'} Threshold {p.threshold}/{effectiveTotal} ({Math.round(pct*100)}%) meets 67%+ ratio. Squads reference is 4/6+.</span>;
                                  if (p.threshold >= 3) return <Check pass={false} label={`Threshold ${p.threshold}/${effectiveTotal} (${Math.round(pct*100)}%) - below 4 signers and below 67% ratio`} />;
                                  return <Check pass={false} label={`Threshold ${p.threshold}/${effectiveTotal} (${Math.round(pct*100)}%) -${p.threshold} signer${p.threshold === 1 ? '' : 's'} needed to approve`} />;
                                })()}</p>
                                <p>{p.timelockSeconds === -1 ? (
                                  <span className="text-gray-500">Gov. timelock: N/A (not available on {p.version})</span>
                                ) : (
                                  <Check pass={p.hasTimelock} label={p.hasTimelock ? `Gov. timelock enabled (${p.timelockLabel})` : 'No gov. timelock'} />
                                )}</p>
                                <p>{p.hasRoleSeparation === null && p.version !== 'Squads V4' ? (
                                  <span className="text-gray-500">Roles: N/A (not available on {p.version})</span>
                                ) : p.hasRoleSeparation === true && (p.threshold ?? 0) < 2 ? (
                                  <Tooltip text="Permissions are split across signers, but the threshold is 1. A single signer can still execute without co-approval, so role separation does not provide meaningful containment here.">
                                    <Check pass={false} label="Role separation present but threshold is 1 (trivial)" />
                                  </Tooltip>
                                ) : (
                                  <Check pass={p.hasRoleSeparation === true} label={p.hasRoleSeparation === true ? 'Role separation (not all signers have equal permissions)' : p.hasRoleSeparation === false ? 'No role separation, all signers have full permissions' : 'Role separation unknown'} />
                                )}</p>
                                <p>{p.verifiedBuild === true ? (
                                  <Check pass={true} label="Verified build (deployed code matches published source)" />
                                ) : p.verifiedBuild === 'partial' ? (
                                  <span className="text-gray-300 font-bold">{'\u2713'} Verified build on some programs, not all. Check individual programs below.</span>
                                ) : (
                                  <Check pass={false} label="No verified build. Cannot confirm deployed code matches source." />
                                )}</p>
                                {p.configAuthority && p.configAuthority !== 'autonomous' && (
                                  <p className="mt-1"><span className="text-gray-400 font-bold">{'\u2717'} External config authority key</span> <span className="text-gray-400">can change threshold, members, and timelock on this multisig without going through the multisig vote</span>. <code className="text-[10px] text-gray-400">{p.configAuthority.slice(0, 12)}...</code>
                                  <Tooltip text="Squads documentation states a Controlled Multisig is not recommended for most use cases."><InfoIcon /></Tooltip></p>
                                )}
                              </>
                            ) : p.version === 'Serum Multisig' ? (
                              <>
                                <h4 className="font-bold text-white mb-2">Governance</h4>
                                <p className="text-gray-400 text-[11px]">Legacy multisig (Serum program). {p.threshold}/{p.totalMembers} threshold. Does not support timelocks or role separation natively.</p>
                                <p className="mt-1"><Check pass={p.verifiedBuild === true} label={p.verifiedBuild ? 'Verified build' : 'No verified build'} /></p>
                              </>
                            ) : p.version === 'Single Signer' ? (
                              <>
                                <h4 className="font-bold text-white mb-2">Governance</h4>
                                <p className="text-gray-400 text-[11px]">Single wallet, no multisig governance detected on-chain.</p>
                                <p className="mt-1"><Check pass={p.verifiedBuild === true} label={p.verifiedBuild ? 'Verified build' : 'No verified build'} /></p>
                              </>
                            ) : p.version === 'Wormhole' ? (
                              <>
                                <h4 className="font-bold text-white mb-2">Governance</h4>
                                <p className="text-gray-400 text-[11px]">Wormhole governance. On-chain threshold is {p.threshold}/{p.totalMembers} (Pythian Council). Cross-chain guardian consensus requires 13/19 independent operators. Different security model to Squads multisig. Not directly comparable.</p>
                                <p className="mt-1"><Check pass={p.verifiedBuild === true} label={p.verifiedBuild ? 'Verified build' : 'No verified build'} /></p>
                              </>
                            ) : p.version === 'Realms DAO' ? (
                              <>
                                <h4 className="font-bold text-white mb-2">Governance</h4>
                                <p className="text-gray-400 text-[11px]">Token-weighted DAO voting (SPL Governance / Realms). Not a multisig. Governance depends on token holder participation and quorum thresholds. Not directly comparable to Squads.</p>
                                <p className="mt-1"><Check pass={p.verifiedBuild === true} label={p.verifiedBuild ? 'Verified build' : 'No verified build'} /></p>
                              </>
                            ) : (
                              <>
                                <h4 className="font-bold text-white mb-2">Governance</h4>
                                <p className="text-gray-400 text-[11px]">Different governance model ({p.version}). The Squads benchmark does not apply.</p>
                                <p className="mt-1"><Check pass={p.verifiedBuild === true} label={p.verifiedBuild ? 'Verified build' : 'No verified build'} /></p>
                              </>
                            )}

                            {p.programs && p.programs.length > 0 && (
                              <ProgramsList p={p} />
                            )}

                            {p.protocolDisclosed && (
                              <>
                                <h4 className="font-bold text-white mt-4 mb-2">
                                  Protocol Disclosed
                                  <Tooltip text="Protocol-disclosed information. Not independently verified on-chain."><InfoIcon /></Tooltip>
                                </h4>
                                {p.protocolDisclosed.compliance && (
                                  <p className="text-[11px]"><span className="text-gray-500">Compliance:</span> <span className="text-gray-300">{p.protocolDisclosed.compliance.join(', ')}</span>
                                    {p.protocolDisclosed.complianceLink && (
                                      <a href={p.protocolDisclosed.complianceLink} target="_blank" rel="noopener" className="ml-1 text-gray-500 hover:text-gray-300 underline decoration-gray-700">verify</a>
                                    )}
                                  </p>
                                )}
                                {p.protocolDisclosed.custodyModel && (
                                  <p className="text-[11px]"><span className="text-gray-500">Custody:</span> <span className="text-gray-300">{p.protocolDisclosed.custodyModel}</span></p>
                                )}
                                {p.protocolDisclosed.custodyNote && (
                                  <p className="text-[11px] text-gray-500">{p.protocolDisclosed.custodyNote}</p>
                                )}
                                {p.protocolDisclosed.other && (
                                  <p className="text-[11px] text-gray-400">{p.protocolDisclosed.other}</p>
                                )}
                                {p.protocolDisclosed.updatedAt && (
                                  <p className="text-[10px] text-gray-400 mt-1">Updated {p.protocolDisclosed.updatedAt}</p>
                                )}
                              </>
                            )}

                            {p.publicDocs && (
                              <>
                                <h4 className="font-bold text-white mt-4 mb-2">
                                  Public Documentation
                                  <Tooltip text="Information sourced from the protocol's public documentation, announcements, or case studies. Not independently verified on-chain."><InfoIcon /></Tooltip>
                                </h4>
                                {p.publicDocs.other && (
                                  <p className="text-[11px] text-gray-400">{p.publicDocs.other}</p>
                                )}
                                <div className="flex items-center gap-3 mt-1">
                                  {p.publicDocs.source && (
                                    <a href={p.publicDocs.source} target="_blank" rel="noopener" className="text-[10px] text-gray-400 hover:text-gray-300 underline decoration-gray-700">Read more</a>
                                  )}
                                  {p.publicDocs.updatedAt && (
                                    <span className="text-[10px] text-gray-400">Updated {p.publicDocs.updatedAt}</span>
                                  )}
                                </div>
                              </>
                            )}

                            {p.insuranceFund && (
                              <>
                                <h4 className="font-bold text-white mt-4 mb-2">
                                  Insurance / Recovery Profile
                                  <Tooltip text="Insurance fund information based on public documentation and protocol disclosures."><InfoIcon /></Tooltip>
                                </h4>
                                <div className="space-y-1 text-[11px]">
                                  <p>
                                    <span className="text-gray-500">Fund type:</span>{' '}
                                    <span className={
                                      p.insuranceFund.fundType === 'socialized_loss'
                                        ? 'text-gray-400'
                                        : p.insuranceFund.fundType === 'none'
                                        ? 'text-gray-500'
                                        : 'text-gray-300'
                                    }>
                                      {p.insuranceFund.fundType === 'none' ? 'Not found in public docs' :
                                       p.insuranceFund.fundType === 'socialized_loss' ? 'Socialised loss (spread across all users)' :
                                       p.insuranceFund.fundType === 'stablecoin' ? 'Stablecoin fund' :
                                       'Token treasury'}
                                    </span>
                                  </p>
                                  {p.insuranceFund.fundSizeEstimate && (
                                    <p><span className="text-gray-500">Estimated size:</span> <span className="text-gray-300">{p.insuranceFund.fundSizeEstimate}</span></p>
                                  )}
                                  <p><span className="text-gray-500">Policy:</span> <span className="text-gray-400">{p.insuranceFund.reimbursementPolicy}</span></p>
                                  {p.insuranceFund.historicalReimbursement && (
                                    <p><span className="text-gray-500">Track record:</span> <span className="text-gray-400">{p.insuranceFund.historicalReimbursement}</span></p>
                                  )}
                                  {p.insuranceFund.sourceUrl && (
                                    <a href={p.insuranceFund.sourceUrl} target="_blank" rel="noopener" className="text-[10px] text-gray-400 hover:text-gray-300 underline decoration-gray-700 block mt-1">Source documentation</a>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-8 pt-5 border-t border-white/[0.04] text-[11px] text-gray-500 space-y-1">
          <a
            href="https://www.soladex.io/project/solgov"
            target="_blank"
            rel="noopener noreferrer"
            title="View the solgov review on Soladex"
            className="inline-block mb-3"
          >
            <img src="/reviewed-by-soladex.svg" alt="Reviewed by Soladex" className="h-9 w-auto hover:opacity-80 transition-opacity" />
          </a>
          <p>All governance data decoded directly from on-chain Solana account data. Live updates via Helius webhooks.{isLive && lastScan ? ` Last event: ${lastScan.split('T')[0]} ${lastScan.split('T')[1]?.slice(0, 5)} UTC.` : ''}{!llama.loading ? ' TVL data live from DeFiLlama.' : ''}</p>
          <p className="text-gray-700">This dashboard does not provide financial advice. It presents on-chain governance configurations for informational purposes.</p>
        </div>
      </>)}

      {activeTab === 'govwatch' && (
        <GovWatchView protocols={liveProtocols} liveStates={liveStates} liveActivity={liveActivity} liveHistorical={liveHistorical} historicalAsOf={historicalAsOf} />
      )}

      {activeTab === 'blast' && (
        <BlastRadiusView llama={llama} liveProtocols={liveProtocols} />
      )}

      {activeTab === 'charts' && (
        <div className="space-y-6">
          <div className="flex gap-1 border-b border-white/[0.04]">
            {([
              { id: 'exploits', label: 'Exploits' },
              { id: 'risk', label: 'Risk metrics' },
              { id: 'governance', label: 'Governance health' },
            ] as const).map(tab => (
              <button
                key={tab.id}
                onClick={() => setChartsSubTab(tab.id)}
                className={`px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2 -mb-px cursor-pointer ${
                  chartsSubTab === tab.id
                    ? 'text-white border-white'
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {chartsSubTab === 'exploits' && (() => {
            const allHacks = [
              ...(solanaHacksData.hacks as any[]),
              ...(evmHacksData.hacks as any[]).filter((h: any) => h.category !== 'excluded'),
              ...(otherChainHacksData.hacks as any[]),
            ];
            const totalGross = allHacks.reduce((s, h) => s + (h.amountUsd || 0), 0);
            const signerGross = allHacks.filter(h => h.category === 'signer').reduce((s, h) => s + (h.amountUsd || 0), 0);
            const signerShare = totalGross > 0 ? signerGross / totalGross : 0;
            const fmt = (n: number) => n >= 1e9 ? '$' + (n/1e9).toFixed(2) + 'B' : '$' + (n/1e6).toFixed(0) + 'M';
            return (
              <div className="space-y-6">
                <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-4">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Headline finding</div>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <div className="text-3xl font-semibold text-white tabular-nums">{fmt(signerGross)}</div>
                    <div className="text-sm text-gray-300">of <span className="tabular-nums">{fmt(totalGross)}</span> tracked DeFi losses ({(signerShare * 100).toFixed(0)}%) trace to signer / admin key compromise.</div>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-2">Across Solana and EVM chains. The single category audits don&apos;t typically catch. Across crypto as a whole (including centralised exchange multisig compromises like Bybit&apos;s $1.44B) the figure is materially higher.</p>
                </div>
                <SolanaHackChart />
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Cross-chain context</div>
                  <p className="text-[10px] text-gray-400 mb-3">Smaller reference views. Solana DeFi exploits are the focus of this dashboard; the panels below scale those losses against an EVM-only aggregate and a combined total.</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <CompactHackChart
                      title="EVM DeFi Exploits"
                      subtitle="EVM chains, since 2016"
                      hacks={(evmHacksData.hacks as any[]).filter((h: any) => h.category !== 'excluded') as any}
                    />
                    <CompactHackChart
                      title="All tracked DeFi"
                      subtitle="Solana, EVM chains, and others. Curated major incidents."
                      hacks={allHacks as any}
                    />
                  </div>
                </div>
              </div>
            );
          })()}
          {chartsSubTab === 'risk' && <ChainRiskPanel />}
          {chartsSubTab === 'governance' && <GovernanceCharts protocols={liveProtocols} liveIntegrity={liveIntegrity} liveActivity={liveActivity} />}
        </div>
      )}
      </main>
    </div>
  );
}

function GovWatchView({ protocols: liveProtocols, liveStates, liveActivity, liveHistorical, historicalAsOf }: { protocols: typeof PROTOCOLS; liveStates: Record<string, any>; liveActivity: { date: string; timestamp: string; protocol: string; type: string; detail: string }[]; liveHistorical: Record<string, import('./hooks/useLiveData').HistoricalProtocolState>; historicalAsOf: string | null }) {
  const [selectedProtocol, setSelectedProtocol] = useState<string | null>(null);
  // Same as the dashboard table: bring the expanded detail row into view when a protocol near the
  // bottom is opened, so the click doesn't look like nothing happened.
  const govDetailRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!selectedProtocol) return;
    const id = requestAnimationFrame(() => {
      govDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [selectedProtocol]);
  const [feedFilter, setFeedFilter] = useState<string>('all');

  const yieldbay = useYieldbayHealth();

  const liveByName = useMemo(() => {
    const map: Record<string, typeof liveProtocols[0]> = {};
    for (const p of liveProtocols) map[p.name] = p;
    return map;
  }, [liveProtocols]);

  const liveConfigDatesByProtocol = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const evt of liveActivity) {
      if (evt.type === 'ConfigChange') {
        if (!map[evt.protocol]) map[evt.protocol] = [];
        if (!map[evt.protocol].includes(evt.date)) map[evt.protocol].push(evt.date);
      }
    }
    return map;
  }, [liveActivity]);

  const liveCountsByProtocol = useMemo(() => {
    const counts: Record<string, {
      approvals: number; rejections: number; cancellations: number;
      vaultTx: number; proposalsCreated: number; programUpgrades: number;
      configChanges: number;
    }> = {};
    const blank = () => ({ approvals: 0, rejections: 0, cancellations: 0, vaultTx: 0, proposalsCreated: 0, programUpgrades: 0, configChanges: 0 });
    for (const evt of liveActivity) {
      if (!counts[evt.protocol]) counts[evt.protocol] = blank();
      const c = counts[evt.protocol];
      if (evt.type === 'Approval') c.approvals++;
      else if (evt.type === 'Rejection') c.rejections++;
      else if (evt.type === 'Cancellation') c.cancellations++;
      else if (evt.type === 'VaultTx') c.vaultTx++;
      else if (evt.type === 'ProposalCreated') c.proposalsCreated++;
      else if (evt.type === 'ProgramUpgrade') c.programUpgrades++;
      else if (evt.type === 'ConfigChange') c.configChanges++;
    }
    return counts;
  }, [liveActivity]);

  function getEffectiveGov(name: string, baseGov: typeof GOV_PROFILES[string]) {
    const live = liveByName[name];
    const rawHist = liveHistorical[name];
    const histLooksEmpty = rawHist
      && (rawHist.totalTxs ?? 0) === 0
      && (rawHist.approvedProposals ?? 0) === 0
      && (rawHist.configChanges ?? 0) === 0;
    const hist = histLooksEmpty ? undefined : rawHist;
    const liveDates = liveConfigDatesByProtocol[name] || [];
    const liveCounts = liveCountsByProtocol[name] || { approvals: 0, rejections: 0, cancellations: 0, vaultTx: 0, proposalsCreated: 0, programUpgrades: 0, configChanges: 0 };
    const mergedDates = Array.from(new Set([...liveDates, ...(hist?.configDates ?? []), ...baseGov.configDates])).sort().reverse();
    return {
      ...baseGov,
      totalMembers: live?.totalMembers ?? baseGov.totalMembers,
      activeVoters90d: live && live.totalMembers > baseGov.totalMembers
        ? Math.min(live.totalMembers, baseGov.activeVoters90d + (live.totalMembers - baseGov.totalMembers))
        : baseGov.activeVoters90d,
      voterRate: live?.totalMembers
        ? Math.round((live.totalMembers > baseGov.totalMembers
            ? Math.min(live.totalMembers, baseGov.activeVoters90d + (live.totalMembers - baseGov.totalMembers))
            : baseGov.activeVoters90d) / live.totalMembers * 100)
        : baseGov.voterRate,
      configChanges: hist?.configChanges ?? (baseGov.configChanges + liveCounts.configChanges),
      configDates: mergedDates,
      approvedProposals: hist?.approvedProposals ?? ((baseGov.approvedProposals ?? 0) + liveCounts.approvals),
      rejectedProposals: hist?.rejectedProposals ?? ((baseGov.rejectedProposals ?? 0) + liveCounts.rejections),
      cancelledProposals: hist?.cancelledProposals ?? ((baseGov.cancelledProposals ?? 0) + liveCounts.cancellations),
      spendingLimitUses: hist?.spendingLimitUses ?? baseGov.spendingLimitUses,
      totalTxs: hist?.totalTxs ?? baseGov.totalTxs,
      topFeePayerPct: (() => {
        if (!hist?.uniqueFeePayers) return baseGov.topFeePayerPct;
        const counts = Object.values(hist.uniqueFeePayers);
        const total = counts.reduce((a, b) => a + b, 0);
        if (total === 0) return baseGov.topFeePayerPct;
        const top = Math.max(...counts);
        return Math.round((top / total) * 100);
      })(),
    };
  }

  const feed = useMemo(() => {
    const events: { date: string; protocol: string; type: string; ts?: string; multisig?: string }[] = [];

    for (const entry of ACTIVITY_FEED as { date: string; protocol: string; type: string; detail: string }[]) {
      const label = entry.type === 'VaultTx' ? 'Vault transaction executed'
        : entry.type === 'SpendingLimit' ? 'Spending limit used'
        : entry.detail;
      const detail = entry.detail.includes('(x') ? entry.detail.match(/\(x\d+\)/)?.[0] || '' : '';
      events.push({ date: entry.date, protocol: entry.protocol, type: label + (detail ? ' ' + detail : '') });
    }

    for (const [name, g] of Object.entries(GOV_PROFILES)) {
      for (const d of g.configDates) {
        events.push({ date: d, protocol: name, type: 'Config change' });
      }
    }

    for (const [name, state] of Object.entries(liveStates)) {
      if (state.pendingProposals > 0 && state.lastChecked) {
        events.push({ date: state.lastChecked.split('T')[0], protocol: name, type: state.pendingProposals + ' pending proposal' + (state.pendingProposals > 1 ? 's' : ''), ts: state.lastChecked });
      }
      if (state.threatAlerts) {
        for (const alert of state.threatAlerts) {
          const cat = alert.category as string;
          const uiLabel = cat === 'NONCE' ? 'Durable nonce activity'
            : null;
          if (!uiLabel) continue;
          events.push({ date: alert.detectedAt.split(' ')[0] || state.lastChecked?.split('T')[0] || '', protocol: name, type: uiLabel, ts: alert.detectedAt });
        }
      }
    }

    for (const evt of cleanLiveActivity(liveActivity)) {
      events.push({ date: evt.date, protocol: evt.protocol, type: evt.type, ts: evt.timestamp, multisig: evt.multisig });
    }

    for (const e of yieldbay.events) {
      const protoNames = (window as any).__YIELDBAY_TO_SOLGOV?.[e.protocol]
        || (e.protocol === 'kamino' ? ['Kamino']
          : e.protocol === 'meteora_dv' || e.protocol === 'meteora_amm_tx' ? ['Meteora']
          : e.protocol === 'jupiter_borrow' || e.protocol === 'jupiter_earn' ? ['Jupiter Lend']
          : e.protocol === 'perena' ? ['Perena']
          : e.protocol === 'spl_stake_pools' ? ['Jito', 'Marinade', 'BlazeStake']
          : []);
      const date = (e.started_at || e.updated_at || '').slice(0, 10);
      const sev = e.severity === 'critical' ? 'critical' : e.severity === 'warning' ? 'warning' : 'info';
      const deltaPct = e.values?.worst_delta_pct || e.values?.delta_pct || '';
      const isPercentMeaningful = deltaPct && deltaPct !== '0.00%' && deltaPct !== '0%' && deltaPct !== '-' && !deltaPct.startsWith('0.0');
      const isMismatchType = (e.field?.name || '').toLowerCase().includes('mismatch') || (e.field?.name || '').includes('vs_issued');
      const fieldLabel = e.field?.label || e.entity?.name || 'event';
      const valuePart = isPercentMeaningful
        ? ` ${deltaPct}`
        : isMismatchType
          ? ' mismatch'
          : '';
      const summary = `${fieldLabel}${valuePart} · ${sev} · Yieldbay`;
      for (const protoName of protoNames) {
        events.push({ date, protocol: protoName, type: summary });
      }
    }

    const seen = new Set<string>();
    const deduped = events.filter(e => {
      const key = e.date + '|' + e.protocol + '|' + e.type + '|' + (e.multisig || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    deduped.sort((a, b) => {
      const ta = a.ts ? Date.parse(a.ts) : NaN;
      const tb = b.ts ? Date.parse(b.ts) : NaN;
      if (!isNaN(ta) && !isNaN(tb)) return tb - ta;
      return b.date.localeCompare(a.date);
    });
    if (feedFilter !== 'all') return deduped.filter(e => e.protocol === feedFilter);
    return deduped;
  }, [feedFilter, liveStates, liveActivity, yieldbay.events]);

  const govEntries = Object.entries(GOV_PROFILES)
    .map(([name, g]) => [name, getEffectiveGov(name, g)] as [string, typeof g])
    .sort((a, b) => b[1].configChanges - a[1].configChanges);

  const historicalDate = historicalAsOf ? historicalAsOf.slice(0, 10) : null;
  const snapshotLabel = historicalDate
    ? `Counts refreshed ${historicalDate}`
    : `Counts as of ${GOV_PROFILES_AS_OF}`;
  const snapshotTooltip = historicalDate
    ? "Proposal/config/spending counts come from the incremental on-chain scan that ran on this date. Multisig state (threshold, members, timelock) is live."
    : `Proposal/config/spending counts are from the on-chain scan run on ${GOV_PROFILES_AS_OF}. Multisig state (threshold, members, timelock) is live. Signer-level fields (active voters in last 90d, hot wallet flags, ghost signers) are from the same snapshot.`;

  return (
    <>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white mb-1">GovWatch</h2>
        <p className="text-xs text-gray-500">Governance accountability data. On-chain verified. Live updates via Helius webhooks.</p>
      </div>

      <div className="overflow-auto max-h-[80vh] border border-white/[0.06] rounded-md scroll-thin">
        <table className="w-full text-sm">
          <thead className="bg-[#0e0e14] sticky top-0 z-20">
            <tr>
              <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">Protocol</th>
              <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Created <Tooltip text="Date the multisig was first created on-chain."><InfoIcon /></Tooltip>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Config <Tooltip text="Total governance config changes (threshold, members, timelock). More = actively maintained."><InfoIcon /></Tooltip>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Voters <Tooltip text="Signers active in the last 90 days / total members. 0 active = nobody governing."><InfoIcon /></Tooltip>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Avg Exec <Tooltip text="Average time from proposal creation to execution. Longer = more deliberation."><InfoIcon /></Tooltip>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Proposers <Tooltip text="Unique signers who create proposals. 1 = single point of control."><InfoIcon /></Tooltip>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Build <Tooltip text="On-chain verified build via OtterSec/Ellipsis verifier. Confirms deployed bytecode matches source code."><InfoIcon /></Tooltip>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Nonces <Tooltip text="Signers with durable nonce activity detected on-chain."><InfoIcon /></Tooltip>
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">
                Activity <Tooltip text="Signing activity hours based on on-chain transaction timestamps. Dist = spread across multiple regions. Conc = concentrated in one region."><InfoIcon /></Tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {govEntries.map(([name, g]) => (
              <Fragment key={name}>
                <tr
                  className="border-t border-white/[0.04] hover:bg-white/[0.02] cursor-pointer"
                  onClick={() => setSelectedProtocol(selectedProtocol === name ? null : name)}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <ProtocolLogo name={name} />
                      <span className="font-medium text-white whitespace-nowrap">{displayName(name)}</span>
                      {liveStates[name]?.pendingProposals > 0 && (
                        <Tooltip text={liveStates[name].pendingProposals + ' proposal' + (liveStates[name].pendingProposals > 1 ? 's' : '') + ' awaiting execution'}>
                          <span className="ml-2 px-1.5 py-0.5 text-[9px] rounded bg-white/[0.04] text-gray-300 border border-white/[0.08] cursor-help">
                            {liveStates[name].pendingProposals} pending
                          </span>
                        </Tooltip>
                      )}
                      {(() => {
                        const all = liveStates[name]?.threatAlerts || [];
                        const uiAlerts = all.filter((a: any) => a.category === 'NONCE');
                        if (uiAlerts.length === 0) return null;
                        const tooltipText = uiAlerts.map((a: any) => a.detail || 'Durable nonce activity').join('. ');
                        return (
                          <Tooltip text={tooltipText}>
                            <span className="ml-1 px-1.5 py-0.5 text-[9px] rounded bg-white/[0.04] text-gray-400 border border-white/[0.08] cursor-help">
                              {uiAlerts.length} finding{uiAlerts.length > 1 ? 's' : ''}
                            </span>
                          </Tooltip>
                        );
                      })()}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-400">{g.created}</td>
                  <td className="px-3 py-2 text-xs text-center text-gray-300">
                    <Tooltip text={g.configChanges + ' governance config changes.' + (g.configDates.length > 0 ? ' Last: ' + g.configDates[0] : ' None recorded.')}>
                      <span className="cursor-help">{g.configChanges}</span>
                    </Tooltip>
                  </td>
                  <td className="px-3 py-2 text-xs text-center text-gray-300">
                    <Tooltip text={g.activeVoters90d + ' of ' + g.totalMembers + ' signers active in last 90 days (' + g.voterRate + '%)'}>
                      <span className="cursor-help">{g.activeVoters90d}/{g.totalMembers}</span>
                    </Tooltip>
                  </td>
                  <td className="px-3 py-2 text-xs text-center text-gray-400">
                    {g.avgExecuteTimeH > 0 ? (
                      <Tooltip text={'Average ' + g.avgExecuteTimeH.toFixed(1) + ' hours from proposal to execution. Fastest: ' + g.fastestExecuteH.toFixed(1) + 'h. Slowest: ' + g.slowestExecuteH.toFixed(1) + 'h.'}>
                        <span className="cursor-help">{g.avgExecuteTimeH >= 24 ? Math.round(g.avgExecuteTimeH / 24) + 'd' : g.avgExecuteTimeH.toFixed(1) + 'h'}</span>
                      </Tooltip>
                    ) : (
                      <span className="text-gray-500">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-center text-gray-400">{g.proposers}</td>
                  <td className="px-3 py-2 text-xs text-center text-gray-300">
                    {g.verifiedBuild ? 'Yes' : 'No'}
                  </td>
                  <td className="px-3 py-2 text-xs text-center text-gray-300">
                    {(() => {
                      const liveNonces = (liveStates[name]?.threatAlerts || []).filter((a: any) => a.category === 'NONCE').length;
                      return liveNonces > 0 ? liveNonces : g.nonceFlags;
                    })()}
                  </td>
                  <td className="px-3 py-2 text-xs text-center text-gray-300">
                    {g.timezoneDiversity === 'distributed' ? (
                      <Tooltip text={'Signing activity spread across multiple UTC windows'}><span className="cursor-help">Dist</span></Tooltip>
                    ) : g.timezoneDiversity === 'concentrated' ? (
                      <Tooltip text={'Signing activity concentrated in a narrow UTC window'}><span className="cursor-help">Conc</span></Tooltip>
                    ) : '-'}
                  </td>
                </tr>
                {selectedProtocol === name && (
                  <tr key={`${name}-detail`} ref={govDetailRef} className="bg-white/[0.01] scroll-mt-2">
                    <td colSpan={9} className="px-2 md:px-6 py-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 text-xs min-w-0 max-w-full overflow-hidden">
                        <div className="min-w-0 overflow-hidden">
                          <h4 className="font-bold text-white mb-2">Activity</h4>
                          <p><span className="text-gray-500">Created:</span> <span className="text-gray-300">{g.created}</span></p>
                          <p><span className="text-gray-500">Total transactions:</span> <span className="text-gray-300">{g.totalTxs}{g.totalTxs >= 1000 ? '+' : ''}</span></p>
                          {(() => {
                            const protoFeed = (ACTIVITY_FEED as { date: string; protocol: string; type: string; detail: string }[]).filter(e => e.protocol === name);
                            const vaultCount = protoFeed.filter(e => e.type === 'VaultTx').reduce((sum, e) => {
                              const m = e.detail.match(/\(x(\d+)\)/); return sum + (m ? parseInt(m[1]) : 1);
                            }, 0);
                            const slCount = protoFeed.filter(e => e.type === 'SpendingLimit').reduce((sum, e) => {
                              const m = e.detail.match(/\(x(\d+)\)/); return sum + (m ? parseInt(m[1]) : 1);
                            }, 0);
                            return (
                              <div className="mt-1 space-y-0.5">
                                {vaultCount > 0 && <p><span className="text-gray-500">Vault executions:</span> <span className="text-gray-300">{vaultCount}</span></p>}
                                {slCount > 0 && <p><span className="text-gray-500">Spending limit uses:</span> <span className="text-gray-300">{slCount}</span></p>}
                                <p><span className="text-gray-500">Config changes:</span> <span className="text-gray-300">{g.configChanges}</span></p>
                              </div>
                            );
                          })()}
                          {(() => {
                            const hasMultipleProgs = (g.programUpgrades?.length ?? 0) > 1;
                            if (hasMultipleProgs) return null;
                            const sizeLabel = g.programSizeKB === 10240
                              ? '10240 KB (BPF max)'
                              : g.programSizeKB > 0
                                ? g.programSizeKB + ' KB'
                                : 'Unknown';
                            return (
                              <>
                                <p><span className="text-gray-500">Program deployed:</span> <span className="text-gray-300">{g.deployDate}</span></p>
                                <p><span className="text-gray-500">Program size:</span> <span className="text-gray-300">{sizeLabel}</span></p>
                              </>
                            );
                          })()}
                          {(() => {
                            const ybEvents = yieldbay.bySolgovName[name] || [];
                            if (ybEvents.length === 0) return null;
                            const crit = ybEvents.filter(e => e.severity === 'critical').length;
                            const warn = ybEvents.filter(e => e.severity === 'warning').length;
                            const parts: string[] = [];
                            if (crit > 0) parts.push(`${crit} critical`);
                            if (warn > 0) parts.push(`${warn} warning`);
                            return (
                              <p className="mt-1">
                                <span className="text-gray-500">Operational signals:</span>{' '}
                                <span className="text-gray-300">{parts.join(', ')} open</span>{' '}
                                <a
                                  href="https://app.yieldbay.fi/health"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-gray-500 hover:text-gray-300 text-[10px] underline"
                                >
                                  Yieldbay
                                </a>
                              </p>
                            );
                          })()}
                          {(g.membersAdded > 0 || g.membersRemoved > 0 || g.thresholdChanges > 0 || g.timelockChanges > 0) && (
                            <>
                              <h4 className="font-bold text-white mt-3 mb-1">Config Breakdown</h4>
                              <p className="text-gray-400 text-[11px]">
                                {g.membersAdded > 0 && `+${g.membersAdded} members added`}
                                {g.membersAdded > 0 && g.membersRemoved > 0 && ', '}
                                {g.membersRemoved > 0 && `${g.membersRemoved} removed`}
                                {(g.membersAdded > 0 || g.membersRemoved > 0) && (g.thresholdChanges > 0 || g.timelockChanges > 0) && '. '}
                                {g.thresholdChanges > 0 && `${g.thresholdChanges} threshold change${g.thresholdChanges > 1 ? 's' : ''}`}
                                {g.thresholdChanges > 0 && g.timelockChanges > 0 && ', '}
                                {g.timelockChanges > 0 && `${g.timelockChanges} timelock change${g.timelockChanges > 1 ? 's' : ''}`}
                              </p>
                            </>
                          )}
                          {g.configChanges > 0 && (
                            <>
                              <h4 className="font-bold text-white mt-3 mb-1">
                                Active days
                                {g.configDates.length < g.configChanges ? (
                                  <span className="font-normal text-gray-500 text-[11px] ml-1">
                                    ({g.configChanges} changes across {g.configDates.length} {g.configDates.length === 1 ? 'day' : 'days'})
                                  </span>
                                ) : (
                                  <span className="font-normal text-gray-500 text-[11px] ml-1">
                                    ({g.configDates.length} {g.configDates.length === 1 ? 'day' : 'days'})
                                  </span>
                                )}
                              </h4>
                              <div className="max-h-24 overflow-y-auto space-y-0.5">
                                {g.configDates.map((d, i) => (
                                  <p key={i} className="text-gray-400 font-mono text-[11px]">{d}</p>
                                ))}
                              </div>
                            </>
                          )}
                          {g.programUpgrades && g.programUpgrades.length > 0 && (
                            <>
                              <h4 className="font-bold text-white mt-3 mb-1">Program Upgrades</h4>
                              <div className="space-y-0.5">
                                {g.programUpgrades.map((u, i) => (
                                  <p key={i} className="text-[11px]"><span className="text-gray-500">{u.name}:</span> <span className="text-gray-300">{u.count}</span> <span className="text-gray-500">(last {u.lastDate})</span></p>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                        <div className="min-w-0 overflow-hidden">
                          <h4 className="font-bold text-white mb-2">Governance Speed</h4>
                          {g.avgExecuteTimeH > 0 && (
                            <>
                              <p><span className="text-gray-500">Avg proposal to execution:</span> <span className="text-gray-300">{g.avgExecuteTimeH.toFixed(1)}h</span></p>
                              <p><span className="text-gray-500">Fastest:</span> <span className="text-gray-300">{g.fastestExecuteH.toFixed(1)}h</span></p>
                              <p><span className="text-gray-500">Slowest:</span> <span className="text-gray-300">{g.slowestExecuteH.toFixed(1)}h</span></p>
                            </>
                          )}
                          <p><span className="text-gray-500">Unique proposers:</span> <span className="text-gray-300">{g.proposers}</span></p>
                          <p><span className="text-gray-500">Unique approvers:</span> <span className="text-gray-300">{g.approvers}</span></p>
                          <p><span className="text-gray-500">Unique executors:</span> <span className="text-gray-300">{g.executors}</span></p>
                          {g.rubberStampSigners > 0 && (
                            <p><span className="text-gray-500">Same signer proposes + executes:</span> <span className="text-gray-300">{g.rubberStampSigners} <Tooltip text="Squads recommends separating Initiate, Vote, and Execute roles. Same signer in multiple stages reduces the practical benefit of multisig governance."><InfoIcon /></Tooltip></span></p>
                          )}
                          {(g.approvedProposals !== undefined && g.approvedProposals > 0) && (
                            <>
                              <h4 className="font-bold text-white mt-3 mb-1">Governance Health</h4>
                              <p><span className="text-gray-500">Proposals approved:</span> <span className="text-gray-300">{g.approvedProposals}</span></p>
                              <p><span className="text-gray-500">Proposals rejected:</span> <span className="text-gray-300">{g.rejectedProposals || 0} ({g.approvedProposals && g.rejectedProposals !== undefined ? Math.round(g.rejectedProposals / (g.approvedProposals + g.rejectedProposals) * 100) : 0}%)</span></p>
                              {g.cancelledProposals !== undefined && g.cancelledProposals > 0 && (
                                <p><span className="text-gray-500">Proposals cancelled:</span> <span className="text-gray-300">{g.cancelledProposals}</span></p>
                              )}
                              {g.spendingLimitUses !== undefined && g.spendingLimitUses > 0 && (
                                <p><span className="text-gray-500">Spending limit uses:</span> <span className="text-gray-300">{g.spendingLimitUses}</span></p>
                              )}
                            </>
                          )}
                        </div>
                        <div className="min-w-0 overflow-hidden">
                          <h4 className="font-bold text-white mb-2">Security Signals</h4>
                          {(() => {
                            const liveProto = liveByName[name];
                            const isV3 = liveProto?.version && liveProto.version !== 'Squads V4';
                            return (
                              <>
                                <p><span className="text-gray-500">Active voters (90d):</span> <span className="text-gray-300">{g.activeVoters90d}/{g.totalMembers} ({g.voterRate}%){isV3 ? <Tooltip text="V3/Serum multisigs often used only for emergency changes, so low 90-day activity may reflect rare use rather than dormancy."><InfoIcon /></Tooltip> : null}</span></p>
                                {g.neverSignedCount !== undefined && g.neverSignedCount > 0 && (
                                  <p><span className="text-gray-500">Never signed:</span> <span className="text-gray-300">{g.neverSignedCount} of {g.totalMembers} <Tooltip text="Members who have never signed anything in the multisig's entire history. Different from ghost signers (who signed at some point but not recently)."><InfoIcon /></Tooltip></span></p>
                                )}
                              </>
                            );
                          })()}
                          {(() => {
                            const liveNonces = (liveStates[name]?.threatAlerts || []).filter((a: any) => a.category === 'NONCE');
                            const count = liveNonces.length || g.nonceFlags;
                            const label = count > 0 ? count + ' signer(s)' : 'None detected';
                            const tip = liveNonces.length > 0 ? liveNonces.map((a: any) => a.detail).join(' · ') : '';
                            return (
                              <p>
                                <span className="text-gray-500">Nonce activity:</span>{' '}
                                {tip ? (
                                  <Tooltip text={tip}>
                                    <span className="text-gray-300 cursor-help">{label}</span>
                                  </Tooltip>
                                ) : (
                                  <span className="text-gray-300">{label}</span>
                                )}
                              </p>
                            );
                          })()}
                          {g.hotWalletSigners !== undefined && g.hotWalletSigners > 0 && (
                            <p><span className="text-gray-500">Gov keys with DeFi activity:</span> <span className="text-gray-300">{g.hotWalletSigners} signer{g.hotWalletSigners > 1 ? 's' : ''} <Tooltip text="Same key signs both multisig governance actions and DeFi transactions like swaps or bridges. Squads recommends dedicated keys exclusively for governance, regardless of whether they are stored on hardware or software wallets."><InfoIcon /></Tooltip></span></p>
                          )}
                          {g.topFeePayerPct !== undefined && g.topFeePayerPct >= 70 && (
                            <p><span className="text-gray-500">Gas concentration:</span> <span className="text-gray-300">1 signer pays {g.topFeePayerPct}% of tx fees</span></p>
                          )}
                          {g.singlePipelineNote && (() => {
                            const ap = g.approvedProposals || 0;
                            const rj = g.rejectedProposals || 0;
                            const rate = (ap + rj) > 0 ? Math.round(rj / (ap + rj) * 100 * 10) / 10 : 0;
                            const context = (ap + rj) > 0 ? ` (${rate}% rejection rate across ${ap + rj} votes)` : '';
                            return (
                              <p><span className="text-gray-500">Proposal pipeline:</span> <span className="text-gray-300">{g.singlePipelineNote}{context}</span></p>
                            );
                          })()}
                          {g.offHoursConfigChanges && g.offHoursConfigChanges.offHours > 0 && (
                            <p><span className="text-gray-500">Off-hours config changes:</span> <span className="text-gray-300">{g.offHoursConfigChanges.offHours} of {g.offHoursConfigChanges.total} <Tooltip text="Config changes made between 22:00-06:00 UTC"><InfoIcon /></Tooltip></span></p>
                          )}
                          <p><span className="text-gray-500">Verified build:</span> <span className={g.verifiedBuild ? 'text-white' : 'text-gray-300'}>{g.verifiedBuild ? 'Yes' + (g.verifiedBuildDate ? ' (' + g.verifiedBuildDate + ')' : '') : 'No'}</span></p>
                          <p><span className="text-gray-500">Signing activity:</span> <span className="text-gray-300">{g.timezoneDiversity === 'distributed' ? 'Distributed across multiple UTC windows' : g.timezoneDiversity === 'concentrated' ? 'Concentrated in a narrow UTC window' : 'Unknown'}</span></p>
                          {g.identifiedSigners && g.identifiedSigners.length > 0 && (
                            <>
                              <h4 className="font-bold text-white mt-3 mb-1">Identified Signers</h4>
                              <div className="space-y-0.5">
                                {g.identifiedSigners.map((s, i) => (
                                  <p key={i} className="text-[11px]"><span className="text-gray-300">{s.name}</span> <span className="text-gray-500 font-mono">({s.address.slice(0, 6)}..{s.address.slice(-4)})</span></p>
                                ))}
                              </div>
                            </>
                          )}
                          {g.fundingSources && g.fundingSources.length > 0 && (
                            <>
                              <h4 className="font-bold text-white mt-3 mb-1">Notable Funding Sources <Tooltip text="Original funding source of governance signers, from first incoming SOL transfer. Identifying exchanges and mixers, not judging intent."><InfoIcon /></Tooltip></h4>
                              <div className="space-y-0.5">
                                {g.fundingSources.map((f, i) => (
                                  <p key={i} className="text-[11px]"><span className="text-gray-300">{f.funderName}</span><span className="text-gray-500">: {f.signerCount} signer{f.signerCount > 1 ? 's' : ''}{f.firstSeen ? `, first ${f.firstSeen}` : ''}</span></p>
                                ))}
                              </div>
                            </>
                          )}
                          {liveStates[name]?.signerBalances && (
                            <>
                              <h4 className="font-bold text-white mt-3 mb-1">Signer Balances <span className="text-[9px] font-normal text-gray-500">(live)</span></h4>
                              <div className="space-y-0.5">
                                {Object.entries(liveStates[name].signerBalances).map(([addr, bal]: [string, any]) => (
                                  <div key={addr} className="flex items-center gap-2 text-[10px]">
                                    <span className="font-mono text-gray-500">{addr.slice(0, 6)}..{addr.slice(-4)}</span>
                                    <div className="flex-1 h-1 bg-white/[0.04] rounded overflow-hidden">
                                      <div className="h-full rounded" style={{
                                        width: Math.min(100, Math.max(1, (bal / 5) * 100)) + '%',
                                        backgroundColor: bal === 0 ? '#ef4444' : bal < 0.05 ? '#f59e0b' : '#10b981',
                                        opacity: 0.6,
                                      }} />
                                    </div>
                                    <span className={bal === 0 ? 'text-gray-400' : bal < 0.05 ? 'text-gray-300' : 'text-gray-400'}>{bal.toFixed(2)} SOL</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                          {liveStates[name]?.lastChecked && (
                            <p className="mt-2 text-[10px] text-gray-400">Last scanned: {liveStates[name].lastChecked.replace('T', ' ').slice(0, 16)} UTC</p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>


      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">Activity Feed</h3>
          <Dropdown
            value={feedFilter}
            onChange={setFeedFilter}
            options={[
              { value: 'all', label: 'All protocols' },
              ...govEntries.map(([name]) => ({ value: name, label: displayName(name) })),
            ]}
          />
        </div>
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {feed.slice(0, 200).map((e, i) => {
            const typeColor = e.type.includes('Config') ? 'text-gray-300'
              : e.type.includes('pending') ? 'text-orange-400'
              : e.type.includes('NONCE') || e.type.includes('BRIDGE') ? 'text-gray-400'
              : e.type.includes('Spending limit') ? 'text-gray-300'
              : 'text-gray-400';
            return (
              <div key={i} className="flex items-center gap-3 text-xs py-1.5 border-b border-white/[0.03]">
                <span className="text-gray-500 font-mono w-20 flex-shrink-0">{e.date}</span>
                <span className="text-white font-medium w-36 flex-shrink-0 truncate">{activityLabel(e)}</span>
                <span className={typeColor}>{e.type}</span>
              </div>
            );
          })}
          {feed.length === 0 && (
            <p className="text-gray-500 text-center py-4">No activity recorded</p>
          )}
        </div>
      </div>

      <div className="mt-8 pt-5 border-t border-white/[0.04] text-[11px] text-gray-500 space-y-1">
        <p>All data verified on-chain via Helius RPC. Continuous monitoring across {PROTOCOLS.length} protocols.</p>
        <p className="flex items-center gap-1.5">
          {snapshotLabel}
          <Tooltip text={snapshotTooltip}><InfoIcon /></Tooltip>
        </p>
      </div>
    </>
  );
}

function overlayExposureNode(node: ExposureNode, liveByName: Record<string, typeof PROTOCOLS[0]>): { governance: string; timelock: string; activeVoters: string; isLive: boolean } {
  const live = liveByName[node.name];
  if (!live || !live.threshold || !live.totalMembers) {
    return { governance: node.governance, timelock: node.timelock, activeVoters: node.activeVoters, isLive: false };
  }
  const versionTag = live.version === 'Squads V3' || live.version === 'Serum Multisig' ? ' V3' : '';
  const governance = `${live.threshold}/${live.totalMembers}${versionTag}`;
  let timelock: string;
  if (live.timelockSeconds === -1) timelock = 'N/A';
  else if (versionTag) timelock = 'None (V3)';
  else timelock = live.hasTimelock ? (live.timelockLabel || node.timelock) : 'None';
  const activeVoters = versionTag
    ? node.activeVoters
    : `${live.activeVoters ?? live.totalMembers}/${live.totalMembers}`;
  return { governance, timelock, activeVoters, isLive: !versionTag };
}

function ExposureRow({ node, index, liveByName }: { node: ExposureNode; index: number; liveByName: Record<string, typeof PROTOCOLS[0]> }) {
  const hasNote = !!node.note;
  const { governance, timelock, activeVoters, isLive } = overlayExposureNode(node, liveByName);
  return (
    <div className={`flex items-start gap-3 py-2.5 px-3 rounded-lg ${hasNote ? 'bg-white/[0.02] border border-white/[0.06]' : 'bg-white/[0.01]'}`}>
      <span className="text-gray-400 text-[10px] w-4 pt-0.5">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-white">{displayName(node.name)}</span>
          <span className="text-[10px] text-gray-400">{node.role}</span>
          {isLive && (
            <Tooltip text="Governance, timelock and active-voter values for this dependency are pulled live from on-chain reads via the listener.">
              <span className="text-[9px] uppercase tracking-wider text-emerald-400/70 cursor-help">live</span>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <span className="text-[10px] text-gray-400">Governance: {governance}</span>
          <span className="text-[10px] text-gray-400">Timelock: {timelock}</span>
          <span className="text-[10px] text-gray-400">Active: {activeVoters}</span>
        </div>
        {hasNote && (
          <p className="text-[10px] text-gray-300 mt-1">{node.note}</p>
        )}
      </div>
    </div>
  );
}

function ExposureSection({ title, icon, nodes, emptyText: _emptyText, liveByName }: { title: string; icon: string; nodes: ExposureNode[]; emptyText: string; liveByName: Record<string, typeof PROTOCOLS[0]> }) {
  if (nodes.length === 0) return null;
  const noteCount = nodes.filter(n => n.note).length;
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span>{icon}</span>
        <h4 className="text-xs font-semibold text-white">{title}</h4>
        {noteCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-gray-300 border border-white/[0.08]">{noteCount} note{noteCount > 1 ? 's' : ''}</span>}
      </div>
      <div className="space-y-1.5">
        {nodes.map((n, i) => <ExposureRow key={n.name} node={n} index={i} liveByName={liveByName} />)}
      </div>
    </div>
  );
}

function BlastRadiusView({ llama, liveProtocols }: { llama: DefiLlamaData; liveProtocols: typeof PROTOCOLS }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'overview' | 'detail'>('overview');
  const rawExposure = selected ? EXPOSURES[selected] || null : null;
  const exposure = rawExposure ? {
    ...rawExposure,
    oracles: rawExposure.oracles.map(resolveExposureNode),
    collateral: rawExposure.collateral.map(resolveExposureNode),
    routing: rawExposure.routing.map(resolveExposureNode),
    settlement: rawExposure.settlement.map(resolveExposureNode),
  } : null;
  const liveByName = useMemo(() => {
    const m: Record<string, typeof PROTOCOLS[0]> = {};
    for (const p of liveProtocols) m[p.name] = p;
    return m;
  }, [liveProtocols]);

  const totalWeakLinks = exposure
    ? [...exposure.oracles, ...exposure.collateral, ...exposure.routing, ...exposure.settlement].filter(n => n.note).length
    : 0;

  const handleSelect = (name: string) => {
    setSelected(name);
    setViewMode('detail');
  };

  const handleBack = () => {
    setSelected(null);
    setViewMode('overview');
  };

  return (
    <>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white mb-1">Blast Radius</h2>
        <p className="text-xs text-gray-500 mb-3">The Drift exploit affected 22 connected protocols with $37.1M in quantified downstream losses. Dependency mapping identifies cascade risk and whether a protocol sits within a chain.</p>
        <p className="text-xs text-gray-500">Select a protocol to view its dependency chain and governance at each layer.</p>
      </div>

      <div className={viewMode === 'overview' ? '' : 'hidden'}>
        <div className="hidden md:block mb-4">
          <p className="text-[11px] text-gray-500 mb-2 text-center">Click a protocol to explore its dependencies</p>
          <OverviewSolarSystem onSelect={handleSelect} />
        </div>
        <div className="md:hidden">
          <div className="flex flex-wrap gap-2 mb-5">
            {EXPOSURE_PROTOCOLS.map(name => (
              <button
                key={name}
                onClick={() => handleSelect(name)}
                className="px-3 py-2 text-xs rounded-lg transition-colors border text-gray-400 border-white/[0.06] hover:border-white/[0.1] hover:text-white"
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={viewMode === 'detail' ? '' : 'hidden'}>
        <button
          onClick={handleBack}
          className="mb-3 px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-white/[0.06] hover:border-white/[0.1] rounded-lg transition-colors"
        >
            ← All protocols
          </button>

          {selected && (
            <div className="mb-4">
              <SolarSystem protocolName={selected} tvlData={llama.tvl} />
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-5">
            {EXPOSURE_PROTOCOLS.map(name => (
              <button
                key={name}
                onClick={() => setSelected(name)}
                className={`px-3 py-2 text-xs rounded-lg transition-colors border ${
                  selected === name
                    ? 'bg-white/[0.08] text-white border-white/[0.15]'
                    : 'text-gray-400 border-white/[0.06] hover:border-white/[0.1] hover:text-white'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
      </div>

      <div className={viewMode === 'detail' && exposure ? '' : 'hidden'}>
        {exposure && <>
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-white">{displayName(exposure.name)}</h3>
              <div className="flex items-center gap-2">
                {selected && formatTvlDisplay(llama.tvl[selected]) && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-white/[0.05] text-gray-300 border border-white/[0.08]">
                    {formatTvlDisplay(llama.tvl[selected])} TVL
                  </span>
                )}
                {totalWeakLinks > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-white/[0.04] text-gray-300 border border-white/[0.08]">
                    {totalWeakLinks} note{totalWeakLinks > 1 ? 's' : ''} in chain
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-gray-400">{exposure.description}</p>
          </div>

          <div className="space-y-1">
            <ExposureSection title="Price Feeds (Oracles)" icon="📡" nodes={exposure.oracles} emptyText="No oracle dependencies" liveByName={liveByName} />
            {exposure.oracles.length > 0 && exposure.collateral.length > 0 && (
              <div className="text-center text-gray-400 text-[10px] py-1">↓ prices feed into ↓</div>
            )}

            <ExposureSection title="Collateral Accepted" icon="🪙" nodes={exposure.collateral} emptyText="No external collateral" liveByName={liveByName} />
            {exposure.collateral.length > 0 && exposure.routing.length > 0 && (
              <div className="text-center text-gray-400 text-[10px] py-1">↓ if liquidated, flows to ↓</div>
            )}

            <ExposureSection title="Routing" icon="🔀" nodes={exposure.routing} emptyText="" liveByName={liveByName} />
            {exposure.routing.length > 0 && exposure.settlement.length > 0 && (
              <div className="text-center text-gray-400 text-[10px] py-1">↓ settles on ↓</div>
            )}

            <ExposureSection title="Settlement (DEX Pools)" icon="💱" nodes={exposure.settlement} emptyText="" liveByName={liveByName} />
          </div>

          {totalWeakLinks > 0 && (
            <div className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
              <p className="text-xs text-gray-300 font-medium mb-1">Notes:</p>
              {[...exposure.oracles, ...exposure.collateral, ...exposure.routing, ...exposure.settlement]
                .filter(n => n.note)
                .map((n, i) => (
                  <p key={i} className="text-[11px] text-gray-400 mt-1">
                    <span className="text-gray-300 font-medium">{displayName(n.name)}:</span> {n.note}
                  </p>
                ))
              }
            </div>
          )}

          {exposure.protocolDisclosed && (
            <div className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
              <p className="text-xs text-white font-medium mb-1">Protocol disclosed</p>
              <p className="text-[11px] text-gray-400">{exposure.protocolDisclosed}</p>
            </div>
          )}

          {(() => {
            const { upstream, downstream } = getRelationships(selected!);
            if (upstream.length === 0 && downstream.length === 0) return null;
            return (
              <div className="mt-4">
                {upstream.length > 0 && (
                  <div className="mb-3">
                    <h4 className="text-xs font-semibold text-white mb-2">Protocols connected to {displayName(exposure.name)} ({upstream.length})</h4>
                    <div className="space-y-1">
                      {upstream.map((r, i) => (
                        <div key={i} className="py-1.5 px-3 bg-white/[0.01] rounded text-[11px]">
                          <div className="flex items-center gap-3">
                            <span className="text-white font-medium w-28 flex-shrink-0">{displayName(r.protocol)}</span>
                            <span className="text-gray-400 flex-1">{r.detail}</span>
                            <span className="text-gray-400 text-[10px]">{r.verified}</span>
                          </div>
                          {r.caveat && (
                            <div className="mt-1 pl-[124px] text-[10px] text-gray-400/80">On-chain: {r.caveat}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {downstream.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-white mb-2">{displayName(exposure.name)} connected to ({downstream.length})</h4>
                    <div className="space-y-1">
                      {downstream.map((r, i) => (
                        <div key={i} className="py-1.5 px-3 bg-white/[0.01] rounded text-[11px]">
                          <div className="flex items-center gap-3">
                            <span className="text-white font-medium w-28 flex-shrink-0">{displayName(r.protocol)}</span>
                            <span className="text-gray-400 flex-1">{r.detail}</span>
                            <span className="text-gray-400 text-[10px]">{r.verified}</span>
                          </div>
                          {r.caveat && (
                            <div className="mt-1 pl-[124px] text-[10px] text-gray-400/80">On-chain: {r.caveat}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {selected && (() => {
            const g = findLiveGroupForProtocol(selected);
            return g ? <IndependenceScorePanel group={g} /> : null;
          })()}

          {selected === 'Drift' && (
            <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
              <h4 className="text-xs font-semibold text-white mb-3">Case Study: April 1, 2026</h4>
              <p className="text-[11px] text-gray-500 mb-3">Drift rebranded to Velocity DEX in July 2026. This exploit is recorded under the Drift name it carried at the time.</p>

              <DriftCaseStudySolar affected={DRIFT_CASE_STUDY.affected} />

              <p className="text-[11px] text-gray-500 mt-4 mb-2">Drift's admin multisig history. The original ran for 23 months at 2/5. A second was created 7 days before the exploit at the same 2/5 threshold and was the one actually exploited. A third was created on April 2 as part of recovery.</p>

              <h5 className="text-[11px] text-white font-medium mt-3 mb-1">Original Admin Multisig (61ApQqLoW - April 2024 to March 2026)</h5>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3 text-[11px]">
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Governance</p>
                  <p className="text-gray-300">2/5 threshold (changed from 3/5 on April 29, 2024 and stable for 23 months), zero timelock</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Config changes</p>
                  <p className="text-gray-300">2 in first 22 days (1 threshold change to 2/5, configAuthority set on May 13, 2024), then stable</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Signing activity hours</p>
                  <p className="text-gray-300">Concentrated UTC 6-14 (2pm-10pm SGT)</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2 md:col-span-3">
                  <p className="text-gray-500">External configAuthority</p>
                  <p className="text-gray-300">A single key set as the multisig's configAuthority. This key can change the threshold, add or remove members, and change the timelock without any proposal or vote from the multisig. Squads documentation states a Controlled Multisig is not recommended for most use cases. Drift is the only protocol on solgov where this is set to an external key rather than autonomous.</p>
                </div>
              </div>

              <h5 className="text-[11px] text-white font-medium mt-3 mb-1">Exploited Multisig (2LW6PS - March 25 to April 1, 2026) - 7 days</h5>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3 text-[11px]">
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Governance</p>
                  <p className="text-gray-300">2/5 threshold (preserved from 61ApQqLoW which had been at 2/5 since April 2024), zero timelock</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Signer rotation</p>
                  <p className="text-gray-300">1 of 5 signers carried over from the original old-group multisigs, 4 new signers added (near-complete rotation)</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">State admin transition</p>
                  <p className="text-gray-300">Drift Protocol V2 State admin moved from 61ApQqLoW vault[0] to 2LW6PS vault[0] on March 26, 2026 at 01:46 UTC. No threshold change.</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Exploit execution time</p>
                  <p className="text-gray-300">April 1 16:05 UTC (00:05 SGT - just past midnight)</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Time from second approval to execution</p>
                  <p className="text-gray-300">1 second (bundled in the same transaction)</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Same signer proposed and executed</p>
                  <p className="text-gray-300">No - two different compromised signers (39JyWrdb proposed, 6UJbu9ut executed). 39JyWrdb was the only signer carried over from the old group. 6UJbu9ut was a new signer added in the March 25 migration.</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Durable nonces</p>
                  <p className="text-gray-300">Used in both exploit transactions, signatures pre-positioned weeks earlier</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Execute action</p>
                  <p className="text-gray-300">UpdateAdmin on Drift program (changed program admin to attacker-controlled address)</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2 md:col-span-3">
                  <p className="text-gray-500">External configAuthority (active during exploit)</p>
                  <p className="text-gray-300">The same configAuthority key was carried over to the new multisig. It could have been used to change settings on the multisig at any point during the 7 day window without going through the multisig approval process.</p>
                </div>
              </div>

              <h5 className="text-[11px] text-white font-medium mt-3 mb-1">Sister Multisig (BBC5g - controls 6 Drift programs, not drained)</h5>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3 text-[11px]">
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Governance</p>
                  <p className="text-gray-300">3/5 threshold, zero timelock</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Created</p>
                  <p className="text-gray-300">March 25 2026 17:00 UTC, 2 minutes after 2LW6PS</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Members</p>
                  <p className="text-gray-300">Identical to 2LW6PS - same five signers, all with Almighty permissions</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Programs controlled</p>
                  <p className="text-gray-300">6 verified Drift programs: Drift Vaults, drift-jit-proxy, Drift Oracle Receiver, drift-stake-voter (Realms vote plugin), drift-competitions (insurance fund prize draws), and merkle-distributor (airdrop). Drift Protocol V2 was the 7th but moved to E44y4Gm on April 2 at 01:39 UTC during recovery.</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">configAuthority</p>
                  <p className="text-gray-300">Same A1eC8n2t key as 2LW6PS</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Authority transfer date</p>
                  <p className="text-gray-300">Took control of 7 Drift programs from Er82vnft on March 29 2026 in two batches (17:07 and 17:17 UTC)</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Approve + Execute</p>
                  <p className="text-gray-300">Available - same as 2LW6PS</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Outcome on April 1</p>
                  <p className="text-gray-300">Not drained. Two compromised signer keys met 2/5 on the exploited multisig but not 3/5 on this one</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2 md:col-span-3">
                  <p className="text-gray-500">Why this matters</p>
                  <p className="text-gray-300">Same five members, same configAuthority, same zero timelock, same Approve+Execute setting. The only differing variable in the multisig flow was threshold. If the configAuthority key had also been compromised, threshold would not have mattered - the attacker could have lowered any threshold to 1, added their own member, and taken over anything those multisigs control. BBC5g controls 6 Drift programs and E44y4Gm controls Drift Protocol V2. A single key compromise on A1eC8n2t maps to taking over the whole Drift program suite.</p>
                </div>
              </div>

              {(() => {
                const g = findCaseStudyGroup('Drift');
                return g ? <IndependenceScorePanel group={g} /> : null;
              })()}

              <h5 className="text-[11px] text-white font-medium mt-4 mb-1">Downstream Impact - 22 protocols affected, $37.1M in quantified downstream losses</h5>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-gray-500 border-b border-white/[0.06]">
                      <th className="text-left py-1.5 pr-3 font-medium">Protocol</th>
                      <th className="text-right py-1.5 px-3 font-medium">Loss</th>
                      <th className="text-center py-1.5 px-3 font-medium">Depth</th>
                      <th className="text-left py-1.5 pl-3 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DRIFT_CASE_STUDY.affected.map((p, i) => (
                      <tr key={i} className="border-t border-white/[0.03]">
                        <td className="py-1.5 pr-3 text-gray-300">{displayName(p.name)}</td>
                        <td className="py-1.5 px-3 text-right text-gray-300">{p.loss}</td>
                        <td className="py-1.5 px-3 text-center text-gray-400">{p.chainDepth}</td>
                        <td className="py-1.5 pl-3 text-gray-500">{p.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h5 className="text-[11px] text-white font-medium mt-3 mb-1">Recovery Multisig (E44y4 - April 2 to present)</h5>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3 text-[11px]">
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Governance</p>
                  <p className="text-gray-300">3/5 threshold, zero timelock</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Changes from exploited</p>
                  <p className="text-gray-300">2 signers removed, 2 new signers added, threshold raised</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Config changes since recovery</p>
                  <p className="text-gray-300">0</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2">
                  <p className="text-gray-500">Recovery transfers</p>
                  <p className="text-gray-300">13 transfers across 55 multisig transactions, around $16.07M USDC moved as part of recovery</p>
                </div>
                <div className="bg-white/[0.03] rounded p-2 md:col-span-2">
                  <p className="text-gray-500">External configAuthority (still active)</p>
                  <p className="text-gray-300">The same configAuthority key is still set on the recovery multisig. It can still change the threshold, members, or timelock on this multisig without going through the multisig approval process.</p>
                </div>
              </div>

            </div>
          )}

      <div className="mt-6 pt-5 border-t border-white/[0.04] text-[11px] text-gray-500">
        <p>Routing and settlement data verified on-chain where possible. Oracle dependencies sourced from protocol documentation (oracle price accounts are read via account references and cannot be verified through transaction analysis). Governance data from solgov on-chain audits. Data covers the {PROTOCOLS.length} protocols tracked on solgov.</p>
      </div>
        </>}
      </div>
    </>
  );
}

export default App;
