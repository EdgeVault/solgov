import { PublicKey } from '@solana/web3.js';

// Squads Multisig Programs
export const SQUADS_V4_PROGRAM = new PublicKey(
  'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'
);
export const SQUADS_V3_PROGRAM = new PublicKey(
  'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu'
);

// SPL Governance Programs
export const SPL_GOVERNANCE_V1 = new PublicKey(
  'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw'
);
export const SPL_GOVERNANCE_V2 = new PublicKey(
  'GovHgfDPyQ1GwjFhNkMqZdnuDBvRqoRmczNo48pBZqn'
);

// Other Known Governance Programs
export const GOKI_SMART_WALLET = new PublicKey(
  'gUALZYRtLVEFP3JCG43bscTv2cMnNtaHwyoaQTGjatP'
);

// Serum Multisig (2021-era, used by Marinade and other early Solana protocols)
export const SERUM_MULTISIG = new PublicKey(
  'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHUwaYqnt'
);

// Wormhole governance (used by Pyth for cross-chain governance)
export const WORMHOLE_CORE = new PublicKey(
  'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
);

// Squads V3 alternative program ID (seen in Pyth txs)
export const SQUADS_V3_ALT = new PublicKey(
  'SMPLVC8MxZ5Bf5EfF7PaMiTCxoBAcmkbM2vkrvMK8ho'
);

// System Program (EOA indicator)
export const SYSTEM_PROGRAM = new PublicKey(
  '11111111111111111111111111111111'
);

// BPF Upgradeable Loader
export const BPF_UPGRADEABLE_LOADER = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111'
);

// Ellipsis Labs Verified Build Program
export const VERIFY_PROGRAM = new PublicKey(
  'veriCDEvUwJjBcumw3FUDPkHB8NUqoakxGhRbiJhTwj'
);

// Known governance program ID → name mapping
export const KNOWN_GOVERNANCE_PROGRAMS: Record<string, string> = {
  [SQUADS_V4_PROGRAM.toBase58()]: 'Squads V4',
  [SQUADS_V3_PROGRAM.toBase58()]: 'Squads V3 (Legacy)',
  [SQUADS_V3_ALT.toBase58()]: 'Squads V3 (Alt)',
  [SPL_GOVERNANCE_V1.toBase58()]: 'SPL Governance (Realms)',
  [SPL_GOVERNANCE_V2.toBase58()]: 'SPL Governance V2',
  [GOKI_SMART_WALLET.toBase58()]: 'Goki Smart Wallet',
  [SERUM_MULTISIG.toBase58()]: 'Serum Multisig (Legacy 2021)',
  [WORMHOLE_CORE.toBase58()]: 'Wormhole Governance',
  [SYSTEM_PROGRAM.toBase58()]: 'System Program (likely EOA)',
};

// Programs that count as multisig-equivalent governance
export const MULTISIG_EQUIVALENT_PROGRAMS = new Set([
  SQUADS_V4_PROGRAM.toBase58(),
  SQUADS_V3_PROGRAM.toBase58(),
  SQUADS_V3_ALT.toBase58(),
  SPL_GOVERNANCE_V1.toBase58(),
  SPL_GOVERNANCE_V2.toBase58(),
  GOKI_SMART_WALLET.toBase58(),
  SERUM_MULTISIG.toBase58(),
  WORMHOLE_CORE.toBase58(),
]);

// RPC configuration
export const DELAY_BETWEEN_PROTOCOLS = 2000; // ms
export const DELAY_BETWEEN_CALLS = 500;     // ms
export const NONCE_TIMEOUT_MS = 10000;      // 10s timeout for nonce detection
export const MAX_NONCE_RESULTS = 20;        // cap nonce results per signer
export const MAX_RETRIES = 3;               // retry count for RPC calls
export const RETRY_BASE_DELAY = 1000;       // ms - base delay for exponential backoff
