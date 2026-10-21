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

  // The new per-channel breakdown the "Who got tracked" popup groups by: both sightings landed in the same
  // (anchor) channel, so both entries should carry that same channelId/channelLabel, and the live channel
  // list on voiceTracking.channels should include it (not marked empty, since two people are actually there).
  assert.equal(credited.channelId, missed.channelId, 'both sightings were in the same channel');
  assert.ok(credited.channelLabel, 'each sighting should carry a human-readable channel label for the popup');
  const chans = final.voiceTracking.channels;
  assert.ok(Array.isArray(chans) && chans.length >= 1, 'the live channel list should be published for the popup to group by');
  const theChan = chans.find((c) => c.channelId === credited.channelId);
  assert.ok(theChan, 'the channel both sightings landed in should be in the published list');
  assert.equal(theChan.empty, false, 'a channel with two people actually in it is not empty');
});

// A channel the bot created but where nobody ever showed up should still appear in the popup's channel
// list, marked empty - this is the whole point of publishing the full channel list separately from the
// sighting log (which, by definition, only ever has entries for channels someone was actually seen in).
withServer("an empty voice channel the bot created shows up in voiceTracking.channels as empty, not just missing", async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const { ev, anchorMembers } = await makeTrackedEvent(s, -5);
  // Add a second, real party - this file's own makeTrackedEvent only ever sets up the anchor, so a second
  // party has to be added explicitly here to get the bot to create more than one channel at all.
  const party2Member = (await s.call('/api/members', 'POST', { name: 'P2-' + ev.id, role: 'DPS', owner: 'd-p2-' + ev.id }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: [
    { name: 'Anchor', members: anchorMembers.map((m) => m.id), leader: anchorMembers[0].id },
    { name: 'Party 2', members: [party2Member.id], leader: party2Member.id },
  ] }, s.officer);
  const r = await s.call(`/api/events/${ev.id}/post-parties`, 'POST', postBody({}), s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Only the anchor's own channel gets anyone at all - party 2's channel (c1) stays completely empty.
  s.bot.setConnected(VOICE_CHANNEL, anchorMembers.map((m) => m.owner));
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(anchorMembers[0].id) ? e : null; });
  const final = await attendedOf(s, ev.id);
  const chans = final.voiceTracking.channels;
  assert.ok(chans.length >= 2, 'both the anchor channel and party 2\'s empty channel should be published');
  const emptyOnes = chans.filter((c) => c.empty);
  assert.ok(emptyOnes.length >= 1, 'party 2\'s channel, which nobody ever joined, should be listed and marked empty');
});

// Reproduces the reported bug: party 1-8 got tracked, party 11 did not. The manual "Start tracking now"
// button (and "Track again") recompute which of ev.parties are real (non-placeholder) fresh at the moment
// they're clicked - if the line-up changed since the Shotcaller session itself was actually started (an
// officer added, removed, or reordered a party in between), that freshly-recomputed list no longer lines up
// by plain array position with the channels the bot's session actually has. beginVoiceTracking resolves this
// by matching each party's channel by the "<leader>'s Party" name the bot echoes back, falling back to
// position only for parties that don't match a name - this confirms that resolution actually finds the right
// channel for a party whose position shifted, not just the common case where nothing changed in between.
withServer('"Start tracking now" still finds the right channel for a party after the line-up changed since Shotcaller itself was started', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const n = Math.floor(Math.random() * 1e6);
  const make = async (owner) => (await s.call('/api/members', 'POST', { name: owner, role: 'DPS', owner }, s.officer)).body;
  const anchor1 = await make(`anchor-${n}`);
  const memberB = await make(`partyb-${n}`);
  const memberC = await make(`partyc-${n}`);
  const ev = (await s.call('/api/events', 'POST', { type: 'Castle Siege', start: new Date(Date.now() - 300000).toISOString(), voiceTrackAuto: false }, s.officer)).body;
  // placeholderOverride/placeholder force these small (1-member) parties to count as real line-ups, not
  // placeholders - belt-and-suspenders here since they're already non-placeholder by the default rule too
  // (only a genuinely empty party is), but this is also exactly the override an officer gets from the party
  // menu's "Mark/Unmark as placeholder", which this test exercises on purpose.
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: [
    { name: 'Anchor', members: [anchor1.id], leader: null },
    { name: 'Party B', members: [memberB.id], leader: memberB.id, placeholderOverride: true, placeholder: false },
    { name: 'Party C', members: [memberC.id], leader: memberC.id, placeholderOverride: true, placeholder: false },
  ] }, s.officer);

  // Start Shotcaller directly (the standalone "Start Shotcaller session" dialog's own route), exactly the
  // same way public/shotcaller.js's manual dialog does - naming party B and C's channels after their leaders.
  const started = await s.call('/api/shotcaller/start', 'POST', { channelId: VOICE_CHANNEL, count: 3, partyNames: [`${memberB.name}'s Party`, `${memberC.name}'s Party`] }, s.officer);
  assert.equal(started.status, 200, JSON.stringify(started.body));

  // The line-up changes before tracking is actually started: party B is dropped entirely (e.g. that player
  // left/was removed from the roll call), leaving only Anchor and Party C - so the SAME-POSITION channel the
  // bot gave party B when the session started is no longer where party C's members connect.
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: [
    { name: 'Anchor', members: [anchor1.id], leader: null },
    { name: 'Party C', members: [memberC.id], leader: memberC.id, placeholderOverride: true, placeholder: false },
  ] }, s.officer);

  const start = await s.call(`/api/events/${ev.id}/voice-track/start`, 'POST', {}, s.officer);
  assert.equal(start.status, 200, JSON.stringify(start.body));

  // Party C's actual channel is 'c2' (the bot assigned party B's old slot 'c1', party C's slot 'c2' when the
  // session started) - a member connecting there should still be credited under their own party's real
  // channel, not silently missed (or wrongly credited under party B's stale slot).
  s.bot.setConnected('c2', [memberC.owner]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(memberC.id) ? e : null; });
  const finalEv = await attendedOf(s, ev.id);
  assert.ok(finalEv.attended.includes(memberC.id), 'party C is tracked on its own real channel even though its position in ev.parties shifted after the session started');
});

