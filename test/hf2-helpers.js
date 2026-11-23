// Shared harness for the 1.46.2-hotfix.2 adversarial suites (security-hotfix2.test.js, token-fuzz.test.js).
// Spawns a real `node server.js` against a temp DATA_DIR, a fake Discord API (test/fake-discord.js) and a tiny
// fake Shotcaller, signs people in through the real OAuth routes, mints tokens with a known SECRET (to model
// legacy/stale cookies, not forgery) and sends raw-socket requests for bytes fetch() refuses. Fictional data only.
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startFakeDiscord } = require('./fake-discord');

const ROOT = path.join(__dirname, '..');
const live = new Set();                     // every child process / server we started, killed even on a crash
process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL'); } catch {} } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Fake Shotcaller (Alliance Bridge backend): every call succeeds with an empty session.
function startFakeShotcaller() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      calls.push({ method: req.method, url: req.url });
      const out = /\/callers$/.test(req.url) ? { callers: [] } : /\/voice-channels$/.test(req.url) ? [] : { ok: true, active: false, parties: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() })));
}

/**
 * Start an isolated GuildHub.
 * opts.seed: db.json object; opts.secret: SECRET written to secret.txt; opts.env: extra env;
 * opts.uploads: { name: Buffer }; opts.guild / opts.alliance: guild ids.
 */
