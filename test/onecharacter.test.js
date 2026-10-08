// Integration tests for "one character per player": the rule itself, and the cleanup tool for data from before it existed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer(seedDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-1char-'));
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
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return { base, call, officer: await login('Boss', 'o1'), zed: await login('Zed', 'm1'), stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const withServer = (name, fn, seed) => test(name, async () => { const s = await startServer(seed); try { await fn(s); } finally { await s.stop(); } });
const state = async (s, who) => (await s.call('/api/state', 'GET', null, s[who])).body;

withServer('a member cannot create a second character themselves, and a helpful message explains why', async (s) => {
  await s.call('/api/members', 'POST', { name: 'Vaelin', role: 'Tank' }, s.zed);
  const again = await s.call('/api/members', 'POST', { name: 'Second try', role: 'Healer' }, s.zed);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /You already have a character/);
  assert.equal((await state(s, 'zed')).members.filter((m) => m.owner === 'Zed').length, 1);
});

withServer("an officer cannot create a second character on a player's behalf either - the API itself enforces it, not just the UI", async (s) => {
  await s.call('/api/members', 'POST', { name: 'Vaelin', role: 'Tank' }, s.zed);
  const viaOfficer = await s.call('/api/members', 'POST', { name: 'Via officer', role: 'DPS', owner: 'Zed' }, s.officer);
  assert.equal(viaOfficer.status, 409);
  assert.match(viaOfficer.body.error, /Zed already has a character/);
});

withServer('a character waiting for approval also counts as "already has one" - no queuing a second application', async (s) => {
  await s.call('/api/admin/options', 'PUT', { approvals: { newCharacter: true } }, s.officer);
  const first = (await s.call('/api/members', 'POST', { name: 'Pending one', role: 'DPS' }, s.zed)).body;
  assert.equal(first.pendingApproval, true);
  const again = await s.call('/api/members', 'POST', { name: 'Second pending', role: 'Tank' }, s.zed);
  assert.equal(again.status, 409);
});

withServer('deleting the one character frees the player up to make a new one', async (s) => {
  const m = (await s.call('/api/members', 'POST', { name: 'Vaelin', role: 'Tank' }, s.zed)).body;
  await s.call('/api/members/' + m.id, 'DELETE', null, s.zed);
  const second = await s.call('/api/members', 'POST', { name: 'Fresh start', role: 'Healer' }, s.zed);
  assert.equal(second.status, 200);
  assert.equal(second.body.name, 'Fresh start');
});

withServer('the "Add character" option is only blocked by the server - officers can still see and manage every character that already exists', async (s) => {
  const m = (await s.call('/api/members', 'POST', { name: 'Vaelin', role: 'Tank' }, s.zed)).body;
  assert.equal((await s.call('/api/members/' + m.id, 'PUT', { name: 'Vaelin', role: 'Healer' }, s.officer)).status, 200, 'editing the existing one is unaffected');
});

// A realistic pre-existing guild: three players, one of them (Zed) with two characters from before the rule
// existed. The second one has real references scattered around - loot, points, a party, a sign-up - to prove
// the cleanup uses the exact same safe cascade as a normal delete, not a shortcut that leaves orphans behind.
const now = Date.now();
const seed = {
  nextId: 100,
  members: [
    { id: 1, owner: 'Zed', name: 'Old Main', role: 'Tank', rank: 'Member', active: true, gearScore: 2000, level: 50, builds: [], questlogs: [], joinedAt: new Date(now - 10 * 864e5).toISOString() },
    { id: 2, owner: 'Zed', name: 'Alt Healer', role: 'Healer', rank: 'Member', active: true, gearScore: 1800, level: 45, builds: [], questlogs: [], joinedAt: new Date(now - 3 * 864e5).toISOString() },
    { id: 3, owner: 'Other', name: 'Solo Player', role: 'DPS', rank: 'Member', active: true, gearScore: 2100, level: 50, builds: [], questlogs: [], joinedAt: new Date(now - 5 * 864e5).toISOString() },
  ],
  events: [{
    id: 10, title: 'Old siege', type: 'Castle Siege', start: new Date(now - 864e5).toISOString(), createdBy: 'Boss',
    description: '', points: 5, mandatory: true, maxSignups: 0, signupCloseMinutes: 30, pinWindowMinutes: 15, reminders: true,
    rsvps: { 2: 'yes', 3: 'yes' }, attended: [2, 3], parties: [{ name: 'Front', members: [2, 3], leader: 2, builds: {} }],
    pin: null, pinEntries: {}, remindersSent: {}, reminderLog: [],
  }],
  points: [{ id: 20, memberId: 2, delta: 5, reason: 'Siege', at: new Date().toISOString(), by: 'Boss' }],
  duties: [{ id: 21, memberId: 2, text: 'Bring potions', status: 'open', at: new Date().toISOString() }],
  presets: [{ id: 30, name: 'Standard', description: '', parties: [{ name: 'Front', members: [2], leader: 2, builds: {} }], createdBy: 'Boss', at: new Date().toISOString() }],
  loot: [{ id: 40, memberId: 2, item: 'Ancient Sword', type: 'Item', amount: 0, date: new Date().toISOString().slice(0, 10), by: 'Boss', at: new Date().toISOString() }],
};

