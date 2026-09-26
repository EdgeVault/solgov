// Cron-driven scanner. Backfills V3 multisigs, Wormhole guardian sets, Realms DAOs, and anything the listener missed.

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import * as fs from 'fs';
import * as path from 'path';
import { escapeHtml, splitTelegramHtml } from './utils/telegram-html';
import { alertName } from './utils/display-names';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatUKTime(d: Date): string {
  const parts = d.toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false }).split(', ');
  const date = parts[0].split('/').reverse().join('-');
  const time = parts[1].slice(0, 5);
  const londonH = parseInt(d.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
  const suffix = ((londonH - d.getUTCHours() + 24) % 24) === 1 ? 'BST' : 'GMT';
  return `${date} ${time} ${suffix}`;
}

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_THREADS = {
  CRITICAL: 65,
  HIGH: 67,
  MONITOR: 69,
  PUBLIC: 21,
};
type Severity = 'CRITICAL' | 'HIGH' | 'MONITOR';

const STATE_FILE = path.join(__dirname, '..', 'data', 'monitor-state.json');

interface ProtocolDef {
  name: string;
  ms: string;
  type: 'v4' | 'v3' | 'serum' | 'other';
  tier: 1 | 2;
  active?: number;
  programs?: { name: string; id: string; expectedAuth: string }[];
}

