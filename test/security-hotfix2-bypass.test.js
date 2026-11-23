// GuildHub 1.46.2-hotfix.2 - Phase D bypass attempts against the INTEGRATED build (Agent 4).
// Each test asserts the SECURE behaviour. A failing test is a CONFIRMED finding with its repro in the test body;
// a passing test means the attack was defended. Preconditions use "precondition:" asserts so harness problems are
// never mistaken for findings. Fictional data only; all servers / temp dirs are cleaned up in after().
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startGuild, poll, png, pendingRequest } = require('./hf2-helpers');

const GUILD = '111111111111111111', ALLIANCE = '222222222222222222';
const OFFICER_ROLE = '900000000000000001', ALLY_ROLE = '910000000000000001';
const SECRET = 'hf2-agent4-phaseD-secret-not-real';
const T = '2026-10-01T18:00:00.000Z';
const id = (n) => '2000000000000000' + String(n).padStart(2, '0');
const U = { OFF: id(1), KM: id(2), OFFL: id(3), LO: id(4), COR: id(5), STUDENT: id(6), RANDO: id(7), LEFT: id(8), KR: id(9), RACE: id(10), OFFR: id(11),
  GC: id(12), DUP: id(14), IAT: id(15), LEG: id(16), MEDIA: id(17), RACE2: id(18), CONC: id(19) };
