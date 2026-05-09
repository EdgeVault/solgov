// Historical exploits mapped to the governance patterns Sentinel detects
export const EXPLOIT_PRECEDENTS: Record<string, {
  pattern: string;
  examples: Array<{ name: string; date: string; loss: string; detail: string }>;
  prevention: string;
}> = {
  low_threshold: {
    pattern: 'Low multisig threshold',
    examples: [
      { name: 'Drift Protocol', date: 'Apr 2026', loss: '$285M', detail: '2/5 threshold - 2 signers socially engineered' },
      { name: 'Ronin Network', date: 'Mar 2022', loss: '$625M', detail: '5/9 validators compromised by Lazarus Group' },
      { name: 'WazirX', date: 'Jul 2024', loss: '$234M', detail: '2/6 multisig keys compromised' },
      { name: 'Harmony Horizon', date: 'Jun 2022', loss: '$100M', detail: '2/5 multisig - private keys stolen by Lazarus' },
    ],
    prevention: 'Minimum 60% threshold (e.g. 5/7, 4/7). Higher signer count increases attacker cost.',
  },
  zero_timelock: {
    pattern: 'Zero timelock on admin actions',
    examples: [
      { name: 'Drift Protocol', date: 'Apr 2026', loss: '$285M', detail: 'Instant execution - no window to detect or cancel' },
      { name: 'Infini', date: 'Feb 2025', loss: '$49.5M', detail: 'Admin key compromise, instant privilege escalation' },
      { name: 'Radiant Capital', date: 'Oct 2024', loss: '$50M', detail: 'Timelock existed but was only 3 minutes - attacker executed before team noticed' },
    ],
    prevention: 'Minimum 24h timelock on all admin actions. 48-72h for critical operations (program upgrades, authority transfers). Toly: "require all signers for instant commit."',
  },
  no_nonce_monitoring: {
    pattern: 'No durable nonce monitoring',
    examples: [
      { name: 'Drift Protocol', date: 'Apr 2026', loss: '$285M', detail: 'Attacker created nonce accounts on March 23 - a week before execution. Nobody checked.' },
    ],
    prevention: 'Automated monitoring of all multisig signer addresses for new durable nonce accounts. Alert immediately on creation. Toly: "pager duty level requirement."',
  },
  no_circuit_breakers: {
    pattern: 'No circuit breakers or rate limits',
    examples: [
      { name: 'Drift Protocol', date: 'Apr 2026', loss: '$285M', detail: 'Withdrawal limit set to $500 trillion. Protocol drained in under an hour.' },
      { name: 'Mango Markets', date: 'Oct 2022', loss: '$114M', detail: 'No position limits - attacker manipulated oracle then withdrew everything' },
      { name: 'Cream Finance', date: 'Oct 2021', loss: '$130M', detail: 'No borrowing caps - flash loan drained all pools' },
    ],
    prevention: 'Per-epoch withdrawal caps that cannot be overridden by admin. Auto-pause on anomalous activity (>2 std dev from normal volume). New market/asset delay (minimum 24h before collateral-eligible).',
  },
  oracle_failure: {
    pattern: 'Single oracle or no oracle validation',
    examples: [
      { name: 'Drift Protocol', date: 'Apr 2026', loss: '$285M', detail: 'Fake token accepted with manipulated price feed. No multi-oracle requirement.' },
      { name: 'Mango Markets', date: 'Oct 2022', loss: '$114M', detail: 'Single oracle manipulated via spot market trades' },
      { name: 'Cream Finance', date: 'Oct 2021', loss: '$130M', detail: 'Price oracle exploited via flash loan' },
    ],
    prevention: 'Multi-oracle validation (minimum 2 independent sources). TWAP/EWMA resistance to manipulation. Minimum price history before new assets accepted as collateral.',
  },
  admin_god_mode: {
    pattern: 'Single admin key controls all functions',
    examples: [
      { name: 'Drift Protocol', date: 'Apr 2026', loss: '$285M', detail: 'One key controlled market creation, oracle params, withdrawal limits, and admin transfer' },
      { name: 'Cork Protocol', date: '2025', loss: '$12M', detail: 'Permissionless market creation without guardrails' },
      { name: 'Infini', date: 'Feb 2025', loss: '$49.5M', detail: 'Admin privilege escalation - single key controlled everything' },
    ],
    prevention: 'Separate authorities for: program upgrades, market creation, oracle management, withdrawal limits, pause. No single key should control more than one critical function.',
  },
  no_backstop: {
    pattern: 'No incident response plan or insurance',
    examples: [
      { name: 'Drift Protocol', date: 'Apr 2026', loss: '$285M', detail: 'Apparent reliance on Circle to freeze USDC. Circle did not act.' },
      { name: 'Ronin Network', date: 'Mar 2022', loss: '$625M', detail: 'FBI attributed to Lazarus. Only $30M recovered (4.8%).' },
      { name: 'Bybit', date: 'Feb 2025', loss: '$1.5B', detail: '$160M laundered in 48h via Tornado Cash. Minimal recovery.' },
      { name: 'Atomic Wallet', date: 'Jun 2023', loss: '$100M', detail: 'Lazarus-linked. Zero recovery.' },
    ],
    prevention: 'Insurance fund (% of protocol revenue). Bug bounty (minimum $500K for critical). Documented incident response plan with specific roles. Pre-arranged relationship with Circle/Tether for emergency freezes. Never assume an external party will save you - recovery rate across all crypto exploits is under 5%.',
  },
  key_compromise: {
    pattern: 'Private key / signer compromise',
    examples: [
      { name: 'Bybit', date: 'Feb 2025', loss: '$1.5B', detail: 'Supply chain attack - malicious JS injection into signing infrastructure' },
      { name: 'Ronin', date: 'Mar 2022', loss: '$625M', detail: 'Social engineering of validator operators by Lazarus Group' },
      { name: 'WazirX', date: 'Jul 2024', loss: '$234M', detail: 'Multisig key theft - 2 of 6 keys compromised' },
      { name: 'Drift', date: 'Apr 2026', loss: '$285M', detail: '2 of 5 signers socially engineered within 3 days of multisig migration' },
      { name: 'Harmony', date: 'Jun 2022', loss: '$100M', detail: 'Private keys stolen by North Korean hackers' },
    ],
    prevention: 'Hardware wallets only. Dedicated signing device. Never sign transactions you did not initiate. Verify transaction simulation before approving. Assume every unsolicited signing request is an attack.',
  },
};

