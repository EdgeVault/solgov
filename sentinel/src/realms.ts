// SPL Governance (Realms) reader for solgov.
//
// Squads DAOs are read via @sqds/multisig; Realms DAOs use a different program
// and account model, so they are read here. Account-type discriminators below are
// the CURRENT on-chain values, validated against BonkDAO (realm 84pGFuy..., gov
// Uq5BRkVf...): the decoder reproduces the known config (1% vote threshold, 0
// hold-up time, 100M BONK proposal threshold) exactly. The older scan-save-mango.ts
// used off-by-one type values (17/19) and silently matched nothing; use these.

import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import { appendActivity } from './activity-log';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const REALMS_PROGRAM = new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw');

// Byte-0 account discriminators (spl-governance v3, on-chain-validated).
export const ACCT = {
  VoteRecordV2: 12,
  ProposalTransactionV2: 13,
  ProposalV2: 14,
  RealmV2: 16,
  TokenOwnerRecordV2: 17,
  GovernanceV2: 18,
  ProgramGovernanceV2: 19,
  MintGovernanceV2: 20,
  TokenGovernanceV2: 21,
} as const;

// A realm can hold treasuries under any of the four V2 governance flavours.
const GOVERNANCE_TYPES: number[] = [ACCT.GovernanceV2, ACCT.ProgramGovernanceV2, ACCT.MintGovernanceV2, ACCT.TokenGovernanceV2];

// ProposalState enum (byte offset 65 in a ProposalV2 account).
export const PROPOSAL_STATE = ['Draft', 'SigningOff', 'Voting', 'Succeeded', 'Executing', 'Completed', 'Cancelled', 'Defeated', 'ExecutingWithErrors', 'Vetoed'] as const;
export type ProposalState = typeof PROPOSAL_STATE[number];

const b58 = (n: number) => bs58.encode(Buffer.from([n]));

// VoteThreshold kinds: 0 YesVotePercentage, 1 QuorumPercentage, 2 Disabled.
function voteThresholdLabel(kind: number, pct: number): string {
  if (kind === 0) return `${pct}% approval`;
  if (kind === 1) return `${pct}% quorum`;
  if (kind === 2) return 'Disabled';
  return `kind${kind}(${pct})`;
}

export interface GovernanceConfig {
  governance: string;
  realm: string;
  governedAccount: string;
  proposalCount: number;
  voteThresholdKind: number;
  voteThresholdPct: number;
  voteThresholdLabel: string;
  minCommunityWeight: number;   // raw units of the community mint
  holdUpTimeSec: number;        // execution timelock
  baseVotingTimeSec: number;
  voteTipping: number;          // 0 Strict, 1 Early, 2 Disabled
}

// Decode a V1/V2 governance account. Field offsets are shared across the V2
// governance flavours; only the type gate differs.
export function parseGovernanceConfig(pubkey: string, data: Buffer): GovernanceConfig | null {
  const t = data[0];
  if (!GOVERNANCE_TYPES.includes(t) && t !== 3 && t !== 4) return null;
  let o = 1;
  const realm = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const governed = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const proposalCount = data.readUInt32LE(o); o += 4;
  const vtKind = data[o++];
  const vtPct = data[o++];
  const minWeight = Number(data.readBigUInt64LE(o)); o += 8;
  const holdUp = data.readUInt32LE(o); o += 4;
  const baseVoting = data.readUInt32LE(o); o += 4;
  const tipping = data[o++];
  return {
    governance: pubkey,
    realm: realm.toBase58(),
    governedAccount: governed.toBase58(),
    proposalCount,
    voteThresholdKind: vtKind,
    voteThresholdPct: vtPct,
    voteThresholdLabel: voteThresholdLabel(vtKind, vtPct),
    minCommunityWeight: minWeight,
    holdUpTimeSec: holdUp,
    baseVotingTimeSec: baseVoting,
    voteTipping: tipping,
  };
}

// All governance (treasury) accounts under a realm.
export async function getGovernancesForRealm(conn: Connection, realm: string): Promise<GovernanceConfig[]> {
  const out: GovernanceConfig[] = [];
  for (const t of GOVERNANCE_TYPES) {
    const accs = await conn.getProgramAccounts(REALMS_PROGRAM, {
      filters: [{ memcmp: { offset: 0, bytes: b58(t) } }, { memcmp: { offset: 1, bytes: realm } }],
    });
    for (const a of accs) {
      const cfg = parseGovernanceConfig(a.pubkey.toBase58(), a.account.data as Buffer);
      if (cfg) out.push(cfg);
    }
  }
  return out;
}

