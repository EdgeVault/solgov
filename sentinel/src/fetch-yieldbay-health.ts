// Poll Yieldbay's incident feed and fan critical/warning events into the bot subscription system.

import * as fs from 'fs';
import * as path from 'path';
import { escapeHtml } from './utils/telegram-html';
import { writeJsonAtomic } from './utils/json-file';

const YIELDBAY_BASE = 'https://api.yieldbay.fi';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min - matches their refresh cadence
const CACHE_FILE = path.join(__dirname, '..', 'data', 'yieldbay-cache.json');

// ---------- Types ----------

export interface YieldbayEvent {
  id: string;
  type: string;
  alert_type: string;
  protocol: string;
  protocol_name: string;
  entity: { name: string; address: string; type: string };
  severity: 'critical' | 'warning' | 'info';
  status: 'open' | 'detected' | 'recovered' | 'normalized';
  field: { name: string; label: string };
  display?: any;
  values?: any;
  raw_values?: any;
  started_at: string;
  updated_at: string;
  resolved_at: string | null;
  sticky_until?: string;
  links?: { app?: string; explorer?: string };
}

interface CachePayload {
  fetchedAt: string;
  events: YieldbayEvent[];
  summary: any | null;
  lastError?: string;
}

let cache: CachePayload = { fetchedAt: '', events: [], summary: null };

function loadCacheFromDisk(): void {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.fetchedAt) cache = parsed;
    }
  } catch (e: any) {
    console.warn('[YIELDBAY] cache load failed:', e?.message);
  }
}

function saveCacheToDisk(): void {
  try {
    writeJsonAtomic(CACHE_FILE, cache);
  } catch (e: any) {
    console.error('[YIELDBAY] cache save failed:', e?.message);
  }
}

// ---------- Fetch primitives ----------

