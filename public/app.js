'use strict';
/* ================= state & helpers ================= */
const S = { cfg: null, user: null, members: [], events: [], points: [], duties: [], presets: [], loot: [], presetRules: [], users: [], applications: [], application: null, notices: [], leaves: [], warnings: [], explanations: [], alert: null, infoBoard: { title: 'Info', categories: [] }, requests: [], changes: [], profiles: {}, series: [], tags: [], playerTags: {}, prefs: {}, settings: { lootFrom: '', lootThreshold: 60, lootRedMax: 59, lootOrangeMax: 80, lootItemDays: 7, pointsEnabled: true, signupCloseDefault: 30, pinOffsetMinutes: 0, pinWindowDefault: 15, reminderMinutes: [300, 120], remindersEnabled: true, approvals: {}, hiddenSections: [], branding: {}, compliance: {} }, now: Date.now() };
const UI = { rosterQ: '', rosterRole: '', rosterWeapon: '', rosterInactive: false, rosterSort: 'name', pointsFocus: null, showPast: false, calView: 'week', calRef: null, presetId: null, lootOnlyOk: false, lootOpen: {}, rulesOpen: false, lootQ: '', lootPlayer: '', lootType: '', lootFormType: '', lootMember: '', lootDate: '' };
// Pages, click actions, change handlers and form handlers can be added from features.js.
const AFTER_RENDER = [];  // functions run after a page was drawn (page name as argument)
const VIEWS = {};      // page name -> function that returns the page's HTML
const ACTIONS = {};    // data-act value -> function (element, dataset, event) for clicks
const CHANGES = {};    // data-act value -> function (element) for change events
const FORMS = {};      // data-form value -> function (form, formData, id) for submits
UI.rosterTag = ''; UI.rosterMode = '';
let DRAG = null; // what is being dragged right now (party board)
let token = localStorage.getItem('gh_token') || '';
let lastSnapshot = '';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isOfficer = () => S.user && S.user.role === 'officer';
const pointsOn = () => S.settings.pointsEnabled !== false;
const byId = (arr, id) => arr.find((x) => x.id === Number(id));
// A character's owner is the Discord user id (or the display name in demo mode); S.user.key is that same value for the person signed in.
const mine = () => S.members.filter((m) => m.owner === S.user.key && m.active);
const canEdit = (m) => isOfficer() || m.owner === S.user.key;
const ownerName = (o) => (S.users.find((u) => u.id === o) || {}).name || o;
const avatarUrl = (u) => { const id = u && (u.id || u.key); return u && u.avatar && /^\d{15,25}$/.test(String(id)) ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.png?size=64` : ''; };
const avatarImg = (u) => (avatarUrl(u) ? `<img class="avatar" src="${esc(avatarUrl(u))}" alt="" width="24" height="24">` : '');
/* ---- time zone ---- */
const pad = (n) => String(n).padStart(2, '0');
const tzOk = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return !!z; } catch { return false; } };
const TZ = () => { const z = S.prefs && S.prefs.timezone; return z && tzOk(z) ? z : (S.cfg && S.cfg.defaultTimezone) || 'Europe/Berlin'; };
const tzAbbr = (ms) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: TZ(), timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value; } catch { return TZ(); } };
// The date and time on a wall clock in the chosen zone.
function wall(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ(), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
}
const wallKey = (ms) => { const w = wall(ms); return w.y * 10000 + w.m * 100 + w.d; };
const todayTz = () => { const w = wall(Date.now()); return `${w.y}-${pad(w.m)}-${pad(w.d)}`; };
const addDayStr = (str, n) => { const [y, m, d] = str.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
// "2026-09-21T21:00" typed as wall-clock time in the chosen zone -> the real moment (ISO string)
function tzToIso(str) {
  const [dp, tp] = str.split('T'), [y, m, d] = dp.split('-').map(Number), [hh, mm] = (tp || '00:00').split(':').map(Number);
  const wallMs = Date.UTC(y, m - 1, d, hh, mm);
  const off = (ms) => { const w = wall(ms); return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm) - Math.floor(ms / 60000) * 60000) / 60000); };
  let utc = wallMs - off(wallMs) * 60000;
  utc = wallMs - off(utc) * 60000;
  return new Date(utc).toISOString();
}
// A timestamp that sits at noon of a calendar day in the chosen zone (used to remember which week/month the calendar shows).
const dayRef = (y, m, d) => Date.parse(tzToIso(`${y}-${pad(m)}-${pad(d)}T12:00`));
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: TZ() });

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { logout(); throw new Error(data.error || 'Signed out.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : '';
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3200);
}
// Runs an action, shows the result, refreshes the data. Resolves to true when it worked, so callers can add their own message.
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(true); return true; }
  catch (e) { toast(e.message, true); return false; }
}

const roleColor = (role) => `var(--role${Math.max(0, S.cfg.roles.indexOf(role)) % 5})`;
const roleChip = (role) => `<span class="chip" style="--c:${roleColor(role)}">${esc(role)}</span>`;
// In Throne and Liberty the pair of equipped weapons decides the class name (table lives in config.json).
const classFor = (a, b) => {
  if (!a || !b || a === b) return '';
  const c = (S.cfg.classes || []).find((c) => c.weapons.includes(a) && c.weapons.includes(b));
  return c ? c.name : '';
};
const classOf = (m) => classFor(m.primaryWeapon, m.secondaryWeapon);
const weaponLine = (m) => {
  const w = [m.primaryWeapon, m.secondaryWeapon].filter(Boolean);
  if (!w.length) return '<span class="muted">-</span>';
  const cls = classOf(m);
  return `${esc(w.join(' / '))}${cls ? ` - <span class="cls">${esc(cls)}</span>` : ''}${m.specialization ? ` <span class="spec">| ${esc(m.specialization)}</span>` : ''}`;
};
const fmtDate = (iso) => `${new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ() })} ${tzAbbr(new Date(iso).getTime())}`;
const fmtShort = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ() });
const toLocalInput = (iso) => { const w = wall(new Date(iso).getTime()); return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.hh)}:${pad(w.mm)}`; };
function until(iso) {
  const ms = new Date(iso) - Date.now(); const abs = Math.abs(ms);
  const d = Math.floor(abs / 864e5), h = Math.floor(abs % 864e5 / 36e5), m = Math.floor(abs % 36e5 / 6e4);
  const s = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return ms >= 0 ? `in ${s}` : `${s} ago`;
}
const rankIdx = (r) => { const i = S.cfg.ranks.indexOf(r); return i < 0 ? 99 : i; };
const balance = (id) => S.points.filter((p) => p.memberId === id).reduce((a, p) => a + p.delta, 0);
// A member's list of attended events only holds their own characters, so "roll was taken" comes from the server.
const rolled = (e) => (e.rollTaken !== undefined ? e.rollTaken : e.attended.length > 0);
// My own outcome for an event, used to colour it in the calendar:
//   attended (green) . no-show (red, after the event) . no reply (orange, after the event) . not attending (grey)
const STATUS_TEXT = { attended: 'You were there', noshow: 'No-show: you said Going but were not recorded', noreply: 'You did not answer', declined: 'You are not attending' };
function myStatus(e) {
  const ids = mine().map((m) => m.id);
  if (!ids.length) return '';
  if (ids.some((id) => e.attended.includes(id))) return 'attended';
  const answers = ids.map((id) => e.rsvps[id]), start = new Date(e.start).getTime();
  const over = start < Date.now() && rolled(e);                              // the leadership recorded who came, so the outcome is known
  if (answers.includes('yes')) return over ? 'noshow' : '';
  if (answers.includes('no')) return 'declined';
  return over && !onLeaveAt(S.user.key, start) ? 'noreply' : '';
}
function attendanceStats(id) {
  const recorded = S.events.filter((e) => new Date(e.start) < Date.now() && rolled(e));
  const n = recorded.filter((e) => e.attended.includes(id)).length;
  return { n, of: recorded.length, pct: recorded.length ? Math.round(100 * n / recorded.length) : null };
}
const enc = encodeURIComponent;
const classPreviewText = (a, b) => { const c = classFor(a, b); return c ? 'Class: ' + c : a && b && a !== b ? 'Class: this pair has no name in the list yet (it works, the weapons are shown instead)' : 'Class: pick two different weapons'; };
// Leave of absence and warnings (the server sends the leadership everything and a member only their own).
const guildDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: S.cfg.defaultTimezone || 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const onLeaveAt = (owner, ms) => { const d = guildDate(ms); return (S.leaves || []).some((l) => l.ownerKey === owner && l.status === 'approved' && l.from <= d && d <= l.to); };
const activeWarn = (owner) => (S.warnings || []).filter((w) => w.ownerKey === owner && w.status === 'active');
const isDisqualified = (owner) => { const n = (S.settings.compliance || {}).disqualifyAt || 0; return n > 0 && activeWarn(owner).length >= n; };
const linkLabel = (l) => l.label || l.url.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 40);
const questlogLinks = (m, sep = '<br>') => ((m.questlogs || []).length
  ? (m.questlogs).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(l))}</a>`).join(sep)
  : '<span class="muted">Not added yet. Players add their links on their profile page.</span>');
const buildLabel = (b) => `${b.mode}: ${classFor(b.primaryWeapon, b.secondaryWeapon) || b.name}`;
// The build a player uses in a party: their main one unless the leadership picked another for that party.
function effectiveBuild(m, party) {
  const k = party && party.builds && party.builds[m.id];
  const b = k && (m.builds || []).find((x) => String(x.id) === String(k));
  return b ? { ...b, key: String(b.id), label: b.name, isBuild: true }
           : { role: m.role, primaryWeapon: m.primaryWeapon, secondaryWeapon: m.secondaryWeapon, specialization: m.specialization, gearScore: m.gearScore, key: 'main', label: 'Main', mode: m.mode || 'PvE' };
}
const tagsOf = (owner) => (S.playerTags[owner] || []).map((id) => S.tags.find((t) => t.id === id)).filter(Boolean);
const tagChip = (t) => `<span class="tagchip" style="--tc:${esc(t.color)}">${esc(t.name)}</span>`;
const opts = (list, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') +
  list.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');

/* ================= auth ================= */
// Guild name, tagline, icon, background picture and accent colour. Before sign-in they come from /api/config, afterwards from the live settings.
function brand() {
  const b = S.user && S.settings.branding && Object.keys(S.settings.branding).length ? S.settings.branding : null;
  if (!b) return S.cfg.branding || {};
  return { name: b.name, tagline: b.tagline, accent: b.accent, bgDim: b.bgDim, announcement: b.announcement, icon: b.iconFile ? '/uploads/' + b.iconFile : '', bg: b.bgFile ? '/uploads/' + b.bgFile : '' };
}
const guildName = () => brand().name || S.cfg.guildName;
const guildTag = () => brand().tagline || S.cfg.tagline;
function applyBranding() {
  const b = brand(), root = document.documentElement.style;
  if (b.accent) {
    const n = parseInt(b.accent.slice(1), 16), lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    root.setProperty('--accent', b.accent);
    root.setProperty('--accent-text', `color-mix(in srgb, ${b.accent} 55%, white)`);
    root.setProperty('--accent-ink', lum > 0.62 ? '#14101a' : '#fff4f6');
  } else ['--accent', '--accent-text', '--accent-ink'].forEach((p) => root.removeProperty(p));
  const dim = (b.bgDim ?? 82) / 100;
  document.body.style.backgroundImage = b.bg ? `linear-gradient(rgba(14,10,14,${dim}), rgba(14,10,14,${Math.min(1, dim + 0.08)})), url("${b.bg}")` : '';
  document.body.style.backgroundSize = 'cover'; document.body.style.backgroundAttachment = 'fixed'; document.body.style.backgroundPosition = 'center';
  document.title = guildName();
  let link = document.querySelector('link[rel=icon]');
  if (b.icon) { if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); } link.href = b.icon; } else if (link) link.remove();
  const gi = $('#brand-icon'); if (gi) { gi.classList.toggle('hidden', !b.icon); if (b.icon) gi.src = b.icon; }
  const li = $('#login-icon'); if (li) { li.classList.toggle('hidden', !b.icon); if (b.icon) li.src = b.icon; }
}
function showLogin() {
  const nb = $('#notice'); if (nb && nb.open) nb.close();
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#login-guild').textContent = guildName(); $('#login-tag').textContent = guildTag();
  const dc = S.cfg.authMode === 'discord';
  $('#login-discord').classList.toggle('hidden', !dc); $('#login-passcode').classList.toggle('hidden', dc);
  const an = $('#login-apply-note'); if (an) an.classList.toggle('hidden', !S.cfg.applicationsOpen);
  // Someone who followed a mercenary-signup link in Discord lands here too, before they have signed in. Send
  // them through a marked version of the same Discord sign-in that is let through even when general guild
  // applications (a different thing) are switched off, and swap the note so it does not say "send us an
  // application" to someone who is not trying to become a guild member at all.
  const merc = /^#\/merc\/\d+$/.test(location.hash);
  const dLink = $('#login-discord a.discord'); if (dLink) dLink.href = merc ? '/auth/discord?merc=1' : '/auth/discord';
  const mn = $('#login-merc-note'); if (mn) mn.classList.toggle('hidden', !merc);
  if (an && merc) an.classList.add('hidden');
  // The Discord round trip (this app -> Discord -> /auth/discord/callback -> this app again) is a full page
  // reload through a different path, which drops the #/merc/... hash along the way - save it here, before the
  // person leaves for Discord, and start() below restores it once they are actually signed in.
  if (merc) localStorage.setItem('gh_pending_hash', location.hash);
  const q = new URLSearchParams(location.search);
  if (q.get('loginError')) { $('#login-err').textContent = q.get('loginError'); history.replaceState(null, '', location.pathname + location.hash); }
  applyBranding();
}
async function logout() {
  token = ''; localStorage.removeItem('gh_token'); S.user = null;
  if (S.cfg && S.cfg.authMode === 'discord') { try { await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); } catch {} }
  showLogin();
}

/* ================= data ================= */
async function refresh(force) {
  const st = await api('/api/state');
  const snap = JSON.stringify([st.members, st.events, st.points, st.duties, st.presets, st.loot, st.requests, st.changes, st.profiles, st.series, st.tags, st.playerTags, st.prefs, st.notices, st.infoBoard, st.leaves, st.warnings, st.explanations, st.alert, st.applications, st.application, st.settings, st.user]);
  Object.assign(S, st);
  if (!force && snap === lastSnapshot) return;
  lastSnapshot = snap;
  checkNotices();                                   // a new notice appears even while somebody is typing
  const a = document.activeElement;
  const typing = a && $('#main').contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
  if (!force && (typing || $('#dlg').open || DRAG || $('#main details.menu[open]'))) return;
  render();
}

/* ================= routing and navigation ================= */
function route() { const [, page = 'dashboard', id] = location.hash.split('/'); return { page, id: id ? decodeURIComponent(id) : id }; }
// hide = the name of a section the leadership can hide from normal members (Admin)
const NAV = [
  { key: 'apply', label: () => 'My application' },
  { key: 'merc', label: () => 'My mercenary signup' },
  { key: 'dashboard', label: () => 'Dashboard' },
  { key: 'member', label: () => 'Member', hide: 'member' },
  { key: 'loot', label: () => 'Loot', hide: 'loot' },
  { key: 'vods', label: () => 'VODs', hide: 'vods' },
  { key: 'events', label: () => 'Events' },
  { key: 'parties', label: () => 'Parties', hide: 'parties' },
  { key: 'points', label: () => (pointsOn() ? 'Points' : 'Attendance'), hide: 'points' },
  { key: 'requests', label: () => 'Requests', hide: 'requests', badge: () => (isOfficer() ? S.requests.filter((r) => r.status === 'open').length : 0) },
  { key: 'leave', label: () => 'Leave of absence', badge: () => (isOfficer() ? 0 : 0) },
  { key: 'approvals', label: () => 'Approvals', officer: true, badge: () => S.changes.filter((c) => c.status === 'pending').length + S.leaves.filter((l) => l.status === 'pending').length + S.explanations.filter((x) => x.status === 'pending').length + S.applications.filter((a) => a.status === 'pending').length },
  { key: 'warnings', label: () => 'Warnings', badge: () => (isOfficer() ? 0 : activeWarn(S.user.key).length) },
  { key: 'auditlog', label: () => 'Audit log', officer: true },
  { key: 'admin', label: () => 'Admin', officer: true },
  { key: 'profile', label: () => 'My profile', gap: true },
];
const hiddenFromMembers = (key) => (S.settings.hiddenSections || []).includes(key);
function canSee(page) {
  if (S.user && S.user.role === 'applicant') return page === 'apply' || page === 'merc';       // not accepted: only the application, or a mercenary signup link they followed - canSee allows reaching it even before S.mercEventId exists (their very first visit, before they have signed up at all); the nav link itself is shown separately, only once they actually are a mercenary
  if (page === 'apply') return false;
  const n = NAV.find((x) => x.key === page);
  if (!n) return page === 'roster';
  if (n.officer) return isOfficer();
  return isOfficer() || !(n.hide && hiddenFromMembers(n.hide));
}
function renderNav(page) {
  // "merc" is the one nav entry that needs an id in its link (which event) - shown at all only once someone
  // actually is a mercenary (S.mercEventId set by applicantState() server-side), not to every applicant.
  $('#nav-links').innerHTML = NAV.filter((n) => canSee(n.key) && (n.key !== 'merc' || S.mercEventId)).map((n) => {
    const b = n.badge ? n.badge() : 0;
    const href = n.key === 'merc' ? `#/merc/${S.mercEventId}` : `#/${n.key}`;
    return `<a class="nav ${n.key === page ? 'active' : ''} ${n.gap ? 'gap' : ''}" href="${href}" data-nav="${n.key}">${esc(n.label())}${b ? `<span class="count">${b}</span>` : ''}</a>`;
  }).join('');
}
function render() {
  let { page, id } = route();
  if (page === 'roster') page = 'member';
  if (S.user.role === 'applicant' && page !== 'merc') page = 'apply';
  if (!canSee(page) || !VIEWS[page]) page = 'dashboard';
  applyBranding();
  renderNav(page);
  $('#who').innerHTML = `${avatarImg(S.user)}<b>${esc(S.user.name)}</b>${isOfficer() ? '<span class="badge-officer">Officer</span>' : S.user.role === 'applicant' ? '<span class="badge-officer" style="color:var(--muted);border-color:var(--muted)">Applicant</span>' : ''}`;
  $('#brand-name').textContent = guildName(); $('#brand-tag').textContent = guildTag();
  $('#main').innerHTML = VIEWS[page](id);
  for (const h of AFTER_RENDER) h(page);
  checkNotices();
}
window.addEventListener('hashchange', () => {
  if (!S.user) return;
  render();
  refresh().catch(() => {});                       // pick up changes other people made while you were on another page
  const r = route();
  if (r.page === 'events' && r.id) { const d = $('#ev-detail'); if (d) d.scrollIntoView({ block: 'start' }); }
});

