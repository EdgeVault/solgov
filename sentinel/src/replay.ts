// Detection replay: runs solgov's production detectors against any past window of on-chain history.
//
//   npm run replay -- <scenario-id>            scenario in data/replay/scenarios/<id>.json
//   npm run replay -- <scenario-id> --offline  cached history only, no RPC at all
//   npm run replay -- <scenario-id> --refresh  top up cached histories to the tip
//
// History is cached in data/replay/history/ (first read: 50 credits per 100 transactions; later runs
// are free). Each rebuilt multisig, program and admin field is checked against a live account read;
// anything that does not match is reported as unverified. Output: data/replay/results/<id>.json.

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { ensureHistory, loadHistory } from './replay/history';
import { runReplay, historyAddresses, type Scenario, type LiveCoverage, type ReplayEvent } from './replay/engine';
import { rebuildV4, verifyAgainstLive } from './replay/squads-v4';
import { rebuildProgram, programDataAddress } from './replay/program';
import { rebuildAdmin } from './replay/admin';
import { readAdminFields, type AdminTarget } from './detectors/admin-watch';
import { readProgramData } from './detectors/program-upgrade';
import { WATCH_LIST } from './watch-list';
import { writeJsonAtomic } from './utils/json-file';

const DATA = path.join(__dirname, '..', 'data');
const SCENARIOS = path.join(DATA, 'replay', 'scenarios');
const RESULTS = path.join(DATA, 'replay', 'results');

export function loadLiveCoverage(): LiveCoverage {
  const programs = new Set<string>();
  try { for (const p of JSON.parse(fs.readFileSync(path.join(DATA, 'programs', 'tracked-program-watch.json'), 'utf-8'))) programs.add(p.programId); } catch {}
  const adminAccounts = new Set<string>();
  try { for (const t of JSON.parse(fs.readFileSync(path.join(DATA, 'admin-watch', 'targets.json'), 'utf-8'))) adminAccounts.add(t.account); } catch {}
  return { multisigs: new Set(WATCH_LIST.map(w => w.address)), programs, adminAccounts };
}

async function verify(conn: Connection, s: Scenario, histories: Record<string, any[]>) {
  const out: { account: string; name: string; verified: boolean; detail: string }[] = [];
  const msInfos = await conn.getMultipleAccountsInfo(s.multisigs.map(m => new PublicKey(m.address)));
  s.multisigs.forEach((m, i) => {
    const { final } = rebuildV4(m.address, histories[m.address] || []);
    const info = msInfos[i];
    if (!final || !info) { out.push({ account: m.address, name: m.name, verified: false, detail: !final ? 'no create instruction found in history' : 'account not found' }); return; }
    const [live] = multisig.accounts.Multisig.fromAccountInfo(info);
    const diffs = verifyAgainstLive(final, live);
    out.push({ account: m.address, name: m.name, verified: diffs.length === 0, detail: diffs.length ? diffs.join('; ') : `matches live (${final.threshold} of ${final.members.length})` });
  });
  const pdKeys = s.programs.map(p => programDataAddress(p.programId));
  const pdInfos = await conn.getMultipleAccountsInfo(pdKeys.map(k => new PublicKey(k)));
  s.programs.forEach((p, i) => {
    const { final } = rebuildProgram(pdKeys[i], histories[pdKeys[i]] || []);
    const live = pdInfos[i] ? readProgramData(pdInfos[i]!.data) : null;
    const ok = !!final && !!live && final.authority === live.authority && final.deploySlot === live.deploySlot;
    out.push({ account: p.programId, name: p.name, verified: ok, detail: ok ? 'authority and deploy slot match live' : `rebuilt ${final?.authority?.slice(0, 8)}@${final?.deploySlot} vs live ${live?.authority?.slice(0, 8)}@${live?.deploySlot}` });
  });
  for (const a of s.admin || []) {
    const info = await conn.getAccountInfo(new PublicKey(a.account));
    const live = info ? readAdminFields(a as AdminTarget, info.data) : null;
    const merged = a.historyFrom.flatMap(h => histories[h] || []).sort((x: any, y: any) => x.slot - y.slot);
    const changes = rebuildAdmin(a as AdminTarget, merged);
    for (const f of a.fields) {
      const last = [...changes].reverse().find(c => c.field === f.name);
      const ok = !!live && !!last && live[f.name] === last.after;
      out.push({ account: a.account, name: `${a.name} (${f.name})`, verified: ok, detail: ok ? 'last rebuilt value matches live' : `rebuilt ${last?.after?.slice(0, 8) ?? 'none'} vs live ${live?.[f.name]?.slice(0, 8) ?? 'unread'} (a later change outside the replayed histories reads as a mismatch)` });
    }
  }
  return out;
}

