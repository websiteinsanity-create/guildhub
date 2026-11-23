'use strict';
// hotfix.4 (LOA regression): a member on a leave of absence is classified Inactive (character `active: false`, set by
// the player or an officer for the break) but keeps their GuildHub rights and their content: own VODs, Gear Thread,
// coaching class and private media - for themselves, for officers and for their class coaches. Removed players do not.
// Fictional data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startGuild } = require('./hf2-helpers');

const GUILD = '111111111111111111', SECRET = 'loa-regression-test-secret-not-real';
const T = '2026-10-01T18:00:00.000Z';
const id = (n) => '6100000000000000' + String(n).padStart(2, '0');
const U = { OFF: id(1), ACT: id(2), LOA: id(3), ENDED: id(4), INACT: id(5), KICK: id(6), COACH: id(7), OTHERCOACH: id(8), MEMBER: id(9), GUEST: id(10), GUESTX: id(11), LEFT: id(12) };
const BW = { primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow' };              // Battleweaver
const BZ = { primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Daggers' };      // Berserker
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const user = (uid, name, extra = {}) => ({ id: uid, name, username: name.toLowerCase(), avatar: '', role: 'member', inGuild: true, accepted: true, ...extra });
const char = (mid, owner, name, extra = {}) => ({ id: mid, owner, name, role: 'DPS', active: true, ...BW, joinedAt: T, builds: [], ...extra });
const vod = (vid, owner, extra = {}) => ({ id: vid, owner, postedBy: owner, postedAt: T, title: 'Wargame ' + vid, type: 'Wargame', recordedDate: '2026-10-01', enemyGuild: 'Rivals',
  note: 'n' + vid, url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', visibility: 'private', visibleClass: '', reviews: [], finished: false, ...extra });
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, n)]);
const MEDIA = { loa: 'gearshot-10a010a010a0.png', loaThumb: 'gearthumb-10a010a010a1.png', kick: 'gearshot-c1c1c1c1c1c1.png', act: 'gearshot-a1a1a1a1a1a1.png' };   // names must match the server's upload pattern ([a-f0-9]{12})

function seed() {
  return {
    nextId: 30000,
    users: {
      [U.OFF]: user(U.OFF, 'Officer'), [U.ACT]: user(U.ACT, 'Activeplayer'), [U.LOA]: user(U.LOA, 'Leaveplayer'), [U.ENDED]: user(U.ENDED, 'Backplayer'),
      [U.INACT]: user(U.INACT, 'Breakplayer'), [U.KICK]: user(U.KICK, 'Kickedplayer', { kicked: true }), [U.COACH]: user(U.COACH, 'Classcoach', { coach: true }),
      [U.OTHERCOACH]: user(U.OTHERCOACH, 'Othercoach', { coach: true }), [U.MEMBER]: user(U.MEMBER, 'Bystander'),
      [U.GUEST]: user(U.GUEST, 'Guestsame', { role: 'applicant', applicant: true, accepted: false, inGuild: false, coach: true }),
      [U.GUESTX]: user(U.GUESTX, 'Guestother', { role: 'applicant', applicant: true, accepted: false, inGuild: false, coach: true }),
      [U.LEFT]: user(U.LEFT, 'Leftplayer', { accepted: false, inGuild: false }),
    },
    members: [
      char(701, U.OFF, 'Offchar', BZ), char(702, U.ACT, 'Actchar'),
      char(703, U.LOA, 'Loachar', { active: false, builds: [{ id: 1, name: 'Second', ...BW }] }),          // on leave: Inactive in the roster
      char(704, U.ENDED, 'Endchar', { active: false }),                                                    // leave over, not reactivated yet
      char(705, U.INACT, 'Breakchar', { active: false }),                                                 // inactive, no leave, still in the guild
      char(706, U.KICK, 'Kickchar', { active: false }),                                                    // kicked (kick also sets inactive)
      char(707, U.COACH, 'Coachchar', BZ), char(708, U.OTHERCOACH, 'Ochar', BZ), char(709, U.MEMBER, 'Bychar', BZ),
      char(712, U.LEFT, 'Leftchar', { active: false }),                                                    // left the guild (no longer a member)
    ],
    leaves: [
      { id: 801, ownerKey: U.LOA, name: 'Leaveplayer', from: day(-3), to: day(10), reason: 'Holiday', status: 'approved', by: 'Leaveplayer', at: T, decidedBy: 'Officer', decidedAt: T },
      { id: 802, ownerKey: U.ENDED, name: 'Backplayer', from: day(-20), to: day(-2), reason: 'Exams', status: 'approved', by: 'Backplayer', at: T, decidedBy: 'Officer', decidedAt: T },
    ],
    coachLinks: [{ id: 811, coach: U.COACH, class: 'Battleweaver', linkedAt: T }, { id: 812, coach: U.OTHERCOACH, class: 'Berserker', linkedAt: T },
      { id: 813, coach: U.GUEST, class: 'Battleweaver', linkedAt: T }, { id: 814, coach: U.GUESTX, class: 'Berserker', linkedAt: T }],
    guestCoaches: [{ id: 851, discordId: U.GUEST, name: 'Guestsame', avatar: '', addedAt: T, via: 'invite' }, { id: 852, discordId: U.GUESTX, name: 'Guestother', avatar: '', addedAt: T, via: 'invite' }],
    guestCoachInvites: [],
    vods: [vod(901, U.ACT), vod(902, U.LOA), vod(903, U.LOA, { visibility: 'everyone' }), vod(904, U.ENDED), vod(905, U.INACT), vod(906, U.KICK), vod(907, U.LEFT)],
    vodMarkers: [{ id: 951, vodId: 902, createdBy: U.COACH, createdAt: T, timestamp: 12, beforeSeconds: 2, afterSeconds: 2, note: 'coach point before the leave', strokes: [] }],
    gearScreens: [{ id: 961, memberId: 703, sectionId: 1, images: [MEDIA.loa], previews: { [MEDIA.loa]: MEDIA.loaThumb }, note: 'loa gear', updatedAt: T },
      { id: 962, memberId: 706, sectionId: 1, images: [MEDIA.kick], previews: {}, note: '', updatedAt: T },
      { id: 963, memberId: 702, sectionId: 1, images: [MEDIA.act], previews: {}, note: '', updatedAt: T }],
    gearFolder: [], gearSectionTypes: [{ id: 1, label: 'Gear' }],
    settings: { coachUserIds: [U.COACH, U.OTHERCOACH], applications: { enabled: true }, branding: {} },
    events: [], points: [],
  };
}

let G; const S = {};
const denied = (s) => s === 401 || s === 403;
const st = async (who) => (await G.api('GET', '/api/state', { cookie: S[who] })).json;
// 200 only counts when an actual PNG came back (never the app page a non-matching name would fall through to)
const media = async (name, who) => { const r = await fetch(G.base + '/uploads/' + name, { headers: who ? { Cookie: S[who] } : {} }); const b = Buffer.from(await r.arrayBuffer());
  if (r.status === 200) assert.equal(b.subarray(0, 4).toString('hex'), '89504e47', `${name} for ${who || 'anonymous'}: 200 without image bytes`); return r.status; };
const exportDb = async () => (await G.api('GET', '/api/export', { cookie: S.OFF })).json;
const pick = (d) => JSON.stringify({ members: d.members.filter((m) => [U.LOA, U.ENDED, U.INACT].includes(m.owner)).map(({ id: i, owner, name, active, builds, primaryWeapon, secondaryWeapon }) => ({ i, owner, name, active, builds, primaryWeapon, secondaryWeapon })),
  vods: d.vods.filter((v) => [902, 903, 904, 905].includes(v.id)).map(({ id: i, owner, postedBy, visibility, title }) => ({ i, owner, postedBy, visibility, title })),
  gear: d.gearScreens.filter((r) => r.memberId === 703), links: d.coachLinks, guests: d.guestCoaches.map((g) => g.discordId) });
let SNAP0;

before(async () => {
  G = await startGuild({ seed: seed(), secret: SECRET, guild: GUILD, uploads: { [MEDIA.loa]: png(1), [MEDIA.loaThumb]: png(2), [MEDIA.kick]: png(3), [MEDIA.act]: png(4) },
    env: { DISCORD_OFFICER_USER_IDS: U.OFF } });
  for (const k of ['OFF', 'ACT', 'LOA', 'ENDED', 'INACT', 'COACH', 'OTHERCOACH', 'MEMBER']) S[k] = await G.login(U[k]);
  S.GUEST = await G.login(U.GUEST, [], { inGuild: false });
  S.GUESTX = await G.login(U.GUESTX, [], { inGuild: false });
  SNAP0 = pick(await exportDb());
});
after(async () => { if (G) await G.close(); });

test('1 active member without leave: own VODs, Gear Thread and media as before', async () => {
  const s = await st('ACT');
  assert.equal(s.user.role, 'member');
  assert.ok(s.vods.some((v) => v.id === 901), 'own VOD listed');
  assert.equal(s.members.find((m) => m.id === 702).content, true);
  assert.equal((await G.api('GET', '/api/gearthreads/702', { cookie: S.ACT })).status, 200);
  assert.equal(await media(MEDIA.act, 'ACT'), 200);
});

test('2 member on an active leave: classified Inactive, keeps role, VODs, Gear Thread, posting and media', async () => {
  const s = await st('LOA');
  const mine = s.members.find((m) => m.id === 703);
  assert.equal(s.user.role, 'member', 'a leave never changes the guild role');
  assert.equal(mine.active, false, 'still classified Inactive (roster)');
  assert.ok((s.leaves || []).some((l) => l.ownerKey === U.LOA && l.status === 'approved'), 'leave is active');
  assert.equal(mine.content, true, 'the character still carries their content');
  const v = s.vods.find((x) => x.id === 902);
  assert.ok(v, 'own private VOD visible');
  assert.equal(v.ownerClass, 'Battleweaver', 'VOD keeps its class folder (was "Other" before the fix)');
  assert.equal(v.ownerName, 'Loachar');
  assert.equal((await G.api('GET', '/api/gearthreads/703', { cookie: S.LOA })).status, 200, 'own Gear Thread');
  assert.equal(await media(MEDIA.loa, 'LOA'), 200, 'own private gear image');
  const posted = await G.api('POST', '/api/vods', { cookie: S.LOA, body: { url: 'https://youtu.be/abcdefghijk', title: 'On leave but still practising', type: 'Wargame', recordedDate: day(-1), enemyGuild: 'Rivals' } });
  assert.equal(posted.status, 200, 'can post an own VOD during the leave: ' + posted.text.slice(0, 100));
  S.loaPosted = posted.json.id;
});

test('3 leave ended (character still Inactive, or reactivated): content stays available', async () => {
  const s = await st('ENDED');
  assert.equal(s.members.find((m) => m.id === 704).content, true);
  assert.ok(s.vods.some((v) => v.id === 904 && v.ownerClass === 'Battleweaver'), 'own VOD after the leave ended, still in its class folder');
  assert.ok((await st('COACH')).vods.some((v) => v.id === 904), 'class coach still sees it after the leave ended');
  assert.ok(((await st('COACH')).myStudents || []).includes(U.ENDED), 'still their student while not yet reactivated');
  assert.equal((await G.api('GET', '/api/gearthreads/704', { cookie: S.ENDED })).status, 200);
  const re = await G.api('PUT', '/api/members/704', { cookie: S.ENDED, body: { ...(s.members.find((m) => m.id === 704)), active: true } });
  assert.equal(re.status, 200, 'reactivating after the leave');
  const s2 = await st('ENDED');
  assert.equal(s2.members.find((m) => m.id === 704).active, true);
  assert.ok(s2.vods.some((v) => v.id === 904 && v.ownerClass === 'Battleweaver'), 'still there with its class after reactivation');
});

test('4 inactive member without any leave, still in the guild: Inactive classification, content kept', async () => {
  const s = await st('INACT');
  assert.equal(s.user.role, 'member');
  assert.equal(s.members.find((m) => m.id === 705).active, false);
  assert.equal(s.members.find((m) => m.id === 705).content, true);
  assert.ok(s.vods.some((v) => v.id === 905 && v.ownerClass === 'Battleweaver'));
  assert.equal((await G.api('GET', '/api/gearthreads/705', { cookie: S.INACT })).status, 200);
});

test('5 kicked and departed players do not regain anything', async () => {
  // kicked: no session survives the kick; a fresh sign-in is an applicant (application page only)
  const k = await G.login(U.KICK);
  const ks = await G.api('GET', '/api/state', { cookie: k });
  assert.equal(ks.json.user.role, 'applicant');
  assert.ok(denied((await G.api('GET', '/api/gearthreads/706', { cookie: k })).status), 'kicked: own gear thread refused');
  assert.equal(await media(MEDIA.kick, null), 401, 'anonymous media refused');
  assert.ok(denied((await fetch(G.base + '/uploads/' + MEDIA.kick, { headers: { Cookie: k } })).status), 'kicked: own private media refused');
  // nobody but officers treats a removed player's character as content: no class, no coach access
  const off = await st('OFF');
  assert.equal(off.members.find((m) => m.id === 706).content, false, 'kicked character is not a content character');
  assert.equal(off.members.find((m) => m.id === 712).content, false, 'departed player (not a member any more) is not either');
  const coach = await st('COACH');
  assert.ok(!coach.vods.some((v) => v.id === 906 || v.id === 907), 'class coach does not see kicked/departed players\' private VODs');
  assert.ok(!(coach.myStudents || []).includes(U.KICK) && !(coach.myStudents || []).includes(U.LEFT));
  assert.ok(denied((await G.api('POST', '/api/vods/906/reviews', { cookie: S.COACH, body: { note: 'x' } })).status));
});

test('6 officer sees and opens the leave member\'s VODs and Gear Thread', async () => {
  const s = await st('OFF');
  assert.ok(s.vods.some((v) => v.id === 902 && v.ownerClass === 'Battleweaver'), 'private VOD in the right class folder');
  assert.equal(s.members.find((m) => m.id === 703).content, true, 'listed in the Gear Thread index');
  const g = await G.api('GET', '/api/gearthreads/703', { cookie: S.OFF });
  assert.equal(g.status, 200);
  assert.equal(await media(MEDIA.loa, 'OFF'), 200);
  assert.equal(await media(MEDIA.loaThumb, 'OFF'), 200);
  // officers keep exactly their normal rights: no new cross-user rights appear (own review notes only)
  const r = await G.api('POST', '/api/vods/902/reviews', { cookie: S.LOA, body: { note: 'my own note' } });
  if (r.status === 200) {
    const rid = (await st('LOA')).vods.find((v) => v.id === 902).reviews.find((x) => x.note === 'my own note');
    if (rid) assert.equal((await G.api('DELETE', `/api/vods/902/reviews/${rid.id}`, { cookie: S.OFF })).status, 403, 'officer cannot delete someone else\'s review note');
  }
});

test('7 member on leave edits and deletes their own content', async () => {
  const s = await st('LOA');
  const v = s.vods.find((x) => x.id === 902);
  assert.equal(v.canManage, true, 'own VOD manageable');
  assert.equal((await G.api('PUT', '/api/vods/902', { cookie: S.LOA, body: { title: 'Renamed during leave' } })).status, 200);
  assert.equal((await G.api('PUT', '/api/vods/902', { cookie: S.LOA, body: { visibility: 'class' } })).status, 200, 'share with own class');
  const after1 = (await st('LOA')).vods.find((x) => x.id === 902);
  assert.equal(after1.visibleClass, 'Battleweaver', 'class sharing falls back to their own class');
  assert.equal((await G.api('PUT', '/api/vods/902', { cookie: S.LOA, body: { visibility: 'private' } })).status, 200);
  assert.equal((await G.api('DELETE', `/api/vods/${S.loaPosted}`, { cookie: S.LOA })).status, 200, 'deletes the VOD posted during the leave');
  const thread = await G.api('GET', '/api/gearthreads/703', { cookie: S.LOA });
  assert.equal(thread.status, 200);
});

test('8 private gear media during the leave: owner, officer and class coach yes; others no', async () => {
  assert.equal(await media(MEDIA.loa, 'LOA'), 200);
  assert.equal(await media(MEDIA.loa, 'OFF'), 200);
  assert.equal(await media(MEDIA.loa, 'COACH'), 200, 'coach of the build\'s class');
  assert.equal(await media(MEDIA.loa, 'MEMBER'), 403, 'unrelated member');
  assert.equal(await media(MEDIA.loa, 'OTHERCOACH'), 403, 'coach of another class');
  assert.equal(await media(MEDIA.loa, null), 401, 'anonymous');
  const r = await fetch(G.base + '/uploads/' + MEDIA.loa, { headers: { Cookie: S.LOA } });
  assert.match(r.headers.get('cache-control') || '', /private/);
  assert.match(r.headers.get('cache-control') || '', /no-store/);
});

test('9 coaching during the leave: class coach keeps the student; class limits and B04 guest rules unchanged', async () => {
  const c = await st('COACH');
  assert.ok((c.myStudents || []).includes(U.LOA), 'leave member is still their student');
  assert.ok(c.vods.some((v) => v.id === 902), 'coach sees the private VOD');
  assert.equal((await G.api('POST', '/api/vods/902/reviews', { cookie: S.COACH, body: { note: 'still coaching you' } })).status, 200);
  assert.equal((await G.api('GET', '/api/gearthreads/703', { cookie: S.COACH })).status, 200, 'coach opens the build thread');
  const o = await st('OTHERCOACH');
  assert.ok(!o.vods.some((v) => v.id === 902), 'coach of another class does not');
  assert.ok(denied((await G.api('POST', '/api/vods/902/reviews', { cookie: S.OTHERCOACH, body: { note: 'x' } })).status));
  // guest coaches (B04): same class sees and annotates, but never manages or deletes; other class sees nothing
  const g = await st('GUEST');
  const gv = g.vods.find((v) => v.id === 902);
  assert.ok(gv, 'guest coach of the class sees the leave member\'s VOD');
  assert.equal(gv.canManage, false);
  assert.equal((await G.api('DELETE', '/api/vods/902', { cookie: S.GUEST })).status, 403, 'guest coach cannot delete');
  assert.equal((await G.api('POST', '/api/vods/902/markers', { cookie: S.GUEST, body: { timestamp: 30, beforeSeconds: 2, afterSeconds: 2, note: 'guest point', strokes: [] } })).status, 200);
  assert.ok(!(await st('GUESTX')).vods.some((v) => v.id === 902), 'guest coach of another class sees nothing');
  assert.equal((await G.api('GET', '/api/gearthreads/703', { cookie: S.GUEST })).status, 403, 'guest coaches never reach gear threads');
  assert.equal((await fetch(G.base + '/uploads/' + MEDIA.loa, { headers: { Cookie: S.GUEST } })).status, 403);
});

test('10 leave switched on and off through the API: content available throughout, no data deleted or re-owned', async () => {
  // a fresh leave for the active player, who marks themselves Inactive for it - then it ends and they come back
  const l = await G.api('POST', '/api/leaves', { cookie: S.OFF, body: { ownerKey: U.ACT, from: day(0), to: day(5), reason: 'Trip' } });
  assert.equal(l.status, 200, l.text.slice(0, 100));
  const me = (await st('ACT')).members.find((m) => m.id === 702);
  assert.equal((await G.api('PUT', '/api/members/702', { cookie: S.ACT, body: { ...me, active: false } })).status, 200);
  const check = async (phase) => {
    const s = await st('ACT'), o = await st('OFF'), c = await st('COACH');
    assert.equal(s.user.role, 'member', phase + ': role');
    assert.ok(s.vods.some((v) => v.id === 901), phase + ': own VOD');
    assert.ok(o.vods.some((v) => v.id === 901 && v.ownerClass === 'Battleweaver'), phase + ': officer sees it in its class');
    assert.ok(c.vods.some((v) => v.id === 901), phase + ': class coach sees it');
    assert.equal((await G.api('GET', '/api/gearthreads/702', { cookie: S.ACT })).status, 200, phase + ': own gear thread');
    assert.equal(await media(MEDIA.act, 'ACT'), 200, phase + ': own media');
    assert.equal(o.members.find((m) => m.id === 702).content, true, phase + ': in the officer\'s Gear Thread index');
  };
  await check('leave active');
  assert.equal((await G.api('PUT', `/api/leaves/${l.json.id}`, { cookie: S.OFF, body: { from: day(-6), to: day(-1) } })).status, 200, 'leave moved into the past');
  await check('leave expired, still Inactive');
  assert.equal((await G.api('PUT', '/api/members/702', { cookie: S.ACT, body: { ...me, active: true } })).status, 200);
  await check('reactivated');
  // the leave players' records were never deleted, moved to another owner or rewritten by any of the reads above
  await G.restart();
  const now = JSON.parse(SNAP0);
  const d = JSON.parse(pick(await exportDb()));
  assert.deepEqual(d.members.filter((m) => m.owner !== U.ENDED), now.members.filter((m) => m.owner !== U.ENDED), 'leave/inactive characters unchanged (Endchar was reactivated on purpose in test 3)');
  assert.deepEqual(d.gear, now.gear, 'gear thread rows unchanged');
  assert.deepEqual(d.links, now.links, 'coach links unchanged');
  assert.deepEqual(d.guests, now.guests, 'guest coaches unchanged');
  for (const v of d.vods) assert.equal(v.owner, now.vods.find((x) => x.i === v.i).owner, 'VOD owner unchanged');
  assert.equal(d.vods.length, now.vods.length, 'no VOD deleted');
});
