// Latest deploy of every tracked program, read from its ProgramData account.
//
// ProgramData stores the slot of the last deploy or upgrade, so this is the authoritative source for
// a protocol's "last upgrade" date. The activity log only holds recent events and misses upgrades that
// scrolled out of it. Slot times are cached in the output, so a run only looks up slots it has not
// seen: normally two batched account reads and nothing else.
//
// Output: data/program-deploys.json
//   programs[programId] = { protocol, name, deploySlot, deployedAt, authority, sizeKB }
//   protocols[name]     = { lastDeployAt, programId }   (latest deploy across the protocol's programs)

import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import 'dotenv/config';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';
import { protocolsSourcePath } from './utils/protocols-source';

const OUT_FILE = path.join(__dirname, '..', 'data', 'program-deploys.json');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

interface TrackedProgram { protocol: string; name: string; id: string }
interface ProgramDeploy { protocol: string; name: string; deploySlot: number | null; deployedAt: string | null; authority: string | null; sizeKB?: number; readError?: string }
interface Snapshot {
  scannedAt: string;
  complete: boolean;
  programs: Record<string, ProgramDeploy>;
  protocols: Record<string, { lastDeployAt: string; programId: string }>;
  slotTimes: Record<string, string>;
}

export function programsFromProtocolsSource(src: string): TrackedProgram[] {
  const out: TrackedProgram[] = [];
  for (const block of src.split(/\n    name: '/).slice(1)) {
    const protocol = block.slice(0, block.indexOf("'"));
    const programs = /\n    programs: \[([\s\S]*?)\n    \]/.exec(block)?.[1] || '';
    for (const m of programs.matchAll(/\{ name: '([^']+)', id: '([1-9A-HJ-NP-Za-km-z]{32,44})'/g)) out.push({ protocol, name: m[1], id: m[2] });
  }
  return out;
}

// Latest deploy per protocol from per-program results.
export function latestByProtocol(programs: Record<string, ProgramDeploy>): Snapshot['protocols'] {
  const out: Snapshot['protocols'] = {};
  for (const [id, p] of Object.entries(programs)) {
    if (!p.deployedAt) continue;
    const cur = out[p.protocol];
    if (!cur || p.deployedAt > cur.lastDeployAt) out[p.protocol] = { lastDeployAt: p.deployedAt, programId: id };
  }
  return out;
}

async function main() {
  const rpc = process.env.HELIUS_RPC_URL;
  if (!rpc) throw new Error('HELIUS_RPC_URL is not set');
  const conn = new Connection(rpc, 'confirmed');
  const tracked = programsFromProtocolsSource(fs.readFileSync(protocolsSourcePath(), 'utf-8'));
  if (!tracked.length) throw new Error('no programs parsed from protocols.ts; snapshot not written');

  let previous: Snapshot | null = null;
  try { previous = readJsonStrict<Snapshot | null>(OUT_FILE, null); } catch { previous = null; }
  const slotTimes: Record<string, string> = { ...(previous?.slotTimes || {}) };

  const pdas = tracked.map(t => PublicKey.findProgramAddressSync([new PublicKey(t.id).toBuffer()], LOADER)[0]);
  const programs: Record<string, ProgramDeploy> = {};
  let complete = true;
  for (let i = 0; i < pdas.length; i += 100) {
    let infos;
    try { infos = await conn.getMultipleAccountsInfo(pdas.slice(i, i + 100)); } catch (e: any) {
      complete = false;
      tracked.slice(i, i + 100).forEach(t => { programs[t.id] = { protocol: t.protocol, name: t.name, deploySlot: null, deployedAt: null, authority: null, readError: String(e?.message || e).slice(0, 120) }; });
      continue;
    }
    infos.forEach((info, j) => {
      const t = tracked[i + j];
      if (!info || info.data.length < 45 || info.data.readUInt32LE(0) !== 3) {
        // Not an upgradeable program (or closed): no deploy slot to report.
        programs[t.id] = { protocol: t.protocol, name: t.name, deploySlot: null, deployedAt: null, authority: null, readError: info ? 'not a ProgramData account' : 'no ProgramData account' };
        return;
      }
      const deploySlot = Number(info.data.readBigUInt64LE(4));
      const authority = info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)).toBase58() : 'IMMUTABLE';
      programs[t.id] = { protocol: t.protocol, name: t.name, deploySlot, deployedAt: null, authority, sizeKB: Math.round((info.data.length - 45) / 1024) };
    });
  }

  let lookups = 0;
  for (const p of Object.values(programs)) {
    if (p.deploySlot === null) continue;
    const key = String(p.deploySlot);
    if (!slotTimes[key]) {
      try {
        const t = await conn.getBlockTime(p.deploySlot);
        lookups++;
        if (t) slotTimes[key] = new Date(t * 1000).toISOString();
      } catch { complete = false; }
      await new Promise(r => setTimeout(r, 60));
    }
    p.deployedAt = slotTimes[key] || null;
  }

  // Keep only slot times still referenced, so the cache does not grow without bound.
  const used = new Set(Object.values(programs).map(p => String(p.deploySlot)));
  for (const k of Object.keys(slotTimes)) if (!used.has(k)) delete slotTimes[k];

  const snapshot: Snapshot = { scannedAt: new Date().toISOString(), complete, programs, protocols: latestByProtocol(programs), slotTimes };
  writeJsonAtomic(OUT_FILE, snapshot);
  console.log(`${tracked.length} programs, ${Object.keys(snapshot.protocols).length} protocols with a deploy date, ${lookups} new slot lookup(s)${complete ? '' : ' (incomplete)'}. Wrote ${OUT_FILE}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
