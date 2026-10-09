// Guild Hall - a tiny self-hosted guild manager.
// No dependencies. Needs Node 18+.
//
//   MEMBER_PASSCODE=xxx OFFICER_PASSCODE=yyy node server.js
//
// Data is stored in ./data/db.json. Back it up (or use the Export button in Admin).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDiscord } = require('./discord');
const pkg = require('./package.json');   // app version only - shown to officers in Admin, so they can tell at a glance which code a deployment is actually running

// Optional .env file next to server.js (one KEY=value per line). Real environment variables always win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: fine */ }

const PORT = process.env.PORT || 3000;
const HOST = process.env.LISTEN_HOST || '';                  // empty = listen on every network address; 127.0.0.1 = only through a reverse proxy on this machine
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const discord = createDiscord();

// Shotcaller: a separate self-hosted Discord bot (live voice-session control). Both are empty by default, which
// keeps the whole integration switched off - see server-shotcaller.js. The bot's own Discord server is read off
// DISCORD_GUILD_ID above, not a second variable, since Guild Hall already knows it.
const SHOTCALLER_URL = (process.env.SHOTCALLER_URL || '').replace(/\/+$/, '');
const SHOTCALLER_API_KEY = process.env.SHOTCALLER_API_KEY || '';

// Without Discord settings the app falls back to shared passcodes. That is meant for trying it out on your own PC.
const MEMBER_PASSCODE = process.env.MEMBER_PASSCODE || 'guild';
const OFFICER_PASSCODE = process.env.OFFICER_PASSCODE || 'officer';
if (!discord.loginEnabled && (!process.env.MEMBER_PASSCODE || !process.env.OFFICER_PASSCODE)) {
  console.warn('WARNING: Discord sign-in is not set up, so the app uses shared passcodes ("guild" / "officer"). Fine for a demo on your own PC; NEVER put this on the internet. For real use set the DISCORD_* variables (see README).');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- storage ----------
// Guild-wide settings. Officers change them in the app; config.json supplies the starting values.
const SETTING_DEFAULTS = {
  lootFrom: '',                                           // day the loot window counts back from ('' = today)
  lootThreshold: config.lootThresholdPercent ?? 60,       // attendance % needed to qualify
  lootRedMax: config.lootBands?.redMax ?? 59,             // red is 0..redMax
  lootOrangeMax: config.lootBands?.orangeMax ?? 80,       // orange is redMax+1..orangeMax, green above
  lootItemDays: config.lootItemDays ?? 7,                 // "items received in the last N days"
  pointsEnabled: false,                                   // award points for attending events (off unless the leadership switches it on)
  signupCloseDefault: 30,                                 // sign-ups close this many minutes before an event starts
  pinOffsetMinutes: 0,                                    // the attendance PIN is created this many minutes after the event starts
  pinWindowDefault: 15,                                   // players have this many minutes to type the PIN in
  reminderMinutes: [300, 120],                            // "you have not answered" reminders, minutes before the event
  remindersEnabled: true,
  // Attendance rules: who gets asked for a reason, who gets warnings, and when a warning goes away. 0 switches a limit off.
  // People who are not in the Discord server can sign in and apply. Off by default: then outsiders are turned away as before.
  applications: { enabled: false, intro: 'Tell us a bit about yourself and the character you play. The leadership reads every application.', inviteUrl: '' },
  // "Post to Discord" next to the parties of an event: which channel, and the text that goes with the picture.
  partyPost: {
    channelId: '', channelName: '', text: '📋 **{event}**: parties for {date} at {time} ({parties} parties)\n{link}',
    mentionRoleIds: [],           // Discord roles to @-mention on every party announcement (empty = none, as before)
    deletePrevious: false,        // delete the last party announcement message before posting the new one
    lastMessage: null,            // { channelId, messageId } of the most recent one, so it can be found again to delete
  },
  // "Get mercenaries": which channel and Discord role to ping when an officer asks for outside help for one event.
  mercenaries: { channelId: '', channelName: '', roleId: '', roleName: '' },
  // Shotcaller: who can be picked as the dedicated or extra caller(s) when running a live voice session - a
  // shortlist the leadership curates in Admin, not the whole roster. candidateUserIds are Discord user ids.
  shotcaller: { candidateUserIds: [], defaultCallerId: '' },
  // Extra ways to become an officer, on top of DISCORD_OFFICER_ROLE_IDS / DISCORD_OFFICER_USER_IDS in .env -
  // editable here instead of needing a server restart. Checked at sign-in, same as the .env ones.
  officerRoleIds: [], officerUserIds: [],
  // Class coaches: a narrower role than officer, granted the same way (a Discord role and/or specific players).
  // A coach does not get officer permissions from this alone - it only ever matters for VOD review.
  coachRoleIds: [], coachUserIds: [],
  compliance: {
    enabled: true,
    pausedUntil: null,      // a temporary pause on top of "enabled" (Admin can set one for a number of hours),
                             // resuming on its own once that time passes rather than needing to be switched back on by hand
    finalAfterMinutes: 60,  // an event's attendance (and no-shows) is only judged once this long after it started,
                             // not as soon as one single person checks in - the PIN window itself is unaffected
    windowDays: 30,         // how far back attendance is looked at
    mandatoryOnly: true,    // only mandatory events count
    minEvents: 3,           // fewer events than this: no judgement on the attendance percentage
    minAttendance: 40,      // below this % the player is asked for a reason
    noShowLimit: 3,         // said Going but did not come this many times: reason + warning
    noReplyLimit: 4,        // never answered this many events: reason + warning
    expiryDays: 60,         // every warning disappears after this many days
    quietDays: 0,           // ...or: after this many days without a new warning...
    quietRemove: 0,         // ...this many of the oldest warnings vanish (0 = all of them)
    disqualifyAt: 3,        // at this many active warnings the player is disqualified from loot
    loaNeedsApproval: true, // leave of absence has to be approved by the leadership
  },
  approvals: Object.fromEntries((config.approvalGroups || []).map((g) => [g.key, !!g.default])),   // which player changes need leadership approval
  hiddenSections: [],                                     // sections normal members do not see
  branding: { name: '', tagline: '', accent: '', bgDim: 82, announcement: '', iconFile: '', bgFile: '' },
};
let db = { nextId: 1, members: [], events: [], points: [], duties: [], presets: [], presetRules: [], loot: [], users: {}, series: [], profiles: {}, changes: [], requests: [], tags: [], playerTags: {}, prefs: {}, notices: [], noticeAcks: {}, leaves: [], warnings: [], explanations: [], applications: [], auditLog: [], infoBoard: { title: 'Info', categories: [] }, settings: { ...SETTING_DEFAULTS } };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };

