// Tests for voice-presence attendance tracking (attendanceMode === 'voice', guild-wide default or per-event
// override): once an officer starts Shotcaller for an event (via POST /api/events/:id/post-parties with
// shotcaller enabled - see test/shotcaller-postparties.test.js for that route's own, unrelated tests), a
// player showing up in the right voice channel gets marked attended on their own, no PIN involved at all.
// See effectiveAttendanceMode (server.js) and beginVoiceTracking/pollVoiceAttendance (server-shotcaller.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111';
const KEY = 'test-voiceattn-key';
const PARTIES_CHANNEL = '800000000000000001'; // matches fake-discord.js's seeded channelList
const VOICE_CHANNEL = '200000000000000001';
const EXTRA_CHANNEL = '200000000000000099'; // a standing channel that is never part of any Shotcaller session

const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const pngDataUrl = () => 'data:image/png;base64,' + FAKE_PNG.toString('base64');

// Same shape as test/shotcaller-postparties.test.js's fake bot, plus mutable "who is actually connected right
// now" per channel (including bot v4.3.0's connectedStates mute/deaf info) and the channel-agnostic
// /voice-presence endpoint "other channels always tracked" reads through.
// legacyNoPresence mimics an older/self-hosted Shotcaller bot build that only ever reports a per-party
// headcount (parties[].connected), never who specifically is connected (no connectedUserIds/connectedStates
// on /session or /session/start at all) and has no /voice-presence endpoint either - see
// "an older bot build that only reports headcounts" below for what Guild Hall is expected to do about it.
function startFakeBot(opts) {
  const legacy = !!(opts && opts.legacyNoPresence);
  const calls = [];
  let session = null;
  let connected = {}; // channelId -> [{id, mute, deaf}, ...]
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const u = new URL(req.url, 'http://x');
      calls.push({ method: req.method, url: req.url, body });
      const send = (status, obj) => { const j = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json' }); res.end(j); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Unauthorized' });
      if (u.pathname === `/api/guilds/${GUILD}/voice-channels`) return send(200, { channels: [{ id: VOICE_CHANNEL, name: 'Command' }, { id: EXTRA_CHANNEL, name: 'Main' }] });
      if (u.pathname === `/api/guilds/${GUILD}/voice-presence`) {
        if (legacy) return send(404, { error: 'Not found' }); // this endpoint doesn't exist on the older build at all
        const ids = (u.searchParams.get('channels') || '').split(',').filter(Boolean);
        return send(200, { channels: ids.map((id) => { const states = connected[id] || []; return { channelId: id, found: true, connected: states.length, connectedUserIds: states.map((s) => s.id), connectedStates: states }; }) });
      }
      if (u.pathname === `/api/guilds/${GUILD}/session/start`) {
        session = { active: true, muted: false, dedicated: [], additionalCallers: [], callerRoleId: null, bridge: null, parties: Array.from({ length: body.count }, (_, i) => ({ index: i + 1, channelId: 'c' + i, name: body.partyNames[i - 1] || `Party ${i + 1}` })) };
        return send(200, withConnected(session));
      }
      if (u.pathname === `/api/guilds/${GUILD}/session/stop`) { session = null; return send(200, { ok: true }); }
      if (u.pathname === `/api/guilds/${GUILD}/session`) return send(200, session ? withConnected(session) : { active: false, lastVoiceChannel: null });
      send(404, { error: 'Not found' });
    });
  });
  function withConnected(s) {
    return { ...s, parties: s.parties.map((p) => {
      const states = connected[p.channelId] || [];
      // The legacy shape only ever hands back how many are connected, never who - that's the whole point
      // of this fake: no connectedUserIds/connectedStates keys at all, not even empty arrays.
      return legacy ? { ...p, connected: states.length } : { ...p, connected: states.length, connectedUserIds: states.map((x) => x.id), connectedStates: states };
    }) };
  }
  return new Promise((resolve) => server.listen(0, () => resolve({
    server, url: `http://localhost:${server.address().port}`, calls,
    activeSession: () => session,
    // ids: either plain Discord id strings (mute/deaf default false) or {id,mute,deaf} objects.
    setConnected: (channelId, ids) => { connected[channelId] = ids.map((x) => (typeof x === 'string' ? { id: x, mute: false, deaf: false } : x)); },
  })));
}

