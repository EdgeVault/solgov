// Read-only audit of the dashboard's static protocol data against on-chain state.
//
// The dashboard overlays live state from the API, but protocols.ts is the source of truth that
// the notes, snapshots and README counts are written from, and it drifts between sweeps. This
// script reports every difference so the file can be brought back in line by hand:
//
//   1. Multisig config: for each Squads V4 multisig in protocols.ts (headline entry and every
//      governanceRoles row marked verified), compare threshold, member count, voter count,
//      timelock, configAuthority and the member list with the on-chain account.
//   2. Program authority: for each listed program, read the ProgramData upgrade authority and
//      check it matches the listed authority and derives from one of the protocol's listed
//      multisigs (Squads V4 vault 0..3). A program whose authority derives from no listed
//      multisig is either mis-attributed or governed by a multisig the entry does not show.
//
// Known findings that are not drift (as of 2026-09-16): Raydium's Treasury role is a Squads V3
// account; Ore's activeVoters counts signers active on-chain, not vote permissions; deBridge's
// program authority is a PDA of its own governance program, two layers above the Squads vault.
//
// Nothing is written. Run from sentinel/: npm run audit:static

import * as fs from 'fs';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import { getConnection } from './utils/connection';
import { BPF_UPGRADEABLE_LOADER, SQUADS_V4_PROGRAM } from './utils/constants';

const PROTOCOLS_TS = path.join(__dirname, '..', '..', 'public-dashboard', 'src', 'data', 'protocols.ts');
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Entry {
  name: string; version?: string; multisigAddress?: string; authorityAddress?: string;
  threshold: number; totalMembers: number; activeVoters: number; timelockSeconds: number; configAuthority?: string;
  members: { key: string; role: string }[];
  roles: { role: string; threshold: number; total: number; timelock: string; address: string }[];
  programs: { name: string; id: string; authority: string | null }[];
}

