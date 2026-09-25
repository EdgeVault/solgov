import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import * as multisig from '@sqds/multisig';
import { applyTx, emptyStore, stepsOf, summarise, targetsFromProtocolsSource, SQUADS_V4, SQUADS_V3 } from '../src/gov-activity';

const MS = '7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM';
const A = 'LoTy38EiLYg85rWq5okYjNwzQECGbYa6uPcJPj8MHu2';
const B = 'bs1PuRvB9rBBZkryBjADYvxc2qYh51EVW2fsb1uTiBN';
const TX = 'stnD32KEQkgA7LTVNprUPBWXt86fstt1sdUiwUUJH4j';
const PROP = 'CyNKPfqsSLAejjZtEeNG3pR4SkPhSPHXdGhuNTyudrNs';
const OTHER = 'FmoQf6t1fxNhvzJ7iVyoiue5C8JuhkLxpp6it9jAkkua';

const v4 = (k: string) => Buffer.from((multisig.generated as any)[k + 'InstructionDiscriminator']);
const anchor = (n: string) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);

// Builds a minimal transaction in the getTransactionsForAddress 'json' shape.
function tx(time: number, program: string, ixs: { data: Buffer; accounts: string[] }[], feePayer = A, inner = false) {
  const keys = [feePayer, program];
  const idx = (k: string) => { if (!keys.includes(k)) keys.push(k); return keys.indexOf(k); };
  const compiled = ixs.map(ix => ({ programIdIndex: 1, accounts: ix.accounts.map(idx), data: bs58.encode(ix.data) }));
  return {
    slot: time, blockTime: time,
    transaction: { signatures: ['sig' + time], message: { accountKeys: keys, header: { numRequiredSignatures: 1 }, instructions: inner ? [] : compiled } },
    meta: { err: null, innerInstructions: inner ? [{ index: 0, instructions: compiled }] : [] },
  };
}

const target = { name: 'Test', address: MS, version: 'V4' as const };

test('V4: create, approve and execute give one approved proposal with its timing', () => {
  const s = emptyStore(target);
  applyTx(s, stepsOf(tx(1_000_000, SQUADS_V4, [{ data: v4('vaultTransactionCreate'), accounts: [MS, TX, A, A] }]), MS, 'V4'));
  applyTx(s, stepsOf(tx(1_003_600, SQUADS_V4, [{ data: v4('proposalApprove'), accounts: [MS, B, PROP] }], B), MS, 'V4'));
  applyTx(s, stepsOf(tx(1_007_200, SQUADS_V4, [{ data: v4('vaultTransactionExecute'), accounts: [MS, PROP, TX, A] }]), MS, 'V4'));
  const out = summarise(s, [A, B, OTHER], 1_007_200 + 86400);
  assert.equal(out.totalTxs, 3);
  assert.equal(out.approvedProposals, 1);
  assert.equal(out.avgExecuteTimeH, 2);
  assert.equal(out.proposers, 1);
  assert.equal(out.approvers, 1);
  assert.equal(out.executors, 1);
  assert.equal(out.rubberStampSigners, 1); // A created and executed
  assert.equal(out.activeVoters90d, 2);
  assert.equal(out.neverSignedCount, 1);
});

test('instructions acting on a different multisig are ignored', () => {
  const s = emptyStore(target);
  applyTx(s, stepsOf(tx(1, SQUADS_V4, [{ data: v4('proposalApprove'), accounts: [OTHER, B, PROP] }]), MS, 'V4'));
  assert.equal(summarise(s, [A, B]).approvers, 0);
});

test('a rejected proposal that later executes is counted as approved, not rejected', () => {
  const s = emptyStore(target);
  applyTx(s, stepsOf(tx(1, SQUADS_V4, [{ data: v4('proposalReject'), accounts: [MS, B, PROP] }]), MS, 'V4'));
  applyTx(s, stepsOf(tx(2, SQUADS_V4, [{ data: v4('vaultTransactionExecute'), accounts: [MS, PROP, TX, A] }]), MS, 'V4'));
  const out = summarise(s, [A, B]);
  assert.equal(out.approvedProposals, 1);
  assert.equal(out.rejectedProposals, 0);
});

test('V3: several config instructions in one transaction are one config change', () => {
  const s = emptyStore({ ...target, version: 'V3' });
  const add = { data: anchor('add_member'), accounts: [MS, A] };
  applyTx(s, stepsOf(tx(1_700_000_000, SQUADS_V3, [add, add, { data: anchor('change_threshold'), accounts: [MS] }], A, true), MS, 'V3'));
  const out = summarise(s, [A]);
  assert.equal(out.configChanges, 1);
  assert.equal(out.membersAdded, 2);
  assert.equal(out.thresholdChanges, 1);
  assert.deepEqual(out.configDates, ['2023-11-14']);
});

test('config changes between 22:00 and 06:00 UTC are off-hours', () => {
  const s = emptyStore({ ...target, version: 'V3' });
  const at = (iso: string) => Date.parse(iso) / 1000;
  applyTx(s, stepsOf(tx(at('2026-01-01T23:30:00Z'), SQUADS_V3, [{ data: anchor('change_threshold'), accounts: [MS] }], A, true), MS, 'V3'));
  applyTx(s, stepsOf(tx(at('2026-01-02T12:00:00Z'), SQUADS_V3, [{ data: anchor('change_threshold'), accounts: [MS] }], A, true), MS, 'V3'));
  assert.deepEqual(summarise(s, [A]).offHoursConfigChanges, { offHours: 1, total: 2 });
});

test('targets come from the headline multisig of each supported entry', () => {
  const src = [
    "export const PROTOCOLS = [",
    "  {",
    "    name: 'Alpha',",
    "    version: 'Squads V4',",
    `    multisigAddress: '${MS}',`,
    "  },",
    "  {",
    "    name: 'Beta',",
    "    version: 'Single Signer',",
    "    multisigAddress: 'N/A',",
    "  },",
    "];",
  ].join('\n');
  assert.deepEqual(targetsFromProtocolsSource(src), [{ name: 'Alpha', address: MS, version: 'V4' }]);
});
