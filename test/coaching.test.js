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
function stopServer() { proc && proc.kill(); fake && fake.close(); dir && fs.rmSync(dir, { recursive: true, force: true }); }
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
  sessions.coach = await discordLogin(COACH, []);   // takes effect on next sign-in, same as officer
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

test('a VOD is private by default (owner + their coach + officers only); the owner cannot promote its visibility, only a coach or officer can', async () => {
  await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer');   // re-link after the previous test's isolated server state
  const v = (await call('/api/vods', 'POST', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'Siege', recordedDate: '2026-09-26' }, 'student')).body;
  assert.equal(v.visibility, 'private');
  assert.equal(v.videoId, 'dQw4w9WgXcQ');

  assert.ok((await state('student')).vods.some((x) => x.id === v.id), 'the owner sees their own VOD');
  assert.ok((await state('coach')).vods.some((x) => x.id === v.id), "their coach sees it too");
  assert.ok((await state('officer')).vods.some((x) => x.id === v.id), 'officers see everything');
  assert.ok(!(await state('other')).vods.some((x) => x.id === v.id), 'an unrelated player cannot see it');

  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'everyone' }, 'student')).status, 403, 'the owner cannot promote their own VOD');
  assert.equal((await call(`/api/vods/${v.id}`, 'PUT', { visibility: 'everyone' }, 'coach')).status, 200);
  assert.ok((await state('other')).vods.some((x) => x.id === v.id), 'now visible to everyone');
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

