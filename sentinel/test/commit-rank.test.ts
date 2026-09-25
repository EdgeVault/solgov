import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCommitMessage } from '../src/utils/commit-rank';

const cases: [string, 'high' | 'low' | null][] = [
  ['Fix rounding error in liquidation math', 'high'],
  ['hotfix: overflow in collateral calc', 'high'],
  ['Prevent unauthorised withdraw path', 'high'],
  ['Fix caching bug in rangeproof caching', 'low'],
  ['Add bounds check on tick index', 'low'],
  ['fix: typo in error message', 'low'],
  ['docs: update README', null],
  ['chore(deps): bump anchor to 0.31', null],
  ['fix(ci): flaky test on windows', null],
  ['feat(sdk): expose new client method', null],
  ['Add new pool type', null],
  ['', null],
];

for (const [msg, expected] of cases) {
  test(`rank "${msg || '<empty>'}" -> ${expected}`, () => {
    assert.equal(rankCommitMessage(msg), expected);
  });
}

test('only the first line of a message is ranked', () => {
  assert.equal(rankCommitMessage('Add new pool type\n\nAlso fixes a security issue'), null);
});
