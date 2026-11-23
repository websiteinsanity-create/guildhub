'use strict';
// Alliance partner verification (GuildHub 1.46.2-hotfix.2): live bot lookups, never token roles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const createPolicy = require('../alliance-policy');
const installAlliance = require('../server-alliance');
const { createDiscord } = require('../discord');
const { startFakeDiscord } = require('./fake-discord');

const INSANITY = '111111111111111111', PARTNER_GUILD = '222222222222222222';
const P = '555555555555555555', Q = '555555555555555556', ADMIN = '333333333333333333';
const PROLE = '777777777777777777', OTHER = '788888888888888888';
const MIN = 60e3;

function harness({ env = {}, members = {}, isOfficerKey } = {}) {
  let t = Date.parse('2026-11-10T12:00:00Z');
  const db = { users: { [ADMIN]: { inGuild: true, discordRoles: [] } }, settings: { officerUserIds: [], officerRoleIds: [] } };
  const calls = [];
  const answers = { ...members };
  const discord = {
    loginEnabled: true, botEnabled: true, cfg: { guildId: INSANITY, officerUserIds: [], officerRoleIds: [] },
    async guildMember(g, u) { calls.push([g, u]); const a = answers[u]; return typeof a === 'function' ? a() : (a || { ok: false, kind: 'not_member' }); },
    async botInfo() { return { ok: true, id: '999000000000000001' }; },
  };
  const policy = createPolicy({ getDb: () => db, discord, env: { ALLIANCE_GUILD_ID: PARTNER_GUILD, ALLIANCE_OFFICER_ROLE_IDS: PROLE, ...env }, now: () => t, isOfficerKey });
  const partner = (key = P, extra = {}) => ({ key, name: 'Partner', role: 'alliance', discord: true, allianceGuildId: PARTNER_GUILD, ...extra });
  return { db, discord, policy, calls, answers, partner, advance: (ms) => { t += ms; } };
}
const member = (...roles) => ({ ok: true, roles, nick: null });

test('authorized partner: live role in the partner guild allows, result is cached for 10 minutes', async () => {
  const h = harness({ members: { [P]: member(PROLE) } });
  const v = await h.policy.verifyPartner(h.partner());
  assert.deepEqual([v.ok, v.reason], [true, 'allowed']);
  assert.deepEqual(h.calls, [[PARTNER_GUILD, P]]);
  assert.ok(h.policy.canPartner(h.partner(), PARTNER_GUILD, v));
  h.advance(9 * MIN);
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
  assert.equal(h.calls.length, 1, 'served from cache');
});

test('cache expires after 10 minutes and a removed partner role then denies', async () => {
  const h = harness({ members: { [P]: member(PROLE) } });
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
  h.answers[P] = member(OTHER);
  h.advance(10 * MIN - 1);
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, true, 'still inside the fresh window');
  h.advance(1);
  const v = await h.policy.verifyPartner(h.partner());
  assert.deepEqual([v.ok, v.reason], [false, 'role_missing']);
  assert.equal(h.calls.length, 2);
  assert.equal(h.policy.canPartner(h.partner(), PARTNER_GUILD, v), false);
});

test('partner who left the partner server (10007) is denied', async () => {
  const h = harness({ members: { [P]: { ok: false, kind: 'not_member' } } });
  const v = await h.policy.verifyPartner(h.partner());
  assert.deepEqual([v.ok, v.reason], [false, 'not_member']);
  // an allowlisted USER id still has to be a member
  h.db.settings.allianceAccess = { enabled: true, officerRoleIds: [], officerUserIds: [P] };
  h.advance(11 * MIN);
  assert.equal((await h.policy.verifyPartner(h.partner())).reason, 'not_member');
});

