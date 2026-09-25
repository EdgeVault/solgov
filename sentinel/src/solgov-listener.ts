// WebSocket listener that diffs threshold, member, timelock, and configAuthority changes in real time across tracked multisigs.

import 'dotenv/config';
import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import * as fs from 'fs';
import * as path from 'path';
import { resolveIdentities, formatAddress, labelAddress } from './utils/identity';
import { escapeHtml, splitTelegramHtml } from './utils/telegram-html';
import { alertName } from './utils/display-names';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';
import { isTrackedName } from './user-tracked-multisigs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_THREADS = {
  CRITICAL: 65,
  HIGH: 67,
  MONITOR: 69,
  PUBLIC: 21,
};

const STATE_FILE = path.join(__dirname, '..', 'data', 'monitor-state.json');
const PREV_STATE_FILE = path.join(__dirname, '..', 'data', 'listener-prev-state.json');
// Last seen deploy slot and upgrade authority per watched program. Persisted so a restart neither
// loses the baseline (a SetAuthority arriving first after restart would otherwise look like no change)
// nor misses a change made while the process was down.
const PROGRAM_STATE_FILE = path.join(__dirname, '..', 'data', 'listener-program-state.json');

import { appendActivity as logActivity } from './activity-log';

const WATCH_LIST: { name: string; address: string; type: 'v4' | 'v3' | 'serum' | 'authority' }[] = [
  { name: 'Drift', address: '7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM', type: 'v4' },
  { name: 'Drift (interim recovery)', address: 'E44y4Gm693AFdGXk4zir5D3ivHn7jns9aWkm8c5q1NDQ', type: 'v4' },
  { name: 'Pumpfun + PumpSwap', address: '2yMoQqQrtbhq3nQ3wFoQQawWS65qcqUXcwHEYha4rshW', type: 'v4' },
  { name: 'Magic Eden', address: 'J2SasfUti5RffbeohWpBDMiGsYGCN11fgyQKTVeREKYE', type: 'v4' },
  { name: 'Exponent', address: '51smH7pBDKJDgmVnVks3gMWaPQFfmQ5s4Fc223yHcjuH', type: 'v4' },
  { name: 'Nosana', address: 'ktKWwDt5J8NFMi5jQNRRBDKAhimU5tnrGCcXuYJmxqE', type: 'v4' },
  { name: 'Lulo', address: '8Sr4rQJL2aQT3EL97mbrk1T9VMw4pCS2mxMPp2QBzHQq', type: 'v4' },
  { name: 'Stabble', address: 'AFRN2ECAY1YTbfkXD7yvoc1iaxYdt5BdyyqyPRsrHaK2', type: 'v4' },
  { name: 'Hylo', address: '2z3t2eBz7VL39Q3vEvaemd5mhT9XLoFofEH2cXvwCJvb', type: 'v4' },
  { name: 'Loopscale', address: 'C4awuufiuL8DNT5wMDP27HneKKqbgynrsbCa4XYGSuPk', type: 'v4' },
  { name: 'Orca', address: 'BQsDWkL417U4tVE2sDnPks469pKdm6YzFgKH77doiEjF', type: 'v4' },
  { name: 'Project 0', address: '7FCPipJWVbPbdHymVt1gJYwKciakkJz5GahdQySemvHk', type: 'v4' },
  { name: 'Kamino', address: '6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM', type: 'v4' },
  { name: 'Jupiter Perps', address: 'AxkJ8oH5aDu4ZRWfsujPtxdb6Vhq4gDehpoReBgrUUSm', type: 'v4' },
  { name: 'Jupiter Lend', address: 'J3mJ3wz6xkVUk3T8qHnuAYNxsRH3ixHsryYNZAU2vG8P', type: 'v4' },
  { name: 'Huma Finance', address: 'uGLhzjot32i9nNKZKUoCzr7sG8bFAXQRN3uZPTUr7gX', type: 'v4' },
  { name: 'Solstice', address: 'AEb1u8FK8EuXLcPtprCy8s4NkqBNoP5mfbuEEop2dJGf', type: 'v4' },
  { name: 'Switchboard', address: '93RQfY6VHRkqXBCEhMY5u92bCGp428DTzqZUEA2Hjr9h', type: 'v4' },
  { name: 'Titan', address: 'F1WZezmt2J1dSsXrQWrS2Umn9CYzPPR2eP3sunZrMX29', type: 'v4' },
  { name: 'Solayer', address: '5AQ3c2nC3Ua5Ms1QP4XpcfaU2Q31C8VhiUJGX3c8zFqp', type: 'v4' },
  { name: 'Flash Trade', address: 'Gb33UeQNnQ4XDuobtGq9M6PVKRVfoH77p8d6JXsgqyXF', type: 'v4' },
  { name: 'Wick', address: '8YmCRSNu7eCjLkhFB4LgDjjjGzfa37ztMoPhXZymWcCA', type: 'v4' },
  { name: 'Onre Finance (treasury)', address: '922xY8imV8NC1FXbaR9VFtNZV7RxQiq19gC42fQG5AfR', type: 'v4' },
  { name: 'Onre Finance', address: '2AD4x72wXvjZVxSQPCt77NYZGXNdMbFvtD5F3mcUAtcN', type: 'v4' },
  { name: 'MetaDAO', address: '8N3Tvc6B1wEVKVC6iD4s6eyaCNqX2ovj2xze2q3Q9DWH', type: 'v4' },
  { name: 'Helium', address: 'FXyzyVsmPRuZjbe97tsCpDqPAPPhBny4dr2hemo8XmL1', type: 'v4' },
  { name: 'Voltr', address: '7szuzpoZzah95BsAu2LQm3bpor5ofiAV4HuinyfFEdse', type: 'v4' },
  { name: 'Voltr (former 3/5)', address: '5QctVSVmX1wdA9emmQFLQGnVbbiR6zPcDkmX8xEScxGH', type: 'v4' },
  { name: 'Jito (program upgrade)', address: 'AJVQRHk9rg25HzE2TompdcjfvQGuZdytPXhU1SgxUxBa', type: 'v4' },
  { name: 'Tessera V', address: '3JW5VWy76TBT5NBbdyrWU6i3fz8XecDko7viGeFSKw7e', type: 'v4' },
  { name: 'LayerZero OFT', address: '9XnbnSvCk33J5Daxc9uJ2MxySTKPuM1KKoFJNmaAk7tN', type: 'v4' },
  { name: 'SolvBTC', address: 'HRr5HqBE7XXMTYD7V6MwojkHxYGttwozEx6atAprp7XE', type: 'v4' },
  { name: 'GMSOL', address: 'CxnEVpQQcYa628TywzHGXeJ2jdVmbU51rnERat9xunP1', type: 'v4' },
  { name: 'Ore', address: 'CHvPhBYPSEdjCrv5xUuzvscqwFYm5wMggWLk2Bvkjgwo', type: 'v4' },
  { name: 'Carrot', address: 'BVQn1waSbAD5fd6rJifaKY8yRrXSUCdd6cA9DZfwVDon', type: 'v4' },
  { name: 'DefiTuna', address: '7tmQEKTNAwmkepvfo2zKvZ1KDHD4nEtQ39eZGwxQ1fQv', type: 'v4' },

  { name: 'Sanctum', address: 'AApfiPZgV5MoPU691GwhdDhq5sKEMMH1Uh8S4Z9xvP6b', type: 'v3' },
  { name: 'Jupiter Agg', address: '7ZyDFzet6sKgZLN4D89JLfo7chu2n7nYdkFt5RCFk8Sf', type: 'v3' },
  { name: 'Raydium', address: 'tr8rgazUrZzgdkfc6Q622nVJHMMzh29trdBE2uBHb4u', type: 'v4' },
  { name: 'Raydium (treasury)', address: 'EXZY7FPccNuEvgHZMCMpww2Fen8oLWBSJzdgCsX3Djwm', type: 'v3' },
  { name: 'Tensor', address: '3djJ66VVaG7si2wsh9isspeZX13meHDvwBzuPGCowY4Z', type: 'v3' },
  { name: 'Phoenix DEX', address: '6x3BDkL2n7VjBWxRD95EsbQi2R2E4zxrvcz1VA6pihnK', type: 'v3' },
  { name: 'Meteora', address: 'CoEsykatDegLB7pcMJia79JSriDdi71nPnjgeSfw623k', type: 'v3' },
  { name: 'Parcl', address: '7qCHZqcbLm9VYUCLtFmFFSyDsvuZ5GHhypv7b4JRAEUE', type: 'v3' },
  { name: 'Marinade', address: 'magrsHFQxkkioAy45VWnZnFBBdKVdy2ZiRoRGYT9Wed', type: 'v3' },
  { name: 'SPL Stake Pool', address: '3yqoHFE4nBGchuVH5rJuZMFvsmnaDTuLLdvGPDUEJcbW', type: 'v3' },

  { name: 'USD1 mint authority', address: '7RiokaeTceeKT57YtZzWXXDuHwtQG7HvWa8hpC8riYTE', type: 'authority' },
  { name: 'PYUSD freeze authority', address: '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk', type: 'authority' },

  { name: 'deBridge (governance multisig)', address: 'FHebUVvpfPzfcaWdhwYMP5uHLpRG6zbN8LcExJYAt8Ap', type: 'v4' },
  { name: 'Phoenix Eternal', address: 'Eq2cke33VYoMpunvbMdeCi44PLX7RLzttgFibvvUjvpc', type: 'v4' },
];

