import { Connection, PublicKey } from '@solana/web3.js';
import { withRetry } from '../utils/connection';

export interface SignerProfile {
  address: string;
  classification: 'hot' | 'cold' | 'dedicated_signer' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  riskLevel: 'high' | 'medium' | 'low';
  indicators: string[];
  details: {
    balance: number;           // SOL balance
    tokenAccounts: number;     // number of SPL token accounts
    recentTxCount: number;     // transactions in last 30 days
    lastActivity: number;      // days since last transaction
    interactsWithDefi: boolean;
    signsOnlyMultisig: boolean;
  };
}

// Known DeFi program IDs - if a signer interacts with these, it's a hot wallet
const DEFI_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Orca V1
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  // Serum
  'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',  // Marginfi
  'So1endDq2YkqhipRh3WViPa8hFvz0XP1QELaiwrOhKM', // Solend
]);

const MULTISIG_PROGRAMS = new Set([
  'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', // Squads V4
  'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu', // Squads V3
  'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHUwaYqnt', // Serum Multisig
  'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHuwg6Xdt', // Serum Multisig v2
]);

/**
 * Profile a multisig signer to determine if they're using a hot or cold wallet.
 *
 * Hot wallet indicators: many token accounts, frequent txs, DeFi interactions
 * Cold/dedicated indicators: few txs, only multisig interactions, minimal tokens
 */
export async function profileSigner(
  connection: Connection,
  signerAddress: string
): Promise<SignerProfile> {
  const signer = new PublicKey(signerAddress);
  const indicators: string[] = [];

  // Get balance
  const balance = await withRetry(
    () => connection.getBalance(signer),
    `getBalance(${signerAddress.slice(0, 8)}...)`
  );
  const solBalance = balance / 1e9;

  // Get token accounts count
  let tokenAccounts = 0;
  try {
    const tokenResp = await withRetry(
      () => connection.getParsedTokenAccountsByOwner(signer, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      }),
      `getTokenAccounts(${signerAddress.slice(0, 8)}...)`
    );
    tokenAccounts = tokenResp.value.length;
  } catch { /* skip */ }

  // Get recent transactions
  let recentTxCount = 0;
  let lastActivity = -1;
  let interactsWithDefi = false;
  let signsOnlyMultisig = true;

  try {
    const sigs = await withRetry(
      () => connection.getSignaturesForAddress(signer, { limit: 20 }),
      `getSignatures(${signerAddress.slice(0, 8)}...)`
    );

    recentTxCount = sigs.length;

    if (sigs.length > 0 && sigs[0].blockTime) {
      lastActivity = (Date.now() / 1000 - sigs[0].blockTime) / 86400;
    }

    // Check a sample of transactions for DeFi interactions
    if (sigs.length > 0) {
      await new Promise((r) => setTimeout(r, 500));
      const tx = await connection.getParsedTransaction(sigs[0].signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (tx?.transaction?.message) {
        const allPrograms = new Set<string>();
        for (const ix of tx.transaction.message.instructions || []) {
          const prog = (ix as any).programId?.toBase58?.() ?? '';
          if (prog) allPrograms.add(prog);
        }
        for (const inner of tx.meta?.innerInstructions ?? []) {
          for (const ix of inner.instructions ?? []) {
            const prog = (ix as any).programId?.toBase58?.() ?? '';
            if (prog) allPrograms.add(prog);
          }
        }

        for (const prog of allPrograms) {
          if (DEFI_PROGRAMS.has(prog)) {
            interactsWithDefi = true;
          }
          if (!MULTISIG_PROGRAMS.has(prog) &&
              prog !== '11111111111111111111111111111111' &&
              prog !== 'ComputeBudget111111111111111111111111111111' &&
              prog !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
            signsOnlyMultisig = false;
          }
        }
      }
    }
  } catch { /* skip */ }

  // Classification logic
  let classification: SignerProfile['classification'] = 'unknown';
  let confidence: SignerProfile['confidence'] = 'low';
  let riskLevel: SignerProfile['riskLevel'] = 'medium';

  // Hot wallet signals
  if (tokenAccounts > 10) {
    indicators.push(`${tokenAccounts} token accounts - active trading wallet`);
  }
  if (interactsWithDefi) {
    indicators.push('Interacts with DeFi protocols - NOT a dedicated signing wallet');
  }
  if (recentTxCount >= 20 && lastActivity < 1) {
    indicators.push('High transaction frequency - active daily use');
  }
  if (solBalance > 100) {
    indicators.push(`${solBalance.toFixed(1)} SOL balance - significant funds in wallet`);
  }

  // Cold/dedicated signals
  if (tokenAccounts <= 2) {
    indicators.push(`Only ${tokenAccounts} token accounts - minimal activity`);
  }
  if (signsOnlyMultisig && recentTxCount > 0) {
    indicators.push('Only interacts with multisig programs - dedicated signer');
  }
  if (lastActivity > 7) {
    indicators.push(`Last activity ${Math.round(lastActivity)} days ago - infrequent use`);
  }
  if (solBalance < 0.1) {
    indicators.push('Minimal SOL balance - likely dedicated signing wallet');
  }

  // Classify
  const hotSignals = (tokenAccounts > 10 ? 1 : 0) +
    (interactsWithDefi ? 1 : 0) +
    (recentTxCount >= 15 ? 1 : 0) +
    (solBalance > 50 ? 1 : 0);

  const coldSignals = (tokenAccounts <= 2 ? 1 : 0) +
    (signsOnlyMultisig ? 1 : 0) +
    (lastActivity > 7 ? 1 : 0) +
    (solBalance < 1 ? 1 : 0);

  if (hotSignals >= 2) {
    classification = 'hot';
    confidence = hotSignals >= 3 ? 'high' : 'medium';
    riskLevel = 'high';
  } else if (coldSignals >= 3) {
    classification = 'dedicated_signer';
    confidence = coldSignals >= 4 ? 'high' : 'medium';
    riskLevel = 'low';
  } else if (coldSignals >= 2) {
    classification = 'cold';
    confidence = 'medium';
    riskLevel = 'low';
  } else {
    classification = 'unknown';
    confidence = 'low';
    riskLevel = 'medium';
  }

  return {
    address: signerAddress,
    classification,
    confidence,
    riskLevel,
    indicators,
    details: {
      balance: solBalance,
      tokenAccounts,
      recentTxCount,
      lastActivity: Math.round(lastActivity * 10) / 10,
      interactsWithDefi,
      signsOnlyMultisig,
    },
  };
}