test('allowlist removal and re-adding take effect immediately even with a fresh cached lookup', async () => {
  const h = harness({ members: { [P]: member(PROLE) } });
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
  h.db.settings.allianceAccess = { enabled: true, officerRoleIds: [OTHER], officerUserIds: [] };
  let v = await h.policy.verifyPartner(h.partner());
  assert.deepEqual([v.ok, v.reason], [false, 'role_missing']);
  h.db.settings.allianceAccess = { enabled: true, officerRoleIds: [], officerUserIds: [] };
  v = await h.policy.verifyPartner(h.partner());
  assert.deepEqual([v.ok, v.reason], [false, 'not_allowlisted']);
  h.db.settings.allianceAccess = { enabled: true, officerRoleIds: [], officerUserIds: [P] };
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
  assert.equal(h.calls.length, 1, 'all decisions above used the one cached live lookup');
  // env allowlist (no stored settings) also applies immediately
  delete h.db.settings.allianceAccess;
  const h2 = harness({ env: { ALLIANCE_OFFICER_ROLE_IDS: '', ALLIANCE_OFFICER_USER_IDS: P }, members: { [P]: member() } });
  assert.equal((await h2.policy.verifyPartner(h2.partner())).ok, true);
});

test('access disabled denies immediately, without a Discord call', async () => {
  const h = harness({ members: { [P]: member(PROLE) } });
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
  h.db.settings.allianceAccess = { enabled: false, officerRoleIds: [PROLE], officerUserIds: [] };
  const v = await h.policy.verifyPartner(h.partner());
  assert.deepEqual([v.ok, v.reason], [false, 'disabled']);
  assert.equal(h.policy.canPartner(h.partner(), PARTNER_GUILD, { ...v, ok: true, reason: 'allowed' }), false, 'canPartner rechecks enabled itself');
  assert.equal(h.calls.length, 1);
});

test('bot not in the partner guild (403 / 10004 / 401 / no bot) fails closed, even with a previous positive result', async () => {
  for (const r of [{ ok: false, kind: 'no_access', status: 403 }, { ok: false, kind: 'no_access', status: 404 }, { ok: false, kind: 'no_access', status: 401 }, { ok: false, kind: 'no_bot' }]) {
    const h = harness({ members: { [P]: member(PROLE) } });
    assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
    h.answers[P] = r; h.advance(11 * MIN);
    const v = await h.policy.verifyPartner(h.partner());
    assert.deepEqual([v.ok, v.reason], [false, 'bot_no_access'], JSON.stringify(r));
    assert.notEqual(h.policy.verifyStats().lastNoAccessAt, null);
  }
});

test('Discord outage: previous positive lookup is reused up to 30 minutes, never beyond; never a negative or no lookup', async () => {
  for (const failure of [{ ok: false, kind: 'error' }, { ok: false, kind: 'rate_limited', retryAfter: 5 }, () => { throw new Error('x'); }]) {
    const h = harness({ members: { [P]: member(PROLE) } });
    assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
    h.answers[P] = failure;
    h.advance(20 * MIN);
    let v = await h.policy.verifyPartner(h.partner());
    assert.deepEqual([v.ok, v.reason, v.degraded], [true, 'allowed', true]);
    // the allowlist still applies to the reused lookup
    h.db.settings.allianceAccess = { enabled: true, officerRoleIds: [OTHER], officerUserIds: [] };
    assert.equal((await h.policy.verifyPartner(h.partner())).ok, false);
    delete h.db.settings.allianceAccess;
    h.advance(10 * MIN);                 // exactly 30 minutes since the lookup
    assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
    h.advance(1);
    v = await h.policy.verifyPartner(h.partner());
    assert.deepEqual([v.ok, v.reason], [false, 'unverifiable']);
  }
  // an outage with no previous lookup, or after a negative one, denies
  const h = harness({ members: { [Q]: { ok: false, kind: 'error' }, [P]: { ok: false, kind: 'not_member' } } });
  assert.equal((await h.policy.verifyPartner(h.partner(Q))).reason, 'unverifiable');
  assert.equal((await h.policy.verifyPartner(h.partner(P))).reason, 'not_member');
  h.answers[P] = { ok: false, kind: 'error' }; h.advance(11 * MIN);
  assert.equal((await h.policy.verifyPartner(h.partner(P))).reason, 'unverifiable');
});

