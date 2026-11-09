import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pendingText, verifiedText, healthText } from '../src/bot-lookups';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solgov-bot-'));
const now = new Date().toISOString();
fs.writeFileSync(path.join(dir, 'pending-upgrades.json'), JSON.stringify({
  scannedAt: now,
  complete: true,
  results: [
    { protocol: 'Orca', proposalIndex: 94, status: 'Active', approvals: 1, threshold: 5, timelockSeconds: 86400, kind: 'ProgramUpgrade', programId: 'riptK81hDxhe5pW5jSzSM9iRA8azgEgLJ4dXkPtBS7j', executable: true },
    { protocol: 'Orca', proposalIndex: 90, status: 'Active', approvals: 0, threshold: 5, timelockSeconds: 86400, kind: 'ConfigChange', programId: null, executable: false },
    { protocol: 'Drift', proposalIndex: 7, status: 'Approved', approvals: 4, threshold: 4, timelockSeconds: 3600, kind: 'ProgramUpgrade', programId: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P', stale: true },
  ],
}));
fs.writeFileSync(path.join(dir, 'verified-builds.json'), JSON.stringify({
  scannedAt: now,
  programs: [
    { protocol: 'Nosana', name: 'Staking', programId: 'nosScmHY', verified: true, repo: 'https://github.com/nosana-ci/nosana-programs/tree/v2.2.8' },
    { protocol: 'Nosana', name: 'Jobs <x>', programId: 'nosJhNRq', verified: null },
  ],
}));

test('pendingText lists proposals with their executability', () => {
  const t = pendingText('orca', dir);
  assert.match(t, /Open proposals: Orca/);
  assert.match(t, /#94 Program code update: 1 of 5 approvals, 24h timelock, collecting approvals/);
  assert.match(t, /#90 Multisig settings change: 0 of 5 approvals, 24h timelock, can no longer go through/);
});

test('pendingText resolves the Velocity alias and keeps approved-but-stale vault transactions executable', () => {
  const t = pendingText('velocity', dir);
  assert.match(t, /Velocity \(formerly Drift\)/);
  // Older snapshots carry stale without executable; stale falls back to not executable.
  assert.match(t, /#7 Program code update: 4 of 4 approvals, 1h timelock, can no longer go through/);
});

test('pendingText handles an unknown protocol and missing data', () => {
  assert.match(pendingText('nothing-here', dir), /No queued upgrade or config proposals found/);
  assert.match(pendingText('orca', path.join(dir, 'missing')), /not available yet/);
});

test('verifiedText distinguishes verified, unverified and unchecked, and escapes names', () => {
  const t = verifiedText('nosana', dir);
  assert.match(t, /Staking: verified \(nosana-ci\/nosana-programs\/tree\/v2\.2\.8\)/);
  assert.match(t, /Jobs &lt;x&gt;: could not be checked/);
});

test('healthText flags missing surfaces', () => {
  const t = healthText(dir);
  assert.match(t, /Pending upgrades: 0h old/);
  assert.match(t, /Monitor state: missing/);
  assert.match(t, /stale or missing/);
});

test('adminText lists watched admin keys and resolves one protocol', async () => {
  const { adminText } = await import('../src/bot-lookups');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'solgov-admin-'));
  assert.equal(adminText('', d), 'Admin key data is not available yet.');
  fs.writeFileSync(path.join(d, 'admin-watch.json'), JSON.stringify({ generatedAt: now, targets: [
    { protocol: 'Kamino', name: 'Kamino Lend main market owner', account: 'a', programId: 'p', fields: [
      { name: 'owner', label: 'Kamino Lend main market owner', kind: 'active', value: 'x', holder: null, holderText: 'Kamino (Lend Market Owner) vault (4 of 10 signers, 12h timelock)', watchingSince: '2026-11-09T10:15:00Z', lastChange: null },
      { name: 'ownerCached', label: 'Kamino Lend main market owner', kind: 'pending', value: 'x', holder: null, holderText: 'No handover pending', handoverProposed: false, watchingSince: '2026-11-09T10:15:00Z', lastChange: null },
    ] },
    { protocol: 'Orca', name: 'Orca config', account: 'b', programId: 'q', fields: [
      { name: 'feeAuthority', label: 'Orca pool fee authority <x>', kind: 'active', value: 'y', holder: null, holderText: 'Orca vault (5 of 13 signers, 24h timelock)', watchingSince: '2026-11-09T10:15:00Z', lastChange: { at: '2026-11-10T01:00:00Z', detail: 'changed' } },
    ] },
  ] }));
  const all = adminText('', d);
  assert.match(all, /Protocol admin keys/);
  assert.match(all, /• <b>Kamino Lend main market owner<\/b>/);
  assert.match(all, /Handover: none pending/);
  assert.match(all, /Orca pool fee authority &lt;x&gt;/);
  assert.match(all, /Changed 10 Nov 2026: changed/);
  assert.match(all, /No change seen since watching began/);
  assert.match(all, /Watching since 9 Nov 2026\./);
  const one = adminText('orca', d);
  assert.match(one, /Admin keys: Orca/);
  assert.doesNotMatch(one, /Kamino/);
  assert.match(adminText('nosuch', d), /No watched admin keys for <b>nosuch<\/b>/);
});

test('adminText formats structured holders: multisig facts, untracked and unchecked addresses', async () => {
  const { adminText } = await import('../src/bot-lookups');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'solgov-admin2-'));
  const base = { label: 'Key (does a thing)', kind: 'active', watchingSince: '2026-11-09T10:15:00Z', lastChange: null };
  fs.writeFileSync(path.join(d, 'admin-watch.json'), JSON.stringify({ generatedAt: now, targets: [{ protocol: 'Kamino', name: 'n', account: 'a', programId: 'p', fields: [
    { ...base, name: 'a', value: 'V1111111111111111111111111111111111111111111', holderText: 'x', holder: { kind: 'multisig-vault', address: 'm', multisigName: 'Kamino (Lend Market Owner)', threshold: 4, memberCount: 10, timeLock: 43200, configAuthority: 'autonomous' } },
    { ...base, name: 'b', value: 'CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw', holderText: 'x', holder: { kind: 'untracked', address: 'CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw', scope: 'live' } },
    { ...base, name: 'c', value: 'CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw', holderText: 'x', holder: { kind: 'untracked', address: 'CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw', scope: 'unchecked' } },
  ] }] }));
  const t = adminText('kamino', d);
  assert.match(t, /Held by: Kamino \(Lend Market Owner\) multisig, 4 of 10 signers, 12h timelock/);
  assert.match(t, /  Does a thing/);
  assert.match(t, /Held by: <code>CYXEgw\.\.\.RbEw<\/code> \(not linked to a multisig solgov tracks\)/);
  assert.match(t, /Held by: <code>CYXEgw\.\.\.RbEw<\/code>\n/);
});
