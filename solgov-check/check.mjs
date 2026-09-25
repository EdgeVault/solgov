// solgov-check: compare a protocol's live on-chain governance (via solgov.xyz) with values the team
// has committed, and fail CI on drift. Everything compared is a fact read from chain; the action
// makes no judgement about whether a value is good.
//
// Exit codes: 0 live matches the expectation; 1 drift (only when fail-on-drift is true); 2 the check
// could not run or could not be trusted (bad input, unknown expectation key, fetch or parse error,
// the API answered for a different protocol, or the live state is older than max-age-hours).
import { readFileSync, appendFileSync } from 'node:fs';

const protocol = process.env.SOLGOV_PROTOCOL;
const expectedPath = process.env.SOLGOV_EXPECTED || '.solgov.json';
const failOnDrift = String(process.env.SOLGOV_FAIL ?? 'true').toLowerCase() !== 'false';
const base = (process.env.SOLGOV_API_BASE || 'https://solgov.xyz').replace(/\/$/, '');
const maxAgeRaw = process.env.SOLGOV_MAX_AGE_HOURS ?? '48';
const TIMEOUT_MS = 15_000;

const fail = (msg) => { console.error(`solgov-check: ${msg}`); process.exit(2); };

if (!protocol) fail('input "protocol" is required');
const maxAgeHours = Number(maxAgeRaw);
if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) fail(`input "max-age-hours" must be a number of hours (0 disables the check), got "${maxAgeRaw}"`);

let expected;
try { expected = JSON.parse(readFileSync(expectedPath, 'utf8')); }
catch (e) { fail(`cannot read ${expectedPath}: ${e.message}`); }
if (!expected || typeof expected !== 'object' || Array.isArray(expected)) fail(`${expectedPath} must hold a JSON object of expected fields`);

// Fields a team can pin. Each maps an expectation key to how it is read from the live response.
// The governance endpoint nests multisig and timelock; older shapes are accepted as fallbacks.
const ms = l => l.multisig || l;
const memberKeys = l => { const m = ms(l).members; return Array.isArray(m) ? [...m.map(x => typeof x === 'string' ? x : (x.key || x.publicKey))].sort() : undefined; };
const readers = {
  threshold: l => ms(l).threshold,
  totalMembers: l => ms(l).totalMembers ?? (Array.isArray(ms(l).members) ? ms(l).members.length : undefined),
  timelockSeconds: l => l.timelock?.seconds ?? l.timeLock ?? l.timelockSeconds,
  configAuthority: l => l.configAuthority,
  members: l => memberKeys(l),
  programAuthorities: l => l.programAuthorities,
};

// A misspelt key used to be skipped, so a file holding only typos passed. Every key must be known.
const unknownKeys = Object.keys(expected).filter(k => !(k in readers));
if (unknownKeys.length) fail(`unknown field(s) in ${expectedPath}: ${unknownKeys.join(', ')}. Valid fields: ${Object.keys(readers).join(', ')}`);
if (!Object.keys(expected).length) fail(`${expectedPath} pins no fields`);

const url = `${base}/api/v1/governance/${encodeURIComponent(protocol)}`;
let live;
try {
  const res = await fetch(url, { headers: { 'User-Agent': 'solgov-check/0.1', Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) fail(`API ${res.status} for ${protocol}: ${body.slice(0, 200)}`);
  try { live = JSON.parse(body); } catch { fail(`API response for ${protocol} is not JSON: ${body.slice(0, 200)}`); }
} catch (e) {
  fail(`request to ${url} failed: ${e.message}`);
}
if (!live || typeof live !== 'object') fail(`API response for ${protocol} is not an object`);

// The API resolves names loosely; make sure the entry it returned is the one that was asked for.
if (typeof live.protocol !== 'string' || live.protocol.toLowerCase() !== protocol.toLowerCase()) {
  fail(`API returned protocol "${live.protocol ?? '(none)'}" for "${protocol}". Use the exact name from ${base}/api/v1/protocols`);
}

// Freshness gate: comparing against an old reading could pass while the chain has moved on.
const checkedAt = typeof live.lastChecked === 'string' ? Date.parse(live.lastChecked) : NaN;
const ageHours = Number.isFinite(checkedAt) ? (Date.now() - checkedAt) / 3_600_000
  : (typeof live.stalenessHours === 'number' ? live.stalenessHours : null);
if (maxAgeHours > 0) {
  if (ageHours === null) fail(`live state for ${live.protocol} carries no lastChecked time, so its age cannot be confirmed`);
  if (ageHours > maxAgeHours) fail(`live state for ${live.protocol} is ${ageHours.toFixed(1)}h old, above max-age-hours ${maxAgeHours}`);
}

// Order-independent comparison: object keys are sorted at every level and arrays are compared as
// sorted lists, so key order in .solgov.json or the API response never reads as drift.
const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical).map(x => JSON.stringify(x)).sort().map(x => JSON.parse(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
};

const rows = [];
let drifted = false;
for (const [key, want] of Object.entries(expected)) {
  const got = readers[key](live);
  const wantC = canonical(want);
  const gotC = canonical(got);
  const same = JSON.stringify(wantC) === JSON.stringify(gotC);
  if (!same) drifted = true;
  rows.push([key, JSON.stringify(wantC), JSON.stringify(gotC), same ? 'ok' : 'DRIFT']);
}

const width = (i) => Math.max(...rows.map(r => String(r[i]).length), 6);
console.log(`solgov-check: ${live.protocol}  (live as of ${live.lastChecked || live.asOf || 'unknown'}, age ${ageHours === null ? '?' : ageHours.toFixed(1)}h)\n`);
console.log(['field', 'expected', 'live', 'status'].map((h, i) => h.padEnd(Math.min(width(i), 60))).join('  '));
for (const r of rows) console.log(r.map((c, i) => String(c).slice(0, 60).padEnd(Math.min(width(i), 60))).join('  '));

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `drifted=${drifted}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `live<<EOF\n${JSON.stringify(live)}\nEOF\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['| field | expected | live | status |', '|---|---|---|---|', ...rows.map(r => `| ${r[0]} | \`${String(r[1]).slice(0, 80)}\` | \`${String(r[2]).slice(0, 80)}\` | ${r[3]} |`)].join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## solgov governance check: ${live.protocol}\n\n${md}\n\nSource: ${url} (live as of ${live.lastChecked || 'unknown'})\n`);
}

if (drifted) {
  console.log(`\nsolgov-check: live governance differs from ${expectedPath}.`);
  process.exit(failOnDrift ? 1 : 0);
}
console.log('\nsolgov-check: live governance matches the committed expectation.');