export interface ProposalRef {
  proposal: string;
  state: ProposalState;
  stateByte: number;
}

// Proposals under a governance, with their state (byte 65). Lightweight: pulls
// only the first 66 bytes of each account.
export async function getProposals(conn: Connection, governance: string): Promise<ProposalRef[]> {
  const accs = await conn.getProgramAccounts(REALMS_PROGRAM, {
    dataSlice: { offset: 0, length: 66 },
    filters: [{ memcmp: { offset: 0, bytes: b58(ACCT.ProposalV2) } }, { memcmp: { offset: 1, bytes: governance } }],
  });
  return accs.map(a => {
    const d = a.account.data as Buffer;
    const stateByte = d.length > 65 ? d[65] : -1;
    return { proposal: a.pubkey.toBase58(), stateByte, state: (PROPOSAL_STATE[stateByte] ?? 'Draft') as ProposalState };
  });
}

export interface VoteAnalysis {
  proposal: string;
  yesVoters: number;
  yesTotalWeight: number;
  topVoter: string;
  topWeight: number;
  concentration: number; // top voter's share of yes weight, 0-1
}

// Enumerate a proposal's vote records and measure how concentrated the yes vote is.
// One wallet holding most of the yes weight is the concentration pattern seen on
// BonkDAO's BIP #76 (99.989% of the yes vote from one wallet). Run on live proposals.
export async function analyzeVotes(conn: Connection, proposal: string): Promise<VoteAnalysis | null> {
  const recs = await conn.getProgramAccounts(REALMS_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: b58(ACCT.VoteRecordV2) } }, { memcmp: { offset: 1, bytes: proposal } }],
  });
  if (!recs.length) return null;
  let yesTotal = 0, topWeight = 0, topVoter = '', yesVoters = 0;
  for (const r of recs) {
    const d = r.account.data as Buffer;
    if (d.length < 75) continue;
    const weight = Number(d.readBigUInt64LE(66));
    if (d[74] !== 0) continue; // Vote enum: 0 = Approve (yes)
    yesVoters++;
    yesTotal += weight;
    if (weight > topWeight) { topWeight = weight; topVoter = new PublicKey(d.subarray(33, 65)).toBase58(); }
  }
  return { proposal, yesVoters, yesTotalWeight: yesTotal, topVoter, topWeight, concentration: yesTotal > 0 ? topWeight / yesTotal : 0 };
}

export interface ProposalIntent { movesTreasury: boolean; largeMove: boolean; summary: string; instructionCount: number; }

// A move counts as large (drain-scale) when it takes a big share of the token's total
// supply, or moves a very large absolute value. Sizing against the source treasury
// account fails: grants use a dedicated account funded with the exact amount, which
// always reads as 100% of that account. Supply is stable and works looking back.
const LARGE_SUPPLY_FRAC = 0.02;     // moves >= 2% of the token's total supply
const LARGE_TOKEN_USD = 10_000_000; // or a very large absolute token value
const LARGE_SOL_USD = 250_000;      // SOL moves are gated on absolute USD value

function fmtAmt(n: number): string {
  return n >= 1e12 ? `${(n / 1e12).toFixed(1)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n.toFixed(2)}`;
}
function fmtUsdShort(n: number): string {
  return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
}

