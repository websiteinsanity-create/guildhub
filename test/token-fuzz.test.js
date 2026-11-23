// GuildHub 1.46.2-hotfix.2 - session-token fuzzing (Agent 4).
// >= 1000 malformed tokens (random/Latin-1/UTF-8 bytes, wrong lengths, dot structure, huge values, base64 padding,
// control bytes, valid body + bad signature, signed garbage / unknown keys, oversized bodies, quoting) are sent as
// the gh_session cookie AND as a Bearer header to /api/state and to /, over raw sockets (fetch() refuses most of
// these bytes). Contract (F-D): every request is answered, /api -> 401, the page -> 200, nothing takes > 1 s,
// nothing is logged as a stack trace, and the server stays healthy. Deterministic (seeded PRNG). Fictional data.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startGuild, rawRequest, rawGet, STACK } = require('./hf2-helpers');

const GUILD = '111111111111111111', SECRET = 'hf2-agent4-fuzz-secret-not-real';
const MEMBER = '200000000000000070', OFFICER = '200000000000000071';
let G;

function prng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = prng(0x46d2);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const b64u = (n) => Array.from({ length: n }, () => pick(B64U)).join('');
const bytes = (n, lo, hi) => Buffer.from(Array.from({ length: n }, () => int(lo, hi)));
const noCrLf = (buf) => Buffer.from(buf.map((b) => (b === 0x0d || b === 0x0a ? 0x78 : b)));
const ascii = (s) => Buffer.from(s, 'latin1');
const utf8To = (len) => { const chars = ['é', '€', '😀', '中', 'ß', 'Ω', 'a']; let out = Buffer.alloc(0); while (out.length < len) { const c = Buffer.from(pick(chars), 'utf8'); if (out.length + c.length <= len) out = Buffer.concat([out, c]); else out = Buffer.concat([out, Buffer.from('a')]); } return out; };

