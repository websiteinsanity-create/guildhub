// GuildHub 1.46.2-hotfix.3 candidate - B04 guest-coach invitations, independent adversarial suite (Agent 4).
// Asserts the SECURE behaviour of /hf2-contract/B04-CONTRACT.md. On the baseline without the fix (3f82340) most of
// these tests are EXPECTED to fail (feature absent); a failure is a plain assertion with the observed status/value.
// "precondition:" asserts mark harness problems, never findings. Fictional data only; server, fake Discord and temp
// dirs are cleaned up in after().
//
// Seeding technique: invite records are written straight into db.json (stopped server) with a known raw token whose
// sha256 hex is stored as tokenHash - that is how expiry, edge and legacy cases are tested without waiting 72 h.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startGuild, pendingRequest, newInviteToken } = require('./hf2-helpers');

const GUILD = '111111111111111111', ALLIANCE = '222222222222222222';
const ALLY_ROLE = '910000000000000001';
const SECRET = 'b04-agent4-invite-secret-not-real';
const T = '2026-10-01T18:00:00.000Z';
const H72 = 72 * 3600 * 1000;
const id = (n) => '4000000000000000' + String(n).padStart(2, '0');
const U = {
  OFF: id(1), OFFL: id(2), KM: id(4), COR: id(5), STUDENT: id(6), STUDENT2: id(7), LEG: id(8), KICK: id(9), APPL: id(10),
  GV: id(11), GC2: id(12), GR: id(13), GP1: id(14), GP2: id(15),
  // fresh outsiders (no record, not in the Discord server) - each used by exactly one scenario
  NEW1: id(20), OTHER: id(21), RA: id(22), RB: id(23), RPL: id(24), INT1: id(25), INT2: id(26), SUB1: id(27), SUB2: id(28), LEGX: id(29),
  EXP: id(30), ONE: id(31), ONE2: id(32), REV: id(33), ELIG: id(34), XO: id(35), EXP2: id(36),
};
const PARTNER = '300000000000000021';
const BW = { primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow' };              // Battleweaver
const BZ = { primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Daggers' };      // Berserker
const user = (uid, name, extra = {}) => ({ id: uid, name, username: name.toLowerCase(), avatar: '', role: 'member', inGuild: true, accepted: true, ...extra });
const applicant = (uid, name, extra = {}) => user(uid, name, { role: 'applicant', applicant: true, accepted: false, inGuild: false, ...extra });
const char = (mid, owner, name, extra = {}) => ({ id: mid, owner, name, role: 'DPS', active: true, ...BW, joinedAt: T, builds: [], ...extra });
const vod = (vid, owner, extra = {}) => ({ id: vid, owner, postedBy: owner, postedAt: T, title: 'Wargame vs Rivals 01.10.2026', type: 'Wargame', recordedDate: '2026-10-01', enemyGuild: 'Rivals', note: 'n' + vid,
  url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk', visibility: 'private', visibleClass: '', reviews: [], finished: false, ...extra });
const GUESTS = ['GV', 'GC2', 'GR', 'GP1', 'GP2'];                                 // invite-based guest coaches seeded directly

function seed() {
  const users = {
    [U.OFF]: user(U.OFF, 'Officer'), [U.OFFL]: user(U.OFFL, 'Listofficer'), [U.KM]: user(U.KM, 'Member'), [U.COR]: user(U.COR, 'Regcoach', { coach: true }),
    [U.STUDENT]: user(U.STUDENT, 'Student'), [U.STUDENT2]: user(U.STUDENT2, 'Studenttwo'),
    [U.LEG]: applicant(U.LEG, 'Legacyguest', { coach: true }), [U.KICK]: user(U.KICK, 'Kicked', { kicked: true }), [U.APPL]: applicant(U.APPL, 'Applicant'),
  };
  for (const k of GUESTS) users[U[k]] = applicant(U[k], 'Guest' + k.toLowerCase(), { coach: true });
  return {
    nextId: 20000, users,
    members: [char(501, U.OFF, 'Offchar'), char(504, U.KM, 'Kmchar'), char(505, U.COR, 'Corchar', BZ), char(506, U.STUDENT, 'Studchar'), char(507, U.STUDENT2, 'Studtwochar', BZ), char(509, U.KICK, 'Kickchar', { active: false })],
    coachLinks: [{ id: 811, coach: U.COR, class: 'Battleweaver', linkedAt: T }, { id: 812, coach: U.LEG, class: 'Battleweaver', linkedAt: T },
      ...GUESTS.map((k, i) => ({ id: 813 + i, coach: U[k], class: 'Battleweaver', linkedAt: T }))],
    guestCoaches: [{ id: 850, discordId: U.LEG, name: 'Legacyguest', avatar: '', addedAt: T },             // pre-B04 record: no `via`
      ...GUESTS.map((k, i) => ({ id: 851 + i, discordId: U[k], name: 'Guest' + k.toLowerCase(), avatar: '', addedAt: T, via: 'invite', inviteId: 8601 + i, invitedBy: U.OFF }))],
    guestCoachInvites: GUESTS.map((k, i) => ({ id: 8601 + i, tokenHash: crypto.randomBytes(32).toString('hex'), class: 'Battleweaver', createdBy: U.OFF, createdByName: 'Officer',
      createdAt: T, expiresAt: new Date(Date.parse(T) + H72).toISOString(), status: 'redeemed', redeemedBy: U[k], redeemedByName: 'Guest' + k.toLowerCase(), redeemedAt: T })),
    vods: [601, 602, 603, 604, 605, 606].map((n) => vod(n, U.STUDENT)).concat([vod(701, U.STUDENT2), vod(702, U.STUDENT2, { visibility: 'everyone' })]),
    vodMarkers: [
      { id: 9101, vodId: 604, createdBy: U.LEG, createdAt: T, timestamp: 10, beforeSeconds: 2, afterSeconds: 2, note: 'legacy point', strokes: [{ color: '#112233', points: [[0.1, 0.1], [0.5, 0.5]] }] },
      { id: 9102, vodId: 604, createdBy: U.COR, createdAt: T, timestamp: 20, beforeSeconds: 2, afterSeconds: 2, note: 'regular coach point', strokes: [] },
    ],
    gearScreens: [], gearFolder: [], gearSectionTypes: [{ id: 1, label: 'Gear' }],
    settings: { coachUserIds: [U.COR], officerUserIds: [U.OFFL], applications: { enabled: false }, branding: {} },
    events: [], points: [],
  };
}
// the legacy reviews on VOD 604 (one by the legacy guest coach, one by the regular coach)
const SEED_REVIEWS = { 604: [{ id: 9201, by: U.LEG, at: T, note: 'legacy review' }, { id: 9202, by: U.COR, at: T, note: 'regular coach review' }] };

let G; const S = {};
const SECRETS = [];                 // every raw token and tokenHash this suite knows; none may ever leak
const remember = (token) => { const h = crypto.createHash('sha256').update(token).digest('hex'); SECRETS.push(token, h); return h; };
const denied = (s) => s === 401 || s === 403;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const violations = () => { const v = []; return { want: (c, m) => { if (!c) v.push(m); }, done: () => assert.deepEqual(v, [], 'violations:\n' + v.join('\n')) }; };
const VIEW_KEYS = new Set(['id', 'class', 'status', 'createdAt', 'expiresAt', 'createdByName', 'redeemedAt', 'redeemedByName', 'redeemedBy', 'revokedAt', 'revokedByName']);

async function createInvite(cls = 'Battleweaver', cookie = S.OFF) {
  const r = await G.api('POST', '/api/admin/guest-invites', { cookie, body: { class: cls } });
  assert.equal(r.status, 200, `officer POST /api/admin/guest-invites {class:${cls}} -> ${r.status} ${r.text.slice(0, 120)} (want 200 { invite, link })`);
  assert.ok(r.json && r.json.invite && typeof r.json.link === 'string', `create response must be { invite, link }, got ${r.text.slice(0, 200)}`);
  const m = /\/#\/guest-invite\/([A-Za-z0-9_-]{43})$/.exec(r.json.link);
  assert.ok(m, `link must end with /#/guest-invite/<43-char base64url token>, got ${r.json.link}`);
  remember(m[1]);
  return { id: r.json.invite.id, token: m[1], invite: r.json.invite, link: r.json.link };
}
async function invites() {
  const r = await G.api('GET', '/api/admin/guest-invites', { cookie: S.OFF });
  assert.equal(r.status, 200, `officer GET /api/admin/guest-invites -> ${r.status} ${r.text.slice(0, 120)}`);
  assert.ok(Array.isArray(r.json), 'GET /api/admin/guest-invites must return an array, got ' + r.text.slice(0, 120));
  return r.json;
}
const inviteById = async (iid) => (await invites()).find((x) => x.id === iid);
async function officerState() { const r = await G.api('GET', '/api/state', { cookie: S.OFF }); assert.equal(r.status, 200, 'precondition: officer state ' + r.status); return r.json; }
const guestCoaches = async () => (await officerState()).guestCoaches || [];
const gcOf = async (key) => (await guestCoaches()).find((g) => g.discordId === key);
async function stateOf(cookie) { const r = await G.api('GET', '/api/state', { cookie }); return { status: r.status, json: r.json, vodIds: ((r.json && r.json.vods) || []).map((v) => v.id) }; }
const vodOf = async (vid) => (await officerState()).vods.find((v) => v.id === vid);
const markersOf = async (vid) => ((await vodOf(vid)) || { markers: [] }).markers.map((m) => m.id);
let GENERIC = null;                 // the one generic refusal message (captured from an unknown well-formed token)
async function expectRefusedBegin(token, what, v) {
  const b = await G.inviteBegin(token);
  const msg = b.json && b.json.error;
  v.want(b.status === 400, `${what}: begin -> ${b.status} (want 400) ${b.text.slice(0, 100)}`);
  v.want(!/gh_oauth=/.test(b.jar), `${what}: begin set an OAuth state cookie`);
  v.want(GENERIC === null || msg === GENERIC, `${what}: message "${msg}" differs from the generic "${GENERIC}"`);
  return b;
}
// a POST whose headers + first half of the body are sent now and the rest later (in-flight / TOCTOU)
function paused(p, cookie, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const head = `POST ${p} HTTP/1.1\r\nHost: localhost:${G.port}\r\nCookie: ${cookie}\r\nOrigin: ${G.base}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
  const half = Math.floor(body.length / 2);
  const pr = pendingRequest(G.port, head, body.slice(0, half));
  return { ready: pr.ready.then(() => sleep(200)), finish: () => pr.finish(body.slice(half)) };
}
const marker = (note, extra = {}) => ({ timestamp: 30, beforeSeconds: 2, afterSeconds: 2, note, strokes: [{ color: '#22aa44', points: [[0.2, 0.2], [0.4, 0.6], [0.7, 0.3]] }], ...extra });
const NEW_VOD = { url: 'https://youtu.be/zyxwvutsrqp', type: 'Wargame', recordedDate: '2026-10-02', enemyGuild: 'Rivals' };

before(async () => {
  const s = seed();
  for (const [vid, reviews] of Object.entries(SEED_REVIEWS)) s.vods.find((v) => v.id === Number(vid)).reviews = reviews;
  G = await startGuild({ seed: s, secret: SECRET, guild: GUILD, alliance: ALLIANCE,
    env: { DISCORD_OFFICER_USER_IDS: U.OFF, ALLIANCE_OFFICER_ROLE_IDS: ALLY_ROLE } });
  S.OFF = await G.login(U.OFF);
});
after(async () => { if (G) await G.close(); });

// =============================================================================================== invitations
test('I01 officer creates, lists and revokes an invitation; 72 h expiry; link format; no token/hash in views', async () => {
  const a = await createInvite('Battleweaver');
  const v = violations();
  v.want(a.link.startsWith(G.base + '/#/guest-invite/'), `link must be <PUBLIC_URL>/#/guest-invite/<token>, got ${a.link}`);
  v.want(a.invite.status === 'pending', `new invite status ${a.invite.status} (want pending)`);
  v.want(a.invite.class === 'Battleweaver', `new invite class ${a.invite.class}`);
  v.want(Date.parse(a.invite.expiresAt) - Date.parse(a.invite.createdAt) === H72, `expiresAt - createdAt = ${Date.parse(a.invite.expiresAt) - Date.parse(a.invite.createdAt)} ms (want exactly 72 h = ${H72})`);
  v.want(Math.abs(Date.parse(a.invite.createdAt) - Date.now()) < 60e3, `createdAt ${a.invite.createdAt} is not now`);
  // lead integration: the creator's display name is the officer's current Discord name (refreshed at sign-in)
  const officerName = (await G.api('GET', '/api/state', { cookie: S.OFF })).json.user.name;
  v.want(!!officerName && a.invite.createdByName === officerName, `createdByName ${a.invite.createdByName} (want the officer's display name ${officerName})`);
  v.want(!('token' in a.invite) && !('tokenHash' in a.invite), 'invite view in the create response carries token/tokenHash');
  const b = await createInvite('Berserker');
  v.want(a.token !== b.token, 'two invites got the same token');
  const list = await invites();
  const la = list.find((x) => x.id === a.id), lb = list.find((x) => x.id === b.id);
  v.want(la && la.status === 'pending' && lb && lb.class === 'Berserker', 'both invites listed as pending with their class');
  for (const x of list) for (const k of Object.keys(x)) v.want(VIEW_KEYS.has(k), `list view has non-contract field "${k}"`);
  const txt = JSON.stringify(list);
  v.want(!txt.includes(a.token) && !txt.includes(remember(a.token)), 'list contains the raw token or its hash');
  // class must be a real class
  const bad = await G.api('POST', '/api/admin/guest-invites', { cookie: S.OFF, body: { class: 'Not A Class' } });
  v.want(bad.status === 400, `create with an unknown class -> ${bad.status} (want 400)`);
  // revoke
  const rv = await G.api('DELETE', `/api/admin/guest-invites/${a.id}`, { cookie: S.OFF });
  v.want(rv.status === 200, `revoke pending -> ${rv.status}`);
  const after1 = await inviteById(a.id);
  v.want(after1 && after1.status === 'revoked' && after1.revokedByName === officerName && !!after1.revokedAt, `revoked view ${JSON.stringify(after1)}`);
  const again = await G.api('DELETE', `/api/admin/guest-invites/${a.id}`, { cookie: S.OFF });
  v.want(again.status === 409, `revoke a revoked invite -> ${again.status} (want 409)`);
  const unknown = await G.api('DELETE', '/api/admin/guest-invites/987654', { cookie: S.OFF });
  v.want(unknown.status === 404, `revoke unknown id -> ${unknown.status} (want 404)`);
  v.done();
});

test('I02 members, applicants, guest coaches, regular coaches, Alliance, support and anonymous cannot create, list or revoke', async () => {
  const target = await createInvite('Battleweaver');
  const before0 = (await invites()).length;
  const sessions = {
    member: await G.login(U.KM),
    'regular coach': await G.login(U.COR),
    applicant: G.mint({ key: U.APPL, name: 'Applicant', discord: true, exp: Date.now() + 864e5, iat: Date.now(), sid: 'b04-appl' }),
    'guest coach': await G.login(U.GV, [], { inGuild: false }),
    alliance: await G.login(PARTNER, [ALLY_ROLE], { alliance: true }),
  };
  const gen = await G.api('POST', '/api/admin/support-access/generate', { cookie: S.OFF });
  const sl = await G.api('POST', '/api/support/login', { body: { username: 'SupportAI', code: gen.json && gen.json.code } });
  assert.equal(sl.status, 200, 'precondition: support login ' + sl.text);
  sessions.support = sl.headers.get('set-cookie').split(';')[0];
  sessions.anonymous = undefined;
  const v = violations();
  for (const [who, cookie] of Object.entries(sessions)) {
    const c = await G.api('POST', '/api/admin/guest-invites', { cookie, body: { class: 'Battleweaver' } });
    v.want(denied(c.status), `${who} POST /api/admin/guest-invites -> ${c.status}`);
    v.want(!/guest-invite\//.test(c.text), `${who} create response contains a link`);
    const l = await G.api('GET', '/api/admin/guest-invites', { cookie });
    v.want(denied(l.status), `${who} GET /api/admin/guest-invites -> ${l.status}`);
    const d = await G.api('DELETE', `/api/admin/guest-invites/${target.id}`, { cookie });
    v.want(denied(d.status), `${who} DELETE /api/admin/guest-invites/:id -> ${d.status}`);
    if (cookie) {
      const b = await G.api('DELETE', `/api/admin/guest-invites/${target.id}`, { bearer: cookie.slice('gh_session='.length), headers: { Origin: undefined } });
      v.want(denied(b.status), `${who} Bearer DELETE /api/admin/guest-invites/:id -> ${b.status}`);
    }
  }
  await G.api('POST', '/api/admin/support-access/revoke', { cookie: S.OFF });
  const list = await invites();
  v.want(list.length === before0, `invite count changed from ${before0} to ${list.length}`);
  v.want((list.find((x) => x.id === target.id) || {}).status === 'pending', 'target invite is no longer pending');
  v.done();
});

test('I03 an officer removed in Admin > Officers cannot create or revoke with the old session', async () => {
  const target = await createInvite('Battleweaver');
  const offl = await G.login(U.OFFL);
  const pre = await G.api('GET', '/api/admin/guest-invites', { cookie: offl });
  assert.equal(pre.status, 200, `precondition: Admin-list officer can list invites -> ${pre.status}`);
  const before0 = (await invites()).length;
  assert.equal((await G.api('PUT', '/api/admin/officers', { cookie: S.OFF, body: { userIds: [] } })).status, 200, 'precondition: officer removed');
  const v = violations();
  const c = await G.api('POST', '/api/admin/guest-invites', { cookie: offl, body: { class: 'Battleweaver' } });
  v.want(denied(c.status), `removed officer create -> ${c.status}`);
  const d = await G.api('DELETE', `/api/admin/guest-invites/${target.id}`, { cookie: offl });
  v.want(denied(d.status), `removed officer revoke -> ${d.status}`);
  const l = await G.api('GET', '/api/admin/guest-invites', { cookie: offl });
  v.want(denied(l.status), `removed officer list -> ${l.status}`);
  v.want((await invites()).length === before0, 'an invite was created');
  v.want((await inviteById(target.id)).status === 'pending', 'target was revoked by the removed officer');
  v.done();
});

test('I04 malformed / invalid / oversized tokens: 400, one generic message, fast; begin is same-origin JSON only', async () => {
  const live = await createInvite('Battleweaver');
  const v = violations();
  const probe = await G.inviteBegin(crypto.randomBytes(32).toString('base64url'));
  assert.equal(probe.status, 400, `unknown well-formed token -> ${probe.status} (want 400) ${probe.text.slice(0, 100)}`);
  GENERIC = probe.json && probe.json.error;
  assert.ok(typeof GENERIC === 'string' && /invitation/i.test(GENERIC), `generic message must mention the invitation, got ${JSON.stringify(probe.json)}`);
  const cases = [
    ['empty string', ''], ['42 chars', 'A'.repeat(42)], ['44 chars', 'A'.repeat(44)], ['bad char', '!' + 'A'.repeat(42)], ['padding', live.token.slice(0, 42) + '='],
    ['trailing space', live.token + ' '], ['token prefix', live.token.slice(0, 20)], ['case-flipped token', live.token.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))],
    ['the stored hash instead of the token', remember(live.token)], ['link instead of token', live.link], ['100 KB', 'A'.repeat(100 * 1024)], ['unicode', 'ä'.repeat(43)],
  ];
  for (const [what, tok] of cases) {
    const b = await expectRefusedBegin(tok, what, v);
    v.want(b.ms < 1000, `${what}: took ${Math.round(b.ms)} ms`);
  }
  for (const [what, body] of [['number', { token: 12345 }], ['null', { token: null }], ['array', { token: [live.token] }], ['object', { token: { $ne: '' } }], ['missing', {}], ['not JSON', 'token=' + live.token], ['JSON array', [live.token]]]) {
    const b = await G.inviteBegin(null, { body });
    v.want(b.status === 400, `${what} body: begin -> ${b.status} (want 400)`);
    v.want(!/gh_oauth=/.test(b.jar), `${what} body: OAuth state cookie set`);
    v.want(b.json && b.json.error === GENERIC, `${what} body: message "${b.json && b.json.error}" is not the generic one`);
  }
  // cross-site attempts with a valid token: no state, nothing bound
  const xo = await G.inviteBegin(live.token, { headers: { Origin: 'https://evil.example' } });
  v.want(denied(xo.status) && !/gh_oauth=/.test(xo.jar), `cross-origin begin -> ${xo.status}, cookie ${xo.jar ? 'set' : 'none'}`);
  const tp = await G.inviteBegin(live.token, { headers: { 'Content-Type': 'text/plain' } });
  v.want(tp.status !== 200 && !/gh_oauth=/.test(tp.jar), `text/plain begin -> ${tp.status} (form-style CSRF must not start an invite sign-in)`);
  const xs = await G.inviteBegin(live.token, { headers: { Origin: undefined, 'Sec-Fetch-Site': 'cross-site' } });
  v.want(xs.status !== 200 && !/gh_oauth=/.test(xs.jar), `Sec-Fetch-Site: cross-site begin -> ${xs.status}`);
  // GET is not a way to begin
  const g = await fetch(G.base + '/auth/discord/invite?token=' + live.token, { redirect: 'manual' });
  v.want(!(g.headers.getSetCookie() || []).some((c) => /^gh_oauth=[^;]/.test(c)), `GET /auth/discord/invite?token= set an OAuth state cookie (${g.status})`);
  v.want((await inviteById(live.id)).status === 'pending', 'live invite is no longer pending');
  // the token itself still works afterwards (none of the above consumed it)
  const ok = await G.inviteLogin(live.token, U.XO);
  v.want(!!ok.cookie, `after all refused attempts the valid invite does not work: ${ok.begin.why}, loginError ${ok.loginError}`);
  v.done();
});

test('I05 single use; revoked invites (before and after the OAuth begin) are refused and consume nothing', async () => {
  const v = violations();
  const once = await createInvite('Battleweaver');
  const first = await G.inviteLogin(once.token, U.ONE);
  assert.ok(first.cookie, `first redemption must sign in: ${first.begin.why}, loginError ${first.loginError}`);
  const st = await inviteById(once.id);
  v.want(st.status === 'redeemed' && st.redeemedBy === U.ONE && !!st.redeemedAt, `after redemption: ${JSON.stringify(st)}`);
  await expectRefusedBegin(once.token, 'already used token', v);
  v.want(!(await gcOf(U.ONE2)), 'second account became a guest coach');
  // revoked before begin
  const r1 = await createInvite('Battleweaver');
  assert.equal((await G.api('DELETE', `/api/admin/guest-invites/${r1.id}`, { cookie: S.OFF })).status, 200, 'precondition: revoke');
  await expectRefusedBegin(r1.token, 'revoked token', v);
  // revoked after begin (state already bound): the callback must not redeem it
  const r2 = await createInvite('Battleweaver');
  const b = await G.inviteBegin(r2.token);
  assert.ok(b.ok, b.why);
  assert.equal((await G.api('DELETE', `/api/admin/guest-invites/${r2.id}`, { cookie: S.OFF })).status, 200, 'precondition: revoke after begin');
  const cb = await G.inviteCallback(b, U.REV);
  v.want(!cb.cookie && !!cb.loginError, `callback after revoke -> session ${cb.cookie ? 'ISSUED' : 'none'}, loginError ${cb.loginError}`);
  v.want(!(await gcOf(U.REV)), 'revoked-after-begin invite made the user a guest coach');
  v.want((await inviteById(r2.id)).status === 'revoked', 'revoked invite changed status');
  v.done();
});

test('I06 expiry: exactly at / after 72 h refused (status expired); valid just before; bound before expiry but called back after -> refused', async () => {
  const past = newInviteToken(), edge = newInviteToken(), fresh = newInviteToken(), inflight = newInviteToken();
  for (const x of [past, edge, fresh, inflight]) remember(x.token);
  let tInflight;
  await G.editDb((d) => {
    const now = Date.now();
    const rec = (iid, x, createdAt) => ({ id: iid, tokenHash: x.tokenHash, class: 'Battleweaver', createdBy: U.OFF, createdByName: 'Officer', createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + H72).toISOString(), status: 'pending' });
    tInflight = now + 6000;
    d.guestCoachInvites = [...(d.guestCoachInvites || []),
      rec(8701, past, now - H72 - 3600e3),            // expired an hour ago
      rec(8702, edge, now - H72),                     // expiresAt == the moment of seeding: expired (now >= expiresAt)
      rec(8703, fresh, now - H72 + 600e3),            // 10 minutes left
      rec(8704, inflight, tInflight - H72)];          // expires 6 s after seeding
    // Trusted offline fixture provisioning, not a database restore: the expiry test must put
    // legitimately issued records into the authoritative ledger as well as the application DB.
    // Restoring only db.json is separately required to fail in X08 and the RC2 adversarial tests.
    const ledger = require('../security-ledger').openLedger({dir:path.join(G.dir,'security-ledger'),binding:path.join(G.dir,'security-ledger-binding.json')});
    try { ledger.syncPolicy(require('../security-state').extract(d)); } finally { ledger.close(); }
  });
  const v = violations();
  const b = await G.inviteBegin(inflight.token);       // bound while still valid
  assert.ok(b.ok, `in-flight invite: ${b.why}`);
  assert.ok(Date.now() < tInflight, `precondition: bound before its expiry (${tInflight - Date.now()} ms left)`);
  await expectRefusedBegin(past.token, 'expired 1 h ago', v);
  await expectRefusedBegin(edge.token, 'expired exactly at 72 h', v);
  const list = await invites();
  v.want((list.find((x) => x.id === 8701) || {}).status === 'expired', `seeded expired invite shows status ${(list.find((x) => x.id === 8701) || {}).status} (want expired)`);
  v.want((list.find((x) => x.id === 8702) || {}).status === 'expired', `invite at exactly 72 h shows status ${(list.find((x) => x.id === 8702) || {}).status} (want expired)`);
  const ok = await G.inviteLogin(fresh.token, U.EXP2);
  v.want(!!ok.cookie, `invite with 10 minutes left does not work: ${ok.begin.why}, loginError ${ok.loginError}`);
  while (Date.now() <= tInflight + 300) await sleep(100);
  const cb = await G.inviteCallback(b, U.EXP);
  v.want(!cb.cookie && !!cb.loginError, `callback after expiry -> session ${cb.cookie ? 'ISSUED' : 'none'}, loginError ${cb.loginError}`);
  v.want(!(await gcOf(U.EXP)), 'an invite that expired between begin and callback was redeemed');
  v.want((await inviteById(8704) || {}).status === 'expired', 'in-flight invite is not shown as expired');
  v.done();
});

test('I07 two simultaneous redemptions of one invite (two OAuth states, different Discord ids) -> exactly one guest coach', async () => {
  const inv = await createInvite('Battleweaver');
  const ba = await G.inviteBegin(inv.token), bb = await G.inviteBegin(inv.token);
  assert.ok(ba.ok && bb.ok, `both begins must bind: ${ba.why} / ${bb.why}`);
  G.setMember(GUILD, U.RA, null); G.setMember(GUILD, U.RB, null);
  const [ca, cbb] = await Promise.all([G.inviteCallback(ba, U.RA), G.inviteCallback(bb, U.RB)]);
  const v = violations();
  const gcs = await guestCoaches();
  const winners = [U.RA, U.RB].filter((k) => gcs.some((g) => g.discordId === k));
  v.want(winners.length === 1, `guest coaches created: ${winners.length} (want exactly 1)`);
  v.want([ca, cbb].filter((x) => x.cookie).length === 1, `sessions issued: ${[ca, cbb].filter((x) => x.cookie).length} (want 1)`);
  const st = await inviteById(inv.id);
  v.want(st && st.status === 'redeemed' && winners.includes(st.redeemedBy), `invite after the race: ${JSON.stringify(st)}`);
  v.done();
});

test('I08 interrupted OAuth (begin, never called back, server restarted) -> invite still pending and usable; the old state grants nothing', async () => {
  const inv = await createInvite('Battleweaver');
  const b = await G.inviteBegin(inv.token);
  assert.ok(b.ok, b.why);
  await G.restart();
  const v = violations();
  v.want((await inviteById(inv.id)).status === 'pending', 'interrupted invite is not pending after restart');
  const stale = await G.inviteCallback(b, U.INT1);           // the browser comes back after the restart with the old state
  v.want(!(await gcOf(U.INT1)), 'a pre-restart OAuth state redeemed the invite after the restart (binding is memory-only)');
  v.want(!stale.cookie, 'pre-restart state issued a session to an outsider with applications closed');
  const ok = await G.inviteLogin(inv.token, U.INT2);
  v.want(!!ok.cookie && !!(await gcOf(U.INT2)), `invite not usable after interruption: ${ok.begin.why}, loginError ${ok.loginError}`);
  v.done();
});

test('I09 replayed callback (same URL + cookie twice): no second session, no second consumption', async () => {
  const inv = await createInvite('Battleweaver');
  const b = await G.inviteBegin(inv.token);
  assert.ok(b.ok, b.why);
  const first = await G.inviteCallback(b, U.RPL);
  assert.ok(first.cookie, `precondition: first callback signs in (loginError ${first.loginError})`);
  const st1 = await inviteById(inv.id);
  const second = await G.inviteCallback(b, U.RPL);
  const v = violations();
  v.want(!second.cookie, 'the replayed callback issued a second session');
  const st2 = await inviteById(inv.id);
  v.want(st2.status === 'redeemed' && st2.redeemedAt === st1.redeemedAt && st2.redeemedBy === U.RPL, `invite changed on replay: ${JSON.stringify(st1)} -> ${JSON.stringify(st2)}`);
  v.want((await guestCoaches()).filter((g) => g.discordId === U.RPL).length === 1, 'replay created a second guest-coach record');
  const ex = await G.api('GET', '/api/export', { cookie: S.OFF });
  v.want(ex.json.coachLinks.filter((l) => l.coach === U.RPL).length === 1, 'replay created a second coach link');
  v.done();
});

test('I10 a token cannot be substituted between begin and callback: only the server-side state binding counts', async () => {
  const A = await createInvite('Battleweaver'), B = await createInvite('Berserker');
  const v = violations();
  // (a) plain sign-in begun without any invite; the token is smuggled into the callback (query + cookie)
  const s0 = await fetch(G.base + '/auth/discord', { redirect: 'manual' });
  const jar = s0.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  const st = new URL(s0.headers.get('location')).searchParams.get('state');
  const a = await G.inviteCallback({ state: st, jar: `${jar}; gh_invite=${B.token}; gh_guestinvite=${B.token}` }, U.SUB1,
    { extraQuery: `&token=${B.token}&invite=${B.token}&inviteToken=${B.token}` });
  v.want(!a.cookie, 'plain sign-in with a smuggled token issued a session (applications are closed)');
  v.want(!(await gcOf(U.SUB1)), 'plain sign-in with a smuggled token made a guest coach');
  // (b) begun with A, callback carries B: A decides, B stays pending
  const b = await G.inviteBegin(A.token);
  assert.ok(b.ok, 'begin A: ' + b.why);
  const r = await G.inviteCallback({ ...b, jar: `${b.jar}; gh_invite=${B.token}` }, U.SUB2, { extraQuery: `&token=${B.token}&invite=${B.id}&class=Berserker` });
  v.want(!!r.cookie, `redemption of A failed: ${r.loginError}`);
  const gc = await gcOf(U.SUB2);
  v.want(gc && gc.class === 'Battleweaver', `class after redeeming A with B smuggled in: ${gc && gc.class} (want Battleweaver)`);
  v.want((await inviteById(A.id)).status === 'redeemed', 'A not redeemed');
  v.want((await inviteById(B.id)).status === 'pending', 'B was consumed by a callback it was never bound to');
  v.done();
});

test('I11 legacy path closed: /auth/discord?guestcoach=1 grants nothing with applications closed; POST /api/guest-coaches/join records nothing', async () => {
  const v = violations();
  const c = await G.login(U.LEGX, [], { guestcoach: true, inGuild: false, expectCookie: false });
  v.want(!c, 'outsider got a session through /auth/discord?guestcoach=1 with applications CLOSED');
  v.want(!(await gcOf(U.LEGX)), 'outsider became a guest coach via ?guestcoach=1');
  const before0 = await G.api('GET', '/api/export', { cookie: S.OFF });
  const appl = G.mint({ key: U.APPL, name: 'Applicant', discord: true, exp: Date.now() + 864e5, iat: Date.now(), sid: 'b04-appl2' });
  const j1 = await G.api('POST', '/api/guest-coaches/join', { cookie: appl, body: { class: 'Battleweaver' } });
  v.want(j1.status === 410 || j1.status === 403, `applicant POST /api/guest-coaches/join -> ${j1.status} (want 410)`);
  const gv = await G.login(U.GV, [], { inGuild: false });
  const j2 = await G.api('POST', '/api/guest-coaches/join', { cookie: gv, body: { class: 'Berserker' } });
  v.want(j2.status === 410 || j2.status === 403, `guest coach POST /api/guest-coaches/join (class switch) -> ${j2.status} (want 410)`);
  const after0 = await G.api('GET', '/api/export', { cookie: S.OFF });
  v.want(JSON.stringify(after0.json.guestCoaches) === JSON.stringify(before0.json.guestCoaches), 'join changed db.guestCoaches');
  v.want(JSON.stringify(after0.json.coachLinks) === JSON.stringify(before0.json.coachLinks), 'join changed db.coachLinks');
  v.want(!after0.json.auditLog.some((e) => e.action === 'guestcoach.join'), 'join wrote an audit entry');
  // restore GV for the later VOD tests if the baseline switched its class
  const gvLink = after0.json.coachLinks.find((l) => l.coach === U.GV);
  if (!gvLink || gvLink.class !== 'Battleweaver') await G.api('PUT', `/api/guest-coaches/${U.GV}/class`, { cookie: S.OFF, body: { class: 'Battleweaver' } });
  v.done();
});

// =============================================================================================== identity
test('D01 redemption binds to the Discord id proven at the callback; plain sign-in later keeps access; survives restart; stays applicant', async () => {
  const inv = await createInvite('Battleweaver');
  const v = violations();
  // attacker-chosen identity fields in the begin body and in the callback query must be ignored
  let b = await G.inviteBegin(null, { body: { token: inv.token, discordId: U.OTHER, key: U.OTHER, id: U.OTHER, class: 'Berserker' } });
  if (b.status === 400) b = await G.inviteBegin(inv.token);                    // rejecting extra fields is fine too
  assert.ok(b.ok, b.why);
  const cb = await G.inviteCallback(b, U.NEW1, { extraQuery: `&discordId=${U.OTHER}&key=${U.OTHER}&user=${U.OTHER}` });
  assert.ok(cb.cookie, `redemption did not sign in: loginError ${cb.loginError}`);
  const gcs = await guestCoaches();
  const gc = gcs.find((g) => g.discordId === U.NEW1);
  v.want(!!gc, 'callback-proven account is not a guest coach');
  v.want(!gcs.some((g) => g.discordId === U.OTHER), 'body/query-claimed account became a guest coach');
  v.want(gc && gc.via === 'invite' && gc.inviteId === inv.id && gc.invitedBy === U.OFF, `guest record ${JSON.stringify(gc)} (want via invite, inviteId ${inv.id}, invitedBy officer)`);
  v.want(gc && gc.class === 'Battleweaver', `class ${gc && gc.class} (want the invite's Battleweaver, not the body's Berserker)`);
  const st = await inviteById(inv.id);
  v.want(st.status === 'redeemed' && st.redeemedBy === U.NEW1, `invite ${JSON.stringify(st)}`);
  const s1 = await stateOf(cb.cookie);
  v.want(s1.status === 200 && s1.json.user.key === U.NEW1 && s1.json.user.role === 'applicant', `state user ${JSON.stringify(s1.json && s1.json.user)}`);
  v.want(s1.vodIds.includes(601) && !s1.vodIds.includes(701) && !s1.vodIds.includes(702), `visible VODs ${s1.vodIds}`);
  // the account stays an applicant: no member / officer routes
  for (const [m, p, body] of [['GET', '/api/export'], ['GET', '/api/gearthreads/506'], ['PUT', '/api/prefs', { timezone: 'UTC' }], ['GET', '/api/admin/guest-invites'],
    ['POST', '/api/admin/guest-invites', { class: 'Battleweaver' }], ['PUT', `/api/guest-coaches/${U.NEW1}/class`, { class: 'Berserker' }], ['GET', '/api/admin/audit']]) {
    const r = await G.api(m, p, { cookie: cb.cookie, body });
    v.want(r.status === 403, `invited guest ${m} ${p} -> ${r.status} (want 403)`);
  }
  // a later plain sign-in (no invite, applications closed) keeps guest access
  const plain = await G.login(U.NEW1, [], { inGuild: false, expectCookie: false });
  v.want(!!plain, 'plain /auth/discord sign-in of the invited guest coach was refused');
  if (plain) { const s2 = await stateOf(plain); v.want(s2.vodIds.includes(601) && s2.json.user.role === 'applicant', `after plain sign-in: role ${s2.json && s2.json.user.role}, VODs ${s2.vodIds}`); }
  // restart: record, link and session survive
  await G.restart();
  const s3 = await stateOf(cb.cookie);
  v.want(s3.status === 200 && s3.vodIds.includes(601), `after restart: ${s3.status}, VODs ${s3.vodIds}`);
  const gc2 = await gcOf(U.NEW1);
  v.want(gc2 && gc2.via === 'invite' && gc2.class === 'Battleweaver', `after restart guest record ${JSON.stringify(gc2)}`);
  v.want((await inviteById(inv.id)).status === 'redeemed', 'invite status lost on restart');
  v.done();
});

test('D02 a legacy guest coach (no `via`) keeps access after the upgrade, shows as via legacy, and its VODs/markers/reviews are intact', async () => {
  const v = violations();
  const gc = await gcOf(U.LEG);
  v.want(gc && gc.via === 'legacy', `legacy guest in the officer list: ${JSON.stringify(gc)} (want via 'legacy')`);
  v.want(gc && gc.id === 850 && gc.name === 'Legacyguest' && gc.addedAt === T && gc.class === 'Battleweaver', `legacy record changed: ${JSON.stringify(gc)}`);
  const c = await G.login(U.LEG, [], { inGuild: false, expectCookie: false });
  v.want(!!c, 'legacy guest coach can no longer sign in');
  if (c) {
    const s = await stateOf(c);
    const v604 = (s.json.vods || []).find((x) => x.id === 604);
    v.want(s.json.user.role === 'applicant' && !!v604, `legacy guest state: role ${s.json.user.role}, VODs ${s.vodIds}`);
    v.want(v604 && v604.markers.map((m) => m.id).sort().join() === '9101,9102', `markers on 604: ${v604 && v604.markers.map((m) => m.id)}`);
    v.want(v604 && v604.markers.find((m) => m.id === 9101).strokes.length === 1, 'legacy marker strokes lost');
    v.want(v604 && v604.reviews.map((r) => r.id).join() === '9201,9202', `reviews on 604: ${v604 && v604.reviews.map((r) => r.id)}`);
    const mk = await G.api('POST', '/api/vods/601/markers', { cookie: c, body: marker('legacy still works') });
    v.want(mk.status === 200, `legacy guest adds a coaching point -> ${mk.status}`);
  }
  const ex = await G.api('GET', '/api/export', { cookie: S.OFF });
  const rec = ex.json.guestCoaches.find((g) => g.discordId === U.LEG);
  v.want(rec && rec.via === 'legacy' && rec.id === 850 && rec.addedAt === T, `stored legacy record ${JSON.stringify(rec)}`);
  v.want(ex.json.coachLinks.some((l) => l.id === 812 && l.coach === U.LEG && l.class === 'Battleweaver'), 'legacy coach link changed');
  v.done();
});

test('D03 removal (DELETE /api/guest-coaches/:id) immediately ends every session, including a copied cookie / Bearer', async () => {
  const c1 = await G.login(U.GR, [], { inGuild: false }), c2 = await G.login(U.GR, [], { inGuild: false });
  assert.ok((await stateOf(c1)).vodIds.includes(601), 'precondition: guest sees the class VOD');
  assert.equal((await G.api('DELETE', `/api/guest-coaches/${U.GR}`, { cookie: S.OFF })).status, 200, 'precondition: removal');
  const v = violations();
  v.want((await stateOf(c1)).status === 401, `removed guest session GET /api/state -> ${(await stateOf(c1)).status} (want 401)`);
  v.want((await stateOf(c2)).status === 401, `removed guest second session -> ${(await stateOf(c2)).status} (want 401)`);
  const br = await G.api('GET', '/api/state', { bearer: c1.slice('gh_session='.length) });
  v.want(br.status === 401, `copied cookie as Bearer -> ${br.status} (want 401)`);
  const rv = await G.api('POST', '/api/vods/601/reviews', { cookie: c1, body: { note: 'after removal' } });
  v.want(denied(rv.status), `removed guest review -> ${rv.status}`);
  v.want(!(await G.login(U.GR, [], { inGuild: false, expectCookie: false })), 'removed guest can sign in again with applications closed');
  v.done();
});

test('D04 class change applies immediately: old-class VODs, markers, reviews (incl. direct ids and VODs they posted) gone; new class granted', async () => {
  const c = await G.login(U.GC2, [], { inGuild: false });
  const own = await G.api('POST', '/api/vods/601/markers', { cookie: c, body: marker('gc2 point') });
  assert.equal(own.status, 200, 'precondition: marker on old class');
  const rv = await G.api('POST', '/api/vods/601/reviews', { cookie: c, body: { note: 'gc2 review' } });
  assert.equal(rv.status, 200, 'precondition: review on old class');
  const posted = await G.api('POST', '/api/vods', { cookie: c, body: { owner: U.STUDENT, ...NEW_VOD } });
  assert.equal(posted.status, 200, 'precondition: guest posts a VOD for a student of its class ' + posted.text);
  assert.equal((await G.api('PUT', `/api/guest-coaches/${U.GC2}/class`, { cookie: S.OFF, body: { class: 'Berserker' } })).status, 200, 'precondition: class change');
  const v = violations();
  const s = await stateOf(c);
  v.want(!s.vodIds.includes(601) && !s.vodIds.includes(604) && !s.vodIds.includes(posted.json.id), `old-class VODs still visible: ${s.vodIds}`);
  v.want(s.vodIds.includes(701), `new-class VOD 701 not visible: ${s.vodIds}`);
  for (const [m, p, body] of [['POST', '/api/vods/601/markers', marker('x')], ['PUT', `/api/vods/601/markers/${own.json.id}`, marker('edit')], ['DELETE', `/api/vods/601/markers/${own.json.id}`],
    ['POST', '/api/vods/601/reviews', { note: 'x' }], ['PUT', `/api/vods/601/reviews/${rv.json.id}`, { note: 'edit' }], ['DELETE', `/api/vods/601/reviews/${rv.json.id}`],
    ['POST', `/api/vods/601/reviews/${rv.json.id}/resend`], ['PUT', '/api/vods/601/finished', { finished: true }], ['POST', '/api/vods', { owner: U.STUDENT, ...NEW_VOD }],
    ['PUT', `/api/vods/${posted.json.id}`, { note: 'mine?' }], ['DELETE', `/api/vods/${posted.json.id}`], ['POST', `/api/vods/${posted.json.id}/reviews`, { note: 'x' }]]) {
    const r = await G.api(m, p, { cookie: c, body });
    v.want(r.status === 403, `after class change ${m} ${p} -> ${r.status} (want 403)`);
  }
  const m7 = await G.api('POST', '/api/vods/701/markers', { cookie: c, body: marker('new class') });
  v.want(m7.status === 200, `new-class marker -> ${m7.status}`);
  const r7 = await G.api('POST', '/api/vods/701/reviews', { cookie: c, body: { note: 'new class' } });
  v.want(r7.status === 200, `new-class review -> ${r7.status}`);
  v.want((await markersOf(601)).includes(own.json.id), 'old-class marker data was deleted by the class change (should only lose access)');
  v.done();
});

test('D05 a request paused before removal / class change cannot complete afterwards', async () => {
  const c1 = await G.login(U.GP1, [], { inGuild: false }), c2 = await G.login(U.GP2, [], { inGuild: false });
  const p1 = paused('/api/vods/606/reviews', c1, { note: 'paused-before-removal' });
  const p2 = paused('/api/vods/606/markers', c2, marker('paused-before-class-change'));
  await Promise.all([p1.ready, p2.ready]);
  assert.equal((await G.api('DELETE', `/api/guest-coaches/${U.GP1}`, { cookie: S.OFF })).status, 200, 'precondition: removal');
  assert.equal((await G.api('PUT', `/api/guest-coaches/${U.GP2}/class`, { cookie: S.OFF, body: { class: 'Berserker' } })).status, 200, 'precondition: class change');
  const [r1, r2] = await Promise.all([p1.finish(), p2.finish()]);
  const v = violations();
  v.want(denied(r1.status), `paused review finished after removal -> ${r1.status}`);
  v.want(denied(r2.status), `paused marker finished after class change -> ${r2.status}`);
  const v606 = await vodOf(606);
  v.want(!v606.reviews.some((r) => r.note === 'paused-before-removal'), 'paused review was stored');
  v.want(!v606.markers.some((m) => m.note === 'paused-before-class-change'), 'paused marker was stored');
  v.done();
});

// =============================================================================================== VOD permissions
test('V01 guest coach: sees own-class VODs, adds markers (with strokes) and reviews, edits/deletes its OWN, marks finished, posts for a student', async () => {
  const c = await G.login(U.GV, [], { inGuild: false });
  const v = violations();
  const s = await stateOf(c);
  v.want([601, 602, 603, 604].every((x) => s.vodIds.includes(x)), `guest does not see its class's private VODs: ${s.vodIds}`);
  const m1 = await G.api('POST', '/api/vods/601/markers', { cookie: c, body: marker('gv point') });
  v.want(m1.status === 200 && m1.json.strokes.length === 1 && m1.json.strokes[0].points.length === 3, `create marker with strokes -> ${m1.status} ${m1.text.slice(0, 120)}`);
  const e1 = await G.api('PUT', `/api/vods/601/markers/${m1.json.id}`, { cookie: c, body: marker('gv point edited') });
  v.want(e1.status === 200 && e1.json.note === 'gv point edited', `edit own marker -> ${e1.status}`);
  const d1 = await G.api('DELETE', `/api/vods/601/markers/${m1.json.id}`, { cookie: c });
  v.want(d1.status === 200 && !(await markersOf(601)).includes(m1.json.id), `delete own marker -> ${d1.status}`);
  const r1 = await G.api('POST', '/api/vods/601/reviews', { cookie: c, body: { note: 'gv review' } });
  v.want(r1.status === 200, `write review -> ${r1.status}`);
  const re = await G.api('PUT', `/api/vods/601/reviews/${r1.json.id}`, { cookie: c, body: { note: 'gv review edited' } });
  v.want(re.status === 200, `edit own review -> ${re.status}`);
  const rs = await G.api('POST', `/api/vods/601/reviews/${r1.json.id}/resend`, { cookie: c });
  v.want(rs.status === 200, `resend own review -> ${rs.status}`);
  const rd = await G.api('DELETE', `/api/vods/601/reviews/${r1.json.id}`, { cookie: c });
  v.want(rd.status === 200, `DELETE own review (new route) -> ${rd.status} (want 200)`);
  v.want(!(await vodOf(601)).reviews.some((r) => r.id === r1.json.id), 'own review still present after DELETE');
  const fin = await G.api('PUT', '/api/vods/601/finished', { cookie: c, body: { finished: true } });
  v.want(fin.status === 200, `mark finished -> ${fin.status}`);
  const post = await G.api('POST', '/api/vods', { cookie: c, body: { owner: U.STUDENT, ...NEW_VOD } });
  v.want(post.status === 200, `post a VOD for a student of its class -> ${post.status}`);
  v.done();
});

test('V02 guest coach: cannot edit/delete another coach\'s marker or review, delete the VOD, or edit title/note/visibility', async () => {
  const c = await G.login(U.GV, [], { inGuild: false });
  const v = violations();
  for (const [m, p, body] of [['PUT', '/api/vods/604/markers/9102', marker('hijack')], ['DELETE', '/api/vods/604/markers/9102'], ['PUT', '/api/vods/604/markers/9101', marker('hijack')], ['DELETE', '/api/vods/604/markers/9101'],
    ['PUT', '/api/vods/604/reviews/9202', { note: 'hijack' }], ['DELETE', '/api/vods/604/reviews/9202'], ['DELETE', '/api/vods/604/reviews/9201'], ['POST', '/api/vods/604/reviews/9202/resend'],
    ['PUT', '/api/vods/602', { note: 'renamed' }], ['PUT', '/api/vods/602', { type: 'Siege', recordedDate: '2026-01-01' }],
    ['PUT', '/api/vods/602', { visibility: 'everyone' }], ['PUT', '/api/vods/602', { visibility: 'class', visibleClass: 'Berserker' }], ['DELETE', '/api/vods/602']]) {
    const r = await G.api(m, p, { cookie: c, body });
    v.want(r.status === 403, `guest ${m} ${p} ${body ? JSON.stringify(body).slice(0, 50) : ''} -> ${r.status} (want 403)`);
  }
  const v604 = await vodOf(604), v602 = await vodOf(602);
  const mk = (mid) => ((v604 && v604.markers) || []).find((m) => m.id === mid), rvw = (rid) => ((v604 && v604.reviews) || []).find((r) => r.id === rid);
  v.want(!!mk(9101) && !!mk(9102), `604 markers now ${v604 && v604.markers.map((m) => m.id)} (want 9101,9102 untouched)`);
  v.want(!!mk(9102) && mk(9102).note === 'regular coach point' && !!mk(9101) && mk(9101).note === 'legacy point', 'another coach\'s marker was modified');
  v.want(!!rvw(9202) && rvw(9202).note === 'regular coach review' && !!rvw(9201), 'another coach\'s review was modified/deleted');
  v.want(!!v602 && v602.note === 'n602' && v602.visibility === 'private' && v602.type === 'Wargame', `VOD 602 after guest attempts: ${JSON.stringify(v602 && { note: v602.note, visibility: v602.visibility, type: v602.type })}`);
  v.done();
});

test('V03 regular coach and officer keep their rights (delete student VOD, edit any marker; officer everything; reviews own-only)', async () => {
  const gv = await G.login(U.GV, [], { inGuild: false }), cor = await G.login(U.COR);
  const gm = await G.api('POST', '/api/vods/603/markers', { cookie: gv, body: marker('gv on 603') });
  assert.equal(gm.status, 200, 'precondition: guest marker');
  const gr = await G.api('POST', '/api/vods/605/reviews', { cookie: gv, body: { note: 'gv on 605' } });
  assert.equal(gr.status, 200, 'precondition: guest review');
  const cr = await G.api('POST', '/api/vods/603/reviews', { cookie: cor, body: { note: 'coach review on 603' } });
  assert.equal(cr.status, 200, 'precondition: regular coach review');
  const gm2 = await G.api('POST', '/api/vods/605/markers', { cookie: gv, body: marker('gv on 605') });
  assert.equal(gm2.status, 200, 'precondition: second guest marker');
  const v = violations();
  const ce = await G.api('PUT', `/api/vods/603/markers/${gm.json.id}`, { cookie: cor, body: marker('coach edits guest point') });
  v.want(ce.status === 200, `regular coach edits a guest's marker -> ${ce.status}`);
  const cn = await G.api('PUT', '/api/vods/603', { cookie: cor, body: { note: 'coach note' } });
  v.want(cn.status === 200, `regular coach edits VOD note -> ${cn.status}`);
  const cv = await G.api('PUT', '/api/vods/603', { cookie: cor, body: { visibility: 'class', visibleClass: 'Battleweaver' } });
  v.want(cv.status === 200, `regular coach changes visibility -> ${cv.status}`);
  const cgr = await G.api('DELETE', `/api/vods/605/reviews/${gr.json.id}`, { cookie: cor });
  v.want(cgr.status === 403, `regular coach deletes a guest's review -> ${cgr.status} (want 403, own only)`);
  const crv = await G.api('DELETE', `/api/vods/603/reviews/${cr.json.id}`, { cookie: cor });
  v.want(crv.status === 200, `regular coach deletes own review -> ${crv.status}`);
  const cd = await G.api('DELETE', '/api/vods/603', { cookie: cor });
  v.want(cd.status === 200, `regular coach deletes a student VOD -> ${cd.status}`);
  // officer
  const om = await G.api('DELETE', `/api/vods/605/markers/${gm2.json.id}`, { cookie: S.OFF });
  v.want(om.status === 200, `officer deletes a guest's marker -> ${om.status}`);
  const ogr = await G.api('DELETE', `/api/vods/605/reviews/${gr.json.id}`, { cookie: S.OFF });
  v.want(ogr.status === 403, `officer deletes a guest's review -> ${ogr.status} (contract: own only)`);
  const orv = await G.api('POST', '/api/vods/605/reviews', { cookie: S.OFF, body: { note: 'officer review' } });
  const ord = await G.api('DELETE', `/api/vods/605/reviews/${orv.json && orv.json.id}`, { cookie: S.OFF });
  v.want(ord.status === 200, `officer deletes own review -> ${ord.status}`);
  const ov = await G.api('PUT', '/api/vods/605', { cookie: S.OFF, body: { visibility: 'everyone' } });
  v.want(ov.status === 200, `officer changes visibility -> ${ov.status}`);
  const od = await G.api('DELETE', '/api/vods/605', { cookie: S.OFF });
  v.want(od.status === 200, `officer deletes a VOD -> ${od.status}`);
  v.done();
});

test('V04 cross-class denied for a guest coach, including direct ids and "everyone" VODs of another class', async () => {
  const c = await G.login(U.GV, [], { inGuild: false });
  const v = violations();
  const s = await stateOf(c);
  v.want(!s.vodIds.includes(701) && !s.vodIds.includes(702), `guest sees other-class VODs: ${s.vodIds}`);
  const sv = await G.api('GET', '/api/state?vod=702', { cookie: c });
  v.want(!((sv.json && sv.json.vods) || []).some((x) => x.id === 702), 'GET /api/state?vod=702 returned the other-class VOD');
  for (const [m, p, body] of [['POST', '/api/vods/701/markers', marker('x')], ['POST', '/api/vods/702/markers', marker('x')], ['POST', '/api/vods/701/reviews', { note: 'x' }],
    ['PUT', '/api/vods/701/finished', { finished: true }], ['PUT', '/api/vods/701', { note: 'x' }], ['DELETE', '/api/vods/701'], ['DELETE', '/api/vods/702'],
    ['POST', '/api/vods', { owner: U.STUDENT2, ...NEW_VOD }]]) {
    const r = await G.api(m, p, { cookie: c, body });
    v.want(r.status === 403, `guest (Battleweaver) ${m} ${p} -> ${r.status} (want 403)`);
  }
  v.want(!!(await vodOf(701)) && !!(await vodOf(702)), 'an other-class VOD was deleted');
  v.done();
});

// =============================================================================================== eligibility
test('E01 members, officers, kicked users and existing guest coaches are refused; the invite stays pending and still works', async () => {
  const inv = await createInvite('Berserker');
  const v = violations();
  for (const [who, key, inGuild] of [['member', U.KM, true], ['officer', U.OFF, true], ['kicked user', U.KICK, true], ['legacy guest coach', U.LEG, false], ['invite guest coach', U.GV, false]]) {
    const r = await G.inviteLogin(inv.token, key, { inGuild });
    v.want(!r.beginFailed, `${who}: ${r.begin.why}`);
    v.want(!!r.loginError && !r.cookie, `${who}: redemption not refused (session ${r.cookie ? 'issued' : 'none'}, loginError ${r.loginError})`);
    v.want((await inviteById(inv.id) || {}).status === 'pending', `${who}: invite no longer pending`);
  }
  const gcs = await guestCoaches();
  v.want(!gcs.some((g) => [U.KM, U.OFF, U.KICK].includes(g.discordId)), 'a member/officer/kicked user became a guest coach');
  v.want((gcs.find((g) => g.discordId === U.GV) || {}).class === 'Battleweaver', 'existing guest coach was moved to the invite\'s class');
  v.want((gcs.find((g) => g.discordId === U.LEG) || {}).class === 'Battleweaver', 'legacy guest coach was moved to the invite\'s class');
  const ok = await G.inviteLogin(inv.token, U.ELIG);
  v.want(!!ok.cookie && (await gcOf(U.ELIG) || {}).class === 'Berserker', `invite unusable after refused attempts: ${ok.begin.why}, loginError ${ok.loginError}`);
  v.done();
});

// =============================================================================================== secrecy (last)
test('S01 no raw token or tokenHash in: invite list, officer/support state, export, audit log, db.json (raw token), server logs', async () => {
  const fresh = await createInvite('Battleweaver');           // one pending invite whose hash is definitely stored
  assert.ok(SECRETS.length >= 2, 'precondition: the suite captured tokens');
  const v = violations();
  const leaks = (what, text) => { for (const s of SECRETS) if (text.includes(s)) { v.want(false, `${what} contains a ${s.length === 64 ? 'tokenHash' : 'raw token'} (${s.slice(0, 6)}...)`); return; } };
  leaks('GET /api/admin/guest-invites', JSON.stringify(await invites()));
  leaks('officer GET /api/state', JSON.stringify(await officerState()));
  const ex = await G.api('GET', '/api/export', { cookie: S.OFF });
  assert.equal(ex.status, 200, 'precondition: export');
  leaks('GET /api/export', ex.text);
  v.want(/tokenHash/.test(ex.text) === false, 'GET /api/export contains a tokenHash field');
  v.want(Array.isArray(ex.json.guestCoachInvites) && ex.json.guestCoachInvites.some((x) => x.id === fresh.id), 'GET /api/export lacks guestCoachInvites (stripped of tokenHash, not removed)');
  const au = await G.api('GET', '/api/admin/audit?limit=200', { cookie: S.OFF });
  leaks('audit log', au.text);
  v.want(/guest-invite\//.test(au.text) === false, 'audit log contains an invite link');
  await G.stop();                                             // flush, then inspect what is on disk and in the logs
  const disk = fs.readFileSync(path.join(G.dir, 'db.json'), 'utf8');
  for (const s of SECRETS.filter((x) => x.length === 43)) if (disk.includes(s)) { v.want(false, 'db.json stores a raw token'); break; }
  v.want(disk.includes(crypto.createHash('sha256').update(fresh.token).digest('hex')), 'db.json does not store the sha256 tokenHash of a pending invite');
  const logs = G.logs.join('');
  leaks('server stdout/stderr', logs);
  v.want(!/guest-invite\//.test(logs), 'server logs contain an invite link');
  v.done();
});
