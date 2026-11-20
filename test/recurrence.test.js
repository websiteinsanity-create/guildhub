// Pure date tests for recurring events: daylight saving time must not shift "Monday 21:00 Berlin time".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zonedToUtcMs, occurrences, matchesRule, validTimeZone } = require('../recurrence');

const iso = (d, t, tz) => new Date(zonedToUtcMs(d, t, tz)).toISOString();

test('21:00 in Berlin is 19:00 UTC in summer (CEST) and 20:00 UTC in winter (CET)', () => {
  assert.equal(iso('2026-07-06', '21:00', 'Europe/Berlin'), '2026-07-06T19:00:00.000Z');
  assert.equal(iso('2026-12-07', '21:00', 'Europe/Berlin'), '2026-12-07T20:00:00.000Z');
  assert.equal(iso('2026-12-07', '20:00', 'America/New_York'), '2026-12-08T01:00:00.000Z');
});

test('the same weekly slot stays at 21:00 local time across the switch back to winter time', () => {
  const se = { weekdays: [1], intervalWeeks: 1, time: '21:00', tz: 'Europe/Berlin', startDate: '2026-09-01', endDate: '' };
  const list = occurrences(se, Date.parse('2026-10-15T00:00:00Z'), Date.parse('2026-11-05T00:00:00Z'));
  assert.deepEqual(list.map((o) => o.date), ['2026-10-19', '2026-10-26', '2026-11-02']);
  assert.deepEqual(list.map((o) => new Date(o.startMs).toISOString().slice(11, 16)), ['19:00', '20:00', '20:00'], 'clocks went back on 25 October');
  for (const o of list) assert.equal(new Date(o.startMs).toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }), '21:00');
});

test('several weekdays, every second week, and an end date', () => {
  const base = { time: '20:00', tz: 'UTC', startDate: '2026-09-07', endDate: '' };   // 7 Sep 2026 is a Monday
  const twoDays = occurrences({ ...base, weekdays: [1, 4], intervalWeeks: 1 }, Date.parse('2026-09-07T00:00:00Z'), Date.parse('2026-09-20T00:00:00Z'));
  assert.deepEqual(twoDays.map((o) => o.date), ['2026-09-07', '2026-09-10', '2026-09-14', '2026-09-17']);
  const biweekly = occurrences({ ...base, weekdays: [1], intervalWeeks: 2 }, Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-10-15T00:00:00Z'));
  assert.deepEqual(biweekly.map((o) => o.date), ['2026-09-07', '2026-09-21', '2026-10-05']);
  const ended = occurrences({ ...base, weekdays: [1], intervalWeeks: 1, endDate: '2026-09-14' }, Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-10-15T00:00:00Z'));
  assert.deepEqual(ended.map((o) => o.date), ['2026-09-07', '2026-09-14']);
  assert.equal(matchesRule({ ...base, weekdays: [1], intervalWeeks: 1 }, '2026-09-06'), false, 'never before the first date');
});

test('time zone names are checked', () => {
  assert.equal(validTimeZone('Europe/Berlin'), true);
  assert.equal(validTimeZone('Mars/Base'), false);
  assert.equal(validTimeZone(''), false);
});
