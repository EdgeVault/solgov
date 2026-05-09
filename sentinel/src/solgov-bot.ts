import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import {
  upsertSubscription,
  addProtocolsToSubscription,
  removeProtocolFromSubscription,
  getSubscription,
  deleteSubscription,
  loadSubscriptions,
  Severity,
  EventType,
} from './subscriptions';
import { nameMatches } from './llm-tools';
import { addTracked, verifySquadsMultisig, listTracked, MAX_TRACKED } from './user-tracked-multisigs';
import { Connection } from '@solana/web3.js';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const STATE_FILE = path.join(__dirname, '..', 'data', 'monitor-state.json');

const ADMIN_IDS: Set<number> = new Set(
  (process.env.SOLGOV_BOT_ADMIN_IDS || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
);
function isAdmin(userId: number): boolean { return ADMIN_IDS.has(userId); }

let lastOffset = 0;
let scanning = false;

let botUsername: string | null = null;

async function fetchBotUsername(): Promise<void> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`);
    const data = await resp.json() as any;
    if (data?.ok && data.result?.username) {
      botUsername = data.result.username;
      console.log(`[BOT] Resolved username: @${botUsername}`);
    } else {
      console.warn('[BOT] getMe did not return a username; deep links will fall back to plain text');
    }
  } catch (e: any) {
    console.warn('[BOT] getMe failed:', e?.message);
  }
}

function dmOnlyMessage(action: string, humanLabel: string): string {
  const base = `Subscriptions are per-user and DM-only. ${humanLabel} there instead of this group.`;
  if (!botUsername) return base;
  const url = `https://t.me/${botUsername}?start=${encodeURIComponent(action)}`;
  return `${base}\n\n<a href="${url}">👉 Open a chat with me</a> (taps straight through).`;
}

let drySink: ((m: { text: string; chatId?: number | string; threadId?: number; replyMarkup?: any }) => void) | null = null;

export function setDryRunSink(fn: typeof drySink) { drySink = fn; }