async function startServer(extraEnv, botOpts) {
  const fake = await startFakeDiscord();
  const bot = await startFakeBot(botOpts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-voiceattn-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const base = `http://localhost:${port}`;
  const spawnServer = async (envOverride) => {
    const pr = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1',
        DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
        SHOTCALLER_URL: bot.url, SHOTCALLER_API_KEY: KEY,
        VOICE_POLL_INTERVAL_MS: '150', // voice-attendance has its own clock, independent of the ~30s scheduler tick
        ...extraEnv, ...envOverride,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 8000);
      pr.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
      pr.on('exit', (c) => reject(new Error('server exited early: ' + c)));
    });
    return pr;
  };
  let proc = await spawnServer({});
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
    // Stops the server process and starts a fresh one on the same data folder - what an update or a crash does.
    restart: async (envOverride) => { proc.kill(); await new Promise((r) => proc.once('exit', r)); proc = await spawnServer(envOverride || {}); },
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); fake.close(); bot.server.close(); },
  };
}

const postBody = (overrides) => ({ image: pngDataUrl(), text: 'test post', channelId: PARTIES_CHANNEL, channelName: 'parties', shotcaller: { enabled: true, channelId: VOICE_CHANNEL }, ...overrides });

// A 2-member anchor party and a 6-member second party (needs a leader - more than 3 members), each member
// owned by a distinct, known Discord id so the test can later claim that id is "connected" wherever it likes.
// `startOffsetMin` shifts the event's start relative to now (negative = already started, matching how these
// sessions are actually used - "tracking starts at/after the event begins" only makes sense for an event
// that has actually begun).
async function makeTrackedEvent(s, startOffsetMin, overrideMode) {
  const n = Math.floor(Math.random() * 1e6); // keeps owners unique across multiple calls within one test/server
  const owners = { anchor: [`d-anchor-1-${n}`, `d-anchor-2-${n}`], party2: Array.from({ length: 6 }, (_, i) => `d-p2-${i}-${n}`) };
  const make = async (owner) => (await s.call('/api/members', 'POST', { name: owner, role: 'DPS', owner }, s.officer)).body;
  const anchorMembers = await Promise.all(owners.anchor.map(make));
  const party2Members = await Promise.all(owners.party2.map(make));
  const ev = (await s.call('/api/events', 'POST', {
    type: 'Castle Siege', start: new Date(Date.now() + (startOffsetMin ?? -5) * 60000).toISOString(), points: 10,
    ...(overrideMode ? { attendanceModeOverride: overrideMode } : {}),
  }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/parties`, 'POST', {
    parties: [
      { name: 'Anchor', members: anchorMembers.map((m) => m.id), leader: anchorMembers[0].id },
      { name: 'Party 2', members: party2Members.map((m) => m.id), leader: party2Members[0].id },
    ],
  }, s.officer);
  return { ev, anchorMembers, party2Members };
}

const poll = async (s, fn, tries = 30, gapMs = 150) => {
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, gapMs));
  }
  throw new Error('condition never became true within the poll budget');
};
const attendedOf = async (s, evId) => { const after = (await s.call('/api/state', 'GET', null, s.officer)).body; return after.events.find((e) => e.id === evId); };

const withServer = (name, fn, extraEnv, botOpts) => test(name, { timeout: 30000 }, async () => { const s = await startServer(extraEnv, botOpts); try { await fn(s); } finally { await s.stop(); } });

withServer("in 'pin' mode (the default), voice presence is never looked at - no voiceTracking even starts", async (s) => {
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shotcaller.ok, true);
  s.bot.setConnected('c0', anchorMembers.map((m) => m.owner));
  await new Promise((res) => setTimeout(res, 600));
  const finalEv = await attendedOf(s, ev.id);
  assert.equal(finalEv.attended.length, 0, 'nobody auto-marked - this guild is still on PIN mode');
});

withServer("'voice' mode: present in ANY of the session's channels marks you attended, even if it's not your own assigned party's channel", async (s) => {
  // There used to be a stricter "own party's channel only" mode here - removed by request: a player standing
  // in the wrong channel, or one who was never assigned to a party at all, should still be credited for
  // simply being in the session.
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', pointsEnabled: true }, s.officer);
  const { ev, anchorMembers, party2Members } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shotcaller.ok, true);

  // Anchor members in their own channel (c0), plus Party 2's leader ALSO standing in the anchor's channel
  // instead of their own (c1, which stays empty) - everyone present anywhere in the session is credited.
  s.bot.setConnected('c0', [...anchorMembers.map((m) => m.owner), party2Members[0].owner]);
  s.bot.setConnected('c1', []);

  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(party2Members[0].id) ? e : null; });

  const finalEv = await attendedOf(s, ev.id);
  for (const m of anchorMembers) assert.ok(finalEv.attended.includes(m.id), `${m.owner} (in their own party's channel) should be marked attended`);
  assert.ok(finalEv.attended.includes(party2Members[0].id), "the Party 2 leader standing in the ANCHOR's channel should still be marked attended - which channel they're in no longer matters");
  for (const m of party2Members.slice(1)) assert.ok(!finalEv.attended.includes(m.id), 'the rest of Party 2, never actually seen anywhere, stays unmarked');
  const points = (await s.call('/api/state', 'GET', null, s.officer)).body.points.filter((p) => p.eventId === ev.id);
  assert.equal(points.length, anchorMembers.length + 1, 'exactly one points entry per attendee, matching attended');
});

withServer('a player who never RSVPed to the event at all still gets credited if they are seen in the tracked session', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);

  // Created but never RSVPed one way or the other - no 'yes', no 'no', nothing in ev.rsvps for them at all.
  // Maybe they forgot to answer, maybe they just showed up to help out - either way, if they're actually in
  // the session's voice, that is a real "no-reply but participated" case Guild Hall already has a place for
  // (the roster's own "noreply-att" status), not something voice-attendance should refuse to notice.
  const dropIn = (await s.call('/api/members', 'POST', { name: 'DropIn', role: 'DPS', owner: 'd-dropin-1' }, s.officer)).body;

  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  s.bot.setConnected('c0', [...anchorMembers.map((m) => m.owner), dropIn.owner]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(dropIn.id) ? e : null; });

  const finalEv = await attendedOf(s, ev.id);
  assert.ok(finalEv.attended.includes(dropIn.id), 'a never-RSVPed player seen in the session should still be credited');
});

