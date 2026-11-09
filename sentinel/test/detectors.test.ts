import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyV4Change, overallSeverity, normaliseConfigAuthority, type MultisigSnapshot } from '../src/detectors/multisig-config';
import { decideProgramEvent, classifyProgramSeverity, readProgramData } from '../src/detectors/program-upgrade';

const base: MultisigSnapshot = { threshold: 3, memberCount: 5, voterCount: 5, timeLock: 0, configAuthority: 'autonomous', memberKeys: ['a', 'b', 'c', 'd', 'e'] };
const types = (p: MultisigSnapshot, n: MultisigSnapshot) => classifyV4Change(p, n).map(c => c.type);

test('no change produces no events', () => {
  assert.deepEqual(classifyV4Change(base, { ...base }), []);
});

test('threshold lowered is CRITICAL, raised is HIGH', () => {
  assert.deepEqual(classifyV4Change(base, { ...base, threshold: 2 }).map(c => [c.type, c.severity]), [['ThresholdLowered', 'CRITICAL']]);
  assert.deepEqual(classifyV4Change(base, { ...base, threshold: 4 }).map(c => [c.type, c.severity]), [['ThresholdRaised', 'HIGH']]);
});

test('1:1 swap with unchanged count is a rotation, not add+remove', () => {
  assert.deepEqual(types(base, { ...base, memberKeys: ['a', 'b', 'c', 'd', 'x'] }), ['SignerRotation']);
});

test('removing three or more signers is CRITICAL', () => {
  const r = classifyV4Change(base, { ...base, memberCount: 2, voterCount: 2, memberKeys: ['a', 'b'] });
  assert.equal(r.find(c => c.type === 'SignersRemoved')?.severity, 'CRITICAL');
});

test('timelock removed is CRITICAL, added is HIGH', () => {
  const withTl = { ...base, timeLock: 3600 };
  assert.deepEqual(classifyV4Change(withTl, base).map(c => [c.type, c.severity]), [['TimelockRemoved', 'CRITICAL']]);
  assert.deepEqual(classifyV4Change(base, withTl).map(c => [c.type, c.severity]), [['TimelockAdded', 'HIGH']]);
});

test('external admin key added on a multisig is CRITICAL', () => {
  const r = classifyV4Change(base, { ...base, configAuthority: 'Key1111111111111111111111111111111111111111' });
  assert.deepEqual(r.map(c => [c.type, c.severity]), [['ExternalAdminKeyAdded', 'CRITICAL']]);
});

test('System Program config authority reads as autonomous', () => {
  assert.equal(normaliseConfigAuthority('11111111111111111111111111111111'), 'autonomous');
  assert.equal(normaliseConfigAuthority(null), 'autonomous');
});

test('overallSeverity picks the highest', () => {
  assert.equal(overallSeverity([{ severity: 'MONITOR' }, { severity: 'CRITICAL' }, { severity: 'HIGH' }]), 'CRITICAL');
  assert.equal(overallSeverity([]), 'MONITOR');
});

// Negative case from the 2026-08-14 Pump.fun phantom: a ProgramData write with no redeploy must not
// read as an upgrade.
test('ProgramData write without deploy-slot advance is not an upgrade', () => {
  const d = decideProgramEvent({ prevAuthority: 'A', authority: 'A', prevDeploySlot: 100, deploySlot: 100, deployTime: 1, nowSec: 10_000_000 });
  assert.deepEqual(d, { isAuthorityChange: false, isRealUpgrade: false });
});

test('deploy slot advancing is an upgrade', () => {
  const d = decideProgramEvent({ prevAuthority: 'A', authority: 'A', prevDeploySlot: 100, deploySlot: 200, deployTime: null, nowSec: 0 });
  assert.equal(d.isRealUpgrade, true);
});

test('no baseline: only a deploy in the last 30 minutes counts', () => {
  assert.equal(decideProgramEvent({ authority: 'A', deploySlot: 5, deployTime: 1000, nowSec: 1000 + 60 }).isRealUpgrade, true);
  assert.equal(decideProgramEvent({ authority: 'A', deploySlot: 5, deployTime: 1000, nowSec: 1000 + 3600 }).isRealUpgrade, false);
});

test('authority change fires without a redeploy; no baseline is never an authority change', () => {
  assert.equal(decideProgramEvent({ prevAuthority: 'A', authority: 'B', prevDeploySlot: 1, deploySlot: 1, deployTime: null, nowSec: 0 }).isAuthorityChange, true);
  assert.equal(decideProgramEvent({ authority: 'B', deploySlot: 1, deployTime: null, nowSec: 0 }).isAuthorityChange, false);
});

test('program severity ladder', () => {
  assert.equal(classifyProgramSeverity({ name: 'Drift V2', role: 'holds-funds', isAuthorityChange: true, hourUtc: 12 }).severity, 'CRITICAL');
  assert.equal(classifyProgramSeverity({ name: 'Drift V2', role: 'holds-funds', isAuthorityChange: false, hourUtc: 12 }).severity, 'HIGH');
  assert.equal(classifyProgramSeverity({ name: 'Jupiter Agg', role: 'routes-funds', isAuthorityChange: false, hourUtc: 12 }).severity, 'MONITOR');
  assert.equal(classifyProgramSeverity({ name: 'Jupiter Agg', role: 'routes-funds', isAuthorityChange: false, hourUtc: 23 }).severity, 'HIGH');
  assert.equal(classifyProgramSeverity({ name: 'BisonFi', role: 'peripheral', isAuthorityChange: false, hourUtc: 12 }).severity, 'CRITICAL');
});

test('readProgramData rejects non-ProgramData and reads authority + slot', () => {
  assert.equal(readProgramData(Buffer.alloc(10)), null);
  const buf = Buffer.alloc(45);
  buf.writeUInt32LE(3, 0);
  buf.writeBigUInt64LE(123n, 4);
  buf[12] = 0;
  assert.deepEqual(readProgramData(buf), { authority: 'IMMUTABLE', deploySlot: 123 });
});