// Writing the whole db to disk on every single change used to be synchronous - fine one at a time, but with
// dozens of players all doing something at once (everyone typing an attendance PIN in during the same minute,
// say) each of those blocking disk writes queues up behind the last, and the single-threaded server cannot even
// start answering the next request until the current write (stringify + write + rename, all synchronous) is
// done - that pile-up is what "nearly crashed the server". Fixed by only ever marking the data dirty here and
// actually writing it out a short moment later, asynchronously, so a whole burst of changes within that window
// collapses into one disk write instead of one per request, and no request ever blocks on disk I/O at all.
let dirty = false, writing = false, flushTimer = null;
const SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS || 200);
function scheduleFlush() {
  if (flushTimer || writing) return;            // a flush is already queued or in progress - it will pick up this change too
  flushTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  flushTimer.unref?.();                         // a pending save should never be the reason the process stays alive
}
async function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  writing = true;
  try {
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.promises.rename(tmp, DB_FILE);
  } catch (e) {
    console.error('save failed, will retry:', e);
    dirty = true;                                // don't silently lose the change - try again on the next flush
  } finally {
    writing = false;
    if (dirty) scheduleFlush();                   // more changes arrived while this write was in flight
  }
}
function save() { dirty = true; scheduleFlush(); }
// Only used right before the process actually exits (see shutdown() below), where "a moment later" is too late -
// this finishes the write before Node is given the chance to quit, so a deploy/restart never drops the last
// few changes that were still waiting out their debounce window.
function saveSync() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function shutdown(code) {
  try { saveSync(); } catch (e) { console.error('final save failed:', e); }
  process.exit(code);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
const newId = () => db.nextId++;

// ---------- auth (stateless signed tokens, survive restarts) ----------
let SECRET = process.env.SECRET;
if (!SECRET) {
  if (fs.existsSync(SECRET_FILE)) SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  else {
    SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, SECRET);
  }
}
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function makeToken(user, days = 30) {
  const body = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + days * 864e5 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
const SESSION_COOKIE = 'gh_session';
const cookieOf = (req, name) => (String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '=')) || '').slice(name.length + 1);
const cookieHeader = (name, value, maxAgeSec) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${discord.cfg.publicUrl.startsWith('https') ? '; Secure' : ''}`;
function readToken(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const u = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!(u.exp > Date.now())) return null;
    if (discord.loginEnabled && !u.discord) return null;      // old passcode sessions stop working once Discord is switched on
    if (!u.key) u.key = u.name;                                // sessions from before Discord sign-in existed
    return u;
  } catch { return null; }
}
// One-tap RSVP links for reminder DMs: short, signed, no session or login needed - the token itself is the
// proof of who it is for. Deliberately NOT a full session token (makeToken/readToken above): this is good for
// exactly one thing, expires with sign-ups for the event, and carries no identity beyond "this Discord account,
// this event, this answer".
function makeRsvpToken(eventId, owner, answer, expiresAt) {
  const body = Buffer.from(JSON.stringify({ e: eventId, o: owner, a: answer, exp: expiresAt })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readRsvpToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!(t.exp > Date.now())) return null;
    return t;
  } catch { return null; }
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const failures = new Map(); // ip -> [timestamps]
function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  failures.set(ip, list);
  return list.length >= 10;
}

// ---------- helpers ----------
const isOfficer = (u) => u.role === 'officer';
const isCoach = (u) => !!u.coach || isOfficer(u);   // officers can do anything a coach can
const LEADERSHIP = config.leadershipRanks || ['Guild Master', 'Officer'];
const DUTY_STATUSES = ['todo', 'doing', 'done'];
const LOOT_TYPES = config.lootTypes || ['Skillcore', 'Item', 'Shard'];
const LOOT_DEFAULT_TYPE = config.lootDefaultType || (LOOT_TYPES.includes('Item') ? 'Item' : LOOT_TYPES[0]);
const DEFAULT_RANK = config.ranks.includes(config.defaultRank) ? config.defaultRank : config.ranks[config.ranks.length - 1];   // the rank a new character gets until an officer changes it
const LOOT_REASONS = config.lootReasons || [];     // how it was decided: loot council, attendance win, donation, buyout...
const LOOT_PURPOSES = config.lootPurposes || [];   // what it is for: PvE, PvP, an alt build...
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };
const findMember = (id) => db.members.find((m) => m.id === Number(id));
const findEvent = (id) => db.events.find((e) => e.id === Number(id));
const hooks = { memberDeleted: [], skipReminder: [] };                 // features register cleanup here
const tickHooks = [];                               // and periodic jobs here
const canEditMember = (u, m) => isOfficer(u) || m.owner === u.key;   // owner = Discord user id (or the display name in demo mode)

// Parties are stored as [{ name, members: [memberId] }]. Older data stored bare id arrays; convert on load.
const dropFromParty = (p, id) => { const builds = { ...(p.builds || {}) }; delete builds[id]; return { ...p, members: p.members.filter((x) => x !== id), leader: p.leader === id ? null : p.leader, builds }; };
function normParties(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr.slice(0, 20).map((p, i) => {
    const list = Array.isArray(p) ? p : p && Array.isArray(p.members) ? p.members : [];
    const members = [];
    for (const raw of list) {
      const id = Number(raw);
      if (findMember(id) && !seen.has(id)) { seen.add(id); members.push(id); }
    }
    const name = (!Array.isArray(p) && p && clean(p.name, 40)) || `Party ${i + 1}`;
    const leader = !Array.isArray(p) && p && members.includes(Number(p.leader)) ? Number(p.leader) : null;
    // builds: { memberId: buildId } only for players who use one of their extra builds in this party (everybody else plays their main)
    const builds = {};
    if (!Array.isArray(p) && p && p.builds && typeof p.builds === 'object') {
      for (const id of members) {
        const k = String(p.builds[id] ?? 'main'), m = findMember(id);
        if (k !== 'main' && m && (m.builds || []).some((b) => String(b.id) === k)) builds[id] = k;
      }
    }
    // placeholder / placeholderOverride: whether this party is a real line-up yet. Left alone
    // (placeholderOverride: false), a party counts as a placeholder automatically once it has 3 or fewer
    // members - see partyIsPlaceholder() below. placeholderOverride: true means an officer explicitly toggled
    // it (party menu > "Mark/Unmark as placeholder"), and placeholder then says which way, overriding the
    // automatic member-count rule either direction - including forcing a 3-or-fewer party to NOT count as one.
    // Used by the "post to Discord + start Shotcaller" leader check (server-community.js) and by Shotcaller
    // itself to decide which parties get skipped entirely (no voice channel, not counted toward its 12-party
    // cap) - see server-community.js's post-parties route and public/shotcaller.js's Start dialog.
    const placeholder = !Array.isArray(p) && !!(p && p.placeholder);
    // Back-compat: data saved before placeholderOverride existed only ever stored a bare `placeholder`
    // boolean, and the only way it could be `true` was an officer's explicit "Mark as placeholder" click (the
    // default was always false) - so treat that old `true` as an override too, or it would silently stop being
    // a placeholder the moment this ran (falling through to the automatic ≤3-member rule instead) and get
    // counted into a Shotcaller session again, shifting every party name after it by one. An old `false` was
    // always just the untouched default and already behaved exactly like the automatic rule, so it implies no
    // override. A request that explicitly sends placeholderOverride (true or false) - from the current party
    // menu toggle, or anything else written after this version - is honored as-is instead of reinterpreted.
    const placeholderOverride = !Array.isArray(p) && p && p.placeholderOverride !== undefined ? !!p.placeholderOverride : placeholder;
    return { name, members, leader, builds, placeholder, placeholderOverride };
  });
}
// Single source of truth for "is this party a placeholder right now" - mirrored in public/app.js's copy of the
// same function (keep both in sync; each is commented to point at the other).
function partyIsPlaceholder(p) { return p.placeholderOverride ? p.placeholder : p.members.length <= 3; }
// Brings data written by older versions up to date. Runs on start and after a backup is restored.
function migrate() {
  db.duties = db.duties || [];
  db.presets = db.presets || [];
  db.loot = db.loot || [];
  db.users = db.users || {};
  db.presetRules = db.presetRules || [];
  for (const k of ['series', 'changes', 'requests', 'tags', 'notices', 'leaves', 'warnings', 'explanations', 'applications', 'auditLog', 'coachLinks', 'vods', 'vodScreenshots', 'vodMarkers', 'guestCoaches']) db[k] = db[k] || [];
  for (const k of ['profiles', 'playerTags', 'prefs', 'noticeAcks']) db[k] = db[k] || {};
  db.partyBuilderNote = typeof db.partyBuilderNote === 'string' ? db.partyBuilderNote : '';
  // { pct, events, days, fromDate } per player - a linearly-decaying starting baseline, not a flat number
  // (see /api/admin/attendance-starting). An older save from before this had just a plain number per player;
  // there is no sound way to guess the events/days/fromDate it never had, so those entries are dropped here
  // rather than carried over as something misleading.
  db.attendanceStarting = (db.attendanceStarting && typeof db.attendanceStarting === 'object') ? db.attendanceStarting : {};
  for (const [k, v] of Object.entries(db.attendanceStarting)) if (typeof v !== 'object' || v === null) delete db.attendanceStarting[k];
  db.infoBoard = db.infoBoard && Array.isArray(db.infoBoard.categories) ? db.infoBoard : { categories: [] };
  db.infoBoard.title = db.infoBoard.title || 'Info';
  db.settings.compliance = { ...SETTING_DEFAULTS.compliance, ...(db.settings.compliance || {}) };
  db.settings.applications = { ...SETTING_DEFAULTS.applications, ...(db.settings.applications || {}) };
  db.settings.partyPost = { ...SETTING_DEFAULTS.partyPost, ...(db.settings.partyPost || {}) };
  db.settings.mercenaries = { ...SETTING_DEFAULTS.mercenaries, ...(db.settings.mercenaries || {}) };
  db.settings.shotcaller = { ...SETTING_DEFAULTS.shotcaller, ...(db.settings.shotcaller || {}) };
  db.settings = { ...SETTING_DEFAULTS, ...(db.settings || {}) };
  db.settings.approvals = { ...SETTING_DEFAULTS.approvals, ...(db.settings.approvals || {}) };
  db.settings.branding = { ...SETTING_DEFAULTS.branding, ...(db.settings.branding || {}) };
  for (const m of db.members) {
    if (typeof m.questlog === 'string') { m.questlogs = m.questlog ? [{ label: 'Questlog', url: m.questlog }] : []; delete m.questlog; }   // one link became a list
    m.questlogs = m.questlogs || [];
    m.builds = m.builds || [];
    m.mode = m.mode || config.buildModes?.[0] || 'PvE';
  }
  for (const se of db.series) { se.skipped = se.skipped || []; }
  for (const l of db.loot) if (!l.type) l.type = LOOT_DEFAULT_TYPE;
  for (const p of db.presets) p.parties = normParties(p.parties);
  db.presetRules = db.presetRules.filter((r) => db.presets.some((p) => p.id === r.presetId));
  for (const v of db.vods) if (!Array.isArray(v.reviews)) v.reviews = [];
  for (const ev of db.events) {
    ev.parties = normParties(ev.parties);
    ev.rsvps = ev.rsvps || {};
    for (const [id, st] of Object.entries(ev.rsvps)) if (st !== 'yes' && st !== 'no') delete ev.rsvps[id];   // "maybe" no longer exists
    if (ev.pinWindowMinutes === undefined) {
      // Event from before PINs existed: never send a PIN for one that has already started.
      ev.pinSkip = Date.parse(ev.start) < Date.now();
      ev.pinWindowMinutes = db.settings.pinWindowDefault;
      ev.signupCloseMinutes = db.settings.signupCloseDefault;
      ev.reminders = true;
    }
    ev.pin = ev.pin || null;
    ev.pinEntries = ev.pinEntries || {};
    ev.remindersSent = ev.remindersSent || {};
    ev.reminderLog = ev.reminderLog || [];
    // Event from before the PIN could be switched off for a non-mandatory event on its own: it follows whatever
    // Mandatory already was, same as the default for a brand new event does.
    if (ev.pinEnabled === undefined) ev.pinEnabled = !!ev.mandatory;
  }
}
migrate();

// Only plain http(s) links are kept, so a pasted "javascript:" link can never end up clickable.
function cleanUrl(v) {
  const u = clean(v, 300);
  if (!u) return '';
  need(/^https?:\/\/[^\s<>"']+$/i.test(u), 400, 'Links must start with http:// or https://');
  return u;
}
function cleanLinks(list) {
  const arr = Array.isArray(list) ? list : [];
  need(arr.length <= 6, 400, 'You can add up to 6 Questlog links.');
  return arr.map((l) => ({ label: clean(l && l.label, 30), url: cleanUrl(l && l.url) })).filter((l) => l.url);
}

// With Discord sign-in an owner must be somebody who has signed in; in demo mode any name is fine.
function pickOwner(v) {
  const o = clean(v, 40);
  need(!discord.loginEnabled || db.users[o], 400, 'Pick a player who has signed in with Discord.');
  return o;
}

function pickMember(b, existing) {
  const m = existing || {};
  const roles = config.roles, weapons = config.weapons, ranks = config.ranks;
  const out = {
    name: clean(b.name, 40),
    role: roles.includes(b.role) ? b.role : roles[0],
    primaryWeapon: weapons.includes(b.primaryWeapon) ? b.primaryWeapon : '',
    secondaryWeapon: weapons.includes(b.secondaryWeapon) ? b.secondaryWeapon : '',
    gearScore: Math.max(0, Math.min(99999, Math.round(num(b.gearScore)))),
    level: Math.max(0, Math.min(99, Math.round(num(b.level)))),
    specialization: clean(b.specialization, 40),
    questlogs: b.questlogs !== undefined ? cleanLinks(b.questlogs) : b.questlog !== undefined ? cleanLinks([{ label: 'Questlog', url: b.questlog }]) : (m.questlogs || []),
    mode: (config.buildModes || ['PvE']).includes(b.mode) ? b.mode : (m.mode || config.buildModes?.[0] || 'PvE'),
    discord: clean(b.discord, 40),
    timezone: clean(b.timezone, 40),
    notes: clean(b.notes, 500),
    active: b.active !== false,
  };
  need(out.name.length >= 2, 400, 'Character name is required (2+ characters).');
  // Only officers may change ranks.
  out.rank = m.rank || DEFAULT_RANK;
  return out;
}

function syncAttendancePoints(ev) {
  // Keep ledger entries for this event in step with the attendance list.
  const attended = new Set(ev.attended || []);
  db.points = db.points.filter((p) => !(p.eventId === ev.id && !attended.has(p.memberId)));
  if (ev.points > 0 && db.settings.pointsEnabled) {
    for (const memberId of attended) {
      if (!db.points.some((p) => p.eventId === ev.id && p.memberId === memberId)) {
        db.points.push({
          id: newId(), memberId, delta: ev.points,
          reason: `Attended: ${ev.title}`, eventId: ev.id, at: new Date().toISOString(), by: 'system',
        });
      }
    }
  }
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, { auth = true, officer = false, applicant = false } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, auth, officer, applicant });
};

// ---------- audit log: records who changed what, across this file and the feature modules ----------
const audit = require('./server-audit')({ route, need, clean, newId, save, isOfficer, get db() { return db; } });

route('POST', '/api/login', ({ body, ip }) => {
  need(!discord.loginEnabled, 400, 'This server uses Discord sign-in.');
  need(!tooManyFailures(ip), 429, 'Too many failed attempts. Try again in a few minutes.');
  const name = clean(body.name, 24);
  need(name.length >= 2, 400, 'Enter a display name (2+ characters).');
  const code = String(body.passcode || '');
  let role = null;
  if (safeEqual(code, OFFICER_PASSCODE)) role = 'officer';
  else if (safeEqual(code, MEMBER_PASSCODE)) role = 'member';
  if (!role) {
    failures.get(ip).push(Date.now());
    throw new HttpError(401, 'Wrong passcode.');
  }
  // Passcode mode has no Discord roles to check, only the specific-player list - and no persisted db.users
  // record either (unlike Discord sign-in), so this is re-checked fresh on every request below rather than
  // relying on what the token says, the same way Discord-mode coach status now works.
  const user = { key: name, name, role, coach: db.settings.coachUserIds.includes(name) };
  return { token: makeToken(user), user };
}, { auth: false });

const publicBranding = () => {
  const b = db.settings.branding;
  return { name: b.name, tagline: b.tagline, accent: b.accent, bgDim: b.bgDim, icon: b.iconFile ? '/uploads/' + b.iconFile : '', bg: b.bgFile ? '/uploads/' + b.bgFile : '' };
};
route('GET', '/api/config', () => ({ ...config, version: pkg.version, authMode: discord.loginEnabled ? 'discord' : 'passcode', botOn: discord.botEnabled, shotcallerOn: !!(SHOTCALLER_URL && SHOTCALLER_API_KEY && discord.cfg.guildId), applicationsOpen: discord.loginEnabled && !!db.settings.applications.enabled, branding: publicBranding() }), { auth: false });

const closeAt = (ev) => Date.parse(ev.start) - (ev.signupCloseMinutes ?? db.settings.signupCloseDefault) * 60000;
function pinInfo(ev) {
  const start = Date.parse(ev.start), win = ev.pinWindowMinutes * 60000;
  const scheduledAt = new Date(start + db.settings.pinOffsetMinutes * 60000).toISOString();
  // enabled: true unless an officer switched the PIN off for this specific event - tells the client there is no
  // point waiting for one here, rather than showing "not activated yet" until enough time has passed to give up.
  if (!ev.pin) return { state: 'pending', scheduledAt, windowMinutes: ev.pinWindowMinutes, enabled: !!ev.pinEnabled };
  const opens = Date.parse(ev.pin.at);
  return { state: Date.now() <= opens + win ? 'open' : 'closed', scheduledAt, opensAt: ev.pin.at, closesAt: new Date(opens + win).toISOString(), windowMinutes: ev.pinWindowMinutes, enabled: !!ev.pinEnabled };
}
// Officers get the whole event. Everybody else gets it without the PIN itself.
function eventFor(ev, user) {
  const out = { ...ev, pinInfo: pinInfo(ev), signupClosesAt: new Date(closeAt(ev)).toISOString() };
  if (!isOfficer(user)) { delete out.pin; delete out.pinEntries; delete out.reminderLog; delete out.remindersSent; delete out.partyPosts; }
  return out;
}

// GET /api/state is built per person in server-features.js (members only get their own loot, attendance and requests).

// Characters: created and edited in server-features.js (some changes can need leadership approval).
// The full cleanup for removing one character: every place a member id is referenced elsewhere in the data.
// Shared by the single-character delete route and the "one character per player" cleanup tool, so both stay
// in sync - there is exactly one place that knows everything a character touches.
function deleteMemberCascade(m) {
  db.members = db.members.filter((x) => x.id !== m.id);
  db.points = db.points.filter((p) => p.memberId !== m.id);
  db.duties = db.duties.filter((d) => d.memberId !== m.id);
  db.loot = db.loot.filter((l) => l.memberId !== m.id);
  for (const ev of db.events) {
    delete ev.rsvps[m.id];
    ev.attended = ev.attended.filter((id) => id !== m.id);
    ev.parties = ev.parties.map((p) => dropFromParty(p, m.id));
  }
  for (const p of db.presets) p.parties = p.parties.map((q) => dropFromParty(q, m.id));
  for (const h of hooks.memberDeleted) h(m);
}
// A kick is not a delete: history (loot, points, attendance) stays exactly as it is, and the character is just
// deactivated, same as if they had left on their own. What makes it a kick rather than that is the Discord
// account itself gets flagged, checked at the top of every future sign-in (see the OAuth callback below) -
// instead of landing in the guild normally (even if they still have the Discord role, even if they were
// accepted before), they are sent to the application page to ask to come back, same as anyone new. Accepting
// a fresh application from them clears the flag - see /api/applications/:id.
route('POST', '/api/admin/kick', ({ body, user }) => {
  need(discord.loginEnabled, 400, 'Kicking a specific player only makes sense with Discord sign-in, which this server is not using.');
  const owner = clean(body.ownerKey, 40);
  need(owner, 400, 'Pick a player.');
  need(db.users[owner], 404, 'That player has never signed in with Discord.');
  need(owner !== user.key, 400, 'You cannot kick yourself.');
  const reason = clean(body.reason, 300);
  const chars = db.members.filter((m) => m.owner === owner && m.active);
  for (const m of chars) m.active = false;
  db.users[owner].kicked = true;
  db.users[owner].kickedAt = new Date().toISOString();
  db.users[owner].kickedBy = user.name;
  db.users[owner].kickReason = reason;
  save();
  audit.log(user, 'player.kick', { type: 'player', id: owner, name: db.users[owner].name }, `${user.name} kicked ${db.users[owner].name}${reason ? ` (${reason})` : ''}. They can no longer sign in normally and will be sent to re-apply.`);
  return { ok: true };
}, { officer: true });
route('DELETE', '/api/members/:id', ({ user, params }) => {
  const m = findMember(params.id);
  need(m, 404, 'Character not found.');
  need(canEditMember(user, m), 403, 'You can only remove your own characters.');
  deleteMemberCascade(m);
  audit.log(user, 'member.delete', { type: 'member', id: m.id, name: m.name }, `${user.name} removed the character "${m.name}" (owner: ${m.owner}).`);
  save();
  return { ok: true };
});

// One character per player: who currently has more than one, and a tool to clean that up (keeps the oldest,
// removes the rest the same safe way a normal delete does). Going forward, POST /api/members itself refuses to
// create a second one - this is only for data that predates that rule.
function duplicateGroups() {
  const byOwner = new Map();
  for (const m of db.members) { if (!byOwner.has(m.owner)) byOwner.set(m.owner, []); byOwner.get(m.owner).push(m); }
  return [...byOwner.entries()].filter(([, ms]) => ms.length > 1).map(([owner, ms]) => {
    const sorted = ms.slice().sort((a, b) => a.id - b.id);
    return { owner, name: nameOfOwner(owner), keep: sorted[0], remove: sorted.slice(1) };
  });
}
route('GET', '/api/admin/duplicate-characters', () => duplicateGroups().map((g) => ({
  owner: g.owner, name: g.name,
  keep: { id: g.keep.id, name: g.keep.name, role: g.keep.role },
  remove: g.remove.map((m) => ({ id: m.id, name: m.name, role: m.role })),
})), { officer: true });
route('POST', '/api/admin/enforce-one-character', ({ user }) => {
  const groups = duplicateGroups();
  let removed = 0;
  for (const g of groups) for (const m of g.remove) { deleteMemberCascade(m); removed++; }
  if (removed) audit.log(user, 'member.cleanup', { type: 'settings' }, `${user.name} cleaned up extra characters: kept 1 per player for ${groups.length} ${groups.length === 1 ? 'player' : 'players'}, removed ${removed}.`);
  save();
  return { players: groups.length, removed };
}, { officer: true });

// Events
function pickEvent(b, ex) {
  const type = config.eventTypes.find((t) => t.name === b.type) || config.eventTypes[config.eventTypes.length - 1];
  const start = new Date(b.start);
  need(!isNaN(start), 400, 'Pick a valid date and time.');
  const title = clean(b.title, 80) || type.name;                 // no title typed: the type becomes the title
  const int = (v, dflt, lo, hi) => { const n = Math.round(Number(v)); return v === undefined || v === '' || v === null || !Number.isFinite(n) ? dflt : Math.min(hi, Math.max(lo, n)); };
  const mandatory = b.mandatory === undefined ? !!type.mandatory : b.mandatory === true || b.mandatory === 'true';
  return {
    title, type: type.name, start: start.toISOString(),
    description: clean(b.description, 1500),
    points: Math.max(0, Math.round(num(b.points, type.points))),
    mandatory,
    // The attendance PIN defaults to following "Mandatory" (on for a mandatory event, off for an optional one -
    // nobody needs to prove they showed up to something optional), but is its own switch: pick it independently
    // of Mandatory, in either direction, same as Mandatory itself can be picked independently of the event type.
    pinEnabled: b.pinEnabled === undefined ? mandatory : b.pinEnabled === true || b.pinEnabled === 'true',
    maxSignups: Math.max(0, Math.round(num(b.maxSignups))),
    signupCloseMinutes: int(b.signupCloseMinutes, ex ? ex.signupCloseMinutes : db.settings.signupCloseDefault, 0, 10080),
    pinWindowMinutes: int(b.pinWindowMinutes, ex ? ex.pinWindowMinutes : db.settings.pinWindowDefault, 1, 720),
    reminders: b.reminders === undefined ? (ex ? ex.reminders !== false : true) : b.reminders === true || b.reminders === 'true',
    // Pre-ticks the "also start Shotcaller" checkbox in the Post-to-Discord dialog for this event (or, via a
    // series, every event it generates) - that checkbox can still be switched either way at post time, this is
    // only the default. Meaningless (and simply ignored) while Shotcaller itself isn't configured.
    shotcallerAutoStart: b.shotcallerAutoStart === undefined ? !!(ex && ex.shotcallerAutoStart) : b.shotcallerAutoStart === true || b.shotcallerAutoStart === 'true',
  };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
// A party preset can be tied to an event type ("use it for every Wargames"). New events of that type get it automatically.
function applyPresetRule(ev) {
  if (ev.parties.length) return;
  const rule = db.presetRules.find((r) => r.type === ev.type);
  const p = rule && db.presets.find((x) => x.id === rule.presetId);
  if (p) ev.parties = normParties(clone(p.parties));
}
route('POST', '/api/events', ({ body, user }) => {
  const ev = { id: newId(), createdBy: user.key, rsvps: {}, attended: [], autoAttended: false, parties: [], pin: null, pinEntries: {}, remindersSent: {}, reminderLog: [], ...pickEvent(body) };
  applyPresetRule(ev);
  db.events.push(ev);
  audit.log(user, 'event.create', { type: 'event', id: ev.id, name: ev.title }, `${user.name} created the event "${ev.title}" (${ev.type}, ${ev.start}).`);
  save();
  return eventFor(ev, user);
}, { officer: true });
route('PUT', '/api/events/:id', ({ body, params, user }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  const oldStart = ev.start, oldType = ev.type, oldTitle = ev.title;
  Object.assign(ev, pickEvent(body, ev));
  if (ev.start !== oldStart) ev.remindersSent = {};               // moved to another time: reminders start over
  if (ev.type !== oldType) applyPresetRule(ev);
  syncAttendancePoints(ev);
  if (ev.start !== oldStart || ev.type !== oldType || ev.title !== oldTitle) audit.log(user, 'event.update', { type: 'event', id: ev.id, name: ev.title }, `${user.name} edited the event "${oldTitle}".`, { title: oldTitle, type: oldType, start: oldStart }, { title: ev.title, type: ev.type, start: ev.start });
  save();
  return eventFor(ev, user);
}, { officer: true });
route('DELETE', '/api/events/:id', ({ params, user }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  const series = ev.seriesId && db.series.find((x) => x.id === ev.seriesId);   // deleting one date of a recurring event skips just that date
  if (series && ev.seriesDate && !series.skipped.includes(ev.seriesDate)) series.skipped.push(ev.seriesDate);
  db.events = db.events.filter((e) => e.id !== ev.id);
  db.points = db.points.filter((p) => p.eventId !== ev.id);
  audit.log(user, 'event.delete', { type: 'event', id: ev.id, name: ev.title }, `${user.name} deleted the event "${ev.title}".`);
  save();
  return { ok: true };
}, { officer: true });

route('POST', '/api/events/:id/rsvp', ({ body, user, params }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  const m = findMember(body.memberId);
  need(m, 404, 'Character not found.');
  need(canEditMember(user, m), 403, 'You can only sign up your own characters.');
  need(isOfficer(user) || Date.now() < closeAt(ev), 409, 'Sign-ups for this event are closed.');
  if (body.status === 'none') delete ev.rsvps[m.id];
  else {
    need(['yes', 'no'].includes(body.status), 400, 'Bad status.');
    if (body.status === 'yes' && ev.maxSignups) {
      const going = Object.entries(ev.rsvps).filter(([id, s]) => s === 'yes' && Number(id) !== m.id).length;
      need(going < ev.maxSignups, 409, 'This event is full.');
    }
    ev.rsvps[m.id] = body.status;
  }
  save();
  return eventFor(ev, user);
});

route('POST', '/api/events/:id/attendance', ({ body, params, user }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  const ids = (Array.isArray(body.memberIds) ? body.memberIds : []).map(Number).filter((id) => findMember(id));
  ev.attended = [...new Set(ids)];
  ev.autoAttended = true;   // an officer took the roll by hand - the automatic fill-in (see tick()) must never touch this event again
  syncAttendancePoints(ev);
  audit.log(user, 'attendance.record', { type: 'event', id: ev.id, name: ev.title }, `${user.name} recorded attendance for "${ev.title}": ${ev.attended.length} ${ev.attended.length === 1 ? 'character' : 'characters'}.`);
  save();
  return eventFor(ev, user);
}, { officer: true });

route('POST', '/api/events/:id/parties', ({ body, params, user }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  ev.parties = normParties(body.parties);
  audit.log(user, 'party.update', { type: 'event', id: ev.id, name: ev.title }, `${user.name} set the parties for "${ev.title}": ${ev.parties.length} ${ev.parties.length === 1 ? 'party' : 'parties'}.`);
  save();
  return eventFor(ev, user);
}, { officer: true });

// Points ledger
route('POST', '/api/points', ({ body, user }) => {
  need(db.settings.pointsEnabled, 400, 'Points are turned off in Admin.');
  const m = findMember(body.memberId);
  need(m, 404, 'Character not found.');
  const delta = Math.round(num(body.delta));
  need(delta !== 0, 400, 'Enter a non-zero amount.');
  const entry = {
    id: newId(), memberId: m.id, delta, reason: clean(body.reason, 100) || 'Manual adjustment',
    at: new Date().toISOString(), by: user.name,
  };
  db.points.push(entry);
  audit.log(user, 'points.adjust', { type: 'member', id: m.id, name: m.name }, `${user.name} ${delta > 0 ? 'gave' : 'took'} ${Math.abs(delta)} points ${delta > 0 ? 'to' : 'from'} ${m.name}: ${entry.reason}.`);
  save();
  return entry;
}, { officer: true });
route('DELETE', '/api/points/:id', ({ params, user }) => {
  const entry = db.points.find((p) => p.id === Number(params.id));
  db.points = db.points.filter((p) => p.id !== Number(params.id));
  if (entry) { const m = findMember(entry.memberId); audit.log(user, 'points.delete', { type: 'member', id: entry.memberId, name: m ? m.name : '' }, `${user.name} deleted a points entry${m ? ' for ' + m.name : ''}: ${entry.delta > 0 ? '+' : ''}${entry.delta} (${entry.reason}).`); }
  save();
  return { ok: true };
}, { officer: true });

// Guild-wide settings (officers only).
// A one-off migration aid for a guild moving its whole history onto Guild Hall: lets the leadership give a
// player a starting baseline - "50% over their last 30 events across 14 days, starting Oct 1" - instead of
// everyone showing a blank "-" until real event history builds up, and instead of one flat number that would
// let a single real event swing someone from 5% to 100% overnight. See virtualAttendanceFor() in
// server-compliance.js for how this baseline actually decays away, linearly, day by day, back to nothing.
route('PUT', '/api/admin/attendance-starting', ({ body, user }) => {
  const values = body.values && typeof body.values === 'object' ? body.values : {};
  let changed = 0;
  for (const [owner, raw] of Object.entries(values)) {
    if (raw === null || (typeof raw === 'object' && raw.pct === '')) { if (owner in db.attendanceStarting) { delete db.attendanceStarting[owner]; changed++; } continue; }
    need(raw && typeof raw === 'object', 400, 'Each player needs a percentage, event count, day count and start date, or none at all.');
    const pct = Math.round(Number(raw.pct)), events = Math.round(Number(raw.events)), days = Math.round(Number(raw.days));
    need(Number.isFinite(pct) && pct >= 0 && pct <= 100, 400, `${raw.pct} is not a percentage between 0 and 100.`);
    need(Number.isFinite(events) && events >= 1 && events <= 1000, 400, `${raw.events} is not a sensible number of events.`);
    need(Number.isFinite(days) && days >= 1 && days <= 1000, 400, `${raw.days} is not a sensible number of days.`);
    const fromDate = String(raw.fromDate || '').trim();
    need(/^\d{4}-\d{2}-\d{2}$/.test(fromDate) && !isNaN(new Date(fromDate + 'T00:00:00Z')), 400, 'Pick a valid start date.');
    const next = { pct, events, days, fromDate };
    if (JSON.stringify(db.attendanceStarting[owner] || null) !== JSON.stringify(next)) { db.attendanceStarting[owner] = next; changed++; }
  }
  if (changed) { save(); audit.log(user, 'attendance.starting', { type: 'settings' }, `${user.name} set a starting attendance baseline for ${changed} ${changed === 1 ? 'player' : 'players'}.`); }
  return db.attendanceStarting;
}, { officer: true });
route('PUT', '/api/party-builder-note', ({ body }) => {
  db.partyBuilderNote = clean(body.note, 2000);
  save();
  return { note: db.partyBuilderNote };
}, { officer: true });
route('PUT', '/api/settings', ({ body, user }) => {
  const st = db.settings, int = (v) => Math.round(Number(v));
  const touchedKeys = Object.keys(body).filter((k) => st[k] !== undefined);
  if (body.lootFrom !== undefined) {
    const v = String(body.lootFrom || '');
    need(v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + 'T00:00:00'))), 400, 'Pick a valid date.');
    st.lootFrom = v;
  }
  if (body.lootThreshold !== undefined) {
    const v = int(body.lootThreshold);
    need(v >= 1 && v <= 100, 400, 'Attendance needed must be between 1 and 100.');
    st.lootThreshold = v;
  }
  if (body.lootRedMax !== undefined || body.lootOrangeMax !== undefined) {
    const r = int(body.lootRedMax ?? st.lootRedMax), o = int(body.lootOrangeMax ?? st.lootOrangeMax);
    need(r >= 0 && r < o && o <= 99, 400, 'Colour ranges need: red up to a lower number than orange, and orange up to at most 99 so green has a range.');
    st.lootRedMax = r; st.lootOrangeMax = o;
  }
  if (body.lootItemDays !== undefined) {
    const v = int(body.lootItemDays);
    need(v >= 1 && v <= 365, 400, 'The item period must be between 1 and 365 days.');
    st.lootItemDays = v;
  }
  if (body.pointsEnabled !== undefined) st.pointsEnabled = body.pointsEnabled === true || body.pointsEnabled === 'true';
  if (body.signupCloseDefault !== undefined) {
    const v = int(body.signupCloseDefault);
    need(v >= 0 && v <= 10080, 400, 'Sign-ups can close between 0 minutes and 7 days before the event.');
    st.signupCloseDefault = v;
  }
  if (body.pinOffsetMinutes !== undefined) {
    const v = int(body.pinOffsetMinutes);
    need(v >= -1440 && v <= 1440, 400, 'The PIN can be created between 24 hours before and 24 hours after the start.');
    st.pinOffsetMinutes = v;
  }
  if (body.pinWindowDefault !== undefined) {
    const v = int(body.pinWindowDefault);
    need(v >= 1 && v <= 720, 400, 'The PIN window must be between 1 and 720 minutes.');
    st.pinWindowDefault = v;
  }
  if (body.reminderMinutes !== undefined) {
    const list = (Array.isArray(body.reminderMinutes) ? body.reminderMinutes : []).map(int);
    need(list.every((v) => v >= 1 && v <= 10080) && list.length <= 6, 400, 'Reminders: up to 6 times, each between 1 minute and 7 days before the event.');
    st.reminderMinutes = [...new Set(list)].sort((a, b) => b - a);
  }
  if (body.remindersEnabled !== undefined) st.remindersEnabled = body.remindersEnabled === true || body.remindersEnabled === 'true';
  if (touchedKeys.length) audit.log(user, 'settings.update', { type: 'settings' }, `${user.name} changed guild settings: ${touchedKeys.join(', ')}.`);
  save();
  return st;
}, { officer: true });

// Loot log: which item a player received, and on which day it was handed out.
const findLoot = (id) => db.loot.find((l) => l.id === Number(id));
function pickLoot(b, existing) {
  const m = findMember(b.memberId ?? existing?.memberId);
  need(m, 404, 'Pick a player.');
  const type = String(b.type ?? existing?.type ?? LOOT_DEFAULT_TYPE);
  need(LOOT_TYPES.includes(type), 400, 'Pick a loot type: ' + LOOT_TYPES.join(', ') + '.');
  // Lucent is an amount, everything else is a named item.
  const item = type === 'Lucent' ? '' : clean(b.item ?? existing?.item, 120);
  const amount = type === 'Lucent' ? Math.round(num(b.amount ?? existing?.amount)) : 0;
  if (type === 'Lucent') need(amount >= 1 && amount <= 1e9, 400, 'Enter how much Lucent was given out.');
  else need(item, 400, 'Type the item that was given out.');
  const date = String(b.date ?? existing?.date ?? '').trim() || new Date().toISOString().slice(0, 10);
  need(/^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(new Date(date + 'T00:00:00')), 400, 'Pick a valid date.');
  // Both optional - how it was decided, and what it is for. Blank is a valid choice for either.
  const reason = clean(b.reason ?? existing?.reason, 40);
  need(!reason || LOOT_REASONS.includes(reason), 400, 'Pick one of the listed reasons, or leave it blank.');
  const purpose = clean(b.purpose ?? existing?.purpose, 40);
  need(!purpose || LOOT_PURPOSES.includes(purpose), 400, 'Pick one of the listed purposes, or leave it blank.');
  return { memberId: m.id, item, date, type, amount, reason, purpose };
}
route('POST', '/api/loot', ({ body, user }) => {
  const l = { id: newId(), ...pickLoot(body), by: user.name, at: new Date().toISOString() };
  db.loot.push(l);
  save();
  return l;
}, { officer: true });
route('PUT', '/api/loot/:id', ({ body, params }) => {
  const l = findLoot(params.id);
  need(l, 404, 'Entry not found.');
  Object.assign(l, pickLoot(body, l));
  save();
  return l;
}, { officer: true });
route('PUT', '/api/loot/:id/proof', ({ body, user, params }) => {
  const l = findLoot(params.id);
  need(l, 404, 'Entry not found.');
  const want = !!body.confirmed;
  if (want === !!l.proofConfirmed) return l;   // no-op, nothing to log
  l.proofConfirmed = want;
  l.proofConfirmedBy = want ? user.name : null;
  l.proofConfirmedAt = want ? new Date().toISOString() : null;
  save();
  const owner = findMember(l.memberId);
  audit.log(user, 'loot.proof', { type: 'loot', id: l.id, name: l.item || l.type }, `${user.name} ${want ? 'confirmed' : 'removed the confirmation of'} proof of use for "${l.item || l.type}" given to ${owner ? owner.name : '(removed)'}.`);
  return l;
}, { officer: true });
route('DELETE', '/api/loot/:id', ({ params }) => {
  const l = findLoot(params.id);
  need(l, 404, 'Entry not found.');
  db.loot = db.loot.filter((x) => x.id !== l.id);
  save();
  return { ok: true };
}, { officer: true });

// Party presets: saved line-ups (a set of named parties) that can be loaded into any event.
const findPreset = (id) => db.presets.find((p) => p.id === Number(id));
route('POST', '/api/presets', ({ body, user }) => {
  const name = clean(body.name, 60);
  need(name, 400, 'Give the preset a name.');
  const p = { id: newId(), name, description: clean(body.description, 200), parties: normParties(body.parties), createdBy: user.name, at: new Date().toISOString() };
  db.presets.push(p);
  audit.log(user, 'party.preset.create', { type: 'preset', id: p.id, name: p.name }, `${user.name} created the party preset "${p.name}".`);
  save();
  return p;
}, { officer: true });
route('PUT', '/api/presets/:id', ({ body, params, user }) => {
  const p = findPreset(params.id);
  need(p, 404, 'Preset not found.');
  if (body.name !== undefined) { p.name = clean(body.name, 60); need(p.name, 400, 'Give the preset a name.'); }
  if (body.description !== undefined) p.description = clean(body.description, 200);
  if (body.parties !== undefined) p.parties = normParties(body.parties);
  if (body.hidden !== undefined) p.hidden = body.hidden === true || body.hidden === 'true';
  audit.log(user, 'party.preset.update', { type: 'preset', id: p.id, name: p.name }, `${user.name} edited the party preset "${p.name}".`);
  save();
  return p;
}, { officer: true });
// Use a preset for every upcoming event of one type, and for future ones of that type too.
route('POST', '/api/presets/:id/use-for-type', ({ body, params }) => {
  const p = findPreset(params.id);
  need(p, 404, 'Preset not found.');
  const type = config.eventTypes.find((t) => t.name === body.type);
  need(type, 400, 'Pick an event type.');
  db.presetRules = db.presetRules.filter((r) => r.type !== type.name);
  db.presetRules.push({ type: type.name, presetId: p.id, at: new Date().toISOString() });
  let applied = 0, skipped = 0;
  for (const ev of db.events) {
    if (ev.type !== type.name || Date.parse(ev.start) <= Date.now()) continue;      // only events that have not started
    if (ev.parties.length && body.overwrite !== true) { skipped++; continue; }
    ev.parties = normParties(clone(p.parties));
    applied++;
  }
  save();
  return { applied, skipped, rules: db.presetRules };
}, { officer: true });
route('DELETE', '/api/preset-rules/:type', ({ params }) => {
  db.presetRules = db.presetRules.filter((r) => r.type !== params.type);
  save();
  return { ok: true };
}, { officer: true });

route('DELETE', '/api/presets/:id', ({ params, user }) => {
  const p = findPreset(params.id);
  need(p, 404, 'Preset not found.');
  db.presetRules = db.presetRules.filter((r) => r.presetId !== p.id);
  db.presets = db.presets.filter((x) => x.id !== p.id);
  audit.log(user, 'party.preset.delete', { type: 'preset', id: p.id, name: p.name }, `${user.name} deleted the party preset "${p.name}".`);
  save();
  return { ok: true };
}, { officer: true });

// Leadership tasks: what each leader is working on.
const findDuty = (id) => db.duties.find((d) => d.id === Number(id));
route('POST', '/api/duties', ({ body, user }) => {
  const m = findMember(body.memberId);
  need(m, 404, 'Character not found.');
  need(canEditMember(user, m), 403, 'You can only add tasks for your own characters.');
  need(LEADERSHIP.includes(m.rank), 400, 'Tasks can only be added to leadership ranks.');
  const text = clean(body.text, 140);
  need(text, 400, 'Write what the task is.');
  const d = { id: newId(), memberId: m.id, text, status: 'todo', at: new Date().toISOString(), by: user.name };
  db.duties.push(d);
  save();
  return d;
});
route('PUT', '/api/duties/:id', ({ body, user, params }) => {
  const d = findDuty(params.id);
  need(d, 404, 'Task not found.');
  need(canEditMember(user, findMember(d.memberId) || {}), 403, 'You can only edit tasks for your own characters.');
  if (body.text !== undefined) { d.text = clean(body.text, 140); need(d.text, 400, 'Write what the task is.'); }
  if (body.status !== undefined) { need(DUTY_STATUSES.includes(body.status), 400, 'Bad status.'); d.status = body.status; }
  d.at = new Date().toISOString();
  save();
  return d;
});
route('DELETE', '/api/duties/:id', ({ user, params }) => {
  const d = findDuty(params.id);
  need(d, 404, 'Task not found.');
  need(canEditMember(user, findMember(d.memberId) || {}), 403, 'You can only remove tasks for your own characters.');
  db.duties = db.duties.filter((x) => x.id !== d.id);
  save();
  return { ok: true };
});

// Backup / restore
route('GET', '/api/export', () => db, { officer: true });
// Everything the app stores. A backup contains all of it, and restoring one brings all of it back.
const DB_LISTS = ['members', 'events', 'points', 'duties', 'presets', 'presetRules', 'loot', 'series', 'changes', 'requests', 'tags', 'notices', 'leaves', 'warnings', 'explanations', 'applications', 'auditLog'];
const DB_MAPS = ['users', 'profiles', 'playerTags', 'prefs', 'noticeAcks'];
route('POST', '/api/import', ({ body }) => {
  need(body && Array.isArray(body.members) && Array.isArray(body.events) && Array.isArray(body.points), 400, 'Not a valid export file.');
  const fresh = { nextId: body.nextId || 1, settings: { ...SETTING_DEFAULTS, ...(body.settings || {}) }, infoBoard: body.infoBoard };
  for (const k of DB_LISTS) fresh[k] = Array.isArray(body[k]) ? body[k] : [];
  for (const k of DB_MAPS) fresh[k] = body[k] && typeof body[k] === 'object' && !Array.isArray(body[k]) ? body[k] : {};
  db = fresh;
  migrate();
  const maxId = Math.max(0, ...DB_LISTS.flatMap((k) => db[k]).map((x) => x.id || 0));
  db.nextId = Math.max(db.nextId, maxId + 1);
  save();
  return { ok: true };
}, { officer: true });

// ---------- attendance PIN, reminders and Discord messages ----------
const PIN_LENGTH = 4;
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const appUrl = () => discord.cfg.publicUrl || `http://localhost:${PORT}`;
const nameOfOwner = (id) => (db.users[id] && db.users[id].name) || id;

