// A "worst night of the year" scenario, all landing on the server inside the same ~20 second window:
//   - 100 players all typing tonight's attendance PIN in at once (see pin-load.test.js for the single-issue
//     version of this - here it's one ingredient in a pile-up, not the only thing happening).
//   - the background scheduler (tick() in server.js) running its own pass at the same time, auto-marking
//     attendance for an EARLIER event that never used the PIN (so it has its own points-sync work to do,
//     against the same shared db and the same points ledger PIN entries are writing into).
//   - a Shotcaller session being started (live, against a fake bot) as part of posting tonight's parties to
//     Discord - exercising the one route that touches three different systems (Discord, Shotcaller, and the
//     event/points db) in a single request, now firing in the middle of everything else.
//   - a new party preset being saved.
//   - 10 VOD links being uploaded.
// None of these share a lock or a queue - they all go through the same single-threaded Node process, reading
// and writing the same in-memory `db` and the same debounced save. The point of this test is not any one
// endpoint's correctness (each has its own focused tests elsewhere) - it is that this pile-up, taken together,
// still finishes promptly, the process does not crash, and nothing silently corrupts another feature's data:
// no lost/duplicated attendance, no lost/duplicated points, the Discord post and Shotcaller session both
// succeed, the preset saves, and all 10 VODs land - exactly the shape of a real raid night's Discord ping.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111';
const KEY = 'test-megastress-key';
const PARTIES_CHANNEL = '800000000000000001'; // matches fake-discord.js's seeded channelList
const VOICE_CHANNEL = '200000000000000001';    // matches the fake bot's voice-channels response below

const PLAYERS = 100;
const VOD_COUNT = 10;

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
      if (req.url === `/api/guilds/${GUILD}/voice-channels`) return send(200, { channels: [{ id: VOICE_CHANNEL, name: 'Command' }] });
      if (req.url === `/api/guilds/${GUILD}/session/start`) {
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

// A big, realistic-looking points ledger from months of unrelated past events - the same reason pin-load.test.js
// seeds one, and here it also gives the earlier event's own auto-attendance-marking pass (tick(), below)
// something non-trivial to scan through while it runs at the same time as everything else.
function seedLedger(pastEvents, perEvent) {
  const points = [];
  let id = 1;
  for (let e = 0; e < pastEvents; e++) {
    for (let m = 0; m < perEvent; m++) {
      points.push({ id: id++, memberId: 100000 + m, delta: 10, reason: 'Attended: Old Event', eventId: 90000 + e, at: new Date().toISOString(), by: 'system' });
    }
  }
  return { nextId: id + 1, points, settings: { pointsEnabled: true } };
}

async function startServer(seedDb) {
  const fake = await startFakeDiscord();
  const bot = await startFakeBot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-megastress-'));
  if (seedDb) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seedDb));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1',
      DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
      SHOTCALLER_URL: bot.url, SHOTCALLER_API_KEY: KEY,
      // The background tick() that marks auto-attendance and runs reminders normally only runs every 30s - far
      // longer than this test's own 20s budget. Shortening it is the only way to actually get it running DURING
      // the burst below instead of safely before or after it, which is the whole point of including it here.
      SCHEDULER_INTERVAL_MS: '500',
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
    login,
    alive: () => proc.exitCode === null,
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); fake.close(); bot.server.close(); },
  };
}

