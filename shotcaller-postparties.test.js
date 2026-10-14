// Tests for the combined "Post the parties to Discord + also start Shotcaller" flow
// (POST /api/events/:id/post-parties with a `shotcaller` field in the body). Uses the real fake-discord.js
// (so the Discord post itself actually happens) alongside a tiny fake Shotcaller bot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111';
const KEY = 'test-shotcaller-key';
const PARTIES_CHANNEL = '800000000000000001'; // matches fake-discord.js's seeded channelList

// need() requires more than 200 bytes after the real PNG signature - a real 1x1 pixel is nowhere near that, so
// pad it out, same as test/features.test.js and test/dm-attachment.test.js do for the same check.
const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const pngDataUrl = () => 'data:image/png;base64,' + FAKE_PNG.toString('base64');

function startFakeBot() {
  const calls = [];
  let session = null;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      calls.push({ method: req.method, url: req.url, body });
      const send = (status, obj) => { const j = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json' }); res.end(j); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Unauthorized' });
      if (req.url === `/api/guilds/${GUILD}/voice-channels`) return send(200, { channels: [{ id: '200000000000000001', name: 'Command' }] });
      if (req.url === `/api/guilds/${GUILD}/session/start`) {
        if (body.channelId === '999999999999999999') return send(400, { error: 'That channel is not a voice channel in this server.' });
        session = { active: true, muted: false, dedicated: [], additionalCallers: [], callerRoleId: null, bridge: null, parties: Array.from({ length: body.count }, (_, i) => ({ index: i + 1, channelId: 'c' + i, name: body.partyNames[i - 1] || `Party ${i + 1}`, connected: 0 })) };
        return send(200, session);
      }
      if (req.url === `/api/guilds/${GUILD}/session/stop`) { session = null; return send(200, { ok: true }); }
      if (req.url === `/api/guilds/${GUILD}/session`) return send(200, session || { active: false, lastVoiceChannel: null });
      send(404, { error: 'Not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}`, calls, activeSession: () => session })));
}

async function startServer(seedDb) {
  const fake = await startFakeDiscord();
  const bot = await startFakeBot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-scpp-'));
  if (seedDb) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seedDb));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1',
      DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
      SHOTCALLER_URL: bot.url, SHOTCALLER_API_KEY: KEY,
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
    base, call, fake, bot,
    officer: await login('Boss', 'o1'),
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); fake.close(); bot.server.close(); },
  };
}

const withServer = (name, fn, seedDb) => test(name, async () => { const s = await startServer(seedDb); try { await fn(s); } finally { await s.stop(); } });

let makeEventWithPartiesCalls = 0;
async function makeEventWithParties(s, partiesSpec) {
  const total = partiesSpec.reduce((n, spec) => n + spec.members, 0);
  const memberIds = [];
  // owner must be distinct per character - the officer token itself can only ever own one character, same as
  // any other player (see test/api.test.js's "party presets keep names and leaders" test for the same pattern).
  // The call counter keeps owners unique across multiple calls within the same test (same server, same db),
  // not just within one call - otherwise a second call's "PlayerN" owners collide with the first call's.
  const batch = makeEventWithPartiesCalls++;
  for (let i = 0; i < total; i++) memberIds.push((await s.call('/api/members', 'POST', { name: `Player${batch}_${i}`, role: 'DPS', owner: `Player${batch}_${i}` }, s.officer)).body.id);
  const ev = (await s.call('/api/events', 'POST', { type: 'Wargames', start: '2999-01-01T20:00:00Z' }, s.officer)).body;
  let cursor = 0;
  const parties = partiesSpec.map((spec, i) => {
    const members = memberIds.slice(cursor, cursor + spec.members);
    cursor += spec.members;
    return {
      name: 'Party ' + (i + 1), members, leader: spec.leader ? members[0] : null,
      // placeholderOverride lets a spec force the opposite of the automatic ≤3-member rule, either direction -
      // omit it to just rely on that automatic rule (the default for every existing spec/test).
      ...(spec.placeholderOverride !== undefined ? { placeholderOverride: true, placeholder: !!spec.placeholder } : {}),
    };
  });
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties }, s.officer);
  return ev;
}

const postBody = (overrides) => ({ image: pngDataUrl(), text: 'test post', channelId: PARTIES_CHANNEL, channelName: 'parties', ...overrides });

