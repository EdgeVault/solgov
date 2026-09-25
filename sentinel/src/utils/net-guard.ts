// Guards for outbound requests to partner-supplied URLs (webhook deliveries). A URL is checked when it
// is registered and again, after DNS resolution, before every delivery, because a public hostname can
// later resolve to a private address.

import { promises as dns } from 'dns';
import * as net from 'net';

function ipv4Private(ip: string): boolean {
  const p = ip.split('.').map(n => parseInt(n, 10));
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function ipv6Private(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1) takes the IPv4 rules.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  const mappedHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 ||   // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 ||        // fe80::/10 link local
    (first & 0xff00) === 0xff00 ||        // ff00::/8 multicast
    s.startsWith('64:ff9b:') ||           // NAT64
    s.startsWith('2001:db8:');            // documentation
}

export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind === 6) return ipv6Private(ip);
  return true;
}

const INTERNAL_NAMES = ['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.goog'];

// Syntactic check used at registration: scheme, credentials, obviously internal names and literal IPs.
export function checkWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'url must be a string' };
  if (raw.length > 2000) return { ok: false, error: 'url too long' };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, error: 'url not parseable' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'url must use http or https' };
  if (parsed.username || parsed.password) return { ok: false, error: 'url must not contain credentials' };
  // URL.hostname keeps the brackets on IPv6 literals.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, error: 'url missing host' };
  if (INTERNAL_NAMES.includes(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return { ok: false, error: 'url targets a non-public host' };
  }
  if (net.isIP(host) && isPrivateAddress(host)) return { ok: false, error: 'url targets a non-public IP range' };
  return { ok: true, url: parsed.toString() };
}

// Resolves the host and rejects if any address it resolves to is private. Called before each delivery.
export async function assertPublicDestination(rawUrl: string): Promise<void> {
  const check = checkWebhookUrl(rawUrl);
  if (!check.ok) throw new Error(check.error);
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error('host did not resolve');
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error('host resolves to a non-public address');
}
