// Tool definitions the LLM can call to query sentinel/data/ at triage time.

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '..', 'data');
const DASHBOARD_DATA_DIR = process.env.SOLGOV_DASHBOARD_DATA
  || path.join(__dirname, '..', '..', 'public-dashboard', 'src', 'data');

function readJson(p: string): any {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; } catch { return null; }
}

/**
 * Normalise protocol names for matching: lowercase, strip all non-alphanumeric.
 * So "BisonFi (AMM)" and "BisonFi AMM" and "bisonfi-amm" all collapse to
 * "bisonfiamm". Fixes the bug where listener fires alerts with parenthesised
 * program labels but stored data uses plain labels.
 */
export function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function nameMatches(key: string, query: string): boolean {
  const nKey = normaliseName(key);
  const nQuery = normaliseName(query);
  if (!nQuery) return false;
  return nKey.includes(nQuery) || nQuery.includes(nKey);
}

// ---------------- Tool implementations ----------------

function tool_search_forensics(args: { protocol: string }): any {
  // Two-step lookup: try the exact normalised filename first, then fall back
  // to scanning the forensics directory and matching any filename stem whose
  // normalised form overlaps. This handles cases like "BisonFi (AMM)" ->
  // bisonfi.json (where the tracked program name is richer than the forensics
  // file stem) and "Drift (Protocol V2)" -> drift.json.
  const normalised = normaliseName(args.protocol);
  const direct = path.join(DATA_DIR, 'forensics', `${normalised}.json`);
  let data = readJson(direct);
  if (data) return { found: true, protocol: args.protocol, profile: data };
  try {
    const dir = path.join(DATA_DIR, 'forensics');
    if (!fs.existsSync(dir)) return { found: false, protocol: args.protocol };
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const hit = files.find(f => nameMatches(f.replace(/\.json$/, ''), args.protocol));
    if (hit) {
      data = readJson(path.join(dir, hit));
      if (data) return { found: true, protocol: args.protocol, matchedFile: hit, profile: data };
    }
  } catch {}
  return { found: false, protocol: args.protocol };
}

function tool_get_upgrade_history(args: { protocol: string }): any {
  const upgrades = readJson(path.join(DATA_DIR, 'programs', 'program-upgrades.json'));
  if (!upgrades) return { found: false };
  const entry = Object.entries(upgrades).find(([k]) => nameMatches(k, args.protocol));
  if (!entry) return { found: false, protocol: args.protocol };
  const hist = (entry[1] as any)?.upgrades || [];
  // Return most recent 30 with count summary
  return {
    found: true,
    protocol: entry[0],
    total: hist.length,
    recent: hist.slice(0, 30),
    firstSeen: hist[hist.length - 1]?.date,
    lastSeen: hist[0]?.date,
  };
}

function tool_count_prior_events(args: { protocol: string; eventType?: string; windowDays?: number }): any {
  const activityFile = path.join(DASHBOARD_DATA_DIR, 'activity-feed.json');
  const feed = readJson(activityFile);
  if (!feed) return { found: false, count: 0 };
  const cutoff = args.windowDays
    ? new Date(Date.now() - args.windowDays * 86400 * 1000).toISOString().slice(0, 10)
    : '2000-01-01';
  const matches = feed.filter((e: any) =>
    e.protocol && nameMatches(e.protocol, args.protocol) &&
    e.date >= cutoff &&
    (!args.eventType || e.type?.toLowerCase().includes(args.eventType.toLowerCase()))
  );
  return {
    found: true,
    protocol: args.protocol,
    eventType: args.eventType || 'any',
    windowDays: args.windowDays || 'all-time',
    count: matches.length,
    sample: matches.slice(0, 10),
  };
}

