// Detect recent multisig configuration changes (threshold, members, timelock).

import { Connection, PublicKey } from '@solana/web3.js';
import { withRetry } from '../utils/connection';

export interface RotationResult {
  multisigAddress: string;
  hasRecentRotation: boolean;
  rotationCount: number;
  recentConfigChanges: Array<{
    signature: string;
    timestamp: number;
    daysAgo: number;
  }>;
  warning: string | null;
}

// Squads V4 config change instruction log patterns
// Audit fix #3: primary detection via typed log strings with fallback
const CONFIG_CHANGE_PATTERNS = [
  'ConfigTransactionExecute',
  'MultisigSetTimeLock',
  'MultisigAddMember',
  'MultisigRemoveMember',
  'MultisigChangeThreshold',
  'MultisigSetConfigAuthority',
  // Squads V4 instruction discriminators (base64 prefixes from IDL)
  'config_transaction_execute',
  'multisig_set_time_lock',
  'multisig_add_member',
  'multisig_remove_member',
  'multisig_change_threshold',
  'multisig_set_config_authority',
];

export async function checkRecentRotation(
  connection: Connection,
  multisigAddress: string,
  _heliusApiKey: string,
  lookbackDays: number = 30
): Promise<RotationResult> {
  const multisigPubkey = new PublicKey(multisigAddress);

  try {
    const signatures = await withRetry(
      () =>
        connection.getSignaturesForAddress(multisigPubkey, { limit: 50 }),
      `getSignaturesForAddress(${multisigAddress})`
    );

    const cutoffTime = Date.now() / 1000 - lookbackDays * 86400;
    const recentConfigChanges: RotationResult['recentConfigChanges'] = [];

    for (const sig of signatures) {
      if (!sig.blockTime || sig.blockTime < cutoffTime) continue;

      // Fetch full transaction to check for config change instructions
      const tx = await withRetry(
        () =>
          connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          }),
        `getParsedTransaction(${sig.signature.slice(0, 8)}...)`
      );

      if (!tx?.meta?.logMessages) continue;

      // Check logs for config change patterns (audit fix #3)
      const isConfigChange = tx.meta.logMessages.some((log: string) =>
        CONFIG_CHANGE_PATTERNS.some((pattern) =>
          log.toLowerCase().includes(pattern.toLowerCase())
        )
      );

      if (isConfigChange) {
        const daysAgo = (Date.now() / 1000 - (sig.blockTime || 0)) / 86400;
        recentConfigChanges.push({
          signature: sig.signature,
          timestamp: sig.blockTime || 0,
          daysAgo: Math.round(daysAgo * 10) / 10,
        });
      }

      // Rate limit between tx fetches
      await new Promise((r) => setTimeout(r, 100));
    }

    const hasRecent = recentConfigChanges.length > 0;
    let warning: string | null = null;

    if (hasRecent) {
      const mostRecent = recentConfigChanges[0];
      warning =
        `Multisig configuration was changed ${mostRecent.daysAgo} days ago.`;
    }

    return {
      multisigAddress,
      hasRecentRotation: hasRecent,
      rotationCount: recentConfigChanges.length,
      recentConfigChanges,
      warning,
    };
  } catch (e) {
    return {
      multisigAddress,
      hasRecentRotation: false,
      rotationCount: 0,
      recentConfigChanges: [],
      warning: `Could not fetch transaction history: ${(e as Error).message}`,
    };
  }
}