// Who receives the PIN: the leader of every party, everybody with a leadership rank, and Discord officers.
function pinRecipients(ev) {
  const out = new Map();
  const add = (id, why) => {
    if (!id) return;
    if (!out.has(id)) out.set(id, { id, name: nameOfOwner(id), reasons: [] });
    if (!out.get(id).reasons.includes(why)) out.get(id).reasons.push(why);
  };
  for (const p of ev.parties) { const m = p.leader && findMember(p.leader); if (m) add(m.owner, `leader of ${p.name}`); }
  for (const m of db.members) if (m.active && LEADERSHIP.includes(m.rank)) add(m.owner, 'leadership');
  for (const u of Object.values(db.users)) if (u.role === 'officer') add(u.id, 'leadership');
  return [...out.values()];
}

// Players who have not answered (Going or Can't) with any of their characters.
function reminderRecipients(ev) {
  const byOwner = new Map();
  for (const m of db.members) if (m.active) (byOwner.get(m.owner) || byOwner.set(m.owner, []).get(m.owner)).push(m);
  const out = [];
  for (const [owner, chars] of byOwner) if (!chars.some((m) => ev.rsvps[m.id] === 'yes' || ev.rsvps[m.id] === 'no') && !hooks.skipReminder.some((h) => h(owner, ev))) out.push({ id: owner, name: nameOfOwner(owner) });
  return out;
}

