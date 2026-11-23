'use strict';
// Periodic, authoritative refresh of stored Discord roles (GuildHub 1.46.2-hotfix.2).
//
// Stored `db.users[key].discordRoles` / `inGuild` are only as good as the moment they were read. This module
// re-reads them with the bot token (GET /guilds/{DISCORD_GUILD_ID}/members/{id}) for everybody who signed in
// within the last 30 days, and tracks when each key's roles were last known authoritatively, so that
// Discord-ROLE-derived privileges (officer-by-role, coach-by-role) can be suspended once that knowledge is older
// than maxStaleMs (see contract: "Role freshness").
//
// Rules:
//  - 200            -> store discordRoles + inGuild:true, mark checked
//  - 404 code 10007 -> inGuild:false, discordRoles:[], mark checked (authoritative: left the server)
//  - 429            -> stop this tick, no data change, do not start another tick before retry_after
//  - anything else  -> no data change, not checked (privileges simply age out after maxStaleMs)
// Log lines carry counts and reason codes only - never ids, names or tokens.

const SNOWFLAKE = /^\d{15,25}$/;
const DAY = 86400e3;
const ACTIVE_WINDOW_MS = 30 * DAY;   // longest session lifetime
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rolesOf = (v) => (Array.isArray(v) ? v.map(String) : []);
const sameRoles = (a, b) => { const x = [...new Set(rolesOf(a))].sort(), y = [...new Set(rolesOf(b))].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
const snapshot = (rec) => ({ discordRoles: rolesOf(rec && rec.discordRoles), inGuild: !!(rec && rec.inGuild === true) });

function defaultMaxStaleMs() {
  const m = Number(process.env.ROLE_MAX_STALE_MINUTES);
  return Number.isFinite(m) && m > 0 ? m * 60e3 : 3600e3;
}

function createRoleRefresh({ discord, getDb, save = () => {}, now = Date.now, intervalMs = 600000, maxStaleMs, log = console, onChange = () => {}, delayMs = 250, guildId } = {}) {
  if (!discord || typeof getDb !== 'function') throw new TypeError('createRoleRefresh needs discord and getDb');
  const staleMs = Number.isFinite(maxStaleMs) && maxStaleMs > 0 ? maxStaleMs : defaultMaxStaleMs();
  const guild = () => guildId || (discord.cfg && discord.cfg.guildId) || '';
  const checked = new Map();          // key -> ms of last successful authoritative check
  let timer = null, running = null, blockedUntil = 0;
  let last = { checked: 0, changed: 0, notMember: 0, failed: 0, rateLimited: 0, skipped: 0, failures: {}, lastSuccessAt: null, lastTickAt: null };
  let lastSuccessAt = null;

  function freshness(key) {
    const k = String(key);
    const rec = (getDb().users || {})[k];
    const login = rec && rec.lastLogin ? Date.parse(rec.lastLogin) : NaN;
    return Math.max(checked.get(k) || 0, Number.isFinite(login) ? login : 0);
  }
  const isFresh = (key) => { const f = freshness(key); return f > 0 && now() - f <= staleMs; };

  function candidates() {
    const t = now(), users = getDb().users || {};
    return Object.keys(users)
      .filter((k) => SNOWFLAKE.test(k))
      .filter((k) => { const l = Date.parse(users[k] && users[k].lastLogin); return Number.isFinite(l) && t - l <= ACTIVE_WINDOW_MS; })
      .sort((a, b) => freshness(a) - freshness(b));   // least recently known first, so a 429 never starves the tail
  }

  async function runTick() {
    const stats = { checked: 0, changed: 0, notMember: 0, failed: 0, rateLimited: 0, skipped: 0, failures: {}, lastSuccessAt, lastTickAt: now() };
    const g = guild();
    if (!discord.botEnabled || !SNOWFLAKE.test(String(g))) { stats.skipped = 1; last = stats; return stats; }
    if (now() < blockedUntil) { stats.rateLimited = 1; stats.skipped = 1; last = stats; return stats; }
    let dirty = false, first = true;
    for (const key of candidates()) {
      if (!first && delayMs > 0) await sleep(delayMs);
      first = false;
      let r;
      try { r = await discord.guildMember(g, key); } catch { r = { ok: false, kind: 'error' }; }
      if (!r || typeof r !== 'object') r = { ok: false, kind: 'error' };
      if (r.kind === 'rate_limited') {
        stats.rateLimited = 1;
        const ra = Number(r.retryAfter);
        blockedUntil = now() + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 1) * 1000;
        break;
      }
      const rec = (getDb().users || {})[key];   // re-read: the record may have been replaced while we waited
      if (!rec) continue;
      let after;
      if (r.ok === true && Array.isArray(r.roles)) after = { discordRoles: r.roles.map(String), inGuild: true };
      else if (r.kind === 'not_member') after = { discordRoles: [], inGuild: false };
      else { stats.failed++; const k = String(r.kind || 'error'); stats.failures[k] = (stats.failures[k] || 0) + 1; continue; }
      const before = snapshot(rec);
      stats.checked++;
      if (r.kind === 'not_member') stats.notMember++;
      checked.set(key, now());
      lastSuccessAt = now();
      stats.lastSuccessAt = lastSuccessAt;
      if (sameRoles(before.discordRoles, after.discordRoles) && before.inGuild === after.inGuild) {
        // same meaning; only normalise a missing/odd stored value (e.g. inGuild undefined -> false) quietly
        if (rec.inGuild !== after.inGuild || !Array.isArray(rec.discordRoles)) { rec.inGuild = after.inGuild; rec.discordRoles = after.discordRoles; dirty = true; }
        continue;
      }
      rec.discordRoles = after.discordRoles;
      rec.inGuild = after.inGuild;
      dirty = true; stats.changed++;
      try { onChange(key, before, { discordRoles: [...after.discordRoles], inGuild: after.inGuild }); }
      catch { stats.failures.onChange = (stats.failures.onChange || 0) + 1; }
    }
    if (dirty) { try { save(); } catch { stats.failures.save = (stats.failures.save || 0) + 1; } }
    last = stats;
    if (stats.changed || stats.failed || stats.rateLimited) {
      const reasons = Object.entries(stats.failures).map(([k, v]) => `${k}=${v}`).join(',') || 'none';
      const line = `role refresh: checked=${stats.checked} changed=${stats.changed} notMember=${stats.notMember} failed=${stats.failed} rateLimited=${stats.rateLimited} reasons=${reasons}`;
      try { (stats.failed || stats.rateLimited ? (log.warn || log.log) : log.log).call(log, line); } catch { /* logging must never break the refresh */ }
    }
    return stats;
  }

  // At most one tick at a time; a second call while one runs returns the running tick.
  function tick() {
    if (running) return running;
    running = runTick().catch(() => { last = { ...last, failed: last.failed + 1 }; return last; }).finally(() => { running = null; });
    return running;
  }

  // The first tick runs after one interval, not immediately: a just-started server already has fresh
  // roles from sign-in (lastLogin), and an immediate burst of lookups on every restart is pointless.
  function start({ immediate = false } = {}) {
    if (timer) return;
    timer = setInterval(() => { tick(); }, intervalMs);
    if (timer.unref) timer.unref();
    if (immediate) tick();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  const stats = () => ({ checked: last.checked, changed: last.changed, notMember: last.notMember, failed: last.failed, rateLimited: last.rateLimited, failures: { ...last.failures }, lastSuccessAt, lastTickAt: last.lastTickAt, running: !!running });

  return { freshness, isFresh, tick, start, stop, stats, maxStaleMs: staleMs };
}

module.exports = { createRoleRefresh };
