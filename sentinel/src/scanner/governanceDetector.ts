// Identify the governance type controlling an authority (Squads V4/V3, Serum Multisig, Realms, SPL Governance, or EOA).

import { Connection, PublicKey } from '@solana/web3.js';
import {
  KNOWN_GOVERNANCE_PROGRAMS,
  MULTISIG_EQUIVALENT_PROGRAMS,
  SYSTEM_PROGRAM,
} from '../utils/constants';
import { withRetry } from '../utils/connection';

export interface GovernanceResult {
  authorityAddress: string;
  ownerProgram: string;
  governanceType: string;
  isKnownGovernance: boolean;
  isMultisig: boolean;
  warning: string | null;
}

export async function identifyGovernanceType(
  connection: Connection,
  authorityAddress: string
): Promise<GovernanceResult> {
  const authority = new PublicKey(authorityAddress);

  const accountInfo = await withRetry(
    () => connection.getAccountInfo(authority),
    `getAccountInfo(${authorityAddress})`
  );

  if (!accountInfo) {
    return {
      authorityAddress,
      ownerProgram: 'unknown',
      governanceType: 'unknown',
      isKnownGovernance: false,
      isMultisig: false,
      warning: 'Authority account not found on-chain - may be closed or invalid',
    };
  }

  const ownerStr = accountInfo.owner.toBase58();
  const knownName = KNOWN_GOVERNANCE_PROGRAMS[ownerStr];

  // EOA - owned by System Program (audit fix #6: explicit handling)
  if (accountInfo.owner.equals(SYSTEM_PROGRAM)) {
    return {
      authorityAddress,
      ownerProgram: ownerStr,
      governanceType: 'system_program',
      isKnownGovernance: false,
      isMultisig: false,
      warning:
        'Authority is owned by System Program - no on-chain multisig detected. May use off-chain signing or be a single wallet.',
    };
  }

  // Known governance program (audit fix #6: SPL Governance, Goki treated as multisig-equivalent)
  if (knownName) {
    const isMultisigEquiv = MULTISIG_EQUIVALENT_PROGRAMS.has(ownerStr);
    return {
      authorityAddress,
      ownerProgram: ownerStr,
      governanceType: knownName.toLowerCase().replace(/[\s()]+/g, '_'),
      isKnownGovernance: true,
      isMultisig: isMultisigEquiv,
      warning: null,
    };
  }

  // Unknown program
  return {
    authorityAddress,
    ownerProgram: ownerStr,
    governanceType: 'unknown',
    isKnownGovernance: false,
    isMultisig: false,
    warning: `Authority owned by unknown program ${ownerStr} - cannot determine governance type. Manual investigation required.`,
  };
}
