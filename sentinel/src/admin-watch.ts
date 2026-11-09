// Live Admin Watch: watches the admin key fields inside protocol state accounts (data/admin-watch/
// targets.json) and reports changes, using detectors/admin-watch.ts to classify them.
//
// Only targets stamped `verified` by src/admin-watch-verify.ts (owner program and account
// discriminator checked against a live read) and not marked `live: false` are watched. Every
// notification re-checks the owner and discriminator, so a layout change after a program upgrade is
// skipped rather than read at the wrong offset.
//
// Each change names who now holds the key: a vault of a multisig solgov tracks is described from a
// live read of that multisig (threshold, signers, timelock, external admin key); anything else is
// stated as not being a vault of any tracked multisig. Where the previous holder was a tracked
// multisig, the executing transaction is looked up and linked.

import * as fs from 'fs';
import * as path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { readAdminFields, classifyAdminChange, NONE, type AdminTarget } from './detectors/admin-watch';
import { snapshotFromV4, type Severity } from './detectors/multisig-config';
import { describeHolder, type HolderFacts } from './detectors/holder';
import { vaultPda } from './replay/squads-v4';
import { WATCH_LIST } from './watch-list';
import { protocolsSourcePath } from './utils/protocols-source';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';

const DATA = path.join(__dirname, '..', 'data');
const TARGETS_FILE = path.join(DATA, 'admin-watch', 'targets.json');
const STATE_FILE = path.join(DATA, 'listener-admin-state.json');
// Public snapshot served by solgov-api as _adminWatch (dashboard panel, bot /admin).
export const SNAPSHOT_FILE = path.join(DATA, 'admin-watch.json');

export interface AdminSnapshotField {
  name: string;
  label: string;
  kind: 'active' | 'pending';
  value: string;            // current key, or NONE
  holder: HolderFacts | null;
  holderText: string;       // plain-English holder (same wording as alerts)
  handoverProposed?: boolean; // pending fields only
  watchingSince: string;    // ISO: first time solgov read this field
  lastChange: { at: string; detail: string } | null; // last change seen since watching began
}
export interface AdminSnapshot {
  generatedAt: string;
  targets: { protocol: string; name: string; account: string; programId: string; fields: AdminSnapshotField[] }[];
}

export type LiveAdminTarget = AdminTarget & { accountType: string; verified?: string; discriminator?: string; live?: boolean };

export function loadLiveAdminTargets(): LiveAdminTarget[] {
  const all = readJsonStrict<LiveAdminTarget[]>(TARGETS_FILE, []);
  return all.filter(t => t.verified && t.discriminator && t.live !== false);
}

// Multisigs solgov tracks: the listener watch list plus every multisig address in protocols.ts
// (headline multisigs and role entries). Maps vault PDA (index 0 and 1) -> name and multisig address.
export function protocolsMultisigs(src: string): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const block of src.split(/\n    name: '/).slice(1)) {
    const protocol = block.slice(0, block.indexOf("'"));
    const headline = /\n    multisigAddress: '([1-9A-HJ-NP-Za-km-z]{32,44})'/.exec(block)?.[1];
    if (headline) out.push({ name: protocol, address: headline });
    for (const m of block.matchAll(/role: '([^']+)'[^\n]*?address: '([1-9A-HJ-NP-Za-km-z]{32,44})'/g)) out.push({ name: `${protocol} (${m[1]})`, address: m[2] });
  }
  return out;
}

// complete=false when protocols.ts could not be read: the registry then misses role-level multisigs,
// so "not a vault of any multisig solgov tracks" must not be claimed.
export function buildHolderRegistry(): { reg: Map<string, { name: string; multisig: string }>; complete: boolean } {
  const reg = new Map<string, { name: string; multisig: string }>();
  const add = (name: string, address: string) => {
    for (const i of [0, 1]) { try { const v = vaultPda(address, i); if (!reg.has(v)) reg.set(v, { name, multisig: address }); } catch {} }
  };
  for (const w of WATCH_LIST) if (w.type === 'v4') add(w.name, w.address);
  let complete = false;
  try {
    const found = protocolsMultisigs(fs.readFileSync(protocolsSourcePath(), 'utf-8'));
    for (const m of found) add(m.name, m.address);
    complete = found.length > 0;
  } catch (e: any) { console.error('[ADMIN] protocols.ts not readable; holder lookups will make no tracked/untracked claim:', e.message); }
  return { reg, complete };
}

export interface AdminAlert {
  target: LiveAdminTarget;
  field: string;
  type: string;
  severity: Severity;
  public: boolean;
  detail: string;
  txLink: string | null;
}

export class AdminWatcher {
  private baseline: Record<string, Record<string, string>>;
  private holderReg = buildHolderRegistry();
  private registry = this.holderReg.reg;
  private untrackedScope: 'live' | 'unchecked' = this.holderReg.complete ? 'live' : 'unchecked';
  private since: Record<string, string> = {};                                  // `${account}:${field}` -> ISO
  private lastChange: Record<string, { at: string; detail: string } | null> = {};
  constructor(private conn: Connection, public targets: LiveAdminTarget[] = loadLiveAdminTargets(), private stateFile: string = STATE_FILE, private snapshotFile: string = SNAPSHOT_FILE) {
    this.baseline = readJsonStrict<Record<string, Record<string, string>>>(this.stateFile, {});
    try {
      const prev = readJsonStrict<AdminSnapshot | null>(this.snapshotFile, null);
      for (const t of prev?.targets || []) for (const f of t.fields) {
        this.since[`${t.account}:${f.name}`] = f.watchingSince;
        this.lastChange[`${t.account}:${f.name}`] = f.lastChange;
      }
    } catch { /* a corrupt snapshot is rebuilt from the baseline */ }
  }

