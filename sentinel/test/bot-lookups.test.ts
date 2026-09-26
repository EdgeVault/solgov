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
