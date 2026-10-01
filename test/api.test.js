// Integration tests: each test starts the real server on a random port with a throw-away data folder.
// Run with:  npm test   (needs Node 18+, no dependencies)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer(seedDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-test-'));
  if (seedDb) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seedDb));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
  const base = `http://localhost:${port}`;
  const call = async (p, method = 'GET', body, token) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return {
    base, call, login,
    officer: await login('Boss', 'o1'), member: await login('Zed', 'm1'), other: await login('Other', 'm1'),
    stop: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// Runs a test body against a fresh server and always cleans up.
const withServer = (name, fn, seed) => test(name, async () => { const s = await startServer(seed); try { await fn(s); } finally { s.stop(); } });

withServer('login needs the right passcode and a proper name', async ({ call }) => {
  assert.equal((await call('/api/login', 'POST', { name: 'Zed', passcode: 'nope' })).status, 401);
  assert.equal((await call('/api/login', 'POST', { name: 'Z', passcode: 'm1' })).status, 400);
  assert.equal((await call('/api/state')).status, 401);
});

withServer('members cannot use officer routes', async ({ call, member, officer }) => {
  assert.equal((await call('/api/events', 'POST', { title: 'x', start: '2026-10-01T18:00:00Z' }, member)).status, 403);
  assert.equal((await call('/api/export', 'GET', null, member)).status, 403);
  assert.equal((await call('/api/settings', 'PUT', { lootThreshold: 70 }, member)).status, 403);
  assert.equal((await call('/api/events', 'POST', { title: 'x', start: '2026-10-01T18:00:00Z' }, officer)).status, 200);
});

withServer('players can only edit their own characters; ranks are officer-only', async ({ call, member, other, officer }) => {
  const c = (await call('/api/members', 'POST', { name: 'Tanky', role: 'Tank' }, member)).body;
  assert.equal((await call('/api/members/' + c.id, 'PUT', { name: 'Hax' }, other)).status, 403);
  assert.equal((await call('/api/members/' + c.id, 'PUT', { name: 'Tanky', role: 'Tank', rank: 'Officer' }, member)).body.rank, 'Recruit');
  assert.equal((await call('/api/members/' + c.id, 'PUT', { name: 'Tanky', role: 'Tank', rank: 'Officer' }, officer)).body.rank, 'Officer');
});

withServer('players can keep several Questlog links, and only plain http(s) links are accepted', async ({ call, member, officer }) => {
  const c = (await call('/api/members', 'POST', { name: 'Linky', role: 'DPS', questlogs: [{ label: 'Main', url: 'https://questlog.gg/x?y=1' }, { url: 'https://example.com/second' }] }, member)).body;
  assert.deepEqual(c.questlogs, [{ label: 'Main', url: 'https://questlog.gg/x?y=1' }, { label: '', url: 'https://example.com/second' }]);
  const put = (questlogs) => call('/api/members/' + c.id, 'PUT', { name: 'Linky', role: 'DPS', questlogs }, member);
  assert.equal((await put([{ url: 'javascript:alert(1)' }])).status, 400);
  assert.equal((await put(Array.from({ length: 7 }, (_, i) => ({ url: 'https://example.com/' + i })))).status, 400);
  assert.deepEqual((await put([])).body.questlogs, []);
  const old = (await call('/api/members', 'POST', { name: 'Oldstyle', role: 'DPS', owner: 'OldstyleOwner', questlog: 'https://example.com/single' }, officer)).body;
  assert.equal(old.questlogs[0].url, 'https://example.com/single', 'the old single-link field still works');
});

withServer('event types carry a mandatory default that can be overridden', async ({ call, officer }) => {
  const cfg = (await call('/api/config')).body;
  for (const t of ['Wargames', 'Tax delivery', 'Guild bosses', 'PvE-Raid', 'Interserver Boonstone', 'Interserver Riftstone', 'Worldboss (Conflict)', 'Worldboss (Peace)']) {
    assert.ok(cfg.eventTypes.some((x) => x.name === t), 'missing event type ' + t);
  }
  const mk = async (b) => (await call('/api/events', 'POST', { title: 't', start: '2026-10-01T18:00:00Z', ...b }, officer)).body;
  assert.equal((await mk({ type: 'Castle Siege' })).mandatory, true);
  assert.equal((await mk({ type: 'Other' })).mandatory, false);
  assert.equal((await mk({ type: 'Other', mandatory: true })).mandatory, true);
});

withServer('points are off until the leadership switches them on', async ({ call, member, officer }) => {
  assert.equal((await call('/api/state', 'GET', null, member)).body.settings.pointsEnabled, false, 'off as standard');
  const id = (await call('/api/members', 'POST', { name: 'Solo', role: 'DPS' }, member)).body.id;
  const ev = (await call('/api/events', 'POST', { title: 'Boss', type: 'Archboss', start: '2026-10-01T18:00:00Z' }, officer)).body;
  await call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [id] }, officer);
  assert.equal((await call('/api/state', 'GET', null, member)).body.points.length, 0, 'attending gives no points while they are off');
  assert.equal((await call('/api/points', 'POST', { memberId: id, delta: 5, reason: 'x' }, officer)).status, 400, 'and points cannot be adjusted by hand either');
});

