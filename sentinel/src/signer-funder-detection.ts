// Detect inbound SOL transfers to tracked signers from previously unknown funders.

import * as fs from 'fs';
import * as path from 'path';
import { writeJsonAtomic, readJsonStrict } from './utils/json-file';

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
  funders: FunderStats[];            // whitelisted: at least one transfer >= WHITELIST_MIN_LAMPORTS
  belowMinFunders?: FunderStats[];   // recorded only: every transfer so far was below the minimum
};
type HistoryFile = {
  scannedAt: string;
  signers: Record<string, SignerHistory>;
};

const HISTORY_PATH = path.join(__dirname, '..', 'data', 'signer-funder-history.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'suspicious-funder-registry.json');

// A transfer below this size is recorded but does not whitelist its funder, so a dust transfer
// cannot pre-clear an address ahead of a larger funding transfer from the same address.
export const WHITELIST_MIN_LAMPORTS = 10_000_000; // 0.01 SOL
const WHITELIST_MIN_SOL = WHITELIST_MIN_LAMPORTS / 1e9;

// In-memory whitelist: signer address → Set of known funder addresses
const signerWhitelists = new Map<string, Set<string>>();
// Funders already reported for a signer with below-minimum transfers only. Suppresses repeat
// reports of further small transfers; a transfer at or above the minimum is still reported.
const belowMinSeen = new Map<string, Set<string>>();

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

// Returns null when the file exists but does not parse; the caller then skips the write so a
// corrupt registry is never replaced with an empty one.
function loadRegistry(): Registry | null {
  try {
    const reg = readJsonStrict<Registry>(REGISTRY_PATH, { updatedAt: new Date().toISOString(), funders: {} });
    if (!reg.funders) reg.funders = {};
    return reg;
  } catch (e: any) {
    console.error(`[SIGNER_FUNDING] ${e?.message}; registry not updated this run`);
    return null;
  }
}

function saveRegistry(reg: Registry) {
  reg.updatedAt = new Date().toISOString();
  try {
    writeJsonAtomic(REGISTRY_PATH, reg);
  } catch (e: any) {
    console.error('[SIGNER_FUNDING] registry save failed:', e?.message);
  }
}

export function loadSignerWhitelists(): number {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.warn('[SIGNER_FUNDING] No history file - detection disabled');
    return 0;
  }
  let data: HistoryFile;
  try {
    data = readJsonStrict<HistoryFile>(HISTORY_PATH, { scannedAt: '', signers: {} });
  } catch (e: any) {
    console.error(`[SIGNER_FUNDING] ${e?.message}; detection disabled`);
    return 0;
  }
  signerWhitelists.clear();
  belowMinSeen.clear();
  for (const [signer, h] of Object.entries(data.signers || {})) {
    const set = new Set((h.funders || []).map(f => f.address));
    signerWhitelists.set(signer, set);
    if (h.belowMinFunders?.length) belowMinSeen.set(signer, new Set(h.belowMinFunders.map(f => f.address)));
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
  belowWhitelistMin: boolean;   // recorded, but the funder stays off the whitelist
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

    // Below-minimum transfers: report the first per (signer, funder) pair, never whitelist.
    const belowMin = amount < WHITELIST_MIN_LAMPORTS;
    if (belowMin) {
      const seen = belowMinSeen.get(to);
      if (seen && seen.has(from)) continue;
      if (!seen) belowMinSeen.set(to, new Set([from]));
      else seen.add(from);
    }

    // Cross-protocol registry lookup: has this funder hit other tracked signers before?
    const reg = loadRegistry();
    const priorEntry = reg?.funders[from];
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
      belowWhitelistMin: belowMin,
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
    if (reg) {
      if (priorEntry) {
        priorEntry.lastSeen = ts;
        priorEntry.hits.push(hit);
      } else {
        reg.funders[from] = { firstSeen: ts, lastSeen: ts, hits: [hit] };
      }
      saveRegistry(reg);
    }

    // Add to the in-memory whitelist so future transfers from the same funder don't re-alert,
    // but only once a transfer at or above the minimum has been seen.
    if (!belowMin) whitelist.add(from);
  }

  return findings;
}

/**
 * Expose the registry for read-only access (e.g. dashboard surfaces).
 */
export function getSuspiciousFunders(): Registry {
  return loadRegistry() ?? { updatedAt: new Date().toISOString(), funders: {} };
}

/**
 * Record a new funder in the on-disk history so subsequent runs (after restart)
 * remember this one has already been flagged. Run async after sending alerts.
 * A transfer at or above the minimum whitelists the funder; a smaller one is
 * recorded under belowMinFunders without whitelisting it.
 */
export function persistNewFunder(signer: string, funder: string, amountSol: number, ts: number): void {
  try {
    // readJsonStrict throws on a corrupt file; the catch below logs it and skips the write.
    const data = readJsonStrict<HistoryFile | null>(HISTORY_PATH, null);
    if (!data) return;
    const history = data.signers?.[signer];
    if (!history) return;
    if (!Array.isArray(history.funders)) history.funders = [];

    const whitelisted = amountSol >= WHITELIST_MIN_SOL;
    let existing = history.funders.find(f => f.address === funder);
    if (!existing) {
      const below = history.belowMinFunders || [];
      const prior = below.find(f => f.address === funder);
      if (prior && whitelisted) {
        // Promote: the funder has now sent at least the minimum.
        history.belowMinFunders = below.filter(f => f.address !== funder);
        history.funders.push(prior);
        existing = prior;
      } else if (prior) {
        existing = prior;
      }
    }
    if (existing) {
      existing.txCount++;
      existing.totalSol += amountSol;
      existing.lastSeen = Math.max(existing.lastSeen, ts);
    } else {
      const entry = { address: funder, txCount: 1, totalSol: amountSol, firstSeen: ts, lastSeen: ts };
      if (whitelisted) history.funders.push(entry);
      else (history.belowMinFunders ||= []).push(entry);
    }
    writeJsonAtomic(HISTORY_PATH, data);
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
