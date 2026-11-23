'use strict';
// Hotfix 1.46.2.2 request guard: pure helpers, no I/O, no state, never throw.
//
//   sameOrigin(req, publicUrl)            -> boolean  CSRF origin check for cookie-authenticated mutations
//   clientIp(req, { trustedProxies, header }) -> string  client address for rate limits / audit
//   parseTrusted(str | array)             -> parsed list of trusted proxy addresses / CIDRs
//   ipInList(ip, list)                    -> boolean
//
// Forwarding headers are attacker-controlled unless the TCP peer is a proxy we were told to trust
// (TRUSTED_PROXIES). Without that setting the socket address is the only source of truth.

// ------------------------------------------------------------------ IP parsing
// Returns { v: 4 | 6, b: number[] } (4 or 16 bytes) or null. IPv4-mapped IPv6 (::ffff:a.b.c.d) is returned as
// IPv4 so it matches IPv4 lists. Accepts optional [brackets], an IPv6 zone id (dropped) and, for IPv4 or
// bracketed IPv6, a trailing :port (some proxies append one). Octets with leading zeros are rejected (octal
// ambiguity).
function parseV4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const b = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    b.push(n);
  }
  return b;
}
function parseV6(s) {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.length > 45) return null;
  const dbl = s.indexOf('::');
  if (dbl !== -1 && s.indexOf('::', dbl + 1) !== -1) return null;
  const toGroups = (part) => {
    if (part === '') return [];
    const out = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i === items.length - 1 && it.includes('.')) {
        const v4 = parseV4(it);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(it)) return null;
        out.push(parseInt(it, 16));
      }
    }
    return out;
  };
  let groups;
  if (dbl === -1) {
    groups = toGroups(s);
    if (!groups || groups.length !== 8) return null;
  } else {
    const head = s.slice(0, dbl), tail = s.slice(dbl + 2);
    if (head.includes('.')) return null;   // an embedded IPv4 may only be the last part
    const h = toGroups(head), t = toGroups(tail);
    if (!h || !t || h.length + t.length > 7) return null;
    groups = [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  }
  const b = [];
  for (const g of groups) b.push(g >> 8, g & 255);
  return b;
}
function isMapped(b) { for (let i = 0; i < 10; i++) if (b[i] !== 0) return false; return b[10] === 255 && b[11] === 255; }
function parseIp(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > 64) return null;
  const br = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
  if (br) s = br[1];
  else if (/^[\d.]+:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));   // a.b.c.d:port
  const pct = s.indexOf('%');
  if (pct !== -1) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(s.slice(pct + 1))) return null;
    s = s.slice(0, pct);
  }
  if (s.includes(':')) {
    const b = parseV6(s);
    if (!b) return null;
    if (isMapped(b)) return { v: 4, b: b.slice(12) };
    return { v: 6, b };
  }
  const b = parseV4(s);
  return b ? { v: 4, b } : null;
}
function format(ip) {
  if (ip.v === 4) return ip.b.join('.');
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push((ip.b[i] << 8) | ip.b[i + 1]);
  // RFC 5952: compress the longest run (>= 2) of zero groups
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestStart === -1) return hex.join(':');
  return hex.slice(0, bestStart).join(':') + '::' + hex.slice(bestStart + bestLen).join(':');
}

// ------------------------------------------------------------------ trusted proxy list
// "10.0.0.0/8, 172.18.0.2, ::1, fd00::/8, ::ffff:172.18.0.0/112" -> [{ v, b, prefix }]. Invalid entries are
// ignored. An IPv4-mapped IPv6 CIDR with prefix >= 96 is stored as the equivalent IPv4 CIDR.
function parseTrusted(input) {
  if (Array.isArray(input) && input.every((e) => e && typeof e === 'object' && Array.isArray(e.b))) return input;   // already parsed
  const raw = Array.isArray(input) ? input.map(String).join(',') : typeof input === 'string' ? input : '';
  const out = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const slash = entry.indexOf('/');
    const addr = slash === -1 ? entry : entry.slice(0, slash);
    const prefixText = slash === -1 ? null : entry.slice(slash + 1);
    if (prefixText !== null && !/^\d{1,3}$/.test(prefixText)) continue;
    // Parse without unmapping first so a mapped CIDR's prefix can be translated.
    let s = addr.trim();
    if (/^\[.*\]$/.test(s)) s = s.slice(1, -1);
    if (s.includes('%') || /\]/.test(s)) continue;
    let ip;
    if (s.includes(':')) {
      const b = parseV6(s);
      if (!b) continue;
      ip = { v: 6, b };
    } else {
      const b = parseV4(s);
      if (!b) continue;
      ip = { v: 4, b };
    }
    const max = ip.v === 4 ? 32 : 128;
    let prefix = prefixText === null ? max : Number(prefixText);
    if (prefix > max) continue;
    if (ip.v === 6 && isMapped(ip.b) && (prefixText === null || prefix >= 96)) { ip = { v: 4, b: ip.b.slice(12) }; prefix -= 96; }
    out.push({ v: ip.v, b: ip.b, prefix });
  }
  return out;
}
function matches(ip, net) {
  if (ip.v !== net.v) return false;
  let bits = net.prefix;
  for (let i = 0; i < ip.b.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 255 : (0xff << (8 - bits)) & 255;
    if ((ip.b[i] & mask) !== (net.b[i] & mask)) return false;
  }
  return true;
}
function ipInList(ip, list) {
  try {
    const parsed = typeof ip === 'string' ? parseIp(ip) : ip && Array.isArray(ip.b) ? ip : null;
    if (!parsed) return false;
    return parseTrusted(list).some((net) => matches(parsed, net));
  } catch { return false; }
}

