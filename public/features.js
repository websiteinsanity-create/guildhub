'use strict';
/* Features that sit on top of app.js: recurring events, the player profile (characters, builds, links), requests,
   approvals, tags, attendance filters, the personalised dashboard and the extra Admin panels.
   They register themselves in VIEWS / ACTIONS / CHANGES / FORMS, which app.js reads. */

Object.assign(UI, { attQ: '', attRole: '', attDays: '30', attMand: false, attBand: '', attSort: 'name', reqStatus: '', reqQ: '' });

/* ================= recurring events ================= */
const wdOrder = () => { const ws = S.cfg.weekStartsOn ?? 1; return Array.from({ length: 7 }, (_, i) => (ws + i) % 7); };
const wdName = (n, long) => new Date(2024, 0, 7 + n).toLocaleDateString('en-US', { weekday: long ? 'long' : 'short' });
const tzShort = (tz) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value; } catch { return tz; } };
function seriesText(se) {
  const days = se.weekdays.map((n) => wdName(n)).join(', ');
  return `${se.intervalWeeks > 1 ? `Every ${se.intervalWeeks} weeks on` : 'Every'} ${days} at ${se.time} (${tzShort(se.tz)})`;
}
const seriesLine = (ev) => { const se = S.series.find((x) => x.id === ev.seriesId); return se ? 'Repeats: ' + seriesText(se) : ''; };

function seriesPanel() {
  if (!isOfficer()) return '';
  const upcoming = (se) => S.events.filter((e) => e.seriesId === se.id && new Date(e.start) > Date.now()).length;
  return `<details class="panel fold" data-fold="series" ${(UI.fold || {}).series ? 'open' : ''}><summary>Recurring events <span class="count-pill">${S.series.length}</span></summary>
    <div class="fold-body">${S.series.length ? S.series.map((se) => `<div class="rule-row">
      <span style="flex:1"><b>${esc(se.title || se.type)}</b> <span class="type-pill">${esc(se.type)}</span><br>
        <span class="muted small">${esc(seriesText(se))} · ${upcoming(se)} upcoming${se.endDate ? ` · until ${fmtLootDate(se.endDate)}` : ''}</span></span>
      <button class="btn sm" data-act="series-edit" data-id="${se.id}">Edit</button></div>`).join('') : '<div class="muted small">No recurring events yet. A recurring event creates its dates by itself, for example every Monday at 21:00.</div>'}
      <button class="btn sm primary" data-act="series-new" style="margin-top:10px">New recurring event</button></div></details>`;
}

