// Rebuilds a protocol admin field over time from decoded setter instructions (top-level or CPI, e.g.
// executed through a Squads vault), for replay. Live Admin Watch reads the field directly instead.

import * as crypto from 'crypto';
import { PublicKey } from '@solana/web3.js';
import type { CompactTx } from './history';
import { ixData } from './history';
import type { AdminTarget } from '../detectors/admin-watch';
import { NONE } from '../detectors/admin-watch';

export type { AdminTarget } from '../detectors/admin-watch';

export const anchorDisc = (name: string) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8).toString('hex');

export interface AdminChange { tx: CompactTx; field: string; before: string | null; after: string; signer: string | null }

export function rebuildAdmin(t: AdminTarget, txs: CompactTx[]): AdminChange[] {
  const discs = new Map(t.setters.map(s => [anchorDisc(s.ix), s]));
  const current: Record<string, string | null> = {};
  const out: AdminChange[] = [];
  for (const tx of txs) {
    for (const ix of tx.ixs) {
      if (ix.p !== t.programId) continue;
      const d = ixData(ix);
      const setter = discs.get(d.subarray(0, 8).toString('hex'));
      if (!setter || ix.a[setter.stateAccountIndex] !== t.account) continue;
      if (d.length < setter.newValueArgOffset + 32) continue;
      const key = new PublicKey(d.subarray(setter.newValueArgOffset, setter.newValueArgOffset + 32));
      const after = key.equals(PublicKey.default) ? NONE : key.toBase58();
      // Where the program requires the current admin to sign (has_one = admin), that account is the
      // value before the change, which gives a baseline on the first observed call.
      const signer = setter.currentAdminAccountIndex !== undefined ? ix.a[setter.currentAdminAccountIndex] ?? null : null;
      const before = setter.field in current ? current[setter.field] : signer;
      if (before === after) continue;
      out.push({ tx, field: setter.field, before, after, signer });
      current[setter.field] = after;
    }
  }
  return out;
}