withServer('attendance gives points, can be undone, and respects the Admin switch', async ({ call, member, officer }) => {
  await call('/api/settings', 'PUT', { pointsEnabled: true }, officer);
  const ids = [];
  for (const n of ['One', 'Two', 'Three']) ids.push((await call('/api/members', 'POST', { name: n, role: 'DPS', owner: n }, officer)).body.id);
  const ev = (await call('/api/events', 'POST', { title: 'Boss', type: 'Archboss', start: '2026-10-01T18:00:00Z' }, officer)).body;
  const pts = async () => (await call('/api/state', 'GET', null, officer)).body.points.filter((p) => p.eventId === ev.id);
  await call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: ids }, officer);
  assert.equal((await pts()).length, 3);
  await call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [ids[0]] }, officer);
  assert.equal((await pts()).length, 1);
  await call('/api/settings', 'PUT', { pointsEnabled: false }, officer);
  await call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: ids }, officer);
  assert.equal((await pts()).length, 1, 'no new points while switched off');
  assert.equal((await call('/api/points', 'POST', { memberId: ids[0], delta: 5 }, officer)).status, 400);
  await call('/api/settings', 'PUT', { pointsEnabled: true }, officer);
  await call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: ids }, officer);
  assert.equal((await pts()).length, 3);
});

withServer('loot log: officers add/edit/delete, dates and items are validated, members only read', async ({ call, member, officer }) => {
  const m = (await call('/api/members', 'POST', { name: 'Looty', role: 'Healer' }, member)).body;
  assert.equal((await call('/api/loot', 'POST', { memberId: m.id, item: 'x' }, member)).status, 403);
  const l = (await call('/api/loot', 'POST', { memberId: m.id, item: '  Sword of Tests ', date: '2026-09-15' }, officer)).body;
  assert.equal(l.item, 'Sword of Tests');
  assert.equal((await call('/api/loot', 'POST', { memberId: m.id, item: ' ' }, officer)).status, 400);
  assert.equal((await call('/api/loot', 'POST', { memberId: m.id, item: 'a', date: '15.09.2026' }, officer)).status, 400);
  assert.equal((await call('/api/loot', 'POST', { memberId: 99999, item: 'a' }, officer)).status, 404);
  assert.equal((await call('/api/loot/' + l.id, 'PUT', { item: 'Renamed', date: '2026-09-16' }, officer)).body.date, '2026-09-16');
  assert.equal((await call('/api/state', 'GET', null, member)).body.loot.length, 1);
  assert.equal((await call('/api/loot/' + l.id, 'DELETE', null, officer)).status, 200);
  const l2 = (await call('/api/loot', 'POST', { memberId: m.id, item: 'Keep me' }, officer)).body;
  await call('/api/members/' + m.id, 'DELETE', null, officer);
  assert.equal((await call('/api/state', 'GET', null, member)).body.loot.some((x) => x.id === l2.id), false, 'loot is removed with its player');
});

withServer('loot rules are editable and validated', async ({ call, officer }) => {
  const set = (b) => call('/api/settings', 'PUT', b, officer);
  assert.equal((await set({ lootThreshold: 70 })).body.lootThreshold, 70);
  assert.equal((await set({ lootThreshold: 0 })).status, 400);
  assert.equal((await set({ lootThreshold: 101 })).status, 400);
  const bands = (await set({ lootRedMax: 50, lootOrangeMax: 75 })).body;
  assert.deepEqual([bands.lootRedMax, bands.lootOrangeMax], [50, 75]);
  assert.equal((await set({ lootRedMax: 80, lootOrangeMax: 70 })).status, 400);
  assert.equal((await set({ lootOrangeMax: 100 })).status, 400);
  assert.equal((await set({ lootItemDays: 14 })).body.lootItemDays, 14);
  assert.equal((await set({ lootItemDays: 0 })).status, 400);
  assert.equal((await set({ lootFrom: 'not a date' })).status, 400);
  assert.equal((await set({ lootFrom: '2026-09-10' })).body.lootFrom, '2026-09-10');
});