/* ================= dashboard ================= */
const LEAD = () => S.cfg.leadershipRanks || ['Guild Master', 'Officer'];
const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
const NEXT_STATUS = { todo: 'doing', doing: 'done', done: 'todo' };

function viewDashboard() {
  const active = S.members.filter((m) => m.active);
  const players = new Set(active.map((m) => m.owner)).size;
  const cap = S.cfg.guildCap || 0;
  const tiles = S.cfg.roles.map((r) => {
    const n = active.filter((m) => m.role === r).length;
    return { r, n, pct: active.length ? Math.round(100 * n / active.length) : 0 };
  });
  const leaders = active.filter((m) => LEAD().includes(m.rank)).sort((a, b) => rankIdx(a.rank) - rankIdx(b.rank) || a.name.localeCompare(b.name));
  const next = S.events.filter((e) => new Date(e.start) >= Date.now() - 3 * 36e5).sort((a, b) => new Date(a.start) - new Date(b.start))[0];

  return `
  <div class="page-head"><div><h1>Dashboard</h1><div class="muted">Welcome, ${esc(S.user.name)}.</div></div></div>
  <div class="stats">
    <div class="stat">
      <div class="k">Members</div>
      <div class="v">${active.length}${cap ? `<small> / ${cap}</small>` : ''}</div>
      ${cap ? `<div class="bar"><i style="width:${Math.min(100, 100 * active.length / cap)}%"></i></div>` : ''}
      <div class="s">${players} ${players === 1 ? 'player' : 'players'}</div>
    </div>
    ${tiles.map((t) => `<div class="stat" style="--c:${roleColor(t.r)}">
      <div class="k">${esc(t.r)}</div><div class="v">${t.n}</div>
      <div class="bar"><i style="width:${t.pct}%"></i></div><div class="s">${t.pct}% of the guild</div></div>`).join('')}
  </div>
  ${lootPanel()}
  <div class="dash-grid">
    <div class="panel"><h3>Leadership</h3>
      ${leaders.length ? leaders.map(leaderCard).join('')
        : `<div class="empty">Nobody holds a leadership rank yet. Give a character the rank ${LEAD().map((r) => `"${esc(r)}"`).join(' or ')} on the Member page.</div>`}
    </div>
    <div class="panel"><h3>Next event</h3>${next ? nextEventCard(next) : '<div class="muted">Nothing scheduled.</div>'}</div>
  </div>`;
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDay = (d) => d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });

const fmtLootDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
const lootSettings = () => {
  const st = S.settings;
  return { days: S.cfg.lootWindowDays ?? 14, need: st.lootThreshold ?? 60, redMax: st.lootRedMax ?? 59, orangeMax: st.lootOrangeMax ?? 80, itemDays: st.lootItemDays ?? 7 };
};
const bandOf = (pct, ls) => (pct <= ls.redMax ? 'red' : pct <= ls.orangeMax ? 'orange' : 'green');

// "Qualified for loot": attendance on mandatory events in the last N days, coloured by range.
// Officers see every member; a normal member only sees their own characters.
function lootPanel() {
  const ls = lootSettings(), off = isOfficer();
  const ref = new Date((S.settings.lootFrom || todayTz()) + 'T00:00:00');
  const end = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999);
  const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - (ls.days - 1));
  const now = Date.now();
  const inWindow = S.events.filter((e) => { const t = new Date(e.start).getTime(); return e.mandatory && t >= start && t <= end && t <= now; });
  const counted = inWindow.filter(rolled);            // only events where an officer took roll
  const skipped = inWindow.length - counted.length;
  const itemFrom = ymd(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - (ls.itemDays - 1))), itemTo = ymd(ref);
  const itemsOf = (id) => S.loot.filter((l) => l.memberId === id && l.date >= itemFrom && l.date <= itemTo).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  const rows = S.members.filter((m) => m.active && (off || m.owner === S.user.key)).map((m) => {
    const mine = counted.filter((e) => !onLeaveAt(m.owner, new Date(e.start).getTime()));            // events during a leave of absence do not count against anybody
    const n = mine.filter((e) => e.attended.includes(m.id)).length;
    const pct = mine.length ? Math.floor(100 * n / mine.length) : null;   // rounded down so 59.6% is not shown as 60%
    const disq = isDisqualified(m.owner);
    return { m, n, total: mine.length, pct, disq, onLeave: onLeaveAt(m.owner, Date.now()), ok: pct !== null && pct >= ls.need && !disq, band: pct === null ? 'none' : bandOf(pct, ls) };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.m.name.localeCompare(b.m.name));
  const okCount = rows.filter((r) => r.ok).length;
  const shown = off && UI.lootOnlyOk ? rows.filter((r) => r.ok) : rows;

  const row = (r) => {
    const items = itemsOf(r.m.id);
    return `<details class="lootd ${r.band}" data-m="${r.m.id}" ${UI.lootOpen[r.m.id] ? 'open' : ''}>
      <summary><span class="nm">${esc(r.m.name)}</span>${r.disq ? '<span class="qtag warn">Disqualified</span>' : r.ok ? '<span class="qtag">Qualified</span>' : ''}${r.onLeave ? '<span class="qtag away">On leave</span>' : ''}<span class="sm">${r.total ? `${r.n}/${r.total}` : ''}</span><span class="pc">${r.pct === null ? '-' : r.pct + '%'}</span></summary>
      <div class="lootd-body">
        <div><span class="k">Questlog</span>${questlogLinks(r.m)}</div>
        ${(() => { const things = items.filter((l) => l.type !== 'Lucent'), lucent = items.filter((l) => l.type === 'Lucent'), sum = lucent.reduce((a, l) => a + (l.amount || 0), 0);
          return `<div><span class="k">Items received, ${fmtDay(new Date(itemFrom + 'T00:00:00'))} to ${fmtDay(ref)} (${ls.itemDays} ${ls.itemDays === 1 ? 'day' : 'days'})</span><b>${things.length}</b>${things.length ? ` <span class="muted small">(${S.cfg.lootTypes.filter((t) => t !== 'Lucent').map((t) => [t, things.filter((l) => l.type === t).length]).filter(([, n]) => n).map(([t, n]) => `${n} ${esc(t.toLowerCase())}`).join(', ')})</span><ul>${things.map((l) => `<li>${esc(l.item)} <span class="type-pill t-${esc(l.type)}">${esc(l.type || 'Item')}</span> <span class="muted small">${fmtDay(new Date(l.date + 'T00:00:00'))}</span></li>`).join('')}</ul>` : ' <span class="muted">none</span>'}</div>
          <div><span class="k">Lucent received in the same time</span><b>${sum.toLocaleString()}</b>${lucent.length ? ` <span class="muted small">(${lucent.length} ${lucent.length === 1 ? 'payment' : 'payments'})</span>` : ''}</div>`; })()}
        ${r.disq ? `<div class="warn-line">Disqualified from loot: ${activeWarn(r.m.owner).length} active warnings (the limit is ${S.settings.compliance.disqualifyAt}).</div>` : ''}
        <div class="muted small">${r.total ? `Attended ${r.n} of ${r.total} mandatory ${r.total === 1 ? 'event' : 'events'}${r.total < counted.length ? ' (events during a leave of absence are left out)' : ''}.` : 'No mandatory events with recorded attendance yet.'}</div>
      </div></details>`;
  };

  return `<div class="panel" style="margin-bottom:20px">
    <div class="ev-title"><div><h3>Qualified for loot</h3>
      <div class="muted small">Needs at least ${ls.need}% attendance on mandatory events, ${fmtDay(start)} to ${fmtDay(end)} (${ls.days} days).${off ? '' : ' You only see your own characters here.'}</div></div>
      ${off
        ? `<div class="loot-ctrl"><label for="loot-date">Count back ${ls.days} days from</label><input id="loot-date" type="date" value="${ymd(ref)}" data-act="loot-date">${S.settings.lootFrom ? '<button class="btn sm" data-act="loot-today">Use today</button>' : ''}</div>`
        : `<div class="muted small">Counting back from ${S.settings.lootFrom ? fmtDay(ref) : 'today'}</div>`}
    </div>
    <div class="small" style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center">
      ${off ? `<span><b>${okCount}</b> of ${rows.length} members qualify, based on ${counted.length} mandatory ${counted.length === 1 ? 'event' : 'events'}.</span>` : ''}
      <span class="band red">Red 0-${ls.redMax}%</span><span class="band orange">Orange ${ls.redMax + 1}-${ls.orangeMax}%</span><span class="band green">Green ${ls.orangeMax + 1}-100%</span>
      ${off ? `<button class="btn sm" data-act="loot-all">${UI.lootOnlyOk ? 'Show everyone' : 'Only qualified'}</button>` : ''}
      ${skipped ? `<span class="muted">${skipped} more mandatory ${skipped === 1 ? 'event has' : 'events have'} no attendance recorded yet and ${skipped === 1 ? 'is' : 'are'} not counted.</span>` : ''}
    </div>
    ${off ? `<details class="lootrules" ${UI.rulesOpen ? 'open' : ''}><summary>Loot rules</summary>
      <form data-form="lootrules" class="rules-grid">
        <div class="field"><label for="lr-need">Attendance needed (%)</label><input id="lr-need" name="lootThreshold" type="number" min="1" max="100" value="${ls.need}" required></div>
        <div class="field"><label for="lr-red">Red up to (%)</label><input id="lr-red" name="lootRedMax" type="number" min="0" max="98" value="${ls.redMax}" required></div>
        <div class="field"><label for="lr-orange">Orange up to (%)</label><input id="lr-orange" name="lootOrangeMax" type="number" min="1" max="99" value="${ls.orangeMax}" required></div>
        <div class="field"><label for="lr-days">Items period (days)</label><input id="lr-days" name="lootItemDays" type="number" min="1" max="365" value="${ls.itemDays}" required></div>
        <button class="btn primary">Save rules</button>
      </form><div class="muted small" style="padding-bottom:12px;margin-top:-6px">Green is everything above the orange limit. The "items received" number in each dropdown counts entries from the Loot section over the item period, ending on the same day as the window above.</div></details>` : ''}
    ${rows.length ? (counted.length ? '' : '<div class="muted" style="margin-top:12px">No mandatory events with recorded attendance in this period, so there are no percentages yet. Mark events as mandatory when you create them.</div>')
      : `<div class="muted" style="margin-top:12px">${off ? 'No active characters yet.' : 'You have no active characters. Add one on the Member page to see your attendance.'}</div>`}
    ${shown.length ? `<div class="loot-grid">${shown.map(row).join('')}</div>` : (rows.length ? '<div class="muted" style="margin-top:12px">Nobody is above the threshold yet.</div>' : '')}
  </div>`;
}

function leaderCard(m) {
  const duties = S.duties.filter((d) => d.memberId === m.id)
    .sort((a, b) => ['doing', 'todo', 'done'].indexOf(a.status) - ['doing', 'todo', 'done'].indexOf(b.status) || new Date(a.at) - new Date(b.at));
  const open = duties.filter((d) => d.status !== 'done').length;
  const hosting = S.events.filter((e) => e.createdBy === m.owner && new Date(e.start) >= Date.now())
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const editable = canEdit(m);
  return `<div class="leader">
    <div class="leader-head"><b>${esc(m.name)}</b><span class="rank-tag">${esc(m.rank)}</span>${roleChip(m.role)}
      <span class="open">${open} open · ${duties.length - open} done</span></div>
    ${isOfficer() ? `<form class="jobs-form" data-form="jobs" data-id="${m.id}"><label>Jobs (everybody sees this)</label><div style="display:flex;gap:6px"><input name="jobs" value="${esc(m.jobs || '')}" maxlength="120" placeholder="For example: Managing the Wargames"><button class="btn sm">Save</button></div></form>` : ''}
    ${duties.length ? `<ul class="duties">${duties.map((d) => `<li class="duty ${d.status}">
      ${editable ? `<button class="st" data-act="duty-cycle" data-id="${d.id}" data-s="${NEXT_STATUS[d.status]}" title="Click to change status">${STATUS[d.status]}</button>` : `<span class="st">${STATUS[d.status]}</span>`}
      <span class="txt">${esc(d.text)}</span>
      ${editable ? `<button class="x" data-act="duty-del" data-id="${d.id}" aria-label="Remove task">×</button>` : ''}</li>`).join('')}</ul>`
      : '<div class="muted small">No tasks listed yet.</div>'}
    ${hosting.length ? `<p class="hosting">Hosting: ${hosting.slice(0, 3).map((e) => `<a href="#/events/${e.id}">${esc(e.title)}</a> (${fmtShort(e.start)})`).join(', ')}${hosting.length > 3 ? ` and ${hosting.length - 3} more` : ''}</p>` : ''}
    ${editable ? `<form class="add-duty" data-form="duty" data-id="${m.id}"><input name="text" maxlength="140" required placeholder="Add a task or responsibility" aria-label="New task for ${esc(m.name)}"><button class="btn sm">Add</button></form>` : ''}
  </div>`;
}

function nextEventCard(ev) {
  const going = Object.entries(ev.rsvps).filter(([, s]) => s === 'yes').map(([id]) => byId(S.members, id)).filter(Boolean);
  return `<h2 style="font-size:20px"><a href="#/events/${ev.id}" style="color:var(--text);text-decoration:none">${esc(ev.title)}</a></h2>
    <div class="ev-meta" style="margin-bottom:10px">${esc(ev.type)}<br>${fmtDate(ev.start)}<br>${until(ev.start)}</div>
    <div style="margin-bottom:6px"><b>${going.length}</b> going${ev.maxSignups ? ` of ${ev.maxSignups}` : ''}</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px 16px">${S.cfg.roles.map((r) => `<span class="chip" style="--c:${roleColor(r)}">${esc(r)} ${going.filter((m) => m.role === r).length}</span>`).join('')}</div>
    <p style="margin:14px 0 0"><a href="#/events/${ev.id}">Open event and sign up</a></p>`;
}