// The shift: code bugs → human failures
export const EXPLOIT_TREND = {
  summary: 'The attack surface has shifted from code to people',
  data: [
    { period: '2016-2020', primaryVector: 'Smart contract bugs', percentage: '~70% of losses', examples: 'The DAO, Parity, bZx' },
    { period: '2021-2022', primaryVector: 'Bridge exploits + flash loans', percentage: '~60% of losses', examples: 'Wormhole, Ronin, Nomad, Cream' },
    { period: '2023-2024', primaryVector: 'Key compromise + social engineering', percentage: '~55% of losses', examples: 'Atomic, Radiant, WazirX' },
    { period: '2025-2026', primaryVector: 'Admin key compromise', percentage: '~80% of losses', examples: 'Bybit $1.5B, Drift $285M, Infini $49.5M' },
  ],
  insight: '"Code gets audited, so attackers go after keys. Keys get secured, so they go after people. The threat surface never shrinks. It just changes shape."',
};

// Recovery statistics
export const RECOVERY_STATS = {
  averageRecoveryRate: '<5%',
  timeToLaunder: '24-48 hours via Tornado Cash, cross-chain bridges, P2P exchanges',
  circleFreezingRecord: 'Inconsistent - froze Multichain USDC, did NOT freeze Drift USDC despite theft during US business hours',
  lawEnforcementRecord: 'Attribution common, recovery rare. Ronin: FBI identified Lazarus, recovered 4.8%. Bybit: $160M laundered in 48h.',
  bestCase: 'Curve Finance (2023): 73% recovered - only because attacker voluntarily returned funds for bounty + no-prosecution deal',
  worstCase: 'Atomic Wallet (2023): 0% recovered. Lazarus-linked. Funds gone within hours.',
};