type ProgramRole = 'holds-funds' | 'routes-funds' | 'peripheral';
const TRACKED_PROGRAM_WATCH_PATH = path.join(__dirname, '..', 'data', 'programs', 'tracked-program-watch.json');
let PROGRAM_DATA_WATCH: { name: string; programId: string; role: ProgramRole }[] = [];
try {
  PROGRAM_DATA_WATCH = JSON.parse(fs.readFileSync(TRACKED_PROGRAM_WATCH_PATH, 'utf-8'));
  console.log(`[INIT] Loaded ${PROGRAM_DATA_WATCH.length} tracked programs from tracked-program-watch.json`);
} catch (e: any) {
  console.error('[INIT] Could not load tracked-program-watch.json, falling back to minimal hardcoded list:', e.message?.slice(0, 80));
  PROGRAM_DATA_WATCH = [
    { name: 'Drift V2', programId: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', role: 'holds-funds' },
    { name: 'Kamino kLend', programId: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', role: 'holds-funds' },
    { name: 'Jupiter Agg', programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', role: 'routes-funds' },
  ];
}

type PrevEntry = { address?: string; threshold: number; memberCount: number; voterCount?: number; timeLock: number; configAuthority: string; memberKeys: string[] };
const prevState: Record<string, PrevEntry> = {};

let reconnectDelayMs = 5000;
let currentWs: WebSocket | null = null;

const v3LastPingMs = new Map<string, number>();

function loadPrevState() {
  try {
    if (!fs.existsSync(PREV_STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PREV_STATE_FILE, 'utf-8'));
    for (const [name, s] of Object.entries(raw)) {
      prevState[name] = s as any;
    }
    console.log(`[PREV] Loaded ${Object.keys(prevState).length} entries from ${path.basename(PREV_STATE_FILE)}`);
  } catch (e: any) {
    console.error('[PREV] Load failed:', e.message);
  }
}

function savePrevState() {
  try {
    writeJsonAtomic(PREV_STATE_FILE, prevState);
  } catch (e: any) {
    console.error('[PREV] Save failed:', e.message);
  }
}

async function sendTelegram(message: string, severity: Severity = 'MONITOR') {
  if (!TG_TOKEN) {
    console.log('[TG]', message);
    return;
  }
  for (const part of splitTelegramHtml(message)) await sendTelegramPart(part, severity);
}

async function sendTelegramPart(message: string, severity: Severity) {
  const threadId = TG_THREADS[severity];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
          message_thread_id: threadId,
        }),
      });
      if (resp.ok) return;
      const errText = await resp.text();
      console.error(`[TG] Send failed (attempt ${attempt}): ${resp.status} thread=${threadId}`, errText.slice(0, 200));
      if (resp.status === 429) {
        const retryAfter = parseInt(JSON.parse(errText)?.parameters?.retry_after, 10);
        await sleep((retryAfter > 0 ? retryAfter : 5) * 1000);
      } else if (attempt === 1) {
        await sleep(1500);
      }
    } catch (e: any) {
      console.error(`[TG] Error (attempt ${attempt}):`, e.message);
      if (attempt === 1) await sleep(1500);
    }
  }
}

