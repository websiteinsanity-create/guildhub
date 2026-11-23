'use strict';
// hotfix.4: the content-character rule (inactive characters of current guild members keep their content) must not give
// anything back to kicked, departed or otherwise unauthorised accounts - not through existing sessions, copied cookies,
// Bearer tokens, a fresh sign-in or direct API requests - and must leave the B04 guest-coach rules and the GH-01
// private-media checks exactly as they were. Fictional data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startGuild } = require('./hf2-helpers');

const GUILD = '111111111111111111', SECRET = 'loa-boundary-test-secret-not-real';
const T = '2026-10-01T18:00:00.000Z';
const id = (n) => '6300000000000000' + String(n).padStart(2, '0');
const U = { OFF: id(1), KICK: id(2), DEP: id(3), LOA: id(4), COACH: id(5), MEMBER: id(6), GUEST: id(7), GUESTX: id(8), OUT: id(9) };
const BW = { primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow' }, BZ = { primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Daggers' };
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const user = (uid, name, extra = {}) => ({ id: uid, name, username: name.toLowerCase(), avatar: '', role: 'member', inGuild: true, accepted: true, ...extra });
const char = (mid, owner, name, extra = {}) => ({ id: mid, owner, name, role: 'DPS', active: true, ...BW, joinedAt: T, builds: [], ...extra });
const vod = (vid, owner, extra = {}) => ({ id: vid, owner, postedBy: owner, postedAt: T, title: 'Wargame ' + vid, type: 'Wargame', recordedDate: '2026-10-01', enemyGuild: 'Rivals',
  note: '', url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', visibility: 'private', visibleClass: '', reviews: [], finished: false, ...extra });
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, n)]);
const MEDIA = { kick: 'gearshot-0c0c0c0c0c0c.png', dep: 'gearshot-0d0d0d0d0d0d.png', loa: 'gearshot-0a0a0a0a0a0a.png', loaThumb: 'gearthumb-0a0a0a0a0a0b.png', loaFolder: 'gearfolder-0a0a0a0a0a0c.png' };

const seed = () => ({
  nextId: 40000,
  users: {
    [U.OFF]: user(U.OFF, 'Officer'), [U.KICK]: user(U.KICK, 'Tobekicked'), [U.DEP]: user(U.DEP, 'Tobedeparted', { accepted: false }),
    [U.LOA]: user(U.LOA, 'Leaveplayer'), [U.COACH]: user(U.COACH, 'Classcoach', { coach: true }), [U.MEMBER]: user(U.MEMBER, 'Bystander'),
    [U.GUEST]: user(U.GUEST, 'Guestsame', { role: 'applicant', applicant: true, accepted: false, inGuild: false, coach: true }),
    [U.GUESTX]: user(U.GUESTX, 'Guestother', { role: 'applicant', applicant: true, accepted: false, inGuild: false, coach: true }),
  },
  members: [char(801, U.OFF, 'Offchar', BZ), char(802, U.KICK, 'Kickchar'), char(803, U.DEP, 'Depchar'), char(804, U.LOA, 'Loachar', { active: false }),
    char(805, U.COACH, 'Coachchar', BZ), char(806, U.MEMBER, 'Bychar', BZ)],
  leaves: [{ id: 851, ownerKey: U.LOA, name: 'Leaveplayer', from: day(-2), to: day(8), reason: 'Holiday', status: 'approved', by: 'Leaveplayer', at: T }],
  coachLinks: [{ id: 861, coach: U.COACH, class: 'Battleweaver', linkedAt: T }, { id: 862, coach: U.GUEST, class: 'Battleweaver', linkedAt: T }, { id: 863, coach: U.GUESTX, class: 'Berserker', linkedAt: T }],
  guestCoaches: [{ id: 871, discordId: U.GUEST, name: 'Guestsame', avatar: '', addedAt: T, via: 'invite' }, { id: 872, discordId: U.GUESTX, name: 'Guestother', avatar: '', addedAt: T, via: 'invite' }],
  guestCoachInvites: [],
  vods: [vod(901, U.KICK), vod(902, U.DEP), vod(903, U.LOA), vod(904, U.KICK, { visibility: 'everyone' })],
  vodMarkers: [{ id: 911, vodId: 903, createdBy: U.COACH, createdAt: T, timestamp: 5, beforeSeconds: 2, afterSeconds: 2, note: 'coach point', strokes: [] }],
  gearScreens: [{ id: 921, memberId: 802, sectionId: 1, images: [MEDIA.kick], previews: {}, note: '', updatedAt: T }, { id: 922, memberId: 803, sectionId: 1, images: [MEDIA.dep], previews: {}, note: '', updatedAt: T },
    { id: 923, memberId: 804, sectionId: 1, images: [MEDIA.loa], previews: { [MEDIA.loa]: MEDIA.loaThumb }, note: '', updatedAt: T }],
  gearFolder: [{ id: 931, memberId: 804, image: MEDIA.loaFolder, note: '', at: T }],
  gearSectionTypes: [{ id: 1, label: 'Gear' }],
  settings: { coachUserIds: [U.COACH], applications: { enabled: true }, branding: {} },
  events: [], points: [],
});

