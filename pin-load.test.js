// A real production report: "servers are crashing once all 70 players try to type that [the attendance PIN]
// in." Traced to syncAttendancePoints() doing a full db.points.filter() PLUS a full db.points.some() PER
// ATTENDED MEMBER on every single PIN submission - fine for a brand new guild with an empty ledger, but with
// months of history (every event, every attendee, forever) that ledger only grows, and ~70 players all typing
// the PIN in within the same minute or two turned "a quick lookup" into O(attended x points) synchronous work,
// repeated once per player, on a single-threaded server - enough to visibly stall it for everyone, not just
// whoever triggered it, and (with nothing catching an unhandled rejection either - see server.js) enough in the
// worst case to take the whole thing down. This test seeds a large pre-existing points ledger (the part a
// small manual test would never have) and then fires a real burst of concurrent PIN entries, the same shape as
// the report, and checks it holds up: every entry succeeds, attendance and points come out exactly right with
// no duplicates or loss, and the whole burst finishes well within the test's own timeout rather than hanging.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLAYERS = 70;

async function startServer(seedDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-pinload-'));
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
    call,
    officer: await login('Boss', 'o1'),
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// A big, realistic-looking points ledger from months of unrelated past events - thousands of entries that
// have nothing to do with tonight's event, which is exactly the part a small hand-run test would never have
// and exactly what made the old O(attended x points) scan per PIN entry actually expensive in practice.
function seedLedger(pastEvents, perEvent) {
  const points = [];
  let id = 1;
  for (let e = 0; e < pastEvents; e++) {
    for (let m = 0; m < perEvent; m++) {
      points.push({ id: id++, memberId: 100000 + m, delta: 10, reason: 'Attended: Old Event', eventId: 90000 + e, at: new Date().toISOString(), by: 'system' });
    }
  }
  return { nextId: id + 1, points, settings: { pointsEnabled: true } };
}

test(`a burst of ${PLAYERS} concurrent PIN entries succeeds and stays correct against a large existing points ledger`, { timeout: 30000 }, async () => {
  // 200 past events x 50 points each = 10,000 pre-existing ledger entries, standing in for a guild that has
  // been running Guild Hall for a long time - the old per-member .some() scan over this array, 70 times in a
  // burst, is exactly the shape of the reported slowdown/crash.
  const s = await startServer(seedLedger(200, 50));
  try {
    await s.call('/api/settings', 'PUT', { pointsEnabled: true }, s.officer);
    const members = [];
    for (let i = 0; i < PLAYERS; i++) {
      members.push((await s.call('/api/members', 'POST', { name: `Player${i}`, role: 'DPS', owner: `player${i}` }, s.officer)).body);
    }
    const ev = (await s.call('/api/events', 'POST', { title: 'Mass PIN night', type: 'Wargames', start: new Date(Date.now() - 60000).toISOString(), pinWindowMinutes: 30, pinEnabled: true, points: 10 }, s.officer)).body;
    await s.call('/api/settings', 'PUT', { pinOffsetMinutes: -60 }, s.officer);
    await s.call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'new' }, s.officer);
    const withPin = (await s.call('/api/state', 'GET', null, s.officer)).body.events.find((e) => e.id === ev.id);
    const code = withPin.pin.code;

    // Each player logs in as themselves (their own token/session, like 70 real browsers) and submits their own
    // character's PIN at the same moment - the real-world shape of the report, not one officer doing it 70
    // times in a row.
    const logins = await Promise.all(members.map((m) => s.call('/api/login', 'POST', { name: m.owner, passcode: 'm1' })));
    const tokens = logins.map((l) => l.body.token);

    const t0 = Date.now();
    const results = await Promise.all(members.map((m, i) => s.call(`/api/events/${ev.id}/pin`, 'POST', { memberId: m.id, pin: code }, tokens[i])));
    const elapsedMs = Date.now() - t0;

    assert.ok(results.every((r) => r.status === 200), 'every one of the 70 concurrent PIN entries succeeds: ' + JSON.stringify(results.filter((r) => r.status !== 200).slice(0, 3)));
    // Generous but real: the old O(attended x 10,000) scan, repeated per player, would make this take vastly
    // longer than a healthy server bottlenecked only by real work should ever need for 70 small requests.
    assert.ok(elapsedMs < 15000, `the burst should finish well under 15s on a healthy server, took ${elapsedMs}ms`);

    const after = (await s.call('/api/state', 'GET', null, s.officer)).body;
    const finalEv = after.events.find((e) => e.id === ev.id);
    assert.equal(finalEv.attended.length, PLAYERS, 'every player is recorded as attended, none lost to a race');
    assert.equal(new Set(finalEv.attended).size, PLAYERS, 'no duplicates in attended');
    const myPoints = after.points.filter((p) => p.eventId === ev.id);
    assert.equal(myPoints.length, PLAYERS, 'exactly one point entry per attendee - no duplicates, none dropped');
    assert.equal(new Set(myPoints.map((p) => p.memberId)).size, PLAYERS);
    assert.equal(after.points.length, 200 * 50 + PLAYERS, 'the pre-existing ledger is untouched, only this event\'s entries were added');
  } finally {
    await s.stop();
  }
});
