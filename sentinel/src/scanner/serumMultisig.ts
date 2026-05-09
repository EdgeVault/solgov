import { Connection, PublicKey } from '@solana/web3.js';
import { SERUM_MULTISIG } from '../utils/constants';
import { withRetry } from '../utils/connection';

export interface SerumMultisigResult {
  isSerumMultisig: boolean;
  multisigAddress: string | null;
  config?: {
    threshold: number;
    memberCount: number;
    members: Array<{
      key: string;
      permissions: number;
      permissionsReadable: string[];
    }>;
    timeLock: number;
    timeLockHours: number;
    configAuthority: string | null;
    createKey: string;
    nonce: number;
    ownerSetSeqno: number;
  };
  error?: string;
}

/**
 * Parse Serum Multisig account data.
 *
 * Layout (Anchor):
 *   8 bytes: discriminator
 *   4 bytes: owners vec length (u32 LE)
 *   N * 32 bytes: owner pubkeys
 *   8 bytes: threshold (u64 LE)
 *   1 byte: nonce (u8)
 *   4 bytes: owner_set_seqno (u32 LE)
 *
 * Serum Multisig has NO timelock - all executions are instant.
 */
function parseSerumMultisigData(data: Buffer): SerumMultisigResult['config'] {
  let offset = 8; // skip Anchor discriminator

  const ownerCount = data.readUInt32LE(offset); offset += 4;

  const members = [];
  for (let i = 0; i < ownerCount; i++) {
    const key = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    members.push({
      key: key.toBase58(),
      permissions: 7, // Serum Multisig: all owners have equal permissions
      permissionsReadable: ['Propose', 'Approve', 'Execute'],
    });
  }

  // threshold is u64 but realistically fits in a number
  const threshold = Number(data.readBigUInt64LE(offset)); offset += 8;
  const nonce = data[offset]; offset += 1;
  const ownerSetSeqno = data.readUInt32LE(offset); offset += 4;

  return {
    threshold,
    memberCount: ownerCount,
    members,
    timeLock: 0,        // Serum Multisig has no timelock
    timeLockHours: 0,
    configAuthority: null,
    createKey: '',      // not stored in account
    nonce,
    ownerSetSeqno,
  };
}

/**
 * Try to find and decode a Serum Multisig for a given authority address.
 *
 * The authority might be:
 * 1. The multisig account itself (owned by Serum Multisig program)
 * 2. A vault PDA derived from the multisig (owned by System Program)
 *
 * For case 2, we check transactions on the authority to find the multisig.
 */
export async function checkSerumMultisig(
  connection: Connection,
  authorityAddress: string
): Promise<SerumMultisigResult> {
  const authority = new PublicKey(authorityAddress);

  // First check if the authority itself is a Serum Multisig account
  const accountInfo = await withRetry(
    () => connection.getAccountInfo(authority),
    `getAccountInfo(${authorityAddress.slice(0, 8)}...)`
  );

  if (accountInfo?.owner.equals(SERUM_MULTISIG)) {
    try {
      const config = parseSerumMultisigData(accountInfo.data);
      return {
        isSerumMultisig: true,
        multisigAddress: authorityAddress,
        config,
      };
    } catch (e) {
      return {
        isSerumMultisig: true,
        multisigAddress: authorityAddress,
        error: `Serum Multisig account but failed to decode: ${(e as Error).message}`,
      };
    }
  }

  // If authority is a System Program account (vault PDA), search transactions
  if (accountInfo && accountInfo.owner.toBase58() === '11111111111111111111111111111111') {
    return await reverseSerumLookup(connection, authorityAddress);
  }

  // Account doesn't exist - try searching by transaction history
  if (!accountInfo) {
    return await reverseSerumLookup(connection, authorityAddress);
  }

  return { isSerumMultisig: false, multisigAddress: null };
}

async function reverseSerumLookup(
  connection: Connection,
  authorityAddress: string
): Promise<SerumMultisigResult> {
  try {
    const sigs = await withRetry(
      () => connection.getSignaturesForAddress(new PublicKey(authorityAddress), { limit: 10 }),
      `getSignatures(serum ${authorityAddress.slice(0, 8)}...)`
    );

    if (sigs.length === 0) {
      return { isSerumMultisig: false, multisigAddress: null };
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Check earliest and most recent txs
    const txsToCheck = [sigs[sigs.length - 1], sigs[0]];

    for (const sig of txsToCheck) {
      const tx = await withRetry(
        () => connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        }),
        `getParsedTx(serum)`
      );
      if (!tx?.transaction?.message) continue;

      await new Promise((r) => setTimeout(r, 1500));

      // Look for Serum Multisig program in instructions
      const instructions = tx.transaction.message.instructions ?? [];
      const innerInstructions = tx.meta?.innerInstructions ?? [];

      const allInstructions: Array<{ programId: string; accounts: string[] }> = [];

      for (const ix of instructions) {
        const prog = (ix as any).programId?.toBase58?.() ?? (ix as any).programId ?? '';
        const accs = ((ix as any).accounts ?? []).map((a: any) =>
          typeof a === 'string' ? a : a?.toBase58?.() ?? String(a)
        );
        allInstructions.push({ programId: prog, accounts: accs });
      }

      for (const inner of innerInstructions) {
        for (const ix of inner.instructions ?? []) {
          const prog = (ix as any).programId?.toBase58?.() ?? (ix as any).programId ?? '';
          const accs = ((ix as any).accounts ?? []).map((a: any) =>
            typeof a === 'string' ? a : a?.toBase58?.() ?? String(a)
          );
          allInstructions.push({ programId: prog, accounts: accs });
        }
      }

      const serumProgramId = SERUM_MULTISIG.toBase58();

      for (const ix of allInstructions) {
        if (ix.programId !== serumProgramId) continue;
        if (ix.accounts.length === 0) continue;

        // In Serum Multisig, the multisig account is the first account
        const candidateAddr = ix.accounts[0];
        if (candidateAddr === authorityAddress) continue;

        await new Promise((r) => setTimeout(r, 1500));

        const msInfo = await connection.getAccountInfo(new PublicKey(candidateAddr));
        if (!msInfo?.owner.equals(SERUM_MULTISIG)) continue;

        try {
          const config = parseSerumMultisigData(msInfo.data);
          return {
            isSerumMultisig: true,
            multisigAddress: candidateAddr,
            config,
          };
        } catch { continue; }
      }
    }
  } catch {
    // Fall through
  }

  return { isSerumMultisig: false, multisigAddress: null };
}