let G; const S = {};
const denied = (s) => s === 401 || s === 403;
const violations = () => { const v = []; return { want: (c, m) => { if (!c) v.push(m); }, done: () => assert.deepEqual(v, [], 'violations:\n' + v.join('\n')) }; };
const media = async (name, cookie) => { const r = await fetch(G.base + '/uploads/' + name, { headers: cookie ? { Cookie: cookie } : {} }); const b = Buffer.from(await r.arrayBuffer());
  if (r.status === 200) assert.equal(b.subarray(0, 4).toString('hex'), '89504e47', name + ': 200 without image bytes'); return { status: r.status, cache: r.headers.get('cache-control') || '' }; };
const bearerOf = (cookie) => cookie.replace(/^gh_session=/, '');
const stateOf = async (cookie) => (await G.api('GET', '/api/state', { cookie })).json;

// Every content route a player might use on their own VODs / Gear Thread, as direct API calls.
async function contentProbe(auth, vodId, memberId, mediaName) {
  const a = auth.bearer ? { bearer: auth.bearer } : { cookie: auth.cookie };
  const st = await G.api('GET', '/api/state', a);
  return {
    state: st.status, stateVods: st.status === 200 ? (st.json.vods || []).map((v) => v.id) : [],
    postVod: (await G.api('POST', '/api/vods', { ...a, body: { url: 'https://youtu.be/abcdefghijk', title: 'x', type: 'Wargame', recordedDate: day(-1), enemyGuild: 'Rivals' } })).status,
    editVod: (await G.api('PUT', `/api/vods/${vodId}`, { ...a, body: { title: 'changed' } })).status,
    shareVod: (await G.api('PUT', `/api/vods/${vodId}`, { ...a, body: { visibility: 'everyone' } })).status,
    marker: (await G.api('POST', `/api/vods/${vodId}/markers`, { ...a, body: { timestamp: 9, beforeSeconds: 2, afterSeconds: 2, note: 'x', strokes: [] } })).status,
    review: (await G.api('POST', `/api/vods/${vodId}/reviews`, { ...a, body: { note: 'x' } })).status,
    deleteVod: (await G.api('DELETE', `/api/vods/${vodId}`, { ...a })).status,
    gear: (await G.api('GET', `/api/gearthreads/${memberId}`, a)).status,
    media: auth.cookie ? (await media(mediaName, auth.cookie)).status : null,
  };
}

before(async () => {
  G = await startGuild({ seed: seed(), secret: SECRET, guild: GUILD, uploads: { [MEDIA.kick]: png(1), [MEDIA.dep]: png(2), [MEDIA.loa]: png(3), [MEDIA.loaThumb]: png(4), [MEDIA.loaFolder]: png(5) },
    env: { DISCORD_OFFICER_USER_IDS: U.OFF } });
  for (const k of ['OFF', 'KICK', 'DEP', 'LOA', 'COACH', 'MEMBER']) S[k] = await G.login(U[k]);
  S.KICK2 = await G.login(U.KICK);                      // a second device of the player who will be kicked
  S.GUEST = await G.login(U.GUEST, [], { inGuild: false });
  S.GUESTX = await G.login(U.GUESTX, [], { inGuild: false });
});
after(async () => { if (G) await G.close(); });

