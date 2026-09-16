// Decoders for SPL Governance instruction data found inside ProposalTransactionV2 accounts. Indices and
// layouts verified against solana-labs/solana-program-library governance/program/src on 2026-09-16:
//   GovernanceInstruction: 6 CreateProposal, 19 SetGovernanceConfig, 21 SetRealmAuthority, 22 SetRealmConfig
//   GovernanceConfig: community_vote_threshold (VoteThreshold), min_community_weight_to_create_proposal u64,
//                     transactions_hold_up_time u32, voting_base_time u32, ...
//   VoteThreshold: 0 YesVotePercentage(u8), 1 QuorumPercentage(u8), 2 Disabled (no payload)

export const IX_CREATE_PROPOSAL = 6;
export const IX_SET_GOVERNANCE_CONFIG = 19;
export const IX_SET_REALM_AUTHORITY = 21;
export const IX_SET_REALM_CONFIG = 22;

export interface SetGovernanceConfigDecoded {
  voteThresholdKind: number;
  voteThresholdPct: number | null;   // null when the threshold kind is Disabled
  holdUpTimeSec: number | null;      // SPL Governance's execution delay (its timelock)
}

// Returns null unless the data is a SetGovernanceConfig instruction long enough to carry the fields.
export function decodeSetGovernanceConfig(ixData: Uint8Array): SetGovernanceConfigDecoded | null {
  const d = Buffer.from(ixData);
  if (d.length < 2 || d[0] !== IX_SET_GOVERNANCE_CONFIG) return null;
  let q = 1;
  const kind = d[q++];
  const pct = kind === 2 ? null : (q < d.length ? d[q++] : null);
  q += 8; // min_community_weight_to_create_proposal
  const holdUp = q + 4 <= d.length ? d.readUInt32LE(q) : null;
  return { voteThresholdKind: kind, voteThresholdPct: pct, holdUpTimeSec: holdUp };
}

export function isSetRealmAuthority(ixData: Uint8Array): boolean {
  return ixData.length >= 1 && ixData[0] === IX_SET_REALM_AUTHORITY;
}
