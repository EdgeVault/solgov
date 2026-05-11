// Internal triage scoring helpers (not surfaced publicly).

import type { GovernanceResult } from '../scanner/governanceDetector';
import type { RotationResult } from '../scanner/rotationDetector';
import type { VerifiedBuildResult } from '../scanner/verifiedBuild';
import type { NonceResult } from '../scanner/nonceDetector';

export interface ScanResult {
  programAuthority: {
    immutable: boolean;
    authority: string | null;
  };
  squadsConfig?: {
    threshold: number;
    memberCount: number;
    timeLock: number;
    members: Array<{ permissions: number }>;
  };
  squadsVersion?: 'v4' | 'v3' | null;
  tvl?: number | null;
  nonceResults?: NonceResult[];
  governance?: GovernanceResult;
  rotationResult?: RotationResult;
  verifiedBuild?: VerifiedBuildResult;
}

export interface RiskReport {
  score: number;                // 0-100, higher = fewer matched Drift-pattern conditions
  rating: string;               // tier-1 / tier-2 / tier-3 / tier-4 / tier-5
  criticalIssues: string[];
  highRiskIssues: string[];
  moderateIssues: string[];
  positives: string[];
  driftSimilarityScore: number; // 0-8, count of Drift-pattern conditions matched
}

export function calculateRisk(scan: ScanResult): RiskReport {
  let score = 100;
  const critical: string[] = [];
  const high: string[] = [];
  const moderate: string[] = [];
  const positives: string[] = [];
  let driftMatch = 0;

  const tvl = scan.tvl ?? 0;

  // === PROGRAM UPGRADE AUTHORITY ===

  if (scan.programAuthority.immutable) {
    positives.push('Program is immutable - cannot be upgraded');
  } else if (!scan.squadsConfig && !scan.governance?.isMultisig) {
    // No on-chain governance detected
    critical.push(
      'On-chain governance not verifiable - authority appears to be a regular wallet. ' +
      'May use off-chain signing (MPC/TSS), custom governance, or genuinely be a single signer.'
    );
    score -= 30;
    driftMatch++;

    // TVL-weighted: larger protocols with no verifiable on-chain governance carry the
    // observation through with more weight in the scoring band.
    if (tvl >= 500_000_000) {
      critical.push(
        `${formatUSD(tvl)} TVL with no on-chain governance verifiable from the scanner's coverage set.`
      );
      score -= 25;
    } else if (tvl >= 100_000_000) {
      high.push(
        `${formatUSD(tvl)} TVL with no on-chain governance verifiable from the scanner's coverage set.`
      );
      score -= 15;
    }
  }

  // === GOVERNANCE TYPE ===

  if (scan.governance) {
    if (scan.governance.governanceType === 'unknown') {
      high.push(
        `Authority owned by unknown program ${scan.governance.ownerProgram}`
      );
      score -= 10;
    } else if (
      scan.governance.isMultisig &&
      !scan.governance.governanceType.includes('squads')
    ) {
      positives.push(
        `Authority managed by ${scan.governance.governanceType} (multisig-equivalent)`
      );
    }
  }

  // === MULTISIG CONFIGURATION ===

  if (scan.squadsConfig) {
    const { threshold, memberCount, timeLock, members } = scan.squadsConfig;
    const ratio = threshold / memberCount;

    // Threshold check
    if (ratio <= 0.4) {
      critical.push(
        `Threshold ${threshold}/${memberCount} (${Math.round(ratio * 100)}%). ` +
        `Drift's pre-exploit threshold was 2/5 (40%).`
      );
      score -= 30;
      driftMatch++;
    } else if (ratio < 0.67) {
      high.push(
        `Threshold ${threshold}/${memberCount} (${Math.round(ratio * 100)}%) - below Squads' 67% ratio reference`
      );
      score -= 15;
    } else if (ratio >= 0.8) {
      positives.push(
        `Strong threshold: ${threshold}/${memberCount} (${Math.round(ratio * 100)}%)`
      );
    } else {
      // 67-79% - meets Squads reference but not strong
      moderate.push(
        `Threshold ${threshold}/${memberCount} (${Math.round(ratio * 100)}%) - meets Squads reference but below 80%`
      );
    }

    // Timelock check
    if (timeLock === 0) {
      critical.push(
        'Zero timelock; admin changes execute instantly. ' +
        'Drift had zero timelock pre-exploit; the post-mortem identifies this as the control that would have prevented the exploit.'
      );
      score -= 40;
      driftMatch++;
    } else if (timeLock < 86400) {
      high.push(
        `Timelock is ${(timeLock / 3600).toFixed(1)} hours`
      );
      score -= 15;
    } else if (timeLock >= 172800) {
      positives.push(`Strong timelock: ${(timeLock / 3600).toFixed(1)} hours`);
    } else {
      positives.push(`Timelock: ${(timeLock / 3600).toFixed(1)} hours`);
    }

    // Member count
    if (memberCount < 4) {
      moderate.push(
        `Only ${memberCount} signers - below Squads' 4/6+ reference`
      );
      score -= 5;
    } else if (memberCount >= 7) {
      positives.push(`Good signer count: ${memberCount}`);
    }

    // Permission separation
    const allSamePerms = members.every(
      (m) => m.permissions === members[0].permissions
    );
    if (allSamePerms) {
      moderate.push(
        'All signers have identical permissions, no role separation. ' +
        'Drift had the same configuration pre-exploit.'
      );
      score -= 5;
      driftMatch++;
    } else {
      positives.push(
        'Role separation configured - signers have different permissions'
      );
    }
  }

  // === SQUADS V3 - NO TIMELOCK FEATURE ===

  if (scan.squadsVersion === 'v3') {
    critical.push(
      'Squads V3 has no timelock feature. All actions execute instantly by design. ' +
      'Same instant-execution as Drift pre-exploit.'
    );
    score -= 40;
    driftMatch++;
  }

  // === NONCE DETECTION ===

  if (scan.nonceResults) {
    const signersWithNonces = scan.nonceResults.filter(
      (n) => n.hasActiveNonces
    );
    const timedOutSigners = scan.nonceResults.filter((n) => n.timedOut);

    if (signersWithNonces.length > 0) {
      high.push(
        `${signersWithNonces.length} signer(s) have active durable nonce accounts. ` +
        `Durable nonces were the vector used in the Drift exploit; pre-positioned weeks before execution.`
      );
      score -= 15;
      driftMatch++;
    } else if (timedOutSigners.length > 0) {
      moderate.push(
        `Nonce detection timed out for ${timedOutSigners.length} signer(s) - status unknown`
      );
      score -= 2;
    } else {
      positives.push(
        'No active durable nonce accounts found on any signer'
      );
    }
  }

  // === RECENT ROTATION ===

  if (scan.rotationResult?.hasRecentRotation) {
    const mostRecent = scan.rotationResult.recentConfigChanges[0];
    if (mostRecent && mostRecent.daysAgo <= 14) {
      high.push(
        `Multisig config changed ${mostRecent.daysAgo} days ago. ` +
        `Drift's pre-exploit multisig was rotated ~10 days before the exploit.`
      );
      score -= 10;
      driftMatch++;
    } else if (mostRecent) {
      moderate.push(
        `Multisig config changed ${mostRecent.daysAgo} days ago`
      );
      score -= 3;
    }
  }

  // === VERIFIED BUILD ===

  if (scan.verifiedBuild) {
    if (scan.verifiedBuild.hasVerifiedBuild) {
      positives.push(
        'Verified build found - deployed bytecode matches public source'
      );
    } else {
      moderate.push(
        'No verified build on-chain - source cannot be independently verified'
      );
      score -= 3;
    }
  }

  // === RATING (adjusted thresholds) ===

  const clampedScore = Math.max(0, Math.min(100, score));
  // Tier labels are neutral band identifiers, not ratings. Tier 1 = most
  // Drift-pattern condition matches; Tier 5 = no matches.
  let rating: string;
  if (clampedScore >= 85) rating = 'tier-5';
  else if (clampedScore >= 70) rating = 'tier-4';
  else if (clampedScore >= 50) rating = 'tier-3';
  else if (clampedScore >= 30) rating = 'tier-2';
  else rating = 'tier-1';

  return {
    score: clampedScore,
    rating,
    criticalIssues: critical,
    highRiskIssues: high,
    moderateIssues: moderate,
    positives,
    driftSimilarityScore: driftMatch,
  };
}

function formatUSD(amount: number): string {
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(0)}M`;
  return `$${(amount / 1_000).toFixed(0)}K`;
}
