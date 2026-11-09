// Admin Watch detector: changes to the admin key held inside a protocol's own state account (the key
// that can change markets, oracles, fees or risk settings without a program upgrade).
//
// Live mode reads the field straight from the state account at a fixed byte offset, which is a
// reliable on-chain read, so active-admin changes and proposed handovers are public-eligible.
// Replay mode rebuilds the same field from decoded setter instructions (see replay/admin.ts) and runs
// this same classifier.
//
// Two field kinds:
//   active   the key in control now (e.g. Drift State.admin, Kamino lending_market_owner)
//   pending  a proposed successor that takes control once it claims (Kamino lending_market_owner_cached,
//            Phoenix successor). Setting it is the earliest on-chain sign of a handover.

import { PublicKey } from '@solana/web3.js';
import type { Severity } from './multisig-config';
import type { ProgramRole } from './program-upgrade';
import { describeHolder, type HolderFacts } from './holder';

export interface AdminField {
  name: string;
  label: string;            // plain English, shown in alerts
  kind: 'active' | 'pending';
  offset?: number;          // byte offset of the 32-byte key in the state account (live reads)
  pendingFor?: string;      // pending fields: the active field it would replace (equal value = nothing pending)
  severity?: Severity;      // active fields: override the role-based severity for lower-stakes keys
}

export interface AdminSetter {
  ix: string;                // Anchor instruction name, e.g. 'update_admin'
  field: string;             // field it writes
  stateAccountIndex: number; // position of the state account in the instruction's accounts
  newValueArgOffset: number; // byte offset of the new 32-byte key in instruction data (after the 8-byte discriminator)
  currentAdminAccountIndex?: number; // position of the signing current admin, when the program enforces it (gives a replay baseline)
}

export interface AdminTarget {
  name: string;          // e.g. 'Drift V2 protocol admin'
  protocol: string;      // dashboard protocol name
  programId: string;
  account: string;       // state account address
  role: ProgramRole;
  fields: AdminField[];
  setters: AdminSetter[];
  historyFrom: string[]; // replay only: addresses whose histories contain the setter calls
  verified?: string;     // how the offsets were confirmed against a live account
}

export const NONE = 'NONE';

export function readAdminFields(t: AdminTarget, data: Buffer): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of t.fields) {
    if (f.offset === undefined) continue;
    if (data.length < f.offset + 32) return null;
    const key = new PublicKey(data.subarray(f.offset, f.offset + 32));
    out[f.name] = key.equals(PublicKey.default) ? NONE : key.toBase58();
  }
  return out;
}

export interface AdminChangeInput {
  target: AdminTarget;
  field: string;
  before: string | null;   // null when there is no baseline (first observation)
  after: string;
  beforeHolder: HolderFacts | null;
  afterHolder: HolderFacts;
  currentActive?: string;  // pending fields: current value of the active field it pairs with
}

export function classifyAdminChange(i: AdminChangeInput): { type: string; severity: Severity; public: boolean; detail: string } {
  const f = i.target.fields.find(x => x.name === i.field);
  const label = f?.label ?? i.field;
  const from = i.before === null ? 'unknown' : i.before === NONE ? 'none' : i.beforeHolder ? describeHolder(i.beforeHolder) : i.before;
  const to = i.after === NONE ? 'none' : describeHolder(i.afterHolder);

  if (f?.kind === 'pending') {
    // A pending value equal to the current holder means nothing is pending (e.g. after a completed claim).
    if (i.after === NONE || (i.currentActive !== undefined && i.after === i.currentActive)) {
      return { type: 'AdminHandoverCleared', severity: 'MONITOR', public: false, detail: `${label}: no handover pending (was proposed to ${from})` };
    }
    return { type: 'AdminHandoverProposed', severity: 'HIGH', public: true, detail: `${label}: handover proposed to ${to}. It takes effect only once the new key claims it.` };
  }
  const severity: Severity = f?.severity ?? (i.target.role === 'peripheral' ? 'HIGH' : 'CRITICAL');
  return { type: 'AdminKeyChanged', severity, public: true, detail: `${label}: ${from} → ${to}` };
}