/* ================= roster ================= */
function viewRoster() {
  const active = S.members.filter((m) => m.active);
  const total = active.length || 1;
  const avgGs = active.length ? Math.round(active.reduce((a, m) => a + m.gearScore, 0) / active.length) : 0;
  const q = UI.rosterQ.toLowerCase();
  let list = S.members.filter((m) =>
    !m.mercenary &&
    (UI.rosterInactive || m.active) &&
    (!UI.rosterRole || m.role === UI.rosterRole) &&
    (!UI.rosterWeapon || m.primaryWeapon === UI.rosterWeapon || m.secondaryWeapon === UI.rosterWeapon || (m.builds || []).some((b) => b.primaryWeapon === UI.rosterWeapon || b.secondaryWeapon === UI.rosterWeapon)) &&
    (!UI.rosterMode || (m.mode || 'PvE') === UI.rosterMode || (m.builds || []).some((b) => b.mode === UI.rosterMode)) &&
    (!UI.rosterTag || (isOfficer() && (S.playerTags[m.owner] || []).includes(Number(UI.rosterTag)))) &&
    (!q || [m.name, m.discord, ownerName(m.owner), classOf(m), m.specialization].join(' ').toLowerCase().includes(q)));
  const sorts = {
    name: (a, b) => a.name.localeCompare(b.name),
    gs: (a, b) => b.gearScore - a.gearScore,
    rank: (a, b) => rankIdx(a.rank) - rankIdx(b.rank) || a.name.localeCompare(b.name),
  };
  list.sort(sorts[UI.rosterSort]);

  const strip = S.cfg.roles.map((r) => {
    const n = active.filter((m) => m.role === r).length;
    return { r, n };
  });
  return `
  <div class="page-head">
    <div><h1>Member</h1><div class="muted">${active.length} active characters · average gear score ${avgGs}</div></div>
    ${S.members.some((m) => m.owner === S.user.key) ? '' : '<button class="btn primary" data-act="member-new">Add character</button>'}
  </div>
  <div class="comp">
    <div class="bar">${strip.map((s) => `<i style="--c:${roleColor(s.r)};width:${100 * s.n / total}%"></i>`).join('')}</div>
    <div class="legend">${strip.map((s) => `<span class="chip" style="--c:${roleColor(s.r)}">${esc(s.r)} <b>${s.n}</b></span>`).join('')}</div>
  </div>
  <div class="toolbar">
    <input type="search" placeholder="Search name, class or Discord" value="${esc(UI.rosterQ)}" data-ui="rosterQ" aria-label="Search">
    <select data-ui="rosterRole" aria-label="Role">${opts(S.cfg.roles, UI.rosterRole, 'All roles')}</select>
    <select data-ui="rosterWeapon" aria-label="Weapon">${opts(S.cfg.weapons, UI.rosterWeapon, 'Any weapon')}</select>
    <select data-ui="rosterMode" aria-label="PvE or PvP">${opts(S.cfg.buildModes || [], UI.rosterMode, 'PvE and PvP')}</select>
    ${isOfficer() && S.tags.length ? `<select data-ui="rosterTag" aria-label="Tag"><option value="">Any tag</option>${S.tags.map((t) => `<option value="${t.id}" ${Number(UI.rosterTag) === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
    <select data-ui="rosterSort" aria-label="Sort">
      <option value="name" ${UI.rosterSort === 'name' ? 'selected' : ''}>Sort by name</option>
      <option value="gs" ${UI.rosterSort === 'gs' ? 'selected' : ''}>Sort by gear score</option>
      <option value="rank" ${UI.rosterSort === 'rank' ? 'selected' : ''}>Sort by rank</option>
    </select>
    <label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" data-ui="rosterInactive" ${UI.rosterInactive ? 'checked' : ''}> Show inactive</label>
  </div>
  ${list.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Character</th><th>Role</th><th>Weapons</th><th class="num">Gear score</th><th class="num">Watermark</th><th>Rank</th><th>Discord</th>${isOfficer() ? '<th>Standing</th><th>Tags</th>' : ''}<th></th></tr></thead>
    <tbody>${list.map((m) => { const wn = isOfficer() ? activeWarn(m.owner) : [], onLeave = isOfficer() && onLeaveAt(m.owner, Date.now()), a = isOfficer() && m.active ? attendanceStats(m.id) : null; return `<tr class="${m.active ? '' : 'dim'}">
      <td><b>${esc(m.name)}</b>${m.owner === S.user.key ? '<span class="you">yours</span>' : ''}${onLeave ? '<span class="type-pill" style="margin-left:6px">On leave</span>' : ''}<div class="muted small"><a href="#/profile/${enc(m.owner)}" class="plain">${esc(ownerName(m.owner))}</a></div>${isOfficer() && (m.questlogs || []).length ? `<details class="ql-drop"><summary>Questlog (${m.questlogs.length})</summary><div>${questlogLinks(m, '<br>')}</div></details>` : ''}</td>
      <td>${roleChip(m.role)}</td><td class="wpn">${weaponLine(m)}${(m.builds || []).length ? `<div class="muted small">Also: ${m.builds.map((b) => esc(buildLabel(b))).join(' · ')}</div>` : ''}${m.mode && m.mode !== 'PvE' ? `<span class="type-pill" style="margin-left:6px">${esc(m.mode)}</span>` : ''}</td>
      <td class="num">${m.gearScore || '-'}</td><td class="num">${m.level || '-'}</td>
      <td>${esc(m.rank)}</td><td>${esc(m.discord)}</td>
      ${isOfficer() ? `<td><a href="#/profile/${enc(m.owner)}" class="plain standing-cell">
          ${wn.length ? `<span class="standing-flag warn">⚠ ${wn.length} ${wn.length === 1 ? 'warning' : 'warnings'}</span>` : ''}
          ${a && a.of ? `<span class="standing-flag ${a.pct < 60 ? 'low' : ''}">${a.pct}% attendance</span>` : ''}
          ${!wn.length && !onLeave && (!a || !a.of) ? '<span class="muted small">-</span>' : ''}
        </a></td>
        <td class="tagcell">${tagsOf(m.owner).map(tagChip).join('')}<button class="btn sm" data-act="tags-edit" data-key="${esc(m.owner)}" aria-label="Edit tags of ${esc(ownerName(m.owner))}">Tags</button></td>` : ''}
      <td>${canEdit(m) ? `<button class="btn sm" data-act="member-edit" data-id="${m.id}">Edit</button>` : ''}</td>
    </tr>`; }).join('')}</tbody></table></div>`
    : `<div class="empty">No characters match. ${S.members.length ? 'Clear the filters to see everyone.' : 'Add the first one with "Add character".'}</div>`}
  ${isOfficer() ? mercenariesSection() : ''}`;
}
// Mercenaries never mix into the roster above (not even with "show inactive" ticked) - they get their own
// dropdown here instead, so the regular Member list stays about guild members only.
function mercenariesSection() {
  const mercs = S.members.filter((m) => m.mercenary);
  if (!mercs.length) return '';
  return `<details class="fold" style="margin-top:20px;border-top:1px solid var(--line)"><summary>Mercenaries (${mercs.length})</summary>
    <div class="fold-body"><div class="tbl-wrap"><table>
      <thead><tr><th>Character</th><th>Role</th><th>Weapons</th><th>For event</th><th></th></tr></thead>
      <tbody>${mercs.map((m) => { const ev = byId(S.events, m.mercFor); return `<tr>
        <td><b>${esc(m.name)}</b> <span class="tag merc">Merc</span><div class="muted small"><a href="#/profile/${enc(m.owner)}" class="plain">${esc(ownerName(m.owner))}</a></div></td>
        <td>${roleChip(m.role)}</td><td class="wpn">${weaponLine(m)}</td>
        <td>${ev ? `<a href="#/events/${ev.id}">${esc(ev.title)}</a>` : '<span class="muted small">Event no longer exists</span>'}</td>
        <td><button class="btn sm" data-act="member-edit" data-id="${m.id}">Edit</button></td>
      </tr>`; }).join('')}</tbody>
    </table></div></div>
  </details>`;
}

const qlRow = (l) => `<div class="ql-row"><input name="ql_label" value="${esc(l.label || '')}" maxlength="30" placeholder="Label (optional)" aria-label="Link label"><input name="ql_url" type="url" value="${esc(l.url || '')}" maxlength="300" placeholder="https://..." aria-label="Link"><button type="button" class="x" data-act="ql-remove" aria-label="Remove link">×</button></div>`;
const collectLinks = (f) => [...f.querySelectorAll('.ql-row')].map((r) => ({ label: r.querySelector('[name=ql_label]').value.trim(), url: r.querySelector('[name=ql_url]').value.trim() })).filter((l) => l.url);
function memberDialog(m) {
  const isNew = !m;
  m = m || { name: '', role: S.cfg.roles[0], primaryWeapon: '', secondaryWeapon: '', gearScore: '', level: '', discord: S.user.username || '', timezone: '', notes: '', active: true, rank: S.cfg.ranks[S.cfg.ranks.length - 1], owner: S.user.key };
  openDialog(`
  <form data-form="member" data-id="${m.id || ''}">
    <h2>${isNew ? 'Add character' : 'Edit character'}</h2>
    <div class="row">
      <div class="field"><label>Character name</label><input name="name" value="${esc(m.name)}" required maxlength="40"></div>
      <div class="field"><label>Role</label><select name="role">${opts(S.cfg.roles, m.role)}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Primary weapon</label><select name="primaryWeapon">${opts(S.cfg.weapons, m.primaryWeapon, 'None')}</select></div>
      <div class="field"><label>Secondary weapon</label><select name="secondaryWeapon">${opts(S.cfg.weapons, m.secondaryWeapon, 'None')}</select></div>
    </div>
    <div class="muted small" id="class-preview" style="margin:-4px 0 10px">${esc(classPreviewText(m.primaryWeapon, m.secondaryWeapon))}</div>
    <div class="field"><label>Specialization (type anything, for example Endurance)</label><input name="specialization" value="${esc(m.specialization || '')}" maxlength="40"></div>
    <div class="row">
      <div class="field"><label>Gear score</label><input name="gearScore" type="number" min="0" value="${m.gearScore}"></div>
      <div class="field"><label>Watermark</label><input name="level" type="number" min="0" max="99" value="${m.level}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Discord</label><input name="discord" value="${esc(m.discord)}"></div>
      <div class="field"><label>Time zone or play hours</label><input name="timezone" value="${esc(m.timezone)}" placeholder="CET, evenings"></div>
    </div>
    ${isOfficer() ? `<div class="row">
      <div class="field"><label>Rank</label><select name="rank">${opts(S.cfg.ranks, m.rank)}</select></div>
      <div class="field"><label>Owner</label>${S.cfg.authMode === 'discord'
        ? `<select name="owner">${S.users.map((u) => `<option value="${esc(u.id)}" ${u.id === m.owner ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}${S.users.some((u) => u.id === m.owner) ? '' : `<option value="${esc(m.owner)}" selected>${esc(m.owner)} (not linked to Discord)</option>`}</select>`
        : `<input name="owner" value="${esc(m.owner)}">`}</div>
    </div>` : ''}
    <div class="field"><label>Mode of this main build</label><select name="mode">${opts(S.cfg.buildModes || ['PvE'], m.mode || 'PvE')}</select></div>
    <div class="field"><label>Questlog links (up to 6)</label>
      <div id="ql-rows">${((m.questlogs || []).length ? m.questlogs : [{ label: '', url: '' }]).map(qlRow).join('')}</div>
      <button type="button" class="btn sm" data-act="ql-add" style="margin-top:6px">+ Add another link</button></div>
    ${!isOfficer() ? `<div class="muted small" id="approval-note">${(() => { const g = (S.cfg.approvalGroups || []).filter((x) => S.settings.approvals[x.key] && !['builds', 'profile', 'newCharacter'].includes(x.key)).map((x) => x.label.toLowerCase()); return g.length ? `Changes to ${g.join(', ')} have to be approved by the leadership before they take effect.` : ''; })()}</div>` : ''}
    <div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${esc(m.notes)}</textarea></div>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> Active (uncheck if taking a break or left)</label>
    <div class="dlg-actions">
      ${isNew ? '' : '<button type="button" class="btn danger left" data-act="member-delete">Delete</button>'}
      <button type="button" class="btn" data-act="dlg-close">Cancel</button>
      <button class="btn primary">Save</button>
    </div>
  </form>`);
}

/* ================= events ================= */
const TYPE_COLORS = ['#ee92a8', '#e2a24a', '#6a9be0', '#7fcf8f', '#c59be0', '#7cc4b8', '#e6d36a', '#f08a5d', '#5fb8e8', '#a8d86e', '#d98cd0', '#9aa7f0', '#e8b4a0', '#68c9a3', '#a39499'];
const typeColor = (t) => TYPE_COLORS[Math.max(0, S.cfg.eventTypes.findIndex((x) => x.name === t)) % TYPE_COLORS.length];
const dayKey = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const goingCount = (e) => Object.values(e.rsvps).filter((s) => s === 'yes').length;
const timeOf = (iso) => fmtTime(iso);

function monthChip(e, sel, now) {
  const st = myStatus(e);
  return `<a class="cal-ev ${sel && sel.id === e.id ? 'sel' : ''} ${new Date(e.start) < now ? 'past' : ''}" data-st="${st}" href="#/events/${e.id}" style="--c:${typeColor(e.type)}" title="${esc(e.title)}${e.mandatory ? ' (mandatory)' : ''}, ${goingCount(e)} going${st ? '. ' + STATUS_TEXT[st] : ''}">${e.mandatory ? '<i class="mdot"></i>' : ''}<span class="tm">${timeOf(e.start)}</span><span class="ttl">${esc(e.title)}</span></a>`;
}
function weekCard(e, sel, now) {
  const st = myStatus(e);
  return `<a class="wk-ev ${sel && sel.id === e.id ? 'sel' : ''} ${new Date(e.start) < now ? 'past' : ''}" data-st="${st}" href="#/events/${e.id}" style="--c:${typeColor(e.type)}" ${st ? `title="${esc(STATUS_TEXT[st])}"` : ''}>
    <span class="top"><span>${timeOf(e.start)}</span>${e.mandatory ? '<i class="mdot" title="Mandatory"></i>' : ''}</span>
    <span class="ttl">${esc(e.title)}</span><span class="sub"><i class="tdot"></i>${esc(e.type)}<br>${goingCount(e)} going</span></a>`;
}

function viewEvents(selId) {
  const now = Date.now();
  let sel = byId(S.events, selId);
  if (sel && UI.calFor !== sel.id) { UI.calRef = new Date(sel.start).getTime(); UI.calFor = sel.id; }
  if (!sel) sel = S.events.filter((e) => new Date(e.start) >= now - 3 * 36e5).sort((a, b) => new Date(a.start) - new Date(b.start))[0];

  const view = UI.calView || 'week';
  const ws = S.cfg.weekStartsOn ?? 1;
  const rw = wall(UI.calRef || Date.now()), ref = new Date(rw.y, rw.m - 1, rw.d);      // a plain calendar date; only its numbers matter
  const byDay = {};
  S.events.forEach((e) => { const k = wallKey(new Date(e.start).getTime()); (byDay[k] = byDay[k] || []).push(e); });
  Object.values(byDay).forEach((l) => l.sort((a, b) => new Date(a.start) - new Date(b.start)));
  const todayKey = wallKey(Date.now());
  const dowName = (i) => new Date(2024, 0, 7 + ws + i).toLocaleDateString('en-US', { weekday: 'short' });
  const can = isOfficer() ? 'can-add' : '';
  let title, body;

  if (view === 'month') {
    const y = ref.getFullYear(), m = ref.getMonth();
    const first = new Date(y, m, 1);
    const offset = (first.getDay() - ws + 7) % 7;
    const cells = Math.ceil((offset + new Date(y, m + 1, 0).getDate()) / 7) * 7;
    title = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    let grid = Array.from({ length: 7 }, (_, i) => `<div class="cal-dow">${dowName(i)}</div>`).join('');
    for (let i = 0; i < cells; i++) {
      const d = new Date(y, m, 1 - offset + i);
      const evs = byDay[dayKey(d)] || [];
      const more = evs.length - 4;
      grid += `<div class="cal-cell ${d.getMonth() !== m ? 'out' : ''} ${dayKey(d) === todayKey ? 'today' : ''} ${can}" data-act="cal-day" data-date="${ymd(d)}">
        <div class="cal-num">${d.getDate()}</div>
        ${evs.slice(0, 4).map((e) => monthChip(e, sel, now)).join('')}
        ${more > 0 ? `<button class="cal-more" data-act="cal-week" data-date="${ymd(d)}">+${more} more</button>` : ''}</div>`;
    }
    body = `<div class="cal-grid">${grid}</div>`;
  } else {
    const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - ((ref.getDay() - ws + 7) % 7));
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    title = `${fmtDay(start)} - ${end.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    body = `<div class="wk-grid">${Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return `<div class="wk-day ${dayKey(d) === todayKey ? 'today' : ''} ${can}" data-act="cal-day" data-date="${ymd(d)}">
        <div class="wk-head"><span class="dow">${dowName(i)}</span><span class="num">${d.getDate()}</span></div>
        ${(byDay[dayKey(d)] || []).map((e) => weekCard(e, sel, now)).join('')}</div>`;
    }).join('')}</div>`;
  }
  return `
  <div class="page-head"><div><h1>Events</h1><div class="muted">Times are shown in ${esc(TZ())} (${esc(tzAbbr(Date.now()))}). <a href="#/profile">Change your time zone</a>.${isOfficer() ? ' Click an empty part of a day to add an event there.' : ''}</div></div>
    ${isOfficer() ? '<button class="btn primary" data-act="event-new">New event</button>' : ''}</div>
  ${typeof seriesPanel === 'function' ? seriesPanel() : ''}
  <div class="events-layout">
  <div class="cal">
    <div class="cal-head"><h2>${title}</h2>
      <span class="seg"><button class="btn sm ${view === 'week' ? 'on' : ''}" data-act="cal-view" data-v="week">Week</button><button class="btn sm ${view === 'month' ? 'on' : ''}" data-act="cal-view" data-v="month">Month</button></span>
      <button class="btn sm" data-act="cal-prev" aria-label="Previous">Previous</button>
      <button class="btn sm" data-act="cal-today">Today</button>
      <button class="btn sm" data-act="cal-next" aria-label="Next">Next</button></div>
    ${body}
    <div class="cal-legend">${S.cfg.eventTypes.map((t) => `<span class="chip" style="--c:${typeColor(t.name)}">${esc(t.name)}</span>`).join('')}<span class="small" style="display:inline-flex;align-items:center;gap:7px"><i class="mdot"></i>Mandatory event</span></div>
    <div class="cal-legend status-legend"><span class="muted small">Your events:</span>${['attended', 'noshow', 'noreply', 'declined'].map((k) => `<span class="st-key" data-st="${k}"><i></i>${{ attended: 'You were there', noshow: 'No-show', noreply: 'No reply', declined: 'Not attending' }[k]}</span>`).join('')}</div>
  </div>
  <aside class="ev-side" aria-label="Event window">${sel ? eventSide(sel) : '<div class="panel side-empty">Click an event in the calendar to see it here: your sign-up and the attendance PIN.</div>'}</aside>
  </div>
  <div id="ev-detail">${sel ? eventDetail(sel) : '<div class="empty">No events yet.' + (isOfficer() ? ' Click a day in the calendar or use "New event".' : '') + '</div>'}</div>`;
}

function eventDetail(ev) {
  const going = [], no = [];
  for (const [id, st] of Object.entries(ev.rsvps)) {
    const m = byId(S.members, id); if (!m) continue;
    (st === 'yes' ? going : no).push(m);
  }
  const past = new Date(ev.start) < Date.now();
  const closesAt = new Date(ev.signupClosesAt), closed = Date.now() >= closesAt;
  const locked = closed && !isOfficer();                                  // officers can still change answers
  const myRows = mine().map((m) => rsvpRow(ev, m, locked)).join('');
  const others = isOfficer() ? S.members.filter((m) => m.active && m.owner !== S.user.key && !ev.rsvps[m.id]) : [];
  const cap = ev.maxSignups ? ` of ${ev.maxSignups}` : '';
  const signupNote = past ? '' : closed ? `Sign-ups closed at ${fmtTime(closesAt)}.${isOfficer() ? ' Officers can still change answers.' : ''}` : `Sign-ups close at ${fmtTime(closesAt)} (${until(closesAt)}).`;

  return `
  <div class="panel"><h3>Going: ${going.length}${cap}</h3>${typeof goingChart === 'function' ? goingChart(ev) : ''}
    ${going.length ? `<div class="cols">${S.cfg.roles.map((r) => {
      const g = going.filter((m) => m.role === r).sort((a, b) => b.gearScore - a.gearScore);
      return `<div class="col" style="--c:${roleColor(r)}"><h3><span>${esc(r)}</span><span>${g.length}</span></h3>
        ${g.map((m) => `<div class="mini"><span>${esc(m.name)}</span><small>${esc(classOf(m) || m.primaryWeapon)} ${m.gearScore || ''}</small></div>`).join('') || '<div class="muted small">None yet</div>'}</div>`;
    }).join('')}</div>` : '<div class="muted">Nobody yet.</div>'}
    ${no.length ? `<p class="small" style="margin-bottom:0"><span class="muted">Can't make it (${no.length}):</span> ${no.map((m) => esc(m.name)).join(', ')}</p>` : ''}
  </div>

  <div class="panel"><div class="ev-title"><h3>Parties</h3>
    <span class="seg">
      ${ev.parties.length ? `<button class="btn sm" data-act="parties-view" data-id="${ev.id}" title="Shows the parties as one readable picture - handy on a phone">View parties</button>` : ''}
      ${isOfficer() ? `
      <button class="btn sm" data-act="parties-build" data-id="${ev.id}">Auto-build from going</button>
      ${S.presets.length ? `<select data-act="preset-load" data-ev="${ev.id}" aria-label="Load a party preset"><option value="">Load preset</option>${S.presets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : ''}
      ${S.presets.length ? `<select data-act="preset-forever" data-ev="${ev.id}" aria-label="Use a preset for all upcoming ${esc(ev.type)} events"><option value="">Preset for all ${esc(ev.type)}…</option>${S.presets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : ''}
      ${ev.parties.length ? `<button class="btn sm" data-act="preset-from-event" data-id="${ev.id}">Save as preset</button><button class="btn sm discord-btn" data-act="parties-post" data-id="${ev.id}" title="Draws the parties as a picture and posts it in a Discord channel">Post to Discord</button>` : ''}
      <button class="btn sm discord-btn" data-act="merc-ask" data-id="${ev.id}" title="Asks an outside Discord role for help filling this event's roster">Get mercenaries</button>` : ''}</span></div>
    ${isOfficer() && ev.mercRequest ? `<div class="muted small" style="margin-top:6px">${ev.mercRequest.ok ? 'Asked' : '<span style="color:var(--danger)">Asking failed</span>'} for ${ev.mercRequest.overall ? `${ev.mercRequest.overall} player${ev.mercRequest.overall === 1 ? '' : 's'}` : (ev.mercRequest.needs || []).map((n) => `${n.count}× ${esc(n.cls)}`).join(', ')} by ${esc(ev.mercRequest.by)}, ${fmtShort(ev.mercRequest.at)}${ev.mercRequest.ok ? '' : ': ' + esc(ev.mercRequest.error)}.</div>` : ''}
    ${isOfficer() && ev.partyPosts && ev.partyPosts.length ? (() => { const p = ev.partyPosts[ev.partyPosts.length - 1]; return `<div class="muted small" style="margin-top:6px">${p.ok ? 'Posted' : '<span style="color:var(--danger)">Posting failed</span>'} to ${p.channelName ? '#' + esc(p.channelName) : 'Discord'} by ${esc(p.by)}, ${fmtShort(p.at)}${p.ok ? '' : ': ' + esc(p.error)}.</div>`; })() : ''}
    ${(() => { const r = S.presetRules.find((x) => x.type === ev.type), p = r && byId(S.presets, r.presetId); return p ? `<div class="muted small" style="margin-top:6px">Every ${esc(ev.type)} event uses the preset "${esc(p.name)}" (set on the Parties page).</div>` : ''; })()}
    <div style="margin-top:14px">${ev.parties.length || isOfficer() ? board({ kind: 'event', id: ev.id }, ev.parties, ev) : '<div class="muted">No parties posted yet.</div>'}</div>
  </div>

  ${isOfficer() ? automationPanel(ev) : ''}
  ${isOfficer() ? attendancePanel(ev, past) : ''}`;
}

// The window on the right of the calendar: the event, my sign-up, and the attendance PIN.
function eventSide(ev) {
  const past = new Date(ev.start) < Date.now();
  const closesAt = new Date(ev.signupClosesAt), closed = Date.now() >= closesAt;
  const locked = closed && !isOfficer();                                  // officers can still change answers
  const myRows = mine().map((m) => rsvpRow(ev, m, locked)).join('');
  const others = isOfficer() ? S.members.filter((m) => m.active && m.owner !== S.user.key && !ev.rsvps[m.id]) : [];
  const signupNote = past ? '' : closed ? `Sign-ups closed at ${fmtTime(closesAt)}.${isOfficer() ? ' Officers can still change answers.' : ''}` : `Sign-ups close at ${fmtTime(closesAt)} (${until(closesAt)}).`;
  const st = myStatus(ev);
  return `<div class="panel side-card" data-st="${st}">
    <div class="ev-title"><div style="min-width:0"><h2>${esc(ev.title)}</h2>
      <div class="ev-meta">${ev.mandatory ? '<span class="pill-m">Mandatory</span> ' : ''}${ev.seriesId && typeof seriesLine === 'function' && seriesLine(ev) ? `<span class="type-pill">${esc(seriesLine(ev))}</span> ` : ''}${esc(ev.type)}<br>${fmtDate(ev.start)} (${until(ev.start)})${ev.points && pointsOn() ? `<br>${ev.points} points for attending` : ''}</div></div>
      ${isOfficer() ? `<div class="seg"><button class="btn sm" data-act="event-edit" data-id="${ev.id}">Edit</button>${ev.seriesId && S.series.some((x) => x.id === ev.seriesId) ? `<button class="btn sm" data-act="series-edit" data-id="${ev.seriesId}">Edit series</button>` : ''}</div>` : ''}</div>
    ${st ? `<div class="mystatus" data-st="${st}"><i></i>${STATUS_TEXT[st]}</div>` : ''}
    ${ev.description ? `<p class="ev-desc">${esc(ev.description)}</p>` : ''}
    <h3 class="side-h">Your sign-up</h3>
    ${signupNote ? `<div class="muted small" style="margin:-4px 0 8px">${signupNote}</div>` : ''}
    ${myRows || `<div class="muted small">You have no active characters. <a href="#/profile" data-act="goto-add">Add one</a> to sign up.</div>`}
    ${others.length ? `<div class="rsvp-row"><select id="other-char" style="max-width:190px" aria-label="Sign up another character">${others.map((m) => `<option value="${m.id}">${esc(m.name)} (${esc(ownerName(m.owner))})</option>`).join('')}</select>
      <span class="seg"><button class="btn sm" data-act="rsvp-other" data-s="yes" data-ev="${ev.id}">Going</button><button class="btn sm" data-act="rsvp-other" data-s="no" data-ev="${ev.id}">Can't</button></span></div>` : ''}
    ${pinSide(ev)}
  </div>`;
}

// Where the attendance PIN stands for this event: not activated yet, open, too late, or not used.
function pinState(ev) {
  const info = ev.pinInfo || { state: 'pending' };
  if (info.state === 'open') return 'open';
  if (info.state === 'closed') return 'late';
  const around = new Date(info.scheduledAt).getTime();
  return ev.pinSkip || Date.now() > around + (info.windowMinutes || 15) * 60000 ? 'none' : 'early';
}
function pinSide(ev) {
  const info = ev.pinInfo || {}, kind = pinState(ev), own = mine();
  const badge = { early: ['Not activated yet', 'st-open'], open: ['Open now', 'st-approved'], late: ['Too late', 'st-rejected'], none: ['Not used', ''] }[kind];
  const text = {
    early: `The PIN is not activated yet. It opens around ${fmtTime(info.scheduledAt)} (${until(info.scheduledAt)}) when your party leader gets it, and stays open for ${info.windowMinutes} minutes.`,
    open: `Type the PIN your party leader gives you. It closes at ${fmtTime(info.closesAt)} (${until(info.closesAt)}).`,
    late: `You are too late: the PIN window closed at ${fmtTime(info.closesAt)}. If you were there, ask an officer to mark you.`,
    none: 'No attendance PIN was used for this event. An officer records who came.',
  }[kind];
  const rows = own.map((m) => {
    const label = `<span><b>${esc(m.name)}</b> ${roleChip(m.role)}</span>`;
    if (ev.attended.includes(m.id)) return `<div class="pin-row">${label}<span class="ok-text">Recorded &#10003;</span></div>`;
    if (kind === 'open') return `<form class="pin-row" data-form="pin" data-ev="${ev.id}" data-m="${m.id}">${label}
      <span class="go"><input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="PIN" autocomplete="off" required aria-label="Attendance PIN for ${esc(m.name)}"><button class="btn primary sm">Confirm</button></span></form>`;
    return `<div class="pin-row">${label}<span class="muted small">${kind === 'late' ? 'too late' : kind === 'early' ? 'not open yet' : ''}</span></div>`;
  }).join('');
  return `<div class="pin-box" data-pin="${kind}"><h3 class="side-h">Attendance PIN <span class="st-pill ${badge[1]}">${badge[0]}</span></h3>
    <div class="muted small" style="margin:-2px 0 8px">${text}</div>${own.length ? rows : '<div class="muted small">Add a character to check in with the PIN.</div>'}</div>`;
}