withServer('a player added to a party AFTER tracking has already begun still gets credited on the next poll', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers, party2Members } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shotcaller.ok, true);

  // A late sign-up, created and swapped into Party 2 only now - after Shotcaller already started and
  // voice-attendance tracking for this event is already live, using whatever roster the parties had at that
  // moment. The whole point of this test is that this player was never in that original snapshot at all.
  const late = (await s.call('/api/members', 'POST', { name: 'Latecomer', role: 'DPS', owner: 'd-late-1' }, s.officer)).body;
  const partiesResp = await s.call(`/api/events/${ev.id}/parties`, 'POST', {
    parties: [
      { name: 'Anchor', members: anchorMembers.map((m) => m.id), leader: anchorMembers[0].id },
      { name: 'Party 2', members: [...party2Members.map((m) => m.id), late.id], leader: party2Members[0].id },
    ],
  }, s.officer);
  assert.equal(partiesResp.status, 200, JSON.stringify(partiesResp.body));

  s.bot.setConnected('c1', [...party2Members.map((m) => m.owner), late.owner]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(late.id) ? e : null; });

  const finalEv = await attendedOf(s, ev.id);
  assert.ok(finalEv.attended.includes(late.id), 'the player added to Party 2 after tracking began should still be picked up, not silently skipped for the rest of the track');
  for (const m of party2Members) assert.ok(finalEv.attended.includes(m.id), 'the rest of Party 2 is unaffected by the late addition');
});

