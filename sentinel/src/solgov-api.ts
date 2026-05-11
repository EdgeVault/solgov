// Public HTTP API. Serves monitor state, historical aggregates, governance slices, alerts, and partner webhook registration.

import 'dotenv/config';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { loadSignerWhitelists, detectNewFunders, persistNewFunder, findProtocolsForSigner } from './signer-funder-detection';
import { nameMatches } from './llm-tools';
import { createSubscription, getSubscription as getWebhookSub, deleteSubscription as deleteWebhookSub, publicView, type Severity as WebhookSeverity } from './webhook-registry';
import { startYieldbayPoller, getCachedIncidents, getCachedSummary } from './fetch-yieldbay-health';
import { listTracked, addTracked, verifySquadsMultisig, MAX_TRACKED } from './user-tracked-multisigs';

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || '';
const conn = HELIUS_RPC_URL ? new Connection(HELIUS_RPC_URL, 'confirmed') : null;

const PORT = parseInt(process.env.SOLGOV_API_PORT || '3847');
const STATE_FILE = path.join(__dirname, '..', 'data', 'monitor-state.json');
const HISTORICAL_FILE = path.join(__dirname, '..', 'data', 'historical-state.json');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_THREADS = { CRITICAL: 65, HIGH: 67, MONITOR: 69, PUBLIC: 21 };

const ADDRESS_TO_PROTOCOL: Record<string, string> = {
  'E44y4Gm693AFdGXk4zir5D3ivHn7jns9aWkm8c5q1NDQ': 'Drift',
  '2yMoQqQrtbhq3nQ3wFoQQawWS65qcqUXcwHEYha4rshW': 'Pumpfun',
  'J2SasfUti5RffbeohWpBDMiGsYGCN11fgyQKTVeREKYE': 'Magic Eden',
  '51smH7pBDKJDgmVnVks3gMWaPQFfmQ5s4Fc223yHcjuH': 'Exponent',
  'ktKWwDt5J8NFMi5jQNRRBDKAhimU5tnrGCcXuYJmxqE': 'Nosana',
  '8Sr4rQJL2aQT3EL97mbrk1T9VMw4pCS2mxMPp2QBzHQq': 'Lulo',
  'AFRN2ECAY1YTbfkXD7yvoc1iaxYdt5BdyyqyPRsrHaK2': 'Stabble',
  '2z3t2eBz7VL39Q3vEvaemd5mhT9XLoFofEH2cXvwCJvb': 'Hylo',
  'C4awuufiuL8DNT5wMDP27HneKKqbgynrsbCa4XYGSuPk': 'Loopscale',
  'BQsDWkL417U4tVE2sDnPks469pKdm6YzFgKH77doiEjF': 'Orca',
  '7FCPipJWVbPbdHymVt1gJYwKciakkJz5GahdQySemvHk': 'Project 0',
  '6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM': 'Kamino',
  'AxkJ8oH5aDu4ZRWfsujPtxdb6Vhq4gDehpoReBgrUUSm': 'Jupiter Perps',
  'J3mJ3wz6xkVUk3T8qHnuAYNxsRH3ixHsryYNZAU2vG8P': 'Jupiter Lend',
  'uGLhzjot32i9nNKZKUoCzr7sG8bFAXQRN3uZPTUr7gX': 'Huma',
  'AEb1u8FK8EuXLcPtprCy8s4NkqBNoP5mfbuEEop2dJGf': 'Solstice',
  '93RQfY6VHRkqXBCEhMY5u92bCGp428DTzqZUEA2Hjr9h': 'Switchboard',
  'F1WZezmt2J1dSsXrQWrS2Umn9CYzPPR2eP3sunZrMX29': 'Titan',
  '5AQ3c2nC3Ua5Ms1QP4XpcfaU2Q31C8VhiUJGX3c8zFqp': 'Solayer',
  'Gb33UeQNnQ4XDuobtGq9M6PVKRVfoH77p8d6JXsgqyXF': 'Flash Trade',
  '8YmCRSNu7eCjLkhFB4LgDjjjGzfa37ztMoPhXZymWcCA': 'Wick',
  '922xY8imV8NC1FXbaR9VFtNZV7RxQiq19gC42fQG5AfR': 'Onre Finance',
  '8N3Tvc6B1wEVKVC6iD4s6eyaCNqX2ovj2xze2q3Q9DWH': 'MetaDAO',
  'FXyzyVsmPRuZjbe97tsCpDqPAPPhBny4dr2hemo8XmL1': 'Helium',
  '5QctVSVmX1wdA9emmQFLQGnVbbiR6zPcDkmX8xEScxGH': 'Voltr',
  '3JW5VWy76TBT5NBbdyrWU6i3fz8XecDko7viGeFSKw7e': 'Tessera V',
  '9XnbnSvCk33J5Daxc9uJ2MxySTKPuM1KKoFJNmaAk7tN': 'LayerZero OFT',
  'HRr5HqBE7XXMTYD7V6MwojkHxYGttwozEx6atAprp7XE': 'SolvBTC',
  'CxnEVpQQcYa628TywzHGXeJ2jdVmbU51rnERat9xunP1': 'GMSOL',
  'CHvPhBYPSEdjCrv5xUuzvscqwFYm5wMggWLk2Bvkjgwo': 'Ore',
  'F7axBNUgWQQ33ZYLdenCk5SV3wBrKyYz9R7MscdPJi1A': 'GMSOL Deploy',
  'BVQn1waSbAD5fd6rJifaKY8yRrXSUCdd6cA9DZfwVDon': 'Carrot',
  '7tmQEKTNAwmkepvfo2zKvZ1KDHD4nEtQ39eZGwxQ1fQv': 'DefiTuna',
  'FHebUVvpfPzfcaWdhwYMP5uHLpRG6zbN8LcExJYAt8Ap': 'deBridge',
  'AApfiPZgV5MoPU691GwhdDhq5sKEMMH1Uh8S4Z9xvP6b': 'Sanctum',
  '7ZyDFzet6sKgZLN4D89JLfo7chu2n7nYdkFt5RCFk8Sf': 'Jupiter Agg',
  'EXZY7FPccNuEvgHZMCMpww2Fen8oLWBSJzdgCsX3Djwm': 'Raydium',
  '3djJ66VVaG7si2wsh9isspeZX13meHDvwBzuPGCowY4Z': 'Tensor',
  '6x3BDkL2n7VjBWxRD95EsbQi2R2E4zxrvcz1VA6pihnK': 'Phoenix DEX',
  'CoEsykatDegLB7pcMJia79JSriDdi71nPnjgeSfw623k': 'Meteora',
  '7qCHZqcbLm9VYUCLtFmFFSyDsvuZ5GHhypv7b4JRAEUE': 'Parcl',
  'magrsHFQxkkioAy45VWnZnFBBdKVdy2ZiRoRGYT9Wed': 'Marinade',
  '3yqoHFE4nBGchuVH5rJuZMFvsmnaDTuLLdvGPDUEJcbW': 'SPL Stake Pool',
  'Ad21qwCb3C98M6UNqjGsZgR48549Spp7W1UWETV29cZ9': 'Drift (BBC5g vault)',
  'GA5aPX7hFNaxoi8akdbcFVMCrkdfbYC42q7BERPguTNo': 'Drift (E44y4Gm vault)',
  '4MsgBB5VPoTrUSp5XnfbViV386C1UnsTdifLBw33ZMSJ': 'Jupiter Lend (vault)',
  'GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV': 'Orca (vault)',
  '6qp7veALWas5rxXJRQXUEbffRtDyhB8koxenBpS51SrA': 'GMSOL (main vault)',
  'G9jXsKZ2XXfNEks2dmouKiJJFBWcn8SQHmMkcy3TUVf5': 'LayerZero OFT (devtools vault)',
  'Gy7pgCryzquDBHkpGkJGBRAyLpdmdqkifjLdKMoS1GEE': 'Project 0 (vault)',
  'CivjSDKgTpmkRNL4zYcmv9D9QqPJg6yTxBVxMGcXvMuY': 'Kamino (KFarms vault)',
  '4JpPs9Mi11qoj6GthQPiTjUc4gXq8BAoSs3AD6NVjQUZ': 'Helium (vault)',
  'pULUgsYtKvT7qhsL8QJ2oJXYQUeCCdjtfawPnBqEr3U': 'Helium (vault 2)',
  'BsF2mR9brTd7u7wGWrejksQzsdrGFNcddRSYeNpHZixM': 'SolvBTC (vault)',
  '4SMcPtixKvjgj3U5N7C4kcnHYcySudLZfFWc523NAvXJ': 'GMSOL (vault)',
  'J5K5tWj3nKfxuSkAJ25WTMf4u5EsxJRfUoRKKxgrfFGV': 'Ore (vault)',
  '9ECeczLtFZDYE3NX6G7uNw5BUGjoJAu1kFyEihA5hMaM': 'Ondo Global Markets (vault A)',
  'haioSqc3tdn5Hat815ehNNA3sN2AHR8hXYJbDafok9P': 'Loopscale (vault)',
  '5JKhn62nyvAE7aRb5zksXiovDEPX6mAcbdxFsJEdVmbw': 'Ondo Global Markets (vault B)',
  '3hiQADryzHeV6gQa8gojLV5EHNAKXdujtTX2u8evVh1Z': 'Berrie Dex / unknown (mixed-program vault)',
  '2ZgW3Y7o9Ws3CCWWUF2TBry5wSVuM4M98s7xD4XWDUda': 'Flash Trade (vault)',
  'HNc9Ws3TEA9Wm1tHrhWubGAX7ryjJUG9jue6dR8ZvjF9': 'Solstice (vault)',
  '3bcxfPkGRLbHfkFb5DADLP9k5SCJmGU2H6MhuE2WxVdV': 'Carrot (vault)',
  '87VfCnQ4d7XuZwriJAK7yADmqzrJQBx9FYMqCwdue5kv': 'DefiTuna (vault)',
  '6nopWptiA5bw3hDsAzDcwEcLSNcrYfbCErKmM14QZS31': 'LayerZero (vault)',
  'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ': 'Jupiter v6 (upgrade auth)',
  'BBC5gSPh71YB2eUXdCqvkmL6kj6YDkUQJpX997qXUt2Q': 'Drift (historical BBC5g)',
  'Er82vnftZhA2YrRZyuGpw1an3Ho585eYCAxNv2U9F2uY': 'Drift (historical Er82vnft)',
  '2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88': 'Drift (historical 2LW6PS exploited)',
  '61ApQqLoWVfTuzua9c22SWMj78RGv77x6Z2kzcJVGNjP': 'Drift (historical 61ApQqLoW)',
  'GMNVGNk8Kso1cjre4Wx7zx2knP4uKLNVtpfay2FEEaAi': 'Drift (historical GMNVGNk8)',
  '5HzXCm7omo3M7sX5nC4XcAxcTXEC22UHegB1hQiRvbfk': 'Kamino KFarms',
  '9CiwEGczicmjioXiPsaJV92j4UXG1qMLYLQTxej4U7tr': 'Project 0 (program admin)',
  '1XEcKnazz6RVxiv6dwqgW45PQxUmYNyqHJpTohPaFzz': 'Helium (Omnix admin)',
  'NG2KqHb4SE1HmqSf1GfJHorKGVNcYfgVSdwPPvn7Lsq': 'Loopscale (program admin)',
  'HB3boZwyCUmjCo2uPWfVS2WKYmdgGv2XVpRgUaX5CkxC': 'LayerZero OFT (devtools admin)',
  '9dUjjx2Vi7GbBtuxN8N71MEFuD6Yn3QTtwLTYYjvZnLr': 'Berrie Dex (program admin)',
  'BPdkMGWnttz4izo6RD6pXpcbVgGiqD2GR3Jds7HvaXEE': 'Solstice (program admin)',
  'DrFv23CkTxu84aAYCK7cvUP3zBvFGz2ruuCXuuyPZWbV': 'Carrot (program admin)',
  'GPuMML3FeJXTr948CvTwSYANHm74RSW5iUibw5T6vSfa': 'Flash Trade (program admin)',
  'EfMUASGwCsPBafiPi8rwdZfUJSUt7pxAoxayR39PVpMr': 'Ondo Global Markets (admin)',
  'DK37X6PNtzS4oiJAWgJ364NkUq6us3gf4u7GVRdezqvW': 'Ondo Global Markets (1/8 keeper)',
  '5Sjxeibf9PmN2WG23nhfJVEJ8paPKfpK7pQ9oyfQkrZy': 'DefiTuna (program admin)',
  '7PMRcwPChXuwKA5Z5znNf6avJgW454gGGboV1Yt1xGgq': 'Raydium (program admin V3)',
  '3Eun8CdkJsd5WZC7NdNLUPQCx86cXKtwAK6EFLuWsn5w': 'Meteora (program admin V3)',
  'BRwx9yUrdP9aZMxJGgarLCKcNr3iCn7yj1nDAy4jfUUk': 'Parcl (governance V3)',
  'D1LUJooB3ywFDqKwkha5Saqy2u7bnCDvu3rKQReByBZT': 'Magic Eden (program admin)',
};

