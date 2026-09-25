import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// subscriptions.ts reads data/bot-subscriptions.json relative to its own file. Swap in a fixture for
// the duration of this test and restore whatever was there.
const FILE = path.join(__dirname, '..', 'data', 'bot-subscriptions.json');
let original: string | null = null;

before(() => {
  original = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf-8') : null;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({
    '1': { chatId: 1, protocols: ['Drift'], severities: [], types: ['*'], createdAt: 'x' },
    '2': { chatId: 2, protocols: ['Tracked: Drift (7qip...cJtM)'], severities: [], types: ['*'], createdAt: 'x' },
    '3': { chatId: 3, protocols: ['kamino'], severities: ['CRITICAL'], types: ['*'], createdAt: 'x' },
  }));
});

after(() => {
  if (original === null) fs.rmSync(FILE, { force: true });
  else fs.writeFileSync(FILE, original);
});

test('curated protocol events keep fuzzy matching', async () => {
  const { matchSubscribersForAlert } = await import('../src/subscriptions');
  const ids = matchSubscribersForAlert({ protocol: 'Drift (interim recovery)', severity: 'HIGH' }).map(m => m.userId);
  assert.deepEqual(ids, ['1']);
});

test('a user-tracked multisig labelled Drift never reaches Drift subscribers', async () => {
  const { matchSubscribersForAlert } = await import('../src/subscriptions');
  const ids = matchSubscribersForAlert({ protocol: 'Tracked: Drift (7qip...cJtM)', severity: 'CRITICAL' }).map(m => m.userId);
  assert.deepEqual(ids, ['2']);
});

test('severity filters still apply', async () => {
  const { matchSubscribersForAlert } = await import('../src/subscriptions');
  assert.deepEqual(matchSubscribersForAlert({ protocol: 'Kamino', severity: 'HIGH' }).map(m => m.userId), []);
  assert.deepEqual(matchSubscribersForAlert({ protocol: 'Kamino', severity: 'CRITICAL' }).map(m => m.userId), ['3']);
});

test('a corrupt subscriptions file is not overwritten by a mutation', async () => {
  const { upsertSubscription } = await import('../src/subscriptions');
  fs.writeFileSync(FILE, '{"1": {"chatId"');
  assert.throws(() => upsertSubscription('9', { chatId: 9 }));
  assert.equal(fs.readFileSync(FILE, 'utf-8'), '{"1": {"chatId"');
});

test('a subscription stored under the rebranded name receives alerts for the internal key', async () => {
  const { matchSubscribersForAlert } = await import('../src/subscriptions');
  fs.writeFileSync(FILE, JSON.stringify({ '7': { chatId: 7, protocols: ['velocity'], severities: [], types: ['*'], createdAt: 'x' } }));
  assert.deepEqual(matchSubscribersForAlert({ protocol: 'Drift', severity: 'HIGH' }).map(m => m.userId), ['7']);
});
