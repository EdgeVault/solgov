// Detect inbound SOL transfers to tracked signers from previously unknown funders.

import * as fs from 'fs';
import * as path from 'path';

type FunderStats = {
  address: string;
  txCount: number;
  totalSol: number;
  firstSeen: number;
  lastSeen: number;
};
type SignerHistory = {
  signer: string;
  scannedAt: string;
  funders: FunderStats[];
};
type HistoryFile = {
  scannedAt: string;
  signers: Record<string, SignerHistory>;
};

const HISTORY_PATH = path.join(__dirname, '..', 'data', 'signer-funder-history.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'suspicious-funder-registry.json');

// In-memory whitelist: signer address → Set of known funder addresses
const signerWhitelists = new Map<string, Set<string>>();
// Track what has already been seen live to avoid re-alerting on the same new funder
const seenLive = new Map<string, Set<string>>();

// Cross-protocol registry: funder address → history of signer hits across protocols.
// When a new-funder detection fires, the funder is recorded here. On subsequent
// detections involving the same funder (same or different protocol), severity is
// elevated because the same address has now reached more than one protocol's
// signer set.
type RegistryEntry = {
  firstSeen: number;
  lastSeen: number;
  hits: {
    signer: string;
    protocols: string[];
    amountSol: number;
    timestamp: number;
    signature: string;
  }[];
};
type Registry = {
  updatedAt: string;
  funders: Record<string, RegistryEntry>;
};

function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { updatedAt: new Date().toISOString(), funders: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return { updatedAt: new Date().toISOString(), funders: {} };
  }
}

function saveRegistry(reg: Registry) {
  reg.updatedAt = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export function loadSignerWhitelists(): number {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.warn('[SIGNER_FUNDING] No history file - detection disabled');
    return 0;
  }
  const data: HistoryFile = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  signerWhitelists.clear();
  for (const [signer, h] of Object.entries(data.signers)) {
    const set = new Set(h.funders.map(f => f.address));
    signerWhitelists.set(signer, set);
  }
  console.log(`[SIGNER_FUNDING] Loaded whitelists for ${signerWhitelists.size} signers`);
  return signerWhitelists.size;
}

type NewFunderFinding = {
  signer: string;
  funder: string;
  amountSol: number;
  signature: string;
  timestamp: number;
  isRepeatOffender: boolean;
  priorProtocolsHit: string[];
};

/**
 * Inspect webhook event for inbound SOL transfers to tracked signers from
 * addresses not in the signer's historical whitelist.
 *
 * Returns findings (possibly multiple per event if several signers funded).
 */
export function detectNewFunders(event: any): NewFunderFinding[] {
  const findings: NewFunderFinding[] = [];
  if (!event.nativeTransfers || !Array.isArray(event.nativeTransfers)) return findings;

  const sig = event.signature || '';
  const ts = event.timestamp || Math.floor(Date.now() / 1000);

  for (const nt of event.nativeTransfers) {
    const to = nt.toUserAccount;
    const from = nt.fromUserAccount;
    const amount = nt.amount || 0;
    if (!to || !from || !amount || to === from) continue;

    const whitelist = signerWhitelists.get(to);
    if (!whitelist) continue; // not a tracked signer
    if (whitelist.has(from)) continue; // known funder, not anomalous

    // Dedup: skip re-alerting if this (signer, funder) pair has already been seen this session
    const seen = seenLive.get(to);
    if (seen && seen.has(from)) continue;
    if (!seen) seenLive.set(to, new Set([from]));
    else seen.add(from);

    // Cross-protocol registry lookup: has this funder hit other tracked signers before?
    const reg = loadRegistry();
    const priorEntry = reg.funders[from];
    const priorProtocols = priorEntry
      ? [...new Set(priorEntry.hits.flatMap(h => h.protocols))]
      : [];
    const isRepeat = priorEntry !== undefined;

    findings.push({
      signer: to,
      funder: from,
      amountSol: amount / 1e9,
      signature: sig,
      timestamp: ts,
      isRepeatOffender: isRepeat,
      priorProtocolsHit: priorProtocols,
    });

    // Record this hit in the registry for future cross-protocol correlation
    const currentProtocols = findProtocolsForSigner(to);
    const hit = {
      signer: to,
      protocols: currentProtocols,
      amountSol: amount / 1e9,
      timestamp: ts,
      signature: sig,
    };
    if (priorEntry) {
      priorEntry.lastSeen = ts;
      priorEntry.hits.push(hit);
    } else {
      reg.funders[from] = { firstSeen: ts, lastSeen: ts, hits: [hit] };
    }
    saveRegistry(reg);

    // Persist: add to in-memory whitelist so future transfers from same funder don't re-alert
    whitelist.add(from);
  }

  return findings;
}

/**
 * Expose the registry for read-only access (e.g. dashboard surfaces).
 */
export function getSuspiciousFunders(): Registry {
  return loadRegistry();
}

/**
 * Append a new funder to the on-disk whitelist so subsequent runs (after restart)
 * remember this one has already been flagged. Run async after sending alerts.
 */
export function persistNewFunder(signer: string, funder: string, amountSol: number, ts: number): void {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return;
    const data: HistoryFile = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    const history = data.signers[signer];
    if (!history) return;

    const existing = history.funders.find(f => f.address === funder);
    if (existing) {
      existing.txCount++;
      existing.totalSol += amountSol;
      existing.lastSeen = Math.max(existing.lastSeen, ts);
    } else {
      history.funders.push({
        address: funder,
        txCount: 1,
        totalSol: amountSol,
        firstSeen: ts,
        lastSeen: ts,
      });
    }
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.error('[SIGNER_FUNDING] persist failed:', e.message);
  }
}

/**
 * Reverse lookup: for a given signer address, find which protocol(s) it belongs to.
 * Reads monitor-state.json on demand (rare call path, no cache needed).
 */
export function findProtocolsForSigner(signer: string): string[] {
  try {
    const statePath = path.join(__dirname, '..', 'data', 'monitor-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const protocols: string[] = [];
    for (const [name, data] of Object.entries(state as Record<string, any>)) {
      if (name.startsWith('_')) continue;
      if (Array.isArray(data?.members) && data.members.includes(signer)) {
        protocols.push(name);
      }
    }
    return protocols;
  } catch {
    return [];
  }
}
