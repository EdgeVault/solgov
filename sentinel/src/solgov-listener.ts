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
import { authorityText, ROLE_LABELS } from './utils/event-labels';
import { classifyV4Change, overallSeverity, snapshotFromV4, type Severity, type MultisigSnapshot } from './detectors/multisig-config';
import { readProgramData, decideProgramEvent, classifyProgramSeverity, type ProgramRole } from './detectors/program-upgrade';
import { AdminWatcher, type AdminAlert } from './admin-watch';

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

import { WATCH_LIST } from './watch-list';

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

type PrevEntry = MultisigSnapshot;
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
    const { threshold, memberCount, voterCount, timeLock, configAuthority, memberKeys } = snapshotFromV4(ms);
    const maskOf = (m: any) => { const mask = (m.permissions as any)?.mask ?? (m.permissions as any) ?? 0; return typeof mask === 'number' ? mask : 0; };

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
    const typedChanges = classifyV4Change(prev, now);
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
    lastUpgradeAuthority[programId] = authAddr;

    // A ProgramData notification fires on any write, not only an upgrade; decideProgramEvent proves a
    // redeploy from the deploy slot (see detectors/program-upgrade.ts). Without it a non-upgrade write
    // posts a phantom "Program X upgraded" to the public feed.
    const deploySlot = parsed.deploySlot;
    const prevSlot = lastDeploySlot[programId];
    lastDeploySlot[programId] = deploySlot;
    saveProgramStateSoon();
    // Block time of the deploy: used for the "deployed in the last 30 minutes" fallback when there is no
    // baseline, and as the event time so a change found after a restart is reported when it happened.
    let deployTime: number | null = null;
    try { deployTime = await conn.getBlockTime(deploySlot); } catch {}
    const { isAuthorityChange, isRealUpgrade } = decideProgramEvent({
      prevAuthority: prevAuth, authority: authAddr, prevDeploySlot: prevSlot, deploySlot, deployTime, nowSec: Date.now() / 1000,
    });
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
      ? `Who can upgrade program ${programId.slice(0, 12)}... changed to ${authAddr === 'IMMUTABLE' ? 'nobody (it can no longer be changed)' : `${authAddr.slice(0, 12)}...`}`
      : `Program code updated at ${hour}:00 UTC (program ${programId.slice(0, 12)}...)`, undefined, eventDate.toISOString());

    const authLabel = authAddr === 'IMMUTABLE' ? escapeHtml(authorityText(authAddr)) : await labelAddress(authAddr);
    const prevAuthLabel = prevAuth && prevAuth !== 'IMMUTABLE' ? await labelAddress(prevAuth) : prevAuth === 'IMMUTABLE' ? escapeHtml(authorityText(prevAuth)) : 'unknown';

    const { severity, header } = classifyProgramSeverity({ name, role, isAuthorityChange, hourUtc: hour });

    const authLine = isAuthorityChange
      ? `Who can upgrade it: <code>${prevAuthLabel}</code> → <code>${authLabel}</code>`
      : `Who can upgrade it: <code>${authLabel}</code>`;
    const msg = `${header}\n\n<b>${escapeHtml(alertName(name))}</b>\nProgram: <code>${programId.slice(0, 12)}...</code>\n${authLine}\nWhat it does: ${escapeHtml(ROLE_LABELS[role] ?? role)}\n📅 ${timestamp} UTC`;
    console.log(`[${severity}] ${name}: ${isAuthorityChange ? 'auth change' : 'upgrade'} role=${role} (${authLabel})`);

    if (severity === 'CRITICAL' || severity === 'HIGH') {
      await sendTelegram(msg, severity);
      if (isAuthorityChange) {
        const pub = `<b>${escapeHtml(alertName(name))}</b>\nWho can upgrade this program changed.\nProgram: <code>${programId.slice(0, 12)}...</code>\n${authLine}\n${timestamp} UTC\nsolgov.xyz`;
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

// Admin Watch (see admin-watch.ts): admin key fields inside protocol state accounts.
let adminWatcher: AdminWatcher | null = null;

async function dispatchAdminAlert(a: AdminAlert) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const safeName = escapeHtml(alertName(a.target.protocol));
  const detail = escapeHtml(a.detail);
  const link = a.txLink ? `\n${a.txLink}` : '';
  const sevHeader = a.severity === 'CRITICAL' ? '🔴 <b>CRITICAL: Protocol admin key changed</b>'
    : a.type === 'AdminHandoverProposed' ? '🟠 <b>HIGH: Protocol admin handover proposed</b>'
    : a.severity === 'HIGH' ? '🟠 <b>HIGH: Protocol admin key changed</b>' : '📋 <b>MONITOR</b>';
  const msg = `${sevHeader}\n\n<b>${safeName}</b>\n${detail}\nAccount: <code>${a.target.account.slice(0, 12)}...</code>${link}\n📅 ${timestamp} UTC`;
  console.log(`[${a.severity}] ${a.target.name}: ${a.type} ${a.field}`);
  logActivity(a.target.protocol, a.type, a.detail, a.target.account);
  await sendTelegram(msg, a.severity);
  if (a.public) await sendPublic(`<b>${safeName}</b>\n${detail}${link}\n${timestamp} UTC\nsolgov.xyz`);
  await sendToSubscribers({ protocol: a.target.protocol, severity: a.severity, type: 'AuthorityChange', message: msg });
}

async function handleAdminNotification(account: string, value: any) {
  if (!adminWatcher) return;
  const t = adminWatcher.targets.find(x => x.account === account);
  const raw = Array.isArray(value?.data) ? value.data[0] : null;
  if (!t || typeof raw !== 'string') return;
  const fields = adminWatcher.read(t, String(value.owner), Buffer.from(raw, 'base64'));
  if (!fields) { console.log(`[ADMIN] ${t.name}: notification failed owner/discriminator check; skipped`); return; }
  const alerts = await adminWatcher.observe(t, fields);
  for (const a of alerts) await dispatchAdminAlert(a);
  if (alerts.length) await adminWatcher.writeSnapshot();
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

    for (const t of adminWatcher?.targets || []) {
      subId++;
      pendingByReqId.set(subId, { name: t.name, address: t.account, type: 'admin-state' });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: subId, method: 'accountSubscribe', params: [t.account, { encoding: 'base64', commitment: 'confirmed' }] }));
    }

    console.log(`[WS] ${allAccounts.length + programDataWatch.length + (adminWatcher?.targets.length || 0)} subscriptions sent`);
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
        } else if (changedItem.type === 'admin-state') {
          if (!isStaleSlot(changedItem.address, notifSlot)) enqueue(changedItem.address, () => handleAdminNotification(changedItem.address, notifValue));
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

  try {
    adminWatcher = new AdminWatcher(conn);
    console.log(`[ADMIN] Watching ${adminWatcher.targets.length} protocol admin account(s)`);
    const changedWhileDownAdmin = await adminWatcher.initialRead();
    for (const a of changedWhileDownAdmin) await dispatchAdminAlert(a);
    await adminWatcher.writeSnapshot();
  } catch (e: any) {
    console.error('[ADMIN] init failed; Admin Watch off this session:', e.message);
    adminWatcher = null;
  }

  console.log(`\nStarting WebSocket listener (${WATCH_LIST.length} accounts + ${programDataWatch.length} program data + ${adminWatcher?.targets.length || 0} admin accounts)...\n`);
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
