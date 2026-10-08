// Tests for recurring events, builds, approvals, profiles, requests, tags, per-person visibility and branding.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer(seedDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-feat-'));
  if (seedDb) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seedDb));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1', DEMO_MODE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
  const base = `http://localhost:${port}`;
  const call = async (p, method = 'GET', body, token) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return { base, call, login, dir, officer: await login('Boss', 'o1'), ann: await login('Ann', 'm1'), bob: await login('Bob', 'm1'), stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const withServer = (name, fn, seed) => test(name, async () => { const s = await startServer(seed); try { await fn(s); } finally { await s.stop(); } });
const state = async (s, who) => (await s.call('/api/state', 'GET', null, s[who])).body;
const day = 864e5, inDays = (n) => new Date(Date.now() + n * day).toISOString();
const berlinTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const berlinWeekday = (iso) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'Europe/Berlin', weekday: 'long' });
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- recurring events
withServer('a recurring event creates its dates ahead of time, always at the same local time', async (s) => {
  assert.equal((await s.call('/api/series', 'POST', { type: 'Boonstone', weekdays: [1], time: '21:00' }, ann(s))).status, 403);
  const r = (await s.call('/api/series', 'POST', { type: 'Boonstone', title: 'Boonstone fight', weekdays: [1], time: '21:00', tz: 'Europe/Berlin', startDate: today() }, s.officer)).body;
  assert.ok(r.created >= 5 && r.created <= 7, 'about six weeks of Mondays, got ' + r.created);
  const evs = (await state(s, 'ann')).events.filter((e) => e.seriesId === r.series.id);
  assert.equal(evs.length, r.created);
  for (const e of evs) { assert.equal(berlinWeekday(e.start), 'Monday'); assert.equal(berlinTime(e.start), '21:00'); assert.equal(e.title, 'Boonstone fight'); assert.equal(e.type, 'Boonstone'); assert.ok(Date.parse(e.start) > Date.now()); }
  assert.equal((await s.call('/api/series/' + r.series.id, 'PUT', { type: 'Boonstone', weekdays: [1], time: '21:00' }, s.officer)).body.created, 0, 'saving again does not create duplicates');
});
const ann = (s) => s.ann;

withServer('deleting one date skips only that date; editing the series moves all upcoming dates; deleting it removes them', async (s) => {
  const r = (await s.call('/api/series', 'POST', { type: 'Wargames', weekdays: [2, 5], time: '20:30', tz: 'Europe/Berlin', startDate: today() }, s.officer)).body;
  const list = async () => (await state(s, 'officer')).events.filter((e) => e.seriesId === r.series.id);
  const first = (await list())[0], count = (await list()).length;
  assert.equal((await s.call('/api/events/' + first.id, 'DELETE', null, s.officer)).status, 200);
  await s.call('/api/series/' + r.series.id, 'PUT', { type: 'Wargames', weekdays: [2, 5], time: '20:30' }, s.officer);   // forces a re-check
  assert.equal((await list()).length, count - 1, 'the deleted date stays deleted');
  const second = (await list())[0];
  await s.call(`/api/events/${second.id}/rsvp`, 'POST', { memberId: (await s.call('/api/members', 'POST', { name: 'Signed', role: 'DPS' }, s.ann)).body.id, status: 'yes' }, s.ann);
  const moved = (await s.call('/api/series/' + r.series.id, 'PUT', { type: 'Wargames', weekdays: [2, 5], time: '19:15', title: 'Wargames night' }, s.officer)).body;
  const after = await list();
  assert.ok(after.every((e) => berlinTime(e.start) === '19:15' && e.title === 'Wargames night'));
  assert.equal(Object.keys(after.find((e) => e.id === second.id).rsvps).length, 1, 'sign-ups survive a change of the series');
  await s.call('/api/series/' + r.series.id, 'PUT', { type: 'Wargames', weekdays: [5], time: '19:15' }, s.officer);
  assert.ok((await list()).every((e) => berlinWeekday(e.start) === 'Friday'), 'dates on removed weekdays are dropped');
  assert.equal((await s.call('/api/series/' + r.series.id, 'DELETE', null, s.officer)).status, 200);
  assert.equal((await list()).length, 0);
  assert.equal((await state(s, 'ann')).series.length, 0);
});

withServer('recurring events get a party preset that is tied to their type, and the series is validated', async (s) => {
  const a = (await s.call('/api/members', 'POST', { name: 'Aaa', role: 'Tank' }, s.ann)).body.id;
  const p = (await s.call('/api/presets', 'POST', { name: 'WG', parties: [{ name: 'Front', members: [a] }] }, s.officer)).body;
  await s.call(`/api/presets/${p.id}/use-for-type`, 'POST', { type: 'Wargames' }, s.officer);
  const r = (await s.call('/api/series', 'POST', { type: 'Wargames', weekdays: [3], time: '21:00', startDate: today() }, s.officer)).body;
  assert.ok((await state(s, 'ann')).events.filter((e) => e.seriesId === r.series.id).every((e) => e.parties.length === 1));
  const bad = (b) => s.call('/api/series', 'POST', { type: 'Wargames', weekdays: [1], time: '21:00', ...b }, s.officer);
  assert.equal((await bad({ weekdays: [] })).status, 400);
  assert.equal((await bad({ time: '25:00' })).status, 400);
  assert.equal((await bad({ tz: 'Mars/Base' })).status, 400);
  assert.equal((await bad({ startDate: '2026-13-40' })).status, 400);
  assert.equal((await bad({ startDate: '2026-10-10', endDate: '2026-10-01' })).status, 400);
  const ended = (await bad({ startDate: today(), endDate: today() })).body;
  assert.ok(ended.created <= 1, 'a series that ends on its first day makes at most one event');
});

