// CLI orchestrator for the sentinel scanner. Runs scan/dry/safe modes.

import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

import { PROTOCOLS, Protocol, fetchTVL } from './protocols/registry';
import { getProgramAuthority, AuthorityResult } from './scanner/programAuthority';
import { checkSquadsConfig, SquadsResult } from './scanner/squadsConfig';
import { checkSerumMultisig } from './scanner/serumMultisig';
import { checkWormholeGovernance } from './scanner/wormholeGovernance';
import { identifyGovernanceType, GovernanceResult } from './scanner/governanceDetector';
import { scanAllSignerNonces, NonceResult } from './scanner/nonceDetector';
import { checkRecentRotation, RotationResult } from './scanner/rotationDetector';
import { checkVerifiedBuild, VerifiedBuildResult } from './scanner/verifiedBuild';
import { calculateRisk, RiskReport } from './scoring/riskScore';
import { generateSummary } from './output/reporter';
import { ProtocolReport, createEmptyReport, formatTVL } from './output/templates';
import {
  DELAY_BETWEEN_PROTOCOLS,
  DELAY_BETWEEN_CALLS,
} from './utils/constants';

// CLI flags
const isDryRun = process.argv.includes('--dry-run');
const isSafeMode = process.argv.includes('--safe-mode');

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface ScanData {
  authority: AuthorityResult;
  governance: GovernanceResult | null;
  squadsConfig: SquadsResult | null;
  nonceResults: NonceResult[] | null;
  rotationResult: RotationResult | null;
  verifiedBuild: VerifiedBuildResult;
  risk: RiskReport;
}

