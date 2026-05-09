import 'dotenv/config';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const BASE_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const BASE_REST = 'https://api.helius.xyz';

// Cloudflare on api.helius.xyz rejects Node's default fetch UA (error 1010).
// A real browser UA passes.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ========================================================
// getTransactionsForAddress - 50 credits per 100 transactions
// ========================================================

interface GetTxOptions {
  address: string;
  limit?: number;        // 1-100, default 100
  before?: string;       // pagination cursor (oldest tx signature from previous page)
  after?: string;        // forward pagination cursor
  type?: string;         // filter by type (e.g. 'EXECUTE_TRANSACTION')
  source?: string;       // filter by source program
  startTime?: number;    // unix timestamp (seconds) - blockTime gte
  endTime?: number;      // unix timestamp (seconds) - blockTime lte
  sortOrder?: 'asc' | 'desc'; // default desc (newest first)
  commitment?: string;   // 'confirmed' or 'finalized'
}

interface ParsedTransaction {
  signature: string;
  type: string;
  source: string;
  description: string;
  fee: number;
  feePayer: string;
  timestamp: number;
  slot: number;
  nativeTransfers: { fromUserAccount: string; toUserAccount: string; amount: number }[];
  tokenTransfers: { mint: string; fromUserAccount: string; toUserAccount: string; tokenAmount: number; fromTokenAccount?: string; toTokenAccount?: string }[];
  accountData: { account: string; nativeBalanceChange: number; tokenBalanceChanges: any[] }[];
  transactionError: string | null;
  instructions: any[];
  events: any;
}

/**
 * Fetch parsed transactions for an address. 50 credits per call (up to 100 txs).
 * Supports time filtering, type filtering, and pagination.
 */
export async function getTransactionsForAddress(opts: GetTxOptions): Promise<ParsedTransaction[]> {
  const params: any = {
    address: opts.address,
    limit: opts.limit || 100,
  };
  if (opts.before) params.before = opts.before;
  if (opts.after) params.after = opts.after;
  if (opts.type) params.type = opts.type;
  if (opts.source) params.source = opts.source;
  if (opts.startTime) params['time-range-start'] = opts.startTime;
  if (opts.endTime) params['time-range-end'] = opts.endTime;
  if (opts.sortOrder) params.sortOrder = opts.sortOrder;
  if (opts.commitment) params.commitment = opts.commitment;

  const qs = new URLSearchParams();
  qs.set('api-key', HELIUS_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'address') qs.set(k, String(v));
  }

  const url = `${BASE_REST}/v0/addresses/${opts.address}/transactions?${qs.toString()}`;

  const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`getTransactionsForAddress failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

/**
 * Fetch ALL transactions for an address, paginating automatically.
 * Yields batches of transactions. Respects rate limits with delays.
 */
export async function* getAllTransactions(
  address: string,
  opts: { type?: string; source?: string; startTime?: number; endTime?: number; maxPages?: number; delayMs?: number } = {}
): AsyncGenerator<ParsedTransaction[]> {
  let before: string | undefined;
  let page = 0;
  const maxPages = opts.maxPages || 100;
  const delayMs = opts.delayMs || 200;

  while (page < maxPages) {
    const txs = await getTransactionsForAddress({
      address,
      limit: 100,
      before,
      type: opts.type,
      source: opts.source,
      startTime: opts.startTime,
      endTime: opts.endTime,
    });

    if (txs.length === 0) break;
    yield txs;

    before = txs[txs.length - 1].signature;
    page++;

    if (txs.length < 100) break; // last page
    await sleep(delayMs);
  }
}

// ========================================================
// Enhanced Transactions API - batch parse by signature
// 100 credits per call (up to 100 signatures)
// ========================================================

// ========================================================
// Standard RPC: getSignaturesForAddress
// 1 CREDIT per call (returns up to 1000 sigs)
// USE THIS for incremental discovery - 100x cheaper than parsing
// ========================================================

interface SignatureInfo {
  signature: string;
  slot: number;
  err: any;
  blockTime: number | null;
  memo: string | null;
  confirmationStatus: string;
}

/**
 * Get signatures for an address. 1 credit per call (up to 1000 sigs).
 * Use `until: lastKnownSig` to only get new ones since last scan.
 */
export async function getSignaturesForAddress(
  address: string,
  opts: { limit?: number; before?: string; until?: string; commitment?: string } = {}
): Promise<SignatureInfo[]> {
  const params: any = { limit: opts.limit || 1000 };
  if (opts.before) params.before = opts.before;
  if (opts.until) params.until = opts.until;
  if (opts.commitment) params.commitment = opts.commitment;

  const resp = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'getSigsForAddr',
      method: 'getSignaturesForAddress',
      params: [address, params],
    }),
  });

  if (!resp.ok) {
    throw new Error(`getSignaturesForAddress failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(`getSignaturesForAddress: ${data.error.message}`);
  return data.result || [];
}