async function sendToSubscribers(event: {
  protocol: string;
  severity: Severity;
  type?: 'ConfigChange' | 'AuthorityChange' | 'ProgramUpgrade' | 'NONCE' | 'VaultTx' | '*';
  message: string;
  programId?: string;
  authority?: string;
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
  if (!isTrackedName(event.protocol)) {
    try {
      const { fanoutEvent } = require('./webhook-registry');
      await fanoutEvent({
        protocol: event.protocol,
        severity: event.severity,
        type: event.type || '*',
        message: event.message,
        timestamp: new Date().toISOString(),
        programId: event.programId,
        authority: event.authority,
      });
    } catch (e: any) {
      console.error('[WEBHOOK] fanout error:', e.message);
    }
  }
}

async function sendPublic(message: string) {
  if (!TG_TOKEN) {
    console.log('[PUBLIC]', message);
    return;
  }
  message = splitTelegramHtml(message)[0];
  const publicChannel = process.env.TELEGRAM_PUBLIC_CHANNEL_ID;
  const body: any = {
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
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
    if (!resp.ok) console.error('[PUBLIC] Send failed:', resp.status, await resp.text());
  } catch (e: any) {
    console.error('[PUBLIC] Error:', e.message);
  }
}

function decodePerms(mask: number): string {
  const parts: string[] = [];
  if (mask & 1) parts.push('Propose');
  if (mask & 2) parts.push('Vote');
  if (mask & 4) parts.push('Execute');
  return parts.length === 3 ? 'Full' : parts.join('+') || 'None';
}

type Severity = 'CRITICAL' | 'HIGH' | 'MONITOR';

interface TypedChange {
  type: string;
  detail: string;
  severity: Severity;
}

function classifyV4Change(name: string, prev: PrevEntry, now: PrevEntry): TypedChange[] {
  const events: TypedChange[] = [];

  const tlLabel = (s: number) => {
    if (s === 0) return 'none';
    const h = s / 3600;
    if (h >= 1) return `${Math.round(h)}h`;
    return `${Math.round(s / 60)}min`;
  };

  if (now.threshold < prev.threshold) {
    events.push({ type: 'ThresholdLowered', detail: `Threshold: ${prev.threshold} → ${now.threshold}`, severity: 'CRITICAL' });
  } else if (now.threshold > prev.threshold) {
    events.push({ type: 'ThresholdRaised', detail: `Threshold: ${prev.threshold} → ${now.threshold}`, severity: 'HIGH' });
  }

  const added = now.memberKeys.filter(k => !prev.memberKeys.includes(k));
  const removed = prev.memberKeys.filter(k => !now.memberKeys.includes(k));
  if (added.length > 0 && removed.length > 0 && added.length === removed.length && now.memberCount === prev.memberCount) {
    // Intra-tx rotation: members swapped out 1:1 with count unchanged.
    events.push({ type: 'SignerRotation', detail: `Signer rotation: ${added.length} swapped (total signers unchanged at ${now.memberCount})`, severity: 'HIGH' });
  } else {
    if (removed.length > 0) {
      const sev: Severity = removed.length >= 3 ? 'CRITICAL' : 'HIGH';
      events.push({ type: 'SignersRemoved', detail: `Total signers: ${prev.memberCount} → ${now.memberCount} (-${removed.length})`, severity: sev });
    }
    if (added.length > 0) {
      events.push({ type: 'SignersAdded', detail: `Total signers: ${prev.memberCount} → ${now.memberCount} (+${added.length})`, severity: 'MONITOR' });
    }
  }

  if (prev.timeLock === 0 && now.timeLock > 0) {
    events.push({ type: 'TimelockAdded', detail: `Timelock: none → ${tlLabel(now.timeLock)}`, severity: 'HIGH' });
  } else if (prev.timeLock > 0 && now.timeLock === 0) {
    events.push({ type: 'TimelockRemoved', detail: `Timelock: ${tlLabel(prev.timeLock)} → none`, severity: 'CRITICAL' });
  } else if (now.timeLock !== prev.timeLock) {
    const sev: Severity = now.timeLock < prev.timeLock ? 'HIGH' : 'MONITOR';
    events.push({ type: 'TimelockChanged', detail: `Timelock: ${tlLabel(prev.timeLock)} → ${tlLabel(now.timeLock)}`, severity: sev });
  }

  // Members that lost the Vote permission lower the number of signers who can approve without any
  // change to threshold or member count. Only compared when both sides recorded a voter count.
  if (typeof prev.voterCount === 'number' && typeof now.voterCount === 'number' && prev.voterCount !== now.voterCount) {
    const sev: Severity = now.voterCount < prev.voterCount ? 'HIGH' : 'MONITOR';
    events.push({ type: 'VotersChanged', detail: `Members with vote permission: ${prev.voterCount} → ${now.voterCount}`, severity: sev });
  }

  if (prev.configAuthority !== now.configAuthority) {
    if (now.configAuthority !== 'autonomous' && prev.configAuthority !== 'autonomous') {
      events.push({ type: 'ExternalAdminKeyChanged', detail: `External admin key on multisig: ${prev.configAuthority.slice(0, 12)}... → ${now.configAuthority.slice(0, 12)}...`, severity: 'CRITICAL' });
    } else if (now.configAuthority !== 'autonomous') {
      events.push({ type: 'ExternalAdminKeyAdded', detail: `External admin key on multisig: none → ${now.configAuthority.slice(0, 12)}...`, severity: 'CRITICAL' });
    } else {
      events.push({ type: 'ExternalAdminKeyCleared', detail: `External admin key on multisig: ${prev.configAuthority.slice(0, 12)}... → none`, severity: 'HIGH' });
    }
  }

  return events;
}

function overallSeverity(events: TypedChange[]): Severity {
  const rank: Record<Severity, number> = { MONITOR: 0, HIGH: 1, CRITICAL: 2 };
  let max: Severity = 'MONITOR';
  for (const e of events) if (rank[e.severity] > rank[max]) max = e.severity;
  return max;
}

// Account notifications carry the account data and the slot it was read at. Decoding that payload,
// rather than re-fetching, removes the chance of a load-balanced RPC node returning an older state
// than the one notified (which would read as a change and then its reversal). Notifications for one
// account are handled one at a time and older slots are dropped.
const lastSlotByAddress = new Map<string, number>();
const queueByAddress = new Map<string, Promise<void>>();

function enqueue(address: string, task: () => Promise<void>): void {
  const prevTask = queueByAddress.get(address) || Promise.resolve();
  const next = prevTask.then(task, task).catch((e: any) => console.error(`[QUEUE] ${address.slice(0, 8)}:`, e?.message));
  queueByAddress.set(address, next);
}

function isStaleSlot(address: string, slot: number | undefined): boolean {
  if (typeof slot !== 'number') return false;
  const last = lastSlotByAddress.get(address);
  if (last !== undefined && slot < last) return true;
  lastSlotByAddress.set(address, slot);
  return false;
}

async function handleV4Notification(name: string, address: string, conn: Connection, value: any, slot: number | undefined) {
  try {
    if (isStaleSlot(address, slot)) {
      console.log(`[SKIP] ${name}: notification for slot ${slot} is older than one already processed`);
      return;
    }
    const raw = Array.isArray(value?.data) ? value.data[0] : null;
    if (typeof raw === 'string') {
      const info = { data: Buffer.from(raw, 'base64'), executable: !!value.executable, lamports: value.lamports, owner: new PublicKey(value.owner), rentEpoch: value.rentEpoch };
      const [ms] = multisig.accounts.Multisig.fromAccountInfo(info as any);
      await processV4State(name, ms, address);
      return;
    }
    const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, new PublicKey(address));
    await processV4State(name, ms, address);
  } catch (e: any) {
    console.error(`[ERROR] ${name}:`, e.message?.slice(0, 60));
  }
}