function fmt(e: ReplayEvent): string {
  const sev = e.severity ? e.severity.padEnd(8) : 'observed';
  const route = e.detector === 'observation' ? '' : ` [risk team: ${e.routing.riskTeam}${e.routing.public ? ', public' : ''}${e.routing.watchedLive ? '' : ', NOT WATCHED LIVE'}]`;
  return `${e.date.slice(0, 16).replace('T', ' ')}  ${sev} ${e.source}: ${e.detail}${route}\n                   ${e.detector}/${e.type}  ${e.signature}`;
}

async function main() {
  const args = process.argv.slice(2);
  const id = args.find(a => !a.startsWith('--'));
  if (!id) throw new Error('usage: npm run replay -- <scenario-id> [--offline] [--refresh]');
  const offline = args.includes('--offline');
  const refresh = args.includes('--refresh');
  const s: Scenario = JSON.parse(fs.readFileSync(path.join(SCENARIOS, `${id}.json`), 'utf-8'));
  const rpc = process.env.HELIUS_RPC_URL || '';
  if (!offline && !rpc) throw new Error('HELIUS_RPC_URL is not set (or pass --offline)');

  const histories: Record<string, any[]> = {};
  let pages = 0;
  for (const addr of historyAddresses(s)) {
    if (offline) {
      const f = loadHistory(addr);
      if (!f) throw new Error(`--offline: no cached history for ${addr}`);
      histories[addr] = f.txs;
    } else {
      const r = await ensureHistory(rpc, addr, { refresh });
      histories[addr] = r.file.txs;
      pages += r.pages;
      console.log(`  history ${addr.slice(0, 8)}... ${r.file.txs.length} txs${r.pages ? ` (${r.pages} page(s) read)` : ' (cached)'}`);
    }
  }
  if (pages) console.log(`  ${pages} history page(s), about ${pages * 50} credits`);

  const result = runReplay(s, histories, loadLiveCoverage());
  const verification = offline ? [] : await verify(new Connection(rpc, 'confirmed'), s, histories);

  console.log(`\n=== ${s.title} ===`);
  for (const w of [...s.windows.map(w => w.label), null]) {
    const evs = result.events.filter(e => e.window === w);
    if (!evs.length) continue;
    console.log(`\n--- ${w ?? 'outside the scenario windows'} (${evs.length}) ---`);
    if (w === null) { console.log(`  (${evs.filter(e => e.detector !== 'observation').length} detector events; see results file)`); continue; }
    for (const e of evs) console.log(fmt(e));
  }
  if (verification.length) {
    console.log('\n--- verification against live accounts ---');
    for (const v of verification) console.log(`  ${v.verified ? 'OK  ' : 'FAIL'} ${v.name}: ${v.detail}`);
  }
  if (Object.keys(result.undecoded).length) console.log('\nUndecoded instructions:', JSON.stringify(result.undecoded));

  fs.mkdirSync(RESULTS, { recursive: true });
  writeJsonAtomic(path.join(RESULTS, `${id}.json`), {
    ...result,
    generatedAt: new Date().toISOString(),
    assumptions: [
      'Detectors are the production code (src/detectors/), run at every rebuilt state change.',
      'routing shows what the live alert path does with the event if the account is watched; watchedLive says whether it is on the live watch list today.',
      'Creation and first-seen states are observations: visible facts the live rules do not alert on by themselves.',
    ],
    verification,
  });
  console.log(`\nWrote data/replay/results/${id}.json`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
