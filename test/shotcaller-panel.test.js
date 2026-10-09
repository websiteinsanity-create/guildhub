// Tests for the Shotcaller control panel additions: the party `placeholder` flag, the event/series
// `shotcallerAutoStart` default, and the generalized proxy routes (`/api/shotcaller/voice-channels` and
// `/api/shotcaller/start`) that hit the bot's `/voice-channels` and `/session/start` endpoints. A tiny fake
// HTTP server stands in for the Shotcaller bot itself - no real bot or Discord connectivity needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUILD = '111111111111111111';
const KEY = 'test-shotcaller-key';

// A minimal stand-in for the bot's src/api.js: just enough of /voice-channels and /session/start (plus the
// plain status/mute/stop/dedicated/additional-callers routes) to exercise Guild Hall's proxy, recording every
// call it receives so a test can assert on what Guild Hall actually sent.
//
// startDelayMs simulates the real bot's slow /session/start (creating channels + logging relay bots in one at a
// time, as its own docs describe) so a test can confirm Guild Hall waits long enough instead of giving up early.
function startFakeBot(startDelayMs = 0) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (status, obj) => { const j = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json' }); res.end(j); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Unauthorized' });
      if (req.url === `/api/guilds/${GUILD}/voice-channels`) return send(200, { channels: [{ id: '200000000000000001', name: 'General Voice' }, { id: '200000000000000002', name: 'Officer Voice' }] });
      if (req.url === `/api/guilds/${GUILD}/session/start`) {
        if (body.channelId === '900000000000000099') return send(400, { error: 'That channel is not a voice channel in this server.' });
        const reply = () => send(200, { active: true, muted: false, dedicated: body.dedicatedCallerId ? [body.dedicatedCallerId] : [], additionalCallers: [], callerRoleId: null, bridge: null, parties: Array.from({ length: body.count }, (_, i) => ({ index: i + 1, channelId: 'c' + i, name: body.partyNames[i - 1] || `Party ${i + 1}`, connected: 0 })) });
        return startDelayMs ? setTimeout(reply, startDelayMs) : reply();
      }
      if (req.url === `/api/guilds/${GUILD}/session`) return send(200, { active: false, lastVoiceChannel: null });
      send(404, { error: 'Not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}`, calls })));
}

async function startServer(bot, seedDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-sc-'));
  if (seedDb) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seedDb));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1', DISCORD_GUILD_ID: GUILD, SHOTCALLER_URL: bot.url, SHOTCALLER_API_KEY: KEY },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
  const base = `http://localhost:${port}`;
  const call = async (p, method = 'GET', body, token) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return {
    base, call,
    officer: await login('Boss', 'o1'), member: await login('Zed', 'm1'),
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const withServer = (name, fn, seedDb) => test(name, async () => {
  const bot = await startFakeBot();
  const s = await startServer(bot, seedDb);
  try { await fn(s, bot); } finally { await s.stop(); bot.server.close(); }
});

withServer('GET /api/shotcaller/voice-channels proxies to the bot, officer-only', async (s) => {
  const denied = await s.call('/api/shotcaller/voice-channels', 'GET', null, s.member);
  assert.equal(denied.status, 403);
  const r = await s.call('/api/shotcaller/voice-channels', 'GET', null, s.officer);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.channels.map((c) => c.name), ['General Voice', 'Officer Voice']);
});

withServer('POST /api/shotcaller/start validates count and channelId before ever reaching the bot', async (s, bot) => {
  const noCount = await s.call('/api/shotcaller/start', 'POST', { channelId: '200000000000000001' }, s.officer);
  assert.equal(noCount.status, 400);
  const badChannel = await s.call('/api/shotcaller/start', 'POST', { count: 8, channelId: 'not-a-snowflake' }, s.officer);
  assert.equal(badChannel.status, 400);
  assert.equal(bot.calls.filter((c) => c.url.endsWith('/session/start')).length, 0, 'the bot is never even called for input that fails validation here');
});

withServer('POST /api/shotcaller/start rejects a dedicated caller who is not a configured candidate', async (s) => {
  const r = await s.call('/api/shotcaller/start', 'POST', { count: 4, channelId: '200000000000000001', dedicatedCallerId: 'some-user-id' }, s.officer);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /candidate/i);
});

