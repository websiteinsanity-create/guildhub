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
function stopServer() { proc && proc.kill(); fake && fake.close(); dir && fs.rmSync(dir, { recursive: true, force: true }); }

// Walks through the OAuth redirect exactly like a browser would and returns the session cookie.
async function discordLogin(id, roles = [], { state: forceState } = {}) {
  fake.state.guildMembers[id] = roles === null ? undefined : { roles };
  const start = await fetch(base + '/auth/discord', { redirect: 'manual' });
  const oauth = /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${forceState ?? oauth}`, { redirect: 'manual', headers: { Cookie: `gh_oauth=${oauth}` } });
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
  const ev = (await call('/api/events', 'POST', { title: 'PIN night', type: 'Wargames', start: inMinutes(5), pinWindowMinutes: 10 }, 'A')).body;
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

  // moving the event restarts its reminders; switching them off globally stops everything
  assert.equal((await call('/api/settings', 'PUT', { remindersEnabled: false }, 'A')).status, 200);
  const later = (await call('/api/events', 'POST', { title: 'Reminder test disabled', type: 'Other', start: inMinutes(180) }, 'A')).body;
  await sleep(1000);
  assert.equal(dmsFor('Reminder test disabled').length, 0);
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
  assert.deepEqual(mine.map((m) => [m.name, m.role, m.rank, m.primaryWeapon, m.active]), [['Newbie', 'Healer', 'Recruit', 'Wand & Tome', true]], 'the character is on the roster');
  assert.equal((await call('/api/applications/' + a.id, 'PUT', { decision: 'reject' }, 'A')).status, 409);
  assert.ok((await state('B')).users.some((u) => u.id === OUTSIDER), 'and they are a player now');
  assert.equal(fake.state.roleAdds.length, 0, 'no member role is configured, so no role is given');
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
