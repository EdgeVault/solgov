// Poll Yieldbay's incident feed and fan critical/warning events into the bot subscription system.

import * as fs from 'fs';
import * as path from 'path';

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
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
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

// Track which Yieldbay event ids have already been pushed through Telegram so
// rolling polls don't re-alert on the same incident every 5 minutes. Capped
// to the most recent 1000 ids to bound memory.
const seenAlertIds: Set<string> = new Set();
const seenAlertOrder: string[] = [];

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
    const solgovNames = YIELDBAY_TO_SOLGOV[e.protocol] || [];
    if (solgovNames.length === 0) continue;
    // Yieldbay 'critical' → SolGov 'CRITICAL'; 'warning' → 'HIGH'
    const severity = e.severity === 'critical' ? 'CRITICAL' : 'HIGH';
    const delta = e.values?.worst_delta_pct || e.values?.delta_pct || '';
    const summary = e.display?.summary || `${e.entity?.name || 'event'}: ${delta}`;
    const ybUrl = e.links?.app || 'https://app.yieldbay.fi/health';
    const message =
      `<b>${e.severity === 'critical' ? '🚨' : '⚠️'} Yieldbay: ${e.protocol_name}</b>\n` +
      `${summary}\n` +
      `<a href="${ybUrl}">View on Yieldbay</a>`;

    for (const protocolName of solgovNames) {
      try {
        const matches = matchSubscribersForAlert({
          protocol: protocolName,
          severity,
          type: 'YieldbayEvent' as any,
        });
        for (const { userId, subscription } of (matches || [])) {
          try {
            await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: subscription.chatId,
                text: `🔔 <b>Your subscription: ${protocolName}</b>\n\n${message}`,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
              }),
            });
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
    if (seenAlertIds.size === 0) {
      for (const e of events) markSeen(e.id);
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