const PROGRAM_ID_TO_NAME: Record<string, string> = {
  'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH': 'Drift Protocol V2',
  'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR': 'Drift Vaults',
  'dVoTE1AJqkZVoE1mPbWcqYPmEEvAUBksHY2NiM2UJQe': 'Drift Stake Voter',
  'DraWMeQX9LfzQQSYoeBwHAgM5JcqFkgrX7GbTfjzVMVL': 'Drift Competitions',
  'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP': 'Drift JIT Proxy',
  'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha': 'Drift Oracle Receiver',
  'E7HtfkEMhmn9uwL7EFNydcXBWy5WCYN1vFmKKjipEH1x': 'Drift Merkle Distributor',
  'dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN': 'Drift V1 (DAMM)',
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD': 'Kamino kLend',
  'kvauTFR8qm1dhniz6pYuBZkuene3Hfrs1VQhVRgCNrr': 'Kamino Vaults',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6',
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu': 'Jupiter Perps Program',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpools',
  'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA': 'Project 0',
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY': 'Phoenix',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
  'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf': 'Squads V4',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo': 'Save (Solend)',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump AMM',
  'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi': 'BisonFi Program',
  'credMBJhYFzfn7NxBMdU4aUqFggAjgztaCcv2Fo6fPT': 'Helium Data Credits',
  'hdaoVTCqhfHHo75XdAMxBKdUqvq1i5bF23sisBqVgGR': 'Helium Sub DAOs',
  'hemjuPXBpNvggtaUnN1MwT3wrdhttKEfosTcc2P9Pg8': 'Helium Entity Manager',
  'hvsrNC3NKbcryqDs2DocYHZ9yPKEVzdSjQG6RVtK1s8': 'Helium Voter Stake Registry',
  'propFYxqmVcufMhk5esNMrexq2ogHbbC2kP9PU1qxKs': 'Helium Modular Governance (proposals)',
  'nprx42sXf5rpVnwBWEdRg1d8tuCWsTuVLys1pRWwE6p': 'Helium Modular Governance (proposals v2)',
  'treaf4wWBBty3fHdyBpo35Mz84M8k3heKXmjmi9vFt5': 'Helium Treasury Management',
  'memMa1HG4odAFmUbGWfPwS1WWfK95k99F2YTkGvyxZr': 'Helium Mobile Entity',
  'noEmmgLmQdk6DLiPV8CSwQv3qQDyGEhz9m5A4zhtByv': 'Helium No-Emit',
  '1atrmQs3eq1N2FEYWu6tyTXbCjP4uQwExpjtnhXtS8h': 'Helium IoT Distributor',
  'orgdXvHVLkWgBYerptASkAwkZAE563CJUu717dMNx5f': 'Helium Organisations',
  'porcSnvH9pvcYPmQ65Y8qcZSRxQBiBBQX7UV5nmBegy': 'Helium Price Oracle',
  'hexbnKYoA2GercNNhHUCCfrTRWrHjT6ujKPXTa5NPqJ': 'Helium Hex Boosting',
  'circAbx64bbsscPbQzZAUvuXpHqrCe6fLMzc2uKXz9g': 'Helium Circuit Breaker',
  'fanqeMu3fw8R4LwKNbahPtYXJsyLL6NXyfe2BqzhfB6': 'Helium Fanout',
  'rorcfdX4h9m9swCKgcypaHJ8NGYVANBpmV9EHn3cYrF': 'Helium Rewards Oracle',
  '1azyuavdMyvsivtNxPoz6SucD18eDHeXzFCUPq5XU7w': 'Helium Lazy Distributor',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx': 'Sanctum S Controller',
  'sp1V4h2gWorkGhVcazBc22Hfo2f5sd7jcjT4EDPrWFF': 'Sanctum SOL Value Calculator',
  'mare3SCyfZkAndpBRBeonETmkCCB3TJTTrz8ZN2dnhP': 'Sanctum Marinade SOL Calculator',
  'sspUE1vrh7xRoXxGsg7vR1zde2WdGtJRbyK9uRumBDy': 'Sanctum SPL Stake Pool Calculator',
  'f1tUoNEKrDp1oeGn4zxr7bh41eN6VcfHjfrL3ZqQday': 'Sanctum Flat Fee Pricing',
  '1idUSy4MGGKyKhvjSnGZ6Zc7Q4eKQcibym4BkEEw9KR': 'Sanctum LiDo SOL Calculator',
  'wsoGmxQLSvwWpuaidCApxN5kEowLe2HLQLJhCQnj4bE': 'Sanctum wSOL Calculator',
  'prfmVhiQTN5Spgoxa8uZJba35V1s7XXReqbBiqPDWeJ': 'Pyth Governance',
  'pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt': 'Pyth Crosschain',
  'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc': 'Magic Eden MMM (AMM)',
};