async function sendPinDMs(ev) {
  const results = [];
  for (const r of pinRecipients(ev)) {
    const end = unix(ev.pin.at) + ev.pinWindowMinutes * 60;
    const text = [
      `🔑 **Attendance PIN for ${ev.title}: ${ev.pin.code}**`,
      `The event starts <t:${unix(ev.start)}:F>. Players can type the PIN in on the event page from <t:${unix(ev.pin.at)}:t> until <t:${end}:t>.`,
      `You are getting this as ${r.reasons.join(' and ')}. Please tell it to your party. ${appUrl()}/#/events/${ev.id}`,
    ].join('\n');
    const res = await discord.sendDM(r.id, text);
    results.push({ id: r.id, name: r.name, why: r.reasons.join(', '), ok: !!res.ok, error: res.error || '' });
  }
  ev.pin.sent = results;
  ev.pin.sentAt = new Date().toISOString();
  save();
  console.log(`[pin] ${ev.title}: sent to ${results.filter((x) => x.ok).length}/${results.length} people`);
}

async function generatePin(ev, by) {
  const code = String(crypto.randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
  ev.pin = { code, at: new Date().toISOString(), by, sent: [] };
  for (const k of [...pinFails.keys()]) if (k.endsWith(':' + ev.id)) pinFails.delete(k);   // a new PIN starts with a clean slate
  save();                                                                                  // saved first, so a restart never makes a second PIN
  await sendPinDMs(ev);
}

async function runReminders(ev, now) {
  const st = db.settings;
  if (!st.remindersEnabled || ev.reminders === false) return;
  const start = Date.parse(ev.start);
  if (now >= start || now >= closeAt(ev)) return;                       // too late to answer anyway
  const offsets = [...st.reminderMinutes].sort((a, b) => b - a);
  const due = offsets.filter((m) => now >= start - m * 60000);
  if (!due.length) return;
  const latest = due[due.length - 1];                                   // if several are overdue (server was off) only send the newest
  const fresh = !ev.remindersSent[latest];
  for (const m of due) ev.remindersSent[m] = ev.remindersSent[m] || new Date().toISOString();
  save();
  if (!fresh) return;
  const number = offsets.indexOf(latest) + 1;
  const people = reminderRecipients(ev);
  const failed = [];
  const closeMs = closeAt(ev);
  for (const r of people) {
    const text = [
      `⏰ **Reminder ${number}/${offsets.length}:** you have not answered for **${ev.title}** yet.`,
      `It starts <t:${unix(ev.start)}:F> (<t:${unix(ev.start)}:R>). Sign-ups close <t:${Math.floor(closeMs / 1000)}:R>.`,
      `Tap a button below, or open the event here: ${appUrl()}/#/events/${ev.id}`,
    ].join('\n');
    // One-tap buttons alongside the link, for anyone who would rather not open the site at all right now. Both
    // point at the signed /rsvp/ page (see the request handler), which expires along with sign-ups.
    const buttons = discord.linkButtons([
      { label: '✅ Can come', url: `${appUrl()}/rsvp/${makeRsvpToken(ev.id, r.id, 'yes', closeMs)}` },
      { label: "❌ Can't come", url: `${appUrl()}/rsvp/${makeRsvpToken(ev.id, r.id, 'no', closeMs)}` },
    ]);
    const res = await discord.sendDM(r.id, text, null, buttons);
    if (!res.ok) failed.push({ id: r.id, name: r.name, error: res.error });
  }
  ev.reminderLog.push({ number, minutesBefore: latest, at: new Date().toISOString(), sent: people.length - failed.length, failed });
  save();
  console.log(`[reminder ${number}/${offsets.length}] ${ev.title}: ${people.length - failed.length}/${people.length} delivered`);
}

// An officer's own "Send reminder now" button - the same DM as the automatic schedule above (same recipients,
// same one-tap buttons), just triggered by hand instead of waiting on reminderMinutes/remindersEnabled. Useful
// for an event with reminders switched off, or just to nudge stragglers again before sign-ups close. Logged
// alongside the automatic entries (see automationPanel client-side), marked manual so the two read differently.
async function sendManualReminders(ev, by) {
  const people = reminderRecipients(ev);
  const failed = [];
  const closeMs = closeAt(ev);
  for (const r of people) {
    const text = [
      `⏰ **Reminder:** you have not answered for **${ev.title}** yet.`,
      `It starts <t:${unix(ev.start)}:F> (<t:${unix(ev.start)}:R>). Sign-ups close <t:${Math.floor(closeMs / 1000)}:R>.`,
      `Tap a button below, or open the event here: ${appUrl()}/#/events/${ev.id}`,
    ].join('\n');
    const buttons = discord.linkButtons([
      { label: '✅ Can come', url: `${appUrl()}/rsvp/${makeRsvpToken(ev.id, r.id, 'yes', closeMs)}` },
      { label: "❌ Can't come", url: `${appUrl()}/rsvp/${makeRsvpToken(ev.id, r.id, 'no', closeMs)}` },
    ]);
    const res = await discord.sendDM(r.id, text, null, buttons);
    if (!res.ok) failed.push({ id: r.id, name: r.name, error: res.error });
  }
  ev.reminderLog.push({ number: 'manual', manual: true, by, at: new Date().toISOString(), sent: people.length - failed.length, failed });
  save();
  console.log(`[reminder manual, by ${by}] ${ev.title}: ${people.length - failed.length}/${people.length} delivered`);
  return { sent: people.length - failed.length, total: people.length, failed };
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const ev of [...db.events]) {
      const now = Date.now(), start = Date.parse(ev.start);
      if (start < now - 24 * 36e5) continue;
      // Follows this event's own PIN switch, not Mandatory directly - it defaults to match Mandatory, but an
      // officer can turn it on for an optional event (or off for a mandatory one) independently; see pickEvent.
      // Either way, an officer can still always create and send one by hand ("Create and send PIN now" on the
      // event), which has no check of its own, so this only changes what happens with nobody touching it.
      if (!ev.pin && !ev.pinSkip && ev.pinEnabled && now >= start + db.settings.pinOffsetMinutes * 60000) await generatePin(ev, 'automatic');
      // An event that does not use the attendance PIN has nobody confirming they actually showed up unless an
      // officer remembers to tick the Attendance box by hand - which leaves everyone who said "Going" wrongly
      // looking like a no-show. Once the event is comfortably over (the same delay compliance uses to judge
      // no-shows), count them as attended automatically instead. This runs once per event (autoAttended) and
      // never again once an officer has recorded attendance by hand, so a deliberate correction always sticks.
      if (!ev.pinEnabled && !ev.autoAttended && now >= start + db.settings.compliance.finalAfterMinutes * 60000) {
        const going = Object.entries(ev.rsvps).filter(([, s]) => s === 'yes').map(([id]) => Number(id));
        const before = ev.attended.length;
        ev.attended = [...new Set([...ev.attended, ...going])];
        ev.autoAttended = true;
        if (ev.attended.length !== before) syncAttendancePoints(ev);
        save();
      }
      await runReminders(ev, Date.now());
    }
    for (const h of tickHooks) await h();
  } catch (e) { console.error('scheduler:', e); }
  ticking = false;
}
const SCHEDULER_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 30000);
setInterval(tick, SCHEDULER_MS);
setTimeout(tick, Math.min(5000, SCHEDULER_MS));

