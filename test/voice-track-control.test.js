// Tests for the "Voice channel tracking and Reminders" panel's server-side pieces (Edit event rework): an
// event's own voiceTrackAuto switch (on by default - tracking starts automatically the moment Shotcaller
// starts for the event, exactly as voice-attendance.test.js already covers) and its manual counterpart,
// POST /api/events/:id/voice-track/start, for when an officer switched automatic tracking off and wants to
// start crediting sightings by hand once Shotcaller is actually running. Also covers an event's own extra
// channels list (voiceTrackExtraChannelIds), the per-event sibling of the guild-wide Admin > Events list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111';
const KEY = 'test-voicetrack-key';
const PARTIES_CHANNEL = '800000000000000001';
const VOICE_CHANNEL = '200000000000000001';
const OWN_EXTRA_CHANNEL = '200000000000000077'; // per-event extra channel, distinct from any guild-wide one

const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const pngDataUrl = () => 'data:image/png;base64,' + FAKE_PNG.toString('base64');

function startFakeBot() {
  let session = null;
  let connected = {};
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const u = new URL(req.url, 'http://x');
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Unauthorized' });
      if (u.pathname === `/api/guilds/${GUILD}/voice-channels`) return send(200, { channels: [{ id: VOICE_CHANNEL, name: 'Command' }] });
      if (u.pathname === `/api/guilds/${GUILD}/voice-presence`) {
        const ids = (u.searchParams.get('channels') || '').split(',').filter(Boolean);
        return send(200, { channels: ids.map((id) => { const states = connected[id] || []; return { channelId: id, found: true, connected: states.length, connectedUserIds: states.map((s) => s.id), connectedStates: states }; }) });
      }
      if (u.pathname === `/api/guilds/${GUILD}/session/start`) {
        session = { active: true, parties: Array.from({ length: body.count }, (_, i) => ({ index: i + 1, channelId: i === 0 ? VOICE_CHANNEL : 'c' + i, name: body.partyNames[i - 1] || `Party ${i + 1}` })) };
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
    server, url: `http://localhost:${server.address().port}`,
    setConnected: (channelId, ids) => { connected[channelId] = ids.map((x) => (typeof x === 'string' ? { id: x, mute: false, deaf: false } : x)); },
  })));
}

async function startServer(extraEnv) {
  const fake = await startFakeDiscord();
  const bot = await startFakeBot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-voicetrackctl-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1',
      DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
      SHOTCALLER_URL: bot.url, SHOTCALLER_API_KEY: KEY,
      VOICE_POLL_INTERVAL_MS: '150',
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
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return {
    call, fake, bot,
    officer: await login('Boss', 'o1'),
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); fake.close(); bot.server.close(); },
  };
}
const withServer = (name, fn, extraEnv) => test(name, { timeout: 30000 }, async () => { const s = await startServer(extraEnv); try { await fn(s); } finally { await s.stop(); } });
const poll = async (s, fn, tries = 30, gapMs = 150) => {
  for (let i = 0; i < tries; i++) { const r = await fn(); if (r) return r; await new Promise((res) => setTimeout(res, gapMs)); }
  throw new Error('condition never became true within the poll budget');
};
const attendedOf = async (s, evId) => { const after = (await s.call('/api/state', 'GET', null, s.officer)).body; return after.events.find((e) => e.id === evId); };
const postBody = (overrides) => ({ image: pngDataUrl(), text: 'test post', channelId: PARTIES_CHANNEL, channelName: 'parties', shotcaller: { enabled: true, channelId: VOICE_CHANNEL }, ...overrides });

async function makeTrackedEvent(s, startOffsetMin, extra) {
  const n = Math.floor(Math.random() * 1e6);
  const owners = { anchor: [`d-anchor-1-${n}`, `d-anchor-2-${n}`] };
  const make = async (owner) => (await s.call('/api/members', 'POST', { name: owner, role: 'DPS', owner }, s.officer)).body;
  const anchorMembers = await Promise.all(owners.anchor.map(make));
  const ev = (await s.call('/api/events', 'POST', {
    type: 'Castle Siege', start: new Date(Date.now() + (startOffsetMin ?? -5) * 60000).toISOString(), points: 10, ...extra,
  }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: [{ name: 'Anchor', members: anchorMembers.map((m) => m.id), leader: anchorMembers[0].id }] }, s.officer);
  return { ev, anchorMembers };
}

