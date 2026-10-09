// Guild Hall <-> Shotcaller: a thin, officer-only proxy to the separate Shotcaller bot's live voice-session
// control API. This module holds no session state of its own - every route here just asks the bot what is
// going on right now, or tells it to do something, and relays the answer. See the Shotcaller repo's src/api.js
// for the other end of this.
//
// Switched off entirely (routes answer 400, GET /api/config reports shotcallerOn:false) unless SHOTCALLER_URL
// and SHOTCALLER_API_KEY are both set - DISCORD_GUILD_ID is reused from the existing Discord config, since
// Guild Hall already knows its own Discord server and there is no reason to ask for that twice.

module.exports = function install(ctx) {
  const { route, need, HttpError, save, audit, shotcaller } = ctx;
  const db = () => ctx.db;
  const yes = (v) => v === true || v === 'true';
  const configured = () => !!(shotcaller.url && shotcaller.apiKey && shotcaller.guildId);
  const nameOf = (id) => { const u = db().users[id]; return (u && u.name) || id; };
  const candidates = () => db().settings.shotcaller.candidateUserIds || [];
  const checkCandidates = (ids) => need(ids.every((id) => candidates().includes(id)), 400, 'Pick from the configured caller candidates (Admin > Shotcaller).');

  // One call out to the bot's control API. Network trouble (bot down, wrong URL, Docker networking) is folded
  // into one clean message instead of a raw fetch/TypeError reaching the officer looking at the panel.
  // path is relative to the guild, e.g. '/session', '/session/mute', '/voice-channels'.
  //
  // timeoutMs defaults to 5s, which is plenty for every call here EXCEPT starting a session: the bot has to
  // create up to 11 new voice channels and log in a relay bot for each one, one at a time, which the bot's own
  // project docs call out as easily taking longer than 3 seconds with several relays - with a full 12-party
  // session that can add up to well past 5 seconds. START_TIMEOUT_MS below gives that one call much more room,
  // so a slow-but-working bot reads back as a real error ("something went wrong") far less often.
  async function callBot(path, method = 'GET', body, timeoutMs = 5000) {
    need(configured(), 400, "Shotcaller is not set up yet. Set SHOTCALLER_URL and SHOTCALLER_API_KEY in the server's environment (DISCORD_GUILD_ID is reused from the existing Discord setup).");
    let res;
    try {
      res = await fetch(`${shotcaller.url}/api/guilds/${shotcaller.guildId}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${shotcaller.apiKey}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HttpError(502, 'Shotcaller is unreachable right now, or took too long to respond.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, data.error || 'Shotcaller rejected the request.');
    return data;
  }
  const callSession = (subpath, method = 'GET', body, timeoutMs) => callBot(`/session${subpath}`, method, body, timeoutMs);
  // Starting a session creates channels and logs in relay bots one at a time - see the comment on callBot above.
  const START_TIMEOUT_MS = 45000;

  // Shared by the manual Start dialog's route below and by server-community.js's combined "Post to Discord +
  // start Shotcaller" flow (passed through as shotcallerApi - see server.js). Validates the same way either
  // caller used to validate on its own, then starts. autoReplace stops an already-active session first instead
  // of reporting the usual "already active" conflict - the leadership's explicit call for the automated
  // post-and-start flow, where there's nobody at a keyboard to react to that conflict. The manual Start button
  // leaves autoReplace off: that page already shows live active/inactive status, so hitting a 409 there would
  // only ever mean a genuine race with someone else, which is safer to report than to resolve by killing their
  // session.
  async function startSession({ channelId, count, partyNames, dedicatedCallerId, autoReplace = false }) {
    need(configured(), 400, "Shotcaller is not set up yet. Set SHOTCALLER_URL and SHOTCALLER_API_KEY in the server's environment (DISCORD_GUILD_ID is reused from the existing Discord setup).");
    need(Number.isInteger(count) && count >= 1 && count <= 12, 400, 'Pick a party count from 1 to 12.');
    const chId = String(channelId || '');
    need(/^\d{15,25}$/.test(chId), 400, 'Pick a voice channel.');
    const callerId = dedicatedCallerId ? String(dedicatedCallerId) : null;
    if (callerId) checkCandidates([callerId]);
    const names = Array.isArray(partyNames) ? partyNames.map((x) => (x == null ? null : String(x).slice(0, 80))) : [];
    if (autoReplace) {
      let current = null;
      try { current = await callSession(''); } catch { /* couldn't read status - try to start anyway, same as a fresh guild */ }
      if (current && current.active) { try { await callSession('/stop', 'POST'); } catch { /* best effort - /start below still reports a real problem */ } }
    }
    return callSession('/start', 'POST', { count, channelId: chId, dedicatedCallerId: callerId, partyNames: names }, START_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------- live panel
  route('GET', '/api/shotcaller/status', () => callSession(''), { officer: true });

  route('GET', '/api/shotcaller/voice-channels', () => callBot('/voice-channels'), { officer: true });

  route('POST', '/api/shotcaller/start', async ({ body, user }) => {
    const count = Math.round(Number(body.count));
    const r = await startSession({ channelId: body.channelId, count, partyNames: body.partyNames, dedicatedCallerId: body.dedicatedCallerId });
    audit(user, 'shotcaller.start', { type: 'guild' }, `${user.name} started a Shotcaller session (${count} ${count === 1 ? 'party' : 'parties'}).`);
    return r;
  }, { officer: true });

  route('POST', '/api/shotcaller/mute', async ({ body, user }) => {
    const muted = yes(body.muted);
    const r = await callSession('/mute', 'POST', { muted });
    audit(user, 'shotcaller.mute', { type: 'guild' }, `${user.name} ${muted ? 'muted' : 'unmuted'} the Shotcaller session.`);
    return r;
  }, { officer: true });

  route('POST', '/api/shotcaller/stop', async ({ user }) => {
    const r = await callSession('/stop', 'POST');
    audit(user, 'shotcaller.stop', { type: 'guild' }, `${user.name} stopped the Shotcaller session.`);
    return r;
  }, { officer: true });

  route('POST', '/api/shotcaller/dedicated', async ({ body, user }) => {
    const ids = Array.isArray(body.userIds) ? [...new Set(body.userIds.map(String))] : [];
    checkCandidates(ids);
    const r = await callSession('/dedicated', 'POST', { userIds: ids });
    audit(user, 'shotcaller.dedicated', { type: 'guild' }, `${user.name} set the dedicated caller(s): ${ids.length ? ids.map(nameOf).join(', ') : 'none'}.`);
    return r;
  }, { officer: true });

  route('POST', '/api/shotcaller/additional-callers', async ({ body, user }) => {
    const ids = Array.isArray(body.userIds) ? [...new Set(body.userIds.map(String))] : [];
    checkCandidates(ids);
    const r = await callSession('/additional-callers', 'POST', { userIds: ids });
    audit(user, 'shotcaller.callers', { type: 'guild' }, `${user.name} set the extra callers: ${ids.length ? ids.map(nameOf).join(', ') : 'none'}.`);
    return r;
  }, { officer: true });

  // ---------------------------------------------------------------- Admin: who can be picked as a caller
  route('PUT', '/api/admin/shotcaller', ({ body, user }) => {
    const st = db().settings.shotcaller, touched = [];
    if (Array.isArray(body.candidateUserIds)) { st.candidateUserIds = [...new Set(body.candidateUserIds.map(String))]; touched.push('candidates'); }
    if (body.defaultCallerId !== undefined) {
      const id = String(body.defaultCallerId || '');
      need(id === '' || st.candidateUserIds.includes(id), 400, 'The default caller has to be one of the ticked candidates.');
      st.defaultCallerId = id; touched.push('default caller');
    }
    if (touched.length) audit(user, 'shotcaller.admin.update', { type: 'settings' }, `${user.name} changed the Shotcaller caller list: ${touched.join(', ')}.`);
    save();
    return st;
  }, { officer: true });

  // Exposed to server.js, which passes it on to server-features.js/server-community.js (as ctx.shotcallerApi) -
  // see server-community.js's post-parties route, the only other caller of startSession.
  return { configured, checkCandidates, startSession };
};