// Players type the PIN in during the window; a correct PIN marks that character as having attended.
const pinFails = new Map();
route('POST', '/api/events/:id/pin', ({ body, user, params }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  const m = findMember(body.memberId);
  need(m, 404, 'Pick one of your characters.');
  need(canEditMember(user, m), 403, 'You can only enter the PIN for your own characters.');
  need(ev.pin, 409, 'The PIN has not been sent out yet.');
  const opens = Date.parse(ev.pin.at), closes = opens + ev.pinWindowMinutes * 60000;
  need(Date.now() <= closes, 409, 'The PIN window is closed. Ask an officer to mark your attendance.');
  const fk = `${user.key}:${ev.id}`, fails = pinFails.get(fk) || 0;
  need(fails < 5, 429, 'Too many wrong PINs. Ask an officer to mark your attendance.');
  if (!safeEqual(String(body.pin ?? '').trim(), ev.pin.code)) {
    pinFails.set(fk, fails + 1);
    throw new HttpError(400, `Wrong PIN. ${4 - fails} ${4 - fails === 1 ? 'try' : 'tries'} left.`);
  }
  if (!ev.attended.includes(m.id)) { ev.attended.push(m.id); syncAttendancePoints(ev); }
  ev.pinEntries[m.id] = { at: new Date().toISOString(), by: user.name };
  save();
  return { ok: true };
});
route('POST', '/api/events/:id/pin/send', async ({ body, params, user }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  // "Reopen" restarts the same window (and clears anyone's wrong-PIN strikes) without handing out a new code -
  // for when the window simply closed too soon (people arrived late, say) and party leaders already have the
  // code written down, so there is no need to make them relay a fresh one. Checked first, and strictly: it must
  // never fall through to creating a brand new PIN just because none exists yet.
  if (body.mode === 'reopen') {
    need(ev.pin, 409, 'There is no PIN for this event yet.');
    ev.pin.at = new Date().toISOString();
    for (const k of [...pinFails.keys()]) if (k.endsWith(':' + ev.id)) pinFails.delete(k);
    audit.log(user, 'event.pin.reopen', { type: 'event', id: ev.id, name: ev.title }, `${user.name} reopened the attendance PIN window for "${ev.title}".`);
    save();
  }
  else if (!ev.pin || body.mode === 'new') await generatePin(ev, user.name);
  else await sendPinDMs(ev);
  return eventFor(ev, user);
}, { officer: true });