// Decode a proposal's executable instructions (stored in ProposalTransaction accounts)
// and size any treasury transfer against the token's total supply. A proposal moving a
// large share (a drain, like BonkDAO's BIP #76 at ~5% of all BONK) is flagged; grants and
// sponsorships that move a fraction of a percent are left as routine proposals.
export async function analyzeProposalInstructions(conn: Connection, proposal: string): Promise<ProposalIntent> {
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const SYS = '11111111111111111111111111111111';
  const BPF = 'BPFLoaderUpgradeab1e11111111111111111111111';
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  const accs = await conn.getProgramAccounts(REALMS_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: b58(ACCT.ProposalTransactionV2) } }, { memcmp: { offset: 1, bytes: proposal } }],
  });
  let count = 0; let movesTreasury = false; let largeMove = false;
  const moves: string[] = [];
  const priceCache: Record<string, number> = {};
  const supplyCache: Record<string, { supply: number; decimals: number }> = {};
  const priceOf = async (mint: string): Promise<number> => {
    if (!(mint in priceCache)) priceCache[mint] = await llamaPrice(mint);
    return priceCache[mint];
  };
  const supplyOf = async (mint: string): Promise<{ supply: number; decimals: number }> => {
    if (!(mint in supplyCache)) {
      try { const s = await conn.getTokenSupply(new PublicKey(mint)); supplyCache[mint] = { supply: s.value.uiAmount || 0, decimals: s.value.decimals }; }
      catch { supplyCache[mint] = { supply: 0, decimals: 0 }; }
    }
    return supplyCache[mint];
  };
  for (const a of accs) {
    const d = a.account.data as Buffer;
    if (d.length < 44) continue;
    let o = 40;
    const nIx = d.readUInt32LE(o); o += 4;
    for (let i = 0; i < nIx && o + 40 <= d.length; i++) {
      count++;
      const prog = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
      const nAcc = d.readUInt32LE(o); o += 4;
      const accts: string[] = [];
      for (let j = 0; j < nAcc && o + 34 <= d.length; j++) { accts.push(new PublicKey(d.subarray(o, o + 32)).toBase58()); o += 34; }
      const dataLen = d.readUInt32LE(o); o += 4;
      const ixData = d.subarray(o, o + dataLen); o += dataLen;

      if (prog === TOKEN && (ixData[0] === 3 || ixData[0] === 12) && ixData.length >= 9) {
        movesTreasury = true;
        const amtRaw = Number(ixData.readBigUInt64LE(1));
        const dest = accts[ixData[0] === 12 ? 2 : 1] || '?';
        // TransferChecked carries the mint; plain Transfer needs the source account for it.
        let mint = '';
        if (ixData[0] === 12) mint = accts[1] || '';
        else { try { mint = ((await conn.getParsedAccountInfo(new PublicKey(accts[0]))).value?.data as any)?.parsed?.info?.mint || ''; } catch { /* unresolved */ } }
        if (mint) {
          const { supply, decimals } = await supplyOf(mint);
          const human = amtRaw / Math.pow(10, decimals);
          const supplyFrac = supply > 0 ? human / supply : 0;
          const price = await priceOf(mint);
          const usd = price > 0 ? human * price : null;
          if (supplyFrac >= LARGE_SUPPLY_FRAC || (usd !== null && usd >= LARGE_TOKEN_USD)) {
            largeMove = true;
            moves.push(`transfers ${fmtAmt(human)}${usd !== null ? ` ~${fmtUsdShort(usd)}` : ''}${supplyFrac > 0 ? `, ${(supplyFrac * 100).toFixed(1)}% of supply` : ''} to ${dest.slice(0, 4)}..`);
          }
        }
      } else if (prog === SYS && ixData.length >= 12 && ixData.readUInt32LE(0) === 2) {
        movesTreasury = true;
        const sol = Number(ixData.readBigUInt64LE(4)) / 1e9;
        const usd = sol * ((await priceOf(WSOL_MINT)) || 190);
        if (usd >= LARGE_SOL_USD) {
          largeMove = true;
          moves.push(`transfers ${sol.toFixed(1)} SOL ~${fmtUsdShort(usd)}`);
        }
      } else if (prog === TOKEN && ixData[0] === 6) {
        movesTreasury = true; largeMove = true;
        moves.push('token authority change');
      } else if (prog === TOKEN && (ixData[0] === 4 || ixData[0] === 13)) {
        // Approve / ApproveChecked hands a delegate spend rights over the treasury; the
        // amount actually taken is then off-proposal, so flag it regardless of size.
        movesTreasury = true; largeMove = true;
        moves.push('delegates spend authority over treasury');
      } else if (prog === BPF && ixData.length >= 4 && ixData.readUInt32LE(0) === 4) {
        movesTreasury = true; largeMove = true;
        moves.push('program authority change');
      }
    }
  }
  return { movesTreasury, largeMove, summary: moves.join('; '), instructionCount: count };
}

export interface RiskAssessment {
  score: number;              // 0-10, higher = more BonkDAO-like
  labels: string[];
  quorumLabel: string;
  timelockHours: number;
  noTimelock: boolean;
  lowThreshold: boolean;
}

// Score a governance config against the BonkDAO failure pattern: a low vote
// threshold plus no execution timelock is the sitting-duck combination.
export function assessRisk(cfg: GovernanceConfig): RiskAssessment {
  const labels: string[] = [];
  let score = 0;
  const noTimelock = cfg.holdUpTimeSec === 0;
  // A very low approval/quorum threshold means a small stake can pass a proposal.
  const lowThreshold = cfg.voteThresholdKind !== 2 && cfg.voteThresholdPct > 0 && cfg.voteThresholdPct <= 10;
  if (lowThreshold) { labels.push(`${cfg.voteThresholdPct}% ${cfg.voteThresholdKind === 1 ? 'quorum' : 'threshold'}`); score += cfg.voteThresholdPct <= 3 ? 5 : 3; }
  if (noTimelock) { labels.push('0 execution timelock'); score += 4; }
  else if (cfg.holdUpTimeSec < 3600) { labels.push(`<1h timelock`); score += 2; }
  return {
    score: Math.min(score, 10),
    labels,
    quorumLabel: cfg.voteThresholdLabel,
    timelockHours: cfg.holdUpTimeSec / 3600,
    noTimelock,
    lowThreshold,
  };
}