function tool_get_monitor_state(args: { protocol: string }): any {
  const state = readJson(path.join(DATA_DIR, 'monitor-state.json'));
  if (!state) return { found: false };
  // Skip internal keys prefixed with "_" (e.g. _activityLog)
  const match = Object.keys(state).find(k => !k.startsWith('_') && nameMatches(k, args.protocol));
  if (!match) return { found: false, protocol: args.protocol };
  const p = state[match];
  // monitor-state members are plain base58 strings, not objects
  const memberKeys = (p.members || []).map((m: any) => typeof m === 'string' ? m : m.key || m.publicKey || '');
  return {
    found: true,
    protocol: match,
    threshold: p.threshold,
    totalMembers: memberKeys.length,
    timeLock: p.timeLock,
    threatAlerts: p.threatAlerts?.length || 0,
    lastChecked: p.lastChecked,
    programAuthorities: p.programAuthorities || {},
    members: memberKeys.slice(0, 20).map((k: string) => k.slice(0, 8) + '...' + k.slice(-4)),
  };
}

function tool_search_activity_feed(args: { protocol?: string; eventType?: string; windowDays: number; limit?: number }): any {
  const activityFile = path.join(DASHBOARD_DATA_DIR, 'activity-feed.json');
  const feed = readJson(activityFile);
  if (!feed) return { found: false, events: [] };
  const cutoff = new Date(Date.now() - args.windowDays * 86400 * 1000).toISOString().slice(0, 10);
  const filtered = feed.filter((e: any) =>
    e.date >= cutoff &&
    (!args.protocol || (e.protocol && nameMatches(e.protocol, args.protocol))) &&
    (!args.eventType || e.type?.toLowerCase().includes(args.eventType.toLowerCase()))
  );
  return {
    found: true,
    windowDays: args.windowDays,
    count: filtered.length,
    events: filtered.slice(0, args.limit || 20),
  };
}

function tool_list_signers_sharing_authority(args: { authorityAddress: string }): any {
  // Walk state + upgrade auth data for addresses that match
  const state = readJson(path.join(DATA_DIR, 'monitor-state.json'));
  const matches: Array<{ protocol: string; role: string }> = [];
  if (state) {
    for (const [proto, p] of Object.entries(state as Record<string, any>)) {
      if (p.members) {
        for (const m of p.members) {
          if (m.key === args.authorityAddress) matches.push({ protocol: proto, role: `${m.role} signer` });
        }
      }
      if (p.programAuthorities) {
        for (const [prog, auth] of Object.entries(p.programAuthorities)) {
          if (auth === args.authorityAddress) matches.push({ protocol: proto, role: `upgrade authority for ${prog}` });
        }
      }
    }
  }
  return { authorityAddress: args.authorityAddress, matchCount: matches.length, matches };
}

function tool_get_hack_history(args: { protocol: string }): any {
  const solHacks = readJson(path.join(DASHBOARD_DATA_DIR, 'solana-hacks.json'));
  const evmHacks = readJson(path.join(DASHBOARD_DATA_DIR, 'evm-hacks.json'));
  const otherHacks = readJson(path.join(DASHBOARD_DATA_DIR, 'other-chain-hacks.json'));
  const all = [
    ...(solHacks?.hacks || []),
    ...(evmHacks?.hacks || []).filter((h: any) => h.category !== 'excluded'),
    ...(otherHacks?.hacks || []),
  ];
  const direct = all.filter((h: any) => h.protocol && nameMatches(h.protocol, args.protocol));
  const cascade = all.filter((h: any) =>
    h.affectedProtocols?.some((ap: string) => nameMatches(ap, args.protocol))
  );
  return {
    protocol: args.protocol,
    directHacks: direct.length,
    cascadeExposure: cascade.length,
    directIncidents: direct.slice(0, 5),
    cascadeIncidents: cascade.slice(0, 5).map((h: any) => ({ upstream: h.protocol, date: h.date, amount: h.amountUsd })),
  };
}

// ---------------- Live RPC tools (investigate current chain state) ----------------

