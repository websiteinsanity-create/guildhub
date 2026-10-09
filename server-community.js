// Guild applications and Discord tools for Guild Hall.
//   - people who are not in the guild sign in with Discord and can only send an application
//   - the leadership accepts or rejects it; accepting makes them a member and creates their character
//   - the Discord connection check, the invite link for the bot, the channel for party pictures
//   - "Post to Discord": the picture of the parties of an event goes into a channel

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

module.exports = function install(ctx) {
  const { route, need, clean, newId, save, config, discord, isOfficer, pickMember, findEvent, findMember, appUrl, audit, shotcallerApi, partyIsPlaceholder } = ctx;
  const db = () => ctx.db;
  const now = () => new Date().toISOString();
  const yes = (v) => v === true || v === 'true';
  const notify = (owner, text) => { discord.sendDM(owner, text).catch(() => {}); };
  const httpUrl = (v) => { const u = clean(v, 300); need(u === '' || /^https?:\/\/[^\s<>"']+$/i.test(u), 400, 'Links must start with http:// or https://'); return u; };

  // ---------------------------------------------------------------- applications
  const latestFor = (key) => db().applications.filter((a) => a.userKey === key).sort((a, b) => b.at.localeCompare(a.at))[0] || null;

  route('POST', '/api/applications', ({ body, user }) => {
    const D = db();
    need(user.role === 'applicant', 409, 'You are already a member.');
    need(D.settings.applications.enabled, 403, 'Applications are closed right now.');
    need(!D.applications.some((a) => a.userKey === user.key && a.status === 'pending'), 409, 'You already have an application waiting.');
    const character = pickMember({
      name: body.characterName, role: body.role, primaryWeapon: body.primaryWeapon, secondaryWeapon: body.secondaryWeapon,
      gearScore: body.gearScore, level: body.level, specialization: body.specialization,
      questlogs: body.questlogs !== undefined ? body.questlogs : body.questlog ? [{ label: 'Questlog', url: body.questlog }] : [],
      discord: user.username || '', timezone: '', notes: '', active: true,
    });
    const about = clean(body.about, 1000);
    need(about.length >= 10, 400, 'Please tell us a little about yourself (a sentence or two).');
    const a = { id: newId(), userKey: user.key, name: user.name, username: user.username || '', avatar: user.avatar || '', character, about, status: 'pending', at: now() };
    D.applications.push(a);
    save();
    for (const u of Object.values(D.users)) if (u.role === 'officer') notify(u.id, `📝 New application from **${user.name}** (${character.name}, ${character.role}).\n${appUrl()}/#/approvals`);
    return a;
  }, { applicant: true });

  route('DELETE', '/api/applications/:id', ({ user, params }) => {
    const D = db(), a = D.applications.find((x) => x.id === Number(params.id));
    need(a && a.userKey === user.key, 404, 'Application not found.');
    need(a.status === 'pending', 409, 'It was already decided.');
    a.status = 'withdrawn'; a.decidedAt = now();
    save();
    return { ok: true };
  }, { applicant: true });

  route('PUT', '/api/applications/:id', async ({ body, user, params }) => {
    const D = db(), a = D.applications.find((x) => x.id === Number(params.id));
    need(a, 404, 'Application not found.');
    need(a.status === 'pending', 409, 'This application was already decided.');
    need(['accept', 'reject'].includes(body.decision), 400, 'Accept or reject.');
    a.note = clean(body.note, 300); a.decidedBy = user.name; a.decidedAt = now();
    if (body.decision === 'reject') {
      a.status = 'rejected';
      audit(user, 'application.reject', { type: 'application', id: a.id, name: a.name }, `${user.name} rejected ${a.name}'s application (${a.character.name}).`);
      save();
      notify(a.userKey, `Your application was not accepted this time.${a.note ? `\nNote: ${a.note}` : ''}`);
      return a;
    }
    a.status = 'accepted';
    const u = (D.users[a.userKey] = { id: a.userKey, name: a.name, username: a.username, avatar: a.avatar, ...(D.users[a.userKey] || {}) });
    u.accepted = true; u.applicant = false; u.acceptedAt = now();
    u.kicked = false;   // accepting a fresh application is the only way back in after a kick - this is that
    if (!D.members.some((m) => m.owner === a.userKey && m.name.toLowerCase() === a.character.name.toLowerCase())) {
      D.members.push({ id: newId(), owner: a.userKey, joinedAt: now(), builds: [], ...a.character, active: true });            // their character is on the roster straight away
    }
    if (discord.cfg.memberRoleId && u.inGuild) { const r = await discord.addRole(a.userKey); a.roleResult = r.ok ? 'given' : r.error; }
    audit(user, 'application.accept', { type: 'application', id: a.id, name: a.name }, `${user.name} accepted ${a.name}'s application and added the character "${a.character.name}".`);
    save();
    const invite = !u.inGuild && D.settings.applications.inviteUrl ? `\nJoin our Discord server: ${D.settings.applications.inviteUrl}` : '';
    notify(a.userKey, `🎉 Your application was accepted. Welcome!${a.note ? `\nNote: ${a.note}` : ''}\n${appUrl()}${invite}`);
    return a;
  }, { officer: true });

  // What an applicant is allowed to see: nothing but their own application.
  function applicantState(user) {
    const D = db();
    // A mercenary is still an "applicant" as far as sign-in is concerned (not a guild member), so the nav needs
    // this to offer a link to their own mercenary page alongside the application link - otherwise someone who
    // only ever came to help for one event has no way back to it once they navigate anywhere else.
    const merc = D.members.find((m) => m.owner === user.key && m.mercenary);
    // A guest class coach is the same idea: still "applicant" as far as sign-in goes, but with real coaching
    // access underneath. coachingState() already works for anyone regardless of role (it only ever looks at
    // user.key and user.coach), so this is the exact same data a real coach gets, not a separate code path.
    const coachBits = ctx.coaching ? ctx.coaching.coachingState(user) : { isCoach: false, myStudents: [], myCoaches: [], vods: [] };
    return {
      user: { key: user.key, name: user.name, username: user.username || '', avatar: user.avatar || '', role: 'applicant' },
      application: latestFor(user.key),
      mercEventId: merc ? merc.mercFor : null,
      ...coachBits,
      members: [], events: [], points: [], duties: [], presets: [], presetRules: [], loot: [], requests: [], changes: [], profiles: {}, series: [],
      infoBoard: { title: 'Info', categories: [] }, notices: [], leaves: [], warnings: [], explanations: [], alert: null, tags: [], playerTags: {}, prefs: {}, users: [],
      settings: { branding: D.settings.branding, hiddenSections: [], approvals: {}, compliance: {}, applications: { enabled: D.settings.applications.enabled, intro: D.settings.applications.intro } },
      now: Date.now(),
    };
  }
  const extraState = (user) => ({
    applications: isOfficer(user) ? db().applications : [],
    application: null,
  });

  // ---------------------------------------------------------------- Discord tools for the leadership
  route('GET', '/api/admin/discord-check', async () => {
    const D = db();
    const out = {
      login: discord.loginEnabled, bot: discord.botEnabled, redirectUri: discord.loginEnabled ? discord.redirectUri() : '', guildIdSet: !!discord.cfg.guildId,
      memberRole: !!discord.cfg.memberRoleId, inviteUrl: discord.inviteUrl(false), inviteUrlWithRoles: discord.inviteUrl(true), channels: [], roles: [],
    };
    if (discord.botEnabled) {
      const [b, g, c, ro] = await Promise.all([discord.botInfo(), discord.guildInfo(), discord.listChannels(), discord.listRoles()]);
      out.botUser = b.ok ? { id: b.id, name: b.name } : null; out.botError = b.error || '';
      out.guild = g.ok ? { name: g.name } : null; out.guildError = g.error || '';
      out.channels = c.ok ? c.channels : []; out.channelsError = c.error || '';
      out.roles = ro.ok ? ro.roles.filter((x) => x.name !== '@everyone').sort((a, b) => b.position - a.position) : []; out.rolesError = ro.error || '';
    }
    out.selected = D.settings.partyPost.channelId;
    out.selectedRoles = D.settings.partyPost.mentionRoleIds;
    return out;
  }, { officer: true });

  route('GET', '/api/discord/channels', async () => {
    const c = await discord.listChannels();
    need(c.ok, 502, c.error || 'Could not read the channels.');
    return { channels: c.channels, selected: db().settings.partyPost.channelId };
  }, { officer: true });

  route('GET', '/api/discord/roles', async () => {
    const r = await discord.listRoles();
    need(r.ok, 502, r.error || 'Could not read the roles.');
    return { roles: r.roles.filter((x) => x.name !== '@everyone').sort((a, b) => b.position - a.position), selected: db().settings.partyPost.mentionRoleIds };
  }, { officer: true });

  route('PUT', '/api/admin/discord', ({ body, user }) => {
    const st = db().settings, touched = [];
    if (body.applications && typeof body.applications === 'object') { touched.push('applications'); }
    if (body.applications && typeof body.applications === 'object') {
      const x = body.applications;
      if (x.enabled !== undefined) st.applications.enabled = yes(x.enabled);
      if (x.intro !== undefined) st.applications.intro = clean(x.intro, 1500);
      if (x.inviteUrl !== undefined) st.applications.inviteUrl = httpUrl(x.inviteUrl);
    }
    if (body.partyPost && typeof body.partyPost === 'object') {
      touched.push('party announcements');
      const x = body.partyPost;
      if (x.channelId !== undefined) { const id = String(x.channelId || ''); need(id === '' || /^\d{15,25}$/.test(id), 400, 'Pick a channel from the list.'); st.partyPost.channelId = id; if (!id) st.partyPost.channelName = ''; }
      if (x.channelName !== undefined) st.partyPost.channelName = clean(x.channelName, 80);
      if (x.text !== undefined) st.partyPost.text = String(x.text).replace(/\r\n/g, '\n').slice(0, 1500);
      if (x.mentionRoleIds !== undefined) {
        const ids = Array.isArray(x.mentionRoleIds) ? x.mentionRoleIds : [];
        need(ids.length <= 10, 400, 'Pick up to 10 roles.');
        const clean_ids = [...new Set(ids.map((id) => String(id)))];
        need(clean_ids.every((id) => /^\d{15,25}$/.test(id)), 400, 'That does not look like a Discord role.');
        st.partyPost.mentionRoleIds = clean_ids;
      }
      if (x.deletePrevious !== undefined) st.partyPost.deletePrevious = yes(x.deletePrevious);
    }
    if (touched.length) audit(user, 'discord.settings.update', { type: 'settings' }, `${user.name} changed Discord settings: ${touched.join(', ')}.`);
    save();
    return st;
  }, { officer: true });

  route('POST', '/api/admin/discord-test', async ({ body, user }) => {
    const id = String(body.channelId || db().settings.partyPost.channelId || '');
    need(/^\d{15,25}$/.test(id), 400, 'Pick a channel first.');
    const r = await discord.postMessage(id, { content: `✅ Guild Hall can post in this channel. (Test message from ${user.name}.)` });
    return { ok: !!r.ok, error: r.error || '' };
  }, { officer: true });

  // ---------------------------------------------------------------- "Post to Discord": the picture of an event's parties
  route('POST', '/api/events/:id/post-parties', async ({ body, user, params }) => {
    const D = db(), ev = findEvent(params.id), pp = D.settings.partyPost;
    need(ev, 404, 'Event not found.');
    need(discord.botEnabled, 400, 'The Discord bot is not set up yet (DISCORD_BOT_TOKEN). See Admin > Discord.');
    // "Also start Shotcaller" validates everything up front and blocks the WHOLE action (the Discord post too)
    // if it fails - there is no point posting the parties if the session that was supposed to go with them
    // can't start, and no half-done state to untangle afterward either.
    const sc = body.shotcaller && (body.shotcaller.enabled === true || body.shotcaller.enabled === 'true') ? body.shotcaller : null;
    if (sc) {
      const missing = ev.parties.filter((p) => !partyIsPlaceholder(p) && !p.leader);
      need(!missing.length, 400, `Pick a leader for ${missing.map((p) => `"${p.name}"`).join(', ')} first, or mark ${missing.length === 1 ? 'it' : 'them'} as a placeholder (party menu > "Mark as placeholder"), before starting Shotcaller with this post.`);
      need(shotcallerApi.configured(), 400, 'Shotcaller is not set up yet. See Admin > Shotcaller.');
      need(/^\d{15,25}$/.test(String(sc.channelId || '')), 400, 'Pick a voice channel for Shotcaller.');
      if (sc.dedicatedCallerId) shotcallerApi.checkCandidates([String(sc.dedicatedCallerId)]);
    }
    const channelId = String(body.channelId || pp.channelId || '');
    need(/^\d{15,25}$/.test(channelId), 400, 'Pick the Discord channel first.');
    const buf = Buffer.from(String(body.image || '').replace(/^data:[^,]*,/, ''), 'base64');
    need(buf.length > 200 && buf.subarray(0, 8).equals(PNG_SIGNATURE), 400, 'The picture is not a PNG.');
    need(buf.length <= 8e6, 413, 'The picture is too large (8 MB at most).');
    const text = String(body.text || '').replace(/\{link\}/g, `${appUrl()}/#/events/${ev.id}`).trim().slice(0, 1900);
    const slug = (ev.title || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
    // Remove the outdated previous party announcement first, if that is switched on. A message that is already
    // gone (someone deleted it by hand) is not an error - deleteMessage treats "not found" as success - and
    // either way this never blocks posting the new one.
    let deletedPrevious = null;
    if (pp.deletePrevious && pp.lastMessage && pp.lastMessage.messageId) {
      const del = await discord.deleteMessage(pp.lastMessage.channelId, pp.lastMessage.messageId);
      deletedPrevious = { ok: del.ok, error: del.error || '' };
    }
    const r = await discord.postMessage(channelId, { content: text, file: { name: `parties-${slug}.png`, type: 'image/png', buffer: buf }, mentionRoleIds: pp.mentionRoleIds });
    ev.partyPosts = [...(ev.partyPosts || []), { at: now(), by: user.name, channelId, channelName: clean(body.channelName, 80) || pp.channelName, ok: !!r.ok, error: r.error || '', messageId: r.id || '', deletedPrevious }].slice(-10);
    if (r.ok && r.id) pp.lastMessage = { channelId, messageId: r.id };
    save();
    need(r.ok, 502, r.error || 'Discord did not accept the message.');

    // The Discord post succeeded - Shotcaller is handled as a best-effort follow-on, not folded into the same
    // pass/fail: failing the whole request here would be misleading (the post already happened and can't be
    // undone), so a Shotcaller problem comes back as shotcaller.ok:false instead of an error response.
    let shotcaller = null;
    if (sc) {
      // channels[0] is always the picked voice channel (Party 1) and is never renamed - it's an existing
      // channel the officer explicitly chose, not one Shotcaller creates, so it always counts regardless of
      // its own placeholder status (ev.parties[0]'s member count/flag is irrelevant here). Placeholder parties
      // AFTER that are skipped entirely - no voice channel created for them and they don't count toward the
      // bot's 12-party cap, same rule the manual Start dialog's preset/event matching uses (public/shotcaller.js).
      // partyNames[0] names channels[1] (Party 2), and so on, matching the bot's own /start endpoint.
      const realRest = ev.parties.slice(1).filter((p) => !partyIsPlaceholder(p));
      const partyNames = realRest.map((p) => { const m = p.leader ? findMember(p.leader) : null; return m ? `${m.name}'s Party` : null; });
      try {
        const started = await shotcallerApi.startSession({
          channelId: sc.channelId, count: 1 + realRest.length, partyNames,
          dedicatedCallerId: sc.dedicatedCallerId || null, autoReplace: true,
        });
        audit(user, 'shotcaller.start', { type: 'guild' }, `${user.name} started a Shotcaller session for "${ev.title}" while posting its parties to Discord.`);
        shotcaller = { ok: true, data: started };
      } catch (e) {
        shotcaller = { ok: false, error: e.message || 'Could not start Shotcaller.' };
      }
    }
    return { ok: true, shotcaller };
  }, { officer: true });

  // After "Post to Discord" (above) succeeds, the officer's browser calls this once per mercenary currently
  // placed in a party for this event, with a picture it already drew showing just that one party - the same
  // renderer as the channel post, just cropped to one party instead of all of them. Sent as a DM, so only that
  // one player ever sees it; nothing is posted anywhere public for this.
  route('POST', '/api/events/:id/merc-dm/:memberId', async ({ body, params }) => {
    const ev = findEvent(params.id), m = findMember(params.memberId);
    need(ev, 404, 'Event not found.');
    need(m && m.mercenary, 404, 'That mercenary could not be found.');
    need(discord.botEnabled, 400, 'The Discord bot is not set up yet (DISCORD_BOT_TOKEN). See Admin > Discord.');
    const buf = Buffer.from(String(body.image || '').replace(/^data:[^,]*,/, ''), 'base64');
    need(buf.length > 200 && buf.subarray(0, 8).equals(PNG_SIGNATURE), 400, 'The picture is not a PNG.');
    need(buf.length <= 8e6, 413, 'The picture is too large (8 MB at most).');
    const r = await discord.sendDM(m.owner, `🗡️ **Your party for ${ev.title}**`, { name: 'my-party.png', type: 'image/png', buffer: buf });
    return { ok: !!r.ok, error: r.error || '' };
  }, { officer: true });

  // ---------------------------------------------------------------- mercenaries: outside help for one event
  // A mercenary is not a guild member: their character lives in the same members list (so the party board, drag
  // and drop, and character editing all just work unchanged) but with active:false and mercenary:true, which
  // hides them from every other page automatically - those already filter by "active" everywhere. They are
  // only ever shown again on the one event's party board (mercFor), where board() adds them to the pool.
  // Extra officers, editable here instead of .env - a Discord role (besides DISCORD_OFFICER_ROLE_IDS) and/or
  // specific players. Takes effect the next time that person signs in (officer status, like everything else
  // about who someone is, is decided once at sign-in and kept for the 7-day session, not re-checked live).
  route('PUT', '/api/admin/officers', ({ body }) => {
    const st = db().settings;
    if (body.roleIds !== undefined) {
      const ids = Array.isArray(body.roleIds) ? body.roleIds : [];
      need(ids.length <= 10, 400, 'Pick up to 10 roles.');
      const clean_ids = [...new Set(ids.map((id) => String(id)))];
      need(clean_ids.every((id) => /^\d{15,25}$/.test(id)), 400, 'That does not look like a Discord role.');
      st.officerRoleIds = clean_ids;
    }
    if (body.userIds !== undefined) {
      const ids = Array.isArray(body.userIds) ? body.userIds : [];
      need(ids.length <= 50, 400, 'That is a lot of individually-chosen officers - double check the list.');
      st.officerUserIds = [...new Set(ids.map((id) => clean(id, 40)).filter(Boolean))];
    }
    save();
    return st;
  }, { officer: true });

  route('PUT', '/api/admin/mercenaries', ({ body }) => {
    const st = db().settings.mercenaries;
    if (body.channelId !== undefined) { const id = String(body.channelId || ''); need(id === '' || /^\d{15,25}$/.test(id), 400, 'Pick a channel from the list.'); st.channelId = id; if (!id) st.channelName = ''; }
    if (body.channelName !== undefined) st.channelName = clean(body.channelName, 80);
    if (body.roleId !== undefined) { const id = String(body.roleId || ''); need(id === '' || /^\d{15,25}$/.test(id), 400, 'Pick a role from the list.'); st.roleId = id; if (!id) st.roleName = ''; }
    if (body.roleName !== undefined) st.roleName = clean(body.roleName, 80);
    save();
    return st;
  }, { officer: true });

  route('POST', '/api/events/:id/merc-request', async ({ body, user, params }) => {
    const D = db(), ev = findEvent(params.id), st = D.settings.mercenaries;
    need(ev, 404, 'Event not found.');
    need(discord.botEnabled, 400, 'The Discord bot is not set up yet. See Admin > Discord.');
    need(/^\d{15,25}$/.test(st.channelId), 400, 'Set the mercenary channel in Admin first.');
    need(/^\d{15,25}$/.test(st.roleId), 400, 'Set the mercenary role in Admin first.');
    const overall = Math.max(0, Math.round(Number(body.overall) || 0));
    // Just the class name itself (Oracle, Crusader, ...) - no separate role, since there is no reliable way to
    // say which role a class belongs to (several flex between roles depending on build) and the name alone
    // already tells anyone who plays this game what it is.
    const needs = (Array.isArray(body.needs) ? body.needs : [])
      .map((n) => ({ cls: clean(n.cls, 40), count: Math.max(1, Math.round(Number(n.count) || 1)) }))
      .filter((n) => n.cls).slice(0, 10);
    need(overall > 0 || needs.length > 0, 400, 'Say how many players you need, or which classes.');
    const note = clean(body.note, 300);
    const needLine = needs.length ? needs.map((n) => `${n.count}× ${n.cls}`).join(', ') : `${overall} player${overall === 1 ? '' : 's'}, any class`;
    const ts = Math.floor(new Date(ev.start).getTime() / 1000);                 // Discord's own <t:...> tag shows this in each reader's own time zone - better than guessing one for an outside audience
    const link = `${appUrl()}/#/merc/${ev.id}`;
    const text = `🗡️ **Mercenaries wanted for ${ev.title}**\n<t:${ts}:F> (<t:${ts}:R>) · ${ev.type}\nLooking for: ${needLine}${note ? `\n${note}` : ''}\n\nJoin: ${link}`;
    // A Join button alongside the plain link - same reasoning as the reminder DMs: it just opens the page like
    // the text link already does, so it needs nothing beyond what this bot already does (see linkButtons() in
    // discord.js for why that matters for a bot with no Gateway connection or public interactions endpoint).
    const r = await discord.postMessage(st.channelId, { content: text, mentionRoleIds: [st.roleId], components: discord.linkButtons([{ label: '🗡️ Join as a mercenary', url: link }]) });
    ev.mercRequest = { at: now(), by: user.name, overall, needs, note, ok: !!r.ok, error: r.error || '' };
    audit(user, 'mercenaries.request', { type: 'event', id: ev.id, name: ev.title }, `${user.name} asked for mercenaries for "${ev.title}": ${needLine}.`);
    save();
    need(r.ok, 502, r.error || 'Discord did not accept the message.');
    return { ok: true };
  }, { officer: true });

  // The public, minimal view of an event for someone who is not a guild member and is deciding whether to join
  // as a mercenary - title, time and type, and what is being asked for, never the full roster, PIN or RSVPs.
  route('GET', '/api/merc-event/:id', ({ user, params }) => {
    const D = db(), ev = findEvent(params.id);
    need(ev, 404, 'That event could not be found. The link may be old.');
    const mine = D.members.find((m) => m.owner === user.key);
    // Once a mercenary is placed into a party, that is the one thing they see here - their own party, not the
    // rest of the roster. No party yet just means "still waiting" below.
    let myParty = null;
    if (mine && mine.mercenary && mine.mercFor === ev.id) {
      const p = ev.parties.find((p) => p.members.includes(mine.id));
      if (p) myParty = { name: p.name, members: p.members.map((id) => findMember(id)).filter(Boolean).map((m) => ({ name: m.name, role: m.role, leader: p.leader === m.id })) };
    }
    return {
      event: { id: ev.id, title: ev.title, type: ev.type, start: ev.start, mercRequest: ev.mercRequest || null },
      alreadyMember: !!(mine && !mine.mercenary),
      character: mine && mine.mercenary ? mine : null,
      joinedThisEvent: !!(mine && mine.mercenary && mine.mercFor === ev.id),
      myParty,
    };
  }, { applicant: true });

  route('POST', '/api/merc-signup/:id', ({ body, user, params }) => {
    const D = db(), ev = findEvent(params.id);
    need(ev, 404, 'That event could not be found. The link may be old.');
    const existing = D.members.find((m) => m.owner === user.key);
    need(!existing || existing.mercenary, 409, 'This Discord account already belongs to a guild character - sign in as yourself instead of as a mercenary.');
    const picked = pickMember(body);
    need(picked.name, 400, 'Enter a name.');
    need(config.roles.includes(picked.role), 400, 'Pick a role.');
    if (existing) {
      // picked.active defaults to true (pickMember assumes a normal character) - reassert false and mercenary
      // AFTER it, since Object.assign applies arguments left to right and the later ones must win here.
      Object.assign(existing, picked, { active: false, mercenary: true, mercFor: ev.id });
      audit(user, 'mercenary.update', { type: 'member', id: existing.id, name: existing.name }, `${existing.name} (mercenary) signed up again, for "${ev.title}".`);
      save();
      return existing;
    }
    const m = { id: newId(), owner: user.key, joinedAt: now(), builds: [], questlogs: [], ...picked, mercenary: true, active: false, mercFor: ev.id };
    D.members.push(m);
    audit(user, 'mercenary.create', { type: 'member', id: m.id, name: m.name }, `${m.name} signed up as a mercenary for "${ev.title}".`);
    save();
    return m;
  }, { applicant: true });

  return { applicantState, extraState, latestFor };
};
