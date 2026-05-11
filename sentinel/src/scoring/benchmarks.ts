// Threshold and timelock benchmarks anchored to Squads' published Advanced Security Best Practices
// (https://docs.squads.so/main/additional-resources/advanced-security-best-practices).

export const GOLD_STANDARD = {
  // Multisig
  minimumSigners: 4,                // Squads reference: 4/6+
  recommendedSigners: 7,
  minimumThresholdRatio: 0.67,      // Squads reference: 4/6 = 67%
  recommendedThresholdRatio: 0.71,  // 5/7
  instantExecutionThreshold: 1.0,   // All signers required for instant execution

  // Timelocks (scanner-internal scoring bands, not published recommendations)
  minimumTimelockSeconds: 86400,
  recommendedTimelockSeconds: 172800,
  criticalActionTimelockSeconds: 259200,

  // Two-step commit pattern
  // 1. Submit hash of payload to unlock for X days
  // 2. After X days, execute or cancel
  // Lower thresholds only allowed WITH timelock
  // Full threshold (all signers) required for instant execution

  // Permission separation
  requireRoleSeparation: true,
  separateAuthorities: [
    'programUpgrade',
    'adminTransfer',
    'marketCreation',
    'oracleManagement',
    'withdrawalLimits',
    'pauseAuthority',
  ],

  // Circuit breakers (program-level, harder to detect externally)
  requireWithdrawalRateLimits: true,
  requireAutoPauseOnAnomaly: true,
  requireNewMarketDelay: true,
  requireMultiOracleValidation: true,
};

// TVL-based minimum standards
export const TVL_TIERS = [
  {
    label: 'Tier 1',
    minTVL: 500_000_000,  // $500M+
    requirements: {
      minSigners: 7,
      minThreshold: '5/7',
      minTimelockHours: 72,
      requirePermSeparation: true,
      requireCircuitBreakers: true,
      requireIndependentSecurityReview: true,
    },
  },
  {
    label: 'Tier 2',
    minTVL: 100_000_000,  // $100M+
    requirements: {
      minSigners: 5,
      minThreshold: '4/7 or 3/5',
      minTimelockHours: 48,
      requirePermSeparation: true,
      requireCircuitBreakers: true,
    },
  },
  {
    label: 'Tier 3',
    minTVL: 10_000_000,   // $10M+
    requirements: {
      minSigners: 5,
      minThreshold: '3/5',
      minTimelockHours: 24,
      requirePermSeparation: false,
      requireCircuitBreakers: false,
    },
  },
  {
    label: 'Tier 4',
    minTVL: 0,
    requirements: {
      minSigners: 3,
      minThreshold: '2/3',
      minTimelockHours: 0,
      requirePermSeparation: false,
      requireCircuitBreakers: false,
    },
  },
];
