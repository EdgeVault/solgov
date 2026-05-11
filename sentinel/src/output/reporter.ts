// This file generates a plain-English markdown summary from protocol scan reports, written to the local reports/ directory.

import type { ProtocolReport } from './templates';

export function generateSummary(
  reports: ProtocolReport[],
  safeMode: boolean = false
): string {
  const critical = reports.filter((r) => r.riskRating === 'tier-1');
  const weak = reports.filter((r) => r.riskRating === 'tier-2');
  const moderate = reports.filter((r) => r.riskRating === 'tier-3');
  const strong = reports.filter((r) => r.riskRating === 'tier-4');
  const excellent = reports.filter((r) => r.riskRating === 'tier-5');
  const errors = reports.filter((r) => r.riskRating === 'ERROR');

  const redactName = (name: string, index: number) =>
    safeMode ? `Protocol-${index + 1}` : name;

  let summary = `# Sentinel Scan - Solana Protocol Governance Report\n\n`;
  summary += `Date: ${new Date().toISOString()}\n`;
  summary += `Protocols scanned: ${reports.length}\n`;
  if (safeMode) {
    summary += `Mode: SAFE MODE - protocol names redacted\n`;
  }
  summary += `\n`;

  // Score distribution
  summary += `## Tier Distribution\n\n`;
  summary += `Tiers are neutral band identifiers based on the count of Drift-pattern conditions matched. Tier 1 = most matches, Tier 5 = no matches.\n\n`;
  summary += `| Tier | Count |\n`;
  summary += `|------|-------|\n`;
  summary += `| Tier 1 | ${critical.length} |\n`;
  summary += `| Tier 2 | ${weak.length} |\n`;
  summary += `| Tier 3 | ${moderate.length} |\n`;
  summary += `| Tier 4 | ${strong.length} |\n`;
  summary += `| Tier 5 | ${excellent.length} |\n`;
  summary += `| ERROR | ${errors.length} |\n`;
  summary += `\n`;

  if (critical.length > 0) {
    summary += `## Tier 1 - ${critical.length} protocol(s) with multiple Drift-pattern matches\n\n`;
    summary += `These protocols' on-chain configurations share multiple conditions with Drift's pre-exploit setup.\n\n`;
    for (let i = 0; i < critical.length; i++) {
      const r = critical[i];
      summary += `### ${redactName(r.name, i)}\n`;
      summary += `Score: ${r.riskScore}/100 | ${r.driftSimilarity}\n`;
      if (!safeMode) summary += `Program: \`${r.programId}\`\n`;
      summary += `Category: ${r.category}\n\n`;
      for (const issue of r.criticalIssues) {
        summary += `- ${issue}\n`;
      }
      for (const issue of r.highRiskIssues) {
        summary += `- ${issue}\n`;
      }
      summary += `\n`;
    }
  }

  if (weak.length > 0) {
    // Split WEAK into "verified no governance" vs "governance unverifiable"
    const verifiedWeak = weak.filter((r) =>
      !r.upgradeAuthority.immutable &&
      r.upgradeAuthority.type === 'single_wallet'
    );
    const unverifiable = weak.filter((r) =>
      r.upgradeAuthority.type !== 'single_wallet' ||
      r.upgradeAuthority.immutable
    );

    if (verifiedWeak.length > 0) {
      summary += `## Tier 2 - ${verifiedWeak.length} protocol(s) with no detectable on-chain governance\n\n`;
      summary += `These protocols' upgrade authorities could not be resolved to any known multisig program `;
      summary += `(Squads V4, Squads V3, SPL Governance, Goki). The authority may use off-chain signing, `;
      summary += `a custom governance mechanism, or genuinely be a single wallet. Manual verification required.\n\n`;
      summary += `**NOTE:** "Governance unverifiable" does NOT mean "no governance exists." `;
      summary += `Some protocols use governance mechanisms that are not detectable by automated on-chain scanning `;
      summary += `(e.g., MPC/TSS key management, Wormhole cross-chain governance, Futarchy, custom programs).\n\n`;
      for (let i = 0; i < verifiedWeak.length; i++) {
        const r = verifiedWeak[i];
        summary += `### ${redactName(r.name, i)}\n`;
        summary += `Score: ${r.riskScore}/100 | ${r.driftSimilarity}\n`;
        if (!safeMode) summary += `Program: \`${r.programId}\`\n`;
        summary += `Status: On-chain governance not verifiable\n\n`;
      }
    }

    if (unverifiable.length > 0) {
      summary += `## Unverifiable - ${unverifiable.length} protocol(s) with unknown governance\n\n`;
      for (let i = 0; i < unverifiable.length; i++) {
        const r = unverifiable[i];
        summary += `### ${redactName(r.name, i)}\n`;
        summary += `Score: ${r.riskScore}/100 | ${r.driftSimilarity}\n`;
        if (!safeMode) summary += `Program: \`${r.programId}\`\n`;
        summary += `\n`;
      }
    }
  }

  // All protocols summary table
  summary += `## All Protocols\n\n`;
  summary += `| ${safeMode ? 'ID' : 'Protocol'} | TVL | Score | Tier | Timelock | Threshold |\n`;
  summary += `|----------|-----|-------|------|----------|----------|\n`;
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    const name = redactName(r.name, i);
    const timelock = r.multisigConfig
      ? `${r.multisigConfig.timeLockHours}h`
      : r.upgradeAuthority.immutable ? 'N/A' : 'Unknown';
    const threshold = r.multisigConfig
      ? r.multisigConfig.threshold
      : r.upgradeAuthority.immutable ? 'Immutable' : 'Unknown';
    summary += `| ${name} | ${r.tvlFormatted} | ${r.riskScore}/100 | ${r.riskRating} | ${timelock} | ${threshold} |\n`;
  }
  summary += `\n`;

  // Methodology
  summary += `## Methodology\n\n`;
  summary += `This scan pulled live on-chain data for each protocol's program upgrade authority, `;
  summary += `Squads V4 multisig configuration (threshold, signers, timelock, permissions), `;
  summary += `and checked all multisig signers for active durable nonce accounts. `;
  summary += `Tier banding is based on how many Drift-pattern conditions an on-chain configuration matches.\n\n`;
  summary += `Additional checks include: non-Squads governance detection (SPL Governance, Goki), `;
  summary += `recent multisig rotation detection (flags config changes within 14 days), `;
  summary += `and on-chain verified build status via Ellipsis Labs verifier.\n\n`;
  summary += `This report summarises scan results for the operator. Output is written to reports/ which is gitignored. `;
  summary += `Whether to share the report is the operator's decision.\n`;

  return summary;
}
