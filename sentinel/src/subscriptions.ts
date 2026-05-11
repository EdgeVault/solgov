// Per-user subscription state shared between solgov-bot and solgov-listener.

import * as fs from 'fs';
import * as path from 'path';

export type Severity = 'CRITICAL' | 'HIGH' | 'MONITOR';
export type EventType = 'ConfigChange' | 'AuthorityChange' | 'ProgramUpgrade' | 'NONCE' | 'VaultTx' | '*';

export interface Subscription {
  username?: string;
  chatId: number;          // private DM chat id (same as user id for 1:1 chats)
  protocols: string[];     // matched case-insensitively against protocol names
  severities: Severity[];  // if empty, matches all
  types: EventType[];      // if empty or contains '*', matches all
  createdAt: string;
  lastNotifiedAt?: string;
}

const SUBSCRIPTIONS_PATH = path.join(__dirname, '..', 'data', 'bot-subscriptions.json');

export function loadSubscriptions(): Record<string, Subscription> {
  try {
    if (!fs.existsSync(SUBSCRIPTIONS_PATH)) return {};
    const raw = fs.readFileSync(SUBSCRIPTIONS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveSubscriptions(subs: Record<string, Subscription>): void {
  fs.mkdirSync(path.dirname(SUBSCRIPTIONS_PATH), { recursive: true });
  fs.writeFileSync(SUBSCRIPTIONS_PATH, JSON.stringify(subs, null, 2));
}

export function getSubscription(userId: number | string): Subscription | null {
  const subs = loadSubscriptions();
  return subs[String(userId)] || null;
}

export function upsertSubscription(
  userId: number | string,
  update: Partial<Subscription> & { chatId: number }
): Subscription {
  const subs = loadSubscriptions();
  const key = String(userId);
  const existing = subs[key];
  const next: Subscription = {
    username: update.username ?? existing?.username,
    chatId: update.chatId,
    protocols: update.protocols ?? existing?.protocols ?? [],
    severities: update.severities ?? existing?.severities ?? [],
    types: update.types ?? existing?.types ?? ['*'],
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastNotifiedAt: existing?.lastNotifiedAt,
  };
  subs[key] = next;
  saveSubscriptions(subs);
  return next;
}

export function deleteSubscription(userId: number | string): boolean {
  const subs = loadSubscriptions();
  const key = String(userId);
  if (!subs[key]) return false;
  delete subs[key];
  saveSubscriptions(subs);
  return true;
}

export function addProtocolsToSubscription(
  userId: number | string,
  chatId: number,
  protocols: string[],
  username?: string
): Subscription {
  const existing = getSubscription(userId);
  const current = existing?.protocols ?? [];
  const merged = Array.from(new Set([...current, ...protocols]));
  return upsertSubscription(userId, { chatId, protocols: merged, username });
}

export function removeProtocolFromSubscription(
  userId: number | string,
  protocol: string
): { found: boolean; remaining: string[] } {
  const existing = getSubscription(userId);
  if (!existing) return { found: false, remaining: [] };
  const target = protocol.toLowerCase();
  const remaining = existing.protocols.filter(p => p.toLowerCase() !== target);
  if (remaining.length === existing.protocols.length) {
    return { found: false, remaining: existing.protocols };
  }
  upsertSubscription(userId, { chatId: existing.chatId, protocols: remaining });
  return { found: true, remaining };
}

/**
 * Return every subscription that should receive an alert for a given event.
 * Matches by protocol name (case-insensitive substring), severity, and type.
 * Case-insensitive on protocol so "drift" matches "Drift".
 */
export function matchSubscribersForAlert(event: {
  protocol: string;
  severity: Severity;
  type?: EventType;
}): Array<{ userId: string; subscription: Subscription }> {
  const subs = loadSubscriptions();
  const matches: Array<{ userId: string; subscription: Subscription }> = [];
  const targetProto = event.protocol.toLowerCase();
  for (const [userId, sub] of Object.entries(subs)) {
    // Protocol match: any subscribed protocol name is a substring of the event
    // protocol (or vice versa) to allow fuzzy matches like "Drift" → "Drift (Protocol V2)".
    const protoMatch = sub.protocols.some(p => {
      const q = p.toLowerCase();
      return targetProto.includes(q) || q.includes(targetProto);
    });
    if (!protoMatch) continue;
    // Severity match: empty array = accept all
    if (sub.severities.length > 0 && !sub.severities.includes(event.severity)) continue;
    // Type match: empty or contains '*' = accept all
    if (sub.types.length > 0 && !sub.types.includes('*') && event.type && !sub.types.includes(event.type)) continue;
    matches.push({ userId, subscription: sub });
  }
  return matches;
}

export function touchNotified(userId: number | string): void {
  const subs = loadSubscriptions();
  const key = String(userId);
  if (!subs[key]) return;
  subs[key].lastNotifiedAt = new Date().toISOString();
  saveSubscriptions(subs);
}
