// Plain-English description of who holds a key (an upgrade authority or a protocol admin field).
// Pure formatter: the caller resolves what the key is (a vault of a known multisig, immutable, or an
// address solgov does not track) and passes the facts. Wording states configuration only.

import { timelockLabel } from './multisig-config';

export type HolderFacts =
  | { kind: 'immutable' }
  | { kind: 'multisig-vault'; address: string; multisigName: string; threshold: number; memberCount: number; timeLock: number; configAuthority: string; version?: 'v3' | 'v4' }
  // The native treasury of an SPL Governance account: it can only sign through a proposal that passes
  // in that realm. Linkage is checked live (treasury PDA derived from the governance account, and the
  // governance account's realm field read on-chain).
  | { kind: 'dao-treasury'; address: string; realmName: string; realm: string; governance: string }
  // scope: 'live' = checked against every multisig solgov tracks; 'replay' = only the replayed multisigs;
  // 'unchecked' = the multisig list could not be loaded, so no claim is made about the key
  | { kind: 'untracked'; address: string; scope?: 'live' | 'replay' | 'unchecked' };

export function describeHolder(h: HolderFacts): string {
  if (h.kind === 'immutable') return 'nobody (it can no longer be changed)';
  if (h.kind === 'dao-treasury') return `${h.realmName} governance treasury (acts only through a proposal voted on in this DAO)`;
  if (h.kind === 'untracked') {
    if (h.scope === 'unchecked') return `${h.address.slice(0, 8)}...`;
    return `${h.address.slice(0, 8)}... (${h.scope === 'replay' ? 'not a vault of any multisig in this replay' : 'not a vault of any multisig solgov tracks'})`;
  }
  const tl = h.timeLock > 0 ? `${timelockLabel(h.timeLock)} timelock` : 'no timelock';
  const ext = h.configAuthority !== 'autonomous' ? ', external admin key set' : '';
  return `${h.multisigName} vault (${h.threshold} of ${h.memberCount} signers, ${tl}${ext})`;
}
