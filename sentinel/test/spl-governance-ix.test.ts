import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSetGovernanceConfig, isSetRealmAuthority, decodeSetRealmAuthorityAction, isSetRealmConfig, readVoteThreshold,
  IX_SET_GOVERNANCE_CONFIG, IX_SET_REALM_AUTHORITY, IX_SET_REALM_CONFIG,
} from '../src/utils/spl-governance-ix';

function build(kind: number, pct: number | null, holdUp: number): Buffer {
  const parts: Buffer[] = [Buffer.from([IX_SET_GOVERNANCE_CONFIG, kind])];
  if (pct !== null) parts.push(Buffer.from([pct]));
  const weight = Buffer.alloc(8); weight.writeBigUInt64LE(1n);
  const hold = Buffer.alloc(4); hold.writeUInt32LE(holdUp);
  parts.push(weight, hold, Buffer.alloc(16)); // trailing fields ignored by the decoder
  return Buffer.concat(parts);
}

test('YesVotePercentage threshold carries a percentage byte before the weight', () => {
  const d = decodeSetGovernanceConfig(build(0, 60, 86400))!;
  assert.deepEqual(d, { voteThresholdKind: 0, voteThresholdPct: 60, holdUpTimeSec: 86400 });
});

test('QuorumPercentage threshold decodes the same way', () => {
  const d = decodeSetGovernanceConfig(build(1, 25, 0))!;
  assert.deepEqual(d, { voteThresholdKind: 1, voteThresholdPct: 25, holdUpTimeSec: 0 });
});

test('Disabled threshold has no percentage byte, so hold-up sits one byte earlier', () => {
  const d = decodeSetGovernanceConfig(build(2, null, 3600))!;
  assert.deepEqual(d, { voteThresholdKind: 2, voteThresholdPct: null, holdUpTimeSec: 3600 });
});

test('truncated data yields null hold-up rather than a misread', () => {
  const d = decodeSetGovernanceConfig(Buffer.from([IX_SET_GOVERNANCE_CONFIG, 0, 50, 1, 0, 0]))!;
  assert.equal(d.voteThresholdPct, 50);
  assert.equal(d.holdUpTimeSec, null);
});

test('other instructions are not decoded', () => {
  assert.equal(decodeSetGovernanceConfig(Buffer.from([6, 0, 0])), null);
  assert.equal(decodeSetGovernanceConfig(Buffer.from([IX_SET_GOVERNANCE_CONFIG])), null);
  assert.equal(decodeSetGovernanceConfig(Buffer.alloc(0)), null);
});

test('isSetRealmAuthority keys on the instruction tag only', () => {
  assert.equal(isSetRealmAuthority(Buffer.from([IX_SET_REALM_AUTHORITY])), true);
  assert.equal(isSetRealmAuthority(Buffer.from([IX_SET_REALM_AUTHORITY, 1, 2])), true);
  assert.equal(isSetRealmAuthority(Buffer.from([IX_SET_GOVERNANCE_CONFIG])), false);
  assert.equal(isSetRealmAuthority(Buffer.alloc(0)), false);
});


test('readVoteThreshold skips the percentage byte only for percentage kinds', () => {
  assert.deepEqual(readVoteThreshold(Buffer.from([0, 60, 9]), 0), { kind: 0, pct: 60, next: 2 });
  assert.deepEqual(readVoteThreshold(Buffer.from([1, 25, 9]), 0), { kind: 1, pct: 25, next: 2 });
  assert.deepEqual(readVoteThreshold(Buffer.from([2, 9, 9]), 0), { kind: 2, pct: null, next: 1 });
  assert.deepEqual(readVoteThreshold(Buffer.from([7, 0]), 1), { kind: 0, pct: null, next: 3 });
});

test('SetRealmAuthority action byte distinguishes Remove from the Set variants', () => {
  assert.equal(decodeSetRealmAuthorityAction(Buffer.from([IX_SET_REALM_AUTHORITY, 0])), 'SetUnchecked');
  assert.equal(decodeSetRealmAuthorityAction(Buffer.from([IX_SET_REALM_AUTHORITY, 1])), 'SetChecked');
  assert.equal(decodeSetRealmAuthorityAction(Buffer.from([IX_SET_REALM_AUTHORITY, 2])), 'Remove');
  assert.equal(decodeSetRealmAuthorityAction(Buffer.from([IX_SET_REALM_AUTHORITY])), 'Unknown');
  assert.equal(decodeSetRealmAuthorityAction(Buffer.from([IX_SET_REALM_CONFIG, 2])), null);
});

test('isSetRealmConfig keys on the instruction tag only', () => {
  assert.equal(isSetRealmConfig(Buffer.from([IX_SET_REALM_CONFIG, 0, 1])), true);
  assert.equal(isSetRealmConfig(Buffer.from([IX_SET_REALM_AUTHORITY])), false);
  assert.equal(isSetRealmConfig(Buffer.alloc(0)), false);
});