/**
 * Profile all signers for a multisig. Rate-limited.
 */
export async function profileAllSigners(
  connection: Connection,
  signerAddresses: string[]
): Promise<SignerProfile[]> {
  const profiles: SignerProfile[] = [];
  for (const addr of signerAddresses) {
    const profile = await profileSigner(connection, addr);
    profiles.push(profile);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return profiles;
}

export function formatSignerProfiles(profiles: SignerProfile[]): string {
  let out = `## Signer Wallet Analysis\n\n`;
  out += `| # | Address | Type | Risk | Tokens | Last Active | Key Indicators |\n`;
  out += `|---|---------|------|------|--------|-------------|----------------|\n`;

  const hotCount = profiles.filter((p) => p.classification === 'hot').length;
  const coldCount = profiles.filter((p) =>
    p.classification === 'cold' || p.classification === 'dedicated_signer'
  ).length;

  profiles.forEach((p, i) => {
    const typeLabel = {
      hot: 'HOT',
      cold: 'Cold',
      dedicated_signer: 'Dedicated',
      unknown: '???',
    }[p.classification];

    const riskLabel = {
      high: 'HIGH',
      medium: 'Medium',
      low: 'Low',
    }[p.riskLevel];

    const lastActive = p.details.lastActivity < 0
      ? 'Never'
      : p.details.lastActivity < 1
        ? 'Today'
        : `${Math.round(p.details.lastActivity)}d ago`;

    const topIndicator = p.indicators[0] ?? '-';

    out += `| ${i + 1} | ${p.address.slice(0, 8)}... | ${typeLabel} | ${riskLabel} | ${p.details.tokenAccounts} | ${lastActive} | ${topIndicator} |\n`;
  });

  out += `\n`;

  if (hotCount > 0) {
    out += `**WARNING: ${hotCount} of ${profiles.length} signers appear to be hot wallets.** `;
    out += `Hot wallets are significantly easier to compromise - they're connected to the internet, `;
    out += `interact with DeFi protocols, and have a larger attack surface. `;
    out += `The Drift attacker compromised signers who were likely using active wallets, not dedicated signing devices.\n\n`;
  }

  if (coldCount === profiles.length) {
    out += `All signers appear to be dedicated signing wallets - good operational security.\n\n`;
  }

  return out;
}
