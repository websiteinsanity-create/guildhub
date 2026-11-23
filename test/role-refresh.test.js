'use strict';
// Role refresh (GuildHub 1.46.2-hotfix.2): authoritative re-reads of stored Discord roles with the bot token.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoleRefresh } = require('../role-refresh');
const { createDiscord } = require('../discord');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111';
const A = '200000000000000001', B = '200000000000000002', C = '200000000000000003', OLD = '200000000000000009';
const OFFICER = '900000000000000001', MEMBER = '900000000000000010';
const TOKEN = 'very-secret-bot-token';
const T0 = Date.parse('2026-11-10T12:00:00Z');
const MIN = 60e3, DAY = 86400e3;

function harness({ answers = {}, users } = {}) {
  let t = T0;
  const db = { users: users || {
    [A]: { id: A, inGuild: true, discordRoles: [OFFICER], lastLogin: new Date(T0 - DAY).toISOString() },
    [B]: { id: B, inGuild: true, discordRoles: [MEMBER], lastLogin: new Date(T0 - 2 * DAY).toISOString() },
  }, settings: {} };
  const calls = [], logs = [], changes = [];
  let saves = 0;
  const discord = {
    botEnabled: true, cfg: { guildId: GUILD },
    async guildMember(g, u) { calls.push([g, u]); const a = answers[u]; return typeof a === 'function' ? a() : (a || { ok: false, kind: 'error' }); },
  };
  const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const rr = createRoleRefresh({ discord, getDb: () => db, save: () => { saves++; }, now: () => t, maxStaleMs: 60 * MIN, delayMs: 0, log, onChange: (k, b, a) => changes.push({ k, b, a }) });
  return { rr, db, calls, logs, changes, discord, answers, saves: () => saves, advance: (ms) => { t += ms; }, now: () => t };
}

test('role granted: new role stored, onChange called, saved once', async () => {
  const h = harness({ answers: { [A]: { ok: true, roles: [OFFICER], nick: null }, [B]: { ok: true, roles: [MEMBER, OFFICER], nick: 'x' } } });
  const s = await h.rr.tick();
  assert.deepEqual(h.db.users[B].discordRoles, [MEMBER, OFFICER]);
  assert.equal(h.db.users[B].inGuild, true);
  assert.equal(s.checked, 2); assert.equal(s.changed, 1);
  assert.equal(h.saves(), 1);
  assert.deepEqual(h.changes, [{ k: B, b: { discordRoles: [MEMBER], inGuild: true }, a: { discordRoles: [MEMBER, OFFICER], inGuild: true } }]);
  assert.ok(h.calls.every(([g]) => g === GUILD));
});

test('role removed: stored roles shrink and onChange reports before/after', async () => {
  const h = harness({ answers: { [A]: { ok: true, roles: [], nick: null }, [B]: { ok: true, roles: [MEMBER] } } });
  await h.rr.tick();
  assert.deepEqual(h.db.users[A].discordRoles, []);
  assert.equal(h.changes.length, 1);
  assert.deepEqual(h.changes[0].b.discordRoles, [OFFICER]);
  assert.deepEqual(h.changes[0].a.discordRoles, []);
  assert.equal(h.saves(), 1);
});

test('user leaves the guild (10007): inGuild false, roles cleared, counted as checked + notMember', async () => {
  const h = harness({ answers: { [A]: { ok: false, kind: 'not_member' }, [B]: { ok: true, roles: [MEMBER] } } });
  const s = await h.rr.tick();
  assert.equal(h.db.users[A].inGuild, false);
  assert.deepEqual(h.db.users[A].discordRoles, []);
  assert.equal(s.notMember, 1); assert.equal(s.checked, 2);
  assert.deepEqual(h.changes[0].a, { discordRoles: [], inGuild: false });
  assert.ok(h.rr.isFresh(A), 'a 10007 answer is authoritative knowledge');
});

test('timeout / 5xx / network errors change nothing and do not count as checked', async () => {
  for (const kind of ['error']) {
    const h = harness({ answers: { [A]: { ok: false, kind }, [B]: () => { throw new Error('boom'); } } });
    const before = JSON.stringify(h.db);
    const s = await h.rr.tick();
    assert.equal(JSON.stringify(h.db), before);
    assert.equal(s.failed, 2); assert.equal(s.checked, 0);
    assert.equal(h.saves(), 0); assert.equal(h.changes.length, 0);
    assert.equal(h.rr.stats().lastSuccessAt, null);
  }
});

test('429 stops the tick, changes nothing, and blocks ticks until retry_after has passed', async () => {
  const h = harness({ answers: { [A]: { ok: false, kind: 'rate_limited', retryAfter: 30 }, [B]: { ok: true, roles: [] } } });
  // A has the newest lastLogin, so B (older) is asked first; make B rate limited too to be order-independent
  h.answers[B] = { ok: false, kind: 'rate_limited', retryAfter: 30 };
  const before = JSON.stringify(h.db);
  const s = await h.rr.tick();
  assert.equal(s.rateLimited, 1);
  assert.equal(h.calls.length, 1, 'the tick stopped at the first 429');
  assert.equal(JSON.stringify(h.db), before);
  assert.equal(h.saves(), 0);
  await h.rr.tick();
  assert.equal(h.calls.length, 1, 'no lookups while Discord asked us to wait');
  h.advance(31e3);
  h.answers[A] = { ok: true, roles: [OFFICER] }; h.answers[B] = { ok: true, roles: [MEMBER] };
  const s2 = await h.rr.tick();
  assert.equal(s2.checked, 2); assert.equal(s2.rateLimited, 0);
});

