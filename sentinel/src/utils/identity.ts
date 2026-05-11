// Wallet identity resolution: Helius batch lookups plus a local known-address registry.

import * as fs from 'fs';
import * as path from 'path';
import { batchWalletIdentity } from './helius-api';

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'identity-cache.json');
const TTL_KNOWN_MS = 30 * 24 * 3600 * 1000;
const TTL_UNKNOWN_MS = 3 * 24 * 3600 * 1000;

interface CacheEntry {
  label: string | null;
  type: string | null;
  tags: string[];
  fetchedAt: number;
}

let cache: Record<string, CacheEntry> | null = null;

function loadCache(): Record<string, CacheEntry> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    cache = {};
  }
  return cache!;
}

function saveCache() {
  if (!cache) return;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e: any) {
    console.error('[identity] cache write failed:', e.message);
  }
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.label ? TTL_KNOWN_MS : TTL_UNKNOWN_MS;
  return Date.now() - entry.fetchedAt < ttl;
}

/**
 * Resolve identity labels for up to 100 addresses in one Helius call.
 * Reads cache first, only queries for stale/missing entries.
 * Safe to call with unknown addresses - they're cached as null.
 */
export async function resolveIdentities(addresses: string[]): Promise<Record<string, CacheEntry>> {
  if (addresses.length === 0) return {};
  const c = loadCache();
  const out: Record<string, CacheEntry> = {};
  const toFetch: string[] = [];

  for (const addr of addresses) {
    const entry = c[addr];
    if (entry && isFresh(entry)) {
      out[addr] = entry;
    } else {
      toFetch.push(addr);
    }
  }

  if (toFetch.length > 0) {
    try {
      // Split into chunks of 100 (Helius limit)
      for (let i = 0; i < toFetch.length; i += 100) {
        const chunk = toFetch.slice(i, i + 100);
        const results = await batchWalletIdentity(chunk);
        const hits = new Set<string>();
        for (const r of results) {
          hits.add(r.address);
          const entry: CacheEntry = {
            label: r.name || null,
            type: r.type || null,
            tags: r.tags || [],
            fetchedAt: Date.now(),
          };
          c[r.address] = entry;
          out[r.address] = entry;
        }
        // Cache negative results so we don't re-query every time
        for (const addr of chunk) {
          if (!hits.has(addr)) {
            const entry: CacheEntry = { label: null, type: null, tags: [], fetchedAt: Date.now() };
            c[addr] = entry;
            out[addr] = entry;
          }
        }
      }
      saveCache();
    } catch (e: any) {
      console.error('[identity] lookup failed:', e.message);
      // Return cached or empty entries for anything we couldn't fetch
      for (const addr of toFetch) {
        out[addr] = c[addr] || { label: null, type: null, tags: [], fetchedAt: 0 };
      }
    }
  }

  return out;
}

/**
 * Format a pubkey for alert display. Returns either "Name (Abcd...wxyz)" or just "Abcd...wxyz".
 * Synchronous - call resolveIdentities() to pre-warm the cache before formatting.
 */
export function formatAddress(address: string, identity?: CacheEntry): string {
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  if (identity && identity.label) {
    const typeTag = identity.type ? ` [${identity.type}]` : '';
    return `${identity.label}${typeTag} (${short})`;
  }
  return short;
}

/**
 * Convenience: resolve + format one address. Useful for single-address alerts.
 */
export async function labelAddress(address: string): Promise<string> {
  const r = await resolveIdentities([address]);
  return formatAddress(address, r[address]);
}

/**
 * Convenience: resolve + format a list. Returns map of address → formatted label.
 */
export async function labelAddresses(addresses: string[]): Promise<Record<string, string>> {
  const r = await resolveIdentities(addresses);
  const out: Record<string, string> = {};
  for (const addr of addresses) out[addr] = formatAddress(addr, r[addr]);
  return out;
}
