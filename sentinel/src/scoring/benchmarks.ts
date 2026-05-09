// Based on Toly's public proposals on April 2, 2026
// and security researcher consensus post-Drift

export const GOLD_STANDARD = {
  // Multisig
  minimumSigners: 5,
  recommendedSigners: 7,
  minimumThresholdRatio: 0.6,      // 3/5
  recommendedThresholdRatio: 0.71,  // 5/7
  instantExecutionThreshold: 1.0,   // 5/5 - Toly: "require all to sign for instant"

  // Timelocks
  minimumTimelockSeconds: 86400,        // 24 hours
  recommendedTimelockSeconds: 172800,   // 48 hours
  criticalActionTimelockSeconds: 259200, // 72 hours (admin transfer, program upgrade)

  // Toly's two-step commit proposal
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
