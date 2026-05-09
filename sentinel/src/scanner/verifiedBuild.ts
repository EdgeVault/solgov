import { Connection, PublicKey } from '@solana/web3.js';
import { VERIFY_PROGRAM } from '../utils/constants';
import { withRetry } from '../utils/connection';

export interface VerifiedBuildResult {
  programId: string;
  hasVerifiedBuild: boolean;
  verifyAuthority: string | null;
  warning: string | null;
}

export async function checkVerifiedBuild(
  connection: Connection,
  programId: string
): Promise<VerifiedBuildResult> {
  try {
    const programPubkey = new PublicKey(programId);

    // Derive the verification PDA from the Ellipsis Labs verifier program
    const [verifyPDA] = PublicKey.findProgramAddressSync(
      [programPubkey.toBuffer()],
      VERIFY_PROGRAM
    );

    const verifyAccount = await withRetry(
      () => connection.getAccountInfo(verifyPDA),
      `checkVerifiedBuild(${programId})`
    );

    if (verifyAccount && verifyAccount.data.length > 0) {
      return {
        programId,
        hasVerifiedBuild: true,
        verifyAuthority: verifyAccount.owner.toBase58(),
        warning: null,
      };
    }

    return {
      programId,
      hasVerifiedBuild: false,
      verifyAuthority: null,
      warning:
        'No verified build found on-chain. Source code cannot be independently verified against deployed bytecode.',
    };
  } catch (e) {
    return {
      programId,
      hasVerifiedBuild: false,
      verifyAuthority: null,
      warning: `Could not check verified build status: ${(e as Error).message}`,
    };
  }
}
