// solgov-check: compare a protocol's live on-chain governance (via solgov.xyz) with values the team
// has committed, and fail CI on drift. Everything compared is a fact read from chain; the action
// makes no judgement about whether a value is good.
import { readFileSync, appendFileSync } from 'node:fs';

const protocol = process.env.SOLGOV_PROTOCOL;
const expectedPath = process.env.SOLGOV_EXPECTED || '.solgov.json';
const failOnDrift = String(process.env.SOLGOV_FAIL ?? 'true').toLowerCase() !== 'false';
const base = (process.env.SOLGOV_API_BASE || 'https://solgov.xyz').replace(/\/$/, '');

if (!protocol) { console.error('solgov-check: input "protocol" is required'); process.exit(2); }

let expected;
try { expected = JSON.parse(readFileSync(expectedPath, 'utf8')); }
catch (e) { console.error(`solgov-check: cannot read ${expectedPath}: ${e.message}`); process.exit(2); }

const res = await fetch(`${base}/api/v1/governance/${encodeURIComponent(protocol)}`, { headers: { 'User-Agent': 'solgov-check/0.1' } });
if (!res.ok) { console.error(`solgov-check: API ${res.status} for ${protocol}: ${(await res.text()).slice(0, 200)}`); process.exit(2); }
const live = await res.json();

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

const rows = [];
let drifted = false;
for (const [key, want] of Object.entries(expected)) {
  if (!(key in readers)) { rows.push([key, JSON.stringify(want), '(not a comparable field)', 'skipped']); continue; }
  const got = readers[key](live);
  const wantN = Array.isArray(want) ? [...want].sort() : want;
  const same = JSON.stringify(wantN) === JSON.stringify(got);
  if (!same) drifted = true;
  rows.push([key, JSON.stringify(wantN), JSON.stringify(got), same ? 'ok' : 'DRIFT']);
}

const width = (i) => Math.max(...rows.map(r => String(r[i]).length), 6);
console.log(`solgov-check: ${protocol}  (live as of ${live.lastChecked || live.asOf || 'unknown'}, staleness ${live.stalenessHours ?? '?'}h)\n`);
console.log(['field', 'expected', 'live', 'status'].map((h, i) => h.padEnd(Math.min(width(i), 60))).join('  '));
for (const r of rows) console.log(r.map((c, i) => String(c).slice(0, 60).padEnd(Math.min(width(i), 60))).join('  '));

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `drifted=${drifted}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `live<<EOF\n${JSON.stringify(live)}\nEOF\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['| field | expected | live | status |', '|---|---|---|---|', ...rows.map(r => `| ${r[0]} | \`${String(r[1]).slice(0, 80)}\` | \`${String(r[2]).slice(0, 80)}\` | ${r[3]} |`)].join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## solgov governance check: ${protocol}\n\n${md}\n\nSource: ${base}/api/v1/governance/${encodeURIComponent(protocol)}\n`);
}

if (drifted) {
  console.log(`\nsolgov-check: live governance differs from ${expectedPath}.`);
  process.exit(failOnDrift ? 1 : 0);
}
console.log('\nsolgov-check: live governance matches the committed expectation.');
