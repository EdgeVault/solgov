// Ranks a commit message for the public-fix watch. Two layers, kept separate on purpose: whether a
// commit is ahead of the deployed build is a git fact; whether its message reads like a security fix
// is a heuristic for internal triage only. A keyword match is not evidence of a vulnerability.

// Commits scoped to docs, CI, tests, SDKs or release chores do not change program logic and are
// excluded before any keyword test.
export const NON_CODE_SCOPE = /^(docs?|doc|chore|ci|test|tests|build|style|refactor|release|bump|readme|changelog|lint|deps?)\s*(\(|:)|^(fix|feat|perf)\((ci|docs?|sdk|sdks|test|tests|build|deps|lint|typo|readme|examples?|client|clients|js|ts|py|python|api|ui|web|frontend)\)/i;

// A strong security word ranks high.
export const STRONG_WORDS = /security|vuln|exploit|overflow|underflow|reentran|bypass|unauthori[sz]|cve-|critical|hotfix|rounding|precision|drain|manipulat|invariant|solvency|liquidation/i;

// A generic fix-word ranks low but is kept: the Liquid fix was titled "Fix caching bug in rangeproof
// caching", which only a generic pattern would have caught.
export const WEAK_WORDS = /\b(fix|fixes|fixed|patch|cache|caching|verify|verification|validation|bounds|check|checks)\b/i;

export type CommitRank = 'high' | 'low' | null;

export function rankCommitMessage(message: string): CommitRank {
  const msg = String(message || '').split('\n')[0];
  if (NON_CODE_SCOPE.test(msg)) return null;
  if (STRONG_WORDS.test(msg)) return 'high';
  if (WEAK_WORDS.test(msg)) return 'low';
  return null;
}
