// GuildHub 1.46.2-hotfix.3 - Phase D adversarial attacks on the B04 guest-coach invitation fix (Agent 4).
// Each test asserts the SECURE / contract behaviour. A failing test is a CONFIRMED finding (repro = the test body);
// a passing test means the attack was defended. "precondition:" asserts mark harness problems, never findings.
// Fictional data only; the server, fake Discord and temp dir are removed in after().
//
// Order matters (one server): X12 (flood guard) runs last because it blocks invitation starts from 127.0.0.1 for
// 10 minutes; X07 (import) wipes guest coaches / VODs, so it runs after the permission tests.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startGuild, newInviteToken, png } = require('./hf2-helpers');

const GUILD = '111111111111111111', ALLIANCE = '222222222222222222', ALLY_ROLE = '910000000000000001';
const SECRET = 'b04-phaseD-attack-secret-not-real';
const T = '2026-10-01T18:00:00.000Z';
const H72 = 72 * 3600e3;
const id = (n) => '5000000000000000' + String(n).padStart(2, '0');
const U = { OFF: id(1), COR: id(2), STUDENT: id(3), STUDENT2: id(4), LEG: id(5), KM: id(6),
  // invite-made guest coaches and fresh outsiders, one per scenario
  N: Array.from({ length: 10 }, (_, i) => id(20 + i)), SAME: id(31), RVK: id(32), XS1: id(33), XS2: id(34), ERR: id(35), ALLY: id(36), MERCM: id(37),
  GP: id(40), GA: id(41), GK: id(42), GF: id(43), GO: id(44), VICTIM: id(45), RESTORE: id(46), AFTER: id(47), IMP: id(48), FLOOD: id(49) };