async function processV4State(name: string, ms: any, address: string) {
  // User-submitted multisigs (see user-tracked-multisigs.ts) are DM-only: they never write
  // monitor-state, never post to the public channel or the risk-team threads.
  const tracked = isTrackedName(name);
  try {
    const threshold = ms.threshold;
    const memberCount = ms.members.length;
    const timeLock = ms.timeLock;
    const ca = (ms as any).configAuthority;
    const caStr = ca ? ca.toBase58() : null;
    const configAuthority = (!caStr || caStr === '11111111111111111111111111111111') ? 'autonomous' : caStr;
    const memberKeys = ms.members.map((m: any) => m.key.toBase58());
    const maskOf = (m: any) => { const mask = (m.permissions as any)?.mask ?? (m.permissions as any) ?? 0; return typeof mask === 'number' ? mask : 0; };
    const voterCount = ms.members.filter((m: any) => maskOf(m) & 2).length;

    if (!tracked) try {
      const state = readJsonStrict<Record<string, any>>(STATE_FILE, {});
      const dashName = name === 'Pumpfun' ? 'Pumpfun + PumpSwap'
        : name === 'Pump.fun' ? 'Pumpfun + PumpSwap'
        : name === 'Huma' ? 'Huma Finance'
        : name;
      state[dashName] = {
        ...(state[dashName] || {}),
        threshold,
        members: memberKeys,
        memberPerms: Object.fromEntries(ms.members.map((m: any) => [m.key.toBase58(), decodePerms(maskOf(m))])),
        timeLock,
        configAuthority,
        address,
        lastChecked: new Date().toISOString(),
      };
      writeJsonAtomic(STATE_FILE, state);
    } catch (e: any) {
      // A corrupt state file is left for the monitor to rebuild rather than overwritten with one entry.
      console.error(`[STATE] ${name}: state write skipped: ${e.message?.slice(0, 80)}`);
    }

    let prev: (typeof prevState)[string] | undefined = prevState[name];
    // Same name, different multisig: the entry was re-pointed after an on-chain handover. Baseline it
    // fresh rather than reporting the new account's config as changes to the old one.
    if (prev && prev.address && prev.address !== address) {
      console.log(`[INIT] ${name}: multisig address changed ${prev.address.slice(0, 8)} -> ${address.slice(0, 8)}, re-baselining`);
      prev = undefined;
    }
    if (!prev) {
      prevState[name] = { address, threshold, memberCount, voterCount, timeLock, configAuthority, memberKeys };
      savePrevState();
      console.log(`[INIT] ${name}: ${threshold}/${memberCount}, timelock=${timeLock}s, configAuth=${configAuthority === 'autonomous' ? 'autonomous' : configAuthority.slice(0, 12) + '...'}`);
      return;
    }

    const now: PrevEntry = { threshold, memberCount, voterCount, timeLock, configAuthority, memberKeys };
    const typedChanges = classifyV4Change(name, prev, now);
    const severity = overallSeverity(typedChanges);
    const changes = typedChanges.map(c => c.detail);

    if (typedChanges.length > 0) {
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

      // Log one activity entry per typed change so the feed can distinguish
      // timelock / threshold / rotation / external-key events from one another.
      if (!tracked) for (const c of typedChanges) {
        logActivity(name, c.type, c.detail, address);
      }

      const addedSigners = memberKeys.filter((k: string) => !prev.memberKeys.includes(k));
      const removedSigners = prev.memberKeys.filter((k: string) => !memberKeys.includes(k));
      const lookups = [...addedSigners, ...removedSigners];
      if (configAuthority !== 'autonomous') lookups.push(configAuthority);
      const identities = lookups.length > 0 ? await resolveIdentities(lookups) : {};

      const signerLines: string[] = [];
      for (const s of addedSigners) signerLines.push(`  + ${formatAddress(s, identities[s])}`);
      for (const s of removedSigners) signerLines.push(`  − ${formatAddress(s, identities[s])}`);
      const signerBlock = signerLines.length > 0 ? `\nSigners:\n${signerLines.join('\n')}` : '';

      const caLabelled = configAuthority !== 'autonomous' && identities[configAuthority]?.label
        ? formatAddress(configAuthority, identities[configAuthority])
        : null;
      const changesLabelled = caLabelled
        ? changes.map(c => c.startsWith('External admin key on multisig: none') ? `External admin key on multisig: none → ${caLabelled}` : c)
        : changes;

      const safeName = escapeHtml(alertName(name));
      const pub = `<b>${safeName}</b>\n${changesLabelled.join('\n')}${signerBlock}\n${timestamp} UTC\nsolgov.xyz`;
      const sevHeader = severity === 'CRITICAL' ? '🔴 <b>CRITICAL</b>' : severity === 'HIGH' ? '🟡 <b>HIGH ALERT</b>' : '📋 <b>MONITOR</b>';
      const alertMsg = `${sevHeader}\n\n<b>${safeName}</b>\n${changesLabelled.join('\n')}${signerBlock}\n📅 ${timestamp} UTC`;
      console.log(`[${severity}] ${name}:`, changes.join(', '));
      if (!tracked) {
        await sendTelegram(alertMsg, severity);
        if (severity === 'CRITICAL' || severity === 'HIGH') await sendPublic(pub);
      }

      await sendToSubscribers({
        protocol: name,
        severity,
        type: 'ConfigChange',
        message: alertMsg,
      });
    }

    prevState[name] = { address, threshold, memberCount, voterCount, timeLock, configAuthority, memberKeys };
    savePrevState();
  } catch (e: any) {
    console.error(`[ERROR] ${name}:`, e.message?.slice(0, 60));
  }
}