withServer('posting without the shotcaller field behaves exactly as before (unaffected by the new gate)', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: false }]); // would fail the leader check if shotcaller were on
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.shotcaller, null);
});

withServer('enabling shotcaller blocks the WHOLE post when a non-placeholder party (more than 3 members) has no leader', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: false }, { members: 2, leader: false }]);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Party 1/);
  assert.doesNotMatch(r.body.error, /Party 2/, 'Party 2 has only 2 members, so it is auto-exempt and should not be named');
  assert.equal(s.fake.state.posts.length, 0, 'nothing was posted to Discord - the whole action was blocked');
  assert.equal(s.bot.calls.length, 0, 'the Shotcaller bot was never even contacted');
});

withServer('a manually-flagged placeholder party is exempt from the leader check, AND skipped entirely from the Shotcaller session', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: true }, { members: 6, leader: false, placeholderOverride: true, placeholder: true }]);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(r.status, 200);
  assert.equal(r.body.shotcaller.ok, true);
  const sent = s.bot.calls.find((c) => c.url.endsWith('/session/start'));
  assert.equal(sent.body.count, 1, 'only the anchor party - the flagged placeholder gets no voice channel at all');
  assert.equal(sent.body.partyNames.length, 0);
});

withServer('a party with 3 or fewer members is skipped from Shotcaller automatically, same as an explicitly-flagged one', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: true }, { members: 2, leader: false }]);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(r.status, 200);
  assert.equal(r.body.shotcaller.ok, true);
  const sent = s.bot.calls.find((c) => c.url.endsWith('/session/start'));
  assert.equal(sent.body.count, 1, 'the 2-member party is auto-placeholder and gets no channel');
});