test('bot without access to the guild (401/403/10004): no change, not fresh by refresh', async () => {
  const h = harness({ answers: { [A]: { ok: false, kind: 'no_access', status: 403 }, [B]: { ok: false, kind: 'no_access', status: 404 } } });
  const s = await h.rr.tick();
  assert.equal(s.failed, 2); assert.equal(s.failures.no_access, 2);
  assert.deepEqual(h.db.users[A].discordRoles, [OFFICER]);
  assert.equal(h.saves(), 0);
});

test('freshness: lastLogin counts, then expires after maxStale; a successful check renews it; recovery after outage', async () => {
  const h = harness({ users: { [A]: { id: A, inGuild: true, discordRoles: [OFFICER], lastLogin: new Date(T0).toISOString() } } });
  assert.equal(h.rr.freshness(A), T0);
  assert.equal(h.rr.isFresh(A), true);
  h.advance(60 * MIN); assert.equal(h.rr.isFresh(A), true, 'exactly maxStale is still fresh');
  h.answers[A] = { ok: false, kind: 'error' };
  await h.rr.tick();                                  // outage: no renewal
  h.advance(1); assert.equal(h.rr.isFresh(A), false, 'beyond maxStale without a successful check');
  assert.deepEqual(h.db.users[A].discordRoles, [OFFICER], 'suspended, not deleted');
  h.advance(2 * 60 * MIN);
  h.answers[A] = { ok: true, roles: [OFFICER] };      // Discord is back
  await h.rr.tick();
  assert.equal(h.rr.isFresh(A), true);
  assert.equal(h.rr.freshness(A), h.now());
  assert.equal(h.rr.stats().lastSuccessAt, h.now());
  assert.equal(h.saves(), 0, 'nothing changed, nothing saved');
  assert.equal(h.rr.isFresh('200000000000000077'), false, 'unknown keys are never fresh');
});

test('save is only called when something changed; unchanged role order is not a change', async () => {
  const h = harness({ answers: { [A]: { ok: true, roles: [OFFICER] }, [B]: { ok: true, roles: [MEMBER] } } });
  h.db.users[B].discordRoles = [MEMBER];
  await h.rr.tick(); await h.rr.tick();
  assert.equal(h.saves(), 0); assert.equal(h.changes.length, 0);
});

test('only Discord-snowflake users who signed in within 30 days are refreshed', async () => {
  const h = harness({ users: {
    [A]: { inGuild: true, discordRoles: [], lastLogin: new Date(T0 - 29 * DAY).toISOString() },
    [OLD]: { inGuild: true, discordRoles: [], lastLogin: new Date(T0 - 31 * DAY).toISOString() },
    [C]: { inGuild: true, discordRoles: [] },                                     // never signed in
    'Passcode Player': { lastLogin: new Date(T0).toISOString() },                  // not a Discord id
  } });
  h.answers[A] = { ok: true, roles: [] };
  await h.rr.tick();
  assert.deepEqual(h.calls.map((c) => c[1]), [A]);
});

test('at most one tick runs at a time; requests are sequential', async () => {
  let inFlight = 0, maxInFlight = 0;
  const slow = () => new Promise((r) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); setTimeout(() => { inFlight--; r({ ok: true, roles: [] }); }, 5); });
  const h = harness({ answers: { [A]: slow, [B]: slow } });
  const [s1, s2] = await Promise.all([h.rr.tick(), h.rr.tick()]);
  assert.equal(s1, s2);
  assert.equal(h.calls.length, 2); assert.equal(maxInFlight, 1);
});

test('no bot configured: tick does nothing', async () => {
  const h = harness();
  h.discord.botEnabled = false;
  const s = await h.rr.tick();
  assert.equal(h.calls.length, 0); assert.equal(s.skipped, 1);
});

test('onChange throwing does not break the tick or prevent saving', async () => {
  const db = { users: { [A]: { inGuild: true, discordRoles: [OFFICER], lastLogin: new Date(T0).toISOString() } } };
  let saves = 0;
  const rr = createRoleRefresh({ discord: { botEnabled: true, cfg: { guildId: GUILD }, guildMember: async () => ({ ok: true, roles: [] }) }, getDb: () => db, save: () => saves++, now: () => T0, delayMs: 0, log: { log() {}, warn() {} }, onChange: () => { throw new Error('x'); } });
  await rr.tick();
  assert.equal(saves, 1); assert.deepEqual(db.users[A].discordRoles, []);
});

