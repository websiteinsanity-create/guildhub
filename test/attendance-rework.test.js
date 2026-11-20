// Regression tests for the attendance-tracking rework (the single shared setAttended() writer, the real
// ev.attendanceTracked field replacing the old rolled()-style heuristic, the attendance-status route's
// per-character fix, and the per-event pinOffsetMinutes/voiceTrackStartOffsetMinutes timing overrides).
// Same lightweight fixture as api.test.js - these don't need a live Discord bot or Shotcaller.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer(seedDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-test-attrework-'));
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
    officer: await login('Boss', 'o1'), member: await login('Zed', 'm1'),
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const withServer = (name, fn, seed) => test(name, async () => { const s = await startServer(seed); try { await fn(s); } finally { await s.stop(); } });
const inMinutes = (n) => new Date(Date.now() + n * 60000).toISOString();
const evOf = async (s, id, who) => (await s.call('/api/state', 'GET', null, who)).body.events.find((e) => e.id === id);

withServer('a zero-attendee hand roll-call reads as tracked, not untracked', async (s) => {
  const ev = (await s.call('/api/events', 'POST', { title: 'Empty raid', type: 'Archboss', start: inMinutes(-60) }, s.officer)).body;
  assert.equal(ev.attendanceTracked, false, 'nothing recorded yet');
  const r = await s.call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [] }, s.officer);
  assert.equal(r.status, 200);
  const after = await evOf(s, ev.id, s.officer);
  assert.deepEqual(after.attended, []);
  assert.equal(after.attendanceTracked, true, 'an officer DID take roll - it just came up empty, which is not the same as never taken');
});

withServer('undo restores attendanceTracked to false, not just an empty attended list', async (s) => {
  const m = (await s.call('/api/members', 'POST', { name: 'Solo', role: 'DPS' }, s.member)).body;
  const ev = (await s.call('/api/events', 'POST', { title: 'Raid', type: 'Archboss', start: inMinutes(-60) }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [m.id] }, s.officer);
  assert.equal((await evOf(s, ev.id, s.officer)).attendanceTracked, true);
  const undo = await s.call(`/api/events/${ev.id}/attendance/undo`, 'POST', {}, s.officer);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const after = await evOf(s, ev.id, s.officer);
  assert.deepEqual(after.attended, []);
  assert.equal(after.attendanceTracked, false, 'back to genuinely never-tracked, undo is a real reset');
});

withServer('a PIN entry marks attendanceTracked without claiming autoAttended', async (s) => {
  const m = (await s.call('/api/members', 'POST', { name: 'Pinner', role: 'DPS' }, s.member)).body;
  const ev = (await s.call('/api/events', 'POST', { title: 'PIN night', type: 'Wargames', start: inMinutes(5), pinEnabled: true }, s.officer)).body;
  const withPin = (await s.call(`/api/events/${ev.id}/pin/send`, 'POST', { mode: 'new' }, s.officer)).body;
  const code = withPin.pin.code;
  const r = await s.call(`/api/events/${ev.id}/pin`, 'POST', { memberId: m.id, pin: code }, s.member);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await evOf(s, ev.id, s.officer);
  assert.ok(after.attended.includes(m.id));
  assert.equal(after.attendanceTracked, true);
  assert.equal(after.autoAttended, false, 'a single PIN entry must never block the no-PIN fallback from layering on top for people never sighted');
});

withServer("attendance-status: correcting one owner's RSVP status never reassigns another already-credited character's attendance", async (s) => {
  // The one real-world case where an owner can have more than one ACTIVE character at once is a mercenary
  // (their own, full signup flow is covered separately in mercenaries.test.js) - the one-active-character-per-
  // owner rule is enforced in the route handler, not the data itself, so exporting/re-importing is the
  // lightweight way to get two active characters under one owner here, to exercise the general fix in
  // attendance-status (which only cares about "more than one active character for this owner", not
  // specifically about the mercenary flag).
  const main = (await s.call('/api/members', 'POST', { name: 'MainChar', role: 'DPS', owner: 'TwoChar' }, s.officer)).body;
  const ev = (await s.call('/api/events', 'POST', { title: 'Siege', type: 'Castle Siege', start: inMinutes(-120) }, s.officer)).body;
  const exp = (await s.call('/api/export', 'GET', null, s.officer)).body;
  const altId = Math.max(...exp.members.map((m) => m.id)) + 1;
  exp.members.push({ ...exp.members.find((m) => m.id === main.id), id: altId, name: 'AltChar' });
  await s.call('/api/import', 'POST', exp, s.officer);
  // Voice/PIN tracking (simulated here directly through the roster-save writer) credited the ALT character
  // specifically, not the main one.
  await s.call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [altId] }, s.officer);
  assert.ok((await evOf(s, ev.id, s.officer)).attended.includes(altId));
  // An officer corrects this owner's overall result through the Attendance page's event-by-event editor.
  const r = await s.call(`/api/events/${ev.id}/attendance-status`, 'POST', { owner: 'TwoChar', status: 'attended' }, s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await evOf(s, ev.id, s.officer);
  assert.ok(after.attended.includes(altId), "the alt character's real credit survives the correction, unreassigned");
  assert.ok(!after.attended.includes(main.id), 'the main character was never actually seen - it does not get credit it was not given');
});

