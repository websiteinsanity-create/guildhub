// Guild Hall server features that sit on top of server.js:
//   - what each person is allowed to see (members only get their own loot, attendance and requests)
//   - characters with several builds (PvE / PvP), several Questlog links and leadership approval of changes
//   - player profiles, lucent / item requests, leadership tags
//   - recurring events, guild icon / background / dashboard preferences

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validTimeZone, zonedToUtcMs, matchesRule, occurrences, isoDate } = require('./recurrence');

module.exports = function install(ctx) {
  const {
    route, need, HttpError, clean, num, newId, save, config, discord, isOfficer, findMember, findEvent, normParties, applyPresetRule,
    eventFor, pickMember, cleanLinks, syncAttendancePoints, hooks, tickHooks, clone, appUrl, nameOfOwner, LOOT_TYPES, LOOT_DEFAULT_TYPE,
    UPLOAD_DIR, publicBranding, pickEvent,
  } = ctx;
  const db = () => ctx.db;                                   // the database object is replaced when a backup is restored
  const now = () => new Date().toISOString();
  const int = (v) => Math.round(Number(v));
  const yes = (v) => v === true || v === 'true';
  const groups = config.approvalGroups || [];
  const MODES = config.buildModes || ['PvE'];
  const notify = (ownerKey, text) => { discord.sendDM(ownerKey, text).catch(() => {}); };   // best effort, never blocks a request
  const community = require('./server-community')(ctx);                                       // applications and the Discord tools
  const compliance = require('./server-compliance')(ctx);                                   // leave of absence, warnings, the event chart

  // ============================================================ who sees what
  const HIDEABLE = new Set((config.sections || []).map((s) => s.key));
  const PANEL_KEYS = ['announcement', 'stats', 'loot', 'leadership', 'next', 'info'];

  // Login notices: everybody gets the active ones with "have I accepted it"; the leadership also sees who accepted.
  function noticesFor(user) {
    const D = db(), off = isOfficer(user);
    return D.notices.filter((n) => off || (n.active && (!n.recipients || n.recipients.includes(user.key)))).map((n) => {
      const acks = D.noticeAcks[n.id] || {};
      const out = { id: n.id, title: n.title, text: n.text, active: n.active, at: n.at, accepted: !!acks[user.key] };
      if (off) { out.acks = Object.entries(acks).map(([key, v]) => ({ key, name: v.name, at: v.at })); out.recipients = n.recipients || null; }
      return out;
    });
  }

  function stateFor(user) {
    if (user.role === 'applicant') return community.applicantState(user);        // an applicant sees nothing but their own application
    const D = db(), off = isOfficer(user), hidden = new Set(D.settings.hiddenSections || []);
    const hide = (k) => !off && hidden.has(k);
    const own = new Set(D.members.filter((m) => m.owner === user.key).map((m) => m.id));
    const P = compliance.players();
    const events = D.events.map((e) => {
      const out = eventFor(e, user);
      out.chart = compliance.eventChart(e, P);                // counts only: who is coming, who is not, who did not answer (per role)
      out.rollTaken = e.attended.length > 0;                  // lets a member's own attendance % work without seeing who else came
      if (!off) { out.attended = e.attended.filter((id) => own.has(id)); if (hide('parties')) out.parties = []; }
      return out;
    });
    return {
      user: { key: user.key, name: user.name, username: user.username || '', avatar: user.avatar || '', role: user.role },
      members: D.members.filter((m) => off || !m.pendingApproval || own.has(m.id)).map((m) => (off || own.has(m.id) ? m : { ...m, questlogs: [] })),     // Questlog links: the leadership and the owner only
      events,
      points: off ? D.points : hide('points') ? [] : D.points.filter((p) => own.has(p.memberId)),
      duties: off ? D.duties : [],                          // the tasks are for the leadership only
      presets: hide('parties') ? [] : D.presets.filter((p) => off || !p.hidden),
      presetRules: hide('parties') ? [] : D.presetRules.filter((r) => off || !(D.presets.find((p) => p.id === r.presetId) || {}).hidden),
      loot: off ? D.loot : hide('loot') ? [] : D.loot.filter((l) => own.has(l.memberId)),
      requests: off ? D.requests : hide('requests') ? [] : D.requests.filter((r) => own.has(r.memberId)),
      changes: off ? D.changes : D.changes.filter((c) => c.ownerKey === user.key),
      profiles: off ? D.profiles : (D.profiles[user.key] ? { [user.key]: D.profiles[user.key] } : {}),
      series: D.series,
      infoBoard: D.infoBoard,
      notices: noticesFor(user),
      ...compliance.extraState(user),
      ...community.extraState(user),
      tags: off ? D.tags : [],
      playerTags: off ? D.playerTags : {},
      prefs: D.prefs[user.key] || {},
      settings: D.settings,
      users: Object.values(D.users).filter((u) => !u.applicant).map((u) => ({ id: u.id, name: u.name, avatar: u.avatar, role: u.role })),
      now: Date.now(),
    };
  }
  route('GET', '/api/state', ({ user }) => stateFor(user), { applicant: true });

  // ============================================================ approval of player changes
  const FIELD_GROUP = {
    name: 'name', role: 'role', primaryWeapon: 'weapons', secondaryWeapon: 'weapons', mode: 'weapons',
    gearScore: 'gearScore', level: 'level', specialization: 'specialization', questlogs: 'questlog',
    discord: 'profile', timezone: 'profile', notes: 'profile',
  };
  const groupLabel = (key) => (groups.find((g) => g.key === key) || { label: key }).label;
  const gate = (user, group) => !isOfficer(user) && !!db().settings.approvals[group];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const show = (v) => (Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : v === '' || v == null ? '(empty)' : String(v));

  function queue(user, entry) {
    const c = { id: newId(), status: 'pending', by: user.name, byKey: user.key, at: now(), ...entry };
    db().changes.push(c);
    return c;
  }
  const describe = (c) => {
    const m = c.memberId && findMember(c.memberId), who = m ? m.name : 'your profile';
    if (c.kind === 'member') return `${who}: ` + Object.entries(c.changes).map(([f, v]) => `${f} ${show(v.from)} -> ${show(v.to)}`).join(', ');
    if (c.kind === 'profile') return 'Profile: ' + Object.keys(c.changes).join(', ');
    if (c.kind === 'build') return `${who}: ${c.op} build "${(c.data && c.data.name) || ''}"`;
    return `New character ${who}`;
  };

  function cleanBuildRefs(memberId, buildId) {
    const fix = (p) => { if (p.builds && String(p.builds[memberId]) === String(buildId)) { const b = { ...p.builds }; delete b[memberId]; return { ...p, builds: b }; } return p; };
    for (const ev of db().events) ev.parties = ev.parties.map(fix);
    for (const pr of db().presets) pr.parties = pr.parties.map(fix);
  }

  function applyChange(c) {
    const D = db(), m = c.memberId ? findMember(c.memberId) : null;
    if (c.kind === 'profile') {
      const p = (D.profiles[c.ownerKey] = D.profiles[c.ownerKey] || {});
      for (const [f, v] of Object.entries(c.changes)) p[f] = v.to;
      p.updatedAt = now();
      return;
    }
    need(m, 404, 'That character no longer exists.');
    if (c.kind === 'member') { for (const [f, v] of Object.entries(c.changes)) m[f] = v.to; }
    else if (c.kind === 'newCharacter') { m.active = true; delete m.pendingApproval; }
    else if (c.kind === 'build') {
      if (c.op === 'add') { need(m.builds.length < 6, 400, 'A character can have up to 6 extra builds.'); m.builds.push({ id: newId(), ...c.data }); return; }
      const b = m.builds.find((x) => x.id === c.buildId);
      need(b, 404, 'That build no longer exists.');
      if (c.op === 'update') Object.assign(b, c.data);
      else { m.builds = m.builds.filter((x) => x.id !== b.id); cleanBuildRefs(m.id, b.id); }
    }
  }

  route('POST', '/api/changes/:id/decide', ({ body, user, params }) => {
    const D = db(), c = D.changes.find((x) => x.id === Number(params.id));
    need(c, 404, 'Request not found.');
    need(c.status === 'pending', 409, 'This request was already decided.');
    need(['approve', 'reject'].includes(body.decision), 400, 'Approve or reject.');
    if (body.decision === 'approve') applyChange(c);
    else if (c.kind === 'newCharacter') D.members = D.members.filter((m) => m.id !== c.memberId);      // a rejected new character is removed
    c.status = body.decision === 'approve' ? 'approved' : 'rejected';
    c.decidedBy = user.name; c.decidedAt = now(); c.note = clean(body.note, 200);
    save();
    notify(c.ownerKey, `${c.status === 'approved' ? '✅ Approved' : '❌ Not approved'} by the leadership: ${describe(c)}${c.note ? `\nNote: ${c.note}` : ''}\n${appUrl()}/#/profile`);
    return c;
  }, { officer: true });
  route('DELETE', '/api/changes/:id', ({ user, params }) => {
    const D = db(), c = D.changes.find((x) => x.id === Number(params.id));
    need(c, 404, 'Request not found.');
    need(c.status === 'pending' && (c.ownerKey === user.key || isOfficer(user)), 403, 'Only the player can take back a request that is still waiting.');
    if (c.kind === 'newCharacter') D.members = D.members.filter((m) => m.id !== c.memberId);
    D.changes = D.changes.filter((x) => x.id !== c.id);
    save();
    return { ok: true };
  });

  // ============================================================ characters (create / edit, with approval)
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, int(v) || 0));
  route('POST', '/api/members', ({ body, user }) => {
    const D = db();
    const m = { id: newId(), owner: user.key, joinedAt: now(), builds: [], ...pickMember(body) };
    if (isOfficer(user)) {
      if (config.ranks.includes(body.rank)) m.rank = body.rank;
      if (clean(body.owner, 40)) m.owner = ctx.pickOwner ? ctx.pickOwner(body.owner) : clean(body.owner, 40);
    } else if (gate(user, 'newCharacter')) {
      m.active = false; m.pendingApproval = true;
    }
    D.members.push(m);
    if (m.pendingApproval) queue(user, { kind: 'newCharacter', ownerKey: m.owner, memberId: m.id });
    save();
    return m.pendingApproval ? { ...m, approvalPending: ['newCharacter'] } : m;
  });
  route('PUT', '/api/members/:id', ({ body, user, params }) => {
    const D = db(), m = findMember(params.id);
    need(m, 404, 'Character not found.');
    need(ctx.canEditMember(user, m), 403, 'You can only edit your own characters.');
    const next = pickMember(body, m);
    const immediate = {}, gated = {};
    for (const [f, g] of Object.entries(FIELD_GROUP)) {
      if (same(next[f], m[f])) continue;
      (gate(user, g) ? gated : immediate)[f] = next[f];
    }
    if (next.active !== m.active) immediate.active = next.active;
    Object.assign(m, immediate);
    if (isOfficer(user)) {
      if (config.ranks.includes(body.rank)) m.rank = body.rank;
      if (body.owner !== undefined && clean(body.owner, 40) && clean(body.owner, 40) !== m.owner) {
        const o = clean(body.owner, 40);
        need(!discord.loginEnabled || D.users[o], 400, 'Pick a player who has signed in with Discord.');
        m.owner = o;
      }
    }
    let pending = [];
    if (Object.keys(gated).length) {
      let c = D.changes.find((x) => x.status === 'pending' && x.kind === 'member' && x.memberId === m.id);
      const fresh = Object.fromEntries(Object.entries(gated).map(([f, to]) => [f, { from: c && c.changes[f] ? c.changes[f].from : m[f], to }]));
      if (c) { c.changes = { ...c.changes, ...fresh }; c.at = now(); }
      else c = queue(user, { kind: 'member', ownerKey: m.owner, memberId: m.id, changes: fresh });
      pending = [...new Set(Object.keys(gated).map((f) => groupLabel(FIELD_GROUP[f])))];
    }
    save();
    return pending.length ? { ...m, approvalPending: pending } : m;
  });

  // ============================================================ builds (several classes, PvE and PvP)
  function pickBuild(b) {
    const roles = config.roles, weapons = config.weapons;
    const out = {
      mode: MODES.includes(b.mode) ? b.mode : MODES[0],
      role: roles.includes(b.role) ? b.role : roles[0],
      primaryWeapon: weapons.includes(b.primaryWeapon) ? b.primaryWeapon : '',
      secondaryWeapon: weapons.includes(b.secondaryWeapon) ? b.secondaryWeapon : '',
      specialization: clean(b.specialization, 40),
      gearScore: Math.max(0, Math.min(99999, Math.round(num(b.gearScore)))),
      notes: clean(b.notes, 200),
    };
    out.name = clean(b.name, 30) || `${out.mode} build`;
    return out;
  }
  const ownBuildCharacter = (user, id) => {
    const m = findMember(id);
    need(m, 404, 'Character not found.');
    need(ctx.canEditMember(user, m), 403, 'You can only change your own characters.');
    return m;
  };
  const buildResult = (m, pending) => (pending ? { ...m, approvalPending: [groupLabel('builds')] } : m);
  route('POST', '/api/members/:id/builds', ({ body, user, params }) => {
    const m = ownBuildCharacter(user, params.id), data = pickBuild(body);
    need(m.builds.length < 6, 400, 'A character can have up to 6 extra builds.');
    if (gate(user, 'builds')) { queue(user, { kind: 'build', op: 'add', ownerKey: m.owner, memberId: m.id, data }); save(); return buildResult(m, true); }
    m.builds.push({ id: newId(), ...data });
    save();
    return m;
  });
  route('PUT', '/api/members/:id/builds/:bid', ({ body, user, params }) => {
    const m = ownBuildCharacter(user, params.id), b = m.builds.find((x) => x.id === Number(params.bid));
    need(b, 404, 'Build not found.');
    const data = pickBuild(body);
    if (gate(user, 'builds')) { queue(user, { kind: 'build', op: 'update', ownerKey: m.owner, memberId: m.id, buildId: b.id, data }); save(); return buildResult(m, true); }
    Object.assign(b, data);
    save();
    return m;
  });
  route('DELETE', '/api/members/:id/builds/:bid', ({ user, params }) => {
    const m = ownBuildCharacter(user, params.id), b = m.builds.find((x) => x.id === Number(params.bid));
    need(b, 404, 'Build not found.');
    if (gate(user, 'builds')) { queue(user, { kind: 'build', op: 'delete', ownerKey: m.owner, memberId: m.id, buildId: b.id, data: { name: b.name } }); save(); return buildResult(m, true); }
    m.builds = m.builds.filter((x) => x.id !== b.id);
    cleanBuildRefs(m.id, b.id);
    save();
    return m;
  });

  // ============================================================ player profile
  route('PUT', '/api/profile/:key', ({ body, user, params }) => {
    const D = db(), key = params.key;
    need(key === user.key || isOfficer(user), 403, 'You can only change your own profile.');
    const cur = D.profiles[key] || {};
    const next = {
      bio: clean(body.bio ?? cur.bio, 600),
      timezone: clean(body.timezone ?? cur.timezone, 40),
      availability: clean(body.availability ?? cur.availability, 200),
    };
    const diff = Object.fromEntries(Object.entries(next).filter(([f, v]) => !same(v, cur[f] ?? '')).map(([f, v]) => [f, { from: cur[f] ?? '', to: v }]));
    if (!Object.keys(diff).length) return { profile: cur, approvalPending: [] };
    if (gate(user, 'profile')) {
      let c = D.changes.find((x) => x.status === 'pending' && x.kind === 'profile' && x.ownerKey === key);
      if (c) { for (const [f, v] of Object.entries(diff)) c.changes[f] = { from: c.changes[f] ? c.changes[f].from : v.from, to: v.to }; c.at = now(); }
      else queue(user, { kind: 'profile', ownerKey: key, changes: diff });
      save();
      return { profile: cur, approvalPending: [groupLabel('profile')] };
    }
    D.profiles[key] = { ...cur, ...next, updatedAt: now() };
    save();
    return { profile: D.profiles[key], approvalPending: [] };
  });

  // ============================================================ lucent / item requests
  const fireStatus = { approved: '✅ approved', rejected: '❌ rejected', given: '🎁 handed over' };
  route('POST', '/api/requests', ({ body, user }) => {
    const D = db(), m = findMember(body.memberId);
    need(m, 404, 'Pick one of your characters.');
    need(m.owner === user.key || isOfficer(user), 403, 'You can only request for your own characters.');
    need(m.active, 400, 'That character is not active.');
    need((config.requestKinds || ['Lucent', 'Item']).includes(body.kind), 400, 'Pick Lucent or Item.');
    const buildKey = String(body.buildKey ?? 'main');
    need(buildKey === 'main' || m.builds.some((b) => String(b.id) === buildKey), 400, "Pick one of that character's builds.");
    need(isOfficer(user) || D.requests.filter((r) => r.byKey === user.key && ['open', 'approved'].includes(r.status)).length < 10, 429, 'You already have 10 open requests.');
    let item = '', amount = 0;
    if (body.kind === 'Lucent') { amount = Math.round(num(body.amount)); need(amount >= 1 && amount <= 1e9, 400, 'Enter how much Lucent you need.'); }
    else { item = clean(body.item, 120); need(item, 400, 'Type which item you need.'); }
    const r = {
      id: newId(), memberId: m.id, buildKey, kind: body.kind, item, amount, lootType: LOOT_TYPES.includes(body.lootType) && body.lootType !== 'Lucent' ? body.lootType : LOOT_DEFAULT_TYPE,
      reason: clean(body.reason, 300), status: 'open', by: user.name, byKey: user.key, at: now(),
    };
    D.requests.push(r);
    save();
    return r;
  });
  route('PUT', '/api/requests/:id', ({ body, user, params }) => {
    const D = db(), r = D.requests.find((x) => x.id === Number(params.id));
    need(r, 404, 'Request not found.');
    need(['approved', 'rejected', 'given'].includes(body.status), 400, 'Approve, reject or mark as given.');
    need(r.status === 'open' || (r.status === 'approved' && body.status !== 'approved'), 409, 'This request is already ' + r.status + '.');
    const m = findMember(r.memberId);
    r.status = body.status; r.note = clean(body.note, 200); r.decidedBy = user.name; r.decidedAt = now();
    if (body.status === 'given' && m) {                      // handed over / paid out: it shows up in the Loot section by itself
      D.loot.push(r.kind === 'Lucent'
        ? { id: newId(), memberId: m.id, item: '', type: 'Lucent', amount: r.amount, date: isoDate(Date.now()), by: user.name, at: now(), fromRequest: r.id }
        : { id: newId(), memberId: m.id, item: r.item, type: r.lootType, amount: 0, date: isoDate(Date.now()), by: user.name, at: now(), fromRequest: r.id });
    }
    save();
    if (m) notify(m.owner, `Your request for ${r.kind === 'Lucent' ? `${r.amount} Lucent` : r.item} (${m.name}) was ${fireStatus[r.status]}.${r.note ? `\nNote: ${r.note}` : ''}\n${appUrl()}/#/requests`);
    return r;
  }, { officer: true });
  route('DELETE', '/api/requests/:id', ({ user, params }) => {
    const D = db(), r = D.requests.find((x) => x.id === Number(params.id));
    need(r, 404, 'Request not found.');
    need(isOfficer(user) || (r.byKey === user.key && r.status === 'open'), 403, 'You can only withdraw your own request while it is still open.');
    D.requests = D.requests.filter((x) => x.id !== r.id);
    save();
    return { ok: true };
  });

  // ============================================================ what each leader does (shown to everybody)
  route('PUT', '/api/members/:id/jobs', ({ body, params }) => {
    const m = findMember(params.id);
    need(m, 404, 'Character not found.');
    m.jobs = clean(body.jobs, 120);
    save();
    return m;
  }, { officer: true });

  // ============================================================ tags (leadership only)
  const pickTag = (b, ex) => {
    const name = clean(b.name ?? ex?.name, 30);
    need(name, 400, 'Give the tag a name.');
    const color = String(b.color ?? ex?.color ?? '#7cc4b8');
    need(/^#[0-9a-f]{6}$/i.test(color), 400, 'Pick a colour.');
    return { name, color: color.toLowerCase() };
  };
  route('POST', '/api/tags', ({ body }) => {
    const D = db(), t = pickTag(body);
    need(!D.tags.some((x) => x.name.toLowerCase() === t.name.toLowerCase()), 409, 'There is already a tag with that name.');
    const tag = { id: newId(), ...t };
    D.tags.push(tag); save();
    return tag;
  }, { officer: true });
  route('PUT', '/api/tags/:id', ({ body, params }) => {
    const D = db(), tag = D.tags.find((x) => x.id === Number(params.id));
    need(tag, 404, 'Tag not found.');
    const t = pickTag(body, tag);
    need(!D.tags.some((x) => x.id !== tag.id && x.name.toLowerCase() === t.name.toLowerCase()), 409, 'There is already a tag with that name.');
    Object.assign(tag, t); save();
    return tag;
  }, { officer: true });
  route('DELETE', '/api/tags/:id', ({ params }) => {
    const D = db(), id = Number(params.id);
    need(D.tags.some((x) => x.id === id), 404, 'Tag not found.');
    D.tags = D.tags.filter((x) => x.id !== id);
    for (const k of Object.keys(D.playerTags)) { D.playerTags[k] = D.playerTags[k].filter((t) => t !== id); if (!D.playerTags[k].length) delete D.playerTags[k]; }
    save();
    return { ok: true };
  }, { officer: true });
  route('PUT', '/api/player-tags/:key', ({ body, params }) => {
    const D = db(), ids = [...new Set((Array.isArray(body.tags) ? body.tags : []).map(Number))].filter((id) => D.tags.some((t) => t.id === id));
    if (ids.length) D.playerTags[params.key] = ids; else delete D.playerTags[params.key];
    save();
    return { key: params.key, tags: ids };
  }, { officer: true });

  // ============================================================ recurring events
  const horizonMs = () => (config.recurrenceHorizonDays || 42) * 864e5;
  function pickSeries(b, ex) {
    const t = pickEvent({ ...b, start: '2000-01-01T00:00:00Z' }, ex);
    delete t.start;
    const weekdays = [...new Set((Array.isArray(b.weekdays) ? b.weekdays : ex ? ex.weekdays : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    need(weekdays.length, 400, 'Pick at least one weekday.');
    const time = String(b.time ?? ex?.time ?? '');
    need(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), 400, 'Enter the time like 21:00.');
    const tz = String(b.tz ?? ex?.tz ?? config.defaultTimezone ?? 'UTC');
    need(validTimeZone(tz), 400, 'Unknown time zone.');
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00Z'));
    const startDate = String(b.startDate || ex?.startDate || isoDate(Date.now()));
    need(isDate(startDate), 400, 'Pick a valid first date.');
    const endDate = String(b.endDate ?? ex?.endDate ?? '');
    need(endDate === '' || (isDate(endDate) && endDate >= startDate), 400, 'The last date must be on or after the first date.');
    const intervalWeeks = Math.max(1, Math.min(4, int(b.intervalWeeks ?? ex?.intervalWeeks) || 1));
    return { ...t, title: clean(b.title ?? ex?.title, 80), weekdays, intervalWeeks, time, tz, startDate, endDate };
  }
  const applyTemplate = (ev, se) => {
    Object.assign(ev, {
      title: se.title || se.type, type: se.type, description: se.description, points: se.points, mandatory: se.mandatory,
      maxSignups: se.maxSignups, signupCloseMinutes: se.signupCloseMinutes, pinWindowMinutes: se.pinWindowMinutes, reminders: se.reminders,
    });
  };
  function materialize() {
    const D = db(), t0 = Date.now();
    let created = 0;
    for (const se of D.series) {
      for (const occ of occurrences(se, t0, t0 + horizonMs())) {
        if (se.skipped.includes(occ.date) || D.events.some((e) => e.seriesId === se.id && e.seriesDate === occ.date)) continue;
        const ev = { id: newId(), createdBy: se.createdBy, seriesId: se.id, seriesDate: occ.date, rsvps: {}, attended: [], parties: [], pin: null, pinEntries: {}, remindersSent: {}, reminderLog: [], start: new Date(occ.startMs).toISOString() };
        applyTemplate(ev, se);
        applyPresetRule(ev);
        D.events.push(ev);
        created++;
      }
    }
    if (created) save();
    return created;
  }
  tickHooks.push(async () => { materialize(); });
  materialize();

  function syncSeries(se) {
    const D = db(), t0 = Date.now();
    for (const ev of [...D.events]) {
      if (ev.seriesId !== se.id || Date.parse(ev.start) <= t0) continue;               // running and past events are never touched
      if (!matchesRule(se, ev.seriesDate)) { D.events = D.events.filter((e) => e.id !== ev.id); continue; }
      const oldStart = ev.start, oldType = ev.type;
      applyTemplate(ev, se);
      ev.start = new Date(zonedToUtcMs(ev.seriesDate, se.time, se.tz)).toISOString();
      if (ev.start !== oldStart) ev.remindersSent = {};
      if (ev.type !== oldType) applyPresetRule(ev);
    }
    return materialize();
  }
  route('POST', '/api/series', ({ body, user }) => {
    const D = db(), se = { id: newId(), createdBy: user.key, at: now(), skipped: [], ...pickSeries(body) };
    D.series.push(se);
    const created = materialize();
    save();
    return { series: se, created };
  }, { officer: true });
  route('PUT', '/api/series/:id', ({ body, params }) => {
    const D = db(), se = D.series.find((x) => x.id === Number(params.id));
    need(se, 404, 'Series not found.');
    Object.assign(se, pickSeries(body, se));
    const created = syncSeries(se);
    save();
    return { series: se, created };
  }, { officer: true });
  route('DELETE', '/api/series/:id', ({ params }) => {
    const D = db(), se = D.series.find((x) => x.id === Number(params.id));
    need(se, 404, 'Series not found.');
    const t0 = Date.now();
    D.events = D.events.filter((e) => !(e.seriesId === se.id && Date.parse(e.start) > t0));       // upcoming ones go, finished ones stay
    for (const e of D.events) if (e.seriesId === se.id) e.seriesId = null;
    D.series = D.series.filter((x) => x.id !== se.id);
    save();
    return { ok: true };
  }, { officer: true });

  // ============================================================ appearance, access, preferences
  route('PUT', '/api/admin/options', ({ body }) => {
    const D = db(), st = D.settings;
    if (body.approvals && typeof body.approvals === 'object') for (const g of groups) if (body.approvals[g.key] !== undefined) st.approvals[g.key] = yes(body.approvals[g.key]);
    if (Array.isArray(body.hiddenSections)) st.hiddenSections = [...new Set(body.hiddenSections.filter((k) => HIDEABLE.has(k)))];
    if (body.branding && typeof body.branding === 'object') {
      const b = st.branding, x = body.branding;
      if (x.name !== undefined) b.name = clean(x.name, 40);
      if (x.tagline !== undefined) b.tagline = clean(x.tagline, 80);
      if (x.announcement !== undefined) b.announcement = clean(x.announcement, 500);
      if (x.accent !== undefined) { need(x.accent === '' || /^#[0-9a-f]{6}$/i.test(x.accent), 400, 'Pick a colour.'); b.accent = String(x.accent).toLowerCase(); }
      if (x.bgDim !== undefined) { const v = int(x.bgDim); need(v >= 0 && v <= 95, 400, 'The background dimming must be between 0 and 95.'); b.bgDim = v; }
    }
    save();
    return st;
  }, { officer: true });

  const sniff = (buf) => {
    if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
    if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    return null;          // deliberately no SVG: it can carry scripts
  };
  const dropFile = (name) => { if (name) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true }); };
  route('POST', '/api/admin/upload', ({ body }) => {
    const D = db(), b = D.settings.branding;
    need(['icon', 'background'].includes(body.kind), 400, 'Icon or background.');
    const key = body.kind === 'icon' ? 'iconFile' : 'bgFile';
    if (body.remove) { dropFile(b[key]); b[key] = ''; save(); return publicBranding(); }
    const buf = Buffer.from(String(body.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    need(buf.length > 100, 400, 'That does not look like an image.');
    need(buf.length <= (body.kind === 'icon' ? 1.5e6 : 6e6), 413, body.kind === 'icon' ? 'The icon can be up to 1.5 MB.' : 'The background can be up to 6 MB.');
    const ext = sniff(buf);
    need(ext, 400, 'Only PNG, JPEG, GIF or WebP pictures are allowed.');
    const name = `${body.kind}-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    if (b[key] && b[key] !== name) dropFile(b[key]);
    b[key] = name;
    save();
    return publicBranding();
  }, { officer: true });

  route('PUT', '/api/prefs', ({ body, user }) => {
    const D = db(), ok = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter((k) => PANEL_KEYS.includes(k)))];
    const cur = D.prefs[user.key] || {}, next = { ...cur };
    need(isOfficer(user) || (body.dashboardHidden === undefined && body.dashboardOrder === undefined), 403, 'Only the leadership can change the dashboard layout.');
    if (body.dashboardHidden !== undefined) next.dashboardHidden = ok(body.dashboardHidden);
    if (body.dashboardOrder !== undefined) next.dashboardOrder = ok(body.dashboardOrder);
    if (body.dashboardHidden !== undefined || body.dashboardOrder !== undefined) { next.dashboardHidden = next.dashboardHidden || []; next.dashboardOrder = next.dashboardOrder || []; }
    if (body.timezone !== undefined) {                                   // every player picks the zone all times are shown in
      const tz = String(body.timezone || '');
      need(tz === '' || validTimeZone(tz), 400, 'Unknown time zone.');
      if (tz) next.timezone = tz; else delete next.timezone;
    }
    D.prefs[user.key] = next;
    save();
    return next;
  });

  // ============================================================ info section on the dashboard (leadership edits)
  route('PUT', '/api/info-board', ({ body }) => {
    const cats = Array.isArray(body.categories) ? body.categories : [];
    need(cats.length <= 8, 400, 'Up to 8 categories.');
    const out = cats.map((c) => {
      const title = clean(c && c.title, 40);
      const buttons = (Array.isArray(c && c.buttons) ? c.buttons : []).map((b) => ({ label: clean(b && b.label, 40), text: String((b && b.text) || '').replace(/\r\n/g, '\n').trim().slice(0, 3000) })).filter((b) => b.label);
      need(buttons.length <= 12, 400, 'Up to 12 buttons per category.');
      return { title, buttons };
    }).filter((c) => c.title || c.buttons.length);
    for (const c of out) need(c.title, 400, 'Give every category a name.');
    db().infoBoard = { title: clean(body.title, 40) || 'Info', categories: out };
    save();
    return db().infoBoard;
  }, { officer: true });

  // ============================================================ login notices (full screen until accepted)
  const pickNotice = (b, ex) => {
    const title = clean(b.title ?? ex?.title, 80), text = String(b.text ?? ex?.text ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
    need(title, 400, 'Give the notice a title.');
    need(text, 400, 'Write the text of the notice.');
    // audience: everybody (recipients null) or only the chosen players (a list of player keys)
    let recipients = ex ? ex.recipients ?? null : null;
    if (b.audience === 'all') recipients = null;
    else if (b.audience === 'selected' || Array.isArray(b.recipients)) {
      recipients = [...new Set((Array.isArray(b.recipients) ? b.recipients : recipients || []).map((k) => clean(k, 40)).filter(Boolean))].slice(0, 300);
      need(recipients.length, 400, 'Pick at least one player, or send it to everybody.');
    }
    return { title, text, recipients };
  };
  route('POST', '/api/notices', ({ body, user }) => {
    const D = db();
    need(D.notices.length < 50, 400, 'Delete some old notices first (50 at most).');
    const n = { id: newId(), ...pickNotice(body), active: true, createdBy: user.name, at: now() };
    D.notices.push(n);
    D.noticeAcks[n.id] = { [user.key]: { name: user.name, at: now() } };          // the author has obviously read it
    save();
    return noticesFor(user).find((x) => x.id === n.id);
  }, { officer: true });
  route('PUT', '/api/notices/:id', ({ body, user, params }) => {
    const D = db(), n = D.notices.find((x) => x.id === Number(params.id));
    need(n, 404, 'Notice not found.');
    Object.assign(n, pickNotice(body, n));
    if (body.active !== undefined) n.active = yes(body.active);
    if (yes(body.resetAcks)) D.noticeAcks[n.id] = { [user.key]: { name: user.name, at: now() } };   // everybody has to accept it again
    save();
    return noticesFor(user).find((x) => x.id === n.id);
  }, { officer: true });
  route('DELETE', '/api/notices/:id', ({ params }) => {
    const D = db(), id = Number(params.id);
    need(D.notices.some((x) => x.id === id), 404, 'Notice not found.');
    D.notices = D.notices.filter((x) => x.id !== id);
    delete D.noticeAcks[id];
    save();
    return { ok: true };
  }, { officer: true });
  route('POST', '/api/notices/:id/ack', ({ user, params }) => {
    const D = db(), n = D.notices.find((x) => x.id === Number(params.id));
    need(n && n.active && (!n.recipients || n.recipients.includes(user.key)), 404, 'Notice not found.');
    const acks = (D.noticeAcks[n.id] = D.noticeAcks[n.id] || {});
    if (!acks[user.key]) acks[user.key] = { name: user.name, at: now() };
    save();
    return { ok: true };
  });

  // ============================================================ one preset for several event types and events
  route('POST', '/api/presets/:id/use-for', ({ body, params }) => {
    const D = db(), p = D.presets.find((x) => x.id === Number(params.id));
    need(p, 404, 'Preset not found.');
    const types = [...new Set((Array.isArray(body.types) ? body.types : []).filter((t) => config.eventTypes.some((x) => x.name === t)))];
    const ids = new Set((Array.isArray(body.eventIds) ? body.eventIds : []).map(Number));
    // types that were unticked stop using THIS preset for new events (events that already have parties keep them)
    const removeTypes = [...new Set((Array.isArray(body.removeTypes) ? body.removeTypes : []).filter((t) => config.eventTypes.some((x) => x.name === t)))];
    need(types.length || ids.size || removeTypes.length, 400, 'Pick at least one event type or event.');
    let removed = 0;
    for (const type of removeTypes) { const before = D.presetRules.length; D.presetRules = D.presetRules.filter((r) => !(r.type === type && r.presetId === p.id)); removed += before - D.presetRules.length; }
    for (const type of types) {                                               // a type keeps using the preset for events created later
      D.presetRules = D.presetRules.filter((r) => r.type !== type);
      D.presetRules.push({ type, presetId: p.id, at: now() });
    }
    let applied = 0, skipped = 0;
    for (const ev of D.events) {
      if (Date.parse(ev.start) <= Date.now() || !(types.includes(ev.type) || ids.has(ev.id))) continue;
      if (ev.parties.length && !yes(body.overwrite)) { skipped++; continue; }
      ev.parties = normParties(clone(p.parties));
      applied++;
    }
    save();
    return { applied, skipped, removed, types, rules: D.presetRules };
  }, { officer: true });

  // ============================================================ clean-up when things are deleted
  hooks.memberDeleted.push((m) => {
    const D = db();
    D.requests = D.requests.filter((r) => r.memberId !== m.id);
    D.changes = D.changes.filter((c) => c.memberId !== m.id);
  });
};
