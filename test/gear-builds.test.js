// (per-build gear threads) Class coaches: a role granted in Admin (by Discord role or specific player, same mechanism as extra
// officers), linked to the students they coach, who post or receive YouTube VODs reviewed live over Discord
// voice. This file covers everything the server actually owns: the role, the links, the VODs and their
// visibility rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

// DMs are sent fire-and-forget (notify() never awaits discord.sendDM()), so the HTTP response for whatever
// triggered one can come back before it actually lands in fake.state.dms - wait for it rather than assume it
// is already there the instant the request resolves.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(100); } }

const GUILD = '111111111111111111', OFFICER_ROLE = '900000000000000001';
const OFFICER = '100000000000000001', COACH = '100000000000000060', COACH2 = '100000000000000063', STUDENT = '100000000000000061', OTHER = '100000000000000062';

let fake, dir, proc, port, base;
const sessions = {};

async function startServer() {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-gearbuild-'));
  port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, DISCORD_DM_DELAY_MS: '0',
      DISCORD_CLIENT_ID: '555', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_URL: base, DISCORD_GUILD_ID: GUILD,
      DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
}
// Waits for the process to actually exit before clearing its data directory - it now flushes a final save on
// SIGTERM (see server.js), so deleting the directory out from under that write would be a race.
async function stopServer() {
  if (proc) { proc.kill(); await new Promise((r) => proc.once('exit', r)); }
  fake && fake.close();
  dir && fs.rmSync(dir, { recursive: true, force: true });
}
async function discordLogin(id, roles) {
  fake.state.guildMembers[id] = { roles };
  const start = await fetch(base + '/auth/discord', { redirect: 'manual' });
  const oauth = /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${oauth}`, { redirect: 'manual', headers: { Cookie: `gh_oauth=${oauth}` } });
  const cookie = /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '');
  return cookie ? `gh_session=${cookie[1]}` : null;
}
const call = async (p, method = 'GET', body, who) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: sessions[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const state = async (who) => (await call('/api/state', 'GET', null, who)).body;

// Gear Threads are per BUILD: a character with a Scorpion main and an Oracle build has two threads, and each
// class's coach only reaches the build of the class they coach.
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 1)]).toString('base64');
let charId, buildId;
// Extra builds (and removing them) wait for an officer, like on the live site.
async function approveLatest() {
  const pending = (await state('officer')).changes.filter((c) => c.status === 'pending');
  assert.ok(pending.length, 'expected a pending request');
  assert.equal((await call(`/api/changes/${pending[pending.length - 1].id}/decide`, 'POST', { decision: 'approve' }, 'officer')).status, 200);
}
before(async () => {
  await startServer();
  sessions.officer = await discordLogin(OFFICER, [OFFICER_ROLE]);
  sessions.coach = await discordLogin(COACH, []);
  sessions.coach2 = await discordLogin(COACH2, []);
  sessions.student = await discordLogin(STUDENT, []);
  sessions.other = await discordLogin(OTHER, []);
  await call('/api/admin/coaches', 'PUT', { userIds: [COACH, COACH2] }, 'officer');
  const created = await call('/api/members', 'POST', { name: 'Multi', role: 'DPS', primaryWeapon: 'Daggers', secondaryWeapon: 'Crossbow' }, 'student'); charId = created.body.id;
  const r = await call(`/api/members/${charId}/builds`, 'POST', { name: 'Heal', mode: 'PvE', role: 'Healer', primaryWeapon: 'Orb', secondaryWeapon: 'Wand & Tome' }, 'student');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  await approveLatest();
  buildId = String((await call(`/api/state`, 'GET', null, 'officer')).body.members.find((m) => m.id === charId).builds[0].id);
  await call('/api/admin/coach-links', 'POST', { coach: COACH, class: 'Scorpion' }, 'officer');
  await call('/api/admin/coach-links', 'POST', { coach: COACH2, class: 'Oracle' }, 'officer');
});
after(stopServer);

test('each person sees only the builds they may open; the coach of a class only reaches that class\'s build', async () => {
  const keys = async (who) => (await call(`/api/gearthreads/${charId}`, 'GET', null, who));
  assert.deepEqual((await keys('student')).body.builds.map((b) => b.key), ['main', buildId]);
  assert.deepEqual((await keys('officer')).body.builds.map((b) => b.key), ['main', buildId]);
  assert.deepEqual((await keys('coach')).body.builds.map((b) => b.key), ['main'], 'Scorpion coach: main only');
  assert.deepEqual((await keys('coach2')).body.builds.map((b) => b.key), [buildId], 'Oracle coach: the Oracle build only');
  assert.equal((await call(`/api/gearthreads/${charId}?build=${buildId}`, 'GET', null, 'coach')).status, 403);
  assert.equal((await call(`/api/gearthreads/${charId}?build=main`, 'GET', null, 'coach2')).status, 403);
  assert.equal((await call(`/api/gearthreads/${charId}`, 'GET', null, 'other')).status, 403, 'a stranger gets nothing');
  assert.equal((await call(`/api/gearthreads/${charId}?build=999`, 'GET', null, 'student')).status, 404);
  assert.deepEqual((await state('coach')).myCoachClasses, ['Scorpion']);
});

test('chat, screenshots, folder and links are separate per build', async () => {
  const sec = (await call(`/api/gearthreads/${charId}`, 'GET', null, 'student')).body.screens[0].sectionId;
  await call(`/api/gearthreads/${charId}/chat`, 'POST', { text: 'main hello' }, 'student');
  assert.equal((await call(`/api/gearthreads/${charId}/chat`, 'POST', { text: 'oracle hello', build: buildId }, 'coach2')).status, 200);
  assert.equal((await call(`/api/gearthreads/${charId}/chat`, 'POST', { text: 'sneaky', build: buildId }, 'coach')).status, 403);
  const chatOf = async (b) => (await call(`/api/gearthreads/${charId}/chat?build=${b}`, 'GET', null, 'officer')).body.messages.map((m) => m.text);
  assert.deepEqual(await chatOf('main'), ['main hello']);
  assert.deepEqual(await chatOf(buildId), ['oracle hello']);

  assert.equal((await call(`/api/gearthreads/${charId}/screens/${sec}`, 'PUT', { image: PNG, note: 'oracle shot', build: buildId }, 'student')).status, 200);
  const main = (await call(`/api/gearthreads/${charId}?build=main`, 'GET', null, 'student')).body;
  const ora = (await call(`/api/gearthreads/${charId}?build=${buildId}`, 'GET', null, 'student')).body;
  assert.equal(main.screens[0].image, '', 'main has no screenshot');
  assert.ok(ora.screens[0].image.startsWith('/uploads/'));
  assert.equal(ora.screens[0].note, 'oracle shot');

  assert.equal((await call(`/api/gearthreads/${charId}/folder`, 'POST', { kind: 'text', text: 'tip', build: buildId }, 'coach2')).status, 200);
  assert.equal((await call(`/api/gearthreads/${charId}/folder`, 'POST', { kind: 'text', text: 'tip', build: buildId }, 'coach')).status, 403);
  assert.equal((await call(`/api/gearthreads/${charId}/folder`, 'POST', { kind: 'text', text: 'self', build: buildId }, 'student')).status, 403, 'players never post to their own folder');
  assert.equal((await call(`/api/gearthreads/${charId}?build=main`, 'GET', null, 'officer')).body.folder.length, 0);

  await call(`/api/gearthreads/${charId}/questlogs`, 'PUT', { links: [{ label: 'o', url: 'https://example.com/o' }], build: buildId }, 'coach2');
  assert.equal((await call(`/api/gearthreads/${charId}?build=${buildId}`, 'GET', null, 'officer')).body.questlogs.length, 1);
  assert.equal((await call(`/api/gearthreads/${charId}?build=main`, 'GET', null, 'officer')).body.questlogs.length, 0, 'main links untouched');
});

test('old data without a build tag counts as the main build, and deleting a build removes its thread', async () => {
  // Main build content written without any build field (the old behavior) lands on main.
  await call(`/api/gearthreads/${charId}/chat`, 'POST', { text: 'legacy style' }, 'student');
  assert.ok((await call(`/api/gearthreads/${charId}/chat`, 'GET', null, 'student')).body.messages.some((m) => m.text === 'legacy style'));
  const del = await call(`/api/members/${charId}/builds/${buildId}`, 'DELETE', null, 'student');
  assert.equal(del.status, 200);
  await approveLatest();
  assert.equal((await call(`/api/gearthreads/${charId}?build=${buildId}`, 'GET', null, 'officer')).status, 404);
  assert.deepEqual((await call(`/api/gearthreads/${charId}`, 'GET', null, 'coach2')).status, 403, 'Oracle coach has nothing left on this character');
  assert.deepEqual((await call(`/api/gearthreads/${charId}/chat`, 'GET', null, 'officer')).body.messages.map((m) => m.text), ['main hello', 'legacy style']);
});
