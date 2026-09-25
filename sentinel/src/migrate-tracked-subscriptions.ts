// One-off migration: user-tracked multisigs were once stored and subscribed under their bare label
// ("My Vault"). Alerts now carry the namespaced name ("Tracked: My Vault (Abcd...wxyz)") and only reach
// exact subscriptions of that name, so each bare subscription a user made through /track is re-pointed
// at the namespaced name. A bare name that also matches a curated protocol is kept, so the user keeps
// the curated alerts they were already receiving.
//
// Before namespacing, the listener also wrote each user-tracked multisig into monitor-state under its
// bare label, so the public /api/state served it as if it were a protocol. Those entries are removed.
// An entry is only treated as a leftover when its name equals a bare tracked label and is not a curated
// multisig name (data/protocols/tracked-multisigs.json), so a label such as "Kamino" can never remove
// the real Kamino entry. Without the curated list nothing is removed.
//
// Dry run by default. Pass --apply to write.
//   node -r ts-node/register/transpile-only src/migrate-tracked-subscriptions.ts [--apply]

import * as path from 'path';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';
import { trackedName, isTrackedName } from './user-tracked-multisigs';
import { canonicalLower } from './utils/display-names';
import type { Subscription } from './subscriptions';

const DATA = path.join(__dirname, '..', 'data');
const SUBS_FILE = path.join(DATA, 'bot-subscriptions.json');
const REGISTRY_FILE = path.join(DATA, 'user-tracked-multisigs.json');
const STATE_FILE = path.join(DATA, 'monitor-state.json');
const CURATED_FILE = path.join(DATA, 'protocols', 'tracked-multisigs.json');

interface RawEntry { address: string; label: string; addedAt: string; addedBy?: string }

// State keys written for user-tracked multisigs before namespacing.
export function leftoverStateKeys(stateKeys: string[], entries: RawEntry[], curatedNames: string[] | null): string[] {
  if (!curatedNames) return [];
  const curated = new Set(curatedNames.map(n => n.toLowerCase()));
  const labels = new Set(entries.filter(e => !isTrackedName(e.label)).map(e => e.label.toLowerCase()));
  return stateKeys.filter(k => labels.has(k.toLowerCase()) && !curated.has(k.toLowerCase()));
}

function matchesCurated(name: string, curated: string[]): boolean {
  const q = canonicalLower(name);
  return curated.some(k => k.includes(q) || q.includes(k));
}

export function migrate(
  subs: Record<string, Subscription>,
  entries: RawEntry[],
  curatedKeys: string[],
): { subs: Record<string, Subscription>; changes: string[] } {
  const curated = curatedKeys.filter(k => !k.startsWith('_') && !isTrackedName(k)).map(canonicalLower);
  const changes: string[] = [];
  const out: Record<string, Subscription> = {};
  for (const [userId, sub] of Object.entries(subs)) {
    const mine = entries.filter(e => e.addedBy === `tg:${userId}`);
    const next = new Set<string>();
    for (const p of sub.protocols) {
      if (isTrackedName(p)) { next.add(p); continue; }
      const hits = mine.filter(e => !isTrackedName(e.label) && e.label.toLowerCase() === p.toLowerCase());
      if (hits.length === 0) { next.add(p); continue; }
      for (const e of hits) next.add(trackedName(e.address, e.label));
      const keep = matchesCurated(p, curated);
      if (keep) next.add(p);
      changes.push(`user ${userId}: "${p}" -> ${hits.map(e => `"${trackedName(e.address, e.label)}"`).join(', ')}${keep ? ' (bare name kept: it matches a curated protocol)' : ''}`);
    }
    out[userId] = { ...sub, protocols: Array.from(next) };
  }
  return { subs: out, changes };
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const subs = readJsonStrict<Record<string, Subscription>>(SUBS_FILE, {});
  const reg = readJsonStrict<{ multisigs: RawEntry[] }>(REGISTRY_FILE, { multisigs: [] });
  const entries = Array.isArray(reg?.multisigs) ? reg.multisigs : [];
  const state = readJsonStrict<Record<string, unknown>>(STATE_FILE, {});
  let curatedNames: string[] | null = null;
  try { curatedNames = Object.keys(readJsonStrict<Record<string, string>>(CURATED_FILE, {})); } catch {}
  if (curatedNames && curatedNames.length === 0) curatedNames = null;

  const leftovers = leftoverStateKeys(Object.keys(state), entries, curatedNames);
  const curatedKeys = Object.keys(state).filter(k => !leftovers.includes(k));
  const { subs: next, changes } = migrate(subs, entries, curatedKeys);
  const relabel = entries.filter(e => !isTrackedName(e.label));

  console.log(`${Object.keys(subs).length} subscriptions, ${entries.length} tracked multisigs (${relabel.length} with a bare label)`);
  for (const c of changes) console.log('  ' + c);
  if (changes.length === 0) console.log('  no subscriptions need migrating');
  if (!curatedNames) console.log(`  ${CURATED_FILE} not found: no monitor-state entries will be removed`);
  for (const k of leftovers) console.log(`  monitor-state entry "${k}" is a user-tracked multisig written before namespacing: will be removed`);

  if (!apply) { console.log('\nDry run. Re-run with --apply to write.'); return; }
  if (changes.length > 0) writeJsonAtomic(SUBS_FILE, next);
  if (relabel.length > 0) {
    writeJsonAtomic(REGISTRY_FILE, { multisigs: entries.map(e => ({ ...e, label: trackedName(e.address, e.label) })) });
  }
  if (leftovers.length > 0) {
    // Re-read right before writing so a listener update since the first read is kept.
    const latest = readJsonStrict<Record<string, unknown>>(STATE_FILE, {});
    for (const k of leftovers) delete latest[k];
    writeJsonAtomic(STATE_FILE, latest);
  }
  console.log(`\nWrote ${changes.length} subscription change(s), ${relabel.length} registry label(s), removed ${leftovers.length} monitor-state entr${leftovers.length === 1 ? 'y' : 'ies'}.`);
}

if (require.main === module) main();