async function startGuild(opts) {
  const fake = await startFakeDiscord();
  const shot = await startFakeShotcaller();
  // Agent 2's backward-compatible fake-Discord extensions (bot member lookup per guild); harmless on the baseline.
  fake.state.memberLookup = true;
  fake.state.guildMembersByGuild = { [opts.guild]: {}, ...(opts.alliance ? { [opts.alliance]: {} } : {}) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-hf2-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(opts.seed));
  fs.writeFileSync(path.join(dir, 'secret.txt'), opts.secret);
  for (const [name, buf] of Object.entries(opts.uploads || {})) fs.writeFileSync(path.join(dir, 'uploads', name), buf);
  const port = await freePort();
  const base = `http://${opts.connectHost || 'localhost'}:${port}`;
  const ctx = { fake, shot, dir, port, base, secret: opts.secret, logs: [], proc: null, guild: opts.guild, alliance: opts.alliance };
  const baseEnv = {
    PATH: process.env.PATH, PORT: String(port), DATA_DIR: dir, DISCORD_CLIENT_ID: '555', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_URL: base,
    DISCORD_GUILD_ID: opts.guild, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url, DISCORD_AUTHORIZE_URL: fake.origin + '/authorize',
    DISCORD_DM_DELAY_MS: '0', SHOTCALLER_URL: shot.url, SHOTCALLER_API_KEY: 'shot-key',
    ...(opts.alliance ? { ALLIANCE_GUILD_ID: opts.alliance } : {}),
    ...(opts.env || {}),
  };
  ctx.start = async (extraEnv = {}) => {
    const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...baseEnv, ...extraEnv } });
    live.add(proc); ctx.proc = proc;
    proc.on('exit', () => live.delete(proc));
    proc.stderr.on('data', (d) => ctx.logs.push(String(d)));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start: ' + ctx.logs.join(''))), 10000);
      proc.stdout.on('data', (d) => { ctx.logs.push(String(d)); if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
      proc.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited early: ' + code + ' ' + ctx.logs.join(''))); });
    });
  };
  ctx.stop = async () => {
    const p = ctx.proc; if (!p || p.exitCode !== null || p.signalCode !== null) return;
    await new Promise((resolve) => { const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 4000); p.once('exit', () => { clearTimeout(t); resolve(); }); p.kill('SIGTERM'); });
  };
  ctx.restart = async (extraEnv = {}) => { await ctx.stop(); await ctx.start(extraEnv); };
  ctx.close = async () => {
    try { await ctx.stop(); } catch {}
    try { fake.close(); } catch {}
    try { shot.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  try { await ctx.start(); } catch (e) { await ctx.close(); throw e; }

  // ---- identities ----
  ctx.sign = (body) => crypto.createHmac('sha256', ctx.secret).update(body).digest('base64url');
  ctx.rawToken = (payload) => { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${body}.${ctx.sign(body)}`; };
  ctx.mint = (payload) => 'gh_session=' + ctx.rawToken(payload);
  // 1.46.2-style token: no sid, no iat.
  ctx.legacy = (key, name, role = 'member', extra = {}) => ctx.mint({ key, name, role, discord: true, exp: Date.now() + 29 * 864e5, ...extra });
  // Discord membership as both the OAuth path (state.guildMembers) and the bot lookup path (guildMembersByGuild) see it.
  ctx.setMember = (guild, id, roles) => {
    if (roles === null) { delete fake.state.guildMembers[id]; delete fake.state.guildMembersByGuild[guild]?.[id]; return; }
    const m = { roles, nick: 'n' + id.slice(-2), user: { id } };
    fake.state.guildMembers[id] = m;
    (fake.state.guildMembersByGuild[guild] ||= {})[id] = m;
  };
  ctx.login = async (id, roles = [], { alliance = false, guestcoach = false, inGuild = true, expectCookie = true } = {}) => {
    if (inGuild) ctx.setMember(alliance ? opts.alliance : opts.guild, id, roles);
    else ctx.setMember(alliance ? opts.alliance : opts.guild, id, null);
    const q = alliance ? '?alliance=1' : guestcoach ? '?guestcoach=1' : '';
    const s0 = await fetch(base + '/auth/discord' + q, { redirect: 'manual' });
    const jar = s0.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
    const st = new URL(s0.headers.get('location')).searchParams.get('state');
    const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${st}`, { redirect: 'manual', headers: { Cookie: jar } });
    const c = cb.headers.getSetCookie().find((x) => x.startsWith('gh_session=') && !x.startsWith('gh_session=;'));
    if (!expectCookie) return c ? c.split(';')[0] : null;
    assert.ok(c, `sign-in for ${id} (${cb.headers.get('location')})`);
    return c.split(';')[0];
  };

  // ---- requests ----
  // Cookie-authenticated request that looks like the real same-origin SPA (Origin + JSON) unless overridden.
  ctx.api = async (method, p, { cookie, body, headers = {}, bearer } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (bearer) h.Authorization = 'Bearer ' + bearer;
    if (method !== 'GET' && method !== 'HEAD') {
      if (!('Origin' in h) && !('origin' in h)) h.Origin = base;
      if (!('Content-Type' in h)) h['Content-Type'] = 'application/json';
    }
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? (method === 'GET' || method === 'HEAD' ? undefined : '{}') : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  ctx.raw = (reqBuf, timeoutMs) => rawRequest(port, reqBuf, timeoutMs);

  // ---- B04 guest-coach invitations (1.46.2-hotfix.3 contract) ----
  // Step 1: POST /auth/discord/invite {token} as the same-origin SPA would. Returns { status, json, jar, state }.
  // `body` replaces the JSON body entirely (for malformed / extra-field attempts); `headers` overrides headers.
  ctx.inviteBegin = async (token, { body, headers = {} } = {}) => {
    const h = { 'Content-Type': 'application/json', Origin: base, ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const t0 = performance.now();
    const r = await fetch(base + '/auth/discord/invite', { method: 'POST', headers: h, body: body === undefined ? JSON.stringify({ token }) : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const ms = performance.now() - t0;
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    const jar = r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
    let state = null;
    try { if (json && typeof json.location === 'string') state = new URL(json.location, base).searchParams.get('state'); } catch {}
    const ok = r.status === 200 && !!state && /gh_oauth=/.test(jar);
    const why = `POST /auth/discord/invite -> ${r.status}, ${ok ? 'state bound' : 'NO OAuth state bound (' + (json ? JSON.stringify(json).slice(0, 80) : 'non-JSON reply: ' + text.slice(0, 30).replace(/\s+/g, ' ')) + ')'}`;
    return { status: r.status, json, text, jar, state, ms, ok, why };
  };
  // Step 2: the Discord callback for a begun sign-in, as the browser would arrive back from Discord with `discordId`
  // proven. `extraQuery` appends attacker-controlled query parameters; `cookie` overrides the jar.
  ctx.inviteCallback = async (begin, discordId, { inGuild = false, roles = [], extraQuery = '', cookie, state } = {}) => {
    if (inGuild) ctx.setMember(opts.guild, discordId, roles); else ctx.setMember(opts.guild, discordId, null);
    const st = state !== undefined ? state : begin.state;
    const cb = await fetch(`${base}/auth/discord/callback?code=${discordId}&state=${encodeURIComponent(st || '')}${extraQuery}`, { redirect: 'manual', headers: { Cookie: cookie !== undefined ? cookie : begin.jar }, signal: AbortSignal.timeout(8000) });
    const c = cb.headers.getSetCookie().find((x) => x.startsWith('gh_session=') && !x.startsWith('gh_session=;'));
    const location = cb.headers.get('location') || '';
    let loginError = null; try { loginError = new URL(location, base).searchParams.get('loginError'); } catch {}
    return { status: cb.status, cookie: c ? c.split(';')[0] : null, location, loginError };
  };
  // Both steps: { begin, cookie, loginError, location }. cookie is null when no session was issued.
  ctx.inviteLogin = async (token, discordId, cbOpts = {}) => {
    const begin = await ctx.inviteBegin(token);
    if (!begin.ok) return { begin, cookie: null, loginError: null, location: null, beginFailed: true };
    const cb = await ctx.inviteCallback(begin, discordId, cbOpts);
    return { begin, ...cb, beginFailed: false };
  };
  // Stop the server, edit db.json directly (seed invite records, legacy data, ...), start it again.
  ctx.editDb = async (fn) => {
    await ctx.stop();
    const f = path.join(dir, 'db.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    await fn(d);
    fs.writeFileSync(f, JSON.stringify(d));
    await ctx.start();
  };
  return ctx;
}

// Send raw bytes over TCP and return { status, ms, timedOut, head } as soon as the status line arrives.
function rawRequest(port, reqBuf, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const t0 = performance.now(); let buf = Buffer.alloc(0), done = false;
    const sock = net.connect(port, '127.0.0.1');
    const finish = (out) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve({ ms: performance.now() - t0, ...out }); };
    const timer = setTimeout(() => finish({ status: null, timedOut: true }), timeoutMs);
    sock.on('connect', () => sock.write(reqBuf));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const s = buf.toString('latin1'); const i = s.indexOf('\r\n');
      if (i >= 0) { const m = /^HTTP\/1\.[01] (\d{3})/.exec(s.slice(0, i)); finish({ status: m ? Number(m[1]) : -1, timedOut: false, head: s.slice(0, 200) }); }
    });
    sock.on('error', (e) => finish({ status: null, timedOut: false, error: e.code || String(e) }));
    sock.on('close', () => finish({ status: null, timedOut: false, error: 'closed without response' }));
  });
}
// Build a GET request whose header value is raw bytes.
function rawGet(port, p, headerName, valueBuf) {
  return Buffer.concat([Buffer.from(`GET ${p} HTTP/1.1\r\nHost: localhost:${port}\r\n${headerName}: `, 'latin1'), valueBuf, Buffer.from('\r\nConnection: close\r\n\r\n', 'latin1')]);
}

