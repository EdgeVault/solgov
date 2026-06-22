// Token custody utility , pure on-chain RPC for mint info + top holders + structural owner classification,
// with optional Helius batchWalletIdentity overlay for named entity labels (CEX, MM, protocol team, etc).
// RPC works everywhere including VPS. batchWalletIdentity is 100 credits per call (up to 100 addrs).

import { Connection, PublicKey } from '@solana/web3.js';
import { getConnection, withRetry } from './connection';
import { batchWalletIdentity, getWalletFundedBy } from './helius-api';

// Owner program IDs used to classify a wallet's custody type structurally.
const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const SQUADS_V3 = 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu';
const SERUM_MULTISIG = 'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHuwg6Xdt';
const SPL_GOVERNANCE = 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw';
const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export type CustodyType =
  | 'squads-v4'
  | 'squads-v3'
  | 'serum-multisig'
  | 'spl-governance'
  | 'program-pda'
  | 'token-account'
  | 'system-program'
  | 'single-key'
  | 'unknown';

export interface MintInfo {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  uiSupply: number;
  mintAuthorityCustody: CustodyType | null;
  freezeAuthorityCustody: CustodyType | null;
}

export interface HolderInfo {
  address: string;                    // token account address
  owner: string;                      // wallet that owns this token account
  amount: bigint;
  uiAmount: number;
  pctOfSupply: number;
  ownerCustody: CustodyType;
  identityName?: string;              // from Helius if known
  identityTags?: string[];            // e.g. ['cex', 'binance']
  funder?: string;                    // first wallet that funded this owner (Helius)
  funderName?: string;                // Helius-curated funder name if known
  usdValue?: number;                  // live USD value of holdings (Jupiter price)
  priceImpactPct?: number;            // % price drop if this holder dumped to USDC (Jupiter quote)
  impactRoute?: string;               // human description of route (informational)
}

export interface FundingCluster {
  funder: string;
  funderName?: string;
  holderOwners: string[];             // list of holder owner addresses sharing this funder
  count: number;
}

export interface TokenCustodySnapshot {
  mint: string;
  symbol: string;
  fetchedAt: string;
  supply: string;                     // stringified bigint for JSON
  uiSupply: number;
  decimals: number;
  mintAuthority: string | null;
  mintAuthorityCustody: CustodyType | null;
  freezeAuthority: string | null;
  freezeAuthorityCustody: CustodyType | null;
  priceUsd?: number;                  // live spot price from Jupiter
  marketCapUsd?: number;              // priceUsd * uiSupply
  dexLiquidityUsd?: number;           // total liquidity across all Solana DEX pairs (DexScreener)
  dexPairCount?: number;
  dexVolume24h?: number;
  topHolders: Array<Omit<HolderInfo, 'amount'> & { amount: string }>;
  fundingClusters: FundingCluster[];  // groups of holders sharing a funder
  summary: {
    topNPct: number;
    breakdown: Record<CustodyType, number>;
    namedCount: number;               // holders with a Helius identity label
  };
}

/**
 * Classify a wallet by its owning program. Structural label only.
 */
// Resolve whether a System-owned address is actually a Squads multisig vault, by tracing a recent
// transaction back to the controlling multisig account. Returns the Squads type or null. This is the
// same reverse-lookup the governance scanner uses, so a vault PDA is never mistaken for a single key.
async function resolveSquadsVault(conn: Connection, address: string): Promise<CustodyType | null> {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit: 4 });
    for (const s of sigs) {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const keys = tx.transaction.message.staticAccountKeys || [];
      const infos = await conn.getMultipleAccountsInfo(keys);
      for (let i = 0; i < keys.length; i++) {
        const o = infos[i]?.owner.toBase58();
        if (o === SQUADS_V4) return 'squads-v4';
        if (o === SQUADS_V3) return 'squads-v3';
      }
    }
  } catch { /* fall through to single-key */ }
  return null;
}