const BW = { primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow' }, BZ = { primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Daggers' };
const MEDIA = { shot: 'gearshot-aaaabbbbcccc.png', thumb: 'gearthumb-ddddeeeeffff.png', folder: 'gearfolder-111122223333.png' };
const user = (uid, name, extra = {}) => ({ id: uid, name, username: name.toLowerCase(), avatar: '', role: 'member', inGuild: true, accepted: true, ...extra });
const char = (mid, owner, name, extra = {}) => ({ id: mid, owner, name, role: 'DPS', active: true, ...BW, joinedAt: T, builds: [], ...extra });
const vod = (vid, owner, extra = {}) => ({ id: vid, owner, postedBy: owner, postedAt: T, title: 'Wargame 01.10.2026', type: 'Wargame', recordedDate: '2026-10-01', enemyGuild: '', note: 'n' + vid,
  url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', visibility: 'private', visibleClass: '', reviews: [], finished: false, ...extra });

function seed() {
  return {
    nextId: 30000,
    users: { [U.OFF]: user(U.OFF, 'Officer'), [U.COR]: user(U.COR, 'Regcoach', { coach: true }), [U.STUDENT]: user(U.STUDENT, 'Student'), [U.STUDENT2]: user(U.STUDENT2, 'Studenttwo'),
      [U.KM]: user(U.KM, 'Member'), [U.LEG]: user(U.LEG, 'Legacyguest', { role: 'applicant', applicant: true, accepted: false, inGuild: false, coach: true }) },
    members: [char(501, U.OFF, 'Offchar'), char(502, U.COR, 'Corchar', BZ), char(503, U.STUDENT, 'Studchar'), char(504, U.STUDENT2, 'Studtwochar', BZ), char(506, U.KM, 'Kmchar')],
    coachLinks: [{ id: 801, coach: U.COR, class: 'Battleweaver', linkedAt: T }, { id: 802, coach: U.LEG, class: 'Battleweaver', linkedAt: T }],
    guestCoaches: [{ id: 850, discordId: U.LEG, name: 'Legacyguest', avatar: '', addedAt: T }],
    vods: [601, 602, 603, 604].map((n) => vod(n, U.STUDENT)).concat([vod(701, U.STUDENT2)]),
    vodMarkers: [{ id: 9102, vodId: 601, createdBy: U.COR, createdAt: T, timestamp: 20, beforeSeconds: 2, afterSeconds: 2, note: 'regular coach point', strokes: [] }],
    gearScreens: [{ id: 901, memberId: 503, sectionId: 1, images: [MEDIA.shot], previews: { [MEDIA.shot]: MEDIA.thumb }, note: '', updatedAt: T }],
    gearFolder: [{ id: 903, memberId: 503, buildKey: 'main', postedBy: U.OFF, postedByName: 'Officer', at: T, kind: 'image', text: '', url: '', image: MEDIA.folder }],
    gearSectionTypes: [{ id: 1, label: 'Gear' }],
    settings: { coachUserIds: [U.COR], officerUserIds: [], applications: { enabled: false }, branding: {} },
    events: [], points: [],
  };
}
seed.reviews = { 601: [{ id: 9202, by: U.COR, at: T, note: 'regular coach review' }] };

let G; const S = {};
const denied = (s) => s === 401 || s === 403;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const violations = () => { const v = []; return { want: (c, m) => { if (!c) v.push(m); }, done: () => assert.deepEqual(v, [], 'violations:\n' + v.join('\n')) }; };
const SECRETS = [];
async function createInvite(cls = 'Battleweaver') {
  const r = await G.api('POST', '/api/admin/guest-invites', { cookie: S.OFF, body: { class: cls } });
  assert.equal(r.status, 200, 'precondition: create invite ' + r.text.slice(0, 120));
  const token = /#\/guest-invite\/([A-Za-z0-9_-]{43})$/.exec(r.json.link)[1];
  SECRETS.push(token, crypto.createHash('sha256').update(token).digest('hex'));
  return { id: r.json.invite.id, token };
}
const invites = async () => (await G.api('GET', '/api/admin/guest-invites', { cookie: S.OFF })).json;
const inviteById = async (iid) => (await invites()).find((x) => x.id === iid) || {};
const exportDb = async () => { const r = await G.api('GET', '/api/export', { cookie: S.OFF }); assert.equal(r.status, 200, 'precondition: export'); return r.json; };
async function guestOf(key) { const d = await exportDb(); return { recs: d.guestCoaches.filter((g) => g.discordId === key), links: d.coachLinks.filter((l) => l.coach === key) }; }
async function newGuest(key, cls = 'Battleweaver') {
  const inv = await createInvite(cls);
  const r = await G.inviteLogin(inv.token, key);
  assert.ok(r.cookie, `precondition: ${key} redeems an invitation (${r.begin.why}, ${r.loginError})`);
  return r.cookie;
}
const plainBegin = async (q = '') => {
  const s0 = await fetch(G.base + '/auth/discord' + q, { redirect: 'manual' });
  return { jar: s0.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; '), state: new URL(s0.headers.get('location')).searchParams.get('state') };
};
const marker = (note) => ({ timestamp: 30, beforeSeconds: 2, afterSeconds: 2, note, strokes: [{ color: '#22aa44', points: [[0.2, 0.2], [0.4, 0.6]] }] });

before(async () => {
  const s = seed();
  for (const [vid, rv] of Object.entries(seed.reviews)) s.vods.find((v) => v.id === Number(vid)).reviews = rv;
  G = await startGuild({ seed: s, secret: SECRET, guild: GUILD, alliance: ALLIANCE, uploads: { [MEDIA.shot]: png(1), [MEDIA.thumb]: png(2), [MEDIA.folder]: png(3) },
    env: { DISCORD_OFFICER_USER_IDS: U.OFF, ALLIANCE_OFFICER_ROLE_IDS: ALLY_ROLE } });
  S.OFF = await G.login(U.OFF);
});
after(async () => { if (G) await G.close(); });

test('X10 migration is idempotent: two restarts keep the legacy record (only `via` added), its coach link, no duplicates', async () => {
  await G.restart(); await G.restart();
  const d = await exportDb();
  const v = violations();
  const recs = d.guestCoaches.filter((g) => g.discordId === U.LEG);
  v.want(recs.length === 1, `legacy records: ${recs.length}`);
  assert.deepEqual(recs[0], { id: 850, discordId: U.LEG, name: 'Legacyguest', avatar: '', addedAt: T, via: 'legacy' });
  v.want(d.coachLinks.filter((l) => l.coach === U.LEG).length === 1 && d.coachLinks.some((l) => l.id === 802 && l.class === 'Battleweaver'), 'legacy coach link changed/duplicated');
  v.want(Array.isArray(d.guestCoachInvites), 'guestCoachInvites list missing after migration');
  v.done();
});

test('X01 ten concurrent begin+callback pairs on one invitation (different Discord ids) -> exactly one guest coach', async () => {
  const inv = await createInvite();
  const begins = [];
  for (let i = 0; i < 10; i++) begins.push(await G.inviteBegin(inv.token));
  assert.ok(begins.every((b) => b.ok), 'precondition: all 10 begins bound');
  for (const k of U.N) G.setMember(GUILD, k, null);
  const res = await Promise.all(begins.map((b, i) => fetch(`${G.base}/auth/discord/callback?code=${U.N[i]}&state=${b.state}`, { redirect: 'manual', headers: { Cookie: b.jar } })));
  const sessions = res.filter((r) => r.headers.getSetCookie().some((c) => /^gh_session=[^;]/.test(c))).length;
  const d = await exportDb();
  const v = violations();
  const winners = d.guestCoaches.filter((g) => U.N.includes(g.discordId));
  v.want(winners.length === 1, `guest coaches created: ${winners.length}`);
  v.want(d.coachLinks.filter((l) => U.N.includes(l.coach)).length === 1, 'coach links created != 1');
  v.want(sessions === 1, `sessions issued: ${sessions}`);
  v.want((await inviteById(inv.id)).status === 'redeemed', 'invite not redeemed');
  v.done();
});

test('X02 one Discord account redeems two invitations concurrently -> one guest record, one class link, the other invite stays pending', async () => {
  const a = await createInvite('Battleweaver'), b = await createInvite('Berserker');
  const ba = await G.inviteBegin(a.token), bb = await G.inviteBegin(b.token);
  assert.ok(ba.ok && bb.ok, 'precondition: both bound');
  G.setMember(GUILD, U.SAME, null);
  const fire = (x) => fetch(`${G.base}/auth/discord/callback?code=${U.SAME}&state=${x.state}`, { redirect: 'manual', headers: { Cookie: x.jar } });
  await Promise.all([fire(ba), fire(bb)]);
  const g = await guestOf(U.SAME);
  const v = violations();
  v.want(g.recs.length === 1, `guest records for one account: ${g.recs.length}`);
  v.want(g.links.length === 1, `class links for one account: ${g.links.length} (${g.links.map((l) => l.class)})`);
  const sa = (await inviteById(a.id)).status, sb = (await inviteById(b.id)).status;
  v.want([sa, sb].sort().join() === 'pending,redeemed', `invite statuses ${sa}/${sb} (want one redeemed, one pending)`);
  v.done();
});

test('X03 redeem vs revoke race: never "revoked" together with a new guest coach', async () => {
  const v = violations();
  for (let i = 0; i < 3; i++) {
    const inv = await createInvite();
    const b = await G.inviteBegin(inv.token);
    assert.ok(b.ok, 'precondition: bound');
    const who = id(60 + i);
    const [cb, rv] = await Promise.all([G.inviteCallback(b, who), G.api('DELETE', `/api/admin/guest-invites/${inv.id}`, { cookie: S.OFF })]);
    const st = (await inviteById(inv.id)).status, g = await guestOf(who);
    v.want((st === 'redeemed' && g.recs.length === 1 && rv.status === 409 && !!cb.cookie) || (st === 'revoked' && g.recs.length === 0 && rv.status === 200 && !cb.cookie),
      `round ${i}: status ${st}, revoke ${rv.status}, guest records ${g.recs.length}, session ${!!cb.cookie}`);
  }
  v.done();
});

test('X04a state binding: a begun state with another begin\'s gh_oauth cookie is refused; both invitations stay pending', async () => {
  const a = await createInvite(), b = await createInvite();
  const ba = await G.inviteBegin(a.token), bb = await G.inviteBegin(b.token);
  const r = await G.inviteCallback(ba, U.XS1, { cookie: bb.jar });
  const v = violations();
  v.want(!r.cookie && (await guestOf(U.XS1)).recs.length === 0, 'state/cookie mismatch still redeemed or signed in');
  v.want((await inviteById(a.id)).status === 'pending' && (await inviteById(b.id)).status === 'pending', 'an invitation was consumed by a mismatched callback');
  v.done();
});

test('X04b callback with error=access_denied after begin: invitation stays pending AND the state is dead afterwards', async () => {
  const inv = await createInvite();
  const b = await G.inviteBegin(inv.token);
  assert.ok(b.ok, 'precondition: bound');
  const cancel = await fetch(`${G.base}/auth/discord/callback?error=access_denied&state=${b.state}`, { redirect: 'manual', headers: { Cookie: b.jar } });
  assert.match(cancel.headers.get('location') || '', /loginError/, 'precondition: cancel shows an error');
  const v = violations();
  v.want((await inviteById(inv.id)).status === 'pending', 'cancel consumed the invitation');
  // replay the same state (cookie value kept by the attacker / a second tab) with a real code
  const r = await G.inviteCallback(b, U.ERR);
  v.want(!r.cookie && (await guestOf(U.ERR)).recs.length === 0, `the state survived the cancelled callback and redeemed the invitation afterwards (session ${!!r.cookie}, guest records ${(await guestOf(U.ERR)).recs.length})`);
  v.done();
});

test('X04c alliance / mercenary cookies injected into an invitation callback grant nothing extra and consume nothing', async () => {
  const v = violations();
  const inv = await createInvite();
  const b = await G.inviteBegin(inv.token);
  G.setMember(ALLIANCE, U.ALLY, [ALLY_ROLE]);
  const cb = await fetch(`${G.base}/auth/discord/callback?code=${U.ALLY}&state=${b.state}`, { redirect: 'manual', headers: { Cookie: b.jar + '; gh_alliance=1' } });
  v.want((await guestOf(U.ALLY)).recs.length === 0, 'alliance-flagged callback made a guest coach');
  v.want((await inviteById(inv.id)).status === 'pending', `alliance-flagged callback consumed the invitation (${cb.status})`);
  // member + gh_merc=1 still refused (merc must not bypass eligibility)
  const b2 = await G.inviteBegin(inv.token);
  const r = await G.inviteCallback(b2, U.KM, { inGuild: true, cookie: b2.jar + '; gh_merc=1' });
  v.want(!!r.loginError && (await guestOf(U.KM)).recs.length === 0, `member with gh_merc=1 redeemed (loginError ${r.loginError})`);
  // begin while already signed in as a member: still refused at the callback
  const km = await G.login(U.KM);
  const b3 = await G.inviteBegin(inv.token, { headers: { Cookie: km } });
  const r3 = await G.inviteCallback(b3, U.KM, { inGuild: true, cookie: b3.jar + '; ' + km });
  v.want(!r3.cookie && (await guestOf(U.KM)).recs.length === 0, 'signed-in member redeemed');
  v.want((await inviteById(inv.id)).status === 'pending', 'invitation consumed by a refused account');
  v.done();
});

test('X05 privilege: guest in coachUserIds stays restricted; Admin coach-link refused; officer then removed; private media, gear, alliance, export, audit refused', async () => {
  const c = await newGuest(U.GP);
  const v = violations();
  // regular-coach list does not lift guest restrictions
  assert.equal((await G.api('PUT', '/api/admin/coaches', { cookie: S.OFF, body: { userIds: [U.COR, U.GP] } })).status, 200, 'precondition: coach list');
  for (const [m, p, body] of [['PUT', '/api/vods/601/markers/9102', marker('x')], ['DELETE', '/api/vods/601/markers/9102'], ['PUT', '/api/vods/602', { note: 'x' }], ['PUT', '/api/vods/602', { visibility: 'everyone' }], ['DELETE', '/api/vods/602']]) {
    const r = await G.api(m, p, { cookie: c, body }); v.want(r.status === 403, `guest+coachUserIds ${m} ${p} -> ${r.status}`);
  }
  const s = await G.api('GET', '/api/state', { cookie: c });
  v.want(!(s.json.vods || []).some((x) => x.id === 701), 'guest+coachUserIds sees other-class VOD');
  assert.equal((await G.api('PUT', '/api/admin/coaches', { cookie: S.OFF, body: { userIds: [U.COR] } })).status, 200, 'precondition: coach list restored');
  const cl = await G.api('POST', '/api/admin/coach-links', { cookie: S.OFF, body: { coach: U.GP, class: 'Berserker' } });
  v.want(cl.status === 409, `Admin coach-link for a guest coach -> ${cl.status} (want 409)`);
  // gear, private uploads, alliance, export, audit
  for (const [m, p] of [['GET', '/api/gearthreads/503'], ['GET', '/api/gearthreads/503/chat'], ['GET', '/api/export'], ['GET', '/api/admin/audit'], ['GET', '/api/alliance/context'], ['GET', '/api/alliance/permissions'], ['GET', '/api/admin/guest-invites']]) {
    const r = await G.api(m, p, { cookie: c }); v.want(denied(r.status), `guest ${m} ${p} -> ${r.status}`);
  }
  for (const f of Object.values(MEDIA)) { const r = await fetch(G.base + '/uploads/' + f, { headers: { Cookie: c } }); v.want(denied(r.status), `guest private upload ${f} -> ${r.status}`); }
  // officer, then removed: back to guest restrictions with a fresh session; old officer session dead
  assert.equal((await G.api('PUT', '/api/admin/officers', { cookie: S.OFF, body: { userIds: [U.GP] } })).status, 200, 'precondition: made officer');
  const asOff = await G.api('GET', '/api/admin/guest-invites', { cookie: c });
  v.want(asOff.status === 200, `guest made officer cannot use officer routes (${asOff.status}) - expected live officer rights`);
  assert.equal((await G.api('PUT', '/api/admin/officers', { cookie: S.OFF, body: { userIds: [] } })).status, 200, 'precondition: officer removed');
  v.want((await G.api('GET', '/api/state', { cookie: c })).status === 401, 'session survived officer removal');
  const c2 = await G.login(U.GP, [], { inGuild: false });
  v.want((await G.api('DELETE', '/api/vods/602', { cookie: c2 })).status === 403, 'ex-officer guest can delete a VOD');
  v.want((await G.api('POST', '/api/admin/guest-invites', { cookie: c2, body: { class: 'Battleweaver' } })).status === 403, 'ex-officer guest can create invitations');
  v.done();
});

test('X05b guest coach kicked: sessions end; a later sign-in reaches no VODs and cannot redeem', async () => {
  const c = await newGuest(U.GK);
  assert.ok(((await G.api('GET', '/api/state', { cookie: c })).json.vods || []).some((x) => x.id === 601), 'precondition: sees 601');
  assert.equal((await G.api('POST', '/api/admin/kick', { cookie: S.OFF, body: { ownerKey: U.GK } })).status, 200, 'precondition: kick');
  const v = violations();
  v.want((await G.api('GET', '/api/state', { cookie: c })).status === 401, 'kicked guest session still valid');
  const c2 = await G.login(U.GK, [], { inGuild: false, expectCookie: false });
  // lead (Phase D fix): with applications closed (this suite's default) a kicked guest coach is no longer let through
  const appsOpen = !!((await G.api('GET', '/api/export', { cookie: S.OFF })).json.settings.applications || {}).enabled;
  if (!appsOpen) v.want(!c2, 'kicked guest coach got a session although applications are closed');
  if (c2) {
    const s = await G.api('GET', '/api/state', { cookie: c2 });
    v.want(!(s.json.vods || []).length, `kicked guest re-signed-in sees VODs ${(s.json.vods || []).map((x) => x.id)}`);
    v.want((await G.api('POST', '/api/vods/601/reviews', { cookie: c2, body: { note: 'x' } })).status === 403, 'kicked guest can review');
  }
  v.done();
});

test('X06 guest coach applies and is accepted: guest restrictions still hold (no VOD delete/edit, no other class)', async () => {
  const c = await newGuest(U.GA);
  assert.equal((await G.api('PUT', '/api/admin/discord', { cookie: S.OFF, body: { applications: { enabled: true } } })).status, 200, 'precondition: open applications');
  try {
    const ap = await G.api('POST', '/api/applications', { cookie: c, body: { characterName: 'Gachar', role: 'DPS', ...BZ, about: 'I coach and want to join too.' } });
    assert.equal(ap.status, 200, 'precondition: application ' + ap.text);
    assert.equal((await G.api('PUT', `/api/applications/${ap.json.id}`, { cookie: S.OFF, body: { decision: 'accept' } })).status, 200, 'precondition: accepted');
  } finally { await G.api('PUT', '/api/admin/discord', { cookie: S.OFF, body: { applications: { enabled: false } } }); }
  const v = violations();
  const outsiderState = await G.api('GET', '/api/state', { cookie: c });
  v.want(outsiderState.json.user.role === 'applicant', 'accepted guest is still an outsider until joining Discord');
  await G.login(U.GA); // explicit Discord membership, without removing the B04 guest record
  const s = await G.api('GET', '/api/state', { cookie: c });
  v.want(s.status === 200 && s.json.user.role === 'member', `precondition-ish: accepted guest role ${s.json && s.json.user && s.json.user.role}`);
  for (const [m, p, body] of [['DELETE', '/api/vods/603'], ['PUT', '/api/vods/603', { note: 'x' }], ['PUT', '/api/vods/601/markers/9102', marker('x')], ['POST', '/api/vods/701/reviews', { note: 'x' }], ['POST', '/api/vods/701/markers', marker('x')]]) {
    const r = await G.api(m, p, { cookie: c, body }); v.want(r.status === 403, `accepted guest ${m} ${p} -> ${r.status}`);
  }
  // own VOD of the new member (Berserker character, not the coached class): the member must at least see their own VOD
  const own = await G.api('POST', '/api/vods', { cookie: c, body: { owner: U.GA, url: 'https://youtu.be/zyxwvutsrqp', type: 'Wargame', recordedDate: '2026-10-02' } });
  v.want(own.status === 200, `accepted guest posts own VOD -> ${own.status}`);
  if (own.status === 200) {
    const s2 = await G.api('GET', '/api/state', { cookie: c });
    v.want((s2.json.vods || []).some((x) => x.id === own.json.id), `FUNCTIONAL: accepted member who is also a guest coach cannot see their OWN VOD #${own.json.id} (canSeeVod guest branch short-circuits owner check)`);
  }
  v.done();
});

test('X09 UI flags match server enforcement for a guest coach (canManage/canPromote/canAnnotate/canReview, marker.canEdit, review.canEdit/canDelete)', async () => {
  const c = await newGuest(U.GF);
  const mine = await G.api('POST', '/api/vods/604/markers', { cookie: c, body: marker('mine') });
  const myRv = await G.api('POST', '/api/vods/604/reviews', { cookie: c, body: { note: 'mine' } });
  const cor = await G.login(U.COR);
  const corRv = await G.api('POST', '/api/vods/604/reviews', { cookie: cor, body: { note: 'coach' } });
  const corMk = await G.api('POST', '/api/vods/604/markers', { cookie: cor, body: marker('coach') });
  assert.ok([mine, myRv, corRv, corMk].every((r) => r.status === 200), 'precondition: fixtures');
  const st = await G.api('GET', '/api/state?vod=604', { cookie: c });
  const vv = (st.json.vods || []).find((x) => x.id === 604);
  assert.ok(vv, 'precondition: guest sees 604');
  const v = violations();
  const check = (flag, r, what) => v.want(flag ? r.status === 200 : r.status === 403, `${what}: UI flag ${flag} but server -> ${r.status}`);
  const mkMine = vv.markers.find((m) => m.id === mine.json.id), mkCor = vv.markers.find((m) => m.id === corMk.json.id);
  const rvMine = vv.reviews.find((r) => r.id === myRv.json.id), rvCor = vv.reviews.find((r) => r.id === corRv.json.id);
  check(mkCor && mkCor.canEdit, await G.api('PUT', `/api/vods/604/markers/${corMk.json.id}`, { cookie: c, body: marker('x') }), 'other marker PUT');
  check(mkCor && mkCor.canEdit, await G.api('DELETE', `/api/vods/604/markers/${corMk.json.id}`, { cookie: c }), 'other marker DELETE');
  check(rvCor && rvCor.canEdit, await G.api('PUT', `/api/vods/604/reviews/${corRv.json.id}`, { cookie: c, body: { note: 'x' } }), 'other review PUT');
  check(rvCor && rvCor.canEdit, await G.api('POST', `/api/vods/604/reviews/${corRv.json.id}/resend`, { cookie: c }), 'other review resend');
  check(rvCor && rvCor.canDelete, await G.api('DELETE', `/api/vods/604/reviews/${corRv.json.id}`, { cookie: c }), 'other review DELETE');
  check(vv.canPromote, await G.api('PUT', '/api/vods/604', { cookie: c, body: { visibility: 'everyone' } }), 'visibility');
  check(vv.canManage, await G.api('PUT', '/api/vods/604', { cookie: c, body: { note: 'x' } }), 'note');
  check(vv.canAnnotate, await G.api('POST', '/api/vods/604/markers', { cookie: c, body: marker('y') }), 'add marker');
  check(vv.canReview, await G.api('PUT', '/api/vods/604/finished', { cookie: c, body: { finished: true } }), 'finished');
  check(mkMine && mkMine.canEdit, await G.api('PUT', `/api/vods/604/markers/${mine.json.id}`, { cookie: c, body: marker('z') }), 'own marker PUT');
  check(rvMine && rvMine.canEdit, await G.api('POST', `/api/vods/604/reviews/${myRv.json.id}/resend`, { cookie: c }), 'own review resend');
  check(rvMine && rvMine.canDelete, await G.api('DELETE', `/api/vods/604/reviews/${myRv.json.id}`, { cookie: c }), 'own review DELETE');
  check(mkMine && mkMine.canEdit, await G.api('DELETE', `/api/vods/604/markers/${mine.json.id}`, { cookie: c }), 'own marker DELETE');
  check(vv.canManage, await G.api('DELETE', '/api/vods/604', { cookie: c }), 'VOD DELETE');
  const other = await G.api('POST', '/api/vods', { cookie: c, body: { owner: U.STUDENT2, url: 'https://youtu.be/zyxwvutsrqp', type: 'Wargame', recordedDate: '2026-10-02' } });
  v.want(other.status === 403, `POST /api/vods for another class's player -> ${other.status}`);
  v.done();
});

test('X11 token leakage: refusal messages, begin location, audit entries, officer/support state and logs carry no token or hash', async () => {
  const inv = await createInvite();
  const v = violations();
  const b = await G.inviteBegin(inv.token);
  v.want(!b.text.includes(inv.token), 'begin response echoes the token');
  const bad = await G.inviteBegin(inv.token.slice(0, 42) + 'Q');
  v.want(!bad.text.includes(inv.token.slice(0, 20)), 'refusal echoes the submitted token');
  const big = await G.inviteBegin('Z'.repeat(5000));
  v.want(!big.text.includes('ZZZZZZZZ'), 'refusal echoes a long submitted value');
  await G.inviteCallback(b, U.GO);
  await G.api('DELETE', `/api/admin/guest-invites/${(await createInvite()).id}`, { cookie: S.OFF });
  const gen = await G.api('POST', '/api/admin/support-access/generate', { cookie: S.OFF });
  const sl = await G.api('POST', '/api/support/login', { body: { username: 'SupportAI', code: gen.json.code } });
  const sup = sl.headers.get('set-cookie').split(';')[0];
  const texts = {
    'audit log': (await G.api('GET', '/api/admin/audit?limit=200', { cookie: S.OFF })).text,
    'officer state': (await G.api('GET', '/api/state', { cookie: S.OFF })).text,
    'support state': (await G.api('GET', '/api/state', { cookie: sup })).text,
    'support audit': (await G.api('GET', '/api/admin/audit?limit=200', { cookie: sup })).text,
    'diagnostics': (await G.api('GET', '/api/admin/diagnostics', { cookie: S.OFF })).text,
    export: (await G.api('GET', '/api/export', { cookie: S.OFF })).text,
    'server logs': G.logs.join(''),
  };
  await G.api('POST', '/api/admin/support-access/revoke', { cookie: S.OFF });
  for (const [what, t] of Object.entries(texts)) for (const s of SECRETS) if (t.includes(s)) { v.want(false, `${what} contains a ${s.length === 64 ? 'tokenHash' : 'raw token'}`); break; }
  v.want(!/tokenHash/.test(texts.export), 'export carries tokenHash');
  const sw = fs.existsSync(path.join(__dirname, '..', 'public', 'sw.js')) ? fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8') : '';
  v.want(!/guest-invite/.test(sw), 'service worker caches invitation URLs');
  v.done();
});

test('X08 newer Ledger refuses unknown pending invitations restored in old db.json; fresh invitations remain usable', async () => {
  const old = newInviteToken(), old2 = newInviteToken();
  SECRETS.push(old.token, old.tokenHash, old2.token, old2.tokenHash);
  const created = Date.now() - 3600e3;
  const rec = (iid, x) => ({ id: iid, tokenHash: x.tokenHash, class: 'Battleweaver', createdBy: U.OFF, createdByName: 'Officer', createdAt: new Date(created).toISOString(), expiresAt: new Date(created + H72).toISOString(), status: 'pending' });
  await G.editDb((d) => { d.guestCoachInvites.push(rec(8801, old), rec(8802, old2)); });     // simulates restoring an older DATA_DIR
  const v = violations();
  const r1 = await G.inviteLogin(old.token, U.RESTORE);
  v.want(!r1.cookie && r1.begin.status === 400, 'unknown restored pending invitation must not redeem');
  await G.restart({ SESSIONS_VALID_AFTER: new Date().toISOString() });
  S.OFF = await G.login(U.OFF);
  v.want(!(await inviteById(8802)).id, 'untrusted restored invitation must not enter the authoritative policy');
  const r2 = await G.inviteBegin(old2.token);
  v.want(r2.status === 400, `restored invite after SESSIONS_VALID_AFTER: begin -> ${r2.status}`);
  const fresh = await createInvite();
  const r3 = await G.inviteLogin(fresh.token, U.AFTER);
  v.want(!!r3.cookie, 'invite created after SESSIONS_VALID_AFTER does not work');
  await G.restart();
  S.OFF = await G.login(U.OFF);
  v.done();
});

test('X16 pending-binding eviction: 2000 begins with one valid token evict another invitee\'s in-flight binding', async () => {
  const mine = await createInvite(), victim = await createInvite();
  const vb = await G.inviteBegin(victim.token);
  assert.ok(vb.ok, 'precondition: victim bound');
  const batch = 50;
  for (let i = 0; i < 2000; i += batch) await Promise.all(Array.from({ length: batch }, () => G.inviteBegin(mine.token)));
  const r = await G.inviteCallback(vb, U.VICTIM);
  const v = violations();
  v.want(!!r.cookie && (await guestOf(U.VICTIM)).recs.length === 1, `victim's in-flight redemption was evicted by another invitee's begin flood (loginError: ${r.loginError}); invitation status ${(await inviteById(victim.id)).status}`);
  v.done();
});

test('X07 import of an export: old invitation links stop working (hash stripped); nothing revives them', async () => {
  const inv = await createInvite();
  const ex = await exportDb();
  v0: {
    const r = await G.api('POST', '/api/import', { cookie: S.OFF, body: ex });
    assert.equal(r.status, 200, 'precondition: import ' + r.text.slice(0, 100));
  }
  const v = violations();
  const b = await G.inviteBegin(inv.token);
  v.want(b.status === 400, `old link after importing an export -> ${b.status}`);
  const after0 = await exportDb();
  v.want(!JSON.stringify(after0).includes(inv.token), 'token present after import');
  v.done();
});

test('X12 per-IP flood guard: 200 failures lock out a valid invitation from the same IP (documented DoS trade-off)', async () => {
  const inv = await createInvite();
  let last;
  for (let i = 0; i < 205; i++) last = await G.inviteBegin(crypto.randomBytes(32).toString('base64url'));
  assert.equal(last.status, 429, 'precondition: guard engaged at 200 failures, got ' + last.status);
  const r = await G.inviteBegin(inv.token);
  // Lead decision (documented trade-off, release notes C): the guard is per client IP and blocks that IP for 10 min,
  // valid tokens included. It only matters where many invitees share one IP (TRUSTED_PROXIES unset). The invitation
  // itself is not consumed or changed by the flood - asserted here, together with the documented 429.
  assert.equal(r.status, 429, `documented: a flooded IP is blocked for 10 min, valid invitations included (got ${r.status})`);
  const list = (await G.api('GET', '/api/admin/guest-invites', { cookie: S.OFF })).json;
  assert.equal(list.find((x) => x.id === inv.id).status, 'pending', 'the flood did not consume or revoke the invitation');
});