// The actual reported scenario: no party has a leader assigned at all (this guild doesn't use them with
// voice tracking), so there is no name for beginVoiceTracking to match on - everything comes down to plain
// position. Parties are signed up and assigned before the session starts; afterward, the officer reassigns
// players between parties by telling them in voice/chat rather than re-posting the line-up, which can change
// how many of ev.parties still count as "real" (non-placeholder) by the time "Start tracking now" is
// eventually clicked. If a party earlier in the list drops below the placeholder threshold in between, every
// REAL party after it shifts down by one position relative to the channels the bot actually created for the
// original count - silently losing the last party's channel from tracking entirely. This is what the
// snapshot taken at /api/shotcaller/start time (with an eventId) fixes: it freezes the full channel list
// against the ORIGINAL count/order, so a later count change can no longer drop anything off the end.
withServer('"Start tracking now" still tracks every party after an earlier party was reassigned down to a placeholder, with no leaders involved at all', async (s) => {
  await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
  const n = Math.floor(Math.random() * 1e6);
  const make = async (owner) => (await s.call('/api/members', 'POST', { name: owner, role: 'DPS', owner }, s.officer)).body;
  const anchor1 = await make(`anchor-${n}`);
  const memberB = await make(`partyb-${n}`);
  const memberC = await make(`partyc-${n}`);
  const memberD = await make(`partyd-${n}`);
  const ev = (await s.call('/api/events', 'POST', { type: 'Castle Siege', start: new Date(Date.now() - 300000).toISOString(), voiceTrackAuto: false }, s.officer)).body;
  // No leader on any party - matches this guild's actual setup when using voice tracking.
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: [
    { name: 'Anchor', members: [anchor1.id], leader: null },
    { name: 'Party B', members: [memberB.id], leader: null, placeholderOverride: true, placeholder: false },
    { name: 'Party C', members: [memberC.id], leader: null, placeholderOverride: true, placeholder: false },
    { name: 'Party D', members: [memberD.id], leader: null, placeholderOverride: true, placeholder: false },
  ] }, s.officer);

  // Start Shotcaller directly, set up "from this event" (eventId passed, as public/shotcaller.js's manual
  // dialog now does) - 4 parties total, no party names since nobody's bound to a leader here.
  const started = await s.call('/api/shotcaller/start', 'POST', { channelId: VOICE_CHANNEL, count: 4, partyNames: [null, null, null], eventId: ev.id }, s.officer);
  assert.equal(started.status, 200, JSON.stringify(started.body));

  // Party C gets reassigned down to a placeholder in between (its one member was pulled out to cover
  // somewhere else, told by voice rather than re-posted) - without the fix, this shifts party D down into
  // party C's old channel slot and drops party D's actual channel off the tracked list entirely.
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: [
    { name: 'Anchor', members: [anchor1.id], leader: null },
    { name: 'Party B', members: [memberB.id], leader: null, placeholderOverride: true, placeholder: false },
    { name: 'Party C', members: [], leader: null, placeholderOverride: true, placeholder: true },
    { name: 'Party D', members: [memberD.id], leader: null, placeholderOverride: true, placeholder: false },
  ] }, s.officer);

  const start = await s.call(`/api/events/${ev.id}/voice-track/start`, 'POST', {}, s.officer);
  assert.equal(start.status, 200, JSON.stringify(start.body));

  // Party D's real channel is 'c3' (anchor=VOICE_CHANNEL, B='c1', C='c2', D='c3' when the 4-party session was
  // actually created) - still credited even though D is now only the second real party, not the third.
  s.bot.setConnected('c3', [memberD.owner]);
  await poll(s, async () => { const e = await attendedOf(s, ev.id); return e.attended.includes(memberD.id) ? e : null; });
  const finalEv = await attendedOf(s, ev.id);
  assert.ok(finalEv.attended.includes(memberD.id), "party D is still tracked on its own real channel after an earlier party's placeholder status changed, with no leader to go by at all");
});