// ---------------------------------------------------------------- builds, approvals, parties
withServer('changes to role and weapons wait for approval, other changes apply at once, officers decide', async (s) => {
  const c = (await s.call('/api/members', 'POST', { name: 'Hero', role: 'DPS', primaryWeapon: 'Longbow', secondaryWeapon: 'Daggers', gearScore: 2000 }, s.ann)).body;
  const edit = (who, b) => s.call('/api/members/' + c.id, 'PUT', { name: 'Hero', role: 'DPS', primaryWeapon: 'Longbow', secondaryWeapon: 'Daggers', gearScore: 2000, ...b }, s[who]);
  const r1 = (await edit('ann', { role: 'Healer', gearScore: 2400, primaryWeapon: 'Wand & Tome' })).body;
  assert.equal(r1.gearScore, 2400, 'gear score is free');
  assert.equal(r1.role, 'DPS', 'role waits for approval');
  assert.equal(r1.primaryWeapon, 'Longbow');
  assert.deepEqual(r1.approvalPending.sort(), ['Role (Tank, Healer, DPS)', 'Weapons, class and PvE/PvP mode']);
  const mine = (await state(s, 'ann')).changes, theirs = (await state(s, 'bob')).changes;
  assert.equal(mine.length, 1); assert.equal(theirs.length, 0, 'other players do not see it');
  assert.deepEqual(mine[0].changes.role, { from: 'DPS', to: 'Healer' });
  assert.equal((await s.call(`/api/changes/${mine[0].id}/decide`, 'POST', { decision: 'approve' }, s.ann)).status, 403);
  const decided = (await s.call(`/api/changes/${mine[0].id}/decide`, 'POST', { decision: 'approve', note: 'ok' }, s.officer)).body;
  assert.equal(decided.status, 'approved');
  const after = (await state(s, 'ann')).members.find((m) => m.id === c.id);
  assert.deepEqual([after.role, after.primaryWeapon], ['Healer', 'Wand & Tome']);
  assert.equal((await s.call(`/api/changes/${mine[0].id}/decide`, 'POST', { decision: 'reject' }, s.officer)).status, 409, 'decided once');
  // rejected: nothing changes; withdrawn: removed
  await edit('ann', { role: 'Tank' });
  const c2 = (await state(s, 'officer')).changes.find((x) => x.status === 'pending');
  await s.call(`/api/changes/${c2.id}/decide`, 'POST', { decision: 'reject', note: 'no' }, s.officer);
  assert.equal((await state(s, 'ann')).members.find((m) => m.id === c.id).role, 'Healer');
  await edit('ann', { role: 'DPS' });
  const c3 = (await state(s, 'ann')).changes.find((x) => x.status === 'pending');
  assert.equal((await s.call('/api/changes/' + c3.id, 'DELETE', null, s.bob)).status, 403);
  assert.equal((await s.call('/api/changes/' + c3.id, 'DELETE', null, s.ann)).status, 200);
  // the leadership decides what needs approval
  assert.equal((await s.call('/api/admin/options', 'PUT', { approvals: { role: false, weapons: false } }, s.ann)).status, 403);
  await s.call('/api/admin/options', 'PUT', { approvals: { role: false, weapons: false, gearScore: true } }, s.officer);
  const r2 = (await edit('ann', { role: 'Tank', gearScore: 2500 })).body;
  assert.equal(r2.role, 'Tank', 'no longer needs approval'); assert.equal(r2.gearScore, 2000, 'gear score now waits, so it is still the old value'); assert.deepEqual(r2.approvalPending, ['Gear score']);
  assert.equal((await edit('officer', { gearScore: 3000 })).body.gearScore, 3000, 'officers are never held back');
});

withServer('a new character can wait for approval and stays hidden from others until then', async (s) => {
  await s.call('/api/admin/options', 'PUT', { approvals: { newCharacter: true } }, s.officer);
  const made = (await s.call('/api/members', 'POST', { name: 'Newbie', role: 'DPS' }, s.ann)).body;
  assert.equal(made.active, false); assert.deepEqual(made.approvalPending, ['newCharacter']);
  assert.ok((await state(s, 'ann')).members.some((m) => m.id === made.id));
  assert.ok(!(await state(s, 'bob')).members.some((m) => m.id === made.id), 'others cannot see it yet');
  const req = (await state(s, 'officer')).changes.find((c) => c.kind === 'newCharacter');
  await s.call(`/api/changes/${req.id}/decide`, 'POST', { decision: 'approve' }, s.officer);
  assert.ok((await state(s, 'bob')).members.find((m) => m.id === made.id).active);
  const second = (await s.call('/api/members', 'POST', { name: 'Nope', role: 'DPS' }, s.bob)).body;
  await s.call(`/api/changes/${(await state(s, 'officer')).changes.find((c) => c.status === 'pending').id}/decide`, 'POST', { decision: 'reject' }, s.officer);
  assert.ok(!(await state(s, 'officer')).members.some((m) => m.id === second.id), 'a rejected new character is removed');
});