function formatUKTime(date: Date): string {
  return date.toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false }).replace(',', '');
}

const CANONICAL_MAP: Record<string, { canonical: string; role: 'primary' | 'treasury' | 'governance' | 'secondary' | 'historical' }> = {
  'Raydium (treasury)':           { canonical: 'Raydium',     role: 'treasury' },
  'Onre Finance (secondary)':     { canonical: 'Onre Finance', role: 'secondary' },
  'deBridge (governance multisig)': { canonical: 'deBridge',   role: 'governance' },
};
function resolveCanonical(name: string): { canonical: string; role: 'primary' | 'treasury' | 'governance' | 'secondary' | 'historical' } {
  return CANONICAL_MAP[name] || { canonical: name, role: 'primary' };
}

const HISTORICAL_NAME_MAP: Record<string, string> = {
  'Marginfi': 'Project 0',
  'Pumpfun': 'Pumpfun + PumpSwap',
  'Huma': 'Huma Finance',
};

type GovernanceModel = 'squads-v4' | 'squads-v3' | 'serum-multisig' | 'goki-smart-wallet' | 'realms-dao' | 'wormhole-guardians' | 'single-signer' | 'unknown';
const GOVERNANCE_MODEL_MAP: Record<string, GovernanceModel> = {
  'Sanctum': 'squads-v3',
  'Jupiter Agg': 'squads-v3',
  'Raydium': 'squads-v4',
  'Tensor': 'squads-v3',
  'Phoenix DEX': 'squads-v3',
  'Meteora': 'squads-v3',
  'Parcl': 'squads-v3',
  'SPL Stake Pool': 'squads-v3',
  'Marinade': 'serum-multisig',
  'Pyth': 'wormhole-guardians',
  'Save (Solend)': 'single-signer',
  'Zebec': 'single-signer',
  'BisonFi': 'single-signer',
  'HumidiFi': 'single-signer',
  'Photon': 'single-signer',
  'Jito': 'realms-dao',
};
function resolveGovernanceModel(name: string): GovernanceModel {
  if (GOVERNANCE_MODEL_MAP[name]) return GOVERNANCE_MODEL_MAP[name];
  const { canonical } = resolveCanonical(name);
  if (GOVERNANCE_MODEL_MAP[canonical]) return GOVERNANCE_MODEL_MAP[canonical];
  return 'squads-v4';
}

function normalizeConfigAuthority(value: unknown): string {
  if (typeof value !== 'string') return 'autonomous';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '11111111111111111111111111111111') return 'autonomous';
  return trimmed;
}

const processedSignatures = new Set<string>();
const MAX_DEDUP_SIZE = 10_000;

function addProcessedSig(sig: string) {
  processedSignatures.add(sig);
  if (processedSignatures.size > MAX_DEDUP_SIZE) {
    const first = processedSignatures.values().next().value;
    if (first) processedSignatures.delete(first);
  }
}

import { appendActivity as logActivity, readActivityLog } from './activity-log';

type SubEventType = 'ConfigChange' | 'AuthorityChange' | 'ProgramUpgrade' | 'NONCE' | 'VaultTx' | '*';

async function sendToSubscribers(event: {
  protocol: string;
  severity: 'CRITICAL' | 'HIGH' | 'MONITOR';
  type?: SubEventType;
  message: string;
}) {
  if (!TG_TOKEN) return;
  try {
    const { matchSubscribersForAlert, touchNotified } = require('./subscriptions');
    const matches = matchSubscribersForAlert(event);
    for (const { userId, subscription } of matches) {
      try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: subscription.chatId,
            text: `🔔 <b>Your subscription: ${event.protocol}</b>\n\n${event.message}`,
            parse_mode: 'HTML',
          }),
        });
        touchNotified(userId);
      } catch (e: any) {
        console.error(`[SUBS] DM to ${userId} failed:`, e.message);
      }
    }
    if (matches.length > 0) console.log(`[SUBS] ${event.severity} ${event.protocol}: DM'd ${matches.length} subscriber(s)`);
  } catch (e: any) {
    console.error('[SUBS] routing error:', e.message);
  }
}

async function sendTelegram(message: string, severity: keyof typeof TG_THREADS = 'MONITOR') {
  if (!TG_TOKEN) { console.log('[TG]', message); return; }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        message_thread_id: TG_THREADS[severity],
      }),
    });
    if (!resp.ok) console.error('[TG] Send failed:', resp.status);
  } catch (e: any) {
    console.error('[TG] Error:', e.message);
  }
}

async function sendPublic(message: string) {
  if (!TG_TOKEN) { console.log('[PUBLIC]', message); return; }
  const publicChannel = process.env.TELEGRAM_PUBLIC_CHANNEL_ID;
  const body: any = { text: message, parse_mode: 'HTML', disable_web_page_preview: true };
  if (publicChannel) {
    body.chat_id = publicChannel;
  } else {
    body.chat_id = TG_CHAT_ID;
    body.message_thread_id = TG_THREADS.PUBLIC;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.error('[PUBLIC] Send failed:', resp.status);
  } catch (e: any) {
    console.error('[PUBLIC] Error:', e.message);
  }
}

async function fetchMultisigState(address: string): Promise<{ threshold: number; memberCount: number; timeLock: number; configAuthority: string } | null> {
  if (!conn) return null;
  try {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, new PublicKey(address));
    const ca = (ms as any).configAuthority;
    const caStr = ca ? ca.toBase58() : null;
    const configAuthority = (!caStr || caStr === '11111111111111111111111111111111') ? 'autonomous' : caStr;
    return {
      threshold: ms.threshold,
      memberCount: ms.members.length,
      timeLock: ms.timeLock,
      configAuthority,
    };
  } catch (e: any) {
    console.error(`[fetchMultisigState] ${address.slice(0, 12)}...: ${e.message?.slice(0, 60)}`);
    return null;
  }
}

function classifyConfigDiff(
  prev: { threshold: number; memberCount: number; timeLock: number; configAuthority: string } | null,
  now: { threshold: number; memberCount: number; timeLock: number; configAuthority: string }
): { severity: 'CRITICAL' | 'HIGH' | 'MONITOR'; changes: string[] } {
  const changes: string[] = [];
  let severity: 'CRITICAL' | 'HIGH' | 'MONITOR' = 'MONITOR';

  if (!prev) {
    return { severity: 'MONITOR', changes: [`Initial state recorded: ${now.threshold}/${now.memberCount}, timelock=${now.timeLock}s`] };
  }

  const tlLabel = (s: number) => s === 0 ? 'none' : s < 3600 ? `${s}s` : `${Math.round(s / 3600)}h`;

  if (now.threshold < prev.threshold) {
    changes.push(`Threshold: ${prev.threshold} → ${now.threshold}`);
    severity = 'CRITICAL';
  } else if (now.threshold > prev.threshold) {
    changes.push(`Threshold: ${prev.threshold} → ${now.threshold}`);
  }

  if (now.memberCount < prev.memberCount) {
    const removed = prev.memberCount - now.memberCount;
    changes.push(`Signers: ${prev.memberCount} → ${now.memberCount}`);
    if (removed >= 3) severity = 'CRITICAL';
    else if (severity !== 'CRITICAL') severity = 'HIGH';
  } else if (now.memberCount > prev.memberCount) {
    changes.push(`Signers: ${prev.memberCount} → ${now.memberCount}`);
  }

  if (prev.timeLock > 0 && now.timeLock === 0) {
    changes.push(`Timelock: ${tlLabel(prev.timeLock)} → none`);
    severity = 'CRITICAL';
  } else if (now.timeLock > prev.timeLock) {
    changes.push(`Timelock: ${tlLabel(prev.timeLock)} → ${tlLabel(now.timeLock)}`);
  } else if (now.timeLock < prev.timeLock && prev.timeLock > 0) {
    changes.push(`Timelock: ${tlLabel(prev.timeLock)} → ${tlLabel(now.timeLock)}`);
    if (severity !== 'CRITICAL') severity = 'HIGH';
  } else if (prev.timeLock === 0 && now.timeLock > 0) {
    changes.push(`Timelock: none → ${tlLabel(now.timeLock)}`);
  }

  if (prev.configAuthority !== now.configAuthority) {
    if (now.configAuthority && now.configAuthority !== 'autonomous') {
      changes.push(`External admin key on multisig: none → ${now.configAuthority.slice(0, 12)}...`);
      severity = 'CRITICAL';
    } else if (now.configAuthority === 'autonomous') {
      changes.push(`External admin key on multisig: removed`);
    } else {
      console.warn(`[CONFIG_DIFF] configAuthority missing/null on state read, skipping diff alert`);
    }
  }

  if (changes.length === 0) {
    changes.push('Config executed; no diff on tracked fields');
  }

  return { severity, changes };
}

