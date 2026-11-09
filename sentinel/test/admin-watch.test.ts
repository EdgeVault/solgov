import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import { AdminWatcher, protocolsMultisigs, loadLiveAdminTargets, type LiveAdminTarget } from '../src/admin-watch';
import { classifyAdminChange, readAdminFields, NONE } from '../src/detectors/admin-watch';

const K1 = new PublicKey('GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV');
const K2 = new PublicKey('CRQd5wvbf6FKVmjHC7on8w4pzFPzudij2BKXRcMCu7aK');
const target: LiveAdminTarget = {
  name: 'Test config', protocol: 'Test', programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', account: 'Acct1111111111111111111111111111111111111111',
  accountType: 'WhirlpoolsConfig', role: 'routes-funds', discriminator: '9d1431e0d957c1fe', verified: '2026-11-09',
  fields: [{ name: 'fee', label: 'Test fee authority', kind: 'active', offset: 8 }, { name: 'next', label: 'Test owner', kind: 'pending', offset: 40 }],
  setters: [], historyFrom: [],
};
const acct = (fee: PublicKey, next: PublicKey | null) => {
  const b = Buffer.alloc(72);
  Buffer.from('9d1431e0d957c1fe', 'hex').copy(b, 0);
  fee.toBuffer().copy(b, 8);
  if (next) next.toBuffer().copy(b, 40);
  return b;
};
const fakeConn: any = { getAccountInfo: async () => null, getSignaturesForAddress: async () => [] };
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adminwatch-')), 'state.json');

test('readAdminFields reads keys and maps the zero key to NONE', () => {
  assert.deepEqual(readAdminFields(target, acct(K1, null)), { fee: K1.toBase58(), next: NONE });
  assert.equal(readAdminFields(target, Buffer.alloc(20)), null);
});

test('wrong owner or discriminator is skipped, never read', () => {
  const w = new AdminWatcher(fakeConn, [target], tmpState());
  assert.equal(w.read(target, 'SomeOtherProgram111111111111111111111111111', acct(K1, null)), null);
  const bad = acct(K1, null); bad[0] ^= 0xff;
  assert.equal(w.read(target, target.programId, bad), null);
  assert.ok(w.read(target, target.programId, acct(K1, null)));
});

test('first read baselines silently; a later change alerts; no change is silent', async () => {
  const w = new AdminWatcher(fakeConn, [target], tmpState());
  assert.deepEqual(await w.observe(target, w.read(target, target.programId, acct(K1, null))!), []);
  assert.deepEqual(await w.observe(target, w.read(target, target.programId, acct(K1, null))!), []);
  const alerts = await w.observe(target, w.read(target, target.programId, acct(K2, null))!);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'AdminKeyChanged');
  assert.equal(alerts[0].severity, 'CRITICAL');
  assert.equal(alerts[0].public, true);
  assert.match(alerts[0].detail, /not a vault of any multisig solgov tracks/);
});

test('baseline persists across restarts, so a change made while down is reported', async () => {
  const file = tmpState();
  const w1 = new AdminWatcher(fakeConn, [target], file);
  await w1.observe(target, w1.read(target, target.programId, acct(K1, null))!);
  const w2 = new AdminWatcher(fakeConn, [target], file);
  const alerts = await w2.observe(target, w2.read(target, target.programId, acct(K2, null))!);
  assert.equal(alerts.length, 1);
});

test('a pending successor being set is a HIGH public handover warning; clearing it is internal', async () => {
  const w = new AdminWatcher(fakeConn, [target], tmpState());
  await w.observe(target, w.read(target, target.programId, acct(K1, null))!);
  const proposed = await w.observe(target, w.read(target, target.programId, acct(K1, K2))!);
  assert.deepEqual(proposed.map(a => [a.type, a.severity, a.public]), [['AdminHandoverProposed', 'HIGH', true]]);
  const cleared = await w.observe(target, w.read(target, target.programId, acct(K1, null))!);
  assert.deepEqual(cleared.map(a => [a.type, a.severity, a.public]), [['AdminHandoverCleared', 'MONITOR', false]]);
});

test('a pending value equal to the current holder is "nothing pending", not a handover', () => {
  const paired = { ...target, fields: [target.fields[0], { ...target.fields[1], pendingFor: 'fee' }] };
  const r = classifyAdminChange({ target: paired, field: 'next', before: K2.toBase58(), after: K1.toBase58(), currentActive: K1.toBase58(), beforeHolder: null, afterHolder: { kind: 'untracked', address: K1.toBase58() } });
  assert.equal(r.type, 'AdminHandoverCleared');
  assert.equal(r.public, false);
});