test('stale window is configurable and never shorter than the fresh window', async () => {
  const h = harness({ env: { ALLIANCE_VERIFY_FRESH_MINUTES: '2', ALLIANCE_VERIFY_MAX_STALE_MINUTES: '5' }, members: { [P]: member(PROLE) } });
  await h.policy.verifyPartner(h.partner());
  h.advance(2 * MIN); h.answers[P] = { ok: false, kind: 'error' };
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, true);
  h.advance(3 * MIN + 1);
  assert.equal((await h.policy.verifyPartner(h.partner())).ok, false);
  assert.deepEqual([h.policy.verifyStats().freshMs, h.policy.verifyStats().maxStaleMs], [2 * MIN, 5 * MIN]);
});

test('canPartner ignores forged token roles and needs this user\'s own verification', async () => {
  const h = harness({ members: { [P]: member(OTHER), [Q]: member(PROLE) } });
  const forged = h.partner(P, { allianceRoles: [PROLE] });
  assert.equal(h.policy.canPartner(forged, PARTNER_GUILD), false, 'no verification -> no access');
  const v = await h.policy.verifyPartner(forged);
  assert.deepEqual([v.ok, v.reason], [false, 'role_missing'], 'live roles decide, not the token');
  assert.equal(h.policy.canPartner(forged, PARTNER_GUILD, v), false);
  const vq = await h.policy.verifyPartner(h.partner(Q));
  assert.equal(vq.ok, true);
  assert.equal(h.policy.canPartner(forged, PARTNER_GUILD, vq), false, "another user's verification is not accepted");
  assert.equal(h.policy.canPartner(h.partner(Q), INSANITY, vq), false, 'wrong guild');
  assert.equal(h.policy.canPartner({ ...h.partner(Q), role: 'officer' }, PARTNER_GUILD, vq), false);
});

test('wrong guild, non-alliance sessions and misconfiguration are denied without a Discord call', async () => {
  const h = harness({ members: { [P]: member(PROLE) } });
  assert.equal((await h.policy.verifyPartner(h.partner(P, { allianceGuildId: INSANITY }))).reason, 'wrong_guild');
  assert.equal((await h.policy.verifyPartner({ key: P, role: 'officer', discord: true })).reason, 'not_alliance');
  assert.equal((await h.policy.verifyPartner(null)).reason, 'not_alliance');
  assert.equal((await h.policy.verifyPartner(h.partner('not-a-snowflake'))).reason, 'not_alliance');
  const same = harness({ env: { ALLIANCE_GUILD_ID: INSANITY } });
  assert.equal((await same.policy.verifyPartner(same.partner(P, { allianceGuildId: INSANITY }))).reason, 'wrong_guild');
  assert.equal(h.calls.length + same.calls.length, 0);
});

test('concurrent requests for one partner share a single lookup', async () => {
  let n = 0;
  const h = harness({ members: { [P]: () => new Promise((r) => { n++; setTimeout(() => r(member(PROLE)), 10); }) } });
  const all = await Promise.all([1, 2, 3, 4].map(() => h.policy.verifyPartner(h.partner())));
  assert.ok(all.every((v) => v.ok)); assert.equal(n, 1);
});