const PARTNER = '300000000000000011';
const BW = { primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow' };
const user = (uid, name, extra = {}) => ({ id: uid, name, username: name.toLowerCase(), avatar: '', role: 'member', inGuild: true, accepted: true, ...extra });
const char = (mid, owner, name, extra = {}) => ({ id: mid, owner, name, role: 'DPS', active: true, ...BW, joinedAt: T, builds: [], ...extra });
const vod = (vid, owner, title) => ({ id: vid, owner, postedBy: owner, title, url: 'https://www.youtube.com/watch?v=abcdefghijk', youtubeId: 'abcdefghijk', visibility: 'private', reviews: [], at: T });
const MEDIA_FILE = 'gearshot-feedfacecafe.png';
const keys = crypto.generateKeyPairSync('ed25519');
const PUBKEY_HEX = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

function seed() {
  const users = {};
  for (const [k, v] of Object.entries(U)) if (k !== 'RANDO') users[v] = user(v, 'P' + k.toLowerCase());
  users[U.LEFT].accepted = false;                                   // a member only through Discord membership
  users[U.GC] = user(U.GC, 'Guestc', { role: 'applicant', applicant: true, accepted: false, inGuild: false, coach: true });
  users[U.COR].coach = true;
  return {
    nextId: 9000, users,
    members: [char(502, U.KM, 'Kmchar'), char(506, U.STUDENT, 'Studchar'), char(508, U.LEFT, 'Leftchar'), char(509, U.KR, 'Krchar'), char(510, U.RACE, 'Racechar'), char(517, U.MEDIA, 'Mediachar')],
    coachLinks: [{ id: 801, coach: U.COR, class: 'Battleweaver' }, { id: 802, coach: U.GC, class: 'Battleweaver' }],
    guestCoaches: [{ id: 850, discordId: U.GC, name: 'Guestc', avatar: '', addedAt: T }],
    vods: [601, 602, 603, 604, 605, 606].map((n) => vod(n, U.STUDENT, 'Private ' + n)), vodMarkers: [],
    gearScreens: [{ id: 904, memberId: 517, sectionId: 1, images: [MEDIA_FILE], note: '', updatedAt: T }], gearFolder: [],
    settings: { coachUserIds: [U.COR], officerUserIds: [U.OFFL, U.OFFR], applications: { enabled: true }, branding: {} },
    gearSectionTypes: [{ id: 1, label: 'Gear' }],
    events: [{ id: 950, title: 'Raid Night', type: 'Raid', start: new Date(Date.now() + 3 * 864e5).toISOString(), rsvps: {}, attended: [], parties: [] }], points: [],
  };
}

let G; const S = {};
const denied = (s) => s === 401 || s === 403;
const violations = () => { const v = []; return { want: (c, m) => { if (!c) v.push(m); }, done: () => assert.deepEqual(v, [], 'violations:\n' + v.join('\n')) }; };
const kick = async (key) => { const r = await G.api('POST', '/api/admin/kick', { cookie: S.OFF, body: { ownerKey: key } }); assert.equal(r.status, 200, 'precondition: kick ' + r.text); };
const tok = (cookie) => cookie.slice('gh_session='.length);
const revocations = () => JSON.parse(fs.readFileSync(path.join(G.dir, 'session-revocations.json'), 'utf8'));
function interaction(payload) {
  const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(null, Buffer.from(ts + body), keys.privateKey).toString('hex');
  return fetch(G.base + '/discord/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts }, body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

before(async () => {
  G = await startGuild({ seed: seed(), secret: SECRET, guild: GUILD, alliance: ALLIANCE, uploads: { [MEDIA_FILE]: png(7) },
    env: { DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_OFFICER_USER_IDS: U.OFF, ALLIANCE_OFFICER_ROLE_IDS: ALLY_ROLE, ROLE_REFRESH_INTERVAL_MS: '300',
      ALLIANCE_VERIFY_FRESH_MINUTES: '0.005', DISCORD_PUBLIC_KEY: PUBKEY_HEX } });
  S.OFF = await G.login(U.OFF);
});
after(async () => { if (G) await G.close(); });

// 1 ------------------------------------------------------------------------------------------------------------
test('B01 Bearer variants of every revoked / demoted case, including mutations (no CSRF check on Bearer)', async () => {
  const km = await G.login(U.KM), offl = await G.login(U.OFFL), lo = await G.login(U.LO), cor = await G.login(U.COR);
  await kick(U.KM);
  assert.equal((await G.api('PUT', '/api/admin/officers', { cookie: S.OFF, body: { userIds: [U.OFFR] } })).status, 200, 'precondition: OFFL removed');
  assert.equal((await G.api('POST', '/api/logout', { cookie: lo })).status, 200, 'precondition: logout');
  assert.equal((await G.api('PUT', '/api/admin/coaches', { cookie: S.OFF, body: { userIds: [] } })).status, 200, 'precondition: coach removed');
  const v = violations();
  const B = async (who, c, m, p, body) => { const r = await G.api(m, p, { bearer: tok(c), body, headers: { Origin: undefined, 'Content-Type': m === 'GET' ? undefined : 'application/json' } }); v.want(denied(r.status), `${who} Bearer ${m} ${p} -> ${r.status}`); };
  await B('kicked', km, 'GET', '/api/state'); await B('kicked', km, 'PUT', '/api/members/502', { name: 'Kmchar', role: 'DPS', ...BW, active: true }); await B('kicked', km, 'PUT', '/api/prefs', { timezone: 'UTC' });
  await B('removed officer', offl, 'GET', '/api/export'); await B('removed officer', offl, 'PUT', '/api/admin/officers', { userIds: [U.OFFL] }); await B('removed officer', offl, 'POST', '/api/admin/kick', { ownerKey: U.STUDENT });
  await B('logged out', lo, 'GET', '/api/state'); await B('logged out', lo, 'PUT', '/api/prefs', { timezone: 'UTC' });
  await B('removed coach', cor, 'POST', '/api/vods/601/reviews', { note: 'x' }); await B('removed coach', cor, 'DELETE', '/api/vods/602');
  const img = await fetch(G.base + '/uploads/' + MEDIA_FILE, { headers: { Authorization: 'Bearer ' + tok(km) } }); v.want(denied(img.status), `kicked Bearer private upload -> ${img.status}`);
  v.done();
});

// 2 ------------------------------------------------------------------------------------------------------------
test('B02 alliance token on non-alliance routes and private uploads (cookie and Bearer)', async () => {
  const c = await G.login(PARTNER, [ALLY_ROLE], { alliance: true });
  assert.equal((await G.api('GET', '/api/alliance/context', { cookie: c })).status, 200, 'precondition: partner works');
  const v = violations();
  for (const [m, p, b] of [['GET', '/api/state'], ['PUT', '/api/prefs', { timezone: 'UTC' }], ['POST', '/api/applications', { about: 'hello there friends', character: { name: 'Allych', role: 'DPS' } }],
    ['POST', '/api/guest-coaches/join', { class: 'Battleweaver' }], ['POST', '/api/vods/601/reviews', { note: 'x' }], ['GET', '/api/gearthreads/517'], ['GET', '/api/alliance/permissions'], ['GET', '/api/admin/diagnostics']]) {
    const r1 = await G.api(m, p, { cookie: c, body: b }); v.want(r1.status === 403, `alliance cookie ${m} ${p} -> ${r1.status}`);
    const r2 = await G.api(m, p, { bearer: tok(c), body: b, headers: { Origin: undefined } }); v.want(r2.status === 403, `alliance Bearer ${m} ${p} -> ${r2.status}`);
  }
  const img = await fetch(G.base + '/uploads/' + MEDIA_FILE, { headers: { Cookie: c } }); v.want(denied(img.status), `alliance private upload -> ${img.status}`);
  v.done();
});

// 3 ------------------------------------------------------------------------------------------------------------
test('B03 support token: mutations refused; revoked grant ends the session everywhere incl. private media', async () => {
  const gen = await G.api('POST', '/api/admin/support-access/generate', { cookie: S.OFF });
  const sl = await G.api('POST', '/api/support/login', { body: { username: 'SupportAI', code: gen.json.code } });
  assert.equal(sl.status, 200, 'precondition: support login'); const sup = sl.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(G.base + '/uploads/' + MEDIA_FILE, { headers: { Cookie: sup } })).status, 200, 'precondition: support reads media');
  const v = violations();
  for (const [m, p, b] of [['PUT', '/api/prefs', { timezone: 'UTC' }], ['POST', '/api/admin/kick', { ownerKey: U.STUDENT }], ['PUT', '/api/admin/officers', { userIds: [] }],
    ['POST', '/api/admin/support-access/generate'], ['POST', '/api/admin/support-access/revoke'], ['DELETE', '/api/vods/603'], ['POST', '/api/import', {}]]) {
    const r = await G.api(m, p, { cookie: sup, body: b }); v.want(r.status === 403, `support ${m} ${p} -> ${r.status}`);
    const rb = await G.api(m, p, { bearer: tok(sup), body: b, headers: { Origin: undefined } }); v.want(rb.status === 403, `support Bearer ${m} ${p} -> ${rb.status}`);
  }
  assert.equal((await G.api('POST', '/api/admin/support-access/revoke', { cookie: S.OFF })).status, 200, 'precondition: revoke');
  const st = await G.api('GET', '/api/state', { cookie: sup }); v.want(st.status === 401, `revoked support GET /api/state -> ${st.status}`);
  const img = await fetch(G.base + '/uploads/' + MEDIA_FILE, { headers: { Cookie: sup } }); v.want(img.status === 401, `revoked support private upload -> ${img.status}`);
  v.done();
});

// 4 ------------------------------------------------------------------------------------------------------------
// B04 (fixed in 1.46.2-hotfix.3, /hf2-contract/B04-CONTRACT.md): guest coaches only through a single-use officer invitation.
// The old static link (/auth/discord?guestcoach=1) and self-enrolment (POST /api/guest-coaches/join) grant nothing.
test('B04 an outsider (applicant, no invite) cannot self-enrol as guest coach and reach students\' private VODs', async () => {
  const c = await G.login(U.RANDO, [], { inGuild: false });             // any Discord account; applications are open
  const st0 = await G.api('GET', '/api/state', { cookie: c });
  assert.equal(st0.json.user.role, 'applicant', 'precondition: outsider is an applicant');
  const v = violations();
  const join = await G.api('POST', '/api/guest-coaches/join', { cookie: c, body: { class: 'Battleweaver' } });
  v.want(join.status === 410 || join.status === 403, `outsider POST /api/guest-coaches/join -> ${join.status} (want 410: self-enrolment removed)`);
  const st = await G.api('GET', '/api/state', { cookie: c });
  const seen = ((st.json && st.json.vods) || []).filter((x) => x.owner === U.STUDENT).map((x) => x.id);
  v.want(seen.length === 0, `outsider now sees ${seen.length} private VODs of a student (${seen.join(',')})`);
  const rv = await G.api('POST', '/api/vods/604/reviews', { cookie: c, body: { note: 'outsider note' } }); v.want(denied(rv.status), `outsider POST review on private VOD -> ${rv.status}`);
  const del = await G.api('DELETE', '/api/vods/605', { cookie: c }); v.want(denied(del.status), `outsider DELETE private VOD -> ${del.status}`);
  const ex = await G.api('GET', '/api/export', { cookie: S.OFF });
  v.want(!ex.json.guestCoaches.some((g) => g.discordId === U.RANDO), 'outsider was recorded as a guest coach');
  v.want(!ex.json.coachLinks.some((l) => l.coach === U.RANDO), 'outsider got a coach link');
  // The old static, public link with applications CLOSED: no session at all for an outsider.
  const OUT = '200000000000000021';
  assert.equal((await G.api('PUT', '/api/admin/discord', { cookie: S.OFF, body: { applications: { enabled: false } } })).status, 200, 'precondition: applications closed');
  try {
    const c2 = await G.login(OUT, [], { guestcoach: true, inGuild: false, expectCookie: false });
    v.want(!c2, 'outsider got a session through /auth/discord?guestcoach=1 with applications CLOSED');
  } finally {
    assert.equal((await G.api('PUT', '/api/admin/discord', { cookie: S.OFF, body: { applications: { enabled: true } } })).status, 200, 'precondition: applications reopened');
  }
  v.done();
});

// 5 ------------------------------------------------------------------------------------------------------------
test('B05 Discord RSVP buttons (signed interactions): kicked user refused; a member who left Discord refused', async () => {
  await G.login(U.KR); await kick(U.KR);
  const v = violations();
  const r1 = await interaction({ type: 3, data: { custom_id: 'rsvp:950:yes' }, user: { id: U.KR } });
  v.want(r1.status === 200 && /could not find|not a guild member/i.test(r1.json.data.content),   // lead: refused by the live check (B05 fix) or by the inactive character
    `kicked user RSVP button -> ${r1.status} "${r1.json && r1.json.data && r1.json.data.content}"`);
  // LEFT is a member only through Discord membership (not accepted). They leave the Discord server; the role refresh
  // marks them inGuild:false, so in the app they are an applicant now.
  const c = await G.login(U.LEFT, []);
  G.setMember(GUILD, U.LEFT, null);
  const gone = await poll(async () => { const r = await G.api('GET', '/api/state', { cookie: c }); return { ok: r.json && r.json.user && r.json.user.role === 'applicant', role: r.json && r.json.user && r.json.user.role }; });
  assert.ok(gone.ok, 'precondition: role refresh demoted LEFT to applicant, got ' + gone.role);
  for (const cid of ['rsvp:950:yes', 'schedrsvp:950:yes']) {
    const r = await interaction({ type: 3, data: { custom_id: cid }, user: { id: U.LEFT } });
    v.want(!/signed up|you're in/i.test((r.json && r.json.data && r.json.data.content) || ''), `ex-member (applicant) ${cid} -> "${r.json && r.json.data && r.json.data.content}" (want refused)`);
  }
  const ex = await G.api('GET', '/api/export', { cookie: S.OFF });
  const ev = ex.json.events.find((e) => e.id === 950);
  v.want(ev.rsvps[508] === undefined, `event 950 rsvps[508] = ${ev.rsvps[508]} (ex-member's character signed up after losing access)`);
  v.done();
});

// 6 ------------------------------------------------------------------------------------------------------------
test('B06 kick vs in-flight request: a request authorised before the kick must not be applied after it', async () => {
  const c = await G.login(U.RACE);
  const body = JSON.stringify({ name: 'Racechar', role: 'DPS', ...BW, active: true, notes: 'after kick' });
  const head = `PUT /api/members/510 HTTP/1.1\r\nHost: localhost:${G.port}\r\nOrigin: ${G.base}\r\nCookie: ${c}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  const p = pendingRequest(G.port, head, body.slice(0, 10)); await p.ready;
  await new Promise((r) => setTimeout(r, 300));                       // server has authenticated the headers by now
  await kick(U.RACE);
  const r = await p.finish(body.slice(10));
  const ex = await G.api('GET', '/api/export', { cookie: S.OFF });
  const m = ex.json.members.find((x) => x.id === 510);
  const v = violations();
  v.want(r.status === 401 || r.status === 403, `in-flight PUT /api/members/510 completed after the kick -> ${r.status}`);
  v.want(m.active === false, `character 510 active=${m.active} notes="${m.notes}" after the kick (reactivated by a pre-kick request)`);
  v.done();
});

test('B06b removed officer re-grants themselves officer with a request opened before the removal', async () => {
  const c = await G.login(U.OFFR);
  const body = JSON.stringify({ userIds: [U.OFFR] });
  const head = `PUT /api/admin/officers HTTP/1.1\r\nHost: localhost:${G.port}\r\nOrigin: ${G.base}\r\nCookie: ${c}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  const p = pendingRequest(G.port, head, body.slice(0, 5)); await p.ready;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await G.api('PUT', '/api/admin/officers', { cookie: S.OFF, body: { userIds: [] } })).status, 200, 'precondition: OFFR removed');
  assert.equal((await G.api('GET', '/api/export', { cookie: c })).status, 401, 'precondition: removal revoked the session');
  const r = await p.finish(body.slice(5));
  const fresh = await G.login(U.OFFR);
  const ex = await G.api('GET', '/api/export', { cookie: fresh });
  const v = violations();
  v.want(denied(r.status), `in-flight PUT /api/admin/officers by the removed officer -> ${r.status}`);
  v.want(denied(ex.status), `removed officer signs in again and GET /api/export -> ${ex.status} (officer again)`);
  v.done();
});

