// Rebuilds a Squads V4 multisig's configuration over time from its transaction history, so the live
// multisig-config detector can be run against any past moment.
//
// State changes come from three places: the create instruction (initial config), executed config
// transactions (autonomous multisigs: actions are stored at ConfigTransactionCreate, applied at
// ConfigTransactionExecute), and direct config-authority instructions (controlled multisigs). The
// rebuilt final state is checked against a live account read by the caller; a mismatch marks the
// replay of that multisig as unverified rather than silently trusting it.

import { PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import type { CompactTx } from './history';
import { ixData } from './history';
import { normaliseConfigAuthority, PERM_VOTE, type MultisigSnapshot } from '../detectors/multisig-config';

export const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

const g = multisig.generated as any;
const disc = (k: string) => Buffer.from(g[k + 'InstructionDiscriminator']).toString('hex');
const D = {
  createV2: disc('multisigCreateV2'),
  create: disc('multisigCreate'),
  cfgCreate: disc('configTransactionCreate'),
  cfgExecute: disc('configTransactionExecute'),
  addMember: disc('multisigAddMember'),
  removeMember: disc('multisigRemoveMember'),
  changeThreshold: disc('multisigChangeThreshold'),
  setTimeLock: disc('multisigSetTimeLock'),
  setConfigAuthority: disc('multisigSetConfigAuthority'),
};

// Discriminators (hex) of every instruction rebuildV4 reads.
export const V4_CONFIG_DISCRIMINATORS = new Set(Object.values(D));

export interface Member { key: string; mask: number }
export interface V4State { threshold: number; timeLock: number; configAuthority: string; members: Member[] }

export function toSnapshot(s: V4State, address?: string): MultisigSnapshot {
  return {
    ...(address ? { address } : {}),
    threshold: s.threshold,
    memberCount: s.members.length,
    voterCount: s.members.filter(m => m.mask & PERM_VOTE).length,
    timeLock: s.timeLock,
    configAuthority: s.configAuthority,
    memberKeys: s.members.map(m => m.key),
  };
}

const pk = (v: any): string => (v && typeof v.toBase58 === 'function' ? v.toBase58() : String(v));
const memberOf = (m: any): Member => ({ key: pk(m.key), mask: Number(m.permissions?.mask ?? m.permissions ?? 0) });

// MultisigCreate (V1, deprecated in the SDK) has the V2 layout without rent_collector:
// config_authority Option<Pubkey>, threshold u16, members Vec<{ key: Pubkey, permissions: u8 }>, time_lock u32.
function decodeCreateV1(d: Buffer): V4State | null {
  try {
    let o = 8;
    let configAuthority: string | null = null;
    if (d[o++] === 1) { configAuthority = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32; }
    const threshold = d.readUInt16LE(o); o += 2;
    const n = d.readUInt32LE(o); o += 4;
    if (n > 64) return null;
    const members: Member[] = [];
    for (let i = 0; i < n; i++) { members.push({ key: new PublicKey(d.subarray(o, o + 32)).toBase58(), mask: d[o + 32] }); o += 33; }
    const timeLock = d.readUInt32LE(o);
    return { threshold, timeLock, configAuthority: normaliseConfigAuthority(configAuthority), members };
  } catch { return null; }
}

export interface V4Change {
  tx: CompactTx;
  before: V4State | null; // null for the create
  after: V4State;
  how: 'create' | 'config-transaction' | 'config-authority';
}

function applyAction(s: V4State, act: any): void {
  switch (act.__kind) {
    case 'AddMember': s.members.push(memberOf(act.newMember)); break;
    case 'RemoveMember': { const k = pk(act.oldMember); s.members = s.members.filter(m => m.key !== k); break; }
    case 'ChangeThreshold': s.threshold = Number(act.newThreshold); break;
    case 'SetTimeLock': s.timeLock = Number(act.newTimeLock); break;
    default: break; // spending limits, rent collector: not part of the detector's snapshot
  }
}

const clone = (s: V4State): V4State => ({ ...s, members: s.members.map(m => ({ ...m })) });

// Walks txs (ascending) and returns every change to the multisig's configuration.
export function rebuildV4(address: string, txs: CompactTx[]): { changes: V4Change[]; final: V4State | null; undecoded: string[] } {
  let state: V4State | null = null;
  const pendingActions = new Map<string, any[]>(); // config transaction account -> actions
  const changes: V4Change[] = [];
  const undecoded: string[] = [];

  for (const tx of txs) {
    for (const ix of tx.ixs) {
      if (ix.p !== SQUADS_V4) continue;
      const d = ixData(ix);
      const k = d.subarray(0, 8).toString('hex');

      if (k === D.createV2 && ix.a[2] === address) {
        try {
          const [{ args }] = g.multisigCreateV2Struct.deserialize(d);
          const after: V4State = { threshold: Number(args.threshold), timeLock: Number(args.timeLock), configAuthority: normaliseConfigAuthority(args.configAuthority ? pk(args.configAuthority) : null), members: args.members.map(memberOf) };
          state = after;
          changes.push({ tx, before: null, after: clone(after), how: 'create' });
        } catch { undecoded.push(tx.sig); }
        continue;
      }
      if (k === D.create && ix.a[0] === address) {
        const after = decodeCreateV1(d);
        if (after) { state = after; changes.push({ tx, before: null, after: clone(after), how: 'create' }); }
        else undecoded.push(tx.sig);
        continue;
      }
      if (ix.a[0] !== address) continue;

      if (k === D.cfgCreate) {
        try { const [{ args }] = g.configTransactionCreateStruct.deserialize(d); pendingActions.set(ix.a[1], args.actions); }
        catch { undecoded.push(tx.sig); }
        continue;
      }
      if (!state) continue; // history before the create instruction is not expected; ignore defensively
      const before = clone(state);
      let how: V4Change['how'] | null = null;
      try {
        if (k === D.cfgExecute) {
          const acts = pendingActions.get(ix.a[3]);
          if (!acts) { undecoded.push(tx.sig); continue; }
          for (const a of acts) applyAction(state, a);
          how = 'config-transaction';
        } else if (k === D.addMember) {
          const [{ args }] = g.multisigAddMemberStruct.deserialize(d); state.members.push(memberOf(args.newMember)); how = 'config-authority';
        } else if (k === D.removeMember) {
          const [{ args }] = g.multisigRemoveMemberStruct.deserialize(d); const r = pk(args.oldMember); state.members = state.members.filter(m => m.key !== r); how = 'config-authority';
        } else if (k === D.changeThreshold) {
          const [{ args }] = g.multisigChangeThresholdStruct.deserialize(d); state.threshold = Number(args.newThreshold); how = 'config-authority';
        } else if (k === D.setTimeLock) {
          const [{ args }] = g.multisigSetTimeLockStruct.deserialize(d); state.timeLock = Number(args.timeLock); how = 'config-authority';
        } else if (k === D.setConfigAuthority) {
          const [{ args }] = g.multisigSetConfigAuthorityStruct.deserialize(d); state.configAuthority = normaliseConfigAuthority(pk(args.configAuthority)); how = 'config-authority';
        }
      } catch { undecoded.push(tx.sig); continue; }
      if (how) changes.push({ tx, before, after: clone(state), how });
    }
  }
  return { changes, final: state, undecoded };
}

// Compares a rebuilt state with a live decoded account. Returns the differing fields (empty = verified).
export function verifyAgainstLive(rebuilt: V4State, live: any): string[] {
  const diffs: string[] = [];
  if (rebuilt.threshold !== Number(live.threshold)) diffs.push(`threshold ${rebuilt.threshold} vs live ${live.threshold}`);
  if (rebuilt.timeLock !== Number(live.timeLock)) diffs.push(`timeLock ${rebuilt.timeLock} vs live ${live.timeLock}`);
  const liveCa = normaliseConfigAuthority(live.configAuthority ? pk(live.configAuthority) : null);
  if (rebuilt.configAuthority !== liveCa) diffs.push(`configAuthority ${rebuilt.configAuthority} vs live ${liveCa}`);
  const a = rebuilt.members.map(m => `${m.key}:${m.mask}`).sort().join(',');
  const b = live.members.map((m: any) => `${pk(m.key)}:${Number(m.permissions?.mask ?? 0)}`).sort().join(',');
  if (a !== b) diffs.push('member set or permissions differ');
  return diffs;
}

export function vaultPda(address: string, index = 0): string {
  const [pda] = multisig.getVaultPda({ multisigPda: new PublicKey(address), index });
  return pda.toBase58();
}
