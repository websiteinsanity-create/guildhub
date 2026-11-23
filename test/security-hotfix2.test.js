// GuildHub 1.46.2-hotfix.2 - independent adversarial regression suite (Agent 4).
// Every test asserts the SECURE behaviour from /hf2-contract/CONTRACT.md. On the vulnerable baseline
// (1.46.2-hotfix.1, cacde23) the SA-xx tests are EXPECTED to fail; that proves they detect the bug.
// Preconditions use plain asserts with a "precondition:" prefix so a harness problem is never mistaken for a
// detected vulnerability. Fictional data only. All processes and temp dirs are cleaned up in after().
//
// Test hooks this file assumes from the integrated build (the lead may rename them):
//   ROLE_REFRESH_INTERVAL_MS=300           role-refresh tick period (SA-02b)
//   ALLIANCE_VERIFY_FRESH_MINUTES=0.005 (= 300 ms)   partner verify cache (SA-07 role loss / leave); contract name, set by the lead at integration
//   fake.state.memberLookup / guildMembersByGuild               bot member lookup in test/fake-discord.js (Agent 2)
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startGuild, rawRequest, rawGet, poll, png } = require('./hf2-helpers');

const GUILD = '111111111111111111', ALLIANCE = '222222222222222222';
const OFFICER_ROLE = '900000000000000001', ALLY_ROLE = '910000000000000001';
const SECRET = 'hf2-agent4-test-secret-not-real';
const T = '2026-10-01T18:00:00.000Z';
const id = (n) => '2000000000000000' + String(n).padStart(2, '0');
const U = {
  OFF: id(1), OFF_ROLE_KICK: id(2), OFF_ROLE_LOSE: id(3), OFF_LIST: id(4), VICTIM: id(5), MEM_KICK: id(6), MEM_KICK_ACC: id(7), DEV: id(8),
  COACH_REM: id(9), STUDENT: id(10), COACH_KICK: id(11), GUEST: id(12), PLAIN: id(16), LEG_KICK: id(17), LEG_OUT: id(18), CSRF: id(19),
  OWNER: id(20), OTHER: id(21), COACH_A: id(22), COACH_B: id(23), APPLICANT: id(24), GH_KICK: id(25), GH_OFF_REM: id(26), GH_LOGOUT: id(27), PLAIN_LEG: id(28),
};
const P = { PARTNER: '300000000000000001', PARTNER_LEAVE: '300000000000000002', PARTNER_LIST: '300000000000000003' };
const F = { shotMain: 'gearshot-aaaaaaaaaaaa.png', thumbMain: 'gearthumb-bbbbbbbbbbbb.png', folderMain: 'gearfolder-cccccccccccc.png', shotAlt: 'gearshot-dddddddddddd.png', shotKick: 'gearshot-0123456789ab.png' };
const BW = { primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow' };                // Battleweaver
const user = (uid, name, extra = {}) => ({ id: uid, name, username: name.toLowerCase(), avatar: '', role: 'member', inGuild: true, accepted: true, ...extra });
const char = (mid, owner, name, extra = {}) => ({ id: mid, owner, name, role: 'DPS', active: true, ...BW, joinedAt: T, builds: [], ...extra });
const vod = (vid, owner, title) => ({ id: vid, owner, postedBy: owner, title, url: 'https://www.youtube.com/watch?v=abcdefghijk', youtubeId: 'abcdefghijk', visibility: 'private', reviews: [], at: T });

function seed() {
  const users = {};
  for (const [k, v] of Object.entries(U)) users[v] = user(v, k.replace(/_/g, '').slice(0, 12));
  users[U.APPLICANT] = user(U.APPLICANT, 'Applicant', { role: 'applicant', applicant: true, accepted: false, inGuild: false });
  users[U.GUEST] = user(U.GUEST, 'Guest', { role: 'applicant', applicant: true, accepted: false, inGuild: false, coach: true });
  for (const k of ['COACH_A', 'COACH_B', 'COACH_REM', 'COACH_KICK']) users[U[k]].coach = true;
  return {
    nextId: 9000, users,
    members: [
      char(501, U.OWNER, 'Ownerchar', { builds: [{ id: 7001, name: 'Alt', primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Daggers', role: 'Tank' }] }),
      char(502, U.OTHER, 'Otherchar'), char(503, U.MEM_KICK, 'Kickchar'), char(504, U.STUDENT, 'Studentchar'), char(505, U.GH_KICK, 'Ghkickchar'),
      char(506, U.MEM_KICK_ACC, 'Accchar'), char(507, U.DEV, 'Devchar'), char(508, U.VICTIM, 'Victimchar'),
    ],
    coachLinks: [{ id: 801, coach: U.COACH_A, class: 'Battleweaver' }, { id: 802, coach: U.COACH_B, class: 'Berserker' }, { id: 803, coach: U.COACH_REM, class: 'Battleweaver' },
      { id: 804, coach: U.COACH_KICK, class: 'Battleweaver' }, { id: 805, coach: U.GUEST, class: 'Battleweaver' }],
    guestCoaches: [{ id: 850, discordId: U.GUEST, name: 'Guest', avatar: '', addedAt: T }],
    vods: [vod(601, U.STUDENT, 'Private A'), vod(602, U.STUDENT, 'Private B'), vod(603, U.STUDENT, 'Private C'), vod(604, U.STUDENT, 'Private D'), vod(605, U.STUDENT, 'Private E')],
    vodMarkers: [],
    gearScreens: [
      { id: 901, memberId: 501, sectionId: 1, images: [F.shotMain], previews: { [F.shotMain]: F.thumbMain }, note: '', updatedAt: T },
      { id: 902, memberId: 501, buildKey: '7001', sectionId: 1, images: [F.shotAlt], note: '', updatedAt: T },
      { id: 904, memberId: 505, sectionId: 1, images: [F.shotKick], note: '', updatedAt: T },
    ],
    gearFolder: [{ id: 903, memberId: 501, buildKey: 'main', postedBy: U.OFF, postedByName: 'Officer', at: T, kind: 'image', text: '', url: '', image: F.folderMain }],
    settings: { coachUserIds: [U.COACH_A, U.COACH_B, U.COACH_REM, U.COACH_KICK], officerUserIds: [U.OFF_LIST, U.GH_OFF_REM], applications: { enabled: true }, branding: {} },
    gearSectionTypes: [{ id: 1, label: 'Gear' }, { id: 2, label: 'Stats' }],
    events: [], points: [],
  };
}

let G;
const S = {};                                                     // cookies, filled in before()
const kick = async (key) => { const r = await G.api('POST', '/api/admin/kick', { cookie: S.OFF, body: { ownerKey: key, reason: 'hf2 test' } }); assert.equal(r.status, 200, 'precondition: officer can kick ' + key + ' ' + r.text); };
const violations = () => { const v = []; return { want: (cond, msg) => { if (!cond) v.push(msg); }, done: () => assert.deepEqual(v, [], 'violations:\n' + v.join('\n')) }; };
const denied = (s) => s === 401 || s === 403;

before(async () => {
  G = await startGuild({
    seed: seed(), secret: SECRET, guild: GUILD, alliance: ALLIANCE,
    uploads: Object.fromEntries(Object.values(F).map((f, i) => [f, png(i + 1)])),
    env: { DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_OFFICER_USER_IDS: U.OFF, ALLIANCE_OFFICER_ROLE_IDS: ALLY_ROLE, ALLIANCE_OFFICER_USER_IDS: P.PARTNER_LIST,
      ROLE_REFRESH_INTERVAL_MS: '300', ALLIANCE_VERIFY_FRESH_MINUTES: '0.005' },
  });
  S.OFF = await G.login(U.OFF);
});
after(async () => { if (G) await G.close(); });

// ------------------------------------------------------------------------------------------------ SA-01
test('SA-01 kicked officer loses officer rights on an existing session (GET /api/export, POST /api/admin/kick)', async () => {
  const c = await G.login(U.OFF_ROLE_KICK, [OFFICER_ROLE]);
  assert.equal((await G.api('GET', '/api/export', { cookie: c })).status, 200, 'precondition: role officer can export');
  await kick(U.OFF_ROLE_KICK);
  const v = violations();
  const ex = await G.api('GET', '/api/export', { cookie: c });
  v.want(ex.status === 401, `kicked officer GET /api/export -> ${ex.status} (want 401, session revoked by kick)`);
  const k = await G.api('POST', '/api/admin/kick', { cookie: c, body: { ownerKey: U.VICTIM } });
  v.want(k.status === 401, `kicked officer POST /api/admin/kick -> ${k.status} (want 401)`);
  const kb = await G.api('GET', '/api/export', { bearer: c.slice('gh_session='.length) });
  v.want(kb.status === 401, `kicked officer via Bearer GET /api/export -> ${kb.status} (want 401)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-02
test('SA-02a officer removed from Admin > Officers (PUT /api/admin/officers) loses officer rights immediately', async () => {
  const c = await G.login(U.OFF_LIST);
  assert.equal((await G.api('GET', '/api/export', { cookie: c })).status, 200, 'precondition: Admin-list officer can export');
  const put = await G.api('PUT', '/api/admin/officers', { cookie: S.OFF, body: { userIds: [U.GH_OFF_REM] } });
  assert.equal(put.status, 200, 'precondition: officer list updated');
  const v = violations();
  const ex = await G.api('GET', '/api/export', { cookie: c });
  v.want(denied(ex.status), `removed officer GET /api/export -> ${ex.status} (want 401/403)`);
  const sa = await G.api('GET', '/api/admin/support-access', { cookie: c });
  v.want(denied(sa.status), `removed officer GET /api/admin/support-access -> ${sa.status} (want 401/403)`);
  v.done();
});

test('SA-02b officer whose Discord officer role is removed loses officer rights after a role refresh (<= 5 s with ROLE_REFRESH_INTERVAL_MS=300)', async () => {
  const c = await G.login(U.OFF_ROLE_LOSE, [OFFICER_ROLE]);
  assert.equal((await G.api('GET', '/api/export', { cookie: c })).status, 200, 'precondition: role officer can export');
  G.setMember(GUILD, U.OFF_ROLE_LOSE, []);                         // role taken away in Discord, still in the guild
  const last = await poll(async () => { const r = await G.api('GET', '/api/export', { cookie: c }); return { ok: denied(r.status), status: r.status }; }, { timeoutMs: 5000 });
  assert.ok(last.ok, `ex-officer GET /api/export still ${last.status} 5 s after the Discord officer role was removed (want 401/403)`);
});

// ------------------------------------------------------------------------------------------------ SA-03
test('SA-03 kicked member cannot use an existing session (PUT /api/members/:id {active:true})', async () => {
  const c = await G.login(U.MEM_KICK);
  assert.equal((await G.api('GET', '/api/state', { cookie: c })).status, 200, 'precondition: member signed in');
  await kick(U.MEM_KICK);
  const v = violations();
  const put = await G.api('PUT', '/api/members/503', { cookie: c, body: { name: 'Kickchar', role: 'DPS', ...BW, active: true } });
  v.want(put.status === 401, `kicked member PUT /api/members/503 {active:true} -> ${put.status} (want 401)`);
  const st = await G.api('GET', '/api/state', { cookie: c });
  v.want(st.status === 401, `kicked member GET /api/state -> ${st.status} (want 401)`);
  const exp = await G.api('GET', '/api/export', { cookie: S.OFF });
  const m = exp.json.members.find((x) => x.id === 503);
  v.want(m && m.active === false, `character 503 active=${m && m.active} after the kicked member's request (want false)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-04
test('SA-04 a kicked, previously accepted player who signs in again (applications open) stays an applicant', async () => {
  const c0 = await G.login(U.MEM_KICK_ACC);
  assert.equal((await G.api('GET', '/api/state', { cookie: c0 })).json.user.role, 'member', 'precondition: member before the kick');
  await kick(U.MEM_KICK_ACC);
  const c = await G.login(U.MEM_KICK_ACC);
  const v = violations();
  const st = await G.api('GET', '/api/state', { cookie: c });
  v.want(st.status === 200 && st.json.user && st.json.user.role === 'applicant', `fresh sign-in GET /api/state -> ${st.status} role=${st.json && st.json.user && st.json.user.role} (want 200 applicant)`);
  const gt = await G.api('GET', '/api/gearthreads/501', { cookie: c });
  v.want(gt.status === 403, `fresh sign-in GET /api/gearthreads/501 -> ${gt.status} (want 403)`);
  const own = await G.api('GET', '/api/gearthreads/506', { cookie: c });
  v.want(own.status === 403, `fresh sign-in GET /api/gearthreads/506 (own deactivated char) -> ${own.status} (want 403)`);
  const pr = await G.api('PUT', '/api/prefs', { cookie: c, body: { timezone: 'UTC' } });
  v.want(pr.status === 403, `fresh sign-in PUT /api/prefs -> ${pr.status} (want 403, application page only)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-05
test('SA-05 logout ends that session server-side; a copied cookie dies, the other device keeps working', async () => {
  const a = await G.login(U.DEV), b = await G.login(U.DEV);
  assert.notEqual(a, b, 'precondition: two devices have two distinct tokens');
  const copy = a;                                                   // an attacker-held copy of device A's cookie
  const out = await G.api('POST', '/api/logout', { cookie: a });
  assert.equal(out.status, 200, 'precondition: same-origin logout accepted');
  const v = violations();
  const r1 = await G.api('GET', '/api/state', { cookie: copy });
  v.want(r1.status === 401, `copied cookie after logout GET /api/state -> ${r1.status} (want 401)`);
  const r1b = await G.api('GET', '/api/state', { bearer: copy.slice('gh_session='.length) });
  v.want(r1b.status === 401, `copied token as Bearer after logout -> ${r1b.status} (want 401)`);
  const r2 = await G.api('GET', '/api/state', { cookie: b });
  v.want(r2.status === 200, `other device after logout -> ${r2.status} (want 200)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-06
test('SA-06 removed or kicked coach loses VOD coaching on a student\'s private VOD; guest coach keeps it', async () => {
  const rem = await G.login(U.COACH_REM), kc = await G.login(U.COACH_KICK), guest = await G.login(U.GUEST, [], { inGuild: false });
  const review = (cookie, vid) => G.api('POST', `/api/vods/${vid}/reviews`, { cookie, body: { note: 'Keep your guard up.' } });
  const marker = (cookie, vid) => G.api('POST', `/api/vods/${vid}/markers`, { cookie, body: { timestamp: 12, note: 'Dodge here.' } });
  assert.equal((await review(rem, 601)).status, 200, 'precondition: coach can review before removal');
  assert.equal((await review(kc, 601)).status, 200, 'precondition: coach can review before the kick');
  // Remove COACH_REM from the coach list (links stay stored, per contract).
  const put = await G.api('PUT', '/api/admin/coaches', { cookie: S.OFF, body: { userIds: [U.COACH_A, U.COACH_B, U.COACH_KICK] } });
  assert.equal(put.status, 200, 'precondition: coach list updated');
  await kick(U.COACH_KICK);
  const v = violations();
  for (const [who, c] of [['removed coach', rem], ['kicked coach (existing session)', kc]]) {
    const r = await review(c, 601); v.want(denied(r.status), `${who} POST /api/vods/601/reviews -> ${r.status} (want 401/403)`);
    const m = await marker(c, 601); v.want(denied(m.status), `${who} POST /api/vods/601/markers -> ${m.status} (want 401/403)`);
  }
  const d1 = await G.api('DELETE', '/api/vods/602', { cookie: rem }); v.want(denied(d1.status), `removed coach DELETE /api/vods/602 -> ${d1.status} (want 401/403)`);
  const d2 = await G.api('DELETE', '/api/vods/603', { cookie: kc }); v.want(denied(d2.status), `kicked coach DELETE /api/vods/603 -> ${d2.status} (want 401/403)`);
  const kc2 = await G.login(U.COACH_KICK);                         // fresh sign-in after the kick: applicant
  const r3 = await review(kc2, 601); v.want(r3.status === 403, `kicked coach fresh sign-in POST review -> ${r3.status} (want 403)`);
  const d3 = await G.api('DELETE', '/api/vods/605', { cookie: kc2 }); v.want(d3.status === 403, `kicked coach fresh sign-in DELETE /api/vods/605 -> ${d3.status} (want 403)`);
  // Guest coach must keep working (non-regression).
  const g1 = await review(guest, 601); v.want(g1.status === 200, `guest coach POST review -> ${g1.status} (want 200)`);
  const g2 = await marker(guest, 601); v.want(g2.status === 200, `guest coach POST marker -> ${g2.status} (want 200)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-07
test('SA-07a alliance partner: alliance routes work, main app and Insanity admin routes are refused (non-regression)', async () => {
  const c = await G.login(P.PARTNER, [ALLY_ROLE], { alliance: true });
  const v = violations();
  const ctx = await G.api('GET', '/api/alliance/context', { cookie: c });
  v.want(ctx.status === 200 && ctx.json.mode === 'partner', `partner GET /api/alliance/context -> ${ctx.status} ${ctx.json && ctx.json.mode} (want 200 partner)`);
  const mute = await G.api('POST', '/api/alliance/mute', { cookie: c, body: { sessionId: 's1', muted: true } });
  v.want(mute.status === 200, `partner POST /api/alliance/mute -> ${mute.status} (want 200)`);
  for (const [m, p, b] of [['GET', '/api/state'], ['GET', '/api/export'], ['GET', '/api/gearthreads/501'], ['GET', '/api/alliance/permissions'], ['PUT', '/api/alliance/permissions', { enabled: true }],
    ['GET', '/api/alliance-management/overview'], ['POST', '/api/alliance-management/bridge', { action: 'swipe' }], ['PUT', '/api/prefs', { timezone: 'UTC' }]]) {
    const r = await G.api(m, p, { cookie: c, body: b });
    v.want(r.status === 403, `partner ${m} ${p} -> ${r.status} (want 403)`);
  }
  const sw = await G.api('POST', '/api/alliance/bridge', { cookie: c, body: { action: 'swipe' } });
  v.want(sw.status === 403, `partner POST /api/alliance/bridge swipe -> ${sw.status} (want 403, Insanity only)`);
  const img = await fetch(G.base + '/uploads/' + F.shotMain, { headers: { Cookie: c } });
  v.want(denied(img.status), `partner private upload -> ${img.status} (want 401/403)`);
  v.done();
});

test('SA-07b alliance partner who loses the partner role in Discord is refused (<= 5 s)', async () => {
  const c = await G.login(P.PARTNER, [ALLY_ROLE], { alliance: true });
  assert.equal((await G.api('GET', '/api/alliance/context', { cookie: c })).status, 200, 'precondition: partner session works');
  G.setMember(ALLIANCE, P.PARTNER, []);
  const last = await poll(async () => { const r = await G.api('GET', '/api/alliance/context', { cookie: c }); return { ok: r.status === 403, status: r.status }; });
  const mute = await G.api('POST', '/api/alliance/mute', { cookie: c, body: { sessionId: 's1', muted: true } });
  const v = violations();
  v.want(last.ok, `partner without role GET /api/alliance/context -> ${last.status} after 5 s (want 403)`);
  v.want(mute.status === 403, `partner without role POST /api/alliance/mute -> ${mute.status} (want 403)`);
  v.done();
});

test('SA-07c alliance partner who leaves the partner guild is refused (<= 5 s)', async () => {
  const c = await G.login(P.PARTNER_LEAVE, [ALLY_ROLE], { alliance: true });
  assert.equal((await G.api('GET', '/api/alliance/context', { cookie: c })).status, 200, 'precondition: partner session works');
  G.setMember(ALLIANCE, P.PARTNER_LEAVE, null);                    // bot lookup now answers 404 / 10007 Unknown Member
  const last = await poll(async () => { const r = await G.api('GET', '/api/alliance/context', { cookie: c }); return { ok: r.status === 403, status: r.status }; });
  const st = await G.api('POST', '/api/alliance/stop', { cookie: c, body: { sessionId: 's1' } });
  const v = violations();
  v.want(last.ok, `partner who left GET /api/alliance/context -> ${last.status} after 5 s (want 403)`);
  v.want(st.status === 403, `partner who left POST /api/alliance/stop -> ${st.status} (want 403)`);
  v.done();
});

test('SA-07d alliance partner removed from the allowlist is refused immediately', async () => {
  const c = await G.login(P.PARTNER_LIST, [], { alliance: true });
  assert.equal((await G.api('GET', '/api/alliance/context', { cookie: c })).status, 200, 'precondition: allowlisted partner works');
  const put = await G.api('PUT', '/api/alliance/permissions', { cookie: S.OFF, body: { officerUserIds: [] } });
  assert.equal(put.status, 200, 'precondition: Insanity admin updated the allowlist ' + put.text);
  const v = violations();
  const r = await G.api('GET', '/api/alliance/context', { cookie: c }); v.want(r.status === 403, `removed partner GET context -> ${r.status} (want 403)`);
  const m = await G.api('POST', '/api/alliance/mute', { cookie: c, body: { sessionId: 's1', muted: true } }); v.want(m.status === 403, `removed partner POST mute -> ${m.status} (want 403)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-08
test('SA-08 a cookie with a non-ASCII (Latin-1) signature gets an HTTP answer within 2 s', async () => {
  const bad = Buffer.concat([Buffer.from('gh_session=e30.', 'latin1'), Buffer.alloc(43, 0xe9)]);
  const bearer = Buffer.concat([Buffer.from('Bearer e30.', 'latin1'), Buffer.alloc(43, 0xe9)]);
  const v = violations();
  for (const [p, hdr, val, want] of [['/api/state', 'Cookie', bad, 401], ['/', 'Cookie', bad, 200], ['/uploads/' + F.shotMain, 'Cookie', bad, 401], ['/api/state', 'Authorization', bearer, 401], ['/', 'Authorization', bearer, 200]]) {
    const r = await rawRequest(G.port, rawGet(G.port, p, hdr, val), 2000);
    v.want(r.status === want && r.ms < 2000, `${hdr} ${p} -> ${r.timedOut ? 'NO RESPONSE (hang)' : r.status || r.error} in ${Math.round(r.ms)} ms (want ${want} < 2000 ms)`);
  }
  const h = await fetch(G.base + '/health'); v.want(h.status === 200, 'server healthy afterwards');
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-09
test('SA-09 cross-site logout is refused and does not end the session', async () => {
  const c = await G.login(U.CSRF);
  const v = violations();
  const variants = [
    ['Origin https://evil.example + JSON', { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, '{}'],
    ['Sec-Fetch-Site: cross-site, no Origin', { Origin: undefined, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, '{}'],
    ['text/plain form post from evil origin', { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, 'x=1'],
    ['text/plain post, no Origin, no Sec-Fetch-Site', { Origin: undefined, 'Content-Type': 'text/plain' }, 'x=1'],
    ['urlencoded form post from evil origin', { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=b'],
  ];
  for (const [name, headers, body] of variants) {
    const r = await G.api('POST', '/api/logout', { cookie: c, headers, body });
    v.want(r.status >= 400 && r.status < 500, `${name}: POST /api/logout -> ${r.status} (want 403/415)`);
    const st = await G.api('GET', '/api/state', { cookie: c });
    v.want(st.status === 200, `${name}: session after refused logout -> ${st.status} (want 200)`);
  }
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-10
test('SA-10 Origin must match PUBLIC_URL exactly (scheme, host, port); Origin: null refused', async () => {
  const c = await G.login(U.PLAIN);
  const prefs = (Origin) => G.api('PUT', '/api/prefs', { cookie: c, headers: { Origin }, body: { timezone: 'UTC' } });
  assert.equal((await prefs(G.base)).status, 200, 'precondition: same-origin mutation accepted');
  const v = violations();
  for (const o of [`https://localhost:${G.port}`, `http://localhost:${G.port + 1}`, 'null', `http://127.0.0.1:${G.port}`, `http://localhost:${G.port}.evil.example`]) {
    const r = await prefs(o); v.want(r.status === 403, `Origin ${o}: PUT /api/prefs -> ${r.status} (want 403)`);
  }
  // Host header spoof: Origin and Host agree with each other but not with PUBLIC_URL.
  const body = '{"timezone":"UTC"}';
  const raw = Buffer.from(`PUT /api/prefs HTTP/1.1\r\nHost: evil.example\r\nOrigin: http://evil.example\r\nCookie: ${c}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`, 'latin1');
  const r = await rawRequest(G.port, raw, 3000);
  v.want(r.status === 403, `Origin http://evil.example + Host: evil.example -> ${r.status} (want 403)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ GH-01
async function mediaRow(cookie, file, build) {
  const r = await fetch(G.base + '/uploads/' + file, { headers: cookie ? { Cookie: cookie } : {} });
  const bytes = (await r.arrayBuffer()).byteLength;
  const api = await G.api('GET', `/api/gearthreads/501?build=${build}`, { cookie });
  return { status: r.status, cc: r.headers.get('cache-control'), bytes, api: api.status };
}
const MEDIA = [[F.shotMain, 'main'], [F.thumbMain, 'main'], [F.folderMain, 'main'], [F.shotAlt, '7001']];

test('GH-01 private media matrix - unchanged cases (non-regression)', async () => {
  const C = { owner: await G.login(U.OWNER), officer: S.OFF, coachA: await G.login(U.COACH_A), coachB: await G.login(U.COACH_B), other: await G.login(U.OTHER),
    applicant: await G.login(U.APPLICANT, [], { inGuild: false }), anonymous: null };
  C.tampered = C.owner.slice(0, -3) + (C.owner.endsWith('AAA') ? 'BBB' : 'AAA');
  C.expired = G.mint({ key: U.OWNER, name: 'Owner', role: 'member', discord: true, iat: Date.now() - 31 * 864e5, exp: Date.now() - 1000 });
  C.alliance = G.mint({ key: '300000000000000099', name: 'Partner', role: 'alliance', allianceGuildId: ALLIANCE, allianceRoles: [ALLY_ROLE], discord: true, exp: Date.now() + 3600e3 });
  const gen = await G.api('POST', '/api/admin/support-access/generate', { cookie: S.OFF });
  assert.equal(gen.status, 200, 'precondition: support code generated');
  const sl = await G.api('POST', '/api/support/login', { headers: { Origin: G.base }, body: { username: 'SupportAI', code: gen.json.code } });
  assert.equal(sl.status, 200, 'precondition: support login'); C.support = sl.headers.get('set-cookie').split(';')[0];
  const expected = { owner: [200, 200], officer: [200, 200], coachA: [200, 403], coachB: [403, 200], other: [403, 403], applicant: [403, 403],
    anonymous: [401, 401], tampered: [401, 401], expired: [401, 401], alliance: [403, 403], support: [200, 200] };
  const v = violations();
  for (const [who, cookie] of Object.entries(C)) for (const [file, build] of MEDIA) {
    const r = await mediaRow(cookie, file, build), want = expected[who][build === 'main' ? 0 : 1];
    const okStatus = who === 'alliance' ? denied(r.status) : r.status === want;
    v.want(okStatus, `${who} ${file}: ${r.status} (want ${want})`);
    v.want(r.cc === 'private, no-store', `${who} ${file}: cache-control ${r.cc}`);
    v.want(r.status === 200 ? r.bytes === 300 : r.bytes === 0, `${who} ${file}: ${r.bytes} bytes`);
    v.want((r.status === 200) === (r.api === 200), `${who} ${build}: image ${r.status} vs thread ${r.api} parity`);
  }
  v.done();
});

test('GH-01 private media matrix - live rules: kicked member, removed officer, logged-out session', async () => {
  const kicked = await G.login(U.GH_KICK), offRem = await G.login(U.GH_OFF_REM), out = await G.login(U.GH_LOGOUT);
  assert.equal((await fetch(G.base + '/uploads/' + F.shotKick, { headers: { Cookie: kicked } })).status, 200, 'precondition: owner sees own image');
  assert.equal((await fetch(G.base + '/uploads/' + F.shotMain, { headers: { Cookie: offRem } })).status, 200, 'precondition: Admin-list officer sees any image');
  await kick(U.GH_KICK);
  assert.equal((await G.api('PUT', '/api/admin/officers', { cookie: S.OFF, body: { userIds: [] } })).status, 200, 'precondition: officer list emptied');
  assert.equal((await G.api('POST', '/api/logout', { cookie: out })).status, 200, 'precondition: logout');
  const v = violations();
  const get = async (cookie, file) => { const r = await fetch(G.base + '/uploads/' + file, { headers: { Cookie: cookie } }); await r.arrayBuffer(); return { s: r.status, cc: r.headers.get('cache-control') }; };
  let r = await get(kicked, F.shotKick); v.want(r.s === 401 && r.cc === 'private, no-store', `kicked member (existing session) own image -> ${r.s} ${r.cc} (want 401 private, no-store)`);
  const kicked2 = await G.login(U.GH_KICK);
  r = await get(kicked2, F.shotKick); v.want(r.s === 403, `kicked member (fresh sign-in, applicant) own image -> ${r.s} (want 403)`);
  for (const [file] of MEDIA) { r = await get(offRem, file); v.want(denied(r.s), `removed officer (existing session) ${file} -> ${r.s} (want 401/403)`); }
  const offRem2 = await G.login(U.GH_OFF_REM);
  for (const [file] of MEDIA) { r = await get(offRem2, file); v.want(r.s === 403, `removed officer (fresh sign-in) ${file} -> ${r.s} (want 403)`); }
  r = await get(out, F.shotMain); v.want(r.s === 401, `logged-out session -> ${r.s} (want 401)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ legacy tokens
test('LEGACY a 1.46.2-format token (no sid/iat) keeps working for a normal member (compat)', async () => {
  const c = G.legacy(U.PLAIN_LEG, 'Plainleg');
  const v = violations();
  const st = await G.api('GET', '/api/state', { cookie: c });
  v.want(st.status === 200 && st.json.user.role === 'member', `legacy member GET /api/state -> ${st.status} ${st.json && st.json.user && st.json.user.role} (want 200 member)`);
  const pr = await G.api('PUT', '/api/prefs', { cookie: c, body: { timezone: 'UTC' } });
  v.want(pr.status === 200, `legacy member PUT /api/prefs -> ${pr.status} (want 200)`);
  const br = await G.api('GET', '/api/state', { bearer: c.slice('gh_session='.length) });
  v.want(br.status === 200, `legacy member Bearer GET /api/state -> ${br.status} (want 200)`);
  v.done();
});

test('LEGACY the role embedded in a legacy token is not trusted (member claiming officer)', async () => {
  const c = G.legacy(U.PLAIN_LEG, 'Plainleg', 'officer', { coach: true });
  const v = violations();
  for (const [m, p, b] of [['GET', '/api/export'], ['GET', '/api/admin/support-access'], ['PUT', '/api/admin/officers', {}]]) {
    const r = await G.api(m, p, { cookie: c, body: b }); v.want(denied(r.status), `legacy 'officer' claim ${m} ${p} -> ${r.status} (want 401/403)`);
  }
  const st = await G.api('GET', '/api/state', { cookie: c });
  v.want(!(st.json && st.json.user && st.json.user.role === 'officer'), `legacy 'officer' claim /api/state role=${st.json && st.json.user && st.json.user.role} (want not officer)`);
  v.done();
});

test('LEGACY kick and logout revoke legacy tokens', async () => {
  const k = G.legacy(U.LEG_KICK, 'Legkick'), o = G.legacy(U.LEG_OUT, 'Legout');
  assert.equal((await G.api('GET', '/api/state', { cookie: k })).status, 200, 'precondition: legacy token works');
  assert.equal((await G.api('GET', '/api/state', { cookie: o })).status, 200, 'precondition: legacy token works');
  await kick(U.LEG_KICK);
  assert.equal((await G.api('POST', '/api/logout', { cookie: o })).status, 200, 'precondition: logout accepted');
  const v = violations();
  const rk = await G.api('GET', '/api/state', { cookie: k }); v.want(rk.status === 401, `legacy token after kick -> ${rk.status} (want 401)`);
  const ro = await G.api('GET', '/api/state', { cookie: o }); v.want(ro.status === 401, `legacy token after logout -> ${ro.status} (want 401)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ forged / stale claims
test('CLAIMS validly signed tokens with stale/forged role, coach or unknown key grant nothing', async () => {
  const now = Date.now(), sid = () => crypto.randomBytes(16).toString('base64url');
  const base = { key: U.PLAIN, name: 'Plain', username: 'plain', avatar: '', discord: true, iat: now, exp: now + 864e5 };
  const officer = G.mint({ ...base, sid: sid(), role: 'officer' });
  const coach = G.mint({ ...base, sid: sid(), role: 'member', coach: true });
  const unknown = G.mint({ ...base, sid: sid(), key: '299999999999999999', role: 'member' });
  const kickedClaim = G.mint({ ...base, sid: sid(), key: U.MEM_KICK, role: 'officer' });   // MEM_KICK was kicked in SA-03
  const allianceClaim = G.mint({ ...base, sid: sid(), role: 'member', allianceGuildId: ALLIANCE, allianceRoles: [ALLY_ROLE] });
  const v = violations();
  for (const [name, c] of [['officer claim', officer], ['kicked user officer claim', kickedClaim]]) {
    for (const [m, p, b] of [['GET', '/api/export'], ['GET', '/api/admin/support-access'], ['PUT', '/api/admin/officers', {}]]) {
      const r = await G.api(m, p, { cookie: c, body: b }); v.want(denied(r.status), `${name} ${m} ${p} -> ${r.status} (want 401/403)`);
    }
    const rb = await G.api('GET', '/api/export', { bearer: c.slice('gh_session='.length) }); v.want(denied(rb.status), `${name} Bearer GET /api/export -> ${rb.status} (want 401/403)`);
  }
  const rv = await G.api('POST', '/api/vods/604/reviews', { cookie: coach, body: { note: 'x' } }); v.want(denied(rv.status), `coach claim POST review -> ${rv.status} (want 401/403)`);
  const gt = await G.api('GET', '/api/gearthreads/504', { cookie: coach }); v.want(denied(gt.status), `coach claim GET student gear thread -> ${gt.status} (want 401/403)`);
  const un = await G.api('GET', '/api/state', { cookie: unknown }); v.want(un.status === 401, `token for a key with no user record GET /api/state -> ${un.status} (want 401)`);
  const al = await G.api('GET', '/api/alliance/context', { cookie: allianceClaim }); v.want(denied(al.status), `member with alliance claims GET /api/alliance/context -> ${al.status} (want 401/403)`);
  const sup = G.mint({ ...base, sid: sid(), key: 'support:SupportAI', support: true, supportGrant: 'not-a-grant', role: 'officer' });
  const rs = await G.api('GET', '/api/export', { cookie: sup }); v.want(rs.status === 401, `support claim without a live grant -> ${rs.status} (want 401)`);
  v.done();
});

// ------------------------------------------------------------------------------------------------ SA-11
test('SA-11 a spoofed X-Forwarded-For from an untrusted peer does not change the support-login rate-limit key', async () => {
  const R = await startGuild({ seed: { nextId: 10, users: {}, members: [], settings: { applications: { enabled: true }, branding: {} }, events: [], points: [] }, secret: SECRET + '-r', guild: GUILD });
  try {
    const attempt = (xff) => R.api('POST', '/api/support/login', { headers: { Origin: R.base, ...(xff ? { 'X-Forwarded-For': xff } : {}) }, body: { username: 'SupportAI', code: 'ABCDEFGHJKLM' } });
    for (let i = 0; i < 8; i++) assert.equal((await attempt(`198.51.100.${i + 1}`)).status, 401, 'precondition: wrong code -> 401');
    const v = violations();
    const ninth = await attempt('203.0.113.77'); v.want(ninth.status === 429, `9th attempt with a new spoofed XFF -> ${ninth.status} (want 429)`);
    const tenth = await attempt(null); v.want(tenth.status === 429, `10th attempt without XFF -> ${tenth.status} (want 429)`);
    const multi = await attempt('203.0.113.78, 127.0.0.1'); v.want(multi.status === 429, `attempt with a multi-hop spoofed XFF -> ${multi.status} (want 429)`);
    v.done();
  } finally { await R.close(); }
});

// ------------------------------------------------------------------------------------------------ restart / post-restore
let R2;
after(async () => { if (R2) await R2.close(); });
const R2U = { OFF: id(60), M1: id(61), M2: id(62), M3: id(63), M4: id(64) };
test('RESTART revocations (logout, kick, legacy logout) survive a server restart', async () => {
  const users = Object.fromEntries(Object.entries(R2U).map(([k, v]) => [v, user(v, k)]));
  R2 = await startGuild({ seed: { nextId: 10, users, members: [char(701, R2U.M2, 'Mtwo')], settings: { applications: { enabled: true }, branding: {} }, events: [], points: [] },
    secret: SECRET + '-r2', guild: GUILD, env: { DISCORD_OFFICER_USER_IDS: R2U.OFF } });
  const off = await R2.login(R2U.OFF), m1 = await R2.login(R2U.M1), m2 = await R2.login(R2U.M2), m4 = await R2.login(R2U.M4);
  const m3 = R2.legacy(R2U.M3, 'Mthree');
  assert.equal((await R2.api('POST', '/api/logout', { cookie: m1 })).status, 200, 'precondition: logout');
  assert.equal((await R2.api('POST', '/api/logout', { cookie: m3 })).status, 200, 'precondition: legacy logout');
  assert.equal((await R2.api('POST', '/api/admin/kick', { cookie: off, body: { ownerKey: R2U.M2 } })).status, 200, 'precondition: kick');
  await R2.restart();
  const v = violations();
  for (const [name, c, want] of [['logged-out session', m1, 401], ['kicked session', m2, 401], ['logged-out legacy token', m3, 401], ['officer control', off, 200], ['member control', m4, 200]]) {
    const r = await R2.api('GET', '/api/state', { cookie: c }); v.want(r.status === want, `after restart ${name} -> ${r.status} (want ${want})`);
  }
  R2.saved = { off, m4 };
  v.done();
});

test('RESTORE SESSIONS_VALID_AFTER=now rejects every older token; fresh sign-ins work', async () => {
  assert.ok(R2 && R2.saved, 'precondition: RESTART test ran');
  const legacy = R2.legacy(R2U.M4, 'Mfour');
  await new Promise((r) => setTimeout(r, 30));
  await R2.restart({ SESSIONS_VALID_AFTER: new Date().toISOString() });
  const v = violations();
  for (const [name, c] of [['officer session from before', R2.saved.off], ['member session from before', R2.saved.m4], ['legacy token', legacy]]) {
    const r = await R2.api('GET', '/api/state', { cookie: c }); v.want(r.status === 401, `${name} -> ${r.status} (want 401)`);
  }
  const fresh = await R2.login(R2U.M4);
  const r = await R2.api('GET', '/api/state', { cookie: fresh }); v.want(r.status === 200, `fresh sign-in after SESSIONS_VALID_AFTER -> ${r.status} (want 200)`);
  v.done();
});