withServer('voiceTrackAuto defaults to true (on) and round-trips through create/update', async (s) => {
  const ev = (await s.call('/api/events', 'POST', { type: 'Castle Siege', start: new Date(Date.now() + 3600000).toISOString() }, s.officer)).body;
  assert.equal(ev.voiceTrackAuto, true, 'on by default - matches the always-automatic behavior this feature used to have unconditionally');
  const off = (await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, voiceTrackAuto: false }, s.officer)).body;
  assert.equal(off.voiceTrackAuto, false);
  const backOn = (await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, voiceTrackAuto: true }, s.officer)).body;
  assert.equal(backOn.voiceTrackAuto, true);
});

withServer('with automatic tracking off, starting Shotcaller for the event does NOT begin tracking on its own', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, voiceTrackAuto: false }, s.officer);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shotcaller.ok, true, 'Shotcaller itself still starts as asked');
  s.bot.setConnected(VOICE_CHANNEL, anchorMembers.map((m) => m.owner));
  await new Promise((res) => setTimeout(res, 500));
  const stillUntracked = await attendedOf(s, ev.id);
  assert.equal(stillUntracked.attended.length, 0, 'nobody is credited - automatic tracking was switched off for this event');
});

withServer('"Start tracking now" manually begins tracking the already-running Shotcaller session', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s);
  await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, voiceTrackAuto: false }, s.officer);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.bot.setConnected(VOICE_CHANNEL, anchorMembers.map((m) => m.owner));
  await new Promise((res) => setTimeout(res, 400));
  assert.equal((await attendedOf(s, ev.id)).attended.length, 0, 'confirming nothing was tracked yet');

  const start = await s.call(`/api/events/${ev.id}/voice-track/start`, 'POST', {}, s.officer);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.length >= anchorMembers.length ? e : null; });
  const finalEv = await attendedOf(s, ev.id);
  for (const m of anchorMembers) assert.ok(finalEv.attended.includes(m.id), 'tracking started by hand still credits people actually seen in voice');
});

withServer('"Start tracking now" is refused when no Shotcaller session is actually running', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev } = await makeTrackedEvent(s);
  await s.call(`/api/events/${ev.id}`, 'PUT', { type: ev.type, start: ev.start, voiceTrackAuto: false }, s.officer);
  const r = await s.call(`/api/events/${ev.id}/voice-track/start`, 'POST', {}, s.officer);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not running/i);
});

withServer('"Start tracking now" is refused for an event that is not using voice tracking at all', async (s) => {
  const { ev } = await makeTrackedEvent(s);    // guild default is still 'pin'
  const r = await s.call(`/api/events/${ev.id}/voice-track/start`, 'POST', {}, s.officer);
  assert.equal(r.status, 400);
});

withServer('a member-only user cannot start tracking by hand', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev } = await makeTrackedEvent(s);
  const member = (await s.call('/api/login', 'POST', { name: 'Rando', passcode: 'm1' })).body.token;
  const r = await s.call(`/api/events/${ev.id}/voice-track/start`, 'POST', {}, member);
  assert.equal(r.status, 403);
});

withServer("an event's own extra channels count toward its attendance, on top of whatever the guild-wide list has", async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);     // no guild-wide extra channels set
  const { ev, anchorMembers } = await makeTrackedEvent(s, -5, { voiceTrackExtraChannelIds: [OWN_EXTRA_CHANNEL] });
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Nobody is in the party's own channel at all - only in this event's own extra channel.
  s.bot.setConnected(OWN_EXTRA_CHANNEL, [anchorMembers[0].owner]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(anchorMembers[0].id) ? e : null; });
  const finalEv = await attendedOf(s, ev.id);
  assert.ok(finalEv.attended.includes(anchorMembers[0].id), "seen in this event's own extra channel - counts toward its attendance");
  assert.ok(!finalEv.attended.includes(anchorMembers[1].id), 'never seen anywhere - stays unmarked');
});

