// Which immediate peers may set X-Forwarded-* headers (TRUST_PROXY).
import { BlockList, isIP } from 'node:net';

/**
 * - `false`: never trust X-Forwarded-* (server exposed directly);
 * - `true` (default): trust the immediate peer only when it is on the loopback or a private network
 *   (Caddy/Nginx on the same host, or in the same Docker network);
 * - a list of IPs, CIDRs and the keywords `loopback` / `private`: trust exactly those peers (e.g. a
 *   proxy or CDN with public addresses).
 * Trusting any peer would let a client exposed directly choose its own IP (per-IP rate limits) and
 * its Host / protocol (QA-HTTP-03).
 */
export type TrustProxySetting = boolean | string[];

type Subnet = [network: string, prefix: number, family: 'ipv4' | 'ipv6'];

const LOOPBACK: Subnet[] = [
  ['127.0.0.0', 8, 'ipv4'],
  ['::1', 128, 'ipv6'],
];
const PRIVATE: Subnet[] = [
  ...LOOPBACK,
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
];
const KEYWORDS: Record<string, Subnet[]> = { loopback: LOOPBACK, private: PRIVATE };

const family = (address: string): 'ipv4' | 'ipv6' | null => {
  const v = isIP(address);
  return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
};

/** "10.0.0.0/8", "2001:db8::1", "private"… → subnets; throws on anything else. */
function subnetsOf(entry: string): Subnet[] {
  const keyword = KEYWORDS[entry.toLowerCase()];
  if (keyword) return keyword;
  const [address = '', prefixText, ...rest] = entry.split('/');
  const fam = family(address);
  const max = fam === 'ipv4' ? 32 : 128;
  const prefix = prefixText === undefined ? max : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
  if (!fam || rest.length > 0 || !(prefix >= 0 && prefix <= max)) {
    throw new Error(`TRUST_PROXY : entrée invalide « ${entry} » (attendu : true, false, ou une liste d'adresses IP, de plages CIDR, « loopback », « private »).`);
  }
  return [[address, prefix, fam]];
}

/** Parses the TRUST_PROXY environment variable. Empty = default (`true`). */
export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  const text = (value ?? '').trim();
  if (text === '') return true;
  const lower = text.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  const entries = text.split(',').map((e) => e.trim()).filter(Boolean);
  entries.forEach(subnetsOf); // validate now: a typo must not silently trust (or distrust) the proxy
  return entries;
}

/** Predicate "this immediate peer may set X-Forwarded-*"; throws on an invalid list entry. */
export function proxyTrust(setting: TrustProxySetting): (address: string | undefined) => boolean {
  if (setting === false) return () => false;
  const list = new BlockList();
  for (const entry of setting === true ? ['private'] : setting) {
    for (const [network, prefix, fam] of subnetsOf(entry)) list.addSubnet(network, prefix, fam);
  }
  return (address) => {
    if (!address) return false;
    // Zone ids (fe80::1%en0) and brackets are not part of the address.
    const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const fam = family(bare);
    // BlockList matches IPv4-mapped IPv6 peers (::ffff:10.0.0.2) against the IPv4 subnets.
    return fam !== null && list.check(bare, fam);
  };
}