const PROTOCOLS: ProtocolDef[] = [
  { name: 'Drift', ms: '7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM', type: 'v4', tier: 1, active: 6,
    programs: [
      { name: 'Protocol V2', id: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', expectedAuth: '8jj7zJgdr5bDndc7evM74FMGwzLPmd4u4QxNzFi1BMai' },
      { name: 'Velocity', id: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P', expectedAuth: '8jj7zJgdr5bDndc7evM74FMGwzLPmd4u4QxNzFi1BMai' },
      { name: 'JIT Proxy (Velocity)', id: 'J1TPRoXCtGuMcWiWFE6RB9eZU8U35PBMETCwNQLCNPhQ', expectedAuth: '8jj7zJgdr5bDndc7evM74FMGwzLPmd4u4QxNzFi1BMai' },
      { name: 'Vaults', id: 'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR', expectedAuth: 'Ad21qwCb3C98M6UNqjGsZgR48549Spp7W1UWETV29cZ9' },
      { name: 'JIT Proxy', id: 'J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP', expectedAuth: 'Ad21qwCb3C98M6UNqjGsZgR48549Spp7W1UWETV29cZ9' },
      { name: 'Oracle Receiver', id: 'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha', expectedAuth: 'Ad21qwCb3C98M6UNqjGsZgR48549Spp7W1UWETV29cZ9' },
      { name: 'Stake Voter', id: 'dVoTE1AJqkZVoE1mPbWcqYPmEEvAUBksHY2NiM2UJQe', expectedAuth: 'Ad21qwCb3C98M6UNqjGsZgR48549Spp7W1UWETV29cZ9' },
      { name: 'Competitions', id: 'DraWMeQX9LfzQQSYoeBwHAgM5JcqFkgrX7GbTfjzVMVL', expectedAuth: 'Ad21qwCb3C98M6UNqjGsZgR48549Spp7W1UWETV29cZ9' },
      { name: 'Merkle Distributor', id: 'E7HtfkEMhmn9uwL7EFNydcXBWy5WCYN1vFmKKjipEH1x', expectedAuth: 'Ad21qwCb3C98M6UNqjGsZgR48549Spp7W1UWETV29cZ9' },
      { name: 'V1 DAMM', id: 'dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN', expectedAuth: 'FdtiepBtP98oU2uPNgAzUoGwggUDdRXwJH2KJo3oUaix' },
    ] },
  { name: 'Pumpfun + PumpSwap', ms: '2yMoQqQrtbhq3nQ3wFoQQawWS65qcqUXcwHEYha4rshW', type: 'v4', tier: 1, active: 4,
    programs: [{ name: 'Bonding Curve', id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', expectedAuth: '7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8' }] },
  { name: 'Magic Eden', ms: 'J2SasfUti5RffbeohWpBDMiGsYGCN11fgyQKTVeREKYE', type: 'v4', tier: 1, active: 5,
    programs: [{ name: 'Marketplace', id: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', expectedAuth: '9GWPeu3cBfkGSEit6HMaAFKswoirxqgMqykMh7RVH2Bb' }] },
  { name: 'Exponent', ms: '51smH7pBDKJDgmVnVks3gMWaPQFfmQ5s4Fc223yHcjuH', type: 'v4', tier: 1, active: 4,
    programs: [{ name: 'Core', id: 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7', expectedAuth: '2tX7aHkV1r7am6bnTPqQJNBbEkbqDpNWHBYPahSQb9TP' }] },
  { name: 'Nosana', ms: 'ktKWwDt5J8NFMi5jQNRRBDKAhimU5tnrGCcXuYJmxqE', type: 'v4', tier: 1, active: 3,
    programs: [{ name: 'Jobs', id: 'nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM', expectedAuth: 'GXs53JMXbgdMDhtmjE9iNgSmC1gu8f3adZhXuCEq1Bx9' }] },
  { name: 'Lulo', ms: '8Sr4rQJL2aQT3EL97mbrk1T9VMw4pCS2mxMPp2QBzHQq', type: 'v4', tier: 1, active: 3,
    programs: [{ name: 'FlexLend', id: 'FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q', expectedAuth: 'FP1AgtaWxArMHtJqDZkxqMSUCCTwGLC3xgt85by9a1zs' }] },
  { name: 'Stabble', ms: 'AFRN2ECAY1YTbfkXD7yvoc1iaxYdt5BdyyqyPRsrHaK2', type: 'v4', tier: 1, active: 3,
    programs: [{ name: 'Stable Swap', id: 'swapNyd8XiQwJ6ianp9snpu4brUqFxadzvHebnAXjJZ', expectedAuth: '9rHUPE2ng7stBuaeAM7heiVHLLGPAqGjYKQ3BBUWxKSP' }] },
  { name: 'Hylo', ms: '2z3t2eBz7VL39Q3vEvaemd5mhT9XLoFofEH2cXvwCJvb', type: 'v4', tier: 1, active: 4 },
  { name: 'Drift (interim recovery)', ms: 'E44y4Gm693AFdGXk4zir5D3ivHn7jns9aWkm8c5q1NDQ', type: 'v4', tier: 1, active: 5 },
  { name: 'Loopscale', ms: 'C4awuufiuL8DNT5wMDP27HneKKqbgynrsbCa4XYGSuPk', type: 'v4', tier: 1, active: 7,
    programs: [
      { name: 'Loopscale', id: '1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78', expectedAuth: 'DwBXwJDZ4Av4miT62sEssWJUinkzwkmPPB4Fg3fKEfft' },
      { name: 'Beam', id: 'beamVVkNmKeXcuZ6zLpC9eM5YgVyAn4Z9xdPrz3gCW2', expectedAuth: 'DwBXwJDZ4Av4miT62sEssWJUinkzwkmPPB4Fg3fKEfft' },
    ] },

  { name: 'Orca', ms: 'BQsDWkL417U4tVE2sDnPks469pKdm6YzFgKH77doiEjF', type: 'v4', tier: 2, active: 6 },
  { name: 'Project 0', ms: '7FCPipJWVbPbdHymVt1gJYwKciakkJz5GahdQySemvHk', type: 'v4', tier: 2, active: 13 },
  { name: 'Kamino', ms: '6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM', type: 'v4', tier: 2, active: 10 },
  { name: 'Jupiter Perps', ms: 'AxkJ8oH5aDu4ZRWfsujPtxdb6Vhq4gDehpoReBgrUUSm', type: 'v4', tier: 2, active: 7 },
  { name: 'Jupiter Lend', ms: 'J3mJ3wz6xkVUk3T8qHnuAYNxsRH3ixHsryYNZAU2vG8P', type: 'v4', tier: 2, active: 7 },
  { name: 'Huma Finance', ms: 'uGLhzjot32i9nNKZKUoCzr7sG8bFAXQRN3uZPTUr7gX', type: 'v4', tier: 2, active: 6 },
  { name: 'Solstice', ms: 'AEb1u8FK8EuXLcPtprCy8s4NkqBNoP5mfbuEEop2dJGf', type: 'v4', tier: 2, active: 5 },
  { name: 'Switchboard', ms: '93RQfY6VHRkqXBCEhMY5u92bCGp428DTzqZUEA2Hjr9h', type: 'v4', tier: 2, active: 7 },
  { name: 'Titan', ms: 'F1WZezmt2J1dSsXrQWrS2Umn9CYzPPR2eP3sunZrMX29', type: 'v4', tier: 2, active: 6 },
  { name: 'Solayer', ms: '5AQ3c2nC3Ua5Ms1QP4XpcfaU2Q31C8VhiUJGX3c8zFqp', type: 'v4', tier: 2, active: 6 },
  { name: 'Flash Trade', ms: 'Gb33UeQNnQ4XDuobtGq9M6PVKRVfoH77p8d6JXsgqyXF', type: 'v4', tier: 2, active: 7,
    programs: [{ name: 'Perpetuals', id: 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn', expectedAuth: 'dhfZwJfdesv7fNW3nngCSjeGbx9zWUusLtfPaWbVKvo' }] },
  { name: 'Wick', ms: '8YmCRSNu7eCjLkhFB4LgDjjjGzfa37ztMoPhXZymWcCA', type: 'v4', tier: 2, active: 5 },

  { name: 'Onre Finance (treasury)', ms: '922xY8imV8NC1FXbaR9VFtNZV7RxQiq19gC42fQG5AfR', type: 'v4', tier: 2, active: 7, programs: [] },
  { name: 'Onre Finance', ms: '2AD4x72wXvjZVxSQPCt77NYZGXNdMbFvtD5F3mcUAtcN', type: 'v4', tier: 2, active: 7,
    programs: [{ name: 'Core', id: 'onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe', expectedAuth: 'FvmhydbpHGQzMUp51GmhB1fwsrkyfmnRsTg7oPwDe25f' }] },
  { name: 'MetaDAO', ms: '8N3Tvc6B1wEVKVC6iD4s6eyaCNqX2ovj2xze2q3Q9DWH', type: 'v4', tier: 2, active: 5,
    programs: [
      { name: 'Futarchy', id: 'FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq', expectedAuth: '6awyHMshBGVjJ3ozdSJdyyDE1CTAXUwrpNMaRGMsb4sf' },
      { name: 'Autocrat', id: 'auToUr3CQza3D4qreT6Std2MTomfzvrEeCC5qh7ivW5', expectedAuth: '6awyHMshBGVjJ3ozdSJdyyDE1CTAXUwrpNMaRGMsb4sf' },
      { name: 'AMM', id: 'AMMJdEiCCa8mdugg6JPF7gFirmmxisTfDJoSNSUi5zDJ', expectedAuth: '6awyHMshBGVjJ3ozdSJdyyDE1CTAXUwrpNMaRGMsb4sf' },
    ] },
  { name: 'Helium', ms: 'FXyzyVsmPRuZjbe97tsCpDqPAPPhBny4dr2hemo8XmL1', type: 'v4', tier: 2, active: 5,
    programs: [{ name: 'Entity Manager', id: 'hemjuPXBpNvggtaUnN1MwT3wrdhttKEfosTcc2P9Pg8', expectedAuth: 'pULUgsYtKvT7qhsL8QJ2oJXYQUeCCdjtfawPnBqEr3U' }] },
  { name: 'Voltr', ms: '7szuzpoZzah95BsAu2LQm3bpor5ofiAV4HuinyfFEdse', type: 'v4', tier: 1, active: 5,
    programs: [
      { name: 'Vaults', id: 'aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz', expectedAuth: 'G2FCNGgQQ7MYyJvkXw1du86YGR6vXXejuQG9LsjX1kEs' },
      { name: 'Vault (vVoLTR)', id: 'vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8', expectedAuth: 'G2FCNGgQQ7MYyJvkXw1du86YGR6vXXejuQG9LsjX1kEs' },
    ] },
  { name: 'Voltr (former 3/5)', ms: '5QctVSVmX1wdA9emmQFLQGnVbbiR6zPcDkmX8xEScxGH', type: 'v4', tier: 2, active: 5 },
  { name: 'Tessera V', ms: '3JW5VWy76TBT5NBbdyrWU6i3fz8XecDko7viGeFSKw7e', type: 'v4', tier: 2, active: 7,
    programs: [{ name: 'AMM', id: 'TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH', expectedAuth: '7bJ9xu9UGVZPtYzH1fMwdaKdvfhqeSJtoFc2eGrXBPhK' }] },

  { name: 'deBridge', ms: 'FHebUVvpfPzfcaWdhwYMP5uHLpRG6zbN8LcExJYAt8Ap', type: 'v4', tier: 1, active: 3,
    programs: [
      { name: 'Main', id: 'DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh', expectedAuth: 'BCTmawGzu1pMmaf9fdGaD1Mcfp8XQ6JiZ4jYaFzyeR1x' },
      { name: 'Settings', id: 'DeSetTwWhjZq6Pz9Kfdo1KoS5NqtsM6G8ERbX4SSCSft', expectedAuth: 'BCTmawGzu1pMmaf9fdGaD1Mcfp8XQ6JiZ4jYaFzyeR1x' },
    ] },
  { name: 'BisonFi', ms: '', type: 'other', tier: 1, active: 1,
    programs: [{ name: 'AMM', id: 'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi', expectedAuth: '6dDjBZdpafRKe7WuVHYTF1HphW1BWiKqioMD5eBGYipS' }] },
  { name: 'HumidiFi', ms: '', type: 'other', tier: 1, active: 1,
    programs: [{ name: 'AMM', id: '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp', expectedAuth: 'FMP7rvAsrs69YKBsaqgbB5mpnWrimNM8LNDfHLEzngLA' }] },
  { name: 'Photon', ms: '', type: 'other', tier: 1, active: 1,
    programs: [{ name: 'Trading Bot', id: 'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW', expectedAuth: '9Vv9LiU728TNdA9mR1w3xGPgcFaqpGA4Baeo7RGJJew6' }] },

  { name: 'Sanctum', ms: 'AApfiPZgV5MoPU691GwhdDhq5sKEMMH1Uh8S4Z9xvP6b', type: 'v3', tier: 2, active: 11 },
  { name: 'Jupiter Agg', ms: '7ZyDFzet6sKgZLN4D89JLfo7chu2n7nYdkFt5RCFk8Sf', type: 'v3', tier: 2, active: 8 },
  { name: 'Raydium', ms: 'tr8rgazUrZzgdkfc6Q622nVJHMMzh29trdBE2uBHb4u', type: 'v4', tier: 1, active: 4 },
  { name: 'Raydium (treasury)', ms: 'EXZY7FPccNuEvgHZMCMpww2Fen8oLWBSJzdgCsX3Djwm', type: 'v3', tier: 1, active: 3 },
  { name: 'Tensor', ms: '3djJ66VVaG7si2wsh9isspeZX13meHDvwBzuPGCowY4Z', type: 'v3', tier: 2, active: 9 },
  { name: 'Phoenix DEX', ms: '6x3BDkL2n7VjBWxRD95EsbQi2R2E4zxrvcz1VA6pihnK', type: 'v3', tier: 1, active: 5 },
  { name: 'Meteora', ms: 'CoEsykatDegLB7pcMJia79JSriDdi71nPnjgeSfw623k', type: 'v3', tier: 2, active: 8 },
  { name: 'Parcl', ms: '7qCHZqcbLm9VYUCLtFmFFSyDsvuZ5GHhypv7b4JRAEUE', type: 'v3', tier: 2, active: 5 },
  { name: 'Marinade', ms: 'magrsHFQxkkioAy45VWnZnFBBdKVdy2ZiRoRGYT9Wed', type: 'serum', tier: 2, active: 13 },
  { name: 'SPL Stake Pool', ms: '3yqoHFE4nBGchuVH5rJuZMFvsmnaDTuLLdvGPDUEJcbW', type: 'v3', tier: 2, active: 10 },

  { name: 'LayerZero OFT', ms: '9XnbnSvCk33J5Daxc9uJ2MxySTKPuM1KKoFJNmaAk7tN', type: 'v4', tier: 1, active: 1,
    programs: [{ name: 'OFT', id: '219m42qCuVirVvWs5GnkuX4aWFx5pX6D9RSTE1vsV5WS', expectedAuth: '6nopWptiA5bw3hDsAzDcwEcLSNcrYfbCErKmM14QZS31' }] },
  { name: 'SolvBTC', ms: 'HRr5HqBE7XXMTYD7V6MwojkHxYGttwozEx6atAprp7XE', type: 'v4', tier: 2, active: 5,
    programs: [{ name: 'Solv Protocol', id: 'soLv1S6GsAEVEnXmVY3oz6GtrNJteQ28iTyRQrHXvkz', expectedAuth: 'BsF2mR9brTd7u7wGWrejksQzsdrGFNcddRSYeNpHZixM' }] },
  { name: 'GMSOL', ms: 'CxnEVpQQcYa628TywzHGXeJ2jdVmbU51rnERat9xunP1', type: 'v4', tier: 2, active: 7,
    programs: [{ name: 'Core', id: 'Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo', expectedAuth: '6qp7veALWas5rxXJRQXUEbffRtDyhB8koxenBpS51SrA' }] },
  { name: 'Ore', ms: 'CHvPhBYPSEdjCrv5xUuzvscqwFYm5wMggWLk2Bvkjgwo', type: 'v4', tier: 1, active: 2,
    programs: [{ name: 'Ore V3', id: 'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv', expectedAuth: 'J5K5tWj3nKfxuSkAJ25WTMf4u5EsxJRfUoRKKxgrfFGV' }] },


  // Secondary governance multisigs surfaced by the dashboard role breakdowns. Each controls a
  // distinct set of programs alongside the protocol's primary multisig. Monitored for config drift.
  { name: 'Kamino (Liquidity)', ms: 'E7994UpSGhSpbpnuSepPXHBuMy3eRvHJL36DjTs1kb2b', type: 'v4', tier: 2, active: 7 },
  { name: 'Kamino (Farms)', ms: '5HzXCm7omo3M7sX5nC4XcAxcTXEC22UHegB1hQiRvbfk', type: 'v4', tier: 2, active: 10 },
  { name: 'Solstice (Aux)', ms: 'BPdkMGWnttz4izo6RD6pXpcbVgGiqD2GR3Jds7HvaXEE', type: 'v4', tier: 2, active: 3 },
  { name: 'Helium (Omnix)', ms: '1XEcKnazz6RVxiv6dwqgW45PQxUmYNyqHJpTohPaFzz', type: 'v4', tier: 2, active: 11 },
  { name: 'LayerZero OFT (Devtools)', ms: 'HB3boZwyCUmjCo2uPWfVS2WKYmdgGv2XVpRgUaX5CkxC', type: 'v4', tier: 2, active: 6 },

  { name: 'Carrot', ms: 'BVQn1waSbAD5fd6rJifaKY8yRrXSUCdd6cA9DZfwVDon', type: 'v4', tier: 1, active: 3,
    programs: [{ name: 'Carrot', id: 'CarrotwivhMpDnm27EHmRLeQ683Z1PufuqEmBZvD282s', expectedAuth: '3eUEKYy7bPqtZ3KyUvCgpXV55v8TfN4xE85NickX6SUM' }] },
  { name: 'DefiTuna', ms: '7tmQEKTNAwmkepvfo2zKvZ1KDHD4nEtQ39eZGwxQ1fQv', type: 'v4', tier: 1, active: 3,
    programs: [{ name: 'DefiTuna', id: 'tuna4uSQZncNeeiAMKbstuxA9CUkHH6HmC64wgmnogD', expectedAuth: 'FWFrrwQ3kd91FEBD17paLUNmWwCYwpxg9bQCXGAcq7jx' }] },

  { name: 'Save (Solend)', ms: '', type: 'other', tier: 1, active: 1,
    programs: [{ name: 'Lending', id: 'So1endDq2YkqhipRh3WViPa8hFrKR6jLePEzLGFj7W5', expectedAuth: 'RY93CZYe5g6drtG7W9PmHRPzaBLZ1uwihTzayQTmJfh' }] },
  { name: 'Zebec', ms: '', type: 'other', tier: 1, active: 1,
    programs: [{ name: 'Streaming', id: 'zbcKGdAmXfthXY3rEPBzexVByT2cqRqCZb9NwWdGQ2T', expectedAuth: '5aUDpuNNbAvme6hPi4o2vBbzHMrF7h3xB4kfKNMk6V8h' }] },

  { name: 'Pyth', ms: '', type: 'other', tier: 2, active: 9,
    programs: [
      { name: 'Legacy Oracle', id: 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH', expectedAuth: '6oXTdojyfDS8m5VtTaYB9xRCxpKGSvKJFndLUPV3V3wT' },
      { name: 'Pull Oracle', id: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ', expectedAuth: '6oXTdojyfDS8m5VtTaYB9xRCxpKGSvKJFndLUPV3V3wT' },
      { name: 'Push Oracle', id: 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT', expectedAuth: '6oXTdojyfDS8m5VtTaYB9xRCxpKGSvKJFndLUPV3V3wT' },
    ] },
  { name: 'Jito', ms: '', type: 'other', tier: 2, active: 0,
    programs: [
      { name: 'Vault', id: 'Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8', expectedAuth: '5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF' },
      { name: 'Restaking', id: 'RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q', expectedAuth: '5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF' },
      { name: 'Steward', id: 'Stewardf95sJbmtcZsyagb2dg4Mo8eVQho8gpECvLx8', expectedAuth: '8EP3VommYzMRSdnSn88GnQpxjRwxg6nroTeUNJoqu9b8' },
      { name: 'Validator History', id: 'HistoryJTGbKQD2mRgLZ3XhqHnN811Qpez8X9kCcGHoa', expectedAuth: '8EP3VommYzMRSdnSn88GnQpxjRwxg6nroTeUNJoqu9b8' },
    ] },
  { name: 'Jito (program upgrade)', ms: 'AJVQRHk9rg25HzE2TompdcjfvQGuZdytPXhU1SgxUxBa', type: 'v4', tier: 2, active: 7 },

  { name: 'Phoenix Eternal', ms: 'Eq2cke33VYoMpunvbMdeCi44PLX7RLzttgFibvvUjvpc', type: 'v4', tier: 1, active: 6,
    programs: [{ name: 'Phoenix Perpetuals', id: 'EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih', expectedAuth: 'GPgADQrhzGoUgLqxsZMKvSpwcLaJFVTq6gEixKhmcwpm' }] },
  { name: 'Adrena', ms: '', type: 'other', tier: 2, active: 0,
    programs: [{ name: 'Perpetuals', id: '13gDzEXCdocbj8iAiqrScGo47NiSuYENGsRqi3SEAwet', expectedAuth: '7VzEXYvGmLg3tdVuFuGFQdr7GP5tutTUt8EcTGHvG8Ev' }] },
];

interface ProtocolState {
  address?: string;          // multisig the entry was read from; a change means re-baseline, not a config change
  threshold: number;
  members: string[];
  memberPerms?: Record<string, string>;
  timeLock: number;
  programAuthorities?: Record<string, string>;
  programUpgrades?: Record<string, string>;
  signerBalances?: Record<string, number>;
  pendingProposals?: number;
  threatAlerts?: ThreatAlert[];
  lastChecked: string;
}

interface MonitorState {
  [name: string]: ProtocolState;
}

type SubEventType = 'ConfigChange' | 'AuthorityChange' | 'ProgramUpgrade' | 'NONCE' | 'VaultTx' | '*';

async function sendToSubscribers(event: {
  protocol: string;
  severity: Severity;
  type?: SubEventType;
  message: string;
}) {
  if (!TG_TOKEN) return;
  try {
    const { matchSubscribersForAlert, touchNotified } = require('./subscriptions');
    const matches = matchSubscribersForAlert(event);
    for (const { userId, subscription } of matches) {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: subscription.chatId,
            text: splitTelegramHtml(`🔔 <b>Your subscription: ${escapeHtml(alertName(event.protocol))}</b>\n\n${event.message}`)[0],
            parse_mode: 'HTML',
          }),
        });
        if (resp.ok) touchNotified(userId);
        else console.error(`[SUBS] DM to ${userId} failed: ${resp.status}`);
      } catch (e: any) {
        console.error(`[SUBS] DM to ${userId} failed:`, e.message);
      }
    }
    if (matches.length > 0) console.log(`[SUBS] ${event.severity} ${event.protocol}: DM'd ${matches.length} subscriber(s)`);
  } catch (e: any) {
    console.error('[SUBS] routing error:', e.message);
  }
}

// Digests can exceed Telegram's 4096-character limit, so every send is split on line boundaries and
// each part is retried once (honouring retry_after on 429).
async function postTelegram(body: Record<string, unknown>, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) return;
      const errText = await resp.text();
      console.error(`[${label}] Send failed (attempt ${attempt}): ${resp.status}`, errText.slice(0, 200));
      let retryAfter = 0;
      try { retryAfter = parseInt(JSON.parse(errText)?.parameters?.retry_after, 10) || 0; } catch {}
      await sleep((resp.status === 429 && retryAfter > 0 ? retryAfter : 2) * 1000);
    } catch (e: any) {
      console.error(`[${label}] Error (attempt ${attempt}):`, e.message);
      await sleep(2000);
    }
  }
}

async function sendTelegram(message: string, severity: Severity = 'MONITOR') {
  if (!TG_TOKEN) {
    console.log('[TG]', message);
    return;
  }
  for (const part of splitTelegramHtml(message)) {
    await postTelegram({ chat_id: TG_CHAT_ID, text: part, parse_mode: 'HTML', message_thread_id: TG_THREADS[severity] }, 'TG');
  }
}

async function sendPublic(message: string) {
  if (!TG_TOKEN) {
    console.log('[PUBLIC]', message);
    return;
  }
  const publicChannel = process.env.TELEGRAM_PUBLIC_CHANNEL_ID;
  for (const part of splitTelegramHtml(message)) {
    const body: any = { text: part, parse_mode: 'HTML', disable_web_page_preview: true };
    if (publicChannel) {
      body.chat_id = publicChannel;
    } else {
      body.chat_id = TG_CHAT_ID;
      body.message_thread_id = TG_THREADS.PUBLIC;
    }
    await postTelegram(body, 'PUBLIC');
  }
}

import { appendActivity as logActivity } from './activity-log';
import { scanRealmsDAOs, writeDaoRiskSnapshot } from './realms';
import { runTriageAndPost } from './llm-triage';
import { threatLabel } from './utils/event-labels';

// A corrupt state file throws (readJsonStrict) and the run aborts: treating it as empty would make every
// protocol look new, baseline real changes silently, and overwrite the file with a partial state.
function loadState(): MonitorState {
  return readJsonStrict<MonitorState>(STATE_FILE, {});
}

// The listener writes monitor-state.json while a scan runs (minutes). Re-read the file at save time and
// apply only the entries this run scanned, so listener updates to other entries are kept. Fields only
// the listener maintains (configAuthority) are carried over onto the scanned entries.
function saveState(scanned: MonitorState) {
  let current: MonitorState = {};
  try { current = readJsonStrict<MonitorState>(STATE_FILE, {}); } catch (e: any) {
    console.error(`[STATE] ${e.message}; writing scanned entries only`);
  }
  for (const [name, entry] of Object.entries(scanned)) {
    const existing = current[name] as any;
    const merged: any = { ...entry };
    if (existing && existing.configAuthority !== undefined && merged.configAuthority === undefined) merged.configAuthority = existing.configAuthority;
    current[name] = merged;
  }
  writeJsonAtomic(STATE_FILE, current);
}

const SUSPICIOUS_PROGRAMS = new Map<string, string>([
  ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', 'Wormhole Bridge'],
  ['Portal11111111111111111111111111111111111', 'Portal Bridge'],
  ['allbridge11111111111111111111111111111111', 'Allbridge'],
]);

interface ThreatAlert {
  signer: string;
  category: 'NONCE' | 'BRIDGE' | 'DEPLOY' | 'MICRO_TX' | 'GAS_FUNDING';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  detail: string;
  detectedAt: string;
  signature?: string;
  precedent: string;
}

async function scanSignerThreats(conn: Connection, member: string): Promise<ThreatAlert[]> {
  const alerts: ThreatAlert[] = [];
  const twoWeeksAgo = Date.now() / 1000 - 14 * 86400;
  const pk = new PublicKey(member);

  try {
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 20 });
    const recent = sigs.filter((s: any) => s.blockTime && s.blockTime > twoWeeksAgo);

    for (const sig of recent.slice(0, 5)) {
      const time = sig.blockTime
        ? formatUKTime(new Date(sig.blockTime * 1000))
        : 'unknown time';

      let tx;
      try {
        tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 1 });
      } catch { continue; }
      if (!tx?.transaction?.message) continue;

      const feePayer = tx.transaction.message.accountKeys[0];
      const feePayerAddr = typeof feePayer === 'string' ? feePayer : (feePayer as any)?.pubkey?.toBase58?.() || '';
      const signerInitiated = feePayerAddr === member;

      const allInstructions = [
        ...(tx.transaction.message.instructions || []),
        ...(tx.meta?.innerInstructions || []).flatMap((inner: any) => inner.instructions || []),
      ];

      let nonceIxType: string | null = null;
      let nonceAddrFull: string | null = null;
      let nonceAuthority: string | null = null;
      for (const ix of allInstructions) {
        const parsed = (ix as any).parsed;
        if (!parsed || typeof parsed !== 'object') continue;
        if (['advanceNonce', 'initializeNonceAccount', 'authorizeNonceAccount', 'withdrawNonceAccount'].includes(parsed.type)) {
          nonceIxType = parsed.type;
          nonceAddrFull = parsed.info?.nonceAccount || null;
          nonceAuthority = parsed.info?.nonceAuthority || parsed.info?.authorized || null;
          break;
        }
      }
      if (!nonceIxType) {
        const nonceLog = tx.meta?.logMessages?.find((l: string) =>
          l.includes('InitializeNonceAccount') || l.includes('AdvanceNonceAccount') ||
          l.includes('AuthorizeNonceAccount') || l.includes('WithdrawNonceAccount')
        );
        if (nonceLog) {
          nonceIxType = nonceLog.includes('Initialize') ? 'initializeNonceAccount'
            : nonceLog.includes('Authorize') ? 'authorizeNonceAccount'
            : nonceLog.includes('Withdraw') ? 'withdrawNonceAccount'
            : 'advanceNonce';
        }
      }

      // Only treat nonce activity as a signal when the signer actually initiated the transaction
      // (fee payer), matching the BRIDGE and DEPLOY gates below. Without this, a signer merely
      // appearing as a passive account in someone else's nonce transaction fired a public CRITICAL.
      if (nonceIxType && signerInitiated) {
        let nonceAgeDays = -1;
        let ageCapped = false;
        if (nonceAddrFull) {
          try {
            const nonceSigs = await conn.getSignaturesForAddress(new PublicKey(nonceAddrFull), { limit: 1000 });
            if (nonceSigs.length >= 1000) {
              // Page cap hit: the earliest returned signature is not the nonce's creation, so it is
              // heavily used (established infrastructure), not freshly staged. Do not let it read as
              // "fresh" - that inflated a busy, benign nonce to a public HIGH.
              ageCapped = true;
            } else if (nonceSigs.length > 0) {
              const earliestTs = nonceSigs[nonceSigs.length - 1].blockTime;
              if (earliestTs) nonceAgeDays = (Date.now() / 1000 - earliestTs) / 86400;
            }
          } catch {}
        }

        const isAuthority = nonceAuthority !== null && nonceAuthority === member;

        let severity: ThreatAlert['severity'] = 'MEDIUM';
        let note = '';
        if (nonceIxType === 'initializeNonceAccount') {
          severity = 'CRITICAL';
          note = 'new durable nonce initialised by this signer';
        } else if (nonceIxType === 'authorizeNonceAccount') {
          severity = 'HIGH';
          note = 'nonce authority rotation';
        } else if (nonceIxType === 'withdrawNonceAccount') {
          severity = 'HIGH';
          note = 'nonce account being emptied';
        } else if (nonceIxType === 'advanceNonce') {
          if (ageCapped) {
            severity = 'LOW';
            note = 'established nonce (1000+ txs) advanced - infrastructure';
          } else if (nonceAgeDays >= 0 && nonceAgeDays < 7 && isAuthority) {
            severity = 'HIGH';
            note = `fresh nonce (${Math.round(nonceAgeDays * 24)}h old) advanced by its own authority`;
          } else if (nonceAgeDays >= 0 && nonceAgeDays < 7) {
            severity = 'MEDIUM';
            note = `fresh nonce (${Math.round(nonceAgeDays * 24)}h old) advanced (signer is fee payer, not authority)`;
          } else if (nonceAgeDays >= 30) {
            severity = 'LOW';
            note = `established nonce (${Math.round(nonceAgeDays)}d old) advanced - likely ops infrastructure`;
          } else if (nonceAgeDays >= 0) {
            severity = 'MEDIUM';
            note = `nonce ${Math.round(nonceAgeDays)}d old being advanced`;
          } else {
            severity = 'MEDIUM';
            note = 'nonce age unknown';
          }
        }

        alerts.push({
          signer: member, category: 'NONCE', severity,
          detail: `Durable nonce activity${nonceAddrFull ? ' (nonce: ' + nonceAddrFull.slice(0, 8) + '...)' : ''}: ${note}`,
          detectedAt: time, signature: sig.signature.slice(0, 20),
          precedent: 'Durable nonce activity on a multisig signer',
        });
        break;
      }

      const allIx = [...(tx.transaction.message.instructions || [])];
      for (const inner of (tx.meta?.innerInstructions || [])) {
        allIx.push(...(inner.instructions || []));
      }
      for (const ix of allIx) {
        const prog = (ix as any).programId?.toBase58?.() || '';
        const bridgeName = SUSPICIOUS_PROGRAMS.get(prog);
        if (bridgeName && signerInitiated) {
          alerts.push({
            signer: member, category: 'BRIDGE', severity: 'HIGH',
            detail: `Signer interacted with ${bridgeName}`,
            detectedAt: time, signature: sig.signature.slice(0, 20),
            precedent: 'Bridge interaction by a multisig signer',
          });
          break;
        }

        if (prog === 'BPFLoaderUpgradeab1e11111111111111111111111' && signerInitiated) {
          alerts.push({
            signer: member, category: 'DEPLOY', severity: 'MEDIUM',
            detail: 'Signer deployed or upgraded a program',
            detectedAt: time, signature: sig.signature.slice(0, 20),
            precedent: 'Program deploy or upgrade signed by a multisig signer',
          });
          break;
        }
      }

      await sleep(300);
    }

    const balance = await conn.getBalance(pk) / 1e9;
    if (balance > 100 && recent.length > 15) {
      alerts.push({
        signer: member, category: 'GAS_FUNDING', severity: 'MEDIUM',
        detail: `${balance.toFixed(1)} SOL balance with ${recent.length} txs in 14 days`,
        detectedAt: formatUKTime(new Date()),
        precedent: 'Unusual SOL balance on multisig signer',
      });
    }
  } catch {}

  return alerts;
}

async function runThreatScan(conn: Connection, members: string[]): Promise<ThreatAlert[]> {
  const allAlerts: ThreatAlert[] = [];
  for (const member of members) {
    const alerts = await scanSignerThreats(conn, member);
    allAlerts.push(...alerts);
    await sleep(300);
  }
  return allAlerts;
}

async function checkProgramUpgrades(conn: Connection, programs: { name: string; id: string; expectedAuth: string }[]): Promise<Record<string, string>> {
  const upgrades: Record<string, string> = {};
  const oneDayAgo = Date.now() / 1000 - 86400;
  for (const prog of programs) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(prog.id));
      if (!info || !info.executable) continue;
      const pdKey = new PublicKey(info.data.slice(4, 36));
      // Read the ProgramData account's last-deployed slot (u64 at offset 4). The BPFLoaderUpgradeable
      // writes this field ONLY on a genuine deploy or upgrade, so it is the authoritative record of a
      // real upgrade. The previous version took the blockTime of the most recent transaction TOUCHING
      // the ProgramData account, which fired a phantom "upgraded" alert whenever an unrelated program
      // merely referenced the account read-only. That broadcast a false "Bonding Curve upgraded" on the
      // Pump.fun feed (2026-08-14): a third-party program referenced programData with no redeploy, yet
      // an upgrade alert went out. Keying on the deploy slot means only a real redeploy can trigger it.
      const pdInfo = await conn.getAccountInfo(pdKey);
      if (!pdInfo || pdInfo.data.length < 12) continue;
      const deploySlot = Number(pdInfo.data.readBigUInt64LE(4));
      const slotTime = await conn.getBlockTime(deploySlot).catch(() => null);
      if (slotTime && slotTime > oneDayAgo) {
        upgrades[prog.name] = formatUKTime(new Date(slotTime * 1000));
      }
      await sleep(300);
    } catch {}
  }
  return upgrades;
}

async function snapshotSignerBalances(conn: Connection, members: string[]): Promise<Record<string, number>> {
  const balances: Record<string, number> = {};
  for (const addr of members) {
    try {
      const bal = await conn.getBalance(new PublicKey(addr));
      balances[addr] = bal / 1e9;
    } catch {}
    await sleep(300);
  }
  return balances;
}

async function countPendingProposals(conn: Connection, msAddress: string): Promise<number> {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(msAddress), { limit: 5 });
    let pending = 0;
    for (const sig of sigs) {
      if (!sig.blockTime) continue;
      const hoursAgo = (Date.now() / 1000 - sig.blockTime) / 3600;
      if (hoursAgo > 72) break;
      try {
        const txResp = await fetch(process.env.HELIUS_RPC_URL!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
          }),
        });
        const txData = await txResp.json() as any;
        const logs = txData.result?.meta?.logMessages || [];
        const logsStr = logs.join(' ');
        if (logsStr.includes('ProposalCreate') || logsStr.includes('ProposalApprove') ||
            logsStr.includes('VaultTransactionCreate') || logsStr.includes('ConfigTransactionCreate') ||
            logsStr.includes('ApproveTransaction')) {
          pending++;
        }
        if (logsStr.includes('VaultTransactionExecute') || logsStr.includes('ConfigTransactionExecute') ||
            logsStr.includes('ExecuteTransaction')) {
          break;
        }
      } catch {}
      await sleep(300);
    }
    return pending;
  } catch {}
  return 0;
}