withServer('attendance-status: marking "not attending" still clears every one of the owner\'s active characters', async (s) => {
  const m = (await s.call('/api/members', 'POST', { name: 'Solo', role: 'DPS', owner: 'Solo1' }, s.officer)).body;
  const ev = (await s.call('/api/events', 'POST', { title: 'Siege', type: 'Castle Siege', start: inMinutes(-120) }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/attendance`, 'POST', { memberIds: [m.id] }, s.officer);
  const r = await s.call(`/api/events/${ev.id}/attendance-status`, 'POST', { owner: 'Solo1', status: 'noshow' }, s.officer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!(await evOf(s, ev.id, s.officer)).attended.includes(m.id));
});

withServer('per-event pinOffsetMinutes and voiceTrackStartOffsetMinutes are independent of the guild default once set', async (s) => {
  const ev = (await s.call('/api/events', 'POST', { title: 'Timed', type: 'Wargames', start: inMinutes(60) }, s.officer)).body;
  assert.equal(ev.pinOffsetMinutes, 0, 'inherits the guild default (0) at creation');
  await s.call('/api/settings', 'PUT', { pinOffsetMinutes: 30, voiceTrackStartOffsetMinutes: -15 }, s.officer);
  const unchanged = await evOf(s, ev.id, s.officer);
  assert.equal(unchanged.pinOffsetMinutes, 0, "an already-created event's own copy does not follow a later guild-default change");
  const edited = await s.call(`/api/events/${ev.id}`, 'PUT', { title: ev.title, type: ev.type, start: ev.start, pinOffsetMinutes: 45, voiceTrackStartOffsetMinutes: 5 }, s.officer);
  assert.equal(edited.body.pinOffsetMinutes, 45, "but it IS independently editable, on its own");
  assert.equal(edited.body.voiceTrackStartOffsetMinutes, 5);
  const fresh = (await s.call('/api/events', 'POST', { title: 'Timed2', type: 'Wargames', start: inMinutes(60) }, s.officer)).body;
  assert.equal(fresh.pinOffsetMinutes, 30, 'a brand new event still picks up whatever the guild default is NOW');
});

withServer(
  'a recurring series saved before per-event timing overrides existed backfills them on load, instead of handing materialize() an undefined that turns into a crash the moment anyone reads the generated event',
  async (s) => {
    const r = await s.call('/api/state', 'GET', null, s.officer);
    assert.equal(r.status, 200, 'the server did not crash just loading state with a legacy series present');
    const se = r.body.series.find((x) => x.id === 1);
    assert.ok(se, 'the legacy series itself survived migration');
    assert.equal(se.pinOffsetMinutes, 7, "backfilled from the guild default, not left undefined");
    assert.equal(se.voiceTrackStartOffsetMinutes, -3, "backfilled from the guild default, not left undefined");
    const ev = r.body.events.find((e) => e.seriesId === 1);
    assert.ok(ev, 'materialize() generated at least one occurrence from the legacy series');
    assert.equal(ev.pinOffsetMinutes, 7, "the generated event's own copy, not undefined/NaN");
    assert.equal(ev.voiceTrackStartOffsetMinutes, -3);
    assert.ok(!isNaN(Date.parse(ev.pinInfo.scheduledAt)), 'pinInfo computed a real date instead of throwing');
  },
  {
    nextId: 50,
    settings: { pinOffsetMinutes: 7, voiceTrackStartOffsetMinutes: -3 },
    series: [{
      id: 1, createdBy: 'Boss', at: new Date().toISOString(), skipped: [],
      weekdays: [0, 1, 2, 3, 4, 5, 6], intervalWeeks: 1, time: '12:00', tz: 'UTC', startDate: '2020-01-01', endDate: '',
      title: 'Legacy Weekly Raid', type: 'Archboss', description: '', points: 10, mandatory: true, pinEnabled: true,
      maxSignups: 0, signupCloseMinutes: 30, pinWindowMinutes: 15, reminders: true, shotcallerAutoStart: false,
      // Deliberately no pinOffsetMinutes/voiceTrackStartOffsetMinutes - this is a series saved before that
      // per-event-override feature existed, which is exactly the shape that used to crash every read.
    }],
  },
);

withServer('GET /api/attendance-stats: an officer sees every player, a member sees only themselves', async (s) => {
  const m1 = (await s.call('/api/members', 'POST', { name: 'Ann', role: 'DPS', owner: 'Owner1' }, s.officer)).body;
  const m2 = (await s.call('/api/members', 'POST', { name: 'Bob', role: 'DPS' }, s.member)).body;
  const asOfficer = await s.call('/api/attendance-stats', 'GET', null, s.officer);
  assert.equal(asOfficer.status, 200);
  const owners = asOfficer.body.map((r) => r.owner);
  assert.ok(owners.includes('Owner1') && owners.length >= 2, 'officers see every owner');
  const asMember = await s.call('/api/attendance-stats', 'GET', null, s.member);
  assert.equal(asMember.status, 200);
  assert.ok(asMember.body.every((r) => r.owner !== 'Owner1'), 'a plain member only ever gets their own row');
  void m1; void m2;
});