withServer('party presets keep names and leaders, and clean up when a member is deleted', async ({ call, member, officer }) => {
  const a = (await call('/api/members', 'POST', { name: 'Aaa', role: 'Tank' }, member)).body.id;
  const b = (await call('/api/members', 'POST', { name: 'Bbb', role: 'Healer', owner: 'Bbb' }, officer)).body.id;
  const p = (await call('/api/presets', 'POST', { name: 'Siege', parties: [{ name: 'Front', leader: a, members: [a, b] }, { name: '  ', leader: 999, members: [b] }] }, officer)).body;
  assert.deepEqual(p.parties, [{ name: 'Front', members: [a, b], leader: a, builds: {} }, { name: 'Party 2', members: [], leader: null, builds: {} }], 'a member can only sit in one party, leader must belong to the party');
  assert.equal((await call('/api/presets', 'POST', { name: 'x' }, member)).status, 403);
  await call('/api/members/' + a, 'DELETE', null, officer);
  const after = (await call('/api/state', 'GET', null, member)).body.presets[0];
  assert.deepEqual(after.parties[0], { name: 'Front', members: [b], leader: null, builds: {} });
});

withServer('export and import round-trip everything', async ({ call, member, officer }) => {
  const m = (await call('/api/members', 'POST', { name: 'Keeper', role: 'DPS' }, member)).body;
  await call('/api/loot', 'POST', { memberId: m.id, item: 'Thing' }, officer);
  const exp = (await call('/api/export', 'GET', null, officer)).body;
  assert.equal(exp.loot.length, 1);
  assert.equal((await call('/api/import', 'POST', exp, officer)).status, 200);
  assert.equal((await call('/api/state', 'GET', null, member)).body.loot.length, 1);
  assert.equal((await call('/api/import', 'POST', { members: exp.members, events: exp.events, points: exp.points }, officer)).status, 200, 'older backups without loot/settings still import');
  const st = (await call('/api/state', 'GET', null, member)).body;
  assert.equal(st.settings.lootThreshold, 60);
});

withServer('old data with bare id arrays as parties is converted on start', async ({ call, member }) => {
  const ev = (await call('/api/state', 'GET', null, member)).body.events[0];
  assert.deepEqual(ev.parties, [{ name: 'Party 1', members: [1, 2], leader: null, builds: {} }, { name: 'Party 2', members: [], leader: null, builds: {} }]);
}, {
  nextId: 20,
  members: [
    { id: 1, owner: 'Amy', name: 'One', role: 'Tank', rank: 'Member', active: true, gearScore: 1, level: 1 },
    { id: 2, owner: 'Bob', name: 'Two', role: 'DPS', rank: 'Member', active: true, gearScore: 1, level: 1 },
  ],
  events: [{ id: 10, title: 'Old', type: 'Other', start: new Date().toISOString(), rsvps: {}, attended: [], parties: [[1, 2, 99], [2]] }],
  points: [],
});

withServer('loot entries have a type (skillcore, item, shard) that is validated and editable', async ({ call, member, officer }) => {
  const m = (await call('/api/members', 'POST', { name: 'Typey', role: 'DPS' }, member)).body;
  const cfg = (await call('/api/config')).body;
  assert.deepEqual(cfg.lootTypes, ['Skillcore', 'Item', 'Shard', 'Lucent']);
  assert.equal((await call('/api/loot', 'POST', { memberId: m.id, item: 'Plain' }, officer)).body.type, 'Item', 'defaults to Item');
  const s = (await call('/api/loot', 'POST', { memberId: m.id, item: 'Fire skillcore', type: 'Skillcore' }, officer)).body;
  assert.equal(s.type, 'Skillcore');
  assert.equal((await call('/api/loot', 'POST', { memberId: m.id, item: 'x', type: 'Gold' }, officer)).status, 400);
  assert.equal((await call('/api/loot/' + s.id, 'PUT', { type: 'Shard' }, officer)).body.type, 'Shard');
  assert.equal((await call('/api/loot/' + s.id, 'PUT', { item: 'Renamed' }, officer)).body.type, 'Shard', 'editing other fields keeps the type');
});

