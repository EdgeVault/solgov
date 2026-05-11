// Resolve a Solana program's upgrade authority via the BPF Upgradeable Loader account.

import { Connection, PublicKey } from '@solana/web3.js';
import { BPF_UPGRADEABLE_LOADER } from '../utils/constants';
import { withRetry } from '../utils/connection';

export interface AuthorityResult {
  programId: string;
  immutable: boolean;
  authority: string | null;
  programDataAddress: string | null;
  error?: string;
}

export async function getProgramAuthority(
  connection: Connection,
  programId: string
): Promise<AuthorityResult> {
  const programPubkey = new PublicKey(programId);

  const programInfo = await withRetry(
    () => connection.getAccountInfo(programPubkey),
    `getAccountInfo(${programId})`
  );

  if (!programInfo) {
    return {
      programId,
      immutable: false,
      authority: null,
      programDataAddress: null,
      error: `Program ${programId} not found on-chain`,
    };
  }

  // Check if this is a standard BPF Upgradeable Loader program
  if (!programInfo.owner.equals(BPF_UPGRADEABLE_LOADER)) {
    // Non-standard loader - treat as immutable (can't determine authority)
    return {
      programId,
      immutable: true,
      authority: null,
      programDataAddress: null,
      error: `Non-standard loader: ${programInfo.owner.toBase58()}. Cannot determine upgrade authority.`,
    };
  }

  // Validate data length before slicing (audit fix #4)
  // Upgradeable programs: data starts with 4-byte enum (2 = Program),
  // followed by 32-byte ProgramData address. Minimum 36 bytes.
  if (programInfo.data.length < 36) {
    return {
      programId,
      immutable: true,
      authority: null,
      programDataAddress: null,
      error: `Program account data too short (${programInfo.data.length} bytes). May be immutable or non-standard.`,
    };
  }

  try {
    const programDataAddress = new PublicKey(programInfo.data.slice(4, 36));
    const programDataInfo = await withRetry(
      () => connection.getAccountInfo(programDataAddress),
      `getAccountInfo(ProgramData for ${programId})`
    );

    if (!programDataInfo) {
      return {
        programId,
        immutable: true,
        authority: null,
        programDataAddress: programDataAddress.toBase58(),
        error: `ProgramData account not found - program may be closed or invalid`,
      };
    }

    // ProgramData layout:
    // Byte 0-3: enum (3 = ProgramData)
    // Byte 4-11: slot last deployed
    // Byte 12: Option<Pubkey> flag (1 = Some, 0 = None/immutable)
    // Byte 13-44: authority pubkey (if flag = 1)
    if (programDataInfo.data.length < 45) {
      return {
        programId,
        immutable: true,
        authority: null,
        programDataAddress: programDataAddress.toBase58(),
        error: `ProgramData account data too short (${programDataInfo.data.length} bytes)`,
      };
    }

    const hasAuthority = programDataInfo.data[12] === 1;

    if (!hasAuthority) {
      return {
        programId,
        immutable: true,
        authority: null,
        programDataAddress: programDataAddress.toBase58(),
      };
    }

    const authority = new PublicKey(programDataInfo.data.slice(13, 45));

    return {
      programId,
      immutable: false,
      authority: authority.toBase58(),
      programDataAddress: programDataAddress.toBase58(),
    };
  } catch (e) {
    // Catch any unexpected parsing errors (audit fix #4)
    return {
      programId,
      immutable: true,
      authority: null,
      programDataAddress: null,
      error: `Failed to parse program authority: ${(e as Error).message}`,
    };
  }
}