// ---------------------------------------------------------------- back-to-back events on one Shotcaller session
withServer(
  "a track finishes itself after its 3 quick checks - so the next event can start tracking on the still-running session with no restart",
  async (s) => {
    await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
    const { ev: evA, anchorMembers: membersA } = await makeTrackedEvent(s, -5);
    const r = await s.call(`/api/events/${evA.id}/post-parties`, 'POST', postBody({}), s.officer);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    s.bot.setConnected(VOICE_CHANNEL, membersA.map((m) => m.owner));
    await poll(s, async () => { const e = await attendedOf(s, evA.id); return e.attended.length === membersA.length ? e : null; });

    // The 3 quick checks (VOICE_POLL_INTERVAL_MS=150 in this test, see startServer) run their course on
    // their own - no duration setting to wait out, just the fixed 3-check cycle finishing itself.
    await poll(s, async () => { const e = await attendedOf(s, evA.id); return (e.voiceTracking.active === false && e.voiceTracking.finishedAt) ? e : null; }, 40, 100);
    const curA = await attendedOf(s, evA.id);
    assert.equal(curA.voiceTracking.active, false, "event A's own track finished itself once its 3 checks were done");
    assert.ok(curA.voiceTracking.finishedAt, 'finished immediately, not left "awaiting save"');
    assert.ok(curA.attended.includes(membersA[0].id), 'the attendance it already earned is untouched');

    // The bot/session was never stopped or restarted - event B can start tracking on it immediately by hand,
    // exactly the back-to-back workflow this quick-check model is for.
    const { ev: evB, anchorMembers: membersB } = await makeTrackedEvent(s, -1, { voiceTrackAuto: false });
    const startB = await s.call(`/api/events/${evB.id}/voice-track/start`, 'POST', {}, s.officer);
    assert.equal(startB.status, 200, JSON.stringify(startB.body), 'the session is still live, so this needs no restart');
    s.bot.setConnected(VOICE_CHANNEL, membersB.map((m) => m.owner));
    await poll(s, async () => { const e = await attendedOf(s, evB.id); return e.attended.length === membersB.length ? e : null; });
  },
);

withServer(
  'finishing a track by hand before its 3 checks are done lets an officer move straight on to the next event',
  async (s) => {
    await s.call('/api/settings', 'PUT', { attendanceMode: 'voice' }, s.officer);
    const { ev: evA, anchorMembers: membersA } = await makeTrackedEvent(s, -5);
    // Connected BEFORE Shotcaller starts (and tracking begins) so the very first of the 3 checks already
    // sees everyone - and VOICE_POLL_INTERVAL_MS is overridden to a much longer gap for this test alone, so
    // checks #2/#3 (on a real wall-clock timer, ticking regardless of how long the surrounding request takes)
    // can't race ahead and finish the track on their own before this test gets to finish it by hand.
    s.bot.setConnected(VOICE_CHANNEL, membersA.map((m) => m.owner));
    const r = await s.call(`/api/events/${evA.id}/post-parties`, 'POST', postBody({}), s.officer);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // ev.attended itself is not updated until the track actually finishes (natural or by hand) - while it's
    // still running, whoever has been SEEN so far only lives in voiceTracking.sessionSeen. Poll on that.
    await poll(s, async () => { const e = await attendedOf(s, evA.id); return (e.voiceTracking.sessionSeen || []).length >= membersA.length ? e : null; });
    const stillRunning = await attendedOf(s, evA.id);
    assert.equal(stillRunning.voiceTracking.active, true, 'confirming it is genuinely still running, not already stopped');
    assert.equal(stillRunning.attended.length, 0, 'seen, but not yet credited to attendance - that only happens once the track finishes');

    const finish = await s.call(`/api/events/${evA.id}/voice-track/finish`, 'POST', {}, s.officer);
    assert.equal(finish.status, 200, JSON.stringify(finish.body));
    assert.equal(finish.body.voiceTracking.active, false);
    assert.ok(finish.body.voiceTracking.finishedAt, 'finished immediately by hand, while the session was still live');
    for (const m of membersA) assert.ok(finish.body.attended.includes(m.id), 'finishing by hand credits everyone seen so far, not just whoever would have been seen by check 3');

    const { ev: evB, anchorMembers: membersB } = await makeTrackedEvent(s, -1, { voiceTrackAuto: false });
    s.bot.setConnected(VOICE_CHANNEL, membersB.map((m) => m.owner));
    const startB = await s.call(`/api/events/${evB.id}/voice-track/start`, 'POST', {}, s.officer);
    assert.equal(startB.status, 200, JSON.stringify(startB.body), 'no restart needed - the session never stopped');
    await poll(s, async () => { const e = await attendedOf(s, evB.id); return (e.voiceTracking.sessionSeen || []).length >= membersB.length ? e : null; });
    await s.call(`/api/events/${evB.id}/voice-track/finish`, 'POST', {}, s.officer);
    assert.equal((await attendedOf(s, evA.id)).attended.length, membersA.length, "event A keeps what it earned, undisturbed by B's track starting");
  },
  { VOICE_POLL_INTERVAL_MS: '5000' },
);
