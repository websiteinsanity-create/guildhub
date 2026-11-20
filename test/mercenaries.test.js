// Tests for mercenaries: outside players who help fill a roster for one event.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111', OFFICER_ROLE = '900000000000000001', MERC_ROLE = '900000000000000099';
const OFFICER = '100000000000000001', MERC = '100000000000000050', MERC2 = '100000000000000051', MEMBER = '100000000000000052';

let fake, dir, proc, port, base;
const sessions = {};

async function startServer() {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-merc-'));
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

// Walks the OAuth redirect like a browser, optionally as a mercenary-signup attempt (?merc=1), and returns the
// session cookie plus where the callback ultimately sent the browser (so a rejection can be told apart from a
// real sign-in without needing a second authenticated call).
async function discordLogin(id, roles, { merc = false } = {}) {
  fake.state.guildMembers[id] = roles === null ? undefined : { roles };
  const start = await fetch(base + '/auth/discord' + (merc ? '?merc=1' : ''), { redirect: 'manual' });
  const oauth = /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  const mercCookie = merc ? /gh_merc=([^;]+)/.exec(start.headers.get('set-cookie'))[1] : null;
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${oauth}`, {
    redirect: 'manual', headers: { Cookie: `gh_oauth=${oauth}` + (mercCookie ? `; gh_merc=${mercCookie}` : '') },
  });
  const cookie = /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '');
  return { cookie: cookie ? `gh_session=${cookie[1]}` : null, location: cb.headers.get('location') };
}
const call = async (p, method = 'GET', body, who) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: sessions[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const state = async (who) => (await call('/api/state', 'GET', null, who)).body;
const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();

before(async () => {
  await startServer();
  fake.state.roleList = [{ id: OFFICER_ROLE, name: 'Officer', position: 2 }, { id: MERC_ROLE, name: 'LFG Helper', position: 1 }, { id: '111111111111111111', name: '@everyone', position: 0 }];
  sessions.officer = (await discordLogin(OFFICER, [OFFICER_ROLE])).cookie;
  await call('/api/admin/discord', 'PUT', { partyPost: { channelId: '800000000000000001' } }, 'officer');
  await call('/api/admin/mercenaries', 'PUT', { channelId: '800000000000000001', roleId: MERC_ROLE }, 'officer');
});
after(stopServer);

test('only officers can set the mercenary channel and role', async () => {
  const asMember = (await discordLogin(MEMBER, [])).cookie;                 // a real guild member, non-officer
  sessions.member = asMember;
  assert.equal((await call('/api/admin/mercenaries', 'PUT', { roleId: MERC_ROLE }, 'member')).status, 403);
  const saved = (await state('officer')).settings.mercenaries;
  assert.equal(saved.roleId, MERC_ROLE);
  assert.equal(saved.channelId, '800000000000000001');
});

test('"Get mercenaries" posts to Discord with the role mention and the structured need, and remembers the ask on the event', async () => {
  const ev = (await call('/api/events', 'POST', { title: 'Castle siege', type: 'Castle Siege', start: inMinutes(600) }, 'officer')).body;
  fake.state.posts.length = 0;
  const bad = await call(`/api/events/${ev.id}/merc-request`, 'POST', {}, 'officer');
  assert.equal(bad.status, 400, 'must ask for something');

  const r = await call(`/api/events/${ev.id}/merc-request`, 'POST', { needs: [{ cls: 'Oracle', count: 1 }, { cls: 'Crusader', count: 2 }] }, 'officer');
  assert.equal(r.status, 200);
  const post = fake.state.posts.at(-1);
  assert.deepEqual(post.mentions, [MERC_ROLE]);
  assert.match(post.content, /<@&900000000000000099>/);
  assert.match(post.content, /Mercenaries wanted for Castle siege/);
  assert.match(post.content, /1× Oracle, 2× Crusader/);
  assert.match(post.content, new RegExp(`/#/merc/${ev.id}`));
  // a Join button alongside the plain link, same reasoning as the reminder DMs - a LINK-style button needs
  // nothing from the bot beyond what it already does
  const joinBtn = post.components[0].components[0];
  assert.equal(joinBtn.style, 5);
  assert.match(joinBtn.label, /Join/);
  assert.match(joinBtn.url, new RegExp(`/#/merc/${ev.id}$`));

  const seen = (await state('officer')).events.find((e) => e.id === ev.id).mercRequest;
  assert.equal(seen.ok, true);
  assert.deepEqual(seen.needs, [{ cls: 'Oracle', count: 1 }, { cls: 'Crusader', count: 2 }]);

  const a = (await call('/api/admin/audit', 'GET', null, 'officer')).body;
  assert.ok(a.entries.some((e) => e.action === 'mercenaries.request' && /Castle siege/.test(e.description)));
});