withServer("a benched player (said Going, never placed in a party) still gets credited for being in voice, under 'own-party' scope too", async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer); // default scope: 'own-party'
  const { ev, anchorMembers, party2Members } = await makeTrackedEvent(s);

  // A bench: said Going, but deliberately never dragged into either party - kept around in voice in case
  // someone no-shows and a sub is needed. They have no party channel of their own at all.
  const bench = (await s.call('/api/members', 'POST', { name: 'Bencher', role: 'DPS', owner: 'd-bench-1' }, s.officer)).body;
  const rsvp = await s.call(`/api/events/${ev.id}/rsvp`, 'POST', { memberId: bench.id, status: 'yes' }, s.officer);
  assert.equal(rsvp.status, 200, JSON.stringify(rsvp.body));

  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shotcaller.ok, true);

  // Sitting in the anchor's channel - not "their own party's channel" (they have none) - which is exactly
  // why 'own-party' scope must not be the rule that decides whether a bench player gets credited.
  s.bot.setConnected('c0', [...anchorMembers.map((m) => m.owner), bench.owner]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(bench.id) ? e : null; });

  const finalEv = await attendedOf(s, ev.id);
  assert.ok(finalEv.attended.includes(bench.id), 'a benched player seen in voice should be credited even though they were never assigned to a party');
  for (const m of anchorMembers) assert.ok(finalEv.attended.includes(m.id), 'the anchor members track normally alongside the bench player');
  assert.ok(!finalEv.attended.includes(party2Members[0].id), 'a real Party 2 member who never actually showed up is unaffected by any of this');
});

withServer('once the Shotcaller session stops, tracking ends - nobody new gets marked afterward even if still "connected" in the (now stale) fake bot state', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers, party2Members } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  s.bot.setConnected('c0', anchorMembers.map((m) => m.owner));
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.length >= anchorMembers.length ? e : null; });

  await s.call('/api/shotcaller/stop', 'POST', {}, s.officer);
  s.bot.setConnected('c1', party2Members.map((m) => m.owner)); // too late - the watch should already have ended
  await new Promise((res) => setTimeout(res, 600));

  const finalEv = await attendedOf(s, ev.id);
  for (const m of anchorMembers) assert.ok(finalEv.attended.includes(m.id), 'the anchor members marked before the stop stay marked');
  for (const m of party2Members) assert.ok(!finalEv.attended.includes(m.id), 'nobody new gets marked after the session has stopped');
});

withServer('a per-event override tracks by voice even while the guild default is still PIN, and leaves other events alone', async (s) => {
  // Guild default stays 'pin' the whole test - only this one event is pinned to 'voice'.
  const { ev: voiceEv, anchorMembers } = await makeTrackedEvent(s, -5, 'voice');
  const { ev: pinEv, anchorMembers: pinAnchor } = await makeTrackedEvent(s, -5, 'default');
  const r1 = await s.call(`/api/events/${voiceEv.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  s.bot.setConnected('c0', anchorMembers.map((m) => m.owner));
  await poll(s, async () => { const e = await attendedOf(s, voiceEv.id); return e.attended.length >= anchorMembers.length ? e : null; });

  // Start a (separate) session for the PIN-default event too, with the exact same anchor members "connected" -
  // it should never be marked, since its own override says 'default' and the guild default is still 'pin'.
  const r2 = await s.call(`/api/events/${pinEv.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  s.bot.setConnected('c0', pinAnchor.map((m) => m.owner));
  await new Promise((res) => setTimeout(res, 600));
  const finalPinEv = await attendedOf(s, pinEv.id);
  assert.equal(finalPinEv.attended.length, 0, "an event overridden to 'default' is unaffected while the guild is still on PIN");
});

withServer('other channels always tracked (Admin > Events) count toward attendance regardless of scope', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', voiceTrackExtraChannelIds: [EXTRA_CHANNEL] }, s.officer);
  const { ev, party2Members } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Party 2's leader is in the standing "Main" channel, not any party channel at all.
  s.bot.setConnected(EXTRA_CHANNEL, [party2Members[0].owner]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(party2Members[0].id) ? e : null; });
  const finalEv = await attendedOf(s, ev.id);
  assert.ok(finalEv.attended.includes(party2Members[0].id), 'a member seen in an always-tracked extra channel counts, even under the strict own-party scope');
});

