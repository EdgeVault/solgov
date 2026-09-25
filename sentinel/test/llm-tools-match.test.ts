import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameMatches, resolveName, findNonceInstruction } from '../src/llm-tools';

const KEYS = ['Drift', 'Pump.fun', 'Jupiter Perps', 'Jupiter Lend', 'Save (Solend)', 'Phoenix DEX', 'BisonFi'];

test('exact normalised names resolve regardless of case and punctuation', () => {
  assert.equal(resolveName(KEYS, 'drift'), 'Drift');
  assert.equal(resolveName(KEYS, 'Drift'), 'Drift');
  assert.equal(resolveName(KEYS, 'jupiter perps'), 'Jupiter Perps');
  assert.equal(resolveName(KEYS, 'Jupiter Lend'), 'Jupiter Lend');
  assert.equal(resolveName(KEYS, 'pumpfun'), 'Pump.fun');
});

test('exact match wins over an earlier prefix match', () => {
  assert.equal(resolveName(['Drift Vaults', 'Drift'], 'drift'), 'Drift');
});

test('a prefix of the name resolves, the reverse does not', () => {
  assert.equal(resolveName(KEYS, 'phoenix'), 'Phoenix DEX');
  assert.equal(resolveName(KEYS, 'Drift BonkDAO'), undefined);
  assert.equal(nameMatches('Drift', 'Drift BonkDAO'), false);
  assert.equal(nameMatches('Drift (Protocol V2)', 'Drift'), true);
});

test('parenthesised parts match on their own, on either side', () => {
  assert.equal(resolveName(KEYS, 'Solend'), 'Save (Solend)');
  assert.equal(resolveName(KEYS, 'BisonFi (AMM)'), 'BisonFi');
});

test('very short queries must match exactly', () => {
  assert.equal(nameMatches('Drift', 'dr'), false);
  assert.equal(nameMatches('', 'drift'), false);
  assert.equal(nameMatches('Drift', ''), false);
});

test('durable nonce detected from parsed System Program instructions, outer or inner', () => {
  const sys = '11111111111111111111111111111111';
  const outer = { transaction: { message: { instructions: [{ programId: sys, parsed: { type: 'advanceNonce' } }] } } };
  assert.equal(findNonceInstruction(outer), 'advanceNonce');
  const inner = {
    transaction: { message: { instructions: [{ programId: 'Other111', parsed: { type: 'x' } }] } },
    meta: { innerInstructions: [{ instructions: [{ programId: sys, parsed: { type: 'withdrawFromNonce' } }] }] },
  };
  assert.equal(findNonceInstruction(inner), 'withdrawFromNonce');
  const transferOnly = { transaction: { message: { instructions: [{ programId: sys, parsed: { type: 'transfer' } }] } } };
  assert.equal(findNonceInstruction(transferOnly), null);
  const wrongProgram = { transaction: { message: { instructions: [{ programId: 'Other111', parsed: { type: 'advanceNonce' } }] } } };
  assert.equal(findNonceInstruction(wrongProgram), null);
  assert.equal(findNonceInstruction(null), null);
});

test('rebrand alias: Velocity resolves to the Drift key', async () => {
  const { resolveName, resolveExactName, nameMatches } = await import('../src/llm-tools');
  const keys = ['Drift', 'Drift (interim recovery)', 'Kamino'];
  assert.equal(resolveName(keys, 'velocity'), 'Drift');
  assert.equal(resolveExactName(keys, 'Velocity'), 'Drift');
  assert.equal(nameMatches('Drift', 'velocity dex'), true);
  assert.equal(resolveExactName(['Jupiter Perps', 'Jupiter Lend'], 'jupiter'), undefined);
});