// (old layout, no longer used) The attendance PIN, as seen by players: type it in while the window is open.
function pinPanel(ev) {
  const info = ev.pinInfo || { state: 'pending' };
  const start = new Date(ev.start).getTime(), soon = start - Date.now() < 6 * 36e5;
  if (info.state === 'pending' && !soon) return '';
  const own = mine();
  const rows = own.map((m) => {
    if (ev.attended.includes(m.id)) return `<div class="pin-row"><span><b>${esc(m.name)}</b> ${roleChip(m.role)}</span><span class="ok-text">Attendance recorded</span></div>`;
    if (info.state !== 'open') return '';
    return `<form class="pin-row" data-form="pin" data-ev="${ev.id}" data-m="${m.id}"><span><b>${esc(m.name)}</b> ${roleChip(m.role)}</span>
      <span class="go"><input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="PIN" autocomplete="off" required aria-label="Attendance PIN for ${esc(m.name)}"><button class="btn primary sm">Confirm</button></span></form>`;
  }).join('');
  const text = info.state === 'pending'
    ? `Your party leader gets a PIN on Discord around ${fmtTime(info.scheduledAt)}. You can type it in here for ${info.windowMinutes} minutes to record that you were there.`
    : info.state === 'open'
      ? `Type the PIN your party leader gives you. The window closes at ${fmtTime(info.closesAt)} (${until(info.closesAt)}).`
      : `The PIN window closed at ${fmtTime(info.closesAt)}. If you were there but did not enter it, ask an officer to mark you.`;
  return `<div class="panel"><h3>Attendance PIN</h3><div class="muted small" style="margin:-6px 0 8px">${text}</div>${own.length ? rows : '<div class="muted small">Add a character to enter the PIN.</div>'}</div>`;
}

// Officers: the PIN itself, who got it, and what the reminders did.
function automationPanel(ev) {
  const pin = ev.pin, info = ev.pinInfo, st = S.settings;
  const entered = Object.keys(ev.pinEntries || {}).length;
  const hrs = (m) => (m % 60 === 0 ? `${m / 60}h` : `${Math.round(m / 6) / 10}h`);
  return `<div class="panel"><div class="ev-title"><h3>PIN and reminders</h3>
      <span class="seg"><button class="btn sm" data-act="pin-send" data-mode="send" data-id="${ev.id}">${pin ? 'Send the PIN again' : 'Create and send PIN now'}</button>${pin ? `<button class="btn sm" data-act="pin-send" data-mode="new" data-id="${ev.id}">New PIN</button>` : ''}</span></div>
    ${pin ? `<div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin:6px 0 4px"><div class="pin-code" aria-label="PIN">${esc(pin.code)}</div>
        <div class="small muted">Created ${fmtShort(pin.at)} (${esc(pin.by)}).<br>Players can enter it until ${fmtTime(info.closesAt)}. ${info.state === 'open' ? '<span class="ok-text">Open now.</span>' : 'Closed.'}<br>${entered} ${entered === 1 ? 'character has' : 'characters have'} entered it.</div></div>
      <ul class="sent">${(pin.sent || []).map((r) => `<li class="${r.ok ? 'yes' : 'fail'}">${r.ok ? 'Sent to' : 'Not delivered to'} <b>${esc(r.name)}</b> <span class="muted">(${esc(r.why)})</span>${r.ok ? '' : ` - ${esc(r.error)}`}</li>`).join('') || '<li class="muted">Nobody to send it to yet.</li>'}</ul>`
      : `<div class="muted small">It will be created ${st.pinOffsetMinutes === 0 ? 'when the event starts' : `${Math.abs(st.pinOffsetMinutes)} minutes ${st.pinOffsetMinutes > 0 ? 'after the start' : 'before the start'}`} (around ${fmtTime(info.scheduledAt)}) and sent by Discord to the party leaders and the leadership. Change this in Admin.</div>`}
    <div class="small" style="margin-top:12px"><span class="muted">Reminders for players who have not answered:</span> ${!st.remindersEnabled ? 'switched off in Admin' : ev.reminders === false ? 'off for this event' : (st.reminderMinutes.length ? st.reminderMinutes.map(hrs).join(' and ') + ' before the start' : 'none set')}.
      ${(ev.reminderLog || []).map((l) => `<div class="muted">Reminder ${l.number}: ${l.sent} delivered${l.failed.length ? `, ${l.failed.length} not delivered (${l.failed.map((f) => esc(f.name)).join(', ')})` : ''} at ${fmtTime(l.at)}.</div>`).join('')}</div>
  </div>`;
}

function rsvpRow(ev, m, locked) {
  const s = ev.rsvps[m.id] || 'none';
  const b = (val, label) => `<button class="btn sm ${s === val ? 'on' : ''}" ${locked ? 'disabled' : ''} data-act="rsvp" data-ev="${ev.id}" data-m="${m.id}" data-s="${s === val ? 'none' : val}">${label}</button>`;
  return `<div class="rsvp-row"><span><b>${esc(m.name)}</b> ${roleChip(m.role)}${s === 'none' ? ' <span class="muted small">no answer yet</span>' : ''}</span><span class="seg">${b('yes', 'Going')}${b('no', "Can't")}</span></div>`;
}

const CROWN = '<svg class="crown" viewBox="0 0 24 24" width="15" height="15" role="img" aria-label="Party leader"><path fill="currentColor" d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/></svg>';

function memberMenu(m, at, o) {
  const inParty = o.from === 'party';
  const cur = inParty ? effectiveBuild(m, o.parties[o.i]).key : 'main';
  const choices = [{ key: 'main', label: `Main: ${classOf(m) || 'no class'} (${m.role})` }, ...(m.builds || []).map((b) => ({ key: String(b.id), label: `${b.name}: ${classFor(b.primaryWeapon, b.secondaryWeapon) || 'no class'} (${b.role}, ${b.mode})` }))];
  const targets = (o.parties || []).map((q, j) => (inParty && j === o.i ? '' : `<button data-act="m-move" ${at} data-m="${m.id}" data-to="${j}">${esc(q.name)}</button>`)).join('');
  return `<details class="menu"><summary aria-label="Options for ${esc(m.name)}">&hellip;</summary><div class="menu-list">
    ${inParty ? `<button data-act="m-leader" ${at} data-m="${m.id}">${o.leader === m.id ? 'Remove as party leader' : 'Make party leader'}</button>` : ''}
    ${inParty && choices.length > 1 ? `<div class="menu-sep">Class / build in this party</div><div class="menu-scroll">${choices.map((c) => `<button data-act="m-build" ${at} data-m="${m.id}" data-b="${c.key}">${cur === c.key ? '&#10003; ' : ''}${esc(c.label)}</button>`).join('')}</div>` : ''}
    ${targets ? `<div class="menu-sep">${inParty ? 'Move to' : 'Add to'}</div><div class="menu-scroll">${targets}</div>` : ''}
    ${inParty ? `<button class="danger" data-act="m-remove" ${at} data-m="${m.id}">Remove from party</button>` : ''}
  </div></details>`;
}

// One member row. Shows role colour, party-leader crown, and "Class | Specialization".
function memberRow(m, at, o) {
  const off = isOfficer();
  const eff = effectiveBuild(m, o.from === 'party' ? (o.parties || [])[o.i] : null);     // the class this player plays in this party
  const cls = classFor(eff.primaryWeapon, eff.secondaryWeapon);
  const meta = [cls, eff.specialization].filter(Boolean).join(' | ') || [eff.primaryWeapon, eff.secondaryWeapon].filter(Boolean).join(' / ');
  const tag = o.ev && o.from === 'pool' ? (o.ev.rsvps[m.id] === 'yes' ? 'going' : '') : '';
  return `<div class="mrow" ${off ? 'draggable="true" data-drag="member"' : ''} data-m="${m.id}" data-from="${o.from}" style="--c:${roleColor(eff.role)}" title="${esc(m.name)}: ${esc([eff.primaryWeapon, eff.secondaryWeapon].filter(Boolean).join(' / '))}${eff.gearScore ? ', GS ' + eff.gearScore : ''}">
    ${off ? '<span class="grip" aria-hidden="true"></span>' : ''}${o.from === 'party' && o.leader === m.id ? CROWN : ''}
    <div class="mtxt"><div class="mname">${esc(m.name)}${m.mercenary ? '<span class="tag merc" title="Not a guild member - helping for this event only">Merc</span>' : ''}${eff.isBuild ? `<span class="tag build">${esc(eff.label)}</span>` : ''}${tag ? `<span class="tag">${tag}</span>` : ''}</div><div class="mmeta">${esc(meta) || '&nbsp;'}</div></div>
    ${off ? memberMenu(m, at, o) : ''}</div>`;
}

function partyCard(ctx, parties, p, i, ev) {
  const off = isOfficer();
  const at = `data-kind="${ctx.kind}" data-owner="${ctx.id}" data-i="${i}"`;
  const ms = p.members.map((id) => byId(S.members, id)).filter(Boolean);
  const size = S.cfg.partySize;
  return `<div class="party" data-party="${i}">
    <div class="phead">
      ${off ? `<span class="grip" draggable="true" data-drag="party" data-i="${i}" title="Drag to reorder parties" aria-hidden="true"></span>` : ''}
      ${off ? `<input class="party-name" ${at} data-act="party-rename" value="${esc(p.name)}" maxlength="40" aria-label="Party name">` : `<span class="party-title">${esc(p.name)}</span>`}
      <span class="muted small ${ms.length > size ? 'over-cap' : ''}">${ms.length}/${size}</span>
      ${off ? `<details class="menu"><summary aria-label="Options for ${esc(p.name)}">&hellip;</summary><div class="menu-list">
        <button data-act="p-left" ${at}>Move party left</button><button data-act="p-right" ${at}>Move party right</button>
        <button data-act="p-clear" ${at}>Remove all members</button><button class="danger" data-act="party-del" ${at}>Delete party</button></div></details>` : ''}
    </div>
    <div class="pdrop" ${off ? 'data-drop="party"' : ''} data-i="${i}">
      ${ms.map((m) => memberRow(m, at, { from: 'party', i, leader: p.leader, parties, ev })).join('') || `<div class="pempty">${off ? 'Drop members here' : 'Empty'}</div>`}
    </div></div>`;
}