withServer("voice tracking doesn't start crediting attendance before its configured start time", async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', voiceTrackStartOffsetMinutes: 0 }, s.officer);
  // The event starts 5 minutes from now - tracking (offset 0) hasn't opened yet.
  const { ev, anchorMembers } = await makeTrackedEvent(s, 5);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.bot.setConnected('c0', anchorMembers.map((m) => m.owner));
  await new Promise((res) => setTimeout(res, 600));
  const finalEv = await attendedOf(s, ev.id);
  assert.equal(finalEv.attended.length, 0, "nobody is marked before the event's own start time (and the configured offset) has passed");
});

withServer('ignoring muted and ignoring deafened are two independent switches, not a combined "both" check', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', voiceAttendanceIgnoreMuted: true }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.bot.setConnected('c0', [
    { id: anchorMembers[0].owner, mute: true, deaf: false },  // mic off, still listening - ignoreMuted alone excludes this now
    { id: anchorMembers[1].owner, mute: false, deaf: true },  // deafened, still able to talk - ignoreMuted alone does NOT exclude this
  ]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(anchorMembers[1].id) ? e : null; });
  const finalEv = await attendedOf(s, ev.id);
  assert.ok(!finalEv.attended.includes(anchorMembers[0].id), 'ignoreMuted alone excludes anyone mic-muted, even if they can still hear');
  assert.ok(finalEv.attended.includes(anchorMembers[1].id), 'ignoreMuted alone has no opinion about deafened players - still counts');
});

withServer('ignoring deafened players works the same way, independently of ignoring muted', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', voiceAttendanceIgnoreDeafened: true }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.bot.setConnected('c0', [
    { id: anchorMembers[0].owner, mute: false, deaf: true },  // deafened - ignoreDeafened alone excludes this
    { id: anchorMembers[1].owner, mute: true, deaf: false },  // just muted - ignoreDeafened alone does NOT exclude this
  ]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(anchorMembers[1].id) ? e : null; });
  const finalEv = await attendedOf(s, ev.id);
  assert.ok(!finalEv.attended.includes(anchorMembers[0].id), 'ignoreDeafened alone excludes anyone deafened, even if they can still talk');
  assert.ok(finalEv.attended.includes(anchorMembers[1].id), 'ignoreDeafened alone has no opinion about muted players - still counts');
});

withServer('turning both switches on together reproduces the old "fully cut off both ways" behavior', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', voiceAttendanceIgnoreMuted: true, voiceAttendanceIgnoreDeafened: true }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.bot.setConnected('c0', [
    { id: anchorMembers[0].owner, mute: true, deaf: true },   // fully cut off both ways - should NOT count
    { id: anchorMembers[1].owner, mute: true, deaf: false },  // mic off but still listening - still excluded now (ignoreMuted alone covers it)
  ]);
  await new Promise((res) => setTimeout(res, 400));
  const finalEv = await attendedOf(s, ev.id);
  assert.ok(!finalEv.attended.includes(anchorMembers[0].id), 'fully muted and deafened should not count as attended');
  assert.ok(!finalEv.attended.includes(anchorMembers[1].id), 'with ignoreMuted also on, merely being muted is enough to exclude them too');
});