test('field severity override lowers a lower-stakes key to HIGH', () => {
  const t2 = { ...target, role: 'holds-funds' as const, fields: [{ ...target.fields[0], severity: 'HIGH' as const }] };
  const r = classifyAdminChange({ target: t2, field: 'fee', before: K1.toBase58(), after: K2.toBase58(), beforeHolder: null, afterHolder: { kind: 'untracked', address: K2.toBase58() } });
  assert.equal(r.severity, 'HIGH');
  assert.equal(r.public, true);
});

test('holder description names a tracked multisig vault with its configuration', () => {
  const r = classifyAdminChange({
    target, field: 'fee', before: K1.toBase58(), after: K2.toBase58(),
    beforeHolder: { kind: 'untracked', address: K1.toBase58(), scope: 'live' },
    afterHolder: { kind: 'multisig-vault', address: 'x', multisigName: 'Orca', threshold: 4, memberCount: 6, timeLock: 0, configAuthority: 'autonomous' },
  });
  assert.match(r.detail, /→ Orca vault \(4 of 6 signers, no timelock\)$/);
});

test('unchecked holder makes no tracked/untracked claim', () => {
  const r = classifyAdminChange({ target, field: 'fee', before: K1.toBase58(), after: K2.toBase58(), beforeHolder: null, afterHolder: { kind: 'untracked', address: K2.toBase58(), scope: 'unchecked' } });
  assert.doesNotMatch(r.detail, /not a vault/);
  assert.match(r.detail, new RegExp(`→ ${K2.toBase58().slice(0, 8)}\\.\\.\\.$`));
});

test('protocols.ts parser picks up headline and role-level multisigs', () => {
  const src = `\n    name: 'Kamino',\n    multisigAddress: '6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM',\n    roles: [\n      { role: 'Lend Market Owner', scope: 'x', threshold: '4/10', address: '7idEEVRidWrahZJhxXMqniDbV6ESj7ZjyLrigcMcEt6H', status: 'verified' },\n    ],\n`;
  assert.deepEqual(protocolsMultisigs(src), [
    { name: 'Kamino', address: '6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM' },
    { name: 'Kamino (Lend Market Owner)', address: '7idEEVRidWrahZJhxXMqniDbV6ESj7ZjyLrigcMcEt6H' },
  ]);
});

test('live target list excludes unverified and held-back targets (Drift is held back)', () => {
  const live = loadLiveAdminTargets();
  assert.ok(live.length >= 1);
  assert.ok(live.every(t => t.verified && t.discriminator && t.live !== false));
  assert.ok(!live.some(t => t.protocol === 'Drift'));
});

test('writeSnapshot records holders, pending handover state, watching-since and the last change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminsnap-'));
  const snapFile = path.join(dir, 'admin-watch.json');
  const paired = { ...target, fields: [target.fields[0], { ...target.fields[1], pendingFor: 'fee' }] };
  const w = new AdminWatcher(fakeConn, [paired], path.join(dir, 'state.json'), snapFile);
  await w.observe(paired, w.read(paired, paired.programId, acct(K1, K1))!);
  let snap = await w.writeSnapshot();
  const [fee, next] = snap.targets[0].fields;
  assert.equal(fee.value, K1.toBase58());
  // K1 is a real tracked vault (Orca) and the fake connection cannot read its multisig, so the
  // holder is 'unchecked': the address alone, with no tracked/untracked claim.
  assert.equal(fee.holderText, `${K1.toBase58().slice(0, 8)}...`);
  assert.equal(fee.lastChange, null);
  assert.equal(next.handoverProposed, false);
  assert.equal(next.holderText, 'No handover pending');
  const since = fee.watchingSince;
  await w.observe(paired, w.read(paired, paired.programId, acct(K2, K2))!);
  snap = await w.writeSnapshot();
  assert.equal(snap.targets[0].fields[0].watchingSince, since);
  assert.match(snap.targets[0].fields[0].lastChange!.detail, /Test fee authority/);
  // A restart keeps watching-since and the last change from the snapshot on disk.
  const w2 = new AdminWatcher(fakeConn, [paired], path.join(dir, 'state.json'), snapFile);
  const snap2 = await w2.writeSnapshot();
  assert.equal(snap2.targets[0].fields[0].watchingSince, since);
  assert.ok(snap2.targets[0].fields[0].lastChange);
});