test('B1 kicked player: every existing session (cookie, second device, copied cookie as Bearer) is dead for every content route', async () => {
  assert.equal((await G.api('POST', '/api/admin/kick', { cookie: S.OFF, body: { ownerKey: U.KICK, reason: 'test' } })).status, 200);
  const v = violations();
  for (const [label, auth] of [['cookie', { cookie: S.KICK }], ['second device', { cookie: S.KICK2 }], ['copied cookie as Bearer', { bearer: bearerOf(S.KICK) }]]) {
    const p = await contentProbe(auth, 901, 802, MEDIA.kick);
    for (const [k, s] of Object.entries(p)) if (k !== 'stateVods' && s !== null) v.want(s === 401, `${label}: ${k} -> ${s} (want 401)`);
  }
  v.done();
});

test('B2 kicked player signing in again: application page only - no own VODs, no Gear Thread, no media, no content character', async () => {
  const fresh = await G.login(U.KICK);
  const st = await stateOf(fresh);
  const v = violations();
  v.want(st.user.role === 'applicant', `role ${st.user.role}`);
  v.want(!(st.vods || []).length, `kicked player still lists VODs ${JSON.stringify((st.vods || []).map((x) => x.id))}`);
  const p = await contentProbe({ cookie: fresh }, 901, 802, MEDIA.kick);
  for (const k of ['postVod', 'editVod', 'shareVod', 'marker', 'review', 'deleteVod', 'gear', 'media']) v.want(denied(p[k]) || p[k] === 404, `kicked fresh session: ${k} -> ${p[k]}`);
  const off = await stateOf(S.OFF);
  v.want(off.members.find((m) => m.id === 802).content === false, 'kicked character counted as a content character');
  v.want(off.vods.some((x) => x.id === 901), 'officer lost the kicked player\'s VOD (must keep it: data is kept)');
  const coach = await stateOf(S.COACH);
  v.want(!coach.vods.some((x) => x.id === 901), 'class coach still sees the kicked player\'s private VOD');
  v.want(!(coach.myStudents || []).includes(U.KICK), 'kicked player still a student');
  v.done();
});

test('B3 departed player (left the Discord server, not accepted): existing session keeps nothing beyond an applicant, no content character', async () => {
  // they sign in again after leaving the server: the live record now says not in the guild
  const after1 = await G.login(U.DEP, [], { inGuild: false, expectCookie: false });
  const v = violations();
  for (const [label, cookie] of [['old session', S.DEP], ['new session', after1]].filter(([, c]) => c)) {
    const st = await G.api('GET', '/api/state', { cookie });
    v.want(st.status === 401 || st.json.user.role === 'applicant', `${label}: role ${st.json && st.json.user && st.json.user.role}`);
    v.want(denied((await G.api('GET', '/api/gearthreads/803', { cookie })).status), `${label}: gear thread`);
    v.want(denied((await media(MEDIA.dep, cookie)).status), `${label}: private media`);
    const pv = (await G.api('POST', '/api/vods', { cookie, body: { url: 'https://youtu.be/abcdefghijk', title: 'x', type: 'Wargame', recordedDate: day(-1), enemyGuild: 'Rivals' } })).status;
    v.want(denied(pv) || pv === 404, `${label}: post VOD -> ${pv}`);
    const sv = await G.api('GET', '/api/state', { cookie });
    v.want(sv.status === 401 || !(sv.json.vods || []).length, `${label}: still lists VODs ${sv.json && JSON.stringify((sv.json.vods || []).map((x) => x.id))}`);
    v.want(denied((await G.api('DELETE', '/api/vods/902', { cookie })).status), `${label}: deletes own VOD`);
  }
  // its character is marked Inactive by an officer (as players who left usually are): still no content character
  const m = (await stateOf(S.OFF)).members.find((x) => x.id === 803);
  assert.equal((await G.api('PUT', '/api/members/803', { cookie: S.OFF, body: { ...m, active: false } })).status, 200);
  const off = await stateOf(S.OFF);
  v.want(off.members.find((x) => x.id === 803).content === false, 'departed + inactive counted as content character');
  v.want(!((await stateOf(S.COACH)).myStudents || []).includes(U.DEP), 'departed player still a student');
  v.want(!(await stateOf(S.COACH)).vods.some((x) => x.id === 902), 'class coach still sees departed player\'s private VOD');
  v.done();
});