withServer("an event's own extra channels never leak into another event's attendance", async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev } = await makeTrackedEvent(s, -5, { voiceTrackExtraChannelIds: [OWN_EXTRA_CHANNEL] });
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // voiceTrackExtraChannelIds was only ever set on THIS event, never saved guild-wide.
  const settings = (await s.call('/api/state', 'GET', null, s.officer)).body.settings;
  assert.deepEqual(settings.voiceTrackExtraChannelIds, [], "the guild-wide list is untouched by one event's own picker");
});

// ---------------------------------------------------------------- "Track again" (attendance rework addendum)
withServer('"Track again" resets attendance all the way to never-tracked, then starts a fresh track', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s, -5);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.bot.setConnected(VOICE_CHANNEL, anchorMembers.map((m) => m.owner));
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.length === anchorMembers.length ? e : null; });
  let cur = await attendedOf(s, ev.id);
  assert.equal(cur.attendanceTracked, true, 'tracked - real sightings were credited');

  // An officer hand-corrects one of them to "not attending" before restarting - this is the kind of correction
  // "Track again" is supposed to wipe too, not just whatever voice tracking itself credited.
  await s.call(`/api/events/${ev.id}/attendance-status`, 'POST', { owner: anchorMembers[0].owner, status: 'noshow' }, s.officer);
  cur = await attendedOf(s, ev.id);
  assert.ok(!cur.attended.includes(anchorMembers[0].id), 'the hand correction took effect');

  s.bot.setConnected(VOICE_CHANNEL, []);   // nobody connected right now - restart should not instantly re-credit anyone
  const restart = await s.call(`/api/events/${ev.id}/voice-track/restart`, 'POST', {}, s.officer);
  assert.equal(restart.status, 200, JSON.stringify(restart.body));
  cur = await attendedOf(s, ev.id);
  assert.equal(cur.attended.length, 0, 'everything reset to never-tracked - including the hand correction, not just the voice credits');
  assert.equal(cur.attendanceTracked, false, 'reads as never tracked, not merely emptied');
  assert.equal(cur.autoAttended, false);

  // The fresh pass needs its own two sightings again (the old seenAt counters were discarded) before
  // crediting anyone - confirms beginVoiceTracking really did start a brand new voiceTracking object.
  s.bot.setConnected(VOICE_CHANNEL, anchorMembers.map((m) => m.owner));
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.length === anchorMembers.length ? e : null; });
});

withServer('"Track again" is refused when no Shotcaller session is running, same precondition as "Start tracking now"', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev } = await makeTrackedEvent(s);
  const r = await s.call(`/api/events/${ev.id}/voice-track/restart`, 'POST', {}, s.officer);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not running/i);
});

// ------------------------------------------------- the "who got tracked" popup's raw seen/mute-deaf log
withServer('every sighting - credited or not, muted or not - is logged in voiceTracking.seen for the tracked-players popup', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice', voiceAttendanceIgnoreMuted: true }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s, -5);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // One player connects clean (gets credited); the other connects muted, and ignoreMuted is on, so they are
  // seen but deliberately never credited - the popup needs to show them anyway, with why they were missed.
  s.bot.setConnected(VOICE_CHANNEL, [
    { id: anchorMembers[0].owner, mute: false, deaf: false },
    { id: anchorMembers[1].owner, mute: true, deaf: false },
  ]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(anchorMembers[0].id) ? e : null; });
  const final = await attendedOf(s, ev.id);
  assert.ok(!final.attended.includes(anchorMembers[1].id), 'muted and ignoreMuted is on - never credited');
  const seen = final.voiceTracking.seen;
  const credited = seen[anchorMembers[0].owner], missed = seen[anchorMembers[1].owner];
  assert.equal(credited.credited, true);
  assert.equal(credited.mutedAtCredit, false, 'state at the moment of crediting, frozen - not a live read');
  assert.equal(missed.credited, false);
  assert.equal(missed.muted, true, 'logged anyway, so the popup can say why this one was missed');
  assert.equal(missed.memberId, anchorMembers[1].id, 'resolved to the actual character, not just a bare Discord id');
});