let lastReVerify = 0;
async function reVerifyAllV4(conn: Connection, reason: string) {
  const now = Date.now();
  if (now - lastReVerify < 120000) {
    console.log(`[RE-VERIFY] Skipped (${reason}): last run ${Math.round((now - lastReVerify) / 1000)}s ago`);
    return;
  }
  lastReVerify = now;

  const v4Items = WATCH_LIST.filter(w => w.type === 'v4');
  const pubkeys = v4Items.map(w => new PublicKey(w.address));
  try {
    const infos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');
    console.log(`[RE-VERIFY] ${reason}: decoded ${v4Items.length} V4 accounts in 1 RPC`);
    for (let i = 0; i < v4Items.length; i++) {
      const info = infos[i];
      if (!info) continue;
      try {
        const [ms] = multisig.accounts.Multisig.fromAccountInfo(info);
        await processV4State(v4Items[i].name, ms, v4Items[i].address);
      } catch (e: any) {
        console.error(`[RE-VERIFY] ${v4Items[i].name}: decode failed: ${e.message?.slice(0, 40)}`);
      }
    }
  } catch (e: any) {
    console.error(`[RE-VERIFY] Batch fetch failed: ${e.message?.slice(0, 60)}`);
  }
}

const recentAlerts: Map<string, number> = new Map();
const ALERT_DEDUPE_MS = 60 * 1000;
function suppressAsDuplicate(key: string): boolean {
  const now = Date.now();
  for (const [k, exp] of recentAlerts) if (exp < now) recentAlerts.delete(k);
  if (recentAlerts.has(key)) return true;
  recentAlerts.set(key, now + ALERT_DEDUPE_MS);
  return false;
}