test('canAdmin uses the injected isOfficerKey (not the session role) and keeps the exclusions', async () => {
  const officers = new Set([ADMIN]);
  const h = harness({ isOfficerKey: (k) => officers.has(k) });
  const admin = { key: ADMIN, discord: true, role: 'member' };
  assert.equal(h.policy.canAdmin(admin), true, 'officer status from the resolver, not the token role');
  assert.equal(h.policy.canAdmin({ ...admin, role: 'officer', key: '444444444444444444' }), false, 'a token role of officer is not enough');
  officers.delete(ADMIN);
  assert.equal(h.policy.canAdmin({ ...admin, role: 'officer' }), false, 'officer removal is immediate');
  officers.add(ADMIN);
  for (const change of [{ support: true }, { readOnly: true }, { role: 'alliance' }, { role: 'applicant' }, { discord: false }]) assert.equal(h.policy.canAdmin({ ...admin, ...change }), false, JSON.stringify(change));
  h.db.users[ADMIN].kicked = true; assert.equal(h.policy.canAdmin(admin), false); h.db.users[ADMIN].kicked = false;
  h.db.users[ADMIN].applicant = true; assert.equal(h.policy.canAdmin(admin), false); h.db.users[ADMIN].applicant = false;
  h.db.users[ADMIN].inGuild = false; assert.equal(h.policy.canAdmin(admin), false); h.db.users[ADMIN].inGuild = true;
  const throwing = harness({ isOfficerKey: () => { throw new Error('x'); } });
  assert.equal(throwing.policy.canAdmin(admin), false, 'a failing resolver denies');
});

test('diagnose classifies whether the bot can read partner-guild members', async () => {
  const h = harness();
  h.answers['999000000000000001'] = member();
  assert.deepEqual(await h.policy.diagnose(), { ok: true, reason: 'ok', guildConfigured: true, canReadMembers: true });
  assert.deepEqual(h.calls.at(-1), [PARTNER_GUILD, '999000000000000001']);
  h.answers['999000000000000001'] = { ok: false, kind: 'not_member' };
  assert.equal((await h.policy.diagnose()).reason, 'ok');
  h.answers['999000000000000001'] = { ok: false, kind: 'no_access', status: 403 };
  assert.deepEqual(await h.policy.diagnose(), { ok: false, reason: 'bot_no_access', status: 403, guildConfigured: true, canReadMembers: false });
  h.answers['999000000000000001'] = { ok: false, kind: 'error' };
  assert.equal((await h.policy.diagnose()).reason, 'unverifiable');
  h.discord.botEnabled = false;
  assert.equal((await h.policy.diagnose()).reason, 'no_bot');
  assert.equal((await harness({ env: { ALLIANCE_GUILD_ID: '' } }).policy.diagnose()).reason, 'not_configured');
});

test('end to end with discord.js and the fake Discord: per-guild membership, bot outside the partner guild', async () => {
  const fake = await startFakeDiscord();
  fake.state.memberLookup = true;
  fake.state.guildMembersByGuild = { [PARTNER_GUILD]: { [P]: { roles: [PROLE] }, '999000000000000001': { roles: [] } } };
  fake.state.guildMembers[Q] = { roles: [PROLE] };   // Q is only known for the OAuth route / fallback
  const discord = createDiscord({ DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: INSANITY, DISCORD_API_BASE: fake.url, DISCORD_MEMBER_TIMEOUT_MS: '300' });
  const db = { users: {}, settings: {} };
  let t = Date.now();
  const policy = createPolicy({ getDb: () => db, discord, env: { ALLIANCE_GUILD_ID: PARTNER_GUILD, ALLIANCE_OFFICER_ROLE_IDS: PROLE }, now: () => t });
  const user = (key) => ({ key, role: 'alliance', discord: true, allianceGuildId: PARTNER_GUILD, allianceRoles: [PROLE] });
  try {
    assert.equal((await policy.verifyPartner(user(P))).ok, true);
    assert.equal((await policy.diagnose()).reason, 'ok');
    fake.state.memberFail = { mode: '10004', guild: PARTNER_GUILD };
    assert.equal((await policy.diagnose()).reason, 'bot_no_access');
    t += 11 * MIN;
    assert.equal((await policy.verifyPartner(user(P))).reason, 'bot_no_access');
    fake.state.memberFail = { mode: 'hang', guild: PARTNER_GUILD };
    assert.equal((await policy.verifyPartner(user(P))).reason, 'unverifiable', 'a bot_no_access answer drops the earlier positive lookup, so a later timeout cannot revive it');
  } finally { fake.close(); }
});

