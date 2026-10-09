'use strict';
/* ================= state & helpers ================= */
const S = { cfg: null, user: null, members: [], events: [], points: [], duties: [], presets: [], loot: [], presetRules: [], users: [], applications: [], application: null, notices: [], leaves: [], warnings: [], explanations: [], alert: null, infoBoard: { title: 'Info', categories: [] }, requests: [], changes: [], profiles: {}, series: [], tags: [], playerTags: {}, prefs: {}, settings: { lootFrom: '', lootThreshold: 60, lootRedMax: 59, lootOrangeMax: 80, lootItemDays: 7, pointsEnabled: true, signupCloseDefault: 30, pinOffsetMinutes: 0, pinWindowDefault: 15, reminderMinutes: [300, 120], remindersEnabled: true, approvals: {}, hiddenSections: [], branding: {}, compliance: {} }, now: Date.now() };
// A phone has no room to spare, so the calendar opens straight to the single day instead of a whole week of
// scrolling - this only picks the starting view; "Week"/"Month" stay one tap away and stick for the rest of
// the session once chosen.
const isMobileViewport = () => window.matchMedia('(max-width: 860px)').matches;
const UI = { vodJump: null, vodRestore: null, lootCompare: [], lootCompareOpen: false, lootCompareQ: '', rosterQ: '', rosterRole: '', rosterWeapon: '', rosterInactive: false, rosterSort: 'name', pointsFocus: null, showPast: false, calView: isMobileViewport() ? 'day' : 'week', calRef: null, presetId: null, lootOnlyOk: false, lootOpen: {}, rulesOpen: false, lootQ: '', lootPlayer: '', lootType: '', lootFormType: '', lootMember: '', lootDate: '' };
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
// RSVP is tapped a lot (it's the main button people hit on their phone), and the result is already known on
// screen before the server even sees it, so we flip it immediately instead of making someone wait out a full
// round trip plus a full state refresh. The server reply is merged in once it arrives (it can differ from the
// guess, e.g. a capped event that just filled up), and a rejection quietly puts the button back.
async function rsvpNow(evId, memberId, status) {
  const e = byId(S.events, evId);
  const prev = e ? e.rsvps[memberId] : undefined;
  if (e) { if (status === 'none') delete e.rsvps[memberId]; else e.rsvps[memberId] = status; render(); }
  try {
    const updated = await api(`/api/events/${evId}/rsvp`, 'POST', { memberId, status });
    if (e) Object.assign(e, updated);
    render();
    refresh(true).catch(() => {});
  } catch (err) {
    if (e) { if (prev === undefined) delete e.rsvps[memberId]; else e.rsvps[memberId] = prev; render(); }
    toast(err.message, true);
  }
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
// Custom weapon icon artwork (the guild's own, supplied directly as images), one small JPEG per weapon
// embedded as a data URI so the whole app stays a single self-contained file with no separate image requests.
const WEAPON_ICONS = {
  'Sword & Shield': 'data:image/jpeg;base64,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',
  'Greatsword': 'data:image/jpeg;base64,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',
  'Spear': 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScdHyIjJSUlFhwpLCgkKyEkJST/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT/wAARCABgAGADASIAAhEBAxEB/8QAHAABAAIDAQEBAAAAAAAAAAAAAQACBAUHBggD/8QAMRAAAQMDAgUCBAUFAAAAAAAAAQACAwQFEQYhBxIxQVEiYRMUMkIVFmKRwSRDcYGh/8QAGAEBAQEBAQAAAAAAAAAAAAAAAQACAwT/xAAgEQEBAAICAgIDAAAAAAAAAAAAAQIRMUEhIgMSUWFx/9oADAMBAAIRAxEAPwD5jUSnC9bzAJwkBKgrjCmFfCE6G1eVBCujCDtTCWsdI4MY0uc4gBoGSSegAWfZbFctR3OC12ijmra2oPLHDEMk+SewA7k7DuvpTR/DGycELIdVak+DdL60BsDWbsilI2jhz1ed8yEbAEjA6neo1J25fQcN4NB2D8xa2pwbg+Ez0Vlf9jRsJajwObAbH3cfVsCFy2eokq5nzynmkkcXvd5JOSuh8WdT3C5vay4S81dcXirqQOkcbciKNo7NG+B7Z7rnICrNXR34WAVkJSwQlACUsoolCUEOPK0nwCVZb3R2jrhrG90tugjEUErsy1MxMcTIx9Xqwd8bADJyRss5XUOM3dPqzhXprSegNIsq6XFNUS0bKm4VlVvJIOQOIBHRoJwGDG+Op3XOdQ6kqtd3992m56a2UfM2jgkO0TerpHfqwMk9th2V+I+qoK57rXT19HTWOjIdJVRzkx1bhs0NJAJa3sADk+rphc21HxIoamxVNotrZ5JpmiL5ks5GiMn1ddySNs4HUreP1wm+27vLx08ZqC8Ov97q7i4EMlfiJp+2MbNH7Af9WAoAlc4LSOqthA2SFpkpUUSEKCoguAG+wUn7UdHUXKrgoqOJ09VUSNiiiZ9T3k4DR7krvl1qqnhJpmj0vQaiuDrpBCfxlnzJbRxBwyYWjAw/fHMDnHucDnGnpKvh1bPx2KqjhvNczlipJqZkgjp+pdKJGnZ22AMHGN+y8vqTUMmoahhBlFO0B/LIdzIR6nE998gE9lXG42XKfxvGyzUOq7kLndpPlqn4tAw89OwdGc4BcOg3zkE+3hagNAVmtwErOuxarhB2KsqlSIVlVKQsFChRQRev0vZqe20DdT3mmjmgDi230kjsfNSj7yMbxtP+Mn2BWFpTTcNwjmvN2LorLROxIRs6pk7Qs9z3PYe5CxdV6imv1dnDImMb8JsMQwyFg6RtHYAdV1wkxn3y46/Yvn1jEvl7q77cJqipndM6R3M95P1n29h2/dYQbhDWgBWXO25XdPHiIhKChAoKSgopGU5QoorLb6b09LqCse0yGnoaZvxayrLctgj/AJJ6AfwCsKz2mrvtxht9EwOllP1O2axo3c9x7NA3JXo9R36itlri09ZAfk4nEyyHrWTdDI79Pgf68rp8eMvtlxGbbxOX4at1Iycw262Rimt9KzkpoG/2293u8vd1yfOfC8uxgaNkN5iS5xLnOOST1JV0Z53O7MmppYKISgIoplBQgVVKENBZtmstx1BXxW+10U1XVSkNayNucZOMk9GjyTsFgldy4c6qfw74Yx1FFWimuN5mmmc9zuVsUIPw2vd7+h3L3zk9tzzbqNT81qtW2226DsjtNUzKCO7xQf193oqp74qwgc5gcHDZ4O2WHBwNtjjkbnumkMkhy4+Og9gtzrC7wXa5tFFM6WljYDu0gGQ/Ud9z237rTDZNy36ziKzvtYJVQU5UysplVyplWwVEZRlSKFEKL//Z',
  'Crossbow': 'data:image/jpeg;base64,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',
  'Daggers': 'data:image/jpeg;base64,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',
  'Staff': 'data:image/jpeg;base64,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',
  'Wand & Tome': 'data:image/jpeg;base64,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',
  'Orb': 'data:image/jpeg;base64,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',
  'Gauntlet': 'data:image/jpeg;base64,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',
  'Longbow': 'data:image/jpeg;base64,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',
};
// One weapon's icon as a small <img>. Falls back to nothing (not a broken image) for a weapon name we have no
// artwork for, so an unmapped or mistyped weapon never blows up a page that tries to render it.
function weaponIcon(name) {
  const src = WEAPON_ICONS[name];
  return src ? `<img class="wicon" src="${src}" alt="${esc(name)}" title="${esc(name)}">` : '';
}
// A character's weapons for a table cell: icons plus the class they resolve to, or just the weapon names side
// by side when the pair does not resolve to a class (same fallback memberRow uses for a party row).
function weaponLine(m) {
  const wpns = [m.primaryWeapon, m.secondaryWeapon].filter(Boolean);
  const icons = wpns.length ? `<span class="wicons">${wpns.map(weaponIcon).join('')}</span>` : '';
  const cls = classFor(m.primaryWeapon, m.secondaryWeapon);
  return `${icons}${cls ? `<span class="cls">${esc(cls)}</span>` : wpns.map((n) => esc(n)).join(' / ')}`;
}
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
// My own outcome for an event, used to colour its whole background in the calendar:
//   grey (default, no data-st at all) - no answer yet, exactly how an event with nothing recorded has always looked
//   green - going (either you said Going, or the leadership already recorded you as having attended)
//   orange - not attending (you said Can't)
//   red - a no-show: you said Going, but were not recorded as attending once the event passed - kept as its own
//   distinct colour since it is a real problem, not just a plain "not coming"
const STATUS_TEXT = { attended: 'You were there', going: 'You are attending', noshow: 'No-show: you said Going but were not recorded', declined: 'You are not attending' };
function myStatus(e) {
  const ids = mine().map((m) => m.id);
  if (!ids.length) return '';
  if (ids.some((id) => e.attended.includes(id))) return 'attended';
  const answers = ids.map((id) => e.rsvps[id]), start = new Date(e.start).getTime();
  const over = start < Date.now() && rolled(e);                              // the leadership recorded who came, so the outcome is known
  if (answers.includes('yes')) return over ? 'noshow' : 'going';
  if (answers.includes('no')) return 'declined';
  return '';                                                                 // no answer at all - stays the plain default colour, whether or not the event has passed
}
// A starting attendance baseline decays away linearly, day by day, from cfg.events (split cfg.pct/100
// attended) at cfg.fromDate down to nothing by cfg.days later - the same math server-side in
// virtualAttendanceFor() (server-compliance.js), kept in sync with it by hand since this is plain display math
// with no round trip, not something worth a server call for.
function virtualAttendanceFor(owner) {
  const c = (S.attendanceStarting || {})[owner];
  if (!c || !c.events || !c.days) return { events: 0, came: 0 };
  const fromMs = Date.parse(c.fromDate + 'T00:00:00Z');
  if (!Number.isFinite(fromMs)) return { events: 0, came: 0 };
  const daysRemaining = Math.max(0, c.days - Math.max(0, (Date.now() - fromMs) / 864e5));
  if (daysRemaining <= 0) return { events: 0, came: 0 };
  const events = (c.events / c.days) * daysRemaining;
  return { events, came: events * (c.pct / 100) };
}
function attendanceStats(id) {
  const recorded = S.events.filter((e) => new Date(e.start) < Date.now() && rolled(e));
  const n = recorded.filter((e) => e.attended.includes(id)).length;
  const owner = (byId(S.members, id) || {}).owner;
  const virtual = virtualAttendanceFor(owner);
  const blendedOf = recorded.length + virtual.events, blendedN = n + virtual.came;
  const pct = blendedOf > 0 ? Math.round(100 * blendedN / blendedOf) : null;
  return { n, of: recorded.length, pct };
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
  // Someone who followed a mercenary-signup or guest-coach-invite link in Discord lands here too, before they
  // have signed in. Send them through a marked version of the same Discord sign-in that is let through even
  // when general guild applications (a different thing) are switched off, and swap the note so it does not
  // say "send us an application" to someone who is not trying to become a guild member at all.
  const merc = /^#\/merc\/\d+$/.test(location.hash);
  const guestCoach = location.hash === '#/guest-coach';
  const dLink = $('#login-discord a.discord'); if (dLink) dLink.href = merc ? '/auth/discord?merc=1' : guestCoach ? '/auth/discord?guestcoach=1' : '/auth/discord';
  const mn = $('#login-merc-note'); if (mn) mn.classList.toggle('hidden', !merc);
  const gn = $('#login-guestcoach-note'); if (gn) gn.classList.toggle('hidden', !guestCoach);
  if (an && (merc || guestCoach)) an.classList.add('hidden');
  // The Discord round trip (this app -> Discord -> /auth/discord/callback -> this app again) is a full page
  // reload through a different path, which drops the #/merc/... or #/guest-coach hash along the way - save it
  // here, before the person leaves for Discord, and start() below restores it once they are actually signed in.
  if (merc || guestCoach) localStorage.setItem('gh_pending_hash', location.hash);
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
  { key: 'guest-coach', label: () => 'My guest coaching' },
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
  if (S.user && S.user.role === 'applicant') return page === 'apply' || page === 'merc' || page === 'guest-coach' || (page === 'vods' && S.isCoach);       // not accepted: only the application, a mercenary signup link they followed, the guest-coach page, or (once they are a guest coach) the VODs they coach
  if (page === 'apply') return false;
  const n = NAV.find((x) => x.key === page);
  if (!n) return page === 'roster';
  if (n.officer) return isOfficer();
  return isOfficer() || !(n.hide && hiddenFromMembers(n.hide));
}
function renderNav(page) {
  // "merc" is the one nav entry that needs an id in its link (which event) - shown at all only once someone
  // actually is a mercenary (S.mercEventId set by applicantState() server-side), not to every applicant.
  // "guest-coach" is similar: shown once someone actually is one (S.isCoach, since the only way an applicant
  // has that is by joining), not to a random applicant who has never touched the invite link.
  $('#nav-links').innerHTML = NAV.filter((n) => canSee(n.key) && (n.key !== 'merc' || S.mercEventId) && (n.key !== 'guest-coach' || (S.user.role === 'applicant' && S.isCoach))).map((n) => {
    const b = n.badge ? n.badge() : 0;
    const href = n.key === 'merc' ? `#/merc/${S.mercEventId}` : `#/${n.key}`;
    return `<a class="nav ${n.key === page ? 'active' : ''} ${n.gap ? 'gap' : ''}" href="${href}" data-nav="${n.key}">${esc(n.label())}${b ? `<span class="count">${b}</span>` : ''}</a>`;
  }).join('');
}
function render() {
  let { page, id } = route();
  if (page === 'roster') page = 'member';
  if (S.user.role === 'applicant' && page !== 'merc' && page !== 'guest-coach' && !(page === 'vods' && S.isCoach)) page = 'apply';
  if (!canSee(page) || !VIEWS[page]) page = 'dashboard';
  applyBranding();
  renderNav(page);
  $('#who').innerHTML = `${avatarImg(S.user)}<b>${esc(S.user.name)}</b>${isOfficer() ? '<span class="badge-officer">Officer</span>' : S.user.role === 'applicant' ? '<span class="badge-officer" style="color:var(--muted);border-color:var(--muted)">Applicant</span>' : ''}`;
  $('#brand-name').textContent = guildName(); $('#brand-tag').textContent = guildTag();
  // Re-rendering the VOD review page while the exact same VOD is already open (a coaching point was just saved
  // or deleted, or the ordinary 30-second background refresh noticed something changed elsewhere) must not tear
  // down and rebuild the YouTube player - see vodPatchReview's own comment for why that silently breaks mobile
  // playback. Anything else (a different page, or a different VOD) renders normally.
  if (page === 'vods' && id && window.__vodReviewId === Number(id) && $('#vod-player-wrap')) {
    vodPatchReview(id);
  } else {
    $('#main').innerHTML = VIEWS[page](id);
    window.__vodReviewId = (page === 'vods' && id) ? Number(id) : null;
    for (const h of AFTER_RENDER) h(page);
  }
  checkNotices();
}
window.addEventListener('hashchange', () => {
  if (!S.user) return;
  render();
  refresh().catch(() => {});                       // pick up changes other people made while you were on another page
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
    // A still-decaying starting-attendance baseline (set in Admin as a migration aid) blends in here too, the
    // same way it does on the Attendance page and the member's own profile (see attendanceStats) - otherwise a
    // guild that just migrated would see everyone's real stats include it everywhere except here.
    const virtual = virtualAttendanceFor(m.owner);
    const blendedOf = mine.length + virtual.events, blendedN = n + virtual.came;
    const pct = blendedOf > 0 ? Math.floor(100 * blendedN / blendedOf) : null;   // rounded down so 59.6% is not shown as 60%
    const disq = isDisqualified(m.owner);
    return { m, n, total: mine.length, pct, disq, onLeave: onLeaveAt(m.owner, Date.now()), ok: pct !== null && pct >= ls.need && !disq, band: pct === null ? 'none' : bandOf(pct, ls), baseline: virtual.events > 0 };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.m.name.localeCompare(b.m.name));
  const okCount = rows.filter((r) => r.ok).length;
  // Picking specific characters to compare (officer only) overrides the plain qualified/everyone toggle - the
  // whole point is to look at a short, hand-picked list side by side (one qualified, one not, say), not to
  // further filter whatever the toggle already shows.
  const compareIds = off ? UI.lootCompare.filter((id) => rows.some((r) => r.m.id === id)) : [];
  const shown = compareIds.length ? rows.filter((r) => compareIds.includes(r.m.id)) : (off && UI.lootOnlyOk ? rows.filter((r) => r.ok) : rows);

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
        <div class="muted small">${r.total ? `Attended ${r.n} of ${r.total} mandatory ${r.total === 1 ? 'event' : 'events'}${r.total < counted.length ? ' (events during a leave of absence are left out)' : ''}.` : 'No mandatory events with recorded attendance yet.'}${r.baseline ? ' The percentage above still includes a decaying starting-attendance baseline (Admin).' : ''}</div>
        ${off ? `<a href="#/loot" class="btn sm primary" data-act="loot-give" data-id="${r.m.id}">Give loot to ${esc(r.m.name)}</a> <button type="button" class="btn sm" data-act="loot-compare-pick" data-id="${r.m.id}">${compareIds.includes(r.m.id) ? 'Remove from compare' : 'Compare'}</button>` : ''}
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
      ${off ? `<button class="btn sm" data-act="loot-all" ${compareIds.length ? 'disabled' : ''}>${UI.lootOnlyOk ? 'Show everyone' : 'Only qualified'}</button>` : ''}
      ${skipped ? `<span class="muted">${skipped} more mandatory ${skipped === 1 ? 'event has' : 'events have'} no attendance recorded yet and ${skipped === 1 ? 'is' : 'are'} not counted.</span>` : ''}
    </div>
    ${off && rows.length ? `<div class="loot-compare-bar">
      <div class="muted small" style="margin-bottom:6px">Search a character and tap it to compare - with two or more picked, the list below becomes just your picks, side by side, regardless of the "only qualified" toggle.</div>
      <input type="search" data-ui="lootCompareQ" value="${esc(UI.lootCompareQ)}" placeholder="Search a character to compare" aria-label="Search a character to compare">
      ${UI.lootCompareQ.trim() ? (() => {
          const q = UI.lootCompareQ.trim().toLowerCase();
          const matches = rows.filter((r) => r.m.name.toLowerCase().includes(q));
          return `<div class="loot-compare-results">${matches.length ? matches.slice(0, 12).map((r) => `<button type="button" class="btn sm ${compareIds.includes(r.m.id) ? 'on' : ''}" data-act="loot-compare-pick" data-id="${r.m.id}">${compareIds.includes(r.m.id) ? '✓ ' : ''}${esc(r.m.name)}${r.ok ? ' <span class="qtag">Qualified</span>' : ''}</button>`).join('') : '<span class="muted small">No character matches.</span>'}</div>`;
        })() : ''}
      ${compareIds.length ? `<div class="muted small" style="margin-top:8px">Comparing ${compareIds.length}: ${compareIds.map((id) => esc(byId(S.members, id).name)).join(', ')} <button class="btn sm" data-act="loot-compare-clear" style="margin-left:6px">Clear</button></div>` : ''}
    </div>` : ''}
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
      <td><b>${esc(m.name)}</b>${m.owner === S.user.key ? '<span class="you">yours</span>' : ''}${onLeave ? '<span class="type-pill" style="margin-left:6px">On leave</span>' : ''}<div class="muted small"><a href="#/profile/${enc(m.owner)}" class="plain">${esc(ownerName(m.owner))}</a></div>${(isOfficer() || (S.myStudents || []).includes(m.owner)) && (m.questlogs || []).length ? `<details class="ql-drop"><summary>Questlog (${m.questlogs.length})</summary><div>${questlogLinks(m, '<br>')}</div></details>` : ''}</td>
      <td>${roleChip(m.role)}</td><td class="wpn">${weaponLine(m)}${(m.builds || []).length ? `<div class="muted small">Also: ${m.builds.map((b) => esc(buildLabel(b))).join(' · ')}</div>` : ''}${m.mode && m.mode !== 'PvE' ? `<span class="type-pill" style="margin-left:6px">${esc(m.mode)}</span>` : ''}</td>
      <td class="num">${m.gearScore || '-'}</td><td class="num">${m.level || '-'}</td>
      <td>${esc(m.rank)}</td><td>${esc(m.discord)}</td>
      ${isOfficer() ? `<td><a href="#/profile/${enc(m.owner)}" class="plain standing-cell">
          ${wn.length ? `<span class="standing-flag warn">⚠ ${wn.length} ${wn.length === 1 ? 'warning' : 'warnings'}</span>` : ''}
          ${a && a.pct !== null ? `<span class="standing-flag ${a.pct < 60 ? 'low' : ''}">${a.pct}% attendance${a.of ? '' : ' (starting)'}</span>` : ''}
          ${!wn.length && !onLeave && (!a || a.pct === null) ? '<span class="muted small">-</span>' : ''}
        </a></td>
        <td class="tagcell">${tagsOf(m.owner).map(tagChip).join('')}<button class="btn sm" data-act="tags-edit" data-key="${esc(m.owner)}" aria-label="Edit tags of ${esc(ownerName(m.owner))}">Tags</button></td>` : ''}
      <td>${canEdit(m) ? `<button class="btn sm" data-act="member-edit" data-id="${m.id}">Edit</button>` : ''}</td>
    </tr>`; }).join('')}</tbody></table></div>`
    : `<div class="empty">No characters match. ${S.members.length ? 'Clear the filters to see everyone.' : 'Add the first one with "Add character".'}</div>`}
  ${isOfficer() ? guestCoachesSection() : ''}
  ${isOfficer() ? mercenariesSection() : ''}`;
}
// Guest class coaches: never guild members, so (like mercenaries below) they never mix into the roster above.
// Sits between the roster and Mercenaries - its own small dropdown-per-row list, not a full table, since there
// is only ever a name and one class to show per person.
function guestCoachesSection() {
  const list = (S.guestCoaches || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const classes = (S.cfg.classes || []).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const link = `${location.origin}/#/guest-coach`;
  return `<details class="fold" data-fold="guest-coaches" ${(UI.fold && UI.fold['guest-coaches']) ? 'open' : ''} style="margin-top:20px;border-top:1px solid var(--line)"><summary>Guest coaches (${list.length})</summary>
    <div class="fold-body">
      <div class="muted small" style="margin-bottom:10px">Someone outside the guild who reviews VODs for one class. Share this link to invite one - it works even if general applications are closed, and does not make them a guild member.</div>
      <div class="link-row" style="margin-bottom:14px"><input readonly value="${esc(link)}" style="flex:1" onclick="this.select()" aria-label="Guest coach invite link"><button class="btn sm" data-act="copy-guestcoach-link" data-link="${esc(link)}">Copy link</button></div>
      ${list.length ? list.map((g) => `<div class="rule-row"><span><b>${esc(g.name)}</b></span>
        <select data-act="guestcoach-class" data-id="${esc(g.discordId)}">${opts(classes, g.class)}</select>
        <button class="btn sm danger" data-act="guestcoach-remove" data-id="${esc(g.discordId)}" data-name="${esc(g.name)}">Remove</button></div>`).join('')
        : '<div class="muted small">No guest coaches yet.</div>'}
    </div>
  </details>`;
}
// Mercenaries never mix into the roster above (not even with "show inactive" ticked) - they get their own
// dropdown here instead, so the regular Member list stays about guild members only.
function mercenariesSection() {
  const mercs = S.members.filter((m) => m.mercenary);
  if (!mercs.length) return '';
  return `<details class="fold" data-fold="mercenaries" ${(UI.fold && UI.fold['mercenaries']) ? 'open' : ''} style="margin-top:20px;border-top:1px solid var(--line)"><summary>Mercenaries (${mercs.length})</summary>
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
      ${!isNew && isOfficer() && S.cfg.authMode === 'discord' ? `<button type="button" class="btn danger left" data-act="member-kick" data-owner="${esc(m.owner)}" data-name="${esc(ownerName(m.owner))}" title="Blocks them from signing in normally again - they are sent to re-apply instead">Kick</button>` : ''}
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

// A small corner badge on top of the background tint - a check for the two "you're in" states, a cross for
// the two "you're not" states, nothing for a plain no-answer (there is nothing to confirm yet). Spelled out as
// its own function since both the month grid and the week list need exactly the same icon for the same status.
const STATUS_ICON = { attended: '✓', going: '✓', noshow: '✕', declined: '✕' };
// The month grid's chips are a single tight row (time + title, no room to spare), so a corner badge there would
// either get clipped or crowd out the title - the background tint alone still shows who's in or out at a
// glance. The fully-detailed week view (see weekCard below) is where the check/cross badge actually belongs.
function monthChip(e, sel, now) {
  const st = myStatus(e);
  return `<a class="cal-ev ${sel && sel.id === e.id ? 'sel' : ''} ${new Date(e.start) < now ? 'past' : ''}" data-st="${st}" href="#/events/${e.id}" style="--c:${typeColor(e.type)}" title="${esc(e.title)}${e.mandatory ? ' (mandatory)' : ''}, ${goingCount(e)} going${st ? '. ' + STATUS_TEXT[st] : ''}">${e.mandatory ? '<i class="mdot"></i>' : ''}<span class="tm">${timeOf(e.start)}</span><span class="ttl">${esc(e.title)}</span></a>`;
}
function weekCard(e, sel, now) {
  const st = myStatus(e), icon = STATUS_ICON[st] || '';
  return `<a class="wk-ev ${sel && sel.id === e.id ? 'sel' : ''} ${new Date(e.start) < now ? 'past' : ''}" data-st="${st}" href="#/events/${e.id}" style="--c:${typeColor(e.type)}" ${st ? `title="${esc(STATUS_TEXT[st])}"` : ''}>
    ${icon ? `<span class="stbadge">${icon}</span>` : ''}
    <span class="top"><span>${timeOf(e.start)}</span>${e.mandatory ? '<i class="mdot" title="Mandatory"></i>' : ''}</span>
    <span class="ttl">${esc(e.title)}</span><span class="sub"><i class="tdot"></i>${esc(e.type)}<br>${goingCount(e)} going</span></a>`;
}
// The day view's whole point is answering without a trip into the event page and a scroll down to "Your
// sign-up" - so every one of your own characters gets its Attend/Not-attend buttons right on the card. The
// title stays a plain link to the full event; the RSVP buttons sit in their own block and stop their click
// from following it (same card, two independent controls).
function dayCard(e, sel, now) {
  const st = myStatus(e), icon = STATUS_ICON[st] || '';
  const closed = Date.now() >= Date.parse(e.signupClosesAt);
  const locked = closed && !isOfficer();
  const my = mine();
  // Quick RSVP right on the card is a phone-only convenience - on a wider screen the event's own sign-up
  // panel is already right there next to the calendar, so these would just be a second, redundant set of
  // buttons cluttering every card for no reason.
  const quickRsvp = isMobileViewport() && my.length && !locked ? `<div class="day-rsvp">${my.map((m) => {
    const s = e.rsvps[m.id] || 'none';
    const b = (val, label) => `<button class="btn sm ${s === val ? 'on' : ''}" data-act="rsvp" data-ev="${e.id}" data-m="${m.id}" data-s="${s === val ? 'none' : val}">${label}</button>`;
    return `<span class="day-rsvp-row">${my.length > 1 ? `<span class="muted small">${esc(m.name)}</span>` : ''}${b('yes', 'Attend')}${b('no', 'Not attend')}</span>`;
  }).join('')}</div>` : '';
  return `<div class="day-card ${sel && sel.id === e.id ? 'sel' : ''} ${new Date(e.start) < now ? 'past' : ''}" data-st="${st}" style="--c:${typeColor(e.type)}">
    <a class="day-head" href="#/events/${e.id}">${icon ? `<span class="stbadge">${icon}</span>` : ''}
      <span class="top"><span>${timeOf(e.start)}</span>${e.mandatory ? '<i class="mdot" title="Mandatory"></i>' : ''}</span>
      <span class="ttl">${esc(e.title)}</span><span class="sub"><i class="tdot"></i>${esc(e.type)} · ${goingCount(e)} going</span></a>${quickRsvp}</div>`;
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
  } else if (view === 'day') {
    title = ref.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
    const todays = byDay[dayKey(ref)] || [];
    body = `<div class="day-list">${todays.length ? todays.map((e) => dayCard(e, sel, now)).join('') : `<div class="empty">Nothing scheduled this day.${isOfficer() ? ' Click "New event" to add one.' : ''}</div>`}</div>`;
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
      <span class="seg"><button class="btn sm ${view === 'day' ? 'on' : ''}" data-act="cal-view" data-v="day">Day</button><button class="btn sm ${view === 'week' ? 'on' : ''}" data-act="cal-view" data-v="week">Week</button><button class="btn sm ${view === 'month' ? 'on' : ''}" data-act="cal-view" data-v="month">Month</button></span>
      <button class="btn sm" data-act="cal-prev" aria-label="Previous">Previous</button>
      <button class="btn sm" data-act="cal-today">Today</button>
      <button class="btn sm" data-act="cal-next" aria-label="Next">Next</button></div>
    ${body}
    <div class="cal-legend">${S.cfg.eventTypes.map((t) => `<span class="chip" style="--c:${typeColor(t.name)}">${esc(t.name)}</span>`).join('')}<span class="small" style="display:inline-flex;align-items:center;gap:7px"><i class="mdot"></i>Mandatory event</span></div>
    <div class="cal-legend status-legend"><span class="muted small">Your events:</span>${['going', 'noshow', 'declined'].map((k) => `<span class="st-key" data-st="${k}"><i></i>${{ going: 'Attending', noshow: 'No-show', declined: 'Not attending' }[k]}</span>`).join('')}</div>
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
  // Active, non-mercenary characters with no answer at all yet - mercenaries are added straight into the
  // roster for one event and never go through RSVP, so they do not belong on either list.
  const noReply = S.members.filter((m) => m.active && !m.mercenary && !(m.id in ev.rsvps));
  const past = new Date(ev.start) < Date.now();
  const closesAt = new Date(ev.signupClosesAt), closed = Date.now() >= closesAt;
  const locked = closed && !isOfficer();                                  // officers can still change answers
  const myRows = mine().map((m) => rsvpRow(ev, m, locked)).join('');
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
    ${noReply.length ? `<p class="small" style="margin-bottom:0"><span class="muted">No reply yet (${noReply.length}):</span> ${noReply.map((m) => esc(m.name)).join(', ')}</p>` : ''}
  </div>

  ${(() => {
    // On a phone, scrolling through every party is the single biggest source of scroll on the whole event page
    // - so there the board starts collapsed and the header gets a plain Show/Hide button for it. On a wider
    // screen the board is the point of this panel, so it still starts open, same as before.
    const key = 'parties-' + ev.id;
    const partiesOpen = (UI.fold && Object.prototype.hasOwnProperty.call(UI.fold, key)) ? UI.fold[key] : !isMobileViewport();
    return `<div class="panel"><div class="ev-title"><h3>Parties</h3>
    <span class="seg">
      <button class="btn sm" data-act="parties-fold" data-id="${ev.id}">${partiesOpen ? 'Hide parties' : 'Show parties'}</button>
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
    ${partiesOpen ? `${partyBuilderNotePanel()}<div style="margin-top:14px">${ev.parties.length || isOfficer() ? board({ kind: 'event', id: ev.id }, ev.parties, ev) : '<div class="muted">No parties posted yet.</div>'}</div>` : `<div class="muted small" style="margin-top:10px">${ev.parties.length ? `${ev.parties.length} ${ev.parties.length === 1 ? 'party' : 'parties'} hidden - tap "Show parties" above to view or edit them.` : `No parties yet.${isOfficer() ? ' Tap "Show parties" above to add one.' : ''}`}</div>`}
  </div>`;
  })()}

  ${isOfficer() ? automationPanel(ev) : ''}
  ${isOfficer() ? attendancePanel(ev, past) : ''}`;
}

