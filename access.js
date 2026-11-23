// Hotfix 1.46.2.2 (F-A): live, server-side authorization.
//
// The signed session cookie only proves WHO someone is (key) and which session it is. WHAT they may do is decided
// here on every request from the current data: the kick flag, the officer lists (env + Admin), the coach lists,
// guest coaches, accepted applications and the Discord roles kept fresh by role-refresh.js. A `role`, `coach` or
// `allianceRoles` value inside a token is never trusted any more (SA-01..SA-04).
//
// Discord-ROLE-derived privileges (officer by role, coach by role) additionally require that the stored roles are
// fresh (`isFresh(key)`, role-refresh.js): after ROLE_MAX_STALE_MINUTES without a successful Discord check they are
// suspended - not deleted - until the next successful check or sign-in. Officers named by user id in
// DISCORD_OFFICER_USER_IDS or in Admin > Officers do not depend on Discord and are unaffected.
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function createAccess({ getDb, discord, env = process.env, isFresh = () => true }) {
  const envOfficerUsers = () => discord.cfg.officerUserIds || csv(env.DISCORD_OFFICER_USER_IDS);
  const envOfficerRoles = () => discord.cfg.officerRoleIds || csv(env.DISCORD_OFFICER_ROLE_IDS);
  const memberRoleId = () => discord.cfg.memberRoleId || '';
  const settings = () => getDb().settings || {};
  const listOf = (v) => (Array.isArray(v) ? v.map(String) : []);
  const rolesOf = (rec) => (rec && Array.isArray(rec.discordRoles) ? rec.discordRoles.map(String) : []);

  const isGuestCoach = (key) => (getDb().guestCoaches || []).some((g) => g && g.discordId === key);

  // Officer purely by user id (env or Admin list) - independent of Discord.
  const officerById = (key) => envOfficerUsers().includes(key) || listOf(settings().officerUserIds).includes(key);
  // Officer by Discord role - only while the stored roles are fresh.
  function officerByRole(key, rec) {
    if (!isFresh(key)) return false;
    const roles = new Set([...envOfficerRoles(), ...listOf(settings().officerRoleIds)]);
    return rolesOf(rec).some((r) => roles.has(r));
  }

  // Own-property lookup only: a key such as "constructor" or "__proto__" must never resolve to Object.prototype.
  const recordOf = (key) => { const users = getDb().users || {}; return typeof key === 'string' && Object.prototype.hasOwnProperty.call(users, key) && users[key] && typeof users[key] === 'object' ? users[key] : null; };

  // The authoritative decision for one Discord account. Pure read; never mutates data.
  function decide(key) {
    const rec = recordOf(key);
    if (!rec) return null;
    if (rec.kicked) return { role: 'applicant', coach: false, kicked: true };       // application page only (D-4)
    const officer = officerById(key) || officerByRole(key, rec);
    const mr = memberRoleId();
    // Confirmed Discord departure revokes membership even after an accepted application.
    const member = officer || (!discord.loginEnabled && !!rec.accepted) || (!!rec.inGuild && (!!rec.accepted || !mr || rolesOf(rec).includes(mr)));
    const st = settings();
    const coach = (member || !discord.loginEnabled || isGuestCoach(key)) && (listOf(st.coachUserIds).includes(key)
      || (isFresh(key) && rolesOf(rec).some((r) => listOf(st.coachRoleIds).includes(r)))
      || isGuestCoach(key));
    return { role: officer ? 'officer' : member ? 'member' : 'applicant', coach, kicked: false };
  }

  const isOfficerKey = (key) => { const d = decide(String(key)); return !!d && d.role === 'officer'; };
  const isActiveCoach = (key) => { const d = decide(String(key)); return !!d && !d.kicked && d.coach && (!discord.loginEnabled || d.role !== 'applicant' || isGuestCoach(String(key))); };
  const officerKeys = () => Object.keys(getDb().users || {}).filter((k) => isOfficerKey(k));

  // payload = verified, unexpired, unrevoked token payload. Returns the request user or null (= 401).
  function resolve(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const rawKey = payload.key ?? payload.name;
    if (typeof rawKey !== 'string' && typeof rawKey !== 'number') return null;
    const key = String(rawKey);
    if (!key || key.length > 64) return null;
    if (payload.support) return { ...payload, key, role: 'officer', coach: false, readOnly: true };   // support-grants decide validity (unchanged)
    if (payload.role === 'alliance') {
      // An Alliance session is only ever issued for the configured partner server; anything else is not a session.
      const partnerGuild = String(env.ALLIANCE_GUILD_ID || '');
      if (!partnerGuild || String(payload.allianceGuildId || '') !== partnerGuild || !/^\d{15,25}$/.test(key)) return null;
      // Partner rights are re-verified per request against the partner Discord server (alliance-policy.verifyPartner).
      return { key, name: String(payload.name || ''), discord: true, role: 'alliance', allianceGuildId: payload.allianceGuildId, coach: false, readOnly: false };
    }
    if (!discord.loginEnabled) {
      // Passcode / demo mode: no Discord accounts exist; the passcode decided the role at sign-in (unchanged).
      return { ...payload, key, coach: listOf(settings().coachUserIds).includes(key), readOnly: false };
    }
    if (!payload.discord) return null;
    const d = decide(key);
    if (!d) return null;                                                 // no account record any more
    const rec = recordOf(key);
    return { key, name: String(rec.name || payload.name || ''), username: rec.username || payload.username || '', avatar: rec.avatar || payload.avatar || '',
      discord: true, role: d.role, coach: d.coach, kicked: d.kicked, readOnly: false, sid: payload.sid };
  }

  return { resolve, decide, isOfficerKey, isActiveCoach, officerKeys, isGuestCoach, officerById };
}

module.exports = { createAccess };