async function scanProtocol(
  connection: Connection,
  protocol: Protocol,
  tvl: number | null = null
): Promise<ProtocolReport> {
  console.log(`\nScanning: ${protocol.name}${tvl ? ` (TVL: ${formatTVL(tvl)})` : ''}...`);

  // Step 1: Get program upgrade authority
  const authority = await getProgramAuthority(connection, protocol.programId);
  console.log(
    `  Authority: ${authority.immutable ? 'IMMUTABLE' : authority.authority ?? 'unknown'}`
  );
  await sleep(DELAY_BETWEEN_CALLS);

  // Step 2: Verified build check (can run regardless of authority type)
  const verifiedBuild = await checkVerifiedBuild(connection, protocol.programId);
  await sleep(DELAY_BETWEEN_CALLS);

  // If immutable or authority unknown, short-circuit
  if (authority.immutable || !authority.authority) {
    const risk = calculateRisk({
      programAuthority: authority,
      verifiedBuild,
      tvl,
    });

    return buildReport(protocol, {
      authority,
      governance: null,
      squadsConfig: null,
      nonceResults: null,
      rotationResult: null,
      verifiedBuild,
      risk,
    }, tvl);
  }

  // Try Squads config FIRST on any authority. Vault PDAs are owned by
  // System Program at the account level but controlled by a Squads multisig
  // underneath. Checking governance type first returns "System Program" and
  // falsely flags as EOA. So: Squads first, governance fallback.
  let squadsConfig: SquadsResult | null = null;
  squadsConfig = await checkSquadsConfig(connection, authority.authority!);

  if (squadsConfig.isSquadsMultisig && squadsConfig.config) {
    const ver = squadsConfig.squadsVersion?.toUpperCase() ?? 'V4';
    console.log(
      `  Squads ${ver}: ${squadsConfig.config.threshold}/${squadsConfig.config.memberCount}`
    );
    console.log(
      `  Timelock: ${squadsConfig.config.timeLock}s (${squadsConfig.config.timeLockHours}h)`
    );
    if (squadsConfig.squadsVersion === 'v3') {
      console.log('  NOTE: Squads V3 has NO timelock support - all executions are instant');
    }
    if (squadsConfig.isVaultPDA) {
      console.log(
        `  (Vault PDA - parent multisig: ${squadsConfig.parentMultisig ?? 'resolved internally'})`
      );
    }
  }
  await sleep(DELAY_BETWEEN_CALLS);

  // Step 4: If Squads didn't match, try Serum Multisig, then generic governance fallback
  let governance: GovernanceResult | null = null;
  if (!squadsConfig.isSquadsMultisig) {
    // Try Serum Multisig (used by Marinade and other early protocols)
    const serumResult = await checkSerumMultisig(connection, authority.authority!);
    await sleep(DELAY_BETWEEN_CALLS);

    if (serumResult.isSerumMultisig && serumResult.config) {
      console.log(`  Serum Multisig: ${serumResult.config.threshold}/${serumResult.config.memberCount}`);
      console.log(`  NOTE: Serum Multisig has NO timelock - instant execution`);
      // Use Serum config as the squadsConfig equivalent for scoring
      squadsConfig = {
        isSquadsMultisig: true,
        squadsVersion: 'v3', // treat as V3-equivalent (no timelock)
        accountOwner: 'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHUwaYqnt',
        isVaultPDA: serumResult.multisigAddress !== authority.authority,
        parentMultisig: serumResult.multisigAddress ?? undefined,
        config: serumResult.config,
      };
      governance = {
        authorityAddress: authority.authority!,
        ownerProgram: 'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHUwaYqnt',
        governanceType: 'serum_multisig',
        isKnownGovernance: true,
        isMultisig: true,
        warning: 'Serum Multisig (2021) - no timelock feature',
      };
      console.log(`  Governance: ${governance.governanceType}`);
    } else {
      // Check if Wormhole-governed (Pyth)
      const govResult = await identifyGovernanceType(connection, authority.authority!);
      await sleep(DELAY_BETWEEN_CALLS);

      if (govResult.governanceType.includes('wormhole')) {
        const wormhole = await checkWormholeGovernance(connection);
        await sleep(DELAY_BETWEEN_CALLS);
        if (wormhole.isWormholeGoverned && wormhole.guardianCount && wormhole.threshold) {
          console.log(`  Wormhole Governance: ${wormhole.threshold}/${wormhole.guardianCount} guardians`);
          governance = {
            ...govResult,
            governanceType: 'wormhole_governance',
          };
        } else {
          governance = govResult;
          console.log(`  Governance: ${governance.governanceType}`);
        }
      } else {
        governance = govResult;
        console.log(`  Governance: ${governance.governanceType}`);
      }
    }
  } else {
    // Squads matched - synthesize governance result
    const ver = squadsConfig.squadsVersion ?? 'v4';
    const vaultSuffix = squadsConfig.isVaultPDA ? '_vault' : '';
    governance = {
      authorityAddress: authority.authority!,
      ownerProgram: squadsConfig.accountOwner,
      governanceType: `squads_${ver}${vaultSuffix}`,
      isKnownGovernance: true,
      isMultisig: true,
      warning: ver === 'v3' ? 'Squads V3 has no timelock support - all executions are instant' : null,
    };
    console.log(`  Governance: ${governance.governanceType}`);
  }

  // Step 5: Nonce detection on all signers
  let nonceResults: NonceResult[] | null = null;
  if (squadsConfig?.config?.members) {
    const signerAddresses = squadsConfig.config.members.map((m) => m.key);
    nonceResults = await scanAllSignerNonces(connection, signerAddresses);
    const noncesFound = nonceResults.filter((n) => n.hasActiveNonces).length;
    const timedOut = nonceResults.filter((n) => n.timedOut).length;
    if (noncesFound > 0) {
      console.log(
        `  WARNING: ${noncesFound} signer(s) with active nonce accounts!`
      );
    }
    if (timedOut > 0) {
      console.log(
        `  NOTE: Nonce check timed out for ${timedOut} signer(s)`
      );
    }
  }

  // Step 6: Check for recent multisig rotation
  let rotationResult: RotationResult | null = null;
  const multisigAddr =
    squadsConfig?.parentMultisig ?? authority.authority;
  if (squadsConfig?.config && multisigAddr) {
    const heliusKey =
      process.env.HELIUS_RPC_URL?.split('api-key=')[1] || '';
    rotationResult = await checkRecentRotation(
      connection,
      multisigAddr,
      heliusKey
    );
    if (rotationResult.hasRecentRotation) {
      console.log(`  WARNING: Recent multisig rotation detected!`);
    }
    await sleep(DELAY_BETWEEN_CALLS);
  }

  // Step 7: Calculate risk score
  const risk = calculateRisk({
    programAuthority: authority,
    squadsConfig: squadsConfig?.config ?? undefined,
    squadsVersion: squadsConfig?.squadsVersion ?? undefined,
    tvl,
    nonceResults: nonceResults ?? undefined,
    governance: governance ?? undefined,
    rotationResult: rotationResult ?? undefined,
    verifiedBuild: verifiedBuild ?? undefined,
  });

  console.log(
    `  Risk: ${risk.score}/100 (${risk.rating}) | Drift similarity: ${risk.driftSimilarityScore}/8`
  );

  return buildReport(protocol, {
    authority,
    governance,
    squadsConfig,
    nonceResults,
    rotationResult,
    verifiedBuild,
    risk,
  }, tvl);
}