// The window on the right of the calendar: the event, my sign-up, and the attendance PIN.
function eventSide(ev) {
  const past = new Date(ev.start) < Date.now();
  const closesAt = new Date(ev.signupClosesAt), closed = Date.now() >= closesAt;
  const locked = closed && !isOfficer();                                  // officers can still change answers
  const myRows = mine().map((m) => rsvpRow(ev, m, locked)).join('');
  // Every other active character, not just the ones who have not answered yet - an officer changing someone's
  // answer (told in Discord they can no longer make it, say) needs to be able to pick them here too, not only
  // the still-unanswered ones.
  const others = isOfficer() ? S.members.filter((m) => m.active && m.owner !== S.user.key) : [];
  const otherStatus = (m) => (ev.rsvps[m.id] === 'yes' ? ' - attending' : ev.rsvps[m.id] === 'no' ? " - can't make it" : ' - no answer yet');
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
    ${others.length ? `<div class="rsvp-row"><select id="other-char" style="max-width:230px" aria-label="Change another character's sign-up">${others.map((m) => `<option value="${m.id}">${esc(m.name)} (${esc(ownerName(m.owner))})${otherStatus(m)}</option>`).join('')}</select>
      <span class="seg"><button class="btn sm" data-act="rsvp-other" data-s="yes" data-ev="${ev.id}">Attend</button><button class="btn sm" data-act="rsvp-other" data-s="no" data-ev="${ev.id}">Not attend</button><button class="btn sm" data-act="rsvp-other" data-s="none" data-ev="${ev.id}">Clear</button></span></div>` : ''}
    ${pinSide(ev)}
  </div>`;
}

// Where the attendance PIN stands for this event: not activated yet, open, too late, or not used.
function pinState(ev) {
  const info = ev.pinInfo || { state: 'pending' };
  if (info.state === 'open') return 'open';
  if (info.state === 'closed') return 'late';
  // Know in advance there is no PIN coming (switched off for this event, or skipped for an old one) rather than
  // waiting for the scheduled time to pass before saying so.
  if (ev.pinSkip || info.enabled === false) return 'none';
  const around = new Date(info.scheduledAt).getTime();
  return Date.now() > around + (info.windowMinutes || 15) * 60000 ? 'none' : 'early';
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
  // The officer's two reminder buttons live right here, under the PIN box, rather than further down the page
  // (in "PIN and reminders") - this card is the first thing you see on a phone after opening an event, so
  // nudging stragglers no longer needs a scroll past parties and the whole PIN panel first.
  const upcoming = new Date(ev.start) > new Date();
  const sameDay = upcoming ? S.events.filter((e) => wallKey(new Date(e.start).getTime()) === wallKey(new Date(ev.start).getTime()) && new Date(e.start) > Date.now()) : [];
  const reminderBtns = isOfficer() && upcoming ? `<div class="seg" style="margin-top:10px">
      <button class="btn sm" data-act="reminder-send" data-id="${ev.id}">Send reminder now</button>
      ${sameDay.length > 1 ? `<button class="btn sm" data-act="reminder-send-day" data-id="${ev.id}" title="Sends a reminder for every one of today's events that has not started yet">Send reminders for all of today's events (${sameDay.length})</button>` : ''}
    </div>` : '';
  return `<div class="pin-box" data-pin="${kind}"><h3 class="side-h">Attendance PIN <span class="st-pill ${badge[1]}">${badge[0]}</span></h3>
    <div class="muted small" style="margin:-2px 0 8px">${text}</div>${own.length ? rows : '<div class="muted small">Add a character to check in with the PIN.</div>'}${reminderBtns}</div>`;
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
      <span class="seg"><button class="btn sm" data-act="pin-send" data-mode="send" data-id="${ev.id}">${pin ? 'Send the PIN again' : 'Create and send PIN now'}</button>${pin ? `<button class="btn sm" data-act="pin-send" data-mode="new" data-id="${ev.id}">New PIN</button>` : ''}${pin && info.state === 'closed' ? `<button class="btn sm" data-act="pin-send" data-mode="reopen" data-id="${ev.id}" title="Keeps the same code, just gives it a fresh window">Reopen window</button>` : ''}</span></div>
    ${pin ? `<div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin:6px 0 4px"><div class="pin-code" aria-label="PIN">${esc(pin.code)}</div>
        <div class="small muted">Created ${fmtShort(pin.at)} (${esc(pin.by)}).<br>Players can enter it until ${fmtTime(info.closesAt)}. ${info.state === 'open' ? '<span class="ok-text">Open now.</span>' : 'Closed.'}<br>${entered} ${entered === 1 ? 'character has' : 'characters have'} entered it.</div></div>
      <ul class="sent">${(pin.sent || []).map((r) => `<li class="${r.ok ? 'yes' : 'fail'}">${r.ok ? 'Sent to' : 'Not delivered to'} <b>${esc(r.name)}</b> <span class="muted">(${esc(r.why)})</span>${r.ok ? '' : ` - ${esc(r.error)}`}</li>`).join('') || '<li class="muted">Nobody to send it to yet.</li>'}</ul>`
      : ev.pinEnabled
        ? `<div class="muted small">It will be created ${st.pinOffsetMinutes === 0 ? 'when the event starts' : `${Math.abs(st.pinOffsetMinutes)} minutes ${st.pinOffsetMinutes > 0 ? 'after the start' : 'before the start'}`} (around ${fmtTime(info.scheduledAt)}) and sent by Discord to the party leaders and the leadership. Change this in Admin.</div>`
        : `<div class="muted small">The PIN is switched off for this event (see "Attendance PIN" below) - nothing is sent automatically, but you can still create and send one by hand with the button above.</div>`}
    <div class="small" style="margin-top:12px">
      <div class="ev-title"><span class="muted">Reminders for players who have not answered.</span></div>
      <div class="muted" style="margin-top:2px">${!st.remindersEnabled ? 'Automatic reminders are switched off in Admin' : ev.reminders === false ? 'Automatic reminders are off for this event' : `Automatic: ${st.reminderMinutes.length ? st.reminderMinutes.map(hrs).join(' and ') + ' before the start' : 'none set'}`}. <span class="muted">(The "Send reminder now" button moved up to the event card above.)</span></div>
      ${(ev.reminderLog || []).map((l) => `<div class="muted">Reminder ${l.manual ? `(sent by ${esc(l.by)})` : l.number}: ${l.sent} delivered${l.failed.length ? `, ${l.failed.length} not delivered (${l.failed.map((f) => esc(f.name)).join(', ')})` : ''} at ${fmtTime(l.at)}.</div>`).join('')}</div>
  </div>`;
}