// server.js's tick() has a long-standing fallback for events that never use the PIN at all: once comfortably
// over, trust whoever said "Going" and mark them attended automatically, since otherwise nobody is confirming
// attendance for that event and everyone who meant to come would wrongly read as a no-show. Voice tracking is
// the exact same kind of "something is actually confirming attendance" system as the PIN, so once Shotcaller
// has actually been started for an event, that fallback must stay out of the way completely - a no-show who
// said Going but was never seen in voice needs to stay a no-show, not get silently waved through by this
// unrelated PIN-less-event fallback the moment the compliance delay passes.
withServer('once Shotcaller has actually tracked an event, the no-PIN auto-attend fallback leaves its result alone - a no-show stays a no-show', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  await s.call('/api/admin/compliance', 'PUT', { finalAfterMinutes: 5 }, s.officer);
  const { ev, anchorMembers, party2Members } = await makeTrackedEvent(s, -10);     // started 10 minutes ago
  await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, pinEnabled: false }, s.officer);
  // Said Going, but never once shows up in voice - a genuine no-show the whole feature exists to catch.
  await s.call(`/api/events/${ev.id}/rsvp`, 'POST', { memberId: party2Members[0].id, status: 'yes' }, s.officer);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.bot.setConnected('c0', anchorMembers.map((m) => m.owner));
  s.bot.setConnected('c1', []);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.length >= anchorMembers.length ? e : null; });
  await new Promise((res) => setTimeout(res, 500));                              // give the scheduler's own tick a chance to run too
  const finalEv = await attendedOf(s, ev.id);
  for (const m of anchorMembers) assert.ok(finalEv.attended.includes(m.id), 'the people actually seen in voice are still marked attended');
  assert.ok(!finalEv.attended.includes(party2Members[0].id), 'said Going but was never seen in voice - must stay a no-show, not get waved through just because this event has no PIN');
}, { SCHEDULER_INTERVAL_MS: '200' });

withServer('Admin: the new attendance settings are validated', async (s) => {
  const bad1 = await s.call('/api/settings', 'PUT', { attendanceMode: 'nonsense' }, s.officer);
  assert.equal(bad1.status, 400);
  const bad3 = await s.call('/api/settings', 'PUT', { voiceTrackExtraChannelIds: ['not-a-snowflake'] }, s.officer);
  assert.equal(bad3.status, 400);
  const bad4 = await s.call('/api/settings', 'PUT', { voiceTrackStartOffsetMinutes: 99999 }, s.officer);
  assert.equal(bad4.status, 400);
  const ok = await s.call('/api/settings', 'PUT', {
    attendanceMode: 'voice', voiceTrackExtraChannelIds: [EXTRA_CHANNEL],
    voiceTrackStartOffsetMinutes: 1, voiceAttendanceIgnoreMuted: true, voiceAttendanceIgnoreDeafened: true,
  }, s.officer);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.attendanceMode, 'voice');
  assert.deepEqual(ok.body.voiceTrackExtraChannelIds, [EXTRA_CHANNEL]);
  assert.equal(ok.body.voiceTrackStartOffsetMinutes, 1);
  assert.equal(ok.body.voiceAttendanceIgnoreMuted, true);
  assert.equal(ok.body.voiceAttendanceIgnoreDeafened, true);
});

withServer('per-event attendanceModeOverride is accepted and round-trips', async (s) => {
  const ev = (await s.call('/api/events', 'POST', { type: 'Castle Siege', start: new Date().toISOString(), attendanceModeOverride: 'voice' }, s.officer)).body;
  assert.equal(ev.attendanceModeOverride, 'voice');
  const updated = (await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, attendanceModeOverride: 'pin' }, s.officer)).body;
  assert.equal(updated.attendanceModeOverride, 'pin');
  const cleared = (await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, attendanceModeOverride: 'default' }, s.officer)).body;
  assert.equal(cleared.attendanceModeOverride, 'default');
});