test('B06c concurrent revocation writes (parallel logouts + kick) are all recorded and survive a restart', async () => {
  const cookies = [];
  for (let i = 0; i < 12; i++) cookies.push(await G.login(U.CONC));
  const kc = await G.login(U.DUP);
  await Promise.all([...cookies.map((c) => G.api('POST', '/api/logout', { cookie: c })), G.api('POST', '/api/admin/kick', { cookie: S.OFF, body: { ownerKey: U.DUP } })]);
  await G.restart();
  const v = violations();
  for (const [i, c] of cookies.entries()) { const r = await G.api('GET', '/api/state', { cookie: c }); v.want(r.status === 401, `logged-out session #${i} after restart -> ${r.status}`); }
  const rk = await G.api('GET', '/api/state', { cookie: kc }); v.want(rk.status === 401, `kicked session after restart -> ${rk.status}`);
  const rr = await G.api('POST', '/api/logout', { cookie: cookies[0] }); v.want(rr.status === 200, `logout replay of a revoked token after restart -> ${rr.status}`);
  const st = fs.statSync(path.join(G.dir, 'session-revocations.json')); v.want((st.mode & 0o077) === 0, `revocation file mode ${(st.mode & 0o777).toString(8)} (want 600)`);
  S.OFF = await G.login(U.OFF);
  v.done();
});