export interface RealmScan {
  realm: string;
  governances: Array<{ config: GovernanceConfig; risk: RiskAssessment; proposals: number; votingNow: number }>;
  maxRiskScore: number;
}

// Full read of a realm for the DAO tab: config + risk + live proposal counts per treasury.
export async function scanRealm(conn: Connection, realm: string): Promise<RealmScan> {
  const govs = await getGovernancesForRealm(conn, realm);
  const governances = [] as RealmScan['governances'];
  for (const config of govs) {
    const props = await getProposals(conn, config.governance);
    governances.push({
      config,
      risk: assessRisk(config),
      proposals: props.length,
      votingNow: props.filter(p => p.state === 'Voting' || p.state === 'SigningOff').length,
    });
  }
  return { realm, governances, maxRiskScore: governances.reduce((m, g) => Math.max(m, g.risk.score), 0) };
}

// ============================================================
// Monitor integration: track a DAO list, detect new proposals + config changes,
// emit to the shared activity feed, and return alerts for the Telegram report.
// ============================================================

const REALMS_STATE_FILE = path.join(__dirname, '..', 'data', 'realms-state.json');

export interface RealmsDAO { name: string; realm: string; }

// Realms DAOs solgov tracks. Add a realm address here to start tracking it.
export const REALMS_DAOS: RealmsDAO[] = [
  { name: 'BonkDAO', realm: '84pGFuy1Y27ApK67ApethaPvexeDWA66zNV8gm38TVeQ' },
  { name: 'MonkeDAO', realm: 'Hcenib1A54LtG4V3TkG4MFYzcLzTqzYKFnttMxAq55c2' },
  { name: 'SamoDAO', realm: 'GC6GDrJTVEY2ZxQ9NaC7n54tvz2HKM5f29LBzP7SjJ6h' },
];

export const REALMS_DAO_NAMES = REALMS_DAOS.map((d) => d.name);