/**
 * Find all signatures since a known signature. Paginated.
 * Cheap: 1 credit per 1000 sigs.
 */
export async function getNewSignaturesSince(address: string, lastKnownSig?: string): Promise<SignatureInfo[]> {
  const all: SignatureInfo[] = [];
  let before: string | undefined;
  while (true) {
    const batch = await getSignaturesForAddress(address, { limit: 1000, before, until: lastKnownSig });
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
    await sleep(150);
  }
  return all;
}

// ========================================================
// New RPC: getTransactionsForAddress (Helius-exclusive)
// 50 CREDITS per call (100 full txs OR 1000 sigs)
// USE THIS for filtered scans - built-in time/status/slot filters
// ========================================================

interface NewRpcOptions {
  address: string;
  transactionDetails?: 'signatures' | 'full';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  paginationToken?: string;
  commitment?: 'finalized' | 'confirmed';
  filters?: {
    slot?: { gte?: number; gt?: number; lte?: number; lt?: number };
    blockTime?: { gte?: number; gt?: number; lte?: number; lt?: number; eq?: number };
    signature?: { gte?: string; gt?: string; lte?: string; lt?: string };
    status?: 'succeeded' | 'failed' | 'any';
    tokenAccounts?: 'none' | 'balanceChanged' | 'all';
  };
  maxSupportedTransactionVersion?: number;
}

/**
 * New RPC method (Helius-exclusive). 50 credits per call.
 * Returns 100 full transactions OR 1000 signatures with filters.
 */
