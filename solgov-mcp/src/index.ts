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

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`solgov API ${res.status} for ${path}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const family = (n: string) => n.replace(/\s*\(.*\)\s*$/, '').trim();

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
  'Queued Squads proposals that would upgrade a program, move a program\'s upgrade authority, or change a multisig\'s config, and have not executed yet. Includes approval count against threshold and the timelock that must elapse. This is visible before the change lands on-chain.',
  { protocol: z.string().optional().describe('Filter to one protocol family') },
  async ({ protocol }) => {
    const st = await api('/api/v1/state');
    const all: any[] = st?._pendingUpgrades?.results || [];
    // Keep proposals that can still execute: open or config proposals that went stale cannot, an
    // already-approved vault transaction still can.
    let live = all.filter(r => !(r.stale === true && (r.status === 'Active' || r.kind === 'ConfigChange')));
    if (protocol) { const w = family(protocol).toLowerCase(); live = live.filter(r => family(r.protocol).toLowerCase() === w || String(r.protocol).toLowerCase() === protocol.toLowerCase()); }
    return text({ scannedAt: st?._pendingUpgrades?.scannedAt ?? null, count: live.length, results: live });
  },
);

server.tool(
  'solgov_signer_independence',
  'For teams running two or more multisigs: how distinct the signer sets are. 100% means no signer sits on more than one of the team\'s multisigs; 0% means they share one signer set. Includes pairwise shared-signer counts. Computed from live on-chain member lists.',
  { team: z.string().optional().describe('Filter to one team, e.g. "Kamino" or "Jupiter"') },
  async ({ team }) => {
    const st = await api('/api/v1/state');
    let groups: any[] = st?._independence?.groups || [];
    if (team) groups = groups.filter(g => String(g.team).toLowerCase().startsWith(team.toLowerCase()));
    return text({ computedAt: st?._independence?.computedAt ?? null, groups });
  },
);

server.tool(
  'solgov_verified_builds',
  'Verified-build status per program from the otter-verify registry, counted only when the record is signed by the program\'s current upgrade authority (or a Solana Explorer trusted signer) and the deployed hash still matches. Distinguishes "verified", "verified once but upgraded since" (matchesDeployed false) and "not verified".',
  { protocol: z.string().optional() },
  async ({ protocol }) => {
    const st = await api('/api/v1/state');
    const vb = st?._verifiedBuilds;
    if (!vb) return text({ available: false });
    let programs: any[] = vb.programs || [];
    if (protocol) { const w = family(protocol).toLowerCase(); programs = programs.filter(p => family(String(p.protocol)).toLowerCase() === w); }
    return text({ scannedAt: vb.scannedAt, notes: vb.notes, programs, rollup: protocol ? vb.protocols?.[protocol] ?? null : vb.protocols });
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