function corpus() {
  const valid = G.rawToken({ key: MEMBER, name: 'Fuzzmember', username: 'fuzz', avatar: '', role: 'member', discord: true, exp: Date.now() + 864e5 });
  const [vBody, vSig] = valid.split('.');
  const otherSig = G.rawToken({ key: OFFICER, name: 'Fuzzofficer', role: 'officer', discord: true, exp: Date.now() + 864e5 }).split('.')[1];
  const C = [];
  const add = (cat, buf) => { buf = Buffer.isBuffer(buf) ? buf : ascii(buf); if (!buf.equals(ascii(valid))) C.push({ cat, buf }); };
  // A: random printable ASCII
  for (let i = 0; i < 200; i++) add('ascii', noCrLf(bytes(int(0, 300), 0x21, 0x7e)));
  // B: valid-shaped body + 43 Latin-1 bytes (the GH-11 / SA-08 class) and Latin-1 bodies
  for (let i = 0; i < 100; i++) add('latin1-sig43', Buffer.concat([ascii(b64u(int(1, 60)) + '.'), bytes(43, 0x80, 0xff)]));
  for (let i = 0; i < 20; i++) add('latin1-sig43-validbody', Buffer.concat([ascii(vBody + '.'), bytes(43, 0x80, 0xff)]));
  for (let i = 0; i < 60; i++) add('latin1-any', Buffer.concat([bytes(int(1, 80), 0x80, 0xff), ascii('.'), bytes(int(1, 80), 0x80, 0xff)]));
  // C: UTF-8 multibyte, 43 bytes of signature and random lengths
  for (let i = 0; i < 70; i++) add('utf8-sig43', Buffer.concat([ascii(b64u(int(1, 60)) + '.'), utf8To(43)]));
  for (let i = 0; i < 30; i++) add('utf8-any', Buffer.concat([utf8To(int(1, 60)), ascii('.'), utf8To(int(1, 90))]));
  // D: wrong signature lengths with a valid charset
  for (let i = 0; i < 100; i++) { let n; do { n = int(0, 120); } while (n === 43); add('siglen', b64u(int(1, 80)) + '.' + b64u(n)); }
  // E: dot structure
  for (const s of ['', '.', '..', '...', 'a.', '.a', '.' + b64u(43), b64u(10), vBody, vBody + vSig, vBody + '.', '.' + vSig, valid + '.', valid + '.extra', 'x.' + valid, vBody + '..' + vSig,
    '.'.repeat(100), 'a.'.repeat(50), Array.from({ length: 20 }, () => b64u(3)).join('.')]) add('dots', s);
  for (let i = 0; i < 41; i++) add('dots', Array.from({ length: int(2, 12) }, () => b64u(int(0, 44))).join('.'));
  // F: huge values (some exceed Node's 16 KB header limit -> 431, still an HTTP answer)
  for (const n of [4096, 4097, 5000, 8000, 12000, 15000, 20000, 50000, 100000, 100000]) add('huge', b64u(n) + '.' + b64u(43));
  add('huge', 'A'.repeat(100 * 1024));
  // G: base64 padding / standard alphabet / whitespace
  for (let i = 0; i < 60; i++) {
    const kind = i % 6;
    if (kind === 0) add('b64pad', vBody + '=.' + vSig);
    else if (kind === 1) add('b64pad', vBody + '.' + vSig + '=');
    else if (kind === 2) add('b64pad', vBody + '.' + vSig.slice(0, 42) + '=');
    else if (kind === 3) add('b64pad', Buffer.from(Buffer.from(vBody, 'base64url')).toString('base64') + '.' + Buffer.from(vSig, 'base64url').toString('base64'));
    else if (kind === 4) add('b64pad', b64u(int(4, 40)) + '==.' + b64u(41) + '==');
    else add('b64pad', vBody.slice(0, int(1, vBody.length - 1)) + ' ' + vBody.slice(1) + '.' + vSig);
  }
  // H: control bytes (NUL etc.); most are rejected by the HTTP parser with 400 - still an answer
  for (let i = 0; i < 60; i++) { const b = Buffer.from(valid, 'latin1'); const pos = int(0, b.length - 1); const ctl = pick([0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f, 0x09]); add('control', Buffer.concat([b.subarray(0, pos), Buffer.from([ctl]), b.subarray(pos + 1)])); }
  // I: valid body, bad signature
  for (let i = 0; i < 120; i++) {
    const k = i % 6; let sig;
    if (k === 0) { const p = int(0, 42); sig = vSig.slice(0, p) + (vSig[p] === 'A' ? 'B' : 'A') + vSig.slice(p + 1); }
    else if (k === 1) sig = otherSig;
    else if (k === 2) sig = b64u(43);
    else if (k === 3) sig = vSig.toUpperCase() === vSig ? b64u(43) : vSig.toUpperCase();
    else if (k === 4) sig = vSig.split('').reverse().join('');
    else sig = 'A'.repeat(43);
    if (sig !== vSig) add('badsig', vBody + '.' + sig);
  }
  for (let i = 0; i < 30; i++) { const p = int(0, vBody.length - 1); const body = vBody.slice(0, p) + (vBody[p] === 'x' ? 'y' : 'x') + vBody.slice(p + 1); add('badbody', body + '.' + vSig); }
  // J: correctly signed garbage / unknown identities (models a stale or foreign cookie, not forgery)
  const sgn = (s) => { const body = Buffer.from(s).toString('base64url'); return body + '.' + G.sign(body); };
  const far = Date.now() + 864e5;
  for (const s of ['null', '[]', '1', '"s"', '{}', 'true', '{"exp":' + far + '}', '{"key":"299999999999999999","discord":true,"exp":' + far + '}',
    '{"__proto__":{"role":"officer"},"key":"299999999999999998","discord":true,"exp":' + far + '}', '{"key":{"$ne":1},"discord":true,"exp":' + far + '}',
    '{"key":"../db.json","discord":true,"exp":' + far + '}', '{"key":"constructor","discord":true,"exp":' + far + '}', '{"key":"__proto__","discord":true,"exp":' + far + '}',
    '{"key":"' + MEMBER + '","discord":true,"exp":"soon"}', '{"key":"' + MEMBER + '","discord":true}', '{"key":"' + MEMBER + '","exp":' + far + '}',
    '{"key":"' + MEMBER + '","discord":true,"exp":' + (Date.now() - 1) + '}', 'not json', '{"key":"' + MEMBER + '",', '\u0000']) add('signed-garbage', sgn(s));
  for (let i = 0; i < 40; i++) add('signed-unknown', sgn(JSON.stringify({ key: '29' + String(int(1e8, 9e8)).padStart(16, '0'), name: 'Nobody', role: pick(['member', 'officer', 'alliance', 'applicant']), coach: true, discord: true, exp: far })));
  // K: signed but oversized body (> 4096 chars, outside the contract's token format) for a real member
  add('signed-oversize', sgn(JSON.stringify({ key: MEMBER, name: 'Fuzzmember', role: 'member', discord: true, exp: far, pad: 'p'.repeat(3200) })));
  add('signed-oversize', sgn(JSON.stringify({ key: MEMBER, name: 'Fuzzmember', role: 'member', discord: true, exp: far, pad: 'p'.repeat(6000) })));
  // L: quoting / encoding
  for (const s of ['"' + valid + '"', "'" + valid + "'", vBody + '%2E' + vSig, encodeURIComponent(valid) + '%00', '<script>', '${jndi:ldap://x}', '\\x00', '%00', '%C3%A9'.repeat(10)]) add('quoting', s);
  for (let i = 0; i < 60; i++) add('mixed', noCrLf(Buffer.concat([ascii(b64u(int(0, 30))), bytes(int(1, 20), 0x00, 0xff), ascii('.'), bytes(int(0, 60), 0x20, 0xff)])));
  return { C, valid };
}