test('B4 forged or stale claims cannot use the rule: a token for a key with no record, or claiming member/officer, gets nothing', async () => {
  // signed with the real secret (models a stale cookie, not a forgery): the account has no record, the claims say officer
  const cookie = G.mint({ key: U.OUT, name: 'Nobody', role: 'officer', coach: true, discord: true, exp: Date.now() + 3600e3 });
  for (const auth of [{ cookie }, { bearer: bearerOf(cookie) }]) {
    const p = await contentProbe(auth, 903, 804, MEDIA.loa);
    for (const [k, s] of Object.entries(p)) if (k !== 'stateVods' && s !== null) assert.equal(s, 401, `${JSON.stringify(Object.keys(auth))}: ${k}`);
  }
});

test('B5 B04 guest-coach rules unchanged for an Inactive (leave) student', async () => {
  const v = violations();
  const g = await stateOf(S.GUEST);
  const gv = (g.vods || []).find((x) => x.id === 903);
  v.want(!!gv, 'guest coach of the class sees the leave student\'s VOD');
  v.want(gv && gv.canManage === false && gv.canAnnotate === true, `guest flags ${gv && JSON.stringify({ m: gv.canManage, a: gv.canAnnotate })}`);
  v.want((await G.api('PUT', '/api/vods/903', { cookie: S.GUEST, body: { title: 'x' } })).status === 403, 'guest edits the recording');
  v.want((await G.api('PUT', '/api/vods/903', { cookie: S.GUEST, body: { visibility: 'everyone' } })).status === 403, 'guest re-shares the recording');
  v.want((await G.api('DELETE', '/api/vods/903', { cookie: S.GUEST })).status === 403, 'guest deletes the recording');
  v.want((await G.api('PUT', '/api/vods/903/markers/911', { cookie: S.GUEST, body: { note: 'mine now' } })).status === 403, 'guest edits the coach\'s point');
  v.want((await G.api('DELETE', '/api/vods/903/markers/911', { cookie: S.GUEST })).status === 403, 'guest deletes the coach\'s point');
  v.want((await G.api('POST', '/api/vods/903/markers', { cookie: S.GUEST, body: { timestamp: 7, beforeSeconds: 2, afterSeconds: 2, note: 'guest', strokes: [] } })).status === 200, 'guest adds a point');
  v.want(denied((await G.api('GET', '/api/gearthreads/804', { cookie: S.GUEST })).status), 'guest opens a gear thread');
  v.want(!((await stateOf(S.GUESTX)).vods || []).some((x) => x.id === 903), 'guest of another class sees it');
  v.want(denied((await G.api('POST', '/api/vods/903/reviews', { cookie: S.GUESTX, body: { note: 'x' } })).status), 'guest of another class reviews it');
  v.want((await stateOf(S.GUEST)).user.role === 'applicant', 'guest coach became a member');
  v.done();
});

test('B6 GH-01 private media of the leave player, all three prefixes: exactly the old matrix', async () => {
  const v = violations();
  const want = { LOA: 200, OFF: 200, COACH: 200, MEMBER: 403, GUEST: 403, GUESTX: 403 };
  for (const name of [MEDIA.loa, MEDIA.loaThumb, MEDIA.loaFolder]) {
    for (const [who, code] of Object.entries(want)) {
      const r = await media(name, S[who]);
      v.want(r.status === code, `${name} as ${who} -> ${r.status} (want ${code})`);
      if (r.status === 200) v.want(/private/.test(r.cache) && /no-store/.test(r.cache), `${name} as ${who}: cache-control ${r.cache}`);
    }
    v.want((await media(name, null)).status === 401, `${name} anonymous`);
    v.want((await media(name, S.KICK)).status === 401, `${name} with the kicked player's revoked session`);
  }
  v.done();
});