function protocolFamily(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

async function handleAuthorityChange(name: string, address: string) {
  const family = protocolFamily(name);
  if (recentAlerts.has(`protocol-upgrade:${family}`)) {
    console.log(`[DEDUPE] authority alert for ${name} suppressed; program upgrade for ${family} already alerted`);
    return;
  }
  if (suppressAsDuplicate(`auth:${name}`)) {
    console.log(`[DEDUPE] suppressing duplicate authority alert for ${name}`);
    return;
  }
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const hour = new Date().getUTCHours();
  logActivity(name, 'AuthorityActivity', `Authority activity at ${hour}:00 UTC`, address);

  const label = await labelAddress(address);

  // Any lamport transfer into an authority account fires its subscription, so "activity" is not
  // evidence of an authority action and anyone can trigger it. Internal threads only, never public.
  if (name.includes('USD1') || name.includes('PYUSD')) {
    const msg = `🔴 <b>CRITICAL: stablecoin authority activity</b>\n\n<b>${name}</b>\nAddress: <code>${label}</code>\n📅 ${timestamp} UTC`;
    console.log(`[CRITICAL] ${name}: stablecoin authority activity (${label})`);
    await sendTelegram(msg, 'CRITICAL');
    return;
  }

  if (hour < 6 || hour > 18) {
    const msg = `🟡 <b>HIGH: Off-hours authority activity</b>\n\n<b>${name}</b>\nAddress: <code>${label}</code>\nActivity at ${hour}:00 UTC\n📅 ${timestamp} UTC`;
    console.log(`[HIGH] ${name}: off-hours authority activity (${label})`);
    await sendTelegram(msg, 'HIGH');
  } else {
    const msg = `📋 <b>${name}</b>\nAddress: <code>${label}</code>\nAuthority activity at ${hour}:00 UTC\n📅 ${timestamp} UTC`;
    console.log(`[MONITOR] ${name}: authority activity at ${hour}:00 UTC (${label})`);
    await sendTelegram(msg, 'MONITOR');
  }
}

const lastUpgradeAuthority: Record<string, string> = {};
const lastDeploySlot: Record<string, number> = {};

function loadProgramState(): boolean {
  try {
    const raw = readJsonStrict<{ authority?: Record<string, string>; deploySlot?: Record<string, number> } | null>(PROGRAM_STATE_FILE, null);
    if (!raw) return false;
    Object.assign(lastUpgradeAuthority, raw.authority || {});
    Object.assign(lastDeploySlot, raw.deploySlot || {});
    console.log(`[PROGRAMS] Loaded baseline for ${Object.keys(lastDeploySlot).length} programs`);
    return true;
  } catch (e: any) {
    console.error('[PROGRAMS] Baseline load failed:', e.message);
    return false;
  }
}

let programStateTimer: NodeJS.Timeout | null = null;
function saveProgramStateSoon() {
  if (programStateTimer) return;
  programStateTimer = setTimeout(() => {
    programStateTimer = null;
    try { writeJsonAtomic(PROGRAM_STATE_FILE, { authority: lastUpgradeAuthority, deploySlot: lastDeploySlot }); }
    catch (e: any) { console.error('[PROGRAMS] Baseline save failed:', e.message); }
  }, 2000);
}

// Reads the upgrade authority and deploy slot from a ProgramData account. Returns null when the data
// is not a ProgramData account (too short, wrong tag) so a failed read is never recorded as IMMUTABLE.
function readProgramData(data: Buffer): { authority: string; deploySlot: number } | null {
  if (data.length < 45 || data.readUInt32LE(0) !== 3) return null;
  const authority = data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : 'IMMUTABLE';
  return { authority, deploySlot: Number(data.readBigUInt64LE(4)) };
}

async function handleProgramUpgrade(name: string, conn: Connection, programId: string) {
  try {
    const info = await conn.getAccountInfo(new PublicKey(programId));
    if (!info || !info.executable) return;
    const pdKey = new PublicKey(info.data.slice(4, 36));
    const pdInfo = await conn.getAccountInfo(pdKey);
    if (!pdInfo) return;
    const parsed = readProgramData(pdInfo.data);
    if (!parsed) {
      console.log(`[SKIP] ${name}: ProgramData for ${programId.slice(0, 12)} did not parse`);
      return;
    }
    const authAddr = parsed.authority;

    const progEntry = PROGRAM_DATA_WATCH.find(p => p.programId === programId);
    const role: ProgramRole = progEntry?.role ?? 'peripheral';

    const prevAuth = lastUpgradeAuthority[programId];
    const isAuthorityChange = prevAuth !== undefined && prevAuth !== authAddr;
    lastUpgradeAuthority[programId] = authAddr;

    // A ProgramData accountSubscribe notification fires on ANY write to the account (rent top-up, a
    // read/write that does not redeploy, etc), not only on an upgrade. Confirm a genuine redeploy by
    // the last-deployed slot (u64 at offset 4, written only by the loader on deploy/upgrade): treat it
    // as an upgrade only if that slot advanced from the last seen value, or was deployed in the last
    // 30 minutes. Without this, a non-upgrade write posts a phantom "Program X upgraded" to the public
    // activity feed and a subscriber DM (the same bug fixed in solgov-monitor.ts checkProgramUpgrades).
    // Authority changes are proven from the authority bytes and still fire regardless.
    const deploySlot = parsed.deploySlot;
    const prevSlot = lastDeploySlot[programId];
    lastDeploySlot[programId] = deploySlot;
    saveProgramStateSoon();
    const slotAdvanced = prevSlot !== undefined && deploySlot > prevSlot;
    // Block time of the deploy: used for the "deployed in the last 30 minutes" fallback when there is no
    // baseline, and as the event time so a change found after a restart is reported when it happened.
    let deployTime: number | null = null;
    try { deployTime = await conn.getBlockTime(deploySlot); } catch {}
    const recentlyDeployed = prevSlot === undefined && !!deployTime && (Date.now() / 1000 - deployTime) < 30 * 60;
    const isRealUpgrade = slotAdvanced || recentlyDeployed;
    if (!isRealUpgrade && !isAuthorityChange) {
      console.log(`[SKIP] ${name}: ProgramData write but deploy slot ${deploySlot} did not advance and is not recent - not an upgrade`);
      return;
    }

    // Dedupe only once the event is confirmed, so a non-upgrade write (rent top-up, ExtendProgram)
    // cannot use up the dedupe window and suppress the real upgrade that follows it.
    const dedupeKey = isAuthorityChange ? `prog-auth:${programId}:${authAddr}` : `prog:${programId}:${deploySlot}`;
    if (suppressAsDuplicate(dedupeKey)) {
      console.log(`[DEDUPE] suppressing duplicate program alert for ${name} (${programId.slice(0, 12)})`);
      return;
    }
    recentAlerts.set(`protocol-upgrade:${protocolFamily(name)}`, Date.now() + ALERT_DEDUPE_MS);
    if (role === 'peripheral' && !isAuthorityChange) {
      const familyKey = `peripheral-batch:${protocolFamily(name)}`;
      if (recentAlerts.has(familyKey)) {
        console.log(`[DEDUPE] peripheral upgrade for ${name} suppressed; ${protocolFamily(name)} batch already alerted within 5min`);
        return;
      }
      recentAlerts.set(familyKey, Date.now() + 5 * 60 * 1000);
    }

    const eventDate = !isAuthorityChange && deployTime ? new Date(deployTime * 1000) : new Date();
    const timestamp = eventDate.toISOString().replace('T', ' ').slice(0, 19);
    const hour = eventDate.getUTCHours();
    const kind = isAuthorityChange ? 'AuthorityChange' : 'ProgramUpgrade';
    logActivity(name, kind, isAuthorityChange
      ? `${programId.slice(0, 12)}... upgrade authority changed to ${authAddr.slice(0, 12)}...`
      : `Program ${programId.slice(0, 12)}... upgraded at ${hour}:00 UTC`, undefined, eventDate.toISOString());

    const authLabel = authAddr === 'IMMUTABLE' ? 'IMMUTABLE' : await labelAddress(authAddr);
    const prevAuthLabel = prevAuth && prevAuth !== 'IMMUTABLE' ? await labelAddress(prevAuth) : prevAuth || 'unknown';

    const noMultisigProgs = ['BisonFi', 'HumidiFi', 'Photon', 'Save'];
    const isNoMultisig = noMultisigProgs.some(s => name.includes(s));
    const isOffHours = hour < 6 || hour > 22;

    let severity: 'CRITICAL' | 'HIGH' | 'MONITOR' = 'MONITOR';
    let header = '';
    if (isNoMultisig) {
      severity = 'CRITICAL';
      header = isAuthorityChange
        ? '🔴 <b>CRITICAL: Upgrade authority changed (no multisig found on-chain)</b>'
        : '🔴 <b>CRITICAL: Program upgrade (no multisig found on-chain)</b>';
    } else if (role === 'holds-funds' && isAuthorityChange) {
      severity = 'CRITICAL';
      header = '🔴 <b>CRITICAL: Custody program authority changed</b>';
    } else if (role === 'routes-funds' && isAuthorityChange) {
      severity = 'HIGH';
      header = '🟠 <b>HIGH: Routing program authority changed</b>';
    } else if (role === 'peripheral' && isAuthorityChange) {
      severity = 'MONITOR';
      header = '🟦 <b>Peripheral program upgrade authority changed</b>';
    } else if (role === 'holds-funds') {
      severity = 'HIGH';
      header = isOffHours ? '🟠 <b>HIGH: Custody program upgrade (off-hours)</b>' : '🟠 <b>HIGH: Custody program upgrade</b>';
    } else if (role === 'routes-funds') {
      severity = isOffHours ? 'HIGH' : 'MONITOR';
      header = isOffHours ? '🟠 <b>HIGH: Routing program upgrade (off-hours)</b>' : '🟦 <b>Routing program upgrade</b>';
    } else {
      severity = 'MONITOR';
      header = '🟦 <b>Peripheral program upgrade</b>';
    }

    const authLine = isAuthorityChange
      ? `Authority: <code>${prevAuthLabel}</code> → <code>${authLabel}</code>`
      : `Authority: <code>${authLabel}</code>`;
    const msg = `${header}\n\n<b>${escapeHtml(alertName(name))}</b>\nProgram: <code>${programId.slice(0, 12)}...</code>\n${authLine}\nRole: ${role}\n📅 ${timestamp} UTC`;
    console.log(`[${severity}] ${name}: ${isAuthorityChange ? 'auth change' : 'upgrade'} role=${role} (${authLabel})`);

    if (severity === 'CRITICAL' || severity === 'HIGH') {
      await sendTelegram(msg, severity);
      if (isAuthorityChange) {
        const pub = `<b>${escapeHtml(alertName(name))}</b>\nUpgrade authority changed.\nProgram: <code>${programId.slice(0, 12)}...</code>\n${authLine}\n${timestamp} UTC\nsolgov.xyz`;
        await sendPublic(pub);
      }
    } else {
      await sendTelegram(msg, 'MONITOR');
    }
    await sendToSubscribers({
      protocol: name,
      severity,
      type: isAuthorityChange ? 'AuthorityChange' : 'ProgramUpgrade',
      message: msg,
      programId,
      authority: authAddr,
    });
    if (severity === 'CRITICAL') {
      try {
        const { runTriageAndPost } = require('./llm-triage');
        await runTriageAndPost({
          protocol: name,
          severity,
          type: isAuthorityChange ? 'AuthorityChange' : 'ProgramUpgrade',
          programId,
          authority: authAddr,
          message: msg,
          timestamp,
        });
      } catch (e: any) {
        console.error('[TRIAGE] dispatch failed:', e.message);
      }
    }
  } catch (e: any) {
    console.error(`[UPGRADE ERROR] ${name}:`, e.message?.slice(0, 40));
  }
}

function connectWebSocket(conn: Connection, programDataWatch: { name: string; address: string }[] = []) {
  const wsUrl = process.env.HELIUS_RPC_URL?.replace('https://', 'wss://') || '';
  if (!wsUrl) {
    console.error('No HELIUS_RPC_URL set');
    process.exit(1);
  }

  console.log(`[WS] Connecting to ${wsUrl.slice(0, 40)}...`);
  const ws = new WebSocket(wsUrl);
  currentWs = ws;

  const pendingByReqId = new Map<number, { name: string; address: string; type: string }>();
  const itemBySubId = new Map<number, { name: string; address: string; type: string }>();
  let subId = 0;

  ws.on('open', () => {
    let userTracked: { name: string; address: string; type: 'v4' }[] = [];
    try {
      const { listTracked } = require('./user-tracked-multisigs');
      // listTracked() returns namespaced names ("Tracked: ..."), which processV4State keeps DM-only.
      userTracked = (listTracked() as Array<any>).map(m => ({
        name: m.label,
        address: m.address,
        type: 'v4' as const,
      }));
    } catch (e: any) {
      console.warn('[USER-TRACKED] load failed at connect:', e?.message);
    }

    const allAccounts = [...WATCH_LIST, ...userTracked];
    console.log(`[WS] Connected. Subscribing to ${WATCH_LIST.length} curated + ${userTracked.length} user-tracked accounts...`);

    for (const item of allAccounts) {
      subId++;
      pendingByReqId.set(subId, item);
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: subId,
        method: 'accountSubscribe',
        params: [
          item.address,
          { encoding: 'base64', commitment: 'confirmed' },
        ],
      }));
    }

    for (const pd of programDataWatch) {
      subId++;
      pendingByReqId.set(subId, { name: pd.name + ' (upgrade)', address: pd.address, type: 'program-upgrade' });
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: subId,
        method: 'accountSubscribe',
        params: [pd.address, { encoding: 'base64', commitment: 'confirmed' }],
      }));
    }

    console.log(`[WS] ${allAccounts.length + programDataWatch.length} subscriptions sent`);
    reconnectDelayMs = 5000;
    setTimeout(() => { void reVerifyAllV4(conn, 'ws-reconnect'); }, 3000);
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.id && msg.result !== undefined) {
        const item = pendingByReqId.get(msg.id);
        if (item && typeof msg.result === 'number') {
          itemBySubId.set(msg.result, item);
          pendingByReqId.delete(msg.id);
        }
        return;
      }
      if (msg.id && msg.error) {
        // A rejected subscription would otherwise leave that account unwatched until the next reconnect.
        const item = pendingByReqId.get(msg.id);
        pendingByReqId.delete(msg.id);
        console.error(`[WS] Subscribe failed for ${item?.name || msg.id}: ${JSON.stringify(msg.error).slice(0, 120)}`);
        if (item) setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          subId++;
          pendingByReqId.set(subId, item);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: subId, method: 'accountSubscribe', params: [item.address, { encoding: 'base64', commitment: 'confirmed' }] }));
        }, 5000);
        return;
      }

      if (msg.method === 'accountNotification') {
        const serverSubId: number | undefined = msg.params?.subscription;
        const changedItem = typeof serverSubId === 'number' ? itemBySubId.get(serverSubId) : undefined;

        if (!changedItem) {
          console.log(`[WS] Account change on unknown subscription ${serverSubId}`);
          return;
        }

        const notifSlot: number | undefined = msg.params?.result?.context?.slot;
        const notifValue = msg.params?.result?.value;
        if (changedItem.type === 'v4') {
          enqueue(changedItem.address, () => handleV4Notification(changedItem.name, changedItem.address, conn, notifValue, notifSlot));
        } else if (changedItem.type === 'v3' || changedItem.type === 'serum') {
          logActivity(changedItem.name, 'VaultTx', 'Account data changed', changedItem.address);
        } else if (changedItem.type === 'authority') {
          await handleAuthorityChange(changedItem.name, changedItem.address);
        } else if (changedItem.type === 'program-upgrade') {
          const progName = changedItem.name.replace(' (upgrade)', '');
          const prog = PROGRAM_DATA_WATCH.find(p => p.name === progName);
          if (prog && !isStaleSlot(changedItem.address, notifSlot)) {
            enqueue(changedItem.address, async () => { await sleep(1000); await handleProgramUpgrade(progName, conn, prog.programId); });
          }
        }
      }
    } catch (e: any) {
      console.error('[WS] message handling error:', e?.message?.slice(0, 120));
    }
  });

  ws.on('close', () => {
    const delay = reconnectDelayMs;
    console.log(`[WS] Connection closed. Reconnecting in ${Math.round(delay / 1000)}s...`);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
    setTimeout(() => connectWebSocket(conn, programDataWatch), delay);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });

  // A half-open socket never fires 'close', so monitoring would stop silently. Terminate when pongs
  // stop arriving; the close handler then reconnects and resubscribes.
  let lastPong = Date.now();
  ws.on('pong', () => { lastPong = Date.now(); });
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeat);
      return;
    }
    if (Date.now() - lastPong > 90000) {
      console.error('[WS] No pong for 90s, terminating socket');
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    ws.ping();
  }, 30000);
}