export interface ProtocolRemediation {
  protocolName: string;
  immediateActions: string[];
  urgentActions: string[];
  signerGuidelines: string[];
  relevantExploits: Array<{ name: string; loss: string; relevance: string }>;
}

export function generateRemediation(
  protocolName: string,
  threshold: number,
  memberCount: number,
  timeLock: number,
  squadsVersion: 'v4' | 'v3' | null,
  hasCircuitBreakers: boolean,
  hasMultiOracle: boolean,
  hasRoleSeparation: boolean,
  hasBackstop: boolean
): ProtocolRemediation {
  const ratio = threshold / memberCount;
  const immediate: string[] = [];
  const urgent: string[] = [];
  const relevantExploits: Array<{ name: string; loss: string; relevance: string }> = [];

  // Timelock
  if (timeLock === 0) {
    if (squadsVersion === 'v4') {
      immediate.push('Enable 24h+ timelock - single config transaction on Squads V4. No migration needed.');
    } else if (squadsVersion === 'v3') {
      urgent.push('Migrate from Squads V3 to V4 to enable timelocks. V3 is immutable and cannot support this feature.');
    } else {
      urgent.push('Implement timelock on admin actions. Current multisig program may not support this - evaluate migration to Squads V4.');
    }
    relevantExploits.push(
      { name: 'Drift', loss: '$285M', relevance: 'Zero timelock allowed instant execution once 2 signatures collected' },
      { name: 'Radiant', loss: '$50M', relevance: '3-minute timelock was not enough - attacker executed before team could react' }
    );
  }

  // Threshold
  if (ratio <= 0.4) {
    immediate.push(`Raise threshold above 40%. Current ${threshold}/${memberCount} (${Math.round(ratio * 100)}%) is at or below Drift pre-exploit level (2/5 = 40%).`);
    relevantExploits.push(
      { name: 'Drift', loss: '$285M', relevance: `2/5 threshold - attacker only needed 2 compromised signers` },
      { name: 'WazirX', loss: '$234M', relevance: '2/6 threshold - same pattern' }
    );
  } else if (ratio < 0.6) {
    immediate.push(`Consider raising threshold to 60%+. Current ${threshold}/${memberCount} (${Math.round(ratio * 100)}%) is below recommended minimum.`);
  }

  // Signer count
  if (memberCount < 5) {
    immediate.push(`Add more signers. ${memberCount} signers means only ${threshold} compromises needed for full control.`);
    relevantExploits.push(
      { name: 'Ronin', loss: '$625M', relevance: '5/9 validators - Lazarus compromised 5 through social engineering' }
    );
  }

  // Circuit breakers
  if (!hasCircuitBreakers) {
    urgent.push('Implement withdrawal rate limits and auto-pause on anomalous activity.');
    relevantExploits.push(
      { name: 'Drift', loss: '$285M', relevance: 'Withdrawal limit set to $500T. Protocol drained in under 1 hour.' },
      { name: 'Mango Markets', loss: '$114M', relevance: 'No position limits - attacker withdrew everything' }
    );
  }

  // Oracle
  if (!hasMultiOracle) {
    urgent.push('Implement multi-oracle validation (minimum 2 independent price sources).');
    relevantExploits.push(
      { name: 'Mango Markets', loss: '$114M', relevance: 'Single oracle manipulated via spot market trades' }
    );
  }

  // Role separation
  if (!hasRoleSeparation) {
    urgent.push('Separate admin authorities - no single key should control upgrades, oracle params, and withdrawals.');
  }

  // Backstop
  if (!hasBackstop) {
    urgent.push('Establish insurance fund + bug bounty. Do NOT rely on Circle/Tether to freeze funds - recovery rate across crypto exploits is under 5%.');
    relevantExploits.push(
      { name: 'Drift', loss: '$285M', relevance: 'Relied on Circle to freeze USDC. Circle did not act.' },
      { name: 'Bybit', loss: '$1.5B', relevance: '$160M laundered in 48h. Minimal recovery.' }
    );
  }

  // Nonce monitoring (always recommend - no protocol has this)
  immediate.push('Implement durable nonce monitoring on all multisig signer addresses. Alert on any new nonce account creation.');

  // Signer guidelines (always included)
  const signerGuidelines = [
    'Hardware wallet only (Ledger/Trezor) - never use a hot wallet for multisig signing',
    'Dedicated signing device - not the same machine used for email, Discord, or browsing',
    'Never sign a transaction you did not personally initiate or fully understand',
    'Always verify transaction simulation in Squads UI before approving',
    'NEVER click Squads links shared in Discord/Slack/Telegram. Navigate to Squads directly. A compromised group chat can swap the link for a phishing site that captures your signature for a different transaction. This is the exact Bybit attack pattern ($1.5B stolen via compromised Safe UI).',
    'Verify every transaction across THREE independent sources: Squads UI, Range interface, AND Solana Explorer/Solscan. If any source shows different transaction content, stop immediately.',
    'Do not reuse multisig signer keys for any other purpose (DeFi, NFTs, personal)',
    'Zero durable nonce accounts should exist on signer wallets - if one appears, investigate immediately',
    'Enable 2FA on all associated accounts (email, Discord, Telegram, GitHub)',
    'Treat every unsolicited request to sign something as a social engineering attempt',
    'If in doubt, delay. With a timelock, you can always cancel. Without one, you cannot.',
    'Assume you are a target. Drift signers were compromised within 3 days of a multisig migration. The attacker was watching.',
    'High upgrade frequency = higher risk. If your team approves multiple transactions per week, every approval is training you to click without thinking. Slow down. Each signature is a potential $285M decision.',
  ];

  return {
    protocolName,
    immediateActions: immediate,
    urgentActions: urgent,
    signerGuidelines,
    relevantExploits,
  };
}

