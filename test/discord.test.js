// Tests for Discord sign-in, the attendance PIN and the no-reply reminders.
// A fake Discord API (test/fake-discord.js) stands in for Discord, so nothing leaves your computer.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111', OFFICER_ROLE = '900000000000000001';
const A = '100000000000000001', B = '100000000000000002', C = '100000000000000003', D = '100000000000000004', OUTSIDER = '100000000000000009';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(100); } }

let fake, dir, proc, port, base;
const sessions = {};

async function startServer(seedDb) {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-discord-'));
  if (seedDb) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seedDb));
  port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, SCHEDULER_INTERVAL_MS: '300', DISCORD_DM_DELAY_MS: '0',
      DISCORD_CLIENT_ID: '555', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_URL: base, DISCORD_GUILD_ID: GUILD,
      DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
}
// Waits for the process to actually exit before clearing its data directory - it now flushes a final save on
// SIGTERM (see server.js), so deleting the directory out from under that write would be a race.
async function stopServer() {
  if (proc) { proc.kill(); await new Promise((r) => proc.once('exit', r)); }
  fake && fake.close();
  dir && fs.rmSync(dir, { recursive: true, force: true });
}

// Walks through the OAuth redirect exactly like a browser would and returns the session cookie.
async function discordLogin(id, roles = [], { state: forceState, authQuery = '' } = {}) {
  fake.state.guildMembers[id] = roles === null ? undefined : { roles };
  const start = await fetch(base + '/auth/discord' + authQuery, { redirect: 'manual' });
  // /auth/discord can set more than one cookie (gh_oauth always, plus gh_merc or gh_guestcoach when the link
  // asked for one) - all of them need forwarding to the callback below, not just gh_oauth, or a bypass cookie
  // set here is silently dropped before the callback ever sees it.
  const setCookies = (start.headers.raw ? start.headers.raw()['set-cookie'] : start.headers.get('set-cookie').split(/,(?=\s*\w+=)/)) || [];
  const startCookies = Object.fromEntries(setCookies.map((c) => c.split(';')[0].split('=').map((s) => s.trim())));
  const oauth = startCookies.gh_oauth;
  const forwardCookie = Object.entries(startCookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${forceState ?? oauth}`, { redirect: 'manual', headers: { Cookie: forwardCookie } });
  const cookie = /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '');
  return { start, cb, cookie: cookie ? `gh_session=${cookie[1]}` : null, location: cb.headers.get('location') };
}
const call = async (p, method = 'GET', body, who) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: sessions[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const state = async (who) => (await call('/api/state', 'GET', null, who)).body;
const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();

before(async () => {
  await startServer();
  sessions.A = (await discordLogin(A, [OFFICER_ROLE])).cookie;
  sessions.B = (await discordLogin(B, [])).cookie;
  sessions.C = (await discordLogin(C, [])).cookie;
  sessions.D = (await discordLogin(D, [])).cookie;
});
after(stopServer);

test('sign-in goes through Discord and only accepts members of the Discord server', async () => {
  assert.equal((await call('/api/config')).body.authMode, 'discord');
  assert.equal((await call('/api/login', 'POST', { name: 'Zed', passcode: 'guild' })).status, 400, 'passcodes are off once Discord is set up');
  const start = await fetch(base + '/auth/discord', { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  assert.equal(start.status, 302);
  assert.equal(loc.searchParams.get('client_id'), '555');
  assert.equal(loc.searchParams.get('redirect_uri'), base + '/auth/discord/callback');
  assert.match(loc.searchParams.get('scope'), /identify/);
  assert.equal(loc.searchParams.get('state'), /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1]);

  const st = await state('A');
  assert.equal(st.user.role, 'officer'); assert.equal(st.user.key, A);
  assert.equal((await state('B')).user.role, 'member');
  assert.deepEqual((await state('B')).users.map((u) => u.id).sort(), [A, B, C, D]);

  const stranger = await discordLogin(OUTSIDER, null);
  assert.equal(stranger.cookie, null);
  assert.match(decodeURIComponent(stranger.location), /not a member of our Discord server/);
  const forged = await discordLogin(OUTSIDER, [], { state: 'wrong' });
  assert.equal(forged.cookie, null);
  assert.match(decodeURIComponent(forged.location), /expired/);
  assert.equal((await fetch(base + '/api/state')).status, 401);
});

test('cookie sessions are protected against requests from other websites, and logout ends them', async () => {
  const noJson = await fetch(base + '/api/events', { method: 'POST', headers: { Cookie: sessions.A, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(noJson.status, 415);
  const foreign = await fetch(base + '/api/events', { method: 'POST', headers: { Cookie: sessions.A, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const out = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: sessions.B, 'Content-Type': 'application/json' } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('characters belong to a Discord user; officers can move them to another player', async () => {
  const mine = (await call('/api/members', 'POST', { name: 'Lead', role: 'Tank', primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Greatsword' }, 'B')).body;
  assert.equal(mine.owner, B);
  assert.equal((await call('/api/members/' + mine.id, 'PUT', { name: 'Hax', role: 'Tank' }, 'C')).status, 403);
  assert.equal((await call('/api/members/' + mine.id, 'PUT', { name: 'Lead', role: 'Tank', owner: 'not-a-user' }, 'A')).status, 400);
  const moved = (await call('/api/members/' + mine.id, 'PUT', { name: 'Lead', role: 'Tank', owner: C }, 'A')).body;
  assert.equal(moved.owner, C);
  await call('/api/members/' + mine.id, 'PUT', { name: 'Lead', role: 'Tank', owner: B }, 'A');
  // old data: characters that belong to a display name can be linked to a Discord player
  const legacy = (await call('/api/members', 'POST', { name: 'OldChar', role: 'DPS', owner: D }, 'A')).body;
  await call('/api/members/' + legacy.id, 'DELETE', null, 'A');
  assert.equal((await call('/api/admin/link-owner', 'POST', { from: 'Nobody', to: 'nope' }, 'A')).status, 400);
  assert.equal((await call('/api/admin/link-owner', 'POST', { from: 'Nobody', to: D }, 'A')).status, 200);
});

test('"Maybe" is gone, an untitled event takes its type as title, and sign-ups close before the start', async () => {
  const cee = (await call('/api/members', 'POST', { name: 'Cee', role: 'DPS' }, 'C')).body;
  const soon = (await call('/api/events', 'POST', { type: 'Guild bosses', start: inMinutes(10) }, 'A')).body;
  assert.equal(soon.title, 'Guild bosses', 'no title: the type is used');
  assert.equal(soon.signupCloseMinutes, 30, 'default from Admin');
  const later = (await call('/api/events', 'POST', { title: 'Later', type: 'Other', start: inMinutes(180), reminders: false }, 'A')).body;
  assert.equal((await call(`/api/events/${later.id}/rsvp`, 'POST', { memberId: cee.id, status: 'maybe' }, 'C')).status, 400);
  assert.equal((await call(`/api/events/${later.id}/rsvp`, 'POST', { memberId: cee.id, status: 'yes' }, 'C')).status, 200);
  assert.equal((await call(`/api/events/${soon.id}/rsvp`, 'POST', { memberId: cee.id, status: 'yes' }, 'C')).status, 409, 'closed 30 minutes before the start');
  assert.equal((await call(`/api/events/${soon.id}/rsvp`, 'POST', { memberId: cee.id, status: 'yes' }, 'A')).status, 200, 'officers can still sign people up');
  const edited = (await call('/api/events/' + soon.id, 'PUT', { type: 'Guild bosses', start: soon.start, signupCloseMinutes: 5 }, 'A')).body;
  assert.equal(edited.title, 'Guild bosses');
  assert.equal((await call(`/api/events/${soon.id}/rsvp`, 'POST', { memberId: cee.id, status: 'no' }, 'C')).status, 200, 'the close time is editable per event');
});

test('the attendance PIN goes to party leaders and leadership only; players type it in within the window', async () => {
  await call('/api/settings', 'PUT', { pointsEnabled: true }, 'A');
  const st0 = await state('A');
  const lead = st0.members.find((m) => m.name === 'Lead'), cee = st0.members.find((m) => m.name === 'Cee');
  const dee = (await call('/api/members', 'POST', { name: 'Dee', role: 'Healer' }, 'D')).body;
  const ev = (await call('/api/events', 'POST', { title: 'PIN night', type: 'Wargames', start: inMinutes(5), pinWindowMinutes: 10, pinEnabled: true }, 'A')).body;
  await call(`/api/events/${ev.id}/parties`, 'POST', { parties: [{ name: 'Party 1', leader: lead.id, members: [lead.id, cee.id] }] }, 'A');
  assert.equal((await state('A')).events.find((e) => e.id === ev.id).pin, null, 'not generated before its time');
  assert.equal((await call('/api/events/' + ev.id + '/pin', 'POST', { memberId: dee.id, pin: '0000' }, 'D')).status, 409, 'no PIN yet');

  fake.state.dms.length = 0;
  assert.equal((await call('/api/settings', 'PUT', { pinOffsetMinutes: -10 }, 'A')).status, 200);     // the PIN is now due
  const withPin = await waitFor(async () => (await state('A')).events.find((e) => e.id === ev.id && e.pin));
  const code = withPin.pin.code;
  assert.match(code, /^\d{4}$/);
  const pinDMs = await waitFor(() => { const l = fake.state.dms.filter((d) => d.content.includes('PIN night')); return l.length >= 2 && l; });
  assert.deepEqual(pinDMs.map((d) => d.to).sort(), [A, B].sort(), 'party leader + officer, nobody else');
  assert.ok(pinDMs.every((d) => d.content.includes(code)));
  assert.ok(pinDMs.find((d) => d.to === B).content.includes('leader of Party 1'));
  assert.equal(withPin.pin.sent.length, 2);

  const seenByPlayer = (await state('D')).events.find((e) => e.id === ev.id);
  assert.equal(seenByPlayer.pin, undefined, 'players never receive the PIN');
  assert.equal(seenByPlayer.pinInfo.state, 'open');
  assert.equal(seenByPlayer.pinEntries, undefined);

  const wrong = code === '0000' ? '1111' : '0000';
  const bad = await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: dee.id, pin: wrong }, 'D');
  assert.equal(bad.status, 400); assert.match(bad.body.error, /4 tries left/);
  assert.equal((await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: cee.id, pin: code }, 'D')).status, 403, 'only your own characters');
  const ok = await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: dee.id, pin: code }, 'D');
  assert.equal(ok.status, 200);
  const after = (await state('A')).events.find((e) => e.id === ev.id);
  assert.ok(after.attended.includes(dee.id));
  assert.ok(after.pinEntries[dee.id]);
  assert.ok((await state('A')).points.some((p) => p.eventId === ev.id && p.memberId === dee.id), 'attending by PIN gives the normal points');

  for (let i = 0; i < 5; i++) await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: cee.id, pin: wrong }, 'C');
  const locked = await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: cee.id, pin: code }, 'C');
  assert.equal(locked.status, 429, 'five wrong tries lock the player out, even with the right PIN');

  assert.equal((await call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'new' }, 'C')).status, 403);
  fake.state.dms.length = 0;
  const fresh = (await call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'new' }, 'A')).body;
  assert.notEqual(fresh.pin.at, withPin.pin.at);
  assert.equal(fake.state.dms.filter((d) => d.content.includes(fresh.pin.code)).length, 2);
  assert.equal((await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: cee.id, pin: fresh.pin.code }, 'C')).status, 200, 'a new PIN clears the lock');

  fake.state.failDM.add(B);
  const resent = (await call(`/api/events/${ev.id}/pin/send`, 'POST', {}, 'A')).body;
  const failedOne = resent.pin.sent.find((x) => x.id === B);
  assert.equal(failedOne.ok, false); assert.match(failedOne.error, /DMs are closed/);
  fake.state.failDM.delete(B);
  const test = await call('/api/admin/test-dm', 'POST', {}, 'A');
  assert.equal(test.body.ok, true);
});

test('the attendance PIN defaults to following Mandatory, but can be switched independently either way, per event', async () => {
  assert.equal((await call('/api/settings', 'PUT', { pinOffsetMinutes: -10 }, 'A')).status, 200);     // PINs are due the instant an event starts

  // Wargames defaults to not mandatory (config.json) - leaving pinEnabled untouched should default to off, so
  // no PIN gets created automatically, even once it is well past due.
  const optional = (await call('/api/events', 'POST', { title: 'Optional night', type: 'Wargames', start: inMinutes(1), pinWindowMinutes: 10 }, 'A')).body;
  assert.equal(optional.mandatory, false);
  assert.equal(optional.pinEnabled, false, 'follows Mandatory by default');
  await sleep(300);
  assert.equal((await state('A')).events.find((e) => e.id === optional.id).pin, null, 'no automatic PIN for a non-mandatory event left on its default');

  // The same non-mandatory type, but with the PIN explicitly switched on for this one event - now it should
  // fire automatically just like a mandatory event would.
  const optionalWithPin = (await call('/api/events', 'POST', { title: 'Optional night, PIN on', type: 'Wargames', start: inMinutes(1), pinWindowMinutes: 10, pinEnabled: true }, 'A')).body;
  assert.equal(optionalWithPin.mandatory, false);
  assert.equal(optionalWithPin.pinEnabled, true);
  await waitFor(async () => (await state('A')).events.find((e) => e.id === optionalWithPin.id && e.pin));

  // A mandatory event defaults the other way (PIN on), but that too can be switched off per event - and an
  // officer can still always send one by hand regardless, since that action has no check of its own.
  const mandatoryNoPin = (await call('/api/events', 'POST', { title: 'Mandatory, PIN off', type: 'Castle Siege', start: inMinutes(1), pinWindowMinutes: 10, pinEnabled: false }, 'A')).body;
  assert.equal(mandatoryNoPin.mandatory, true);
  assert.equal(mandatoryNoPin.pinEnabled, false);
  await sleep(300);
  assert.equal((await state('A')).events.find((e) => e.id === mandatoryNoPin.id).pin, null, 'switched off even though the event is mandatory');
  const sentByHand = (await call(`/api/events/${mandatoryNoPin.id}/pin/send`, 'POST', {}, 'A')).body;
  assert.ok(sentByHand.pin.code, 'an officer can still always send one manually regardless of the switch');

  // Editing an event to toggle Mandatory does not silently flip pinEnabled along with it - the two are picked
  // independently once set.
  const edited = (await call('/api/events/' + optional.id, 'PUT', { title: optional.title, type: optional.type, start: optional.start, mandatory: true, pinEnabled: false }, 'A')).body;
  assert.equal(edited.mandatory, true);
  assert.equal(edited.pinEnabled, false, 'an explicit pinEnabled on the request is kept, not overridden by the new Mandatory value');
});

test('reopening the PIN window keeps the same code, clears wrong-PIN strikes, and does not re-send DMs', async () => {
  // A previous test left pinOffsetMinutes at -10 (PIN due 10 minutes before the start) - reset it here so the
  // scheduler does not race in and auto-generate a PIN before this test gets to do it explicitly below.
  await call('/api/settings', 'PUT', { pinOffsetMinutes: 0 }, 'A');
  const ev = (await call('/api/events', 'POST', { title: 'Reopen night', type: 'Wargames', start: inMinutes(5), pinWindowMinutes: 10, pinEnabled: true }, 'A')).body;
  const dee = (await state('A')).members.find((m) => m.name === 'Dee');   // D's one character, already created in an earlier test
  assert.equal((await call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'reopen' }, 'A')).status, 409, 'nothing to reopen before a PIN exists');
  const created = (await call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'new' }, 'A')).body;
  for (let i = 0; i < 5; i++) await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: dee.id, pin: '9999' }, 'D');   // burn through the 5 tries
  assert.equal((await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: dee.id, pin: created.pin.code }, 'D')).status, 429, 'locked out after 5 wrong tries');

  assert.equal((await call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'reopen' }, 'D')).status, 403, 'officers only');
  fake.state.dms.length = 0;
  const reopened = (await call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'reopen' }, 'A')).body;
  assert.equal(reopened.pin.code, created.pin.code, 'same code, not a new one');
  assert.notEqual(reopened.pin.at, created.pin.at, 'the window restarted from now');
  assert.equal(fake.state.dms.length, 0, 'reopening is quiet - it does not relay a new code by DM');
  assert.equal((await call(`/api/events/${ev.id}/pin`, 'POST', { memberId: dee.id, pin: created.pin.code }, 'D')).status, 200, 'the old lock is gone and the same code still works');
});

test('an event not using the PIN automatically counts its "Going" players as attended once it is over', async () => {
  await call('/api/settings', 'PUT', { pointsEnabled: true }, 'A');
  const st0 = await state('A');
  const lead = st0.members.find((m) => m.name === 'Lead'), cee = st0.members.find((m) => m.name === 'Cee');
  // Backdated well past the compliance "final after" delay (60 minutes by default) so the very next tick
  // (300ms, see SCHEDULER_INTERVAL_MS above) judges it as over, without the test actually waiting an hour.
  const ev = (await call('/api/events', 'POST', { title: 'No-PIN raid', type: 'Wargames', start: inMinutes(-65), pinEnabled: false }, 'A')).body;
  assert.equal(ev.pinEnabled, false);
  await call(`/api/events/${ev.id}/rsvp`, 'POST', { memberId: lead.id, status: 'yes' }, 'A');
  await call(`/api/events/${ev.id}/rsvp`, 'POST', { memberId: cee.id, status: 'no' }, 'A');
  const after = await waitFor(async () => { const e = (await state('A')).events.find((x) => x.id === ev.id); return e.attended.length ? e : null; });
  assert.ok(after.attended.includes(lead.id), 'said Going, so counted as attended with nobody having to tick a box');
  assert.ok(!after.attended.includes(cee.id), "said Can't, so not counted");
  assert.ok((await state('A')).points.some((p) => p.eventId === ev.id && p.memberId === lead.id), 'the automatic attendance pays out points same as a manual one would');

  // An officer correcting this by hand (lead actually left early and should not count, say) must stick - the
  // automatic fill-in only ever runs once and must never undo a deliberate human correction on a later tick.
  await call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [] }, 'A');
  await sleep(600);
  const corrected = (await state('A')).events.find((x) => x.id === ev.id);
  assert.deepEqual(corrected.attended, [], "the officer's correction is not overwritten by a later tick");
});

test('reminders go only to players who have not answered, at the editable times', async () => {
  const st0 = await state('A');
  const lead = st0.members.find((m) => m.name === 'Lead'), cee = st0.members.find((m) => m.name === 'Cee');
  assert.deepEqual((await call('/api/settings', 'PUT', { reminderMinutes: [120, 300, 300] }, 'A')).body.reminderMinutes, [300, 120]);
  assert.equal((await call('/api/settings', 'PUT', { reminderMinutes: [0] }, 'A')).status, 400);

  const in3h = (await call('/api/events', 'POST', { title: 'Reminder test 3h', type: 'Other', start: inMinutes(180) }, 'A')).body;
  const in1h = (await call('/api/events', 'POST', { title: 'Reminder test 1h', type: 'Other', start: inMinutes(60) }, 'A')).body;
  const off = (await call('/api/events', 'POST', { title: 'Reminder test off', type: 'Other', start: inMinutes(180), reminders: false }, 'A')).body;
  const closed = (await call('/api/events', 'POST', { title: 'Reminder test closed', type: 'Other', start: inMinutes(20) }, 'A')).body;
  await call(`/api/events/${in3h.id}/rsvp`, 'POST', { memberId: cee.id, status: 'yes' }, 'C');      // C has answered
  await call(`/api/events/${in1h.id}/rsvp`, 'POST', { memberId: cee.id, status: 'no' }, 'C');

  const dmsFor = (title) => fake.state.dms.filter((d) => d.content.includes(title));
  await waitFor(() => dmsFor('Reminder test 3h').length >= 2 && dmsFor('Reminder test 1h').length >= 2);
  await sleep(1200);                                                                                  // several more ticks: no repeats
  const threeH = dmsFor('Reminder test 3h'), oneH = dmsFor('Reminder test 1h');
  assert.deepEqual(threeH.map((d) => d.to).sort(), [B, D].sort(), 'B and D have not answered; C has');
  assert.ok(threeH.every((d) => d.content.includes('Reminder 1/2')), 'the 5-hour reminder is the first of two');
  assert.deepEqual(oneH.map((d) => d.to).sort(), [B, D].sort());
  assert.ok(oneH.every((d) => d.content.includes('Reminder 2/2')) && oneH.length === 2, 'both were overdue: only the newest is sent, once');
  assert.equal(dmsFor('Reminder test off').length, 0, 'reminders can be switched off per event');
  assert.equal(dmsFor('Reminder test closed').length, 0, 'no reminders once sign-ups are closed');
  const log = (await state('A')).events.find((e) => e.id === in3h.id).reminderLog;
  assert.equal(log.length, 1); assert.equal(log[0].number, 1);
  assert.equal((await state('B')).events.find((e) => e.id === in3h.id).reminderLog, undefined);

  // the reminder also carries two one-tap buttons, each a direct link (no interaction sent to the bot at all -
  // see linkButtons() in discord.js) to a signed /rsvp/ page that needs no login
  const dmB = threeH.find((d) => d.to === B);
  assert.equal(dmB.components.length, 1, 'one action row');
  const [goBtn, noBtn] = dmB.components[0].components;
  assert.equal(goBtn.style, 5, 'a LINK-style button, not one that would need an interactions endpoint');
  assert.match(goBtn.label, /Can come/); assert.match(noBtn.label, /Can't come/);
  assert.match(goBtn.url, /\/rsvp\//); assert.match(noBtn.url, /\/rsvp\//);

  const r1 = await fetch(goBtn.url);
  assert.equal(r1.status, 200);
  const html1 = await r1.text();
  assert.match(html1, /marked as Going/);
  assert.equal((await state('A')).events.find((e) => e.id === in3h.id).rsvps[lead.id], 'yes', 'actually recorded, no login involved at all');

  const badToken = await fetch(goBtn.url.slice(0, -3) + 'xyz');
  assert.equal((await badToken.text()).includes('expired'), true, 'a tampered token is rejected, not silently accepted');

  const closedBtn = (await fetch(`${base}/rsvp/doesnotexist`));
  assert.match(await closedBtn.text(), /expired/);

  // moving the event restarts its reminders; switching them off globally stops everything
  assert.equal((await call('/api/settings', 'PUT', { remindersEnabled: false }, 'A')).status, 200);
  const later = (await call('/api/events', 'POST', { title: 'Reminder test disabled', type: 'Other', start: inMinutes(180) }, 'A')).body;
  await sleep(1000);
  assert.equal(dmsFor('Reminder test disabled').length, 0);
  await call('/api/settings', 'PUT', { remindersEnabled: true }, 'A');
});

test('an officer can send a reminder by hand, any time, regardless of the automatic schedule', async () => {
  const cee = (await state('A')).members.find((m) => m.name === 'Cee');
  assert.equal((await call('/api/settings', 'PUT', { remindersEnabled: false }, 'A')).status, 200);   // automatic reminders fully off
  const ev = (await call('/api/events', 'POST', { title: 'Manual reminder test', type: 'Other', start: inMinutes(180), reminders: false }, 'A')).body;   // also off for this one event
  await call(`/api/events/${ev.id}/rsvp`, 'POST', { memberId: cee.id, status: 'yes' }, 'C');   // C has answered, B and D have not

  assert.equal((await call(`/api/events/${ev.id}/reminders/send`, 'POST', {}, 'B')).status, 403, 'only an officer can press the button');

  const dmsFor = (title) => fake.state.dms.filter((d) => d.content.includes(title));
  const sent = await call(`/api/events/${ev.id}/reminders/send`, 'POST', {}, 'A');
  assert.equal(sent.status, 200);
  const dms = dmsFor('Manual reminder test');
  assert.deepEqual(dms.map((d) => d.to).sort(), [B, D].sort(), 'only those who have not answered get one, same as the automatic reminders');
  assert.ok(dms.every((d) => d.content.includes('Reminder:')), 'not numbered like the automatic schedule - this one has no N/M of its own');

  const officerName = (await state('A')).user.name;
  const log = (await state('A')).events.find((e) => e.id === ev.id).reminderLog;
  assert.equal(log.length, 1);
  assert.equal(log[0].manual, true);
  assert.equal(log[0].by, officerName);
  assert.equal(log[0].sent, 2);

  // pressing it again sends another round - it is not a one-shot like the automatic schedule
  await call(`/api/events/${ev.id}/reminders/send`, 'POST', {}, 'A');
  assert.equal((await state('A')).events.find((e) => e.id === ev.id).reminderLog.length, 2);

  const past = (await call('/api/events', 'POST', { title: 'Manual reminder on a past event', type: 'Other', start: inMinutes(-5) }, 'A')).body;
  assert.equal((await call(`/api/events/${past.id}/reminders/send`, 'POST', {}, 'A')).status, 409, 'cannot nudge people about an event that has already started');

  await call('/api/settings', 'PUT', { remindersEnabled: true }, 'A');
});

test('sign-up, PIN and reminder settings are validated', async () => {
  const set = (b) => call('/api/settings', 'PUT', b, 'A');
  assert.equal((await set({ signupCloseDefault: 45 })).body.signupCloseDefault, 45);
  assert.equal((await set({ signupCloseDefault: -1 })).status, 400);
  assert.equal((await set({ pinWindowDefault: 0 })).status, 400);
  assert.equal((await set({ pinWindowDefault: 20 })).body.pinWindowDefault, 20);
  assert.equal((await set({ pinOffsetMinutes: 5000 })).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { pinOffsetMinutes: 0 }, 'B')).status, 403);
  await set({ signupCloseDefault: 30, pinWindowDefault: 15, pinOffsetMinutes: 0 });
});


// ---------------------------------------------------------------- applications for people who are not in the guild
const OUTSIDER_NO_ROLE = '100000000000000007';
const tinyPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 3)]).toString('base64');

test('outsiders: turned away by default; with applications switched on they sign in and see only the application', async () => {
  const dm = fake.state.dms.length;
  assert.equal((await discordLogin(OUTSIDER, null)).cookie, null, 'applications are off: the old rule still holds');
  assert.equal((await call('/api/admin/discord', 'PUT', { applications: { enabled: true, intro: 'Welcome, tell us about you.', inviteUrl: 'https://discord.gg/example' } }, 'A')).status, 200);
  assert.equal((await call('/api/config')).body.applicationsOpen, true);
  const login = await discordLogin(OUTSIDER, null);
  assert.ok(login.cookie, 'now the outsider gets a session');
  sessions.X = login.cookie;
  const st = await state('X');
  assert.equal(st.user.role, 'applicant');
  assert.deepEqual([st.members.length, st.events.length, st.loot.length, st.users.length], [0, 0, 0, 0], 'an applicant sees nothing of the guild');
  assert.equal(st.settings.applications.intro, 'Welcome, tell us about you.');
  assert.equal(st.application, null);
  assert.ok(!(await state('B')).users.some((u) => u.id === OUTSIDER), 'applicants do not show up in the player list');
  // every other route is closed
  for (const [m, p] of [['GET', '/api/export'], ['POST', '/api/members'], ['GET', '/api/admin/discord-check'], ['POST', '/api/loot'], ['PUT', '/api/prefs'], ['POST', '/api/requests'], ['POST', '/api/leaves']]) {
    assert.equal((await call(p, m, m === 'GET' ? undefined : {}, 'X')).status, 403, `${m} ${p} is closed to applicants`);
  }
  assert.equal((await call('/api/config')).status, 200);
  void dm;
});

test('an application: needs a character and a few words, one at a time; the leadership accepts and the applicant is a member at once', async () => {
  const send = (b, who = 'X') => call('/api/applications', 'POST', b, who);
  assert.equal((await send({ characterName: 'N', about: 'short' })).status, 400);
  assert.equal((await send({ characterName: 'Newbie', role: 'Healer', about: 'ok' })).status, 400, 'a few words about yourself are needed');
  assert.equal((await send({ characterName: 'Newbie', role: 'Healer', about: 'Two years of healing in other MMOs.', questlog: 'javascript:alert(1)' })).status, 400);
  const a = (await send({ characterName: 'Newbie', role: 'Healer', primaryWeapon: 'Wand & Tome', secondaryWeapon: 'Orb', gearScore: 2100, level: 50, about: 'Two years of healing in other MMOs.', questlog: 'https://questlog.gg/newbie' })).body;
  assert.equal(a.status, 'pending'); assert.equal(a.character.role, 'Healer'); assert.equal(a.character.questlogs[0].url, 'https://questlog.gg/newbie');
  assert.equal((await send({ characterName: 'Again', role: 'DPS', about: 'A second application at once' })).status, 409);
  assert.equal((await state('X')).application.id, a.id);
  assert.equal((await call('/api/applications', 'POST', { characterName: 'Member', role: 'DPS', about: 'I am already in the guild' }, 'B')).status, 409, 'members do not apply');
  assert.equal((await state('B')).applications.length, 0, 'members do not see applications');
  assert.equal((await state('A')).applications.length, 1);
  assert.equal((await call('/api/applications/' + a.id, 'PUT', { decision: 'accept' }, 'B')).status, 403);
  assert.equal((await call('/api/applications/' + a.id, 'PUT', { decision: 'maybe' }, 'A')).status, 400);
  fake.state.roleAdds.length = 0;
  const done = (await call('/api/applications/' + a.id, 'PUT', { decision: 'accept', note: 'Welcome!' }, 'A')).body;
  assert.equal(done.status, 'accepted');
  // the same session is a member now, no new sign-in needed
  const now = await state('X');
  assert.equal(now.user.role, 'member');
  const mine = now.members.filter((m) => m.owner === OUTSIDER);
  assert.deepEqual(mine.map((m) => [m.name, m.role, m.rank, m.primaryWeapon, m.active]), [['Newbie', 'Healer', 'Member', 'Wand & Tome', true]], 'the character is on the roster');
  assert.equal((await call('/api/applications/' + a.id, 'PUT', { decision: 'reject' }, 'A')).status, 409);
  assert.ok((await state('B')).users.some((u) => u.id === OUTSIDER), 'and they are a player now');
  assert.equal(fake.state.roleAdds.length, 0, 'no member role is configured, so no role is given');
});

test('kicking a player: their character is deactivated (not deleted), they cannot sign in normally again, and officer/coach status from before cannot override that', async () => {
  // B is an existing member with a character; also add them to the officer list by specific player, to prove
  // a kick cannot be undone by some other access they still technically have on paper
  await call('/api/admin/officers', 'PUT', { userIds: [B] }, 'A');
  const beforeKick = await state('B');
  const charId = beforeKick.members.find((m) => m.owner === B).id;

  assert.equal((await call('/api/admin/kick', 'POST', { ownerKey: B, reason: 'Inactive for months' }, 'B')).status, 403, 'members cannot kick');
  assert.equal((await call('/api/admin/kick', 'POST', { ownerKey: A, reason: 'oops' }, 'A')).status, 400, 'cannot kick yourself');
  assert.equal((await call('/api/admin/kick', 'POST', { ownerKey: '999999999999999999' }, 'A')).status, 404, 'has to be a real, signed-in player');

  const r = await call('/api/admin/kick', 'POST', { ownerKey: B, reason: 'Inactive for months' }, 'A');
  assert.equal(r.status, 200);

  const afterKick = await state('A');
  const char = afterKick.members.find((m) => m.id === charId);
  assert.equal(char.active, false, 'deactivated, not deleted');
  const auditLog = (await call('/api/admin/audit', 'GET', null, 'A')).body;
  assert.ok(auditLog.entries.some((e) => e.action === 'player.kick'));

  // signing in again - even though they are STILL on the officer-by-specific-player list - lands them as an
  // applicant, not an officer and not a member
  const relogin = await discordLogin(B, [OFFICER_ROLE]);
  sessions.B = relogin.cookie;
  const st = await state('B');
  assert.equal(st.user.role, 'applicant');
  assert.ok(!st.isCoach, 'not a coach either - an applicant has no coach status to report at all');

  // they can apply again like anyone new
  const app = (await call('/api/applications', 'POST', { characterName: 'SecondChance', role: 'DPS', about: 'Sorry about before, I would like to come back.' }, 'B')).body;
  assert.equal(app.status, 'pending');

  await call('/api/applications/' + app.id, 'PUT', { decision: 'accept', note: 'Welcome back' }, 'A');
  // the same session is in again immediately, same as any other acceptance - no longer an applicant
  assert.notEqual((await state('B')).user.role, 'applicant');

  // and it sticks on a brand new sign-in too, with the kick flag genuinely cleared, not just the live session -
  // back to 'officer' specifically because they were never actually removed from that list, only overridden
  // while the kick itself was in effect; that override is gone now that they have been accepted again
  const again = await discordLogin(B, [OFFICER_ROLE]);
  sessions.B2 = again.cookie;
  assert.equal((await state('B2')).user.role, 'officer');
});

test('guest class coaches: someone outside the guild joins via the invite link, even with applications closed, picks a class, and gets real coaching access for it - officers can reassign or remove them, a plain sign-in link does not let a stranger in the same way', async () => {
  const GUEST = '100000000000000050';
  // an earlier test in this file leaves applications open - close them explicitly, since the whole point of
  // this test is proving the guest-coach link works even when they are not
  await call('/api/admin/discord', 'PUT', { applications: { enabled: false } }, 'A');

  // without the special link, applications being closed still blocks a total stranger, same as ever
  assert.equal((await discordLogin(GUEST, null)).cookie, null, 'a plain sign-in is still blocked while applications are closed');

  // with the link, the same person gets through as an applicant, not rejected
  const first = await discordLogin(GUEST, null, { authQuery: '?guestcoach=1' });
  assert.ok(first.cookie, 'the guest-coach link lets them through even with applications closed');
  sessions.guest = first.cookie;
  assert.equal((await state('guest')).user.role, 'applicant');
  assert.equal((await state('guest')).isCoach, false, 'not a coach yet - only after they actually join and pick a class');

  // B already has a character from an earlier test in this file - switch it to Oracle so myStudents has
  // something real to show once the guest coach joins, rather than trying to add a second character for B
  // (one character per player is enforced, so that would just be rejected)
  // an officer edits directly, so this applies immediately rather than going into the approval queue a
  // player's own weapon change would need (a separate concern from what this test covers)
  const bChar = (await state('B')).members.find((m) => m.owner === B);
  await call(`/api/members/${bChar.id}`, 'PUT', { name: 'OracleStudent', role: 'Healer', primaryWeapon: 'Orb', secondaryWeapon: 'Wand & Tome' }, 'A');

  assert.equal((await call('/api/guest-coaches/join', 'POST', { class: 'Not a real class' }, 'guest')).status, 400);
  assert.equal((await call('/api/guest-coaches/join', 'POST', { class: 'Oracle' }, 'A')).status, 400, 'only someone not already a member can join this way');
  const joined = await call('/api/guest-coaches/join', 'POST', { class: 'Oracle' }, 'guest');
  assert.equal(joined.status, 200);
  assert.equal(joined.body.class, 'Oracle');

  const guestState = await state('guest');
  assert.equal(guestState.isCoach, true);
  assert.ok(guestState.myStudents.includes(B), 'sees the real Oracle player as a student, the same mechanism a real coach uses');

  // an officer can see them listed, with their class
  const officerState = await state('A');
  const listed = officerState.guestCoaches.find((g) => g.discordId === GUEST);
  assert.ok(listed);
  assert.equal(listed.class, 'Oracle');
  assert.deepEqual((await state('guest')).guestCoaches, [], 'the list itself is officer-only, like coachLinks');

  // signing in again later, with no special link at all, still gets them through and still a coach - the
  // bypass is not only a one-time thing tied to the link itself
  const again = await discordLogin(GUEST, null);
  assert.ok(again.cookie, 'a returning guest coach signs in normally afterwards, no link needed a second time');
  sessions.guest2 = again.cookie;
  assert.equal((await state('guest2')).isCoach, true);

  // only an officer can reassign or remove them
  assert.equal((await call(`/api/guest-coaches/${GUEST}/class`, 'PUT', { class: 'Crusader' }, 'guest')).status, 403);
  assert.equal((await call(`/api/guest-coaches/${GUEST}/class`, 'PUT', { class: 'Crusader' }, 'A')).status, 200);
  assert.equal((await state('A')).guestCoaches.find((g) => g.discordId === GUEST).class, 'Crusader');
  assert.ok(!(await state('guest')).myStudents.includes(B), 'moved off Oracle, so the Oracle player is no longer their student');

  assert.equal((await call(`/api/guest-coaches/${GUEST}`, 'DELETE', null, 'guest')).status, 403);
  assert.equal((await call(`/api/guest-coaches/${GUEST}`, 'DELETE', null, 'A')).status, 200);
  assert.equal((await state('A')).guestCoaches.length, 0);
  assert.equal((await state('guest')).isCoach, false, 'removed - no more coaching access at all');

  // restore applications to how this file's later tests expect to find them (left open by an earlier test)
  await call('/api/admin/discord', 'PUT', { applications: { enabled: true } }, 'A');
});

test('a rejected applicant may apply again; a withdrawn application is gone; accepted people can sign in later without being in the server', async () => {
  const lone = '100000000000000011';
  const login = await discordLogin(lone, null); sessions.Y = login.cookie;
  const first = (await call('/api/applications', 'POST', { characterName: 'First', role: 'DPS', about: 'Please let me in, I play daily.' }, 'Y')).body;
  await call('/api/applications/' + first.id, 'PUT', { decision: 'reject', note: 'Not enough gear yet' }, 'A');
  assert.deepEqual([(await state('Y')).application.status, (await state('Y')).application.note], ['rejected', 'Not enough gear yet']);
  const second = (await call('/api/applications', 'POST', { characterName: 'Second', role: 'DPS', about: 'Now with better gear, retrying.' }, 'Y')).body;
  assert.equal((await call('/api/applications/' + second.id, 'DELETE', null, 'B')).status, 404, 'only the applicant can withdraw');
  assert.equal((await call('/api/applications/' + second.id, 'DELETE', null, 'Y')).status, 200);
  assert.equal((await state('Y')).application.status, 'withdrawn');
  const third = (await call('/api/applications', 'POST', { characterName: 'Third', role: 'Tank', about: 'Third time lucky, honestly.' }, 'Y')).body;
  await call('/api/applications/' + third.id, 'PUT', { decision: 'accept' }, 'A');
  // switch applications off again: outsiders are turned away, but the accepted person still gets in
  await call('/api/admin/discord', 'PUT', { applications: { enabled: false } }, 'A');
  assert.equal((await discordLogin('100000000000000012', null)).cookie, null, 'a new outsider is turned away again');
  const back = await discordLogin(lone, null);
  assert.ok(back.cookie, 'somebody who was accepted is never turned away');
  sessions.Y2 = back.cookie;
  assert.equal((await state('Y2')).user.role, 'member');
  assert.equal((await call('/api/applications', 'POST', { characterName: 'Late', role: 'DPS', about: 'Applications are closed now' }, 'X')).status, 409, 'members cannot apply');
  await call('/api/admin/discord', 'PUT', { applications: { enabled: true } }, 'A');
});

// ---------------------------------------------------------------- the Discord tools and "Post to Discord"
test('the connection check tells the leadership what works, and the invite link has the right permissions', async () => {
  assert.equal((await call('/api/admin/discord-check', 'GET', null, 'B')).status, 403);
  const c = (await call('/api/admin/discord-check', 'GET', null, 'A')).body;
  assert.deepEqual([c.login, c.bot, c.botUser.name, c.guild.name], [true, true, 'GuildHallBot', 'Test Guild']);
  assert.deepEqual(c.channels.map((x) => x.name), ['general', 'parties'], 'only text channels, in the order of the server');
  assert.match(c.inviteUrl, /client_id=555&scope=bot&permissions=35840/);
  assert.match(c.inviteUrlWithRoles, /permissions=268471296/);
  fake.state.botInGuild = false;
  const bad = (await call('/api/admin/discord-check', 'GET', null, 'A')).body;
  assert.match(bad.guildError, /not in your Discord server/); assert.deepEqual(bad.channels, []);
  fake.state.botInGuild = true;
});

test('the leadership picks a channel, posts a test message, and posts the picture of the parties with a text', async () => {
  const ch = '800000000000000001';
  assert.equal((await call('/api/admin/discord', 'PUT', { partyPost: { channelId: 'nope' } }, 'A')).status, 400);
  assert.equal((await call('/api/admin/discord', 'PUT', { partyPost: { channelId: ch, channelName: 'parties', text: '📋 **{event}** parties\n{link}' } }, 'B')).status, 403);
  await call('/api/admin/discord', 'PUT', { partyPost: { channelId: ch, channelName: 'parties', text: '📋 **{event}** parties\n{link}' } }, 'A');
  fake.state.posts.length = 0;
  assert.deepEqual((await call('/api/admin/discord-test', 'POST', {}, 'A')).body, { ok: true, error: '' });
  assert.equal(fake.state.posts[0].channel, ch); assert.match(fake.state.posts[0].content, /can post in this channel/);
  assert.equal((await call('/api/admin/discord-test', 'POST', {}, 'B')).status, 403);
  const ev = (await call('/api/events', 'POST', { title: 'Castle siege: Stonegard', type: 'Castle Siege', start: inMinutes(600) }, 'A')).body;
  const post = (b, who = 'A') => call(`/api/events/${ev.id}/post-parties`, 'POST', b, who);
  assert.equal((await post({ image: tinyPng, text: 'x' }, 'B')).status, 403, 'only the leadership posts');
  assert.equal((await post({ image: Buffer.from('not a picture at all, just text '.repeat(20)).toString('base64'), text: 'x' })).status, 400, 'must be a PNG');
  assert.equal((await post({ image: '', text: 'x' })).status, 400);
  fake.state.posts.length = 0;
  const ok = await post({ image: 'data:image/png;base64,' + tinyPng, text: 'Parties are up!\n{link}' });
  assert.equal(ok.status, 200);
  const p = fake.state.posts[0];
  assert.equal(p.channel, ch);
  assert.match(p.content, /^Parties are up!\nhttp:\/\/localhost:\d+\/#\/events\/\d+$/, '{link} becomes the link to the event');
  assert.deepEqual([p.file.name, p.file.png, p.file.size > 300], ['parties-castle-siege-stonegard.png', true, true]);
  const seen = (await state('A')).events.find((e) => e.id === ev.id);
  assert.equal(seen.partyPosts.length, 1); assert.equal(seen.partyPosts[0].ok, true);
  assert.equal((await state('B')).events.find((e) => e.id === ev.id).partyPosts, undefined, 'players do not see the posting log');
  // another channel and a failure: the bot has no permission there
  const other = '800000000000000002';
  fake.state.denyChannels.add(other);
  const denied = await post({ image: tinyPng, text: 'x', channelId: other });
  assert.equal(denied.status, 502); assert.match(denied.body.error, /missing permission/i);
  assert.equal((await state('A')).events.find((e) => e.id === ev.id).partyPosts.at(-1).ok, false, 'the failure is written down');
  assert.equal((await post({ image: tinyPng, text: 'x', channelId: '800000000000000099' })).status, 502);
  fake.state.denyChannels.clear();
  await call('/api/admin/discord', 'PUT', { partyPost: { channelId: '' } }, 'A');
  assert.equal((await post({ image: tinyPng, text: 'x' })).status, 400, 'no channel chosen');
});

// ---------------------------------------------------------------- role mentions on party announcements
test('party announcements can @-mention chosen Discord roles, in the correct <@&id> format, with the rest of the text untouched', async () => {
  const ch = '800000000000000001', officerRole = '900000000000000001', memberRole = '900000000000000010', bogus = '900000000000099999';
  await call('/api/admin/discord', 'PUT', { partyPost: { channelId: ch } }, 'A');
  const ev = (await call('/api/events', 'POST', { title: 'Mentions test', type: 'Castle Siege', start: inMinutes(600) }, 'A')).body;
  const post = (b) => call(`/api/events/${ev.id}/post-parties`, 'POST', { image: tinyPng, text: 'Parties are up!', ...b }, 'A');

  // who may read/pick roles, and what the picker sees
  assert.equal((await call('/api/discord/roles', 'GET', null, 'B')).status, 403, 'members cannot read the role list');
  const roles = (await call('/api/discord/roles', 'GET', null, 'A')).body;
  assert.deepEqual(roles.roles.map((r) => r.name).sort(), ['GuildHallBot', 'Member', 'Officer'], '@everyone is filtered out, the bot is not');
  assert.deepEqual(roles.selected, [], 'nothing configured yet');

  // saving the setting: only officers, only real-looking role ids, capped
  assert.equal((await call('/api/admin/discord', 'PUT', { partyPost: { mentionRoleIds: [officerRole] } }, 'B')).status, 403);
  assert.equal((await call('/api/admin/discord', 'PUT', { partyPost: { mentionRoleIds: ['not-a-role'] } }, 'A')).status, 400);
  assert.equal((await call('/api/admin/discord', 'PUT', { partyPost: { mentionRoleIds: Array.from({ length: 11 }, (_, i) => String(9e17 + i)) } }, 'A')).status, 400, 'up to 10 roles');
  const saved = (await call('/api/admin/discord', 'PUT', { partyPost: { mentionRoleIds: [officerRole, memberRole, officerRole] } }, 'A')).body;
  assert.deepEqual(saved.partyPost.mentionRoleIds.sort(), [memberRole, officerRole].sort(), 'duplicates removed');

  // posting: the message is prefixed with the correct Discord mention syntax, and only those roles are whitelisted
  fake.state.posts.length = 0;
  await post({});
  const p = fake.state.posts[0];
  assert.match(p.content, /^<@&900000000000000001> <@&900000000000000010>\nParties are up!$/, 'mentions come first, in <@&id> form, then the text unchanged');
  assert.deepEqual(p.mentions.sort(), [memberRole, officerRole].sort(), 'Discord is told exactly which roles may actually ping, via allowed_mentions.roles');
  assert.equal(p.parseAll, false, 'free-typed text can never trigger an accidental @everyone/@here/user ping');

  // no roles configured: behaves exactly as before (no prefix at all) - existing guilds are unaffected
  await call('/api/admin/discord', 'PUT', { partyPost: { mentionRoleIds: [bogus] } }, 'A').then((r) => assert.equal(r.status, 200, 'a role id can be saved even if it does not exist on the server (deleted role, etc.)'));
  await call('/api/admin/discord', 'PUT', { partyPost: { mentionRoleIds: [] } }, 'A');
  fake.state.posts.length = 0;
  await post({});
  assert.equal(fake.state.posts[0].content, 'Parties are up!', 'with no roles configured, the message is exactly what it always was');
  assert.deepEqual(fake.state.posts[0].mentions, []);
});

// ---------------------------------------------------------------- deleting the previous party announcement
test('switching on "delete previous announcement" removes the last one when posting a new one, and copes if it is already gone', async () => {
  const ch = '800000000000000001';
  await call('/api/admin/discord', 'PUT', { partyPost: { channelId: ch, mentionRoleIds: [] } }, 'A');
  const ev1 = (await call('/api/events', 'POST', { title: 'Week 1', type: 'Castle Siege', start: inMinutes(600) }, 'A')).body;
  const ev2 = (await call('/api/events', 'POST', { title: 'Week 2', type: 'Castle Siege', start: inMinutes(700) }, 'A')).body;
  const post = (ev, b) => call(`/api/events/${ev.id}/post-parties`, 'POST', { image: tinyPng, text: 'x', ...b }, 'A');

  assert.equal((await call('/api/admin/discord', 'PUT', { partyPost: { deletePrevious: true } }, 'B')).status, 403);

  // off by default: two posts, both stay up, nothing deleted
  await call('/api/admin/discord', 'PUT', { partyPost: { deletePrevious: false } }, 'A');
  fake.state.posts.length = 0;
  await post(ev1, {}); await post(ev2, {});
  assert.equal(fake.state.posts.filter((p) => !p.deleted).length, 2, 'deletePrevious is off by default, so both messages remain');

  // on: posting a second time removes the first message this test itself created (whatever else exists from
  // earlier tests in this file is not this test's concern - only the outcome of its own two posts is asserted)
  await call('/api/admin/discord', 'PUT', { partyPost: { deletePrevious: true } }, 'A');
  fake.state.posts.length = 0;
  await post(ev1, {});
  const first = fake.state.posts[0];
  assert.equal(first.deleted, false, 'nothing has tried to remove it yet');
  await post(ev2, {});
  assert.equal(first.deleted, true, 'the outdated message from this test was deleted');
  const second = fake.state.posts[1];
  assert.equal(second.deleted, false, 'the new one stays up');
  const seenAfterSecond = (await state('A')).events.find((e) => e.id === ev2.id).partyPosts.at(-1);
  assert.deepEqual(seenAfterSecond.deletedPrevious, { ok: true, error: '' });
  assert.equal(seenAfterSecond.messageId, second.id);

  // only that one message was touched - nothing else in the channel gets deleted as a side effect
  assert.equal(fake.state.posts.filter((p) => p.deleted).length, 1);

  // someone already deleted the "previous" message by hand: the next post must not fail because of that
  await post(ev1, {});                                                   // becomes the new "last one"
  const third = fake.state.posts[2];
  third.deleted = true;                                                  // simulate a human deleting it in Discord directly
  const r4 = await post(ev2, {});
  assert.equal(r4.status, 200, 'posting still succeeds even though the message to delete was already gone');
  const seenAfterManualDelete = (await state('A')).events.find((e) => e.id === ev2.id).partyPosts.at(-1);
  assert.deepEqual(seenAfterManualDelete.deletedPrevious, { ok: true, error: '' }, 'an already-missing message counts as successfully cleaned up');

  await call('/api/admin/discord', 'PUT', { partyPost: { deletePrevious: false } }, 'A');
});

// ---------------------------------------------------------------- extra officers granted in Admin, not .env
test('a Discord role or a specific player can be granted officer status from Admin, on top of .env, taking effect on their next sign-in', async () => {
  const ADVISOR_ROLE = '900000000000000055', OTHER_PLAYER = '100000000000000061';
  sessions.plain = (await discordLogin(OTHER_PLAYER, [ADVISOR_ROLE])).cookie;
  assert.equal((await state('plain')).user.role, 'member', 'an unrecognised role is just a regular member so far');

  assert.equal((await call('/api/admin/officers', 'PUT', { roleIds: [ADVISOR_ROLE] }, 'plain')).status, 403, 'members cannot grant officer status themselves');
  await call('/api/admin/officers', 'PUT', { roleIds: [ADVISOR_ROLE] }, 'A');

  assert.equal((await state('plain')).user.role, 'member', 'their current 7-day session is unaffected until they sign in again');

  sessions.plain2 = (await discordLogin(OTHER_PLAYER, [ADVISOR_ROLE])).cookie;
  assert.equal((await state('plain2')).user.role, 'officer', 'the advisor role now grants officer, from the next sign-in onward');

  // a specific player, regardless of role
  const NO_ROLE_AT_ALL = '100000000000000062';
  sessions.norole = (await discordLogin(NO_ROLE_AT_ALL, [])).cookie;
  assert.equal((await state('norole')).user.role, 'member');
  await call('/api/admin/officers', 'PUT', { userIds: [NO_ROLE_AT_ALL] }, 'A');
  sessions.norole2 = (await discordLogin(NO_ROLE_AT_ALL, [])).cookie;
  assert.equal((await state('norole2')).user.role, 'officer', 'a specific player can be made an officer even with no special role at all');

  await call('/api/admin/officers', 'PUT', { roleIds: [], userIds: [] }, 'A');
});
