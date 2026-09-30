// Recurring events: turns "every Monday 21:00 in Europe/Berlin" into real start times, including daylight saving time
// (21:00 in Berlin is 19:00 UTC in summer and 20:00 UTC in winter). No dependencies, uses the built-in Intl.

const DAY = 864e5;

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; }
}

// Minutes the zone is ahead of UTC at a given moment (Berlin: +120 in summer, +60 in winter).
function tzOffsetMinutes(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// A wall-clock time in a zone ("2026-10-26", "21:00", "Europe/Berlin") as a UTC timestamp.
function zonedToUtcMs(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number), [hh, mm] = timeStr.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let utc = wall - tzOffsetMinutes(wall, tz) * 60000;      // first guess
  utc = wall - tzOffsetMinutes(utc, tz) * 60000;           // corrected with the offset that really applies at that moment
  return utc;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekday = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };   // 0 = Sunday
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((v, i) => (i === 1 ? v - 1 : +v))) - Date.UTC(...a.split('-').map((v, i) => (i === 1 ? v - 1 : +v)))) / DAY);
const mondayOf = (dateStr) => addDays(dateStr, -((weekday(dateStr) + 6) % 7));

// Does this calendar day belong to the series? (weekday, "every N weeks", first and last day)
function matchesRule(se, date) {
  if (date < se.startDate || (se.endDate && date > se.endDate)) return false;
  if (!se.weekdays.includes(weekday(date))) return false;
  return Math.floor(daysBetween(mondayOf(se.startDate), date) / 7) % (se.intervalWeeks || 1) === 0;
}

// Every start time of the series between two moments.
function occurrences(se, fromMs, toMs) {
  const out = [];
  const last = isoDate(toMs + DAY);
  for (let d = isoDate(fromMs - DAY); d <= last; d = addDays(d, 1)) {
    if (!matchesRule(se, d)) continue;
    const startMs = zonedToUtcMs(d, se.time, se.tz);
    if (startMs >= fromMs && startMs <= toMs) out.push({ date: d, startMs });
  }
  return out;
}

module.exports = { validTimeZone, tzOffsetMinutes, zonedToUtcMs, matchesRule, occurrences, isoDate, addDays, weekday };