function classifyEvent(type: string, _protocol: string, description: string): { severity: 'CRITICAL' | 'HIGH' | 'MONITOR'; alertMonitor: boolean } {
  const desc = description.toLowerCase();
  const upper = (type || '').toUpperCase();
  const utcHour = new Date().getUTCHours();
  const isOffHours = utcHour < 6 || utcHour >= 22;

  if (upper === 'EXECUTE_CONFIG_TRANSACTION' || upper.includes('SET_AUTHORITY') ||
      desc.includes('threshold') || desc.includes('configauthority')) {
    return { severity: 'CRITICAL', alertMonitor: true };
  }

  if (upper.includes('UPGRADE_PROGRAM') || upper.includes('FINALIZE_PROGRAM')) {
    return { severity: 'HIGH', alertMonitor: true };
  }

  if (upper === 'CREATE_CONFIG_TRANSACTION') {
    return { severity: 'HIGH', alertMonitor: true };
  }

  if (isOffHours && (upper.includes('EXECUTE') || upper.includes('CREATE_VAULT'))) {
    return { severity: 'HIGH', alertMonitor: true };
  }

  if (upper === 'EXECUTE_VAULT_TRANSACTION' || upper === 'EXECUTE_TRANSACTION' ||
      upper.includes('REJECT') || upper.includes('CANCEL')) {
    return { severity: 'MONITOR', alertMonitor: true };
  }

  return { severity: 'MONITOR', alertMonitor: false };
}

async function checkSignerFunding(event: any) {
  const findings = detectNewFunders(event);
  if (findings.length === 0) return;

  for (const f of findings) {
    const protocols = findProtocolsForSigner(f.signer);
    const protocolLabel = protocols.length > 0 ? protocols.join(', ') : 'Unknown protocol';
    const ukTime = formatUKTime(new Date(f.timestamp * 1000));
    const solStr = f.amountSol < 0.01 ? f.amountSol.toFixed(6) : f.amountSol.toFixed(4);

    const repeatTag = f.isRepeatOffender ? ' [REPEAT ACTOR]' : '';
    const logLine = `[SIGNER_FUNDING] NEW FUNDER${repeatTag}: ${f.funder.slice(0, 12)} → ${f.signer.slice(0, 12)} (${protocolLabel}) ${solStr} SOL`;
    console.log(logLine);
    const activityDetail = f.isRepeatOffender
      ? `Repeat cross-protocol funder ${f.funder.slice(0, 12)} sent ${solStr} SOL to signer ${f.signer.slice(0, 8)} (prior hits: ${f.priorProtocolsHit.join(', ')})`
      : `New funder for signer ${f.signer.slice(0, 8)}: ${f.funder.slice(0, 12)} sent ${solStr} SOL`;
    logActivity(protocolLabel, 'SignerFundingAnomaly', activityDetail);

    const repeatLine = f.isRepeatOffender
      ? `\nFunder previously seen on: ${f.priorProtocolsHit.join(', ')}`
      : '';
    const headline = f.isRepeatOffender
      ? '🔴 <b>Cross-protocol funder reappearing</b>'
      : '🔴 <b>New funder for tracked signer</b>';

    const msg = `${headline}\n\n` +
      `<b>${protocolLabel}</b>\n` +
      `Signer: <code>${f.signer}</code>\n` +
      `Funder: <code>${f.funder}</code>\n` +
      `Amount: ${solStr} SOL (first time from this funder to this signer)\n` +
      `📅 ${ukTime}` +
      repeatLine + `\n\n` +
      `<code>${f.signature.slice(0, 24)}...</code>`;
    await sendTelegram(msg, 'CRITICAL');

    persistNewFunder(f.signer, f.funder, f.amountSol, f.timestamp);
  }
}

