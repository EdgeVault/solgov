// Decoders for SPL Governance instruction data found inside ProposalTransactionV2 accounts. Indices and
// layouts verified against solana-labs/solana-program-library governance/program/src on 2026-09-16:
//   GovernanceInstruction: 6 CreateProposal, 19 SetGovernanceConfig, 21 SetRealmAuthority, 22 SetRealmConfig
//   GovernanceConfig: community_vote_threshold (VoteThreshold), min_community_weight_to_create_proposal u64,
//                     transactions_hold_up_time u32, voting_base_time u32, ...
//   VoteThreshold: 0 YesVotePercentage(u8), 1 QuorumPercentage(u8), 2 Disabled (no payload)
//   SetRealmAuthority { action: SetRealmAuthorityAction }: 0 SetUnchecked, 1 SetChecked, 2 Remove

export const IX_CREATE_PROPOSAL = 6;
export const IX_SET_GOVERNANCE_CONFIG = 19;
export const IX_SET_REALM_AUTHORITY = 21;
export const IX_SET_REALM_CONFIG = 22;

export const VOTE_THRESHOLD_DISABLED = 2;

export interface VoteThresholdDecoded {
  kind: number;
  pct: number | null;   // null when the kind is Disabled (no payload) or the data is truncated
  next: number;         // offset of the first byte after the threshold
}

// Reads a VoteThreshold enum at offset `o`. Disabled carries no percentage byte, so every later field
// sits one byte earlier than it does for the two percentage kinds. The same rule applies to the
// community, council and veto thresholds wherever they are parsed.
export function readVoteThreshold(d: Uint8Array, o: number): VoteThresholdDecoded {
  const kind = d[o++];
  if (kind === VOTE_THRESHOLD_DISABLED) return { kind, pct: null, next: o };
  const pct = o < d.length ? d[o] : null;
  return { kind, pct, next: o + 1 };
}

export interface SetGovernanceConfigDecoded {
  voteThresholdKind: number;
  voteThresholdPct: number | null;   // null when the threshold kind is Disabled
  holdUpTimeSec: number | null;      // SPL Governance's execution delay (its timelock)
}

// Returns null unless the data is a SetGovernanceConfig instruction long enough to carry the fields.
export function decodeSetGovernanceConfig(ixData: Uint8Array): SetGovernanceConfigDecoded | null {
  const d = Buffer.from(ixData);
  if (d.length < 2 || d[0] !== IX_SET_GOVERNANCE_CONFIG) return null;
  const vt = readVoteThreshold(d, 1);
  const q = vt.next + 8; // min_community_weight_to_create_proposal
  const holdUp = q + 4 <= d.length ? d.readUInt32LE(q) : null;
  return { voteThresholdKind: vt.kind, voteThresholdPct: vt.pct, holdUpTimeSec: holdUp };
}

export function isSetRealmAuthority(ixData: Uint8Array): boolean {
  return ixData.length >= 1 && ixData[0] === IX_SET_REALM_AUTHORITY;
}

export type SetRealmAuthorityAction = 'SetUnchecked' | 'SetChecked' | 'Remove' | 'Unknown';

// The action byte follows the tag. Remove clears the realm authority (no new authority account);
// the two Set variants move it to the account passed as the third instruction account.
export function decodeSetRealmAuthorityAction(ixData: Uint8Array): SetRealmAuthorityAction | null {
  if (!isSetRealmAuthority(ixData)) return null;
  const a = ixData.length >= 2 ? ixData[1] : -1;
  return a === 0 ? 'SetUnchecked' : a === 1 ? 'SetChecked' : a === 2 ? 'Remove' : 'Unknown';
}

export function isSetRealmConfig(ixData: Uint8Array): boolean {
  return ixData.length >= 1 && ixData[0] === IX_SET_REALM_CONFIG;
}
