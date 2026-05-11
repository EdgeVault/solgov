// Registry of user-submitted Squads V4 multisigs watched alongside the curated tracked-protocol set.

import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';

const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'user-tracked-multisigs.json');

// Hard cap to bound RPC subscription count + storage.
export const MAX_TRACKED = 200;

export interface UserTrackedMultisig {
  address: string;
  label: string;        // user-supplied display label, defaults to short addr
  addedAt: string;
  addedBy?: string;     // optional opaque ID (telegram user, IP) for audit
}

interface Registry { multisigs: UserTrackedMultisig[] }

export function loadRegistry(): Registry {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const r = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      if (Array.isArray(r?.multisigs)) return r;
    }
  } catch (e: any) {
    console.warn('[USER-TRACKED] load failed:', e?.message);
  }
  return { multisigs: [] };
}

function saveRegistry(r: Registry): void {
  try {
    const dir = path.dirname(REGISTRY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2));
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
  const reg = loadRegistry();
  if (reg.multisigs.find(m => m.address === input.address)) {
    return { ok: true, entry: reg.multisigs.find(m => m.address === input.address)! };
  }
  if (reg.multisigs.length >= MAX_TRACKED) {
    return { ok: false, error: `User-tracked cap reached (${MAX_TRACKED}). Contact the team to raise it.` };
  }
  const entry: UserTrackedMultisig = {
    address: input.address,
    label: input.label?.slice(0, 60) || `Custom ${input.address.slice(0, 8)}`,
    addedAt: new Date().toISOString(),
    addedBy: input.addedBy,
  };
  reg.multisigs.push(entry);
  saveRegistry(reg);
  return { ok: true, entry };
}

export function removeTracked(address: string): boolean {
  const reg = loadRegistry();
  const idx = reg.multisigs.findIndex(m => m.address === address);
  if (idx < 0) return false;
  reg.multisigs.splice(idx, 1);
  saveRegistry(reg);
  return true;
}

/**
 * Watch the registry file for changes. Used by the listener to react to
 * additions without restarting. Calls back with the updated list whenever
 * the file is written. Returns the close handle.
 */
export function watchRegistry(onChange: (list: UserTrackedMultisig[]) => void): { close: () => void } {
  if (!fs.existsSync(REGISTRY_FILE)) {
    // File may not exist yet at startup; create empty so fs.watch has a target.
    saveRegistry({ multisigs: [] });
  }
  let debounceTimer: NodeJS.Timeout | null = null;
  const w = fs.watch(REGISTRY_FILE, () => {
    // Coalesce double-fires (rename + change)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const list = loadRegistry().multisigs;
      onChange(list);
    }, 250);
  });
  return { close: () => { w.close(); if (debounceTimer) clearTimeout(debounceTimer); } };
}