test('100 concurrent PIN entries, a live earlier-event attendance sweep, a Shotcaller session start, a new preset and 10 VOD uploads all land correctly within ~20 seconds', { timeout: 40000 }, async () => {
  const s = await startServer(seedLedger(200, 50)); // 10,000 pre-existing ledger entries
  try {
    await s.call('/api/settings', 'PUT', { pointsEnabled: true }, s.officer);

    // --- An EARLIER event, already over an hour ago, that never used the PIN - exactly the shape tick() sweeps
    // for and auto-marks attendance on once it's comfortably over (compliance.finalAfterMinutes defaults to 60).
    const earlierStart = new Date(Date.now() - 90 * 60000).toISOString();
    const earlierEv = (await s.call('/api/events', 'POST', { type: 'Archboss', start: earlierStart, pinEnabled: false, points: 5 }, s.officer)).body;
    const earlyMembers = [];
    for (let i = 0; i < 5; i++) {
      earlyMembers.push((await s.call('/api/members', 'POST', { name: `Early${i}`, role: 'DPS', owner: `early${i}` }, s.officer)).body);
    }
    for (const m of earlyMembers) await s.call(`/api/events/${earlierEv.id}/rsvp`, 'POST', { memberId: m.id, status: 'yes' }, s.officer);
    assert.equal(earlierEv.autoAttended, false, 'sanity check: tick has not run yet for the earlier event');

    // --- TONIGHT's event: 100 players about to all submit the same PIN at once.
    const members = [];
    for (let i = 0; i < PLAYERS; i++) {
      members.push((await s.call('/api/members', 'POST', { name: `Player${i}`, role: 'DPS', owner: `player${i}` }, s.officer)).body);
    }
    const tonightEv = (await s.call('/api/events', 'POST', { type: 'Castle Siege', start: new Date(Date.now() - 5 * 60000).toISOString(), pinWindowMinutes: 30, pinEnabled: true, points: 10 }, s.officer)).body;
    await s.call('/api/settings', 'PUT', { pinOffsetMinutes: -60 }, s.officer);
    await s.call(`/api/events/${tonightEv.id}/pin/send`, 'POST', { mode: 'new' }, s.officer);
    const withPin = (await s.call('/api/state', 'GET', null, s.officer)).body.events.find((e) => e.id === tonightEv.id);
    const pinCode = withPin.pin.code;

    // Two real parties (needed so the combined post-parties+Shotcaller call below has something to start a
    // session for), using the first 12 of tonight's 100 players. The other 88 are unassigned - a realistic
    // roster where not everyone signed up is in a party yet when the PIN goes out.
    const partyMembers = members.slice(0, 12).map((m) => m.id);
    await s.call(`/api/events/${tonightEv.id}/parties`, 'POST', {
      parties: [
        { name: 'Party 1', members: partyMembers.slice(0, 6), leader: partyMembers[0] },
        { name: 'Party 2', members: partyMembers.slice(6, 12), leader: partyMembers[6] },
      ],
    }, s.officer);

    const logins = await Promise.all(members.map((m) => s.login(m.owner, 'm1')));

    // --- Fire everything at once: 100 PIN submissions, the post-parties+Shotcaller call, a new preset, and
    // 10 VOD uploads - while the 500ms scheduler keeps ticking in the background the whole time.
    const t0 = Date.now();
    const pinCalls = members.map((m, i) => s.call(`/api/events/${tonightEv.id}/pin`, 'POST', { memberId: m.id, pin: pinCode }, logins[i]));
    const postPartiesCall = s.call(`/api/events/${tonightEv.id}/post-parties`, 'POST', {
      image: pngDataUrl(), text: 'Tonight\'s parties', channelId: PARTIES_CHANNEL, channelName: 'parties',
      shotcaller: { enabled: true, channelId: VOICE_CHANNEL },
    }, s.officer);
    const presetCall = s.call('/api/presets', 'POST', { name: 'Stress Night Preset', description: 'saved mid-raid', parties: [{ name: 'Bench', members: [] }] }, s.officer);
    const vodCalls = Array.from({ length: VOD_COUNT }, (_, i) => s.call('/api/vods', 'POST', {
      owner: members[i].owner, url: 'https://youtu.be/dQw4w9WgXcQ', type: 'Testing', recordedDate: new Date().toISOString().slice(0, 10),
    }, logins[i]));

    const [pinResults, postPartiesResult, presetResult, vodResults] = await Promise.all([
      Promise.all(pinCalls), postPartiesCall, presetCall, Promise.all(vodCalls),
    ]);
    const elapsedMs = Date.now() - t0;

    // Give the 500ms-interval scheduler a couple more ticks to land the earlier event's auto-attendance pass -
    // it is deliberately NOT awaited directly (nothing in the app lets a request wait on it), so this is the
    // test polling for it the same way "did the background job catch up" has to be checked in practice.
    const earlierSettled = await (async () => {
      for (let i = 0; i < 20; i++) {
        const st = (await s.call('/api/state', 'GET', null, s.officer)).body;
        const ev = st.events.find((e) => e.id === earlierEv.id);
        if (ev.autoAttended) return ev;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error('the earlier event was never auto-marked by the scheduler');
    })();

    // --- The server is still alive and responsive - the whole point of the exercise.
    assert.ok(s.alive(), 'the server process is still running after the burst');

    // --- All 100 PIN submissions succeeded, with correct, non-duplicated results.
    assert.ok(pinResults.every((r) => r.status === 200), 'every one of the 100 concurrent PIN entries succeeds: ' + JSON.stringify(pinResults.filter((r) => r.status !== 200).slice(0, 3)));
    assert.ok(elapsedMs < 20000, `the whole concurrent burst (PINs + post-parties/Shotcaller + preset + VODs) should finish well under 20s, took ${elapsedMs}ms`);

    // --- The combined Discord post + Shotcaller start succeeded too, even with the PIN rush happening at the
    // exact same time.
    assert.equal(postPartiesResult.status, 200, JSON.stringify(postPartiesResult.body));
    assert.equal(postPartiesResult.body.shotcaller.ok, true, JSON.stringify(postPartiesResult.body.shotcaller));
    assert.equal(s.fake.state.posts.length, 1, 'the Discord party post went out');
    const started = s.bot.calls.find((c) => c.url.endsWith('/session/start'));
    assert.ok(started, 'Shotcaller actually received a session start call');
    assert.equal(started.body.count, 2);

    // --- The new preset saved.
    assert.equal(presetResult.status, 200, JSON.stringify(presetResult.body));
    assert.equal(presetResult.body.name, 'Stress Night Preset');

    // --- All 10 VODs landed.
    assert.ok(vodResults.every((r) => r.status === 200), 'every VOD upload succeeds: ' + JSON.stringify(vodResults.filter((r) => r.status !== 200).slice(0, 3)));

    // --- Tonight's attendance and points are exactly right: no player lost or duplicated despite the
    // concurrency, and no cross-talk with the earlier event's own points work happening in the same window.
    const after = (await s.call('/api/state', 'GET', null, s.officer)).body;
    const finalTonight = after.events.find((e) => e.id === tonightEv.id);
    assert.equal(finalTonight.attended.length, PLAYERS, 'every player recorded as attended, none lost to a race');
    assert.equal(new Set(finalTonight.attended).size, PLAYERS, 'no duplicates in attended');
    const tonightPoints = after.points.filter((p) => p.eventId === tonightEv.id);
    assert.equal(tonightPoints.length, PLAYERS, 'exactly one point entry per attendee - no duplicates, none dropped');
    assert.equal(new Set(tonightPoints.map((p) => p.memberId)).size, PLAYERS);

    // --- The EARLIER event's own auto-attendance pass, running in the background at the same time, also came
    // out right - the two events' points work never collided or corrupted each other.
    assert.equal(earlierSettled.attended.length, 5, 'all 5 RSVP\'d members were auto-marked attended for the earlier event');
    const earlierPoints = after.points.filter((p) => p.eventId === earlierEv.id);
    assert.equal(earlierPoints.length, 5, 'exactly one point entry per attendee for the earlier event too');

    // --- And the pre-existing 10,000-entry ledger is untouched - only these two events' entries were added.
    assert.equal(after.points.length, 200 * 50 + PLAYERS + 5, 'the pre-existing ledger is undisturbed; only new entries were added');
  } finally {
    await s.stop();
  }
});
