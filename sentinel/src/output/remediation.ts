// This file generates per-protocol remediation reports listing the configuration changes that would close out matched setup-risk conditions. Output is plain markdown written to the local reports/ directory.

export interface ProtocolRemediation {
  protocolName: string;
  immediateActions: string[];
  urgentActions: string[];
  signerGuidelines: string[];
}

export function generateRemediation(
  protocolName: string,
  threshold: number,
  memberCount: number,
  timeLock: number,
  squadsVersion: 'v4' | 'v3' | null,
  hasCircuitBreakers: boolean,
  hasMultiOracle: boolean,
  hasRoleSeparation: boolean,
  hasBackstop: boolean
): ProtocolRemediation {
  const ratio = memberCount > 0 ? threshold / memberCount : 0;
  const immediate: string[] = [];
  const urgent: string[] = [];

  if (timeLock === 0) {
    if (squadsVersion === 'v4') {
      immediate.push('Enable a timelock on the multisig. On Squads V4 this is a single config transaction.');
    } else if (squadsVersion === 'v3') {
      urgent.push('Squads V3 does not support timelocks. Evaluate migration to V4 if a timelock is required.');
    } else {
      urgent.push('Multisig program may not support timelocks. Evaluate the available options for the governance model in use.');
    }
  }

  if (ratio > 0 && ratio <= 0.4) {
    immediate.push(`Threshold ${threshold}/${memberCount} (${Math.round(ratio * 100)}%) is below Squads' published 67% ratio reference.`);
  } else if (ratio > 0 && ratio < 0.67) {
    immediate.push(`Threshold ${threshold}/${memberCount} (${Math.round(ratio * 100)}%) is below Squads' published 67% ratio reference.`);
  }

  if (memberCount > 0 && memberCount < 4) {
    immediate.push(`${memberCount} signers is below Squads' published 4/6 example. Consider expanding the signer set.`);
  }

  if (!hasRoleSeparation) {
    urgent.push('All signers hold identical permissions. Squads recommends separating Initiate / Vote / Execute permissions across signers.');
  }

  if (!hasCircuitBreakers) {
    urgent.push('No program-level rate limits or auto-pause detected. Evaluate withdrawal rate limits and anomaly-based pause logic.');
  }

  if (!hasMultiOracle) {
    urgent.push('Single-oracle configuration detected. Evaluate redundant oracle sources for collateral and liquidation pricing.');
  }

  if (!hasBackstop) {
    urgent.push('No insurance fund or bug bounty disclosed. Evaluate an on-chain backstop sized to protocol scale.');
  }

  immediate.push('Monitor all multisig signer addresses for new durable nonce account creation.');

  const signerGuidelines = [
    'Sign from a hardware wallet, not a hot wallet.',
    'Use a dedicated signing device, separate from machines used for email, chat, or browsing.',
    'Do not sign a transaction you did not personally initiate or fully understand.',
    'Verify transaction simulation in the multisig UI before approving.',
    'Open the multisig UI by navigating directly. Do not follow signing links posted in group chats.',
    'Cross-check pending transactions against an independent on-chain explorer before approval.',
    'Do not reuse multisig signer keys for other purposes (DeFi, NFTs, personal).',
    'Multisig signer wallets should hold no active durable nonce accounts.',
    'Enable 2FA on email, chat, and source-control accounts associated with signing identities.',
    'Treat unsolicited signing requests as potential social engineering.',
    'With a timelock in place, a pending transaction can be cancelled before execution.',
  ];

  return {
    protocolName,
    immediateActions: immediate,
    urgentActions: urgent,
    signerGuidelines,
  };
}

export function formatRemediationReport(r: ProtocolRemediation): string {
  let out = `# Remediation Report: ${r.protocolName}\n\n`;

  if (r.immediateActions.length > 0) {
    out += `## Immediate Actions\n`;
    r.immediateActions.forEach((a) => { out += `- ${a}\n`; });
    out += `\n`;
  }

  if (r.urgentActions.length > 0) {
    out += `## Urgent Actions\n`;
    r.urgentActions.forEach((a) => { out += `- ${a}\n`; });
    out += `\n`;
  }

  out += `## Signer Operational Guidelines\n`;
  r.signerGuidelines.forEach((g, i) => { out += `${i + 1}. ${g}\n`; });
  out += `\n`;

  return out;
}
