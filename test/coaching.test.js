// Class coaches: a role granted in Admin (by Discord role or specific player, same mechanism as extra
// officers), linked to the students they coach, who post or receive YouTube VODs reviewed live over Discord
// voice. This file covers everything the server actually owns: the role, the links, the VODs and their
// visibility rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

// DMs are sent fire-and-forget (notify() never awaits discord.sendDM()), so the HTTP response for whatever
// triggered one can come back before it actually lands in fake.state.dms - wait for it rather than assume it
// is already there the instant the request resolves.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(100); } }

const GUILD = '111111111111111111', OFFICER_ROLE = '900000000000000001';
const OFFICER = '100000000000000001', COACH = '100000000000000060', STUDENT = '100000000000000061', OTHER = '100000000000000062';

let fake, dir, proc, port, base;
const sessions = {};

async function startServer() {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-coach-'));
  port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, DISCORD_DM_DELAY_MS: '0',
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
async function discordLogin(id, roles) {
  fake.state.guildMembers[id] = { roles };
  const start = await fetch(base + '/auth/discord', { redirect: 'manual' });
  const oauth = /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${oauth}`, { redirect: 'manual', headers: { Cookie: `gh_oauth=${oauth}` } });
  const cookie = /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '');
  return cookie ? `gh_session=${cookie[1]}` : null;
}
const call = async (p, method = 'GET', body, who) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: sessions[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const state = async (who) => (await call('/api/state', 'GET', null, who)).body;

before(async () => {
  await startServer();
  sessions.officer = await discordLogin(OFFICER, [OFFICER_ROLE]);
  sessions.coach = await discordLogin(COACH, []);
  sessions.student = await discordLogin(STUDENT, []);
  sessions.other = await discordLogin(OTHER, []);
  await call('/api/members', 'POST', { name: 'StudentChar', role: 'DPS', primaryWeapon: 'Daggers', secondaryWeapon: 'Crossbow' }, 'student');   // Scorpion
  await call('/api/members', 'POST', { name: 'OtherChar', role: 'Healer', primaryWeapon: 'Orb', secondaryWeapon: 'Wand & Tome' }, 'other');       // Oracle
});
after(stopServer);

test('coach status is granted the same way extra officer status is, and does not grant officer permissions by itself', async () => {
  assert.equal((await call('/api/admin/coaches', 'PUT', { userIds: [COACH] }, 'student')).status, 403, 'only officers can grant coach status');
  assert.equal((await call('/api/admin/coaches', 'PUT', { userIds: [COACH] }, 'officer')).status, 200);
  // The coach was already signed in before the save, so this must work without re-login.
  const st = await state('coach');
  assert.equal(st.isCoach, true);
  assert.equal(st.user.role, 'member', 'being a coach does not make them an officer');
  assert.equal((await call('/api/admin/coaches', 'PUT', { userIds: [] }, 'coach')).status, 403, 'a coach cannot grant coach status to others');
});

test('an officer links a coach to a class; whoever currently plays that class shows up as a student in both directions; only officers manage links', async () => {
  assert.equal((await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'coach')).status, 403);
  const link = (await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer')).body;
  assert.ok(link.id);
  assert.equal((await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer')).status, 409, 'no duplicate links');
  assert.equal((await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Not a real class' }, 'officer')).status, 400);

  // StudentChar plays Scorpion (Daggers + Crossbow, set up in before()) - linking the class picks them up
  // automatically, with no student ever chosen by name
  const coachSt = await state('coach');
  assert.deepEqual(coachSt.myStudents, [STUDENT]);
  const studentSt = await state('student');
  assert.deepEqual(studentSt.myCoaches, [COACH]);
  // OtherChar plays Oracle, a different class, so they are not swept in by this link
  assert.deepEqual((await state('other')).myCoaches, []);

  assert.equal((await call(`/api/admin/coach-links/${link.id}`, 'DELETE', null, 'coach')).status, 403);
});

test('a VOD link is recognized in every common YouTube URL shape, not just youtube.com/watch - including a livestream replay link, which is what most VODs actually are', async () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],   // an extra query param alongside v= still works
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],        // a livestream replay - most VODs are actually this
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],       // mobile subdomain
    ['https://www.youtube.com/live/ dQw4w9WgXcQ', 'dQw4w9WgXcQ'],       // a stray space from how the link got pasted/shared
    ['  https://youtu.be/dQw4w9WgXcQ\n', 'dQw4w9WgXcQ'],                // leading/trailing whitespace from the same
    ['https://www.youtube.com/live/%dQw4w9WgXcQ', 'dQw4w9WgXcQ'],       // a stray "%" right before the id, same kind of paste glitch
    ['https://www.youtube.com/live/%20dQw4w9WgXcQ', 'dQw4w9WgXcQ'],     // a wrapped line copied back out as a literal "%20" instead of a space
  ];
  for (const [url, expectedId] of cases) {
    const r = await call('/api/vods', 'POST', { url, type: 'Testing', recordedDate: '2026-09-26' }, 'student');
    assert.equal(r.status, 200, `${url} should be accepted (${r.body && r.body.error})`);
    assert.equal(r.body.videoId, expectedId, `${url} should resolve to ${expectedId}`);
  }
  // still rejects things that are not a real YouTube video link
  const bad = ['https://vimeo.com/123456789', 'https://www.youtube.com/channel/UC123', 'not a url at all', 'https://youtu.be/tooshort'];
  for (const url of bad) {
    assert.equal((await call('/api/vods', 'POST', { url, type: 'Testing', recordedDate: '2026-09-26' }, 'student')).status, 400, `${url} should be rejected`);
  }
});

test('a VOD is private by default (owner + their coach + officers only); the owner, their coach, or an officer can all promote its visibility', async () => {
  await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer');   // re-link after the previous test's isolated server state
  const v = (await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'Siege', recordedDate: '2026-09-26' }, 'student')).body;
  assert.equal(v.visibility, 'private');
  assert.equal(v.videoId, 'dQw4w9WgXcQ');

  assert.ok((await state('student')).vods.some((x) => x.id === v.id), 'the owner sees their own VOD');
  assert.ok((await state('coach')).vods.some((x) => x.id === v.id), "their coach sees it too");
  assert.ok((await state('officer')).vods.some((x) => x.id === v.id), 'officers see everything');
  assert.ok(!(await state('other')).vods.some((x) => x.id === v.id), 'an unrelated player cannot see it');

  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'everyone' }, 'other')).status, 403, 'an unrelated player still cannot touch it');
  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'everyone' }, 'student')).status, 200, 'the owner can promote their own VOD');
  assert.ok((await state('other')).vods.some((x) => x.id === v.id), 'now visible to everyone');

  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'private' }, 'student')).status, 200);
  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'everyone' }, 'coach')).status, 200, 'a coach can promote it too');
  assert.ok((await state('other')).vods.some((x) => x.id === v.id));
});

test('the owner promoting their own VOD to "a class" has no class picker to misuse - it always lands on whatever class they currently play', async () => {
  const v = (await call('/api/vods', 'POST', { url: 'https://youtu.be/bcdefghijkl', type: 'Siege', recordedDate: '2026-09-26' }, 'student')).body;
  const studentVod = (await state('student')).vods.find((x) => x.id === v.id);
  assert.equal(studentVod.promoteOwnClassOnly, true, 'the owner is not a coach or officer, so only their own class makes sense');

  // no visibleClass sent at all - still resolves to Scorpion, the class StudentChar actually plays
  const r = await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'class' }, 'student');
  assert.equal(r.status, 200);
  assert.equal(r.body.visibleClass, 'Scorpion');
  assert.ok((await state('student')).vods.some((x) => x.id === v.id), 'still visible to the student themselves');
  assert.ok(!(await state('other')).vods.some((x) => x.id === v.id), 'other plays Oracle - not Scorpion - so still cannot see it');

  // a coach is not restricted the same way - they keep the full class picker, including a class the owner does not play
  const coachVod = (await state('coach')).vods.find((x) => x.id === v.id);
  assert.equal(coachVod.promoteOwnClassOnly, false, 'a coach is never restricted to "their own" class, since they do not own the VOD');
  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'class', visibleClass: 'Oracle' }, 'coach')).status, 200);
  assert.ok((await state('other')).vods.some((x) => x.id === v.id), 'Oracle was picked explicitly, so the Oracle player can see it now');
});

test('a VOD shared with "a class" is visible only to players currently playing that class', async () => {
  const posted = await call('/api/vods', 'POST', { owner: STUDENT, url: 'https://youtu.be/abcdefghijk', type: 'GvG Boss', recordedDate: '2026-07-21', enemyGuild: 'Rivals' }, 'coach');
  assert.equal(posted.status, 200, posted.body && posted.body.error);
  const v = posted.body;
  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'class', visibleClass: 'Scorpion' }, 'coach')).status, 200);
  assert.ok((await state('student')).vods.some((x) => x.id === v.id), 'student plays Scorpion (Daggers + Crossbow) - can see it');
  assert.ok(!(await state('other')).vods.some((x) => x.id === v.id), 'other plays Oracle - cannot see it');
});

test('the VOD name is always built from its type, date and (where it applies) the enemy guild - never typed by hand', async () => {
  const siege = (await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=ppppppppppp', type: 'Siege', recordedDate: '2026-09-26', enemyGuild: 'Should be ignored' }, 'student')).body;
  assert.equal(siege.title, 'Siege 26.09.2026', 'no "vs" part for a type with no single opponent, even if an enemy guild was sent anyway');
  assert.equal(siege.enemyGuild, '', 'and it is not even stored for this type');

  const wargame = (await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=qqqqqqqqqqq', type: 'Wargame', recordedDate: '2026-07-21', enemyGuild: 'Rivals' }, 'student')).body;
  assert.equal(wargame.title, 'Wargame vs Rivals 21.07.2026');

  const noEnemyGiven = (await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=rrrrrrrrrrr', type: 'GvG Boss', recordedDate: '2026-08-01' }, 'student')).body;
  assert.equal(noEnemyGiven.title, 'GvG Boss 01.08.2026', 'a type that allows an enemy guild still falls back to just type + date when none was given');

  assert.equal((await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=sssssssssss', type: 'Not a real type', recordedDate: '2026-08-01' }, 'student')).status, 400);
  assert.equal((await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=ttttttttttt', type: 'Siege', recordedDate: 'not-a-date' }, 'student')).status, 400);

  // editing the type/date re-builds the name
  const edited = (await call(`/api/vods/${noEnemyGiven.id}`, 'PUT', { enemyGuild: 'Nemesis' }, 'student')).body;
  assert.equal(edited.title, 'GvG Boss vs Nemesis 01.08.2026');
});

test('a non-YouTube link is refused, and only the owner, their coach or an officer can post a VOD for someone', async () => {
  assert.equal((await call('/api/vods', 'POST', { url: 'https://example.com/video', type: 'Siege', recordedDate: '2026-09-26' }, 'student')).status, 400);
  assert.equal((await call('/api/vods', 'POST', { owner: STUDENT, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', type: 'Siege', recordedDate: '2026-09-26' }, 'other')).status, 403);
  const ok = (await call('/api/vods', 'POST', { owner: STUDENT, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', type: 'Siege', recordedDate: '2026-09-26' }, 'coach')).body;
  assert.equal(ok.postedBy, COACH);
  assert.equal(ok.owner, STUDENT);
});

test('switching classes moves a player in and out of a coach\'s students automatically - nobody has to re-link anything by hand', async () => {
  await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Oracle' }, 'officer');
  // OtherChar plays Oracle from the start - already a student of the Oracle coach without any link naming them
  assert.ok((await state('coach')).myStudents.includes(OTHER));

  // they respec to Crusader - a class this coach is not linked to at all (unlike Scorpion, used by an earlier
  // test, which would make this ambiguous: still a student there, just via a different link) - so this is the
  // clean case of actually leaving this coach's roster, not just moving within it
  const otherMember = (await state('other')).members.find((m) => m.owner === OTHER);
  // an officer edits directly, so this applies immediately rather than going into the usual approval queue a
  // player's own weapon change would need - that approval step is a separate concern from what this test covers
  await call(`/api/members/${otherMember.id}`, 'PUT', { name: 'OtherChar', role: 'Tank', primaryWeapon: 'Greatsword', secondaryWeapon: 'Sword & Shield' }, 'officer');
  assert.ok(!(await state('coach')).myStudents.includes(OTHER), 'no longer this coach\'s student after switching to an unlinked class');
  assert.deepEqual((await state('other')).myCoaches, [], 'and they have no coach at all now, with no link to remove by hand');

  // switching back to Oracle picks them back up automatically too
  await call(`/api/members/${otherMember.id}`, 'PUT', { name: 'OtherChar', role: 'Healer', primaryWeapon: 'Orb', secondaryWeapon: 'Wand & Tome' }, 'officer');
  assert.ok((await state('coach')).myStudents.includes(OTHER));
});

test("a coach sees their linked student's full profile - questlog links, notes, loot and points - the same as the student sees their own, and an unrelated player still sees none of it", async () => {
  const studentId = (await state('student')).members.find((m) => m.owner === STUDENT).id;
  await call(`/api/members/${studentId}`, 'PUT', { name: 'StudentChar', role: 'DPS', questlogs: [{ label: 'Main', url: 'https://questlog.example/student' }] }, 'student');
  await call('/api/profile/' + STUDENT, 'PUT', { bio: 'Working on positioning' }, 'student');
  await call('/api/loot', 'POST', { memberId: studentId, item: 'Coaching Test Ring' }, 'officer');
  await call('/api/settings', 'PUT', { pointsEnabled: true }, 'officer');
  await call('/api/points', 'POST', { memberId: studentId, delta: 5, reason: 'test' }, 'officer');

  const coachSt = await state('coach');
  const studentAsCoachSees = coachSt.members.find((m) => m.owner === STUDENT);
  assert.ok(studentAsCoachSees.questlogs.length, "the coach sees the student's questlog link");
  assert.equal(coachSt.profiles[STUDENT] && coachSt.profiles[STUDENT].bio, 'Working on positioning');
  assert.ok(coachSt.loot.some((l) => l.memberId === studentId && l.item === 'Coaching Test Ring'));
  assert.ok(coachSt.points.some((p) => p.memberId === studentId && p.delta === 5));

  const otherSt = await state('other');
  const studentAsOtherSees = otherSt.members.find((m) => m.owner === STUDENT);
  assert.equal(studentAsOtherSees.questlogs.length, 0, 'an unrelated player still gets the stripped-down view');
  assert.equal(otherSt.profiles[STUDENT], undefined);
  assert.ok(!otherSt.loot.some((l) => l.memberId === studentId));
});


test('VOD coaching points save an exact timestamp, an optional persisted drawing, and a configurable before/after window - distinct from the live-only drawing overlay', async () => {
  const v = (await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', type: 'Siege', recordedDate: '2026-10-05' }, 'student')).body;
  const strokes = [{ color: '#e2685c', points: [[0.1, 0.2], [0.5, 0.4], [0.8, 0.3]] }];
  const created = await call(`/api/vods/${v.id}/markers`, 'POST', { timestamp: 763.25, beforeSeconds: 3, afterSeconds: 5, note: 'Wait for the engage.', strokes }, 'coach');
  assert.equal(created.status, 200);
  assert.equal(created.body.timestamp, 763.25);
  assert.equal(created.body.beforeSeconds, 3);
  assert.equal(created.body.afterSeconds, 5);
  assert.deepEqual(created.body.strokes, strokes);
  assert.equal(created.body.createdBy, COACH, 'who added it is recorded, not just the note itself');
  assert.equal(created.body.createdByName, COACH, "resolved to a display name where one exists - here there is no character or guest-coach record for this id, so it falls back to the raw id, same as a review's byName would");

  // a plain note with nothing drawn is just as valid - strokes are optional, only the note is required
  const plain = await call(`/api/vods/${v.id}/markers`, 'POST', { timestamp: 10, note: 'Just a reminder, nothing drawn.' }, 'coach');
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body.strokes, []);
  assert.equal((await call(`/api/vods/${v.id}/markers`, 'POST', { timestamp: 10 }, 'coach')).status, 400, 'a note is still required');

  const coachVod = (await state('coach')).vods.find((x) => x.id === v.id);
  assert.equal(coachVod.markers.length, 2);
  assert.equal(coachVod.markers[0].note, 'Just a reminder, nothing drawn.', 'sorted by timestamp');
  assert.deepEqual(coachVod.markers[1].strokes, strokes);
  assert.ok(coachVod.markers.every((m) => m.createdByName), 'every coaching point says who added it, to whoever is looking (not just the author)');

  assert.equal((await call(`/api/vods/${v.id}/markers/${created.body.id}`, 'PUT', { timestamp: 764, beforeSeconds: 2, afterSeconds: 2, note: 'Updated.', strokes }, 'student')).status, 200);
  const updated = (await state('student')).vods.find((x) => x.id === v.id).markers.find((m) => m.id === created.body.id);
  assert.equal(updated.timestamp, 764);
  assert.equal(updated.note, 'Updated.');

  assert.equal((await call(`/api/vods/${v.id}/markers/${created.body.id}`, 'DELETE', null, 'other')).status, 403);
  assert.equal((await call(`/api/vods/${v.id}/markers/${created.body.id}`, 'DELETE', null, 'coach')).status, 200);
  assert.equal((await state('student')).vods.find((x) => x.id === v.id).markers.length, 1);

  // deleting the VOD itself cleans up its markers too
  await call(`/api/vods/${v.id}`, 'DELETE', null, 'student');
  assert.equal((await call(`/api/vods/${v.id}/markers`, 'POST', { timestamp: 1, note: 'gone' }, 'coach')).status, 404);
});

test('a VOD can be marked as a spectator/overview recording, not tied to any one class - settable on posting or afterwards, independent of the other fields', async () => {
  const posted = await call('/api/vods', 'POST', { url: 'https://youtu.be/dQw4w9WgXcQ', type: 'Siege', recordedDate: '2026-09-26', spectator: true }, 'student');
  assert.equal(posted.status, 200);
  assert.equal(posted.body.spectator, true);

  // defaults to false when not mentioned at all
  const normal = await call('/api/vods', 'POST', { url: 'https://youtu.be/abcdefghijk', type: 'Siege', recordedDate: '2026-09-26' }, 'student');
  assert.equal(normal.body.spectator, false);

  // can be toggled on its own afterwards, without touching type/date/enemyGuild
  const toggled = await call(`/api/vods/${normal.body.id}`, 'PUT', { spectator: true }, 'student');
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.spectator, true);
  assert.equal(toggled.body.type, 'Siege', 'other fields are untouched by a spectator-only update');

  // and back off again
  assert.equal((await call(`/api/vods/${normal.body.id}`, 'PUT', { spectator: false }, 'student')).body.spectator, false);
});

test('posting a VOD DMs whoever coaches the player\'s current class - not the poster themselves, and not at all for a spectator recording', async () => {
  // re-establish this explicitly rather than relying on whatever an earlier test in this file left behind -
  // StudentChar plays Scorpion (set up in before())
  await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer').catch(() => {});
  fake.state.dms.length = 0;

  // the student posts their own VOD - their coach gets a DM about it
  const posted = await call('/api/vods', 'POST', { url: 'https://youtu.be/mmmmmmmmmmm', type: 'Siege', recordedDate: '2026-09-26' }, 'student');
  const coachDms = await waitFor(() => { const l = fake.state.dms.filter((d) => d.to === COACH); return l.length && l; });
  assert.equal(coachDms.length, 1);
  assert.ok(coachDms[0].content.includes(posted.body.title), 'mentions the VOD title');
  assert.ok(coachDms[0].content.includes(`/vods/${posted.body.id}`), 'links straight to it');

  // the coach posting for the same student does not DM themselves
  fake.state.dms.length = 0;
  await call('/api/vods', 'POST', { owner: STUDENT, url: 'https://youtu.be/nnnnnnnnnnn', type: 'Siege', recordedDate: '2026-09-27' }, 'coach');
  await sleep(300);   // give a wrongly-sent DM time to arrive before checking it did not
  assert.equal(fake.state.dms.filter((d) => d.to === COACH).length, 0, 'the coach does not get a DM for their own post');

  // a spectator recording is not really "for" any class, so it notifies nobody
  fake.state.dms.length = 0;
  await call('/api/vods', 'POST', { url: 'https://youtu.be/ooooooooooo', type: 'Siege', recordedDate: '2026-09-28', spectator: true }, 'student');
  await sleep(300);
  assert.equal(fake.state.dms.length, 0);
});

test('a guest coach is never DMed about a new VOD, even for the class they coach - they can still see it, just not get pinged about every upload', async () => {
  await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer').catch(() => {});

  // a true outsider signs in via the guest-coach link (not added to guildMembers at all, same as a real
  // stranger - see the dedicated discord.test.js coverage for why that distinction matters) and joins as a
  // guest coach for the same class StudentChar plays
  const GUEST = '100000000000000070';
  const start = await fetch(base + '/auth/discord?guestcoach=1', { redirect: 'manual' });
  const setCookies = (start.headers.raw ? start.headers.raw()['set-cookie'] : start.headers.get('set-cookie').split(/,(?=\s*\w+=)/)) || [];
  const startCookies = Object.fromEntries(setCookies.map((c) => c.split(';')[0].split('=').map((s) => s.trim())));
  const cb = await fetch(`${base}/auth/discord/callback?code=${GUEST}&state=${startCookies.gh_oauth}`, { redirect: 'manual', headers: { Cookie: Object.entries(startCookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
  const guestCookie = `gh_session=${/gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '')[1]}`;
  sessions.guest = guestCookie;
  assert.equal((await call('/api/guest-coaches/join', 'POST', { class: 'Scorpion' }, 'guest')).status, 200);

  fake.state.dms.length = 0;
  const posted = await call('/api/vods', 'POST', { url: 'https://youtu.be/ppppppppppp', type: 'Siege', recordedDate: '2026-09-29' }, 'student');
  // the real (non-guest) coach still gets notified - confirms this run actually exercised the notify path at
  // all, rather than the guest simply never being reachable in the first place
  await waitFor(() => fake.state.dms.some((d) => d.to === COACH));
  assert.equal(fake.state.dms.filter((d) => d.to === GUEST).length, 0, 'the guest coach gets no DM');

  // but they can still see the VOD itself - the exclusion is notification-only, not visibility
  const guestVod = (await state('guest')).vods.find((v) => v.id === posted.body.id);
  assert.ok(guestVod, 'visibility is untouched - they can still see it');
  // the guest coach has no member/user list of their own to resolve a name or a class from (see
  // server-coaching.js's coachingState) - each VOD must carry its own owner's name and class directly, or the
  // VOD library page has nothing to show for its folders at all
  assert.equal(guestVod.ownerName, 'StudentChar');
  assert.equal(guestVod.ownerClass, 'Scorpion');

  // StudentChar's own VOD, shared with "everyone" by the real coach earlier in this file, still has nothing to
  // do with the class this guest coach was actually brought in for - an outsider should never see footage of
  // any other class, no matter how broadly its owner or a real coach chose to share it
  const everyoneVod = (await call('/api/vods', 'POST', { url: 'https://youtu.be/qqqqqqqqqqq', type: 'Siege', recordedDate: '2026-09-30' }, 'other')).body;   // OtherChar plays Oracle
  await call(`/api/vods/${everyoneVod.id}`, 'PUT', { visibility: 'everyone' }, 'other');
  assert.ok((await state('student')).vods.some((v) => v.id === everyoneVod.id), 'a regular member does see it - "everyone" means everyone for them');
  assert.ok(!(await state('guest')).vods.some((v) => v.id === everyoneVod.id), 'but the guest coach, outside the guild entirely, still does not');

  await call(`/api/guest-coaches/${GUEST}`, 'DELETE', null, 'officer');   // tidy up
});

test('a member can promote their own VOD straight to "everyone" or to their own class - not just leave it private', async () => {
  const v = (await call('/api/vods', 'POST', { url: 'https://youtu.be/rstuvwxyzab', type: 'Siege', recordedDate: '2026-10-01' }, 'other')).body;   // OtherChar plays Oracle
  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'everyone' }, 'other')).status, 200);
  assert.ok((await state('student')).vods.some((x) => x.id === v.id), 'an unrelated player now sees it, by the owner\'s own choice');

  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'class' }, 'other')).status, 200);
  assert.ok((await state('other')).vods.some((x) => x.id === v.id));
  assert.ok(!(await state('student')).vods.some((x) => x.id === v.id), 'student plays Scorpion, not Oracle - no longer visible to them');
});

test('only a coach or officer can finish a review, never the VOD\'s own owner, and never on a spectator recording', async () => {
  await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer').catch(() => {});
  const v = (await call('/api/vods', 'POST', { url: 'https://youtu.be/revcheck001', type: 'Siege', recordedDate: '2026-10-02' }, 'student')).body;
  assert.equal((await call(`/api/vods/${v.id}/reviews`, 'POST', { note: 'nice work' }, 'student')).status, 403, 'the owner cannot finish their own review');
  assert.equal((await call(`/api/vods/${v.id}/reviews`, 'POST', { note: 'nice work' }, 'other')).status, 403, 'an unrelated player cannot either');
  assert.equal((await call(`/api/vods/${v.id}/reviews`, 'POST', { note: '' }, 'coach')).status, 400, 'a note is required');

  const spectatorVod = (await call('/api/vods', 'POST', { url: 'https://youtu.be/revcheck002', type: 'Siege', recordedDate: '2026-10-02', spectator: true }, 'student')).body;
  assert.equal((await call(`/api/vods/${spectatorVod.id}/reviews`, 'POST', { note: 'nope' }, 'coach')).status, 403, "a spectator recording is not any one player's review to finish");
  assert.equal((await state('coach')).vods.find((x) => x.id === spectatorVod.id).canReview, false);
});

test('finishing a review DMs the player, mentions any coaching points, and a second reviewer adds to an already-finished review instead of overwriting it', async () => {
  const v = (await call('/api/vods', 'POST', { url: 'https://youtu.be/revcheck010', type: 'Siege', recordedDate: '2026-10-03' }, 'student')).body;
  await call(`/api/vods/${v.id}/markers`, 'POST', { timestamp: 5, note: 'watch your dash' }, 'coach');

  fake.state.dms.length = 0;
  const r1 = await call(`/api/vods/${v.id}/reviews`, 'POST', { note: 'Solid rotation, work on positioning.' }, 'coach');
  assert.equal(r1.status, 200);
  const dm1 = await waitFor(() => fake.state.dms.find((d) => d.to === STUDENT));
  assert.ok(dm1.content.includes('reviewed'));
  assert.ok(dm1.content.includes('1 coaching point'));
  assert.ok(dm1.content.includes('Solid rotation'));

  let vod = (await state('student')).vods.find((x) => x.id === v.id);
  assert.equal(vod.reviews.length, 1);
  assert.equal(vod.finished, false, 'writing a review note does not by itself mark the VOD as finished any more');

  // a second reviewer (here, an officer - who can review anything) adds to the already-finished review; an
  // "add-on", not a replacement, and the earlier entry is untouched
  fake.state.dms.length = 0;
  const r2 = await call(`/api/vods/${v.id}/reviews`, 'POST', { note: 'Agreed, also watch your cooldown usage.' }, 'officer');
  assert.equal(r2.status, 200);
  const dm2 = await waitFor(() => fake.state.dms.find((d) => d.to === STUDENT));
  assert.ok(dm2.content.includes('added more to the review'));

  vod = (await state('student')).vods.find((x) => x.id === v.id);
  assert.equal(vod.reviews.length, 2, 'both entries are kept, nothing is overwritten');
  assert.equal(vod.reviews[0].note, 'Solid rotation, work on positioning.');

  // a new coaching point added afterwards does not touch the review notes at all
  await call(`/api/vods/${v.id}/markers`, 'POST', { timestamp: 20, note: 'another spot' }, 'coach');
  assert.equal((await state('student')).vods.find((x) => x.id === v.id).reviews.length, 2);
});

test('marking a VOD as finished is its own explicit, undoable choice - separate from writing a review note', async () => {
  const v = (await call('/api/vods', 'POST', { url: 'https://youtu.be/revcheck015', type: 'Siege', recordedDate: '2026-10-03' }, 'student')).body;
  assert.equal(v.finished, false, 'a freshly posted VOD starts out not finished');

  // writing a review note is not the same thing as finishing - it must not flip this on by itself
  await call(`/api/vods/${v.id}/reviews`, 'POST', { note: 'Looks good overall.' }, 'coach');
  assert.equal((await state('coach')).vods.find((x) => x.id === v.id).finished, false);

  assert.equal((await call(`/api/vods/${v.id}/finished`, 'PUT', { finished: true }, 'student')).status, 403, 'only a coach or officer can mark it finished');

  const marked = (await call(`/api/vods/${v.id}/finished`, 'PUT', { finished: true }, 'coach')).body;
  assert.equal(marked.finished, true);
  assert.equal((await state('coach')).vods.find((x) => x.id === v.id).finished, true, 'the folder now shows it as finished');

  // undoing it (a mistaken click) is just as explicit and just as available
  const unmarked = (await call(`/api/vods/${v.id}/finished`, 'PUT', { finished: false }, 'coach')).body;
  assert.equal(unmarked.finished, false);
  assert.equal((await state('coach')).vods.find((x) => x.id === v.id).finished, false, 'unmarking takes it back out of the folder\'s finished state');
});

test('only the coach or officer who wrote a particular review entry can edit or resend it - not even another officer, and not the VOD\'s own owner', async () => {
  const v = (await call('/api/vods', 'POST', { url: 'https://youtu.be/revcheck020', type: 'Siege', recordedDate: '2026-10-04' }, 'student')).body;
  const created = (await call(`/api/vods/${v.id}/reviews`, 'POST', { note: 'First pass.' }, 'coach')).body;

  assert.equal((await state('coach')).vods.find((x) => x.id === v.id).reviews[0].canEdit, true);
  assert.equal((await state('officer')).vods.find((x) => x.id === v.id).reviews[0].canEdit, false, 'not even an officer sees edit controls on another coach\'s entry');

  assert.equal((await call(`/api/vods/${v.id}/reviews/${created.id}`, 'PUT', { note: 'edited' }, 'officer')).status, 403, 'not even an officer may edit another coach\'s entry');
  assert.equal((await call(`/api/vods/${v.id}/reviews/${created.id}`, 'PUT', { note: 'edited' }, 'student')).status, 403, "nor the VOD's own owner");
  assert.equal((await call(`/api/vods/${v.id}/reviews/${created.id}/resend`, 'POST', null, 'officer')).status, 403);

  const edited = await call(`/api/vods/${v.id}/reviews/${created.id}`, 'PUT', { note: 'First pass, revised.' }, 'coach');
  assert.equal(edited.status, 200);
  assert.equal(edited.body.note, 'First pass, revised.');

  fake.state.dms.length = 0;
  assert.equal((await call(`/api/vods/${v.id}/reviews/${created.id}/resend`, 'POST', null, 'coach')).status, 200);
  const dm = await waitFor(() => fake.state.dms.find((d) => d.to === STUDENT));
  assert.ok(dm.content.includes('updated their review note'), 'a resend of an edited entry gets the "updated" wording');
  assert.ok(dm.content.includes('First pass, revised.'));

  // a resend of an entry that was never edited does not claim it was "updated"
  const v2 = (await call('/api/vods', 'POST', { url: 'https://youtu.be/revcheck021', type: 'Siege', recordedDate: '2026-10-05' }, 'student')).body;
  const created2 = (await call(`/api/vods/${v2.id}/reviews`, 'POST', { note: 'Looks good.' }, 'coach')).body;
  fake.state.dms.length = 0;
  await call(`/api/vods/${v2.id}/reviews/${created2.id}/resend`, 'POST', null, 'coach');
  const dm2 = await waitFor(() => fake.state.dms.find((d) => d.to === STUDENT));
  assert.ok(!dm2.content.includes('updated their review note'));
});
