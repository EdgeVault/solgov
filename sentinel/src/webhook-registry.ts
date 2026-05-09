/**
 * Push delivery registry for partners integrating with the SolGov public API.
 *
 * Partners POST /api/webhooks with a target URL and optional filters; we
 * persist a record + return them an opaque id and secret. The listener then
 * fans out CRITICAL/HIGH events to every matching subscriber over HTTPS,
 * signed with HMAC-SHA256 using the per-subscriber secret.
 *
 * Stored at sentinel/data/webhook-subscribers.json. Plain-text JSON is fine
 * for now - the registry is small and the secrets are partner-scoped, not
 * blast-radius secrets.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { nameMatches } from './llm-tools';

const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'webhook-subscribers.json');

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

export function loadRegistry(): Registry {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const r = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      if (Array.isArray(r?.subscribers)) return r;
    }
  } catch {}
  return { subscribers: [] };
}

function saveRegistry(r: Registry): void {
  try {
    const dir = path.dirname(REGISTRY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2));
  } catch (e: any) {
    console.error('[WEBHOOK-REGISTRY] save failed:', e?.message);
  }
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
  const sub: WebhookSubscription = {
    id: 'whk_' + crypto.randomBytes(8).toString('hex'),
    url: input.url,
    secret: crypto.randomBytes(24).toString('hex'),
    protocols: input.protocols && input.protocols.length > 0 ? input.protocols : null,
    severities: input.severities && input.severities.length > 0 ? input.severities : null,
    types: input.types && input.types.length > 0 ? input.types : null,
    createdAt: new Date().toISOString(),
  };
  const reg = loadRegistry();
  reg.subscribers.push(sub);
  saveRegistry(reg);
  return sub;
}

export function getSubscription(id: string, secret: string): WebhookSubscription | null {
  const reg = loadRegistry();
  const s = reg.subscribers.find(x => x.id === id);
  if (!s) return null;
  // Constant-time compare so a probing attacker can't infer secret length
  if (s.secret.length !== secret.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s.secret), Buffer.from(secret))) return null;
  return s;
}

export function deleteSubscription(id: string, secret: string): boolean {
  const reg = loadRegistry();
  const idx = reg.subscribers.findIndex(x => x.id === id);
  if (idx < 0) return false;
  const stored = reg.subscribers[idx].secret;
  if (stored.length !== secret.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(secret))) return false;
  reg.subscribers.splice(idx, 1);
  saveRegistry(reg);
  return true;
}

function eventMatchesSubscription(
  event: { protocol: string; severity: Severity; type?: string },
  sub: WebhookSubscription,
): boolean {
  if (sub.severities && !sub.severities.includes(event.severity)) return false;
  if (sub.types && event.type && !sub.types.includes(event.type)) return false;
  if (sub.protocols) {
    const hit = sub.protocols.some(p => nameMatches(event.protocol, p));
    if (!hit) return false;
  }
  return true;
}

/**
 * Fan out an event to every matching subscriber. Each delivery is fire-and-forget
 * with a 5-second timeout; a failed POST increments failureCount but never
 * blocks the listener loop. Body is signed with HMAC-SHA256(secret, body) so
 * the partner can verify origin.
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
      detail: event.message,
      timestamp: event.timestamp,
      programId: event.programId ?? null,
      authority: event.authority ?? null,
    },
    source: 'https://solgov.xyz',
  });

  const updated = loadRegistry();
  await Promise.all(matches.map(async sub => {
    const sig = crypto.createHmac('sha256', sub.secret).update(payload).digest('hex');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SolGov-Signature': `sha256=${sig}`,
          'X-SolGov-Subscription': sub.id,
        },
        body: payload,
        signal: ctrl.signal,
      });
      const target = updated.subscribers.find(x => x.id === sub.id);
      if (!target) return;
      target.lastDeliveryAt = new Date().toISOString();
      if (!resp.ok) {
        target.failureCount = (target.failureCount ?? 0) + 1;
        console.error(`[WEBHOOK] ${sub.id} -> ${resp.status} (failures: ${target.failureCount})`);
      } else {
        target.failureCount = 0;
      }
    } catch (e: any) {
      const target = updated.subscribers.find(x => x.id === sub.id);
      if (target) {
        target.failureCount = (target.failureCount ?? 0) + 1;
        console.error(`[WEBHOOK] ${sub.id} delivery error: ${e.message?.slice(0, 80)} (failures: ${target.failureCount})`);
      }
    } finally {
      clearTimeout(t);
    }
  }));
  saveRegistry(updated);
}

export function publicView(sub: WebhookSubscription): Omit<WebhookSubscription, 'secret'> {
  const { secret: _omit, ...rest } = sub;
  return rest;
}
