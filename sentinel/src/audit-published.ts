// Weekly audit of what solgov publishes, for everything that can be checked by machine.
//
//   1. Figures written into protocol notes (thresholds such as "3/5", "no timelock") against the live
//      multisig state the listener keeps in monitor-state.json.
//   2. Point-in-time amounts in notes ("$X in vault"), which go stale and should not be published.
//   3. "read on-chain <date>" statements and research updatedAt dates older than MAX_AGE_DAYS.
//   4. Every source URL cited in protocols.ts: dead links and redirects to a site root.
//   5. Static fallback values (threshold, members, timelock) that no longer match live state.
//
// Research that cannot be checked by machine keeps its "Updated" date on the dashboard; this audit
// flags when that date is old. Findings go to data/published-audit.json and, when they change, to the
// internal risk-team Telegram thread. Nothing here is public.
//
//   node -r ts-node/register/transpile-only src/audit-published.ts [--no-telegram] [--skip-links]

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import 'dotenv/config';
import { readJsonStrict, writeJsonAtomic } from './utils/json-file';
import { protocolsSourcePath } from './utils/protocols-source';
import { escapeHtml, splitTelegramHtml } from './utils/telegram-html';

const DATA = path.join(__dirname, '..', 'data');
const STATE_FILE = process.env.AUDIT_STATE_FILE || path.join(DATA, 'monitor-state.json');
const OUT_FILE = path.join(DATA, 'published-audit.json');
const MAX_AGE_DAYS = 60;
const RISK_TEAM_THREAD = 75;

export interface Finding { protocol: string; kind: string; detail: string }

interface Entry {
  name: string;
  block: string;
  threshold: number | null;
  totalMembers: number | null;
  activeVoters: number | null;
  timelockSeconds: number | null;
  notes: { field: string; text: string }[];
  updatedAt: string[];
  urls: string[];
}

const NOTE_FIELDS = ['other', 'authorityRoleNote', 'governanceRolesNote', 'custodyNote', 'reimbursementPolicy', 'programTimelockNote', 'historicalReimbursement'];

