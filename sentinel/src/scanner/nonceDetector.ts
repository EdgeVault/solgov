import { Connection, PublicKey, NONCE_ACCOUNT_LENGTH } from '@solana/web3.js';
import { SYSTEM_PROGRAM, NONCE_TIMEOUT_MS, MAX_NONCE_RESULTS } from '../utils/constants';
import { withTimeout } from '../utils/connection';

export interface NonceResult {
  signer: string;
  hasActiveNonces: boolean;
  nonceCount: number;
  nonceAccounts: string[];
  timedOut: boolean;
  error?: string;
}

export async function checkSignerNonces(
  connection: Connection,
  signerAddress: string
): Promise<NonceResult> {
  const signer = new PublicKey(signerAddress);

  try {
    const { result: nonceAccounts, timedOut } = await withTimeout(
      connection.getProgramAccounts(SYSTEM_PROGRAM, {
        filters: [
          { dataSize: NONCE_ACCOUNT_LENGTH },
          // Filter for active nonce state (audit fix #2)
          // Nonce account layout: bytes 0-3 = version, byte 4-7 = state
          // State 1 = Initialized (active). This filters out uninitialized nonces.
          {
            memcmp: {
              offset: 0,
              bytes: '2', // bs58 encoding of u32 state = 1 (Initialized)
            },
          },
          // Filter by nonce authority at offset 8
          {
            memcmp: {
              offset: 8,
              bytes: signer.toBase58(),
            },
          },
        ],
      }),
      NONCE_TIMEOUT_MS,
      [] // return empty array on timeout
    );

    if (timedOut) {
      return {
        signer: signerAddress,
        hasActiveNonces: false,
        nonceCount: 0,
        nonceAccounts: [],
        timedOut: true,
        error: `Nonce detection timed out after ${NONCE_TIMEOUT_MS}ms - status unknown`,
      };
    }

    // Cap results to prevent RPC quota blowout (audit fix #2)
    const capped = nonceAccounts.slice(0, MAX_NONCE_RESULTS);

    return {
      signer: signerAddress,
      hasActiveNonces: capped.length > 0,
      nonceCount: capped.length,
      nonceAccounts: capped.map((a) => a.pubkey.toBase58()),
      timedOut: false,
    };
  } catch (e) {
    return {
      signer: signerAddress,
      hasActiveNonces: false,
      nonceCount: 0,
      nonceAccounts: [],
      timedOut: false,
      error: `RPC error: ${(e as Error).message}`,
    };
  }
}

/**
 * Scan ALL signers for a given multisig.
 * Rate-limited to avoid hammering the RPC.
 */
export async function scanAllSignerNonces(
  connection: Connection,
  signerAddresses: string[]
): Promise<NonceResult[]> {
  const results: NonceResult[] = [];

  for (const signer of signerAddresses) {
    const result = await checkSignerNonces(connection, signer);
    results.push(result);
    // Rate limit between signer checks
    await new Promise((r) => setTimeout(r, 200));
  }

  return results;
}