export async function classifyOwner(
  conn: Connection,
  address: string,
  tryResolve: boolean = false
): Promise<CustodyType> {
  if (address === SYSTEM_PROGRAM) return 'system-program';

  try {
    const info = await withRetry(
      () => conn.getAccountInfo(new PublicKey(address), 'confirmed'),
      `classify ${address.slice(0, 8)}`
    );
    if (!info) return 'unknown';

    const owner = info.owner.toBase58();
    if (owner === SQUADS_V4) return 'squads-v4';
    if (owner === SQUADS_V3) return 'squads-v3';
    if (owner === SERUM_MULTISIG) return 'serum-multisig';
    if (owner === SPL_GOVERNANCE) return 'spl-governance';
    if (owner === BPF_LOADER_UPGRADEABLE) return 'program-pda';
    if (owner === SPL_TOKEN || owner === SPL_TOKEN_2022) return 'token-account';
    if (owner === SYSTEM_PROGRAM) {
      // Could be a regular wallet OR a Squads vault PDA, both look like 0-byte System Program
      // accounts. For authorities (tryResolve), trace a recent transaction back to the controlling
      // multisig before defaulting to single-key, so a multisig-controlled mint/freeze authority is
      // never mislabelled. Holders rely on the Helius identity overlay downstream.
      if (tryResolve) {
        const resolved = await resolveSquadsVault(conn, address);
        if (resolved) return resolved;
      }
      return 'single-key';
    }
    if (info.executable) return 'program-pda';
    return 'program-pda';
  } catch {
    return 'unknown';
  }
}

/**
 * Fetch SPL Token Mint account data. Single getAccountInfo RPC call.
 */
