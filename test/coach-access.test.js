// Hotfix 1.46.2.2 (SA-06): VOD coaching rights come from a coach link ONLY while its coach is an active coach.
// Removing someone as a coach in Admin, or kicking them, must take away review/annotate/finish/delete rights and
// private-VOD visibility on the very next request; re-instating them restores it (links stay stored). Guest
// coaches keep working exactly as before; unrelated members stay denied; officers stay allowed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { inviteGuestCoach } = require('./guest-invite-helper');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111', OFFICER_ROLE = '900000000000000001';
const OFFICER = '100000000000000301', COACH = '100000000000000302', STUDENT = '100000000000000303', OTHER = '100000000000000304', GUEST = '100000000000000305';
// The lead's server-side resolver (access.js) also revokes a kicked account's sessions outright; without it the
// kicked coach's existing session keeps working as a plain member, and only the coach-link check below applies.
const RESOLVER_INTEGRATED = fs.existsSync(path.join(__dirname, '..', 'access.js'));

let fake, dir, proc, port, base;
const sessions = {};
const vods = {};

async function startServer() {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-coach-access-'));
  port = await require('./free-port')();
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
let urlSeq = 0;
const postVod = async (who, extra = {}) => {
  const url = `https://youtu.be/coachacc${String(urlSeq++).padStart(3, '0')}`;
  const r = await call('/api/vods', 'POST', { url, type: 'Siege', recordedDate: '2026-11-01', ...extra }, who);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const setCoaches = async (userIds) => assert.equal((await call('/api/admin/coaches', 'PUT', { userIds }, 'officer')).status, 200);

// Everything an active coach of the VOD's owner may do. Returns the status of every step so a caller can assert
// "all allowed" or "all denied" in one place.
async function coachActions(who, vod) {
  const out = {};
  out.edit = (await call(`/api/vods/${vod.id}`, 'PUT', { note: `edited by ${who}` }, who)).status;
  out.visibility = (await call(`/api/vods/${vod.id}`, 'PUT', { visibility: 'private' }, who)).status;
  const mk = await call(`/api/vods/${vod.id}/markers`, 'POST', { timestamp: 5, note: 'here' }, who);
  out.markerAdd = mk.status;
  const markerId = mk.status === 200 ? mk.body.id : vods.officerMarkerId;
  out.markerEdit = (await call(`/api/vods/${vod.id}/markers/${markerId}`, 'PUT', { timestamp: 6, note: 'there' }, who)).status;
  out.markerDelete = (await call(`/api/vods/${vod.id}/markers/${markerId}`, 'DELETE', null, who)).status;
  out.review = (await call(`/api/vods/${vod.id}/reviews`, 'POST', { note: `review by ${who}` }, who)).status;
  out.finish = (await call(`/api/vods/${vod.id}/finished`, 'PUT', { finished: true }, who)).status;
  out.unfinish = (await call(`/api/vods/${vod.id}/finished`, 'PUT', { finished: false }, who)).status;
  out.postFor = (await call('/api/vods', 'POST', { owner: STUDENT, url: `https://youtu.be/coachacc${String(urlSeq++).padStart(3, '0')}`, type: 'Siege', recordedDate: '2026-11-02' }, who)).status;
  return out;
}
const allIs = (o, want) => Object.values(o).every((s) => (Array.isArray(want) ? want.includes(s) : s === want));

before(async () => {
  await startServer();
  sessions.officer = await discordLogin(OFFICER, [OFFICER_ROLE]);
  sessions.coach = await discordLogin(COACH, []);
  sessions.student = await discordLogin(STUDENT, []);
  sessions.other = await discordLogin(OTHER, []);
  assert.equal((await call('/api/members', 'POST', { name: 'CoachChar', role: 'DPS', primaryWeapon: 'Greatsword', secondaryWeapon: 'Longbow' }, 'coach')).status, 200);
  assert.equal((await call('/api/members', 'POST', { name: 'StudentChar', role: 'DPS', primaryWeapon: 'Daggers', secondaryWeapon: 'Crossbow' }, 'student')).status, 200);   // Scorpion
  assert.equal((await call('/api/members', 'POST', { name: 'OtherChar', role: 'Healer', primaryWeapon: 'Orb', secondaryWeapon: 'Wand & Tome' }, 'other')).status, 200);       // Oracle
  await setCoaches([COACH]);
  assert.equal((await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer')).status, 200);
  // B04 (hotfix.3): guest coaches join only through a single-use invitation from an officer.
  sessions.guest = await inviteGuestCoach(base, sessions.officer, 'Scorpion', GUEST);
  vods.priv = await postVod('student');                                   // private by default
  vods.pub = await postVod('student');
  assert.equal((await call(`/api/vods/${vods.pub.id}`, 'PUT', { visibility: 'everyone' }, 'student')).status, 200);
  const mk = await call(`/api/vods/${vods.priv.id}/markers`, 'POST', { timestamp: 1, note: 'officer point' }, 'officer');
  vods.officerMarkerId = mk.body.id;
});
after(stopServer);

test('an active coach can see, edit, annotate, review, finish and delete a student VOD', async () => {
  const st = await state('coach');
  assert.equal(st.isCoach, true);
  assert.deepEqual(st.myStudents, [STUDENT]);
  assert.deepEqual(st.myCoachClasses, ['Scorpion']);
  const seen = st.vods.find((v) => v.id === vods.priv.id);
  assert.ok(seen, 'private student VOD visible to their coach');
  assert.equal(seen.canManage, true);
  assert.equal(seen.canReview, true);
  assert.equal(seen.canPromote, true);
  const res = await coachActions('coach', vods.priv);
  assert.ok(allIs(res, 200), JSON.stringify(res));
  assert.deepEqual((await state('student')).myCoaches.sort(), [COACH, GUEST].sort());
  const doomed = await postVod('student');
  assert.equal((await call(`/api/vods/${doomed.id}`, 'DELETE', null, 'coach')).status, 200);
});

test('an unrelated member is denied everything on a private VOD', async () => {
  assert.ok(!(await state('other')).vods.some((v) => v.id === vods.priv.id));
  const res = await coachActions('other', vods.priv);
  assert.ok(allIs(res, [403, 404]), JSON.stringify(res));
  assert.equal((await call(`/api/vods/${vods.priv.id}`, 'DELETE', null, 'other')).status, 403);
});

test('a coach removed in Admin loses every VOD right immediately, links stay stored, re-instating restores access', async () => {
  // a review written while still a coach - its author must not be able to edit/resend it after removal
  const rev = (await call(`/api/vods/${vods.pub.id}/reviews`, 'POST', { note: 'written while coach' }, 'coach')).body;
  assert.ok(rev.id);
  const victim = await postVod('student');

  await setCoaches([]);   // removed in Admin, still signed in with the same session

  const st = await state('coach');
  assert.equal(st.isCoach, false);
  assert.deepEqual(st.myStudents, []);
  assert.deepEqual(st.myCoachClasses, []);
  assert.deepEqual(st.myStudentNames, {});
  assert.equal(st.myGuestCoachClass, null);
  assert.ok(!st.vods.some((v) => v.id === vods.priv.id), 'private VOD no longer visible');
  assert.ok(!st.vods.some((v) => v.id === victim.id));
  const pub = st.vods.find((v) => v.id === vods.pub.id);
  assert.ok(pub, 'an "everyone" VOD stays visible as to any member');
  assert.equal(pub.canManage, false);
  assert.equal(pub.canReview, false);
  assert.equal(pub.canPromote, false);
  assert.equal(pub.reviews.find((r) => r.id === rev.id).canEdit, false);

  for (const v of [vods.priv, vods.pub]) {
    const res = await coachActions('coach', v);
    assert.ok(allIs(res, 403), `${v.id}: ${JSON.stringify(res)}`);
  }
  assert.equal((await call(`/api/vods/${victim.id}`, 'DELETE', null, 'coach')).status, 403);
  assert.equal((await call(`/api/vods/${vods.pub.id}/reviews/${rev.id}`, 'PUT', { note: 'sneaky edit' }, 'coach')).status, 403);
  assert.equal((await call(`/api/vods/${vods.pub.id}/reviews/${rev.id}/resend`, 'POST', null, 'coach')).status, 403);

  assert.deepEqual((await state('student')).myCoaches, [GUEST], 'student no longer lists the removed coach');
  const off = await state('officer');
  assert.ok(off.coachLinks.some((l) => l.coach === COACH && l.class === 'Scorpion'), 'the link itself is kept');

  // a new VOD for the student does not DM the removed coach
  fake.state.dms.length = 0;
  await postVod('student');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fake.state.dms.filter((d) => d.to === COACH).length, 0);

  // guest coaches are not touched by an Admin coach-list save
  const g = await state('guest');
  assert.ok(g.vods.some((v) => v.id === vods.priv.id), 'guest coach still sees the private VOD');

  await setCoaches([COACH]);   // re-instated
  const back = await state('coach');
  assert.equal(back.isCoach, true);
  assert.deepEqual(back.myStudents, [STUDENT]);
  assert.ok(back.vods.some((v) => v.id === victim.id));
  assert.equal(back.vods.find((v) => v.id === vods.pub.id).reviews.find((r) => r.id === rev.id).canEdit, true);
  const res = await coachActions('coach', vods.priv);
  assert.ok(allIs(res, 200), JSON.stringify(res));
  assert.equal((await call(`/api/vods/${vods.pub.id}/reviews/${rev.id}`, 'PUT', { note: 'edited after reinstatement' }, 'coach')).status, 200);
  assert.equal((await call(`/api/vods/${victim.id}`, 'DELETE', null, 'coach')).status, 200);
});

// B04 (hotfix.3, owner decision 1.5): a guest coach keeps all coaching work inside their class - points, drawings,
// review notes, finishing, posting for a student - but no longer edits or deletes the recording itself.
test('a guest coach keeps coaching their class, but cannot edit or delete the recording itself', async () => {
  const st = await state('guest');
  assert.equal(st.myGuestCoachClass, 'Scorpion');
  assert.deepEqual(st.myStudents, [STUDENT]);
  const seen = st.vods.find((v) => v.id === vods.priv.id);
  assert.ok(seen);
  assert.equal(seen.canManage, false, 'no longer manages the recording');
  assert.equal(seen.canAnnotate, true, 'still adds coaching points');
  assert.equal(seen.canReview, true);
  const res = await coachActions('guest', vods.priv);
  const { edit, visibility, ...coaching } = res;
  assert.ok(allIs(coaching, 200), JSON.stringify(res));
  assert.deepEqual([edit, visibility], [403, 403], 'title/note and visibility of the recording are not theirs to change');
  const doomed = await postVod('student');
  assert.equal((await call(`/api/vods/${doomed.id}`, 'DELETE', null, 'guest')).status, 403, 'cannot delete an original VOD');
  assert.equal((await call(`/api/vods/${doomed.id}`, 'DELETE', null, 'coach')).status, 200, 'a regular coach still can');
  // still confined to their one class: an "everyone" VOD of another class stays hidden
  const otherPub = await postVod('other');
  await call(`/api/vods/${otherPub.id}`, 'PUT', { visibility: 'everyone' }, 'other');
  assert.ok(!(await state('guest')).vods.some((v) => v.id === otherPub.id));
});

test('an officer is still allowed everything', async () => {
  const res = await coachActions('officer', vods.priv);
  assert.ok(allIs(res, 200), JSON.stringify(res));
  const doomed = await postVod('student');
  assert.equal((await call(`/api/vods/${doomed.id}`, 'DELETE', null, 'officer')).status, 200);
});

// Kicking runs last: it deactivates the coach's characters and cannot be undone without a new application.
test('a kicked coach loses all VOD rights immediately (coach-link check; works with or without the resolver)', async () => {
  const victim = await postVod('student');
  assert.equal((await call('/api/admin/kick', 'POST', { ownerKey: COACH, reason: 'test' }, 'officer')).status, 200);
  // The coach is still in the Admin coach list and still linked - only the kick changed.
  const st = await call('/api/state', 'GET', null, 'coach');
  if (st.status === 200) {
    assert.ok(!st.body.vods.some((v) => v.id === vods.priv.id || v.id === victim.id), 'no private VOD visibility');
    assert.deepEqual(st.body.myStudents, []);
  } else assert.equal(st.status, 401, 'session revoked');
  for (const v of [vods.priv, vods.pub]) {
    const res = await coachActions('coach', v);
    assert.ok(allIs(res, [401, 403]), `${v.id}: ${JSON.stringify(res)}`);
  }
  assert.ok([401, 403].includes((await call(`/api/vods/${victim.id}`, 'DELETE', null, 'coach')).status));
  assert.deepEqual((await state('student')).myCoaches, [GUEST]);
  assert.ok((await state('officer')).vods.some((v) => v.id === victim.id), 'the VOD itself is untouched');
});

test('a kicked coach\'s existing session is revoked outright (needs the lead\'s access.js resolver / session-guard)', { skip: RESOLVER_INTEGRATED ? false : 'depends on lead integration of access.js + session-guard.js (kick revokes sessions); re-run after integration' }, async () => {
  assert.equal((await call('/api/state', 'GET', null, 'coach')).status, 401);
  assert.equal((await call(`/api/vods/${vods.priv.id}/reviews`, 'POST', { note: 'x' }, 'coach')).status, 401);
});