// ---- server-alliance.js: every partner-reachable route awaits verifyPartner for alliance sessions ----
async function allianceRoutes(verifyPartner) {
  const shot = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); if (req.url.endsWith('/callers')) return res.end(JSON.stringify({ callers: [{ id: P }] })); res.end(JSON.stringify({ active: false, sessionState: 'inactive', id: 'b', bridge: { state: 'x' } })); });
  await new Promise((r) => shot.listen(0, '127.0.0.1', r));
  const routes = [];
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const need = (ok, status, msg) => { if (!ok) throw new HttpError(status, msg); };
  const policy = createPolicy({ getDb: () => ({ users: {}, settings: {} }), discord: { loginEnabled: true, cfg: { guildId: INSANITY } }, env: {} });
  installAlliance({ route: (method, path, handler, opts) => routes.push({ method, path, handler, opts }), need, shotcaller: { url: 'http://127.0.0.1:' + shot.address().port, apiKey: 'k', guildId: INSANITY }, allianceGuildId: PARTNER_GUILD, audit: () => {}, canAdmin: (u) => u.role === 'officer', getDb: () => ({ settings: {} }), verifyPartner, partnerMessage: policy.partnerMessage });
  return { routes, close: () => shot.close() };
}
const bodyFor = (path) => (path.endsWith('/start') ? { count: 2, channelId: 'c' } : path.endsWith('/bridge') ? { action: 'pause' } : path.endsWith('/dedicated') || path.endsWith('/additional-callers') ? { userIds: [P] } : {});

test('server-alliance: every route denies an alliance session whose verification fails, before contacting Shotcaller', async () => {
  const seen = [];
  const { routes, close } = await allianceRoutes(async (u) => { seen.push(u.key); return { ok: false, reason: 'role_missing', key: u.key }; });
  try {
    assert.ok(routes.length >= 17);
    for (const r of routes) {
      const user = { key: P, name: 'P', role: 'alliance', allianceGuildId: PARTNER_GUILD };
      await assert.rejects(r.handler({ user, body: bodyFor(r.path), params: {} }), (e) => e.status === 403 && /removed/.test(e.message), r.method + ' ' + r.path);
    }
    assert.equal(seen.length, routes.length);
  } finally { close(); }
});

test('server-alliance: allowed partners and Insanity admins keep identical behaviour; missing verifier fails closed', async () => {
  let verified = 0;
  const { routes, close } = await allianceRoutes(async (u) => { verified++; return { ok: true, reason: 'allowed', key: u.key }; });
  const find = (m, p) => routes.find((r) => r.method === m && r.path === p);
  try {
    const partner = { key: P, name: 'P', role: 'alliance', allianceGuildId: PARTNER_GUILD };
    const status = await find('GET', '/api/alliance/status').handler({ user: partner });
    assert.deepEqual(Object.keys(status), ['active', 'sessionState', 'sessionId', 'muted', 'paused', 'dedicated', 'additionalCallers', 'parties', 'bridge']);
    assert.equal((await find('GET', '/api/alliance/callers').handler({ user: partner })).callers.length, 1);
    assert.equal((await find('POST', '/api/alliance/bridge').handler({ user: partner, body: { action: 'pause' } })).id, 'b');
    await assert.rejects(find('GET', '/api/alliance/permissions').handler({ user: partner }), (e) => e.status === 403, 'admin paths still need canAdmin');
    assert.equal(verified, 4);
    const admin = { key: ADMIN, name: 'A', role: 'officer' };
    assert.equal((await find('GET', '/api/alliance/context').handler({ user: admin })).mode, 'insanity-admin');
    assert.equal(verified, 4, 'Insanity sessions are not partner-verified');
  } finally { close(); }
  const none = await allianceRoutes(null);
  try {
    await assert.rejects(none.routes.find((r) => r.path === '/api/alliance/status').handler({ user: { key: P, role: 'alliance' } }), (e) => e.status === 403);
  } finally { none.close(); }
});