export async function getMintInfo(
  conn: Connection,
  mintAddress: string
): Promise<MintInfo | null> {
  try {
    const info = await withRetry(
      () => conn.getAccountInfo(new PublicKey(mintAddress), 'confirmed'),
      `getMintInfo ${mintAddress.slice(0, 8)}`
    );
    if (!info || info.data.length < 82) return null;

    // SPL Token Mint layout:
    //   0..4    mint_authority_option (u32 LE)
    //   4..36   mint_authority (32 bytes)
    //   36..44  supply (u64 LE)
    //   44      decimals (u8)
    //   45      is_initialized (u8)
    //   46..50  freeze_authority_option (u32 LE)
    //   50..82  freeze_authority (32 bytes)
    const d = info.data;
    const mintAuthOption = d.readUInt32LE(0);
    const mintAuthority = mintAuthOption === 1
      ? new PublicKey(d.slice(4, 36)).toBase58()
      : null;
    const supply = d.readBigUInt64LE(36);
    const decimals = d.readUInt8(44);
    const freezeAuthOption = d.readUInt32LE(46);
    const freezeAuthority = freezeAuthOption === 1
      ? new PublicKey(d.slice(50, 82)).toBase58()
      : null;

    const mintAuthorityCustody = mintAuthority ? await classifyOwner(conn, mintAuthority, true) : null;
    const freezeAuthorityCustody = freezeAuthority ? await classifyOwner(conn, freezeAuthority, true) : null;

    return {
      mint: mintAddress,
      mintAuthority,
      freezeAuthority,
      supply,
      decimals,
      uiSupply: Number(supply) / Math.pow(10, decimals),
      mintAuthorityCustody,
      freezeAuthorityCustody,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch top N holders. Single getTokenLargestAccounts call returns up to 20 sorted by balance.
 * No identity overlay here , caller should pass holder owners to attachIdentityLabels in one batch.
 */
export async function getTopHolders(
  conn: Connection,
  mintAddress: string,
  n: number = 10
): Promise<HolderInfo[]> {
  try {
    const mintInfo = await getMintInfo(conn, mintAddress);
    if (!mintInfo) return [];

    const largest = await withRetry(
      () => conn.getTokenLargestAccounts(new PublicKey(mintAddress), 'confirmed'),
      `getTokenLargestAccounts ${mintAddress.slice(0, 8)}`
    );

    const slice = largest.value.slice(0, n);
    const out: HolderInfo[] = [];

    for (const account of slice) {
      const acctInfo = await withRetry(
        () => conn.getAccountInfo(account.address, 'confirmed'),
        `tokenAccount owner ${account.address.toBase58().slice(0, 8)}`
      );
      if (!acctInfo || acctInfo.data.length < 64) continue;

      // SPL Token Account: bytes 32..64 are the owner pubkey.
      const owner = new PublicKey(acctInfo.data.slice(32, 64)).toBase58();
      const amount = BigInt(account.amount);
      const uiAmount = Number(amount) / Math.pow(10, mintInfo.decimals);
      const pctOfSupply = mintInfo.supply > 0n
        ? (Number(amount) / Number(mintInfo.supply)) * 100
        : 0;

      const ownerCustody = await classifyOwner(conn, owner);

      out.push({
        address: account.address.toBase58(),
        owner,
        amount,
        uiAmount,
        pctOfSupply,
        ownerCustody,
      });
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Attach funder for each holder (first wallet to send them SOL).
 * One call per holder via Helius. Slower than identity batch , call selectively.
 * Failures are silent (funder remains undefined). Used to detect shared-funder clusters.
 */
export async function attachFunders(holders: HolderInfo[]): Promise<void> {
  for (const h of holders) {
    try {
      const f = await getWalletFundedBy(h.owner);
      if (f && f.funder) {
        h.funder = f.funder;
        h.funderName = f.funderName || undefined;
      }
    } catch {
      // Funder overlay failures are non-fatal.
    }
  }
}

/**
 * Group holders by shared funder. Returns clusters of 2+ holders only.
 * A funder shared across only one holder is not a cluster.
 */
export function buildFundingClusters(holders: HolderInfo[]): FundingCluster[] {
  const byFunder = new Map<string, { name?: string; owners: string[] }>();
  for (const h of holders) {
    if (!h.funder) continue;
    const entry = byFunder.get(h.funder) || { name: h.funderName, owners: [] };
    entry.owners.push(h.owner);
    if (h.funderName && !entry.name) entry.name = h.funderName;
    byFunder.set(h.funder, entry);
  }
  const clusters: FundingCluster[] = [];
  for (const [funder, entry] of byFunder) {
    if (entry.owners.length >= 2) {
      clusters.push({
        funder,
        funderName: entry.name,
        holderOwners: entry.owners,
        count: entry.owners.length,
      });
    }
  }
  // Sort by cluster size descending
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

/**
 * Attach Helius identity labels (name + tags) to a list of HolderInfo entries.
 * One batch call per 100 addresses. Mutates the input array in place.
 * Failures are silent (label remains undefined) , identity is an overlay, not a requirement.
 */
export async function attachIdentityLabels(holders: HolderInfo[]): Promise<void> {
  const unique = [...new Set(holders.map(h => h.owner))];
  if (unique.length === 0) return;

  const labelsByAddress = new Map<string, { name: string; tags: string[] }>();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    try {
      const identities = await batchWalletIdentity(batch);
      for (const id of identities) {
        if (id?.address && (id.name || id.tags?.length)) {
          labelsByAddress.set(id.address, { name: id.name || '', tags: id.tags || [] });
        }
      }
    } catch {
      // Identity overlay failures are non-fatal.
    }
  }

  for (const h of holders) {
    const label = labelsByAddress.get(h.owner);
    if (label) {
      h.identityName = label.name || undefined;
      h.identityTags = label.tags;
    }
  }
}

// ============================================================================
// Live-market metrics: Jupiter Price + Quote + DexScreener liquidity depth
// ============================================================================

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Jupiter spot price for a token in USD. Single REST call to lite-api.jup.ag/price/v3 (free).
 * v3 response shape is keyed by mint with { usdPrice, liquidity, priceChange24h, decimals }.
 */
export async function getJupiterPrice(mint: string): Promise<number | null> {
  try {
    const resp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const v = data?.[mint]?.usdPrice;
    return v != null ? Number(v) : null;
  } catch {
    return null;
  }
}

/**
 * Jupiter Quote: how much USDC you'd get if you sold `amount` of `inputMint` right now,
 * and the price impact %. Captures immediate slippage at current DEX liquidity depth.
 * Uses lite-api.jup.ag/swap/v1/quote (free, public). Response priceImpactPct is a string fraction
 * (e.g. "0.0021..." = 0.21%), swapUsdValue is the direct USD output if available.
 */
export async function getJupiterQuoteImpact(
  inputMint: string,
  amount: bigint
): Promise<{ outAmountUsd: number; priceImpactPct: number } | null> {
  try {
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${USDC_MINT}&amount=${amount.toString()}&slippageBps=9999&swapMode=ExactIn`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (!data?.outAmount) return null;
    // USDC has 6 decimals , outAmount is in raw units
    const outAmountUsd = data.swapUsdValue != null
      ? Number(data.swapUsdValue)
      : Number(BigInt(data.outAmount)) / 1e6;
    // priceImpactPct comes as a string fraction. Multiply by 100 to get a percent.
    const piRaw = data.priceImpactPct;
    const priceImpactPct = piRaw != null ? Number(piRaw) * 100 : 0;
    return { outAmountUsd, priceImpactPct };
  } catch {
    return null;
  }
}

/**
 * DexScreener: aggregate DEX liquidity for a token across all Solana pairs.
 * Returns total liquidity in USD across all pools, pair count, 24h volume.
 * Free endpoint, returns up to 30 pairs.
 */
export async function getDexScreenerLiquidity(mint: string): Promise<{
  liquidityUsd: number;
  pairCount: number;
  volume24h: number;
} | null> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (!data?.pairs?.length) return null;
    const solPairs = data.pairs.filter((p: any) => p.chainId === 'solana');
    const liquidityUsd = solPairs.reduce((s: number, p: any) => s + (p.liquidity?.usd || 0), 0);
    const volume24h = solPairs.reduce((s: number, p: any) => s + (p.volume?.h24 || 0), 0);
    return { liquidityUsd, pairCount: solPairs.length, volume24h };
  } catch {
    return null;
  }
}

/**
 * Attach live USD value + price impact (Jupiter Quote) to each holder.
 * Per-holder call. Failures silent (fields remain undefined).
 */
export async function attachLiveMetrics(
  holders: HolderInfo[],
  mint: string,
  priceUsd: number | null
): Promise<void> {
  // Throttle to stay under Jupiter free-tier rate limit (~60 req/min = 1/sec).
  for (const h of holders) {
    // usdValue is the PAPER value at spot price , what they hold in dollars.
    // It must NOT be overridden by the Quote outAmount, which represents
    // post-slippage extractable amount and gets capped by pool depth.
    if (priceUsd != null) {
      h.usdValue = h.uiAmount * priceUsd;
    }
    try {
      const q = await getJupiterQuoteImpact(mint, h.amount);
      if (q) {
        // Only take the price impact from Quote, leave usdValue as paper value.
        h.priceImpactPct = q.priceImpactPct;
      }
    } catch {
      // Quote failure non-fatal
    }
    await new Promise(r => setTimeout(r, 1100));
  }
}

/**
 * End-to-end: mint info + top holders + identity overlay + funders + clusters +
 * live USD prices + per-holder price impact + DEX liquidity depth + summary stats.
 * Single high-level function the scan script calls per protocol.
 */
export async function buildCustodySnapshot(
  conn: Connection,
  mintAddress: string,
  symbol: string,
  topN: number = 10
): Promise<TokenCustodySnapshot | null> {
  const mintInfo = await getMintInfo(conn, mintAddress);
  if (!mintInfo) return null;

  const topHolders = await getTopHolders(conn, mintAddress, topN);
  if (topHolders.length === 0) return null;

  // Run identity, funder, price, and DEX depth in parallel where independent.
  // attachLiveMetrics needs the price for fallback so chain after Jupiter price.
  const [_, __, priceUsd, dexInfo] = await Promise.all([
    attachIdentityLabels(topHolders),
    attachFunders(topHolders),
    getJupiterPrice(mintAddress),
    getDexScreenerLiquidity(mintAddress),
  ]);

  await attachLiveMetrics(topHolders, mintAddress, priceUsd);

  const fundingClusters = buildFundingClusters(topHolders);

  const topNPct = topHolders.reduce((sum, h) => sum + h.pctOfSupply, 0);
  const breakdown: Record<CustodyType, number> = {
    'squads-v4': 0,
    'squads-v3': 0,
    'serum-multisig': 0,
    'spl-governance': 0,
    'program-pda': 0,
    'token-account': 0,
    'system-program': 0,
    'single-key': 0,
    'unknown': 0,
  };
  let namedCount = 0;
  for (const h of topHolders) {
    breakdown[h.ownerCustody]++;
    if (h.identityName) namedCount++;
  }

  const marketCapUsd = priceUsd != null ? priceUsd * mintInfo.uiSupply : undefined;

  return {
    mint: mintAddress,
    symbol,
    fetchedAt: new Date().toISOString(),
    supply: mintInfo.supply.toString(),
    uiSupply: mintInfo.uiSupply,
    decimals: mintInfo.decimals,
    mintAuthority: mintInfo.mintAuthority,
    mintAuthorityCustody: mintInfo.mintAuthorityCustody,
    freezeAuthority: mintInfo.freezeAuthority,
    freezeAuthorityCustody: mintInfo.freezeAuthorityCustody,
    priceUsd: priceUsd ?? undefined,
    marketCapUsd,
    dexLiquidityUsd: dexInfo?.liquidityUsd,
    dexPairCount: dexInfo?.pairCount,
    dexVolume24h: dexInfo?.volume24h,
    topHolders: topHolders.map(h => ({
      address: h.address,
      owner: h.owner,
      amount: h.amount.toString(),
      uiAmount: h.uiAmount,
      pctOfSupply: h.pctOfSupply,
      ownerCustody: h.ownerCustody,
      identityName: h.identityName,
      identityTags: h.identityTags,
      funder: h.funder,
      funderName: h.funderName,
      usdValue: h.usdValue,
      priceImpactPct: h.priceImpactPct,
    })),
    fundingClusters,
    summary: {
      topNPct,
      breakdown,
      namedCount,
    },
  };
}

export { getConnection };