export function parseEntries(src: string): Entry[] {
  return src.split(/\n    name: '/).slice(1).map(block => {
    const name = block.slice(0, block.indexOf("'"));
    const num = (k: string) => { const m = new RegExp(`\\n    ${k}: (-?\\d+),`).exec(block); return m ? Number(m[1]) : null; };
    const notes: Entry['notes'] = [];
    for (const field of NOTE_FIELDS) {
      for (const m of block.matchAll(new RegExp(`${field}: '((?:[^'\\\\]|\\\\.)*)'`, 'g'))) notes.push({ field, text: m[1].replace(/\\'/g, "'") });
    }
    const updatedAt = [...block.matchAll(/updatedAt: '(\d{4}-\d{2}-\d{2})'/g)].map(m => m[1]);
    const urls = Array.from(new Set([...block.matchAll(/https?:\/\/[^\s'",)]+/g)].map(m => m[0].replace(/[.;]$/, ''))));
    return { name, block, threshold: num('threshold'), totalMembers: num('totalMembers'), activeVoters: num('activeVoters'), timelockSeconds: num('timelockSeconds'), notes, updatedAt, urls };
  });
}

const govWords = /threshold|multisig|voters|members|signers|Squads|upgrade|admin|council/i;
const daysSince = (d: string, now: number) => Math.floor((now - Date.parse(d + 'T00:00:00Z')) / 86400000);

// Checks 1, 2, 3 and 5 for one entry against its live state (null when not tracked live).
export function auditEntry(e: Entry, live: any, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  const add = (kind: string, detail: string) => out.push({ protocol: e.name, kind, detail });
  const members: string[] = Array.isArray(live?.members) ? live.members : [];
  const perms = Object.values(live?.memberPerms || {}) as string[];
  const voters = perms.length ? perms.filter(p => /Full|Vote/.test(p)).length : members.length;

  for (const { field, text } of e.notes) {
    if (members.length && typeof live.threshold === 'number') {
      for (const m of text.matchAll(/(\d+)\s*\/\s*(\d+)(?![\d%])/g)) {
        const a = +m[1], c = +m[2];
        const ctx = text.slice(Math.max(0, m.index! - 60), m.index! + 60);
        if (!govWords.test(ctx)) continue;
        // History ("changed from 2/5 to 2/3", "created as 2/2") is fine; only flag a figure that looks
        // like the current headline but does not match it.
        if (/from|previous|former|earlier|was |created as|reduced|bumped|interim|historical|before|describe|docs /i.test(ctx)) continue;
        const looksHeadline = a === live.threshold || c === members.length || c === voters;
        const matches = a === live.threshold && (c === voters || c === members.length);
        if (looksHeadline && !matches) add('note-figure', `${field}: "${m[0]}" but live is ${live.threshold}/${voters} (${members.length} total)`);
      }
      if (/\b(no|zero) timelock\b/i.test(text) && live.timeLock > 0 && !/former|previous|interim|earlier|main multisig|treasury/i.test(text)) {
        add('note-timelock', `${field}: says no timelock but live timelock is ${live.timeLock}s`);
      }
    }
    for (const m of text.matchAll(/\$[\d.,]+\s*[kKmMbB]?\+?\s+(?:in (?:the )?vault|TVL)/g)) add('point-in-time', `${field}: "${m[0]}"`);
    for (const m of text.matchAll(/read on-chain (\d{4}-\d{2}-\d{2})/g)) {
      if (daysSince(m[1], now) > MAX_AGE_DAYS) add('stale-read', `${field}: "read on-chain ${m[1]}" is ${daysSince(m[1], now)} days old`);
    }
  }
  for (const d of e.updatedAt) if (daysSince(d, now) > MAX_AGE_DAYS) add('stale-research', `updatedAt ${d} is ${daysSince(d, now)} days old`);

  if (members.length && typeof live.threshold === 'number') {
    if (e.threshold !== null && e.threshold !== live.threshold) add('fallback-drift', `static threshold ${e.threshold}, live ${live.threshold}`);
    if (e.totalMembers !== null && e.totalMembers !== members.length) add('fallback-drift', `static totalMembers ${e.totalMembers}, live ${members.length}`);
    if (e.activeVoters !== null && e.activeVoters !== voters) add('fallback-drift', `static activeVoters ${e.activeVoters}, live ${voters}`);
    if (e.timelockSeconds !== null && e.timelockSeconds >= 0 && typeof live.timeLock === 'number' && e.timelockSeconds !== live.timeLock) add('fallback-drift', `static timelock ${e.timelockSeconds}s, live ${live.timeLock}s`);
  }
  return out;
}

async function checkUrl(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (solgov link check)' } });
    if (r.status === 404 || r.status === 410 || r.status >= 500) return `HTTP ${r.status}`;
    const final = new URL(r.url);
    const orig = new URL(url);
    if (orig.pathname.length > 1 && (final.pathname === '/' || final.pathname === '') && final.host === orig.host) return `redirects to the site root`;
    return null;
  } catch (e: any) {
    return e?.name === 'AbortError' ? 'timed out' : `failed (${String(e?.message || e).slice(0, 60)})`;
  } finally {
    clearTimeout(t);
  }
}

async function sendRiskTeam(html: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  for (const part of splitTelegramHtml(html)) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: part, parse_mode: 'HTML', message_thread_id: RISK_TEAM_THREAD, disable_web_page_preview: true }),
    }).catch(() => undefined);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const entries = parseEntries(fs.readFileSync(protocolsSourcePath(), 'utf-8'));
  if (!entries.length) throw new Error('no entries parsed from protocols.ts');
  let state: any = {};
  try { state = readJsonStrict<any>(STATE_FILE, {}); } catch (e: any) { console.error(`monitor-state unreadable: ${e.message}`); }

  const findings: Finding[] = [];
  for (const e of entries) findings.push(...auditEntry(e, state[e.name]));

  if (!args.includes('--skip-links')) {
    const urls = new Map<string, string[]>();
    for (const e of entries) for (const u of e.urls) urls.set(u, [...(urls.get(u) || []), e.name]);
    for (const [url, owners] of urls) {
      const problem = await checkUrl(url);
      if (problem) for (const o of owners) findings.push({ protocol: o, kind: 'dead-link', detail: `${url} ${problem}` });
      await new Promise(r => setTimeout(r, 300));
    }
  }

  let previous: { fingerprint?: string } = {};
  try { previous = readJsonStrict<any>(OUT_FILE, {}); } catch {}
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(findings.map(f => [f.protocol, f.kind, f.detail]))).digest('hex');
  writeJsonAtomic(OUT_FILE, { checkedAt: new Date().toISOString(), fingerprint, count: findings.length, findings });

  const byKind: Record<string, number> = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  console.log(`${entries.length} protocols, ${findings.length} finding(s)`, byKind);
  for (const f of findings) console.log(`  ${f.protocol.padEnd(22)} ${f.kind.padEnd(15)} ${f.detail.slice(0, 160)}`);

  if (!args.includes('--no-telegram') && findings.length && fingerprint !== previous.fingerprint) {
    const lines = findings.slice(0, 60).map(f => `• <b>${escapeHtml(f.protocol)}</b> ${escapeHtml(f.kind)}: ${escapeHtml(f.detail.slice(0, 180))}`);
    await sendRiskTeam(`<b>Published data audit</b>: ${findings.length} item(s) to review\n${lines.join('\n')}${findings.length > 60 ? `\n…and ${findings.length - 60} more in data/published-audit.json` : ''}`);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
