// Protocol registry types and tracked-protocol list.

export interface Protocol {
  name: string;
  programId: string;
  category: string;
  notes?: string;
  priority: number;
  defillamaSlug?: string;
}

// Fetch TVL from DeFiLlama (free, no auth)
export async function fetchTVL(slug: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.llama.fi/protocol/${slug}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.currentChainTvls?.Solana ?? data.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD ?? null;
  } catch {
    return null;
  }
}

export const PROTOCOLS: Protocol[] = [
  // Priority 1 - baseline scan order
  {
    name: 'Sanctum',
    programId: '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx',
    category: 'Liquid Staking',
    notes: 'Publicly stated multisig-controlled authorities post-Drift',
    priority: 1,
    defillamaSlug: 'sanctum',
  },
  {
    name: 'Drift Protocol',
    programId: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
    category: 'Perps DEX',
    notes: 'Post-exploit state. Reference case for Drift-pattern condition matching.',
    priority: 1,
    defillamaSlug: 'drift',
  },
  // Priority 2 - large TVL perps and lending
  {
    name: 'Jupiter Perpetuals',
    programId: 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
    category: 'Perps DEX',
    priority: 2,
    defillamaSlug: 'jupiter-perpetual-exchange',
  },
  {
    name: 'Jupiter Aggregator',
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    category: 'DEX Aggregator',
    priority: 2,
    defillamaSlug: 'jupiter',
  },
  {
    name: 'Kamino Finance',
    programId: 'KLend2g3cP87ber8CJASBnBGjocMnnGnUPMTQfbt7GS',
    category: 'Lending',
    priority: 2,
    defillamaSlug: 'kamino',
  },
  {
    name: 'Project 0',
    programId: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',
    category: 'Lending',
    priority: 2,
    defillamaSlug: 'marginfi',
  },
  // Priority 3 - major DEXs and infrastructure
  {
    name: 'Marinade Finance',
    programId: 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
    category: 'Liquid Staking',
    priority: 3,
    defillamaSlug: 'marinade-liquid-staking',
  },
  {
    name: 'Jito Stake Pool',
    programId: 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb',
    category: 'Liquid Staking',
    priority: 3,
    defillamaSlug: 'jito-liquid-staking',
  },
  {
    name: 'Raydium AMM',
    programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    category: 'AMM DEX',
    priority: 3,
    defillamaSlug: 'raydium-amm',
  },
  {
    name: 'Orca Whirlpools',
    programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    category: 'CLMM DEX',
    priority: 3,
    defillamaSlug: 'orca',
  },
  {
    name: 'Pyth Network',
    programId: 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH',
    category: 'Oracle',
    notes: 'Oracle program. Multiple downstream protocols consume Pyth feeds.',
    priority: 3,
    defillamaSlug: 'pyth-network',
  },
  // Priority 4 - NFT marketplaces and other
  {
    name: 'Tensor',
    programId: 'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN',
    category: 'NFT Marketplace',
    priority: 4,
  },
  {
    name: 'Magic Eden',
    programId: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',
    category: 'NFT Marketplace',
    priority: 4,
    defillamaSlug: 'magic-eden',
  },
  {
    name: 'Phoenix DEX',
    programId: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
    category: 'Order Book DEX',
    priority: 4,
    defillamaSlug: 'phoenix',
  },
  {
    name: 'Helium',
    programId: 'hdaoVTCqhfHHo75XdAMxBKdUqvq1i5bF23DjYLkCkmb',
    category: 'DePIN',
    priority: 4,
    defillamaSlug: 'helium-network',
  },
];