// Lets an officer nudge stragglers on demand - does not wait on the configured schedule or care whether
// reminders are switched off for this event, and can be used as many times as wanted.
route('POST', '/api/events/:id/reminders/send', async ({ params, user }) => {
  const ev = findEvent(params.id);
  need(ev, 404, 'Event not found.');
  need(Date.now() < Date.parse(ev.start), 409, 'This event has already started.');
  const result = await sendManualReminders(ev, user.name);
  audit.log(user, 'event.reminder.send', { type: 'event', id: ev.id, name: ev.title }, `${user.name} manually sent a reminder for "${ev.title}" to ${result.sent}/${result.total} player(s).`);
  return eventFor(ev, user);
}, { officer: true });

// The "send reminders for all of today's events" button - the client works out which events share a calendar
// day (in the viewer's own time zone) and are still upcoming, and hands over just those ids; the server only
// has to trust that list and re-check each one is still actually upcoming before nudging it, same as the
// single-event button above.
route('POST', '/api/events/reminders/send-many', async ({ body, user }) => {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const events = ids.map((id) => findEvent(id)).filter((ev) => ev && Date.now() < Date.parse(ev.start));
  need(events.length, 409, 'None of those events can be reminded any more (already started).');
  let sent = 0, total = 0;
  for (const ev of events) {
    const result = await sendManualReminders(ev, user.name);
    sent += result.sent; total += result.total;
    audit.log(user, 'event.reminder.send', { type: 'event', id: ev.id, name: ev.title }, `${user.name} manually sent a reminder for "${ev.title}" to ${result.sent}/${result.total} player(s) (sent together with ${events.length - 1} other event${events.length === 2 ? '' : 's'} that day).`);
  }
  return { events: events.length, sent, total };
}, { officer: true });

