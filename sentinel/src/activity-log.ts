// Append-only log of governance events powering the public activity feed.

import * as fs from 'fs';
import { writeJsonAtomic } from './utils/json-file';
import * as path from 'path';

const LOG_FILE = path.join(__dirname, '..', 'data', 'activity-log.jsonl');
const STATE_FILE = path.join(__dirname, '..', 'data', 'monitor-state.json');
// Enough history for the changelog and cadence endpoints; /api/state serves only the latest 500.
const MAX_ENTRIES = 5000;

export interface ActivityEvent {
  date: string;
  timestamp: string;
  protocol: string;
  type: string;
  detail: string;
  multisig?: string;
}

let migrated = false;
function migrateOnce(): void {
  if (migrated) return;
  migrated = true;
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const old: ActivityEvent[] = Array.isArray(state._activityLog) ? state._activityLog : [];
    if (old.length > 0 && !fs.existsSync(LOG_FILE)) {
      const lines = old.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(LOG_FILE, lines);
    }
    if ('_activityLog' in state) {
      delete state._activityLog;
      writeJsonAtomic(STATE_FILE, state);
    }
  } catch {}
}

export function appendActivity(protocol: string, type: string, detail: string, multisig?: string, timestamp?: string): void {
  migrateOnce();
  const ts = timestamp || new Date().toISOString();
  const event: ActivityEvent = {
    date: ts.split('T')[0],
    timestamp: ts,
    protocol,
    type,
    detail,
    ...(multisig ? { multisig } : {}),
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n');
  } catch (e: any) {
    console.error('[ACTIVITY_LOG] append failed:', e?.message || e);
  }
}

export function readActivityLog(): ActivityEvent[] {
  migrateOnce();
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const events: ActivityEvent[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    if (events.length > MAX_ENTRIES * 1.2) {
      const trimmed = events.slice(-MAX_ENTRIES);
      try {
        // Write to a temp file and rename so a concurrent reader never sees a truncated log.
        const tmp = `${LOG_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
        fs.renameSync(tmp, LOG_FILE);
      } catch (e: any) {
        console.error('[ACTIVITY_LOG] trim failed:', e?.message || e);
      }
      return trimmed;
    }
    return events;
  } catch {
    return [];
  }
}