// An older/self-hosted Shotcaller bot build (the one shipped in an early "step 2" checkpoint, before per-user
// voice presence was added) only ever reports a per-party headcount, not who is actually in each channel -
// see beginVoiceTracking's presenceUnsupported check in server-shotcaller.js. Running voice-attendance against
// a bot like that would otherwise look like a silent, permanent 0-attendees bug with no explanation anywhere;
// this confirms Guild Hall notices and says so instead, while everything else (starting/stopping a session,
// party management) keeps working fine.
withServer('an older Shotcaller bot build that only reports headcounts (no per-user ids) is detected, flagged, and audited - instead of silently crediting nobody forever', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const started = await attendedOf(s, ev.id);
  assert.equal(started.voiceTracking.presenceUnsupported, true, 'Guild Hall should recognize this bot build has no per-user presence data at all');

  const live = await s.call(`/api/events/${ev.id}/voice-track/live`, 'GET', null, s.officer);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.equal(live.body.presenceUnsupported, true, 'the dashboard card reads this flag to show its warning banner');

  // Even with people "connected" (headcount only, no ids for Guild Hall to match against), nobody can be
  // credited - there is nothing to compare a member's Discord id against.
  s.bot.setConnected('c0', anchorMembers.map((m) => m.owner));
  await new Promise((res) => setTimeout(res, 600));
  const finalEv = await attendedOf(s, ev.id);
  assert.equal(finalEv.attended.length, 0, 'with no per-user ids at all from the bot, nobody can be matched to a member - this is the gap the warning exists to explain');

  const audit = (await s.call('/api/admin/audit', 'GET', null, s.officer)).body;
  assert.ok(audit.entries.some((row) => row.action === 'event.voicetrack.unsupported'), 'an audit log entry should explain why attendance is not being credited');
}, {}, { legacyNoPresence: true });

// Performance: while an event is being voice-tracked, THREE independent things ask the bot "what is the
// session doing right now" (GET /session) on their own clock - the background pollVoiceAttendance loop, and,
// per officer with a tab open, the dashboard's live panel (/voice-track/live) and the Shotcaller page itself
// (/api/shotcaller/status), both every 5s in the real app. With more than one officer watching the same raid,
// that is several redundant real network round trips to the separate bot process every few seconds, all
// asking the exact same question - worst right when the bot is slowest to answer (mid session-start). This is
// what read back as "the website lags while Shotcaller is starting/tracking" (see cachedSession() in
// server-shotcaller.js). This test stands in for several officers' tabs all polling at once - some landing at
// the very same instant, some a little apart but still inside the cache window - and checks that the bot
// actually only sees a small, bounded number of real /session requests, not one per client call.
withServer('several officers watching the same tracked event at once does not multiply real requests to the Shotcaller bot - concurrent and near-simultaneous status reads are coalesced', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const sessionCallsSoFar = () => s.bot.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/session')).length;
  const before = sessionCallsSoFar();

  // Ten "officers" each hitting both polled endpoints at the exact same instant - the classic case (several
  // dashboard tabs open during the same raid) that used to mean 20 separate bot calls for one real question.
  const reads = [];
  for (let i = 0; i < 10; i++) {
    reads.push(s.call(`/api/events/${ev.id}/voice-track/live`, 'GET', null, s.officer));
    reads.push(s.call('/api/shotcaller/status', 'GET', null, s.officer));
  }
  const results = await Promise.all(reads);
  for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.body));

  const afterBurst = sessionCallsSoFar();
  assert.ok(afterBurst - before <= 2, `20 simultaneous reads should collapse into at most 1-2 real bot calls, not one each (saw ${afterBurst - before})`);

  // A few more reads spread out a little, but still comfortably inside the cache window (SHOTCALLER_SESSION_CACHE_MS,
  // set well below the default for this test) - these should also ride the same cached answer rather than each
  // starting a fresh one.
  await new Promise((res) => setTimeout(res, 40));
  await Promise.all([
    s.call(`/api/events/${ev.id}/voice-track/live`, 'GET', null, s.officer),
    s.call('/api/shotcaller/status', 'GET', null, s.officer),
    s.call(`/api/events/${ev.id}/voice-track/live`, 'GET', null, s.officer),
  ]);
  const afterMore = sessionCallsSoFar();
  assert.ok(afterMore - afterBurst <= 1, `reads still inside the cache window should add at most one more real call (saw ${afterMore - afterBurst})`);

  // Once the cache window has genuinely passed, the next read does go back to the bot for a fresh answer -
  // this is a short-lived cache for a burst, never a permanently stale one.
  await new Promise((res) => setTimeout(res, 300));
  await s.call(`/api/events/${ev.id}/voice-track/live`, 'GET', null, s.officer);
  assert.ok(sessionCallsSoFar() > afterMore, 'after the cache window passes, a read gets a fresh answer from the bot again');
}, { SHOTCALLER_SESSION_CACHE_MS: '200' });