interface RealmsDaoState { seen: string[]; configHash: Record<string, string>; concentrationFlagged?: string[]; }
type RealmsState = Record<string, RealmsDaoState>;
function loadRealmsState(): RealmsState { try { return JSON.parse(fs.readFileSync(REALMS_STATE_FILE, 'utf-8')); } catch { return {}; } }
function saveRealmsState(s: RealmsState): void { try { fs.writeFileSync(REALMS_STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* best effort */ } }

// Proposal names are decoded from third-party on-chain instruction data. Strip
// control characters and line breaks, collapse whitespace, and cap the length so
// a crafted name cannot inject structure into a Telegram message, the activity
// feed, or the LLM triage prompt. Kept as literal text (no HTML entities) so the
// React dashboard renders it correctly; HTML sinks escape separately.
export function cleanProposalName(raw: string): string {
  const s = (raw || '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.length > 200 ? s.slice(0, 197) + '…' : s;
}

// Escape the HTML-significant characters for Telegram parse_mode HTML, which also
// neutralises markup injection into the risk-team thread. Applied only at the
// Telegram boundary; the stored activity feed keeps the literal cleaned name.
export function escapeHtml(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Proposal name + creation unix time, decoded from the CreateProposal (variant 6)
// instruction of the proposal's creation tx. Validated against BonkDAO BIP #76.
export async function getProposalDetail(conn: Connection, proposal: string): Promise<{ name: string; createdAt: number }> {
  let sigs = await conn.getSignaturesForAddress(new PublicKey(proposal), { limit: 1000 });
  if (!sigs.length) return { name: '(unknown)', createdAt: 0 };
  // Page back to the true oldest signature (the creation tx) for heavily-voted proposals.
  while (sigs.length === 1000) {
    const older = await conn.getSignaturesForAddress(new PublicKey(proposal), { limit: 1000, before: sigs[sigs.length - 1].signature });
    if (!older.length) break;
    sigs = older;
  }
  const oldest = sigs[sigs.length - 1];
  const createdAt = oldest.blockTime || 0;
  const tx = await conn.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0 });
  const ixs: any[] = [...(tx?.transaction.message.instructions || []), ...((tx?.meta?.innerInstructions || []).flatMap((i) => i.instructions))];
  for (const ix of ixs) {
    const pid = ix.programId?.toBase58?.() || ix.programId;
    if (pid !== REALMS_PROGRAM.toBase58() || ix.parsed || !ix.data) continue;
    const data = Buffer.from(bs58.decode(ix.data));
    if (data[0] !== 6) continue; // CreateProposal
    try { const len = data.readUInt32LE(1); if (len > 0 && len < 500) return { name: cleanProposalName(data.subarray(5, 5 + len).toString('utf8')), createdAt }; } catch { /* fall through */ }
  }
  return { name: '(unnamed)', createdAt };
}

export interface RealmsAlert { dao: string; type: string; severity: 'CRITICAL' | 'HIGH' | 'MONITOR'; message: string; authority?: string; }

// Scan every tracked Realms DAO. New proposals and config changes are appended to the
// activity feed; a DAO's first scan backfills up to `backfillLimit` recent proposals so
// the feed isn't empty. Returns alerts + watching lines for the monitor's report.
export async function scanRealmsDAOs(conn: Connection, opts: { backfillLimit?: number; dryRun?: boolean } = {}): Promise<{ alerts: RealmsAlert[]; watching: string[] }> {
  const backfillLimit = opts.backfillLimit ?? 40;
  const dry = opts.dryRun ?? false;
  const state = loadRealmsState();
  const alerts: RealmsAlert[] = [];
  const watching: string[] = [];
  const emit = (dao: string, type: string, detail: string, gov: string, ts?: string) => {
    if (dry) console.log(`  [feed] ${dao} | ${type} | ${detail}${ts ? ' @ ' + ts.slice(0, 10) : ''}`);
    else appendActivity(dao, type, detail, gov, ts);
  };

  for (const dao of REALMS_DAOS) {
    const st: RealmsDaoState = state[dao.name] || { seen: [], configHash: {} };
    const govs = await getGovernancesForRealm(conn, dao.realm);

    for (const g of govs) {
      const hash = `${g.voteThresholdLabel}|${g.holdUpTimeSec}|${g.minCommunityWeight}`;
      if (st.configHash[g.governance] && st.configHash[g.governance] !== hash) {
        const d = `governance config changed: ${g.voteThresholdLabel}, timelock ${g.holdUpTimeSec / 3600}h`;
        emit(dao.name, 'ConfigChange', d, g.governance);
        alerts.push({ dao: dao.name, type: 'ConfigChange', severity: 'HIGH', message: `<b>${dao.name}</b> ${d}` });
      }
      st.configHash[g.governance] = hash;
    }

    const all: Array<{ proposal: string; state: string; governance: string }> = [];
    for (const g of govs) { for (const p of await getProposals(conn, g.governance)) all.push({ proposal: p.proposal, state: p.state, governance: g.governance }); }
    const firstScan = st.seen.length === 0;

    let toEmit: Array<{ proposal: string; state: string; governance: string; name?: string; createdAt?: number }> = [];
    if (firstScan) {
      // Backfill proposals with their real creation dates. Date all, emit the most recent N,
      // oldest first so the append order leaves the feed ending on the most recent.
      const dated: Array<{ proposal: string; state: string; governance: string; name: string; createdAt: number }> = [];
      for (const p of all) { const d = await getProposalDetail(conn, p.proposal); dated.push({ ...p, name: d.name, createdAt: d.createdAt }); await sleep(100); }
      dated.sort((a, b) => a.createdAt - b.createdAt);
      toEmit = dated.slice(-backfillLimit);
      console.log(`  ${dao.name}: first scan, backfilling ${toEmit.length} of ${all.length} proposals`);
    } else {
      const fresh = all.filter((p) => !st.seen.includes(p.proposal));
      for (const p of fresh) { const d = await getProposalDetail(conn, p.proposal); toEmit.push({ ...p, name: d.name, createdAt: d.createdAt }); await sleep(120); }
    }

    for (const p of toEmit) {
      const intent = await analyzeProposalInstructions(conn, p.proposal);
      const nameOrShort = p.name || p.proposal.slice(0, 8);
      const base = `${nameOrShort} [${p.state}]`;
      // Only a drain-scale move gets the distinct type + orange flag; a small grant or
      // sponsorship stays a routine ProposalCreated so it does not read like an exploit.
      const label = intent.largeMove ? `${base} · ${intent.summary}` : base;
      const evType = intent.largeMove ? 'TreasuryProposal' : 'ProposalCreated';
      emit(dao.name, evType, label, p.governance, p.createdAt ? new Date(p.createdAt * 1000).toISOString() : undefined);
      if (!firstScan) {
        const sev: 'CRITICAL' | 'HIGH' | 'MONITOR' = intent.largeMove ? 'HIGH' : (p.state === 'Voting' ? 'HIGH' : 'MONITOR');
        // Escape the third-party proposal name for the HTML Telegram message. dao.name
        // and intent.summary are generated internally, so they carry the intended markup.
        const msg = intent.largeMove
          ? `<b>${dao.name}</b> proposal ${intent.summary}: "${escapeHtml(nameOrShort)}"`
          : `<b>${dao.name}</b> new proposal: ${escapeHtml(nameOrShort)} [${p.state}]`;
        alerts.push({ dao: dao.name, type: evType, severity: sev, message: msg });
      }
      await sleep(120);
    }

    // Live proposals: flag only where one wallet holds ~all the yes vote AND its stake
    // alone reaches quorum (it could pass the proposal single-handedly). Raw concentration
    // is normal in any token DAO; a single wallet meeting quorum is the takeover pattern.
    // A proposal can sit in the Voting state forever if nobody finalises it. Exclude ones
    // whose voting window closed long ago (dead proposals, like MonkeDAO's 2022 test set)
    // so the "in voting" count and the concentration check only see genuinely open votes.
    const govByPk = new Map(govs.map((g) => [g.governance, g]));
    const nowSec = Date.now() / 1000;
    const liveProps: Array<{ proposal: string; state: string; governance: string }> = [];
    for (const x of all) {
      if (x.state !== 'Voting' && x.state !== 'SigningOff') continue;
      const windowSec = (govByPk.get(x.governance)?.baseVotingTimeSec || 3 * 86400) + 7 * 86400; // voting period + a week grace
      try {
        const sigs = await conn.getSignaturesForAddress(new PublicKey(x.proposal), { limit: 1 });
        const last = sigs[0]?.blockTime || 0;
        if (last && nowSec - last <= windowSec) liveProps.push(x);
      } catch { liveProps.push(x); }
      await sleep(60);
    }
    if (liveProps.length > 0) {
      const cmint = await realmCommunityMint(conn, dao.realm);
      let supplyUi = 0, decimals = 0;
      try { const s = await conn.getTokenSupply(new PublicKey(cmint)); supplyUi = s.value.uiAmount || 0; decimals = s.value.decimals; } catch { /* unknown supply */ }
      const flagged = st.concentrationFlagged || [];
      const liveSet = new Set(liveProps.map((x) => x.proposal));
      for (const p of liveProps) {
        if (flagged.includes(p.proposal)) continue; // already flagged, do not re-fire each scan
        const va = await analyzeVotes(conn, p.proposal);
        const gcfg = govByPk.get(p.governance);
        const quorumUi = gcfg && gcfg.voteThresholdKind !== 2 && supplyUi > 0 ? (gcfg.voteThresholdPct / 100) * supplyUi : Infinity;
        const topUi = va ? va.topWeight / Math.pow(10, decimals) : 0;
        if (va && va.concentration >= 0.9 && topUi >= quorumUi) {
          const detail = await getProposalDetail(conn, p.proposal);
          const d = `one wallet (${va.topVoter.slice(0, 8)}) holds ${(va.concentration * 100).toFixed(1)}% of the yes vote and reaches quorum alone on "${detail.name}"`;
          emit(dao.name, 'VoteConcentration', d, p.governance);
          // d embeds the third-party proposal name; escape the whole line for the HTML
          // message (d carries no intended markup, so escaping only touches the name).
          alerts.push({ dao: dao.name, type: 'VoteConcentration', severity: 'HIGH', message: `<b>${dao.name}</b> ${escapeHtml(d)}`, authority: va.topVoter });
          flagged.push(p.proposal);
        }
        await sleep(120);
      }
      st.concentrationFlagged = flagged.filter((pr) => liveSet.has(pr)); // prune to still-live proposals
      watching.push(`• ${dao.name}: ${liveProps.length} proposal(s) in voting`);
    }

    st.seen = all.map((p) => p.proposal);
    state[dao.name] = st;
  }

  if (!dry) saveRealmsState(state);
  return { alerts, watching };
}

// ============================================================
// DAO risk profile ("attacker attractiveness") for the dashboard DAO tab.
// The governance-attack blast radius is the value held DIRECTLY in
// governance-controlled accounts (what a passed proposal can move), not the
// total DAO treasury. Cost-to-seize is quorum% x the governing token's market
// cap. Validated against BonkDAO (1% x $358M cap = ~$3.6M seize cost).
// ============================================================

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WSOL = 'So11111111111111111111111111111111111111112';
const SOL_PRICE_FALLBACK = 190;

async function llamaPrice(mint: string): Promise<number> {
  try { const j: any = await (await fetch(`https://coins.llama.fi/prices/current/solana:${mint}`)).json(); return j.coins?.[`solana:${mint}`]?.price || 0; } catch { return 0; }
}

async function realmCommunityMint(conn: Connection, realm: string): Promise<string> {
  const acc = await conn.getAccountInfo(new PublicKey(realm));
  return acc ? new PublicKey((acc.data as Buffer).subarray(1, 33)).toBase58() : '';
}

// True if the realm-config sets a community voter-weight addin. Reported as a
// neutral fact, not equated with staked/locked voting (BonkDAO had one and was liquid).
async function hasVoterWeightPlugin(conn: Connection, realm: string): Promise<boolean> {
  const [rc] = PublicKey.findProgramAddressSync([Buffer.from('realm-config'), new PublicKey(realm).toBuffer()], REALMS_PROGRAM);
  const acc = await conn.getAccountInfo(rc);
  return acc ? (acc.data as Buffer)[33] === 1 : false;
}

// USD value held in the governance-controlled accounts (native treasury + governance
// PDAs), the value a passed proposal could move directly. Tokens are priced where a
// price is available; tokens that cannot be priced are flagged separately so a drained
// or empty treasury is not overstated by a token balance with no market value.
async function governanceHeldValue(conn: Connection, governances: GovernanceConfig[]): Promise<{ sol: number; solUsd: number; tokenUsd: number; totalUsd: number; holdsTokens: boolean; holdsUnpricedTokens: boolean }> {
  let sol = 0, tokenUsd = 0, holdsTokens = false, holdsUnpricedTokens = false;
  const solPrice = (await llamaPrice(WSOL)) || SOL_PRICE_FALLBACK;
  const priceCache: Record<string, number> = {};
  for (const g of governances) {
    const govPk = new PublicKey(g.governance);
    const [nt] = PublicKey.findProgramAddressSync([Buffer.from('native-treasury'), govPk.toBuffer()], REALMS_PROGRAM);
    for (const owner of [govPk, nt]) {
      sol += (await conn.getBalance(owner)) / 1e9;
      try {
        const t = await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM });
        for (const a of t.value) {
          const info = a.account.data.parsed.info;
          const amt = Number(info.tokenAmount.uiAmount || 0);
          if (amt <= 0) continue;
          holdsTokens = true;
          const mint = info.mint as string;
          if (!(mint in priceCache)) priceCache[mint] = await llamaPrice(mint);
          if (priceCache[mint] > 0) tokenUsd += amt * priceCache[mint];
          else holdsUnpricedTokens = true;
        }
      } catch { /* ignore */ }
    }
  }
  const solUsd = sol * solPrice;
  return { sol, solUsd, tokenUsd, totalUsd: solUsd + tokenUsd, holdsTokens, holdsUnpricedTokens };
}