withServer('a party preset can be tied to an event type, for upcoming and future events', async ({ call, member, officer }) => {
  const a = (await call('/api/members', 'POST', { name: 'Aaa', role: 'Tank' }, member)).body.id;
  const b = (await call('/api/members', 'POST', { name: 'Bbb', role: 'DPS', owner: 'Bbb' }, officer)).body.id;
  const preset = (await call('/api/presets', 'POST', { name: 'WG main', parties: [{ name: 'Front', leader: a, members: [a, b] }] }, officer)).body;
  const day = 864e5, iso = (d) => new Date(Date.now() + d * day).toISOString();
  const mk = async (type, d) => (await call('/api/events', 'POST', { type, start: iso(d) }, officer)).body;
  const past = await mk('Wargames', -3), next1 = await mk('Wargames', 2), next2 = await mk('Wargames', 9), other = await mk('Dungeon', 3);
  await call(`/api/events/${next2.id}/parties`, 'POST', { parties: [{ name: 'Mine', members: [b] }] }, officer);

  assert.equal((await call(`/api/presets/${preset.id}/use-for-type`, 'POST', { type: 'Nonsense' }, officer)).status, 400);
  assert.equal((await call(`/api/presets/${preset.id}/use-for-type`, 'POST', { type: 'Wargames' }, member)).status, 403);
  const r1 = (await call(`/api/presets/${preset.id}/use-for-type`, 'POST', { type: 'Wargames' }, officer)).body;
  assert.deepEqual([r1.applied, r1.skipped], [1, 1], 'events that already have parties are kept unless you say so');
  const parties = async () => Object.fromEntries((await call('/api/state', 'GET', null, member)).body.events.map((e) => [e.id, e.parties]));
  let p = await parties();
  assert.deepEqual(p[next1.id], [{ name: 'Front', members: [a, b], leader: a, builds: {} }]);
  assert.equal(p[next2.id][0].name, 'Mine');
  assert.equal(p[past.id].length, 0, 'past events are left alone');
  assert.equal(p[other.id].length, 0, 'other event types are left alone');

  const r2 = (await call(`/api/presets/${preset.id}/use-for-type`, 'POST', { type: 'Wargames', overwrite: true }, officer)).body;
  assert.equal(r2.applied, 2);
  assert.equal((await parties())[next2.id][0].name, 'Front');

  const future = await mk('Wargames', 16);
  assert.equal(future.parties.length, 1, 'a Wargames event created later gets the preset automatically');
  const retyped = await mk('Dungeon', 20);
  assert.equal(retyped.parties.length, 0);
  assert.equal((await call('/api/events/' + retyped.id, 'PUT', { type: 'Wargames', start: retyped.start }, officer)).body.parties.length, 1, 'changing the type to Wargames fills empty parties too');

  assert.equal((await call('/api/preset-rules/Wargames', 'DELETE', null, officer)).status, 200);
  assert.equal((await mk('Wargames', 30)).parties.length, 0, 'rule removed: new events stay empty');
  await call(`/api/presets/${preset.id}/use-for-type`, 'POST', { type: 'Wargames' }, officer);
  await call('/api/presets/' + preset.id, 'DELETE', null, officer);
  assert.deepEqual((await call('/api/state', 'GET', null, member)).body.presetRules, [], 'deleting a preset removes its rules');
});

withServer('old events: "maybe" answers are dropped, no PIN is sent for events that already started, closed PIN windows stay closed', async ({ call, member, officer }) => {
  const st = (await call('/api/state', 'GET', null, member)).body;
  const byTitle = (t) => st.events.find((e) => e.title === t);
  assert.deepEqual(byTitle('Legacy started').rsvps, { 1: 'yes' }, '"maybe" is removed');
  assert.equal(byTitle('Legacy started').signupCloseMinutes, 30);
  await new Promise((r) => setTimeout(r, 1500));                                   // let the scheduler run a few times
  const off = (await call('/api/state', 'GET', null, officer)).body;
  assert.equal(off.events.find((e) => e.title === 'Legacy started').pin, null, 'no surprise PIN for an event that began before the update');
  const closed = off.events.find((e) => e.title === 'Old PIN');
  assert.equal(closed.pinInfo.state, 'closed');
  assert.equal((await call(`/api/events/${closed.id}/pin`, 'POST', { memberId: 1, pin: '1234' }, member)).status, 409);
}, {
  nextId: 50,
  members: [{ id: 1, owner: 'Zed', name: 'One', role: 'Tank', rank: 'Member', active: true, gearScore: 1, level: 1 }],
  events: [
    { id: 10, title: 'Legacy started', type: 'Other', start: new Date(Date.now() - 3600e3).toISOString(), rsvps: { 1: 'yes', 2: 'maybe' }, attended: [], parties: [] },
    { id: 11, title: 'Old PIN', type: 'Other', start: new Date(Date.now() - 2 * 3600e3).toISOString(), rsvps: {}, attended: [], parties: [],
      pinWindowMinutes: 15, signupCloseMinutes: 30, reminders: true, pin: { code: '1234', at: new Date(Date.now() - 3600e3).toISOString(), sent: [] } },
  ],
  points: [],
});

withServer('event title is optional and defaults to the type', async ({ call, officer }) => {
  const ev = (await call('/api/events', 'POST', { type: 'Tax delivery', start: '2026-10-01T18:00:00Z', title: '   ' }, officer)).body;
  assert.equal(ev.title, 'Tax delivery');
  assert.equal((await call('/api/events', 'POST', { type: 'Tax delivery', start: '2026-10-01T18:00:00Z', title: 'Custom' }, officer)).body.title, 'Custom');
});