async function sendMessage(text: string, chatIdOverride?: number | string, threadId?: number, replyMarkup?: any): Promise<{ messageId: number; chatId: number | string } | null> {
  if (drySink || process.env.SOLGOV_BOT_DRY_RUN === '1') {
    const entry = { text, chatId: chatIdOverride, threadId, replyMarkup };
    if (drySink) drySink(entry);
    else console.log('[DRY]', JSON.stringify(entry).slice(0, 400));
    return null;
  }
  const chatId = chatIdOverride ?? TG_CHAT_ID;
  if (chatId === undefined || chatId === null || chatId === '') {
    const stack = new Error('sendMessage with no chat_id').stack?.split('\n').slice(1, 5).join(' | ');
    console.error(`[BOT] sendMessage skipped: chat_id resolved to ${JSON.stringify(chatId)}, TG_CHAT_ID=${JSON.stringify(TG_CHAT_ID)}. Text=${text.slice(0, 80)}. Stack: ${stack}`);
    return null;
  }
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (threadId !== undefined) body.message_thread_id = threadId;
  if (replyMarkup) body.reply_markup = replyMarkup;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[BOT] sendMessage failed: ${resp.status} chat=${body.chat_id} thread=${body.message_thread_id || 'default'} body=${errText.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json() as { result?: { message_id?: number } };
    const messageId = data?.result?.message_id;
    return typeof messageId === 'number' ? { messageId, chatId } : null;
  } catch (e: any) {
    console.error('[BOT] sendMessage exception:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function editMessage(chatId: number | string, messageId: number, text: string, replyMarkup?: any): Promise<void> {
  if (drySink || process.env.SOLGOV_BOT_DRY_RUN === '1') {
    const entry = { edit: true, messageId, chatId, text, replyMarkup };
    if (drySink) drySink(entry);
    return;
  }
  const body: any = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[BOT] editMessage failed: ${resp.status} body=${errText.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.error('[BOT] editMessage exception:', e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function answerCallbackQuery(callbackQueryId: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch {}
}

function mainMenuKeyboard(userId: number) {
  const rows: { text: string; callback_data: string }[][] = [
    [
      { text: '📊 Status', callback_data: 'cmd:status' },
      { text: '📋 Report', callback_data: 'cmd:report_prompt' },
    ],
    [
      { text: '🔔 Subscribe', callback_data: 'cmd:subscribe_prompt' },
      { text: '📂 My Subs', callback_data: 'cmd:mysubs' },
    ],
    isAdmin(userId)
      ? [
          { text: '🔍 Scan', callback_data: 'cmd:scan' },
          { text: '⚙️ Filters', callback_data: 'cmd:filters_help' },
        ]
      : [
          { text: '🔎 Check protocol', callback_data: 'cmd:check_prompt' },
          { text: '⚙️ Filters', callback_data: 'cmd:filters_help' },
        ],
    [
      { text: '❓ Full command list', callback_data: 'cmd:help_full' },
    ],
  ];
  return { inline_keyboard: rows };
}

function fullMenuKeyboard(userId: number) {
  const admin = isAdmin(userId);
  const rows: { text: string; callback_data: string }[][] = admin
    ? [
        [
          { text: '📊 Status', callback_data: 'cmd:status' },
          { text: '🔍 Full scan', callback_data: 'cmd:scan' },
        ],
        [
          { text: '🏆 Tier 1 scan', callback_data: 'cmd:tier1' },
          { text: '🔬 Deep scan', callback_data: 'cmd:deep' },
        ],
        [
          { text: '📋 Report', callback_data: 'cmd:report_prompt' },
          { text: '🔎 Check protocol', callback_data: 'cmd:check_prompt' },
        ],
        [
          { text: '🎯 Nonce check', callback_data: 'cmd:nonce_prompt' },
          { text: '⚙️ Filter help', callback_data: 'cmd:filters_help' },
        ],
        [
          { text: '🔔 Subscribe', callback_data: 'cmd:subscribe_prompt' },
          { text: '📂 My Subs', callback_data: 'cmd:mysubs' },
        ],
        [
          { text: '🚫 Unsubscribe', callback_data: 'cmd:unsubscribe_prompt' },
          { text: '❌ Clear all subs', callback_data: 'cmd:unsuball' },
        ],
        [
          { text: '« Main menu', callback_data: 'cmd:main_menu' },
        ],
      ]
    : [
        [
          { text: '📊 Status', callback_data: 'cmd:status' },
          { text: '🔎 Check protocol', callback_data: 'cmd:check_prompt' },
        ],
        [
          { text: '📋 Report', callback_data: 'cmd:report_prompt' },
          { text: '⚙️ Filter help', callback_data: 'cmd:filters_help' },
        ],
        [
          { text: '🔔 Subscribe', callback_data: 'cmd:subscribe_prompt' },
          { text: '📂 My Subs', callback_data: 'cmd:mysubs' },
        ],
        [
          { text: '🚫 Unsubscribe', callback_data: 'cmd:unsubscribe_prompt' },
          { text: '❌ Clear all subs', callback_data: 'cmd:unsuball' },
        ],
        [
          { text: '« Main menu', callback_data: 'cmd:main_menu' },
        ],
      ];
  return { inline_keyboard: rows };
}

function welcomeText(): string {
  return `<b>🟢 SolGov Monitor</b>\n\n` +
    `Real-time governance monitoring across 50+ Solana DeFi protocols. ` +
    `Tap a button or use slash commands directly.`;
}

function fullHelpText(): string {
  return `<b>SolGov - full command list</b>\n\n` +
    `<b>Scanning</b>\n` +
    `<code>/scan</code>  /tier1  /deep  /status\n\n` +
    `<b>Lookup</b>\n` +
    `<code>/check &lt;name&gt;</code>  <code>/nonce &lt;address&gt;</code>\n\n` +
    `<b>Subscriptions (DM)</b>\n` +
    `<code>/subscribe &lt;protocol&gt;</code>\n` +
    `<code>/unsubscribe &lt;protocol&gt;</code>\n` +
    `<code>/mysubs</code>  <code>/unsuball</code>\n` +
    `<code>/filters severity:CRITICAL types:AuthorityChange</code>\n\n` +
    `<b>Track any Squads v4 multisig (DM)</b>\n` +
    `<code>/track &lt;address&gt; [label]</code>\n\n` +
    `<b>Report</b>\n` +
    `<code>/report &lt;protocol&gt; [24h|7d]</code>`;
}

type PendingAction = 'report' | 'subscribe' | 'check' | 'nonce' | 'unsubscribe';
const pendingActions: Map<number, { action: PendingAction; createdAt: number }> = new Map();

async function getUpdates(): Promise<any[]> {
  try {
    const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
    const resp = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastOffset}&timeout=30&allowed_updates=${allowed}`
    );
    const data = await resp.json() as any;
    if (data.ok && data.result.length > 0) {
      lastOffset = data.result[data.result.length - 1].update_id + 1;
      return data.result;
    }
  } catch {}
  return [];
}

function runScan(mode: string): Promise<string> {
  return new Promise((resolve) => {
    exec(
      `npx tsx src/solgov-monitor.ts ${mode}`,
      { cwd: path.join(__dirname, '..'), timeout: 300000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve(`Scan error: ${error.message.slice(0, 100)}`);
        } else {
          const lines = stdout.split('\n');
          const hasChanges = lines.some((l) => l.includes('changes'));
          resolve(hasChanges ? 'Scan complete. See alert above for details.' : 'Scan complete.');
        }
      }
    );
  });
}

const STATUS_NAME_MAP: Record<string, string> = {
  'Pumpfun': 'Pumpfun + PumpSwap',
  'Huma': 'Huma Finance',
  'Onre Finance (secondary)': 'Onre Finance',
  'deBridge (governance multisig)': 'deBridge',
  'Raydium (treasury)': 'Raydium',
};

function getStatus(): string {
  try {
    if (!fs.existsSync(STATE_FILE)) return 'No scan data yet. Run /scan first.';
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const rawNames = Object.keys(state).filter(k => !k.startsWith('_'));
    if (rawNames.length === 0) return 'No scan data yet. Run /scan first.';

    const byCanonical = new Map<string, any>();
    for (const name of rawNames) {
      const canonical = STATUS_NAME_MAP[name] || name;
      const isPrimary = name === canonical;
      const existing = byCanonical.get(canonical);
      const existingIsPrimary = existing?.__rawName === canonical;
      const incoming = { ...state[name], __rawName: name };
      if (!existing) {
        byCanonical.set(canonical, incoming);
      } else if (isPrimary && !existingIsPrimary) {
        byCanonical.set(canonical, incoming);
      } else if (!isPrimary && existingIsPrimary) {
      } else if ((incoming.lastChecked ?? '') > (existing.lastChecked ?? '')) {
        byCanonical.set(canonical, incoming);
      }
    }

    let latest = '';
    let withTimelock = 0;
    let noTimelock = 0;
    let threatCount = 0;
    let criticalCount = 0;
    for (const p of byCanonical.values()) {
      if (p.lastChecked > latest) latest = p.lastChecked;
      if (typeof p.timeLock === 'number' && p.timeLock > 0) withTimelock++;
      else noTimelock++;
      if (p.threatAlerts?.length > 0) {
        threatCount += p.threatAlerts.length;
        criticalCount += p.threatAlerts.filter((t: any) => t.severity === 'CRITICAL').length;
      }
    }

    return `<b>SolGov Status</b>\n\n` +
      `Protocols tracked: ${byCanonical.size}\n` +
      `With timelock: ${withTimelock}\n` +
      `No timelock: ${noTimelock}\n` +
      `Threat alerts: ${threatCount} (${criticalCount} critical)\n` +
      `Last scan: ${latest.split('T')[0]} ${latest.split('T')[1]?.slice(0, 5)} UTC`;
  } catch {
    return 'Error reading state.';
  }
}

function checkProtocol(name: string): string {
  try {
    if (!fs.existsSync(STATE_FILE)) return 'No scan data yet. Run /scan first.';
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));

    const match = Object.keys(state).find(
      (k) => !k.startsWith('_') && nameMatches(k, name)
    );
    if (!match) return `Protocol "${name}" not found. Try /status to see tracked protocols.`;

    const p = state[match];
    const members = p.members?.length || 0;
    const tl = p.timeLock === 0 ? 'None' : p.timeLock === -1 ? 'N/A' : `${Math.round(p.timeLock / 3600)}h`;
    const nonces = p.nonceAlerts?.length || 0;
    const pct = members > 0 ? Math.round((p.threshold / members) * 100) : 0;

    let msg = `<b>${match}</b>\n\n`;
    msg += `<b>Multisig</b>\n`;
    msg += `Threshold: ${p.threshold}/${members} (${pct}%)\n`;
    msg += `Gov. timelock: ${tl}\n`;
    const threats = p.threatAlerts || [];
    if (threats.length > 0) {
      msg += `\n⚠️ <b>Threat alerts: ${threats.length}</b>\n`;
      for (const t of threats) {
        const icon = t.severity === 'CRITICAL' ? '🚨' : t.severity === 'HIGH' ? '⚠️' : 'ℹ️';
        msg += `${icon} ${t.category}: ${t.detail}\n`;
        msg += `  Signer: ${t.signer?.slice(0, 8)}... | ${t.detectedAt}\n`;
      }
    } else {
      msg += `Threat scan: Clean\n`;
    }
    msg += `Last checked: ${p.lastChecked?.split('T')[0] || 'unknown'}`;
    if (p.programAuthorities) {
      const auths = Object.entries(p.programAuthorities) as [string, string][];
      if (auths.length > 0) {
        msg += `\n\n<b>Programs (${auths.length})</b>\n`;
        const byAuth = new Map<string, string[]>();
        for (const [name, auth] of auths) {
          const list = byAuth.get(auth) || [];
          list.push(name);
          byAuth.set(auth, list);
        }
        for (const [auth, names] of byAuth) {
          const shortAuth = auth.slice(0, 8) + '...';
          if (names.length === 1) {
            msg += `${names[0]}: ${shortAuth}\n`;
          } else {
            msg += `${shortAuth} controls ${names.length}:\n  ${names.join(', ')}\n`;
          }
        }
      }
    }
    return msg;
  } catch {
    return 'Error reading state.';
  }
}

async function checkNonce(address: string): Promise<string> {
  try {
    const resp = await fetch(process.env.HELIUS_RPC_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 20 }],
      }),
    });
    const data = await resp.json() as any;
    const sigs = data.result || [];
    const twoWeeksAgo = Date.now() / 1000 - 14 * 86400;
    const recent = sigs.filter((s: any) => s.blockTime && s.blockTime > twoWeeksAgo);

    let nonceFound = false;
    let nonceTime = '';
    let nonceSig = '';

    for (const sig of recent.slice(0, 5)) {
      const txResp = await fetch(process.env.HELIUS_RPC_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
      });
      const txData = await txResp.json() as any;
      const logs = txData.result?.meta?.logMessages || [];
      const hasNonce = logs.some((l: string) =>
        l.includes('InitializeNonceAccount') ||
        l.includes('AdvanceNonceAccount') ||
        l.includes('AuthorizeNonceAccount') ||
        l.includes('WithdrawNonceAccount')
      );
      if (hasNonce) {
        nonceFound = true;
        nonceTime = sig.blockTime
          ? new Date(sig.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
          : 'unknown';
        nonceSig = sig.signature.slice(0, 20);
        break;
      }
    }

    if (nonceFound) {
      return `🚨 <b>Durable nonce activity</b>\n\n` +
        `Address: ${address.slice(0, 8)}...${address.slice(-4)}\n` +
        `Detected: ${nonceTime}\n` +
        `Signature: ${nonceSig}...`;
    } else {
      return `✅ <b>Clean</b>\n\n` +
        `Address: ${address.slice(0, 8)}...${address.slice(-4)}\n` +
        `Transactions checked: ${recent.length} (14 day window)\n` +
        `Durable nonce activity: none detected`;
    }
  } catch (e: any) {
    return `Error checking address: ${e.message?.slice(0, 60)}`;
  }
}

const reportCache = new Map<string, { text: string; createdAt: number }>();
const REPORT_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

function pruneReportCache() {
  const cutoff = Date.now() - REPORT_CACHE_MAX_AGE_MS;
  for (const [k, v] of reportCache) if (v.createdAt < cutoff) reportCache.delete(k);
}

const REPORT_USER_WINDOW_MS = 60 * 60 * 1000;
const REPORT_USER_LIMIT = 5;
const reportUserHits: Map<number, number[]> = new Map();

function checkReportRateLimit(userId: number): { allowed: boolean; retryAfterMin?: number } {
  if (isAdmin(userId)) return { allowed: true };
  const now = Date.now();
  const cutoff = now - REPORT_USER_WINDOW_MS;
  const hits = (reportUserHits.get(userId) || []).filter(t => t > cutoff);
  if (hits.length >= REPORT_USER_LIMIT) {
    const retryAfterMin = Math.ceil((hits[0] + REPORT_USER_WINDOW_MS - now) / 60000);
    return { allowed: false, retryAfterMin };
  }
  return { allowed: true };
}

function recordReportHit(userId: number): void {
  if (isAdmin(userId)) return;
  const now = Date.now();
  const cutoff = now - REPORT_USER_WINDOW_MS;
  const hits = (reportUserHits.get(userId) || []).filter(t => t > cutoff);
  hits.push(now);
  reportUserHits.set(userId, hits);
}

async function generateReport(protocol: string, window: '24h' | '7d', userId?: number): Promise<string> {
  try {
    const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {};
    const protocolName = Object.keys(state).find(k => !k.startsWith('_') && nameMatches(k, protocol));
    const protocolState = protocolName ? state[protocolName] : null;

    const feedPath = path.join(__dirname, '..', '..', 'public-dashboard', 'src', 'data', 'activity-feed.json');
    let activity: any[] = [];
    if (fs.existsSync(feedPath)) {
      try { activity = JSON.parse(fs.readFileSync(feedPath, 'utf-8')); } catch {}
    }
    if (state._activityLog && Array.isArray(state._activityLog)) {
      activity = activity.concat(state._activityLog);
    }
    const cutoffMs = Date.now() - (window === '7d' ? 7 : 1) * 86400 * 1000;
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
    const cutoffIso = new Date(cutoffMs).toISOString();
    const relevant = activity.filter((e: any) => {
      const protoMatch = e.protocol && nameMatches(e.protocol, protocol);
      if (!protoMatch) return false;
      if (e.timestamp) return e.timestamp >= cutoffIso;
      return e.date >= cutoff;
    });
    const seen = new Set<string>();
    const deduped = relevant.filter((e: any) => {
      const key = `${e.timestamp || e.date}|${e.type}|${e.detail || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a: any, b: any) => (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || ''));

    const newestEventTs = deduped[0]?.timestamp || deduped[0]?.date || 'none';
    const cacheKey = `${protocolName || protocol}:${window}:${newestEventTs}:${protocolState?.lastChecked || 'nostate'}`;
    pruneReportCache();
    const cached = reportCache.get(cacheKey);
    if (cached) return cached.text;

    const displayName = protocolName || protocol;

    if (!protocolState) {
      const miss = `<b>${displayName} - ${window} briefing</b>\n\nNot tracked in monitor-state. Try /status for the full list.`;
      reportCache.set(cacheKey, { text: miss, createdAt: Date.now() });
      return miss;
    }

    const lastCheckedIso: string | null = protocolState.lastChecked ?? null;
    const lastCheckedAgeH = lastCheckedIso
      ? (Date.now() - new Date(lastCheckedIso).getTime()) / 3600_000
      : null;
    const freshness = lastCheckedAgeH === null
      ? 'no timestamp'
      : lastCheckedAgeH < 1
        ? `${Math.round(lastCheckedAgeH * 60)} min ago`
        : lastCheckedAgeH < 48
          ? `${Math.round(lastCheckedAgeH)} h ago`
          : `${Math.round(lastCheckedAgeH / 24)} d ago (stale)`;

    const memberCount = protocolState.members?.length ?? 0;
    const thresh = protocolState.threshold ?? '?';
    const tlSec = protocolState.timeLock ?? 0;
    const tlLabel = tlSec === 0 ? 'None' : tlSec === -1 ? 'N/A' : `${Math.round(tlSec / 3600)}h`;
    const threats = (protocolState.threatAlerts || []) as Array<any>;
    const pendingProposals = protocolState.pendingProposals ?? 0;

    const lines: string[] = [];
    lines.push(`<b>${displayName} - ${window} briefing</b>`);
    lines.push('');
    lines.push(`<b>Governance</b>`);
    lines.push(`• Multisig: ${thresh}/${memberCount} signers`);
    lines.push(`• Timelock: ${tlLabel}`);
    lines.push(`• State freshness: ${freshness}`);
    if (pendingProposals > 0) {
      lines.push(`• <b>Pending proposals</b>: ${pendingProposals} queued in the multisig (not yet executed)`);
    }
    if (threats.length > 0) {
      lines.push('');
      lines.push(`<b>Open threat alerts (${threats.length})</b>`);
      for (const t of threats.slice(0, 6)) {
        const icon = t.severity === 'CRITICAL' ? '🚨' : t.severity === 'HIGH' ? '⚠️' : 'ℹ️';
        const signer = t.signer ? ` · ${t.signer.slice(0, 8)}…` : '';
        lines.push(`${icon} ${t.category}: ${t.detail}${signer}`);
      }
      if (threats.length > 6) lines.push(`<i>…and ${threats.length - 6} more</i>`);
    }

    lines.push('');
    if (deduped.length === 0) {
      lines.push(`<b>Activity (${window})</b>`);
      lines.push(`No on-chain events recorded in this window.`);
    } else {
      lines.push(`<b>Activity (${window}) - ${deduped.length} event${deduped.length === 1 ? '' : 's'}</b>`);
      const shown = deduped.slice(0, 15);
      for (const e of shown) {
        const when = e.date || (e.timestamp ? e.timestamp.slice(0, 10) : '?');
        const detail = e.detail ? ` · ${String(e.detail).slice(0, 160)}` : '';
        lines.push(`• ${when} - <b>${e.type}</b>${detail}`);
      }
      if (deduped.length > shown.length) lines.push(`<i>…and ${deduped.length - shown.length} more</i>`);
    }

    if (deduped.length === 0 && threats.length === 0 && pendingProposals === 0) {
      lines.push('');
      lines.push('<i>Clean window: no events, no open threats, no pending proposals.</i>');
    }

    const final = lines.join('\n');
    reportCache.set(cacheKey, { text: final, createdAt: Date.now() });
    if (userId !== undefined) recordReportHit(userId);
    return final;
  } catch (e: any) {
    return `Error generating report: ${e.message?.slice(0, 100)}`;
  }
}

export async function handleCallback(data: string, ctx: { userId: number; chatId: number; username?: string; isPrivate: boolean; threadId?: number }) {
  const replyTo = ctx.isPrivate ? ctx.chatId : undefined;
  const replyThread = ctx.isPrivate ? undefined : ctx.threadId;

  if (data.startsWith('triage:')) {
    if (!isAdmin(ctx.userId)) {
      await sendMessage('Auto-triage is admin-only. Public alerts include the on-chain facts; the deep-scan playbook is run by the operator and posted as a follow-up when relevant.', replyTo, replyThread);
      return;
    }
    const [, id, stepStr] = data.split(':');
    const stepIndex = parseInt(stepStr, 10);
    if (!id || isNaN(stepIndex)) return;
    const placeholder = await sendMessage('🔎 Scanning deeper...', replyTo, replyThread);
    const { runStoredTriageStep } = await import('./llm-triage');
    const out = await runStoredTriageStep(id, stepIndex);
    const finalText = out
      ? out.text
      : '⚠️ Triage temporarily unavailable. The LLM returned no output. Try the button again in a minute.';
    const finalMarkup = out?.replyMarkup;
    if (placeholder) {
      await editMessage(placeholder.chatId, placeholder.messageId, finalText, finalMarkup);
    } else {
      await sendMessage(finalText, replyTo, replyThread, finalMarkup);
    }
    return;
  }

  switch (data) {
    case 'cmd:status':
      await sendMessage(getStatus(), replyTo, replyThread);
      return;
    case 'cmd:help_full':
      await sendMessage(
        `<b>SolGov - full command menu</b>\n\nTap a tile or use slash commands directly.`,
        replyTo, replyThread, fullMenuKeyboard(ctx.userId)
      );
      return;
    case 'cmd:main_menu':
      await sendMessage(welcomeText(), replyTo, replyThread, mainMenuKeyboard(ctx.userId));
      return;
    case 'cmd:tier1':
      if (scanning) { await sendMessage('Scan already in progress...', replyTo, replyThread); return; }
      scanning = true;
      await sendMessage('🏆 Starting tier 1 scan (11 high-risk protocols)...', replyTo, replyThread);
      await sendMessage(await runScan('tier1'), replyTo, replyThread);
      scanning = false;
      return;
    case 'cmd:deep':
      if (scanning) { await sendMessage('Scan already in progress...', replyTo, replyThread); return; }
      scanning = true;
      await sendMessage('🔬 Starting deep audit (member permissions, verified builds, full threat detection). 2-3 minutes...', replyTo, replyThread);
      await sendMessage(await runScan('full'), replyTo, replyThread);
      scanning = false;
      return;
    case 'cmd:check_prompt':
      pendingActions.set(ctx.userId, { action: 'check', createdAt: Date.now() });
      await sendMessage(
        `🔎 <b>Check protocol</b>\n\nReply with a protocol name to see its governance, multisig, threat status.\nExamples: <code>Drift</code>, <code>Project 0</code>, <code>Kamino</code>`,
        replyTo, replyThread
      );
      return;
    case 'cmd:nonce_prompt':
      pendingActions.set(ctx.userId, { action: 'nonce', createdAt: Date.now() });
      await sendMessage(
        `🎯 <b>Nonce check</b>\n\nReply with a Solana address to scan the last 14 days for durable-nonce activity.`,
        replyTo, replyThread
      );
      return;
    case 'cmd:unsubscribe_prompt':
      if (!ctx.isPrivate) {
        await sendMessage(dmOnlyMessage('unsubscribe', 'Unsubscribe from'), replyTo, replyThread);
        return;
      }
      pendingActions.set(ctx.userId, { action: 'unsubscribe', createdAt: Date.now() });
      await sendMessage(
        `🚫 <b>Unsubscribe</b>\n\nReply with the protocol name to remove from your subscriptions.`,
        replyTo, replyThread
      );
      return;
    case 'cmd:unsuball':
      if (!ctx.isPrivate) {
        await sendMessage(dmOnlyMessage('unsuball', 'Clear all your subscriptions'), replyTo, replyThread);
        return;
      }
      await handleCommand('/unsuball', ctx);
      return;
    case 'cmd:filters_help':
      await sendMessage(
        `<b>Filter your subscription</b>\n\n` +
        `Send <code>/filters severity:CRITICAL</code> to only receive critical alerts.\n\n` +
        `<b>Severity options:</b> CRITICAL, HIGH, MONITOR (comma-separate for multiple)\n` +
        `<b>Type options:</b> AuthorityChange, ProgramUpgrade, ConfigChange, NONCE, VaultTx, * (all)\n\n` +
        `Example: <code>/filters severity:CRITICAL,HIGH types:AuthorityChange,ProgramUpgrade</code>`,
        replyTo,
        replyThread
      );
      return;
    case 'cmd:mysubs': {
      const sub = getSubscription(ctx.userId);
      if (!ctx.isPrivate) {
        if (sub?.chatId && sub.chatId !== ctx.chatId) {
          const sevLabel = sub.severities.length === 0 ? 'all' : sub.severities.join(', ');
          const typeLabel = sub.types.includes('*') ? 'all' : sub.types.join(', ');
          await sendMessage(
            `<b>Your subscription</b>\n\n` +
            `Protocols: ${sub.protocols.join(', ') || '(none)'}\n` +
            `Severities: ${sevLabel}\n` +
            `Event types: ${typeLabel}\n` +
            `Since: ${sub.createdAt.slice(0, 10)}`,
            sub.chatId,
          );
          await sendMessage('📩 Sent to your DM.', undefined, replyThread);
          return;
        }
        await sendMessage(dmOnlyMessage('mysubs', 'View your subscriptions'), replyTo, replyThread);
        return;
      }
      if (!sub) {
        await sendMessage('You have no subscriptions yet. Tap 🔔 Subscribe to add one.', replyTo, replyThread);
      } else {
        const sevLabel = sub.severities.length === 0 ? 'all' : sub.severities.join(', ');
        const typeLabel = sub.types.includes('*') ? 'all' : sub.types.join(', ');
        await sendMessage(
          `<b>Your subscription</b>\n\n` +
          `Protocols: ${sub.protocols.join(', ') || '(none)'}\n` +
          `Severities: ${sevLabel}\n` +
          `Event types: ${typeLabel}\n` +
          `Since: ${sub.createdAt.slice(0, 10)}`,
          replyTo,
          replyThread
        );
      }
      return;
    }
    case 'cmd:subscribe_prompt':
      if (!ctx.isPrivate) {
        await sendMessage(dmOnlyMessage('subscribe', 'Subscribe to a protocol'), replyTo, replyThread);
        return;
      }
      pendingActions.set(ctx.userId, { action: 'subscribe', createdAt: Date.now() });
      await sendMessage(
        `🔔 <b>Subscribe</b>\n\nReply with the protocol name you want alerts for.\nExamples: <code>Solstice</code>, <code>Drift</code>, <code>Kamino</code>`,
        replyTo,
        replyThread
      );
      return;
    case 'cmd:report_prompt':
      pendingActions.set(ctx.userId, { action: 'report', createdAt: Date.now() });
      await sendMessage(
        `📋 <b>Report</b>\n\nReply with the protocol name. Add <code>7d</code> at the end for a 7-day briefing (default is 24h).\nExamples: <code>Solstice</code> or <code>Drift 7d</code>`,
        replyTo,
        replyThread
      );
      return;
    case 'cmd:scan':
      if (!isAdmin(ctx.userId)) {
        await sendMessage('Manual scans are admin-only. /status shows live state from the always-on listener.', replyTo, replyThread);
        return;
      }
      if (scanning) {
        await sendMessage('Scan already in progress...', replyTo, replyThread);
        return;
      }
      scanning = true;
      await sendMessage('🔍 Starting full scan...', replyTo, replyThread);
      const result = await runScan('full');
      await sendMessage(result, replyTo, replyThread);
      scanning = false;
      return;
  }
}

export async function handleCommand(text: string, ctx: { userId: number; chatId: number; username?: string; isPrivate: boolean; threadId?: number }) {
  const cmd = text.trim().replace(/@\w+/g, '');
  const cmdLower = cmd.toLowerCase();
  const replyTo = ctx.isPrivate ? ctx.chatId : undefined;
  const replyThread = ctx.isPrivate ? undefined : ctx.threadId;

  if (cmdLower === '/help' || cmdLower.startsWith('/start')) {
    const startArg = cmdLower.startsWith('/start')
      ? cmd.slice('/start'.length).trim().toLowerCase()
      : '';
    if (ctx.isPrivate && startArg) {
      const route: Record<string, string> = {
        subscribe: 'cmd:subscribe_prompt',
        unsubscribe: 'cmd:unsubscribe_prompt',
        unsuball: 'cmd:unsuball',
        mysubs: 'cmd:mysubs',
        filters: 'cmd:filters_help',
      };
      const target = route[startArg];
      if (target) {
        await handleCallback(target, ctx);
        return;
      }
    }
    await sendMessage(welcomeText(), replyTo, replyThread, mainMenuKeyboard(ctx.userId));
  } else if (cmdLower === '/myid') {
    await sendMessage(`Your Telegram user ID: <code>${ctx.userId}</code>`, replyTo, replyThread);
  } else if (cmdLower.startsWith('/showcase') || cmdLower.startsWith('/test')) {
    if (!isAdmin(ctx.userId)) return;
    const isShowcase = cmdLower.startsWith('/showcase');
    const prefixLen = isShowcase ? '/showcase'.length : '/test'.length;
    const args = cmd.slice(prefixLen).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const isLive = isShowcase || args.includes('live');
    const group = args.find(a => a !== 'live') || 'all';
    if (isLive) {
      await sendMessage(
        `🟢 <b>SolGov live showcase</b>\nA short walkthrough of some features.`,
        replyTo, replyThread,
      );
      const summary = await runInternalTestSweep(group, ctx.threadId, true);
      if (summary) await sendMessage(summary, replyTo, replyThread);
    } else {
      await sendMessage(`🧪 Running bot-flow test (<b>${group}</b>, dry-run)...`, replyTo, replyThread);
      const summary = await runInternalTestSweep(group, ctx.threadId, false);
      if (summary) await sendMessage(summary, replyTo, replyThread);
    }
  } else if (cmdLower.startsWith('/subscribe')) {
    if (!ctx.isPrivate) {
      await sendMessage(dmOnlyMessage('subscribe', 'Subscribe'), replyTo, replyThread);
      return;
    }
    const protocol = cmd.slice('/subscribe'.length).trim();
    if (!protocol) {
      await sendMessage('Usage: /subscribe &lt;protocol&gt;\nExample: /subscribe Solstice', replyTo, replyThread);
      return;
    }
    const sub = addProtocolsToSubscription(ctx.userId, ctx.chatId, [protocol], ctx.username);
    await sendMessage(
      `✅ Subscribed to <b>${protocol}</b>.\nYou will receive alerts for this protocol at your current filter settings.\nProtocols subscribed: ${sub.protocols.join(', ')}`,
      replyTo,
      replyThread
    );
  } else if (cmdLower.startsWith('/unsubscribe')) {
    if (!ctx.isPrivate) {
      await sendMessage(dmOnlyMessage('unsubscribe', 'Unsubscribe'), replyTo, replyThread);
      return;
    }
    const protocol = cmd.slice('/unsubscribe'.length).trim();
    if (!protocol) {
      await sendMessage('Usage: /unsubscribe &lt;protocol&gt;', replyTo, replyThread);
      return;
    }
    const { found, remaining } = removeProtocolFromSubscription(ctx.userId, protocol);
    if (!found) {
      await sendMessage(`${protocol} was not in your subscriptions.`, replyTo, replyThread);
    } else {
      await sendMessage(
        remaining.length > 0
          ? `Removed <b>${protocol}</b>. Still subscribed to: ${remaining.join(', ')}.`
          : `Removed <b>${protocol}</b>. No remaining subscriptions.`,
        replyTo, replyThread,
      );
    }
  } else if (cmdLower === '/unsuball') {
    if (!ctx.isPrivate) {
      await sendMessage(dmOnlyMessage('unsuball', 'Clear all subscriptions'), replyTo, replyThread);
      return;
    }
    const ok = deleteSubscription(ctx.userId);
    await sendMessage(ok ? 'Subscription cleared.' : 'You had no subscription to clear.', replyTo, replyThread);
  } else if (cmdLower === '/mysubs') {
    const sub = getSubscription(ctx.userId);
    if (!ctx.isPrivate) {
      if (sub?.chatId && sub.chatId !== ctx.chatId) {
        const sevLabel = sub.severities.length === 0 ? 'all' : sub.severities.join(', ');
        const typeLabel = sub.types.includes('*') ? 'all' : sub.types.join(', ');
        await sendMessage(
          `<b>Your subscription</b>\n\n` +
          `Protocols: ${sub.protocols.join(', ') || '(none)'}\n` +
          `Severities: ${sevLabel}\n` +
          `Event types: ${typeLabel}\n` +
          `Since: ${sub.createdAt.slice(0, 10)}`,
          sub.chatId,
        );
        await sendMessage('📩 Sent to your DM.', undefined, replyThread);
        return;
      }
      await sendMessage(dmOnlyMessage('mysubs', 'View your subscriptions'), replyTo, replyThread);
      return;
    }
    if (!sub) {
      await sendMessage('You have no subscriptions yet. Try <code>/subscribe Solstice</code>.', replyTo, replyThread);
    } else {
      const sevLabel = sub.severities.length === 0 ? 'all' : sub.severities.join(', ');
      const typeLabel = sub.types.includes('*') ? 'all' : sub.types.join(', ');
      await sendMessage(
        `<b>Your subscription</b>\n\n` +
        `Protocols: ${sub.protocols.join(', ') || '(none)'}\n` +
        `Severities: ${sevLabel}\n` +
        `Event types: ${typeLabel}\n` +
        `Since: ${sub.createdAt.slice(0, 10)}`,
        replyTo,
        replyThread
      );
    }
  } else if (cmdLower.startsWith('/filters')) {
    if (!ctx.isPrivate) {
      await sendMessage(dmOnlyMessage('filters', 'Adjust your filters'), replyTo, replyThread);
      return;
    }
    const sub = getSubscription(ctx.userId);
    if (!sub) {
      await sendMessage('Subscribe to a protocol first with /subscribe &lt;protocol&gt;.', replyTo, replyThread);
      return;
    }
    const body = cmd.slice('/filters'.length).trim();
    if (!body) {
      await sendMessage(
        `Usage: /filters severity:CRITICAL,HIGH types:AuthorityChange,ProgramUpgrade\n` +
        `Severity options: CRITICAL, HIGH, MONITOR, or omit for all.\n` +
        `Type options: ConfigChange, AuthorityChange, ProgramUpgrade, NONCE, VaultTx, or * for all.`,
        replyTo,
        replyThread
      );
      return;
    }
    let severities = sub.severities;
    let types = sub.types;
    const sevMatch = body.match(/severity:([A-Z,]+)/i);
    const typeMatch = body.match(/types:([A-Za-z*,]+)/);
    if (sevMatch) {
      severities = sevMatch[1].split(',').map(s => s.toUpperCase().trim()).filter(s => ['CRITICAL', 'HIGH', 'MONITOR'].includes(s)) as Severity[];
    }
    if (typeMatch) {
      types = typeMatch[1].split(',').map(t => t.trim()).filter(t => ['ConfigChange', 'AuthorityChange', 'ProgramUpgrade', 'NONCE', 'VaultTx', '*'].includes(t)) as EventType[];
    }
    upsertSubscription(ctx.userId, { chatId: ctx.chatId, severities, types });
    await sendMessage(
      `Filters updated.\nSeverities: ${severities.length > 0 ? severities.join(', ') : 'all'}\nTypes: ${types.includes('*') ? 'all' : types.join(', ')}`,
      replyTo,
      replyThread
    );
  } else if (cmdLower.startsWith('/track')) {
    if (!ctx.isPrivate) {
      await sendMessage(dmOnlyMessage('track', 'Track a Squads v4 multisig'), replyTo, replyThread);
      return;
    }
    const arg = cmd.slice('/track'.length).trim();
    if (!arg) {
      await sendMessage(
        `<b>Track a Squads v4 multisig</b>\n\n` +
        `Submit any Squads v4 multisig address - solgov verifies it on-chain, adds it to the listener, and auto-subscribes you for alerts.\n\n` +
        `Usage: <code>/track &lt;address&gt; [optional label]</code>\n` +
        `Currently tracked: ${listTracked().length}/${MAX_TRACKED}`,
        replyTo, replyThread,
      );
      return;
    }
    const parts = arg.split(/\s+/);
    const address = parts[0];
    const label = parts.slice(1).join(' ').slice(0, 60) || undefined;
    if (!process.env.HELIUS_RPC_URL) {
      await sendMessage('On-chain verification unavailable: HELIUS_RPC_URL not configured on the bot host.', replyTo, replyThread);
      return;
    }
    await sendMessage(`🔎 Verifying <code>${address.slice(0, 12)}...</code> on-chain...`, replyTo, replyThread);
    const conn = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
    const verified = await verifySquadsMultisig(conn, address);
    if (!verified.ok) {
      await sendMessage(`❌ ${verified.error}`, replyTo, replyThread);
      return;
    }
    const result = addTracked({ address, label, addedBy: `tg:${ctx.userId}` });
    if (!result.ok) {
      await sendMessage(`❌ ${result.error}`, replyTo, replyThread);
      return;
    }
    addProtocolsToSubscription(ctx.userId, ctx.chatId, [result.entry!.label], ctx.username);
    await sendMessage(
      `✅ <b>Tracking ${result.entry!.label}</b>\n` +
      `Address: <code>${result.entry!.address}</code>\n` +
      `On-chain: ${verified.threshold}/${verified.memberCount} multisig\n` +
      `Listener will pick up new events on the next WebSocket cycle (~60s).\n` +
      `You're auto-subscribed for alerts in this DM.`,
      replyTo, replyThread,
    );
  } else if (cmdLower === '/scan') {
    if (!isAdmin(ctx.userId)) {
      await sendMessage('Manual scans are admin-only because they fire on-demand RPC calls against every tracked protocol. The dashboard at solgov.xyz and /status here both show live state already, refreshed automatically by the always-on listener.', replyTo, replyThread);
      return;
    }
    if (scanning) {
      await sendMessage('Scan already in progress...', replyTo, replyThread);
      return;
    }
    scanning = true;
    await sendMessage('🔍 Starting full scan (config + tier 1 threat detection)...', replyTo, replyThread);
    const result = await runScan('full');
    await sendMessage(`${result}`, replyTo, replyThread);
    scanning = false;
  } else if (cmdLower === '/tier1') {
    if (!isAdmin(ctx.userId)) {
      await sendMessage('Manual scans are admin-only. /status shows live state from the always-on listener.', replyTo, replyThread);
      return;
    }
    if (scanning) {
      await sendMessage('Scan already in progress...', replyTo, replyThread);
      return;
    }
    scanning = true;
    await sendMessage('🔍 Starting tier 1 scan (high risk protocols)...', replyTo, replyThread);
    const result = await runScan('tier1');
    await sendMessage(`${result}`, replyTo, replyThread);
    scanning = false;
  } else if (cmdLower === '/deep') {
    if (!isAdmin(ctx.userId)) {
      await sendMessage('Deep audit is admin-only (RPC-heavy, 2-3 min). /status shows current state.', replyTo, replyThread);
      return;
    }
    if (scanning) {
      await sendMessage('Scan already in progress...', replyTo, replyThread);
      return;
    }
    scanning = true;
    await sendMessage('🔬 Starting deep audit. This checks member permissions, verified builds, and runs full threat detection across all tier 1 signers. May take 2-3 minutes...', replyTo, replyThread);
    const result = await runScan('full');
    await sendMessage(`${result}`, replyTo, replyThread);
    scanning = false;
  } else if (cmdLower.startsWith('/nonce ')) {
    if (!isAdmin(ctx.userId)) {
      await sendMessage('Nonce lookup is admin-only because each call fires several on-demand RPC requests. The CRITICAL/HIGH alert stream surfaces durable-nonce signals automatically as they appear on chain.', replyTo, replyThread);
      return;
    }
    const address = cmd.slice(7).trim();
    if (!address || address.length < 32) {
      await sendMessage('Usage: /nonce &lt;solana address&gt;\nChecks last 14 days for durable nonce activity on a specific address.', replyTo, replyThread);
      return;
    }
    await sendMessage(`🔍 Checking ${address.slice(0, 8)}... for durable nonce activity (14 day window)...`, replyTo, replyThread);
    const result = await checkNonce(address);
    await sendMessage(result, replyTo, replyThread);
  } else if (cmdLower === '/status') {
    await sendMessage(getStatus(), replyTo, replyThread);
  } else if (cmdLower.startsWith('/check ')) {
    const name = cmd.slice(7).trim();
    if (!name) {
      await sendMessage('Usage: /check &lt;protocol name&gt;\nExample: /check drift', replyTo, replyThread);
    } else {
      await sendMessage(checkProtocol(name), replyTo, replyThread);
    }
  } else if (cmdLower.startsWith('/report')) {
    const body = cmd.slice('/report'.length).trim();
    const tokens = body.split(/\s+/).filter(Boolean);
    const windowToken = tokens.find(t => /^(7d|24h)$/i.test(t));
    const window: '24h' | '7d' = windowToken?.toLowerCase() === '7d' ? '7d' : '24h';
    const protocol = tokens.filter(t => t !== windowToken).join(' ').trim();
    if (!protocol) {
      await sendMessage('Usage: /report &lt;protocol&gt; [24h|7d]\nExample: /report Drift 7d', replyTo, replyThread);
      return;
    }
    const rate = checkReportRateLimit(ctx.userId);
    if (!rate.allowed) {
      await sendMessage(
        `⏳ Rate limit: 5 reports per hour. Try again in ~${rate.retryAfterMin} min.`,
        replyTo, replyThread,
      );
      return;
    }
    await sendMessage(`📋 Generating ${window} report for <b>${protocol}</b>...`, replyTo, replyThread);
    const report = await generateReport(protocol, window, ctx.userId);
    const safe = report.length > 4000
      ? report.slice(0, 3950) + '\n\n<i>…[truncated, narrow window or use /check for a summary]</i>'
      : report;
    await sendMessage(safe, replyTo, replyThread);
  }
}

async function runInternalTestSweep(group: string, threadIdForCtx?: number, live = false): Promise<string> {
  const adminCtx = { userId: 999001, chatId: parseInt(TG_CHAT_ID, 10), username: 'bot-test', isPrivate: false, threadId: threadIdForCtx };
  const dmCtx = { userId: 999001, chatId: 999001, username: 'bot-test', isPrivate: true };
  if (live) (dmCtx as any).isPrivate = false, (dmCtx as any).chatId = adminCtx.chatId, (dmCtx as any).threadId = adminCtx.threadId;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  type Flow = { name: string; fn: () => Promise<void> };

  const commandFlows: Flow[] = [
    { name: '/help', fn: () => handleCommand('/help', adminCtx) },
    { name: '/status', fn: () => handleCommand('/status', adminCtx) },
    { name: '/check Drift', fn: () => handleCommand('/check Drift', adminCtx) },
    { name: '/check unknown', fn: () => handleCommand('/check nonexistent-xyz', adminCtx) },
    { name: '/nonce short', fn: () => handleCommand('/nonce abc', adminCtx) },
    { name: '/report no-arg', fn: () => handleCommand('/report', adminCtx) },
  ];
  const callbackFlows: Flow[] = live ? [
    { name: 'cb:status', fn: () => handleCallback('cmd:status', adminCtx) },
    { name: 'cb:help_full', fn: () => handleCallback('cmd:help_full', adminCtx) },
    { name: 'cb:filters_help', fn: () => handleCallback('cmd:filters_help', adminCtx) },
    { name: 'cb:report_prompt', fn: () => handleCallback('cmd:report_prompt', adminCtx) },
  ] : [
    { name: 'cb:status', fn: () => handleCallback('cmd:status', adminCtx) },
    { name: 'cb:help_full', fn: () => handleCallback('cmd:help_full', adminCtx) },
    { name: 'cb:filters_help', fn: () => handleCallback('cmd:filters_help', adminCtx) },
    { name: 'cb:subscribe_prompt', fn: () => handleCallback('cmd:subscribe_prompt', adminCtx) },
    { name: 'cb:report_prompt', fn: () => handleCallback('cmd:report_prompt', adminCtx) },
    { name: 'cb:mysubs', fn: () => handleCallback('cmd:mysubs', dmCtx) },
  ];
  const subFlows: Flow[] = live ? [
    { name: '/subscribe (DM redirect)', fn: () => handleCommand('/subscribe TestProtocol', dmCtx) },
  ] : [
    { name: '/subscribe', fn: () => handleCommand('/subscribe TestProtocol', dmCtx) },
    { name: '/mysubs', fn: () => handleCommand('/mysubs', dmCtx) },
    { name: '/filters', fn: () => handleCommand('/filters severity:CRITICAL', dmCtx) },
    { name: '/unsubscribe', fn: () => handleCommand('/unsubscribe TestProtocol', dmCtx) },
    { name: '/unsuball', fn: () => handleCommand('/unsuball', dmCtx) },
  ];

  const chosen: Flow[] = [];
  if (group === 'all' || group === 'commands') chosen.push(...commandFlows);
  if (group === 'all' || group === 'callbacks') chosen.push(...callbackFlows);
  if (group === 'all' || group === 'subscriptions') chosen.push(...subFlows);

  const results: Array<{ name: string; ok: boolean; count: number; err?: string }> = [];
  for (const f of chosen) {
    let captured = 0;
    if (!live) setDryRunSink(() => { captured++; });
    try {
      await f.fn();
      const ok = live ? true : captured > 0;
      results.push({ name: f.name, ok, count: captured, err: !ok ? 'no response' : undefined });
    } catch (e: any) {
      results.push({ name: f.name, ok: false, count: captured, err: e.message?.slice(0, 80) });
    }
    if (live) await sleep(1100);
  }
  setDryRunSink(null);

  if (live && (group === 'all' || group === 'triage')) {
    const cannedSteps = [
      {
        label: 'Step 2: Authority check (2 tools)',
        body: 'The current upgrade authority of the Drift program is GA5aPX7hFNaxoi8akdbcFVMCrkdfbYC42q7BERPguTNo, a vault PDA controlled by the E44y4Gm multisig. The multisig is 3/5 threshold with no governance timelock. The external configAuthority key A1eC8n2t remains dormant since 2024.',
        verdict: 'routine',
        nextLabel: 'Priors (step 3)',
      },
      {
        label: 'Step 3: Priors (2 tools)',
        body: 'No ProgramUpgrade events on the Drift program in the last 30 days. Last upgrade 2026-04-05. Activity feed shows the recovery multisig migration on 2026-04-02 with no subsequent admin transfers. No durable nonce activity on current signers.',
        verdict: 'routine',
        nextLabel: undefined,
      },
    ];
    for (let i = 0; i < cannedSteps.length; i++) {
      const step = cannedSteps[i];
      const placeholder = await sendMessage('🔎 Scanning deeper...', adminCtx.chatId, adminCtx.threadId);
      await sleep(400);
      const verdictText = `🧠 <b>Auto-triage: Drift</b>\n${step.label}\n\n${step.body}\n\n<b>Verdict:</b> ${step.verdict}`;
      const markup = step.nextLabel
        ? { inline_keyboard: [[{ text: `🔎 ${step.nextLabel}`, callback_data: 'noop' }]] }
        : undefined;
      if (placeholder) {
        await editMessage(placeholder.chatId, placeholder.messageId, verdictText, markup);
      } else {
        await sendMessage(verdictText, adminCtx.chatId, adminCtx.threadId, markup);
      }
      results.push({ name: `triage step ${i + 2}`, ok: true, count: 1 });
      if (i < cannedSteps.length - 1) await sleep(900);
    }
  } else if (group === 'all' || group === 'triage') {
    const { stashTriage } = await import('./llm-triage');
    const id = stashTriage({
      protocol: 'Drift',
      severity: 'CRITICAL',
      type: 'ProgramUpgrade',
      programId: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
      message: '[test] synthetic Drift program upgrade',
      timestamp: new Date().toISOString(),
    });
    for (const step of [1, 2]) {
      let count = 0;
      if (!live) setDryRunSink(() => { count++; });
      try {
        await handleCallback(`triage:${id}:${step}`, adminCtx);
        const ok = live ? true : count > 0;
        results.push({ name: `triage step ${step + 1}`, ok, count, err: !ok ? 'no output (LLM?)' : undefined });
      } catch (e: any) {
        results.push({ name: `triage step ${step + 1}`, ok: false, count, err: e.message?.slice(0, 80) });
      }
      if (live) await sleep(1100);
    }
    setDryRunSink(null);
  }

  if (live) return '';
  const passed = results.filter(r => r.ok).length;
  const icon = (ok: boolean) => ok ? '✓' : '✗';
  const lines = results.map(r => `${icon(r.ok)} ${r.name}${r.err ? ` - <i>${r.err}</i>` : ''}`);
  return `<b>🧪 Test sweep: ${passed}/${results.length} passed</b>\n\n${lines.join('\n')}`;
}

async function main() {
  console.log('SolGov Bot started. Listening for commands...');
  await fetchBotUsername();
  await sendMessage('🟢 <b>SolGov Bot online.</b> Type /help for commands.');

  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        if (update.callback_query) {
          const cb = update.callback_query;
          const msg = cb.message;
          const ctx = {
            userId: cb.from?.id || 0,
            chatId: msg?.chat?.id || 0,
            username: cb.from?.username || cb.from?.first_name,
            isPrivate: msg?.chat?.type === 'private',
            threadId: msg?.message_thread_id,
          };
          console.log(`Callback: ${cb.data} from @${ctx.username || ctx.userId}`);
          await answerCallbackQuery(cb.id);
          await handleCallback(cb.data || '', ctx);
          continue;
        }

        const msg = update.message;
        const text = msg?.text;
        if (!text) continue;

        const ctx = {
          userId: msg.from?.id || 0,
          chatId: msg.chat?.id || 0,
          username: msg.from?.username || msg.from?.first_name,
          isPrivate: msg.chat?.type === 'private',
          threadId: msg.message_thread_id,
        };

        const pending = pendingActions.get(ctx.userId);
        if (pending && !text.startsWith('/')) {
          if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
            pendingActions.delete(ctx.userId);
          } else {
            pendingActions.delete(ctx.userId);
            const actionToCmd: Record<PendingAction, string> = {
              subscribe: '/subscribe',
              report: '/report',
              check: '/check',
              nonce: '/nonce',
              unsubscribe: '/unsubscribe',
            };
            const cmdPrefix = actionToCmd[pending.action];
            if (cmdPrefix) {
              console.log(`Pending ${pending.action} resolved: ${text} from @${ctx.username || ctx.userId}`);
              await handleCommand(`${cmdPrefix} ${text}`, ctx);
            }
            continue;
          }
        }

        if (text.startsWith('/')) {
          console.log(`Command: ${text} from @${ctx.username || ctx.userId} (${ctx.isPrivate ? 'DM' : 'group'})`);
          await handleCommand(text, ctx);
        }
      }
    } catch (e: any) {
      console.error('Poll error:', e.message);
    }
  }
}

if (require.main === module) {
  process.on('unhandledRejection', (reason: any) => {
    const msg = reason?.message || String(reason);
    console.error(`[UNHANDLED-REJECTION] ${String(msg).slice(0, 200)}`);
  });
  process.on('uncaughtException', (err: any) => {
    const msg = err?.message || String(err);
    console.error(`[UNCAUGHT-EXCEPTION] ${String(msg).slice(0, 200)}`);
  });
  main();
}
