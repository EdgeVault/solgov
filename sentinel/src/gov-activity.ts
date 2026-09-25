// Governance activity per tracked multisig, computed from its full on-chain transaction history.
//
// Supersedes the dated GovWatch snapshot counts (public-dashboard/src/data/governance.ts) and the
// incremental-scan.ts overlay for every field that can be read mechanically from transactions:
// creation date, transaction count, executed config changes and their actions, proposal outcomes,
// who proposes / approves / executes, active signers over 90 days, proposal-to-execution times, fee
// payer concentration and spending-limit use. Fields that needed human research (time zones, hot
// wallets, funders, named signers) are not produced here.
//
// Every figure is keyed by multisig address, so a count can only ever attach to the multisig it was
// read from. The first run reads each multisig's whole history; later runs read only newer
// transactions (getTransactionsForAddress, 100 transactions per call, resumable at any point).
//
// Definitions:
//   totalTxs            successful transactions that reference the multisig account
//   created             date of the first successful transaction referencing it
//   configChanges       transactions that changed the multisig's configuration: executed config
//                       transactions (V4), or transactions in which the multisig ran config instructions
//                       on itself (V3, Serum), one per transaction; configDates are the UTC dates
//   approvedProposals   proposals that were executed (execution requires approval)
//   rejectedProposals   proposals with at least one rejection that were never executed
//   cancelledProposals  proposals with a cancellation
//   proposers/approvers/executors   distinct signing members for each step
//   rubberStampSigners  distinct signers who executed a transaction they had created
//   activeVoters90d     current members who signed any governance step in the last 90 days
//   neverSignedCount    current members with no governance step in the multisig's history
//   execute times       hours from transaction creation to execution, over all executed transactions
//   offHoursConfigChanges   config changes executed between 22:00 and 06:00 UTC
//
//   node -r ts-node/register/transpile-only src/gov-activity.ts [--only <address>] [--max-pages N]
//   --targets-only rewrites data/gov-activity-targets.json from protocols.ts without scanning; copy it
//   to the VPS after a headline multisig changes and the next run reads the new multisig's history.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import 'dotenv/config';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';

const DATA = path.join(__dirname, '..', 'data');
const PROTOCOLS_TS = path.join(__dirname, '..', '..', 'public-dashboard', 'src', 'data', 'protocols.ts');
const TARGETS_FILE = path.join(DATA, 'gov-activity-targets.json');
const STORE_FILE = path.join(DATA, 'gov-activity-store.json');
const OUT_FILE = path.join(DATA, 'gov-activity.json');

export const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
export const SQUADS_V3 = 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu';
export const SERUM = 'msigmtwzgXJHj2ext4XJjCDmpbcMuufFb5cHuwg6Xdt';

export type MsVersion = 'V4' | 'V3' | 'SERUM';
export interface Target { name: string; address: string; version: MsVersion }

// ---------------------------------------------------------------------------------------------
// Instruction decoding

const anchor = (name: string) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8).toString('hex');
const v4 = (k: string) => Buffer.from((multisig.generated as any)[k + 'InstructionDiscriminator']).toString('hex');

type Step =
  | { kind: 'create'; tx: string; by: string; actions?: ConfigActions }
  | { kind: 'proposal'; proposal: string; by: string }
  | { kind: 'approve' | 'reject' | 'cancel'; proposal: string; by: string }
  | { kind: 'execute'; tx: string; proposal: string; by: string | null; config: boolean }
  | { kind: 'config'; actions: ConfigActions; by: string | null }
  | { kind: 'owners'; owners: string[]; threshold?: number }
  | { kind: 'threshold' }
  | { kind: 'spend'; by: string };

export interface ConfigActions { add: number; remove: number; threshold: number; timelock: number; other: number }
const noActions = (): ConfigActions => ({ add: 0, remove: 0, threshold: 0, timelock: 0, other: 0 });