export async function getTransactionsForAddressRpc(opts: NewRpcOptions): Promise<{ data: any[]; paginationToken: string | null }> {
  const params: any = { ...opts };
  delete params.address;

  const resp = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'gtfa',
      method: 'getTransactionsForAddress',
      params: [opts.address, params],
    }),
  });

  if (!resp.ok) {
    throw new Error(`getTransactionsForAddress failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(`getTransactionsForAddress: ${data.error.message}`);
  return data.result || { data: [], paginationToken: null };
}

// ========================================================
// getTransfersByAddress (Helius-exclusive)
// Returns parsed token + native SOL transfer objects directly.
// Paid-tier method on mainnet.helius-rpc.com.
// ========================================================

export interface TokenTransfer {
  signature: string;
  slot: number;
  blockTime: number;
  type: 'transfer' | 'mint' | 'burn' | 'wrap' | 'unwrap' | 'changeOwner' | 'withdrawWithheldFee';
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  mint: string;
  amount: string;       // raw integer as string
  feeAmount?: string;   // Token-2022 fee
  decimals: number;
  uiAmount: string;
  feeUiAmount?: string;
  confirmationStatus: 'finalized' | 'confirmed';
  transactionIdx: number;
  instructionIdx: number;
  innerInstructionIdx: number;
}

interface TransfersOptions {
  address: string;
  with?: string;                                              // counterparty filter
  direction?: 'in' | 'out' | 'any';
  mint?: string;
  solMode?: 'merged' | 'separate';
  filters?: {
    amount?: { gt?: number; gte?: number; lt?: number; lte?: number };
    blockTime?: { gt?: number; gte?: number; lt?: number; lte?: number };
    slot?: { gt?: number; gte?: number; lt?: number; lte?: number };
  };
  limit?: number;            // 1..100, default 100
  paginationToken?: string;
  commitment?: 'finalized' | 'confirmed';
  sortOrder?: 'asc' | 'desc';
}

/** Single-page fetch. For full pagination use getAllTransfers below. */
export async function getTransfersByAddress(opts: TransfersOptions): Promise<{ data: TokenTransfer[]; paginationToken: string | null }> {
  const { address, ...config } = opts;
  const resp = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'gtba',
      method: 'getTransfersByAddress',
      params: [address, config],
    }),
  });
  if (!resp.ok) {
    throw new Error(`getTransfersByAddress failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json() as { error?: { message: string }; result?: { data: TokenTransfer[]; paginationToken: string | null } };
  if (data.error) throw new Error(`getTransfersByAddress: ${data.error.message}`);
  return data.result || { data: [], paginationToken: null };
}

/** Fetch every transfer matching the filters, paginating until exhausted.
 *  Optional maxPages cap for safety on very-active addresses. */
export async function getAllTransfers(opts: TransfersOptions, maxPages = 50): Promise<TokenTransfer[]> {
  const all: TokenTransfer[] = [];
  let paginationToken: string | undefined = opts.paginationToken;
  for (let page = 0; page < maxPages; page++) {
    const res = await getTransfersByAddress({ ...opts, paginationToken });
    all.push(...res.data);
    if (!res.paginationToken) break;
    paginationToken = res.paginationToken;
    await sleep(150);
  }
  return all;
}

/**
 * Parse up to 100 transaction signatures in one call.
 * 100 credits per call. Use when you already have signatures.
 */
export async function parseTransactions(signatures: string[]): Promise<ParsedTransaction[]> {
  if (signatures.length === 0) return [];
  if (signatures.length > 100) throw new Error('Max 100 signatures per batch');

  // Retry on 429 with exponential backoff. Helius rate-limits parseTransactions
  // around 5-10 req/sec; mass backfills on V3 protocols (Marinade, SPL Stake
  // Pool, Tensor) easily exceed that on a single multisig and used to drop
  // entire protocols from the scan. Five attempts gets us through transient
  // bursts without burning the whole pass.
  const delays = [800, 2000, 4000, 8000, 16000];
  let lastErr = '';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const resp = await fetch(`${BASE_REST}/v0/transactions?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
      body: JSON.stringify({ transactions: signatures }),
    });
    if (resp.ok) return resp.json();
    lastErr = `${resp.status} ${await resp.text()}`;
    if (resp.status !== 429) break;
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  throw new Error(`parseTransactions failed: ${lastErr}`);
}

// ========================================================
// Wallet API - identity, funding, balances
// 100 credits per request
// ========================================================

interface WalletIdentity {
  address: string;
  name: string;
  tags: string[];
  type: string;
}

/**
 * Look up identity for a single wallet address.
 * Returns null if wallet is not in the Orb database (404 is expected).
 */
export async function getWalletIdentity(address: string): Promise<WalletIdentity | null> {
  const resp = await fetch(`${BASE_REST}/v1/wallet/${address}/identity?api-key=${HELIUS_API_KEY}`, { headers: { 'User-Agent': BROWSER_UA } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getWalletIdentity failed: ${resp.status}`);
  return resp.json();
}

/**
 * Batch identity lookup for up to 100 addresses.
 * Returns array of identified wallets (unknown wallets are omitted).
 */
export async function batchWalletIdentity(addresses: string[]): Promise<WalletIdentity[]> {
  if (addresses.length === 0) return [];
  if (addresses.length > 100) throw new Error('Max 100 addresses per batch');

  const resp = await fetch(`${BASE_REST}/v1/wallet/batch-identity?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
    body: JSON.stringify({ addresses }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`batchWalletIdentity failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

interface FundingSource {
  funder: string;
  funderName: string | null;
  funderType: string | null;
  amount: number;
  timestamp: number;
  date: string;
  signature: string;
}

/**
 * Find who originally funded a wallet (first incoming SOL transfer).
 * Returns null if no funding data found (404 is expected).
 */
export async function getWalletFundedBy(address: string): Promise<FundingSource | null> {
  const resp = await fetch(`${BASE_REST}/v1/wallet/${address}/funded-by?api-key=${HELIUS_API_KEY}`, { headers: { 'User-Agent': BROWSER_UA } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getWalletFundedBy failed: ${resp.status}`);
  return resp.json();
}

// ========================================================
// Governance-specific helpers
// ========================================================

interface GovernanceProfile {
  address: string;
  totalTxs: number;
  approvals: number;
  rejections: number;
  cancellations: number;
  executions: number;
  proposals: number;
  rejectionRate: number;
  uniqueSigners: Set<string>;
  avgExecuteTimeH: number;
  feePayers: Map<string, number>;
  txsByType: Map<string, number>;
  firstTx: number;
  lastTx: number;
}

/**
 * Build a governance profile for a multisig address using getTransactionsForAddress.
 * 50 credits per 100 txs - much cheaper than the old approach.
 */
export async function buildGovernanceProfile(address: string, maxPages = 20): Promise<GovernanceProfile> {
  const profile: GovernanceProfile = {
    address,
    totalTxs: 0,
    approvals: 0,
    rejections: 0,
    cancellations: 0,
    executions: 0,
    proposals: 0,
    rejectionRate: 0,
    uniqueSigners: new Set(),
    avgExecuteTimeH: 0,
    feePayers: new Map(),
    txsByType: new Map(),
    firstTx: Infinity,
    lastTx: 0,
  };

  const executeTimes: number[] = [];
  const proposalCreateTimes = new Map<string, number>(); // sig -> timestamp

  for await (const batch of getAllTransactions(address, { maxPages, delayMs: 250 })) {
    for (const tx of batch) {
      if (tx.transactionError) continue; // skip failed txs

      profile.totalTxs++;
      profile.uniqueSigners.add(tx.feePayer);

      const count = profile.feePayers.get(tx.feePayer) || 0;
      profile.feePayers.set(tx.feePayer, count + 1);

      const typeCount = profile.txsByType.get(tx.type) || 0;
      profile.txsByType.set(tx.type, typeCount + 1);

      if (tx.timestamp < profile.firstTx) profile.firstTx = tx.timestamp;
      if (tx.timestamp > profile.lastTx) profile.lastTx = tx.timestamp;

      switch (tx.type) {
        case 'APPROVE_TRANSACTION':
          profile.approvals++;
          break;
        case 'REJECT_TRANSACTION':
          profile.rejections++;
          break;
        case 'CANCEL_TRANSACTION':
          profile.cancellations++;
          break;
        case 'EXECUTE_TRANSACTION':
          profile.executions++;
          break;
        case 'CREATE_TRANSACTION':
          profile.proposals++;
          proposalCreateTimes.set(tx.signature, tx.timestamp);
          break;
      }
    }
  }

  // Calculate rejection rate
  const totalVotes = profile.approvals + profile.rejections;
  profile.rejectionRate = totalVotes > 0 ? Math.round((profile.rejections / totalVotes) * 100 * 10) / 10 : 0;

  return profile;
}

/**
 * Profile a signer's DeFi activity (hot wallet detection).
 * Looks for swaps, bridge activity, lending, and other DeFi interactions.
 */
export async function profileSignerActivity(address: string, maxPages = 5): Promise<{
  address: string;
  totalTxs: number;
  swaps: number;
  bridges: number;
  lending: number;
  nfts: number;
  transfers: number;
  otherDefi: number;
  sources: Map<string, number>;
  riskScore: number;
  isDeFiActive: boolean;
}> {
  const result = {
    address,
    totalTxs: 0,
    swaps: 0,
    bridges: 0,
    lending: 0,
    nfts: 0,
    transfers: 0,
    otherDefi: 0,
    sources: new Map<string, number>(),
    riskScore: 0,
    isDeFiActive: false,
  };

  for await (const batch of getAllTransactions(address, { maxPages, delayMs: 300 })) {
    for (const tx of batch) {
      if (tx.transactionError) continue;
      result.totalTxs++;

      const srcCount = result.sources.get(tx.source) || 0;
      result.sources.set(tx.source, srcCount + 1);

      switch (tx.type) {
        case 'SWAP':
        case 'BUY':
        case 'SELL':
          result.swaps++;
          break;
        case 'TRANSFER':
          result.transfers++;
          break;
        case 'DEPOSIT':
        case 'WITHDRAW':
        case 'LOAN':
        case 'REPAY_LOAN':
        case 'ADD_LIQUIDITY':
        case 'WITHDRAW_LIQUIDITY':
          result.lending++;
          break;
        case 'NFT_SALE':
        case 'NFT_LISTING':
        case 'NFT_MINT':
          result.nfts++;
          break;
        default:
          if (['STAKE_SOL', 'UNSTAKE_SOL', 'STAKE_TOKEN', 'UNSTAKE_TOKEN', 'CLAIM_REWARDS', 'CREATE_POOL'].includes(tx.type)) {
            result.otherDefi++;
          }
      }
    }
  }

  // Risk score: higher = more DeFi activity on governance key
  const defiTxs = result.swaps + result.bridges + result.lending + result.otherDefi;
  result.isDeFiActive = defiTxs > 5;
  result.riskScore = Math.min(10, Math.round(defiTxs / 10));

  // Bridge detection from sources
  for (const [source] of result.sources) {
    if (source.toLowerCase().includes('wormhole') || source.toLowerCase().includes('mayan') || source.toLowerCase().includes('debridge') || source.toLowerCase().includes('portal')) {
      result.bridges++;
      result.riskScore = Math.min(10, result.riskScore + 2);
    }
  }

  return result;
}