withServer('the duplicate-character finder shows exactly who has more than one and which would be kept', async (s) => {
  const dupes = (await s.call('/api/admin/duplicate-characters', 'GET', null, s.officer)).body;
  assert.equal(dupes.length, 1, 'only Zed has more than one');
  assert.equal(dupes[0].owner, 'Zed');
  assert.equal(dupes[0].keep.name, 'Old Main', 'the older character (lower id) is the one that would be kept');
  assert.deepEqual(dupes[0].remove.map((m) => m.name), ['Alt Healer']);
  assert.equal((await s.call('/api/admin/duplicate-characters', 'GET', null, s.zed)).status, 403, 'members cannot run this');
}, seed);

withServer('applying the cleanup removes the extra character everywhere it was referenced, exactly like a normal delete would', async (s) => {
  assert.equal((await s.call('/api/admin/enforce-one-character', 'POST', {}, s.zed)).status, 403);
  const r = (await s.call('/api/admin/enforce-one-character', 'POST', {}, s.officer)).body;
  assert.deepEqual(r, { players: 1, removed: 1 });

  const st = await state(s, 'officer');
  assert.deepEqual(st.members.filter((m) => m.owner === 'Zed').map((m) => m.name), ['Old Main'], 'Alt Healer is gone, Old Main remains');
  assert.ok(st.members.some((m) => m.owner === 'Other' && m.name === 'Solo Player'), "Other's character is untouched");

  const ev = st.events.find((e) => e.id === 10);
  assert.equal(ev.rsvps[2], undefined, 'the sign-up by the removed character is gone');
  assert.equal(ev.rsvps[3], 'yes', 'someone else\'s sign-up is untouched');
  assert.deepEqual(ev.attended, [3]);
  assert.deepEqual(ev.parties[0].members, [3], 'removed from the party (without breaking the party itself)');
  assert.equal(ev.parties[0].leader, null, 'was the party leader - the crown is cleared, not left dangling on a deleted character');

  assert.equal(st.points.some((p) => p.memberId === 2), false, 'the points entry for the removed character is gone');
  assert.equal(st.duties.some((d) => d.memberId === 2), false, 'their task is gone too');
  assert.equal(st.loot.some((l) => l.memberId === 2), false, 'and their loot entry');
  assert.deepEqual(st.presets[0].parties[0].members, [], 'removed from the saved preset as well');

  // running it again is a safe no-op
  const again = (await s.call('/api/admin/enforce-one-character', 'POST', {}, s.officer)).body;
  assert.deepEqual(again, { players: 0, removed: 0 });
  assert.equal((await s.call('/api/admin/duplicate-characters', 'GET', null, s.officer)).body.length, 0);

  // and it was written to the audit log
  const a = (await s.call('/api/admin/audit', 'GET', null, s.officer)).body;
  assert.ok(a.entries.some((e) => e.action === 'member.cleanup' && /removed 1/.test(e.description)));
}, seed);