const V4_TABLE: Record<string, (a: string[], data: Buffer) => Step | null> = {
  [v4('vaultTransactionCreate')]: a => ({ kind: 'create', tx: a[1], by: a[2] }),
  [v4('vaultTransactionCreateFromBuffer')]: a => ({ kind: 'create', tx: a[1], by: a[2] }),
  [v4('batchCreate')]: a => ({ kind: 'create', tx: a[1], by: a[2] }),
  [v4('configTransactionCreate')]: (a, d) => ({ kind: 'create', tx: a[1], by: a[2], actions: decodeV4ConfigActions(d) }),
  [v4('proposalCreate')]: a => ({ kind: 'proposal', proposal: a[1], by: a[2] }),
  [v4('proposalApprove')]: a => ({ kind: 'approve', proposal: a[2], by: a[1] }),
  [v4('proposalReject')]: a => ({ kind: 'reject', proposal: a[2], by: a[1] }),
  [v4('proposalCancel')]: a => ({ kind: 'cancel', proposal: a[2], by: a[1] }),
  [v4('proposalCancelV2')]: a => ({ kind: 'cancel', proposal: a[2], by: a[1] }),
  [v4('vaultTransactionExecute')]: a => ({ kind: 'execute', proposal: a[1], tx: a[2], by: a[3], config: false }),
  [v4('batchExecuteTransaction')]: a => ({ kind: 'execute', proposal: a[2], tx: a[3], by: a[1], config: false }),
  [v4('configTransactionExecute')]: a => ({ kind: 'execute', proposal: a[2], tx: a[3], by: a[1], config: true }),
  [v4('spendingLimitUse')]: a => ({ kind: 'spend', by: a[1] }),
  // Controlled multisigs: the config authority changes the multisig directly, without a proposal.
  [v4('multisigAddMember')]: () => ({ kind: 'config', actions: { ...noActions(), add: 1 }, by: null }),
  [v4('multisigRemoveMember')]: () => ({ kind: 'config', actions: { ...noActions(), remove: 1 }, by: null }),
  [v4('multisigChangeThreshold')]: () => ({ kind: 'config', actions: { ...noActions(), threshold: 1 }, by: null }),
  [v4('multisigSetTimeLock')]: () => ({ kind: 'config', actions: { ...noActions(), timelock: 1 }, by: null }),
  [v4('multisigSetConfigAuthority')]: () => ({ kind: 'config', actions: { ...noActions(), other: 1 }, by: null }),
  [v4('multisigAddSpendingLimit')]: () => ({ kind: 'config', actions: { ...noActions(), other: 1 }, by: null }),
  [v4('multisigRemoveSpendingLimit')]: () => ({ kind: 'config', actions: { ...noActions(), other: 1 }, by: null }),
};

export function decodeV4ConfigActions(data: Buffer): ConfigActions {
  const out = noActions();
  try {
    const [ix] = (multisig.generated as any).configTransactionCreateStruct.deserialize(data);
    for (const act of ix.args.actions as { __kind: string }[]) {
      if (act.__kind === 'AddMember') out.add++;
      else if (act.__kind === 'RemoveMember') out.remove++;
      else if (act.__kind === 'ChangeThreshold') out.threshold++;
      else if (act.__kind === 'SetTimeLock') out.timelock++;
      else out.other++;
    }
  } catch { out.other++; }
  return out;
}

