// Discord integration for Guild Hall (no dependencies, uses Node's built-in fetch).
//
//  1. "Sign in with Discord" (OAuth2). Only members of your Discord server can sign in; their Discord roles
//     decide who is an officer.
//  2. Direct messages from a bot: attendance PINs and "you have not answered" reminders.
//
// Everything is configured with environment variables, see README.md ("Discord setup").

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isSnowflake = (v) => /^\d{15,25}$/.test(String(v));

function createDiscord(env = process.env) {
  const cfg = {
    clientId: env.DISCORD_CLIENT_ID || '',
    clientSecret: env.DISCORD_CLIENT_SECRET || '',
    botToken: env.DISCORD_BOT_TOKEN || '',
    guildId: env.DISCORD_GUILD_ID || '',                  // your Discord server; only its members may sign in
    memberRoleId: env.DISCORD_MEMBER_ROLE_ID || '',       // optional: also require this role
    officerRoleIds: csv(env.DISCORD_OFFICER_ROLE_IDS),    // members with one of these roles are officers
    officerUserIds: csv(env.DISCORD_OFFICER_USER_IDS),    // or list Discord user IDs directly
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''), // where this app is reachable, e.g. https://guild.example.com
    apiBase: (env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, ''),
    authorizeUrl: env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize',
    dmDelayMs: Number(env.DISCORD_DM_DELAY_MS ?? 600),    // pause between DMs so Discord's rate limit is respected
  };
  // A guild id is required: without it anybody with a Discord account could sign in.
  // DEMO_MODE=1 (used by start-demo) switches Discord off completely, so the demo works even when a .env file exists.
  const demo = env.DEMO_MODE === '1';
  const loginEnabled = !demo && !!(cfg.clientId && cfg.clientSecret && cfg.publicUrl && cfg.guildId);
  const botEnabled = !demo && !!cfg.botToken;
  const redirectUri = () => `${cfg.publicUrl}/auth/discord/callback`;

  const authorizeUrl = (state) => {
    const q = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirectUri(), response_type: 'code',
      scope: 'identify guilds.members.read', state, prompt: 'none',
    });
    return `${cfg.authorizeUrl}?${q}`;
  };

  async function api(pathname, { method = 'GET', token, bot, body, form } = {}) {
    const headers = { 'User-Agent': 'DiscordBot (guild-hall, 1.0)' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (bot) headers.Authorization = 'Bot ' + cfg.botToken;
    let payload;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(cfg.apiBase + pathname, { method, headers, body: payload, signal: AbortSignal.timeout(10000) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data, retryAfter: Number(res.headers.get('retry-after') || data.retry_after || 0) };
  }

  // Turns the ?code=... from Discord into a person. Somebody who is not in the Discord server (or lacks the member role) comes back with
  // role "applicant": the caller decides whether applicants may sign in at all.
  async function resolveUser(code) {
    const tok = await api('/oauth2/token', {
      method: 'POST',
      form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri() },
    });
    if (!tok.ok || !tok.data.access_token) throw new Error('Discord did not accept the sign-in. Please try again.');
    const me = await api('/users/@me', { token: tok.data.access_token });
    if (!me.ok || !me.data.id) throw new Error('Could not read your Discord profile.');
    const mem = await api(`/users/@me/guilds/${cfg.guildId}/member`, { token: tok.data.access_token });
    const inGuild = mem.ok, roles = inGuild ? (mem.data.roles || []) : [];
    const officer = cfg.officerUserIds.includes(me.data.id) || roles.some((r) => cfg.officerRoleIds.includes(r));
    const member = officer || (inGuild && (!cfg.memberRoleId || roles.includes(cfg.memberRoleId)));
    return {
      id: me.data.id,
      username: me.data.username || '',
      name: String((mem.ok && mem.data.nick) || me.data.global_name || me.data.username || 'Player').slice(0, 40),
      avatar: me.data.avatar || '',
      inGuild,
      role: officer ? 'officer' : member ? 'member' : 'applicant',
      whyNot: member ? '' : inGuild ? 'You do not have the member role on our Discord server yet.' : 'You are not a member of our Discord server, so you cannot sign in.',
    };
  }

  // ---- direct messages (sent one after another, never in parallel) ----
  const dmChannels = new Map();
  let chain = Promise.resolve();
  const enqueue = (fn) => { const p = chain.then(fn, fn); chain = p.then(() => sleep(cfg.dmDelayMs), () => sleep(cfg.dmDelayMs)); return p; };

  async function deliver(userId, content) {
    if (!botEnabled) return { ok: false, dry: true, error: 'No bot token set (DISCORD_BOT_TOKEN), so nothing was sent.' };
    if (!isSnowflake(userId)) return { ok: false, error: 'This player has no Discord account linked.' };
    for (let attempt = 0; attempt < 2; attempt++) {
      let ch = dmChannels.get(userId);
      if (!ch) {
        const r = await api('/users/@me/channels', { method: 'POST', bot: true, body: { recipient_id: String(userId) } });
        if (r.status === 429 && attempt === 0) { await sleep(Math.min(10, r.retryAfter || 1) * 1000); continue; }
        if (!r.ok || !r.data.id) return { ok: false, error: (r.data && r.data.message) || `Discord said ${r.status}` };
        ch = r.data.id; dmChannels.set(userId, ch);
      }
      const m = await api(`/channels/${ch}/messages`, { method: 'POST', bot: true, body: { content, allowed_mentions: { parse: [] } } });
      if (m.status === 429 && attempt === 0) { await sleep(Math.min(10, m.retryAfter || 1) * 1000); continue; }
      if (m.ok) return { ok: true };
      const msg = m.data && m.data.code === 50007 ? 'Cannot message this player (their DMs are closed, or they share no server with the bot).' : (m.data && m.data.message) || `Discord said ${m.status}`;
      return { ok: false, error: msg };
    }
    return { ok: false, error: 'Discord is rate limiting the bot. Try again in a minute.' };
  }
  const sendDM = (userId, content) => enqueue(() => deliver(userId, content).catch((e) => ({ ok: false, error: String(e.message || e) })));

  // ---- posting a message with a picture into a channel ----
  const FRIENDLY = {
    50013: 'The bot is missing permission in that channel (it needs View Channel, Send Messages and Attach Files).',
    50001: 'The bot cannot see that channel. Give its role access to the channel.',
    10003: 'That channel does not exist (any more).',
    10004: 'The bot is not in that Discord server.',
    30046: 'Discord says too many messages were sent. Try again in a minute.',
  };
  const explain = (r) => (r.data && FRIENDLY[r.data.code]) || (r.status === 401 ? 'Discord did not accept the bot token.' : (r.data && r.data.message) || `Discord said ${r.status}`);
  async function postMessage(channelId, { content, file }) {
    if (!botEnabled) return { ok: false, dry: true, error: 'No bot token set (DISCORD_BOT_TOKEN), so nothing was sent.' };
    if (!isSnowflake(channelId)) return { ok: false, error: 'Pick a channel first.' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ content, allowed_mentions: { parse: [] }, ...(file ? { attachments: [{ id: 0, filename: file.name }] } : {}) }));
      if (file) fd.append('files[0]', new Blob([file.buffer], { type: file.type || 'application/octet-stream' }), file.name);
      const res = await fetch(`${cfg.apiBase}/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: 'Bot ' + cfg.botToken, 'User-Agent': 'DiscordBot (guild-hall, 1.0)' }, body: fd, signal: AbortSignal.timeout(20000) });
      const data = await res.json().catch(() => ({}));
      const r = { status: res.status, ok: res.ok, data, retryAfter: Number(res.headers.get('retry-after') || data.retry_after || 0) };
      if (r.status === 429 && attempt === 0) { await sleep(Math.min(10, r.retryAfter || 1) * 1000); continue; }
      return r.ok ? { ok: true } : { ok: false, error: explain(r) };
    }
    return { ok: false, error: 'Discord is rate limiting the bot. Try again in a minute.' };
  }
  async function listChannels() {
    if (!botEnabled) return { ok: false, error: 'No bot token set.' };
    const r = await api(`/guilds/${cfg.guildId}/channels`, { bot: true });
    if (!r.ok) return { ok: false, error: (r.data && r.data.code === 10004) || r.status === 404 ? 'The bot is not in your Discord server yet. Use the invite link below.' : explain(r) };
    return { ok: true, channels: (r.data || []).filter((c) => c.type === 0 || c.type === 5).sort((a, b) => (a.position || 0) - (b.position || 0)).map((c) => ({ id: c.id, name: c.name })) };
  }
  async function botInfo() {
    if (!botEnabled) return { ok: false, error: 'No bot token set.' };
    const r = await api('/users/@me', { bot: true });
    return r.ok ? { ok: true, id: r.data.id, name: r.data.username } : { ok: false, error: explain(r) };
  }
  async function guildInfo() {
    if (!botEnabled || !cfg.guildId) return { ok: false, error: 'No bot token or server id set.' };
    const r = await api(`/guilds/${cfg.guildId}`, { bot: true });
    return r.ok ? { ok: true, name: r.data.name } : { ok: false, error: r.status === 404 || (r.data && r.data.code === 10004) ? 'The bot is not in your Discord server yet.' : explain(r) };
  }
  // Gives an accepted applicant the member role. Needs the "Manage Roles" permission and a bot role that sits above the member role.
  async function addRole(userId) {
    if (!botEnabled || !cfg.memberRoleId) return { ok: false, error: 'No member role configured.' };
    const r = await api(`/guilds/${cfg.guildId}/members/${userId}/roles/${cfg.memberRoleId}`, { method: 'PUT', bot: true });
    return r.ok || r.status === 204 ? { ok: true } : { ok: false, error: r.status === 403 ? 'The bot may not give roles: it needs the "Manage Roles" permission and its own role must be above the member role.' : explain(r) };
  }
  // ---- lookups used by check-discord.js (and safe to call any time) ----
  // Do the Client ID and Client Secret belong together? (Discord answers "invalid_client" when they do not.)
  async function checkClientSecret() {
    const r = await api('/oauth2/token', { method: 'POST', form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credentials', scope: 'identify' } });
    return r.ok ? { ok: true } : { ok: false, status: r.status, error: (r.data && (r.data.error || r.data.message)) || `Discord said ${r.status}` };
  }
  async function listRoles() {
    const r = await api(`/guilds/${cfg.guildId}/roles`, { bot: true });
    return r.ok ? { ok: true, roles: (r.data || []).map((x) => ({ id: x.id, name: x.name, position: x.position || 0 })) } : { ok: false, error: explain(r) };
  }
  async function botMember(botId) {
    const r = await api(`/guilds/${cfg.guildId}/members/${botId}`, { bot: true });
    return r.ok ? { ok: true, roles: r.data.roles || [] } : { ok: false, error: explain(r) };
  }
  async function lookupUser(id) {
    const r = await api(`/users/${id}`, { bot: true });
    return r.ok ? { ok: true, name: r.data.global_name || r.data.username } : { ok: false, status: r.status, error: explain(r) };
  }

  // A link that adds the bot to the server with exactly the permissions it needs (view channels, send messages, attach files).
  const inviteUrl = (withRoles) => (cfg.clientId ? `https://discord.com/oauth2/authorize?client_id=${cfg.clientId}&scope=bot&permissions=${35840 + (withRoles ? 268435456 : 0)}${cfg.guildId ? '&guild_id=' + cfg.guildId : ''}` : '');

  const avatarUrl = (u) => (u && u.avatar && isSnowflake(u.id) ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : '');

  return { cfg, loginEnabled, botEnabled, redirectUri, authorizeUrl, resolveUser, sendDM, postMessage, listChannels, botInfo, guildInfo, addRole, inviteUrl, checkClientSecret, listRoles, botMember, lookupUser, avatarUrl, isSnowflake };
}

module.exports = { createDiscord, isSnowflake };
