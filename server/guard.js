// Small helpers that make the server safe to put on the public internet:
// who the client really is behind a proxy, which origins may open a socket, and rate limits.

import net from 'node:net';

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT, used inside some hosts
];

const stripV6Prefix = (addr) => String(addr ?? '').replace(/^::ffff:/i, '');

export function isPrivateAddress(addr) {
  const a = stripV6Prefix(addr);
  if (a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  return PRIVATE_V4.some((re) => re.test(a));
}

/**
 * The client's address. Hosting platforms put a proxy in front of the app, so the socket peer is the proxy.
 * X-Forwarded-For is believed only when the direct peer is a private address; a client on the open
 * internet cannot use it to pretend to be someone else.
 */
export function clientIp(req) {
  const peer = stripV6Prefix(req.socket?.remoteAddress);
  if (!isPrivateAddress(peer)) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',').map((s) => s.trim()).filter((s) => net.isIP(s) && !isPrivateAddress(s));
  return forwarded[0] ?? peer;
}

/** True when the request was addressed to this machine directly (localhost or a LAN address). */
export function isLocalHost(hostHeader) {
  const host = String(hostHeader ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || (net.isIP(host) !== 0 && isPrivateAddress(host));
}

/**
 * Browsers always send Origin on a WebSocket handshake. Accept the page's own host, anything listed in
 * ALLOWED_ORIGINS, or no Origin at all (scripts and tests). This stops other websites from using this
 * server as a free relay for their visitors.
 */
export function originAllowed(req, allowed = []) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowed.includes('*')) return true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === String(req.headers.host ?? '').toLowerCase()) return true;
  return allowed.some((a) => {
    try { return new URL(a).host === host; } catch { return a.toLowerCase() === host; }
  });
}

/** Sliding-window counter per key, e.g. "tables created per address per hour". */
export class Hits {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.byKey = new Map();
  }

  #fresh(key, now) {
    const list = (this.byKey.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.byKey.set(key, list); else this.byKey.delete(key);
    return list;
  }

  /** Has this key already used up its allowance? */
  full(key, now = Date.now()) { return this.#fresh(key, now).length >= this.limit; }

  /** Record one use. Returns false (and records nothing) when the allowance is spent. */
  take(key, now = Date.now()) {
    const list = this.#fresh(key, now);
    if (list.length >= this.limit) return false;
    list.push(now);
    this.byKey.set(key, list);
    return true;
  }

  /** Record a use unconditionally, for things like wrong codes that are counted after the fact. */
  add(key, now = Date.now()) {
    const list = this.#fresh(key, now);
    list.push(now);
    this.byKey.set(key, list);
  }

  sweep(now = Date.now()) { for (const key of [...this.byKey.keys()]) this.#fresh(key, now); }
}

/** Token bucket for message floods on one socket: `rate` messages per second with room for `burst`. */
export class Bucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = Date.now();
  }

  take(now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