test('start/stop manage an unref-ed interval timer without an immediate burst', async () => {
  const h = harness({ answers: { [A]: { ok: true, roles: [OFFICER] }, [B]: { ok: true, roles: [MEMBER] } } });
  const rr = createRoleRefresh({ discord: h.discord, getDb: () => h.db, now: () => T0, delayMs: 0, intervalMs: 20, log: { log() {}, warn() {} } });
  rr.start(); rr.start();
  assert.equal(h.calls.length, 0, 'no immediate tick on start');
  await new Promise((r) => setTimeout(r, 70));
  rr.stop();
  const n = h.calls.length;
  assert.ok(n >= 2, 'interval ticks ran');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.calls.length, n, 'stopped');
});

test('end to end through discord.guildMember and the fake Discord: kinds map correctly and logs carry no ids or tokens', async () => {
  const fake = await startFakeDiscord();
  fake.state.botToken = TOKEN;
  fake.state.memberLookup = true;
  fake.state.guildMembersByGuild = { [GUILD]: { [A]: { roles: [OFFICER], nick: 'Nick' } } };
  const discord = createDiscord({ DISCORD_BOT_TOKEN: TOKEN, DISCORD_GUILD_ID: GUILD, DISCORD_API_BASE: fake.url, DISCORD_MEMBER_TIMEOUT_MS: '300' });
  try {
    assert.deepEqual(await discord.guildMember(GUILD, A), { ok: true, roles: [OFFICER], nick: 'Nick' });
    assert.deepEqual(await discord.guildMember(GUILD, B), { ok: false, kind: 'not_member' });
    for (const [mode, expect] of [['500', { ok: false, kind: 'error', status: 500 }], ['403', { ok: false, kind: 'no_access', status: 403 }], ['401', { ok: false, kind: 'no_access', status: 401 }], ['10004', { ok: false, kind: 'no_access', status: 404 }], ['reset', { ok: false, kind: 'error' }], ['hang', { ok: false, kind: 'error' }]]) {
      fake.state.memberFail = { mode };
      assert.deepEqual(await discord.guildMember(GUILD, A), expect, mode);
    }
    fake.state.memberFail = { mode: '429', retryAfter: 2.5 };
    assert.deepEqual(await discord.guildMember(GUILD, A), { ok: false, kind: 'rate_limited', retryAfter: 2.5 });
    fake.state.memberFail = null;
    assert.deepEqual(await discord.guildMember('nope', A), { ok: false, kind: 'invalid' });
    assert.deepEqual(await createDiscord({ DISCORD_API_BASE: fake.url }).guildMember(GUILD, A), { ok: false, kind: 'no_bot' });

    const db = { users: {
      [A]: { inGuild: true, discordRoles: [], lastLogin: new Date().toISOString() },
      [B]: { inGuild: true, discordRoles: [MEMBER], lastLogin: new Date().toISOString() },
      [C]: { inGuild: true, discordRoles: [MEMBER], lastLogin: new Date().toISOString() },
    } };
    const lines = [];
    const log = { log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    fake.state.memberFail = { mode: '500', guild: '333333333333333333' };   // other guild only: no effect here
    const rr = createRoleRefresh({ discord, getDb: () => db, delayMs: 0, log });
    let s = await rr.tick();
    assert.equal(s.checked, 3);
    assert.deepEqual(db.users[A].discordRoles, [OFFICER]);
    assert.equal(db.users[B].inGuild, false); assert.equal(db.users[C].inGuild, false);
    // an outage: nothing changes, a summary line is logged
    fake.state.guildMembersByGuild[GUILD][B] = { roles: [MEMBER] };
    fake.state.memberFail = { mode: '500' };
    s = await rr.tick();
    assert.equal(s.failed, 3);
    assert.equal(db.users[B].inGuild, false);
    assert.ok(lines.length >= 2);
    const all = lines.join('\n');
    for (const secret of [A, B, C, GUILD, OFFICER, MEMBER, TOKEN, 'Nick']) assert.ok(!all.includes(secret), 'log leaks ' + secret);
    assert.match(all, /failed=3/);
  } finally { fake.close(); }
});

test('fake Discord answers bot member lookups from sign-in membership; memberLookup=false keeps the old answers', async () => {
  const fake = await startFakeDiscord();
  const discord = createDiscord({ DISCORD_BOT_TOKEN: 'x', DISCORD_GUILD_ID: GUILD, DISCORD_API_BASE: fake.url });
  try {
    fake.state.guildMembers[A] = { roles: [OFFICER] };
    assert.deepEqual(await discord.guildMember(GUILD, A), { ok: true, roles: [OFFICER], nick: null });
    assert.deepEqual(await discord.guildMember(GUILD, '999000000000000001'), { ok: true, roles: ['900000000000000099'], nick: null });
    assert.deepEqual(await discord.botMember('999000000000000001'), { ok: true, roles: ['900000000000000099'] });
    fake.state.memberLookup = false;   // pre-1.46.2.2 fake behaviour: only the bot itself is a member
    assert.deepEqual(await discord.guildMember(GUILD, A), { ok: false, kind: 'not_member' });
    assert.deepEqual(await discord.botMember('999000000000000001'), { ok: true, roles: ['900000000000000099'] });
  } finally { fake.close(); }
});
