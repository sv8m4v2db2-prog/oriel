import { isIP } from 'node:net';

/** The 8 groups of an IPv6 address (lowercase hex without leading zeros), embedded IPv4 included. */
function ipv6Groups(address: string): string[] {
  let text = address;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16).toString(16));
}

/**
 * Rate-limit identity of a client address. IPv4 as is (IPv4-mapped IPv6 unwrapped); IPv6 by /64
 * prefix: a single host usually owns a whole /64 and could otherwise rotate source addresses to
 * get a fresh quota on every attempt.
 */
export function clientKey(ip: string | undefined): string {
  let address = (ip ?? '').trim().toLowerCase();
  if (address.startsWith('[')) address = address.slice(1, address.includes(']') ? address.indexOf(']') : undefined);
  if (address.includes('%')) address = address.slice(0, address.indexOf('%'));
  if (isIP(address) !== 6) return address;
  const g = ipv6Groups(address);
  if (g.slice(0, 5).every((x) => x === '0') && g[5] === 'ffff') {
    const hi = parseInt(g[6]!, 16);
    const lo = parseInt(g[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${g.slice(0, 4).join(':')}::/64`;
}

/** Fixed-window in-memory rate limiter (per key, e.g. "auth:<clientKey(ip)>"). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; returns false when the key exceeded its quota for the current window. */
  hit(key: string, now = Date.now()): boolean {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
      if (this.hits.size > 10_000) this.prune(now);
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
