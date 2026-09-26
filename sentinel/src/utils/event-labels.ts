// Plain-English labels for event types, threat categories and program roles, used in bot replies and
// alerts so users never see internal code names. Keep in step with ACTIVITY_TYPE_LABELS in
// public-dashboard/src/App.tsx.

export const EVENT_LABELS: Record<string, string> = {
  ConfigChange: 'Multisig settings changed',
  VaultTx: 'Transaction sent from the multisig',
  SpendingLimit: 'Spending limit used',
  ProgramUpgrade: 'Program code updated',
  Approval: 'Proposal approved',
  Rejection: 'Proposal rejected',
  Cancellation: 'Proposal cancelled',
  ProposalCreated: 'Proposal created',
  TreasuryProposal: 'Proposal to move treasury funds',
  AuthorityActivity: 'Activity by a controlling wallet',
  AuthorityChange: 'Program control changed',
  ProposalPending: 'Proposal waiting',
  GovernanceActivity: 'Governance activity',
  MintAuthorityChange: 'Token minting control changed',
  DVNConfigChange: 'Cross-chain message checks changed',
  OFTRouteChange: 'Cross-chain token route changed',
  IntegrityChange: 'Daily check found a change',
  NONCE: 'Pre-signed transaction activity',
  GovernanceConfigProposal: 'DAO voting rules change proposed',
  TimelockAdded: 'Timelock added',
  TimelockRemoved: 'Timelock removed',
  TimelockChanged: 'Timelock changed',
  ThresholdRaised: 'Threshold raised',
  ThresholdLowered: 'Threshold lowered',
  SignersAdded: 'Signers added',
  SignersRemoved: 'Signers removed',
  SignerRotation: 'Signers swapped',
  ExternalAdminKeyAdded: 'External admin key set',
  ExternalAdminKeyCleared: 'External admin key cleared',
  ExternalAdminKeyChanged: 'External admin key changed',
  VotersChanged: 'Voting members changed',
  VoteConcentration: 'Voting power concentrated',
  Composability: 'Protocol connection changed',
};

// Signer risk categories recorded by the monitor.
export const THREAT_LABELS: Record<string, string> = {
  NONCE: 'Pre-signed transaction activity (a transaction signed now that can be submitted later)',
  BRIDGE: 'Signer used a cross-chain bridge',
  DEPLOY: 'Signer deployed or upgraded a program',
  MICRO_TX: 'Pattern of small test transactions',
  GAS_FUNDING: 'Signer wallet topped up with SOL',
};

// What a program does, used when its upgrade key changes.
export const ROLE_LABELS: Record<string, string> = {
  'holds-funds': 'holds user funds',
  'routes-funds': 'routes user funds',
  'peripheral': 'supporting program',
};

// Anything without a label is split into words ("SomeNewEvent" -> "Some new event"), never shown raw.
export function humanise(code: string): string {
  const words = String(code).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : String(code);
}

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? humanise(type);
}

export function threatLabel(category: string): string {
  return THREAT_LABELS[category] ?? humanise(category);
}

// Upgrade authority for display: "IMMUTABLE" becomes a sentence.
export function authorityText(authority: string): string {
  return authority === 'IMMUTABLE' ? 'none (the program can no longer be changed)' : authority;
}
