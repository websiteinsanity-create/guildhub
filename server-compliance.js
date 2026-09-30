// Attendance rules for Guild Hall:
//   - leave of absence (a player who is away is not judged for the events in that time)
//   - looking at every player's attendance, no-shows and unanswered events
//   - asking a player for a reason (a pop-up that the leadership has to approve)
//   - automatic warnings that expire, and disqualification from loot while a player has too many
//   - the per-event chart of who is coming (with a per-role split)

const { tzOffsetMinutes, isoDate } = require('./recurrence');

module.exports = function install(ctx) {
  const { route, need, clean, num, newId, save, config, discord, isOfficer, findMember, hooks, tickHooks, appUrl } = ctx;
  const db = () => ctx.db;
  const now = () => new Date().toISOString();
  const int = (v) => Math.round(Number(v));
  const yes = (v) => v === true || v === 'true';
  const LEAD = config.leadershipRanks || ['Guild Master', 'Officer'];
  const TZ = config.defaultTimezone || 'UTC';
  const notify = (owner, text) => { discord.sendDM(owner, text).catch(() => {}); };
  const nameOf = (owner) => (db().users[owner] && db().users[owner].name) || owner;
  const cfg = () => db().settings.compliance;

  // ---------------------------------------------------------------- people and dates
  const zoneDate = (ms) => isoDate(ms + tzOffsetMinutes(ms, TZ) * 60000);           // calendar day in the guild's own time zone
  function players() {                                                              // owner -> their active characters (lowest id first)
    const map = new Map();
    for (const m of db().members.filter((x) => x.active).sort((a, b) => a.id - b.id)) { if (!map.has(m.owner)) map.set(m.owner, []); map.get(m.owner).push(m); }
    return map;
  }
  const isLeader = (owner, chars) => (db().users[owner] && db().users[owner].role === 'officer') || (chars || []).some((c) => LEAD.includes(c.rank));   // the leadership is not judged by itself
  const isOnLeave = (owner, ms) => { const d = zoneDate(ms); return db().leaves.some((l) => l.ownerKey === owner && l.status === 'approved' && l.from <= d && d <= l.to); };
  hooks.skipReminder.push((owner, ev) => isOnLeave(owner, Date.parse(ev.start)));

  // ---------------------------------------------------------------- what every player did
  //   came     one of their characters attended
  //   noshow   said Going with a character, but none of them came
  //   noreply  never answered Going or Can't with any character
  function playerStats(owner, chars, t = Date.now()) {
    const c = cfg(), from = t - c.windowDays * 864e5;
    const ids = chars.map((x) => x.id);
    const events = db().events.filter((e) => Date.parse(e.start) < t && Date.parse(e.start) >= from && e.attended.length > 0 && (!c.mandatoryOnly || e.mandatory));
    const list = [];
    let counted = 0, came = 0, noshow = 0, noreply = 0;
    for (const e of events) {
      if (isOnLeave(owner, Date.parse(e.start))) { list.push({ ev: e, status: 'leave', replied: true }); continue; }
      counted++;
      const answers = ids.map((id) => e.rsvps[id]), going = answers.includes('yes'), no = answers.includes('no'), attended = ids.some((id) => e.attended.includes(id));
      const replied = going || no;
      if (!replied) noreply++;
      let status;
      if (attended) { status = 'attended'; came++; } else if (going) { status = 'noshow'; noshow++; } else if (no) status = 'declined'; else status = 'noreply';
      list.push({ ev: e, status, replied });
    }
    return { counted, came, noshow, noreply, pct: counted ? Math.floor(100 * came / counted) : null, list };
  }

  function triggersFor(s) {
    const c = cfg(), out = [];
    if (!s.counted) return out;
    if (c.noShowLimit > 0 && s.noshow >= c.noShowLimit) out.push({ kind: 'noshow', value: s.noshow, limit: c.noShowLimit });
    if (c.noReplyLimit > 0 && s.noreply >= c.noReplyLimit) out.push({ kind: 'noreply', value: s.noreply, limit: c.noReplyLimit });
    if (c.minAttendance > 0 && s.counted >= c.minEvents && s.pct < c.minAttendance) out.push({ kind: 'attendance', value: s.pct, limit: c.minAttendance });
    return out;
  }
  const lastMiss = (s) => s.list.filter((x) => x.status !== 'attended' && x.status !== 'leave').map((x) => x.ev.start).sort().pop() || '';

  // The pop-up: asked for a reason while they are over a limit and have not explained since their latest missed event.
  function alertFor(owner) {
    const D = db(), c = cfg(), chars = players().get(owner);
    if (!c.enabled || !chars || isLeader(owner, chars)) return null;
    const s = playerStats(owner, chars), triggers = triggersFor(s);
    if (!triggers.length) return null;
    const miss = lastMiss(s);
    // An explanation covers everything up to the latest missed event it was written about. A newer missed event asks again.
    const mine = D.explanations.filter((x) => x.ownerKey === owner && (x.upTo || '') >= miss);
    if (mine.some((x) => x.status === 'pending' || x.status === 'approved')) return null;
    const rejected = mine.filter((x) => x.status === 'rejected').sort((a, b) => b.at.localeCompare(a.at))[0];
    return { triggers, windowDays: c.windowDays, upTo: miss, rejected: rejected ? { note: rejected.note || '', at: rejected.decidedAt } : null };
  }

  // ---------------------------------------------------------------- warnings
  const active = (owner) => db().warnings.filter((w) => w.ownerKey === owner && w.status === 'active');
  function addWarning({ owner, kind, reason, auto, by }) {
    const c = cfg(), w = {
      id: newId(), ownerKey: owner, name: nameOf(owner), kind, reason, auto: !!auto, by: by || 'system', at: now(), status: 'active',
      expiresAt: c.expiryDays > 0 ? new Date(Date.now() + c.expiryDays * 864e5).toISOString() : null,
    };
    db().warnings.push(w);
    const n = active(owner).length;
    notify(owner, `⚠️ You received a warning: ${reason}\nActive warnings: ${n}${c.disqualifyAt > 0 ? ` (at ${c.disqualifyAt} you are disqualified from loot)` : ''}.\n${appUrl()}/#/warnings`);
    return w;
  }

  // Runs every few seconds: ends warnings that have run out, applies the "quiet period" rule, hands out new warnings.
  function runChecks() {
    const D = db(), c = cfg(), t = Date.now();
    let expired = 0, issued = 0;
    for (const w of D.warnings) if (w.status === 'active' && w.expiresAt && Date.parse(w.expiresAt) <= t) { w.status = 'expired'; w.endedAt = now(); w.endedBy = 'timer'; expired++; }
    if (c.quietDays > 0) {
      for (const owner of new Set(D.warnings.filter((w) => w.status === 'active').map((w) => w.ownerKey))) {
        const mine = D.warnings.filter((w) => w.ownerKey === owner);
        const last = Math.max(...mine.map((w) => Date.parse(w.at)), ...mine.filter((w) => w.endedBy === 'quiet').map((w) => Date.parse(w.endedAt)));
        if (t - last < c.quietDays * 864e5) continue;
        const act = mine.filter((w) => w.status === 'active').sort((a, b) => a.at.localeCompare(b.at));
        for (const w of act.slice(0, c.quietRemove > 0 ? c.quietRemove : act.length)) { w.status = 'expired'; w.endedAt = now(); w.endedBy = 'quiet'; expired++; }
      }
    }
    if (c.enabled) {
      for (const [owner, chars] of players()) {
        if (isLeader(owner, chars)) continue;
        const s = playerStats(owner, chars, t);
        for (const [kind, limit, label, offence] of [
          ['noshow', c.noShowLimit, 'no-shows', (x) => x.status === 'noshow'],
          ['noreply', c.noReplyLimit, 'events without an answer', (x) => !x.replied && x.status !== 'leave'],
        ]) {
          if (!limit || s[kind] < limit) continue;
          const lastUpTo = D.warnings.filter((w) => w.ownerKey === owner && w.kind === kind && w.auto).map((w) => w.upTo || w.at).sort().pop() || '';
          const fresh = s.list.filter((x) => offence(x) && x.ev.start > lastUpTo);      // needs a newer offence than the ones the last warning was about
          if (!fresh.length) continue;
          const w = addWarning({ owner, kind, auto: true, reason: `${s[kind]} ${label} in the last ${c.windowDays} days (limit ${limit})` });
          w.upTo = s.list.filter(offence).map((x) => x.ev.start).sort().pop();
          issued++;
        }
      }
    }
    if (expired || issued) save();
    return { expired, issued };
  }
  tickHooks.push(async () => { runChecks(); });

  // ---------------------------------------------------------------- the chart on every event
  function eventChart(ev, P) {
    const zero = () => ({ yes: 0, no: 0, none: 0, leave: 0 }), roles = {}, total = zero(), start = Date.parse(ev.start);
    for (const r of config.roles) roles[r] = zero();
    const bump = (role, k) => { (roles[role] = roles[role] || zero())[k]++; total[k]++; };
    for (const [owner, chars] of P) {
      const answered = chars.filter((c) => ev.rsvps[c.id] === 'yes' || ev.rsvps[c.id] === 'no');
      if (answered.length) { for (const c of answered) bump(c.role, ev.rsvps[c.id]); continue; }
      bump(chars[0].role, isOnLeave(owner, start) ? 'leave' : 'none');                    // somebody who did not answer counts once, under their main character
    }
    return { roles, total };
  }

  // ---------------------------------------------------------------- leave of absence
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00Z'));
  route('POST', '/api/leaves', ({ body, user }) => {
    const D = db(), off = isOfficer(user);
    const owner = off && clean(body.ownerKey, 40) ? clean(body.ownerKey, 40) : user.key;
    const from = String(body.from || ''), to = String(body.to || '');
    need(isDate(from) && isDate(to), 400, 'Pick the first and the last day.');
    need(to >= from, 400, 'The last day cannot be before the first day.');
    need((Date.parse(to) - Date.parse(from)) / 864e5 <= 365, 400, 'A leave can be up to a year.');
    need(off || from >= zoneDate(Date.now()), 400, 'A leave has to start today or later. Ask the leadership for earlier days.');
    need(!D.leaves.some((l) => l.ownerKey === owner && l.status !== 'rejected' && !(to < l.from || from > l.to)), 409, 'There is already a leave in that time.');
    const l = { id: newId(), ownerKey: owner, name: owner === user.key ? user.name : nameOf(owner), from, to, reason: clean(body.reason, 200),
      status: off || !cfg().loaNeedsApproval ? 'approved' : 'pending', by: user.name, at: now() };
    if (l.status === 'approved') { l.decidedBy = off ? user.name : 'automatic'; l.decidedAt = now(); }
    D.leaves.push(l);
    save();
    return l;
  });
  route('PUT', '/api/leaves/:id', ({ body, user, params }) => {
    const D = db(), l = D.leaves.find((x) => x.id === Number(params.id));
    need(l, 404, 'Leave not found.');
    if (body.from !== undefined || body.to !== undefined) {
      const from = String(body.from ?? l.from), to = String(body.to ?? l.to);
      need(isDate(from) && isDate(to) && to >= from, 400, 'Pick valid days.');
      l.from = from; l.to = to;
    }
    if (body.status !== undefined) {
      need(['approved', 'rejected'].includes(body.status), 400, 'Approve or reject.');
      l.status = body.status; l.note = clean(body.note, 200); l.decidedBy = user.name; l.decidedAt = now();
      notify(l.ownerKey, `Your leave of absence (${l.from} to ${l.to}) was ${l.status === 'approved' ? '✅ approved' : '❌ not approved'}.${l.note ? `\nNote: ${l.note}` : ''}\n${appUrl()}/#/leave`);
    }
    save();
    return l;
  }, { officer: true });
  route('DELETE', '/api/leaves/:id', ({ user, params }) => {
    const D = db(), l = D.leaves.find((x) => x.id === Number(params.id));
    need(l, 404, 'Leave not found.');
    need(isOfficer(user) || (l.ownerKey === user.key && (l.status === 'pending' || l.from > zoneDate(Date.now()))), 403, 'You can only take back a leave that has not started yet. Ask the leadership to end a running one.');
    D.leaves = D.leaves.filter((x) => x.id !== l.id);
    save();
    return { ok: true };
  });

  // ---------------------------------------------------------------- explanations (the reason pop-up)
  route('POST', '/api/explanations', ({ body, user }) => {
    const D = db(), a = alertFor(user.key);
    need(a, 409, 'There is nothing you have to explain right now.');
    const reason = clean(body.reason, 600);
    need(reason.length >= 5, 400, 'Please write a few words about why.');
    const x = { id: newId(), ownerKey: user.key, name: user.name, reason, triggers: a.triggers, upTo: a.upTo, status: 'pending', at: now() };
    D.explanations.push(x);
    save();
    return x;
  });
  route('PUT', '/api/explanations/:id', ({ body, user, params }) => {
    const D = db(), x = D.explanations.find((e) => e.id === Number(params.id));
    need(x, 404, 'Explanation not found.');
    need(['approved', 'rejected'].includes(body.status), 400, 'Approve or reject.');
    need(x.status === 'pending', 409, 'This was already decided.');
    x.status = body.status; x.note = clean(body.note, 200); x.decidedBy = user.name; x.decidedAt = now();
    save();
    notify(x.ownerKey, `Your explanation was ${x.status === 'approved' ? '✅ accepted' : '❌ not accepted. Please open the site and write a new one'}.${x.note ? `\nNote: ${x.note}` : ''}\n${appUrl()}`);
    return x;
  }, { officer: true });

  // ---------------------------------------------------------------- warnings (leadership)
  route('POST', '/api/warnings', ({ body, user }) => {
    const owner = clean(body.ownerKey, 40), reason = clean(body.reason, 300);
    need(owner && players().has(owner), 404, 'Pick a player.');
    need(reason, 400, 'Write the reason for the warning.');
    const w = addWarning({ owner, kind: 'manual', reason, auto: false, by: user.name });
    save();
    return w;
  }, { officer: true });
  route('PUT', '/api/warnings/:id', ({ body, user, params }) => {
    const D = db(), w = D.warnings.find((x) => x.id === Number(params.id));
    need(w, 404, 'Warning not found.');
    need(w.status === 'active', 409, 'This warning is already over.');
    w.status = 'removed'; w.endedAt = now(); w.endedBy = user.name; w.note = clean(body.note, 200);
    save();
    return w;
  }, { officer: true });
  route('POST', '/api/admin/compliance/run', () => runChecks(), { officer: true });
  route('PUT', '/api/admin/compliance', ({ body }) => {
    const c = cfg();
    const ranges = { windowDays: [7, 365], minEvents: [1, 50], minAttendance: [0, 100], noShowLimit: [0, 50], noReplyLimit: [0, 50], expiryDays: [0, 730], quietDays: [0, 730], quietRemove: [0, 50], disqualifyAt: [0, 20] };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      if (body[k] === undefined) continue;
      const v = int(body[k]);
      need(Number.isFinite(v) && v >= lo && v <= hi, 400, `${k}: a number between ${lo} and ${hi}.`);
      c[k] = v;
    }
    for (const k of ['enabled', 'mandatoryOnly', 'loaNeedsApproval']) if (body[k] !== undefined) c[k] = yes(body[k]);
    save();
    return c;
  }, { officer: true });

  // ---------------------------------------------------------------- what the server tells each person
  function extraState(user) {
    const D = db(), off = isOfficer(user);
    return {
      leaves: off ? D.leaves : D.leaves.filter((l) => l.ownerKey === user.key),
      warnings: off ? D.warnings : D.warnings.filter((w) => w.ownerKey === user.key),
      explanations: off ? D.explanations : D.explanations.filter((x) => x.ownerKey === user.key),
      alert: off ? null : (() => { const a = alertFor(user.key); if (a) delete a.upTo; return a; })(),
    };
  }
  return { extraState, eventChart, players, runChecks, isOnLeave };
};