  // Writes the public snapshot from the current baseline, resolving each holder from a live read.
  async writeSnapshot(): Promise<AdminSnapshot> {
    const now = new Date().toISOString();
    const snap: AdminSnapshot = { generatedAt: now, targets: [] };
    for (const t of this.targets) {
      const vals = this.baseline[t.account];
      if (!vals) continue;
      const fields: AdminSnapshotField[] = [];
      for (const f of t.fields) {
        const value = vals[f.name];
        if (value === undefined) continue;
        const key = `${t.account}:${f.name}`;
        const holder = value === NONE ? null : await this.holder(value);
        const proposed = f.kind === 'pending' ? value !== NONE && !(f.pendingFor && vals[f.pendingFor] === value) : undefined;
        const holderText = f.kind === 'pending' && !proposed ? 'No handover pending' : holder ? describeHolder(holder) : 'none';
        fields.push({
          name: f.name, label: f.label, kind: f.kind, value, holder, holderText,
          ...(f.kind === 'pending' ? { handoverProposed: proposed } : {}),
          watchingSince: this.since[key] || (this.since[key] = now),
          lastChange: this.lastChange[key] ?? null,
        });
      }
      snap.targets.push({ protocol: t.protocol, name: t.name, account: t.account, programId: t.programId, fields });
    }
    try { writeJsonAtomic(this.snapshotFile, snap); } catch (e: any) { console.error('[ADMIN] snapshot write failed:', e.message); }
    return snap;
  }

  private save() {
    try { writeJsonAtomic(this.stateFile, this.baseline); } catch (e: any) { console.error('[ADMIN] baseline save failed:', e.message); }
  }

  private async holder(key: string): Promise<HolderFacts> {
    const r = this.registry.get(key);
    if (!r) return { kind: 'untracked', address: key, scope: this.untrackedScope };
    try {
      const info = await this.conn.getAccountInfo(new PublicKey(r.multisig));
      // Known tracked vault but its multisig could not be read: make no tracked/untracked claim.
      if (!info) return { kind: 'untracked', address: key, scope: 'unchecked' };
      const [ms] = multisig.accounts.Multisig.fromAccountInfo(info);
      const s = snapshotFromV4(ms);
      return { kind: 'multisig-vault', address: r.multisig, multisigName: r.name, threshold: s.threshold, memberCount: s.memberCount, timeLock: s.timeLock, configAuthority: s.configAuthority };
    } catch { return { kind: 'untracked', address: key, scope: 'unchecked' }; }
  }

  // The transaction that executed the change, when it went through a tracked multisig's vault:
  // a recent transaction on that multisig that touched the state account.
  private async executingTx(prevHolder: string, account: string): Promise<string | null> {
    const r = this.registry.get(prevHolder);
    if (!r) return null;
    try {
      const sigs = await this.conn.getSignaturesForAddress(new PublicKey(r.multisig), { limit: 5 });
      for (const s of sigs) {
        if (s.err || !s.blockTime || Date.now() / 1000 - s.blockTime > 3600) continue;
        const tx = await this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
        const keys = tx?.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat().map(k => k.toBase58()) || [];
        if (keys.includes(account)) return `https://solscan.io/tx/${s.signature}`;
      }
    } catch {}
    return null;
  }

  // Validates and reads the target's fields from raw account data. Null = skip (wrong owner,
  // discriminator or size), never treated as a change.
  read(t: LiveAdminTarget, owner: string, data: Buffer): Record<string, string> | null {
    if (owner !== t.programId) return null;
    if (data.subarray(0, 8).toString('hex') !== t.discriminator) return null;
    return readAdminFields(t, data);
  }

  // Compares a fresh read with the baseline and returns classified alerts. First read only baselines.
  async observe(t: LiveAdminTarget, fields: Record<string, string>): Promise<AdminAlert[]> {
    const prev = this.baseline[t.account];
    this.baseline[t.account] = fields;
    this.save();
    if (!prev) return [];
    const alerts: AdminAlert[] = [];
    for (const f of t.fields) {
      const before = prev[f.name];
      const after = fields[f.name];
      if (before === undefined || after === undefined || before === after) continue;
      const ch = classifyAdminChange({
        target: t, field: f.name, before, after,
        currentActive: f.pendingFor ? fields[f.pendingFor] : undefined,
        beforeHolder: before === NONE ? null : await this.holder(before),
        afterHolder: after === NONE ? { kind: 'untracked', address: NONE, scope: this.untrackedScope } : await this.holder(after),
      });
      const txLink = f.kind === 'active' && before !== NONE ? await this.executingTx(before, t.account) : null;
      alerts.push({ target: t, field: f.name, ...ch, txLink });
      this.lastChange[`${t.account}:${f.name}`] = { at: new Date().toISOString(), detail: ch.detail };
    }
    return alerts;
  }

  // Startup read of every target; a change made while the listener was down is reported now.
  async initialRead(): Promise<AdminAlert[]> {
    if (!this.targets.length) return [];
    const infos = await this.conn.getMultipleAccountsInfo(this.targets.map(t => new PublicKey(t.account)));
    const out: AdminAlert[] = [];
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      const info = infos[i];
      const fields = info ? this.read(t, info.owner.toBase58(), info.data) : null;
      if (!fields) { console.error(`[ADMIN] ${t.name}: initial read failed validation; not baselined`); continue; }
      out.push(...await this.observe(t, fields));
    }
    return out;
  }
}