withServer('POST /api/shotcaller/start forwards count/channelId/partyNames/dedicatedCallerId to the bot\'s /session/start, and relays its response and errors', async (s, bot) => {
  const ok = await s.call('/api/shotcaller/start', 'POST', { count: 3, channelId: '200000000000000001', partyNames: ["Aria's Party", null] }, s.officer);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.active, true);
  assert.equal(ok.body.parties.length, 3);
  const sent = bot.calls.find((c) => c.url.endsWith('/session/start'));
  assert.equal(sent.auth, `Bearer ${KEY}`);
  assert.deepEqual(sent.body, { count: 3, channelId: '200000000000000001', dedicatedCallerId: null, partyNames: ["Aria's Party", null] });

  const rejected = await s.call('/api/shotcaller/start', 'POST', { count: 2, channelId: '900000000000000099' }, s.officer);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /not a voice channel/);
});

test('POST /api/shotcaller/start waits past the old 5s timeout for a slow-but-working bot (channel creation + relay logins take a while)', { timeout: 15000 }, async () => {
  // 6.5s comfortably clears the fast calls' 5s timeout but is still well inside startSession's own 45s
  // allowance for /start specifically - reproduces the user's real "something went wrong" report, where a bot
  // that is genuinely still working (just slow) used to read back as a 502 instead of succeeding.
  const bot = await startFakeBot(6500);
  const s = await startServer(bot);
  try {
    const r = await s.call('/api/shotcaller/start', 'POST', { count: 2, channelId: '200000000000000001' }, s.officer);
    assert.equal(r.status, 200, 'the slow-but-successful bot response is not treated as a timeout/failure: ' + JSON.stringify(r.body));
    assert.equal(r.body.active, true);
  } finally {
    await s.stop(); bot.server.close();
  }
});

withServer('GET /api/shotcaller/status still works after generalizing callBot (it now hits /session, not a hardcoded path)', async (s) => {
  const r = await s.call('/api/shotcaller/status', 'GET', null, s.officer);
  assert.equal(r.status, 200);
  assert.equal(r.body.active, false);
});

withServer('a party can be explicitly overridden as a placeholder, or not, independently of stored defaults', async (s) => {
  const a = (await s.call('/api/members', 'POST', { name: 'Aria', role: 'DPS' }, s.officer)).body.id;
  const p = (await s.call('/api/presets', 'POST', { name: 'Siege', parties: [
    { name: 'Front', members: [a], placeholderOverride: true, placeholder: true },
    { name: 'Back', members: [] },
  ] }, s.officer)).body;
  assert.equal(p.parties[0].placeholderOverride, true);
  assert.equal(p.parties[0].placeholder, true);
  assert.equal(p.parties[1].placeholderOverride, false, 'placeholderOverride defaults to false - no explicit decision was made for this party');
  assert.equal(p.parties[1].placeholder, false);
  const unset = (await s.call(`/api/presets/${p.id}`, 'PUT', { parties: [{ ...p.parties[0], placeholderOverride: false }, p.parties[1]] }, s.officer)).body;
  assert.equal(unset.parties[0].placeholderOverride, false, 'the override itself can be cleared again, falling back to the automatic (member-count) rule');
});

withServer('an event stores shotcallerAutoStart, and it is pre-ticked but still editable on the generated events of a series', async (s) => {
  const ev = (await s.call('/api/events', 'POST', { type: 'Wargames', start: '2999-01-01T20:00:00Z', shotcallerAutoStart: true }, s.officer)).body;
  assert.equal(ev.shotcallerAutoStart, true);
  const off2 = (await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, shotcallerAutoStart: false }, s.officer)).body;
  assert.equal(off2.shotcallerAutoStart, false);

  // startDate/weekdays: tomorrow, so materialize() (which only looks a few weeks ahead of "now") is sure to
  // generate at least one occurrence regardless of when this test happens to run.
  const tomorrow = new Date(Date.now() + 86400000);
  const seriesStart = tomorrow.toISOString().slice(0, 10);
  const se = (await s.call('/api/series', 'POST', { type: 'Wargames', weekdays: [tomorrow.getUTCDay()], time: '21:00', tz: 'UTC', startDate: seriesStart, shotcallerAutoStart: true }, s.officer)).body.series;
  assert.equal(se.shotcallerAutoStart, true);
  const state = (await s.call('/api/state', 'GET', null, s.officer)).body;
  const generated = state.events.find((e) => e.seriesId === se.id);
  assert.ok(generated, 'the series generated at least one upcoming event');
  assert.equal(generated.shotcallerAutoStart, true, 'the flag is copied from the series onto every event it generates');
});