async function rpcCall(method: string, params: any[]): Promise<any> {
  const url = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;
  if (!url.includes('api-key=') || url.endsWith('api-key=')) {
    // Fall back to public endpoint (slow, rate-limited, but works for read-only)
  }
  try {
    const res = await fetch(url.includes('api-key=') && !url.endsWith('api-key=') ? url : 'https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const data = await res.json() as any;
    return data.result ?? { error: data.error?.message || 'no result' };
  } catch (e: any) {
    return { error: e.message?.slice(0, 100) };
  }
}

async function tool_get_account_info(args: { address: string }): Promise<any> {
  const result = await rpcCall('getAccountInfo', [args.address, { encoding: 'base64' }]);
  if (!result || result.error) return { found: false, ...result };
  const value = result.value;
  if (!value) return { found: false, address: args.address };
  return {
    found: true,
    address: args.address,
    owner: value.owner,
    lamports: value.lamports,
    executable: value.executable,
    dataLen: value.data?.[0] ? Buffer.from(value.data[0], 'base64').length : 0,
  };
}

async function tool_get_recent_signatures(args: { address: string; limit?: number }): Promise<any> {
  const limit = Math.min(args.limit || 20, 50);
  const result = await rpcCall('getSignaturesForAddress', [args.address, { limit }]);
  if (!Array.isArray(result)) return { found: false, ...result };
  const now = Math.floor(Date.now() / 1000);
  return {
    found: true,
    address: args.address,
    count: result.length,
    oldestBlockTime: result[result.length - 1]?.blockTime,
    newestBlockTime: result[0]?.blockTime,
    ageDays: result[result.length - 1]?.blockTime ? Math.floor((now - result[result.length - 1].blockTime) / 86400) : null,
    signatures: result.slice(0, Math.min(limit, 10)).map((s: any) => ({
      sig: s.signature?.slice(0, 20) + '...',
      blockTime: s.blockTime,
      err: s.err ? 'failed' : 'ok',
    })),
  };
}

async function tool_check_nonce_activity(args: { address: string }): Promise<any> {
  const sigsResult = await rpcCall('getSignaturesForAddress', [args.address, { limit: 20 }]);
  if (!Array.isArray(sigsResult)) return { found: false, hasNonceActivity: false };
  const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 86400;
  const recent = sigsResult.filter((s: any) => s.blockTime && s.blockTime > twoWeeksAgo).slice(0, 5);
  for (const sig of recent) {
    const tx = await rpcCall('getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const logs = tx?.meta?.logMessages || [];
    if (logs.some((l: string) =>
      l.includes('InitializeNonceAccount') ||
      l.includes('AdvanceNonceAccount') ||
      l.includes('AuthorizeNonceAccount') ||
      l.includes('WithdrawNonceAccount')
    )) {
      return {
        hasNonceActivity: true,
        address: args.address,
        foundInTx: sig.signature.slice(0, 20) + '...',
        blockTime: sig.blockTime,
        note: 'Durable nonce activity detected - same vector as Drift exploit. Investigate.',
      };
    }
  }
  return { hasNonceActivity: false, address: args.address, txnsChecked: recent.length };
}

async function tool_get_program_upgrade_authority(args: { programId: string }): Promise<any> {
  const result = await rpcCall('getAccountInfo', [args.programId, { encoding: 'base64' }]);
  if (!result?.value?.data?.[0]) return { found: false, programId: args.programId };
  const data = Buffer.from(result.value.data[0], 'base64');
  if (data.length < 36) return { found: false, programId: args.programId, note: 'not a BPF program' };
  // Programs have a pointer to ProgramData at bytes 4-36
  try {
    const pdKey = data.slice(4, 36);
    const bs58Mod = await import('bs58');
    const bs58 = (bs58Mod as any).default || bs58Mod;
    const pdAddr = bs58.encode(pdKey);
    const pdResult = await rpcCall('getAccountInfo', [pdAddr, { encoding: 'base64' }]);
    if (!pdResult?.value?.data?.[0]) return { found: false, programId: args.programId };
    const pdData = Buffer.from(pdResult.value.data[0], 'base64');
    if (pdData[12] === 1) {
      const authKey = pdData.slice(13, 45);
      return {
        found: true,
        programId: args.programId,
        upgradeAuthority: bs58.encode(authKey),
        immutable: false,
      };
    }
    return { found: true, programId: args.programId, upgradeAuthority: 'IMMUTABLE', immutable: true };
  } catch (e: any) {
    return { found: false, error: e.message };
  }
}

function tool_list_protocols(): any {
  // Prefer monitor-state.json (authoritative, always on VPS). Fall back to
  // parsing public-dashboard/protocols.ts when that source isn't present.
  const state = readJson(path.join(DATA_DIR, 'monitor-state.json'));
  if (state) {
    const names = Object.keys(state).filter(k => !k.startsWith('_'));
    if (names.length > 0) return { count: names.length, protocols: names, source: 'monitor-state.json' };
  }
  try {
    const src = fs.readFileSync(path.join(DASHBOARD_DATA_DIR, 'protocols.ts'), 'utf-8');
    const names = Array.from(src.matchAll(/name:\s*'([^']+)'/g)).map(m => m[1]);
    return { count: names.length, protocols: names, source: 'protocols.ts' };
  } catch {
    return { count: 0, protocols: [] };
  }
}

// ---------------- Schema for LLM ----------------

export const TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'search_forensics',
      description: 'Retrieve the curated forensics profile for a protocol: known multisigs, authorities, governance model, known gaps.',
      parameters: {
        type: 'object',
        properties: { protocol: { type: 'string', description: 'Protocol name, e.g. "BisonFi" or "Drift"' } },
        required: ['protocol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_upgrade_history',
      description: 'Recent program upgrades for a protocol. Returns up to 30 most recent entries, total count, first/last seen dates. Use to establish cadence (e.g. "this is the 47th upgrade this year").',
      parameters: {
        type: 'object',
        properties: { protocol: { type: 'string' } },
        required: ['protocol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_prior_events',
      description: 'Count prior events of a given type for a protocol, optionally within a window. Answers questions like "how many authority changes has X had in 90 days?"',
      parameters: {
        type: 'object',
        properties: {
          protocol: { type: 'string' },
          eventType: { type: 'string', description: 'Optional. ConfigChange, AuthorityChange, ProgramUpgrade, NONCE, VaultTx, etc.' },
          windowDays: { type: 'number', description: 'Optional. Omit for all-time.' },
        },
        required: ['protocol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_monitor_state',
      description: 'Current multisig state for a protocol: threshold, members, timelock, open threat alerts.',
      parameters: {
        type: 'object',
        properties: { protocol: { type: 'string' } },
        required: ['protocol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_activity_feed',
      description: 'Raw activity events in a window. Optional protocol/type filters. Returns up to 20 events.',
      parameters: {
        type: 'object',
        properties: {
          protocol: { type: 'string', description: 'Optional filter' },
          eventType: { type: 'string', description: 'Optional filter' },
          windowDays: { type: 'number' },
          limit: { type: 'number', description: 'Max results, default 20' },
        },
        required: ['windowDays'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_signers_sharing_authority',
      description: 'Find every protocol where a given address appears as a multisig signer or program upgrade authority. Use to spot cross-protocol signer risk.',
      parameters: {
        type: 'object',
        properties: { authorityAddress: { type: 'string', description: 'Solana base58 address' } },
        required: ['authorityAddress'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_hack_history',
      description: 'Prior hacks affecting this protocol (direct incidents and cascade exposure from upstream incidents).',
      parameters: {
        type: 'object',
        properties: { protocol: { type: 'string' } },
        required: ['protocol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_protocols',
      description: 'List every tracked protocol name. Useful when the alert mentions a protocol and you want to confirm the canonical name.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_account_info',
      description: 'Live RPC call: owner, lamports, executable flag, and data length for a Solana account. Use when you need to verify an account still exists or check its basic type.',
      parameters: {
        type: 'object',
        properties: { address: { type: 'string', description: 'Solana base58 address' } },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_signatures',
      description: 'Live RPC call: most recent transaction signatures for an address, plus age of oldest. Use to tell if a signer is brand new (ageDays < 7 is suspicious) or dormant.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          limit: { type: 'number', description: 'Optional, max 50, default 20' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_nonce_activity',
      description: 'Live RPC scan of recent transactions on an address for durable nonce operations (InitializeNonce, AdvanceNonce, etc). Durable nonce on an admin signer is the Drift exploit vector. Returns hasNonceActivity: true if found.',
      parameters: {
        type: 'object',
        properties: { address: { type: 'string' } },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_program_upgrade_authority',
      description: 'Live RPC: resolve the current upgrade authority of a BPF program by reading its ProgramData account. Returns "IMMUTABLE" if the program has been frozen.',
      parameters: {
        type: 'object',
        properties: { programId: { type: 'string', description: 'Solana base58 program ID' } },
        required: ['programId'],
      },
    },
  },
];

// ---------------- Dispatcher ----------------

export async function executeTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'search_forensics': return tool_search_forensics(args);
    case 'get_upgrade_history': return tool_get_upgrade_history(args);
    case 'count_prior_events': return tool_count_prior_events(args);
    case 'get_monitor_state': return tool_get_monitor_state(args);
    case 'search_activity_feed': return tool_search_activity_feed(args);
    case 'list_signers_sharing_authority': return tool_list_signers_sharing_authority(args);
    case 'get_hack_history': return tool_get_hack_history(args);
    case 'list_protocols': return tool_list_protocols();
    case 'get_account_info': return await tool_get_account_info(args);
    case 'get_recent_signatures': return await tool_get_recent_signatures(args);
    case 'check_nonce_activity': return await tool_check_nonce_activity(args);
    case 'get_program_upgrade_authority': return await tool_get_program_upgrade_authority(args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ---------------- Playbooks: alert-type → investigation sequence ----------------
//
// Each playbook is a tiny ordered list of "steps". A step = 1 LLM call with
// a narrow toolset + a focused instruction. The bot posts the step's output
// and an inline "Scan deeper" button that triggers the next step. If the LLM
// concludes routine, processing stops. This mirrors how a manual investigation runs:
// look at the most suspicious signal first, then decide whether to drill down.

export interface PlaybookStep {
  id: string;
  label: string;        // shown as button text for the next step
  instruction: string;  // prompt appended to the system context
  tools: string[];      // tool names allowed for this step
}

export interface Playbook {
  alertType: string;
  steps: PlaybookStep[];
}

export const PLAYBOOKS: Record<string, Playbook> = {
  NONCE: {
    alertType: 'NONCE',
    steps: [
      {
        id: 'root',
        label: 'Confirm nonce',
        instruction: 'A durable-nonce signal fired on this address. Call check_nonce_activity first to confirm. If confirmed, state the finding in one sentence and flag whether deeper investigation is warranted. If not confirmed, say so and stop.',
        tools: ['check_nonce_activity', 'get_recent_signatures'],
      },
      {
        id: 'context',
        label: 'Check signer history',
        instruction: 'Establish the signer context: how long has this address been active, what protocols does it touch. Be brief.',
        tools: ['get_recent_signatures', 'list_signers_sharing_authority', 'search_forensics'],
      },
      {
        id: 'cross_protocol',
        label: 'Cross-protocol scan',
        instruction: 'Look for Drift-pattern cross-protocol exposure: does this signer hold authority elsewhere, any similar recent events in the activity feed.',
        tools: ['list_signers_sharing_authority', 'search_activity_feed', 'get_hack_history'],
      },
    ],
  },
  CONFIG_CHANGE: {
    alertType: 'CONFIG_CHANGE',
    steps: [
      {
        id: 'root',
        label: 'Cadence check',
        instruction: 'A governance config change fired. Call get_upgrade_history and count_prior_events to establish baseline cadence. If the change fits the normal pattern, say routine and stop. If not, flag what stands out.',
        tools: ['get_upgrade_history', 'count_prior_events', 'get_monitor_state'],
      },
      {
        id: 'signer',
        label: 'Who signed',
        instruction: 'Identify the signer set that approved this change, check whether any signer is brand new or known from other protocols.',
        tools: ['get_monitor_state', 'get_recent_signatures', 'list_signers_sharing_authority'],
      },
      {
        id: 'history',
        label: 'Priors',
        instruction: 'Any related activity or hacks touching this protocol. Decide whether to escalate.',
        tools: ['search_activity_feed', 'get_hack_history', 'search_forensics'],
      },
    ],
  },
  PROGRAM_UPGRADE: {
    alertType: 'PROGRAM_UPGRADE',
    steps: [
      {
        id: 'root',
        label: 'Upgrade cadence',
        instruction: 'A BPF program upgrade fired. Call get_upgrade_history to see cadence. If this is a protocol that upgrades frequently, say routine and stop. Otherwise flag what stands out.',
        tools: ['get_upgrade_history', 'get_program_upgrade_authority'],
      },
      {
        id: 'authority',
        label: 'Authority check',
        instruction: 'Confirm the upgrade authority is unchanged from forensics. Check if the authority is a known multisig or a single key.',
        tools: ['get_program_upgrade_authority', 'search_forensics', 'get_monitor_state'],
      },
      {
        id: 'priors',
        label: 'Priors',
        instruction: 'Related recent activity or hacks. Decide whether to escalate.',
        tools: ['search_activity_feed', 'get_hack_history'],
      },
    ],
  },
  NEW_SIGNER: {
    alertType: 'NEW_SIGNER',
    steps: [
      {
        id: 'root',
        label: 'Signer age',
        instruction: 'A new signer was added to a multisig. Call get_recent_signatures on the signer to see how old the wallet is. Brand new wallets (age < 7 days) are suspicious. State the age and one sentence of assessment.',
        tools: ['get_recent_signatures', 'get_account_info'],
      },
      {
        id: 'cross_protocol',
        label: 'Known signer?',
        instruction: 'Does this address hold authority elsewhere on the tracked set. Is it a known team wallet.',
        tools: ['list_signers_sharing_authority', 'search_forensics'],
      },
      {
        id: 'context',
        label: 'Governance context',
        instruction: 'Check current multisig state and recent governance activity. Decide whether to escalate.',
        tools: ['get_monitor_state', 'search_activity_feed', 'get_hack_history'],
      },
    ],
  },
  // Default playbook for uncategorised alerts
  GENERIC: {
    alertType: 'GENERIC',
    steps: [
      {
        id: 'root',
        label: 'Initial assessment',
        instruction: 'Read the alert and use the most appropriate single tool to get a quick read. State one sentence: does it look routine or worth deeper investigation.',
        tools: ['search_forensics', 'get_monitor_state', 'count_prior_events'],
      },
      {
        id: 'deeper',
        label: 'Deeper look',
        instruction: 'Investigate further: check upgrade history, activity feed, and prior incidents.',
        tools: ['get_upgrade_history', 'search_activity_feed', 'get_hack_history', 'get_recent_signatures'],
      },
      {
        id: 'full',
        label: 'Full scan',
        instruction: 'Any tool is available. Chain them to reach a conclusion.',
        tools: ['search_forensics', 'get_upgrade_history', 'count_prior_events', 'get_monitor_state', 'search_activity_feed', 'list_signers_sharing_authority', 'get_hack_history', 'list_protocols', 'get_account_info', 'get_recent_signatures', 'check_nonce_activity', 'get_program_upgrade_authority'],
      },
    ],
  },
};

export function getPlaybook(alertType: string): Playbook {
  const key = alertType?.toUpperCase().replace(/[^A-Z_]/g, '_') || 'GENERIC';
  return PLAYBOOKS[key] || PLAYBOOKS.GENERIC;
}

/**
 * Return the tool schema entries matching a list of names. Used to give
 * the LLM only the tools that are relevant to the current step.
 */
export function toolsByNames(names: string[]): any[] {
  return TOOL_SCHEMA.filter(t => names.includes(t.function.name));
}