function headerValue(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  if (Array.isArray(v)) return v.map(String).join(',');
  return typeof v === 'string' ? v : undefined;
}

// ------------------------------------------------------------------ client IP
function clientIp(req, opts = {}) {
  try {
    const rawPeer = req && req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : '';
    const peer = parseIp(rawPeer);
    if (!peer) return rawPeer;                                   // nothing better to offer; never throw
    const peerText = format(peer);
    const trusted = parseTrusted(opts.trustedProxies);
    if (!trusted.length || !trusted.some((net) => matches(peer, net))) return peerText;   // forwarding headers ignored
    const header = String(opts.header || '').trim().toLowerCase();
    if (header === 'cf-connecting-ip') {
      const cf = headerValue(req, 'cf-connecting-ip');
      const ip = cf !== undefined && !cf.includes(',') ? parseIp(cf) : null;
      if (ip) return format(ip);
    }
    const xff = headerValue(req, 'x-forwarded-for');
    if (!xff) return peerText;
    const entries = xff.split(',');
    if (entries.length > 100) return peerText;
    for (let i = entries.length - 1; i >= 0; i--) {
      const ip = parseIp(entries[i]);
      // An unparsable hop appended by a trusted proxy ends the trustworthy part of the chain: anything further
      // left could be client-supplied, so fall back to the peer instead of skipping over it.
      if (!ip) return peerText;
      if (!trusted.some((net) => matches(ip, net))) return format(ip);
    }
    return peerText;                                             // every hop is a trusted proxy
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ same origin
// Origin (scheme://host[:port]) with default ports normalised, or null for anything that is not a plain
// http(s) origin.
function originOf(text) {
  if (typeof text !== 'string' || !text || text.length > 2048) return null;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.origin;   // lower-cased host, default port dropped
}
function isJson(req) {
  const ct = headerValue(req, 'content-type');
  if (!ct) return false;
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}
function sameOrigin(req, publicUrl) {
  try {
    const rawOrigin = req && req.headers ? req.headers.origin : undefined;
    if (Array.isArray(rawOrigin)) return false;
    if (rawOrigin !== undefined) {
      if (typeof rawOrigin !== 'string') return false;
      const origin = originOf(rawOrigin.trim());
      if (!origin) return false;                                   // includes "null" and opaque/odd origins
      if (publicUrl) {
        const expected = originOf(String(publicUrl).trim());
        return !!expected && expected === origin;                  // misconfigured PUBLIC_URL: fail closed
      }
      // Demo / passcode mode without PUBLIC_URL: the Host header is all we have (scheme not knowable behind a proxy).
      const host = headerValue(req, 'host');
      if (!host || host.includes(',') || /[\s/@?#\\]/.test(host)) return false;
      const scheme = origin.slice(0, origin.indexOf(':'));
      const hostOrigin = originOf(`${scheme}://${host.trim()}`);
      return !!hostOrigin && hostOrigin === origin;
    }
    const site = headerValue(req, 'sec-fetch-site');
    if (site !== undefined) {
      const s = site.trim().toLowerCase();
      return s === 'same-origin' || s === 'none';
    }
    // No Origin and no Fetch Metadata: not a modern browser fetch. A browser cannot send a cross-site
    // application/json body without a CORS preflight (never granted here), so JSON is safe to accept.
    return isJson(req);
  } catch {
    return false;
  }
}

module.exports = { sameOrigin, clientIp, parseTrusted, ipInList, _parseIp: parseIp, _formatIp: (s) => { const p = parseIp(s); return p ? format(p) : null; } };