// Open a request, send headers and the first part of the body now, the rest later (TOCTOU / in-flight tests).
function pendingRequest(port, head, part1) {
  const sock = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0), closed = false;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
  sock.on('error', () => {});
  sock.on('close', () => { closed = true; });
  const ready = new Promise((r) => sock.on('connect', () => { sock.write(Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(part1, 'latin1')])); r(); }));
  return {
    ready,
    finish: (part2, timeoutMs = 3000) => new Promise((resolve) => {
      sock.write(Buffer.from(part2, 'latin1'));
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = buf.toString('latin1'); const m = /^HTTP\/1\.[01] (\d{3})/.exec(s);
        if ((m && s.includes('\r\n\r\n')) || closed || Date.now() - t0 > timeoutMs) {
          clearInterval(iv); sock.destroy();
          const body = s.split('\r\n\r\n').slice(1).join('\r\n\r\n');
          resolve({ status: m ? Number(m[1]) : null, body });
        }
      }, 20);
    }),
  };
}

async function poll(fn, { timeoutMs = 5000, everyMs = 150 } = {}) {
  const t0 = Date.now(); let last;
  for (;;) { last = await fn(); if (last.ok) return last; if (Date.now() - t0 > timeoutMs) return last; await new Promise((r) => setTimeout(r, everyMs)); }
}

const png = (seed) => { const b = Buffer.alloc(300, seed); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); return b; };
const STACK = /^\s+at .+(\(|:\d+:\d+)/m;
// A fresh invite token in the contract format (32 random bytes, base64url, 43 chars) and its stored sha256 hex hash,
// for seeding invite records directly into db.json.
function newInviteToken() { const token = crypto.randomBytes(32).toString('base64url'); return { token, tokenHash: crypto.createHash('sha256').update(token).digest('hex') }; }

module.exports = { startGuild, rawRequest, rawGet, poll, png, freePort, STACK, pendingRequest, newInviteToken };