export function formatRemediationReport(r: ProtocolRemediation): string {
  let out = `# Remediation Report: ${r.protocolName}\n\n`;

  if (r.immediateActions.length > 0) {
    out += `## Immediate Actions (days)\n`;
    r.immediateActions.forEach((a) => { out += `- ${a}\n`; });
    out += `\n`;
  }

  if (r.urgentActions.length > 0) {
    out += `## Urgent Actions (weeks)\n`;
    r.urgentActions.forEach((a) => { out += `- ${a}\n`; });
    out += `\n`;
  }

  if (r.relevantExploits.length > 0) {
    out += `## Why This Matters - Historical Precedent\n`;
    r.relevantExploits.forEach((e) => {
      out += `- **${e.name} (${e.loss})**: ${e.relevance}\n`;
    });
    out += `\n`;
  }

  out += `## Signer Security Guidelines\n`;
  out += `Every multisig signer should follow these practices:\n\n`;
  r.signerGuidelines.forEach((g, i) => { out += `${i + 1}. ${g}\n`; });
  out += `\n`;

  out += `## Recovery Reality Check\n`;
  out += `- Average crypto exploit recovery rate: **under 5%**\n`;
  out += `- Time to launder stolen funds: **24-48 hours** via Tornado Cash + cross-chain bridges\n`;
  out += `- Circle USDC freeze record: **inconsistent** - froze Multichain, did NOT freeze Drift\n`;
  out += `- Law enforcement: attribution is common, recovery is rare (Ronin: 4.8% recovered)\n`;
  out += `- Best case: Curve 2023 - 73% returned because attacker *chose* to accept bounty\n`;
  out += `- **Do not plan for rescue. Plan for prevention.**\n`;

  return out;
}