test('someone who follows the link, not yet a member, can see the event and sign up - and shows up only in that event\'s party board data, nowhere else', async () => {
  const ev = (await call('/api/events', 'POST', { title: 'Guild bosses', type: 'PvE-Raid', start: inMinutes(300) }, 'officer')).body;
  await call(`/api/events/${ev.id}/merc-request`, 'POST', { overall: 2 }, 'officer');

  // a plain Discord sign-in (not through the merc link) for someone outside the guild is correctly blocked while applications are off
  const plain = await discordLogin(MERC, null, {});
  assert.match(plain.location, /loginError/, 'without ?merc=1, an outsider is turned away like any other non-member when applications are closed');

  // following the merc link (?merc=1) lets the same outsider in despite applications being closed
  const merc = await discordLogin(MERC, null, { merc: true });
  assert.ok(merc.cookie, 'the mercenary-flagged sign-in succeeds');
  sessions.merc = merc.cookie;

  const info = await call(`/api/merc-event/${ev.id}`, 'GET', null, 'merc');
  assert.equal(info.status, 200);
  assert.equal(info.body.event.title, 'Guild bosses');
  assert.equal(info.body.event.mercRequest.overall, 2);
  assert.equal(info.body.alreadyMember, false);
  assert.equal(info.body.character, null, 'first time - no saved character yet');

  const signup = await call(`/api/merc-signup/${ev.id}`, 'POST', { name: 'Rook', role: 'DPS', primaryWeapon: 'Daggers', secondaryWeapon: 'Crossbow' }, 'merc');
  assert.equal(signup.status, 200);
  assert.equal(signup.body.mercenary, true);
  assert.equal(signup.body.active, false, 'inactive, so every normal page that filters on active never shows them');
  assert.equal(signup.body.mercFor, ev.id);

  const officerView = await state('officer');
  const merc1 = officerView.members.find((m) => m.name === 'Rook');
  assert.ok(merc1, 'officers can still see the character through the full member list in state (board() picks them out of it)');
  assert.equal(merc1.active, false);

  const asMemberOnly = officerView.members.filter((m) => m.active);
  assert.ok(!asMemberOnly.some((m) => m.name === 'Rook'), 'but they are excluded from anything that only looks at active members - the normal roster, loot, attendance, etc.');
});

test('a returning mercenary is recognised by their Discord account and reuses the same character for a new event', async () => {
  const ev1 = (await call('/api/events', 'POST', { title: 'Week 1', type: 'Castle Siege', start: inMinutes(100) }, 'officer')).body;
  const ev2 = (await call('/api/events', 'POST', { title: 'Week 2', type: 'Castle Siege', start: inMinutes(200) }, 'officer')).body;
  const login = await discordLogin(MERC2, null, { merc: true });
  sessions.merc2 = login.cookie;

  const first = await call(`/api/merc-signup/${ev1.id}`, 'POST', { name: 'Sable', role: 'Healer', primaryWeapon: 'Wand & Tome', secondaryWeapon: 'Staff' }, 'merc2');
  const firstId = first.body.id;

  const info2 = await call(`/api/merc-event/${ev2.id}`, 'GET', null, 'merc2');
  assert.equal(info2.body.character.id, firstId, 'the same character is offered again for a different event');

  const second = await call(`/api/merc-signup/${ev2.id}`, 'POST', { name: 'Sable', role: 'Healer', primaryWeapon: 'Wand & Tome', secondaryWeapon: 'Staff' }, 'merc2');
  assert.equal(second.body.id, firstId, 'updates the same character rather than creating a second one');
  assert.equal(second.body.mercFor, ev2.id, 'now tied to the new event');

  const all = (await state('officer')).members.filter((m) => m.name === 'Sable');
  assert.equal(all.length, 1, 'still exactly one character, not a duplicate');
});

test('a real guild member cannot also sign up as a mercenary with the same Discord account', async () => {
  const ev = (await call('/api/events', 'POST', { title: 'Member test event', type: 'Castle Siege', start: inMinutes(400) }, 'officer')).body;
  await call('/api/members', 'POST', { name: 'RealChar', role: 'DPS' }, 'member');     // the member needs an actual character for this to be a meaningful check
  const r = await call(`/api/merc-signup/${ev.id}`, 'POST', { name: 'Nope', role: 'DPS' }, 'member');
  assert.equal(r.status, 409);
});

// ---------------------------------------------------------------- DMing a mercenary their own party
test('an officer can DM a mercenary a picture of their own party, and it fails cleanly for a non-mercenary or a bad picture', async () => {
  const tinyPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 2)]).toString('base64');
  const ev = (await call('/api/events', 'POST', { title: 'DM test event', type: 'Castle Siege', start: inMinutes(400) }, 'officer')).body;
  const merc3 = '100000000000000070';
  sessions.merc3 = (await discordLogin(merc3, [])).cookie;
  const signed = (await call(`/api/merc-signup/${ev.id}`, 'POST', { name: 'Dagger', role: 'DPS' }, 'merc3')).body;

  assert.equal((await call(`/api/events/${ev.id}/merc-dm/${signed.id}`, 'POST', { image: tinyPng }, 'member')).status, 403, 'members cannot send this');

  fake.state.posts.length = 0;
  const r = await call(`/api/events/${ev.id}/merc-dm/${signed.id}`, 'POST', { image: tinyPng }, 'officer');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  const dm = fake.state.dms.at(-1);
  assert.equal(dm.to, merc3, "sent to the mercenary's own Discord account");
  assert.match(dm.content, /DM test event/);
  assert.ok(dm.file && dm.file.png, 'the picture is actually attached');

  const realMember = (await call('/api/members', 'POST', { name: 'RealOne', role: 'Tank' }, 'member')).body;
  assert.equal((await call(`/api/events/${ev.id}/merc-dm/${realMember.id}`, 'POST', { image: tinyPng }, 'officer')).status, 404, 'only a mercenary can be DMed this way');

  const badPic = await call(`/api/events/${ev.id}/merc-dm/${signed.id}`, 'POST', { image: 'not-a-real-png' }, 'officer');
  assert.equal(badPic.status, 400);
});