withServer('a character can have extra builds; leaders can pick which one a player uses in a party', async (s) => {
  await s.call('/api/admin/options', 'PUT', { approvals: { builds: false } }, s.officer);
  const c = (await s.call('/api/members', 'POST', { name: 'Flex', role: 'DPS', primaryWeapon: 'Longbow', secondaryWeapon: 'Daggers' }, s.ann)).body;
  assert.equal((await s.call(`/api/members/${c.id}/builds`, 'POST', { name: 'PvP heal', mode: 'PvP', role: 'Healer', primaryWeapon: 'Wand & Tome', secondaryWeapon: 'Orb', specialization: 'Endurance' }, s.bob)).status, 403);
  const withBuild = (await s.call(`/api/members/${c.id}/builds`, 'POST', { name: 'PvP heal', mode: 'PvP', role: 'Healer', primaryWeapon: 'Wand & Tome', secondaryWeapon: 'Orb', specialization: 'Endurance' }, s.ann)).body;
  const b = withBuild.builds[0];
  assert.deepEqual([b.mode, b.role, b.primaryWeapon, b.specialization], ['PvP', 'Healer', 'Wand & Tome', 'Endurance']);
  assert.equal((await s.call(`/api/members/${c.id}/builds/${b.id}`, 'PUT', { name: 'PvP heal v2', mode: 'PvP', role: 'Healer' }, s.ann)).body.builds[0].name, 'PvP heal v2');
  for (let i = 0; i < 5; i++) await s.call(`/api/members/${c.id}/builds`, 'POST', { name: 'x' + i }, s.ann);
  assert.equal((await s.call(`/api/members/${c.id}/builds`, 'POST', { name: 'too many' }, s.ann)).status, 400, 'up to 6 extra builds');

  const pr = (await s.call('/api/presets', 'POST', { name: 'P', parties: [{ name: 'A', members: [c.id], builds: { [c.id]: String(b.id) } }] }, s.officer)).body;
  assert.deepEqual(pr.parties[0].builds, { [c.id]: String(b.id) });
  const bogus = (await s.call('/api/presets/' + pr.id, 'PUT', { parties: [{ name: 'A', members: [c.id], builds: { [c.id]: '99999' } }] }, s.officer)).body;
  assert.deepEqual(bogus.parties[0].builds, {}, 'an unknown build is ignored');
  await s.call('/api/presets/' + pr.id, 'PUT', { parties: [{ name: 'A', members: [c.id], builds: { [c.id]: String(b.id) } }] }, s.officer);
  assert.equal((await s.call(`/api/members/${c.id}/builds/${b.id}`, 'DELETE', null, s.ann)).status, 200);
  assert.deepEqual((await state(s, 'officer')).presets[0].parties[0].builds, {}, 'deleting a build clears it from parties');
});

withServer('extra builds wait for approval when the leadership wants that', async (s) => {
  const c = (await s.call('/api/members', 'POST', { name: 'Flex', role: 'DPS' }, s.ann)).body;     // builds need approval by default
  const r = (await s.call(`/api/members/${c.id}/builds`, 'POST', { name: 'PvP', mode: 'PvP', role: 'Tank' }, s.ann)).body;
  assert.deepEqual(r.approvalPending, ['Extra builds (PvE / PvP)']); assert.equal(r.builds.length, 0);
  const req = (await state(s, 'officer')).changes.find((x) => x.kind === 'build');
  await s.call(`/api/changes/${req.id}/decide`, 'POST', { decision: 'approve' }, s.officer);
  const built = (await state(s, 'ann')).members.find((m) => m.id === c.id).builds;
  assert.equal(built.length, 1); assert.equal(built[0].name, 'PvP');
  await s.call(`/api/members/${c.id}/builds/${built[0].id}`, 'DELETE', null, s.ann);
  await s.call(`/api/changes/${(await state(s, 'officer')).changes.find((x) => x.status === 'pending').id}/decide`, 'POST', { decision: 'approve' }, s.officer);
  assert.equal((await state(s, 'ann')).members.find((m) => m.id === c.id).builds.length, 0);
});

// ---------------------------------------------------------------- profile
withServer('player profiles: own profile only, optional approval, officers can edit anyone', async (s) => {
  const put = (who, key, b) => s.call('/api/profile/' + key, 'PUT', b, s[who]);
  const annKey = 'Ann';
  assert.equal((await put('bob', annKey, { bio: 'x' })).status, 403);
  const saved = (await put('ann', annKey, { bio: 'Raid leader in a past life', timezone: 'CET', availability: 'evenings', modes: ['PvE'] })).body;
  assert.equal(saved.profile.modes, undefined, 'the "I like to play" choice is gone'); assert.equal(saved.approvalPending.length, 0);
  assert.equal((await state(s, 'ann')).profiles.Ann.bio, 'Raid leader in a past life');
  assert.equal(Object.keys((await state(s, 'bob')).profiles).length, 0, 'other players cannot read it');
  assert.equal(Object.keys((await state(s, 'officer')).profiles).length, 1);
  await s.call('/api/admin/options', 'PUT', { approvals: { profile: true } }, s.officer);
  const pend = (await put('ann', annKey, { bio: 'New text' })).body;
  assert.equal(pend.profile.bio, 'Raid leader in a past life'); assert.equal(pend.approvalPending.length, 1);
  await s.call(`/api/changes/${(await state(s, 'officer')).changes.find((c) => c.kind === 'profile').id}/decide`, 'POST', { decision: 'approve' }, s.officer);
  assert.equal((await state(s, 'ann')).profiles.Ann.bio, 'New text');
  assert.equal((await put('officer', annKey, { availability: 'weekends' })).body.profile.availability, 'weekends');
});