process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason);
  console.error(`[UNHANDLED-REJECTION] ${String(msg).slice(0, 200)}`);
});
process.on('uncaughtException', (err: any) => {
  const msg = err?.message || String(err);
  console.error(`[UNCAUGHT-EXCEPTION] ${String(msg).slice(0, 200)}`);
});

async function main() {
  console.log('=== SolGov Real-Time Listener ===');
  console.log(`Watching ${WATCH_LIST.length} accounts`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('');

  const conn = new Connection(process.env.HELIUS_RPC_URL || '', 'confirmed');

  loadPrevState();

  console.log('Loading initial state (batched)...');
  try {
    const v4Items = WATCH_LIST.filter(w => w.type === 'v4');
    const pubkeys = v4Items.map(w => new PublicKey(w.address));
    const infos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');
    for (let i = 0; i < v4Items.length; i++) {
      const info = infos[i];
      if (!info) {
        console.error(`  ${v4Items[i].name}: account not found`);
        continue;
      }
      try {
        const [ms] = multisig.accounts.Multisig.fromAccountInfo(info);
        await processV4State(v4Items[i].name, ms, v4Items[i].address);
      } catch (e: any) {
        console.error(`  ${v4Items[i].name}: ${e.message?.slice(0, 40)}`);
      }
    }
    lastReVerify = Date.now();
  } catch (e: any) {
    console.error('Initial state batch fetch failed:', e.message?.slice(0, 60));
  }
  savePrevState();

  console.log('\nResolving program data accounts...');
  const hadBaseline = loadProgramState();
  const programDataWatch: { name: string; address: string }[] = [];
  const changedWhileDown: { name: string; programId: string }[] = [];
  const valid = PROGRAM_DATA_WATCH.filter(p => { try { new PublicKey(p.programId); return true; } catch { console.error(`[INIT] invalid program id for ${p.name}`); return false; } });
  for (let i = 0; i < valid.length; i += 100) {
    const batch = valid.slice(i, i + 100);
    let progInfos: any[] = [];
    let pdInfos: any[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        progInfos = await conn.getMultipleAccountsInfo(batch.map(p => new PublicKey(p.programId)));
        const pdKeys = progInfos.map(info => info && info.executable && info.data.length >= 36 ? new PublicKey(info.data.slice(4, 36)) : null);
        const present = pdKeys.filter((k): k is PublicKey => !!k);
        const fetched = present.length ? await conn.getMultipleAccountsInfo(present) : [];
        let j = 0;
        pdInfos = pdKeys.map(k => (k ? { key: k, info: fetched[j++] } : null));
        break;
      } catch (e: any) {
        console.error(`[INIT] ProgramData batch ${i / 100 + 1} attempt ${attempt} failed: ${e.message?.slice(0, 80)}`);
        await sleep(2000 * attempt);
      }
    }
    batch.forEach((prog, k) => {
      const pd = pdInfos[k];
      if (!pd) { console.error(`[INIT] ${prog.name}: program account not resolved, not watched this session`); return; }
      programDataWatch.push({ name: prog.name, address: pd.key.toBase58() });
      const parsed = pd.info ? readProgramData(pd.info.data) : null;
      if (!parsed) return;
      const known = lastDeploySlot[prog.programId] !== undefined;
      if (hadBaseline && known && (lastDeploySlot[prog.programId] !== parsed.deploySlot || lastUpgradeAuthority[prog.programId] !== parsed.authority)) {
        changedWhileDown.push({ name: prog.name, programId: prog.programId });
        return; // keep the stored baseline so handleProgramUpgrade sees the difference
      }
      lastDeploySlot[prog.programId] = parsed.deploySlot;
      lastUpgradeAuthority[prog.programId] = parsed.authority;
    });
    await sleep(300);
  }
  saveProgramStateSoon();
  if (changedWhileDown.length) {
    console.log(`[INIT] ${changedWhileDown.length} program(s) changed while the listener was down; checking each`);
    for (const c of changedWhileDown) { await handleProgramUpgrade(c.name, conn, c.programId); await sleep(500); }
  }

  console.log(`\nStarting WebSocket listener (${WATCH_LIST.length} accounts + ${programDataWatch.length} program data)...\n`);
  connectWebSocket(conn, programDataWatch);

  try {
    const { watchRegistry } = require('./user-tracked-multisigs');
    let lastSize = -1;
    watchRegistry((list: any[]) => {
      if (list.length === lastSize) return;
      lastSize = list.length;
      console.log(`[USER-TRACKED] registry now has ${list.length} addresses; cycling WebSocket`);
      try { currentWs?.close(); } catch {}
    });
  } catch (e: any) {
    console.warn('[USER-TRACKED] watchRegistry not available:', e?.message);
  }
}

main().catch(console.error);