function decodePerms(mask: number): string {
  const parts: string[] = [];
  if (mask & 1) parts.push('Propose');
  if (mask & 2) parts.push('Vote');
  if (mask & 4) parts.push('Execute');
  return parts.length === 3 ? 'Full' : parts.join('+') || 'None';
}

async function scanV4(conn: Connection, p: ProtocolDef, skipThreats = false): Promise<ProtocolState | null> {
  try {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, new PublicKey(p.ms));
    const members = ms.members.map((m) => m.key.toBase58());
    const memberPerms: Record<string, string> = {};
    for (const m of ms.members) {
      const mask = (m.permissions as any)?.mask ?? (m.permissions as any) ?? 0;
      memberPerms[m.key.toBase58()] = decodePerms(typeof mask === 'number' ? mask : 0);
    }
    const state: ProtocolState = {
      address: p.ms,
      threshold: ms.threshold,
      members,
      memberPerms,
      timeLock: ms.timeLock,
      lastChecked: new Date().toISOString(),
    };

    if (p.tier === 1 && !skipThreats) {
      const threatAlerts = await runThreatScan(conn, members);
      if (threatAlerts.length > 0) {
        state.threatAlerts = threatAlerts;
      }
    }

    if (p.programs) {
      state.programAuthorities = await readProgramAuthorities(conn, p.programs);

      if (!skipThreats) {
        const upgrades = await checkProgramUpgrades(conn, p.programs);
        if (Object.keys(upgrades).length > 0) {
          state.programUpgrades = upgrades;
        }
      }
    }

    if (!skipThreats) {
      state.signerBalances = await snapshotSignerBalances(conn, members);
    }

    if (!skipThreats) {
      state.pendingProposals = await countPendingProposals(conn, p.ms);
    }

    return state;
  } catch (e: any) {
    console.error(`  [${p.name}] V4 scan error: ${e.message.slice(0, 60)}`);
    return null;
  }
}

