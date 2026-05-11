// Shape definitions for protocol report cards (sentinel/src/output).

export interface ProtocolReport {
  name: string;
  programId: string;
  category: string;
  tvl: number | null;
  tvlFormatted: string;
  scanDate: string;
  upgradeAuthority: {
    immutable: boolean;
    type: string; // 'immutable' | 'squads_v4' | 'squads_v3' | 'spl_governance' | 'single_wallet' | 'unknown'
    address: string | null;
    isVaultPDA: boolean;
    parentMultisig?: string;
  };
  multisigConfig: {
    threshold: string;       // "3/5"
    timeLockHours: number;
    roleSeparation: boolean;
    signerCount: number;
    members: Array<{
      key: string;
      permissionsReadable: string[];
    }>;
  } | null;
  nonceAlert: boolean;
  nonceDetails: string | null;
  noncesTimedOut: boolean;
  rotationAlert: boolean;
  rotationDetails: string | null;
  verifiedBuild: boolean;
  riskScore: number;
  riskRating: string;
  driftSimilarity: string; // "X/8 Drift attack patterns match"
  criticalIssues: string[];
  highRiskIssues: string[];
  moderateIssues: string[];
  positives: string[];
  error?: string;
}

export function formatTVL(tvl: number | null): string {
  if (tvl === null) return 'Unknown';
  if (tvl >= 1_000_000_000) return `$${(tvl / 1_000_000_000).toFixed(1)}B`;
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(0)}M`;
  if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(0)}K`;
  return `$${tvl.toFixed(0)}`;
}

export function createEmptyReport(
  name: string,
  programId: string,
  category: string,
  error: string,
  tvl: number | null = null
): ProtocolReport {
  return {
    name,
    programId,
    category,
    tvl,
    tvlFormatted: formatTVL(tvl),
    scanDate: new Date().toISOString(),
    upgradeAuthority: {
      immutable: false,
      type: 'unknown',
      address: null,
      isVaultPDA: false,
    },
    multisigConfig: null,
    nonceAlert: false,
    nonceDetails: null,
    noncesTimedOut: false,
    rotationAlert: false,
    rotationDetails: null,
    verifiedBuild: false,
    riskScore: 0,
    riskRating: 'ERROR',
    driftSimilarity: '0/8 Drift attack patterns match',
    criticalIssues: ['Scan failed'],
    highRiskIssues: [],
    moderateIssues: [],
    positives: [],
    error,
  };
}