// ---------------------------------------------------------------- requests
withServer('lucent and item requests: per build, own view for members, given items land in the loot log', async (s) => {
  const a = (await s.call('/api/members', 'POST', { name: 'Ann1', role: 'DPS' }, s.ann)).body, b = (await s.call('/api/members', 'POST', { name: 'Bob1', role: 'DPS' }, s.bob)).body;
  await s.call('/api/admin/options', 'PUT', { approvals: { builds: false } }, s.officer);
  const build = (await s.call(`/api/members/${a.id}/builds`, 'POST', { name: 'PvP', mode: 'PvP', role: 'Healer' }, s.ann)).body.builds[0];
  const ask = (who, body) => s.call('/api/requests', 'POST', body, s[who]);
  assert.equal((await ask('bob', { memberId: a.id, kind: 'Lucent', amount: 5 })).status, 403, 'only for your own characters');
  assert.equal((await ask('ann', { memberId: a.id, kind: 'Gold', amount: 5 })).status, 400);
  assert.equal((await ask('ann', { memberId: a.id, kind: 'Lucent', amount: 0 })).status, 400);
  assert.equal((await ask('ann', { memberId: a.id, kind: 'Item', item: ' ' })).status, 400);
  assert.equal((await ask('ann', { memberId: a.id, kind: 'Item', item: 'Sword', buildKey: '999' })).status, 400, "must be one of that character's builds");
  const lucent = (await ask('ann', { memberId: a.id, buildKey: String(build.id), kind: 'Lucent', amount: 1500, reason: 'Enchanting my PvP set' })).body;
  const item = (await ask('ann', { memberId: a.id, kind: 'Item', item: 'Skillcore: Heal Pulse', lootType: 'Skillcore' })).body;
  await ask('bob', { memberId: b.id, kind: 'Lucent', amount: 200 });
  assert.equal((await state(s, 'ann')).requests.length, 2); assert.equal((await state(s, 'bob')).requests.length, 1); assert.equal((await state(s, 'officer')).requests.length, 3);
  assert.equal((await s.call('/api/requests/' + lucent.id, 'PUT', { status: 'approved' }, s.ann)).status, 403);
  assert.equal((await s.call('/api/requests/' + lucent.id, 'PUT', { status: 'approved', note: 'ok' }, s.officer)).body.status, 'approved');
  assert.equal((await s.call('/api/requests/' + lucent.id, 'PUT', { status: 'approved' }, s.officer)).status, 409);
  assert.equal((await s.call('/api/requests/' + lucent.id, 'DELETE', null, s.ann)).status, 403, 'cannot withdraw once it was looked at');
  assert.equal((await s.call('/api/requests/' + lucent.id, 'DELETE', null, s.officer)).status, 200, 'an officer can delete it anyway, in any status - for a troll request even after it has been rejected');
  assert.equal((await state(s, 'officer')).requests.some((r) => r.id === lucent.id), false);
  assert.equal((await s.call('/api/requests/' + item.id, 'PUT', { status: 'given' }, s.officer)).body.status, 'given');
  const loot = (await state(s, 'ann')).loot;
  assert.equal(loot.length, 1); assert.deepEqual([loot[0].item, loot[0].type], ['Skillcore: Heal Pulse', 'Skillcore']);
  assert.equal((await state(s, 'bob')).loot.length, 0);
  const mine = (await ask('bob', { memberId: b.id, kind: 'Item', item: 'Shield' })).body;
  assert.equal((await s.call('/api/requests/' + mine.id, 'DELETE', null, s.bob)).status, 200, 'withdraw while open');
  for (let i = 0; i < 12; i++) await ask('ann', { memberId: a.id, kind: 'Lucent', amount: 1 });
  assert.equal((await ask('ann', { memberId: a.id, kind: 'Lucent', amount: 1 })).status, 429, 'ten open requests at most');
});

// ---------------------------------------------------------------- tags
withServer('tags are created by the leadership and invisible to normal members', async (s) => {
  assert.equal((await s.call('/api/tags', 'POST', { name: 'Trial', color: '#ffaa00' }, s.ann)).status, 403);
  const t1 = (await s.call('/api/tags', 'POST', { name: 'Trial', color: '#FFAA00' }, s.officer)).body;
  assert.equal(t1.color, '#ffaa00');
  assert.equal((await s.call('/api/tags', 'POST', { name: 'trial', color: '#000000' }, s.officer)).status, 409);
  assert.equal((await s.call('/api/tags', 'POST', { name: 'Bad', color: 'red' }, s.officer)).status, 400);
  const t2 = (await s.call('/api/tags', 'POST', { name: 'Raid lead', color: '#3366ff' }, s.officer)).body;
  assert.equal((await s.call('/api/tags/' + t2.id, 'PUT', { name: 'Raid leader', color: '#3366ff' }, s.officer)).body.name, 'Raid leader');
  await s.call('/api/player-tags/Ann', 'PUT', { tags: [t1.id, t2.id, 99999] }, s.officer);
  assert.deepEqual((await state(s, 'officer')).playerTags, { Ann: [t1.id, t2.id] });
  const seen = await state(s, 'ann');
  assert.deepEqual([seen.tags, seen.playerTags], [[], {}], 'members never receive tags, not even their own');
  assert.equal((await s.call('/api/player-tags/Ann', 'PUT', { tags: [] }, s.ann)).status, 403);
  await s.call('/api/tags/' + t1.id, 'DELETE', null, s.officer);
  assert.deepEqual((await state(s, 'officer')).playerTags, { Ann: [t2.id] }, 'deleting a tag removes it from players');
});