async function scanV3(conn: Connection, p: ProtocolDef): Promise<ProtocolState | null> {
  const V3 = new PublicKey('SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu');
  const SERUM = new PublicKey('msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHuwg6Xdt');

  try {
    const info = await conn.getAccountInfo(new PublicKey(p.ms));
    if (!info) return null;

    const data = info.data;
    let threshold: number;
    let members: string[] = [];

    if (info.owner.equals(V3)) {
      let offset = 8;
      threshold = data.readUInt16LE(offset); offset += 2;
      offset += 2 + 4 + 4 + 1 + 32 + 1;
      const numKeys = data.readUInt32LE(offset); offset += 4;
      for (let i = 0; i < Math.min(numKeys, 20); i++) {
        const key = new PublicKey(data.slice(offset + i * 32, offset + i * 32 + 32));
        if (!key.equals(PublicKey.default)) members.push(key.toBase58());
      }
    } else if (info.owner.equals(SERUM)) {
      let offset = 8;
      const numOwners = data.readUInt32LE(offset); offset += 4;
      for (let i = 0; i < numOwners; i++) {
        const key = new PublicKey(data.slice(offset + i * 32, offset + i * 32 + 32));
        if (!key.equals(PublicKey.default)) members.push(key.toBase58());
      }
      offset += numOwners * 32;
      threshold = data.readUInt32LE(offset);
    } else {
      return null;
    }

    return {
      threshold: threshold!,
      members,
      timeLock: 0,
      lastChecked: new Date().toISOString(),
    };
  } catch (e: any) {
    console.error(`  [${p.name}] V3/Serum scan error: ${e.message.slice(0, 60)}`);
    return null;
  }
}

