import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cadenceFromKeys, dedupeUpgradesByFamily, protocolFamily, upgradeHourKey } from '../src/utils/upgrade-events';

test('protocolFamily strips nested parentheticals', () => {
  assert.equal(protocolFamily('Raydium (LaunchLab)'), 'Raydium');
  assert.equal(protocolFamily('Helium (Top (topqq))'), 'Helium');
  assert.equal(protocolFamily('Pump.fun'), 'Pump.fun');
});

test('listener event and monitor digest for the same upgrade collapse onto one UTC hour', () => {
  const listener = { type: 'ProgramUpgrade', protocol: 'Pump.fun', detail: 'Program 6EF8... upgraded', timestamp: '2026-09-15T10:34:12.000Z' };
  const digestBst = { type: 'ProgramUpgrade', protocol: 'Pump.fun', detail: 'Bonding Curve upgraded: 2026-09-15 11:34 BST' };
  assert.equal(upgradeHourKey(listener), '2026-09-15T10');
  assert.equal(upgradeHourKey(digestBst), '2026-09-15T10');
});

test('GMT digests are not shifted', () => {
  assert.equal(upgradeHourKey({ detail: 'Program upgraded: 2026-01-10 09:05 GMT' }), '2026-01-10T09');
});

test('events without a usable time are dropped', () => {
  assert.equal(upgradeHourKey({ detail: 'no time here' }), null);
  assert.equal(upgradeHourKey({ timestamp: 'not a date' }), null);
});

test('dedupeUpgradesByFamily keeps only attributed ProgramUpgrade events and merges product labels', () => {
  const events = [
    { type: 'ProgramUpgrade', protocol: 'Raydium (LaunchLab)', timestamp: '2026-09-01T10:00:00Z' },
    { type: 'ProgramUpgrade', protocol: 'Raydium (LaunchLab)', detail: 'x upgraded: 2026-09-01 11:20 BST' },
    { type: 'ProgramUpgrade', protocol: 'Raydium (CLMM)', timestamp: '2026-09-03T10:00:00Z' },
    { type: 'ProgramUpgrade', protocol: 'Unknown', timestamp: '2026-09-04T10:00:00Z' },
    { type: 'ThresholdChange', protocol: 'Raydium', timestamp: '2026-09-05T10:00:00Z' },
    null as any,
  ];
  const out = dedupeUpgradesByFamily(events);
  assert.deepEqual(Array.from(out.keys()), ['Raydium']);
  assert.deepEqual(Array.from(out.get('Raydium')!).sort(), ['2026-09-01T10', '2026-09-03T10']);
});

test('cadenceFromKeys reports observed count, span, 30-day count and mean interval', () => {
  const keys = new Set(['2026-08-01T10', '2026-08-11T10', '2026-09-10T10']);
  const now = Date.parse('2026-09-16T00:00:00Z');
  const row = cadenceFromKeys(keys, now);
  assert.equal(row.observed, 3);
  assert.equal(row.firstAt, '2026-08-01T10:00:00.000Z');
  assert.equal(row.lastAt, '2026-09-10T10:00:00.000Z');
  assert.equal(row.last30d, 1);
  assert.equal(row.meanIntervalDays, 20);
});

test('a single observation has no interval', () => {
  const row = cadenceFromKeys(new Set(['2026-08-01T10']), Date.parse('2026-08-02T00:00:00Z'));
  assert.equal(row.observed, 1);
  assert.equal(row.meanIntervalDays, null);
  assert.equal(row.last30d, 1);
});
