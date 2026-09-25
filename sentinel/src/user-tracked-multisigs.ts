// Registry of user-submitted Squads V4 multisigs watched alongside the curated tracked-protocol set.
//
// Submissions come from the public API and from any Telegram user, so every entry lives in its own
// namespace: the stored name is always "Tracked: <label> (<addr4>...<addr4>)". That name can never equal
// a curated protocol key, so a submission cannot write a curated entry in monitor-state, trip the
// listener's re-baseline for a curated multisig, or reach subscribers of a curated protocol. Alerts for
// tracked entries go only to the users subscribed to that exact tracked name (see subscriptions.ts), and
// never to the public channel.

import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { readJsonStrict, writeJsonAtomic, JsonReadError } from './utils/json-file';

const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'user-tracked-multisigs.json');

// Hard cap to bound RPC subscription count + storage.
export const MAX_TRACKED = 200;
// Per-submitter cap so one account or IP cannot fill the registry.
export const MAX_PER_SUBMITTER = 5;

export const TRACKED_PREFIX = 'Tracked: ';

export interface UserTrackedMultisig {
  address: string;
  label: string;        // namespaced display name, always starts with TRACKED_PREFIX
  addedAt: string;
  addedBy?: string;     // optional opaque ID (telegram user, IP) for audit
}

interface Registry { multisigs: UserTrackedMultisig[] }

export function isTrackedName(name: string): boolean {
  return name.startsWith(TRACKED_PREFIX);
}

// Keeps letters, digits, spaces and a few separators; drops markup characters and control codes.
function cleanLabel(raw: string | undefined): string {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function trackedName(address: string, label?: string): string {
  const base = cleanLabel(label && label.startsWith(TRACKED_PREFIX) ? label.slice(TRACKED_PREFIX.length).replace(/\s*\([^)]*\)\s*$/, '') : label);
  const short = `${address.slice(0, 4)}...${address.slice(-4)}`;
  return `${TRACKED_PREFIX}${base || 'multisig'} (${short})`;
}

// Throws JsonReadError if the file exists but is corrupt, so callers that write never save an empty
// registry over a real one.
function readRegistryStrict(): Registry {
  const r = readJsonStrict<Registry>(REGISTRY_FILE, { multisigs: [] });
  return Array.isArray(r?.multisigs) ? r : { multisigs: [] };
}

export function loadRegistry(): Registry {
  try {
    const r = readRegistryStrict();
    // Entries saved before namespacing carry a bare label; normalise on read.
    return { multisigs: r.multisigs.map(m => ({ ...m, label: trackedName(m.address, m.label) })) };
  } catch (e: any) {
    console.warn('[USER-TRACKED] load failed:', e?.message);
    return { multisigs: [] };
  }
}

function saveRegistry(r: Registry): void {
  try {
    writeJsonAtomic(REGISTRY_FILE, r);
  } catch (e: any) {
    console.error('[USER-TRACKED] save failed:', e?.message);
  }
}

export function listTracked(): UserTrackedMultisig[] {
  return loadRegistry().multisigs;
}

export function isAddressValidBase58(addr: string): boolean {
  try {
    const pk = new PublicKey(addr);
    return pk.toBase58() === addr;
  } catch { return false; }
}

/**
 * Verify the address points at a real Squads v4 multisig account on-chain
 * before accepting it. This is the critical step - anyone with a string
 * could submit junk; only entries that decode as Squads accounts are added.
 *
 * Returns the parsed multisig metadata on success or an error string.
 */
export async function verifySquadsMultisig(
  conn: Connection,
  address: string,
): Promise<{ ok: true; threshold: number; memberCount: number } | { ok: false; error: string }> {
  if (!isAddressValidBase58(address)) return { ok: false, error: 'Not a valid base58 pubkey' };
  let info;
  try {
    info = await conn.getAccountInfo(new PublicKey(address));
  } catch (e: any) {
    return { ok: false, error: `RPC error: ${e.message?.slice(0, 80)}` };
  }
  if (!info) return { ok: false, error: 'Account not found on-chain' };
  // Squads v4 program owns its accounts. Verify ownership before parsing.
  const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
  if (info.owner.toBase58() !== SQUADS_V4) {
    return { ok: false, error: `Account is not owned by Squads v4 program (owner: ${info.owner.toBase58().slice(0, 12)}...)` };
  }
  // Decode via official SDK so the validation matches the listener's parser.
  try {
    const multisig: any = await import('@sqds/multisig');
    const [ms] = multisig.accounts.Multisig.fromAccountInfo(info);
    const memberCount = Array.isArray(ms.members) ? ms.members.length : 0;
    return { ok: true, threshold: Number(ms.threshold || 0), memberCount };
  } catch (e: any) {
    return { ok: false, error: `Squads decode failed: ${e.message?.slice(0, 80)}` };
  }
}

export function addTracked(input: { address: string; label?: string; addedBy?: string }): { ok: boolean; error?: string; entry?: UserTrackedMultisig } {
  let reg: Registry;
  try {
    reg = readRegistryStrict();
  } catch (e) {
    if (e instanceof JsonReadError) return { ok: false, error: 'Tracking registry is temporarily unavailable. Try again later.' };
    throw e;
  }
  const existing = reg.multisigs.find(m => m.address === input.address);
  if (existing) return { ok: true, entry: { ...existing, label: trackedName(existing.address, existing.label) } };
  if (reg.multisigs.length >= MAX_TRACKED) {
    return { ok: false, error: `User-tracked cap reached (${MAX_TRACKED}). No new submissions accepted.` };
  }
  if (input.addedBy && reg.multisigs.filter(m => m.addedBy === input.addedBy).length >= MAX_PER_SUBMITTER) {
    return { ok: false, error: `Each submitter can track up to ${MAX_PER_SUBMITTER} multisigs.` };
  }
  const entry: UserTrackedMultisig = {
    address: input.address,
    label: trackedName(input.address, input.label),
    addedAt: new Date().toISOString(),
    addedBy: input.addedBy,
  };
  reg.multisigs.push(entry);
  saveRegistry(reg);
  return { ok: true, entry };
}

export function removeTracked(address: string): boolean {
  let reg: Registry;
  try { reg = readRegistryStrict(); } catch { return false; }
  const idx = reg.multisigs.findIndex(m => m.address === address);
  if (idx < 0) return false;
  reg.multisigs.splice(idx, 1);
  saveRegistry(reg);
  return true;
}

/**
 * Watch the registry file for changes. Used by the listener to react to
 * additions without restarting. Watches the directory rather than the file:
 * atomic writes replace the file by rename, and a watch on the old inode
 * would stop firing after the first save.
 */
export function watchRegistry(onChange: (list: UserTrackedMultisig[]) => void): { close: () => void } {
  if (!fs.existsSync(REGISTRY_FILE)) saveRegistry({ multisigs: [] });
  const base = path.basename(REGISTRY_FILE);
  let debounceTimer: NodeJS.Timeout | null = null;
  const w = fs.watch(path.dirname(REGISTRY_FILE), (_event, filename) => {
    if (filename && filename.toString() !== base) return;
    // Coalesce double-fires (rename + change)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const list = loadRegistry().multisigs;
      onChange(list);
    }, 250);
  });
  return { close: () => { w.close(); if (debounceTimer) clearTimeout(debounceTimer); } };
}