async function scanOther(conn: Connection, p: ProtocolDef): Promise<ProtocolState | null> {
  if (!p.programs || p.programs.length === 0) return null;

  const state: ProtocolState = {
    threshold: 0,
    members: [],
    timeLock: 0,
    programAuthorities: await readProgramAuthorities(conn, p.programs),
    lastChecked: new Date().toISOString(),
  };

  return state;
}

// Reads each program's upgrade authority. A program whose read fails is left out of the result (the
// caller carries the previous value forward), and 'IMMUTABLE' is recorded only when the ProgramData
// account was read and its authority option byte is 0.
async function readProgramAuthorities(conn: Connection, programs: { name: string; id: string }[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const prog of programs) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(prog.id));
      if (info && info.executable && info.data.length >= 36) {
        const pdInfo = await conn.getAccountInfo(new PublicKey(info.data.slice(4, 36)));
        if (pdInfo && pdInfo.data.length >= 45 && pdInfo.data.readUInt32LE(0) === 3) {
          out[prog.name] = pdInfo.data[12] === 1 ? new PublicKey(pdInfo.data.slice(13, 45)).toBase58() : 'IMMUTABLE';
        } else {
          console.log(`  [${prog.name}] ProgramData not readable this run; keeping previous value`);
        }
      }
    } catch (e: any) {
      console.log(`  [${prog.name}] authority read failed: ${e.message?.slice(0, 60)}`);
    }
    await sleep(300);
  }
  return out;
}