// 7 ------------------------------------------------------------------------------------------------------------
test('B07 legacy token: logout revokes that token; a differently-signed legacy token of the same user is a separate session (by design)', async () => {
  const a = G.legacy(U.LEG, 'Pleg'), b = G.legacy(U.LEG, 'Pleg', 'member', { exp: Date.now() + 20 * 864e5 });
  assert.equal((await G.api('POST', '/api/logout', { cookie: a })).status, 200, 'precondition: legacy logout');
  const v = violations();
  const ra = await G.api('GET', '/api/state', { cookie: a }); v.want(ra.status === 401, `logged-out legacy token -> ${ra.status}`);
  const rab = await G.api('GET', '/api/state', { bearer: tok(a) }); v.want(rab.status === 401, `logged-out legacy token as Bearer -> ${rab.status}`);
  const rb = await G.api('GET', '/api/state', { cookie: b }); v.want(rb.status === 200, `other legacy token of the same user (other device) -> ${rb.status} (expected 200: per-device logout)`);
  v.done();
});

// 8 ------------------------------------------------------------------------------------------------------------
test('B08 revoked token on private media while the role refresh is running', async () => {
  const c = await G.login(U.MEDIA);
  assert.equal((await fetch(G.base + '/uploads/' + MEDIA_FILE, { headers: { Cookie: c } })).status, 200, 'precondition: owner sees image');
  assert.equal((await G.api('POST', '/api/logout', { cookie: c })).status, 200, 'precondition: logout');
  const v = violations();
  for (let i = 0; i < 10; i++) {
    const r = await fetch(G.base + '/uploads/' + MEDIA_FILE, { headers: { Cookie: c } }); await r.arrayBuffer();
    v.want(r.status === 401 && r.headers.get('cache-control') === 'private, no-store', `revoked token media #${i} -> ${r.status} ${r.headers.get('cache-control')}`);
    await new Promise((res) => setTimeout(res, 100));
  }
  v.done();
});

