import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, auditEntry } from '../src/audit-published';

const src = (other: string, extra = '') => [
  'export const PROTOCOLS = [',
  '  {',
  "    name: 'Alpha',",
  '    threshold: 3,',
  '    totalMembers: 5,',
  '    activeVoters: 5,',
  '    timelockSeconds: 0,',
  '    publicDocs: {',
  `      other: '${other}',`,
  "      source: 'https://example.org/docs',",
  "      updatedAt: '2026-09-20',",
  '    },',
  extra,
  '  },',
  '];',
].join('\n');

const live = { threshold: 3, members: ['a', 'b', 'c', 'd', 'e'], memberPerms: {}, timeLock: 0 };
const NOW = Date.parse('2026-09-25T00:00:00Z');

test('a note figure that matches live state is not flagged', () => {
  const [e] = parseEntries(src('The multisig is 3/5 with no timelock.'));
  assert.deepEqual(auditEntry(e, live, NOW), []);
});

test('a current-looking multisig figure that differs from live is flagged', () => {
  const [e] = parseEntries(src('The multisig is 3/4 today.'));
  const kinds = auditEntry(e, live, NOW).map(f => f.kind);
  assert.deepEqual(kinds, ['note-figure']);
});

test('history and docs-quoted figures are not flagged', () => {
  const [e] = parseEntries(src('Multisig changed from 2/4 to 3/5; the docs describe it as 4/7.'));
  assert.deepEqual(auditEntry(e, live, NOW), []);
});

test('point-in-time amounts and stale on-chain reads are flagged', () => {
  const [e] = parseEntries(src('About $1.2M in vault, read on-chain 2026-05-01.'));
  const kinds = auditEntry(e, live, NOW).map(f => f.kind).sort();
  assert.deepEqual(kinds, ['point-in-time', 'stale-read']);
});

test('"no timelock" in a note is flagged when live has one', () => {
  const [e] = parseEntries(src('Runs with no timelock.'));
  const f = auditEntry(e, { ...live, timeLock: 3600 }, NOW);
  assert.ok(f.some(x => x.kind === 'note-timelock'));
  assert.ok(f.some(x => x.kind === 'fallback-drift'));
});

test('source URLs are collected per entry', () => {
  const [e] = parseEntries(src('Audited.'));
  assert.deepEqual(e.urls, ['https://example.org/docs']);
});