async function processWebhookEvent(event: any) {
  const sig = event.signature;
  if (!sig || processedSignatures.has(sig)) return;
  addProcessedSig(sig);

  try { await checkSignerFunding(event); } catch (e: any) { console.error('[SIGNER_FUNDING] check failed:', e.message); }

  const type = event.type || 'UNKNOWN';
  const description = event.description || '';
  const feePayer = event.feePayer || '';
  const timestamp = event.timestamp ? new Date(event.timestamp * 1000).toISOString() : new Date().toISOString();
  const timeStr = timestamp.replace('T', ' ').slice(0, 19);

  let protocol = 'Unknown';
  const involvedAddresses = [feePayer];
  if (event.accountData) {
    for (const ad of event.accountData) {
      if (ad.account) involvedAddresses.push(ad.account);
    }
  }
  if (event.instructions) {
    for (const ix of event.instructions) {
      if (ix.accounts) involvedAddresses.push(...ix.accounts);
    }
  }

  for (const addr of involvedAddresses) {
    if (ADDRESS_TO_PROTOCOL[addr]) {
      protocol = ADDRESS_TO_PROTOCOL[addr];
      break;
    }
  }

  let upgradedProgramId = '';
  let upgradedProgramName = '';
  if (type === 'UPGRADE_PROGRAM_INSTRUCTION' || type === 'FINALIZE_PROGRAM_INSTRUCTION') {
    const logs = Array.isArray(event.logMessages)
      ? event.logMessages
      : Array.isArray(event.meta?.logMessages)
        ? event.meta.logMessages
        : Array.isArray(event.transaction?.meta?.logMessages)
          ? event.transaction.meta.logMessages
          : [];
    for (const line of logs) {
      const m = String(line).match(/Upgraded program ([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (m) {
        upgradedProgramId = m[1];
        if (PROGRAM_ID_TO_NAME[upgradedProgramId]) {
          upgradedProgramName = PROGRAM_ID_TO_NAME[upgradedProgramId];
          if (protocol === 'Unknown') protocol = upgradedProgramName;
        }
        break;
      }
    }
    if (!upgradedProgramId) {
      for (const addr of involvedAddresses) {
        if (PROGRAM_ID_TO_NAME[addr]) {
          upgradedProgramName = PROGRAM_ID_TO_NAME[addr];
          upgradedProgramId = addr;
          if (protocol === 'Unknown') protocol = upgradedProgramName;
          break;
        }
      }
    }
    if (!upgradedProgramId && protocol === 'Unknown') {
      const systemAddrs = new Set(['11111111111111111111111111111111', 'BPFLoaderUpgradeab1e11111111111111111111111', 'SysvarC1ock11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111']);
      for (const addr of involvedAddresses) {
        if (!systemAddrs.has(addr) && addr !== feePayer) {
          upgradedProgramId = addr + ' (best-guess, buffer or unrelated)';
          break;
        }
      }
    }
  }

  const activityType =
    type === 'EXECUTE_TRANSACTION' ? 'VaultTx' :
    type === 'APPROVE_TRANSACTION' ? 'Approval' :
    type === 'CREATE_TRANSACTION' ? 'ProposalCreated' :
    type === 'REJECT_TRANSACTION' ? 'Rejection' :
    type === 'CANCEL_TRANSACTION' ? 'Cancellation' :
    type === 'UPGRADE_PROGRAM_INSTRUCTION' || type === 'FINALIZE_PROGRAM_INSTRUCTION' ? 'ProgramUpgrade' :
    'GovernanceActivity';

  const shortDesc = description.length > 120 ? description.slice(0, 120) + '...' : description;

  const niceTypeLabel = (
    type === 'EXECUTE_CONFIG_TRANSACTION' ? 'Config change' :
    type === 'UPGRADE_PROGRAM_INSTRUCTION' ? 'Program upgrade' :
    type === 'FINALIZE_PROGRAM_INSTRUCTION' ? 'Program finalised' :
    type === 'EXECUTE_TRANSACTION' ? 'Vault transaction executed' :
    type === 'APPROVE_TRANSACTION' ? 'Proposal approved' :
    type === 'CREATE_TRANSACTION' ? 'Proposal created' :
    type === 'REJECT_TRANSACTION' ? 'Proposal rejected' :
    type === 'CANCEL_TRANSACTION' ? 'Proposal cancelled' :
    type.replace(/_/g, ' ').toLowerCase()
  );
  const programDetail = upgradedProgramId
    ? ` (program ${upgradedProgramId.slice(0, 12)}...)`
    : '';
  logActivity(protocol, activityType, `${niceTypeLabel}${programDetail}`);

  let { severity, alertMonitor } = classifyEvent(type, protocol, description);
  let diffChanges: string[] = [];

  if (type === 'EXECUTE_CONFIG_TRANSACTION' && conn) {
    let multisigAddr: string | null = null;
    for (const addr of involvedAddresses) {
      if (ADDRESS_TO_PROTOCOL[addr]) { multisigAddr = addr; break; }
    }
    if (multisigAddr) {
      await new Promise(r => setTimeout(r, 1500));
      const newState = await fetchMultisigState(multisigAddr);
      if (newState) {
        let prevState = null;
        try {
          const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
          const protocolState = state[protocol];
          if (protocolState && protocolState.threshold !== undefined) {
            prevState = {
              threshold: protocolState.threshold,
              memberCount: protocolState.members?.length || 0,
              timeLock: protocolState.timeLock || 0,
              configAuthority: protocolState.configAuthority || 'autonomous',
            };
          }
        } catch (e: any) { console.error('[CONFIG_DIFF] prev state read failed:', e?.message || e); }

        const diff = classifyConfigDiff(prevState, newState);
        severity = diff.severity;
        alertMonitor = true;
        diffChanges = diff.changes;
        console.log(`[CONFIG_DIFF] ${protocol}: ${diff.severity} | ${diff.changes.join(' | ')}`);

        try {
          const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {};
          state[protocol] = {
            ...(state[protocol] || {}),
            threshold: newState.threshold,
            members: state[protocol]?.members || [],
            timeLock: newState.timeLock,
            configAuthority: newState.configAuthority,
            lastChecked: new Date().toISOString(),
          };
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        } catch (e: any) { console.error('[STATE] write failed:', e?.message || e); }
      }
    }
  }

  const ukTime = formatUKTime(new Date(timestamp));
  const upgradeInfo = upgradedProgramId ? `\nProgram: <code>${upgradedProgramId.slice(0, 16)}...</code>` : '';

  console.log(`[WEBHOOK] ${severity} | ${protocol} | ${type} | ${ukTime} | ${sig}`);

  const diffText = diffChanges.length > 0 ? '\n' + diffChanges.join('\n') : '';

  const niceTitle = (
    type === 'EXECUTE_CONFIG_TRANSACTION' ? 'Config change' :
    type === 'UPGRADE_PROGRAM_INSTRUCTION' ? 'Program upgrade' :
    type === 'FINALIZE_PROGRAM_INSTRUCTION' ? 'Program finalised' :
    type === 'EXECUTE_TRANSACTION' ? 'Vault transaction executed' :
    type === 'APPROVE_TRANSACTION' ? 'Proposal approved' :
    type === 'CREATE_TRANSACTION' ? 'Proposal created' :
    type === 'REJECT_TRANSACTION' ? 'Proposal rejected' :
    type === 'CANCEL_TRANSACTION' ? 'Proposal cancelled' :
    type.replace(/_/g, ' ').toLowerCase()
  );

  const isUpgradeEventCoveredByListener =
    type === 'UPGRADE_PROGRAM_INSTRUCTION' || type === 'FINALIZE_PROGRAM_INSTRUCTION';

  const subType: SubEventType | undefined =
    type === 'EXECUTE_CONFIG_TRANSACTION' ? 'ConfigChange' :
    type === 'UPGRADE_PROGRAM_INSTRUCTION' ? 'ProgramUpgrade' :
    type === 'FINALIZE_PROGRAM_INSTRUCTION' ? 'ProgramUpgrade' :
    type === 'EXECUTE_TRANSACTION' || type.includes('VAULT') ? 'VaultTx' :
    undefined;

  if (severity === 'CRITICAL') {
    const msg = `🔴 <b>CRITICAL: ${niceTitle}</b>\n\n<b>${protocol}</b>${upgradeInfo}${diffText || '\n' + shortDesc}\n📅 ${ukTime}\n\n<code>${sig.slice(0, 20)}...</code>`;
    if (!isUpgradeEventCoveredByListener) {
      await sendTelegram(msg, 'CRITICAL');
      const pubBody = diffText || `\n${shortDesc}`;
      const pub = `<b>${protocol}</b>${pubBody}\n${ukTime} UTC\nsolgov.xyz`;
      await sendPublic(pub);
    } else {
      console.log(`[WEBHOOK] suppressing duplicate ${type} for ${protocol}; listener handles upgrade events`);
    }
    if (!isUpgradeEventCoveredByListener) {
      await sendToSubscribers({ protocol, severity: 'CRITICAL', type: subType, message: msg });
    }
  } else if (severity === 'HIGH') {
    const msg = `🟡 <b>${niceTitle}</b>\n\n<b>${protocol}</b>${upgradeInfo}${diffText || '\n' + shortDesc}\n📅 ${ukTime}`;
    if (!isUpgradeEventCoveredByListener) {
      await sendTelegram(msg, 'HIGH');
      if (type.includes('VAULT')) {
        const pub = `<b>${protocol}</b>\n${niceTitle}${upgradeInfo}\n${ukTime} UTC\nsolgov.xyz`;
        await sendPublic(pub);
      }
    } else {
      console.log(`[WEBHOOK] suppressing duplicate ${type} for ${protocol}; listener handles upgrade events`);
    }
    if (!isUpgradeEventCoveredByListener) {
      await sendToSubscribers({ protocol, severity: 'HIGH', type: subType, message: msg });
    }
  } else if (alertMonitor) {
    const msg = diffChanges.length > 0
      ? `📋 <b>${protocol}</b> governance update${diffText}\n${ukTime}`
      : `📋 <b>${protocol}</b> ${niceTitle.toLowerCase()}${upgradeInfo}\n${ukTime}`;
    if (!isUpgradeEventCoveredByListener) {
      await sendTelegram(msg, 'MONITOR');
      await sendToSubscribers({ protocol, severity: 'MONITOR', type: subType, message: msg });
    }
  }
}

async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (WEBHOOK_SECRET && url.searchParams.get('token') !== WEBHOOK_SECRET) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorised' }));
    return;
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 5_000_000) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }
  }

  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));

  try {
    const events = JSON.parse(body);
    if (!Array.isArray(events)) {
      console.error('[WEBHOOK] Payload is not an array');
      return;
    }
    console.log(`[WEBHOOK] Received ${events.length} events`);
    for (const event of events) {
      try {
        await processWebhookEvent(event);
      } catch (e: any) {
        console.error('[WEBHOOK] Event processing error:', e.message);
      }
    }
  } catch (e: any) {
    console.error('[WEBHOOK] JSON parse error:', e.message);
  }
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = parseInt(process.env.SOLGOV_API_RATE_LIMIT_MAX || '60', 10);
const WRITE_RATE_LIMIT_MAX = parseInt(process.env.SOLGOV_API_WRITE_RATE_LIMIT_MAX || '10', 10);
const GLOBAL_RATE_LIMIT_MAX = parseInt(process.env.SOLGOV_API_GLOBAL_RATE_LIMIT_MAX || '6000', 10);
type RateBucket = { count: number; windowStart: number };
const rateBuckets = new Map<string, RateBucket>();
const writeRateBuckets = new Map<string, RateBucket>();
const globalBucket: RateBucket = { count: 0, windowStart: Date.now() };

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function bumpBucket(bucket: RateBucket | undefined, max: number, now: number): { allowed: boolean; remaining: number; resetSec: number; bucket: RateBucket } {
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    const fresh: RateBucket = { count: 1, windowStart: now };
    return { allowed: true, remaining: max - 1, resetSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000), bucket: fresh };
  }
  if (bucket.count >= max) {
    const resetSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart)) / 1000);
    return { allowed: false, remaining: 0, resetSec, bucket };
  }
  bucket.count++;
  const resetSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart)) / 1000);
  return { allowed: true, remaining: max - bucket.count, resetSec, bucket };
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetSec: number } {
  const now = Date.now();
  const r = bumpBucket(rateBuckets.get(ip), RATE_LIMIT_MAX, now);
  rateBuckets.set(ip, r.bucket);
  return { allowed: r.allowed, remaining: r.remaining, resetSec: r.resetSec };
}

function checkWriteRateLimit(ip: string): { allowed: boolean; remaining: number; resetSec: number } {
  const now = Date.now();
  const r = bumpBucket(writeRateBuckets.get(ip), WRITE_RATE_LIMIT_MAX, now);
  writeRateBuckets.set(ip, r.bucket);
  return { allowed: r.allowed, remaining: r.remaining, resetSec: r.resetSec };
}

function checkGlobalRateLimit(): { allowed: boolean; resetSec: number } {
  const now = Date.now();
  if (now - globalBucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    globalBucket.count = 1;
    globalBucket.windowStart = now;
    return { allowed: true, resetSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
  }
  if (globalBucket.count >= GLOBAL_RATE_LIMIT_MAX) {
    const resetSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - globalBucket.windowStart)) / 1000);
    return { allowed: false, resetSec };
  }
  globalBucket.count++;
  return { allowed: true, resetSec: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - globalBucket.windowStart)) / 1000) };
}

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, b] of rateBuckets) if (b.windowStart < cutoff) rateBuckets.delete(ip);
  for (const [ip, b] of writeRateBuckets) if (b.windowStart < cutoff) writeRateBuckets.delete(ip);
}, RATE_LIMIT_WINDOW_MS).unref();

async function readJsonBody(req: http.IncomingMessage, maxBytes = 8192): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const VALID_SEVERITIES: WebhookSeverity[] = ['CRITICAL', 'HIGH', 'MONITOR'];

function sanitiseWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'url must be a string' };
  if (raw.length > 2000) return { ok: false, error: 'url too long' };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, error: 'url not parseable' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'url must use http or https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'url must not contain credentials' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, error: 'url missing host' };
  // Reject obvious internal hostnames
  const internalHostnames = ['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.goog'];
  if (internalHostnames.includes(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return { ok: false, error: 'url targets a non-public host' };
  }
  // Reject IP-shaped hosts that point inside the VPS / private ranges / metadata
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = parseInt(ipv4[1], 10), b = parseInt(ipv4[2], 10);
    const isPrivate =
      a === 0 ||                             // unspecified
      a === 10 ||                            // 10/8
      a === 127 ||                           // loopback
      (a === 169 && b === 254) ||            // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||   // 172.16/12
      (a === 192 && b === 168) ||            // 192.168/16
      a === 100 && (b >= 64 && b <= 127) ||  // CGNAT
      a >= 224;                              // multicast / reserved
    if (isPrivate) return { ok: false, error: 'url targets a non-public IP range' };
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:') || host === '::') {
    return { ok: false, error: 'url targets a non-public IPv6 range' };
  }
  return { ok: true, url: parsed.toString() };
}

async function handleWebhookSubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (e: any) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: e.message || 'invalid body' }));
    return;
  }
  const rawUrl = body?.url;
  const sanitised = sanitiseWebhookUrl(rawUrl);
  if (!sanitised.ok) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: sanitised.error }));
    return;
  }
  const url = sanitised.url;
  const protocols = Array.isArray(body.protocols) ? body.protocols.filter((s: any) => typeof s === 'string') : undefined;
  const sevsRaw = Array.isArray(body.severities) ? body.severities.filter((s: any) => typeof s === 'string') : undefined;
  const severities = sevsRaw?.map((s: string) => s.toUpperCase() as WebhookSeverity).filter((s: WebhookSeverity) => VALID_SEVERITIES.includes(s));
  const types = Array.isArray(body.types) ? body.types.filter((s: any) => typeof s === 'string') : undefined;
  try {
    const sub = createSubscription({ url, protocols, severities, types });
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(201);
    res.end(JSON.stringify({
      id: sub.id,
      secret: sub.secret,
      url: sub.url,
      protocols: sub.protocols,
      severities: sub.severities,
      types: sub.types,
      createdAt: sub.createdAt,
      verifyHmacAlgorithm: 'sha256',
      verifyHmacHeader: 'X-SolGov-Signature',
      note: 'Store this secret. It is shown once and used to verify HMAC signatures on every delivery.',
    }));
  } catch (e: any) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: e.message || 'subscription failed' }));
  }
}

async function handleWebhookGet(id: string, url: URL, res: http.ServerResponse) {
  const secret = url.searchParams.get('secret') || '';
  const sub = getWebhookSub(id, secret);
  res.setHeader('Content-Type', 'application/json');
  if (!sub) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found or wrong secret' }));
    return;
  }
  res.writeHead(200);
  res.end(JSON.stringify(publicView(sub)));
}

async function handleWebhookDelete(id: string, url: URL, res: http.ServerResponse) {
  const secret = url.searchParams.get('secret') || '';
  const ok = deleteWebhookSub(id, secret);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(ok ? 200 : 404);
  res.end(JSON.stringify({ deleted: ok }));
}

