// Tests for Admin > Testing's live voice-attendance dry-run (server-shotcaller.js's voiceTest state and the
// /api/admin/voice-test* routes) - a throwaway 3-channel Shotcaller session an officer can start any time to
// watch the real voice-attendance pipeline work end to end, without needing a real event. Never touches
// db.events, db.points or anything else persisted - see the comment above voiceTest in server-shotcaller.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111';
const KEY = 'test-voicetest-key';
const ANCHOR_CHANNEL = '800000000000000003'; // matches fake-discord.js's seeded "Voice" channel (type 2)

// Same shape as voice-attendance.test.js's fake bot.
function startFakeBot() {
  const calls = [];
  let session = null;
  let connected = {};
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const u = new URL(req.url, 'http://x');
      calls.push({ method: req.method, url: req.url, body });
      const send = (status, obj) => { const j = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json' }); res.end(j); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Unauthorized' });
      if (u.pathname === `/api/guilds/${GUILD}/voice-channels`) return send(200, { channels: [{ id: ANCHOR_CHANNEL, name: 'Voice' }] });
      if (u.pathname === `/api/guilds/${GUILD}/session/start`) {
        if (session) return send(409, { error: 'A Shotcaller session is already active.' });
        session = { active: true, muted: false, dedicated: [], additionalCallers: [], callerRoleId: null, bridge: null, parties: Array.from({ length: body.count }, (_, i) => ({ index: i + 1, channelId: i === 0 ? ANCHOR_CHANNEL : 'c' + i, name: i === 0 ? 'Voice' : (body.partyNames[i - 1] || `Party ${i + 1}`) })) };
        return send(200, withConnected(session));
      }
      if (u.pathname === `/api/guilds/${GUILD}/session/stop`) { session = null; return send(200, { ok: true }); }
      if (u.pathname === `/api/guilds/${GUILD}/session`) return send(200, session ? withConnected(session) : { active: false, lastVoiceChannel: null });
      send(404, { error: 'Not found' });
    });
  });
  function withConnected(s) {
    return { ...s, parties: s.parties.map((p) => { const states = connected[p.channelId] || []; return { ...p, connected: states.length, connectedUserIds: states.map((x) => x.id), connectedStates: states }; }) };
  }
  return new Promise((resolve) => server.listen(0, () => resolve({
    server, url: `http://localhost:${server.address().port}`, calls,
    activeSession: () => session,
    setConnected: (channelId, ids) => { connected[channelId] = ids.map((x) => (typeof x === 'string' ? { id: x, mute: false, deaf: false } : x)); },
  })));
}

async function startServer(extraEnv) {
  const fake = await startFakeDiscord();
  const bot = await startFakeBot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-voicetest-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1',
      DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
      SHOTCALLER_URL: bot.url, SHOTCALLER_API_KEY: KEY,
      // Fast enough to actually finish a test suite, slow enough to still observe each phase in order.
      VOICE_TEST_DELAY_MS: '300', VOICE_TEST_POLL_MS: '100',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
  const call = async (p, method = 'GET', body, token) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return {
    call, fake, bot,
    officer: await login('Boss', 'o1'),
    member: await login('Mem', 'm1'),
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); fake.close(); bot.server.close(); },
  };
}
const withServer = (name, fn, extraEnv) => test(name, { timeout: 20000 }, async () => { const s = await startServer(extraEnv); try { await fn(s); } finally { await s.stop(); } });
const poll = async (s, fn, tries = 40, gapMs = 100) => {
  for (let i = 0; i < tries; i++) { const r = await fn(); if (r) return r; await new Promise((res) => setTimeout(res, gapMs)); }
  throw new Error('condition never became true within the poll budget');
};
const status = async (s) => (await s.call('/api/admin/voice-test', 'GET', null, s.officer)).body;

withServer('nothing running at first, and the route is officer-only', async (s) => {
  assert.deepEqual(await status(s), { phase: null });
  assert.equal((await s.call('/api/admin/voice-test', 'GET', null, s.member)).status, 403);
  assert.equal((await s.call('/api/admin/voice-test/start', 'POST', { channelId: ANCHOR_CHANNEL }, s.member)).status, 403);
});

