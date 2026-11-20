// The audit log's cap is pure, deterministic array logic with no I/O of its own (save() is just a callback),
// so it is tested directly against the module rather than through a real HTTP server for 5000+ requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshAudit() {
  const db = { auditLog: [], nextId: 1 };
  let saveCount = 0;
  const ctx = {
    route: () => {}, need: () => {}, clean: (v, max) => String(v ?? '').slice(0, max),
    newId: () => db.nextId++, save: () => { saveCount++; }, isOfficer: () => true,
    get db() { return db; },
  };
  const audit = require('../server-audit.js')(ctx);
  return { db, audit, saves: () => saveCount };
}

test('the audit log caps at 5000 and, once reached, drops the oldest 1000 at once rather than trimming one at a time', () => {
  const { db, audit } = freshAudit();
  for (let i = 0; i < 5001; i++) audit.log({ key: 'p1', name: 'Player' }, 'member.update', { type: 'member', id: i }, 'entry #' + i);
  assert.equal(db.auditLog.length, 4001, '5001 pushed, one batch of 1000 dropped once the cap of 5000 was crossed');
  assert.equal(db.auditLog[0].description, 'entry #1000', 'the oldest 1000 (entries #0-#999) are the ones removed');
  assert.equal(db.auditLog.at(-1).description, 'entry #5000', 'the newest entry is kept');
});

test('the cap keeps working on later cycles, not just the first time it is crossed', () => {
  const { db, audit } = freshAudit();
  for (let i = 0; i < 5001; i++) audit.log(null, 'event.create', {}, 'a' + i);
  for (let i = 0; i < 1999; i++) audit.log(null, 'event.create', {}, 'b' + i);
  assert.equal(db.auditLog.length, 5000, '4001 + 1999 = 6000, minus a second batch of 1000 once 5000 was crossed again');
});

test('nothing is trimmed below the cap', () => {
  const { db, audit } = freshAudit();
  for (let i = 0; i < 4999; i++) audit.log(null, 'event.create', {}, 'x' + i);
  assert.equal(db.auditLog.length, 4999, 'still under 5000, nothing dropped yet');
});