// 9 ------------------------------------------------------------------------------------------------------------
test('B09 guest coach loses VOD access at once when removed as guest coach', async () => {
  const c = await G.login(U.GC, [], { inGuild: false });
  assert.equal((await G.api('POST', '/api/vods/606/reviews', { cookie: c, body: { note: 'guest' } })).status, 200, 'precondition: guest coach reviews');
  assert.equal((await G.api('DELETE', `/api/guest-coaches/${U.GC}`, { cookie: S.OFF })).status, 200, 'precondition: guest coach removed');
  const v = violations();
  const r = await G.api('POST', '/api/vods/606/reviews', { cookie: c, body: { note: 'still?' } }); v.want(denied(r.status), `removed guest coach POST review -> ${r.status}`);
  const st = await G.api('GET', '/api/state', { cookie: c }); const n = ((st.json && st.json.vods) || []).length; v.want(n === 0, `removed guest coach still sees ${n} VODs`);
  v.done();
});

// 11 -----------------------------------------------------------------------------------------------------------
test('B11 Alliance partner when the bot cannot read the partner guild (10004 / 403 / 401) is refused (fail-closed)', async () => {
  const c = await G.login(PARTNER, [ALLY_ROLE], { alliance: true });
  assert.equal((await G.api('GET', '/api/alliance/context', { cookie: c })).status, 200, 'precondition: partner works');
  const v = violations();
  try {
    for (const mode of ['10004', '403', '401']) {
      G.fake.state.memberFail = { mode, guild: ALLIANCE };
      const last = await poll(async () => { const r = await G.api('GET', '/api/alliance/context', { cookie: c }); return { ok: r.status === 403, status: r.status }; }, { timeoutMs: 3000 });
      v.want(last.ok, `bot ${mode} on partner guild: GET /api/alliance/context -> ${last.status} (want 403)`);
      const m = await G.api('POST', '/api/alliance/mute', { cookie: c, body: { sessionId: 's', muted: true } }); v.want(m.status === 403, `bot ${mode}: POST mute -> ${m.status}`);
      G.fake.state.memberFail = null;
      await poll(async () => ({ ok: (await G.api('GET', '/api/alliance/context', { cookie: c })).status === 200 }), { timeoutMs: 3000 });
    }
  } finally { G.fake.state.memberFail = null; }
  v.done();
});

