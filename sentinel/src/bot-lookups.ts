// Read-only lookups for the Telegram bot, built on the snapshots the scanners already write. Each
// function returns Telegram HTML; every dynamic string is escaped. Kept out of solgov-bot.ts so the
// formatting can be unit-tested without a bot token.

import * as fs from 'fs';
import * as path from 'path';
import { readJsonLoose } from './utils/json-file';
import { escapeHtml } from './utils/telegram-html';
import { alertName } from './utils/display-names';
import { resolveName, nameMatches } from './llm-tools';
import { readActivityLog } from './activity-log';
import { eventLabel } from './utils/event-labels';

export const DATA_DIR = path.join(__dirname, '..', 'data');

const short = (a: unknown) => { const s = String(a || ''); return s.length > 12 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s; };

function ageHours(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 3600000);
}

function scannedLine(iso: string | undefined | null): string {
  const h = ageHours(iso);
  return h === null ? 'Scan time unknown' : `Scanned ${h}h ago`;
}

function timelockLabel(sec: number | undefined): string {
  if (!sec) return 'no timelock';
  if (sec < 3600) return `${Math.round(sec / 60)}min timelock`;
  if (sec < 172800) return `${Math.round(sec / 360) / 10}h timelock`;
  return `${Math.round(sec / 8640) / 10}d timelock`;
}

// Short timelock label for bot replies: None, N/A, 10min, 1h, 1h 30min.
export function timelockShort(sec: number): string {
  if (sec === -1) return 'N/A';
  if (!Number.isFinite(sec) || sec <= 0) return 'None';
  if (sec < 3600) return `${Math.round(sec / 60)}min`;
  const m = Math.round(sec / 60);
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m / 60}h`;
}

// Number of proposals for one tracked multisig that can still execute, per the pending-upgrades scan
// (Squads rules plus every buffer, target account and authority checked). null when no scan exists.
export function executableProposalCount(stateKey: string, dataDir = DATA_DIR): number | null {
  const snap = readJsonLoose<any>(path.join(dataDir, 'pending-upgrades.json'), null);
  if (!snap || !Array.isArray(snap.results)) return null;
  const alias: Record<string, string> = { 'Pumpfun': 'Pumpfun + PumpSwap', 'Huma': 'Huma Finance' };
  const names = new Set([stateKey, alias[stateKey]].filter(Boolean));
  return snap.results.filter((r: any) => names.has(r.protocol) && r.executable === true).length;
}

// Queued Squads proposals that touch program upgrades, upgrade authority or multisig config.
export function pendingText(query: string, dataDir = DATA_DIR): string {
  const snap = readJsonLoose<any>(path.join(dataDir, 'pending-upgrades.json'), null);
  if (!snap || !Array.isArray(snap.results)) return 'Queued proposal data is not available yet.';
  const names = Array.from(new Set<string>(snap.results.map((r: any) => r.protocol).filter(Boolean)));
  const protocol = resolveName(names, query);
  if (!protocol) return `No queued upgrade or config proposals found for <b>${escapeHtml(query)}</b>.\n${escapeHtml(scannedLine(snap.scannedAt))}.`;
  const rows = snap.results.filter((r: any) => r.protocol === protocol);
  const lines = [`<b>Open proposals: ${escapeHtml(alertName(protocol))}</b>`, ''];
  const kindText: Record<string, string> = {
    ProgramUpgrade: 'Program code update',
    SetUpgradeAuthority: 'Change of who can upgrade a program',
    ProgramClose: 'Program closure',
    ProgramExtend: 'Program size increase',
    ConfigChange: 'Multisig settings change',
    OtherVaultTx: 'Other transaction',
  };
  for (const r of rows.slice(0, 15)) {
    // executable is written by the scanner from Squads rules; older snapshots only carry stale.
    const exec = typeof r.executable === 'boolean' ? r.executable : !r.stale;
    const state = exec ? (r.status === 'Approved' ? 'approved, can still go through' : 'collecting approvals') : 'can no longer go through';
    lines.push(`• #${escapeHtml(r.proposalIndex)} ${escapeHtml(kindText[r.kind] ?? r.kind)}: ${escapeHtml(r.approvals)} of ${escapeHtml(r.threshold)} approvals, ${escapeHtml(timelockLabel(r.timelockSeconds))}, ${state}`);
    if (r.programId) lines.push(`  Program <code>${escapeHtml(short(r.programId))}</code>`);
  }
  if (rows.length > 15) lines.push(`<i>...and ${rows.length - 15} more</i>`);
  if (snap.complete === false) lines.push('', '<i>Partial scan: some multisigs could not be read this run.</i>');
  lines.push('', escapeHtml(scannedLine(snap.scannedAt)));
  return lines.join('\n');
}