withServer('starting creates a 3-channel session, waits the configured delay, then starts tracking - confirming only after 2 sightings within the rolling window, and reporting mute/deaf state', async (s) => {
  const r = await s.call('/api/admin/voice-test/start', 'POST', { channelId: ANCHOR_CHANNEL }, s.officer);
  assert.equal(r.status, 200);
  assert.equal(r.body.phase, 'waiting');
  assert.equal(r.body.channels.length, 3, 'the anchor plus 2 bot-created channels');
  assert.ok(r.body.trackAt > Date.now(), 'tracking has not opened yet');

  // Still "waiting" immediately after - the fake bot's session really is active with 3 real channels.
  assert.equal(s.bot.activeSession().parties.length, 3);

  // Someone joins the SECOND test channel right away, before tracking has opened - must not be confirmed yet.
  const early = r.body.channels[1].channelId;
  s.bot.setConnected(early, [{ id: 'd-early-1', mute: false, deaf: false }]);
  await new Promise((res) => setTimeout(res, 150));
  assert.equal((await status(s)).confirmed.length, 0, 'tracking has not opened yet, so nobody is confirmed');

  // Once tracking opens, that same person (still connected) needs to be SEEN AGAIN (>= 2 sightings within the
  // rolling 30s window) before counting as confirmed - matching the real feature's own rule exactly.
  const tracked = await poll(s, async () => { const t = await status(s); return t.phase === 'tracking' ? t : null; });
  assert.equal(tracked.confirmed.length, 0, 'present, but only seen once so far since tracking opened');
  const confirmed = await poll(s, async () => { const t = await status(s); return t.confirmed.length ? t : null; });
  assert.equal(confirmed.confirmed[0].ownerId, 'd-early-1');
  assert.equal(confirmed.confirmed[0].mute, false);
  assert.equal(confirmed.confirmed[0].deaf, false);

  // A second, muted-and-deafened person joins a different test channel - also gets confirmed (muting never
  // blocks confirmation here - the whole point of the test is to show mute state, not filter by it), and their
  // mute/deaf state is reported accurately.
  const other = r.body.channels[2].channelId;
  s.bot.setConnected(other, [{ id: 'd-muted-1', mute: true, deaf: true }]);
  const both = await poll(s, async () => { const t = await status(s); return t.confirmed.length >= 2 ? t : null; });
  const muted = both.confirmed.find((c) => c.ownerId === 'd-muted-1');
  assert.ok(muted, 'a fully muted+deafened tester still gets confirmed');
  assert.deepEqual([muted.mute, muted.deaf], [true, true]);
}, {});

withServer('starting a second test while one is already running is refused; stopping clears it and actually stops the bot session', async (s) => {
  const r1 = await s.call('/api/admin/voice-test/start', 'POST', { channelId: ANCHOR_CHANNEL }, s.officer);
  assert.equal(r1.status, 200);
  const r2 = await s.call('/api/admin/voice-test/start', 'POST', { channelId: ANCHOR_CHANNEL }, s.officer);
  assert.equal(r2.status, 409, 'a test is already running');

  const stopR = await s.call('/api/admin/voice-test/stop', 'POST', {}, s.officer);
  assert.equal(stopR.status, 200);
  assert.deepEqual(await status(s), { phase: null }, 'the slot is cleared');
  assert.equal(s.bot.activeSession(), null, 'the throwaway Shotcaller session was actually stopped on the bot side too');

  // Stopping when nothing is running at all is a harmless no-op, not an error - the client's own dialog-close
  // cleanup calls this unconditionally and should never itself produce a scary failure toast.
  const idempotent = await s.call('/api/admin/voice-test/stop', 'POST', {}, s.officer);
  assert.equal(idempotent.status, 200);
});

withServer('a bad anchor channel id is rejected cleanly, with a phase:"error" an admin can read and retry from', async (s) => {
  const r = await s.call('/api/admin/voice-test/start', 'POST', { channelId: 'not-a-real-channel' }, s.officer);
  assert.equal(r.status, 200, 'the route itself always succeeds - failure is reported as phase:error, not an HTTP error');
  assert.equal(r.body.phase, 'error');
  assert.ok(r.body.error, 'has a human-readable reason');
  // Having failed to really start anything, a fresh attempt is allowed right away - no need to "stop" first.
  const retry = await s.call('/api/admin/voice-test/start', 'POST', { channelId: ANCHOR_CHANNEL }, s.officer);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.phase, 'waiting');
});
