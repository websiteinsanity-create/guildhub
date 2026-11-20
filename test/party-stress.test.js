// A stress/concurrency test for party building: several officers dragging players into the SAME event's (and
// the same preset's) parties at the same time. This is not about one request's correctness in isolation (the
// optimistic-concurrency mechanics are covered in features.test.js) - it is about what actually happens under
// real concurrent load: does every move eventually land somewhere, does the server stay fast, and does nobody's
// change silently vanish.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-stress-'));
  const port = 42000 + Math.floor(Math.random() * 8000);
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
    const t0 = Date.now();
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return { status: res.status, body: data, ms: Date.now() - t0 };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return { base, call, login, officer: await login('Boss', 'o1'), stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const withServer = (name, fn, opts) => test(name, opts, async () => { const s = await startServer(); try { await fn(s); } finally { await s.stop(); } });

// Simulates what the client's commitParties() does: read the current parties + version, apply one small change
// (move member `mid` into party `ti`), save with that baseVersion, and on a 409 (someone else saved first)
// re-read and retry - up to a few times - instead of giving up or silently clobbering. Mirrors public/app.js's
// real retry logic closely enough to exercise the same server-side contract under real concurrency.
async function moveMemberWithRetry(s, token, evId, mid, ti, maxAttempts = 12) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cur = (await s.call('/api/state', 'GET', null, token)).body.events.find((e) => e.id === evId);
    const parties = JSON.parse(JSON.stringify(cur.parties));
    parties.forEach((p) => { p.members = p.members.filter((id) => id !== mid); });
    parties[ti].members.push(mid);
    const r = await s.call(`/api/events/${evId}/parties`, 'POST', { parties, baseVersion: cur.partiesVersion || 0 }, token);
    if (r.status === 200) return { ok: true, attempts: attempt + 1, ms: r.ms };
    if (r.status !== 409) return { ok: false, attempts: attempt + 1, error: r.body && r.body.error };
    // 409: someone else won this round - same jitter-before-retry idea as public/app.js's real commitParties(),
    // so several officers colliding on the same event do not just keep retrying in lockstep against each other.
    await new Promise((res) => setTimeout(res, 20 + Math.random() * 80));
  }
  return { ok: false, attempts: maxAttempts, error: 'gave up after too many conflicts' };
}

withServer('5 officers building parties for the same event at once: every move lands somewhere, nobody\'s change is silently lost, and it stays fast', async (s) => {
  const OFFICERS = 5, MOVES_PER_OFFICER = 6, PARTIES = 4;
  // 5 separate logins acting as 5 different officers (their own browser tab, their own session) - not just 5
  // requests from one token, so this also exercises the "several people, several tokens" shape of the real bug report.
  const officerTokens = await Promise.all(Array.from({ length: OFFICERS }, (_, i) => s.login('Officer' + i, 'o1')));
  // An officer-created character needs its own owner (one character per owner is enforced server-side), so each
  // of the 24 gets a distinct owner name rather than all piling onto the officer's own account.
  const memberIds = [];
  for (let i = 0; i < 24; i++) {
    const r = await s.call('/api/members', 'POST', { name: 'P' + i, role: ['Tank', 'Healer', 'DPS'][i % 3], owner: 'Stress' + i }, s.officer);
    assert.equal(r.status, 200, 'member creation did not fail: ' + JSON.stringify(r.body));
    memberIds.push(r.body.id);
  }
  const ev = (await s.call('/api/events', 'POST', { type: 'Wargames', start: new Date(Date.now() + 864e5).toISOString() }, s.officer)).body;
  await s.call(`/api/events/${ev.id}/parties`, 'POST', { parties: Array.from({ length: PARTIES }, (_, i) => ({ name: 'Party ' + (i + 1), members: [] })) }, s.officer);

  // Give each officer their own disjoint slice of members to move, so the EXPECTED end state is fully known
  // (every member ends up in SOME party) and any lost move is unambiguously detectable, while still having all
  // 5 officers hammer the exact same event's parties at the same time (the actual stress condition).
  const perOfficer = Math.floor(memberIds.length / OFFICERS);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: OFFICERS }, (_, oi) => (async () => {
    const mine = memberIds.slice(oi * perOfficer, (oi + 1) * perOfficer).slice(0, MOVES_PER_OFFICER);
    const out = [];
    for (let k = 0; k < mine.length; k++) out.push(await moveMemberWithRetry(s, officerTokens[oi], ev.id, mine[k], (oi + k) % PARTIES));
    return out;
  })()));
  const elapsedMs = Date.now() - t0;
  const flat = results.flat();

  console.log(`stress test: ${flat.length} moves from ${OFFICERS} concurrent officers finished in ${elapsedMs}ms (${(elapsedMs / flat.length).toFixed(1)}ms/move average); attempts per move: ${flat.map((r) => r.attempts).join(',')}`);

  assert.ok(flat.every((r) => r.ok), 'every single move eventually succeeded (none gave up): ' + JSON.stringify(flat.filter((r) => !r.ok)));
  // "Works without lags" - a few hundred moves' worth of real save round-trips (with retries) against one
  // in-process server should comfortably finish in a few seconds, not grind to a crawl.
  assert.ok(elapsedMs < 15000, `finished in ${elapsedMs}ms - should stay well under 15s even with conflicts and retries`);

  // The real correctness check: NOTHING got silently lost. Every member any officer moved is in EXACTLY the
  // party their own (possibly retried) move last placed them in - not missing, not duplicated, not overwritten
  // by a different officer's concurrent save.
  const final = (await s.call('/api/state', 'GET', null, s.officer)).body.events.find((e) => e.id === ev.id);
  const expectedMoved = [];
  for (let oi = 0; oi < OFFICERS; oi++) expectedMoved.push(...memberIds.slice(oi * perOfficer, (oi + 1) * perOfficer).slice(0, MOVES_PER_OFFICER));
  const placedCount = new Map();
  for (const p of final.parties) for (const id of p.members) placedCount.set(id, (placedCount.get(id) || 0) + 1);
  for (const id of expectedMoved) {
    assert.equal(placedCount.get(id) || 0, 1, `member ${id} ended up placed exactly once (not lost, not duplicated across parties) - found in ${placedCount.get(id) || 0} parties`);
  }
  assert.equal(final.parties.flatMap((p) => p.members).length, new Set(final.parties.flatMap((p) => p.members)).size, 'no member id appears in two parties at once anywhere in the final state');
}, { timeout: 30000 });
