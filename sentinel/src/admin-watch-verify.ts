// Verifies Admin Watch targets against live accounts before the listener trusts them:
//   - the state account is owned by the target program
//   - its first 8 bytes are the Anchor discriminator of the named account type
//   - each field reads as a key, and is resolved against the vaults of every multisig on the watch list
// Prints a report; with --stamp, writes `verified` (date + discriminator) onto each target that passes
// the first two checks. Field values are for a human to confirm against the protocol's known multisig.
//
//   npx ts-node --transpile-only src/admin-watch-verify.ts [--stamp]

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { readAdminFields, type AdminTarget } from './detectors/admin-watch';
import { vaultPda } from './replay/squads-v4';
import { WATCH_LIST } from './watch-list';

const TARGETS = path.join(__dirname, '..', 'data', 'admin-watch', 'targets.json');
export const accountDisc = (name: string) => crypto.createHash('sha256').update('account:' + name).digest().subarray(0, 8).toString('hex');

(async () => {
  const stamp = process.argv.includes('--stamp');
  const targets: (AdminTarget & { accountType: string; verified?: string; discriminator?: string })[] = JSON.parse(fs.readFileSync(TARGETS, 'utf-8'));
  const conn = new Connection(process.env.HELIUS_RPC_URL!, 'confirmed');
  const vaults = new Map<string, string>();
  for (const w of WATCH_LIST) if (w.type === 'v4') vaults.set(vaultPda(w.address), `${w.name} (${w.address.slice(0, 8)}...) vault`);
  const infos = await conn.getMultipleAccountsInfo(targets.map(t => new PublicKey(t.account)));
  const today = new Date().toISOString().slice(0, 10);
  targets.forEach((t, i) => {
    const info = infos[i];
    console.log(`\n== ${t.name} (${t.account})`);
    if (!info) { console.log('  FAIL account not found'); return; }
    const ownerOk = info.owner.toBase58() === t.programId;
    const disc = info.data.subarray(0, 8).toString('hex');
    const discOk = disc === accountDisc(t.accountType);
    console.log(`  owner ${ownerOk ? 'OK' : 'FAIL ' + info.owner.toBase58()}; discriminator ${discOk ? 'OK' : 'FAIL'} (${t.accountType}); ${info.data.length} bytes`);
    const fields = readAdminFields(t, info.data) || {};
    for (const f of t.fields) {
      const v = fields[f.name];
      console.log(`  ${f.name.padEnd(30)} @${String(f.offset).padEnd(3)} ${v}  ${v && vaults.get(v) ? '= ' + vaults.get(v) : v === 'NONE' ? '(empty)' : '(not a watch-list multisig vault)'}`);
    }
    if (stamp && ownerOk && discOk) { t.verified = today; t.discriminator = disc; }
  });
  if (stamp) { fs.writeFileSync(TARGETS, JSON.stringify(targets, null, 2) + '\n'); console.log('\nStamped passing targets.'); }
})();