// 15 -----------------------------------------------------------------------------------------------------------
test('B15 iat exactly at the revocation instant is revoked; iat one ms later is a valid (applicant) session', async () => {
  await G.login(U.IAT); await kick(U.IAT);
  const nb = revocations().notBefore[U.IAT];
  assert.ok(Number.isFinite(nb), 'precondition: notBefore recorded');
  const mk = (iat) => G.mint({ key: U.IAT, name: 'Piat', discord: true, sid: crypto.randomBytes(8).toString('base64url'), iat, exp: Date.now() + 864e5 });
  const v = violations();
  const a = await G.api('GET', '/api/state', { cookie: mk(nb) }); v.want(a.status === 401, `iat == notBefore -> ${a.status} (want 401)`);
  const b = await G.api('GET', '/api/state', { cookie: mk(nb - 1) }); v.want(b.status === 401, `iat == notBefore-1 -> ${b.status} (want 401)`);
  const c = await G.api('GET', '/api/state', { cookie: mk(nb + 1) }); v.want(c.status === 200 && c.json.user.role === 'applicant', `iat == notBefore+1 -> ${c.status} ${c.json && c.json.user && c.json.user.role} (want 200 applicant)`);
  const d = await G.api('GET', '/api/state', { cookie: mk('9999999999999') }); v.want(d.status === 401, `string iat -> ${d.status} (treated as legacy exp-30d, revoked)`);
  v.done();
});

// 16 -----------------------------------------------------------------------------------------------------------
test('B16 duplicate gh_session cookies / name case variants / Bearer + cookie mixes do not resurrect revoked sessions', async () => {
  const good = await G.login(U.LO), bad = (await G.login(U.LO));
  assert.equal((await G.api('POST', '/api/logout', { cookie: bad })).status, 200, 'precondition: logout');
  const v = violations();
  const q = async (headers) => (await fetch(G.base + '/api/state', { headers })).status;
  v.want((await q({ Cookie: `${bad}; ${good}` })) === 401, 'revoked first, valid second: first cookie wins (401)');
  v.want((await q({ Cookie: `GH_SESSION=${tok(good)}` })) === 401, 'upper-case cookie name ignored');
  v.want((await q({ Cookie: `gh_session =${tok(good)}` })) === 401, 'cookie name with space ignored');
  v.want((await q({ Authorization: 'Bearer ' + tok(bad), Cookie: good })) === 401, 'revoked Bearer + valid cookie: Bearer wins (401)');
  v.want((await q({ Authorization: 'bearer ' + tok(bad) })) === 401, 'lower-case bearer scheme is not honoured');
  const mut = await G.api('PUT', '/api/prefs', { cookie: good, headers: { Authorization: 'Basic eDp5', Origin: 'https://evil.example' }, body: { timezone: 'UTC' } });
  v.want(mut.status === 403, `cookie mutation with a non-Bearer Authorization header from evil origin -> ${mut.status}`);
  v.done();
});