// Officers get role lists on the left (drag from there, or back to it to unassign) and the party grid on the right.
function board(ctx, parties, ev) {
  const off = isOfficer();
  const used = new Set(parties.flatMap((p) => p.members));
  const total = parties.reduce((a, p) => a + p.members.filter((id) => byId(S.members, id)).length, 0);
  // Mercenaries are not "active" (that is what keeps them off every other page - the member list, loot,
  // attendance, all of it already filter on active) but they still need to appear here, in the one place they
  // are relevant: the pool for the specific event they signed up to help with.
  const mercs = ev ? S.members.filter((m) => m.mercenary && m.mercFor === ev.id) : [];
  // The pool only ever shows people who actually said Going (plus mercenaries, who join a different way) - not
  // everyone active. An officer can still place someone who never answered; that just means setting their RSVP
  // to Going first (on the Attendance or Events page), rather than dragging them in from here regardless of
  // their answer. Presets have no event at all, so there is no RSVP to filter by - every active member stays
  // available there, same as always.
  const active = (ev ? S.members.filter((m) => m.active && ev.rsvps[m.id] === 'yes') : S.members.filter((m) => m.active)).concat(mercs);
  const pools = S.cfg.roles.map((r) => {
    const all = active.filter((m) => m.role === r);
    const free = all.filter((m) => !used.has(m.id)).sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="pool" style="--c:${roleColor(r)}"><div class="pool-head"><span>${esc(r)}</span><span>${free.length}/${all.length}</span></div>
      <div class="pool-list">${free.map((m) => memberRow(m, `data-kind="${ctx.kind}" data-owner="${ctx.id}"`, { from: 'pool', parties, ev })).join('') || '<div class="pempty">Everyone is placed</div>'}</div></div>`;
  }).join('');
  return `<div class="board ${off ? '' : 'ro'}" data-kind="${ctx.kind}" data-owner="${ctx.id}">
    ${off ? `<aside class="pools" data-drop="pool">${pools}</aside>` : ''}
    <section class="pboard">
      <div class="pboard-head"><h3>${parties.length} ${parties.length === 1 ? 'Party' : 'Parties'} <span class="muted">(${total} members)</span></h3>
        ${off ? `<button class="btn sm" data-act="party-add" data-kind="${ctx.kind}" data-owner="${ctx.id}">Add party</button>` : ''}</div>
      ${parties.length ? `<div class="parties">${parties.map((p, i) => partyCard(ctx, parties, p, i, ev)).join('')}</div>` : '<div class="muted">No parties yet. Add one, then drag members in.</div>'}
    </section></div>`;
}

function viewParties() {
  const off = isOfficer();
  const p = byId(S.presets, UI.presetId) || S.presets[0];
  const upcoming = S.events.filter((e) => new Date(e.start) >= Date.now() - 3 * 36e5).sort((a, b) => new Date(a.start) - new Date(b.start));
  return `
  <div class="page-head"><div><h1>Parties</h1><div class="muted">Drag members from the role lists into parties. Save line-ups as presets and load them into events.</div></div></div>
  <div class="pbar">
    ${off ? '<button class="btn primary" data-act="preset-new">+ New preset</button>' : ''}
    ${S.presets.length ? `<select class="preset-select" data-ui="presetId" aria-label="Choose a preset">${S.presets.map((x) => `<option value="${x.id}" ${p && x.id === p.id ? 'selected' : ''}>${esc(x.name)}${off && x.hidden ? ' (hidden)' : ''}</option>`).join('')}</select>` : ''}
    ${off && p ? `<button class="btn" data-act="preset-dup" data-id="${p.id}">Duplicate</button><button class="btn danger" data-act="preset-del" data-id="${p.id}">Delete</button>
      <select data-act="preset-apply" data-id="${p.id}" style="width:auto;max-width:100%" aria-label="Load this preset into an event"><option value="">Load into event</option>${upcoming.map((e) => `<option value="${e.id}">${esc(e.title)} (${fmtShort(e.start)})</option>`).join('')}</select>` : ''}
  </div>
  ${p ? `<div class="panel" style="margin-bottom:16px">
      ${off ? `<input class="preset-name" data-act="preset-rename" data-id="${p.id}" value="${esc(p.name)}" maxlength="60" aria-label="Preset name"><br>
        <input class="preset-desc" data-act="preset-desc" data-id="${p.id}" value="${esc(p.description || '')}" maxlength="200" placeholder="Add a note, for example who this line-up is for" aria-label="Preset note">
        <label class="tagpick" style="margin:8px 0 0"><input type="checkbox" data-act="preset-hidden" data-id="${p.id}" ${p.hidden ? 'checked' : ''}> Hidden from normal members (only the leadership sees this preset)</label>`
        : `<h2>${esc(p.name)}</h2>${p.description ? `<div class="muted">${esc(p.description)}</div>` : ''}`}
    </div>
    ${off ? presetRulesPanel(p) : ''}
    <div class="panel boardwrap">${board({ kind: 'preset', id: p.id }, p.parties, null)}</div>`
    : `<div class="empty">No presets yet.${off ? ' Click "+ New preset", or build parties on an event and choose "Save as preset".' : ''}</div>`}`;
}

// Use a preset for all upcoming events of one type, and for the ones created later.
function presetRulesPanel(p) {
  const upcoming = (t) => S.events.filter((e) => e.type === t && new Date(e.start) > Date.now());
  const rules = S.presetRules.map((r) => ({ r, preset: byId(S.presets, r.presetId) })).filter((x) => x.preset);
  const soon = S.events.filter((e) => new Date(e.start) > Date.now()).sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 40);
  return `<details class="panel usepreset" ${UI.presetUseOpen ? "open" : ""}><summary>Use this preset for several events</summary>
    <div class="muted small" style="margin:8px 0 6px">Ticked event types use this preset: it is copied into their upcoming events and into every new event of that type. Untick a type to stop that for new events (events that already have parties keep them). You can also tick single events. Events that already started are not touched.</div>
    <form data-form="preset-use" data-id="${p.id}">
      <div class="use-cols">
        <div><div class="k">Event types (ticked = uses this preset)</div>${S.cfg.eventTypes.map((t) => { const rule = S.presetRules.find((r) => r.type === t.name), mine_ = rule && rule.presetId === p.id, other = rule && !mine_ && byId(S.presets, rule.presetId); return `<label class="tagpick"><input type="checkbox" name="rt" value="${esc(t.name)}" ${mine_ ? 'checked' : ''}> ${esc(t.name)} <span class="muted small">(${upcoming(t.name).length} upcoming${other ? `, now uses "${esc(other.name)}"` : ''})</span></label>`; }).join('')}</div>
        <div><div class="k">Single events</div><div class="scrollbox">${soon.map((e) => `<label class="tagpick"><input type="checkbox" name="re" value="${e.id}"> ${esc(e.title)} <span class="muted small">${fmtShort(e.start)}</span></label>`).join('') || '<span class="muted small">No upcoming events.</span>'}</div></div>
      </div>
      <button class="btn primary">Save</button></form>
    <div style="margin-top:14px">${rules.length ? rules.map(({ r, preset }) => `<div class="rule-row"><span><b>${esc(r.type)}</b> uses <b>${esc(preset.name)}</b> <span class="muted small">(${upcoming(r.type).length} upcoming, new ones too)</span></span>
      <button class="btn sm" data-act="rule-reapply" data-type="${esc(r.type)}" data-id="${preset.id}">Apply again to all upcoming</button>
      <button class="btn sm" data-act="rule-stop" data-type="${esc(r.type)}">Stop</button></div>`).join('') : '<div class="muted small">No event type is tied to a preset yet.</div>'}</div>
  </details>`;
}
async function usePresetForType(presetId, type, reapply) {
  const p = byId(S.presets, presetId);
  const up = S.events.filter((e) => e.type === type && new Date(e.start) > Date.now());
  const filled = up.filter((e) => e.parties.length).length;
  let overwrite = !!reapply;
  if (reapply) { if (!confirm(`Replace the parties of all ${up.length} upcoming ${type} events with "${p.name}" again?`)) return; }
  else {
    if (!confirm(`Use "${p.name}" for all ${up.length} upcoming ${type} events, and for every new ${type} event from now on?`)) return;
    if (filled) overwrite = confirm(`${filled} of them already have parties.\n\nOK = replace those too.\nCancel = keep them and only fill the empty ones.`);
  }
  await act(async () => {
    const r = await api(`/api/presets/${p.id}/use-for-type`, 'POST', { type, overwrite });
    toast(`${r.applied} ${type} ${r.applied === 1 ? 'event' : 'events'} updated${r.skipped ? `, ${r.skipped} kept as they were` : ''}. New ones get it automatically.`);
  });
}

// ---- drag and drop (native HTML5; the "..." menus do the same job on touch screens) ----
function clearMarks() { document.querySelectorAll('.over,.end,.before,.drop-before,.drop-after').forEach((x) => x.classList.remove('over', 'end', 'before', 'drop-before', 'drop-after')); }
function dropZone(target) {
  const zone = target.closest('.pdrop');
  if (zone) return zone;
  const card = target.closest('.party');
  if (card) return card.querySelector('.pdrop');
  return target.closest('.pools');
}
function insertIndex(zone, y, mid) {
  const rows = [...zone.querySelectorAll(':scope > .mrow')].filter((r) => Number(r.dataset.m) !== mid);
  const i = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  return { index: i < 0 ? rows.length : i, row: i < 0 ? null : rows[i] };
}
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest && e.target.closest('[data-drag]');
  if (!el) return;
  DRAG = { type: el.dataset.drag, m: Number(el.dataset.m), i: Number(el.dataset.i) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'guild-hall');
  if (DRAG.type === 'party') { const card = el.closest('.party'); if (card) e.dataTransfer.setDragImage(card, 24, 16); }
  setTimeout(() => el.closest(DRAG.type === 'party' ? '.party' : '.mrow')?.classList.add('dragging'), 0);
});
document.addEventListener('dragend', () => { DRAG = null; clearMarks(); document.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); });
document.addEventListener('dragover', (e) => {
  if (!DRAG || !e.target.closest) return;
  const board = e.target.closest('.board'); if (!board) return;
  if (DRAG.type === 'member') {
    const zone = dropZone(e.target); if (!zone) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    clearMarks(); zone.classList.add('over');
    if (zone.classList.contains('pdrop')) { const { row } = insertIndex(zone, e.clientY, DRAG.m); if (row) row.classList.add('before'); else zone.classList.add('end'); }
  } else {
    const card = e.target.closest('.party'); if (!card) return;
    e.preventDefault(); clearMarks();
    const r = card.getBoundingClientRect();
    card.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
  }
});
document.addEventListener('drop', (e) => {
  if (!DRAG || !e.target.closest) return;
  const board = e.target.closest('.board'); if (!board) return;
  e.preventDefault();
  const d = DRAG; DRAG = null;
  const ctx = { kind: board.dataset.kind, id: Number(board.dataset.owner) };
  const parties = JSON.parse(JSON.stringify(partiesOf(ctx.kind, ctx.id)));
  if (d.type === 'member') {
    const zone = dropZone(e.target); if (!zone) { clearMarks(); return; }
    const wasLeaderOf = parties.findIndex((p) => p.leader === d.m);
    const carried = (parties.find((p) => p.members.includes(d.m)) || {}).builds?.[d.m];          // which build they were using
    parties.forEach((p) => { p.members = p.members.filter((id) => id !== d.m); if (p.leader === d.m) p.leader = null; if (p.builds) delete p.builds[d.m]; });
    if (zone.classList.contains('pdrop')) {
      const ti = Number(zone.dataset.i);
      parties[ti].members.splice(insertIndex(zone, e.clientY, d.m).index, 0, d.m);
      if (wasLeaderOf === ti) parties[ti].leader = d.m;      // moving inside the same party keeps the crown
      if (carried) (parties[ti].builds = parties[ti].builds || {})[d.m] = carried;
    }
  } else {
    const card = e.target.closest('.party'); if (!card) { clearMarks(); return; }
    let ti = Number(card.dataset.party);
    const r = card.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    const [moved] = parties.splice(d.i, 1);
    if (d.i < ti) ti--;
    parties.splice(ti + (after ? 1 : 0), 0, moved);
  }
  clearMarks();
  act(() => saveParties(ctx.kind, ctx.id, parties));
});

// "..." menus use fixed positioning so they are never clipped by the scrolling role lists.
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches) return;
  if (d.matches('details.lootd')) { UI.lootOpen[d.dataset.m] = d.open; return; }          // remember open dropdowns across refreshes
  if (d.matches('details.lootrules')) { UI.rulesOpen = d.open; return; }
  if (d.matches('details.usepreset')) { UI.presetUseOpen = d.open; return; }
  if (d.dataset.fold) { (UI.fold = UI.fold || {})[d.dataset.fold] = d.open; return; }
  if (!d.matches('details.menu') || !d.open) return;
  document.querySelectorAll('details.menu[open]').forEach((o) => { if (o !== d) o.removeAttribute('open'); });
  const list = d.querySelector('.menu-list'), r = d.querySelector('summary').getBoundingClientRect();
  list.style.left = Math.max(8, Math.min(window.innerWidth - list.offsetWidth - 8, r.right - list.offsetWidth)) + 'px';
  list.style.top = (r.bottom + list.offsetHeight + 8 > window.innerHeight ? Math.max(8, r.top - list.offsetHeight - 2) : r.bottom + 2) + 'px';
}, true);
window.addEventListener('scroll', () => document.querySelectorAll('details.menu[open]').forEach((o) => o.removeAttribute('open')), true);

const clone = (x) => JSON.parse(JSON.stringify(x));
const partiesOf = (kind, id) => (kind === 'event' ? byId(S.events, id) : byId(S.presets, id)).parties;
const saveParties = (kind, id, parties) => (kind === 'event'
  ? api(`/api/events/${id}/parties`, 'POST', { parties })
  : api(`/api/presets/${id}`, 'PUT', { parties }));
function mutateParties(el, fn, okMsg) {
  const kind = el.dataset.kind, id = Number(el.dataset.owner), i = Number(el.dataset.i);
  const parties = clone(partiesOf(kind, id));
  fn(parties, i);
  act(() => saveParties(kind, id, parties), okMsg);
}

function attendancePanel(ev, past) {
  const rank = (m) => (ev.rsvps[m.id] === 'yes' ? 0 : ev.rsvps[m.id] === 'no' ? 2 : 1);
  const list = S.members.filter((m) => m.active || ev.attended.includes(m.id)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return `<div class="panel"><h3>Attendance</h3>
    <p class="muted small" style="margin-top:0">${past ? '' : 'The event has not started yet. '}Tick who showed up${ev.points && pointsOn() ? `; each gets ${ev.points} points` : ''}.${pointsOn() ? ' Saving again updates points automatically.' : ''}</p>
    <form data-form="attendance" data-id="${ev.id}">
      <div class="attend-list">${list.map((m) => `<label><input type="checkbox" name="m" value="${m.id}" ${ev.attended.includes(m.id) ? 'checked' : ''}>
        ${esc(m.name)} ${roleChip(m.role)} <span class="muted small">${ev.rsvps[m.id] === 'yes' ? 'signed up' : ev.rsvps[m.id] === 'no' ? "can't" : ''}${ev.pinEntries && ev.pinEntries[m.id] ? ' · entered the PIN' : ''}</span></label>`).join('')}</div>
      <button class="btn primary">Save attendance</button>
    </form></div>`;
}

function eventDialog(ev, dateStr) {
  const isNew = !ev;
  const startIso = tzToIso((dateStr || addDayStr(todayTz(), 1)) + 'T20:00');      // 20:00 in your time zone
  ev = ev || { title: '', type: S.cfg.eventTypes[0].name, start: startIso, description: '', points: S.cfg.eventTypes[0].points, mandatory: !!S.cfg.eventTypes[0].mandatory, maxSignups: 0 };
  openDialog(`
  <form data-form="event" data-id="${ev.id || ''}">
    <h2>${isNew ? 'New event' : 'Edit event'}</h2>
    <div class="field"><label>Title (optional, the type is used when this is empty)</label><input name="title" value="${esc(ev.title)}" maxlength="80"></div>
    <div class="row">
      <div class="field"><label>Type</label><select name="type" id="ev-type">${S.cfg.eventTypes.map((t) => `<option value="${esc(t.name)}" data-pts="${t.points}" data-mand="${t.mandatory ? 1 : 0}" ${t.name === ev.type ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Starts (${esc(TZ())}, ${esc(tzAbbr(new Date(ev.start).getTime()))})</label><input name="start" type="datetime-local" value="${toLocalInput(ev.start)}" required></div>
    </div>
    <div class="row">
      ${pointsOn() ? `<div class="field"><label>Points for attending</label><input name="points" id="ev-pts" type="number" min="0" value="${ev.points}"></div>` : ''}
      <div class="field"><label>Max sign-ups (0 = no limit)</label><input name="maxSignups" type="number" min="0" value="${ev.maxSignups}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Close sign-ups (minutes before start)</label><input name="signupCloseMinutes" type="number" min="0" max="10080" value="${ev.signupCloseMinutes ?? S.settings.signupCloseDefault}"></div>
      <div class="field"><label>PIN window (minutes players can enter it)</label><input name="pinWindowMinutes" type="number" min="1" max="720" value="${ev.pinWindowMinutes ?? S.settings.pinWindowDefault}"></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:8px"><input type="checkbox" name="reminders" ${ev.reminders === false ? '' : 'checked'}> Remind players who have not answered (times are set in Admin)</label>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:12px"><input type="checkbox" name="mandatory" id="ev-mand" ${ev.mandatory ? 'checked' : ''}> Mandatory event (counts toward "Qualified for loot")</label>
    <div class="field"><label>Details</label><textarea name="description" maxlength="1500" placeholder="Where to meet, what to bring, voice channel">${esc(ev.description)}</textarea></div>
    <div class="dlg-actions">
      ${isNew ? '' : '<button type="button" class="btn danger left" data-act="event-delete">Delete</button>'}
      <button type="button" class="btn" data-act="dlg-close">Cancel</button>
      <button class="btn primary">Save event</button>
    </div>
  </form>`);
}

// Greedy balancer: fills parties so each gets a similar mix of roles and gear score.
function autoParties(ev) {
  const going = Object.entries(ev.rsvps).filter(([, s]) => s === 'yes').map(([id]) => byId(S.members, id)).filter(Boolean);
  if (!going.length) return [];
  const size = S.cfg.partySize;
  const n = Math.ceil(going.length / size);
  const parties = Array.from({ length: n }, () => ({ ids: [], roles: {}, gs: 0 }));
  const order = [...S.cfg.roles].sort((a, b) => (a === S.cfg.roles[0] ? -1 : b === S.cfg.roles[0] ? 1 : 0)); // scarce support roles first
  const sorted = order.flatMap((r) => going.filter((m) => m.role === r).sort((a, b) => b.gearScore - a.gearScore));
  for (const m of sorted) {
    const open = parties.filter((p) => p.ids.length < size);
    open.sort((a, b) => (a.roles[m.role] || 0) - (b.roles[m.role] || 0) || a.gs - b.gs || a.ids.length - b.ids.length);
    const p = open[0];
    p.ids.push(m.id); p.roles[m.role] = (p.roles[m.role] || 0) + 1; p.gs += m.gearScore;
  }
  return parties.map((p, i) => ({ name: `Party ${i + 1}`, members: p.ids }));
}

/* ================= loot ================= */
function viewLoot() {
  const off = isOfficer();
  const q = UI.lootQ.toLowerCase();
  const nameOf = (id) => (byId(S.members, id) || { name: '(removed)' }).name;
  const list = S.loot.filter((l) => (!UI.lootPlayer || l.memberId === Number(UI.lootPlayer)) && (!UI.lootType || l.type === UI.lootType) && (!q || `${l.item} ${nameOf(l.memberId)}`.toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const active = S.members.filter((m) => m.active).sort((a, b) => a.name.localeCompare(b.name));
  // No outside item catalog - just everything typed in here before, so a name only ever needs typing once and
  // the next entry can pick it from the list instead of risking a slightly different spelling.
  const itemNames = [...new Set(S.loot.map((l) => l.item).filter(Boolean))].sort();
  const itemDatalist = `<datalist id="item-names">${itemNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
  return `
  ${itemDatalist}
  <div class="page-head"><div><h1>Loot</h1><div class="muted">Who received which item, and on which day. The dashboard reads its "items received" numbers from this list.${isOfficer() ? '' : ' You only see your own loot.'}</div></div></div>
  ${off ? `<div class="panel" style="margin-bottom:16px"><h3>Give out loot</h3>
    ${active.length ? `<form data-form="loot" class="loot-form">
      <div class="field"><label for="lf-m">Player</label><select id="lf-m" name="memberId" required>${active.map((m) => `<option value="${m.id}" ${Number(UI.lootMember) === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="lf-t">Type</label><select id="lf-t" name="type" data-act="loot-type">${S.cfg.lootTypes.map((t) => `<option ${(UI.lootFormType || S.cfg.lootDefaultType) === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      ${(() => { const lu = (UI.lootFormType || S.cfg.lootDefaultType) === 'Lucent'; return `
      <div class="field wide slidefield ${lu ? 'off' : ''}" id="lf-item-field"><label for="lf-i">Item</label><input id="lf-i" name="item" ${lu ? '' : 'required'} maxlength="120" placeholder="Item name" autocomplete="off" list="item-names"></div>
      <div class="field wide slidefield ${lu ? '' : 'off'}" id="lf-amt-field"><label for="lf-a">Amount of Lucent</label><input id="lf-a" name="amount" type="number" min="1" ${lu ? 'required' : ''} placeholder="For example 1500" autocomplete="off"></div>`; })()}
      <div class="field"><label for="lf-d">Given out on</label><input id="lf-d" name="date" type="date" value="${esc(UI.lootDate || todayTz())}" required></div>
      <div class="field"><label for="lf-r">Decision (optional)</label><select id="lf-r" name="reason"><option value="">-</option>${S.cfg.lootReasons.map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
      <div class="field"><label for="lf-p">Purpose (optional)</label><select id="lf-p" name="purpose"><option value="">-</option>${S.cfg.lootPurposes.map((p) => `<option>${esc(p)}</option>`).join('')}</select></div>
      <button class="btn primary">Add</button>
    </form>` : '<div class="muted">Add characters on the Member page first.</div>'}</div>` : ''}
  <div class="toolbar">
    <input type="search" placeholder="Search player or item" value="${esc(UI.lootQ)}" data-ui="lootQ" aria-label="Search loot">
    <select data-ui="lootPlayer" aria-label="Player"><option value="">All players</option>${S.members.slice().sort((a, b) => a.name.localeCompare(b.name)).map((m) => `<option value="${m.id}" ${Number(UI.lootPlayer) === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    <select data-ui="lootType" aria-label="Loot type"><option value="">All types</option>${S.cfg.lootTypes.map((t) => `<option ${UI.lootType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
    <span class="muted small">${list.length} ${list.length === 1 ? 'entry' : 'entries'}</span>
  </div>
  ${list.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Given out</th><th>Player</th><th>Type</th><th>Item</th><th></th></tr></thead>
    <tbody>${list.map((l) => { const m = byId(S.members, l.memberId); return `<tr>
      <td class="nowrap">${fmtLootDate(l.date)}</td><td><b>${esc(nameOf(l.memberId))}</b> ${m ? roleChip(m.role) : ''}</td><td><span class="type-pill t-${esc(l.type)}">${esc(l.type || 'Item')}</span></td><td>${l.type === 'Lucent' ? `<b>${Number(l.amount).toLocaleString()}</b> Lucent` : esc(l.item)}${l.fromRequest ? ' <span class="muted small">(from a request)</span>' : ''}${l.reason || l.purpose ? `<div class="muted small">${[l.reason, l.purpose].filter(Boolean).join(' · ')}</div>` : ''}</td>
      <td>${off ? `<span class="seg">${l.proofConfirmed ? `<button class="btn sm" data-act="loot-proof" data-id="${l.id}" data-on="0" style="color:#7cc4b8;border-color:#7cc4b8" title="Confirmed by ${esc(l.proofConfirmedBy || '')}, ${l.proofConfirmedAt ? fmtShort(l.proofConfirmedAt) : ''} - click to undo">✓ Proof confirmed</button>` : `<button class="btn sm" data-act="loot-proof" data-id="${l.id}" data-on="1">Confirm proof of use</button>`}<button class="btn sm" data-act="loot-edit" data-id="${l.id}">Edit</button></span>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
    : `<div class="empty">${S.loot.length ? 'Nothing matches your search.' : 'No loot has been given out yet.' + (off ? ' Use the form above to add the first entry.' : '')}</div>`}`;
}

function lootDialog(l) {
  const players = S.members.filter((m) => m.active || m.id === l.memberId).sort((a, b) => a.name.localeCompare(b.name));
  openDialog(`
  <form data-form="loot-edit" data-id="${l.id}">
    <h2>Edit loot entry</h2>
    <div class="field"><label>Player</label><select name="memberId">${players.map((m) => `<option value="${m.id}" ${m.id === l.memberId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
    <div class="row"><div class="field"><label>Type</label><select name="type" data-act="loot-type-edit">${S.cfg.lootTypes.map((t) => `<option ${l.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="field" style="flex:2"><div id="le-item" class="${l.type === 'Lucent' ? 'hidden' : ''}"><label>Item</label><input name="item" value="${esc(l.item)}" ${l.type === 'Lucent' ? '' : 'required'} maxlength="120" list="item-names"></div>
        <div id="le-amt" class="${l.type === 'Lucent' ? '' : 'hidden'}"><label>Amount of Lucent</label><input name="amount" type="number" min="1" value="${l.amount || ''}" ${l.type === 'Lucent' ? 'required' : ''}></div></div></div>
    <div class="field"><label>Given out on</label><input name="date" type="date" value="${esc(l.date)}" required></div>
    <div class="row"><div class="field"><label>Decision (optional)</label><select name="reason"><option value="">-</option>${S.cfg.lootReasons.map((r) => `<option ${l.reason === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></div>
      <div class="field"><label>Purpose (optional)</label><select name="purpose"><option value="">-</option>${S.cfg.lootPurposes.map((p) => `<option ${l.purpose === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div></div>
    <div class="dlg-actions"><button type="button" class="btn danger left" data-act="loot-delete" data-id="${l.id}">Delete</button>
      <button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div>
  </form>`);
}

/* ================= points ================= */
function viewAttendanceOnly() {
  const rows = S.members.filter((m) => m.active).map((m) => ({ m, att: attendanceStats(m.id) })).sort((a, b) => (b.att.pct ?? -1) - (a.att.pct ?? -1) || a.m.name.localeCompare(b.m.name));
  return `
  <div class="page-head"><div><h1>Attendance</h1><div class="muted">Points for attending are switched off (Admin). Counts past events where officers took roll.</div></div></div>
  ${rows.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Character</th><th>Role</th><th class="num">Attended</th><th class="num">Rate</th></tr></thead>
    <tbody>${rows.map(({ m, att }) => `<tr><td><b>${esc(m.name)}</b></td><td>${roleChip(m.role)}</td>
      <td class="num">${att.of ? `${att.n} / ${att.of}` : '-'}</td><td class="num">${att.pct === null ? '-' : att.pct + '%'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No active characters yet.</div>'}`;
}

function viewPoints() {
  if (!pointsOn()) return viewAttendanceOnly();
  const active = S.members.filter((m) => m.active);
  const rows = active.map((m) => ({ m, bal: balance(m.id), att: attendanceStats(m.id) })).sort((a, b) => b.bal - a.bal || a.m.name.localeCompare(b.m.name));
  const focus = UI.pointsFocus ? byId(S.members, UI.pointsFocus) : null;
  const ledger = S.points.filter((p) => !focus || p.memberId === focus.id).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 60);
  return `
  <div class="page-head"><div><h1>Points and attendance</h1><div class="muted">Points come from event attendance and officer adjustments. Attendance counts past events where officers took roll.</div></div></div>
  ${rows.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Character</th><th>Role</th><th class="num">Points</th><th class="num">Attended</th><th class="num">Rate</th></tr></thead>
    <tbody>${rows.map(({ m, bal, att }) => `<tr class="click" data-act="points-focus" data-id="${m.id}">
      <td><b>${esc(m.name)}</b></td><td>${roleChip(m.role)}</td>
      <td class="num ${bal > 0 ? 'pos' : bal < 0 ? 'neg' : ''}">${bal}</td>
      <td class="num">${att.of ? `${att.n} / ${att.of}` : '-'}</td><td class="num">${att.pct === null ? '-' : att.pct + '%'}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No active characters yet.</div>'}

  ${isOfficer() ? `<div class="panel" style="margin-top:20px"><h3>Adjust points</h3>
    <form data-form="points" class="toolbar" style="margin:0">
      <select name="memberId" required aria-label="Character" style="min-width:180px">${active.slice().sort((a, b) => a.name.localeCompare(b.name)).map((m) => `<option value="${m.id}" ${focus && focus.id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <input name="delta" type="number" placeholder="+5 or -10" required style="width:110px" aria-label="Amount">
      <input name="reason" list="reasons" placeholder="Reason" style="flex:1;min-width:160px" aria-label="Reason">
      <datalist id="reasons">${S.cfg.pointReasons.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <button class="btn primary">Add entry</button>
    </form></div>` : ''}

  <div class="panel" style="margin-top:16px"><div class="ev-title"><h3>${focus ? `Ledger for ${esc(focus.name)}` : 'Recent ledger'}</h3>
    ${focus ? '<button class="btn sm" data-act="points-focus" data-id="">Show everyone</button>' : ''}</div>
    ${ledger.length ? `<div class="tbl-wrap" style="border:0"><table><tbody>${ledger.map((p) => {
      const m = byId(S.members, p.memberId);
      return `<tr><td class="muted small" style="white-space:nowrap">${fmtShort(p.at)}</td><td>${esc(m ? m.name : '?')}</td><td>${esc(p.reason)}</td>
        <td class="num ${p.delta > 0 ? 'pos' : 'neg'}">${p.delta > 0 ? '+' : ''}${p.delta}</td>
        <td>${isOfficer() && !p.eventId ? `<button class="btn sm" data-act="points-del" data-id="${p.id}" aria-label="Delete entry">×</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="muted">No entries yet.</div>'}</div>`;
}

/* ================= admin ================= */
// Each Admin panel below is its own small function so features.js can put them in whatever order the
// leadership actually wants, rather than always showing them in this file's own order. "Link old characters
// to Discord players" (the pre-Discord-sign-in migration helper) is not among them, by request - a guild with
// nothing left to link does not need to see it. The route it used to call (/api/admin/link-owner) is untouched
// in server.js in case it is ever needed again; only this page stopped offering a way to reach it.
function adminSignIn() {
  const dc = S.cfg.authMode === 'discord';
  return `<div class="panel"><h3>Sign-in and Discord</h3>
    <p style="margin-top:0">${dc ? 'Members sign in with their Discord account. Officers are the people with an officer role on the Discord server. People outside the guild can apply if you switch that on below.' : '<b>Demo mode:</b> Discord sign-in is not set up, so everybody uses the shared passcodes. See the README, section "Discord setup".'}</p>
    <p class="small muted" style="margin-bottom:10px">Discord bot for direct messages (PINs and reminders): <b>${S.cfg.botOn ? 'on' : 'off'}</b>${S.cfg.botOn ? '' : '. Without it, PINs and reminders are only written to the server log.'}</p>
    <button class="btn" data-act="test-dm">Send me a test message</button>
  </div>`;
}
function adminEventRules() {
  const st = S.settings, hours = (st.reminderMinutes || []).map((m) => Math.round(m / 6) / 10).join(', ');
  return `<div class="panel"><h3>Events: sign-ups, attendance PIN and reminders</h3>
    <form data-form="eventrules" class="rules-grid" style="padding-bottom:0">
      <div class="field"><label for="er-close">Close sign-ups (minutes before start)</label><input id="er-close" name="signupCloseDefault" type="number" min="0" max="10080" value="${st.signupCloseDefault}" required></div>
      <div class="field"><label for="er-off">Create the PIN (minutes after start, negative = before)</label><input id="er-off" name="pinOffsetMinutes" type="number" min="-1440" max="1440" value="${st.pinOffsetMinutes}" required></div>
      <div class="field"><label for="er-win">PIN window (minutes players can enter it)</label><input id="er-win" name="pinWindowDefault" type="number" min="1" max="720" value="${st.pinWindowDefault}" required></div>
      <div class="field"><label for="er-rem">Reminders (hours before the event)</label><input id="er-rem" name="reminderHours" value="${esc(hours)}" placeholder="5, 2"></div>
      <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin:0"><input type="checkbox" name="remindersEnabled" ${st.remindersEnabled ? 'checked' : ''}> Send reminders</label>
      <button class="btn primary">Save</button>
    </form>
    <p class="muted small" style="margin:12px 0 0">These are the defaults for new events. Each event can override the sign-up close time and the PIN window in its edit dialog. The PIN is sent by Discord to the leader of every party and to the leadership. Reminders go to players who have not answered Going or Can't with any character; "5, 2" means the first reminder 5 hours before the event and the second 2 hours before.</p>
  </div>`;
}
function adminPointsToggle() {
  return `<div class="panel"><h3>Points for attending</h3>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin:0"><input type="checkbox" data-act="points-toggle" ${pointsOn() ? 'checked' : ''}> Give points when members attend events</label>
    <p class="muted small" style="margin-bottom:0">When this is off, attendance is still recorded (and still counts for loot), but nobody receives points. The points fields disappear and the Points page becomes a plain attendance list. Points already given are kept.</p>
  </div>`;
}
function adminPlayersList() {
  const dc = S.cfg.authMode === 'discord', owners = [...new Set(S.members.map((m) => m.owner))];
  return `<div class="panel"><h3>Players (${dc ? S.users.length : owners.length})</h3>
    ${dc ? (S.users.length ? S.users.slice().sort((a, b) => a.name.localeCompare(b.name)).map((u) => `<div class="rule-row">${avatarImg(u)}<b>${esc(u.name)}</b>${u.role === 'officer' ? '<span class="badge-officer">Officer</span>' : ''}<span class="muted small">${S.members.filter((m) => m.owner === u.id).length} characters</span></div>`).join('') : '<span class="muted">Nobody has signed in yet.</span>')
      : `<p class="muted small" style="margin-top:0">Each player is whoever signed in with that display name.</p><div>${owners.sort().map((o) => `<span class="btn sm" style="display:inline-block;margin:0 6px 6px 0;cursor:default">${esc(o)} · ${S.members.filter((m) => m.owner === o).length}</span>`).join('') || '<span class="muted">No one yet.</span>'}</div>`}
  </div>`;
}
function adminBackup() {
  return `<div class="panel"><h3>Backup</h3>
    <p class="muted small" style="margin-top:0">Download everything as one file, or restore from a previous download. Restoring replaces all current data.</p>
    <span class="seg"><button class="btn" data-act="export">Download backup</button>
    <label class="btn" style="margin:0;color:var(--text)">Restore from file<input type="file" accept="application/json" data-act="import" class="hidden"></label></span>
  </div>`;
}
// Plain reference text, not a panel: it has no form or button, so it does not need to be collapsible like
// everything else on this page (see the dropdown-conversion hook in features.js, which only touches .panel
// elements with an <h3> - this is neither, on purpose).
function adminCustomizingText() {
  return `<div class="muted small" style="margin:18px 2px 0;padding-top:14px;border-top:1px solid var(--line)">
    <b>Customizing:</b> guild name, roles, weapons, the class name for each weapon pair, ranks, event types (with default points and mandatory flag), loot types and the starting loot rules are in <code>config.json</code>. Restart the server after changing it. Colors and fonts are the variables at the top of <code>public/index.html</code>. Discord settings are environment variables (see the README).
  </div>`;
}

/* ================= dialog ================= */
function openDialog(html, wide) { const d = $('#dlg'); d.innerHTML = html; d.classList.toggle('wide', !!wide); if (!d.open) d.showModal(); const f = d.querySelector('input,select'); f && f.focus(); }
function closeDialog() { const d = $('#dlg'); if (d.open) d.close(); }
$('#dlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDialog(); });

/* ================= events (delegated) ================= */
document.addEventListener('click', async (e) => {
  document.querySelectorAll('details.menu[open]').forEach((o) => { if (!o.contains(e.target)) o.removeAttribute('open'); });
  const el = e.target.closest('[data-act]'); if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const d = el.dataset, a = d.act;
  const ev = () => byId(S.events, d.ev || d.id);
  if (ACTIONS[a]) { ACTIONS[a](el, d, e); return; }
  if (a === 'logout') { e.preventDefault(); logout(); }
  else if (a === 'dlg-close') closeDialog();
  else if (a === 'member-new') memberDialog();
  else if (a === 'member-edit') memberDialog(byId(S.members, d.id));
  else if (a === 'goto-add') { e.preventDefault(); location.hash = '#/member'; memberDialog(); }
  else if (a === 'member-delete') {
    const id = $('#dlg form').dataset.id;
    if (confirm('Delete this character, including their points and sign-ups? This cannot be undone. (To keep history, mark them inactive instead.)'))
      act(async () => { await api('/api/members/' + id, 'DELETE'); closeDialog(); }, 'Character deleted');
  }
  else if (a === 'event-new') eventDialog();
  else if (a === 'event-edit') eventDialog(byId(S.events, d.id));
  else if (a === 'event-delete') {
    const id = $('#dlg form').dataset.id, ev0 = byId(S.events, id);
    if (confirm(ev0 && ev0.seriesId ? 'Delete only this date of the recurring event? The other dates stay. (To stop the whole series, use "Edit series" > Delete series.)' : 'Delete this event and the points it awarded?')) act(async () => { await api('/api/events/' + id, 'DELETE'); closeDialog(); location.hash = '#/events'; }, 'Event deleted');
  }
  else if (a === 'duty-cycle') act(() => api('/api/duties/' + d.id, 'PUT', { status: d.s }));
  else if (a === 'duty-del') act(() => api('/api/duties/' + d.id, 'DELETE'));
  else if (a === 'toggle-past') { UI.showPast = !UI.showPast; render(); }
  else if (a === 'rsvp') act(() => api(`/api/events/${d.ev}/rsvp`, 'POST', { memberId: d.m, status: d.s }));
  else if (a === 'rsvp-other') act(() => api(`/api/events/${d.ev}/rsvp`, 'POST', { memberId: $('#other-char').value, status: d.s }));
  else if (a === 'parties-build') {
    const e2 = ev(); if (e2.parties.length && !confirm('Replace the current parties?')) return;
    const p = autoParties(e2);
    if (!p.length) return toast('Nobody has signed up as Going yet.', true);
    p.forEach((q, i) => { if (e2.parties[i]) q.name = e2.parties[i].name; }); // keep names you already chose
    act(() => api(`/api/events/${e2.id}/parties`, 'POST', { parties: p }), 'Parties built');
  }
  else if (a === 'party-add') mutateParties(el, (ps) => ps.push({ name: `Party ${ps.length + 1}`, members: [] }));
  else if (a === 'party-del') {
    const list = partiesOf(d.kind, Number(d.owner));
    if (list[Number(d.i)].members.length && !confirm('Remove this party? Its members become unassigned.')) return;
    mutateParties(el, (ps, i) => ps.splice(i, 1));
  }
  else if (a === 'preset-new') {
    const name = prompt('Name for the new preset', 'Siege line-up');
    if (name && name.trim()) act(async () => { const r = await api('/api/presets', 'POST', { name, parties: [{ name: 'Party 1', members: [] }] }); UI.presetId = r.id; }, 'Preset created');
  }
  else if (a === 'preset-from-event') {
    const e2 = ev(); const name = prompt('Name for this preset', e2.title);
    if (name && name.trim()) act(async () => { const r = await api('/api/presets', 'POST', { name, parties: e2.parties }); UI.presetId = r.id; }, 'Saved. Find it under Parties.');
  }
  else if (a === 'rule-add') usePresetForType(Number(d.id), $('#rule-type').value, false);
  else if (a === 'rule-reapply') usePresetForType(Number(d.id), d.type, true);
  else if (a === 'rule-stop') act(() => api('/api/preset-rules/' + encodeURIComponent(d.type), 'DELETE'), 'Stopped. Existing events keep their parties.');
  else if (a === 'preset-dup') { const p = byId(S.presets, d.id); act(async () => { const r = await api('/api/presets', 'POST', { name: p.name + ' (copy)', description: p.description, parties: p.parties }); UI.presetId = r.id; }, 'Preset duplicated'); }
  else if (a === 'preset-del') { if (confirm('Delete this preset? Events that already use it keep their parties.')) act(async () => { await api('/api/presets/' + d.id, 'DELETE'); UI.presetId = null; }, 'Preset deleted'); }
  else if (a === 'cal-prev' || a === 'cal-next') {
    const dir = a === 'cal-next' ? 1 : -1, rw = wall(UI.calRef || Date.now()), r = new Date(rw.y, rw.m - 1, rw.d);
    const t = UI.calView === 'month' ? new Date(r.getFullYear(), r.getMonth() + dir, 1) : new Date(r.getFullYear(), r.getMonth(), r.getDate() + 7 * dir);
    UI.calRef = dayRef(t.getFullYear(), t.getMonth() + 1, t.getDate());
    render();
  }
  else if (a === 'cal-today') { UI.calRef = null; render(); }
  else if (a === 'cal-view') { UI.calView = d.v; render(); }
  else if (a === 'cal-week') { UI.calView = 'week'; UI.calRef = Date.parse(tzToIso(d.date + 'T12:00')); render(); }
  else if (a === 'loot-today') act(() => api('/api/settings', 'PUT', { lootFrom: '' }), 'Counting back from today');
  else if (a === 'loot-all') { UI.lootOnlyOk = !UI.lootOnlyOk; render(); }
  else if (a === 'test-dm') act(async () => { const r = await api('/api/admin/test-dm', 'POST', {}); if (!r.ok) throw new Error(r.error || 'The message could not be sent.'); toast('Test message sent. Check your Discord messages.'); });
  else if (a === 'link-owner') act(async () => { const r = await api('/api/admin/link-owner', 'POST', { from: d.from, to: $('#lk-' + d.i).value }); toast(`${r.moved} characters linked`); });
  else if (a === 'pin-send') act(() => api(`/api/events/${d.id}/pin/send`, 'POST', { mode: d.mode }), d.mode === 'new' ? 'New PIN created and sent' : 'PIN sent');
  else if (a === 'loot-proof') act(() => api(`/api/loot/${d.id}/proof`, 'PUT', { confirmed: d.on === '1' }), d.on === '1' ? 'Proof of use confirmed' : 'Confirmation removed');
  else if (a === 'loot-edit') lootDialog(byId(S.loot, d.id));
  else if (a === 'loot-delete') { if (confirm('Delete this loot entry?')) act(async () => { await api('/api/loot/' + d.id, 'DELETE'); closeDialog(); }, 'Entry deleted'); }
  else if (a === 'm-leader') mutateParties(el, (ps, i) => { ps[i].leader = ps[i].leader === Number(d.m) ? null : Number(d.m); });
  else if (a === 'm-remove') { const mid = Number(d.m); mutateParties(el, (ps) => ps.forEach((p) => { p.members = p.members.filter((x) => x !== mid); if (p.leader === mid) p.leader = null; if (p.builds) delete p.builds[mid]; })); }
  else if (a === 'm-build') { const mid = Number(d.m); mutateParties(el, (ps, i) => { ps[i].builds = ps[i].builds || {}; if (d.b === 'main') delete ps[i].builds[mid]; else ps[i].builds[mid] = d.b; }); }
  else if (a === 'm-move') { const mid = Number(d.m), to = Number(d.to); mutateParties(el, (ps) => { const carried = (ps.find((p) => p.members.includes(mid)) || {}).builds?.[mid]; ps.forEach((p) => { p.members = p.members.filter((x) => x !== mid); if (p.leader === mid) p.leader = null; if (p.builds) delete p.builds[mid]; }); ps[to].members.push(mid); if (carried) (ps[to].builds = ps[to].builds || {})[mid] = carried; }); }
  else if (a === 'p-clear') mutateParties(el, (ps, i) => { ps[i].members = []; ps[i].leader = null; ps[i].builds = {}; });
  else if (a === 'p-left' || a === 'p-right') mutateParties(el, (ps, i) => { const j = i + (a === 'p-right' ? 1 : -1); if (j >= 0 && j < ps.length) [ps[i], ps[j]] = [ps[j], ps[i]]; });
  else if (a === 'cal-day') { if (!e.target.closest('a') && isOfficer()) eventDialog(null, d.date); }
  else if (a === 'points-focus') { UI.pointsFocus = d.id ? Number(d.id) : null; render(); }
  else if (a === 'points-del') { if (confirm('Delete this ledger entry?')) act(() => api('/api/points/' + d.id, 'DELETE')); }
  else if (a === 'export') {
    try {
      const data = await api('/api/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const l = document.createElement('a'); l.href = url; l.download = `guild-backup-${new Date().toISOString().slice(0, 10)}.json`; l.click();
      URL.revokeObjectURL(url);
    } catch (er) { toast(er.message, true); }
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (CHANGES[el.dataset.act]) { CHANGES[el.dataset.act](el); return; }
  if (el.dataset.ui) { UI[el.dataset.ui] = el.type === 'checkbox' ? el.checked : el.value; render(); }
  else if (el.dataset.act === 'party-rename') mutateParties(el, (ps, i) => { ps[i].name = el.value.trim() || `Party ${i + 1}`; });
  else if (el.dataset.act === 'points-toggle') act(() => api('/api/settings', 'PUT', { pointsEnabled: el.checked }), el.checked ? 'Points are on' : 'Points are off');
  else if (el.dataset.act === 'loot-date') act(() => api('/api/settings', 'PUT', { lootFrom: el.value }), 'Loot window updated');
  else if (el.dataset.act === 'preset-load') {
    const evn = byId(S.events, el.dataset.ev), p = byId(S.presets, el.value);
    if (!p) return;
    if (evn.parties.length && !confirm('Replace this event\'s parties with the preset?')) { el.value = ''; return; }
    act(() => api(`/api/events/${evn.id}/parties`, 'POST', { parties: clone(p.parties) }), 'Preset loaded');
  }
  else if (el.dataset.act === 'preset-forever') { const evn = byId(S.events, el.dataset.ev), id = Number(el.value); el.value = ''; if (id) usePresetForType(id, evn.type, false); }
  else if (el.dataset.act === 'preset-apply') {
    const evn = byId(S.events, el.value), p = byId(S.presets, el.dataset.id);
    if (!evn) return;
    if (evn.parties.length && !confirm(`Replace the parties already set on "${evn.title}"?`)) { el.value = ''; return; }
    act(() => api(`/api/events/${evn.id}/parties`, 'POST', { parties: clone(p.parties) }), `Loaded into ${evn.title}`);
  }
  else if (el.dataset.act === 'preset-rename') act(() => api('/api/presets/' + el.dataset.id, 'PUT', { name: el.value }));
  else if (el.dataset.act === 'preset-desc') act(() => api('/api/presets/' + el.dataset.id, 'PUT', { description: el.value }));
  else if (el.name === 'primaryWeapon' || el.name === 'secondaryWeapon') {
    const f = el.form, c = classFor(f.elements.primaryWeapon.value, f.elements.secondaryWeapon.value);
    $('#class-preview').textContent = classPreviewText(f.elements.primaryWeapon.value, f.elements.secondaryWeapon.value);
  }
  else if (el.dataset.act === 'import') {
    const f = el.files[0]; if (!f) return;
    if (!confirm('Restoring replaces ALL current data with the contents of this file. Continue?')) { el.value = ''; return; }
    f.text().then((t) => act(() => api('/api/import', 'POST', JSON.parse(t)), 'Backup restored')).catch(() => toast('That file could not be read.', true));
  }
  else if (el.id === 'ev-type') { if ($('#ev-pts')) $('#ev-pts').value = el.selectedOptions[0].dataset.pts; $('#ev-mand').checked = el.selectedOptions[0].dataset.mand === '1'; }
});
document.addEventListener('input', (e) => {
  const k = e.target.dataset.ui;
  if (k === 'rosterQ' || k === 'lootQ') {
    UI[k] = e.target.value; const pos = e.target.selectionStart; render();
    const i = $(`[data-ui=${k}]`); i.focus(); i.setSelectionRange(pos, pos);
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form, id = f.dataset.id;
  const fd = Object.fromEntries(new FormData(f));
  if (FORMS[kind]) { FORMS[kind](f, fd, id); return; }
  if (kind === 'login') {
    try {
      const r = await api('/api/login', 'POST', fd);
      token = r.token; localStorage.setItem('gh_token', token);
      $('#login-err').textContent = ''; await start();
    } catch (er) { $('#login-err').textContent = er.message; }
  } else if (kind === 'member') {
    fd.active = f.elements.active.checked;
    fd.questlogs = collectLinks(f); delete fd.ql_label; delete fd.ql_url;
    let pending = [];
    if (await act(async () => { const r = await api(id ? '/api/members/' + id : '/api/members', id ? 'PUT' : 'POST', fd); pending = r.approvalPending || []; closeDialog(); }))
      toast(pending.length ? `Saved. Waiting for the leadership to approve: ${pending.join(', ')}.` : 'Character saved');
  } else if (kind === 'event') {
    fd.start = tzToIso(fd.start);
    fd.mandatory = f.elements.mandatory.checked;
    fd.reminders = f.elements.reminders.checked;
    act(async () => {
      const r = await api(id ? '/api/events/' + id : '/api/events', id ? 'PUT' : 'POST', fd);
      closeDialog(); location.hash = '#/events/' + r.id;
    }, 'Event saved');
  } else if (kind === 'attendance') {
    const ids = [...f.querySelectorAll('input[name=m]:checked')].map((i) => Number(i.value));
    act(() => api(`/api/events/${id}/attendance`, 'POST', { memberIds: ids }), 'Attendance saved');
  } else if (kind === 'eventrules') {
    const mins = String(fd.reminderHours || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => Math.round(parseFloat(x) * 60));
    if (mins.some((n) => !Number.isFinite(n))) return toast('Reminders: type hours separated by commas, for example 5, 2', true);
    act(() => api('/api/settings', 'PUT', { signupCloseDefault: fd.signupCloseDefault, pinOffsetMinutes: fd.pinOffsetMinutes, pinWindowDefault: fd.pinWindowDefault, reminderMinutes: mins, remindersEnabled: f.elements.remindersEnabled.checked }), 'Saved');
  } else if (kind === 'pin') {
    act(() => api(`/api/events/${f.dataset.ev}/pin`, 'POST', { memberId: f.dataset.m, pin: fd.pin }), 'Attendance recorded');
  } else if (kind === 'loot') {
    act(async () => { await api('/api/loot', 'POST', fd); UI.lootMember = fd.memberId; UI.lootDate = fd.date; UI.lootFormType = fd.type; }, 'Loot added').then(() => { const i = $('#lf-i'); if (i) i.focus(); });
  } else if (kind === 'loot-edit') {
    act(async () => { await api('/api/loot/' + id, 'PUT', fd); closeDialog(); }, 'Entry saved');
  } else if (kind === 'lootrules') {
    act(() => api('/api/settings', 'PUT', fd), 'Loot rules saved');
  } else if (kind === 'duty') {
    act(() => api('/api/duties', 'POST', { memberId: id, text: fd.text }), 'Task added');
  } else if (kind === 'points') {
    act(async () => { await api('/api/points', 'POST', fd); }, 'Entry added');
  }
});

/* ================= boot ================= */
async function start() {
  try { await refresh(true); }
  catch { return showLogin(); }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  const pending = localStorage.getItem('gh_pending_hash');
  if (pending) { localStorage.removeItem('gh_pending_hash'); location.hash = pending; }
  else if (!location.hash) location.hash = '#/dashboard';
  render();
}
(async () => {
  S.cfg = await (await fetch('/api/config')).json();
  applyBranding();
  if (token || S.cfg.authMode === 'discord') await start(); else showLogin();
  setInterval(() => { if (S.user && !document.hidden) refresh().catch(() => {}); }, 30000);
})();

VIEWS.dashboard = () => viewDashboard();
VIEWS.loot = () => viewLoot();
function viewVods() {
  const vods = S.vods || [];
  // One folder per player who has posted at least one VOD, labelled with their current class so a coach can
  // tell at a glance who plays what - sorted by name, newest VOD first within each folder.
  const folders = {};
  for (const v of vods) (folders[v.owner] ??= []).push(v);
  const folderList = Object.entries(folders).map(([owner, list]) => ({ owner, list: list.slice().sort((a, b) => b.recordedDate.localeCompare(a.recordedDate) || b.id - a.id) }))
    .sort((a, b) => ownerName(a.owner).localeCompare(ownerName(b.owner)));
  return `
  <div class="page-head"><div><h1>VODs</h1><div class="muted">Post a YouTube link for a coach to review live over Discord, or browse what has been shared with you.</div></div></div>
  <button class="btn primary" style="margin-bottom:16px" data-act="vod-post-open">+ Post a VOD</button>
  ${S.isCoach ? vodScreenshotsFolder() : ''}
  ${folderList.length ? folderList.map((f) => vodFolder(f.owner, f.list)).join('') : '<div class="empty">No VODs yet.</div>'}`;
}
// Kept separate from the VOD folders above, not nested inside them - a screenshot is tied to one VOD, but
// coaches think of "what have I captured lately" as its own list, across whichever players and VODs it came
// from, not something to go digging for one player-folder at a time.
function vodScreenshotsFolder() {
  const shots = (S.screenshots || []).slice().sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  if (!shots.length) return '';
  return `<details class="fold" style="margin-bottom:16px"><summary>Screenshots <span class="muted small">(${shots.length})</span></summary>
    <div class="fold-body vod-shots-grid">${shots.map((s) => `
      <div class="vod-shot-card">
        <a href="#/vods/${s.vodId}"><img src="/uploads/${esc(s.file)}" alt="${esc(s.label)}" loading="lazy"></a>
        <div class="muted small">${esc(s.label)}</div>
        <div class="muted small">${esc(s.takenBy)} · ${fmtShort(s.takenAt)}</div>
        <button type="button" class="btn sm danger" data-act="vod-shot-delete" data-id="${s.id}">Delete</button>
      </div>`).join('')}</div>
  </details>`;
}
ACTIONS['vod-shot-delete'] = (el, d) => { if (confirm('Delete this screenshot?')) act(() => api('/api/vod-screenshots/' + d.id, 'DELETE'), 'Deleted'); };
function vodFolder(owner, list) {
  const m = S.members.find((x) => x.owner === owner && x.active);
  const cls = m ? classFor(m.primaryWeapon, m.secondaryWeapon) : '';
  return `<details class="fold" style="margin-bottom:12px"><summary>${esc(ownerName(owner))}${cls ? ` (${esc(cls)})` : ''} <span class="muted small">(${list.length})</span></summary>
    <div class="fold-body">${list.map((v) => vodRow(v)).join('')}</div>
  </details>`;
}
function vodPostDialog() {
  const coach = S.isCoach, students = S.myStudents || [];
  const postFor = coach ? [{ key: S.user.key, label: 'Myself' }, ...students.map((k) => ({ key: k, label: ownerName(k) }))] : null;
  const defType = S.cfg.vodTypes[0], needsEnemy = S.cfg.vodTypesWithEnemy.includes(defType);
  openDialog(`<form data-form="vod-post"><h2>Post a VOD</h2>
      ${coach ? `<div class="field"><label for="vf-for">For</label><select id="vf-for" name="owner">${postFor.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="vf-url">YouTube link</label><input id="vf-url" name="url" placeholder="https://youtu.be/..." required></div>
      <div class="row">
        <div class="field"><label for="vf-type">Type</label><select id="vf-type" name="type" data-act="vod-type">${opts(S.cfg.vodTypes, defType)}</select></div>
        <div class="field"><label for="vf-date">Date of recording</label><input id="vf-date" name="recordedDate" type="date" required value="${esc(todayTz())}"></div>
      </div>
      <div class="field slidefield ${needsEnemy ? '' : 'off'}" id="vf-enemy-field"><label for="vf-enemy">Enemy guild</label><input id="vf-enemy" name="enemyGuild" maxlength="60"></div>
      <div class="field"><label for="vf-note">Note (optional)</label><textarea id="vf-note" name="note" maxlength="500" placeholder="Anything worth pointing out"></textarea></div>
      <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Post</button></div>
    </form>`);
}
ACTIONS['vod-post-open'] = () => vodPostDialog();
function viewVodReview(id) {
  const v = (S.vods || []).find((x) => x.id === Number(id));
  if (!v) return `<div class="page-head"><h1>VOD not found</h1></div><div class="empty">This VOD may have been deleted, or you may not have access to it.</div>`;
  const visText = v.visibility === 'everyone' ? 'Shared with everyone' : v.visibility === 'class' ? `Shared with ${esc(v.visibleClass)}` : 'Private';
  return `
  <div class="page-head"><div><h1>${esc(v.title)}</h1><div class="muted">${esc(ownerName(v.owner))}${v.note ? ' · ' + esc(v.note) : ''} · ${visText}</div></div>
    <a href="#/vods" class="btn sm">← Back to VODs</a></div>
  <div class="panel">
    <div id="vod-player-wrap" class="vod-player-wrap">
      <div id="vod-yt-player"></div>
      <canvas id="vod-draw-canvas" class="vod-draw-canvas"></canvas>
      <div class="vod-toolbar">
        <span class="vod-colors" id="vod-colors">${['#e2685c', '#e8c468', '#7cc4b8', '#ebe5e3'].map((c, i) => `<button type="button" class="vod-color ${i === 0 ? 'active' : ''}" data-act="vod-color" data-color="${c}" style="background:${c}" aria-label="Draw in this colour"></button>`).join('')}</span>
        <button type="button" class="btn sm" data-act="vod-draw-toggle" id="vod-draw-btn">✏️ Draw</button>
        <button type="button" class="btn sm" data-act="vod-draw-clear">🗑️ Clear</button>
        <button type="button" class="btn sm" data-act="vod-fullscreen" id="vod-fs-btn">⛶ Fullscreen</button>
        ${S.isCoach ? `<button type="button" class="btn sm" data-act="vod-screenshot" data-id="${v.id}" id="vod-shot-btn" disabled title="Go fullscreen first - that is what keeps a screenshot to just the video, never the rest of the page">📸 Screenshot</button>` : ''}
      </div>
    </div>
  </div>`;
}
// A transparent canvas sitting over the player - open to anyone watching, for sketching over the paused video
// while talking it through on Discord voice. Nothing here is saved on its own; it only becomes permanent if a
// coach or officer takes a screenshot (a separate, later control), and otherwise resets whenever the page is
// left or the player is resized (entering/exiting fullscreen), which is fine since it was never meant to last.
let vodDraw = null;   // { ctx, drawing, color }
function setupVodDrawing() {
  const canvas = $('#vod-draw-canvas'), wrap = $('#vod-player-wrap');
  if (!canvas || !wrap) return;
  const resize = () => {
    const r = wrap.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * ratio); canvas.height = Math.round(r.height * ratio);
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 4;
    ctx.strokeStyle = vodDraw ? vodDraw.color : '#e2685c';
    vodDraw = { ctx, drawing: false, color: ctx.strokeStyle };
  };
  resize();
  new ResizeObserver(resize).observe(wrap);
  let lastX = 0, lastY = 0;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { if (!vodDraw) return; vodDraw.drawing = true; [lastX, lastY] = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!vodDraw || !vodDraw.drawing) return;
    const [x, y] = pos(e);
    vodDraw.ctx.beginPath(); vodDraw.ctx.moveTo(lastX, lastY); vodDraw.ctx.lineTo(x, y); vodDraw.ctx.stroke();
    lastX = x; lastY = y;
  });
  const stop = () => { if (vodDraw) vodDraw.drawing = false; };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
}
ACTIONS['vod-draw-toggle'] = (el) => {
  const canvas = $('#vod-draw-canvas'), on = !canvas.classList.contains('active');
  canvas.classList.toggle('active', on);
  el.classList.toggle('primary', on);
  el.textContent = on ? '✏️ Drawing (on)' : '✏️ Draw';
};
ACTIONS['vod-draw-clear'] = () => { if (vodDraw) vodDraw.ctx.clearRect(0, 0, $('#vod-draw-canvas').width, $('#vod-draw-canvas').height); };
ACTIONS['vod-color'] = (el) => {
  if (!vodDraw) return;
  vodDraw.ctx.strokeStyle = el.dataset.color; vodDraw.color = el.dataset.color;
  $('#vod-colors').querySelectorAll('.vod-color').forEach((b) => b.classList.toggle('active', b === el));
};
// Fullscreen is the whole wrap (the player plus its toolbar, not just the YouTube iframe), so whatever gets
// added on top later - the drawing canvas, a screenshot button - comes along into fullscreen with it rather
// than being left behind outside the fullscreened element. It also happens to be exactly what makes a later
// screenshot capture just the video: once this is the only thing on screen, "capture this tab" naturally
// cannot include anything else, with no cropping logic needed.
ACTIONS['vod-fullscreen'] = () => {
  const wrap = $('#vod-player-wrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap.requestFullscreen().catch(() => toast('Your browser blocked fullscreen for this page.', true));
};
document.addEventListener('fullscreenchange', () => {
  const btn = $('#vod-fs-btn'); if (!btn) return;
  btn.textContent = document.fullscreenElement ? '⤢ Exit fullscreen' : '⛶ Fullscreen';
  const shot = $('#vod-shot-btn');
  if (shot) {
    shot.disabled = !document.fullscreenElement;
    shot.title = document.fullscreenElement ? '' : 'Go fullscreen first - that is what keeps a screenshot to just the video, never the rest of the page';
  }
});
// A screenshot is the paused video plus whatever is drawn on it, flattened into one picture - exactly like
// taking a normal OS screenshot would, just without leaving the page. Cross-origin YouTube pixels cannot be
// read onto a canvas directly (the browser blocks that for any site, not just this one), so this instead asks
// for a one-off capture of what is actually on screen via getDisplayMedia - which is also why fullscreen is
// required first: with nothing else rendered, there is nothing else that capture could possibly include.
ACTIONS['vod-screenshot'] = async (el, d) => {
  if (!document.fullscreenElement) return toast('Go fullscreen first.', true);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast('Your browser does not support taking a screenshot this way.', true);
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false }); }
  catch { return; }   // the person cancelled the share picker - not an error, just nothing to do
  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video'); video.srcObject = stream; video.muted = true;
    await video.play();
    await new Promise((r) => { if (video.readyState >= 2) r(); else video.onloadeddata = r; });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    track.stop();   // only ever need the one frame - stop sharing immediately rather than leave the browser's "sharing this tab" indicator up
    const dataUrl = canvas.toDataURL('image/png');
    await act(() => api(`/api/vods/${d.id}/screenshot`, 'POST', { image: dataUrl }), 'Screenshot saved');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
};
// The YouTube IFrame API is loaded once, lazily, the first time a VOD is actually opened - no reason to pull
// in an external script on every page load for guilds that never watch a VOD.
let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return ytApiPromise;
}
let ytPlayer = null;
AFTER_RENDER.push(async (page) => {
  if (page !== 'vods') return;
  const { id } = route();
  if (!id) return;
  const v = (S.vods || []).find((x) => x.id === Number(id));
  const wrap = $('#vod-yt-player');
  if (!v || !wrap) return;
  setupVodDrawing();   // works regardless of whether the YouTube embed itself loads below
  const timedOut = await Promise.race([loadYouTubeApi().then(() => false), new Promise((r) => setTimeout(() => r(true), 10000))]);
  if (!$('#vod-yt-player')) return;    // the page may have been navigated away from while the API was loading
  if (timedOut) { $('#vod-yt-player').outerHTML = '<div class="empty" style="height:100%;display:grid;place-items:center">Could not load the YouTube player. Check your connection and reload.</div>'; return; }
  ytPlayer = new YT.Player('vod-yt-player', { videoId: v.videoId, playerVars: { playsinline: 1, rel: 0 } });
});
function vodRow(v) {
  const visBadge = v.visibility === 'everyone' ? '<span class="type-pill">Everyone</span>' : v.visibility === 'class' ? `<span class="type-pill">${esc(v.visibleClass)}</span>` : '<span class="muted small">Private</span>';
  return `<div class="rule-row" style="align-items:flex-start;flex-wrap:wrap;gap:10px">
    <div style="flex:1;min-width:220px">
      <a href="#/vods/${v.id}" class="plain"><b>${esc(v.title)}</b></a>
      <a href="${esc(v.url)}" target="_blank" rel="noopener" class="muted small" style="margin-left:6px">Open on YouTube ↗</a>
      <div class="muted small">${esc(ownerName(v.owner))}${v.note ? ' · ' + esc(v.note) : ''}</div>
    </div>
    <div style="align-self:center">${visBadge}</div>
    ${v.canPromote ? `<form data-form="vod-vis" data-id="${v.id}" class="seg" style="align-items:center">
      <select name="visibility" data-act="vod-vis">
        <option value="private" ${v.visibility === 'private' ? 'selected' : ''}>Private</option>
        <option value="everyone" ${v.visibility === 'everyone' ? 'selected' : ''}>Everyone</option>
        <option value="class" ${v.visibility === 'class' ? 'selected' : ''}>A class</option>
      </select>
      <select name="visibleClass" id="vv-cls-${v.id}" class="${v.visibility === 'class' ? '' : 'hidden'}">${opts(S.cfg.classes.map((c) => c.name), v.visibleClass)}</select>
      <button class="btn sm">Save</button>
    </form>` : ''}
    ${v.canManage ? `<button class="btn sm danger" data-act="vod-delete" data-id="${v.id}">Delete</button>` : ''}
  </div>`;
}
VIEWS.vods = (id) => id ? viewVodReview(id) : viewVods();
VIEWS.member = () => viewRoster();
VIEWS.parties = () => viewParties();
VIEWS.events = (id) => viewEvents(id);
VIEWS.points = () => viewPoints();
// VIEWS.admin itself is assigned once, in features.js, composing the panel functions above in the agreed order.

/* ================= login notices: cover the whole screen until accepted ================= */
const linkify = (text) => esc(text).replace(/(https?:\/\/[^\s<&"']+(?:&amp;[^\s<&"']+)*)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
function checkNotices() {
  const box = $('#notice');
  if (!box || !S.user) return;
  const pending = (S.notices || []).filter((n) => n.active && !n.accepted).sort((a, b) => a.at.localeCompare(b.at));
  if (!pending.length) { if (box.open) box.close(); checkAlert(); return; }
  const n = pending[0];
  box.innerHTML = `<div class="notice-card">
    <div class="notice-count">${pending.length > 1 ? `Message 1 of ${pending.length}` : 'Important message from the leadership'}</div>
    <h1>${esc(n.title)}</h1><div class="notice-text">${linkify(n.text)}</div>
    <button class="btn primary big" data-act="notice-accept" data-id="${n.id}">I have read this and accept</button></div>`;
  if (!box.open) box.showModal();
  const b = box.querySelector('button'); if (b) b.focus();
}
document.addEventListener('DOMContentLoaded', () => { const box = $('#notice'); if (box) box.addEventListener('cancel', (e) => e.preventDefault()); });   // Escape does not close it
ACTIONS['notice-accept'] = (el, d) => act(() => api(`/api/notices/${d.id}/ack`, 'POST', {}));

// Lucent is an amount, everything else is a named item: the item field slides away and the amount field grows into its place.
CHANGES['vod-type'] = (el) => { $('#vf-enemy-field').classList.toggle('off', !S.cfg.vodTypesWithEnemy.includes(el.value)); };
CHANGES['vod-vis'] = (el) => { const cls = el.closest('form').querySelector('[name=visibleClass]'); cls.classList.toggle('hidden', el.value !== 'class'); };
FORMS['vod-post'] = (f, fd) => act(async () => { await api('/api/vods', 'POST', fd); closeDialog(); }, 'Posted');
FORMS['vod-vis'] = (f, fd, id) => act(() => api(`/api/vods/${id}`, 'PUT', { visibility: fd.visibility, visibleClass: fd.visibleClass }), 'Saved');
ACTIONS['vod-delete'] = (el, d) => { if (confirm('Delete this VOD? This also removes any saved screenshots from it.')) act(() => api('/api/vods/' + d.id, 'DELETE'), 'Deleted'); };
CHANGES['loot-type'] = (el) => {
  const lu = el.value === 'Lucent', item = $('#lf-item-field'), amt = $('#lf-amt-field');
  item.classList.toggle('off', lu); amt.classList.toggle('off', !lu);
  $('#lf-i').required = !lu; $('#lf-a').required = lu;
  if (lu) $('#lf-i').value = ''; else $('#lf-a').value = '';
  UI.lootFormType = el.value;
};
CHANGES['loot-type-edit'] = (el) => {
  const lu = el.value === 'Lucent';
  $('#le-item').classList.toggle('hidden', lu); $('#le-amt').classList.toggle('hidden', !lu);
  $('#le-item input').required = !lu; $('#le-amt input').required = lu;
};

// The attendance pop-up: shown when the server says the player is over a limit and has not explained it yet.
// It covers the screen and only goes away once a reason has been sent to the leadership.
const ALERT_TEXT = {
  noshow: (t, d) => `You said Going but did not show up <b>${t.value}</b> ${t.value === 1 ? 'time' : 'times'} in the last ${d} days (the limit is ${t.limit}).`,
  noreply: (t, d) => `You did not answer <b>${t.value}</b> ${t.value === 1 ? 'event' : 'events'} in the last ${d} days (the limit is ${t.limit}).`,
  attendance: (t, d) => `Your attendance in the last ${d} days is <b>${t.value}%</b> (the minimum is ${t.limit}%).`,
};
function checkAlert() {
  const box = $('#alert');
  if (!box || !S.user) return;
  const a = S.alert, notice = $('#notice');
  if (!a || (notice && notice.open)) { if (box.open && !a) box.close(); return; }
  if (box.open) return;                                                  // do not wipe what the player is typing
  box.innerHTML = `<div class="notice-card">
    <div class="notice-count">Message from the attendance rules</div>
    <h1>Please tell us what happened</h1>
    <ul class="alert-list">${a.triggers.map((t) => `<li>${ALERT_TEXT[t.kind](t, a.windowDays)}</li>`).join('')}</ul>
    ${a.rejected ? `<div class="warn-line">Your last explanation was not accepted${a.rejected.note ? `: ${esc(a.rejected.note)}` : ''}. Please write a new one.</div>` : ''}
    <form data-form="explain"><div class="field"><label for="ex-text">Your reason (the leadership has to approve it)</label><textarea id="ex-text" name="reason" required minlength="5" maxlength="600" style="min-height:120px" placeholder="For example: I was ill and forgot to say Can't."></textarea></div>
      <button class="btn primary big">Send to the leadership for approval</button></form></div>`;
  box.showModal();
  const t = $('#ex-text'); if (t) t.focus();
}
document.addEventListener('DOMContentLoaded', () => { const box = $('#alert'); if (box) box.addEventListener('cancel', (e) => e.preventDefault()); });
FORMS.explain = (f, fd) => act(async () => { await api('/api/explanations', 'POST', fd); $('#alert').close(); }, 'Sent. The leadership will look at it.');
