import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, leftoverStateKeys } from '../src/migrate-tracked-subscriptions';

const A = '7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM';
const B = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const sub = (protocols: string[]) => ({ chatId: 1, protocols, severities: [], types: ['*' as const], createdAt: 'x' });

test('a bare tracked label is re-pointed at the namespaced name', () => {
  const { subs, changes } = migrate(
    { '10': sub(['My Vault', 'Kamino']) },
    [{ address: A, label: 'My Vault', addedAt: 'x', addedBy: 'tg:10' }],
    ['Kamino', 'Drift', '_activityLog'],
  );
  assert.deepEqual(subs['10'].protocols, ['Tracked: My Vault (7qip...cJtM)', 'Kamino']);
  assert.equal(changes.length, 1);
});

test('a bare label that is also a curated protocol keeps the curated subscription', () => {
  const { subs } = migrate(
    { '10': sub(['Drift']) },
    [{ address: A, label: 'Drift', addedAt: 'x', addedBy: 'tg:10' }],
    ['Drift'],
  );
  assert.deepEqual(subs['10'].protocols, ['Tracked: Drift (7qip...cJtM)', 'Drift']);
});

test("another user's tracked label is not applied", () => {
  const { subs, changes } = migrate(
    { '10': sub(['My Vault']) },
    [{ address: B, label: 'My Vault', addedAt: 'x', addedBy: 'tg:99' }],
    [],
  );
  assert.deepEqual(subs['10'].protocols, ['My Vault']);
  assert.equal(changes.length, 0);
});

test('already namespaced subscriptions are left alone', () => {
  const n = 'Tracked: My Vault (7qip...cJtM)';
  const { subs, changes } = migrate({ '10': sub([n]) }, [{ address: A, label: n, addedAt: 'x', addedBy: 'tg:10' }], []);
  assert.deepEqual(subs['10'].protocols, [n]);
  assert.equal(changes.length, 0);
});

test('leftover state entries are found by bare tracked label, never a curated name', () => {
  const entries = [
    { address: A, label: 'LifeSavings', addedAt: 'x', addedBy: 'tg:10' },
    { address: B, label: 'Kamino', addedAt: 'x', addedBy: 'tg:11' },
  ];
  const keys = ['Kamino', 'Drift', 'LifeSavings', '_activityLog'];
  assert.deepEqual(leftoverStateKeys(keys, entries, ['Kamino', 'Drift']), ['LifeSavings']);
  // Without the curated list nothing is treated as a leftover.
  assert.deepEqual(leftoverStateKeys(keys, entries, null), []);
});

test('a leftover state entry does not keep the bare subscription', () => {
  const entries = [{ address: A, label: 'LifeSavings', addedAt: 'x', addedBy: 'tg:10' }];
  const { subs } = migrate({ '10': sub(['LifeSavings']) }, entries, ['Kamino']);
  assert.deepEqual(subs['10'].protocols, ['Tracked: LifeSavings (7qip...cJtM)']);
});
