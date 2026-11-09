// Rebuilds a program's upgrade authority and deploy slot over time from its ProgramData account's
// history, so the live program-upgrade detector can be run against any past moment.
//
// Decoded upgradeable-loader instructions (bincode u32 tag), top-level or CPI:
//   2 DeployWithMaxDataLen  [payer, programData, program, buffer, rent, clock, system, authority]
//   3 Upgrade               [programData, program, buffer, spill, rent, clock, authority]
//   4 SetAuthority          [account, currentAuthority, newAuthority?]   (no new authority = immutable)
//   7 SetAuthorityChecked   [account, currentAuthority, newAuthority]
// The loader writes the deploy slot as the slot of the deploy/upgrade transaction.

import { PublicKey } from '@solana/web3.js';
import type { CompactTx } from './history';
import { ixData } from './history';

export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

export function programDataAddress(programId: string): string {
  const [pd] = PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer()], new PublicKey(LOADER));
  return pd.toBase58();
}

export interface ProgramState { authority: string; deploySlot: number; deployTime: number }

export interface ProgramChange {
  tx: CompactTx;
  before: ProgramState | null;
  after: ProgramState;
  how: 'deploy' | 'upgrade' | 'set-authority';
}

export function rebuildProgram(programData: string, txs: CompactTx[]): { changes: ProgramChange[]; final: ProgramState | null } {
  let state = null as ProgramState | null;
  const changes: ProgramChange[] = [];
  for (const tx of txs) {
    for (const ix of tx.ixs) {
      if (ix.p !== LOADER) continue;
      const d = ixData(ix);
      if (d.length < 4) continue;
      const tag = d.readUInt32LE(0);
      const before = state ? { ...state } : null;
      if (tag === 2 && ix.a[1] === programData) {
        state = { authority: ix.a[7] ?? 'IMMUTABLE', deploySlot: tx.slot, deployTime: tx.time };
        changes.push({ tx, before, after: { ...state }, how: 'deploy' });
      } else if (tag === 3 && ix.a[0] === programData) {
        state = { authority: ix.a[6] ?? state?.authority ?? 'UNKNOWN', deploySlot: tx.slot, deployTime: tx.time };
        changes.push({ tx, before, after: { ...state }, how: 'upgrade' });
      } else if ((tag === 4 || tag === 7) && ix.a[0] === programData) {
        const next = ix.a[2] ?? 'IMMUTABLE';
        state = { authority: next, deploySlot: state?.deploySlot ?? 0, deployTime: state?.deployTime ?? 0 };
        changes.push({ tx, before, after: { ...state }, how: 'set-authority' });
      }
    }
  }
  return { changes, final: state };
}