// Squads V3 (squads-mpl): account 0 is the multisig, 1 the transaction, 2 the signing member. Config
// changes are instructions the multisig runs on itself through execute_transaction (inner instructions).
const V3_TABLE: Record<string, (a: string[]) => Step | null> = {
  [anchor('create_transaction')]: a => ({ kind: 'create', tx: a[1], by: a[2] }),
  [anchor('approve_transaction')]: a => ({ kind: 'approve', proposal: a[1], by: a[2] }),
  [anchor('reject_transaction')]: a => ({ kind: 'reject', proposal: a[1], by: a[2] }),
  [anchor('cancel_transaction')]: a => ({ kind: 'cancel', proposal: a[1], by: a[2] }),
  [anchor('execute_transaction')]: a => ({ kind: 'execute', proposal: a[1], tx: a[1], by: a[2], config: false }),
  [anchor('execute_instruction')]: a => ({ kind: 'execute', proposal: a[1], tx: a[1], by: a[3], config: false }),
  [anchor('add_member')]: () => ({ kind: 'config', actions: { ...noActions(), add: 1 }, by: null }),
  [anchor('remove_member')]: () => ({ kind: 'config', actions: { ...noActions(), remove: 1 }, by: null }),
  [anchor('add_member_and_change_threshold')]: () => ({ kind: 'config', actions: { ...noActions(), add: 1, threshold: 1 }, by: null }),
  [anchor('remove_member_and_change_threshold')]: () => ({ kind: 'config', actions: { ...noActions(), remove: 1, threshold: 1 }, by: null }),
  [anchor('change_threshold')]: () => ({ kind: 'config', actions: { ...noActions(), threshold: 1 }, by: null }),
  [anchor('add_authority')]: () => ({ kind: 'config', actions: { ...noActions(), other: 1 }, by: null }),
  [anchor('set_external_execute')]: () => ({ kind: 'config', actions: { ...noActions(), other: 1 }, by: null }),
};

// Serum-style multisig: account 0 is the multisig, 1 the transaction (2 on execute, after the signer
// PDA). execute_transaction names no member, so the fee payer is taken as the executor. The owner set
// is replaced wholesale by set_owners, so additions and removals are the difference from the last set.
const SERUM_TABLE: Record<string, (a: string[], d: Buffer) => Step | null> = {
  [anchor('create_transaction')]: a => ({ kind: 'create', tx: a[1], by: a[2] }),
  [anchor('approve')]: a => ({ kind: 'approve', proposal: a[1], by: a[2] }),
  [anchor('execute_transaction')]: a => ({ kind: 'execute', proposal: a[2], tx: a[2], by: null, config: false }),
  [anchor('create_multisig')]: (_a, d) => ({ kind: 'owners', owners: readPubkeyVec(d, 8) }),
  [anchor('set_owners')]: (_a, d) => ({ kind: 'owners', owners: readPubkeyVec(d, 8) }),
  [anchor('set_owners_and_change_threshold')]: (_a, d) => ({ kind: 'owners', owners: readPubkeyVec(d, 8), threshold: 1 }),
  [anchor('change_threshold')]: () => ({ kind: 'threshold' }),
};

function readPubkeyVec(d: Buffer, at: number): string[] {
  try {
    const n = d.readUInt32LE(at);
    if (n > 64) return [];
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(new PublicKey(d.subarray(at + 4 + i * 32, at + 36 + i * 32)).toBase58());
    return out;
  } catch { return []; }
}

const TABLES: Record<MsVersion, { program: string; table: Record<string, (a: string[], d: Buffer) => Step | null> }> = {
  V4: { program: SQUADS_V4, table: V4_TABLE },
  V3: { program: SQUADS_V3, table: V3_TABLE as any },
  SERUM: { program: SERUM, table: SERUM_TABLE },
};