before(async () => {
  const users = { [MEMBER]: { id: MEMBER, name: 'Fuzzmember', username: 'fuzz', avatar: '', role: 'member', inGuild: true, accepted: true },
    [OFFICER]: { id: OFFICER, name: 'Fuzzofficer', username: 'fo', avatar: '', role: 'officer', inGuild: true, accepted: true } };
  G = await startGuild({ seed: { nextId: 10, users, members: [{ id: 1, owner: MEMBER, name: 'Fuzzchar', role: 'DPS', active: true, primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow', builds: [] }],
    settings: { applications: { enabled: true }, branding: {} }, events: [], points: [] }, secret: SECRET, guild: GUILD, env: { DISCORD_OFFICER_USER_IDS: OFFICER } });
});
after(async () => { if (G) await G.close(); });

async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

test('token fuzz: >= 1000 malformed tokens, cookie and Bearer, /api/state and / - always answered, 401 on /api, <= 1 s, no stack traces', async () => {
  const { C, valid } = corpus();
  assert.ok(C.length >= 1000, `corpus has ${C.length} tokens (want >= 1000)`);
  // Control: the harness itself accepts a real token (so 401s below are meaningful).
  const ok = await rawRequest(G.port, rawGet(G.port, '/api/state', 'Cookie', ascii('gh_session=' + valid)), 3000);
  assert.equal(ok.status, 200, 'precondition: a valid token is accepted over a raw socket');
  const logStart = G.logs.length;
  const jobs = [];
  for (const t of C) for (const [hdr, prefix] of [['Cookie', 'gh_session='], ['Authorization', 'Bearer ']]) for (const p of ['/api/state', '/']) jobs.push({ ...t, hdr, prefix, p });
  const res = await pool(jobs, 32, async (j) => {
    const value = Buffer.concat([ascii(j.prefix), j.buf]);
    const r = await rawRequest(G.port, rawGet(G.port, j.p, j.hdr, value), 1500);
    const allowed = new Set([j.p === '/' ? 200 : 401]);
    if (j.buf.some((b) => (b < 0x20 && b !== 0x09) || b === 0x7f)) allowed.add(400);         // HTTP parser: invalid header char
    if (value.length > 15000) { allowed.add(431); allowed.add(400); }                         // Node's 16 KB header limit
    return { j, r, good: !r.timedOut && allowed.has(r.status) && r.ms <= 1000, allowed: [...allowed] };
  });
  const bad = res.filter((x) => !x.good);
  const byCat = {};
  for (const x of bad) { const k = `${x.j.cat} ${x.j.hdr} ${x.j.p} -> ${x.r.timedOut ? 'HANG' : x.r.status ?? x.r.error}${x.r.ms > 1000 && !x.r.timedOut ? ' slow' : ''}`; byCat[k] = (byCat[k] || 0) + 1; }
  const logs = G.logs.slice(logStart).join('');
  const health = await fetch(G.base + '/health');
  const after = await rawRequest(G.port, rawGet(G.port, '/api/state', 'Cookie', ascii('gh_session=' + valid)), 3000);
  console.log(`token fuzz: ${C.length} tokens, ${jobs.length} requests, ${bad.length} violations, max ${Math.round(Math.max(...res.map((x) => x.r.ms)))} ms`);
  const problems = [];
  if (bad.length) problems.push('requests not answered as required:\n  ' + Object.entries(byCat).map(([k, n]) => `${n} x ${k}`).join('\n  '));
  if (STACK.test(logs) || /Unhandled rejection|Uncaught exception|RangeError|TypeError/.test(logs)) problems.push('stack traces / errors logged during fuzz: ' + logs.split('\n').filter((l) => /Error|Unhandled|Uncaught/.test(l)).slice(0, 3).join(' | '));
  if (health.status !== 200) problems.push('/health -> ' + health.status);
  if (after.status !== 200) problems.push('valid session after fuzz -> ' + after.status);
  assert.deepEqual(problems, [], problems.join('\n'));
});
