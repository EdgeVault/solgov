// This file builds the connection graph for the Blast Radius view. It maps every oracle, collateral, routing, and settlement relationship between tracked protocols with verification source and caveats.

export interface Relationship {
  protocol: string;
  type: 'oracle' | 'collateral' | 'routing' | 'settlement' | 'lending';
  direction: 'upstream' | 'downstream';
  detail: string;
  verified: 'on-chain' | 'docs' | 'news';
  caveat?: string;
}

export const RELATIONSHIPS: Record<string, Relationship[]> = {
  'Pyth': [
    { protocol: 'Kamino', type: 'oracle', direction: 'upstream', detail: 'Provides price feeds via Scope aggregator', verified: 'docs' },
    { protocol: 'Drift', type: 'oracle', direction: 'upstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Project 0', type: 'oracle', direction: 'upstream', detail: 'Secondary price feed', verified: 'docs' },
    { protocol: 'Jupiter Perps', type: 'oracle', direction: 'upstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Jupiter Lend', type: 'oracle', direction: 'upstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Save (Solend)', type: 'oracle', direction: 'upstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Loopscale', type: 'oracle', direction: 'upstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Flash Trade', type: 'oracle', direction: 'upstream', detail: 'Price feed', verified: 'docs' },
    { protocol: 'Solstice', type: 'oracle', direction: 'upstream', detail: 'Price feeds for strategy', verified: 'docs' },
    { protocol: 'Exponent', type: 'oracle', direction: 'upstream', detail: 'Price feed', verified: 'docs' },
    { protocol: 'Parcl', type: 'oracle', direction: 'upstream', detail: 'Price feed', verified: 'docs' },
  ],
  'Switchboard': [
    { protocol: 'Drift', type: 'oracle', direction: 'upstream', detail: 'Backup price feed', verified: 'docs' },
    { protocol: 'Project 0', type: 'oracle', direction: 'upstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Save (Solend)', type: 'oracle', direction: 'upstream', detail: 'Backup price feed', verified: 'docs' },
    { protocol: 'Kamino', type: 'oracle', direction: 'upstream', detail: 'Feed into Scope aggregator', verified: 'docs' },
    { protocol: 'Loopscale', type: 'oracle', direction: 'upstream', detail: 'Backup price feed', verified: 'docs' },
  ],

  'Jito': [
    { protocol: 'Kamino', type: 'collateral', direction: 'upstream', detail: 'JitoSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Project 0', type: 'collateral', direction: 'upstream', detail: 'JitoSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Drift', type: 'collateral', direction: 'upstream', detail: 'JitoSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Jupiter Lend', type: 'collateral', direction: 'upstream', detail: 'JitoSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Save (Solend)', type: 'collateral', direction: 'upstream', detail: 'JitoSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Loopscale', type: 'collateral', direction: 'upstream', detail: 'JitoSOL accepted as collateral', verified: 'docs' },
  ],
  'Marinade': [
    { protocol: 'Kamino', type: 'collateral', direction: 'upstream', detail: 'mSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Project 0', type: 'collateral', direction: 'upstream', detail: 'mSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Drift', type: 'collateral', direction: 'upstream', detail: 'mSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Jupiter Lend', type: 'collateral', direction: 'upstream', detail: 'mSOL accepted as collateral', verified: 'docs' },
    { protocol: 'Save (Solend)', type: 'collateral', direction: 'upstream', detail: 'mSOL accepted as collateral', verified: 'docs' },
  ],
  'Sanctum': [
    { protocol: 'Kamino', type: 'collateral', direction: 'upstream', detail: 'Sanctum LSTs accepted as collateral', verified: 'docs' },
    { protocol: 'Project 0', type: 'collateral', direction: 'upstream', detail: 'Sanctum LSTs accepted as collateral', verified: 'docs' },
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Sanctum LSTs swapped through Jupiter', verified: 'docs' },
  ],

  'Jupiter Agg': [
    { protocol: 'Kamino', type: 'routing', direction: 'upstream', detail: 'Routes Kamino liquidations to DEX pools', verified: 'on-chain' },
    { protocol: 'Jupiter Lend', type: 'routing', direction: 'upstream', detail: 'Routes Jupiter Lend liquidations', verified: 'docs' },
    { protocol: 'Save (Solend)', type: 'routing', direction: 'upstream', detail: 'Routes Save liquidations', verified: 'docs' },
    { protocol: 'Project 0', type: 'routing', direction: 'upstream', detail: 'Routes Project 0 liquidations to DEX pools', verified: 'docs' },
    { protocol: 'Loopscale', type: 'routing', direction: 'upstream', detail: 'Routes Loopscale liquidations to DEX pools', verified: 'docs' },
    { protocol: 'Voltr', type: 'routing', direction: 'upstream', detail: '69% of Voltr vault transactions route through Jupiter (on-chain verified)', verified: 'on-chain' },
    { protocol: 'GMSOL', type: 'routing', direction: 'upstream', detail: 'GMTrade liquidations route through Jupiter', verified: 'docs' },
    { protocol: 'BisonFi', type: 'routing', direction: 'downstream', detail: '55% of volume routes to BisonFi prop AMM (on-chain verified)', verified: 'on-chain' },
    { protocol: 'Tessera V', type: 'routing', direction: 'downstream', detail: '45% of volume routes to Tessera V / Wintermute (on-chain verified)', verified: 'on-chain' },
    { protocol: 'HumidiFi', type: 'routing', direction: 'downstream', detail: '37% of volume routes to HumidiFi prop AMM (on-chain verified)', verified: 'on-chain' },
    { protocol: 'PancakeSwap', type: 'routing', direction: 'downstream', detail: '19% of volume routes to PancakeSwap (on-chain verified)', verified: 'on-chain' },
    { protocol: 'Orca', type: 'settlement', direction: 'downstream', detail: 'Swaps settle on Orca Whirlpools', verified: 'on-chain' },
    { protocol: 'Raydium', type: 'settlement', direction: 'downstream', detail: 'Swaps settle on Raydium pools', verified: 'docs' },
    { protocol: 'Meteora', type: 'settlement', direction: 'downstream', detail: 'Swaps settle on Meteora DLMM', verified: 'on-chain' },
    { protocol: 'Phoenix DEX', type: 'settlement', direction: 'downstream', detail: 'Swaps settle on Phoenix CLOB', verified: 'docs' },
    { protocol: 'Pumpfun + PumpSwap', type: 'settlement', direction: 'downstream', detail: 'Swaps settle on PumpSwap', verified: 'docs' },
  ],
  'Lulo': [
    { protocol: 'Kamino', type: 'lending', direction: 'downstream', detail: '82% of sampled txs route here (on-chain verified, 49/60 txs)', verified: 'on-chain' },
    { protocol: 'Project 0', type: 'lending', direction: 'downstream', detail: 'Listed as routing destination (from docs)', verified: 'docs' },
    { protocol: 'Drift', type: 'lending', direction: 'downstream', detail: 'Historical routing confirmed via exploit losses', verified: 'news' },
    { protocol: 'Save (Solend)', type: 'lending', direction: 'downstream', detail: 'Listed as routing destination (from docs)', verified: 'docs' },
  ],
  'Titan': [
    { protocol: 'Exponent', type: 'routing', direction: 'upstream', detail: 'Core swap infrastructure partner for Exponent v2 rate markets and Strategy Vault swap operations', verified: 'news' },
  ],

  'Kamino': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Price feeds via Scope aggregator', verified: 'docs' },
    { protocol: 'Switchboard', type: 'oracle', direction: 'downstream', detail: 'Feed into Scope aggregator', verified: 'docs' },
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'downstream', detail: 'Liquidations route through Jupiter', verified: 'on-chain' },
    { protocol: 'Lulo', type: 'lending', direction: 'upstream', detail: 'Receives routed deposits from Lulo', verified: 'on-chain' },
    { protocol: 'Voltr', type: 'lending', direction: 'upstream', detail: '50% of Voltr vault transactions route to Kamino kLend (on-chain verified)', verified: 'on-chain' },
    { protocol: 'Carrot', type: 'lending', direction: 'upstream', detail: 'Yield vaults route to Kamino kLend', verified: 'docs' },
    { protocol: 'Hastra PRIME', type: 'collateral', direction: 'upstream', detail: 'Largest single market on Kamino ($610M+ deposits). RWA yield from Figure HELOCs. Bigger than SOL as collateral on Kamino.', verified: 'news' },
    { protocol: 'Onre Finance', type: 'collateral', direction: 'upstream', detail: 'RWA reinsurance yield market on Kamino', verified: 'docs' },
  ],
  'Drift': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Switchboard', type: 'oracle', direction: 'downstream', detail: 'Backup price feed', verified: 'docs' },
    { protocol: 'Lulo', type: 'lending', direction: 'upstream', detail: 'Received routed deposits from Lulo (historical)', verified: 'news' },
    { protocol: 'Neutral Trade', type: 'lending', direction: 'upstream', detail: '$17M routed via Drift Vaults. Lost $3.67M in Drift exploit.', verified: 'news' },
    { protocol: 'Vectis Finance', type: 'lending', direction: 'upstream', detail: '$11M in delta-neutral vaults on Drift. Lost $1.69M in exploit.', verified: 'news' },
    { protocol: 'Carrot', type: 'lending', direction: 'upstream', detail: '$11M yield vaults on Drift. Lost $8.4M in exploit.', verified: 'news' },
    { protocol: 'Phoenix DEX', type: 'settlement', direction: 'upstream', detail: 'Phoenix users directly impacted by Drift exploit. Phoenix matched losses up to $5,000 per user.', verified: 'news' },
    { protocol: 'Voltr', type: 'lending', direction: 'upstream', detail: '20% of Voltr vault transactions route to Drift (on-chain verified)', verified: 'on-chain' },
  ],
  'Project 0': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Primary oracle', verified: 'docs' },
    { protocol: 'Switchboard', type: 'oracle', direction: 'downstream', detail: 'Oracle for unsupported assets', verified: 'docs' },
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'downstream', detail: 'Liquidations route through Jupiter', verified: 'docs' },
    { protocol: 'Lulo', type: 'lending', direction: 'upstream', detail: 'Receives routed deposits from Lulo (from docs)', verified: 'docs' },
    { protocol: 'Perena', type: 'lending', direction: 'upstream', detail: '$14M vault infrastructure routing to Project 0', verified: 'docs' },
    { protocol: 'Voltr', type: 'lending', direction: 'upstream', detail: '20% of Voltr vault transactions route to Project 0 (on-chain verified)', verified: 'on-chain' },
  ],
  'Jupiter Lend': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'downstream', detail: 'Liquidations route through Jupiter', verified: 'docs' },
  ],
  'Jupiter Perps': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Primary price feed', verified: 'docs' },
  ],
  'Solstice': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Price feeds for strategy', verified: 'docs' },
  ],
  'Loopscale': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Switchboard', type: 'oracle', direction: 'downstream', detail: 'Backup price feed', verified: 'docs' },
  ],
  'Save (Solend)': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Primary price feed', verified: 'docs' },
    { protocol: 'Switchboard', type: 'oracle', direction: 'downstream', detail: 'Backup price feed', verified: 'docs' },
    { protocol: 'Lulo', type: 'lending', direction: 'upstream', detail: 'Receives routed deposits from Lulo (from docs)', verified: 'docs' },
  ],
  'Flash Trade': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Price feed', verified: 'docs' },
  ],
  'Exponent': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Price feed', verified: 'docs' },
  ],
  'Parcl': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Price feed', verified: 'docs' },
  ],
  'Huma Finance': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Price feed', verified: 'docs' },
  ],

  'Orca': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives swaps and liquidations from Jupiter', verified: 'on-chain' },
    { protocol: 'HawkFi', type: 'lending', direction: 'upstream', detail: '$8M LP automation on Orca CLMM', verified: 'docs' },
  ],
  'Raydium': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives swaps and liquidations from Jupiter', verified: 'docs' },
  ],
  'Meteora': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives swaps from Jupiter', verified: 'on-chain' },
    { protocol: 'HawkFi', type: 'lending', direction: 'upstream', detail: '$8M LP automation on Meteora DLMM', verified: 'docs' },
  ],
  'Phoenix DEX': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives swaps from Jupiter', verified: 'docs' },
    { protocol: 'Drift', type: 'settlement', direction: 'upstream', detail: 'Phoenix users were directly impacted by Drift exploit. Phoenix matched losses up to $5,000 per user.', verified: 'news' },
  ],
  'Pumpfun + PumpSwap': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'PumpSwap receives swaps from Jupiter', verified: 'docs' },
    { protocol: 'Photon', type: 'routing', direction: 'upstream', detail: '75% of Photon txs route to Pumpfun', verified: 'on-chain' },
    { protocol: 'Meteora', type: 'settlement', direction: 'downstream', detail: 'PumpSwap settles on Meteora DLMM (43% of txs)', verified: 'on-chain' },
    { protocol: 'Orca', type: 'settlement', direction: 'downstream', detail: 'PumpSwap settles on Orca (7% of txs)', verified: 'on-chain' },
  ],
  'BisonFi': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives 55% of Jupiter swap volume', verified: 'on-chain' },
  ],
  'Tessera V': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives 45% of Jupiter swap volume (Wintermute)', verified: 'on-chain' },
  ],
  'HumidiFi': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives 37% of Jupiter swap volume', verified: 'on-chain' },
  ],
  'PancakeSwap': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'upstream', detail: 'Receives 19% of Jupiter swap volume', verified: 'on-chain' },
  ],
  'Voltr': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'downstream', detail: '69% of Voltr txs route through Jupiter', verified: 'on-chain' },
    { protocol: 'Kamino', type: 'lending', direction: 'downstream', detail: '50% of Voltr txs route to Kamino kLend', verified: 'on-chain' },
    { protocol: 'Project 0', type: 'lending', direction: 'downstream', detail: '20% of Voltr txs route to Project 0', verified: 'on-chain' },
    { protocol: 'Drift', type: 'lending', direction: 'downstream', detail: '20% of Voltr txs route to Drift', verified: 'on-chain' },
  ],
  'Photon': [
    { protocol: 'Pumpfun + PumpSwap', type: 'routing', direction: 'downstream', detail: '75% of Photon txs route to Pumpfun', verified: 'on-chain' },
  ],
  'LayerZero OFT': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'downstream', detail: 'Bridged tokens depend on Jupiter for trading', verified: 'docs' },
    { protocol: 'Orca', type: 'settlement', direction: 'downstream', detail: 'Bridged tokens settle on Orca pools', verified: 'docs' },
    { protocol: 'Raydium', type: 'settlement', direction: 'downstream', detail: 'Bridged tokens settle on Raydium pools', verified: 'docs' },
  ],
  'SolvBTC': [
    { protocol: 'Kamino', type: 'collateral', direction: 'upstream', detail: 'Solv docs list Kamino as a SolvBTC venue', verified: 'docs', caveat: 'Not live on Kamino\'s on-chain reserve list today. If re-listed, the 1/2 SolvBTC mint authority means a single compromised key could mint counterfeit SolvBTC into this market.' },
    { protocol: 'Project 0', type: 'collateral', direction: 'upstream', detail: 'Solv docs list Project 0 (formerly marginfi) as a SolvBTC venue', verified: 'docs', caveat: 'Not live on Project 0\'s on-chain bank list today. If re-listed, the 1/2 SolvBTC mint authority means a single compromised key could mint counterfeit SolvBTC into this market.' },
  ],
  'GMSOL': [
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Depends on Pyth for perpetual market price feeds', verified: 'docs' },
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'downstream', detail: 'Liquidations route through Jupiter', verified: 'docs' },
    { protocol: 'Orca', type: 'settlement', direction: 'downstream', detail: 'Swaps settle on Orca Whirlpools', verified: 'docs' },
    { protocol: 'Raydium', type: 'settlement', direction: 'downstream', detail: 'Swaps settle on Raydium pools', verified: 'docs' },
  ],
  'Carrot': [
    { protocol: 'Drift', type: 'lending', direction: 'downstream', detail: 'Yield vaults deposit into Drift. Lost $8.4M in exploit.', verified: 'news' },
    { protocol: 'Kamino', type: 'lending', direction: 'downstream', detail: 'Yield vaults route to Kamino kLend', verified: 'docs' },
  ],
  'DefiTuna': [
    { protocol: 'Orca', type: 'settlement', direction: 'downstream', detail: 'Leveraged LP positions on Orca CLMM', verified: 'docs' },
    { protocol: 'Pyth', type: 'oracle', direction: 'downstream', detail: 'Price feeds for lending/liquidations', verified: 'docs' },
  ],
  'Ore': [
    { protocol: 'Jupiter Agg', type: 'routing', direction: 'downstream', detail: 'ORE token depends on Jupiter for trading', verified: 'docs' },
  ],
  'SPL Stake Pool': [
    { protocol: 'Jito', type: 'settlement', direction: 'upstream', detail: 'JitoSOL stake pool built on SPL Stake Pool program', verified: 'docs' },
    { protocol: 'Sanctum', type: 'settlement', direction: 'upstream', detail: 'Sanctum LST pools use SPL Stake Pool program', verified: 'docs' },
    { protocol: 'Solayer', type: 'settlement', direction: 'upstream', detail: 'Solayer restaking built on SPL Stake Pool program', verified: 'docs' },
    { protocol: 'Kamino', type: 'collateral', direction: 'upstream', detail: 'LST collateral depends on SPL Stake Pool for underlying staking', verified: 'docs' },
    { protocol: 'Project 0', type: 'collateral', direction: 'upstream', detail: 'LST collateral depends on SPL Stake Pool for underlying staking', verified: 'docs' },
    { protocol: 'Drift', type: 'collateral', direction: 'upstream', detail: 'LST collateral depends on SPL Stake Pool for underlying staking', verified: 'docs' },
  ],
};

export function getRelationships(protocol: string): { upstream: Relationship[]; downstream: Relationship[] } {
  const direct = RELATIONSHIPS[protocol] || [];
  const upstream = direct.filter(r => r.direction === 'upstream');
  const downstream = direct.filter(r => r.direction === 'downstream');

  const upstreamNames = new Set(upstream.map(r => r.protocol));
  const downstreamNames = new Set(downstream.map(r => r.protocol));

  for (const [other, rels] of Object.entries(RELATIONSHIPS)) {
    if (other === protocol) continue;
    for (const r of rels) {
      if (r.protocol === protocol) {
        if (r.direction === 'upstream') {
          if (!downstreamNames.has(other)) {
            downstream.push({ ...r, protocol: other, direction: 'downstream' });
            downstreamNames.add(other);
          }
        } else {
          if (!upstreamNames.has(other)) {
            upstream.push({ ...r, protocol: other, direction: 'upstream' });
            upstreamNames.add(other);
          }
        }
      }
    }
  }

  return { upstream, downstream };
}

export function connectionCount(protocol: string): number {
  const { upstream, downstream } = getRelationships(protocol);
  return upstream.length + downstream.length;
}