// Steps in one transaction that act on this multisig (account 0 of the instruction), top-level and inner.
export function stepsOf(tx: any, address: string, version: MsVersion): { steps: Step[]; feePayer: string; time: number; slot: number; signature: string } {
  const msg = tx.transaction.message;
  const keys: string[] = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  const ixs: any[] = [...msg.instructions];
  for (const g of tx.meta?.innerInstructions || []) ixs.push(...g.instructions);
  const { program, table } = TABLES[version];
  const steps: Step[] = [];
  for (const ix of ixs) {
    if (keys[ix.programIdIndex] !== program) continue;
    const accounts: string[] = (ix.accounts || []).map((i: number) => keys[i]);
    if (accounts[0] !== address) continue;
    let data: Buffer;
    try { data = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
    const fn = table[data.subarray(0, 8).toString('hex')];
    const step = fn ? fn(accounts, data) : null;
    if (step) steps.push(step);
  }
  return { steps, feePayer: msg.accountKeys[0], time: tx.blockTime || 0, slot: tx.slot, signature: tx.transaction.signatures[0] };
}

// ---------------------------------------------------------------------------------------------
// Aggregation. The store holds running aggregates rather than raw transactions, so it stays small
// and each run only has to read what is new.

interface ProposalState { executed?: number; rejected?: boolean; cancelled?: boolean }

export interface MsStore {
  name: string;
  version: MsVersion;
  lastSlot: number;
  lastSlotSigs: string[];
  complete: boolean;           // whole history read up to lastSlot
  txCount: number;
  firstTxAt: number | null;
  lastTxAt: number | null;
  feePayers: Record<string, number>;
  signerLast: Record<string, number>;
  proposers: string[];
  approvers: string[];
  executors: string[];
  selfExecutors: string[];
  creates: Record<string, { t: number; by: string; actions?: ConfigActions }>;
  proposals: Record<string, ProposalState>;
  exec: { n: number; sumH: number; minH: number | null; maxH: number | null };
  configs: { t: number; actions: ConfigActions }[];
  spendingLimitUses: number;
  owners: string[] | null;     // Serum only: last known owner set
}

export function emptyStore(t: Target): MsStore {
  return {
    name: t.name, version: t.version, lastSlot: 0, lastSlotSigs: [], complete: false, txCount: 0,
    firstTxAt: null, lastTxAt: null, feePayers: {}, signerLast: {}, proposers: [], approvers: [], executors: [],
    selfExecutors: [], creates: {}, proposals: {}, exec: { n: 0, sumH: 0, minH: null, maxH: null }, configs: [],
    spendingLimitUses: 0, owners: null,
  };
}

const addTo = (arr: string[], v: string | null | undefined) => { if (v && !arr.includes(v)) arr.push(v); };

export function applyTx(s: MsStore, tx: ReturnType<typeof stepsOf>): void {
  const { steps, feePayer, time } = tx;
  s.txCount++;
  if (s.firstTxAt === null || time < s.firstTxAt) s.firstTxAt = time;
  if (s.lastTxAt === null || time > s.lastTxAt) s.lastTxAt = time;
  s.feePayers[feePayer] = (s.feePayers[feePayer] || 0) + 1;
  const signed = (who: string | null) => { if (who) s.signerLast[who] = Math.max(s.signerLast[who] || 0, time); };
  // Several config instructions in one transaction are one config change.
  let txConfig: ConfigActions | null = null;
  const addConfig = (a: ConfigActions) => {
    txConfig ||= noActions();
    for (const k of Object.keys(a) as (keyof ConfigActions)[]) txConfig[k] += a[k];
  };

  for (const st of steps) {
    switch (st.kind) {
      case 'create':
        s.creates[st.tx] = { t: time, by: st.by, ...(st.actions ? { actions: st.actions } : {}) };
        addTo(s.proposers, st.by); signed(st.by);
        break;
      case 'proposal':
        addTo(s.proposers, st.by); signed(st.by);
        break;
      case 'approve':
        addTo(s.approvers, st.by); signed(st.by);
        break;
      case 'reject':
        (s.proposals[st.proposal] ||= {}).rejected = true; signed(st.by);
        break;
      case 'cancel':
        (s.proposals[st.proposal] ||= {}).cancelled = true; signed(st.by);
        break;
      case 'execute': {
        const by = st.by ?? feePayer;
        const p = (s.proposals[st.proposal] ||= {});
        const first = p.executed === undefined;
        if (first) p.executed = time;
        addTo(s.executors, by); signed(st.by);
        const c = s.creates[st.tx];
        if (c && first) {
          const h = Math.max(0, (time - c.t) / 3600);
          s.exec.n++; s.exec.sumH += h;
          s.exec.minH = s.exec.minH === null ? h : Math.min(s.exec.minH, h);
          s.exec.maxH = s.exec.maxH === null ? h : Math.max(s.exec.maxH, h);
          if (c.by === by) addTo(s.selfExecutors, by);
        }
        if (st.config && first) addConfig(c?.actions ?? { ...noActions(), other: 1 });
        if (c) delete s.creates[st.tx];
        break;
      }
      case 'config':
        addConfig(st.actions);
        break;
      case 'owners': {
        if (s.owners) {
          const add = st.owners.filter(o => !s.owners!.includes(o)).length;
          const remove = s.owners.filter(o => !st.owners.includes(o)).length;
          addConfig({ ...noActions(), add, remove, threshold: st.threshold ?? 0 });
        }
        s.owners = st.owners;
        break;
      }
      case 'threshold':
        addConfig({ ...noActions(), threshold: 1 });
        break;
      case 'spend':
        s.spendingLimitUses++; signed(st.by);
        break;
    }
  }
  if (txConfig) s.configs.push({ t: time, actions: txConfig });
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarise(s: MsStore, members: string[] | null, now = Date.now() / 1000) {
  const configDates = Array.from(new Set(s.configs.map(c => day(c.t)))).sort().reverse();
  const sum = (k: keyof ConfigActions) => s.configs.reduce((n, c) => n + c.actions[k], 0);
  const offHours = s.configs.filter(c => { const h = new Date(c.t * 1000).getUTCHours(); return h >= 22 || h < 6; }).length;
  const proposals = Object.values(s.proposals);
  const payerCounts = Object.values(s.feePayers);
  const payerTotal = payerCounts.reduce((a, b) => a + b, 0);
  const cutoff = now - 90 * 86400;
  const active = members ? members.filter(m => s.signerLast[m] !== undefined && s.signerLast[m] >= cutoff).length : null;
  return {
    name: s.name,
    version: s.version,
    complete: s.complete,
    created: s.firstTxAt ? day(s.firstTxAt) : null,
    lastTxAt: s.lastTxAt ? new Date(s.lastTxAt * 1000).toISOString() : null,
    totalTxs: s.txCount,
    configChanges: s.configs.length,
    configDates,
    membersAdded: sum('add'),
    membersRemoved: sum('remove'),
    thresholdChanges: sum('threshold'),
    timelockChanges: sum('timelock'),
    offHoursConfigChanges: { offHours, total: s.configs.length },
    totalMembers: members ? members.length : null,
    activeVoters90d: active,
    voterRate: members && members.length > 0 && active !== null ? Math.round((active / members.length) * 100) : null,
    neverSignedCount: members ? members.filter(m => !s.signerLast[m]).length : null,
    proposers: s.proposers.length,
    approvers: s.approvers.length,
    executors: s.executors.length,
    rubberStampSigners: s.selfExecutors.length,
    approvedProposals: proposals.filter(p => p.executed !== undefined).length,
    rejectedProposals: proposals.filter(p => p.rejected && p.executed === undefined).length,
    cancelledProposals: proposals.filter(p => p.cancelled).length,
    spendingLimitUses: s.spendingLimitUses,
    avgExecuteTimeH: s.exec.n > 0 ? round2(s.exec.sumH / s.exec.n) : 0,
    fastestExecuteH: s.exec.minH !== null ? round2(s.exec.minH) : 0,
    slowestExecuteH: s.exec.maxH !== null ? round2(s.exec.maxH) : 0,
    executionSamples: s.exec.n,
    topFeePayerPct: payerTotal > 0 ? Math.round((Math.max(...payerCounts) / payerTotal) * 100) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Current member lists, read in one batch.

export function decodeMembers(version: MsVersion, data: Buffer): string[] | null {
  try {
    if (version === 'V4') {
      const [ms] = multisig.accounts.Multisig.fromAccountInfo({ data } as any);
      return ms.members.map((m: any) => m.key.toBase58());
    }
    if (version === 'V3') {
      // disc 8, threshold u16, authority_index u16, transaction_index u32, ms_change_index u32, bump u8,
      // create_key 32, allow_external_execute bool, keys Vec<Pubkey>
      return readPubkeyVec(data, 8 + 2 + 2 + 4 + 4 + 1 + 32 + 1);
    }
    return readPubkeyVec(data, 8);
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Targets: the headline multisig of every protocols.ts entry that has one. Written to a data file so
// the VPS, which has no dashboard source, scans the same list.

function versionOf(v: string | undefined): MsVersion | null {
  if (v === 'Squads V4') return 'V4';
  if (v === 'Squads V3') return 'V3';
  if (v === 'Serum Multisig') return 'SERUM';
  return null;
}

export function targetsFromProtocolsSource(src: string): Target[] {
  const out: Target[] = [];
  for (const block of src.split(/\n    name: '/).slice(1)) {
    const name = block.slice(0, block.indexOf("'"));
    const address = /\n    multisigAddress: '([1-9A-HJ-NP-Za-km-z]{32,44})'/.exec(block)?.[1];
    const version = versionOf(/\n    version: '([^']+)'/.exec(block)?.[1]);
    if (address && version && !out.some(t => t.address === address)) out.push({ name, address, version });
  }
  return out;
}

function loadTargets(): Target[] {
  if (fs.existsSync(PROTOCOLS_TS)) {
    const targets = targetsFromProtocolsSource(fs.readFileSync(PROTOCOLS_TS, 'utf-8'));
    writeJsonAtomic(TARGETS_FILE, { generatedAt: new Date().toISOString(), source: 'public-dashboard/src/data/protocols.ts', targets });
    return targets;
  }
  return readJsonStrict<{ targets: Target[] }>(TARGETS_FILE, { targets: [] }).targets;
}

// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchPage(rpc: string, address: string, fromSlot: number): Promise<{ data: any[]; next: string | null }> {
  const body = (token?: string) => JSON.stringify({
    jsonrpc: '2.0', id: 'gov-activity', method: 'getTransactionsForAddress',
    params: [address, {
      transactionDetails: 'full', sortOrder: 'asc', limit: 100, encoding: 'json', maxSupportedTransactionVersion: 0,
      filters: { status: 'succeeded', ...(fromSlot > 0 ? { slot: { gte: fromSlot } } : {}) },
      ...(token ? { paginationToken: token } : {}),
    }],
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body() });
      const j: any = await r.json();
      if (j.error) throw new Error(j.error.message);
      return { data: j.result?.data || [], next: j.result?.paginationToken || null };
    } catch (e: any) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// After the first full read, only new signatures are listed (1 credit per 1,000) and only those
// transactions are fetched (1 credit each), so a quiet multisig costs one call per run.
async function rawTransaction(rpc: string, signature: string): Promise<any | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'gov-activity', method: 'getTransaction', params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }),
      });
      const j: any = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result ?? null;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function scanIncremental(rpc: string, conn: Connection, t: Target, s: MsStore, save: () => void): Promise<number> {
  const until = s.lastSlotSigs[s.lastSlotSigs.length - 1];
  const sigs: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  let calls = 0;
  for (;;) {
    const page = await conn.getSignaturesForAddress(new PublicKey(t.address), { limit: 1000, until, before }, 'confirmed');
    calls++;
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  for (const sig of sigs.reverse()) {
    if (sig.err) continue;
    const tx = await rawTransaction(rpc, sig.signature);
    calls++;
    if (!tx || tx.meta?.err) continue;
    applyTx(s, stepsOf(tx, t.address, t.version));
    if (tx.slot !== s.lastSlot) { s.lastSlot = tx.slot; s.lastSlotSigs = []; }
    s.lastSlotSigs.push(sig.signature);
  }
  save();
  return calls;
}

async function scan(rpc: string, t: Target, s: MsStore, maxPages: number, save: () => void): Promise<number> {
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) return pages;
    const { data } = await fetchPage(rpc, t.address, s.lastSlot);
    pages++;
    const fresh = data.filter(tx => !(tx.slot === s.lastSlot && s.lastSlotSigs.includes(tx.transaction.signatures[0])));
    for (const tx of fresh) {
      if (tx.meta?.err) continue;
      applyTx(s, stepsOf(tx, t.address, t.version));
      if (tx.slot !== s.lastSlot) { s.lastSlot = tx.slot; s.lastSlotSigs = []; }
      s.lastSlotSigs.push(tx.transaction.signatures[0]);
    }
    save();
    // A page with nothing new (only already-seen transactions from the resume slot) or a short page
    // means the history is read to the tip.
    if (fresh.length === 0 || data.length < 100) { s.complete = true; save(); return pages; }
    await sleep(150);
  }
}