// Admin helpers
route('POST', '/api/admin/test-dm', async ({ user }) => {
  const res = await discord.sendDM(user.key, '✅ Guild Hall can send you direct messages. PINs and reminders will arrive like this.');
  return { ok: !!res.ok, error: res.error || '', bot: discord.botEnabled };
}, { officer: true });
// Characters created before Discord sign-in belong to a display name. This links them to a Discord player.
route('POST', '/api/admin/link-owner', ({ body, user }) => {
  const from = clean(body.from, 40), to = clean(body.to, 40);
  need(from && db.users[to], 400, 'Pick the old name and a player who has signed in with Discord.');
  let n = 0;
  for (const m of db.members) if (m.owner === from) { m.owner = to; n++; }
  for (const ev of db.events) if (ev.createdBy === from) ev.createdBy = to;
  audit.log(user, 'owner.link', { type: 'player', id: to, name: db.users[to].name }, `${user.name} linked ${n} character(s) owned by "${from}" to the Discord player ${db.users[to].name}.`);
  save();
  return { moved: n };
}, { officer: true });

// ---------- Shotcaller control panel (officer-only proxy to the separate Shotcaller bot's HTTP API) ----------
// Required before server-features/server-community below, which need its returned helpers (shotcallerApi) to
// let "Post to Discord" also start a session - see server-community.js's post-parties route.
const shotcallerApi = require('./server-shotcaller')({
  route, need, HttpError, save, isOfficer, audit: audit.log,
  shotcaller: { url: SHOTCALLER_URL, apiKey: SHOTCALLER_API_KEY, get guildId() { return discord.cfg.guildId; } },
  get db() { return db; },
});

// ---------- more features (approvals, profiles, builds, requests, tags, recurring events, branding) ----------
require('./server-features')({
  route, need, HttpError, clean, num, newId, save, config, discord, isOfficer, isCoach, canEditMember, findMember, findEvent, normParties, applyPresetRule,
  eventFor, safeEqual, pickMember, pickEvent, pickOwner, cleanUrl, cleanLinks, syncAttendancePoints, dropFromParty, hooks, tickHooks, clone, appUrl, nameOfOwner,
  LOOT_TYPES, LOOT_DEFAULT_TYPE, SETTING_DEFAULTS, UPLOAD_DIR, publicBranding, audit: audit.log, shotcallerApi, partyIsPlaceholder,
  get db() { return db; },
});

// ---------- server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
  });
}

