// Applications when the Discord server uses a member role: who is a member, who is an applicant, and the role the bot hands out.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111', MEMBER_ROLE = '900000000000000010', OFFICER_ROLE = '900000000000000001';
const BOSS_ID = '100000000000000101', MEMBER_ID = '100000000000000102', NO_ROLE_ID = '100000000000000103', STRANGER = '100000000000000104', OWNER_ID = '100000000000000105';
let fake, dir, proc, base;
const sessions = {};

before(async () => {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-apps-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, SCHEDULER_INTERVAL_MS: '60000', DISCORD_DM_DELAY_MS: '0',
      DISCORD_CLIENT_ID: '555', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_URL: base, DISCORD_GUILD_ID: GUILD, DISCORD_MEMBER_ROLE_ID: MEMBER_ROLE,
      DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_OFFICER_USER_IDS: OWNER_ID, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
});
// Waits for the process to actually exit before clearing its data directory - it now flushes a final save on
// SIGTERM (see server.js), so deleting the directory out from under that write would be a race.
after(async () => {
  if (proc) { proc.kill(); await new Promise((r) => proc.once('exit', r)); }
  fake && fake.close();
  dir && fs.rmSync(dir, { recursive: true, force: true });
});

async function login(id, roles) {
  fake.state.guildMembers[id] = roles === null ? undefined : { roles };
  const start = await fetch(base + '/auth/discord', { redirect: 'manual' });
  const oauth = /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${oauth}`, { redirect: 'manual', headers: { Cookie: `gh_oauth=${oauth}` } });
  const c = /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '');
  return { cookie: c ? `gh_session=${c[1]}` : null, location: cb.headers.get('location') };
}
const call = async (p, method = 'GET', body, who) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: sessions[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const state = async (who) => (await call('/api/state', 'GET', null, who)).body;

test('with a member role: role holders are members, everybody else is an applicant, officers are always in', async () => {
  sessions.boss = (await login(BOSS_ID, [OFFICER_ROLE])).cookie;
  sessions.member = (await login(MEMBER_ID, [MEMBER_ROLE])).cookie;
  assert.equal((await state('boss')).user.role, 'officer'); assert.equal((await state('member')).user.role, 'member');
  const owner = await login(OWNER_ID, null);                                        // listed by id, not even in the server
  assert.ok(owner.cookie); sessions.owner = owner.cookie;
  assert.equal((await state('owner')).user.role, 'officer', 'a listed officer gets in without being in the server');

  // nobody may apply while applications are switched off
  const off = await login(NO_ROLE_ID, []);
  assert.equal(off.cookie, null); assert.match(decodeURIComponent(off.location), /member role/, 'in the server but without the role: the message says so');
  assert.match(decodeURIComponent((await login(STRANGER, null)).location), /not a member of our Discord server/);

  await call('/api/admin/discord', 'PUT', { applications: { enabled: true, inviteUrl: 'https://discord.gg/join-us' } }, 'boss');
  sessions.norole = (await login(NO_ROLE_ID, [])).cookie;
  sessions.stranger = (await login(STRANGER, null)).cookie;
  assert.equal((await state('norole')).user.role, 'applicant', 'in the server but without the member role');
  assert.equal((await state('stranger')).user.role, 'applicant', 'not in the server at all');
});

test('accepting hands out the member role to somebody in the server; a missing permission is written down, not fatal', async () => {
  const apply = (who, name) => call('/api/applications', 'POST', { characterName: name, role: 'DPS', about: 'I would like to join the guild.' }, who).then((r) => r.body);
  const a1 = await apply('norole', 'Rolely'), a2 = await apply('stranger', 'Outsider');
  fake.state.roleAdds.length = 0;
  const r1 = (await call('/api/applications/' + a1.id, 'PUT', { decision: 'accept' }, 'boss')).body;
  assert.deepEqual(fake.state.roleAdds, [{ user: NO_ROLE_ID, role: MEMBER_ROLE }], 'the role went to the person who is in the server');
  assert.equal(r1.roleResult, 'given');
  const dmsBefore = fake.state.dms.length;
  const r2 = (await call('/api/applications/' + a2.id, 'PUT', { decision: 'accept' }, 'boss')).body;
  assert.equal(fake.state.roleAdds.length, 1, 'somebody who is not in the server cannot get a role');
  assert.equal(r2.roleResult, undefined);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fake.state.dms.slice(dmsBefore).some((d) => d.to === STRANGER && /join-us/.test(d.content)), 'they get the invite link to the Discord server');
  assert.equal((await state('stranger')).user.role, 'member');
  // the bot is not allowed to give roles
  sessions.late = (await login('100000000000000106', [])).cookie;
  const a3 = await apply('late', 'Denied');
  fake.state.roleFail = true;
  const r3 = (await call('/api/applications/' + a3.id, 'PUT', { decision: 'accept' }, 'boss')).body;
  fake.state.roleFail = false;
  assert.equal(r3.status, 'accepted'); assert.match(r3.roleResult, /Manage Roles/);
  assert.equal((await state('late')).user.role, 'member', 'the application still counts');
});