// Splits the PROTOCOLS array into entry source blocks and pulls the audited fields out of each.
// A text parse rather than an import so the script needs no TS/JSX toolchain for the dashboard.
function parseEntries(src: string): Entry[] {
  const start = src.indexOf('export const PROTOCOLS');
  const body = src.slice(src.indexOf('= [', start) + 2);
  const blocks: string[] = [];
  let depth = 0, cur: number | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') { if (depth === 1) cur = i; depth++; }
    else if (c === '}') { depth--; if (depth === 1 && cur !== null) { blocks.push(body.slice(cur, i + 1)); cur = null; } }
    else if (c === '[' && depth === 0) depth = 1;
    else if (c === ']' && depth === 1) break;
  }
  const out: Entry[] = [];
  for (const e of blocks) {
    const name = /^\s*name:\s*'([^']+)'/m.exec(e)?.[1];
    if (!name) continue;
    const num = (k: string) => Number(new RegExp(`^\\s{4}${k}:\\s*(-?\\d+)`, 'm').exec(e)?.[1] ?? 0);
    const str = (k: string) => new RegExp(`^\\s{4}${k}:\\s*'([^']*)'`, 'm').exec(e)?.[1];
    const membersBlock = /^\s{4}members:\s*\[([\s\S]*?)^\s{4}\]/m.exec(e)?.[1] || '';
    const members = [...membersBlock.matchAll(/key:\s*'([^']+)',\s*role:\s*'([^']+)'/g)].map(m => ({ key: m[1], role: m[2] }));
    const roles = [...e.matchAll(/\{\s*role:\s*'([^']+)'[^}]*?threshold:\s*'(\d+)\/(\d+)'[^}]*?timelock:\s*'([^']+)'[^}]*?address:\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'[^}]*?status:\s*'verified'/g)]
      .map(m => ({ role: m[1], threshold: +m[2], total: +m[3], timelock: m[4], address: m[5] }));
    const programsBlock = /^\s{4}programs:\s*\[([\s\S]*?)^\s{4}\]/m.exec(e)?.[1] || '';
    const programs = [...programsBlock.matchAll(/\{\s*name:\s*'([^']+)',\s*id:\s*'([^']+)'(?:,\s*authority:\s*'([^']+)')?/g)]
      .map(m => ({ name: m[1], id: m[2], authority: m[3] || null }));
    out.push({
      name, version: str('version'), multisigAddress: str('multisigAddress'), authorityAddress: str('authorityAddress'),
      threshold: num('threshold'), totalMembers: num('totalMembers'), activeVoters: num('activeVoters'), timelockSeconds: num('timelockSeconds'),
      configAuthority: str('configAuthority'), members, roles, programs,
    });
  }
  return out;
}

const roleOf = (mask: number) =>
  mask === 7 ? 'Full' : mask === 1 ? 'Propose' : mask === 2 ? 'Vote' : mask === 4 ? 'Execute'
  : mask === 3 ? 'Propose + Vote' : mask === 5 ? 'Propose + Execute' : mask === 6 ? 'Vote + Execute' : 'None';

// Matches the timelock labels used in governanceRoles rows ('None', '24h', '10min', ...).
const timelockLabel = (s: number) =>
  s === 0 ? 'None' : s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}min` : `${s}s`;

function vaultsOf(ms: string): Set<string> {
  const out = new Set<string>();
  let pk: PublicKey;
  try { pk = new PublicKey(ms); } catch { return out; }
  out.add(ms);
  for (let i = 0; i < 4; i++) out.add(multisig.getVaultPda({ multisigPda: pk, index: i })[0].toBase58());
  return out;
}

async function main() {
  const conn = getConnection();
  const entries = parseEntries(fs.readFileSync(PROTOCOLS_TS, 'utf-8'));
  console.log(`protocols.ts: ${entries.length} entries, ${entries.reduce((n, e) => n + e.programs.length, 0)} programs\n`);
  let findings = 0;

  console.log('== Multisig config vs on-chain');
  for (const e of entries) {
    const checks: { label: string; addr: string; role?: Entry['roles'][number] }[] = [];
    if (e.version === 'Squads V4' && BASE58.test(e.multisigAddress || '')) checks.push({ label: 'headline', addr: e.multisigAddress! });
    for (const r of e.roles) if (r.address !== e.multisigAddress) checks.push({ label: `role:${r.role}`, addr: r.address, role: r });
    for (const c of checks) {
      let m: multisig.accounts.Multisig;
      try { m = await multisig.accounts.Multisig.fromAccountAddress(conn, new PublicKey(c.addr)); }
      catch { console.log(`  ${e.name} [${c.label}] ${c.addr}: not a Squads V4 multisig account`); findings++; continue; }
      await sleep(120);
      const onT = m.threshold, onN = m.members.length, onTl = Number(m.timeLock);
      const onV = m.members.filter(x => x.permissions.mask & 2).length;
      const onCfg = m.configAuthority.toBase58() === '11111111111111111111111111111111' ? 'autonomous' : m.configAuthority.toBase58();
      const diffs: string[] = [];
      if (c.role) {
        if (c.role.threshold !== onT) diffs.push(`threshold ${c.role.threshold}->${onT}`);
        if (c.role.total !== onN) diffs.push(`members ${c.role.total}->${onN}`);
        if (c.role.timelock !== timelockLabel(onTl) && !(c.role.timelock === '24h' && onTl === 86400)) diffs.push(`timelock ${c.role.timelock}->${timelockLabel(onTl)}`);
      } else {
        if (e.threshold !== onT) diffs.push(`threshold ${e.threshold}->${onT}`);
        if (e.totalMembers !== onN) diffs.push(`members ${e.totalMembers}->${onN}`);
        if (e.activeVoters !== onV) diffs.push(`voters ${e.activeVoters}->${onV}`);
        if (e.timelockSeconds !== onTl) diffs.push(`timelock ${e.timelockSeconds}->${onTl}`);
        if (e.configAuthority && e.configAuthority !== onCfg) diffs.push(`configAuthority ${e.configAuthority.slice(0, 8)}->${onCfg.slice(0, 8)}`);
        const onKeys = new Map(m.members.map(x => [x.key.toBase58(), roleOf(x.permissions.mask)]));
        const gone = e.members.filter(x => !onKeys.has(x.key)).map(x => x.key.slice(0, 6));
        const added = [...onKeys.keys()].filter(k => !e.members.some(x => x.key === k)).map(k => k.slice(0, 6));
        const roleDiff = e.members.filter(x => onKeys.has(x.key) && onKeys.get(x.key) !== x.role).map(x => `${x.key.slice(0, 6)}:${x.role}->${onKeys.get(x.key)}`);
        if (gone.length) diffs.push(`members gone ${gone.join(',')}`);
        if (added.length) diffs.push(`members new ${added.join(',')}`);
        if (roleDiff.length) diffs.push(`roles ${roleDiff.join(',')}`);
      }
      if (diffs.length) { console.log(`  ${e.name} [${c.label}] ${c.addr.slice(0, 8)}: ${diffs.join('; ')}`); findings++; }
    }
  }

  console.log('\n== Program upgrade authority vs on-chain');
  const all = entries.flatMap(e => e.programs.filter(p => BASE58.test(p.id)).map(p => ({ e, p })));
  const pdas = all.map(a => PublicKey.findProgramAddressSync([new PublicKey(a.p.id).toBuffer()], BPF_UPGRADEABLE_LOADER)[0]);
  const infos: (Awaited<ReturnType<typeof conn.getMultipleAccountsInfo>>[number])[] = [];
  for (let i = 0; i < pdas.length; i += 100) { infos.push(...await conn.getMultipleAccountsInfo(pdas.slice(i, i + 100))); await sleep(300); }
  const linkedPerProtocol: Record<string, { total: number; linked: number; immutable: number }> = {};
  all.forEach((a, i) => {
    const info = infos[i];
    let onChain = 'no-programdata';
    if (info && info.data.length >= 45) onChain = info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)).toBase58() : 'immutable';
    const linkSet = new Set<string>([...vaultsOf(a.e.multisigAddress || ''), ...vaultsOf(a.e.authorityAddress || ''), ...a.e.roles.flatMap(r => [...vaultsOf(r.address)])]);
    const linked = linkSet.has(onChain);
    const st = linkedPerProtocol[a.e.name] = linkedPerProtocol[a.e.name] || { total: 0, linked: 0, immutable: 0 };
    st.total++; if (onChain === 'immutable') st.immutable++; else if (linked) st.linked++;
    const listed = a.p.authority === 'IMMUTABLE' ? 'immutable' : a.p.authority;
    if (listed && listed !== onChain && onChain !== 'no-programdata') {
      console.log(`  ${a.e.name} / ${a.p.name} ${a.p.id}: listed ${listed} on-chain ${onChain}${linked ? '' : ' (not derived from a listed multisig)'}`); findings++;
    } else if (!listed && !linked && onChain !== 'immutable' && onChain !== 'no-programdata') {
      console.log(`  ${a.e.name} / ${a.p.name}: on-chain ${onChain} not derived from a listed multisig`); findings++;
    }
  });
  const unlinked = Object.entries(linkedPerProtocol).filter(([, s]) => s.linked === 0 && s.total > s.immutable);
  if (unlinked.length) {
    console.log('\n== Protocols where no listed program derives from a listed multisig (check attribution or add the governing multisig)');
    for (const [n, s] of unlinked) console.log(`  ${n}: ${s.total} programs, ${s.immutable} immutable`);
    findings += unlinked.length;
  }
  console.log(`\n${findings} finding(s). Nothing was written.`);
}

main().catch(e => { console.error(e); process.exit(1); });