function rsvpRow(ev, m, locked) {
  const s = ev.rsvps[m.id] || 'none';
  const b = (val, label) => `<button class="btn sm ${s === val ? 'on' : ''}" ${locked ? 'disabled' : ''} data-act="rsvp" data-ev="${ev.id}" data-m="${m.id}" data-s="${s === val ? 'none' : val}">${label}</button>`;
  return `<div class="rsvp-row"><span><b>${esc(m.name)}</b> ${roleChip(m.role)}${s === 'none' ? ' <span class="muted small">no answer yet</span>' : ''}</span><span class="seg">${b('yes', 'Attend')}${b('no', 'Not attend')}</span></div>`;
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

// One member row. Shows role colour, party-leader crown, class (with its weapon icons), and - on its own line
// below, so a long one has room to actually be read instead of getting crushed into "Class | Spec..." - the
// specialization.
function memberRow(m, at, o) {
  const off = isOfficer();
  const eff = effectiveBuild(m, o.from === 'party' ? (o.parties || [])[o.i] : null);     // the class this player plays in this party
  const cls = classFor(eff.primaryWeapon, eff.secondaryWeapon);
  const wpns = [eff.primaryWeapon, eff.secondaryWeapon].filter(Boolean);
  const icons = wpns.length ? `<span class="wicons">${wpns.map(weaponIcon).join('')}</span>` : '';
  // Already-safe HTML either way (weapon names, the class and the specialization are all escaped here), so the
  // render below must not escape this a second time - that would show the icon markup as literal text.
  const meta = `${icons}${cls ? `<span class="cls">${esc(cls)}</span>` : wpns.map((n) => esc(n)).join(' / ')}`;
  const spec = eff.specialization ? `<div class="mspec spec">${esc(eff.specialization)}</div>` : '';
  const tag = o.ev && o.from === 'pool' ? (o.ev.rsvps[m.id] === 'yes' ? 'going' : '') : '';
  return `<div class="mrow ${o.dim ? 'not-attending' : ''}" ${off ? 'draggable="true" data-drag="member"' : ''} data-m="${m.id}" data-from="${o.from}" style="--c:${roleColor(eff.role)}" title="${esc(m.name)}: ${esc([eff.primaryWeapon, eff.secondaryWeapon].filter(Boolean).join(' / '))}${eff.gearScore ? ', GS ' + eff.gearScore : ''}${o.dim ? ' (not confirmed for this event)' : ''}">
    ${off ? '<span class="grip" aria-hidden="true"></span>' : ''}${o.from === 'party' && o.leader === m.id ? CROWN : ''}
    <div class="mtxt"><div class="mname">${esc(m.name)}${m.mercenary ? '<span class="tag merc" title="Not a guild member - helping for this event only">Merc</span>' : ''}${eff.isBuild ? `<span class="tag build">${esc(eff.label)}</span>` : ''}${tag ? `<span class="tag">${tag}</span>` : ''}</div><div class="mmeta">${meta || '&nbsp;'}</div>${spec}</div>
    ${off ? memberMenu(m, at, o) : ''}</div>`;
}

function partyCard(ctx, parties, p, i, ev) {
  const off = isOfficer();
  const at = `data-kind="${ctx.kind}" data-owner="${ctx.id}" data-i="${i}"`;
  const ms = p.members.map((id) => byId(S.members, id)).filter(Boolean);
  const size = S.cfg.partySize;
  // A preset carries whoever was in the line-up when it was saved, not whoever actually said Going for THIS
  // event - so once loaded into an event, anyone in the party who has not confirmed attending (and is not a
  // mercenary, who was placed here deliberately rather than loaded from a saved line-up) is shown separately,
  // dimmed, at the bottom of their own party - still visibly part of the plan, but clearly not confirmed.
  const notAttending = ev ? ms.filter((m) => !m.mercenary && ev.rsvps[m.id] !== 'yes') : [];
  const attending = ev ? ms.filter((m) => m.mercenary || ev.rsvps[m.id] === 'yes') : ms;
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
      ${attending.map((m) => memberRow(m, at, { from: 'party', i, leader: p.leader, parties, ev })).join('') || (notAttending.length ? '' : `<div class="pempty">${off ? 'Drop members here' : 'Empty'}</div>`)}
      ${notAttending.length ? `<div class="pnotattending"><div class="muted small">Not confirmed for this event</div>
        ${notAttending.map((m) => memberRow(m, at, { from: 'party', i, leader: p.leader, parties, ev, dim: true })).join('')}</div>` : ''}
    </div></div>`;
}

// Officers get role lists on the left (drag from there, or back to it to unassign) and the party grid on the right.
// One shared scratchpad for whoever is building parties - the same note on the Presets page and on every
// event's board, synced through the normal state refresh since it is just one more field in /api/state.
// Officer-only: the server never even sends its content to anyone else, not just hides it here.
function partyBuilderNotePanel() {
  if (!isOfficer()) return '';
  return `<details class="panel fold" style="margin-bottom:16px" data-fold="party-note" ${(UI.fold && UI.fold['party-note']) ? 'open' : ''}>
    <summary>Notes for whoever is building parties <span class="muted small">(officers only, shared everywhere parties are built)</span></summary>
    <textarea data-act="party-note-save" rows="3" maxlength="2000" placeholder="Anything worth remembering while building parties - who's away, who needs a specific role, reminders for next time...">${esc(S.partyBuilderNote || '')}</textarea>
  </details>`;
}
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
    ${partyBuilderNotePanel()}
    <div class="boardwrap">${board({ kind: 'preset', id: p.id }, p.parties, null)}</div>`
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
  ev = ev || { title: '', type: S.cfg.eventTypes[0].name, start: startIso, description: '', points: S.cfg.eventTypes[0].points, mandatory: !!S.cfg.eventTypes[0].mandatory, pinEnabled: !!S.cfg.eventTypes[0].mandatory, maxSignups: 0 };
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
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:8px"><input type="checkbox" name="mandatory" id="ev-mand" ${ev.mandatory ? 'checked' : ''}> Mandatory event (counts toward "Qualified for loot")</label>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:12px"><input type="checkbox" name="pinEnabled" id="ev-pin" ${(ev.pinEnabled ?? ev.mandatory) ? 'checked' : ''}> Attendance PIN for this event (on by default for a mandatory event, off for an optional one - switch it either way here)</label>
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
  </div>
  <div class="muted small" style="margin:8px 2px 0">Version: ${esc(S.cfg.version || '?')} powered by Freki</div>`;
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
  else if (a === 'member-kick') {
    if (!confirm(`Kick ${d.name}? They will not be able to sign in normally again - they will be sent to a page to re-apply, which an officer has to accept. Their history (loot, points, attendance) is kept; their character is just marked inactive.`)) return;
    const reason = prompt('Reason (optional, kept for your own records)', '') || '';
    act(async () => { await api('/api/admin/kick', 'POST', { ownerKey: d.owner, reason }); closeDialog(); }, `${d.name} kicked`);
  }
  else if (a === 'copy-guestcoach-link') {
    navigator.clipboard?.writeText(d.link).then(() => toast('Link copied')).catch(() => toast('Could not copy - select and copy the link by hand'));
  }
  else if (a === 'guestcoach-remove') {
    if (confirm(`Remove ${d.name} as a guest coach? They lose VOD access immediately and can no longer sign in at all.`)) act(() => api(`/api/guest-coaches/${d.id}`, 'DELETE'), 'Removed');
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
  else if (a === 'rsvp') rsvpNow(d.ev, d.m, d.s);
  else if (a === 'rsvp-other') rsvpNow(d.ev, $('#other-char').value, d.s);
  else if (a === 'parties-build') {
    const e2 = ev(); if (e2.parties.length && !confirm('Replace the current parties?')) return;
    const p = autoParties(e2);
    if (!p.length) return toast('Nobody has signed up as Going yet.', true);
    p.forEach((q, i) => { if (e2.parties[i]) q.name = e2.parties[i].name; }); // keep names you already chose
    act(() => api(`/api/events/${e2.id}/parties`, 'POST', { parties: p }), 'Parties built');
  }
  else if (a === 'parties-fold') {
    const key = 'parties-' + d.id;
    const was = (UI.fold && Object.prototype.hasOwnProperty.call(UI.fold, key)) ? UI.fold[key] : !isMobileViewport();
    (UI.fold = UI.fold || {})[key] = !was;
    render();
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
    const t = UI.calView === 'month' ? new Date(r.getFullYear(), r.getMonth() + dir, 1) : UI.calView === 'day' ? new Date(r.getFullYear(), r.getMonth(), r.getDate() + dir) : new Date(r.getFullYear(), r.getMonth(), r.getDate() + 7 * dir);
    UI.calRef = dayRef(t.getFullYear(), t.getMonth() + 1, t.getDate());
    render();
  }
  else if (a === 'cal-today') { UI.calRef = null; render(); }
  else if (a === 'cal-view') { UI.calView = d.v; render(); }
  else if (a === 'cal-week') { UI.calView = 'week'; UI.calRef = Date.parse(tzToIso(d.date + 'T12:00')); render(); }
  else if (a === 'loot-today') act(() => api('/api/settings', 'PUT', { lootFrom: '' }), 'Counting back from today');
  else if (a === 'loot-all') { UI.lootOnlyOk = !UI.lootOnlyOk; render(); }
  else if (a === 'loot-compare-clear') { UI.lootCompare = []; render(); }
  else if (a === 'loot-compare-pick') {
    const id = Number(d.id);
    UI.lootCompare = UI.lootCompare.includes(id) ? UI.lootCompare.filter((x) => x !== id) : [...UI.lootCompare, id];
    render();
  }
  else if (a === 'loot-give') { UI.lootMember = d.id; }
  else if (a === 'test-dm') act(async () => { const r = await api('/api/admin/test-dm', 'POST', {}); if (!r.ok) throw new Error(r.error || 'The message could not be sent.'); toast('Test message sent. Check your Discord messages.'); });
  else if (a === 'link-owner') act(async () => { const r = await api('/api/admin/link-owner', 'POST', { from: d.from, to: $('#lk-' + d.i).value }); toast(`${r.moved} characters linked`); });
  else if (a === 'pin-send') act(() => api(`/api/events/${d.id}/pin/send`, 'POST', { mode: d.mode }), d.mode === 'new' ? 'New PIN created and sent' : d.mode === 'reopen' ? 'PIN window reopened' : 'PIN sent');
  else if (a === 'reminder-send') act(() => api(`/api/events/${d.id}/reminders/send`, 'POST', {}), 'Reminder sent');
  else if (a === 'reminder-send-day') {
    const ev = byId(S.events, d.id);
    const ids = S.events.filter((e) => wallKey(new Date(e.start).getTime()) === wallKey(new Date(ev.start).getTime()) && new Date(e.start) > Date.now()).map((e) => e.id);
    act(() => api('/api/events/reminders/send-many', 'POST', { ids }), `Reminders sent for ${ids.length} events`);
  }
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
  else if (el.dataset.act === 'party-note-save') act(() => api('/api/party-builder-note', 'PUT', { note: el.value }));
  else if (el.dataset.act === 'guestcoach-class') act(() => api(`/api/guest-coaches/${el.dataset.id}/class`, 'PUT', { class: el.value }), 'Updated');
  else if (el.name === 'primaryWeapon' || el.name === 'secondaryWeapon') {
    const f = el.form, c = classFor(f.elements.primaryWeapon.value, f.elements.secondaryWeapon.value);
    $('#class-preview').textContent = classPreviewText(f.elements.primaryWeapon.value, f.elements.secondaryWeapon.value);
  }
  else if (el.dataset.act === 'import') {
    const f = el.files[0]; if (!f) return;
    if (!confirm('Restoring replaces ALL current data with the contents of this file. Continue?')) { el.value = ''; return; }
    f.text().then((t) => act(() => api('/api/import', 'POST', JSON.parse(t)), 'Backup restored')).catch(() => toast('That file could not be read.', true));
  }
  else if (el.id === 'ev-type') {
    if ($('#ev-pts')) $('#ev-pts').value = el.selectedOptions[0].dataset.pts;
    $('#ev-mand').checked = el.selectedOptions[0].dataset.mand === '1';
    if ($('#ev-pin')) $('#ev-pin').checked = $('#ev-mand').checked;   // follows the type's default too, same as Mandatory - still a separate switch from here
  }
});
document.addEventListener('input', (e) => {
  const k = e.target.dataset.ui;
  if (k === 'rosterQ' || k === 'lootQ' || k === 'lootCompareQ') {
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
    fd.pinEnabled = f.elements.pinEnabled.checked;
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
// A player's current class, the same way everywhere else in the app resolves it (their active character's two
// weapons) - a VOD's class folder is therefore whatever its owner currently plays, not whatever they played
// when it was posted. Someone who has respecced moves to their new class folder automatically, the same way
// they move in and out of a coach's roster elsewhere.
function classOfOwner(owner) {
  const m = S.members.find((x) => x.owner === owner && x.active);
  return m ? classFor(m.primaryWeapon, m.secondaryWeapon) : '';
}
// A VOD's own ownerClass/ownerName (set server-side, in coachingState) is always preferred over looking the
// owner up in S.members/S.users - those lists are empty for a guest coach (an applicant, never a member), who
// would otherwise see every VOD land in "Other" with no name at all. Falling back to the old lookup keeps this
// working exactly as before for everyone else, in case either field is ever missing.
const vodOwnerClass = (v) => v.ownerClass || classOfOwner(v.owner) || '';
const vodOwnerName = (v) => v.ownerName || ownerName(v.owner);
function viewVods() {
  const vods = S.vods || [];
  // Folders are class-first - the first thing anyone sees on this page - because that is how a coach actually
  // goes looking for footage ("show me Oracle VODs"), not by hunting through every player one at a time. A
  // class folder exists only once a VOD from someone currently playing it actually exists; it is never created
  // or managed by hand. Players with no resolvable class (an unmapped weapon pair, or no active character at
  // all) land in one "Other" folder rather than being silently dropped. A spectator/overview recording is not
  // really about whoever posted it at all - marking it as such (see the posting form) pulls it out of the
  // class grouping entirely into its own folder, shown first since it tends to be what a coach checks for
  // whole-fight analysis before drilling into any one player's own view.
  const spectatorVods = vods.filter((v) => v.spectator);
  const byClass = {};
  for (const v of vods) { if (v.spectator) continue; const cls = vodOwnerClass(v) || 'Other'; (byClass[cls] ??= []).push(v); }
  const classFolders = Object.entries(byClass).sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  return `
  <div class="page-head"><div><h1>VODs</h1><div class="muted">Post a YouTube link for a coach to review live over Discord, or browse what has been shared with you.</div></div></div>
  <button class="btn primary" style="margin-bottom:16px" data-act="vod-post-open">+ Post a VOD</button>
  ${spectatorVods.length ? vodClassFolder('Spectator PoV', spectatorVods, '🎥') : ''}
  ${classFolders.length ? classFolders.map(([cls, list]) => vodClassFolder(cls, list)).join('') : (spectatorVods.length ? '' : '<div class="empty">No VODs yet.</div>')}`;
}
function vodClassFolder(label, vods, fixedIcon) {
  const classDef = !fixedIcon && (S.cfg.classes || []).find((c) => c.name === label);
  const icons = fixedIcon ? `<span class="wicons" style="font-size:18px">${fixedIcon}</span>` : classDef ? `<span class="wicons">${classDef.weapons.map(weaponIcon).join('')}</span>` : '';
  const byOwner = {};
  for (const v of vods) (byOwner[v.owner] ??= []).push(v);
  const ownerFolders = Object.entries(byOwner).map(([owner, list]) => ({ owner, list: list.slice().sort((a, b) => b.recordedDate.localeCompare(a.recordedDate) || b.id - a.id) }))
    .sort((a, b) => vodOwnerName(a.list[0]).localeCompare(vodOwnerName(b.list[0])));
  return `<details class="fold" style="margin-bottom:12px"><summary>${icons}${esc(label)} <span class="muted small">(${vods.length})</span></summary>
    <div class="fold-body">${ownerFolders.map((f) => vodFolder(f.owner, f.list)).join('')}</div>
  </details>`;
}
function vodFolder(owner, list) {
  return `<details class="fold vod-player-fold" style="margin-bottom:10px"><summary>${esc(vodOwnerName(list[0]))} <span class="muted small">(${list.length})</span></summary>
    <div class="fold-body">${list.map((v) => vodRow(v)).join('')}</div>
  </details>`;
}
function vodPostDialog() {
  const coach = S.isCoach, students = S.myStudents || [], studentNames = S.myStudentNames || {};
  const postFor = coach ? [{ key: S.user.key, label: 'Myself' }, ...students.map((k) => ({ key: k, label: studentNames[k] || ownerName(k) }))] : null;
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
      <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:12px"><input type="checkbox" name="spectator" id="vf-spectator"> Spectator/overview recording (not one player's own view - goes in its own folder, not a class folder)</label>
      <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Post</button></div>
    </form>`);
}
ACTIONS['vod-post-open'] = () => vodPostDialog();
function fmtVodTimestamp(seconds) {
  const n = Math.max(0, Number(seconds) || 0), total = Math.floor(n);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
// Just the "Coaching points" list - pulled out of viewVodReview so it can also be redrawn on its own (see
// vodPatchReview below), without touching the player/iframe next to it.
function vodMarkerPanelHtml(v) {
  const markers = Array.isArray(v.markers) ? v.markers : [];
  return `<h3 style="margin-top:0">Coaching points <span class="muted small">(${markers.length})</span></h3>
      ${markers.length ? `<div class="vod-marker-list">${markers.map((m) => `<div class="vod-marker" data-marker-row="${m.id}">
        <button type="button" class="vod-marker-jump" data-act="vod-marker-jump" data-marker-id="${m.id}" title="Jump to ${fmtVodTimestamp(m.timestamp)}">
          <span class="vod-marker-time">${fmtVodTimestamp(m.timestamp)} <span class="muted small" style="font-weight:400">${esc(m.createdByName || m.createdBy)}</span></span><span class="vod-marker-note">${esc(m.note)}</span>
        </button>
        ${v.canManage ? `<button type="button" class="btn sm danger" data-act="vod-marker-delete" data-marker-id="${m.id}">Delete</button>` : ''}
      </div>`).join('')}</div>` : '<div class="empty">No coaching points yet.</div>'}`;
}
function vodReviewSubtitle(v) {
  const visText = v.visibility === 'everyone' ? 'Shared with everyone' : v.visibility === 'class' ? `Shared with ${esc(v.visibleClass)}` : 'Private';
  return `${esc(vodOwnerName(v))}${v.note ? ' · ' + esc(v.note) : ''} · ${visText}`;
}
// A small checkmark next to the title wherever the VOD is listed or opened - driven by the coach's own
// "Mark as finished" toggle (see vodReviewsPanelHtml), not by whether a review note has been written: writing
// one is not the same thing as being done with the VOD, and this badge should only mean the latter.
function vodReviewedBadge(v) { return v.finished ? '<span class="vod-reviewed-badge" title="Marked as finished">✓</span>' : ''; }
function vodReviewEntryHtml(v, r) {
  return `<div class="vod-review-entry">
    <div class="vod-review-entry-head"><b>${esc(r.byName)}</b> <span class="muted small">${esc(fmtShort(r.at))}${r.editedAt ? ' · edited' : ''}</span></div>
    <div class="vod-review-entry-note">${esc(r.note)}</div>
    ${r.canEdit ? `<div class="link-row" style="margin-top:4px">
      <button type="button" class="btn sm" data-act="vod-review-edit" data-vod-id="${v.id}" data-review-id="${r.id}">Edit</button>
      <button type="button" class="btn sm" data-act="vod-review-resend" data-vod-id="${v.id}" data-review-id="${r.id}">Resend</button>
    </div>` : ''}
  </div>`;
}
// Pulled out of viewVodReview, same as vodMarkerPanelHtml, so it can be patched in place on its own (see
// vodPatchReview). Not offered at all on a spectator recording - that is not really any one player's review to
// finish (see canReviewVod server-side).
function vodReviewsPanelHtml(v) {
  if (v.spectator) return '';
  const reviews = Array.isArray(v.reviews) ? v.reviews : [];
  return `<h3 style="margin-top:0">Review${vodReviewedBadge(v)}</h3>
    ${reviews.length ? `<div class="vod-review-list">${reviews.map((r) => vodReviewEntryHtml(v, r)).join('')}</div>` : '<div class="empty">Not reviewed yet.</div>'}
    ${v.canReview ? `<div class="seg" style="margin-top:10px;flex-wrap:wrap">
      <button type="button" class="btn sm primary" data-act="vod-review-open" data-id="${v.id}">${reviews.length ? 'Add review' : 'Write a review'}</button>
      <button type="button" class="btn sm" data-act="vod-finish-toggle" data-id="${v.id}" data-finished="${v.finished ? '1' : '0'}" title="${v.finished ? 'Undo this if it was ticked by mistake' : 'Marks this VOD done in the folder'}">${v.finished ? 'Unmark as finished' : 'Mark as finished'}</button>
    </div>` : ''}`;
}
function viewVodReview(id) {
  const v = (S.vods || []).find((x) => x.id === Number(id));
  if (!v) return `<div class="page-head"><h1>VOD not found</h1></div><div class="empty">This VOD may have been deleted, or you may not have access to it.</div>`;
  return `
  <div class="page-head"><div><h1 id="vod-review-title">${esc(v.title)}${vodReviewedBadge(v)}</h1><div class="muted" id="vod-review-sub">${vodReviewSubtitle(v)}</div></div>
    <a href="#/vods" class="btn sm">← Back to VODs</a></div>
  <div class="vod-review-grid">
    <div class="panel">
      <div id="vod-player-wrap" class="vod-player-wrap">
        <div id="vod-yt-player"></div>
        <canvas id="vod-draw-canvas" class="vod-draw-canvas"></canvas>
        <div class="vod-toolbar">
          <span class="vod-colors" id="vod-colors">${['#e2685c', '#e8c468', '#7cc4b8', '#ebe5e3'].map((c, i) => `<button type="button" class="vod-color ${i === 0 ? 'active' : ''}" data-act="vod-color" data-color="${c}" style="background:${c}" aria-label="Draw in this colour"></button>`).join('')}</span>
          <button type="button" class="btn sm" data-act="vod-draw-toggle" id="vod-draw-btn">✏️ Draw</button>
          <button type="button" class="btn sm" data-act="vod-draw-clear">🗑️ Clear</button>
          <button type="button" class="btn sm" data-act="vod-fullscreen" id="vod-fs-btn">⛶ Fullscreen</button>
        </div>
      </div>
      ${v.canManage ? `<form data-form="vod-marker" class="panel" style="margin-top:12px">
        <h3 style="margin-top:0">Save coaching point</h3>
        <div class="muted small" style="margin:-4px 0 10px">Saved at the video's current position. Draw on the video first if you want a marking attached - otherwise this saves as a plain timestamped note.</div>
        <div class="row">
          <div class="field"><label for="vm-before">Show marking before (seconds)</label><input id="vm-before" name="beforeSeconds" type="number" min="0" max="10" step="0.5" value="2"></div>
          <div class="field"><label for="vm-after">Show marking after (seconds)</label><input id="vm-after" name="afterSeconds" type="number" min="0" max="10" step="0.5" value="2"></div>
        </div>
        <div class="field"><label for="vm-note">Note</label><textarea id="vm-note" name="note" maxlength="500" placeholder="What should the player notice here?" required></textarea></div>
        <div class="link-row"><span class="muted small" id="vod-current-time">Current position: 0:00</span><button class="btn primary">Save coaching point</button></div>
      </form>` : ''}
      ${vodReviewsPanelHtml(v) ? `<div class="panel vod-review-panel" style="margin-top:12px">${vodReviewsPanelHtml(v)}</div>` : ''}
    </div>
    <div class="panel vod-marker-panel">${vodMarkerPanelHtml(v)}</div>
  </div>`;
}
// Re-render while the SAME VOD review page is already open updates just the header text and the coaching-point
// list, in place - leaving the player wrap (iframe, canvas, toolbar) completely alone. This is what actually
// fixes the mobile "save a coaching point -> black screen -> nothing works after that" bug: the earlier fix
// (seeking more carefully) only treated a symptom. The real cause is that a normal re-render replaces the whole
// page's HTML, which destroys and recreates the YouTube iframe - and on a phone, a freshly created iframe has
// never been directly tapped by the viewer, so the browser's autoplay rules silently block every later seek or
// play on it (no error, just a permanently stuck black frame) until the page is fully reloaded. Not touching the
// iframe at all when nothing about which VOD is open has actually changed avoids the problem entirely, for a
// saved/deleted coaching point and for the normal 30-second background refresh alike.
function vodPatchReview(id) {
  const v = (S.vods || []).find((x) => x.id === Number(id));
  if (!v) { $('#main').innerHTML = VIEWS['vods'](id); window.__vodReviewId = null; for (const h of AFTER_RENDER) h('vods'); return; }
  const title = $('#vod-review-title'), sub = $('#vod-review-sub'), panel = document.querySelector('.vod-marker-panel'), reviewPanel = document.querySelector('.vod-review-panel');
  if (title) title.innerHTML = `${esc(v.title)}${vodReviewedBadge(v)}`;
  if (sub) sub.innerHTML = vodReviewSubtitle(v);
  if (panel) panel.innerHTML = vodMarkerPanelHtml(v);
  if (reviewPanel) reviewPanel.innerHTML = vodReviewsPanelHtml(v);
}
// A transparent canvas sitting over the player - open to anyone watching, for sketching over the paused video
// while talking it through on Discord voice. Nothing here is saved on its own; it only becomes permanent if a
// coach or officer takes a screenshot (a separate, later control), and otherwise resets whenever the page is
// left or the player is resized (entering/exiting fullscreen), which is fine since it was never meant to last.
// Strokes are now kept as data (points as fractions of the player's size, 0 to 1), not just painted onto the
// canvas and forgotten - that is what lets a coaching point save exactly what was drawn, and what lets the
// video restore a saved drawing on its own when its marker's timestamp is reached again later. A stroke being
// mid-draw (currentStroke) is kept separate from the finished ones so a resize mid-stroke cannot lose it.
let vodDraw = null;   // { ctx, drawing, color, strokes, currentStroke, activeMarkerId }
function redrawVodStrokes() {
  const canvas = $('#vod-draw-canvas');
  if (!vodDraw || !canvas) return;
  const r = canvas.getBoundingClientRect(), ctx = vodDraw.ctx;
  ctx.clearRect(0, 0, r.width, r.height);
  const drawStroke = (stroke) => {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color || '#e2685c';
    ctx.beginPath();
    stroke.points.forEach((p, i) => { const x = p[0] * r.width, y = p[1] * r.height; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  };
  vodDraw.strokes.forEach(drawStroke);
  if (vodDraw.currentStroke) drawStroke(vodDraw.currentStroke);
}
function setupVodDrawing() {
  const canvas = $('#vod-draw-canvas'), wrap = $('#vod-player-wrap');
  if (!canvas || !wrap) return;
  vodDraw = { ctx: canvas.getContext('2d'), drawing: false, color: '#e2685c', strokes: [], currentStroke: null, activeMarkerId: null };
  const resize = () => {
    const r = wrap.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * ratio)); canvas.height = Math.max(1, Math.round(r.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 4;
    vodDraw.ctx = ctx;
    redrawVodStrokes();
  };
  resize();
  new ResizeObserver(resize).observe(wrap);
  // Points are stored as a fraction of the canvas size (0 to 1), not pixels, so a saved drawing still lines up
  // correctly even if it is viewed again at a different window size than it was drawn at.
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!vodDraw || !canvas.classList.contains('active')) return;
    vodDraw.drawing = true; vodDraw.currentStroke = { color: vodDraw.color, points: [pos(e)] };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!vodDraw || !vodDraw.drawing || !vodDraw.currentStroke) return;
    vodDraw.currentStroke.points.push(pos(e));
    redrawVodStrokes();
  });
  const stop = () => {
    if (!vodDraw || !vodDraw.drawing) return;
    vodDraw.drawing = false;
    if (vodDraw.currentStroke && vodDraw.currentStroke.points.length >= 2) vodDraw.strokes.push(vodDraw.currentStroke);
    vodDraw.currentStroke = null;
    redrawVodStrokes();
  };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
}
ACTIONS['vod-draw-toggle'] = (el) => {
  const canvas = $('#vod-draw-canvas'), on = !canvas.classList.contains('active');
  canvas.classList.toggle('active', on);
  el.classList.toggle('primary', on);
  el.textContent = on ? '✏️ Drawing (on)' : '✏️ Draw';
};
ACTIONS['vod-draw-clear'] = () => { if (vodDraw) { vodDraw.strokes = []; vodDraw.currentStroke = null; redrawVodStrokes(); } };
ACTIONS['vod-color'] = (el) => {
  if (!vodDraw) return;
  vodDraw.color = el.dataset.color;
  $('#vod-colors').querySelectorAll('.vod-color').forEach((b) => b.classList.toggle('active', b === el));
};
// Seeking straight into a paused state is what produces the mobile "black screen" bug: phone browsers (iOS
// Safari and Chrome especially) do not actually decode a video frame just because seekTo() was called - they
// only do that once the player is genuinely playing. So instead of seeking-then-pausing, this seeks, lets the
// player actually reach the "playing" state (which forces that frame to decode), and only then pauses it again
// if the caller wanted it paused. A short safety timeout pauses it anyway if "playing" never fires (e.g. the
// player was already sitting exactly on that frame and has nothing new to report).
function vodSeekSettle(time, keepPlaying) {
  if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
  const target = Math.max(0, Number(time) || 0);
  ytPlayer.seekTo(target, true);
  if (keepPlaying) { ytPlayer.playVideo(); return; }
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    try { ytPlayer.removeEventListener('onStateChange', onState); } catch {}
    ytPlayer.pauseVideo();
  };
  const onState = (e) => { if (e && e.data === 1) settle(); };   // 1 = YT.PlayerState.PLAYING
  try { ytPlayer.addEventListener('onStateChange', onState); } catch {}
  ytPlayer.playVideo();
  setTimeout(settle, 1200);
}
// How far into a VOD someone last was, remembered across a real page reload (not just the in-memory re-render
// that a coaching-point save triggers, which UI.vodRestore already covers). Small/near-zero positions are not
// worth restoring to, so those are not saved at all.
const VOD_POS_PREFIX = 'gh_vodpos_';
function vodSavedPosition(id) {
  try { const n = Number(localStorage.getItem(VOD_POS_PREFIX + id)); return Number.isFinite(n) && n > 3 ? n : 0; } catch { return 0; }
}
function vodSavePosition(id, time) {
  try { localStorage.setItem(VOD_POS_PREFIX + id, String(Math.floor(time))); } catch {}
}
// Jumping to a coaching point pauses the video there and immediately shows whatever was drawn for it, without
// waiting for the playback-position check below to notice (that one only fires while the video is playing).
ACTIONS['vod-marker-jump'] = (el) => {
  const markerId = Number(el.dataset.markerId), v = (S.vods || []).find((x) => x.id === Number(route().id));
  const m = v && (v.markers || []).find((x) => x.id === markerId);
  if (!m || !ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
  UI.vodJump = m.timestamp;
  vodSeekSettle(m.timestamp, false);
  vodDraw.activeMarkerId = m.id;
  setVodMarkerDrawing(m);
};
ACTIONS['vod-marker-delete'] = (el) => {
  const markerId = Number(el.dataset.markerId), v = (S.vods || []).find((x) => x.id === Number(route().id));
  if (v && confirm('Delete this coaching point?')) act(() => api(`/api/vods/${v.id}/markers/${markerId}`, 'DELETE'), 'Deleted');
};
function setVodMarkerDrawing(marker) {
  if (!vodDraw) return;
  vodDraw.strokes = (marker && marker.strokes) ? marker.strokes.map((s) => ({ color: s.color, points: s.points.map((p) => [p[0], p[1]]) })) : [];
  redrawVodStrokes();
  document.querySelectorAll('[data-marker-row]').forEach((row) => row.classList.toggle('active', !!marker && Number(row.dataset.markerRow) === marker.id));
}
// Runs continuously (see the interval timer below) while a VOD is open: as the video plays normally and its
// position passes through a saved coaching point's [timestamp - before, timestamp + after] window, that
// point's drawing appears on its own, then clears again once playback moves past it - automatic annotations,
// not something anyone has to click through.
function syncVodMarkerDisplay() {
  const r = route();
  if (r.page !== 'vods' || !r.id || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
  const v = (S.vods || []).find((x) => x.id === Number(r.id));
  if (!v) return;
  const t = Number(ytPlayer.getCurrentTime()) || 0, current = $('#vod-current-time');
  if (current) current.textContent = `Current position: ${fmtVodTimestamp(t)}`;
  // Throttled so a real reload can pick playback back up near here - not every 200ms tick, just every couple
  // of seconds, since localStorage writes are synchronous and there is no need to do one that often.
  const nowMs = Date.now();
  if (!syncVodMarkerDisplay._savedAt || nowMs - syncVodMarkerDisplay._savedAt > 2000) {
    syncVodMarkerDisplay._savedAt = nowMs;
    vodSavePosition(v.id, t);
  }
  const marker = (v.markers || []).find((m) => t >= Math.max(0, m.timestamp - m.beforeSeconds) && t <= m.timestamp + m.afterSeconds);
  if (marker) {
    if (vodDraw.activeMarkerId !== marker.id) { vodDraw.activeMarkerId = marker.id; setVodMarkerDrawing(marker); }
  } else if (vodDraw.activeMarkerId !== null) {
    vodDraw.activeMarkerId = null; setVodMarkerDrawing(null);
  }
}
// Fullscreen is the whole wrap (the player plus its toolbar, not just the YouTube iframe), so whatever gets
// added on top later - the drawing canvas, a screenshot button - comes along into fullscreen with it rather
// than being left behind outside the fullscreened element. It also happens to be exactly what makes a later
// screenshot capture just the video: once this is the only thing on screen, "capture this tab" naturally
// cannot include anything else, with no cropping logic needed.
// Safari (desktop and iOS) and some older mobile browsers only understand the webkit-prefixed fullscreen API,
// not the standard unprefixed one - this fell back to nothing before, which is the likely reason fullscreen
// silently did not work for anyone on one of those.
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
const fsRequest = (el) => (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen ? Promise.resolve(el.webkitRequestFullscreen()) : Promise.reject(new Error('not supported')));
const fsExit = () => (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen ? document.webkitExitFullscreen() : null);
ACTIONS['vod-fullscreen'] = () => {
  const wrap = $('#vod-player-wrap');
  if (fsElement()) { fsExit(); return; }
  fsRequest(wrap).catch(() => {
    // Some mobile browsers (older iOS Safari especially) refuse fullscreen on a wrapping div that contains a
    // cross-origin iframe, even though they are fine with fullscreening the iframe itself - fall back to that.
    // The drawing overlay and toolbar live outside the iframe, so they will not be visible in this fallback,
    // but a working fullscreen video is better than a silently-rejected request.
    const frame = ytPlayer && typeof ytPlayer.getIframe === 'function' ? ytPlayer.getIframe() : null;
    if (frame) fsRequest(frame).catch(() => toast('Your browser does not support fullscreen here.', true));
    else toast('Your browser does not support fullscreen here.', true);
  });
};
const onFsChange = () => { const btn = $('#vod-fs-btn'); if (btn) btn.textContent = fsElement() ? '⤢ Exit fullscreen' : '⛶ Fullscreen'; };
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
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
  ytPlayer = null;
  setupVodDrawing();   // works regardless of whether the YouTube embed itself loads below
  const timedOut = await Promise.race([loadYouTubeApi().then(() => false), new Promise((r) => setTimeout(() => r(true), 10000))]);
  if (!$('#vod-yt-player')) return;    // the page may have been navigated away from while the API was loading
  if (timedOut) { $('#vod-yt-player').outerHTML = '<div class="empty" style="height:100%;display:grid;place-items:center">Could not load the YouTube player. Check your connection and reload.</div>'; return; }
  ytPlayer = new YT.Player('vod-yt-player', {
    videoId: v.videoId, playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        // Clicking a coaching point before the player existed yet (e.g. the API was still loading) is
        // remembered and honoured the moment it becomes ready, rather than silently doing nothing.
        // Separately: a render can happen after saving a coaching point, and recreating the YouTube iframe
        // normally restarts it at 0:00 - vodRestore (set in FORMS['vod-marker'] below) puts the viewer back
        // where they actually were, and whether it was playing. A deliberate marker jump always wins over this
        // passive restoration, since someone clicking a marker wants to go there, not stay where they were.
        // Make sure the generated iframe is actually allowed to go fullscreen - some browsers otherwise reject
        // a fullscreen request on it even when the surrounding page asks nicely.
        try {
          const frame = ytPlayer.getIframe();
          if (frame) { frame.setAttribute('allowfullscreen', ''); if (!/fullscreen/.test(frame.getAttribute('allow') || '')) frame.setAttribute('allow', `${frame.getAttribute('allow') || ''}; fullscreen`.replace(/^;\s*/, '')); }
        } catch {}
        if (UI.vodJump !== null) {
          const jumpTo = UI.vodJump; UI.vodJump = null; UI.vodRestore = null;
          vodSeekSettle(jumpTo, false);
        } else if (UI.vodRestore) {
          const restore = UI.vodRestore; UI.vodRestore = null;
          vodSeekSettle(restore.time, !!restore.playing);
        } else {
          // A plain page load/reload, not a save-triggered re-render - pick the viewer back up near where they
          // last were watching this VOD, instead of always restarting at 0:00.
          const saved = vodSavedPosition(v.id);
          if (saved) vodSeekSettle(saved, false);
        }
        syncVodMarkerDisplay();
      },
      onStateChange: syncVodMarkerDisplay,
    },
  });
});
// One shared interval, not one per page visit - it is a no-op (syncVodMarkerDisplay returns immediately) on
// every page except an open VOD, so there is nothing to tear down when leaving one.
if (!window.__vodMarkerTimer) window.__vodMarkerTimer = setInterval(syncVodMarkerDisplay, 200);
function vodRow(v) {
  const visBadge = v.visibility === 'everyone' ? '<span class="type-pill">Everyone</span>' : v.visibility === 'class' ? `<span class="type-pill">${esc(v.visibleClass)}</span>` : '<span class="muted small">Private</span>';
  // The owner picking "a class" for their own VOD can only mean their own class - there is no real reason to
  // hand footage to a class they do not even play - so they get just the two meaningful choices and no class
  // picker at all; a coach or officer keeps the full one, since sharing a VOD across classes is sometimes
  // exactly the point for them.
  const selfOnly = !!v.promoteOwnClassOnly;
  return `<div class="rule-row" style="align-items:flex-start;flex-wrap:wrap;gap:10px">
    <div style="flex:1;min-width:220px">
      <a href="#/vods/${v.id}" class="plain"><b>${esc(v.title)}</b>${vodReviewedBadge(v)}</a>
      <a href="${esc(v.url)}" target="_blank" rel="noopener" class="muted small" style="margin-left:6px">Open on YouTube ↗</a>
      <div class="muted small">${esc(vodOwnerName(v))}${v.note ? ' · ' + esc(v.note) : ''}</div>
    </div>
    <div style="align-self:center">${visBadge}</div>
    ${v.canPromote ? `<form data-form="vod-vis" data-id="${v.id}" class="seg" style="align-items:center">
      <select name="visibility" data-act="vod-vis">
        <option value="private" ${v.visibility === 'private' ? 'selected' : ''}>Private</option>
        <option value="everyone" ${v.visibility === 'everyone' ? 'selected' : ''}>Everyone</option>
        <option value="class" ${v.visibility === 'class' ? 'selected' : ''}>${selfOnly ? 'My class' : 'A class'}</option>
      </select>
      ${selfOnly ? '' : `<select name="visibleClass" id="vv-cls-${v.id}" class="${v.visibility === 'class' ? '' : 'hidden'}">${opts(S.cfg.classes.map((c) => c.name), v.visibleClass)}</select>`}
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
CHANGES['vod-vis'] = (el) => { const cls = el.closest('form').querySelector('[name=visibleClass]'); if (cls) cls.classList.toggle('hidden', el.value !== 'class'); };
FORMS['vod-post'] = (f, fd) => act(async () => { await api('/api/vods', 'POST', fd); closeDialog(); }, 'Posted');
FORMS['vod-marker'] = (f, fd) => act(async () => {
  const v = (S.vods || []).find((x) => x.id === Number(route().id));
  if (!v || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') throw new Error('The VOD player is not ready yet.');
  const currentTime = Number(ytPlayer.getCurrentTime()) || 0;
  const playerState = typeof ytPlayer.getPlayerState === 'function' ? ytPlayer.getPlayerState() : null;
  const beforeSeconds = Number(fd.beforeSeconds), afterSeconds = Number(fd.afterSeconds);
  if (!Number.isFinite(beforeSeconds) || beforeSeconds < 0 || beforeSeconds > 10 || !Number.isFinite(afterSeconds) || afterSeconds < 0 || afterSeconds > 10) throw new Error('Marking duration must be between 0 and 10 seconds.');
  const strokes = vodDraw ? (vodDraw.strokes || []).map((s) => ({ color: s.color, points: s.points })) : [];
  // The re-render this save triggers patches the marker list in place and leaves the player alone (see
  // vodPatchReview) - so this normally never gets consumed. It is kept only as a fallback for the rare case a
  // full rebuild happens anyway (e.g. the VOD itself couldn't be found any more), so a restart at 0:00 still
  // will not happen then either.
  UI.vodRestore = { time: currentTime, playing: playerState === 1 };
  await api(`/api/vods/${v.id}/markers`, 'POST', { timestamp: currentTime, beforeSeconds, afterSeconds, note: fd.note, strokes });
  f.reset();
}, 'Coaching point saved');
FORMS['vod-vis'] = (f, fd, id) => act(() => api(`/api/vods/${id}`, 'PUT', { visibility: fd.visibility, visibleClass: fd.visibleClass }), 'Saved');
ACTIONS['vod-delete'] = (el, d) => { if (confirm('Delete this VOD? This also removes any saved screenshots from it.')) act(() => api('/api/vods/' + d.id, 'DELETE'), 'Deleted'); };
// "Write a review" / "Add review": a coach or officer types one overall note, which DMs the player - the
// per-timestamp coaching points above are for pointing at exact moments, this is the wrap-up. Writing a note
// here does not by itself mark the VOD as finished any more - that is its own separate, undoable toggle (see
// the "Mark as finished" button next to this one).
function vodReviewDialog(vodId) {
  const v = (S.vods || []).find((x) => x.id === Number(vodId));
  if (!v) return;
  const already = Array.isArray(v.reviews) && v.reviews.length;
  openDialog(`<form data-form="vod-review" data-id="${v.id}"><h2>${already ? 'Add review' : 'Write a review'}</h2>
      <div class="muted small" style="margin:-4px 0 10px">${already ? 'Adds another review note and DMs the player again.' : 'Lets the player know their VOD has been reviewed.'}${(v.markers || []).length ? ` There ${(v.markers || []).length === 1 ? 'is' : 'are'} ${(v.markers || []).length} coaching point${(v.markers || []).length === 1 ? '' : 's'} on this VOD.` : ''}</div>
      <div class="field"><label for="vr-note">Overall note</label><textarea id="vr-note" name="note" maxlength="1000" placeholder="What should they take away from this?" required autofocus></textarea></div>
      <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">${already ? 'Add review' : 'Write a review'}</button></div>
    </form>`);
}
ACTIONS['vod-review-open'] = (el, d) => vodReviewDialog(d.id);
ACTIONS['vod-finish-toggle'] = (el, d) => {
  const finished = d.finished !== '1';
  act(() => api(`/api/vods/${d.id}/finished`, 'PUT', { finished }), finished ? 'Marked as finished' : 'Marked as not finished');
};
ACTIONS['vod-review-edit'] = (el, d) => {
  const v = (S.vods || []).find((x) => x.id === Number(d.vodId));
  const r = v && (v.reviews || []).find((x) => x.id === Number(d.reviewId));
  if (!r) return;
  openDialog(`<form data-form="vod-review-edit" data-id="${d.vodId}" data-review-id="${d.reviewId}"><h2>Edit review note</h2>
      <div class="field"><label for="vr-note">Overall note</label><textarea id="vr-note" name="note" maxlength="1000" required autofocus>${esc(r.note)}</textarea></div>
      <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
};
ACTIONS['vod-review-resend'] = (el, d) => act(() => api(`/api/vods/${d.vodId}/reviews/${d.reviewId}/resend`, 'POST'), 'Resent');
FORMS['vod-review'] = (f, fd, id) => act(async () => { await api(`/api/vods/${id}/reviews`, 'POST', { note: fd.note }); closeDialog(); }, 'Review sent');
FORMS['vod-review-edit'] = (f, fd, id) => act(async () => { await api(`/api/vods/${id}/reviews/${f.dataset.reviewId}`, 'PUT', { note: fd.note }); closeDialog(); }, 'Saved');
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