const send = (res, status, data, headers = {}) => {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  // Health check for Docker / a load balancer: no auth, no DB access, just "the process is alive and serving".
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Sign in with Discord
  if (url.pathname === '/auth/discord' && req.method === 'GET') {
    if (!discord.loginEnabled) { res.writeHead(302, { Location: '/?loginError=' + encodeURIComponent('Discord sign-in is not set up on this server.') }); return res.end(); }
    const state = crypto.randomBytes(16).toString('hex');
    // ?merc=1 (from a mercenary-signup link) is remembered the same way the CSRF state is, across the trip to
    // Discord and back, so the callback below can let this one sign-in through even if general guild
    // applications are switched off - joining for one event as a mercenary is a different thing from applying.
    // ?guestcoach=1 (from the guest-coach invite link in Admin) works the same way, for someone outside the
    // guild who is only ever there to review VODs for one class, never a member in any other sense.
    const cookies = [cookieHeader('gh_oauth', state, 600)];
    if (url.searchParams.get('merc') === '1') cookies.push(cookieHeader('gh_merc', '1', 600));
    if (url.searchParams.get('guestcoach') === '1') cookies.push(cookieHeader('gh_guestcoach', '1', 600));
    res.writeHead(302, { Location: discord.authorizeUrl(state), 'Set-Cookie': cookies });
    return res.end();
  }
  if (url.pathname === '/auth/discord/callback' && req.method === 'GET') {
    const fail = (msg) => { res.writeHead(302, { Location: '/?loginError=' + encodeURIComponent(msg), 'Set-Cookie': [cookieHeader('gh_oauth', '', 0), cookieHeader('gh_merc', '', 0), cookieHeader('gh_guestcoach', '', 0)] }); res.end(); };
    try {
      if (!discord.loginEnabled) return fail('Discord sign-in is not set up on this server.');
      if (url.searchParams.get('error')) return fail('Discord sign-in was cancelled.');
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      if (!state || !code || !safeEqual(state, cookieOf(req, 'gh_oauth'))) return fail('The sign-in link expired. Please try again.');
      const merc = cookieOf(req, 'gh_merc') === '1';
      const guestCoachLink = cookieOf(req, 'gh_guestcoach') === '1';
      const u = await discord.resolveUser(code);
      const known = db.users[u.id];
      // A guest coach is never a guild member, in any sense - whether they arrived just now via the invite
      // link or are signing back in afterwards, they always land as an applicant with nothing beyond coaching
      // access for their chosen class (picked once they land on the guest-coach page - see /api/guest-coaches).
      const isGuestCoach = db.guestCoaches.some((g) => g.discordId === u.id);
      // A kicked player is sent to the application page like anyone new, regardless of their Discord role or
      // having been accepted before - overrides everything else below. Accepting a fresh application from
      // them clears this (see /api/applications/:id), which is the only way back in.
      if (known && known.kicked) { u.role = 'applicant'; u.whyNot = 'You were removed from the guild. You can send a new application below.'; }
      else if (u.role === 'applicant' && known && known.accepted) u.role = 'member';           // accepted earlier: in, even if they never joined the Discord server
      // Officer status can also be granted in Admin > Officers, without editing .env or restarting the server -
      // by a specific Discord role (on top of DISCORD_OFFICER_ROLE_IDS) or a specific player directly.
      const kicked = known && known.kicked;
      const { officerRoleIds: xRoles, officerUserIds: xUsers, coachRoleIds, coachUserIds } = db.settings;
      if (!kicked && u.role !== 'officer' && (xUsers.includes(u.id) || (u.roles || []).some((r) => xRoles.includes(r)))) u.role = 'officer';
      // A coach is a separate, narrower flag, not a role - someone can be a normal member and a coach, or an
      // officer and a coach, at the same time. Neither this nor officer status above can override a kick -
      // being in either list from before does not let a kicked player back in through the side door.
      const isCoach = !kicked && (coachUserIds.includes(u.id) || (u.roles || []).some((r) => coachRoleIds.includes(r)) || isGuestCoach);
      if (u.role === 'applicant' && !merc && !guestCoachLink && !isGuestCoach && !db.settings.applications.enabled) return fail(u.whyNot);
      db.users[u.id] = { ...(known || {}), id: u.id, name: u.name, username: u.username, avatar: u.avatar, role: u.role, inGuild: u.inGuild, applicant: u.role === 'applicant', coach: isCoach, discordRoles: Array.isArray(u.roles) ? u.roles : (known?.discordRoles || []), lastLogin: new Date().toISOString() };
      save();
      const token = makeToken({ key: u.id, name: u.name, username: u.username, avatar: u.avatar, role: u.role, coach: isCoach, discord: true }, 7);
      res.writeHead(302, { Location: '/', 'Set-Cookie': [cookieHeader(SESSION_COOKIE, token, 7 * 86400), cookieHeader('gh_oauth', '', 0), cookieHeader('gh_merc', '', 0), cookieHeader('gh_guestcoach', '', 0)] });
      return res.end();
    } catch (e) { return fail(e.message || 'Sign-in failed.'); }
  }

  // A tap from the "Can come" / "Can't come" buttons on a reminder DM - no login, the token is the proof. A
  // small standalone page, not the app shell, since the whole point is not needing to open the website.
  if (url.pathname.startsWith('/rsvp/') && req.method === 'GET') {
    const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const page = (title, body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title}</title><style>body{background:#0e0a0c;color:#ebe5e3;font:17px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
      .card{max-width:420px}h1{font-size:22px;margin:0 0 10px}p{color:#a39499;margin:0 0 6px}a{color:#e7879a}</style></head>
      <body><div class="card"><h1>${title}</h1>${body}</div></body></html>`);
    };
    const t = readRsvpToken(url.pathname.slice('/rsvp/'.length));
    if (!t) { page('This link has expired', '<p>Reminder links stop working once sign-ups close for that event. Open the site to answer instead.</p>'); return; }
    const ev = findEvent(t.e);
    if (!ev) { page('Event not found', '<p>This event may have been deleted.</p>'); return; }
    const m = db.members.find((x) => x.owner === t.o && x.active);
    if (!m) { page('Character not found', '<p>We could not find your character. Open the site to answer instead.</p>'); return; }
    if (Date.now() >= closeAt(ev)) { page('Sign-ups are closed', `<p>Sign-ups for <b>${escHtml(ev.title)}</b> already closed.</p>`); return; }
    if (t.a === 'yes' && ev.maxSignups) {
      const going = Object.entries(ev.rsvps).filter(([id, s]) => s === 'yes' && Number(id) !== m.id).length;
      if (going >= ev.maxSignups) { page('This event is full', `<p><b>${escHtml(ev.title)}</b> has no open spots left. Open the site to see where you stand.</p>`); return; }
    }
    ev.rsvps[m.id] = t.a;
    save();
    page(t.a === 'yes' ? "You're marked as Going" : "You're marked as Can't come", `<p><b>${escHtml(m.name)}</b> for <b>${escHtml(ev.title)}</b>. Changed your mind? <a href="${appUrl()}/#/events/${ev.id}">Open the event</a> any time.</p>`);
    return;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0) });
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      need(r, 404, 'Not found.');
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let user = null;
      if (r.auth) {
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        user = readToken(bearer || cookieOf(req, SESSION_COOKIE));
        need(user, 401, 'Please sign in.');
        // Keep session flags in sync with the persisted user record. Admin coach assignments can
        // change while someone is already signed in, so the signed session must not retain a stale
        // `coach` value until the next Discord login.
        if (user.key && db.users[user.key]) {
          user.coach = !!db.users[user.key].coach;
        } else if (!discord.loginEnabled) {
          // Passcode mode has no persisted db.users record to re-check against (sign-in never writes one),
          // so the setting itself is the live source of truth here instead.
          user.coach = db.settings.coachUserIds.includes(user.key);
        }
        // Somebody whose application was accepted since they signed in is a member from now on, without signing in again.
        if (user.role === 'applicant' && db.users[user.key] && db.users[user.key].accepted) user.role = 'member';
        if (!bearer && req.method !== 'GET') {           // cookie sessions: block requests that other websites could trigger
          need(/application\/json/i.test(req.headers['content-type'] || ''), 415, 'Send JSON.');
          need(!req.headers.origin || (() => { try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; } })(), 403, 'Cross-site request blocked.');
        }
        need(!r.officer || isOfficer(user), 403, 'Officers only.');
        need(user.role !== 'applicant' || r.applicant, 403, 'Your application has to be accepted first.');       // applicants can reach nothing but the application
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, url.pathname === '/api/admin/upload' || /\/post-parties$/.test(url.pathname) ? 9e6 : 2e6);
      const out = await r.handler({ body, user, params, ip, query: Object.fromEntries(url.searchParams) });
      return send(res, 200, out, url.pathname === '/api/export'
        ? { 'Content-Disposition': 'attachment; filename="guild-backup.json"' } : {});
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    }
  }

  // uploaded images (guild icon, background). File names are content hashes, so they can be cached forever.
  const up = url.pathname.match(/^\/uploads\/([a-z]+-[a-f0-9]{12}\.(png|jpg|gif|webp))$/);
  if (up) {
    const f = path.join(UPLOAD_DIR, up[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[up[2]], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    return fs.createReadStream(f).pipe(res);
  }

  // static files
  let file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}).listen(...(HOST ? [PORT, HOST] : [PORT]), () => {
  console.log(`Guild Hall running on http://${HOST || 'localhost'}:${PORT}`);
  console.log(discord.loginEnabled ? `Sign-in: Discord (redirect URI ${discord.redirectUri()})` : 'Sign-in: shared passcodes (demo mode)');
  console.log(discord.botEnabled ? 'Discord bot: on (PINs and reminders are sent as direct messages)' : 'Discord bot: off (PINs and reminders are only written to this log)');
});

// Optional auto-update: when AUTO_UPDATE_MINUTES is set and this folder is a git checkout, look for new
// commits on the remote. When there are some, exit with code 75; the start scripts then run `git pull`
// and start the server again. Only outgoing connections are used, so it works behind a home router.
const AUTO_UPDATE_MINUTES = Number(process.env.AUTO_UPDATE_MINUTES || 0);
if (AUTO_UPDATE_MINUTES > 0 && fs.existsSync(path.join(__dirname, '.git'))) {
  const { execFile } = require('child_process');
  const git = (args) => new Promise((resolve) => execFile('git', args, { cwd: __dirname, timeout: 60000 }, (err, out) => resolve(err ? null : String(out).trim())));
  const check = async () => {
    if ((await git(['fetch', '--quiet'])) === null) return;              // offline or no remote: try again later
    const behind = Number(await git(['rev-list', '--count', 'HEAD..@{u}']));
    if (behind > 0) { console.log(`Update found (${behind} new commit${behind === 1 ? '' : 's'}). Restarting to apply it...`); shutdown(75); }
  };
  setTimeout(check, 15000);
  setInterval(check, AUTO_UPDATE_MINUTES * 60e3);
  console.log(`Auto-update is on: checking for new code every ${AUTO_UPDATE_MINUTES} minute(s).`);
}
