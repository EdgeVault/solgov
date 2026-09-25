#!/usr/bin/env node
// solgov MCP server. Read-only tools over the public solgov.xyz API so an AI agent can ask, before it
// deposits into or interacts with a Solana protocol, who can upgrade the program, what the multisig
// looks like, whether there is a timelock, and what has changed recently. Every tool returns the
// API's facts as-is; nothing here scores, ranks or advises.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.SOLGOV_API_BASE || 'https://solgov.xyz').replace(/\/$/, '');
const UA = 'solgov-mcp/0.1.0 (+https://solgov.xyz)';
const TIMEOUT_MS = 15_000;

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`solgov API ${res.status} for ${path}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const family = (n: string) => n.replace(/\s*\(.*\)\s*$/, '').trim();
// Same match rule for every protocol filter: exact name (case-insensitive) or same family, so
// "Kamino" matches "Kamino (Farms)" and "kamino lend" matches only itself.
const sameProtocol = (candidate: string, wanted: string) =>
  String(candidate).toLowerCase() === wanted.toLowerCase() || family(String(candidate)).toLowerCase() === family(wanted).toLowerCase();
// Snapshot age, so a caller can tell a fresh reading from a stale one without a second call.
function freshness(stamp: unknown): { scannedAt: string | null; stalenessHours: number | null } {
  const iso = typeof stamp === 'string' ? stamp : null;
  const t = iso ? Date.parse(iso) : NaN;
  return { scannedAt: iso, stalenessHours: Number.isFinite(t) ? Math.round((Date.now() - t) / 360_000) / 10 : null };
}

const server = new McpServer({ name: 'solgov', version: '0.1.0' });

server.tool(
  'solgov_list_protocols',
  'List every Solana protocol solgov tracks, with its current multisig threshold, signer count, timelock, config authority and governance model. Start here to find the exact protocol name to pass to other tools.',
  {},
  async () => text(await api('/api/v1/protocols')),
);

server.tool(
  'solgov_get_governance',
  'Current on-chain governance state for one protocol: multisig threshold and signers, timelock, config authority, program upgrade authorities, pending proposals, threat alerts, and how fresh the read is (lastChecked, stalenessHours). Name matching is case-insensitive and tolerant of suffixes.',
  { protocol: z.string().describe('Protocol name as listed by solgov_list_protocols, e.g. "Kamino" or "Jupiter Perps"') },
  async ({ protocol }) => text(await api(`/api/v1/governance/${encodeURIComponent(protocol)}`)),
);

server.tool(
  'solgov_recent_events',
  'Recent governance events across all tracked protocols (config changes, signer changes, timelock changes, program upgrades, proposals), newest first. Optionally filter by protocol and event type.',
  {
    protocol: z.string().optional().describe('Filter to one protocol'),
    type: z.string().optional().describe('Filter by event type, e.g. ConfigChange, ProgramUpgrade, SignersAdded, ThresholdLowered'),
    limit: z.number().int().min(1).max(500).optional().describe('Max events, default 50'),
  },
  async ({ protocol, type, limit }) => {
    const q = new URLSearchParams();
    if (protocol) q.set('protocol', protocol);
    if (type) q.set('type', type);
    q.set('limit', String(limit ?? 50));
    return text(await api(`/api/v1/alerts/recent?${q.toString()}`));
  },
);

server.tool(
  'solgov_changelog',
  'Permanent change history for one protocol, newest first: every recorded config change, signer change, timelock change, program upgrade and proposal. Each event is citable by timestamp, type and detail.',
  { protocol: z.string(), limit: z.number().int().min(1).max(500).optional() },
  async ({ protocol, limit }) => text(await api(`/api/v1/changelog/${encodeURIComponent(protocol)}?limit=${limit ?? 100}`)),
);

server.tool(
  'solgov_pending_upgrades',
  'Queued Squads proposals that would upgrade, close or extend a program, move a program\'s upgrade authority, or change a multisig\'s config, and have not executed yet. Includes approval count against threshold and the timelock that must elapse. This is visible before the change lands on-chain. Returns available:false when the scan output is missing; scannedAt, stalenessHours and complete say how fresh and whole the scan is.',
  { protocol: z.string().optional().describe('Filter to one protocol family') },
  async ({ protocol }) => {
    const st = await api('/api/v1/state');
    const pu = st?._pendingUpgrades;
    if (!pu || !Array.isArray(pu.results)) return text({ available: false, reason: 'pending-upgrades scan output is not present in the API state' });
    const all: any[] = pu.results;
    // Keep proposals that can still execute. Newer scans carry `executable`; for older ones apply the
    // same rule: open or config proposals that went stale cannot, an approved vault transaction can.
    let live = all.filter(r => typeof r.executable === 'boolean' ? r.executable : !(r.stale === true && (r.status === 'Active' || r.kind === 'ConfigChange')));
    if (protocol) live = live.filter(r => sameProtocol(r.protocol, protocol));
    return text({ available: true, ...freshness(pu.scannedAt), complete: pu.complete ?? null, count: live.length, results: live });
  },
);

server.tool(
  'solgov_signer_independence',
  'For teams running two or more multisigs: how distinct the signer sets are. 100% means no signer sits on more than one of the team\'s multisigs; 0% means they share one signer set. Includes pairwise shared-signer counts. Computed from live on-chain member lists. Returns available:false when the computation output is missing, and stalenessHours otherwise.',
  { team: z.string().optional().describe('Filter to one team, e.g. "Kamino" or "Jupiter"') },
  async ({ team }) => {
    const st = await api('/api/v1/state');
    const ind = st?._independence;
    if (!ind || !Array.isArray(ind.groups)) return text({ available: false, reason: 'signer-independence output is not present in the API state' });
    let groups: any[] = ind.groups;
    if (team) groups = groups.filter(g => String(g.team).toLowerCase().startsWith(team.toLowerCase()));
    const f = freshness(ind.computedAt);
    return text({ available: true, computedAt: f.scannedAt, stalenessHours: f.stalenessHours, groups });
  },
);

server.tool(
  'solgov_verified_builds',
  'Verified-build status per program from the OtterSec verify registry. verified is true only when a registry entry marked verified is signed by the program\'s current upgrade authority (or a Solana Explorer trusted signer) and its recorded on_chain_hash equals a fresh hash of the deployed bytes; false when the check ran and nothing qualified; null when the check could not run (checkError says why). matchesDeployed is the registry\'s own comparison for the recorded entry (on_chain_hash === executable_hash); it is not a fresh comparison with the bytes deployed now. Returns available:false when the scan output is missing; scannedAt, stalenessHours and complete say how fresh and whole the scan is.',
  { protocol: z.string().optional() },
  async ({ protocol }) => {
    const st = await api('/api/v1/state');
    const vb = st?._verifiedBuilds;
    if (!vb || !Array.isArray(vb.programs)) return text({ available: false, reason: 'verified-builds scan output is not present in the API state' });
    let programs: any[] = vb.programs;
    let rollup: Record<string, any> | null = vb.protocols ?? null;
    if (protocol) {
      programs = programs.filter(p => sameProtocol(p.protocol, protocol));
      // Same matching as the programs filter, so a family query returns every matching rollup row.
      const rows = Object.entries(vb.protocols || {}).filter(([name]) => sameProtocol(name, protocol));
      rollup = rows.length ? Object.fromEntries(rows) : null;
    }
    return text({ available: true, ...freshness(vb.scannedAt), complete: vb.complete ?? null, notes: vb.notes, programs, rollup });
  },
);

server.tool(
  'solgov_upgrade_cadence',
  'Program upgrade cadence per protocol: upgrades observed, first and last, count in the last 30 days, mean interval in days. Derived from deploy-slot-confirmed upgrade events.',
  {},
  async () => text(await api('/api/v1/cadence')),
);

server.tool(
  'solgov_health',
  'Freshness of every solgov data surface with its age in hours and whether it is stale against its expected refresh cadence. Check this before relying on a number.',
  {},
  async () => text(await api('/api/v1/health')),
);

server.tool(
  'solgov_stride_mapping',
  'How solgov\'s fields map to the STRIDE Governance controls (G1 to G5) defined by Asymmetric Research for the Solana Foundation. Vocabulary alignment only; solgov assigns no maturity level or score.',
  {},
  async () => text(await api('/api/v1/stride')),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('solgov-mcp failed to start:', err);
  process.exit(1);
});
