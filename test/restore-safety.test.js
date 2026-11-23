// Hotfix 1.46.2.2 (F-B "persistence and restore safety"): what happens to revoked sessions when data is restored.
// Two restore paths exist: the in-app restore (POST /api/import, replaces db.json only) and an operator restoring an
// older copy of the whole data folder. Fictional data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startGuild } = require('./hf2-helpers');

const GUILD = '111111111111111111', SECRET = 'restore-safety-test-secret';
const OFFICER = '410000000000000001', MEMBER = '410000000000000002';
const T = '2026-10-01T18:00:00.000Z';
const seed = () => ({
  nextId: 100,
  users: { [OFFICER]: { id: OFFICER, name: 'Officer', role: 'officer', inGuild: true, accepted: true }, [MEMBER]: { id: MEMBER, name: 'Member', role: 'member', inGuild: true, accepted: true } },
  members: [{ id: 11, owner: MEMBER, name: 'Memberchar', role: 'DPS', active: true, primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow', joinedAt: T, builds: [] }],
  settings: { applications: { enabled: true }, branding: {} }, events: [], points: [],
});

test('in-app restore (POST /api/import of an older export) keeps every revocation: logged-out and kicked sessions stay dead', async () => {
  const G = await startGuild({ seed: seed(), secret: SECRET, guild: GUILD, env: { DISCORD_OFFICER_USER_IDS: OFFICER } });
  try {
    const off = await G.login(OFFICER), d1 = await G.login(MEMBER), d2 = await G.login(MEMBER);
    const exp = await G.api('GET', '/api/export', { cookie: off });
    assert.equal(exp.status, 200);
    const older = exp.json;                                                     // snapshot BEFORE the logout and the kick
    assert.equal((await G.api('POST', '/api/logout', { cookie: d1 })).status, 200);
    assert.equal((await G.api('POST', '/api/admin/kick', { cookie: off, body: { ownerKey: MEMBER, reason: 'test' } })).status, 200);
    assert.equal((await G.api('GET', '/api/state', { cookie: d2 })).status, 401, 'kick revoked the second device');
    const imp = await G.api('POST', '/api/import', { cookie: off, body: older });
    assert.equal(imp.status, 200, 'restore of the older export');
    assert.equal((await G.api('GET', '/api/state', { cookie: d1 })).status, 401, 'logged-out session stays revoked after the in-app restore');
    assert.equal((await G.api('GET', '/api/state', { cookie: d2 })).status, 401, 'kick-revoked session stays revoked after the in-app restore');
    // SEC-06: ledger-authoritative kick survives restoration, including new sign-ins.
    const fresh = await G.login(MEMBER);
    assert.equal((await G.api('GET', '/api/state', { cookie: fresh })).json.user.role, 'applicant', 'newer ledger revocation overrides restored application data');
  } finally { await G.close(); }
});

test('older DATA_DIR files cannot revive revoked sessions while the newer ledger survives', async () => {
  const G = await startGuild({ seed: seed(), secret: SECRET, guild: GUILD, env: { DISCORD_OFFICER_USER_IDS: OFFICER } });
  try {
    const d1 = await G.login(MEMBER);
    await G.stop();
    const backup = fs.readdirSync(G.dir).filter((f) => !f.startsWith('.')).map((f) => [f, fs.statSync(path.join(G.dir, f)).isFile() ? fs.readFileSync(path.join(G.dir, f)) : null]);
    await G.start();
    assert.equal((await G.api('POST', '/api/logout', { cookie: d1 })).status, 200);
    assert.equal((await G.api('GET', '/api/state', { cookie: d1 })).status, 401, 'logged out');
    // Operator restores the older folder copy (taken before the logout): the newer revocation file is gone.
    await G.stop();
    fs.rmSync(path.join(G.dir, 'session-revocations.json'), { force: true });
    for (const [f, buf] of backup) if (buf) fs.writeFileSync(path.join(G.dir, f), buf);
    await G.start();
    assert.equal((await G.api('GET', '/api/state', { cookie: d1 })).status, 401, 'newer ledger still rejects the old session');
    // Mitigation: restart with SESSIONS_VALID_AFTER = restore time.
    await G.restart({ SESSIONS_VALID_AFTER: new Date().toISOString() });
    assert.equal((await G.api('GET', '/api/state', { cookie: d1 })).status, 401, 'SESSIONS_VALID_AFTER rejects every session from before the restore');
    const fresh = await G.login(MEMBER);
    assert.equal((await G.api('GET', '/api/state', { cookie: fresh })).status, 200, 'fresh sign-ins work');
  } finally { await G.close(); }
});
