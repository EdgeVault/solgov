// Freezes a replay scenario into a small offline test fixture: the scenario plus only the transactions
// the rebuild reads, taken from the cached histories. Refuses to write if the subset does not give
// exactly the same events as the full history.
//
//   npx ts-node --transpile-only src/replay/freeze-fixture.ts <scenario-id>

import * as fs from 'fs';
import * as path from 'path';
import { runReplay, relevantSubset, historyAddresses, type Scenario } from './engine';
import { loadHistory, type CompactTx } from './history';

const id = process.argv[2];
if (!id) throw new Error('usage: freeze-fixture.ts <scenario-id>');
const root = path.join(__dirname, '..', '..');
const s: Scenario = JSON.parse(fs.readFileSync(path.join(root, 'data', 'replay', 'scenarios', `${id}.json`), 'utf-8'));
const full: Record<string, CompactTx[]> = {};
for (const a of historyAddresses(s)) {
  const f = loadHistory(a);
  if (!f) throw new Error(`no cached history for ${a}; run npm run replay -- ${id} first`);
  full[a] = f.txs;
}
const sub = relevantSubset(s, full);
const a = JSON.stringify(runReplay(s, full).events);
const b = JSON.stringify(runReplay(s, sub).events);
if (a !== b) throw new Error('subset events differ from full-history events; fixture not written');
const count = (h: Record<string, CompactTx[]>) => Object.values(h).reduce((n, l) => n + l.length, 0);
const out = path.join(root, 'test', 'fixtures', 'replay', `${id}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ scenario: s, histories: sub }));
console.log(`events identical (${JSON.parse(a).length}); ${count(full)} txs -> ${count(sub)} in fixture; wrote ${path.relative(root, out)} (${fs.statSync(out).size} bytes)`);