async function main() {
  const rpc = process.env.HELIUS_RPC_URL;
  if (!rpc) throw new Error('HELIUS_RPC_URL is not set');
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const maxPages = args.includes('--max-pages') ? Number(args[args.indexOf('--max-pages') + 1]) : 1000;

  if (args.includes('--targets-only')) {
    console.log(`${loadTargets().length} targets written to ${TARGETS_FILE}`);
    return;
  }
  const targets = loadTargets().filter(t => !only || t.address === only || t.name === only);
  const store = readJsonStrict<Record<string, MsStore>>(STORE_FILE, {});
  const save = () => writeJsonAtomic(STORE_FILE, store);

  const conn = new Connection(rpc, 'confirmed');
  let pages = 0;
  let singleCalls = 0;
  for (const t of targets) {
    const s = store[t.address] ||= emptyStore(t);
    s.name = t.name;
    const before = s.txCount;
    let note: string;
    if (s.complete && s.lastSlotSigs.length > 0) {
      const n = await scanIncremental(rpc, conn, t, s, save);
      singleCalls += n;
      note = `${n} call(s)`;
    } else {
      const n = await scan(rpc, t, s, maxPages, save);
      pages += n;
      note = `${n} page(s)${s.complete ? '' : '  (incomplete)'}`;
    }
    console.log(`${t.name.padEnd(22)} ${t.version.padEnd(5)} ${String(s.txCount).padStart(6)} txs  +${s.txCount - before}  ${note}`);
  }

  // Current members for the per-member fields.
  const all = Object.keys(store);
  const infos: (Buffer | null)[] = [];
  for (let i = 0; i < all.length; i += 100) {
    const batch = await conn.getMultipleAccountsInfo(all.slice(i, i + 100).map(a => new PublicKey(a)));
    infos.push(...batch.map(b => (b ? Buffer.from(b.data) : null)));
  }
  const entries: Record<string, ReturnType<typeof summarise>> = {};
  all.forEach((addr, i) => {
    const s = store[addr];
    const members = infos[i] ? decodeMembers(s.version, infos[i]!) : null;
    entries[addr] = summarise(s, members);
  });
  const targetSet = new Set(loadTargetsQuiet().map(t => t.address));
  writeJsonAtomic(OUT_FILE, {
    generatedAt: new Date().toISOString(),
    source: 'full on-chain history per multisig (successful transactions), updated incrementally',
    entries: Object.fromEntries(Object.entries(entries).filter(([a]) => targetSet.has(a))),
  });
  console.log(`\n${pages} history page(s) and ${singleCalls} single call(s), about ${pages * 50 + singleCalls} credits. Wrote ${OUT_FILE}`);
}

function loadTargetsQuiet(): Target[] {
  try { return readJsonStrict<{ targets: Target[] }>(TARGETS_FILE, { targets: [] }).targets; } catch { return []; }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