// 17 -----------------------------------------------------------------------------------------------------------
test('B17 navigator.sendBeacon-style logout (text/plain, cross-site or same-site) is refused and keeps the session', async () => {
  const c = await G.login(U.LO);
  const v = violations();
  for (const headers of [{ Origin: 'https://evil.example', 'Content-Type': 'text/plain;charset=UTF-8', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: undefined, 'Content-Type': 'text/plain;charset=UTF-8', 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null', 'Content-Type': 'application/json' },
    { Origin: 'https://evil.example', 'Content-Type': 'text/plain; x=application/json' }, { Origin: undefined, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' }]) {
    const r = await G.api('POST', '/api/logout', { cookie: c, headers, body: '{}' }); v.want(r.status === 403, `logout ${JSON.stringify(headers)} -> ${r.status}`);
  }
  v.want((await G.api('GET', '/api/state', { cookie: c })).status === 200, 'session survives');
  v.done();
});

// 10 (separate server) ------------------------------------------------------------------------------------------
// server.js clamps ROLE_MAX_STALE_MINUTES to >= 1 (Math.max(1, ...)), so the suspension check takes ~60 s.
test('B10 Discord errors during role refresh: no demotion inside the window, suspension after ROLE_MAX_STALE (1 min), recovery after', { timeout: 150000 }, async () => {
  const R = await startGuild({ seed: { nextId: 10, users: { [id(80)]: user(id(80), 'Roff') }, members: [], settings: { applications: { enabled: true }, branding: {} }, events: [], points: [] },
    secret: SECRET + '-b10', guild: GUILD, env: { DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, ROLE_REFRESH_INTERVAL_MS: '300', ROLE_MAX_STALE_MINUTES: '1' } });
  try {
    const c = await R.login(id(80), [OFFICER_ROLE]);
    const ex = async () => (await R.api('GET', '/api/export', { cookie: c })).status;
    assert.equal(await ex(), 200, 'precondition: role officer');
    const v = violations();
    for (const mode of ['429', '10004', 'reset', '403']) {             // inside the window: never a demotion
      R.fake.state.memberFail = { mode, guild: GUILD, retryAfter: 0.2 };
      await new Promise((r) => setTimeout(r, 1200));
      const s = await ex(); v.want(s === 200, `${mode}: inside the window -> ${s} (no demotion on API errors)`);
    }
    R.fake.state.memberFail = { mode: '500', guild: GUILD };
    const t0 = Date.now();
    const sus = await poll(async () => { const s = await ex(); return { ok: s === 403, s }; }, { timeoutMs: 75000, everyMs: 1000 });
    v.want(sus.ok, `500: after ROLE_MAX_STALE without a successful check -> ${sus.s} (want 403 suspended) after ${Date.now() - t0} ms`);
    v.want(Date.now() - t0 > 50000, `suspended too early (${Date.now() - t0} ms after the outage began; window is 60 s from the last success)`);
    const roles = JSON.parse(fs.readFileSync(path.join(R.dir, 'db.json'), 'utf8')).users[id(80)].discordRoles;
    v.want(Array.isArray(roles) && roles.includes(OFFICER_ROLE), `stored roles kept during the outage (${JSON.stringify(roles)})`);
    R.fake.state.memberFail = null;
    const back = await poll(async () => { const s = await ex(); return { ok: s === 200, s }; }, { timeoutMs: 5000 });
    v.want(back.ok, `after the next successful check -> ${back.s} (want 200 again, session not revoked)`);
    v.done();
  } finally { await R.close(); }
});

// 12 (separate server) ------------------------------------------------------------------------------------------
test('B12 client IP: TRUSTED_PROXIES with the IPv4-mapped loopback peer, untrusted peer, CLIENT_IP_HEADER from an untrusted peer', async () => {
  const R = await startGuild({ connectHost: '127.0.0.1', seed: { nextId: 10, users: {}, members: [], settings: { applications: { enabled: true }, branding: {} }, events: [], points: [] }, secret: SECRET + '-b12', guild: GUILD });
  try {
    const attempt = (h) => R.api('POST', '/api/support/login', { headers: h, body: { username: 'SupportAI', code: 'ABCDEFGHJKLM' } });
    const run = async (h1, h9) => { for (let i = 0; i < 8; i++) await attempt(h1(i)); return (await attempt(h9)).status; };
    const v = violations();
    // a) peer 127.0.0.1 (seen as ::ffff:127.0.0.1) IS the trusted proxy: forwarded clients are told apart.
    await R.restart({ TRUSTED_PROXIES: '127.0.0.1' });
    let s = await run((i) => ({ 'X-Forwarded-For': '198.51.100.9' }), { 'X-Forwarded-For': '198.51.100.10' });
    v.want(s === 401, `trusted proxy 127.0.0.1 (IPv4-mapped peer): another forwarded client -> ${s} (want 401, separate key)`);
    s = await attempt({ 'X-Forwarded-For': '198.51.100.9' }); v.want(s.status === 429, `trusted proxy: same forwarded client 9th attempt -> ${s.status} (want 429)`);
    s = await attempt({ 'X-Forwarded-For': '198.51.100.9, 127.0.0.1' }); v.want(s.status === 429, `trusted proxy: client appended before a trusted hop -> ${s.status} (want 429)`);
    // b) proxy configured but the peer is not it: XFF ignored.
    await R.restart({ TRUSTED_PROXIES: '10.0.0.0/8, ::ffff:10.1.1.1' });
    s = await run((i) => ({ 'X-Forwarded-For': `198.51.100.${i + 20}` }), { 'X-Forwarded-For': '198.51.100.99' });
    v.want(s === 429, `untrusted peer with TRUSTED_PROXIES set: spoofed XFF -> ${s} (want 429)`);
    // c) CLIENT_IP_HEADER from an untrusted peer: ignored.
    await R.restart({ CLIENT_IP_HEADER: 'cf-connecting-ip' });
    s = await run((i) => ({ 'CF-Connecting-IP': `203.0.113.${i + 1}` }), { 'CF-Connecting-IP': '203.0.113.99' });
    v.want(s === 429, `CLIENT_IP_HEADER from an untrusted peer -> ${s} (want 429)`);
    // d) CLIENT_IP_HEADER with a trusted peer: honoured; a garbage value must not collapse everyone into one key or crash.
    await R.restart({ CLIENT_IP_HEADER: 'cf-connecting-ip', TRUSTED_PROXIES: '127.0.0.1' });
    s = await run(() => ({ 'CF-Connecting-IP': '203.0.113.1' }), { 'CF-Connecting-IP': '203.0.113.2' });
    v.want(s === 401, `CLIENT_IP_HEADER via trusted proxy, other client -> ${s} (want 401)`);
    const junk = await attempt({ 'CF-Connecting-IP': 'not-an-ip' }); v.want([401, 429].includes(junk.status), `junk CLIENT_IP_HEADER value -> ${junk.status}`);
    v.done();
  } finally { await R.close(); }
});

// 14 (separate server) ------------------------------------------------------------------------------------------
test('B14 SESSIONS_VALID_AFTER: invalid value refuses to start; a future value must not lock out fresh sign-ins', async () => {
  const R = await startGuild({ seed: { nextId: 10, users: { [id(90)]: user(id(90), 'Vone') }, members: [], settings: { applications: { enabled: true }, branding: {} }, events: [], points: [] }, secret: SECRET + '-b14', guild: GUILD, env: { DISCORD_OFFICER_USER_IDS: id(90) } });
  try {
    const v = violations();
    let started = true;
    try { await R.restart({ SESSIONS_VALID_AFTER: 'yesterday-ish' }); } catch { started = false; }
    v.want(!started, 'server started with SESSIONS_VALID_AFTER=yesterday-ish (want refusal)');
    v.want(/SESSIONS_VALID_AFTER/.test(R.logs.join('')), 'start-up error names SESSIONS_VALID_AFTER');
    // Lead (B14 fix): a future value is refused at start-up (exit 1, named in the log); the alternative the test allows
    // - starting and accepting fresh sign-ins - is checked if the server does start.
    let futureStarted = true;
    try { await R.start({ SESSIONS_VALID_AFTER: new Date(Date.now() + 365 * 864e5).toISOString() }); } catch { futureStarted = false; }   // operator typo: next year
    if (futureStarted) {
      const fresh = await R.login(id(90));
      const r = await R.api('GET', '/api/state', { cookie: fresh });
      v.want(r.status === 200, `fresh sign-in with SESSIONS_VALID_AFTER one year in the future -> ${r.status} (everyone, officers included, locked out until then; want refusal to start or clamp to now)`);
    } else v.want(/SESSIONS_VALID_AFTER is in the future/.test(R.logs.join('')), 'refused future SESSIONS_VALID_AFTER names the problem');
    v.done();
  } finally { await R.close(); }
});