// ---------------------------------------------------------------- who sees what
withServer('members only receive their own loot, attendance and points; the leadership hides sections', async (s) => {
  await s.call('/api/settings', 'PUT', { pointsEnabled: true }, s.officer);
  const a = (await s.call('/api/members', 'POST', { name: 'AnnChar', role: 'DPS' }, s.ann)).body, b = (await s.call('/api/members', 'POST', { name: 'BobChar', role: 'DPS' }, s.bob)).body;
  await s.call('/api/loot', 'POST', { memberId: a.id, item: 'Ann sword' }, s.officer);
  await s.call('/api/loot', 'POST', { memberId: b.id, item: 'Bob shield' }, s.officer);
  const ev = (await s.call('/api/events', 'POST', { title: 'Boss', type: 'Archboss', start: inDays(-1) }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [a.id, b.id] }, s.officer);
  const pre = (await s.call('/api/presets', 'POST', { name: 'P', parties: [{ name: 'A', members: [a.id] }] }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: [{ name: 'A', members: [a.id, b.id] }] }, s.officer);
  await s.call('/api/duties', 'POST', { memberId: a.id, text: 'x' }, s.officer).catch(() => {});
  const seenByAnn = await state(s, 'ann');
  assert.deepEqual(seenByAnn.loot.map((l) => l.item), ['Ann sword']);
  assert.deepEqual(seenByAnn.points.map((p) => p.memberId), [a.id]);
  const e = seenByAnn.events.find((x) => x.id === ev.id);
  assert.deepEqual(e.attended, [a.id], "a member sees only their own character in the attendance list");
  assert.equal(e.rollTaken, true, 'but still knows that attendance was recorded');
  assert.equal(e.parties.length, 1);
  assert.equal((await state(s, 'officer')).loot.length, 2); assert.deepEqual((await state(s, 'officer')).events.find((x) => x.id === ev.id).attended.sort(), [a.id, b.id].sort());
  // hide sections
  await s.call('/api/admin/options', 'PUT', { hiddenSections: ['parties', 'loot', 'points', 'requests', 'nonsense'] }, s.officer);
  const hidden = await state(s, 'ann');
  assert.deepEqual([hidden.loot.length, hidden.points.length, hidden.presets.length, hidden.events.find((x) => x.id === ev.id).parties.length], [0, 0, 0, 0]);
  assert.deepEqual((await state(s, 'officer')).settings.hiddenSections.sort(), ['loot', 'parties', 'points', 'requests']);
  assert.equal((await state(s, 'officer')).presets.length, 1, 'officers still see everything');
  assert.equal((await s.call('/api/admin/options', 'PUT', { hiddenSections: [] }, s.ann)).status, 403);
});

