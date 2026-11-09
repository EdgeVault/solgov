import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { runReplay, relevantSubset, type Scenario } from '../src/replay/engine';
import { programDataAddress, LOADER } from '../src/replay/program';
import { SQUADS_V4, vaultPda } from '../src/replay/squads-v4';
import { anchorDisc } from '../src/replay/admin';
import type { CompactTx, CompactIx } from '../src/replay/history';

// Synthetic histories built with the Squads SDK's own instruction encoders and the upgradeable loader
// layout, so every decoder path is exercised offline.

const g = multisig.generated as any;
const key = () => Keypair.generate().publicKey;
const toIx = (ix: { programId: PublicKey; keys: { pubkey: PublicKey }[]; data: Buffer }, inner = false): CompactIx =>
  ({ p: ix.programId.toBase58(), a: ix.keys.map(k => k.pubkey.toBase58()), d: bs58.encode(ix.data), inner });
let slot = 1000;
const tx = (ixs: CompactIx[], time: number): CompactTx => ({ sig: `sig${slot}`, slot: slot++, time, feePayer: 'payer', ixs });

const MS = key();
const EXT = key();
const members = [key(), key(), key(), key(), key()].map(k => ({ key: k, permissions: { mask: 7 } }));
const create = toIx(g.createMultisigCreateV2Instruction(
  { programConfig: key(), treasury: key(), multisig: MS, createKey: key(), creator: key() },
  { args: { configAuthority: EXT, threshold: 3, members, timeLock: 0, rentCollector: null, memo: null } },
));
const lower = toIx(g.createMultisigChangeThresholdInstruction(
  { multisig: MS, configAuthority: EXT, rentPayer: key() },
  { args: { newThreshold: 2, memo: null } },
));

const PROG = key().toBase58();
const PD = programDataAddress(PROG);
const AUTH1 = key().toBase58();
const VAULT = vaultPda(MS.toBase58());
const loader = (tag: number, accounts: string[]): CompactIx => { const d = Buffer.alloc(4); d.writeUInt32LE(tag, 0); return { p: LOADER, a: accounts, d: bs58.encode(d), inner: false }; };

const ADMIN_PROG = key().toBase58();
const STATE = key().toBase58();
const NEW_ADMIN = key();
const setAdmin: CompactIx = { p: ADMIN_PROG, a: [VAULT, STATE], d: bs58.encode(Buffer.concat([Buffer.from(anchorDisc('update_admin'), 'hex'), NEW_ADMIN.toBuffer()])), inner: true };

const T = 1_700_000_000;
const msHist = [tx([create], T), tx([lower], T + 100), tx([{ p: SQUADS_V4, a: [MS.toBase58()], d: bs58.encode(Buffer.alloc(8)), inner: false }, setAdmin], T + 500)];
const pdHist = [
  tx([loader(2, ['payer', PD, PROG, 'buf', 'rent', 'clock', 'sys', AUTH1])], T + 10),
  tx([loader(3, [PD, PROG, 'buf', 'spill', 'rent', 'clock', AUTH1])], T + 200),
  tx([loader(4, [PD, AUTH1, VAULT])], T + 300),
  tx([{ p: 'SomeOtherProgram1111111111111111111111111111', a: [PD], d: bs58.encode(Buffer.alloc(8)), inner: false }], T + 350), // read-only touch
  tx([loader(6, [PD, PROG])], T + 360),                                                                                    // ExtendProgram
  tx([loader(4, [PD, VAULT])], T + 400),                                                                                   // made immutable
];

const scenario: Scenario = {
  id: 'synthetic', title: 'Synthetic', windows: [{ label: 'all', from: '2023-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }],
  multisigs: [{ name: 'Test multisig', address: MS.toBase58() }],
  programs: [{ name: 'Test program', programId: PROG, role: 'holds-funds' }],
  admin: [{ name: 'Test admin', protocol: 'Test', programId: ADMIN_PROG, account: STATE, role: 'holds-funds', fields: [{ name: 'admin', label: 'Test protocol admin', kind: 'active', offset: 8 }], setters: [{ ix: 'update_admin', field: 'admin', stateAccountIndex: 1, newValueArgOffset: 8, currentAdminAccountIndex: 0 }], historyFrom: [MS.toBase58()] }],
};
const histories = { [MS.toBase58()]: msHist, [PD]: pdHist };
const r = runReplay(scenario, histories);
const types = r.events.map(e => `${e.detector}/${e.type}`);

test('multisig create is an observation with the starting configuration', () => {
  const e = r.events.find(e => e.type === 'MultisigCreated')!;
  assert.equal(e.detector, 'observation');
  assert.match(e.detail, /3 of 5 signers, no timelock, external admin key/);
});

test('threshold lowered by the external admin key fires CRITICAL, public, and says no proposal', () => {
  const e = r.events.find(e => e.type === 'ThresholdLowered')!;
  assert.equal(e.severity, 'CRITICAL');
  assert.equal(e.routing.public, true);
  assert.match(e.detail, /Threshold: 3 → 2 \(changed directly by the external admin key, no proposal\)/);
});

test('program upgrade fires HIGH internal; authority change to a replayed vault fires CRITICAL public with the vault described', () => {
  const up = r.events.find(e => e.type === 'ProgramUpgrade')!;
  assert.equal(up.severity, 'HIGH');
  assert.equal(up.routing.public, false);
  const auth = r.events.filter(e => e.type === 'AuthorityChange');
  assert.equal(auth.length, 2);
  assert.equal(auth[0].severity, 'CRITICAL');
  assert.equal(auth[0].routing.public, true);
  assert.match(auth[0].detail, /→ Test multisig vault \(2 of 5 signers, no timelock, external admin key set\)/);
  assert.match(auth[1].detail, /→ nobody \(it can no longer be changed\)/);
});

test('a read-only ProgramData touch and ExtendProgram produce no events', () => {
  assert.equal(types.filter(t => t.startsWith('program-upgrade/')).length, 3); // 1 upgrade + 2 authority changes
});

test('admin setter executed through a vault fires Admin Watch with the previous holder taken from the signer', () => {
  const e = r.events.find(e => e.detector === 'admin-watch')!;
  assert.equal(e.type, 'AdminKeyChanged');
  assert.equal(e.severity, 'CRITICAL');
  assert.match(e.detail, /Test multisig vault \(2 of 5 signers.*\) → .* \(not a vault of any multisig in this replay\)/);
});

test('relevantSubset gives identical events from a smaller history', () => {
  const sub = relevantSubset(scenario, histories);
  assert.deepEqual(runReplay(scenario, sub).events, r.events);
  assert.ok(sub[PD].length < pdHist.length);
});

test('watchedLive reflects live coverage', () => {
  const r2 = runReplay(scenario, histories, { multisigs: new Set([MS.toBase58()]), programs: new Set(), adminAccounts: new Set() });
  assert.equal(r2.events.find(e => e.type === 'ThresholdLowered')!.routing.watchedLive, true);
  assert.equal(r2.events.find(e => e.type === 'ProgramUpgrade')!.routing.watchedLive, false);
});