function buildOpenApiSpec(host: string): any {
  const proto = host.includes('localhost') ? 'http' : 'https';
  const publicUrl = process.env.SOLGOV_PUBLIC_URL || `${proto}://${host}`;
  return {
    openapi: '3.1.0',
    info: {
      title: 'SolGov Public API',
      version: '1.0.0',
      description: 'Live Solana governance state across 50+ DeFi protocols.\n\n' +
        '**Data freshness**\n' +
        '- Live multisig state (threshold, members, timelock, configAuthority): refreshed within ~30 minutes.\n' +
        '- Activity feed (`/alerts/recent`): real-time, append-only as events land on-chain.\n' +
        '- Historical aggregates (`/historical`): refreshed weekly; expect up to 7 days of lag.\n\n' +
        '**Scope**\n' +
        'Coverage is the protocols solgov actively tracks. Protocols outside that set are not represented; absence in the response does not imply absence on chain. The `governanceModel` field on each protocol indicates the underlying governance pattern: `squads-v4`, `squads-v3`, `serum-multisig`, `realms-dao`, `wormhole-guardians`, `single-signer`, etc. Protocols without a Squads multisig (e.g. single-signer, DAO-governed) return `threshold: 0, totalMembers: 0` because there is no multisig to count; consult `governanceModel` to interpret.\n\n' +
        '**Rate limits**\n' +
        'Reads: 60 requests / minute / IP. Writes (POST/DELETE): 10 requests / minute / IP. Limits surface as `X-RateLimit-*` headers and 429 / 503 responses with `Retry-After`.\n\n' +
        '**Corrections**\n' +
        'Found a discrepancy? DM @Trader_CSK on X.',
      contact: { name: 'SolGov', url: 'https://solgov.xyz' },
    },
    servers: [{ url: publicUrl }],
    paths: {
      '/api/v1/protocols': {
        get: {
          summary: 'List tracked protocols',
          description: 'Sorted list of every protocol solgov currently monitors. Includes derived `canonical` and `role` fields so secondary multisigs (treasury, governance) roll up to the parent protocol.',
          responses: { '200': { description: 'Sorted list of protocol names with canonical mapping' } },
        },
      },
      '/api/v1/governance': {
        get: {
          summary: 'Live governance slice for every tracked protocol',
          description: 'One row per tracked protocol with current threshold, signer count, timelock, configAuthority, pending proposals, threat alerts, and governance model. Refreshed within ~30 minutes. Each row also includes `lastChecked` and `stalenessHours` so freshness is self-reporting.',
          parameters: [{ name: 'protocols', in: 'query', schema: { type: 'string' }, description: 'Comma-separated names to filter (case-insensitive substring match)' }],
          responses: { '200': { description: 'Map of protocol to governance slice' } },
        },
      },
      '/api/v1/governance/{protocol}': {
        get: {
          summary: 'Single-protocol governance slice (with members)',
          description: 'Same shape as `/governance` but for one protocol. Adds the full member list, threat alert detail, program upgrade authorities, and `governanceModel`. Name match is case-insensitive with substring fallback.',
          parameters: [{ name: 'protocol', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Governance slice' },
            '404': { description: 'Protocol not tracked' },
          },
        },
      },
      '/api/v1/alerts/recent': {
        get: {
          summary: 'Recent governance events feed (real-time)',
          description: 'Append-only event log of every governance change observed across all tracked protocols. Events are produced in real time as on-chain transactions land. Newest first. Capped at 500 entries; rolls over.',
          parameters: [
            { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'ISO 8601. Filter to events with timestamp >= this value.' },
            { name: 'protocol', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive substring match against protocol name.' },
            { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Filter by event type, e.g. `ConfigChange`, `ProgramUpgrade`, `Approval`.' },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 50 } },
          ],
          responses: { '200': { description: 'Filtered event list, newest first' } },
        },
      },
      '/api/v1/search': {
        get: {
          summary: 'Resolve a base58 address to protocols',
          description: 'Looks up which tracked protocol a Solana address appears in, as a multisig signer or program upgrade authority. Searches against current live state only; does not search historical signers who have since been removed.',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Solana base58 pubkey to resolve' }],
          responses: { '200': { description: 'List of protocol/role pairs the address appears in' } },
        },
      },
      '/api/v1/state': {
        get: {
          summary: 'Full monitor state (heavy)',
          description: 'Complete state object: every tracked protocol\'s live multisig data, plus the recent activity log. ~100 KB response. Prefer `/governance` or `/governance/{protocol}` for normal use; `/state` is intended for the dashboard and bulk integrations.',
          responses: { '200': { description: 'Complete state object' } },
        },
      },
      '/api/v1/historical': {
        get: {
          summary: 'Scan-derived aggregates (refreshed weekly)',
          description: 'Cumulative on-chain activity counts per protocol: total transactions, approved/rejected/cancelled proposals, configuration changes, program upgrades, unique fee payers. Recomputed weekly via an incremental on-chain scan. Each entry has its own `lastUpdated` timestamp; expect entries to be up to 7 days behind the live `/governance` view.',
          responses: { '200': { description: 'Historical aggregates per protocol, with per-entry lastUpdated' } },
        },
      },
      '/api/v1/health': {
        get: {
          summary: 'Liveness and freshness check',
          description: 'Reports liveness and the age of the underlying state file in minutes. Useful for client-side freshness assertions.',
          responses: { '200': { description: 'Status report' } },
        },
      },
      '/api/v1/track': {
        get: {
          summary: 'List user-tracked Squads v4 multisigs currently being monitored',
          responses: { '200': { description: 'Array of {address, label, addedAt}, with cap and current count' } },
        },
        post: {
          summary: 'Submit any Squads v4 multisig address for live monitoring',
          description: 'Validates on-chain that the address is a Squads v4 multisig before adding. Monitoring for new addresses begins within ~60 seconds. Subscribe to alerts via the Telegram bot or POST /api/webhooks afterwards.',
          requestBody: {
            required: true,
            content: { 'application/json': {
              schema: {
                type: 'object',
                required: ['address'],
                properties: {
                  address: { type: 'string', description: 'Solana base58 pubkey of the Squads v4 multisig account' },
                  label: { type: 'string', description: 'Optional display label, max 60 chars' },
                },
              },
            }},
          },
          responses: {
            '201': { description: 'Added; verification metadata returned' },
            '400': { description: 'Bad address, not on-chain, or not a Squads v4 multisig' },
            '409': { description: 'Tracking cap reached' },
            '503': { description: 'On-chain validation temporarily unavailable' },
          },
        },
      },
      '/api/webhooks': {
        post: {
          summary: 'Subscribe to push delivery',
          requestBody: {
            required: true,
            content: { 'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  protocols: { type: 'array', items: { type: 'string' }, description: 'omit or empty for all' },
                  severities: { type: 'array', items: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MONITOR'] } },
                  types: { type: 'array', items: { type: 'string' } },
                },
              },
            }},
          },
          responses: { '201': { description: 'Subscription created. Response includes the secret used to verify deliveries.' } },
        },
      },
      '/api/webhooks/{id}': {
        get: {
          summary: 'View subscription config',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'secret', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Subscription record' }, '404': { description: 'Not found or wrong secret' } },
        },
        delete: {
          summary: 'Unsubscribe',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'secret', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found or wrong secret' } },
        },
      },
    },
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/v1/')) {
    url.pathname = '/api/' + url.pathname.slice('/api/v1/'.length);
  }

  const isApiPath = url.pathname.startsWith('/api/');
  const isApiGet = isApiPath && req.method === 'GET';
  const isApiWrite = isApiPath && (req.method === 'POST' || req.method === 'DELETE');

  if (isApiPath && req.method !== 'OPTIONS') {
    const global = checkGlobalRateLimit();
    if (!global.allowed) {
      res.setHeader('Retry-After', String(global.resetSec));
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Service temporarily overloaded', retryAfterSeconds: global.resetSec }));
      return;
    }
  }

  if (isApiGet) {
    const ip = clientIp(req);
    const rl = checkRateLimit(ip);
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(rl.resetSec));
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.resetSec));
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(429);
      res.end(JSON.stringify({ error: 'Too many requests', retryAfterSeconds: rl.resetSec }));
      return;
    }
  } else if (isApiWrite) {
    const ip = clientIp(req);
    const rl = checkWriteRateLimit(ip);
    res.setHeader('X-RateLimit-Limit', String(WRITE_RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(rl.resetSec));
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.resetSec));
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(429);
      res.end(JSON.stringify({ error: 'Too many write requests', retryAfterSeconds: rl.resetSec }));
      return;
    }
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      raw._activityLog = readActivityLog().filter(e => e?.type !== 'Watching');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      res.writeHead(200);
      res.end(JSON.stringify(raw));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'State file not found' }));
    }
  } else if (url.pathname === '/api/historical' && req.method === 'GET') {
    try {
      const raw = fs.existsSync(HISTORICAL_FILE)
        ? JSON.parse(fs.readFileSync(HISTORICAL_FILE, 'utf-8'))
        : {};
      const normalised: Record<string, any> = {};
      for (const [k, v] of Object.entries(raw)) {
        const canon = HISTORICAL_NAME_MAP[k] || k;
        normalised[canon] = v;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      res.writeHead(200);
      res.end(JSON.stringify(normalised));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Historical state read failed' }));
    }
  } else if (url.pathname === '/api/protocols' && req.method === 'GET') {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const names = Object.keys(state).filter(k => !k.startsWith('_')).sort();
      const entries = names.map(name => ({ name, ...resolveCanonical(name) }));
      const canonicalCount = entries.filter(e => e.role === 'primary').length;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify({
        asOf: new Date().toISOString(),
        count: names.length,
        canonicalCount,
        protocols: names,
        entries,
      }));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'State file not found' }));
    }
  } else if ((url.pathname === '/api/governance' || url.pathname === '/api/governance/') && req.method === 'GET') {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const wanted = url.searchParams.get('protocols')?.split(',').map(s => s.trim()).filter(Boolean) || null;
      const all = Object.keys(state)
        .filter(k => !k.startsWith('_'))
        .filter(k => !wanted || wanted.some(w => nameMatches(k, w)))
        .sort();
      const out: Record<string, any> = {};
      const now = Date.now();
      for (const name of all) {
        const p = state[name];
        const lastCheckedIso: string | null = p.lastChecked || null;
        const stalenessHours = lastCheckedIso
          ? Math.round((now - new Date(lastCheckedIso).getTime()) / 3600_000)
          : null;
        const tlSec = p.timeLock ?? 0;
        const tlLabel = tlSec === 0 ? 'None' : tlSec === -1 ? 'N/A' : `${Math.round(tlSec / 3600)}h`;
        const memberKeysRaw: string[] = (p.members || []).map((m: any) =>
          typeof m === 'string' ? m : (m.key || m.publicKey || '')
        );
        const memberKeys = Array.from(new Set(memberKeysRaw.filter(Boolean)));
        const { canonical, role } = resolveCanonical(name);
        out[name] = {
          canonical,
          role,
          governanceModel: resolveGovernanceModel(name),
          lastChecked: lastCheckedIso,
          stalenessHours,
          multisig: { threshold: p.threshold ?? null, totalMembers: memberKeys.length },
          timelock: { seconds: tlSec, label: tlLabel },
          configAuthority: normalizeConfigAuthority(p.configAuthority),
          openThreatAlerts: (p.threatAlerts || []).length,
          pendingProposals: p.pendingProposals ?? 0,
        };
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      res.writeHead(200);
      res.end(JSON.stringify({ asOf: new Date().toISOString(), count: all.length, protocols: out }));
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to read state', detail: e.message?.slice(0, 100) }));
    }
  } else if (url.pathname === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'q parameter required (Solana base58 address)' }));
      return;
    }
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const matches: Array<{ protocol: string; role: string; detail?: string }> = [];
      for (const [name, p] of Object.entries(state as Record<string, any>)) {
        if (name.startsWith('_')) continue;
        if (Array.isArray(p.members)) {
          for (const m of p.members) {
            const key = typeof m === 'string' ? m : (m.key || m.publicKey || '');
            if (key === q) matches.push({ protocol: name, role: 'multisig signer' });
          }
        }
        if (p.programAuthorities) {
          for (const [prog, auth] of Object.entries(p.programAuthorities as Record<string, string>)) {
            if (auth === q) matches.push({ protocol: name, role: 'program upgrade authority', detail: prog });
          }
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      res.writeHead(200);
      res.end(JSON.stringify({
        asOf: new Date().toISOString(),
        query: q,
        matchCount: matches.length,
        matches,
      }));
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to read state', detail: e.message?.slice(0, 100) }));
    }
  } else if (url.pathname === '/api/track' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=30');
    res.writeHead(200);
    res.end(JSON.stringify({
      asOf: new Date().toISOString(),
      cap: MAX_TRACKED,
      count: listTracked().length,
      tracked: listTracked().map(m => ({ address: m.address, label: m.label, addedAt: m.addedAt })),
    }));
  } else if (url.pathname === '/api/track' && req.method === 'POST') {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e: any) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message || 'invalid body' }));
      return;
    }
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    const label = typeof body?.label === 'string' ? body.label.trim() : undefined;
    if (!address) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'address (Solana base58) required' }));
      return;
    }
    if (!conn) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'on-chain validation temporarily unavailable' }));
      return;
    }
    if (listTracked().length >= MAX_TRACKED) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(409);
      res.end(JSON.stringify({ error: `Tracking cap reached (${MAX_TRACKED}). No new submissions accepted.` }));
      return;
    }
    const verified = await verifySquadsMultisig(conn, address);
    if (!verified.ok) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: verified.error }));
      return;
    }
    const result = addTracked({ address, label, addedBy: clientIp(req) });
    res.setHeader('Content-Type', 'application/json');
    if (!result.ok) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.writeHead(201);
    res.end(JSON.stringify({
      ok: true,
      address: result.entry!.address,
      label: result.entry!.label,
      addedAt: result.entry!.addedAt,
      verified: { threshold: verified.threshold, memberCount: verified.memberCount },
      note: 'Monitoring begins within ~60 seconds. Subscribe via the Telegram bot or webhook API to receive alerts.',
    }));
  } else if (url.pathname === '/api/yieldbay/incidents' && req.method === 'GET') {
    const cached = getCachedIncidents();
    const protoFilter = url.searchParams.get('protocol');
    const statusFilter = url.searchParams.get('status');
    const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.max(1, Math.min(isNaN(limitParam) ? 50 : limitParam, 500));
    let events = cached.events;
    if (protoFilter) {
      events = events.filter(e =>
        nameMatches(e.protocol_name, protoFilter) || nameMatches(e.protocol, protoFilter)
      );
    }
    if (statusFilter) {
      const allowed = statusFilter.split(',').map(s => s.trim().toLowerCase());
      events = events.filter(e => allowed.includes(e.status));
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.writeHead(200);
    res.end(JSON.stringify({
      asOf: new Date().toISOString(),
      sourceFetchedAt: cached.fetchedAt || null,
      sourceLastError: cached.lastError || null,
      source: 'https://api.yieldbay.fi',
      sourceLicense: 'classification preserved verbatim, no aggregation, no scoring',
      protocol: protoFilter || null,
      status: statusFilter || null,
      count: Math.min(events.length, limit),
      total: events.length,
      events: events.slice(0, limit),
    }));
  } else if (url.pathname === '/api/yieldbay/summary' && req.method === 'GET') {
    const cached = getCachedSummary();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.writeHead(200);
    res.end(JSON.stringify({
      asOf: new Date().toISOString(),
      sourceFetchedAt: cached.fetchedAt || null,
      sourceLastError: cached.lastError || null,
      source: 'https://api.yieldbay.fi',
      summary: cached.summary,
    }));
  } else if (url.pathname === '/api/openapi.json' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.writeHead(200);
    res.end(JSON.stringify(buildOpenApiSpec(req.headers.host || `localhost:${PORT}`)));
  } else if (url.pathname.startsWith('/api/governance/') && req.method === 'GET') {
    const rawName = decodeURIComponent(url.pathname.slice('/api/governance/'.length));
    if (!rawName) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Protocol name required: /api/governance/<name>' }));
      return;
    }
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const candidates = Object.keys(state).filter(k => !k.startsWith('_'));
      const exactKey = candidates.find(k => k.toLowerCase() === rawName.toLowerCase());
      const matchKey = exactKey || candidates.find(k => nameMatches(k, rawName));
      if (!matchKey) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'Protocol not tracked',
          query: rawName,
          hint: 'GET /api/protocols for the canonical list',
        }));
        return;
      }
      const p = state[matchKey];
      const lastCheckedIso: string | null = p.lastChecked || null;
      const stalenessHours = lastCheckedIso
        ? Math.round((Date.now() - new Date(lastCheckedIso).getTime()) / 3600_000)
        : null;
      const tlSec = p.timeLock ?? 0;
      const tlLabel = tlSec === 0 ? 'None' : tlSec === -1 ? 'N/A' : `${Math.round(tlSec / 3600)}h`;
      const memberKeysRaw: string[] = (p.members || []).map((m: any) =>
        typeof m === 'string' ? m : (m.key || m.publicKey || '')
      );
      const memberKeys = Array.from(new Set(memberKeysRaw.filter(Boolean)));
      const threats = (p.threatAlerts || []).map((t: any) => ({
        severity: t.severity,
        category: t.category,
        detail: t.detail,
        signer: t.signer,
        detectedAt: t.detectedAt,
      }));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify({
        asOf: new Date().toISOString(),
        protocol: matchKey,
        governanceModel: resolveGovernanceModel(matchKey),
        lastChecked: lastCheckedIso,
        stalenessHours,
        multisig: {
          threshold: p.threshold ?? null,
          totalMembers: memberKeys.length,
          members: memberKeys,
        },
        timelock: { seconds: tlSec, label: tlLabel },
        configAuthority: normalizeConfigAuthority(p.configAuthority),
        openThreatAlerts: threats.length,
        threatAlerts: threats,
        pendingProposals: p.pendingProposals ?? 0,
        programAuthorities: p.programAuthorities || {},
        source: `https://solgov.xyz`,
      }));
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to read state', detail: e.message?.slice(0, 100) }));
    }
  } else if (url.pathname === '/api/alerts/recent' && req.method === 'GET') {
    try {
      const liveLog: any[] = readActivityLog();
      const dashboardFeed = path.join(__dirname, '..', '..', 'public-dashboard', 'src', 'data', 'activity-feed.json');
      let mergedLog: any[] = liveLog.slice();
      if (fs.existsSync(dashboardFeed)) {
        try {
          const cron = JSON.parse(fs.readFileSync(dashboardFeed, 'utf-8'));
          if (Array.isArray(cron)) mergedLog = mergedLog.concat(cron);
        } catch {}
      }
      mergedLog = mergedLog.filter(e => e.type !== 'Watching');
      const seen = new Set<string>();
      mergedLog = mergedLog.filter(e => {
        const key = `${e.timestamp || e.date}|${e.protocol}|${e.type}|${e.detail || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const sinceParam = url.searchParams.get('since');
      const protoParam = url.searchParams.get('protocol');
      const typeParam = url.searchParams.get('type');
      const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Math.max(1, Math.min(isNaN(limitParam) ? 50 : limitParam, 500));
      let filtered = mergedLog;
      if (sinceParam) {
        const since = sinceParam;
        filtered = filtered.filter(e => (e.timestamp || e.date || '') >= since);
      }
      if (protoParam) {
        filtered = filtered.filter(e => e.protocol && nameMatches(e.protocol, protoParam));
      }
      if (typeParam) {
        const t = typeParam.toLowerCase();
        filtered = filtered.filter(e => (e.type || '').toLowerCase().includes(t));
      }
      filtered.sort((a, b) =>
        (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || '')
      );
      const events = filtered.slice(0, limit).map(e => ({
        timestamp: e.timestamp || e.date,
        date: e.date,
        protocol: e.protocol,
        type: e.type,
        detail: e.detail,
      }));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify({
        asOf: new Date().toISOString(),
        since: sinceParam || null,
        protocol: protoParam || null,
        type: typeParam || null,
        limit,
        count: events.length,
        events,
      }));
    } catch (e: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to read activity', detail: e.message?.slice(0, 100) }));
    }
  } else if (url.pathname === '/api/health' && req.method === 'GET') {
    const stateExists = fs.existsSync(STATE_FILE);
    const stateAge = stateExists
      ? Math.round((Date.now() - fs.statSync(STATE_FILE).mtimeMs) / 1000 / 60)
      : -1;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      stateFile: stateExists,
      stateAgeMinutes: stateAge,
    }));
  } else if (url.pathname === '/webhook' && req.method === 'POST') {
    await handleWebhook(req, res);
  } else if (url.pathname === '/api/webhooks' && req.method === 'POST') {
    await handleWebhookSubscribe(req, res);
  } else if (url.pathname.startsWith('/api/webhooks/') && req.method === 'GET') {
    const id = url.pathname.slice('/api/webhooks/'.length);
    await handleWebhookGet(id, url, res);
  } else if (url.pathname.startsWith('/api/webhooks/') && req.method === 'DELETE') {
    const id = url.pathname.slice('/api/webhooks/'.length);
    await handleWebhookDelete(id, url, res);
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`SolGov API running on port ${PORT}`);
  console.log(`  GET    /api/v1/state                    - current monitor state`);
  console.log(`  GET    /api/v1/historical               - scan-derived aggregates`);
  console.log(`  GET    /api/v1/protocols                - list of tracked protocols`);
  console.log(`  GET    /api/v1/governance               - bulk governance slice (all)`);
  console.log(`  GET    /api/v1/governance/<protocol>    - single-protocol slice`);
  console.log(`  GET    /api/v1/alerts/recent            - recent events feed`);
  console.log(`  GET    /api/v1/search?q=<address>       - resolve address to protocols`);
  console.log(`  GET    /api/v1/openapi.json             - OpenAPI 3.1 spec`);
  console.log(`  GET    /api/v1/health                   - health check`);
  console.log(`  POST   /api/webhooks                    - subscribe to push deliveries`);
  console.log(`  GET    /api/webhooks/<id>?secret=...    - view subscription`);
  console.log(`  DELETE /api/webhooks/<id>?secret=...    - unsubscribe`);
  console.log(`  GET    /api/v1/yieldbay/incidents       - Yieldbay crit+warn feed (cached, attributed)`);
  console.log(`  GET    /api/v1/yieldbay/summary         - Yieldbay per-protocol status (cached)`);
  console.log(`  GET    /api/v1/track                    - list user-tracked multisigs`);
  console.log(`  POST   /api/v1/track                    - submit any Squads v4 multisig for monitoring`);
  console.log(`  POST   /webhook                         - Helius webhook receiver`);
  if (WEBHOOK_SECRET) console.log(`  Webhook auth: token query param required`);
  if (conn) console.log(`  Connection: live multisig state diff enabled`);
  loadSignerWhitelists();
  startYieldbayPoller();
});