// ---------------------------------------------------------------- branding, uploads, preferences
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString('base64');
withServer('guild name, colour, icon and background can be changed by the leadership', async (s) => {
  const opt = (who, b) => s.call('/api/admin/options', 'PUT', b, s[who]);
  assert.equal((await opt('officer', { branding: { name: 'Night Watch', tagline: 'We hold the line', accent: '#3366FF', bgDim: 60, announcement: 'Siege on Sunday' } })).status, 200);
  assert.equal((await opt('officer', { branding: { accent: 'blue' } })).status, 400);
  assert.equal((await opt('officer', { branding: { bgDim: 99 } })).status, 400);
  let cfg = (await s.call('/api/config')).body;
  assert.deepEqual([cfg.branding.name, cfg.branding.accent, cfg.branding.bgDim], ['Night Watch', '#3366ff', 60]);
  const up = (who, b) => s.call('/api/admin/upload', 'POST', b, s[who]);
  assert.equal((await up('ann', { kind: 'icon', data: PNG })).status, 403);
  assert.equal((await up('officer', { kind: 'icon', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'.repeat(5)).toString('base64') })).status, 400, 'SVG is refused');
  assert.equal((await up('officer', { kind: 'icon', data: Buffer.from('just some text '.repeat(20)).toString('base64') })).status, 400);
  assert.equal((await up('officer', { kind: 'icon', data: Buffer.alloc(1.6e6, 1).toString('base64') })).status, 413, 'an icon over 1.5 MB is too large');
  assert.equal((await up('officer', { kind: 'other', data: PNG })).status, 400);
  const okIcon = (await up('officer', { kind: 'icon', data: 'data:image/png;base64,' + PNG })).body;
  assert.match(okIcon.icon, /^\/uploads\/icon-[a-f0-9]{12}\.png$/);
  const img = await fetch(s.base + okIcon.icon);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png'); assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(s.base + '/uploads/icon-000000000000.png')).status, 404);
  assert.equal((await fetch(s.base + '/uploads/../server.js')).status === 200 && (await (await fetch(s.base + '/uploads/../server.js')).text()).includes('createServer'), false);
  const bg = (await up('officer', { kind: 'background', data: PNG })).body;
  assert.ok(bg.bg && bg.icon);
  assert.equal(fs.readdirSync(path.join(s.dir, 'uploads')).length, 2);
  await up('officer', { kind: 'icon', remove: true });
  cfg = (await s.call('/api/config')).body; assert.equal(cfg.branding.icon, ''); assert.equal(fs.readdirSync(path.join(s.dir, 'uploads')).length, 1, 'the old file is deleted');
});

withServer('only the leadership arranges the dashboard; the choice is stored per person', async (s) => {
  const put = (who, b) => s.call('/api/prefs', 'PUT', b, s[who]);
  assert.equal((await put('ann', { dashboardHidden: ['loot'] })).status, 403, 'a normal member cannot customize the dashboard');
  assert.deepEqual((await put('officer', { dashboardHidden: ['loot', 'bogus'], dashboardOrder: ['next', 'stats', 'next', 'nope'] })).body, { dashboardHidden: ['loot'], dashboardOrder: ['next', 'stats'] });
  assert.deepEqual((await state(s, 'officer')).prefs.dashboardHidden, ['loot']);
  assert.deepEqual((await state(s, 'bob')).prefs, {});
});

// ---------------------------------------------------------------- old data
withServer('old characters with a single Questlog link are converted', async (s) => {
  const m = (await state(s, 'ann')).members[0];
  assert.deepEqual(m.questlogs, [{ label: 'Questlog', url: 'https://example.com/old' }]);
  assert.deepEqual(m.builds, []); assert.equal(m.mode, 'PvE'); assert.equal(m.questlog, undefined);
}, { nextId: 10, members: [{ id: 1, owner: 'Ann', name: 'Old', role: 'Tank', rank: 'Member', active: true, gearScore: 1, level: 1, questlog: 'https://example.com/old' }], events: [], points: [] });

// ---------------------------------------------------------------- info section, notices, time zone, presets for several types
withServer('the info section on the dashboard is edited by the leadership and visible to everybody', async (s) => {
  const board = { categories: [
    { title: 'Guild rules', buttons: [{ label: 'Loot rules', text: 'Attend 60% of the mandatory events.\r\nSee https://example.com/rules' }, { label: '   ', text: 'no label' }] },
    { title: 'Links', buttons: [{ label: 'Discord', text: 'https://discord.gg/example' }] },
  ] };
  assert.equal((await s.call('/api/info-board', 'PUT', board, s.ann)).status, 403);
  const saved = (await s.call('/api/info-board', 'PUT', board, s.officer)).body;
  assert.equal(saved.categories.length, 2);
  assert.equal(saved.categories[0].buttons.length, 1, 'a button without a label is dropped');
  assert.equal(saved.categories[0].buttons[0].text, 'Attend 60% of the mandatory events.\nSee https://example.com/rules');
  assert.equal((await state(s, 'bob')).infoBoard.categories[1].buttons[0].label, 'Discord');
  assert.equal((await s.call('/api/info-board', 'PUT', { categories: [{ title: '', buttons: [{ label: 'x', text: 'y' }] }] }, s.officer)).status, 400, 'a category needs a name');
  assert.equal((await s.call('/api/info-board', 'PUT', { categories: Array.from({ length: 9 }, (_, i) => ({ title: 'C' + i, buttons: [] })) }, s.officer)).status, 400);
  assert.equal((await s.call('/api/info-board', 'PUT', { categories: [{ title: 'A', buttons: Array.from({ length: 13 }, (_, i) => ({ label: 'B' + i, text: '' })) }] }, s.officer)).status, 400);
  const long = (await s.call('/api/info-board', 'PUT', { categories: [{ title: 'A'.repeat(90), buttons: [{ label: 'L', text: 'x'.repeat(5000) }] }] }, s.officer)).body;
  assert.equal(long.categories[0].title.length, 40); assert.equal(long.categories[0].buttons[0].text.length, 3000);
  assert.deepEqual((await s.call('/api/info-board', 'PUT', { categories: [] }, s.officer)).body, { title: 'Info', categories: [] });
  assert.equal((await s.call('/api/info-board', 'PUT', { title: 'Guild wiki', categories: [] }, s.officer)).body.title, 'Guild wiki', 'the name of the section can be changed');
  assert.equal((await state(s, 'bob')).infoBoard.title, 'Guild wiki');
});

withServer('login notices stay on screen until every player accepts them', async (s) => {
  assert.equal((await s.call('/api/notices', 'POST', { title: 'Rules', text: 'Read this' }, s.ann)).status, 403);
  assert.equal((await s.call('/api/notices', 'POST', { title: '', text: 'x' }, s.officer)).status, 400);
  assert.equal((await s.call('/api/notices', 'POST', { title: 'x', text: '  ' }, s.officer)).status, 400);
  const n = (await s.call('/api/notices', 'POST', { title: 'New siege rules', text: 'Be in voice chat.\nNo exceptions.' }, s.officer)).body;
  assert.equal(n.accepted, true, 'the author does not have to accept their own notice');
  const mine = (st) => st.notices.find((x) => x.id === n.id);
  assert.equal(mine(await state(s, 'ann')).accepted, false);
  assert.equal(mine(await state(s, 'ann')).acks, undefined, 'players do not see who accepted');
  assert.equal((await s.call(`/api/notices/${n.id}/ack`, 'POST', {}, s.ann)).status, 200);
  await s.call(`/api/notices/${n.id}/ack`, 'POST', {}, s.ann);                                  // accepting twice changes nothing
  assert.equal(mine(await state(s, 'ann')).accepted, true);
  assert.equal(mine(await state(s, 'bob')).accepted, false);
  const seenByOfficer = mine(await state(s, 'officer'));
  assert.deepEqual(seenByOfficer.acks.map((a) => a.name).sort(), ['Ann', 'Boss']);
  // edit + everybody has to accept again
  assert.equal((await s.call('/api/notices/' + n.id, 'PUT', { title: 'New siege rules', text: 'Changed text', resetAcks: true }, s.officer)).body.text, 'Changed text');
  assert.equal(mine(await state(s, 'ann')).accepted, false);
  // switched off: players no longer get it
  await s.call('/api/notices/' + n.id, 'PUT', { title: 'x', text: 'y', active: false }, s.officer);
  assert.equal(mine(await state(s, 'ann')), undefined);
  assert.equal(mine(await state(s, 'officer')).active, false, 'the leadership still sees it');
  assert.equal((await s.call(`/api/notices/${n.id}/ack`, 'POST', {}, s.bob)).status, 404, 'an inactive notice cannot be accepted');
  assert.equal((await s.call('/api/notices/' + n.id, 'DELETE', null, s.ann)).status, 403);
  assert.equal((await s.call('/api/notices/' + n.id, 'DELETE', null, s.officer)).status, 200);
  assert.equal((await state(s, 'officer')).notices.length, 0);
});

withServer('every player can choose the time zone their times are shown in', async (s) => {
  const put = (who, b) => s.call('/api/prefs', 'PUT', b, s[who]);
  assert.equal((await put('ann', { timezone: 'Asia/Tokyo' })).body.timezone, 'Asia/Tokyo');
  assert.equal((await put('ann', { timezone: 'Mars/Base' })).status, 400);
  assert.equal((await state(s, 'ann')).prefs.timezone, 'Asia/Tokyo');
  assert.equal((await state(s, 'bob')).prefs.timezone, undefined, 'it is a personal setting');
  assert.equal((await put('ann', { dashboardHidden: ['loot'] })).status, 403);
  await put('officer', { timezone: 'Asia/Tokyo' });
  const both = (await put('officer', { dashboardHidden: ['loot'], dashboardOrder: ['next', 'stats'] })).body;
  assert.deepEqual([both.timezone, both.dashboardHidden], ['Asia/Tokyo', ['loot']], 'saving the dashboard keeps the time zone');
  assert.equal((await put('officer', { timezone: 'America/New_York' })).body.dashboardHidden[0], 'loot', 'and the other way round');
  assert.equal((await put('ann', { timezone: '' })).body.timezone, undefined, 'empty means back to the default');
  assert.deepEqual((await put('officer', { dashboardHidden: ['info', 'next', 'bogus'] })).body.dashboardHidden, ['info', 'next']);
});

withServer('one preset can be used for several event types and for chosen events at once', async (s) => {
  const a = (await s.call('/api/members', 'POST', { name: 'Aaa', role: 'Tank' }, s.ann)).body.id;
  const p = (await s.call('/api/presets', 'POST', { name: 'Big line-up', parties: [{ name: 'Front', members: [a] }] }, s.officer)).body;
  const mk = async (type, d) => (await s.call('/api/events', 'POST', { type, start: inDays(d) }, s.officer)).body;
  const wg1 = await mk('Wargames', 2), wg2 = await mk('Wargames', 9), boon = await mk('Boonstone', 3), dungeon = await mk('Dungeon', 4), pastWg = await mk('Wargames', -2);
  await s.call(`/api/events/${wg2.id}/parties`, 'POST', { parties: [{ name: 'Mine', members: [a] }] }, s.officer);
  const use = (b, who = 'officer') => s.call(`/api/presets/${p.id}/use-for`, 'POST', b, s[who]);
  assert.equal((await use({ types: ['Wargames'] }, 'ann')).status, 403);
  assert.equal((await use({})).status, 400, 'pick something');
  assert.equal((await use({ types: ['Nonsense'] })).status, 400);
  const r = (await use({ types: ['Wargames', 'Boonstone'], eventIds: [dungeon.id] })).body;
  assert.deepEqual([r.applied, r.skipped], [3, 1], 'two Wargames dates, the boonstone and the chosen dungeon; the one with parties is kept');
  const parties = async () => Object.fromEntries((await state(s, 'ann')).events.map((e) => [e.id, e.parties.map((x) => x.name)]));
  let now = await parties();
  assert.deepEqual([now[wg1.id], now[boon.id], now[dungeon.id], now[wg2.id], now[pastWg.id]], [['Front'], ['Front'], ['Front'], ['Mine'], []]);
  assert.deepEqual((await state(s, 'ann')).presetRules.map((x) => x.type).sort(), ['Boonstone', 'Wargames'], 'both types now use the preset for future events too');
  assert.equal((await mk('Boonstone', 20)).parties.length, 1);
  assert.equal((await mk('Dungeon', 20)).parties.length, 0, 'a chosen single event does not create a rule');
  assert.equal((await use({ types: ['Wargames'], overwrite: true })).body.applied, 2);
  assert.equal((await parties())[wg2.id][0], 'Front');
});

// ---------------------------------------------------------------- Gauntlet, hidden questlog links, notices to chosen players, untick event types
withServer('the Gauntlet is a weapon with its class names, and no pair or name is listed twice', async (s) => {
  const cfg = (await s.call('/api/config')).body;
  assert.ok(cfg.weapons.includes('Gauntlet'));
  const g = Object.fromEntries(cfg.classes.filter((c) => c.weapons.includes('Gauntlet')).map((c) => [c.weapons.find((w) => w !== 'Gauntlet'), c.name]));
  assert.deepEqual(g, { Greatsword: 'Mauler', Orb: 'Soulcrusher', Staff: 'Archon', Spear: 'Destroyer', Longbow: 'Mobilist', Daggers: 'Predator', Crossbow: 'Shrike' });
  const keys = cfg.classes.map((c) => c.weapons.slice().sort().join('+'));
  assert.equal(new Set(keys).size, keys.length, 'no weapon pair is listed twice');
  assert.equal(new Set(cfg.classes.map((c) => c.name)).size, cfg.classes.length, 'no class name is used twice');
  for (const c of cfg.classes) for (const w of c.weapons) assert.ok(cfg.weapons.includes(w), `${c.name} uses a weapon that exists: ${w}`);
  const m = (await s.call('/api/members', 'POST', { name: 'Fist', role: 'Tank', primaryWeapon: 'Gauntlet', secondaryWeapon: 'Greatsword' }, s.ann)).body;
  assert.equal(m.primaryWeapon, 'Gauntlet');
});

withServer('Questlog links are for the leadership and the owner, not for other members', async (s) => {
  const mk = (who, name) => s.call('/api/members', 'POST', { name, role: 'DPS', questlogs: [{ label: 'Main', url: 'https://questlog.gg/' + name.toLowerCase() }] }, s[who]);
  await mk('ann', 'Annie'); await mk('bob', 'Bobby');
  const seen = async (who) => Object.fromEntries((await state(s, who)).members.map((m) => [m.name, m.questlogs.length]));
  assert.deepEqual(await seen('ann'), { Annie: 1, Bobby: 0 }, 'you see your own links only');
  assert.deepEqual(await seen('officer'), { Annie: 1, Bobby: 1 }, 'the leadership sees all');
});

withServer('a login notice can go to chosen players only', async (s) => {
  assert.equal((await s.call('/api/notices', 'POST', { title: 'Just you', text: 'Hi', audience: 'selected', recipients: [] }, s.officer)).status, 400, 'a selection needs at least one player');
  const n = (await s.call('/api/notices', 'POST', { title: 'Only Ann', text: 'A word with you.', audience: 'selected', recipients: ['Ann', 'Ann', 'Nobody'] }, s.officer)).body;
  assert.deepEqual(n.recipients, ['Ann', 'Nobody'], 'duplicates are removed');
  const has = async (who) => (await state(s, who)).notices.some((x) => x.id === n.id);
  assert.deepEqual([await has('ann'), await has('bob')], [true, false], 'only the chosen player gets it');
  assert.equal((await s.call(`/api/notices/${n.id}/ack`, 'POST', {}, s.bob)).status, 404, 'somebody else cannot accept it');
  assert.equal((await s.call(`/api/notices/${n.id}/ack`, 'POST', {}, s.ann)).status, 200);
  assert.deepEqual((await state(s, 'officer')).notices.find((x) => x.id === n.id).recipients, ['Ann', 'Nobody'], 'the leadership sees who it went to');
  const all = (await s.call('/api/notices/' + n.id, 'PUT', { title: 'Only Ann', text: 'A word with you.', audience: 'all' }, s.officer)).body;
  assert.equal(all.recipients, null);
  assert.equal(await has('bob'), true, 'switched to everybody');
  const back = (await s.call('/api/notices/' + n.id, 'PUT', { title: 'x', text: 'y', recipients: ['Bob'] }, s.officer)).body;
  assert.deepEqual(back.recipients, ['Bob'], 'a list of players alone also narrows it');
  assert.equal((await s.call('/api/notices', 'POST', { title: 'Everybody', text: 'Hi' }, s.officer)).body.recipients, null, 'the default is everybody');
});

withServer('event types ticked for a preset stay ticked, and unticking removes the rule for new events only', async (s) => {
  const a = (await s.call('/api/members', 'POST', { name: 'Aaa', role: 'Tank' }, s.ann)).body.id;
  const p = (await s.call('/api/presets', 'POST', { name: 'One', parties: [{ name: 'F', members: [a] }] }, s.officer)).body;
  const q = (await s.call('/api/presets', 'POST', { name: 'Two', parties: [{ name: 'G', members: [a] }] }, s.officer)).body;
  const mk = async (type, d) => (await s.call('/api/events', 'POST', { type, start: new Date(Date.now() + d * 864e5).toISOString() }, s.officer)).body;
  const use = (id, b) => s.call(`/api/presets/${id}/use-for`, 'POST', b, s.officer);
  await use(p.id, { types: ['Wargames', 'Boonstone'] });
  const rules = async () => Object.fromEntries((await state(s, 'ann')).presetRules.map((r) => [r.type, r.presetId]));
  assert.deepEqual(await rules(), { Wargames: p.id, Boonstone: p.id });
  const filled = await mk('Wargames', 3);
  assert.equal(filled.parties.length, 1);
  const r = (await use(p.id, { types: ['Wargames'], removeTypes: ['Boonstone'] })).body;
  assert.equal(r.removed, 1);
  assert.deepEqual(await rules(), { Wargames: p.id }, 'Boonstone is no longer tied to the preset');
  assert.equal((await mk('Boonstone', 4)).parties.length, 0, 'so a new Boonstone starts empty');
  assert.equal((await state(s, 'ann')).events.find((e) => e.id === filled.id).parties.length, 1, 'events that already have parties keep them');
  await use(q.id, { types: ['Dungeon'] });
  await use(p.id, { removeTypes: ['Dungeon'] });                                      // Dungeon belongs to "Two": the other preset cannot remove it
  assert.equal((await rules()).Dungeon, q.id);
  assert.equal((await use(p.id, { types: [], removeTypes: [] })).status, 400, 'nothing chosen');
  await use(p.id, { removeTypes: ['Wargames'] });
  assert.deepEqual(await rules(), { Dungeon: q.id }, 'an untick can also be the only change');
});
