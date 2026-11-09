// Transaction history for replay, read once and cached in data/replay/history/<address>.json.
//
// Uses getTransactionsForAddress (50 credits per 100 transactions, ascending, resumable by slot), the
// same call gov-activity.ts uses. The cache stores a compact form: signature, slot, block time and
// every instruction (top-level and inner) with its program and account keys resolved, so detectors can
// be re-run any number of times at no further cost. Only successful transactions are kept.

import * as fs from 'fs';
import * as path from 'path';
import bs58 from 'bs58';
import { readJsonStrict, writeJsonAtomic } from '../utils/json-file';

export const HISTORY_DIR = path.join(__dirname, '..', '..', 'data', 'replay', 'history');

export interface CompactIx {
  p: string;       // program id
  a: string[];     // account keys in instruction order
  d: string;       // instruction data, base58 (as returned by the RPC)
  inner: boolean;  // true for CPI (inner) instructions
}

export interface CompactTx {
  sig: string;
  slot: number;
  time: number;
  feePayer: string;
  ixs: CompactIx[];
}

export interface HistoryFile {
  address: string;
  complete: boolean;  // read to the tip at fetchedAt
  fetchedAt: string;
  lastSlot: number;
  txs: CompactTx[];
}

export function compactTx(tx: any): CompactTx {
  const msg = tx.transaction.message;
  const keys: string[] = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  const resolve = (ix: any, inner: boolean): CompactIx => ({ p: keys[ix.programIdIndex], a: (ix.accounts || []).map((i: number) => keys[i]), d: ix.data, inner });
  const ixs: CompactIx[] = msg.instructions.map((ix: any) => resolve(ix, false));
  for (const g of tx.meta?.innerInstructions || []) for (const ix of g.instructions) ixs.push(resolve(ix, true));
  return { sig: tx.transaction.signatures[0], slot: tx.slot, time: tx.blockTime || 0, feePayer: msg.accountKeys[0], ixs };
}

export function ixData(ix: CompactIx): Buffer {
  try { return Buffer.from(bs58.decode(ix.d)); } catch { return Buffer.alloc(0); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchPage(rpc: string, address: string, fromSlot: number): Promise<any[]> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 'replay', method: 'getTransactionsForAddress',
    params: [address, {
      transactionDetails: 'full', sortOrder: 'asc', limit: 100, encoding: 'json', maxSupportedTransactionVersion: 0,
      filters: { status: 'succeeded', ...(fromSlot > 0 ? { slot: { gte: fromSlot } } : {}) },
    }],
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const j: any = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result?.data || [];
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export function historyPath(address: string): string {
  return path.join(HISTORY_DIR, `${address}.json`);
}

export function loadHistory(address: string): HistoryFile | null {
  return readJsonStrict<HistoryFile | null>(historyPath(address), null);
}

// Reads (or tops up) an address's full history. With refresh=false a complete cached file is returned
// as-is and costs nothing. Returns the file and the number of paid pages read.
export async function ensureHistory(rpc: string, address: string, opts: { refresh?: boolean; maxPages?: number } = {}): Promise<{ file: HistoryFile; pages: number }> {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const file: HistoryFile = loadHistory(address) || { address, complete: false, fetchedAt: '', lastSlot: 0, txs: [] };
  if (file.complete && !opts.refresh) return { file, pages: 0 };
  const seen = new Set(file.txs.map(t => t.sig));
  const maxPages = opts.maxPages ?? 500;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) break;
    const data = await fetchPage(rpc, address, file.lastSlot);
    pages++;
    const fresh = data.filter(tx => !seen.has(tx.transaction.signatures[0]) && !tx.meta?.err);
    for (const tx of fresh) {
      const c = compactTx(tx);
      seen.add(c.sig);
      file.txs.push(c);
      if (c.slot > file.lastSlot) file.lastSlot = c.slot;
    }
    if (fresh.length === 0 || data.length < 100) { file.complete = true; break; }
    await sleep(150);
  }
  file.fetchedAt = new Date().toISOString();
  file.txs.sort((x, y) => x.slot - y.slot);
  writeJsonAtomic(historyPath(address), file);
  return { file, pages };
}