function seriesDialog(se) {
  const isNew = !se, st = S.settings, t0 = S.cfg.eventTypes[0];
  se = se || { title: '', type: t0.name, weekdays: [1], intervalWeeks: 1, time: '21:00', tz: S.cfg.defaultTimezone || 'UTC', startDate: todayTz(), endDate: '', description: '', points: t0.points, mandatory: !!t0.mandatory, maxSignups: 0, signupCloseMinutes: st.signupCloseDefault, pinWindowMinutes: st.pinWindowDefault, reminders: true };
  openDialog(`
  <form data-form="series" data-id="${se.id || ''}">
    <h2>${isNew ? 'New recurring event' : 'Edit recurring event'}</h2>
    <div class="field"><label>Title (optional, the type is used when this is empty)</label><input name="title" value="${esc(se.title)}" maxlength="80" placeholder="For example: Boonstone fight"></div>
    <div class="row">
      <div class="field"><label>Type</label><select name="type" id="ev-type">${S.cfg.eventTypes.map((t) => `<option value="${esc(t.name)}" data-pts="${t.points}" data-mand="${t.mandatory ? 1 : 0}" ${t.name === se.type ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Repeats every</label><select name="intervalWeeks">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${n === se.intervalWeeks ? 'selected' : ''}>${n === 1 ? 'week' : n + ' weeks'}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>On these days</label><div class="wd">${wdOrder().map((n) => `<label class="wdbox"><input type="checkbox" name="wd" value="${n}" ${se.weekdays.includes(n) ? 'checked' : ''}> ${wdName(n)}</label>`).join('')}</div></div>
    <div class="row">
      <div class="field"><label>At (time)</label><input name="time" type="time" value="${esc(se.time)}" required></div>
      <div class="field"><label>Time zone</label><select name="tz">${[...new Set([se.tz, ...S.cfg.timezones])].map((z) => `<option value="${esc(z)}" ${z === se.tz ? 'selected' : ''}>${esc(z)} (${esc(tzShort(z))})</option>`).join('')}</select></div>
    </div>
    <div class="muted small" style="margin:-4px 0 10px">The time follows the time zone all year, so "21:00 Europe/Berlin" stays 21:00 there when the clocks change.</div>
    <div class="row">
      <div class="field"><label>First date</label><input name="startDate" type="date" value="${esc(se.startDate)}" required></div>
      <div class="field"><label>Last date (optional)</label><input name="endDate" type="date" value="${esc(se.endDate || '')}"></div>
    </div>
    <div class="row">
      ${pointsOn() ? `<div class="field"><label>Points for attending</label><input name="points" id="ev-pts" type="number" min="0" value="${se.points}"></div>` : ''}
      <div class="field"><label>Max sign-ups (0 = no limit)</label><input name="maxSignups" type="number" min="0" value="${se.maxSignups}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Close sign-ups (minutes before start)</label><input name="signupCloseMinutes" type="number" min="0" max="10080" value="${se.signupCloseMinutes}"></div>
      <div class="field"><label>PIN window (minutes)</label><input name="pinWindowMinutes" type="number" min="1" max="720" value="${se.pinWindowMinutes}"></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:8px"><input type="checkbox" name="reminders" ${se.reminders === false ? '' : 'checked'}> Remind players who have not answered</label>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:12px"><input type="checkbox" name="mandatory" id="ev-mand" ${se.mandatory ? 'checked' : ''}> Mandatory (counts toward "Qualified for loot")</label>
    <div class="field"><label>Details</label><textarea name="description" maxlength="1500" placeholder="Where to meet, what to bring, voice channel">${esc(se.description)}</textarea></div>
    <div class="muted small">Dates are created about ${Math.round((S.cfg.recurrenceHorizonDays || 42) / 7)} weeks ahead. Changing the series changes all upcoming dates (sign-ups are kept). Deleting a single date only skips that date.</div>
    <div class="dlg-actions">
      ${isNew ? '' : '<button type="button" class="btn danger left" data-act="series-delete">Delete series</button>'}
      <button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button>
    </div>
  </form>`);
}
ACTIONS['series-new'] = () => seriesDialog();
ACTIONS['series-edit'] = (el, d) => seriesDialog(byId(S.series, d.id));
ACTIONS['series-delete'] = () => {
  const id = Number($('#dlg form').dataset.id), n = S.events.filter((e) => e.seriesId === id && new Date(e.start) > Date.now()).length;
  if (confirm(`Delete this recurring event and its ${n} upcoming ${n === 1 ? 'date' : 'dates'}? Events that already happened stay.`))
    act(async () => { await api('/api/series/' + id, 'DELETE'); closeDialog(); }, 'Recurring event deleted');
};
FORMS.series = (f, fd, id) => {
  const body = { ...fd, weekdays: [...f.querySelectorAll('input[name=wd]:checked')].map((i) => Number(i.value)), reminders: f.elements.reminders.checked, mandatory: f.elements.mandatory.checked };
  delete body.wd;
  let created = 0;
  act(async () => { const r = await api(id ? '/api/series/' + id : '/api/series', id ? 'PUT' : 'POST', body); created = r.created; closeDialog(); })
    .then((ok) => ok && toast(`Saved. ${created} new ${created === 1 ? 'date was' : 'dates were'} added.`));
};

/* ================= player profile: about me, characters, builds ================= */
const FIELD_LABEL = { name: 'Name', role: 'Role', primaryWeapon: 'Primary weapon', secondaryWeapon: 'Secondary weapon', mode: 'Mode', gearScore: 'Gear score', level: 'Watermark', specialization: 'Specialization', questlogs: 'Questlog links', discord: 'Discord', timezone: 'Time zone', notes: 'Notes', bio: 'Note', availability: 'Availability' };
const fmtVal = (v) => (Array.isArray(v) ? (v.length ? v.map((x) => (x && x.url ? x.url : x)).map(esc).join(', ') : '(none)') : v === '' || v == null ? '(empty)' : esc(String(v)));

function changeSummary(c) {
  const m = c.memberId ? byId(S.members, c.memberId) : null, who = m ? m.name : 'Profile';
  if (c.kind === 'newCharacter') return `<b>New character</b> ${esc(who)} wants to join.`;
  if (c.kind === 'build') return `<b>${esc(who)}</b>: ${c.op === 'add' ? 'add' : c.op === 'update' ? 'change' : 'remove'} the build <b>${esc((c.data && c.data.name) || '')}</b>${c.op !== 'delete' && c.data ? ` (${esc(c.data.mode)}, ${esc(c.data.role)}, ${esc(classFor(c.data.primaryWeapon, c.data.secondaryWeapon) || 'no class')})` : ''}`;
  return `<b>${esc(who)}</b><div class="diff">${Object.entries(c.changes).map(([f, v]) => `<div><span class="muted">${esc(FIELD_LABEL[f] || f)}:</span> ${fmtVal(v.from)} <span class="arrow">→</span> <b>${fmtVal(v.to)}</b></div>`).join('')}</div>`;
}

VIEWS.profile = (key) => viewProfile(key);
// A quick "is this player okay" glance for officers: active warnings and leave status, right on their profile,
// so checking someone over does not mean a separate trip to the Warnings and Leave of absence pages first.
// Shown to officers only (for anyone's profile, including their own); normal members already get their own
// status on the Warnings and Leave pages themselves.
function profileStanding(key) {
  const wn = activeWarn(key);
  const leaves = (S.leaves || []).filter((l) => l.ownerKey === key).sort((a, b) => b.from.localeCompare(a.from));
  const today = guildDate(Date.now());
  const current = leaves.find((l) => l.status === 'approved' && l.from <= today && today <= l.to);
  const pendingLeave = leaves.find((l) => l.status === 'pending');
  const c = S.settings.compliance || {};
  return `<div class="panel" style="margin-bottom:16px"><h3>Standing</h3>
    <div class="rule-row"><span>Active warnings</span><span><b>${wn.length}</b>${isDisqualified(key) ? ' <span class="qtag warn">Disqualified from loot</span>' : (c.disqualifyAt > 0 && wn.length ? ` <span class="muted small">(disqualified from ${c.disqualifyAt})</span>` : '')}</span></div>
    ${wn.length ? wn.map((w) => `<div class="muted small" style="margin:2px 0 0">${fmtShort(w.at)}: ${esc(w.reason)}</div>`).join('') : ''}
    <div class="rule-row" style="margin-top:10px"><span>Leave of absence</span><span>${current ? `<span class="type-pill">Away until ${fmtLootDate(current.to)}</span>` : pendingLeave ? '<span class="st-pill st-open">Waiting for approval</span>' : '<span class="muted small">Not away</span>'}</span></div>
    <div class="muted small" style="margin-top:10px"><a href="#/warnings">All warnings</a> · <a href="#/leave">Leave entries</a></div>
  </div>`;
}
function viewProfile(key) {
  const off = isOfficer();
  // A coach can open their own linked student's profile too, not just an officer - this was the actual bug
  // behind "coaches can't see the full profile": anyone who was neither an officer nor looking at their own
  // profile was silently sent back to their own, with no exception for a coach looking at their own student.
  const canOpen = off || (S.myStudents || []).includes(key);
  if (!key || (!canOpen && key !== S.user.key)) key = S.user.key;
  const own = key === S.user.key, u = S.users.find((x) => x.id === key);
  const name = own ? S.user.name : (u ? u.name : key);
  const profile = S.profiles[key] || {};
  const chars = S.members.filter((m) => m.owner === key).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const pending = S.changes.filter((c) => c.ownerKey === key && c.status === 'pending');
  const recent = S.changes.filter((c) => c.ownerKey === key && c.status !== 'pending').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, 4);
  const need = (g) => !!S.settings.approvals[g] && !off;
  const openReq = S.requests.filter((r) => chars.some((m) => m.id === r.memberId) && ['open', 'approved'].includes(r.status)).length;
  return `
  <div class="page-head"><div class="profile-head">${avatarImg({ id: key, avatar: (u || (own ? S.user : {})).avatar, key })}<div><h1>${own ? 'My profile' : esc(name)}</h1>
      <div class="muted">${own ? esc(S.user.name) : 'Player profile'}${u && u.role === 'officer' ? ' <span class="badge-officer">Officer</span>' : ''}${off ? tagsOf(key).map(tagChip).join('') : ''}</div></div></div>
    ${!own ? '<a class="btn" href="#/member">Back to Member</a>' : ''}</div>

  ${pending.length ? `<div class="panel pending-banner"><h3>Waiting for the leadership</h3>${pending.map((c) => `<div class="rule-row"><span style="flex:1">${changeSummary(c)}</span><button class="btn sm" data-act="change-cancel" data-id="${c.id}">${own ? 'Take back' : 'Remove'}</button></div>`).join('')}
      <div class="muted small" style="margin-top:6px">These changes take effect as soon as an officer approves them. You get a Discord message with the answer.</div></div>` : ''}
  ${recent.length && own ? `<div class="muted small" style="margin-bottom:12px">Latest answers: ${recent.map((c) => `${c.status === 'approved' ? 'approved' : 'not approved'}${c.note ? ` (${esc(c.note)})` : ''}`).join(' · ')}</div>` : ''}
  ${off ? profileStanding(key, own) : ''}

  ${own ? `<div class="panel"><h3>Time zone</h3>
    <div class="muted small" style="margin:-6px 0 10px">All times in the app (calendar, events, PIN windows) are shown in this time zone. Nobody else is affected.</div>
    <form data-form="tzpref" class="link-row"><select name="timezone" aria-label="Time zone" style="min-width:260px">${[...new Set([TZ(), ...S.cfg.timezones])].map((z) => `<option value="${esc(z)}" ${z === TZ() ? 'selected' : ''}>${esc(z)} (${esc(tzShort(z))})</option>`).join('')}</select>
      <button class="btn primary">Save</button><span class="muted small">Now: ${esc(fmtTime(new Date().toISOString()))} ${esc(tzAbbr(Date.now()))}${S.prefs && S.prefs.timezone ? '' : ' (default)'}</span></form></div>` : ''}

  <div class="panel"><h3>Note</h3>
    <form data-form="profile" data-key="${esc(key)}">
      <div class="field"><label for="pf-bio">Note</label><textarea id="pf-bio" name="bio" maxlength="600" placeholder="Anything the leadership should know about you">${esc(profile.bio || '')}</textarea></div>
      <button class="btn primary">Save</button>${need('profile') ? '<span class="muted small" style="margin-left:10px">Changes to your note are checked by the leadership first.</span>' : ''}
    </form></div>

  <div class="page-head" style="margin:24px 0 12px"><h2>${own ? 'My characters' : 'Characters'}</h2>
    ${chars.length ? '' : `<button class="btn primary" data-act="member-new-for" data-key="${esc(key)}">Add character</button>`}</div>
  ${chars.length ? chars.map(charCard).join('') : '<div class="empty">No characters yet. Add your first one with "Add character".</div>'}

  <div class="panel"><h3>${own ? 'My' : 'Their'} numbers</h3>
    <div class="cols">${chars.filter((m) => m.active).map((m) => { const a = attendanceStats(m.id), ln = S.loot.filter((l) => l.memberId === m.id).length;
      return `<div class="col" style="--c:${roleColor(m.role)}"><h3><span>${esc(m.name)}</span></h3><div class="mini"><span>Attendance</span><small>${a.of ? `${a.n}/${a.of} (${a.pct}%)` : 'no data yet'}</small></div>
        <div class="mini"><span>Loot received</span><small>${ln}</small></div>${pointsOn() ? `<div class="mini"><span>Points</span><small>${balance(m.id)}</small></div>` : ''}</div>`; }).join('') || '<div class="muted">Nothing to show yet.</div>'}</div>
    <p class="small" style="margin:12px 0 0"><span class="muted">Open requests:</span> ${openReq} ${!hiddenFromMembers('requests') || off ? '· <a href="#/requests">Lucent and item requests</a>' : ''}</p></div>`;
}

function charCard(m) {
  const canChange = canEdit(m);
  return `<div class="panel char-card ${m.active ? '' : 'dim'}">
    <div class="ev-title"><div><h3 style="margin:0">${esc(m.name)} ${roleChip(m.role)}${m.pendingApproval ? ' <span class="type-pill">waiting for approval</span>' : m.active ? '' : ' <span class="type-pill">inactive</span>'}</h3>
        <div class="muted small">${esc(m.rank)} · ${esc(m.mode || 'PvE')} · Gear score ${m.gearScore || '-'} · Watermark ${m.level || '-'}</div></div>
      ${canChange ? `<span class="seg"><button class="btn sm" data-act="member-edit" data-id="${m.id}">Edit</button>${(m.builds || []).length < 6 ? `<button class="btn sm" data-act="build-new" data-m="${m.id}">Add build</button>` : ''}</span>` : ''}</div>
    <div style="margin-top:8px">${weaponLine(m)}</div>
    <div class="small" style="margin-top:6px"><span class="muted">Questlog:</span> ${questlogLinks(m, ' · ')}</div>
    ${m.notes ? `<div class="small muted" style="margin-top:6px">${esc(m.notes)}</div>` : ''}
    ${(m.builds || []).length ? `<div class="builds"><div class="muted small" style="margin-bottom:4px">Other builds</div>${m.builds.map((b) => `<div class="build-row"><span class="type-pill">${esc(b.mode)}</span> <b>${esc(b.name)}</b> ${roleChip(b.role)}
        <span class="muted">${esc([classFor(b.primaryWeapon, b.secondaryWeapon), b.specialization].filter(Boolean).join(' | ') || [b.primaryWeapon, b.secondaryWeapon].filter(Boolean).join(' / '))}</span>${b.gearScore ? ` <span class="muted small">GS ${b.gearScore}</span>` : ''}
        ${canChange ? `<button class="btn sm" data-act="build-edit" data-m="${m.id}" data-b="${b.id}">Edit</button>` : ''}</div>`).join('')}</div>` : ''}
  </div>`;
}
ACTIONS['member-new-for'] = (el, d) => { memberDialog(); if (d.key !== S.user.key && isOfficer()) { const o = $('#dlg [name=owner]'); if (o) o.value = d.key; } };
ACTIONS['ql-add'] = () => { const rows = $('#ql-rows'); if (rows.children.length < 6) rows.insertAdjacentHTML('beforeend', qlRow({})); };
ACTIONS['ql-remove'] = (el) => { const rows = $('#ql-rows'); if (rows.children.length > 1) el.closest('.ql-row').remove(); else el.closest('.ql-row').querySelectorAll('input').forEach((i) => (i.value = '')); };
ACTIONS['change-cancel'] = (el, d) => { if (confirm('Take this change back?')) act(() => api('/api/changes/' + d.id, 'DELETE'), 'Removed'); };
FORMS.profile = (f, fd) => {
  const body = { bio: fd.bio };
  let pending = [];
  act(async () => { const r = await api('/api/profile/' + enc(f.dataset.key), 'PUT', body); pending = r.approvalPending || []; })
    .then((ok) => ok && toast(pending.length ? 'Saved. The leadership has to approve it first.' : 'Saved'));
};
FORMS.tzpref = (f, fd) => act(() => api('/api/prefs', 'PUT', { timezone: fd.timezone }), 'Time zone saved. All times now use it.');

function buildDialog(memberId, b) {
  const isNew = !b, m = byId(S.members, memberId);
  b = b || { name: '', mode: (S.cfg.buildModes || ['PvE'])[0], role: m.role, primaryWeapon: '', secondaryWeapon: '', specialization: '', gearScore: '', notes: '' };
  openDialog(`
  <form data-form="build" data-m="${m.id}" data-b="${b.id || ''}">
    <h2>${isNew ? 'Add a build' : 'Edit build'} <span class="muted small">for ${esc(m.name)}</span></h2>
    <div class="row">
      <div class="field"><label>Name of the build</label><input name="name" value="${esc(b.name)}" maxlength="30" placeholder="For example: PvP healer"></div>
      <div class="field"><label>Used for</label><select name="mode">${opts(S.cfg.buildModes || ['PvE'], b.mode)}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Role</label><select name="role">${opts(S.cfg.roles, b.role)}</select></div>
      <div class="field"><label>Gear score</label><input name="gearScore" type="number" min="0" value="${b.gearScore}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Primary weapon</label><select name="primaryWeapon">${opts(S.cfg.weapons, b.primaryWeapon, 'None')}</select></div>
      <div class="field"><label>Secondary weapon</label><select name="secondaryWeapon">${opts(S.cfg.weapons, b.secondaryWeapon, 'None')}</select></div>
    </div>
    <div class="muted small" id="class-preview" style="margin:-4px 0 10px">${esc(classPreviewText(b.primaryWeapon, b.secondaryWeapon))}</div>
    <div class="field"><label>Specialization (type anything)</label><input name="specialization" value="${esc(b.specialization || '')}" maxlength="40"></div>
    <div class="field"><label>Notes</label><input name="notes" value="${esc(b.notes || '')}" maxlength="200"></div>
    ${!isOfficer() && S.settings.approvals.builds ? '<div class="muted small">Builds are checked by the leadership before they show up.</div>' : ''}
    <div class="dlg-actions">${isNew ? '' : '<button type="button" class="btn danger left" data-act="build-delete">Delete</button>'}
      <button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div>
  </form>`);
}
ACTIONS['build-new'] = (el, d) => buildDialog(Number(d.m));
ACTIONS['build-edit'] = (el, d) => buildDialog(Number(d.m), byId(byId(S.members, d.m).builds, d.b));
ACTIONS['build-delete'] = () => {
  const f = $('#dlg form');
  if (!confirm('Delete this build?')) return;
  let pending = false;
  act(async () => { const r = await api(`/api/members/${f.dataset.m}/builds/${f.dataset.b}`, 'DELETE'); pending = !!r.approvalPending; closeDialog(); })
    .then((ok) => ok && toast(pending ? 'Sent to the leadership for approval' : 'Build deleted'));
};
FORMS.build = (f, fd) => {
  const b = f.dataset.b;
  let pending = false;
  act(async () => { const r = await api(`/api/members/${f.dataset.m}/builds${b ? '/' + b : ''}`, b ? 'PUT' : 'POST', fd); pending = !!r.approvalPending; closeDialog(); })
    .then((ok) => ok && toast(pending ? 'Sent to the leadership for approval' : 'Build saved'));
};

/* ================= tags (leadership only) ================= */
ACTIONS['tags-edit'] = (el, d) => {
  const key = d.key, have = new Set(S.playerTags[key] || []);
  openDialog(`<form data-form="playertags" data-key="${esc(key)}"><h2>Tags for ${esc(ownerName(key))}</h2>
    <div class="muted small" style="margin:-8px 0 12px">Only the leadership sees tags. They belong to the player, so they show on all of their characters.</div>
    ${S.tags.length ? S.tags.map((t) => `<label class="tagpick"><input type="checkbox" name="tag" value="${t.id}" ${have.has(t.id) ? 'checked' : ''}> ${tagChip(t)}</label>`).join('') : '<div class="muted">There are no tags yet. Create them in Admin under "Player tags".</div>'}
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div></form>`);
};
FORMS.playertags = (f) => act(async () => { await api('/api/player-tags/' + enc(f.dataset.key), 'PUT', { tags: [...f.querySelectorAll('input[name=tag]:checked')].map((i) => Number(i.value)) }); closeDialog(); }, 'Tags saved');

/* ================= requests: Lucent and items ================= */
const buildOptionsFor = (m) => `<option value="main">Main: ${esc(classOf(m) || 'no class')} (${esc(m.role)})</option>${(m.builds || []).map((b) => `<option value="${b.id}">${esc(b.name)}: ${esc(classFor(b.primaryWeapon, b.secondaryWeapon) || 'no class')} (${esc(b.mode)})</option>`).join('')}`;
const buildName = (m, key) => { if (!m) return ''; if (key === 'main') return 'Main build'; const b = (m.builds || []).find((x) => String(x.id) === String(key)); return b ? b.name : '(deleted build)'; };
const REQ_STATUS = { open: 'Open', approved: 'Approved', rejected: 'Not approved', given: 'Handed over' };

VIEWS.requests = () => {
  const off = isOfficer(), own = mine(), q = UI.reqQ.toLowerCase();
  const list = S.requests.filter((r) => (!UI.reqStatus || r.status === UI.reqStatus) && (!q || `${r.item} ${r.reason} ${(byId(S.members, r.memberId) || {}).name || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.at.localeCompare(a.at));
  const first = own[0];
  return `
  <div class="page-head"><div><h1>Requests</h1><div class="muted">Ask the leadership for Lucent or an item, for a specific build.${off ? '' : ' You only see your own requests.'}</div></div></div>
  ${own.length ? `<div class="panel" style="margin-bottom:16px"><h3>New request</h3>
    <form data-form="request" class="loot-form">
      <div class="field"><label for="rq-m">Character</label><select id="rq-m" name="memberId" data-act="req-char">${own.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="rq-b">Build</label><select id="rq-b" name="buildKey">${buildOptionsFor(first)}</select></div>
      <div class="field"><label for="rq-k">I need</label><select id="rq-k" name="kind" data-act="req-kind">${(S.cfg.requestKinds || ['Lucent', 'Item']).map((k) => `<option>${esc(k)}</option>`).join('')}</select></div>
      <div class="field" id="rq-lucent"><label for="rq-a">Amount of Lucent</label><input id="rq-a" name="amount" type="number" min="1" placeholder="1000"></div>
      <div class="field wide hidden" id="rq-item"><label for="rq-i">Item</label><div style="display:flex;gap:8px"><select name="lootType" style="width:auto">${S.cfg.lootTypes.filter((t) => t !== 'Lucent').map((t) => `<option ${t === S.cfg.lootDefaultType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><input id="rq-i" name="item" maxlength="120" placeholder="Item name"></div></div>
      <div class="field wide"><label for="rq-r">Why do you need it? (optional)</label><input id="rq-r" name="reason" maxlength="300" placeholder="For my PvP set, to finish the enchanting"></div>
      <button class="btn primary">Send request</button>
    </form></div>` : '<div class="empty">Add a character on your profile page to make requests.</div>'}
  <div class="toolbar">
    <select data-ui="reqStatus" aria-label="Status"><option value="">All statuses</option>${Object.entries(REQ_STATUS).map(([k, v]) => `<option value="${k}" ${UI.reqStatus === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <input type="search" placeholder="Search" value="${esc(UI.reqQ)}" data-ui="reqQ" aria-label="Search requests">
    <span class="muted small">${list.length} ${list.length === 1 ? 'request' : 'requests'}</span>
  </div>
  ${list.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Sent</th><th>Character and build</th><th>Request</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map((r) => { const m = byId(S.members, r.memberId); return `<tr>
      <td class="nowrap muted small">${fmtShort(r.at)}</td>
      <td><b>${esc(m ? m.name : '(removed)')}</b> ${m ? roleChip(m.role) : ''}<div class="muted small">${esc(buildName(m, r.buildKey))}${off && m ? ` · ${esc(ownerName(m.owner))}` : ''}</div></td>
      <td>${r.kind === 'Lucent' ? `<b>${Number(r.amount).toLocaleString()}</b> Lucent` : `${esc(r.item)} <span class="type-pill t-${esc(r.lootType)}">${esc(r.lootType)}</span>`}${r.reason ? `<div class="muted small">${esc(r.reason)}</div>` : ''}</td>
      <td><span class="st-pill st-${r.status}">${REQ_STATUS[r.status]}</span>${r.note ? `<div class="muted small">${esc(r.note)}${r.decidedBy ? ` (${esc(r.decidedBy)})` : ''}</div>` : ''}</td>
      <td class="nowrap">${off && (r.status === 'open' || r.status === 'approved') ? `${r.status === 'open' ? `<button class="btn sm" data-act="req-set" data-id="${r.id}" data-s="approved">Approve</button> ` : ''}<button class="btn sm" data-act="req-set" data-id="${r.id}" data-s="given">${r.kind === 'Item' ? 'Handed over' : 'Paid out'}</button> <button class="btn sm danger" data-act="req-set" data-id="${r.id}" data-s="rejected">Reject</button>` : ''}
        ${(r.status === 'open' && (r.byKey === S.user.key || off)) ? `<button class="btn sm" data-act="req-del" data-id="${r.id}">${off ? 'Delete' : 'Withdraw'}</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
    : `<div class="empty">${S.requests.length ? 'Nothing matches.' : 'No requests yet.'}</div>`}
  ${off ? '<p class="muted small">"Handed over" (or "Paid out" for Lucent) adds the entry to the Loot section by itself. Players get a Discord message when you decide.</p>' : ''}`;
};
CHANGES['req-char'] = (el) => { const m = byId(S.members, el.value); $('#rq-b').innerHTML = m ? buildOptionsFor(m) : ''; };
CHANGES['req-kind'] = (el) => { $('#rq-lucent').classList.toggle('hidden', el.value !== 'Lucent'); $('#rq-item').classList.toggle('hidden', el.value === 'Lucent'); };
FORMS.request = (f, fd) => act(async () => { await api('/api/requests', 'POST', fd); }, 'Request sent');
ACTIONS['req-set'] = (el, d) => {
  const note = d.s === 'rejected' ? prompt('Reason for the player (optional)', '') : '';
  if (note === null) return;
  act(() => api('/api/requests/' + d.id, 'PUT', { status: d.s, note }), 'Saved');
};
ACTIONS['req-del'] = (el, d) => { if (confirm('Remove this request?')) act(() => api('/api/requests/' + d.id, 'DELETE'), 'Removed'); };

/* ================= approvals (leadership) ================= */
VIEWS.approvals = () => {
  const pending = S.changes.filter((c) => c.status === 'pending').sort((a, b) => a.at.localeCompare(b.at));
  const done = S.changes.filter((c) => c.status !== 'pending').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, 15);
  const leaves = S.leaves.filter((l) => l.status === 'pending').sort((a, b) => a.at.localeCompare(b.at));
  const reasons = S.explanations.filter((x) => x.status === 'pending').sort((a, b) => a.at.localeCompare(b.at));
  const apps = S.applications.filter((a) => a.status === 'pending').sort((a, b) => a.at.localeCompare(b.at));
  const appsDone = S.applications.filter((a) => a.status !== 'pending' && a.status !== 'withdrawn').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, 6);
  const none = !pending.length && !leaves.length && !reasons.length && !apps.length;
  return `
  <div class="page-head"><div><h1>Approvals</h1><div class="muted">Everything players sent that needs your OK. What needs approval is set in Admin.</div></div></div>
  ${none ? '<div class="empty">Nothing is waiting for approval.</div>' : ''}
  ${apps.length ? `<h3 class="sec">Applications to join the guild</h3>${apps.map((a) => `<div class="panel"><div class="ev-title"><div style="min-width:0">
      <div class="muted small">${avatarImg({ id: a.userKey, avatar: a.avatar })} ${esc(a.name)}${a.username ? ` (${esc(a.username)})` : ''} · ${fmtShort(a.at)}</div>
      <b>${esc(a.character.name)}</b> ${roleChip(a.character.role)} <span class="muted">${esc(classFor(a.character.primaryWeapon, a.character.secondaryWeapon) || [a.character.primaryWeapon, a.character.secondaryWeapon].filter(Boolean).join(' / ') || 'no weapons given')}${a.character.specialization ? ' | ' + esc(a.character.specialization) : ''}</span>
      <div class="small muted">Gear score ${a.character.gearScore || '-'} · Watermark ${a.character.level || '-'}${(a.character.questlogs || []).length ? ' · ' + questlogLinks(a.character, ' · ') : ''}</div>
      <div style="white-space:pre-wrap;margin-top:6px">${esc(a.about)}</div></div>
      <span class="seg"><button class="btn sm primary" data-act="app-decide" data-id="${a.id}" data-d="accept">Accept</button><button class="btn sm danger" data-act="app-decide" data-id="${a.id}" data-d="reject">Reject</button></span></div></div>`).join('')}` : ''}
  ${reasons.length ? `<h3 class="sec">Reasons for missed events</h3>${reasons.map((x) => `<div class="panel"><div class="ev-title"><div><div class="muted small">${esc(x.name)} · ${fmtShort(x.at)}</div>
      <div class="small" style="margin:2px 0 6px">${x.triggers.map((t) => esc(triggerText(t))).join(' · ')}</div><div style="white-space:pre-wrap">${esc(x.reason)}</div></div>
      <span class="seg"><button class="btn sm primary" data-act="expl-decide" data-id="${x.id}" data-d="approved">Accept</button><button class="btn sm danger" data-act="expl-decide" data-id="${x.id}" data-d="rejected">Reject</button></span></div></div>`).join('')}` : ''}
  ${leaves.length ? `<h3 class="sec">Leave of absence</h3>${leaves.map((l) => `<div class="panel"><div class="ev-title"><div><div class="muted small">${esc(l.name)} · ${fmtShort(l.at)}</div>
      <b>${fmtLootDate(l.from)} to ${fmtLootDate(l.to)}</b> <span class="muted">(${dayCount(l)} days)</span>${l.reason ? `<div class="small">${esc(l.reason)}</div>` : ''}</div>
      <span class="seg"><button class="btn sm primary" data-act="leave-decide" data-id="${l.id}" data-d="approved">Approve</button><button class="btn sm danger" data-act="leave-decide" data-id="${l.id}" data-d="rejected">Reject</button></span></div></div>`).join('')}` : ''}
  ${pending.length ? `<h3 class="sec">Changes to characters and profiles</h3>${pending.map((c) => `<div class="panel"><div class="ev-title"><div><div class="muted small">${esc(ownerName(c.ownerKey))} · ${fmtShort(c.at)}</div>${changeSummary(c)}</div>
      <span class="seg"><button class="btn sm primary" data-act="change-decide" data-id="${c.id}" data-d="approve">Approve</button><button class="btn sm danger" data-act="change-decide" data-id="${c.id}" data-d="reject">Reject</button></span></div></div>`).join('')}` : ''}
  ${appsDone.length ? `<h3 class="sec" style="margin-top:28px">Recent applications</h3><div class="tbl-wrap"><table><tbody>${appsDone.map((a) => `<tr><td class="muted small nowrap">${fmtShort(a.decidedAt)}</td><td><b>${esc(a.name)}</b> <span class="muted">(${esc(a.character.name)})</span></td><td><span class="st-pill ${a.status === 'accepted' ? 'st-approved' : 'st-rejected'}">${a.status === 'accepted' ? 'Accepted' : 'Rejected'}</span>${a.note ? `<div class="muted small">${esc(a.note)}</div>` : ''}${a.roleResult && a.roleResult !== 'given' ? `<div class="small" style="color:var(--danger)">Discord role: ${esc(a.roleResult)}</div>` : a.roleResult === 'given' ? '<div class="muted small">Discord member role given</div>' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
  ${done.length ? `<h3 class="sec" style="margin-top:28px">Recently decided</h3><div class="tbl-wrap"><table><tbody>${done.map((c) => `<tr><td class="muted small nowrap">${fmtShort(c.decidedAt)}</td><td>${esc(ownerName(c.ownerKey))}</td><td>${changeSummary(c)}</td>
      <td><span class="st-pill st-${c.status === 'approved' ? 'approved' : 'rejected'}">${c.status === 'approved' ? 'Approved' : 'Not approved'}</span>${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
};
const dayCount = (l) => Math.round((Date.parse(l.to) - Date.parse(l.from)) / 864e5) + 1;
const triggerText = (t) => ({ noshow: `${t.value} no-shows (limit ${t.limit})`, noreply: `${t.value} events without an answer (limit ${t.limit})`, attendance: `attendance ${t.value}% (minimum ${t.limit}%)` }[t.kind] || t.kind);
ACTIONS['change-decide'] = (el, d) => {
  const note = d.d === 'reject' ? prompt('Reason for the player (optional)', '') : '';
  if (note === null) return;
  act(() => api(`/api/changes/${d.id}/decide`, 'POST', { decision: d.d, note }), d.d === 'approve' ? 'Approved' : 'Rejected');
};
ACTIONS['expl-decide'] = (el, d) => {
  const note = d.d === 'rejected' ? prompt('What should the player know? (optional)', '') : '';
  if (note === null) return;
  act(() => api('/api/explanations/' + d.id, 'PUT', { status: d.d, note }), d.d === 'approved' ? 'Accepted' : 'Rejected. The player is asked again.');
};
ACTIONS['leave-decide'] = (el, d) => {
  const note = d.d === 'rejected' ? prompt('Reason for the player (optional)', '') : '';
  if (note === null) return;
  act(() => api('/api/leaves/' + d.id, 'PUT', { status: d.d, note }), d.d === 'approved' ? 'Approved' : 'Rejected');
};

/* ================= attendance: how often did a player come, not show up, or not answer ================= */
Object.assign(UI, { attFlag: '' });
const ATT_STATUS = { attended: ['Came', 'st-approved'], noshow: ['No-show', 'st-rejected'], declined: ["Said can't", 'st-given'], noreply: ['No reply', 'st-open'], leave: ['On leave', ''] };

// Past events where an officer took roll, within the chosen period.
function attEvents() {
  const days = UI.attDays === 'all' ? null : Number(UI.attDays);
  return S.events.filter((e) => new Date(e.start) < Date.now() && rolled(e) && (!UI.attMand || e.mandatory) && (!days || new Date(e.start) >= Date.now() - days * 864e5));
}
// One row per player (all of their active characters together).
//   Came      = one of their characters attended
//   No-show   = said Going with a character, but none of them attended
//   No reply  = never answered Going or Can't with any character
function attRows(evs) {
  const off = isOfficer(), ls = lootSettings(), byOwner = new Map();
  for (const m of S.members.filter((x) => x.active && (off || x.owner === S.user.key))) { if (!byOwner.has(m.owner)) byOwner.set(m.owner, []); byOwner.get(m.owner).push(m); }
  return [...byOwner].map(([owner, chars]) => {
    const ids = chars.map((c) => c.id), list = [];
    let n = 0, noshow = 0, noreply = 0, declined = 0, total = 0;
    for (const e of evs) {
      if (onLeaveAt(owner, new Date(e.start).getTime())) { list.push({ e, status: 'leave', answer: '-' }); continue; }       // away with the leadership's OK: not judged
      total++;
      const answers = ids.map((id) => e.rsvps[id]), going = answers.includes('yes'), no = answers.includes('no');
      const attended = ids.some((id) => e.attended.includes(id));
      if (!going && !no) noreply++;
      let status;
      if (attended) { status = 'attended'; n++; } else if (going) { status = 'noshow'; noshow++; } else if (no) { status = 'declined'; declined++; } else status = 'noreply';
      list.push({ e, status, answer: going ? 'Going' : no ? "Can't" : 'no answer' });
    }
    const pct = total ? Math.floor(100 * n / total) : null;
    const last = S.events.filter((e) => ids.some((id) => e.attended.includes(id))).map((e) => e.start).sort().pop();
    return { owner, name: ownerName(owner), chars, n, total, noshow, noreply, declined, pct, band: pct === null ? 'none' : bandOf(pct, ls), last, bal: ids.reduce((a, id) => a + balance(id), 0), list };
  });
}

VIEWS.points = () => {
  const off = isOfficer(), ls = lootSettings(), q = UI.attQ.toLowerCase();
  const evs = attEvents(), days = UI.attDays === 'all' ? null : Number(UI.attDays);
  const rows = attRows(evs).filter((r) => (!UI.attRole || r.chars.some((c) => c.role === UI.attRole)) && (!UI.attBand || r.band === UI.attBand)
    && (!UI.attFlag || (UI.attFlag === 'noshow' ? r.noshow > 0 : r.noreply > 0)) && (!q || `${r.name} ${r.chars.map((c) => `${c.name} ${classOf(c)}`).join(' ')}`.toLowerCase().includes(q)));
  const sorts = {
    name: (a, b) => a.name.localeCompare(b.name),
    rateDesc: (a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.name.localeCompare(b.name),
    rateAsc: (a, b) => (a.pct ?? 101) - (b.pct ?? 101) || a.name.localeCompare(b.name),
    attended: (a, b) => b.n - a.n || a.name.localeCompare(b.name),
    noshow: (a, b) => b.noshow - a.noshow || a.name.localeCompare(b.name),
    noreply: (a, b) => b.noreply - a.noreply || a.name.localeCompare(b.name),
    points: (a, b) => b.bal - a.bal || a.name.localeCompare(b.name),
    last: (a, b) => (b.last || '').localeCompare(a.last || ''),
  };
  rows.sort(sorts[UI.attSort] || sorts.name);
  const showPts = pointsOn();
  const focus = UI.pointsFocus ? byId(S.members, UI.pointsFocus) : null;
  const ledger = S.points.filter((p) => !focus || p.memberId === focus.id).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 60);
  const active = S.members.filter((m) => m.active).sort((a, b) => a.name.localeCompare(b.name));
  const bad = (n) => (n ? `<b class="cnt-bad">${n}</b>` : '<span class="muted">0</span>');
  const warn = (n) => (n ? `<b class="cnt-warn">${n}</b>` : '<span class="muted">0</span>');
  return `
  <div class="page-head"><div><h1>${showPts ? 'Attendance and points' : 'Attendance'}</h1>
    <div class="muted">Based on ${evs.length} ${evs.length === 1 ? 'event' : 'events'} with recorded attendance ${days ? `in the last ${days} days` : 'in total'}${UI.attMand ? ' (mandatory only)' : ''}. Click a row for the event-by-event list.${off ? '' : ' You only see yourself.'}</div></div></div>
  <div class="toolbar">
    ${off ? `<input type="search" placeholder="Search player, character or class" value="${esc(UI.attQ)}" data-ui="attQ" aria-label="Search">
    <select data-ui="attRole" aria-label="Role">${opts(S.cfg.roles, UI.attRole, 'All roles')}</select>` : ''}
    <select data-ui="attDays" aria-label="Period">${[['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']].map(([v, l]) => `<option value="${v}" ${UI.attDays === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" data-ui="attMand" ${UI.attMand ? 'checked' : ''}> Mandatory only</label>
    ${off ? `<select data-ui="attBand" aria-label="Attendance colour"><option value="">Any attendance</option><option value="red" ${UI.attBand === 'red' ? 'selected' : ''}>Red (0-${ls.redMax}%)</option><option value="orange" ${UI.attBand === 'orange' ? 'selected' : ''}>Orange (${ls.redMax + 1}-${ls.orangeMax}%)</option><option value="green" ${UI.attBand === 'green' ? 'selected' : ''}>Green (${ls.orangeMax + 1}-100%)</option></select>
    <select data-ui="attFlag" aria-label="Problems"><option value="">Everybody</option><option value="noshow" ${UI.attFlag === 'noshow' ? 'selected' : ''}>With no-shows</option><option value="noreply" ${UI.attFlag === 'noreply' ? 'selected' : ''}>With unanswered events</option></select>` : ''}
    <select data-ui="attSort" aria-label="Sort by">${[['name', 'Sort: name'], ['rateDesc', 'Sort: best attendance'], ['rateAsc', 'Sort: worst attendance'], ['attended', 'Sort: most events'], ['noshow', 'Sort: most no-shows'], ['noreply', 'Sort: most unanswered'], ['last', 'Sort: last seen'], ...(showPts ? [['points', 'Sort: points']] : [])].map(([v, l]) => `<option value="${v}" ${UI.attSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span class="muted small">${rows.length} shown</span>
  </div>
  ${rows.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Player</th><th style="min-width:210px">Attendance</th><th class="num">Events came to</th><th class="num" title="Said Going, but did not show up">No-shows</th><th class="num" title="Did not answer Going or Can't">No reply</th><th>Last seen</th>${showPts ? '<th class="num">Points</th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="click" data-act="att-detail" data-key="${esc(r.owner)}">
      <td><b>${esc(r.name)}</b><div class="chips-sm">${r.chars.map((c) => `<span class="chip small" style="--c:${roleColor(c.role)}">${esc(c.name)}</span>`).join('')}</div></td>
      <td><div class="attcell"><span class="rate ${r.band}">${r.pct === null ? '-' : r.pct + '%'}</span><div class="attbar"><i class="${r.band}" style="width:${r.pct ?? 0}%"></i></div></div></td>
      <td class="num">${r.total ? `${r.n} / ${r.total}` : '-'}${r.total < evs.length ? `<div class="muted small">${evs.length - r.total} on leave</div>` : ''}</td><td class="num">${bad(r.noshow)}</td><td class="num">${warn(r.noreply)}</td>
      <td class="muted small nowrap">${r.last ? fmtShort(r.last) : '-'}</td>${showPts ? `<td class="num ${r.bal > 0 ? 'pos' : r.bal < 0 ? 'neg' : ''}">${r.bal}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">Nobody matches these filters.</div>'}
  ${showPts && off ? `<div class="panel" style="margin-top:20px"><h3>Adjust points</h3>
    <form data-form="points" class="toolbar" style="margin:0">
      <select name="memberId" required aria-label="Character" style="min-width:180px">${active.map((m) => `<option value="${m.id}" ${focus && focus.id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <input name="delta" type="number" placeholder="+5 or -10" required style="width:110px" aria-label="Amount">
      <input name="reason" list="reasons" placeholder="Reason" style="flex:1;min-width:160px" aria-label="Reason">
      <datalist id="reasons">${S.cfg.pointReasons.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <button class="btn primary">Add entry</button></form></div>` : ''}
  ${showPts ? `<div class="panel" style="margin-top:16px"><div class="ev-title"><h3>${off ? 'Points ledger' : 'Your points'}</h3>
    ${off ? `<select data-ui="pointsFocus" aria-label="Ledger of" style="width:auto"><option value="">Everybody</option>${active.map((m) => `<option value="${m.id}" ${focus && focus.id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}</div>
    ${ledger.length ? `<div class="tbl-wrap" style="border:0"><table><tbody>${ledger.map((p) => { const m = byId(S.members, p.memberId);
      return `<tr><td class="muted small" style="white-space:nowrap">${fmtShort(p.at)}</td><td>${esc(m ? m.name : '?')}</td><td>${esc(p.reason)}</td><td class="num ${p.delta > 0 ? 'pos' : 'neg'}">${p.delta > 0 ? '+' : ''}${p.delta}</td>
        <td>${off && !p.eventId ? `<button class="btn sm" data-act="points-del" data-id="${p.id}" aria-label="Delete entry">×</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="muted">No entries yet.</div>'}</div>` : ''}`;
};
ACTIONS['att-detail'] = (el, d) => {
  const r = attRows(attEvents()).find((x) => x.owner === d.key);
  if (!r) return;
  openDialog(`<h2>${esc(r.name)}</h2>
    <div class="muted small" style="margin:-8px 0 12px">${r.chars.map((c) => esc(c.name)).join(', ')} · came to ${r.n} of ${r.total} events (${r.pct ?? 0}%) · ${r.noshow} no-show · ${r.noreply} without an answer · ${r.declined} said they can't</div>
    ${r.list.length ? `<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Answered</th><th>Result</th></tr></thead><tbody>${r.list.slice().sort((a, b) => b.e.start.localeCompare(a.e.start)).map((x) => `<tr>
      <td class="muted small nowrap">${fmtShort(x.e.start)}</td><td>${esc(x.e.title)}${x.e.mandatory ? ' <span class="pill-m">Mandatory</span>' : ''}</td><td>${esc(x.answer)}</td>
      <td><span class="st-pill ${ATT_STATUS[x.status][1]}">${ATT_STATUS[x.status][0]}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">No events with recorded attendance in this period.</div>'}
    <div class="dlg-actions"><button class="btn primary" data-act="dlg-close">Close</button></div>`, true);
};

/* ================= dashboard you can personalise ================= */
const DASH_PANELS = [
  { key: 'announcement', label: 'Announcement' }, { key: 'stats', label: 'Guild name and numbers' }, { key: 'loot', label: 'Qualified for loot' },
  { key: 'leadership', label: 'Leadership' }, { key: 'next', label: 'Next event' },
  { key: 'info', label: 'Info section (stays under Next event)', fixed: true },
];
function dashPrefs() {
  const p = isOfficer() ? (S.prefs || {}) : {}, keys                       // only the leadership arranges the dashboard; everybody else sees the standard layout
  = DASH_PANELS.filter((x) => !x.fixed).map((x) => x.key);
  const order = [...(p.dashboardOrder || []).filter((k) => keys.includes(k)), ...keys.filter((k) => !(p.dashboardOrder || []).includes(k))];
  return { order, hidden: new Set(p.dashboardHidden || []) };
}
function heroHtml() {
  const b = brand();
  return `<div class="guild-hero">${b.icon ? `<img class="hero-icon" src="${esc(b.icon)}" alt="">` : ''}<div><div class="hero-name">${esc(guildName())}</div>${guildTag() ? `<div class="hero-tag">${esc(guildTag())}</div>` : ''}</div></div>`;
}
function statsHtml() {
  const active = S.members.filter((m) => m.active), players = new Set(active.map((m) => m.owner)).size, cap = S.cfg.guildCap || 0;
  const tiles = S.cfg.roles.map((r) => { const n = active.filter((m) => m.role === r).length; return { r, n, pct: active.length ? Math.round(100 * n / active.length) : 0 }; });
  return `<div class="stats" style="margin:0">
    <div class="stat"><div class="k">Members</div><div class="v">${active.length}${cap ? `<small> / ${cap}</small>` : ''}</div>${cap ? `<div class="bar"><i style="width:${Math.min(100, 100 * active.length / cap)}%"></i></div>` : ''}<div class="s">${players} ${players === 1 ? 'player' : 'players'}</div></div>
    ${tiles.map((t) => `<div class="stat" style="--c:${roleColor(t.r)}"><div class="k">${esc(t.r)}</div><div class="v">${t.n}</div><div class="bar"><i style="width:${t.pct}%"></i></div><div class="s">${t.pct}% of the guild</div></div>`).join('')}</div>`;
}

// Small section under "Next event": categories with buttons; each button opens a popup with text the leadership wrote.
function infoPanel() {
  const cats = (S.infoBoard && S.infoBoard.categories) || [];
  return `<div class="panel info"><div class="ev-title"><h3>${esc((S.infoBoard && S.infoBoard.title) || 'Info')}</h3>${isOfficer() ? '<button class="btn sm" data-act="info-edit">Edit</button>' : ''}</div>
    ${cats.length ? cats.map((c, ci) => `<div class="info-cat"><div class="info-title">${esc(c.title)}</div><div class="info-btns">${c.buttons.map((b, bi) => `<button class="btn sm" data-act="info-open" data-c="${ci}" data-b="${bi}">${esc(b.label)}</button>`).join('')}</div></div>`).join('')
      : '<div class="muted small">Add categories and buttons with "Edit". Every button opens a popup with your own text.</div>'}</div>`;
}
ACTIONS['info-open'] = (el, d) => {
  const b = S.infoBoard.categories[d.c].buttons[d.b];
  openDialog(`<h2>${esc(b.label)}</h2><div class="info-text">${linkify(b.text) || '<span class="muted">(no text yet)</span>'}</div><div class="dlg-actions"><button class="btn primary" data-act="dlg-close">Close</button></div>`);
};
const ieBtn = (b) => `<div class="ie-btn"><div class="ie-row"><input class="ie-label" maxlength="40" value="${esc(b.label || '')}" placeholder="Button label" aria-label="Button label"><button type="button" class="x" data-act="info-del-btn" aria-label="Remove button">×</button></div>
  <textarea class="ie-text" maxlength="3000" placeholder="Text shown in the popup" aria-label="Popup text">${esc(b.text || '')}</textarea></div>`;
const ieCat = (c) => `<div class="ie-cat"><div class="ie-row"><input class="ie-title" maxlength="40" value="${esc(c.title || '')}" placeholder="Category name" aria-label="Category name"><button type="button" class="x" data-act="info-del-cat" aria-label="Remove category">×</button></div>
  <div class="ie-btns">${(c.buttons || []).map(ieBtn).join('')}</div><button type="button" class="btn sm" data-act="info-add-btn">+ Add button</button></div>`;
ACTIONS['info-edit'] = () => openDialog(`<form data-form="infoboard"><h2>Info section</h2>
  <div class="field"><label for="ie-name">Name of this section</label><input id="ie-name" name="title" value="${esc((S.infoBoard && S.infoBoard.title) || 'Info')}" maxlength="40" placeholder="Info" required></div>
  <div class="muted small" style="margin:-8px 0 12px">A category groups buttons. Every button opens a popup with its text. Web addresses starting with https:// become clickable.</div>
  <div id="ie-cats">${S.infoBoard.categories.map(ieCat).join('')}</div><button type="button" class="btn sm" data-act="info-add-cat">+ Add category</button>
  <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div></form>`, true);
ACTIONS['info-add-cat'] = () => $('#ie-cats').insertAdjacentHTML('beforeend', ieCat({ buttons: [{}] }));
ACTIONS['info-add-btn'] = (el) => el.closest('.ie-cat').querySelector('.ie-btns').insertAdjacentHTML('beforeend', ieBtn({}));
ACTIONS['info-del-cat'] = (el) => el.closest('.ie-cat').remove();
ACTIONS['info-del-btn'] = (el) => el.closest('.ie-btn').remove();
FORMS.infoboard = (f) => {
  const categories = [...f.querySelectorAll('.ie-cat')].map((c) => ({ title: c.querySelector('.ie-title').value.trim(), buttons: [...c.querySelectorAll('.ie-btn')].map((b) => ({ label: b.querySelector('.ie-label').value.trim(), text: b.querySelector('.ie-text').value })) }));
  act(async () => { await api('/api/info-board', 'PUT', { title: f.elements.title.value.trim() || 'Info', categories }); closeDialog(); }, 'Saved');
};

VIEWS.dashboard = () => {
  const { order, hidden } = dashPrefs(), off = isOfficer();
  const active = S.members.filter((m) => m.active);
  const leaders = active.filter((m) => LEAD().includes(m.rank)).sort((a, b) => rankIdx(a.rank) - rankIdx(b.rank) || a.name.localeCompare(b.name));
  const next = S.events.filter((e) => new Date(e.start) >= Date.now() - 3 * 36e5).sort((a, b) => new Date(a.start) - new Date(b.start))[0];
  const ann = brand().announcement;
  const showLeadership = !hidden.has('leadership') && (off || !hiddenFromMembers('leadership'));
  const showNext = !hidden.has('next');
  const showInfo = !hidden.has('info') && (off || ((S.infoBoard.categories || []).length > 0));
  const side = showNext || showInfo;
  const panels = {
    announcement: ann && !hidden.has('announcement') ? `<div class="announce full" role="note"><b>Announcement</b><div>${esc(ann)}</div></div>` : '',
    stats: hidden.has('stats') ? '' : `<div class="full">${heroHtml()}${statsHtml()}</div>`,
    loot: hidden.has('loot') || (!off && hiddenFromMembers('lootpanel')) ? '' : `<div class="full">${lootPanel()}</div>`,
    leadership: showLeadership ? leadershipPanel(leaders, side) : '',
    next: side ? `<div class="side ${showLeadership ? '' : 'full'}">${showNext ? `<div class="panel"><h3>Next event</h3>${next ? nextEventCard(next) : '<div class="muted">Nothing scheduled.</div>'}</div>` : ''}${showInfo ? infoPanel() : ''}</div>` : '',
  };
  return `
  <div class="page-head"><div><h1>Dashboard</h1><div class="muted">Welcome, ${esc(S.user.name)}.</div></div>${off ? '<button class="btn" data-act="dash-customize">Customize</button>' : ''}</div>
  <div class="dash-panels">${myStatusBanner()}${order.map((k, i) => (panels[k] ? panels[k].replace('class="', `style="order:${i}" class="`) : '')).join('')}</div>`;
};
// Two sections: the tasks (only the leadership sees them) and a short "who is who" that everybody sees.
function leadershipPanel(leaders, side) {
  const off = isOfficer();
  const overview = leaders.length
    ? leaders.map((m) => `<div class="ov-row"><b>${esc(m.name)}</b>: ${esc(m.rank)}. <span class="muted">Jobs:</span> ${m.jobs ? esc(m.jobs) : '<span class="muted">-</span>'}</div>`).join('')
    : `<div class="muted">Nobody holds a leadership rank yet.${off ? ` Give a character the rank ${LEAD().map((r) => `"${esc(r)}"`).join(' or ')} on the Member page.` : ''}</div>`;
  return `<div class="panel ${side ? 'wide' : 'full'}"><h3>Leadership</h3>
    ${off ? `<div class="sub-head">Tasks <span class="muted small">(only the leadership sees this)</span></div>${leaders.length ? leaders.map(leaderCard).join('') : '<div class="muted small">No leaders yet.</div>'}<div class="sub-sep"></div>` : ''}
    <div class="sub-head">Who is who</div>${overview}</div>`;
}
FORMS.jobs = (f, fd, id) => act(() => api(`/api/members/${id}/jobs`, 'PUT', { jobs: fd.jobs }), 'Saved');

// A player's own warnings, disqualification and leave, always on top of their dashboard while they exist.
function myStatusBanner() {
  if (isOfficer()) return '';
  const warns = activeWarn(S.user.key), disq = isDisqualified(S.user.key), c = S.settings.compliance || {};
  const away = (S.leaves || []).find((l) => l.ownerKey === S.user.key && l.status === 'approved' && l.from <= guildDate(Date.now()) && guildDate(Date.now()) <= l.to);
  if (!warns.length && !away) return '';
  return `<div class="warn-banner full" style="order:-1" role="note">
    ${warns.length ? `<b>You have ${warns.length} active ${warns.length === 1 ? 'warning' : 'warnings'}</b>${disq ? ` <span class="qtag warn">Disqualified from loot</span>` : c.disqualifyAt > 0 ? ` <span class="muted small">(at ${c.disqualifyAt} you are disqualified from loot)</span>` : ''}
      <ul>${warns.map((w) => `<li>${esc(w.reason)} <span class="muted small">· ${fmtLootDate(w.at.slice(0, 10))}${w.expiresAt ? ` · goes away ${fmtLootDate(w.expiresAt.slice(0, 10))}` : ''}</span></li>`).join('')}</ul><a href="#/warnings">All warnings</a>` : ''}
    ${away ? `<div>${warns.length ? '<br>' : ''}<b>You are on leave of absence</b> until ${fmtLootDate(away.to)}. Events in that time do not count against you.</div>` : ''}</div>`;
}

ACTIONS['dash-customize'] = () => {
  const { order, hidden } = dashPrefs();
  const item = (k, fixed) => `<div class="dash-item" data-k="${k}" ${fixed ? 'data-fixed="1"' : ''}><label><input type="checkbox" name="show" value="${k}" ${hidden.has(k) ? '' : 'checked'}> ${esc(DASH_PANELS.find((x) => x.key === k).label)}</label>
    ${fixed ? '' : '<span class="seg"><button type="button" class="btn sm" data-act="dash-move" data-dir="-1" aria-label="Move up">Up</button><button type="button" class="btn sm" data-act="dash-move" data-dir="1" aria-label="Move down">Down</button></span>'}</div>`;
  openDialog(`<form data-form="dashprefs"><h2>Customize your dashboard</h2>
    <div class="muted small" style="margin:-8px 0 12px">Choose what you see and in which order. This is only for you.</div>
    <div id="dash-list">${order.map((k) => item(k, false)).join('')}${DASH_PANELS.filter((x) => x.fixed).map((x) => item(x.key, true)).join('')}</div>
    <div class="dlg-actions"><button type="button" class="btn danger left" data-act="dash-reset">Reset</button><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div></form>`);
};
ACTIONS['dash-move'] = (el, d) => {
  const item = el.closest('.dash-item'), dir = Number(d.dir);
  if (dir < 0 && item.previousElementSibling && !item.previousElementSibling.dataset.fixed) item.parentNode.insertBefore(item, item.previousElementSibling);
  if (dir > 0 && item.nextElementSibling && !item.nextElementSibling.dataset.fixed) item.parentNode.insertBefore(item.nextElementSibling, item);
};
ACTIONS['dash-reset'] = () => act(async () => { await api('/api/prefs', 'PUT', { dashboardHidden: [], dashboardOrder: [] }); closeDialog(); }, 'Dashboard reset');
FORMS.dashprefs = (f) => {
  const items = [...f.querySelectorAll('.dash-item')];
  act(async () => { await api('/api/prefs', 'PUT', { dashboardOrder: items.filter((i) => !i.dataset.fixed).map((i) => i.dataset.k), dashboardHidden: items.filter((i) => !i.querySelector('input').checked).map((i) => i.dataset.k) }); closeDialog(); }, 'Saved');
};

/* ================= Admin: appearance, who sees what, approvals, tags ================= */
// Admin is composed below (search "VIEWS.admin =" near the bottom of this section) from the small panel
// functions in this file plus the ones in app.js, in the order the leadership actually wants to see them -
// most used at the top, set-and-forget settings further down. Reordering the page in the future just means
// reordering that one list, not moving code around.
function appearanceAdmin() {
  const st = S.settings, b = st.branding || {};
  const file = (kind, name) => `<div class="upload"><div class="img-prev ${kind}">${name ? `<img src="/uploads/${esc(name)}" alt="">` : '<span class="muted small">none</span>'}</div>
    <div><label class="btn sm" style="margin:0;color:var(--text)">${name ? 'Replace' : 'Upload'}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-act="upload" data-kind="${kind}" class="hidden"></label>
    ${name ? `<button class="btn sm danger" data-act="upload-remove" data-kind="${kind}">Remove</button>` : ''}</div></div>`;
  return `<div class="panel"><h3>Appearance</h3>
    <form data-form="appearance" class="rules-grid" style="padding-bottom:0">
      <div class="field"><label for="ap-name">Guild name</label><input id="ap-name" name="name" value="${esc(b.name || '')}" maxlength="40" placeholder="${esc(S.cfg.guildName)}"></div>
      <div class="field"><label for="ap-tag">Tagline</label><input id="ap-tag" name="tagline" value="${esc(b.tagline || '')}" maxlength="80" placeholder="${esc(S.cfg.tagline)}"></div>
      <div class="field"><label for="ap-col">Accent colour</label><div style="display:flex;gap:8px;align-items:center"><input id="ap-col" name="accent" type="color" value="${esc(b.accent || '#ac2d4c')}" style="width:56px;padding:2px"><label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" name="defaultAccent" ${b.accent ? '' : 'checked'}> Use the default</label></div></div>
      <div class="field"><label for="ap-dim">Background dimming: <span id="ap-dim-v">${b.bgDim ?? 82}</span>%</label><input id="ap-dim" name="bgDim" type="range" min="0" max="95" value="${b.bgDim ?? 82}" data-act="dim-live"></div>
      <div class="field" style="grid-column:1/-1"><label for="ap-ann">Announcement on the dashboard (leave empty for none)</label><textarea id="ap-ann" name="announcement" maxlength="500" placeholder="Siege on Sunday 20:00. Be in voice chat 15 minutes early.">${esc(b.announcement || '')}</textarea></div>
      <button class="btn primary">Save appearance</button>
    </form>
    <div class="uploads"><div><div class="k">Guild icon</div>${file('icon', b.iconFile)}<div class="muted small">PNG, JPEG, GIF or WebP, up to 1.5 MB. Square works best.</div></div>
      <div><div class="k">Background picture</div>${file('background', b.bgFile)}<div class="muted small">Up to 6 MB. It is dimmed so the text stays readable.</div></div></div>
  </div>`;
}
function accessAdmin() {
  const hidden = new Set((S.settings.hiddenSections || []));
  return `<div class="panel"><h3>What normal members can see</h3>
    <div class="muted small" style="margin:-6px 0 10px">Untick a section to hide it from normal members. The leadership always sees everything, and the data of a hidden section is not sent to normal members either.</div>
    <form data-form="access">${S.cfg.sections.map((s) => `<label class="tagpick"><input type="checkbox" name="show" value="${esc(s.key)}" ${hidden.has(s.key) ? '' : 'checked'}> ${esc(s.label)}</label>`).join('')}<button class="btn primary" style="margin-top:8px">Save</button></form>
    <p class="muted small" style="margin:10px 0 0">In the sections they can open, members only ever see their own loot, their own attendance and their own requests.</p>
  </div>`;
}
function approvalRulesAdmin() {
  const st = S.settings;
  return `<div class="panel"><h3>Changes that need approval by the leadership</h3>
    <div class="muted small" style="margin:-6px 0 10px">When a normal member changes one of these, it waits under "Approvals" until an officer accepts it. Everything else applies at once. Officers are never held back.</div>
    <form data-form="approvals">${S.cfg.approvalGroups.map((g) => `<label class="tagpick"><input type="checkbox" name="g" value="${esc(g.key)}" ${st.approvals[g.key] ? 'checked' : ''}> ${esc(g.label)}</label>`).join('')}<button class="btn primary" style="margin-top:8px">Save</button></form>
  </div>`;
}
function tagsAdmin() {
  return `<div class="panel"><h3>Player tags</h3>
    <div class="muted small" style="margin:-6px 0 10px">Only the leadership sees tags. Give them to players on the Member page.</div>
    ${S.tags.map((t) => `<form data-form="tag-save" data-id="${t.id}" class="link-row"><input name="color" type="color" value="${esc(t.color)}" style="width:48px;padding:2px" aria-label="Colour"><input name="name" value="${esc(t.name)}" maxlength="30" style="max-width:220px" aria-label="Tag name">${tagChip(t)}
      <button class="btn sm">Save</button><button type="button" class="btn sm danger" data-act="tag-delete" data-id="${t.id}">Delete</button></form>`).join('') || '<div class="muted small">No tags yet.</div>'}
    <form data-form="tag-new" class="link-row" style="margin-top:8px"><input name="color" type="color" value="#7cc4b8" style="width:48px;padding:2px" aria-label="Colour"><input name="name" maxlength="30" placeholder="New tag, for example Trial" style="max-width:220px" required aria-label="New tag name"><button class="btn primary sm">Add tag</button></form>
  </div>`;
}
const options = (body, msg) => act(() => api('/api/admin/options', 'PUT', body), msg || 'Saved');
FORMS.appearance = (f, fd) => options({ branding: { name: fd.name, tagline: fd.tagline, announcement: fd.announcement, accent: f.elements.defaultAccent.checked ? '' : fd.accent, bgDim: fd.bgDim } });
FORMS.access = (f) => options({ hiddenSections: S.cfg.sections.map((s) => s.key).filter((k) => !f.querySelector(`input[value="${k}"]`).checked) });
FORMS.approvals = (f) => options({ approvals: Object.fromEntries(S.cfg.approvalGroups.map((g) => [g.key, f.querySelector(`input[value="${g.key}"]`).checked])) });
FORMS['tag-new'] = (f, fd) => act(() => api('/api/tags', 'POST', fd), 'Tag added');
FORMS['tag-save'] = (f, fd, id) => act(() => api('/api/tags/' + id, 'PUT', fd), 'Tag saved');
ACTIONS['tag-delete'] = (el, d) => { if (confirm('Delete this tag? It is removed from all players.')) act(() => api('/api/tags/' + d.id, 'DELETE'), 'Tag deleted'); };
CHANGES['dim-live'] = (el) => { $('#ap-dim-v').textContent = el.value; };
CHANGES['upload'] = (el) => {
  const file = el.files[0]; if (!file) return;
  const limit = el.dataset.kind === 'icon' ? 1.5e6 : 6e6;
  if (file.size > limit) { toast(`That picture is too large (limit ${limit / 1e6} MB).`, true); el.value = ''; return; }
  const r = new FileReader();
  r.onload = () => act(() => api('/api/admin/upload', 'POST', { kind: el.dataset.kind, data: r.result }), 'Picture saved');
  r.readAsDataURL(file);
};
ACTIONS['upload-remove'] = (el, d) => act(() => api('/api/admin/upload', 'POST', { kind: d.kind, remove: true }), 'Picture removed');


/* ================= login notices (leadership) ================= */
// A search box and a list of players with tick boxes.
const playerPicker = (selected = []) => `<div class="pp"><input type="search" class="pp-filter" placeholder="Search players" aria-label="Search players"><div class="scrollbox">${allPlayers().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<label class="tagpick" data-n="${esc(p.name.toLowerCase())}"><input type="checkbox" name="rcpt" value="${esc(p.key)}" ${selected.includes(p.key) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('') || '<span class="muted small">No players yet.</span>'}</div></div>`;
const audienceFields = (recipients) => `<div class="field"><label>Send to</label>
  <label class="tagpick"><input type="radio" name="audience" value="all" data-act="aud" ${recipients ? '' : 'checked'}> Everybody</label>
  <label class="tagpick"><input type="radio" name="audience" value="selected" data-act="aud" ${recipients ? 'checked' : ''}> Only chosen players</label>
  <div class="pp-wrap ${recipients ? '' : 'hidden'}">${playerPicker(recipients || [])}</div></div>`;
const audienceOf = (f) => (f.querySelector('input[name=audience]:checked').value === 'selected' ? { audience: 'selected', recipients: [...f.querySelectorAll('input[name=rcpt]:checked')].map((i) => i.value) } : { audience: 'all' });
CHANGES['aud'] = (el) => { el.closest('form').querySelector('.pp-wrap').classList.toggle('hidden', el.value !== 'selected'); };
document.addEventListener('input', (e) => {                                   // filter the player list while typing
  if (!e.target.classList || !e.target.classList.contains('pp-filter')) return;
  const q = e.target.value.toLowerCase();
  e.target.closest('.pp').querySelectorAll('label[data-n]').forEach((l) => l.classList.toggle('hidden', q && !l.dataset.n.includes(q)));
});
function noticesAdmin() {
  const people = allPlayers();
  return `<div class="panel"><h3>Login notices</h3>
    <div class="muted small" style="margin:-6px 0 10px">A notice covers the whole screen when a player opens the app and stays until they press "I have read this and accept". Players who are already signed in get it within a minute.</div>
    ${S.notices.map((n) => { const acked = new Set((n.acks || []).map((a) => a.key)), audience = n.recipients ? people.filter((p) => n.recipients.includes(p.key)) : people, missing = audience.filter((p) => !acked.has(p.key));
      return `<div class="rule-row"><span style="flex:1;min-width:220px"><b>${esc(n.title)}</b> <span class="st-pill ${n.active ? 'st-approved' : ''}">${n.active ? 'Active' : 'Off'}</span><br>
        <span class="muted small">${fmtShort(n.at)} · to ${n.recipients ? `${n.recipients.length} chosen ${n.recipients.length === 1 ? 'player' : 'players'}` : 'everybody'} · ${audience.filter((p) => acked.has(p.key)).length} of ${audience.length} accepted</span>
        ${missing.length && n.active ? `<details style="margin-top:4px"><summary class="small" style="cursor:pointer;color:var(--accent-text)">Who has not accepted yet (${missing.length})</summary><div class="small muted">${missing.map((p) => esc(p.name)).join(', ')}</div></details>` : ''}</span>
        <span class="seg"><button class="btn sm" data-act="notice-preview" data-id="${n.id}">Preview</button><button class="btn sm" data-act="notice-edit" data-id="${n.id}">Edit</button>
        <button class="btn sm" data-act="notice-toggle" data-id="${n.id}">${n.active ? 'Turn off' : 'Turn on'}</button><button class="btn sm danger" data-act="notice-delete" data-id="${n.id}">Delete</button></span></div>`; }).join('') || '<div class="muted small">No notices yet.</div>'}
    <form data-form="notice-new" style="margin-top:12px"><div class="field"><label for="nt-title">Title</label><input id="nt-title" name="title" maxlength="80" required placeholder="For example: New siege rules"></div>
      <div class="field"><label for="nt-text">Text</label><textarea id="nt-text" name="text" maxlength="2000" required placeholder="What the players have to read" style="min-height:110px"></textarea></div>
      ${audienceFields(null)}
      <button class="btn primary">Send notice</button></form></div>`;
}
FORMS['notice-new'] = (f, fd) => act(async () => { await api('/api/notices', 'POST', { title: fd.title, text: fd.text, ...audienceOf(f) }); f.reset(); }, 'Notice created. It shows up when the players open the app.');
ACTIONS['notice-toggle'] = (el, d) => { const n = byId(S.notices, d.id); act(() => api('/api/notices/' + d.id, 'PUT', { title: n.title, text: n.text, active: !n.active }), n.active ? 'Turned off' : 'Turned on'); };
ACTIONS['notice-delete'] = (el, d) => { if (confirm('Delete this notice?')) act(() => api('/api/notices/' + d.id, 'DELETE'), 'Deleted'); };
ACTIONS['notice-preview'] = (el, d) => {
  const n = byId(S.notices, d.id);
  openDialog(`<div class="notice-card" style="border:0;padding:0"><div class="notice-count">Preview: this is how players see it</div><h1>${esc(n.title)}</h1><div class="notice-text">${linkify(n.text)}</div>
    <button class="btn" data-act="dlg-close">Close preview</button></div>`, true);
};
ACTIONS['notice-edit'] = (el, d) => {
  const n = byId(S.notices, d.id);
  openDialog(`<form data-form="notice-save" data-id="${n.id}"><h2>Edit notice</h2>
    <div class="field"><label>Title</label><input name="title" value="${esc(n.title)}" maxlength="80" required></div>
    <div class="field"><label>Text</label><textarea name="text" maxlength="2000" required style="min-height:160px">${esc(n.text)}</textarea></div>
    ${audienceFields(n.recipients)}
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="resetAcks"> Everybody it goes to has to accept it again</label>
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div></form>`);
};
FORMS['notice-save'] = (f, fd, id) => act(async () => { await api('/api/notices/' + id, 'PUT', { title: fd.title, text: fd.text, resetAcks: f.elements.resetAcks.checked, ...audienceOf(f) }); closeDialog(); }, 'Saved');


/* ================= one preset for several event types and events ================= */
FORMS['preset-use'] = (f, fd, id) => {
  const p = byId(S.presets, id);
  const types = [...f.querySelectorAll('input[name=rt]:checked')].map((i) => i.value);
  const ids = [...f.querySelectorAll('input[name=re]:checked')].map((i) => Number(i.value));
  const removeTypes = S.presetRules.filter((r) => r.presetId === p.id && !types.includes(r.type)).map((r) => r.type);     // were ticked before, are not any more
  if (!types.length && !ids.length && !removeTypes.length) return toast('Tick at least one event type or event.', true);
  const targets = S.events.filter((e) => new Date(e.start) > Date.now() && (types.includes(e.type) || ids.includes(e.id)));
  const filled = targets.filter((e) => e.parties.length).length;
  const lines = [];
  if (types.length || ids.length) lines.push(`Use "${p.name}" for ${targets.length} upcoming ${targets.length === 1 ? 'event' : 'events'}${types.length ? `, and for every new ${types.join(' / ')} event from now on` : ''}.`);
  if (removeTypes.length) lines.push(`Stop using it for new ${removeTypes.join(' / ')} events (events that already have parties keep them).`);
  if (!confirm(lines.join('\n\n'))) return;
  const overwrite = filled && targets.length ? confirm(`${filled} of the upcoming events already have parties.\n\nOK = replace those too.\nCancel = keep them and only fill the empty ones.`) : false;
  act(async () => {
    const r = await api(`/api/presets/${id}/use-for`, 'POST', { types, eventIds: ids, removeTypes, overwrite });
    toast(`${r.applied} ${r.applied === 1 ? 'event' : 'events'} updated${r.skipped ? `, ${r.skipped} kept as they were` : ''}${r.removed ? `, ${r.removed} ${r.removed === 1 ? 'type' : 'types'} unlinked` : ''}.`);
  });
};

CHANGES['preset-hidden'] = (el) => act(() => api('/api/presets/' + el.dataset.id, 'PUT', { hidden: el.checked }), el.checked ? 'Hidden from normal members' : 'Visible to everybody');


/* ================= the chart in the "Going" area of an event ================= */
UI.chartMode = 'bar';
const CH = { yes: ['Going', '#6fcf8b'], no: ["Can't", '#e2685c'], none: ['No reply', '#8b95a7'], leave: ['On leave', '#5fb8e8'] };
const ZERO = { yes: 0, no: 0, none: 0, leave: 0 };
function chartBars(rows, keys) {
  const sum = (c) => keys.reduce((a, k) => a + c[k], 0), max = Math.max(1, ...rows.map((r) => sum(r.c)));
  return `<div class="cbars">${rows.map((r) => {
    const t = sum(r.c), going = r.c.yes, pct = t ? Math.round(100 * going / t) : 0;
    return `<div class="cbar ${r.all ? 'all' : ''}" style="--rc:${r.color || 'var(--accent-text)'}">
      <div class="cl"><i class="rdot"></i>${esc(r.label)}</div>
      <div class="ctrack">${t ? `<div class="cstack" style="width:${100 * t / max}%">${keys.map((k) => (r.c[k] ? `<span class="seg-${k}" style="flex:${r.c[k]}" title="${CH[k][0]}: ${r.c[k]}"><b>${r.c[k]}</b></span>` : '')).join('')}</div>` : '<em class="muted small">nobody</em>'}</div>
      <div class="cn"><b>${going}</b><span class="muted">/${t}</span><small>${pct}%</small></div></div>`;
  }).join('')}</div>`;
}
// A ring with the number of people going in the middle.
function donutSvg(c, keys, size = 132) {
  const tot = keys.reduce((a, k) => a + c[k], 0), R = 46, W = 16, C = 2 * Math.PI * R, cx = size / 2, live = keys.filter((k) => c[k]);
  let off = 0;
  const arcs = live.map((k) => {
    const len = (c[k] / tot) * C, gap = live.length > 1 ? 2.5 : 0, shown = Math.max(0.5, len - gap);
    const el = `<circle cx="${cx}" cy="${cx}" r="${R}" fill="none" stroke="${CH[k][1]}" stroke-width="${W}" stroke-dasharray="${shown} ${C - shown}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cx})"><title>${CH[k][0]}: ${c[k]}</title></circle>`;
    off += len; return el;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${keys.map((k) => `${CH[k][0]} ${c[k]}`).join(', ')}">
    <circle cx="${cx}" cy="${cx}" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${W}"/>${tot ? arcs : ''}
    <text x="${cx}" y="${cx + 3}" text-anchor="middle" class="dn">${c.yes}</text><text x="${cx}" y="${cx + 22}" text-anchor="middle" class="dl">of ${tot} going</text></svg>`;
}
function goingChart(ev) {
  const c = ev.chart;
  if (!c) return '';
  const rows = [...S.cfg.roles.map((r) => ({ label: r, c: c.roles[r] || ZERO, color: roleColor(r) })), { label: 'Everybody', c: c.total, all: true }];
  const keys = ['yes', 'no', 'none', ...(c.total.leave ? ['leave'] : [])];
  const pie = UI.chartMode === 'pie', all = keys.reduce((a, k) => a + c.total[k], 0);
  return `<div class="going-chart">
    <div class="chart-head"><div class="chart-sum"><b>${c.total.yes}</b> of ${all} ${all === 1 ? 'player' : 'players'} going${all ? ` <span class="muted">(${Math.round(100 * c.total.yes / all)}%)</span>` : ''}</div>
      <span class="seg"><button class="btn sm ${pie ? '' : 'on'}" data-act="chart-mode" data-m="bar">Bars</button><button class="btn sm ${pie ? 'on' : ''}" data-act="chart-mode" data-m="pie">Rings</button></span></div>
    <div class="legend-row">${keys.map((k) => `<span class="lg"><i style="background:${CH[k][1]}"></i>${CH[k][0]} <b>${c.total[k]}</b>${all ? `<small>${Math.round(100 * c.total[k] / all)}%</small>` : ''}</span>`).join('')}</div>
    ${pie ? `<div class="cpies">${rows.map((r) => `<figure class="cpie ${r.all ? 'all' : ''}" style="--rc:${r.color || 'var(--accent-text)'}">${donutSvg(r.c, keys)}<figcaption><b>${esc(r.label)}</b>
        <span class="mini-legend">${keys.map((k) => `<span title="${CH[k][0]}"><i style="background:${CH[k][1]}"></i>${r.c[k]}</span>`).join('')}</span></figcaption></figure>`).join('')}</div>` : chartBars(rows, keys)}
  </div>`;
}
ACTIONS['chart-mode'] = (el, d) => { UI.chartMode = d.m; render(); };

/* ================= leave of absence ================= */
UI.leaveStatus = '';
const LEAVE_STATUS = { pending: ['Waiting', 'st-open'], approved: ['Approved', 'st-approved'], rejected: ['Not approved', 'st-rejected'] };
const allPlayers = () => (S.cfg.authMode === 'discord' ? S.users.map((u) => ({ key: u.id, name: u.name })) : [...new Set(S.members.filter((m) => m.active).map((m) => m.owner))].map((o) => ({ key: o, name: o })));
VIEWS.leave = () => {
  const off = isOfficer(), c = S.settings.compliance || {}, today = todayTz();
  const list = S.leaves.filter((l) => !UI.leaveStatus || l.status === UI.leaveStatus).sort((a, b) => b.from.localeCompare(a.from));
  const away = S.leaves.filter((l) => l.status === 'approved' && l.from <= guildDate(Date.now()) && guildDate(Date.now()) <= l.to);
  return `
  <div class="page-head"><div><h1>Leave of absence</h1><div class="muted">Going to be away? Tell the leadership. Events in that time do not count as no-show, no reply or missed attendance, and you get no reminders.${c.loaNeedsApproval ? ' The leadership has to approve it.' : ''}</div></div></div>
  ${off && away.length ? `<div class="panel" style="margin-bottom:16px"><h3>Away right now</h3>${away.map((l) => `<div class="rule-row"><b>${esc(l.name)}</b><span class="muted small">until ${fmtLootDate(l.to)}${l.reason ? ' · ' + esc(l.reason) : ''}</span></div>`).join('')}</div>` : ''}
  <div class="panel" style="margin-bottom:16px"><h3>${off ? 'Add a leave' : 'Ask for a leave'}</h3>
    <form data-form="leave" class="loot-form">
      ${off ? `<div class="field"><label for="lv-p">Player</label><select id="lv-p" name="ownerKey">${allPlayers().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="lv-f">First day</label><input id="lv-f" name="from" type="date" value="${today}" ${off ? '' : `min="${today}"`} required></div>
      <div class="field"><label for="lv-t">Last day</label><input id="lv-t" name="to" type="date" value="${addDayStr(today, 6)}" ${off ? '' : `min="${today}"`} required></div>
      <div class="field wide"><label for="lv-r">Reason (optional)</label><input id="lv-r" name="reason" maxlength="200" placeholder="Holiday, exams, ..."></div>
      <button class="btn primary">${off ? 'Add leave' : 'Send'}</button>
    </form>${off ? '<div class="muted small" style="margin-top:8px">Entries added by the leadership are approved at once and may start in the past.</div>' : ''}</div>
  <div class="toolbar"><select data-ui="leaveStatus" aria-label="Status"><option value="">All</option>${Object.entries(LEAVE_STATUS).map(([k, v]) => `<option value="${k}" ${UI.leaveStatus === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select><span class="muted small">${list.length} ${list.length === 1 ? 'entry' : 'entries'}</span></div>
  ${list.length ? `<div class="tbl-wrap"><table><thead><tr>${off ? '<th>Player</th>' : ''}<th>From</th><th>To</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${list.map((l) => {
    const running = l.from <= today && today <= l.to;
    return `<tr>${off ? `<td><b>${esc(l.name)}</b></td>` : ''}<td class="nowrap">${fmtLootDate(l.from)}</td><td class="nowrap">${fmtLootDate(l.to)}${running && l.status === 'approved' ? ' <span class="type-pill">now</span>' : ''}</td><td>${esc(l.reason) || '<span class="muted">-</span>'}</td>
      <td><span class="st-pill ${LEAVE_STATUS[l.status][1]}">${LEAVE_STATUS[l.status][0]}</span>${l.note ? `<div class="muted small">${esc(l.note)}</div>` : ''}</td>
      <td class="nowrap">${off && l.status === 'pending' ? `<button class="btn sm" data-act="leave-decide" data-id="${l.id}" data-d="approved">Approve</button> <button class="btn sm danger" data-act="leave-decide" data-id="${l.id}" data-d="rejected">Reject</button> ` : ''}
        ${off && running && l.status === 'approved' ? `<button class="btn sm" data-act="leave-end" data-id="${l.id}">End today</button> ` : ''}
        ${off || l.status === 'pending' || l.from > today ? `<button class="btn sm" data-act="leave-del" data-id="${l.id}">${off ? 'Delete' : 'Take back'}</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty">No leave entries.</div>'}`;
};
FORMS.leave = (f, fd) => act(async () => { const r = await api('/api/leaves', 'POST', fd); toast(r.status === 'pending' ? 'Sent. The leadership has to approve it.' : 'Saved'); });
ACTIONS['leave-del'] = (el, d) => { if (confirm('Remove this leave entry?')) act(() => api('/api/leaves/' + d.id, 'DELETE'), 'Removed'); };
ACTIONS['leave-end'] = (el, d) => act(() => api('/api/leaves/' + d.id, 'PUT', { to: addDayStr(guildDate(Date.now()), -1) }), 'The leave ended');

/* ================= warnings ================= */
UI.warnFilter = 'active'; UI.warnQ = '';
const WARN_KIND = { noshow: 'No-shows', noreply: 'No reply', manual: 'From the leadership' };
const rulesText = () => {
  const c = S.settings.compliance || {}, parts = [];
  if (!c.enabled) return 'Automatic warnings are switched off.';
  if (c.noShowLimit) parts.push(`${c.noShowLimit} no-shows (said Going, did not come)`);
  if (c.noReplyLimit) parts.push(`${c.noReplyLimit} events without an answer`);
  const out = [parts.length ? `A warning is given for ${parts.join(' or ')} within ${c.windowDays} days${c.mandatoryOnly ? ' (mandatory events)' : ''}.` : 'No automatic warning limits are set.'];
  if (c.minAttendance) out.push(`Below ${c.minAttendance}% attendance you are asked for a reason.`);
  if (c.expiryDays) out.push(`Every warning goes away after ${c.expiryDays} days.`);
  if (c.quietDays) out.push(`After ${c.quietDays} days without a new warning ${c.quietRemove ? `${c.quietRemove} of your warnings go away` : 'all your warnings go away'}.`);
  if (c.disqualifyAt) out.push(`With ${c.disqualifyAt} active warnings you are disqualified from loot until some are gone.`);
  return out.join(' ');
};
VIEWS.warnings = () => {
  const off = isOfficer(), q = UI.warnQ.toLowerCase();
  const list = S.warnings.filter((w) => (UI.warnFilter === 'all' || w.status === 'active') && (!q || `${w.name} ${w.reason}`.toLowerCase().includes(q))).sort((a, b) => b.at.localeCompare(a.at));
  const perPlayer = [...new Set(S.warnings.filter((w) => w.status === 'active').map((w) => w.ownerKey))].map((k) => ({ k, n: activeWarn(k).length, name: ownerName(k) })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const mineActive = activeWarn(S.user.key).length, c = S.settings.compliance || {};
  const status = (w) => (w.status === 'active' ? '<span class="st-pill st-rejected">Active</span>' : `<span class="st-pill">${w.status === 'removed' ? 'Removed' : 'Ended'}</span><div class="muted small">${w.endedBy === 'timer' ? 'ran out' : w.endedBy === 'quiet' ? 'quiet period' : w.endedBy ? 'by ' + esc(w.endedBy) : ''}</div>`);
  return `
  <div class="page-head"><div><h1>Warnings</h1><div class="muted">${off ? 'Every warning, given automatically or by the leadership.' : 'Your warnings. Only you and the leadership can see them.'}</div></div>
    ${off ? '<button class="btn" data-act="warn-run">Check attendance now</button>' : ''}</div>
  <div class="panel" style="margin-bottom:16px"><h3>How it works</h3><div class="small">${esc(rulesText())}</div></div>
  ${!off ? `<div class="panel" style="margin-bottom:16px"><h3>Your status</h3><div><b>${mineActive}</b> active ${mineActive === 1 ? 'warning' : 'warnings'}${isDisqualified(S.user.key) ? ' <span class="qtag warn">Disqualified from loot</span>' : c.disqualifyAt > 0 ? ` <span class="muted small">(disqualified from ${c.disqualifyAt})</span>` : ''}</div></div>` : ''}
  ${off ? `<div class="panel" style="margin-bottom:16px"><h3>Players with active warnings</h3>${perPlayer.length ? perPlayer.map((p) => `<div class="rule-row"><b>${esc(p.name)}</b><span>${p.n} active</span>${isDisqualified(p.k) ? '<span class="qtag warn">Disqualified from loot</span>' : ''}<button class="btn sm" data-act="warn-clear-all" data-owner="${esc(p.k)}" data-name="${esc(p.name)}">Clear all</button></div>`).join('') : '<div class="muted small">Nobody has an active warning.</div>'}</div>
    <div class="panel" style="margin-bottom:16px"><h3>Give a warning</h3><form data-form="warn-new" class="loot-form">
      <div class="field"><label for="wn-p">Player</label><select id="wn-p" name="ownerKey">${allPlayers().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field wide"><label for="wn-r">Reason</label><input id="wn-r" name="reason" required maxlength="300" placeholder="What happened"></div><button class="btn primary">Give warning</button></form></div>` : ''}
  <div class="toolbar">
    <select data-ui="warnFilter" aria-label="Which"><option value="active" ${UI.warnFilter === 'active' ? 'selected' : ''}>Active warnings</option><option value="all" ${UI.warnFilter === 'all' ? 'selected' : ''}>All, including ended</option></select>
    ${off ? `<input type="search" placeholder="Search player or reason" value="${esc(UI.warnQ)}" data-ui="warnQ" aria-label="Search">` : ''}<span class="muted small">${list.length} shown</span></div>
  ${list.length ? `<div class="tbl-wrap"><table><thead><tr>${off ? '<th>Player</th>' : ''}<th>Given</th><th>Type</th><th>Reason</th><th>Ends</th><th>Status</th>${off ? '<th></th>' : ''}</tr></thead><tbody>${list.map((w) => `<tr>${off ? `<td><b>${esc(w.name)}</b></td>` : ''}
    <td class="nowrap muted small">${fmtShort(w.at)}</td><td>${esc(WARN_KIND[w.kind] || w.kind)}</td><td>${esc(w.reason)}${w.note ? `<div class="muted small">${esc(w.note)}</div>` : ''}</td>
    <td class="nowrap muted small">${w.status === 'active' ? (w.expiresAt ? fmtLootDate(w.expiresAt.slice(0, 10)) : 'never') : (w.endedAt ? fmtLootDate(w.endedAt.slice(0, 10)) : '-')}</td><td>${status(w)}</td>
    ${off ? `<td>${w.status === 'active' ? `<button class="btn sm" data-act="warn-remove" data-id="${w.id}">Remove</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No warnings.</div>'}
  ${S.explanations.length ? `<h3 class="sec" style="margin-top:24px">${off ? 'Reasons players sent' : 'Your explanations'}</h3><div class="tbl-wrap"><table><tbody>${S.explanations.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15).map((x) => `<tr><td class="nowrap muted small">${fmtShort(x.at)}</td>${off ? `<td><b>${esc(x.name)}</b></td>` : ''}<td>${esc(x.reason)}</td>
      <td><span class="st-pill ${x.status === 'approved' ? 'st-approved' : x.status === 'rejected' ? 'st-rejected' : 'st-open'}">${x.status === 'approved' ? 'Accepted' : x.status === 'rejected' ? 'Not accepted' : 'Waiting'}</span>${x.note ? `<div class="muted small">${esc(x.note)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
};
FORMS['warn-new'] = (f, fd) => act(async () => { await api('/api/warnings', 'POST', fd); f.reset(); }, 'Warning given. The player gets a Discord message.');
ACTIONS['warn-remove'] = (el, d) => { const note = prompt('Why is it removed? (optional)', ''); if (note === null) return; act(() => api('/api/warnings/' + d.id, 'PUT', { note }), 'Warning removed'); };
ACTIONS['warn-clear-all'] = (el, d) => {
  if (!confirm(`Clear every active warning for ${d.name}?`)) return;
  const note = prompt('Why are they all being cleared? (optional)', '') || '';
  act(async () => { const r = await api(`/api/warnings/clear/${encodeURIComponent(d.owner)}`, 'POST', { note }); toast(`Cleared ${r.cleared} ${r.cleared === 1 ? 'warning' : 'warnings'} for ${d.name}.`); }, null);
};
ACTIONS['warn-run'] = () => act(async () => { const r = await api('/api/admin/compliance/run', 'POST', {}); toast(`Checked. ${r.issued} new ${r.issued === 1 ? 'warning' : 'warnings'}, ${r.expired} ended.`); });

/* ================= Admin: attendance rules ================= */
function complianceAdmin() {
  const c = S.settings.compliance || {};
  const num = (id, name, label, min, max, desc) => `<div class="rule-field"><label for="${id}">${label}</label><div class="muted small" style="margin:2px 0 6px">${desc}</div><input id="${id}" name="${name}" type="number" min="${min}" max="${max}" value="${c[name] ?? 0}" required></div>`;
  const check = (name, label, desc) => `<div class="rule-field"><label class="tagpick"><input type="checkbox" name="${name}" ${c[name] ? 'checked' : ''}> ${label}</label><div class="muted small" style="margin:2px 0 0 26px">${desc}</div></div>`;
  return `<div class="panel"><h3>Attendance rules, warnings and disqualification</h3>
    <div class="muted small" style="margin:-6px 0 10px"><b>Put 0 in any limit below to switch it off.</b> The leadership itself is never judged by any of this.</div>
    <form data-form="compliance" class="rules-stack">
      ${num('cp-fa', 'finalAfterMinutes', 'Count an event\'s attendance after (minutes)', 5, 1440, 'How long after an event starts its attendance is treated as final and counted for warnings and the attendance percentage. The PIN entry window itself is a separate setting below and is not affected by this.')}
      ${num('cp-w', 'windowDays', 'Attendance window (days)', 7, 365, 'How far back to look when counting no-shows, unanswered events, and the attendance percentage below. Anything older than this does not count.')}
      ${num('cp-ns', 'noShowLimit', 'No-shows that trigger a warning', 0, 50, 'A no-show is saying Going and then not showing up. Once a player reaches this many within the window above, they get the pop-up and an automatic warning.')}
      ${num('cp-nr', 'noReplyLimit', 'Unanswered events that trigger a warning', 0, 50, "Counts events where a player never answered Going or Can't. Once they reach this many within the window above, they get the pop-up and an automatic warning.")}
      ${num('cp-ma', 'minAttendance', 'Minimum attendance (%)', 0, 100, 'If attendance over the window above drops below this, the player gets the pop-up asking them to explain. This one does not give an automatic warning by itself.')}
      ${num('cp-me', 'minEvents', 'Events needed before judging attendance %', 1, 50, 'The attendance rule above only applies once a player has had at least this many events to attend, so someone brand new is not judged on one or two events.')}
      ${num('cp-ex', 'expiryDays', 'A warning goes away after (days)', 0, 730, 'Automatically removes a warning this many days after it was given. Set to 0 to make warnings permanent until an officer removes them.')}
      ${num('cp-qd', 'quietDays', 'Quiet period (days)', 0, 730, 'If a player goes this many days in a row without earning another warning, some of their oldest warnings are automatically cleared. How many get cleared is set in the next field.')}
      ${num('cp-qr', 'quietRemove', 'Warnings removed by the quiet period', 0, 50, 'How many warnings disappear once the quiet period above is reached. 0 clears every active warning at once; any other number clears just that many, oldest first.')}
      ${num('cp-dq', 'disqualifyAt', 'Disqualified from loot at (active warnings)', 0, 20, 'Once a player has this many active warnings at the same time, they are disqualified from loot until enough of those warnings expire or get removed.')}
      ${check('mandatoryOnly', 'Only mandatory events count', 'When on, only events marked Mandatory count toward no-shows, unanswered events and attendance percentage. Optional events are ignored for every rule above.')}
      ${check('loaNeedsApproval', 'Leave of absence needs approval', "When on, a player's requested leave of absence has to be approved by an officer before it excuses them from these rules. When off, leave is approved automatically.")}
      ${check('enabled', 'Rules switched on', 'Turns this whole system on or off. When off, nothing on this page does anything: no pop-ups, no automatic warnings, no disqualification.')}
      <button class="btn primary">Save rules</button>
    </form>
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      ${c.pausedUntil && Date.parse(c.pausedUntil) > Date.now()
        ? `<div class="rule-row"><span>Paused until <b>${fmtShort(c.pausedUntil)}</b> - resumes on its own, or now:</span><button class="btn sm" data-act="warn-resume">Resume now</button></div>`
        : `<form data-form="warn-pause" class="link-row"><label for="cp-pause-h" class="muted small" style="margin:0">Pause everything above for</label>
            <input id="cp-pause-h" name="hours" type="number" min="1" max="720" value="24" style="max-width:90px"><span class="muted small">hours</span>
            <button class="btn sm">Pause</button></form>
           <div class="muted small" style="margin-top:4px">Resumes on its own once that time is up - no need to remember to switch it back on.</div>`}
    </div></div>`;
}
FORMS['warn-pause'] = (f, fd) => act(() => api('/api/admin/compliance/pause', 'POST', { hours: fd.hours }), 'Paused');
ACTIONS['warn-resume'] = () => act(() => api('/api/admin/compliance/resume', 'POST', {}), 'Resumed');
FORMS.compliance = (f, fd) => {
  const body = { ...fd, mandatoryOnly: f.elements.mandatoryOnly.checked, loaNeedsApproval: f.elements.loaNeedsApproval.checked, enabled: f.elements.enabled.checked };
  act(() => api('/api/admin/compliance', 'PUT', body), 'Saved');
};

ACTIONS['app-decide'] = (el, d) => {
  const note = prompt(d.d === 'accept' ? 'A welcome note for the new member (optional)' : 'What should the applicant know? (optional)', '');
  if (note === null) return;
  act(async () => { const r = await api('/api/applications/' + d.id, 'PUT', { decision: d.d, note }); if (r.roleResult && r.roleResult !== 'given') toast('Accepted, but the Discord role could not be given: ' + r.roleResult, true); }, d.d === 'accept' ? 'Accepted. They are a member now and their character is on the roster.' : 'Rejected');
};

/* ================= applying to the guild (for people who are not members yet) ================= */
VIEWS.apply = () => {
  const a = S.application, ap = S.settings.applications || {};
  const head = `<div class="page-head"><div><h1>Apply to ${esc(guildName())}</h1><div class="muted">You are signed in as ${esc(S.user.name)}. Members of the guild see everything here, you can only send an application for now.</div></div></div>`;
  if (a && a.status === 'pending') {
    return `${head}<div class="panel"><h3>Your application is with the leadership</h3><div class="muted small" style="margin:-4px 0 10px">Sent ${fmtShort(a.at)}. This page updates by itself when they have decided.</div>
      <div><b>${esc(a.character.name)}</b> ${roleChip(a.character.role)} <span class="muted">${esc(classFor(a.character.primaryWeapon, a.character.secondaryWeapon) || '')}</span></div>
      <div style="white-space:pre-wrap;margin:8px 0 14px">${esc(a.about)}</div><button class="btn" data-act="app-withdraw" data-id="${a.id}">Withdraw the application</button></div>`;
  }
  if (!ap.enabled) return `${head}<div class="empty">Applications are closed at the moment.</div>`;
  return `${head}
  ${a && a.status === 'rejected' ? `<div class="warn-banner" style="margin-bottom:16px"><b>Your last application was not accepted.</b>${a.note ? `<div>${esc(a.note)}</div>` : ''}<div class="muted small">You can send a new one.</div></div>` : ''}
  ${ap.intro ? `<div class="panel" style="margin-bottom:16px;white-space:pre-wrap">${esc(ap.intro)}</div>` : ''}
  <div class="panel"><h3>Your application</h3>
    <form data-form="application">
      <div class="row"><div class="field"><label for="ap-c">Character name</label><input id="ap-c" name="characterName" required minlength="2" maxlength="40"></div>
        <div class="field"><label for="ap-r">Role</label><select id="ap-r" name="role">${opts(S.cfg.roles, S.cfg.roles[0])}</select></div></div>
      <div class="row"><div class="field"><label for="ap-p">Primary weapon</label><select id="ap-p" name="primaryWeapon">${opts(S.cfg.weapons, '', 'None')}</select></div>
        <div class="field"><label for="ap-s">Secondary weapon</label><select id="ap-s" name="secondaryWeapon">${opts(S.cfg.weapons, '', 'None')}</select></div></div>
      <div class="muted small" id="class-preview" style="margin:-4px 0 10px">Class: pick two different weapons</div>
      <div class="row"><div class="field"><label for="ap-g">Gear score</label><input id="ap-g" name="gearScore" type="number" min="0"></div>
        <div class="field"><label for="ap-l">Watermark</label><input id="ap-l" name="level" type="number" min="0" max="99"></div></div>
      <div class="field"><label for="ap-q">Questlog link (optional)</label><input id="ap-q" name="questlog" type="url" maxlength="300" placeholder="https://..."></div>
      <div class="field"><label for="ap-a">About you</label><textarea id="ap-a" name="about" required minlength="10" maxlength="1000" style="min-height:130px" placeholder="Who you are, what you play, how much time you have, why our guild"></textarea></div>
      <button class="btn primary">Send application</button></form></div>`;
};
FORMS.application = (f, fd) => act(async () => { await api('/api/applications', 'POST', fd); }, 'Sent. The leadership will look at it.');
ACTIONS['app-withdraw'] = (el, d) => { if (confirm('Withdraw your application?')) act(() => api('/api/applications/' + d.id, 'DELETE'), 'Withdrawn'); };

/* ================= Mercenary signup: a non-member who followed a "Get mercenaries" Discord link ================= */
Object.assign(UI, { mercInfo: null, mercInfoFor: null, mercEditing: false });
async function loadMercEvent(id) {
  try { UI.mercInfo = await api('/api/merc-event/' + id); } catch (e) { UI.mercInfo = { error: e.message }; }
  UI.mercInfoFor = id; render();
}
AFTER_RENDER.push((page) => { if (page === 'merc') { const { id } = route(); if (UI.mercInfoFor !== id) loadMercEvent(id); } });
VIEWS.merc = (id) => {
  const info = UI.mercInfoFor === id ? UI.mercInfo : null;
  const head = `<div class="page-head"><div><h1>Join as a mercenary</h1><div class="muted">Signed in as ${esc(S.user.name)}. This does not make you a guild member - you only show up for the one event below.</div></div></div>`;
  if (!info) return `${head}<div class="empty">Loading…</div>`;
  if (info.error) return `${head}<div class="empty">${esc(info.error)}</div>`;
  if (info.alreadyMember) return `${head}<div class="empty">This Discord account already belongs to one of our guild's characters - no need to sign up as a mercenary too.</div>`;
  const ev = info.event, m = info.character || { name: '', role: S.cfg.roles[0], primaryWeapon: '', secondaryWeapon: '', specialization: '' };
  const r = ev.mercRequest;
  const eventPanel = `<div class="panel" style="margin-bottom:16px"><h3>${esc(ev.title)}</h3>
    <div class="muted small">${fmtDate(ev.start)} · ${esc(ev.type)}</div>
    ${r ? `<div style="margin-top:8px">Looking for: ${r.overall ? `${r.overall} player${r.overall === 1 ? '' : 's'}, any class` : (r.needs || []).map((n) => `${n.count}× ${esc(n.cls)}`).join(', ')}</div>${r.note ? `<div class="muted small" style="margin-top:4px">${esc(r.note)}</div>` : ''}` : ''}
  </div>`;
  // Already joined this event: a waiting hall instead of the signup form - just their status, and once an
  // officer places them, just their own party, not the full roster or anyone else's party.
  if (info.joinedThisEvent && !UI.mercEditing) {
    return `${head}${eventPanel}
    <div class="panel"><h3>You're in</h3>
      <div class="muted small" style="margin:-4px 0 10px">Signed up as <b>${esc(m.name)}</b> (${esc(m.role)}).</div>
      ${info.myParty ? `
      <div class="rule-row"><span>Party</span><b>${esc(info.myParty.name)}</b></div>
      <div class="muted small" style="margin:6px 0 2px">With you:</div>
      ${info.myParty.members.map((p) => `<div class="rule-row">${p.leader ? '👑 ' : ''}<b>${esc(p.name)}</b><span class="muted small">${esc(p.role)}</span></div>`).join('')}`
        : `<div class="muted small">Waiting to be placed into a party. Check back here, or watch for a Discord message once parties are posted.</div>`}
      <button class="btn sm" style="margin-top:12px" data-act="merc-edit-toggle">Change my details</button>
    </div>`;
  }
  return `${head}${eventPanel}
  <div class="panel"><h3>${info.character ? 'Welcome back - confirm your character' : 'Your character for this event'}</h3>
    ${info.character ? '<div class="muted small" style="margin:-4px 0 10px">You signed up with us before. Change anything that is different, or just join as-is.</div>' : ''}
    <form data-form="merc-signup" data-id="${ev.id}">
      <div class="row"><div class="field"><label>Character name</label><input name="name" value="${esc(m.name)}" required maxlength="40"></div>
        <div class="field"><label>Role</label><select name="role">${opts(S.cfg.roles, m.role)}</select></div></div>
      <div class="row"><div class="field"><label>Primary weapon</label><select name="primaryWeapon">${opts(S.cfg.weapons, m.primaryWeapon, 'None')}</select></div>
        <div class="field"><label>Secondary weapon</label><select name="secondaryWeapon">${opts(S.cfg.weapons, m.secondaryWeapon, 'None')}</select></div></div>
      <div class="muted small" id="class-preview" style="margin:-4px 0 10px">${esc(classPreviewText(m.primaryWeapon, m.secondaryWeapon))}</div>
      <div class="field"><label>Specialization (optional)</label><input name="specialization" value="${esc(m.specialization || '')}" maxlength="40"></div>
      <div class="row"><div class="field"><label>Gear score</label><input name="gearScore" type="number" min="0" value="${m.gearScore || ''}"></div>
        <div class="field"><label>Watermark</label><input name="level" type="number" min="0" max="99" value="${m.level || ''}"></div></div>
      <div class="link-row">${info.joinedThisEvent ? '<button type="button" class="btn" data-act="merc-edit-toggle">Cancel</button>' : ''}<button class="btn primary">${info.character ? 'Confirm and join' : 'Join this event'}</button></div>
    </form>
  </div>`;
};
ACTIONS['merc-edit-toggle'] = () => { UI.mercEditing = !UI.mercEditing; render(); };
FORMS['merc-signup'] = (f, fd, id) => act(async () => { await api('/api/merc-signup/' + id, 'POST', fd); UI.mercInfoFor = null; UI.mercEditing = false; }, 'Joined. The officers can see you in the party board now.');

/* ================= Admin: the Discord bot, the channel for party pictures, applications ================= */
UI.dcheck = null;
const okMark = (ok, text, bad, optional) => `<div class="chk ${ok ? 'good' : optional ? 'info' : 'bad'}"><span>${ok ? '✓' : optional ? 'i' : '✗'}</span><div>${text}${!ok && bad ? `<div class="muted small">${esc(bad)}</div>` : ''}</div></div>`;
function discordAdmin() {
  const st = S.settings, pp = st.partyPost || {}, ap = st.applications || {}, c = UI.dcheck;
  const chans = c ? c.channels : [];
  const selected = pp.channelId;
  const options = [...(selected && !chans.some((x) => x.id === selected) ? [{ id: selected, name: pp.channelName || selected }] : []), ...chans];
  const mentioned = pp.mentionRoleIds || [];
  // c is null until the roles have actually been checked (either by hand or by the auto-check below), so a saved
  // role must not be called "not found" before that - that only means "not found yet", not "this role is gone".
  const roleOptions = !c ? mentioned.map((id) => ({ id, name: id + ' (checking...)' }))
    : [...c.roles, ...mentioned.filter((id) => !c.roles.some((r) => r.id === id)).map((id) => ({ id, name: id + ' (not found on the server - a deleted role?)' }))];
  return `<div class="panel"><h3>Discord: bot, party pictures and applications</h3>
    <div class="muted small" style="margin:-6px 0 10px">The bot is the Discord account this app uses. It is a <b>bot user</b> you create for free in the Discord Developer Portal (see the README, "Discord setup"). An ordinary Discord account cannot be used, because Discord forbids that.</div>
    <div class="link-row"><button class="btn" data-act="dcheck">Check the connection</button><span class="muted small">Looks up the bot, your server, its channels and its roles.</span></div>
    ${c ? `<div class="chk-list">
      ${okMark(c.login, 'Sign in with Discord is set up', 'Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID and PUBLIC_URL in the .env file.')}
      ${okMark(c.bot, 'Bot token is set', 'Set DISCORD_BOT_TOKEN in the .env file.')}
      ${c.bot ? okMark(!!c.botUser, c.botUser ? `The bot is <b>${esc(c.botUser.name)}</b>` : 'The bot token was not accepted', c.botError) : ''}
      ${c.bot ? okMark(!!c.guild, c.guild ? `The bot is in your server <b>${esc(c.guild.name)}</b>` : 'The bot is not in your server yet', c.guildError) : ''}
      ${c.bot && c.guild ? okMark(chans.length > 0, `${chans.length} text ${chans.length === 1 ? 'channel' : 'channels'} found`, c.channelsError || 'The bot sees no text channels. Check its role permissions.') : ''}
      ${okMark(c.memberRole, c.memberRole ? 'A member role is set (DISCORD_MEMBER_ROLE_ID): accepted applicants in the server get it' : 'No member role set: being in the Discord server is enough to be a member', '', true)}
      ${c.redirectUri ? `<div class="small muted">Redirect address for the Discord application: <code>${esc(c.redirectUri)}</code></div>` : ''}
      ${c.inviteUrl ? `<div class="small" style="margin-top:6px">Invite the bot to your server: <a href="${esc(c.inviteUrl)}" target="_blank" rel="noopener noreferrer">invite link</a> (view channels, send messages, attach files) · <a href="${esc(c.inviteUrlWithRoles)}" target="_blank" rel="noopener noreferrer">the same plus "Manage Roles"</a> if the bot should give the member role to accepted applicants.</div>` : ''}</div>` : ''}
    <h4 class="sub-head" style="margin-top:18px">Party pictures</h4>
    <form data-form="dpost"><div class="row"><div class="field"><label for="dc-ch">Channel</label><select id="dc-ch" name="channelId"><option value="">${chans.length || selected ? 'No channel chosen' : 'Press "Check the connection" to load your channels'}</option>${options.map((x) => `<option value="${esc(x.id)}" ${x.id === selected ? 'selected' : ''}>#${esc(x.name)}</option>`).join('')}</select></div></div>
      <div class="field"><label for="dc-tx">Text that goes with the picture</label><textarea id="dc-tx" name="text" maxlength="1500" style="min-height:90px">${esc(pp.text || '')}</textarea>
        <div class="muted small">You can use {event}, {type}, {date}, {time}, {parties} and {link} (the link to the event). Whoever posts can still change the text.</div></div>
      <div class="field"><label>@-mention these roles on every party announcement (optional)</label>
        ${roleOptions.length ? roleOptions.map((r) => `<label class="tagpick"><input type="checkbox" name="mrole" value="${esc(r.id)}" ${mentioned.includes(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('')
          : '<div class="muted small">Press "Check the connection" above to see your server\'s roles.</div>'}
        <div class="muted small" style="margin-top:2px">Up to 10. None ticked = no mention, exactly as before.</div></div>
      <label class="tagpick"><input type="checkbox" name="deletePrevious" ${pp.deletePrevious ? 'checked' : ''}> Delete the last party announcement message before posting a new one, so the channel only ever shows the latest one</label>
      <div class="link-row" style="margin-top:10px"><button class="btn primary">Save</button><button type="button" class="btn" data-act="dtest">Send a test message to this channel</button></div></form>
    <h4 class="sub-head" style="margin-top:18px">Applications</h4>
    <form data-form="dapps">
      <label class="tagpick"><input type="checkbox" name="enabled" ${ap.enabled ? 'checked' : ''}> People who are not in our Discord server (or lack the member role) can sign in with Discord and apply. Without this they are turned away.</label>
      <div class="field"><label for="da-in">Text above the application form</label><textarea id="da-in" name="intro" maxlength="1500" style="min-height:80px">${esc(ap.intro || '')}</textarea></div>
      <div class="field"><label for="da-iv">Invite link to your Discord server (sent to accepted people who are not in it yet)</label><input id="da-iv" name="inviteUrl" type="url" value="${esc(ap.inviteUrl || '')}" maxlength="300" placeholder="https://discord.gg/..."></div>
      <button class="btn primary">Save</button></form>
  </div>`;
}
// Mercenaries: outside players who help fill a roster for one event. They carry a different Discord role from
// regular guild members - picking it here is what "Get mercenaries" (on an event) pings when asking for help.
// Reuses the same channel/role data "Check the connection" above already loaded (UI.dcheck); no separate check.
function mercenariesAdmin() {
  const mc = S.settings.mercenaries || {}, c = UI.dcheck;
  const chans = c ? c.channels : [];
  const chanOptions = [...(mc.channelId && !chans.some((x) => x.id === mc.channelId) ? [{ id: mc.channelId, name: mc.channelName || mc.channelId }] : []), ...chans];
  const roles = !c ? (mc.roleId ? [{ id: mc.roleId, name: mc.roleName || (mc.roleId + ' (checking...)') }] : [])
    : (mc.roleId && !c.roles.some((r) => r.id === mc.roleId) ? [{ id: mc.roleId, name: (mc.roleName || mc.roleId) + ' (not found on the server - a deleted role?)' }] : []).concat(c.roles);
  return `<div class="panel"><h3>Mercenaries</h3>
    <div class="muted small" style="margin:-6px 0 10px">Players from other guilds who help fill the roster for one event. They sign in with Discord but are never guild
      members: they do not appear on the Member page or anywhere else, only in the party board of the event they signed up for, marked "Merc". An officer removes them
      whenever they like; nothing happens automatically.</div>
    <form data-form="mercset" class="rules-stack">
      <div class="rule-field"><label for="mc-ch">Channel to ask in</label><select id="mc-ch" name="channelId"><option value="">${chans.length || mc.channelId ? 'No channel chosen' : 'Press "Check the connection" above to load your channels'}</option>${chanOptions.map((x) => `<option value="${esc(x.id)}" ${x.id === mc.channelId ? 'selected' : ''}>#${esc(x.name)}</option>`).join('')}</select></div>
      <div class="rule-field"><label for="mc-role">Role to @-mention</label><div class="muted small" style="margin:2px 0 6px">The role your mercenaries carry on this Discord server - not the regular member role.</div><select id="mc-role" name="roleId"><option value="">${roles.length ? 'No role chosen' : 'Press "Check the connection" above to load your roles'}</option>${roles.map((r) => `<option value="${esc(r.id)}" ${r.id === mc.roleId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      <button class="btn primary">Save</button>
    </form>
  </div>`;
}
// Officer status comes from .env (DISCORD_OFFICER_ROLE_IDS / DISCORD_OFFICER_USER_IDS) and is checked once at
// sign-in. This panel adds two more ways to grant it, without touching .env or restarting the server - a
// Discord role (reuses the same role data "Check the connection" above loaded) or specific players directly.
function officersAdmin() {
  const st = S.settings, roleIds = st.officerRoleIds || [], userIds = st.officerUserIds || [], c = UI.dcheck;
  const allRoles = !c ? roleIds.map((id) => ({ id, name: id + ' (checking...)' }))
    : [...c.roles, ...roleIds.filter((id) => !c.roles.some((r) => r.id === id)).map((id) => ({ id, name: id + ' (not found on the server - a deleted role?)' }))];
  return `<div class="panel"><h3>Officers</h3>
    <div class="muted small" style="margin:-6px 0 10px">Officer status is decided when someone signs in, from Discord roles or players picked here, plus anything set in the
      server's .env file. Specific-player coach assignments take effect immediately, including for people already signed in. Discord-role assignments are refreshed when Discord sign-in updates their roles.</div>
    <form data-form="officers">
      <label><b>Discord roles that make someone an officer</b></label>
      ${allRoles.length ? allRoles.map((r) => `<label class="tagpick"><input type="checkbox" name="orole" value="${esc(r.id)}" ${roleIds.includes(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('')
        : '<div class="muted small">Press "Check the connection" above to see your server\'s roles.</div>'}
      <div class="muted small" style="margin:4px 0 14px">Up to 10. None ticked here just means nothing extra beyond .env.</div>
      <label><b>Specific players who are always officers</b></label>
      <div class="muted small" style="margin:2px 0 6px">Only players who have signed in before can be picked.</div>
      ${playerPickerFor('ouser', userIds)}
      <button class="btn primary" style="margin-top:10px">Save</button>
    </form>
  </div>`;
}
// A coach is a narrower role than officer: granted the same way (role or specific player), but only ever
// matters for VOD review - linking a coach to the students they review happens right below it, since the two
// settings are only ever useful together.
function coachesAdmin() {
  const st = S.settings, roleIds = st.coachRoleIds || [], userIds = st.coachUserIds || [], c = UI.dcheck;
  const allRoles = !c ? roleIds.map((id) => ({ id, name: id + ' (checking...)' }))
    : [...c.roles, ...roleIds.filter((id) => !c.roles.some((r) => r.id === id)).map((id) => ({ id, name: id + ' (not found on the server - a deleted role?)' }))];
  const coaches = (S.users || []).filter((u) => u.coach).sort((a, b) => a.name.localeCompare(b.name));
  const classes = (S.cfg.classes || []).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const links = st_coachLinks();
  return `<div class="panel"><h3>Coaches</h3>
    <div class="muted small" style="margin:-6px 0 10px">Coach status is decided when someone signs in, from Discord roles or players picked here, plus anything set in the
      server's .env file. Specific-player coach assignments take effect immediately, including for people already signed in. Discord-role assignments are refreshed when Discord sign-in updates their roles. A coach does not get officer
      permissions from this alone - it only ever matters for reviewing the VODs of the students linked to them below.</div>
    <form data-form="coaches">
      <label><b>Discord roles that make someone a coach</b></label>
      ${allRoles.length ? allRoles.map((r) => `<label class="tagpick"><input type="checkbox" name="crole" value="${esc(r.id)}" ${roleIds.includes(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('')
        : '<div class="muted small">Press "Check the connection" above (in the Discord panel) to see your server\'s roles.</div>'}
      <div class="muted small" style="margin:4px 0 14px">Up to 10. None ticked here just means nothing extra beyond .env.</div>
      <label><b>Specific players who are always coaches</b></label>
      <div class="muted small" style="margin:2px 0 6px">Only players who have signed in before can be picked.</div>
      ${playerPickerFor('cuser', userIds)}
      <button class="btn primary" style="margin-top:10px">Save</button>
    </form>
    <div class="muted small" style="margin:16px 0 8px;padding-top:14px;border-top:1px solid var(--line)"><b>Which classes each coach reviews</b></div>
    <div class="muted small" style="margin:-4px 0 10px">Linked by class, not by player - whoever is currently playing that class is automatically that coach's student, so this never needs updating as people join, leave, or switch classes.</div>
    ${coaches.length ? `<form data-form="coach-link" class="link-row">
      <select name="coach" aria-label="Coach">${coaches.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select>
      <select name="class" aria-label="Class">${classes.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
      <button class="btn sm primary">Link</button>
    </form>` : '<div class="muted small">No coaches yet - grant coach status above first.</div>'}
    ${links.length ? links.map((l) => `<div class="rule-row"><span><b>${esc(nameOfUser(l.coach))}</b> coaches <b>${esc(l.class)}</b> players</span><button class="btn sm danger" data-act="coach-unlink" data-id="${l.id}">Remove</button></div>`).join('')
      : (coaches.length ? '<div class="muted small">No classes linked yet.</div>' : '')}
  </div>`;
}
const st_coachLinks = () => S.coachLinks || [];
const nameOfUser = (id) => { const u = (S.users || []).find((x) => x.id === id); return u ? u.name : id; };
FORMS.coaches = (f) => act(() => api('/api/admin/coaches', 'PUT', {
  roleIds: [...f.querySelectorAll('input[name=crole]:checked')].map((i) => i.value),
  userIds: [...f.querySelectorAll('input[name=cuser]:checked')].map((i) => i.value),
}), 'Saved');
FORMS['coach-link'] = (f, fd) => act(() => api('/api/admin/coach-links', 'POST', { coach: fd.coach, class: fd.class }), 'Linked');
ACTIONS['coach-unlink'] = (el, d) => act(() => api(`/api/admin/coach-links/${d.id}`, 'DELETE'), 'Removed');
// Same idea as playerPicker() (used for login notices), with its own checkbox name so the two never collide if
// both forms were ever open at once.
const playerPickerFor = (name, selected = []) => `<div class="pp"><input type="search" class="pp-filter" placeholder="Search players" aria-label="Search players"><div class="scrollbox">${allPlayers().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<label class="tagpick" data-n="${esc(p.name.toLowerCase())}"><input type="checkbox" name="${name}" value="${esc(p.key)}" ${selected.includes(p.key) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('') || '<span class="muted small">No players yet.</span>'}</div></div>`;
FORMS.officers = (f) => act(() => api('/api/admin/officers', 'PUT', {
  roleIds: [...f.querySelectorAll('input[name=orole]:checked')].map((i) => i.value),
  userIds: [...f.querySelectorAll('input[name=ouser]:checked')].map((i) => i.value),
}), 'Saved');
ACTIONS['dcheck'] = () => act(async () => { UI.dcheck = await api('/api/admin/discord-check'); }, 'Checked');
FORMS.mercset = (f, fd) => act(() => api('/api/admin/mercenaries', 'PUT', {
  channelId: fd.channelId, channelName: f.elements.channelId.selectedOptions[0] ? f.elements.channelId.selectedOptions[0].textContent.replace(/^#/, '') : '',
  roleId: fd.roleId, roleName: f.elements.roleId.selectedOptions[0] ? f.elements.roleId.selectedOptions[0].textContent : '',
}), 'Saved');
FORMS.dpost = (f, fd) => act(() => api('/api/admin/discord', 'PUT', {
  partyPost: {
    channelId: fd.channelId, channelName: f.elements.channelId.selectedOptions[0] ? f.elements.channelId.selectedOptions[0].textContent.replace(/^#/, '') : '',
    text: fd.text, mentionRoleIds: [...f.querySelectorAll('input[name=mrole]:checked')].map((i) => i.value), deletePrevious: f.elements.deletePrevious.checked,
  },
}), 'Saved');
ACTIONS['dtest'] = () => {
  const sel = $('#dc-ch');
  if (!sel.value) return toast('Pick a channel first.', true);
  act(async () => { const r = await api('/api/admin/discord-test', 'POST', { channelId: sel.value }); if (!r.ok) throw new Error(r.error || 'The test message was not sent.'); }, 'Sent. Look in that channel.');
};
FORMS.dapps = (f, fd) => act(() => api('/api/admin/discord', 'PUT', { applications: { enabled: f.elements.enabled.checked, intro: fd.intro, inviteUrl: fd.inviteUrl } }), 'Saved');

/* ================= "Post to Discord": draw the parties as a picture and send it to a channel ================= */
let PARTY_IMG = '';
// maxCols caps how many party cards sit side by side. The Discord post (the default, 4) is viewed on a normal
// screen or can be zoomed in Discord itself; the mobile "View parties" popup instead forces 1 (see ACTIONS
// below), so each card gets the image's full width and the text stays a readable size once the dialog scales
// the image down to fit a phone screen - cramming 3-4 narrow columns into a 340px-wide dialog would make the
// player names and classes too small to read, which defeats the entire point of a mobile-friendly view.
async function renderPartiesImage(ev, { maxCols = 4 } = {}) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const css = getComputedStyle(document.documentElement);
  const roleCol = (role) => css.getPropertyValue('--role' + (Math.max(0, S.cfg.roles.indexOf(role)) % 5)).trim() || '#8b95a7';
  const accent = css.getPropertyValue('--accent').trim() || '#ac2d4c';
  const sans = '"Source Sans 3", system-ui, "Segoe UI", Arial, sans-serif', serif = 'Marcellus, Georgia, serif';
  const parties = ev.parties;
  const cols = Math.min(maxCols, Math.max(1, parties.length)), cardW = 300, gap = 16, pad = 28, rowH = 46, headH = 42, titleH = 108;
  const W = pad * 2 + cols * cardW + (cols - 1) * gap;
  const gridRows = Math.ceil(parties.length / cols);
  const cardH = (p) => headH + Math.max(p.members.length, 1) * rowH + 10;
  const rowHeights = Array.from({ length: gridRows }, (_, r) => Math.max(...parties.slice(r * cols, r * cols + cols).map(cardH)));
  const measure = document.createElement('canvas').getContext('2d');
  const wrap = (g, text, max) => { const out = []; let line = ''; for (const w of text.split(' ')) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; };
  // going, but not in a party
  const placed = new Set(parties.flatMap((p) => p.members));
  const unplaced = S.members.filter((m) => m.active && ev.rsvps[m.id] === 'yes' && !placed.has(m.id)).map((m) => m.name);
  measure.font = `400 15px ${sans}`;
  const unLines = unplaced.length ? wrap(measure, 'Going, but not in a party: ' + unplaced.join(', '), W - 2 * pad) : [];
  const H = pad + titleH + rowHeights.reduce((a, b) => a + b, 0) + (gridRows - 1) * gap + (unLines.length ? 16 + unLines.length * 21 : 0) + 42 + pad;
  const scale = W > 1300 ? 1.6 : 2;
  const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const g = c.getContext('2d'); g.scale(scale, scale); g.textBaseline = 'alphabetic';
  const fit = (text, max) => { if (g.measureText(text).width <= max) return text; let t = text; while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; };
  const rr = (x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
  g.fillStyle = '#130e11'; g.fillRect(0, 0, W, H);
  // title. A single narrow column (the mobile "View parties" popup) has no room to also reserve space for the
  // guild name on the same line without crushing the title down to a couple of letters - so a narrow canvas
  // drops the guild name (the app already makes it obvious whose parties these are) and uses a smaller title
  // font instead, rather than truncating the event's own title into something unreadable.
  const narrow = cols === 1;
  g.fillStyle = accent; g.fillRect(pad, pad, 52, 4);
  g.fillStyle = '#ebe5e3'; g.font = `400 ${narrow ? 26 : 34}px ${serif}`; g.fillText(fit(ev.title, W - 2 * pad - (narrow ? 0 : 200)), pad, pad + (narrow ? 38 : 46));
  g.fillStyle = '#a39499'; g.font = `400 17px ${sans}`;
  const total = parties.reduce((a, p) => a + p.members.length, 0);
  g.fillText(`${fmtDate(ev.start)}  ·  ${ev.type}  ·  ${parties.length} ${parties.length === 1 ? 'party' : 'parties'}, ${total} players`, pad, pad + 76);
  if (!narrow) { g.textAlign = 'right'; g.fillStyle = '#a39499'; g.font = `400 16px ${sans}`; g.fillText(guildName(), W - pad, pad + 20); g.textAlign = 'left'; }
  // parties
  let y0 = pad + titleH;
  const rowTop = []; rowHeights.forEach((h, i) => { rowTop[i] = y0; y0 += h + gap; });
  parties.forEach((p, i) => {
    const x = pad + (i % cols) * (cardW + gap), y = rowTop[Math.floor(i / cols)], h = cardH(p);
    g.fillStyle = '#1b1418'; rr(x, y, cardW, h, 10); g.fill(); g.strokeStyle = '#3a2a31'; g.lineWidth = 1; rr(x + .5, y + .5, cardW - 1, h - 1, 10); g.stroke();
    g.fillStyle = '#ebe5e3'; g.font = `600 18px ${sans}`; g.fillText(fit(p.name, cardW - 90), x + 14, y + 27);
    g.fillStyle = '#a39499'; g.font = `400 15px ${sans}`; g.textAlign = 'right'; g.fillText(`${p.members.length}/${S.cfg.partySize || 6}`, x + cardW - 14, y + 27); g.textAlign = 'left';
    g.fillStyle = '#3a2a31'; g.fillRect(x + 1, y + headH - 1, cardW - 2, 1);
    if (!p.members.length) { g.fillStyle = '#6f6268'; g.font = `italic 400 15px ${sans}`; g.fillText('Empty', x + 14, y + headH + 28); return; }
    p.members.forEach((id, j) => {
      const m = byId(S.members, id); if (!m) return;
      const eff = effectiveBuild(m, p), ry = y + headH + j * rowH, col = roleCol(eff.role);
      g.globalAlpha = 0.24; g.fillStyle = col; g.fillRect(x + 1, ry, cardW - 2, rowH - 2); g.globalAlpha = 1;
      g.fillStyle = col; g.fillRect(x + 1, ry, 4, rowH - 2);
      let nx = x + 16;
      if (p.leader === id) {                                                       // crown
        g.fillStyle = '#e6d08a'; g.beginPath(); g.moveTo(nx, ry + 27); g.lineTo(nx, ry + 15); g.lineTo(nx + 5, ry + 21); g.lineTo(nx + 9, ry + 13); g.lineTo(nx + 13, ry + 21); g.lineTo(nx + 18, ry + 15); g.lineTo(nx + 18, ry + 27); g.closePath(); g.fill(); nx += 25;
      }
      g.fillStyle = '#ebe5e3'; g.font = `600 17px ${sans}`;
      const tag = eff.isBuild ? eff.label : '';
      const tagW = tag ? (g.font = `600 12px ${sans}`, g.measureText(tag).width + 14) : 0;
      g.font = `600 17px ${sans}`; g.fillText(fit(m.name, cardW - (nx - x) - 14 - tagW), nx, ry + 20);
      if (tag) { g.font = `600 12px ${sans}`; const tw = g.measureText(tag).width; g.strokeStyle = '#ebe5e3'; g.globalAlpha = .6; rr(x + cardW - 14 - tw - 10, ry + 8, tw + 10, 17, 8); g.stroke(); g.globalAlpha = 1; g.fillStyle = '#ebe5e3'; g.fillText(tag, x + cardW - 14 - tw - 5, ry + 21); }
      const cls = classFor(eff.primaryWeapon, eff.secondaryWeapon), meta = [cls, eff.specialization].filter(Boolean).join(' | ') || [eff.primaryWeapon, eff.secondaryWeapon].filter(Boolean).join(' / ');
      g.fillStyle = '#c9bfc2'; g.font = `400 13px ${sans}`; g.fillText(fit(meta, cardW - (nx - x) - 14), nx, ry + 37);
    });
  });
  let yy = y0 - gap + 16;
  if (unLines.length) { g.fillStyle = '#a39499'; g.font = `400 15px ${sans}`; unLines.forEach((l, i) => g.fillText(l, pad, yy + 14 + i * 21)); yy += unLines.length * 21 + 14; }
  g.fillStyle = '#6f6268'; g.font = `400 13px ${sans}`; g.fillText(`Made with Guild Hall · ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ() })} ${tzAbbr(Date.now())}`, pad, H - pad + 6);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not make the picture'))), 'image/png'));
}
const blobToDataUrl = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
// A read-only, single-column picture of the parties - open to every member, not just officers, since this is
// about being able to actually read the line-up on a phone, not about editing it.
// "Get mercenaries": one row per role (Tank/Healer/DPS), each with an optional class and a count - 0 means "not
// needed", so the officer only fills in what actually matters. A separate "any role" count covers "just send
// warm bodies" without having to split it across roles. Kept to fixed rows (no add/remove-row JS) on purpose -
// there are only ever three roles, so a dynamic list would be more code for no real benefit here.
// Each need is its own row (role + class + count), freely repeatable - so "2 healers: 1 Oracle, 1 Seeker" is
// two separate rows with the same role and different classes, not one row trying to cover both at once.
// No separate Tank/Healer/DPS picker here - the class name itself (Oracle, Crusader, ...) already says what it
// is, and there is no reliable "which role is this class" data to filter by anyway, so a second dropdown would
// just be guesswork dressed up as a filter.
const mercNeedRow = (cls, count) => `<div class="row merc-need-row" style="align-items:end;margin-bottom:8px">
  <div class="field" style="flex:1"><label>Class</label><select class="mn-cls" aria-label="Class">${opts(S.cfg.classes.map((c) => c.name).sort(), cls)}</select></div>
  <div class="field" style="flex:0 0 80px"><label>Count</label><input class="mn-count" type="number" min="1" max="20" value="${count}" aria-label="Count"></div>
  <button type="button" class="btn sm danger" data-act="merc-need-remove" title="Remove this row" aria-label="Remove this row">×</button>
</div>`;
ACTIONS['merc-ask'] = (el, d) => {
  const ev = byId(S.events, d.id), mc = S.settings.mercenaries || {};
  if (!mc.channelId || !mc.roleId) return toast('Set the mercenary channel and role in Admin first.', true);
  openDialog(`<form data-form="merc-ask" data-id="${ev.id}"><h2>Get mercenaries for ${esc(ev.title)}</h2>
    <div class="field"><label for="ma-overall">Just need players, any class</label><input id="ma-overall" name="overall" type="number" min="0" max="50" value="0"></div>
    <div class="muted small" style="margin:4px 0 10px">Or ask for specific classes below. Add a row for each class you need.</div>
    <div id="merc-needs"></div>
    <button type="button" class="btn sm" data-act="merc-need-add" style="margin-bottom:10px">+ Add a class you need</button>
    <div class="field"><label for="ma-note">Note (optional)</label><textarea id="ma-note" name="note" maxlength="300" style="min-height:60px" placeholder="Anything else they should know"></textarea></div>
    <div class="muted small" style="margin-bottom:10px">Posts in #${esc(mc.channelName || mc.channelId)} and pings ${esc(mc.roleName || 'the mercenary role')}, with a link for them to sign in and join.</div>
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Ask for help</button></div></form>`);
};
ACTIONS['merc-need-add'] = (el) => { $('#merc-needs').insertAdjacentHTML('beforeend', mercNeedRow(S.cfg.classes[0].name, 1)); };
ACTIONS['merc-need-remove'] = (el) => { el.closest('.merc-need-row').remove(); };
FORMS['merc-ask'] = (f, fd, id) => {
  const needs = [...f.querySelectorAll('.merc-need-row')].map((row) => ({
    cls: row.querySelector('.mn-cls').value, count: Number(row.querySelector('.mn-count').value) || 0,
  })).filter((n) => n.count > 0);
  const overall = Number(fd.overall) || 0;
  if (!overall && !needs.length) return toast('Say how many players you need, or add at least one class.', true);
  act(async () => { await api(`/api/events/${id}/merc-request`, 'POST', { overall, needs, note: fd.note }); closeDialog(); }, 'Asked for mercenaries');
};
ACTIONS['parties-view'] = async (el, d) => {
  const ev = byId(S.events, d.id);
  if (!ev || !ev.parties.length) return;
  toast('Drawing the picture...');
  let img;
  try { img = await blobToDataUrl(await renderPartiesImage(ev, { maxCols: 1 })); } catch (e) { return toast('Could not draw the picture: ' + e.message, true); }
  openDialog(`<h2>${esc(ev.title)}</h2>
    <img class="post-preview" src="${img}" alt="Parties for ${esc(ev.title)}">
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Close</button></div>`);
};
ACTIONS['parties-post'] = async (el, d) => {
  const ev = byId(S.events, d.id);
  if (!S.cfg.botOn) return toast('The Discord bot is not set up yet. See Admin > Discord.', true);
  toast('Drawing the picture...');
  try { PARTY_IMG = await blobToDataUrl(await renderPartiesImage(ev)); } catch (e) { return toast('Could not draw the picture: ' + e.message, true); }
  const pp = S.settings.partyPost || {};
  let channels = [], selected = pp.channelId || '', problem = '', mentionNames = [];
  try {
    const [rc, rr] = await Promise.all([api('/api/discord/channels'), (pp.mentionRoleIds || []).length ? api('/api/discord/roles') : null]);
    channels = rc.channels;
    if (rr) mentionNames = (pp.mentionRoleIds || []).map((id) => (rr.roles.find((r) => r.id === id) || { name: id }).name);
  } catch (e) { problem = e.message; }
  const when = new Date(ev.start);
  const text = (pp.text || '📋 **{event}**: parties for {date} at {time}\n{link}')
    .replace(/\{event\}/g, ev.title).replace(/\{type\}/g, ev.type).replace(/\{parties\}/g, ev.parties.length)
    .replace(/\{date\}/g, when.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ() })).replace(/\{time\}/g, `${fmtTime(ev.start)} ${tzAbbr(when.getTime())}`);
  openDialog(`<form data-form="postparties" data-id="${ev.id}"><h2>Post the parties to Discord</h2>
    <img class="post-preview" src="${PARTY_IMG}" alt="Preview of the picture that will be posted">
    ${problem ? `<div class="warn-line" style="margin:10px 0">Could not load your channels: ${esc(problem)} Check Admin > Discord.</div>` : ''}
    <div class="field" style="margin-top:12px"><label for="pp-ch">Channel</label><select id="pp-ch" name="channelId" required><option value="">Choose a channel</option>${channels.map((x) => `<option value="${esc(x.id)}" ${x.id === selected ? 'selected' : ''}>#${esc(x.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="pp-tx">Text</label><textarea id="pp-tx" name="text" maxlength="1900" style="min-height:90px">${esc(text)}</textarea><div class="muted small">{link} becomes the link to this event.</div></div>
    ${mentionNames.length ? `<div class="muted small" style="margin:-4px 0 12px">Will also @-mention: <b>${mentionNames.map(esc).join(', ')}</b> (set in Admin > Discord).</div>` : ''}
    ${pp.deletePrevious ? `<div class="muted small" style="margin:-4px 0 12px">The last party announcement will be deleted right before this one posts (Admin > Discord).</div>` : ''}
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary" ${problem ? 'disabled' : ''}>Post it</button></div></form>`, true);
};
FORMS.postparties = (f, fd, id) => {
  const sel = f.elements.channelId, name = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.replace(/^#/, '') : '';
  act(async () => {
    await api(`/api/events/${id}/post-parties`, 'POST', { image: PARTY_IMG, text: fd.text, channelId: fd.channelId, channelName: name });
    closeDialog(); PARTY_IMG = '';
    dmMercsTheirParty(byId(S.events, Number(id)));   // best-effort, does not block or affect the toast above
  }, `Posted in #${name}`);
};
// Every mercenary currently placed in a party gets a DM with just that one party - same picture style as the
// channel post, cropped to the one party they are actually in. One failed DM (closed DMs, etc.) does not stop
// the others; each is reported with its own quiet toast rather than one popup for the whole batch.
async function dmMercsTheirParty(ev) {
  if (!ev) return;
  const mercsPlaced = ev.parties.flatMap((p) => p.members).map((id) => byId(S.members, id)).filter((m) => m && m.mercenary);
  for (const merc of mercsPlaced) {
    const party = ev.parties.find((p) => p.members.includes(merc.id));
    // rsvps cleared too: renderPartiesImage also lists everyone "going but not placed" using the full guild's
    // RSVPs, which has nothing to do with this mercenary's own party and would otherwise leak the rest of the
    // roster into what is meant to be just their own picture.
    const cropped = { ...ev, parties: [party], rsvps: {} };
    try {
      const img = await blobToDataUrl(await renderPartiesImage(cropped, { maxCols: 1 }));
      const r = await api(`/api/events/${ev.id}/merc-dm/${merc.id}`, 'POST', { image: img });
      if (!r.ok) toast(`Could not DM ${merc.name}: ${r.error}`, true);
    } catch (e) { toast(`Could not DM ${merc.name}: ${e.message}`, true); }
  }
}


/* ================= Admin: every section is a dropdown ================= */
AFTER_RENDER.push((page) => {
  if (page !== 'admin') return;
  const main = $('#main');
  for (const p of [...main.children]) {
    if (!p.classList.contains('panel') || !p.firstElementChild || p.firstElementChild.tagName !== 'H3') continue;
    const title = p.firstElementChild.textContent.trim(), key = 'adm:' + title;
    const d = document.createElement('details'); d.className = 'panel fold adm'; d.dataset.fold = key;
    if ((UI.fold || {})[key]) d.open = true;
    const sum = document.createElement('summary'); sum.textContent = title;
    const body = document.createElement('div'); body.className = 'fold-body';
    p.firstElementChild.remove(); while (p.firstChild) body.appendChild(p.firstChild);
    d.append(sum, body); p.replaceWith(d);
  }
  const head = main.querySelector('.page-head');
  if (head && !head.querySelector('[data-act=adm-all]')) head.insertAdjacentHTML('beforeend', '<span class="seg"><button class="btn sm" data-act="adm-all" data-open="1">Open all</button><button class="btn sm" data-act="adm-all" data-open="0">Close all</button></span>');
});
ACTIONS['adm-all'] = (el, d) => document.querySelectorAll('details.adm').forEach((x) => { x.open = d.open === '1'; (UI.fold = UI.fold || {})[x.dataset.fold] = x.open; });

/* ================= audit log (leadership only): who changed what, searchable and paginated ================= */
Object.assign(UI, { auditQ: { user: '', action: '', target: '', from: '', to: '', page: 1 }, auditResult: null, auditActions: null });
const ACTION_LABELS = {
  'member.create': 'Character created', 'member.update': 'Character edited', 'member.delete': 'Character removed',
  'event.create': 'Event created', 'event.update': 'Event edited', 'event.delete': 'Event deleted',
  'attendance.record': 'Attendance recorded', 'party.update': 'Parties set on an event',
  'party.preset.create': 'Party preset created', 'party.preset.update': 'Party preset edited', 'party.preset.delete': 'Party preset deleted',
  'points.adjust': 'Points adjusted', 'points.delete': 'Points entry deleted',
  'settings.update': 'Guild settings changed', 'discord.settings.update': 'Discord settings changed',
  'application.accept': 'Application accepted', 'application.reject': 'Application rejected', 'owner.link': 'Characters linked to a player',
};
const actionLabel = (a) => ACTION_LABELS[a] || a;

async function loadAudit() {
  const q = UI.auditQ, qs = Object.entries({ user: q.user, action: q.action, target: q.target, from: q.from, to: q.to, page: q.page, limit: 50 })
    .filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  try { UI.auditResult = await api('/api/admin/audit?' + qs); } catch (e) { UI.auditResult = { error: e.message }; }
  if (!UI.auditActions) { try { UI.auditActions = await api('/api/admin/audit/actions'); } catch { UI.auditActions = []; } }
  render();
}
AFTER_RENDER.push((page) => { if (page === 'auditlog' && UI.auditResult === null) loadAudit(); });
// Quietly re-check the Discord connection (channels, roles) the moment Admin is opened, rather than only when
// "Check the connection" is clicked by hand - otherwise a saved @-mention role looks "not found" on every fresh
// visit until that button is pressed again, even though the role is perfectly fine.
async function loadDcheck() { try { UI.dcheck = await api('/api/admin/discord-check'); } catch { UI.dcheck = { channels: [], roles: [] }; } render(); }
AFTER_RENDER.push((page) => { if (page === 'admin' && UI.dcheck === null) loadDcheck(); });

const diffRow = (label, before, after) => `<div><span class="muted">${esc(label)}:</span> ${esc(String(before ?? ''))} <span class="arrow">→</span> <b>${esc(String(after ?? ''))}</b></div>`;
function auditRow(e) {
  const hasDiff = e.before && e.after && Object.keys(e.before).length;
  return `<tr>
    <td class="muted small nowrap">${fmtShort(e.at)}</td>
    <td><b>${esc(e.byName || 'System')}</b></td>
    <td><span class="type-pill">${esc(actionLabel(e.action))}</span></td>
    <td>${e.targetName ? `${esc(e.targetName)}${e.targetType ? ` <span class="muted small">(${esc(e.targetType)})</span>` : ''}` : '<span class="muted">-</span>'}</td>
    <td>${esc(e.description)}${hasDiff ? `<details class="ql-drop"><summary>What changed</summary><div class="diff">${Object.keys(e.before).map((k) => diffRow(k, e.before[k], e.after[k])).join('')}</div></details>` : ''}</td>
  </tr>`;
}
VIEWS.auditlog = () => {
  const q = UI.auditQ, r = UI.auditResult;
  return `
  <div class="page-head"><div><h1>Audit log</h1><div class="muted">Who changed what, and when. Only the leadership can see this.</div></div></div>
  <div class="toolbar">
    <input type="search" placeholder="Search player" value="${esc(q.user)}" data-act="audit-user" aria-label="Filter by player">
    <select data-act="audit-action" aria-label="Filter by action"><option value="">All actions</option>${(UI.auditActions || []).map((a) => `<option value="${esc(a)}" ${q.action === a ? 'selected' : ''}>${esc(actionLabel(a))}</option>`).join('')}</select>
    <input type="search" placeholder="Search target (character, event...)" value="${esc(q.target)}" data-act="audit-target" aria-label="Filter by target">
    <label class="small muted" style="margin:0">From <input type="date" value="${esc(q.from)}" data-act="audit-from" aria-label="From date" style="width:auto"></label>
    <label class="small muted" style="margin:0">To <input type="date" value="${esc(q.to)}" data-act="audit-to" aria-label="To date" style="width:auto"></label>
    ${(q.user || q.action || q.target || q.from || q.to) ? '<button class="btn sm" data-act="audit-clear">Clear filters</button>' : ''}
  </div>
  ${!r ? '<div class="empty">Loading...</div>' : r.error ? `<div class="empty">${esc(r.error)}</div>` : r.entries.length ? `
  <div class="tbl-wrap"><table>
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
    <tbody>${r.entries.map(auditRow).join('')}</tbody>
  </table></div>
  <div class="toolbar" style="margin-top:14px;justify-content:space-between">
    <span class="muted small">${r.total} ${r.total === 1 ? 'entry' : 'entries'} · page ${r.page} of ${r.pages}</span>
    <span class="seg"><button class="btn sm" data-act="audit-page" data-p="${r.page - 1}" ${r.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn sm" data-act="audit-page" data-p="${r.page + 1}" ${r.page >= r.pages ? 'disabled' : ''}>Next</button></span>
  </div>` : '<div class="empty">Nothing matches these filters.</div>'}`;
};
const auditRefetch = (field) => (el) => { UI.auditQ = { ...UI.auditQ, [field]: el.value, page: 1 }; loadAudit(); };
CHANGES['audit-user'] = auditRefetch('user');
CHANGES['audit-action'] = auditRefetch('action');
CHANGES['audit-target'] = auditRefetch('target');
CHANGES['audit-from'] = auditRefetch('from');
CHANGES['audit-to'] = auditRefetch('to');
ACTIONS['audit-clear'] = () => { UI.auditQ = { user: '', action: '', target: '', from: '', to: '', page: 1 }; loadAudit(); };
ACTIONS['audit-page'] = (el, d) => { UI.auditQ = { ...UI.auditQ, page: Number(d.p) }; loadAudit(); };

/* ================= Admin: one character per player (clean up duplicates from before this rule existed) =================
   This tool stays in the code (it is reachable again if old data ever needs it) but is no longer shown on the
   Admin page by request, since every player's data is already down to one character. */
Object.assign(UI, { dupes: null });
function oneCharAdmin() {
  const d = UI.dupes;
  return `<div class="panel"><h3>One character per player</h3>
    <div class="muted small" style="margin:-6px 0 10px">Every player can only have one character now. This finds anyone who still has more than one from before that rule existed, and removes the extra ones - keeping each player's oldest character and cleaning up everywhere else it is referenced (parties, loot, points, sign-ups), the same as a normal delete.</div>
    <button class="btn" data-act="dupes-check">Check for players with more than one character</button>
    ${d === null ? '' : !d.length ? '<div class="muted small" style="margin-top:10px">Nobody has more than one character. Nothing to do.</div>' : `
    <div style="margin-top:12px">${d.map((g) => `<div class="rule-row"><span style="flex:1"><b>${esc(g.name)}</b>:
      keep <span class="type-pill">${esc(g.keep.name)}</span> (${esc(g.keep.role)}) · remove ${g.remove.map((m) => `${esc(m.name)} (${esc(m.role)})`).join(', ')}</span></div>`).join('')}</div>
    <button class="btn danger" style="margin-top:10px" data-act="dupes-apply">Remove the extra characters listed above</button>`}
  </div>`;
}
ACTIONS['dupes-check'] = () => act(async () => { UI.dupes = await api('/api/admin/duplicate-characters'); }, 'Checked');
ACTIONS['dupes-apply'] = () => {
  const n = (UI.dupes || []).reduce((a, g) => a + g.remove.length, 0);
  if (!confirm(`Remove ${n} extra ${n === 1 ? 'character' : 'characters'} across ${UI.dupes.length} ${UI.dupes.length === 1 ? 'player' : 'players'}? Each player keeps their oldest character. This cannot be undone.`)) return;
  act(async () => { const r = await api('/api/admin/enforce-one-character', 'POST', {}); UI.dupes = []; toast(`Removed ${r.removed} extra ${r.removed === 1 ? 'character' : 'characters'}.`); });
};

/* ================= Admin: the final page, in the order the leadership wants it ================= */
VIEWS.admin = () => {
  if (!isOfficer()) return '<div class="empty">Officers only.</div>';
  return '<div class="page-head"><h1>Admin</h1></div>'
    + appearanceAdmin()
    + discordAdmin()
    + officersAdmin()
    + coachesAdmin()
    + mercenariesAdmin()
    + adminPlayersList()
    + noticesAdmin()
    + tagsAdmin()
    + complianceAdmin()
    + adminEventRules()
    + adminPointsToggle()
    + approvalRulesAdmin()
    + accessAdmin()
    + adminSignIn()
    + adminBackup()
    + adminCustomizingText();
};
