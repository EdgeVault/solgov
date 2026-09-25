import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLiveGroups, familyOf, scoreGroup } from '../src/utils/independence';

const ms = (label: string, members: string[]) => ({ label, address: null, members });

test('familyOf strips a trailing parenthetical and applies the explicit family map', () => {
  assert.equal(familyOf('Kamino (Farms)'), 'Kamino');
  assert.equal(familyOf('Helium (Top (topqq))'), 'Helium');
  assert.equal(familyOf('Jupiter Perps'), 'Jupiter');
  assert.equal(familyOf('Jupiter Lend'), 'Jupiter');
  assert.equal(familyOf('Orca'), 'Orca');
});

test('disjoint signer sets score 100%', () => {
  const g = scoreGroup('T', [ms('a', ['1', '2', '3']), ms('b', ['4', '5', '6'])]);
  assert.equal(g.independencePct, 100);
  assert.equal(g.uniqueSigners, 6);
  assert.equal(g.totalSignerPositions, 6);
  assert.deepEqual(g.pairwiseOverlap, [{ a: 'a', b: 'b', shared: 0, sharedPctOfMinSet: 0 }]);
});

test('identical signer sets score 0% (the pre-exploit Drift shape)', () => {
  const five = ['1', '2', '3', '4', '5'];
  const g = scoreGroup('T', [ms('a', five), ms('b', five)]);
  assert.equal(g.independencePct, 0);
  assert.equal(g.uniqueSigners, 5);
  assert.equal(g.pairwiseOverlap[0].shared, 5);
  assert.equal(g.pairwiseOverlap[0].sharedPctOfMinSet, 100);
});

test('partial overlap lands between the two extremes and is clamped to [0, 1]', () => {
  const g = scoreGroup('T', [ms('a', ['1', '2', '3']), ms('b', ['3', '4', '5'])]);
  // positions 6, unique 5, minSize 3 -> (5-3)/(6-3)
  assert.equal(g.independencePct, 67);
  assert.ok(g.independenceScore >= 0 && g.independenceScore <= 1);
});

test('computeLiveGroups groups by family, needs two or more multisigs, skips historical and empty entries', () => {
  const state = {
    _meta: { anything: true },
    'Kamino (Lend)': { members: ['1', '2'], address: 'K1', lastChecked: '2026-09-01T00:00:00.000Z' },
    'Kamino (Farms)': { members: ['3', '4'], address: 'K2', lastChecked: '2026-09-02T00:00:00.000Z' },
    'Kamino (historical 2025)': { members: ['1', '2'], address: 'K0' },
    'Orca': { members: ['9'], address: 'O1' },
    'Empty': { members: [], address: 'E1' },
    'Jupiter Perps': { members: ['a', 'b'], address: 'J1' },
    'Jupiter Lend': { members: ['a', 'c'], address: 'J2' },
  };
  const out = computeLiveGroups(state);
  assert.equal(out.computedAt, '2026-09-02T00:00:00.000Z');
  assert.deepEqual(out.groups.map(g => g.team), ['Kamino', 'Jupiter']);
  const kamino = out.groups.find(g => g.team === 'Kamino')!;
  assert.equal(kamino.multisigs.length, 2);
  assert.equal(kamino.independencePct, 100);
  const jup = out.groups.find(g => g.team === 'Jupiter')!;
  assert.equal(jup.note, 'Three product multisigs: Perps, Lend, Aggregator');
  assert.equal(jup.independencePct, 50);
});
