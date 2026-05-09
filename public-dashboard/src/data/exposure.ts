import { PROTOCOLS } from './protocols';

export interface ExposureNode {
  name: string;
  role: string;
  governance: string;
  timelock: string;
  activeVoters: string;
  configChanges: number;
  note?: string;
}

export function resolveExposureNode(node: ExposureNode): ExposureNode {
  const live = PROTOCOLS.find(p => p.name === node.name);
  if (!live) return node;
  const voters = live.activeVoters > 0 ? live.activeVoters : live.totalMembers;
  const versionTag = live.version === 'Squads V4' ? ' V4' : live.version === 'Squads V3' ? ' V3' : '';
  return {
    ...node,
    governance: `${live.threshold}/${voters}${versionTag}`,
    timelock: live.timelockLabel,
    activeVoters: `${live.activeVoters || voters}/${voters}`,
  };
}

export interface ProtocolExposure {
  name: string;
  tvl?: string;
  description: string;
  oracles: ExposureNode[];
  collateral: ExposureNode[];
  routing: ExposureNode[];
  settlement: ExposureNode[];
  protocolDisclosed?: string;
}

export const EXPOSURES: Record<string, ProtocolExposure> = {
  'Kamino': {
    name: 'Kamino', tvl: '$1.6B',
    description: 'Lending protocol. Deposits are lent to borrowers. Liquidations flow through Jupiter Agg, which routes volume through both public DEXs and proprietary AMMs.',
    oracles: [
      { name: 'Scope (aggregator)', role: 'Primary oracle aggregator (Pyth + Chainlink + Switchboard + RedStone)', governance: 'Kamino internal', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
      { name: 'Switchboard', role: 'Feed into Scope aggregator', governance: '3/7', timelock: 'None', activeVoters: '0/7', configChanges: 7, note: 'Zero active voters in 90 days' },
    ],
    collateral: [
      { name: 'JitoSOL', role: 'Accepted as collateral', governance: 'Jito DAO (immutable)', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
      { name: 'mSOL', role: 'Accepted as collateral', governance: '6/13 Serum', timelock: 'None', activeVoters: '0/13', configChanges: 0, note: 'No timelock on Serum multisig. Zero active voters in 90 days.' },
      { name: 'Sanctum LSTs', role: 'Accepted as collateral', governance: '6/11 V3', timelock: 'None (V3 limitation)', activeVoters: '0/11', configChanges: 0, note: 'If LSTs lose value, collateral is affected across multiple protocols. V3 cannot add timelock. Zero active voters in 90 days.' },
    ],
    routing: [
      { name: 'Jupiter Agg', role: 'Routes liquidations to DEX pools (on-chain verified)', governance: '4/8 V3', timelock: 'None (V3 limitation)', activeVoters: '0/8', configChanges: 0, note: 'Liquidation paths from multiple protocols route through this aggregator. V3 cannot add timelock. Zero config changes ever. Zero active voters in 90 days.' },
    ],
    settlement: [
      { name: 'Orca', role: 'Liquidated assets sold here (on-chain verified)', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5, note: 'Only 1 of 10 signers active in 90 days' },
      { name: 'Meteora', role: 'Liquidated assets sold here (on-chain verified)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8 (est)', configChanges: 0 },
      { name: 'Raydium', role: 'Liquidated assets sold here (from docs)', governance: '3/4 V4', timelock: '24h', activeVoters: '4/4', configChanges: 0, note: 'Migrated to V4 in April 2026 with 24h timelock. Tracked at FytDrVz vault.' },
    ],
  },
  'Drift': {
    name: 'Drift', tvl: '$246M',
    description: 'Perpetual trading protocol. Funds sit in vaults that counterparty against traders. On-chain analysis shows 58% of transactions involve Voltr (yield vault protocol, Squads V4 governance).',
    oracles: [
      { name: 'Pyth', role: 'Primary price feed', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
      { name: 'Switchboard', role: 'Backup price feed', governance: '3/7', timelock: 'None', activeVoters: '0/7', configChanges: 7, note: 'Zero active voters' },
    ],
    collateral: [
      { name: 'USDC', role: 'Primary collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
      { name: 'SOL', role: 'Trading collateral', governance: 'Native asset', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
      { name: 'JitoSOL', role: 'Accepted as collateral', governance: 'Jito DAO (immutable)', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
      { name: 'mSOL', role: 'Accepted as collateral', governance: '6/13 Serum', timelock: 'None', activeVoters: '0/13', configChanges: 0 },
    ],
    routing: [
      { name: 'Internal AMM', role: 'Drift handles liquidations internally', governance: 'Same as Drift', timelock: 'None', activeVoters: '3/5', configChanges: 0 },
      { name: 'Voltr', role: 'Yield vault protocol. 58% of Drift txs involve Voltr (on-chain verified). Voltr also routes to Kamino (50%), Jupiter Agg (69%), Project 0 (20%).', governance: 'Squads V4 (verified via tx)', timelock: 'Unknown', activeVoters: 'Unknown', configChanges: 0 },
    ],
    settlement: [],
  },
  'Solstice': {
    name: 'Solstice', tvl: '$357M',
    description: 'Institutional yield vault. USDC/USDT earns yield through delta-neutral trading strategies. On-chain sampling (40 txs) shows zero routing to external protocols.',
    oracles: [
      { name: 'Pyth', role: 'Price feeds for strategy', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
      { name: 'Chainlink', role: 'Proof of Reserves', governance: 'External', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Vault collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
      { name: 'USDT', role: 'Vault collateral', governance: 'Tether', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
    protocolDisclosed: 'Solstice disclosed indirect exposure: LSTs and stables are composable with Kamino, Loopscale, and Exponent. Not directly exposed to other protocol failures, but DEX LP sell pressure from those protocols could affect asset prices.',
  },
  'Jupiter Lend': {
    name: 'Jupiter Lend', tvl: '$1.65B',
    description: 'Lending protocol. Deposits are lent to borrowers. Liquidations flow through Jupiter Agg, which routes volume through both public DEXs and proprietary AMMs.',
    oracles: [
      { name: 'Pyth', role: 'Primary price feed', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
      { name: 'Chainlink', role: 'Secondary feed', governance: 'External', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
      { name: 'RedStone', role: 'Additional feed', governance: 'External', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Primary collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
      { name: 'JitoSOL', role: 'Accepted as collateral', governance: 'Jito DAO', timelock: 'DAO governance', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [
      { name: 'Jupiter Agg', role: 'Routes liquidations', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0, note: 'V3 cannot add timelock. Zero config changes. Zero active voters in 90 days.' },
    ],
    settlement: [
      { name: 'Orca', role: 'Terminal DEX', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5, note: '1/10 active voters' },
      { name: 'Raydium', role: 'Terminal DEX', governance: '3/4 V4', timelock: '24h', activeVoters: '4/4', configChanges: 0, note: 'Migrated to V4 in April 2026 with 24h timelock. Tracked at FytDrVz vault.' },
    ],
  },
  'Lulo': {
    name: 'Lulo', tvl: '$92M',
    description: 'Yield aggregator. Routes deposits to lending protocols for best rate. On-chain sampling (60 txs, April 10) shows 82% routed to Kamino kLend, 0% to any other destination.',
    oracles: [],
    collateral: [],
    routing: [
      { name: 'Kamino', role: '82% of sampled txs route here (on-chain verified, 49/60 txs)', governance: '5/10', timelock: '12h', activeVoters: '7/10', configChanges: 13 },
      { name: 'Project 0', role: 'Listed in docs as routing target. 0/60 sampled txs routed here.', governance: '7/13', timelock: 'None', activeVoters: '10/13', configChanges: 13, note: 'No timelock. Not observed in on-chain sample. Formerly marginfi.' },
      { name: 'Drift', role: 'Confirmed historical routing (downstream exploit losses). 0/60 current txs.', governance: '3/5', timelock: 'None', activeVoters: '3/5', configChanges: 0, note: 'Recovery multisig created April 2, 2026. Zero timelock. Zero config changes.' },
      { name: 'Save (Solend)', role: 'Listed in docs as routing target. 0/60 sampled txs routed here.', governance: 'Single signer', timelock: 'None', activeVoters: '1/1', configChanges: 0, note: 'Single signer governance. Not observed in on-chain sample.' },
      { name: 'Jupiter Lend', role: 'Listed in docs as routing target. Not in on-chain sample.', governance: '4/7', timelock: '12h', activeVoters: '5/7', configChanges: 14 },
    ],
    settlement: [],
  },
  'Project 0': {
    name: 'Project 0', tvl: '$51M',
    description: 'Lending protocol, formerly marginfi. Project 0 took over operations Sep 2025 and retained the same Squads V4 multisig and on-chain programs. Deposits are lent to borrowers. Third-party liquidators handle liquidations.',
    oracles: [
      { name: 'Pyth', role: 'Primary oracle', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
      { name: 'Switchboard', role: 'Oracle for unsupported assets', governance: '3/7', timelock: 'None', activeVoters: '0/7', configChanges: 7, note: 'Zero active voters in 90 days' },
    ],
    collateral: [
      { name: 'USDC', role: 'Primary collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
      { name: 'JitoSOL', role: 'Accepted as collateral', governance: 'Jito DAO', timelock: 'DAO governance', activeVoters: 'External', configChanges: 0 },
      { name: 'mSOL', role: 'Accepted as collateral', governance: '6/13 Serum', timelock: 'None', activeVoters: '0/13', configChanges: 0, note: 'No timelock on Serum multisig. Zero active voters in 90 days.' },
    ],
    routing: [],
    settlement: [],
  },
  'Orca': {
    name: 'Orca', tvl: '$240M',
    description: 'DEX. Liquidity pools where trades and liquidations settle.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Huma Finance': {
    name: 'Huma Finance', tvl: '$100M+',
    description: 'PayFi protocol. Payment financing for cross-border settlements and credit. On-chain analysis shows 85% of transactions involve Orca.',
    oracles: [
      { name: 'Pyth', role: 'Price feeds', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Primary collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [
      { name: 'Orca', role: '85% of txs settle on Orca (on-chain verified, 29/34 txs)', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5 },
    ],
  },
  'Jupiter Perps': {
    name: 'Jupiter Perps',
    description: 'Perpetual trading. Positions held against JLP pool at oracle prices. Triple oracle system.',
    oracles: [
      { name: 'Edge (Chaos Labs)', role: 'Primary oracle (Dove Oracle)', governance: 'Chaos Labs', timelock: 'External', activeVoters: 'External', configChanges: 0 },
      { name: 'Chainlink', role: 'Verification oracle', governance: 'External', timelock: 'External', activeVoters: 'External', configChanges: 0 },
      { name: 'Pyth', role: 'Verification oracle', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Pool collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
  },
  'Pumpfun + PumpSwap': {
    name: 'Pumpfun + PumpSwap',
    description: 'Token launch platform and DEX. Bonding curve mechanics.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [
      { name: 'Meteora', role: '43% of txs settle here (on-chain verified, 26/60 txs)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
      { name: 'Orca', role: '7% of txs settle here (on-chain verified, 4/60 txs)', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5 },
    ],
  },
  'Magic Eden': {
    name: 'Magic Eden',
    description: 'NFT marketplace. No lending or routing dependencies.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Exponent': {
    name: 'Exponent',
    description: 'Yield trading protocol. On-chain sampling (40 txs) shows zero routing to external protocols.',
    oracles: [
      { name: 'Pyth', role: 'Price feeds', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
  },
  'Nosana': {
    name: 'Nosana',
    description: 'Decentralised compute network. Not a DeFi lending/trading protocol.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Stabble': {
    name: 'Stabble',
    description: 'Stablecoin swap protocol.',
    oracles: [],
    collateral: [],
    routing: [
      { name: 'Jupiter Agg', role: '27% of txs route through Jupiter (on-chain verified, 16/60 txs)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
    ],
    settlement: [
      { name: 'Orca', role: '37% of txs settle on Orca (on-chain verified, 22/60 txs)', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5 },
      { name: 'Meteora', role: '23% of txs settle on Meteora (on-chain verified, 14/60 txs)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
      { name: 'Raydium', role: '15% of txs settle on Raydium (on-chain verified, 9/60 txs)', governance: '3/4 V4', timelock: '24h', activeVoters: '4/4', configChanges: 0, note: 'Migrated to V4 with 24h timelock April 2026.' },
    ],
  },
  'Hylo': {
    name: 'Hylo',
    description: 'Stablecoin and leveraged token protocol. hyUSD backed by LST basket, xSOL for leveraged SOL. Oracle-free by design - uses internal pricing from LST collateral pool.',
    oracles: [],
    collateral: [
      { name: 'JitoSOL', role: 'LST collateral backing hyUSD', governance: 'Jito DAO (immutable)', timelock: 'N/A', activeVoters: 'External', configChanges: 0 },
      { name: 'mSOL', role: 'LST collateral backing hyUSD', governance: '6/13 Serum', timelock: 'None', activeVoters: '0/13', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
  },
  'Loopscale': {
    name: 'Loopscale',
    description: 'Lending protocol. Order book-based, auction liquidations, does not route through Jupiter Agg.',
    oracles: [
      { name: 'Pyth', role: 'Primary price feed (EMA for loans, spot for liquidations)', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
  },
  'Switchboard': {
    name: 'Switchboard',
    description: 'Oracle network. Provides price feeds to other protocols.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Titan': {
    name: 'Titan',
    description: 'Meta DEX aggregator. Aggregates other aggregators (including Jupiter) and its own Argos router for optimal swap execution.',
    oracles: [],
    collateral: [],
    routing: [
      { name: 'Jupiter Agg', role: 'Primary aggregator source (from docs)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
    ],
    settlement: [],
  },
  'Solayer': {
    name: 'Solayer',
    description: 'Restaking protocol.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Flash Trade': {
    name: 'Flash Trade',
    description: 'Perpetual trading. Internal liquidation pool, does not route through Jupiter Agg.',
    oracles: [
      { name: 'Pyth', role: 'Price feeds', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
  },
  'Wick': {
    name: 'Wick',
    description: 'Lending protocol. Recently launched (April 2026).',
    oracles: [],
    collateral: [],
    routing: [
      { name: 'Jupiter Agg', role: '82% of txs route through Jupiter (on-chain verified, 49/60 txs)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
    ],
    settlement: [
      { name: 'Orca', role: '55% of txs settle on Orca (on-chain verified, 33/60 txs)', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5 },
    ],
  },
  'Sanctum': {
    name: 'Sanctum',
    description: 'LST issuer. Sanctum LSTs are used as collateral across Kamino, Project 0, Jupiter, and Orca.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [
      { name: 'Meteora', role: '15% of txs settle on Meteora (on-chain verified, 9/60 txs)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
      { name: 'Orca', role: '5% of txs settle on Orca (on-chain verified, 3/60 txs)', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5 },
      { name: 'Raydium', role: '3% of txs settle on Raydium (on-chain verified, 2/60 txs)', governance: '3/4 V4', timelock: '24h', activeVoters: '4/4', configChanges: 0, note: 'Migrated to V4 with 24h timelock April 2026.' },
    ],
  },
  'Jupiter Agg': {
    name: 'Jupiter Agg',
    description: 'DEX aggregator. Routes swaps and liquidations across public DEXs and proprietary AMMs. On-chain analysis shows significant volume goes through proprietary AMMs. Governance varies: Tessera V uses Squads V4, BisonFi and HumidiFi use single key authorities.',
    oracles: [],
    collateral: [],
    routing: [
      { name: 'BisonFi', role: '55% of sampled txs (on-chain verified, 55/100 txs). Proprietary AMM.', governance: 'Unknown', timelock: 'Unknown', activeVoters: 'Unknown', configChanges: 0, note: 'Proprietary AMM. No public governance. No verified build. No public frontend.' },
      { name: 'Tessera V', role: '45% of sampled txs (on-chain verified, 45/100 txs). Dark AMM operated by Wintermute.', governance: 'Squads V4 (verified via tx)', timelock: 'Unknown', activeVoters: 'Unknown', configChanges: 0, note: 'Proprietary dark AMM. Squads V4 multisig confirmed for upgrades. No verified build.' },
      { name: 'HumidiFi', role: '37% of sampled txs (on-chain verified, 37/100 txs).', governance: 'Unknown', timelock: 'Unknown', activeVoters: 'Unknown', configChanges: 0, note: 'Proprietary AMM. No public governance. No verified build.' },
    ],
    settlement: [
      { name: 'Orca', role: 'Swaps settle on Orca pools (on-chain verified)', governance: '3/10', timelock: '24h', activeVoters: '1/10', configChanges: 5, note: '1 of 10 signers active in 90 days' },
      { name: 'Raydium', role: 'Swaps settle on Raydium pools (from docs)', governance: '3/4 V4', timelock: '24h', activeVoters: '4/4', configChanges: 0, note: 'Migrated to V4 with 24h timelock April 2026.' },
      { name: 'Meteora', role: 'Swaps settle on Meteora DLMM (on-chain verified)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
      { name: 'Phoenix DEX', role: 'Swaps settle on Phoenix CLOB (from docs)', governance: '2/5 V3', timelock: 'None (V3)', activeVoters: '0/5 (est)', configChanges: 0 },
    ],
  },
  'Raydium': {
    name: 'Raydium',
    description: 'DEX. Liquidity pools where trades and liquidations settle.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Tensor': {
    name: 'Tensor',
    description: 'NFT marketplace and AMM. No DeFi lending dependencies.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Phoenix DEX': {
    name: 'Phoenix DEX',
    description: 'Central limit order book DEX. Terminal settlement venue.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Meteora': {
    name: 'Meteora',
    description: 'DEX with dynamic vaults. DAMM v1 routes idle liquidity through Dynamic Vaults. DLMM does not route.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Parcl': {
    name: 'Parcl',
    description: 'Real estate perpetuals. Internal LP pool for liquidations.',
    oracles: [
      { name: 'Pyth', role: 'Price feeds', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
    ],
    collateral: [
      { name: 'USDC', role: 'Collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
  },
  'Marinade': {
    name: 'Marinade',
    description: 'Liquid staking. mSOL is used as collateral across Kamino, Project 0, Drift, Jupiter Lend, and Save. mSOL price derived from Pyth and Switchboard.',
    oracles: [
      { name: 'Pyth', role: 'mSOL price feed', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
      { name: 'Switchboard', role: 'mSOL price feed', governance: '3/7', timelock: 'None', activeVoters: '0/7', configChanges: 7, note: 'Zero active voters in 90 days' },
    ],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Pyth': {
    name: 'Pyth',
    description: 'Oracle network. Provides price feeds to 13+ Solana DeFi protocols. Custom governance via Pythian Council with staking-based voting.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Jito': {
    name: 'Jito',
    description: 'Liquid staking and MEV. JitoSOL used as collateral across 9 protocols. DAO governed.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Save (Solend)': {
    name: 'Save (Solend)',
    description: 'Lending protocol. Single signer governance. Receives routed funds from Lulo and Meteora Dynamic Vaults.',
    oracles: [
      { name: 'Pyth', role: 'Primary price feed', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
      { name: 'Switchboard', role: 'Backup feed', governance: '3/7', timelock: 'None', activeVoters: '0/7', configChanges: 7, note: 'Zero active voters in 90 days' },
    ],
    collateral: [
      { name: 'USDC', role: 'Collateral', governance: 'Circle (regulated)', timelock: 'Legal process', activeVoters: 'External', configChanges: 0 },
    ],
    routing: [],
    settlement: [],
  },
  'Zebec': {
    name: 'Zebec',
    description: 'Payment streaming protocol. Single signer governance.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'BisonFi': {
    name: 'BisonFi',
    description: 'Proprietary AMM operated by Forward Industries (NASDAQ). Single key upgrade authority. No audit, no governance, no verified build. Receives 55% of Jupiter Agg swap volume.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Tessera V': {
    name: 'Tessera V',
    description: 'Proprietary dark AMM operated by Wintermute. Squads V4 multisig for upgrades (verified via tx analysis). No audit, no verified build. Receives 45% of Jupiter Agg swap volume.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'HumidiFi': {
    name: 'HumidiFi',
    description: 'Proprietary AMM linked to Temporal (DL News). Handles ~35% of all Solana DEX volume. Single key upgrade authority. No audit, no governance, no verified build.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Voltr': {
    name: 'Voltr',
    description: 'Yield vault protocol acquired by Ranger Finance (Nov 2025). Squads V4 multisig for upgrades (verified via tx analysis). No audit, beta stage. Transactions touch multiple protocols per tx (percentages overlap).',
    oracles: [],
    collateral: [],
    routing: [
      { name: 'Jupiter Agg', role: '69% of txs route through Jupiter (on-chain verified)', governance: '4/8 V3', timelock: 'None (V3)', activeVoters: '0/8', configChanges: 0 },
      { name: 'Kamino', role: '50% of txs route to Kamino kLend (on-chain verified)', governance: '5/10', timelock: '12h', activeVoters: '7/10', configChanges: 13 },
      { name: 'Project 0', role: '20% of txs route to Project 0 (formerly marginfi, on-chain verified)', governance: '7/13', timelock: 'None', activeVoters: '10/13', configChanges: 13 },
      { name: 'Drift', role: '20% of txs route to Drift (on-chain verified)', governance: '3/5', timelock: 'None', activeVoters: '3/5', configChanges: 0 },
    ],
    settlement: [],
  },
  'Photon': {
    name: 'Photon',
    description: 'Trading bot. Single key upgrade authority, no verified build. 75% of transactions route to Pumpfun. 52 upgrades since March 2024.',
    oracles: [],
    collateral: [],
    routing: [
      { name: 'Pumpfun + PumpSwap', role: '75% of txs route to Pumpfun (on-chain verified)', governance: '3/4', timelock: 'None', activeVoters: '4/4', configChanges: 16 },
    ],
    settlement: [],
  },
  'PancakeSwap': {
    name: 'PancakeSwap',
    description: 'BSC-origin DEX with Solana deployment. Receives 19% of Jupiter Agg swap volume (on-chain verified). Single/PDA upgrade authority.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Onre Finance': {
    name: 'Onre Finance',
    description: 'DeFi protocol on Solana. Squads V4 multisig for upgrades (verified via tx analysis). Last upgraded March 4, 2026.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'deBridge': {
    name: 'deBridge',
    description: 'Cross-chain bridge. Solana program upgrades are routed through a custom deBridge governance program that invoke_signs a program-derived upgrade authority. The governance program itself is controlled by Squads V4 multisig at threshold 2 of 3 with zero timelock (on-chain verified, April 2026). 12-node validator network (8/12 threshold) secures cross-chain messaging separately. 10+ Solana audits (Halborn, Neodyme, Ackee). No verified build. Bug bounty covers EVM only, not Solana.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'MetaDAO': {
    name: 'MetaDAO',
    description: 'Futarchy governance protocol. Uses prediction markets for decision-making. Squads V4 multisig (verified). Verified build on futarchy and AMM programs.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Helium': {
    name: 'Helium',
    description: 'Decentralised wireless network. Squads V4 multisig for entity manager program (verified via tx analysis).',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'SPL Stake Pool': {
    name: 'SPL Stake Pool',
    description: 'Core Solana program for liquid staking pools. Controls most stake pools outside Marinade and Sanctum. ~$3.5B TVL. Governed by 6/10 Squads V3 multisig. Audited by Halborn, Neodyme, and Quantstamp.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'LayerZero OFT': {
    name: 'LayerZero OFT',
    description: 'Cross-chain messaging protocol. OFT program handles omnichain fungible token bridging on Solana. 1/2 threshold with only 1 member able to vote and execute, so it is effectively a single signer. Verified build. Audited by Zellic, Trail of Bits, ABDK.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'SolvBTC': {
    name: 'SolvBTC',
    description: 'Bitcoin reserve protocol. Wraps BTC for cross-chain DeFi. 3/5 Squads V4 for program upgrades, but SolvBTC mint authority is a separate 1/2 SPL Token multisig. $2.7M exploit March 2026 (EVM chain). Verified build. Audited by OpenZeppelin, Quantstamp.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'GMSOL': {
    name: 'GMSOL',
    description: 'GMX V2 fork on Solana (GMTrade). 3rd largest perp DEX. Two Squads multisigs: 4/7 core with 10min timelock, 2/3 deployment with 1h timelock. 10 distinct signer keys, no overlap. GMX DAO approved. 8 audits in 16 months. Verified build.',
    oracles: [
      { name: 'Pyth', role: 'Price feeds for perpetual markets', governance: '13/19 Wormhole guardians', timelock: 'Guardian consensus', activeVoters: '19 guardians on-chain', configChanges: 0 },
    ],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Ore': {
    name: 'Ore',
    description: 'Proof-of-work mining protocol on Solana. 2/4 Squads V4 multisig but only 2 of 4 signers are active. 1 signer is propose-only, 1 has never transacted. 200+ txs in 6 weeks. No timelock. Founded by HardhatChad.',
    oracles: [],
    collateral: [],
    routing: [],
    settlement: [],
  },
  'Neutral Trade': {
    name: 'Neutral Trade',
    description: 'Yield strategies on Drift Vaults. $17M TVL. No independent on-chain program, all activity routes through Drift. Lost $3.67M in Drift exploit.',
    oracles: [], collateral: [], routing: [], settlement: [],
  },
  'Vectis Finance': {
    name: 'Vectis Finance',
    description: 'Delta-neutral vaults on Drift. $11M TVL. No independent on-chain program. Lost $1.69M in Drift exploit.',
    oracles: [], collateral: [], routing: [], settlement: [],
  },
  'HawkFi': {
    name: 'HawkFi',
    description: 'LP automation for Meteora DLMM and Orca CLMM. $8M TVL. No independent on-chain program.',
    oracles: [], collateral: [], routing: [], settlement: [],
  },
  'Perena': {
    name: 'Perena',
    description: 'Vault infrastructure and Numeraire AMM. $14M TVL. Routes deposits to lending protocols.',
    oracles: [], collateral: [], routing: [], settlement: [],
  },
  'Carrot': {
    name: 'Carrot',
    description: 'Yield vaults and lending. $11M TVL. Squads V4 multisig (2/3, no timelock). Lost $8.4M in Drift exploit.',
    oracles: [], collateral: [], routing: [], settlement: [],
  },
};

export const EXPOSURE_PROTOCOLS = Object.keys(EXPOSURES);