async function yieldbayGet(path: string): Promise<any> {
  const apiKey = process.env.YIELDBAY_API_KEY || '';
  if (!apiKey) throw new Error('YIELDBAY_API_KEY not set');
  const resp = await fetch(`${YIELDBAY_BASE}${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 200);
    throw new Error(`Yieldbay ${resp.status} ${path}: ${text}`);
  }
  return await resp.json();
}

/**
 * Fetch the full curated incident-tier event feed (their /v1/health/events
 * with severity=critical,warning and source_kind=incident filter, ordered by
 * severity). Pages through cursor until exhausted or hard cap is reached.
 */
async function fetchAllCriticalWarning(): Promise<YieldbayEvent[]> {
  const events: YieldbayEvent[] = [];
  let cursor: string | null = null;
  const HARD_CAP_PAGES = 10; // 100 events per page * 10 = 1000 max
  for (let page = 0; page < HARD_CAP_PAGES; page++) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const data: any = await yieldbayGet(
      `/v1/health/events?limit=100&severity=critical,warning&sort=severity${cursorParam}`,
    );
    const batch: YieldbayEvent[] = Array.isArray(data?.data) ? data.data : [];
    events.push(...batch);
    cursor = data?.meta?.next_cursor || null;
    if (!cursor || batch.length === 0) break;
  }
  return events;
}

async function fetchSummary(): Promise<any> {
  const data = await yieldbayGet('/v1/health/summary');
  return data?.data ?? data;
}

// ---------- Public surface ----------

// Map Yieldbay protocol identifier → SolGov canonical protocol name(s).
// Mirrored from the dashboard hook so the listener fanout uses the same
// vocabulary as the per-user subscription matcher.
const YIELDBAY_TO_SOLGOV: Record<string, string[]> = {
  'kamino': ['Kamino'],
  'meteora_dv': ['Meteora'],
  'meteora_amm_tx': ['Meteora'],
  'jupiter_borrow': ['Jupiter Lend'],
  'jupiter_earn': ['Jupiter Lend'],
  'perena': ['Perena'],
  'spl_stake_pools': ['Jito', 'Marinade', 'BlazeStake'],
};

// Yieldbay's spl_stake_pools feed covers many pools. An incident is attributed to a specific
// pool's protocol only when the event names that pool; otherwise it goes to subscribers of the
// generic SPL Stake Pool entry rather than to every stake-pool protocol.
const STAKE_POOL_BY_NAME: Array<{ re: RegExp; protocol: string }> = [
  { re: /\bjito(sol)?\b/i, protocol: 'Jito' },
  { re: /\b(marinade|msol)\b/i, protocol: 'Marinade' },
  { re: /\b(blaze(stake)?|bsol)\b/i, protocol: 'BlazeStake' },
];
const GENERIC_STAKE_POOL = 'SPL Stake Pool';

function solgovNamesFor(e: YieldbayEvent): string[] {
  if (e.protocol !== 'spl_stake_pools') return YIELDBAY_TO_SOLGOV[e.protocol] || [];
  const label = `${e.entity?.name || ''} ${e.protocol_name || ''}`;
  const hit = STAKE_POOL_BY_NAME.find(p => p.re.test(label));
  return [hit ? hit.protocol : GENERIC_STAKE_POOL];
}

const YIELDBAY_FALLBACK_URL = 'https://app.yieldbay.fi/health';

// Only http(s) links go into an <a href>; anything else falls back to the Yieldbay health page.
function safeHttpUrl(raw: unknown): string {
  try {
    const u = new URL(String(raw ?? ''));
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
  } catch { /* not a URL */ }
  return YIELDBAY_FALLBACK_URL;
}

// Track which Yieldbay event ids have already been pushed through Telegram so
// rolling polls don't re-alert on the same incident every 5 minutes. Capped
// to the most recent 1000 ids to bound memory.
const seenAlertIds: Set<string> = new Set();
const seenAlertOrder: string[] = [];
// Set after the first successful poll has seeded seenAlertIds. Keying the seed on an empty set
// instead would re-seed every poll after a quiet start and drop the first real event unsent.
let seededFromFirstPoll = false;

function markSeen(id: string): void {
  if (seenAlertIds.has(id)) return;
  seenAlertIds.add(id);
  seenAlertOrder.push(id);
  while (seenAlertOrder.length > 1000) {
    const drop = seenAlertOrder.shift()!;
    seenAlertIds.delete(drop);
  }
}

/**
 * Fan a new critical/warning Yieldbay event into the existing per-user
 * Telegram subscription system, once per event id. We map Yieldbay's
 * protocol identifier onto the SolGov protocol name(s) so existing subs
 * (e.g. "Kamino" subscribers) receive the operational signal alongside
 * governance events. Events are tagged severity HIGH so subscribers who
 * filter to CRITICAL only don't get warning-tier Yieldbay noise.
 */
async function fanoutNewYieldbayEvents(events: YieldbayEvent[]): Promise<void> {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TG_TOKEN) return;
  let subscriptionsModule: any = null;
  try { subscriptionsModule = require('./subscriptions'); } catch { return; }
  const matchSubscribersForAlert = subscriptionsModule?.matchSubscribersForAlert;
  const touchNotified = subscriptionsModule?.touchNotified;
  if (!matchSubscribersForAlert) return;

  for (const e of events) {
    if (e.status !== 'open' && e.status !== 'detected') continue;
    if (seenAlertIds.has(e.id)) continue;
    markSeen(e.id);
    const solgovNames = solgovNamesFor(e);
    if (solgovNames.length === 0) continue;
    // Yieldbay 'critical' → SolGov 'CRITICAL'; 'warning' → 'HIGH'
    const severity = e.severity === 'critical' ? 'CRITICAL' : 'HIGH';
    const delta = e.values?.worst_delta_pct || e.values?.delta_pct || '';
    const summary = e.display?.summary || `${e.entity?.name || 'event'}: ${delta}`;
    const ybUrl = safeHttpUrl(e.links?.app);
    // Every field below comes from Yieldbay's API, so it is escaped for parse_mode HTML.
    const message =
      `<b>${e.severity === 'critical' ? '🚨' : '⚠️'} Yieldbay: ${escapeHtml(e.protocol_name)}</b>\n` +
      `${escapeHtml(summary)}\n` +
      `<a href="${escapeHtml(ybUrl)}">View on Yieldbay</a>`;

    for (const protocolName of solgovNames) {
      try {
        const matches = matchSubscribersForAlert({
          protocol: protocolName,
          severity,
          type: 'YieldbayEvent' as any,
        });
        for (const { userId, subscription } of (matches || [])) {
          try {
            const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: subscription.chatId,
                text: `🔔 <b>Your subscription: ${escapeHtml(protocolName)}</b>\n\n${message}`,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
              }),
            });
            if (!resp.ok) {
              const body = await resp.text().catch(() => '');
              console.error(`[YIELDBAY-FANOUT] DM to ${userId} rejected: ${resp.status} ${body.slice(0, 120)}`);
              continue;
            }
            if (touchNotified) touchNotified(userId);
          } catch (err: any) {
            console.error(`[YIELDBAY-FANOUT] DM to ${userId} failed:`, err.message?.slice(0, 80));
          }
        }
      } catch (err: any) {
        console.error('[YIELDBAY-FANOUT] match error:', err.message?.slice(0, 80));
      }
    }
  }
}

/** One full poll cycle. Updates the in-memory + disk cache. */
export async function pollYieldbayOnce(): Promise<{ ok: boolean; error?: string; eventCount?: number }> {
  try {
    const [events, summary] = await Promise.all([
      fetchAllCriticalWarning(),
      fetchSummary().catch((e) => { console.warn('[YIELDBAY] summary fetch failed:', e.message?.slice(0, 80)); return null; }),
    ]);
    cache = {
      fetchedAt: new Date().toISOString(),
      events,
      summary,
    };
    saveCacheToDisk();
    // Fire-and-forget Telegram fanout - never blocks cache update on
    // delivery hiccups. First-ever poll seeds seenAlertIds with current
    // events so subscribers don't get flooded with backfill on cold start.
    if (!seededFromFirstPoll) {
      for (const e of events) markSeen(e.id);
      seededFromFirstPoll = true;
      console.log(`[YIELDBAY] seeded ${events.length} existing events; future deliveries will only fire on new events`);
    } else {
      void fanoutNewYieldbayEvents(events);
    }
    return { ok: true, eventCount: events.length };
  } catch (e: any) {
    cache.lastError = e.message?.slice(0, 200);
    saveCacheToDisk();
    return { ok: false, error: e.message };
  }
}

/**
 * Run a poll loop forever. Call once at API startup. Returns nothing - fire
 * and forget. Errors are logged but never thrown so transient Yieldbay
 * outages don't crash the API process.
 */
export function startYieldbayPoller(): void {
  loadCacheFromDisk();
  if (!process.env.YIELDBAY_API_KEY) {
    console.log('[YIELDBAY] YIELDBAY_API_KEY not set; poller disabled, /api/v1/yieldbay/* will return last-known cache or empty');
    return;
  }
  // Kick first poll immediately, then every POLL_INTERVAL_MS.
  void pollYieldbayOnce().then(r => {
    if (r.ok) console.log(`[YIELDBAY] initial poll: ${r.eventCount} critical+warning events`);
    else console.warn('[YIELDBAY] initial poll failed:', r.error?.slice(0, 100));
  });
  setInterval(() => {
    void pollYieldbayOnce().then(r => {
      if (!r.ok) console.warn('[YIELDBAY] poll failed:', r.error?.slice(0, 100));
    });
  }, POLL_INTERVAL_MS).unref();
}

export function getCachedIncidents(): { fetchedAt: string; events: YieldbayEvent[]; lastError?: string } {
  return { fetchedAt: cache.fetchedAt, events: cache.events, lastError: cache.lastError };
}

export function getCachedSummary(): { fetchedAt: string; summary: any | null; lastError?: string } {
  return { fetchedAt: cache.fetchedAt, summary: cache.summary, lastError: cache.lastError };
}