// Verified-build status per program: whether the deployed program matches a published build.
export function verifiedText(query: string, dataDir = DATA_DIR): string {
  const snap = readJsonLoose<any>(path.join(dataDir, 'verified-builds.json'), null);
  if (!snap || !Array.isArray(snap.programs)) return 'Verified-build data is not available yet.';
  const names = Array.from(new Set<string>(snap.programs.map((p: any) => p.protocol).filter(Boolean)));
  const protocol = resolveName(names, query);
  if (!protocol) return `No verified-build data for <b>${escapeHtml(query)}</b>.`;
  const progs = snap.programs.filter((p: any) => p.protocol === protocol);
  const lines = [`<b>Verified builds: ${escapeHtml(alertName(protocol))}</b>`, ''];
  for (const p of progs) {
    const status = p.verified === true ? 'verified' : p.verified === null ? 'could not be checked' : 'not verified';
    const repo = p.verified === true && p.repo ? ` (${escapeHtml(String(p.repo).replace(/^https:\/\/github\.com\//, '').slice(0, 60))})` : '';
    lines.push(`• ${escapeHtml(p.name || short(p.programId))}: ${status}${repo}`);
  }
  lines.push('', escapeHtml(scannedLine(snap.scannedAt)), 'Source: the on-chain verification record and verify.osec.io');
  return lines.join('\n');
}

// Governance changes across every tracked protocol in a window, newest first.
const CHANGE_TYPES = /^(Threshold|Signers|SignerRotation|Timelock|ExternalAdminKey|VotersChanged|ConfigChange|AuthorityChange|ProgramUpgrade|GovernanceConfigProposal|RealmAuthority|NONCE)/;

export function recentText(window: '24h' | '7d'): string {
  const cutoff = Date.now() - (window === '24h' ? 86400000 : 7 * 86400000);
  const events = readActivityLog()
    .filter(e => e && CHANGE_TYPES.test(String(e.type)) && Date.parse(e.timestamp || e.date) >= cutoff)
    .sort((a, b) => String(b.timestamp || b.date).localeCompare(String(a.timestamp || a.date)));
  if (events.length === 0) return `No governance changes recorded in the last ${window}.`;
  const lines = [`<b>Governance changes, last ${window}</b>`, ''];
  for (const e of events.slice(0, 25)) {
    const when = String(e.timestamp || e.date).replace('T', ' ').slice(0, 16);
    const detail = e.detail ? `: ${escapeHtml(String(e.detail).slice(0, 140))}` : '';
    lines.push(`• ${escapeHtml(when)} <b>${escapeHtml(alertName(e.protocol))}</b> ${escapeHtml(eventLabel(String(e.type)))}${detail}`);
  }
  if (events.length > 25) lines.push(`<i>...and ${events.length - 25} more</i>`);
  return lines.join('\n');
}

// Freshness of each data file the bot and API serve, against the cadence its producer runs on.
const SURFACES: { name: string; file: string; stamp: (j: any) => string | null; maxHours: number }[] = [
  { name: 'Monitor state', file: 'monitor-state.json', maxHours: 3, stamp: j => {
    let best: string | null = null;
    for (const [k, v] of Object.entries(j || {})) if (!k.startsWith('_') && (v as any)?.lastChecked && (!best || (v as any).lastChecked > best)) best = (v as any).lastChecked;
    return best;
  } },
  { name: 'Pending upgrades', file: 'pending-upgrades.json', maxHours: 36, stamp: j => j?.scannedAt ?? null },
  { name: 'Verified builds', file: 'verified-builds.json', maxHours: 24 * 9, stamp: j => j?.scannedAt ?? null },
  { name: 'Independence', file: 'independence-scores.json', maxHours: 36, stamp: j => j?.computedAt ?? null },
  { name: 'Token transparency', file: 'token-transparency.json', maxHours: 24 * 9, stamp: j => j?.scannedAt ?? null },
  { name: 'Admin path', file: 'admin-path.json', maxHours: 24 * 9, stamp: j => j?.scannedAt ?? null },
  { name: 'Integrity', file: 'monitor-state.json', maxHours: 36, stamp: j => j?._integrity?.scannedAt ?? null },
];

export function healthText(dataDir = DATA_DIR): string {
  const lines = ['<b>Data freshness</b>', ''];
  let stale = 0;
  for (const s of SURFACES) {
    const file = path.join(dataDir, s.file);
    const j = fs.existsSync(file) ? readJsonLoose<any>(file, null) : null;
    const stamp = j ? s.stamp(j) : null;
    const h = ageHours(stamp);
    const ok = h !== null && h <= s.maxHours;
    if (!ok) stale++;
    lines.push(`${ok ? '✅' : '⚠️'} ${escapeHtml(s.name)}: ${h === null ? 'missing' : `${h}h old`} (expected within ${s.maxHours}h)`);
  }
  lines.push('', stale === 0 ? 'All surfaces fresh.' : `${stale} surface(s) stale or missing.`);
  return lines.join('\n');
}

// For /check: a one-line pointer to the other lookups when data exists for the protocol.
export function relatedHint(protocol: string, dataDir = DATA_DIR): string {
  const pend = readJsonLoose<any>(path.join(dataDir, 'pending-upgrades.json'), null);
  const n = Array.isArray(pend?.results) ? pend.results.filter((r: any) => nameMatches(r.protocol || '', protocol) && (typeof r.executable === 'boolean' ? r.executable : !r.stale)).length : 0;
  return n > 0 ? `\n${n} queued proposal(s): /pending ${escapeHtml(protocol)}` : '';
}