async function getChangeTimestamp(conn: Connection, address: string): Promise<string> {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit: 1 });
    if (sigs.length > 0 && sigs[0].blockTime) {
      return formatUKTime(new Date(sigs[0].blockTime * 1000));
    }
  } catch {}
  return 'unknown time';
}

function fmtTimelock(sec: number): string {
  if (!sec) return 'none';
  if (sec < 3600) return `${Math.round(sec / 60)}min`;
  if (sec < 172800) return `${Math.round((sec / 3600) * 10) / 10}h`;
  return `${Math.round((sec / 86400) * 10) / 10}d`;
}

interface DiffResult {
  changes: string[];
  watching: string[];
}

function diffState(name: string, prev: ProtocolState, curr: ProtocolState, p: ProtocolDef): DiffResult {
  const changes: string[] = [];
  const watching: string[] = [];

  if (prev.threshold !== curr.threshold) {
    changes.push(`Threshold: ${prev.threshold} → ${curr.threshold}`);
  }

  if (prev.members.length !== curr.members.length) {
    changes.push(`Members: ${prev.members.length} → ${curr.members.length}`);
  }

  const added = Array.from(new Set(curr.members.filter((m) => !prev.members.includes(m))));
  const removed = Array.from(new Set(prev.members.filter((m) => !curr.members.includes(m))));
  if (added.length > 0) changes.push(`Added: ${added.map((a) => a.slice(0, 8) + '...').join(', ')}`);
  if (removed.length > 0) changes.push(`Removed: ${removed.map((r) => r.slice(0, 8) + '...').join(', ')}`);

  if (prev.timeLock !== curr.timeLock) {
    changes.push(`Timelock: ${fmtTimelock(prev.timeLock)} → ${fmtTimelock(curr.timeLock)}`);
  }

  if (curr.threatAlerts && curr.threatAlerts.length > 0) {
    const prevKeys = (prev.threatAlerts || []).map(t => t.signer + t.category);
    const newThreats = curr.threatAlerts
      .filter((t) => !prevKeys.includes(t.signer + t.category));
    for (const t of newThreats) {
      if (t.severity === 'CRITICAL' || t.severity === 'HIGH') {
        const icon = t.severity === 'CRITICAL' ? '🚨' : '⚠️';
        changes.push(
          `${icon} [${t.severity}] ${threatLabel(t.category)}\n` +
          `${t.detail}\n` +
          `Signer: ${t.signer.slice(0, 8)}...\n` +
          `📅 ${t.detectedAt}`
        );
      } else if (t.severity === 'LOW') {
        watching.push(`${threatLabel(t.category)}: ${t.detail} (signer ${t.signer.slice(0, 8)}...)`);
      }
    }
  }

  if (prev.programAuthorities && curr.programAuthorities) {
    for (const progName of Object.keys(curr.programAuthorities)) {
      const prevAuth = prev.programAuthorities[progName];
      const currAuth = curr.programAuthorities[progName];
      if (prevAuth && currAuth && prevAuth !== currAuth) {
        changes.push(`⚠️ ${progName}: who can upgrade it changed from ${prevAuth === 'IMMUTABLE' ? 'nobody' : `${prevAuth.slice(0, 8)}...`} to ${currAuth === 'IMMUTABLE' ? 'nobody (it can no longer be changed)' : `${currAuth.slice(0, 8)}...`}`);
      }
    }
  }

  if (p.programs && curr.programAuthorities) {
    for (const prog of p.programs) {
      const actual = curr.programAuthorities[prog.name];
      if (actual && actual !== prog.expectedAuth && actual !== 'IMMUTABLE') {
        const prevActual = prev.programAuthorities?.[prog.name];
        const alreadyReported = prevActual === actual;
        if (!alreadyReported) {
          changes.push(`🚨 ${prog.name}: upgrade key is not the expected one (expected ${prog.expectedAuth.slice(0, 8)}..., found ${actual === 'IMMUTABLE' ? 'none' : `${actual.slice(0, 8)}...`})`);
        }
      }
    }
  }

  if (curr.programUpgrades) {
    for (const [progName, when] of Object.entries(curr.programUpgrades)) {
      const prevWhen = prev.programUpgrades?.[progName];
      if (prevWhen !== when) {
        changes.push(`🔄 ${progName} upgraded: ${when}`);
      }
    }
  }

  if (prev.signerBalances && curr.signerBalances) {
    for (const [addr, currBal] of Object.entries(curr.signerBalances)) {
      const prevBal = prev.signerBalances[addr] || 0;
      if (currBal - prevBal > 50) {
        watching.push(`GAS_FUNDING: ${addr.slice(0, 8)}... balance ${prevBal.toFixed(1)} → ${currBal.toFixed(1)} SOL (+${(currBal - prevBal).toFixed(1)})`);
      }
    }
  }

  const prevPending = prev.pendingProposals || 0;
  const currPending = curr.pendingProposals || 0;
  if (currPending > prevPending) {
    const added = currPending - prevPending;
    watching.push(`${added} new proposal(s) submitted (${currPending} now awaiting execution)`);
  }

  return { changes, watching };
}