export interface DaoRiskProfile {
  name: string; realm: string; updatedAt: string;
  quorumLabel: string; timelockHours: number; votingPeriodHours: number;
  proposalThresholdRaw: number; proposalThresholdTokens: number;
  tokenMcapUsd: number; costToSeizeUsd: number;
  governanceHeldSol: number; governanceHeldUsd: number; holdsTokens: boolean; holdsUnpricedTokens: boolean;
  voterWeightPlugin: boolean;
  liveProposals: number; totalProposals: number;
}

// Full attacker-lens profile for one DAO.
export async function daoRiskProfile(conn: Connection, dao: RealmsDAO, ts: string): Promise<DaoRiskProfile> {
  const govs = await getGovernancesForRealm(conn, dao.realm);
  const worst = govs.slice().sort((a, b) => a.voteThresholdPct - b.voteThresholdPct)[0];
  const mint = await realmCommunityMint(conn, dao.realm);
  const supplyRes = mint ? await conn.getTokenSupply(new PublicKey(mint)).catch(() => null) : null;
  const supply = supplyRes?.value.uiAmount || 0;
  const decimals = supplyRes?.value.decimals || 0;
  const price = mint ? await llamaPrice(mint) : 0;
  const mcap = supply * price;
  const held = await governanceHeldValue(conn, govs);
  const plugin = await hasVoterWeightPlugin(conn, dao.realm);
  let total = 0, live = 0;
  for (const g of govs) { const ps = await getProposals(conn, g.governance); total += ps.length; live += ps.filter(p => p.state === 'Voting' || p.state === 'SigningOff').length; }
  const quorumFrac = worst && worst.voteThresholdKind !== 2 ? worst.voteThresholdPct / 100 : 1;
  return {
    name: dao.name, realm: dao.realm, updatedAt: ts,
    quorumLabel: worst?.voteThresholdLabel || 'n/a',
    timelockHours: (worst?.holdUpTimeSec || 0) / 3600,
    votingPeriodHours: (worst?.baseVotingTimeSec || 0) / 3600,
    proposalThresholdRaw: worst?.minCommunityWeight || 0,
    proposalThresholdTokens: worst ? worst.minCommunityWeight / Math.pow(10, decimals) : 0,
    tokenMcapUsd: mcap, costToSeizeUsd: mcap * quorumFrac,
    governanceHeldSol: held.sol, governanceHeldUsd: held.totalUsd, holdsTokens: held.holdsTokens, holdsUnpricedTokens: held.holdsUnpricedTokens,
    voterWeightPlugin: plugin,
    liveProposals: live, totalProposals: total,
  };
}