function buildReport(protocol: Protocol, data: ScanData, tvl: number | null = null): ProtocolReport {
  const { authority, governance, squadsConfig, nonceResults, rotationResult, verifiedBuild, risk } = data;

  // Determine authority type string
  let authorityType = 'unknown';
  if (authority.immutable) {
    authorityType = 'immutable';
  } else if (governance?.governanceType === 'system_program') {
    authorityType = 'single_wallet';
  } else if (governance?.governanceType) {
    authorityType = governance.governanceType;
  }

  // Build multisig config summary
  let multisigConfig: ProtocolReport['multisigConfig'] = null;
  if (squadsConfig?.config) {
    const c = squadsConfig.config;
    const allSamePerms = c.members.every(
      (m) => m.permissions === c.members[0].permissions
    );
    multisigConfig = {
      threshold: `${c.threshold}/${c.memberCount}`,
      timeLockHours: c.timeLockHours,
      roleSeparation: !allSamePerms,
      signerCount: c.memberCount,
      members: c.members.map((m) => ({
        key: m.key,
        permissionsReadable: m.permissionsReadable,
      })),
    };
  }

  // Nonce summary
  const signersWithNonces = nonceResults?.filter((n) => n.hasActiveNonces) ?? [];
  const timedOutNonces = nonceResults?.filter((n) => n.timedOut) ?? [];
  let nonceDetails: string | null = null;
  if (signersWithNonces.length > 0) {
    nonceDetails = signersWithNonces
      .map(
        (n) =>
          `Signer ${n.signer.slice(0, 8)}... has ${n.nonceCount} active nonce(s)`
      )
      .join('; ');
  } else if (timedOutNonces.length > 0) {
    nonceDetails = `Nonce check timed out for ${timedOutNonces.length} signer(s)`;
  }

  return {
    name: protocol.name,
    programId: protocol.programId,
    category: protocol.category,
    tvl,
    tvlFormatted: formatTVL(tvl),
    scanDate: new Date().toISOString(),
    upgradeAuthority: {
      immutable: authority.immutable,
      type: authorityType,
      address: authority.authority,
      isVaultPDA: squadsConfig?.isVaultPDA ?? false,
      parentMultisig: squadsConfig?.parentMultisig,
    },
    multisigConfig,
    nonceAlert: signersWithNonces.length > 0,
    nonceDetails,
    noncesTimedOut: timedOutNonces.length > 0,
    rotationAlert: rotationResult?.hasRecentRotation ?? false,
    rotationDetails: rotationResult?.warning ?? null,
    verifiedBuild: verifiedBuild.hasVerifiedBuild,
    riskScore: risk.score,
    riskRating: risk.rating,
    driftSimilarity: `${risk.driftSimilarityScore}/8 Drift attack patterns match`,
    criticalIssues: risk.criticalIssues,
    highRiskIssues: risk.highRiskIssues,
    moderateIssues: risk.moderateIssues,
    positives: risk.positives,
  };
}

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) {
    console.error('Missing HELIUS_RPC_URL in .env');
    console.error('Copy .env.example to .env and add your Helius API key');
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, 'confirmed');

  console.log('Sentinel - Solana Protocol Governance Scanner');
  console.log('=============================================');
  console.log(`Scanning ${PROTOCOLS.length} protocols...`);
  if (isDryRun) console.log('(DRY RUN - console output only)');
  if (isSafeMode) console.log('(SAFE MODE - protocol names redacted in reports)');
  console.log('');

  // Fetch TVL data from DeFiLlama (no RPC calls, free API)
  console.log('Fetching TVL data from DeFiLlama...');
  const tvlMap = new Map<string, number | null>();
  for (const p of PROTOCOLS) {
    if (p.defillamaSlug) {
      const tvl = await fetchTVL(p.defillamaSlug);
      tvlMap.set(p.programId, tvl);
      if (tvl) console.log(`  ${p.name}: ${formatTVL(tvl)}`);
    }
  }
  console.log('');

  const reports: ProtocolReport[] = [];

  // Sort by priority
  const sorted = [...PROTOCOLS].sort(
    (a, b) => (a.priority ?? 99) - (b.priority ?? 99)
  );

  for (const protocol of sorted) {
    const tvl = tvlMap.get(protocol.programId) ?? null;
    try {
      const report = await scanProtocol(connection, protocol, tvl);
      reports.push(report);
    } catch (e) {
      const errMsg = (e as Error).message;
      console.error(`  ERROR scanning ${protocol.name}: ${errMsg}`);
      reports.push(
        createEmptyReport(
          protocol.name,
          protocol.programId,
          protocol.category,
          errMsg,
          tvl
        )
      );
    }
    await sleep(DELAY_BETWEEN_PROTOCOLS);
  }

  // Generate outputs
  const dateStr = new Date().toISOString().split('T')[0];
  const reportsDir = path.resolve(__dirname, '..', 'reports');

  if (!isDryRun) {
    fs.mkdirSync(reportsDir, { recursive: true });

    // JSON report
    const jsonPath = path.join(reportsDir, `scan-${dateStr}.json`);
    const jsonData = isSafeMode
      ? reports.map((r, i) => ({ ...r, name: `Protocol-${i + 1}` }))
      : reports;
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
    console.log(`\nJSON report: ${jsonPath}`);

    // Markdown summary
    const mdPath = path.join(reportsDir, `summary-${dateStr}.md`);
    const summary = generateSummary(reports, isSafeMode);
    fs.writeFileSync(mdPath, summary);
    console.log(`Summary report: ${mdPath}`);
  }

  // Console summary
  console.log('\n=== SCAN COMPLETE ===\n');
  const critical = reports.filter((r) => r.riskRating === 'tier-1');
  const weak = reports.filter((r) => r.riskRating === 'tier-2');
  const errors = reports.filter((r) => r.riskRating === 'ERROR');

  console.log(`Tier 1: ${critical.length} protocols`);
  console.log(`Tier 2: ${weak.length} protocols`);
  console.log(`ERROR:  ${errors.length} protocols`);
  console.log(`Total:  ${reports.length} scanned`);

  if (critical.length > 0) {
    console.log('\nTier 1 protocols:');
    for (const r of critical) {
      const name = isSafeMode ? '[REDACTED]' : r.name;
      console.log(
        `  ${name} - ${r.riskScore}/100 - ${r.driftSimilarity}`
      );
    }
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
