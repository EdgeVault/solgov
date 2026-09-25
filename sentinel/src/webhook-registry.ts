// Push delivery registry for partner webhook subscribers.
//
// The API process creates and deletes subscriptions; the listener process delivers events and records
// delivery counters. Both write the same file, so every write re-reads it first and changes only what
// that caller owns (a delivery never re-adds a deleted subscription or drops a new one), and every write
// is atomic.

import * as crypto from 'crypto';
import * as path from 'path';
import { nameMatches } from './llm-tools';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';
import { assertPublicDestination } from './utils/net-guard';

const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'webhook-subscribers.json');

// Caps so the registry cannot be used to aim alert deliveries at one target in bulk.
export const MAX_SUBSCRIPTIONS = 500;
export const MAX_PER_HOST = 5;
// Deliveries stop after this many consecutive failures; the partner can re-subscribe.
const MAX_CONSECUTIVE_FAILURES = 200;

export type Severity = 'CRITICAL' | 'HIGH' | 'MONITOR';

export interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  protocols: string[] | null;     // null = all
  severities: Severity[] | null;  // null = all
  types: string[] | null;         // null = all
  createdAt: string;
  lastDeliveryAt?: string;
  failureCount?: number;
}

interface Registry { subscribers: WebhookSubscription[] }

function readStrict(): Registry {
  const r = readJsonStrict<Registry>(REGISTRY_FILE, { subscribers: [] });
  return Array.isArray(r?.subscribers) ? r : { subscribers: [] };
}

export function loadRegistry(): Registry {
  try { return readStrict(); } catch (e: any) {
    console.error('[WEBHOOK-REGISTRY] read failed:', e?.message);
    return { subscribers: [] };
  }
}

function saveRegistry(r: Registry): void {
  writeJsonAtomic(REGISTRY_FILE, r);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return url; }
}

// Secrets are hex; compare as bytes of equal length so malformed input cannot throw.
function secretsEqual(stored: string, given: string): boolean {
  const a = Buffer.from(String(stored), 'utf-8');
  const b = Buffer.from(String(given), 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createSubscription(input: {
  url: string;
  protocols?: string[];
  severities?: Severity[];
  types?: string[];
}): WebhookSubscription {
  // Defensive validation. The route handler also validates but a defaulted
  // record means downstream delivery code never has to handle malformed input.
  if (!/^https?:\/\//.test(input.url)) throw new Error('url must be http(s)');
  const reg = readStrict();
  if (reg.subscribers.length >= MAX_SUBSCRIPTIONS) throw new Error('subscription limit reached');
  const host = hostOf(input.url);
  if (reg.subscribers.filter(s => hostOf(s.url) === host).length >= MAX_PER_HOST) {
    throw new Error(`at most ${MAX_PER_HOST} subscriptions per destination host`);
  }
  const clean = (xs?: string[]) => (xs && xs.length > 0 ? xs.slice(0, 100).map(x => String(x).slice(0, 80)) : null);
  const sub: WebhookSubscription = {
    id: 'whk_' + crypto.randomBytes(8).toString('hex'),
    url: input.url,
    secret: crypto.randomBytes(24).toString('hex'),
    protocols: clean(input.protocols),
    severities: input.severities && input.severities.length > 0 ? input.severities : null,
    types: clean(input.types),
    createdAt: new Date().toISOString(),
  };
  reg.subscribers.push(sub);
  saveRegistry(reg);
  return sub;
}

export function getSubscription(id: string, secret: string): WebhookSubscription | null {
  const s = loadRegistry().subscribers.find(x => x.id === id);
  if (!s || !secretsEqual(s.secret, secret)) return null;
  return s;
}

export function deleteSubscription(id: string, secret: string): boolean {
  const reg = readStrict();
  const idx = reg.subscribers.findIndex(x => x.id === id);
  if (idx < 0) return false;
  if (!secretsEqual(reg.subscribers[idx].secret, secret)) return false;
  reg.subscribers.splice(idx, 1);
  saveRegistry(reg);
  return true;
}

function eventMatchesSubscription(
  event: { protocol: string; severity: Severity; type?: string },
  sub: WebhookSubscription,
): boolean {
  if ((sub.failureCount ?? 0) >= MAX_CONSECUTIVE_FAILURES) return false;
  if (sub.severities && !sub.severities.includes(event.severity)) return false;
  if (sub.types && event.type && !sub.types.includes(event.type)) return false;
  if (sub.protocols) {
    const hit = sub.protocols.some(p => nameMatches(event.protocol, p));
    if (!hit) return false;
  }
  return true;
}

// Alert messages are Telegram HTML; partners receive plain text.
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * Fan out an event to every matching subscriber. Each delivery has a 5-second
 * timeout, does not follow redirects, and is refused if the destination now
 * resolves to a private address. Body is signed with HMAC-SHA256(secret, body)
 * so the partner can verify origin.
 */
export async function fanoutEvent(event: {
  protocol: string;
  severity: Severity;
  type: string;
  message: string;
  timestamp: string;
  programId?: string;
  authority?: string;
}): Promise<void> {
  const reg = loadRegistry();
  if (reg.subscribers.length === 0) return;
  const matches = reg.subscribers.filter(s => eventMatchesSubscription(event, s));
  if (matches.length === 0) return;

  const payload = JSON.stringify({
    asOf: new Date().toISOString(),
    event: {
      protocol: event.protocol,
      severity: event.severity,
      type: event.type,
      detail: toPlainText(event.message),
      timestamp: event.timestamp,
      programId: event.programId ?? null,
      authority: event.authority ?? null,
    },
    source: 'https://solgov.xyz',
  });

  const results = new Map<string, boolean>();
  await Promise.all(matches.map(async sub => {
    const sig = crypto.createHmac('sha256', sub.secret).update(payload).digest('hex');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      await assertPublicDestination(sub.url);
      const resp = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SolGov-Signature': `sha256=${sig}`,
          'X-SolGov-Subscription': sub.id,
        },
        body: payload,
        signal: ctrl.signal,
        redirect: 'manual',
      });
      results.set(sub.id, resp.ok);
      if (!resp.ok) console.error(`[WEBHOOK] ${sub.id} -> ${resp.status}`);
    } catch (e: any) {
      results.set(sub.id, false);
      console.error(`[WEBHOOK] ${sub.id} delivery error: ${e.message?.slice(0, 80)}`);
    } finally {
      clearTimeout(t);
    }
  }));

  // Re-read after delivery and update counters only on subscriptions that still exist.
  try {
    const latest = readStrict();
    const now = new Date().toISOString();
    for (const s of latest.subscribers) {
      if (!results.has(s.id)) continue;
      s.lastDeliveryAt = now;
      s.failureCount = results.get(s.id) ? 0 : (s.failureCount ?? 0) + 1;
    }
    saveRegistry(latest);
  } catch (e: any) {
    console.error('[WEBHOOK-REGISTRY] counter update skipped:', e?.message);
  }
}

export function publicView(sub: WebhookSubscription): Omit<WebhookSubscription, 'secret'> {
  const { secret: _omit, ...rest } = sub;
  return rest;
}