const DAO_SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'dao-risk.json');

// Generate risk profiles for the tracked DAOs and write the snapshot the API serves.
export async function writeDaoRiskSnapshot(conn: Connection): Promise<DaoRiskProfile[]> {
  const ts = new Date().toISOString();
  const daos: DaoRiskProfile[] = [];
  for (const dao of REALMS_DAOS) daos.push(await daoRiskProfile(conn, dao, ts));
  try { fs.writeFileSync(DAO_SNAPSHOT_FILE, JSON.stringify({ updatedAt: ts, daos }, null, 2)); } catch { /* best effort */ }
  return daos;
}

// CLI test: `npx tsx src/realms.ts <realmPubkey>` (defaults to BonkDAO),
// `npx tsx src/realms.ts scan` to dry-run the DAO-list scan, or
// `npx tsx src/realms.ts snapshot` to write the DAO-risk snapshot.
if (require.main === module) {
  (async () => {
    require('dotenv').config();
    const conn = new Connection(process.env.HELIUS_RPC_URL!, 'confirmed');
    if (process.argv[2] === 'scan') {
      const { alerts, watching } = await scanRealmsDAOs(conn, { dryRun: true });
      console.log(`\nalerts: ${alerts.length}`);
      alerts.forEach((a) => console.log(`  [${a.severity}] ${a.message}`));
      console.log(`watching:\n${watching.join('\n') || '  (none)'}`);
      return;
    }
    if (process.argv[2] === 'votes') {
      const va = await analyzeVotes(conn, process.argv[3]);
      console.log(JSON.stringify(va, null, 2));
      if (va) console.log(`\nconcentration ${(va.concentration * 100).toFixed(3)}% -> ${va.concentration >= 0.9 ? 'WOULD FLAG (>= 90%)' : 'ok'}`);
      return;
    }
    if (process.argv[2] === 'snapshot') {
      const daos = await writeDaoRiskSnapshot(conn);
      console.log(`wrote ${daos.length} DAOs to ${DAO_SNAPSHOT_FILE}`);
      for (const d of daos) console.log(`  ${d.name}: seize $${Math.round(d.costToSeizeUsd).toLocaleString()}, timelock ${d.timelockHours}h, gov-held ${d.holdsTokens ? 'tokens+' : ''}${d.governanceHeldSol.toFixed(1)} SOL, proposals ${d.totalProposals} (${d.liveProposals} live)`);
      return;
    }
    const realm = process.argv[2] || '84pGFuy1Y27ApK67ApethaPvexeDWA66zNV8gm38TVeQ';
    const scan = await scanRealm(conn, realm);
    console.log(`Realm ${realm}  |  max risk ${scan.maxRiskScore}/10\n`);
    for (const g of scan.governances) {
      console.log(`Governance ${g.config.governance}`);
      console.log(`  vote threshold: ${g.config.voteThresholdLabel}  |  timelock: ${g.risk.timelockHours}h  |  proposal threshold: ${g.config.minCommunityWeight.toLocaleString()} raw`);
      console.log(`  proposals: ${g.proposals} (${g.votingNow} live)  |  RISK ${g.risk.score}/10  ${g.risk.labels.length ? '[' + g.risk.labels.join(', ') + ']' : ''}\n`);
    }
  })().catch(e => { console.error('ERR', e.message); process.exit(1); });
}
