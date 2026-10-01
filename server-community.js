// Guild applications and Discord tools for Guild Hall.
//   - people who are not in the guild sign in with Discord and can only send an application
//   - the leadership accepts or rejects it; accepting makes them a member and creates their character
//   - the Discord connection check, the invite link for the bot, the channel for party pictures
//   - "Post to Discord": the picture of the parties of an event goes into a channel

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

module.exports = function install(ctx) {
  const { route, need, clean, newId, save, config, discord, isOfficer, pickMember, findEvent, appUrl, audit } = ctx;
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
    return {
      user: { key: user.key, name: user.name, username: user.username || '', avatar: user.avatar || '', role: 'applicant' },
      application: latestFor(user.key),
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
    return { ok: true };
  }, { officer: true });

  return { applicantState, extraState, latestFor };
};
