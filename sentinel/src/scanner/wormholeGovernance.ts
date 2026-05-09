import { Connection, PublicKey } from '@solana/web3.js';
import { WORMHOLE_CORE } from '../utils/constants';
import { withRetry } from '../utils/connection';

export interface WormholeGovernanceResult {
  isWormholeGoverned: boolean;
  guardianSetIndex: number | null;
  guardianCount: number | null;
  threshold: number | null; // computed: (count * 2) / 3 + 1
  error?: string;
}

/**
 * Read the Wormhole guardian set to determine governance parameters.
 *
 * Wormhole stores guardian sets at PDAs: ["GuardianSet", index (u32 BE)].
 * The bridge config stores the current guardian set index.
 * Threshold = floor(guardianCount * 2 / 3) + 1 (hardcoded in VAA verification).
 */
export async function checkWormholeGovernance(
  connection: Connection
): Promise<WormholeGovernanceResult> {
  try {
    // First find the bridge config to get current guardian set index
    // Bridge config PDA: ["Bridge"]
    const [bridgePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('Bridge')],
      WORMHOLE_CORE
    );

    const bridgeInfo = await withRetry(
      () => connection.getAccountInfo(bridgePDA),
      'getAccountInfo(Wormhole Bridge)'
    );

    if (!bridgeInfo) {
      return {
        isWormholeGoverned: false,
        guardianSetIndex: null,
        guardianCount: null,
        threshold: null,
        error: 'Wormhole Bridge config not found',
      };
    }

    // Bridge config layout:
    // 4 bytes: guardian_set_index (u32 LE)
    // ... other fields
    const guardianSetIndex = bridgeInfo.data.readUInt32LE(0);

    // Now fetch the guardian set at this index
    // GuardianSet PDA: ["GuardianSet", index (u32 BE)]
    const indexBuffer = Buffer.alloc(4);
    indexBuffer.writeUInt32BE(guardianSetIndex);
    const [guardianSetPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('GuardianSet'), indexBuffer],
      WORMHOLE_CORE
    );

    const guardianSetInfo = await withRetry(
      () => connection.getAccountInfo(guardianSetPDA),
      'getAccountInfo(Wormhole GuardianSet)'
    );

    if (!guardianSetInfo) {
      return {
        isWormholeGoverned: true,
        guardianSetIndex,
        guardianCount: null,
        threshold: null,
        error: `Guardian set ${guardianSetIndex} not found on-chain`,
      };
    }

    // GuardianSet layout:
    // 4 bytes: index (u32 LE)
    // 4 bytes: keys vec length (u32 LE)
    // N * 20 bytes: guardian ETH addresses (20 bytes each)
    // 4 bytes: creation_time (u32 LE)
    // 4 bytes: expiration_time (u32 LE)
    const gsIndex = guardianSetInfo.data.readUInt32LE(0);
    const guardianCount = guardianSetInfo.data.readUInt32LE(4);

    // Wormhole threshold: floor(count * 2 / 3) + 1
    const threshold = Math.floor(guardianCount * 2 / 3) + 1;

    return {
      isWormholeGoverned: true,
      guardianSetIndex: gsIndex,
      guardianCount,
      threshold,
    };
  } catch (e) {
    return {
      isWormholeGoverned: false,
      guardianSetIndex: null,
      guardianCount: null,
      threshold: null,
      error: `Failed to read Wormhole governance: ${(e as Error).message}`,
    };
  }
}