withServer('an officer can override a ≤3-member party to NOT be a placeholder, so it is included (and then needs a leader like any other real party)', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: true }, { members: 2, leader: false, placeholderOverride: true, placeholder: false }]);
  const blocked = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(blocked.status, 400, 'forced out of placeholder status, this 2-member party now needs a leader too');
  assert.match(blocked.body.error, /Party 2/);

  const ev2 = await makeEventWithParties(s, [{ members: 6, leader: true }, { members: 2, leader: true, placeholderOverride: true, placeholder: false }]);
  const r = await s.call(`/api/events/${ev2.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(r.status, 200);
  const sent = s.bot.calls.filter((c) => c.url.endsWith('/session/start')).pop();
  assert.equal(sent.body.count, 2, 'the override makes it a real party, so it gets its own channel despite having only 2 members');
  assert.equal(sent.body.partyNames.length, 1);
});

withServer('a valid combined post actually posts to Discord AND starts Shotcaller, with party names from the leaders', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: true }, { members: 6, leader: true }]);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001', dedicatedCallerId: null } }), s.officer);
  assert.equal(r.status, 200);
  assert.equal(s.fake.state.posts.length, 1, 'the Discord post happened');
  assert.equal(r.body.shotcaller.ok, true);
  const sent = s.bot.calls.find((c) => c.url.endsWith('/session/start'));
  assert.ok(sent, 'the bot received a start call');
  assert.equal(sent.body.count, 2);
  assert.equal(sent.body.channelId, '200000000000000001');
  assert.equal(sent.body.partyNames.length, 1, 'only parties after the first (the anchor/Party 1) are named');
  assert.match(sent.body.partyNames[0], /'s Party$/);
});

withServer('an already-active Shotcaller session is stopped automatically before the new one starts', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: true }]);
  // Start one session directly against the fake bot first, bypassing Guild Hall, to simulate one already running.
  await fetch(`${s.bot.url}/api/guilds/${GUILD}/session/start`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ count: 3, channelId: '200000000000000001', partyNames: [] }) });
  assert.equal(s.bot.activeSession().active, true, 'sanity check: a session is indeed already running');
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(r.status, 200);
  assert.equal(r.body.shotcaller.ok, true);
  const urls = s.bot.calls.map((c) => c.url + ':' + c.method);
  const stopIdx = urls.lastIndexOf(`/api/guilds/${GUILD}/session/stop:POST`);
  const startIdx = urls.lastIndexOf(`/api/guilds/${GUILD}/session/start:POST`);
  assert.ok(stopIdx !== -1 && stopIdx < startIdx, 'the old session was stopped before the new one was started: ' + JSON.stringify(urls));
});

withServer('an invalid voice channel id fails validation up front and blocks the whole action (no Discord post either)', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: true }]);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: 'not-a-real-snowflake' } }), s.officer);
  assert.equal(r.status, 400);
  assert.equal(s.fake.state.posts.length, 0, 'nothing was posted - format validation runs before anything else');
});

withServer('the Discord post still succeeds even when Shotcaller itself rejects the start (reported separately, not as a failed post)', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 6, leader: true }]);
  // A well-formed snowflake the fake bot is rigged to reject - this passes Guild Hall's own format check, so the
  // Discord post goes ahead, and only the bot's own /session/start response comes back as an error.
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '999999999999999999' } }), s.officer);
  assert.equal(r.status, 200, 'the overall request still succeeds - the Discord post is not rolled back');
  assert.equal(s.fake.state.posts.length, 1, 'the Discord post went through');
  assert.equal(r.body.shotcaller.ok, false);
  assert.match(r.body.shotcaller.error, /not a voice channel/);
});

// Regression test: data saved before placeholderOverride existed only ever stored a bare `placeholder: true`
// (no override field at all - it didn't exist yet). Without the back-compat handling in server.js's
// normParties(), that old `true` would stop meaning anything once an officer's party had more than 3 members
// (placeholderOverride defaults to false, so it falls through to the automatic ≤3-member rule instead) -
// silently un-flagging it, so it gets counted into the Shotcaller session again AND inserts an extra entry
// into partyNames, shifting every real party's name after it by one slot.
const member = (id) => ({ id, owner: 'P' + id, name: 'P' + id, role: 'DPS', rank: 'Member', active: true, gearScore: 1, level: 1 });
const ids = (...r) => r.map(member);
withServer('a party saved as a placeholder before placeholderOverride existed (bare `placeholder: true`, no override field) is still skipped by Shotcaller, not just exempted from the leader check', async (s) => {
  const r = await s.call(`/api/events/10/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(r.status, 200, 'not blocked by the leader check either - the old flag still exempts it there too: ' + JSON.stringify(r.body));
  const sent = s.bot.calls.find((c) => c.url.endsWith('/session/start'));
  assert.equal(sent.body.count, 2, 'only the anchor and the real leader party - the old-style placeholder (6 members, so NOT auto-exempt by the ≤3 rule) is still skipped despite having no override field');
  assert.equal(sent.body.partyNames.length, 1);
  assert.match(sent.body.partyNames[0], /^P14/, "the real leader party keeps its own name slot - not shifted by an extra entry for the old placeholder (which would otherwise land here first)");
}, {
  nextId: 50,
  members: [...ids(1), ...ids(2, 3, 4, 5, 6, 7), ...ids(14, 15, 16, 17, 18, 19)],
  events: [{
    id: 10, title: 'Siege', type: 'Wargames', start: new Date(Date.now() + 86400000).toISOString(), rsvps: {}, attended: [],
    parties: [
      { name: 'Anchor', members: [1], leader: 1 },
      // Pre-upgrade shape: `placeholder: true`, no `placeholderOverride` key at all. 6 members (not auto-exempt
      // by the ≤3 rule) and a leader already set, the way an officer might have left it after marking a
      // half-formed party placeholder without clearing out who was already assigned to lead it.
      { name: 'Old Placeholder', members: [2, 3, 4, 5, 6, 7], leader: 2, placeholder: true },
      { name: 'Leader Party', members: [14, 15, 16, 17, 18, 19], leader: 14 },
    ],
  }],
});

withServer('the picked anchor channel (Party 1) always counts, even if it has 3 or fewer members itself - it is an existing channel you chose, not one Shotcaller has to decide whether to create', async (s) => {
  const ev = await makeEventWithParties(s, [{ members: 2, leader: false }, { members: 6, leader: true }]);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({ shotcaller: { enabled: true, channelId: '200000000000000001' } }), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sent = s.bot.calls.find((c) => c.url.endsWith('/session/start'));
  assert.equal(sent.body.count, 2, 'the anchor (2 members) still counts, plus the real 6-member party - it must not be dropped for having 3 or fewer members itself');
  assert.equal(sent.body.partyNames.length, 1);
});