async function main() {
  const mode = process.argv[2] || 'full';
  const conn = new Connection(process.env.HELIUS_RPC_URL!, 'confirmed');
  let prevState: MonitorState;
  try {
    prevState = loadState();
  } catch (e: any) {
    console.error(`Fatal: ${e.message}. Aborting so the state file is not overwritten.`);
    process.exit(1);
  }
  const newState: MonitorState = {};
  const allChanges: string[] = [];
  // Highest severity per change block, in the same order as allChanges; decides internal thread and
  // whether the digest goes public. Based on this run's changes only, never on stored threat alerts.
  const changeSeverities: Severity[] = [];
  // Whether each block may go to the public channel. A diff in which no previous signer remains is more
  // often a stale or differently-parsed baseline than a real rotation, so it is held for review on the
  // internal thread rather than published.
  const publicEligible: boolean[] = [];
  const allWatching: string[] = [];
  let scanned = 0;
  let errors = 0;

  const isReport = mode === 'report';
  const skipThreats = mode === 'config' || isReport;
  const toScan = mode === 'tier1'
    ? PROTOCOLS.filter((p) => p.tier === 1)
    : PROTOCOLS;

  console.log(`\nSolGov Monitor - ${mode.toUpperCase()} scan`);
  console.log(`${new Date().toISOString()}`);
  console.log(`Scanning ${toScan.length} protocols...\n`);

  for (const p of toScan) {
    let state: ProtocolState | null = null;

    if (p.type === 'v4') {
      state = await scanV4(conn, p, skipThreats);
    } else if (p.type === 'v3' || p.type === 'serum') {
      state = await scanV3(conn, p);
    } else if (p.type === 'other') {
      state = await scanOther(conn, p);
    }

    if (state) {
      scanned++;
      let prev: ProtocolState | undefined = prevState[p.name];
      // A tracked name pointing at a different multisig than last run (the entry was re-pointed after an
      // on-chain handover) is a new baseline, not a threshold or member change on the old account.
      if (prev && prev.address && state.address && prev.address !== state.address) {
        console.log(`  ${p.name}: multisig address changed ${prev.address.slice(0, 8)} -> ${state.address.slice(0, 8)}, re-baselining without alerts`);
        prev = undefined;
      }

      // Config and report runs skip the slow reads; carry those fields forward so the next full run does
      // not see them as new (which re-posted old upgrades and re-counted pending proposals as new).
      if (prev) {
        if (state.programUpgrades === undefined && prev.programUpgrades) state.programUpgrades = prev.programUpgrades;
        if (state.pendingProposals === undefined && prev.pendingProposals !== undefined) state.pendingProposals = prev.pendingProposals;
        if (state.signerBalances === undefined && prev.signerBalances) state.signerBalances = prev.signerBalances;
        // A program whose authority could not be read this run keeps its previous value.
        if (state.programAuthorities && prev.programAuthorities) {
          for (const [k, v] of Object.entries(prev.programAuthorities)) if (!(k in state.programAuthorities)) state.programAuthorities[k] = v;
        }
      }

      if (prev) {
        const { changes, watching } = diffState(p.name, prev, state, p);
        if (changes.length > 0) {
          console.log(`  ${p.name}: CHANGED`);
          changes.forEach((c) => console.log(`    ${c}`));
          // The time shown is the multisig's latest transaction, which is where a config change lands.
          const changeTime = p.ms ? await getChangeTimestamp(conn, p.ms) : null;
          const changeBlock = `<b>${escapeHtml(alertName(p.name))}</b>\n${changes.join('\n')}` + (changeTime ? `\n📅 Latest multisig transaction: ${changeTime}` : '');
          allChanges.push(changeBlock);
          let dominantType: SubEventType | undefined = undefined;
          let dominantSev: Severity = 'MONITOR';
          const bump = (s: Severity) => { if (s === 'CRITICAL' || (s === 'HIGH' && dominantSev === 'MONITOR')) dominantSev = s; };
          for (const c of changes) {
            let type: SubEventType;
            if (/^(Threshold|Timelock|Members|Added:|Removed:)/.test(c)) { type = 'ConfigChange'; bump('HIGH'); }
            else if (/authority (CHANGED|MISMATCH)/.test(c)) { type = 'AuthorityChange'; bump(c.includes('🚨') ? 'CRITICAL' : 'HIGH'); }
            else if (c.startsWith('🔄')) type = 'ProgramUpgrade';
            else if (/\] NONCE/.test(c)) { type = 'NONCE'; bump(c.includes('[CRITICAL]') ? 'CRITICAL' : 'HIGH'); }
            else { type = 'VaultTx'; if (c.includes('🚨')) bump('CRITICAL'); else if (c.includes('⚠️')) bump('HIGH'); }
            logActivity(p.name, type, c.replace(/<[^>]+>/g, '').replace(/🚨|⚠️|🔄|📅/g, '').trim(), p.ms);
            if (!dominantType) dominantType = type;
          }
          const wholesale = prev.members.length > 0 && state.members.length > 0 && !state.members.some(m => prev.members.includes(m));
          changeSeverities.push(dominantSev);
          publicEligible.push(!wholesale);
          if (wholesale) allChanges[allChanges.length - 1] += '\n<i>Every previous signer differs; held for review, not published.</i>';
          await sendToSubscribers({ protocol: p.name, severity: dominantSev, type: dominantType, message: changeBlock });
        } else {
          console.log(`  ${p.name}: OK`);
        }
        if (watching.length > 0) {
          console.log(`  ${p.name}: ${watching.length} low severity items`);
          for (const w of watching) {
            allWatching.push(`• ${p.name}: ${w}`);
          }
        }
      } else {
        console.log(`  ${p.name}: NEW (first scan)`);
      }

      if (skipThreats && prev?.threatAlerts && !state.threatAlerts) {
        state.threatAlerts = prev.threatAlerts;
      }
      newState[p.name] = state;
    } else {
      errors++;
      console.log(`  ${p.name}: FAILED`);
    }

    await sleep(300);
  }

  // Realms DAOs (SPL Governance) use a different account model from Squads and are
  // scanned separately via realms.ts. New proposals + config changes feed the same log.
  if (!isReport) {
    try {
      const realms = await scanRealmsDAOs(conn);
      realms.watching.forEach((w) => allWatching.push(w));
      for (const a of realms.alerts) {
        allChanges.push(`<b>${escapeHtml(a.dao)}</b>\n${a.message}`);
        changeSeverities.push(a.severity as Severity);
        publicEligible.push(true);
        await sendToSubscribers({ protocol: a.dao, severity: a.severity, type: a.type as any, message: a.message });
        // Significant governance flags auto-run the internal triage (posts to the risk-team thread).
        if (a.severity === 'HIGH' || a.severity === 'CRITICAL') {
          try {
            await runTriageAndPost({ protocol: a.dao, severity: a.severity, type: a.type, message: a.message, authority: a.authority, timestamp: new Date().toISOString() });
          } catch (e: any) { console.log('  Realms triage failed:', e.message); }
        }
      }
      await writeDaoRiskSnapshot(conn);
    } catch (e: any) { console.log('  Realms scan failed:', e.message); }
  }

  saveState(newState);

  console.log(`\n${scanned} scanned, ${errors} errors, ${allChanges.length} changes, ${allWatching.length} watching`);

  const scannedNames = toScan.filter((_, i) => i < scanned).map(p => p.name);
  const tier1Names = toScan.filter(p => p.tier === 1).map(p => p.name);
  const threatCount = Object.values(newState).reduce((acc, s) => acc + ((s as ProtocolState).threatAlerts?.length || 0), 0);
  const criticalCount = Object.values(newState).reduce((acc, s) => acc + ((s as ProtocolState).threatAlerts?.filter(t => t.severity === 'CRITICAL').length || 0), 0);
  const timestamp = formatUKTime(new Date());
  const scanLabel = mode === 'report' ? 'Report' : mode === 'config' ? 'Config Scan' : mode === 'full' ? 'Full Scan' : 'Tier 1 Scan';

  const watchingSection = allWatching.length > 0
    ? `\n👁️ <b>WATCHING (${allWatching.length})</b>\n${allWatching.join('\n')}\n`
    : '';

  const protocolCount = toScan.length;

  const rank: Record<Severity, number> = { MONITOR: 0, HIGH: 1, CRITICAL: 2 };
  const runSeverity: Severity = changeSeverities.reduce<Severity>((m, s) => (rank[s] > rank[m] ? s : m), 'MONITOR');

  async function postChanges() {
    if (allChanges.length === 0) return;
    const msg = `📊 <b>SolGov scan</b>\n\n` +
      `${allChanges.join('\n\n')}\n\n` +
      watchingSection +
      `\n<b>Summary</b>\n` +
      `Scan: ${scanLabel}\n` +
      `Protocols: ${protocolCount}\n` +
      `Changes: ${allChanges.length}\n` +
      `Open signer risk flags: ${threatCount} (${criticalCount} critical)\n` +
      `<i>${timestamp}</i>`;
    await sendTelegram(msg, runSeverity);
    // Only blocks that are HIGH or CRITICAL in this run go public.
    const publicBlocks = allChanges.filter((_, i) => publicEligible[i] && (changeSeverities[i] === 'CRITICAL' || changeSeverities[i] === 'HIGH'));
    if (publicBlocks.length > 0) {
      const pubChanges = publicBlocks.map(c => c.replace(/🚨|⚠️|🔴|🟡/g, '').trim());
      const heading = pubChanges.length === 1 ? '1 governance change' : `${pubChanges.length} governance changes`;
      const pub = `<b>solgov scan</b>\n${heading}\n\n${pubChanges.join('\n\n')}\n\n<i>${timestamp}</i>\nsolgov.xyz`;
      await sendPublic(pub);
    }
    console.log('\nTelegram alert sent.');
  }

  if (isReport) {
    await postChanges();
    let noTimelock = 0;
    let withTimelock = 0;
    const lowThreshold: string[] = [];
    const recentActivity: string[] = [];

    for (const p of toScan) {
      const s = newState[p.name] as ProtocolState | undefined;
      if (!s) continue;
      if (s.timeLock === 0) noTimelock++;
      else if (s.timeLock > 0) withTimelock++;

      let activeCount = s.members.length;
      if (s.memberPerms && Object.keys(s.memberPerms).length > 0) {
        activeCount = Object.values(s.memberPerms).filter(perm => {
          return perm === 'Full' || perm.includes('Vote');
        }).length;
      }
      const totalCount = s.members.length;
      const signerLabel = activeCount !== totalCount && activeCount > 0
        ? `${s.threshold}/${activeCount} (${totalCount} total)`
        : `${s.threshold}/${totalCount}`;

      if (s.threshold > 0 && activeCount > 0 && s.threshold <= 2 && activeCount >= 3) {
        const tl = s.timeLock === 0 ? 'no timelock' : s.timeLock >= 3600 ? Math.round(s.timeLock / 3600) + 'h' : Math.round(s.timeLock / 60) + 'min';
        lowThreshold.push(`• ${p.name}: ${signerLabel} (${tl})`);
      }

      if (p.ms) {
        try {
          const sigs = await conn.getSignaturesForAddress(new PublicKey(p.ms), { limit: 10 });
          if (sigs.length > 0 && sigs[0].blockTime) {
            const txTime = sigs[0].blockTime;
            const hoursAgo = (Date.now() / 1000 - txTime) / 3600;
            if (hoursAgo < 72) {
              const tl = s.timeLock === 0 ? 'no timelock' : s.timeLock >= 3600 ? Math.round(s.timeLock / 3600) + 'h' : Math.round(s.timeLock / 60) + 'min';

              let changeDesc = '';
              for (const sig of sigs) {
                if (!sig.blockTime) continue;
                const sigHoursAgo = (Date.now() / 1000 - sig.blockTime) / 3600;
                if (sigHoursAgo > 168) break;
                try {
                  const txResp = await fetch(process.env.HELIUS_RPC_URL!, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0', id: 1,
                      method: 'getTransaction',
                      params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
                    }),
                  });
                  const txData = await txResp.json() as any;
                  const logs = txData.result?.meta?.logMessages || [];
                  const logsStr = logs.join(' ');

                  if (logsStr.includes('ConfigTransactionExecute') || logsStr.includes('config_transaction_execute')) {
                    changeDesc = ` - config changed (now ${signerLabel})`;
                    break;
                  }

                  if (logsStr.includes('VaultTransactionExecute') || logsStr.includes('vault_transaction_execute')) {
                    if (!changeDesc) changeDesc = ' - vault tx';
                    continue;
                  }

                  if (logsStr.includes('SpendingLimitUse')) {
                    if (!changeDesc) changeDesc = ' - spending limit used';
                    continue;
                  }

                  if (logsStr.includes('ExecuteTransaction') && !logsStr.includes('VaultTransaction') && !logsStr.includes('ConfigTransaction')) {
                    if (!changeDesc) changeDesc = ' - tx executed';
                    continue;
                  }
                  if (logsStr.includes('ApproveTransaction') && !logsStr.includes('ProposalApprove')) {
                    if (!changeDesc) changeDesc = ' - approval pending';
                    continue;
                  }

                  if (!changeDesc) {
                    if (logsStr.includes('ProposalApprove')) {
                      if (logsStr.includes('ConfigTransaction')) {
                        changeDesc = ' - config approval pending';
                      } else {
                        changeDesc = ' - vault approval pending';
                      }
                    } else if (logsStr.includes('ConfigTransactionCreate')) {
                      changeDesc = ' - config proposal pending';
                    } else if (logsStr.includes('VaultTransactionCreate') || logsStr.includes('ProposalCreate')) {
                      changeDesc = ' - vault proposal pending';
                    }
                  }
                } catch {}
                await sleep(300);
              }

              recentActivity.push(`• ${p.name}: ${signerLabel} (${tl}) - ${Math.round(hoursAgo)}h ago${changeDesc}`);
            }
          }
          await sleep(300);
        } catch {}
      }
    }

    let msg = `📊 <b>SOLGOV - Governance Report</b>\n\n` +
      `Protocols: ${protocolCount}\n` +
      `With timelock: ${withTimelock} | No timelock: ${noTimelock}\n`;

    if (recentActivity.length > 0) {
      msg += `\n🔄 <b>Recent activity (last 72h)</b>\n${recentActivity.join('\n')}\n`;
    }

    if (lowThreshold.length > 0) {
      msg += `\n<b>Threshold 1 or 2 with 3+ active voters (${lowThreshold.length})</b>\n${lowThreshold.join('\n')}\n`;
    }

    msg += `\n<i>${timestamp}</i>`;
    await sendTelegram(msg, 'MONITOR');
    await sendPublic(msg);
    console.log('\nReport sent.');
    return;
  }

  if (allChanges.length > 0) {
    await postChanges();
  } else if (watchingSection) {
    // Watching items include heuristics (gas funding, low-severity threat categories), so a digest
    // with nothing but watching items stays on the internal thread.
    const msg = `✅ <b>SOLGOV - ${scanLabel} Complete</b>\n\n` +
      `<b>Result:</b> No config changes detected\n` +
      `Protocols scanned: ${protocolCount} | Errors: ${errors}\n` +
      watchingSection +
      `<i>${timestamp}</i>`;
    await sendTelegram(msg, 'MONITOR');
    console.log('\nClean scan with WATCHING items posted internally.');
  } else {
    console.log('\nClean scan, nothing to watch - Telegram suppressed.');
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