// Reproduces the exact live-production report: an officer started Shotcaller from the standalone panel
// (public/shotcaller.js's "Start Shotcaller session" dialog with no event selected, i.e. no body.eventId) with
// a generic party count bigger than this event's own real line-up - same shape as "started with 12 default
// Extra standalone channels must remain visible and credit eligible members even if the
// event has fewer parties. Stored channel metadata no longer guesses party assignments.
withServer("a party's members standing in a voice channel the officer's standalone Shotcaller start never tied to any specific party still get credited - the exact 'started with more default parties than real ones' scenario reported in production", async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers, party2Members } = await makeTrackedEvent(s);

  // Standalone start, no eventId at all - count=5 gives the bot 5 channels (c0..c4) even though this event
  // only has one real party besides the anchor. No partyNames either, so there is nothing for name-matching
  // to latch onto - computePartyChannels falls straight to guessing by position.
  const started = await s.call('/api/shotcaller/start', 'POST', { channelId: VOICE_CHANNEL, count: 5 }, s.officer);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(ev.voiceSessionSnapshot, undefined, 'sanity check: a standalone start with no eventId must not have snapshotted anything for this event');

  const trackStart = await s.call(`/api/events/${ev.id}/voice-track/start`, 'POST', null, s.officer);
  assert.equal(trackStart.status, 200, JSON.stringify(trackStart.body));
  assert.deepEqual(trackStart.body.voiceTracking.partyChannels.map(pc=>pc.channelId), ['c0','c1','c2','c3','c4'], 'every live channel is retained without party matching');

  s.bot.setConnected('c3', party2Members.map((m) => m.owner));
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return party2Members.every((m) => e.attended.includes(m.id)) ? e : null; });

  const finalEv = await attendedOf(s, ev.id);
  for (const m of party2Members) assert.ok(finalEv.attended.includes(m.id), `${m.owner}, standing in channel c3 (never matched to any party by Guild Hall's own guess), should still be credited for being in the live session at all`);
});

// A track that was running when the server restarted (an update, a crash) used to sit at "1 of 3" forever: the
// next check only ever lived in an in-memory timer. The scheduler's watchdog now picks such a track up.
withServer('a voice track interrupted by a server restart resumes and finishes instead of sticking at 1 of 3', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', pointsEnabled: true }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  s.bot.setConnected('c0', anchorMembers.map((m) => m.owner));
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // First check done, next one is 60s away - the restart kills that timer.
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.voiceTracking && e.voiceTracking.checksDone === 1 ? e : null; });
  await s.restart({ SCHEDULER_INTERVAL_MS: '200', VOICE_POLL_INTERVAL_MS: '150' });
  s.officer = (await s.call('/api/login', 'POST', { name: 'Boss', passcode: 'o1' })).body.token;
  const done = await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.voiceTracking && e.voiceTracking.finishedAt ? e : null; }, 60, 150);
  assert.equal(done.voiceTracking.checksDone, 3);
  for (const m of anchorMembers) assert.ok(done.attended.includes(m.id), `${m.owner} should be marked attended`);
}, { VOICE_POLL_INTERVAL_MS: '60000' });
