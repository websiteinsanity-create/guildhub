// Guild Hall <-> Shotcaller: a thin, officer-only proxy to the separate Shotcaller bot's live voice-session
// control API. This module holds no session state of its own - every route here just asks the bot what is
// going on right now, or tells it to do something, and relays the answer. See the Shotcaller repo's src/api.js
// for the other end of this.
//
// Switched off entirely (routes answer 400, GET /api/config reports shotcallerOn:false) unless SHOTCALLER_URL
// and SHOTCALLER_API_KEY are both set - DISCORD_GUILD_ID is reused from the existing Discord config, since
// Guild Hall already knows its own Discord server and there is no reason to ask for that twice.

module.exports = function install(ctx) {
  const { route, need, HttpError, save, audit, shotcaller, findMember, syncAttendancePoints } = ctx;
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
    } catch (e) {
      // The officer-facing message here is deliberately generic (a raw fetch/TypeError is not something they
      // can act on), but that used to mean the REAL reason - wrong URL, Docker networking, the bot's process
      // actually down, a timeout - was thrown away entirely, nowhere even in Guild Hall's own log. Whatever it
      // was, it's cheap to keep and only ever shows up here, in this server's own console/docker logs - never
      // sent to the browser - so print it before replacing it with the clean message the officer actually gets.
      console.error(`[shotcaller] ${method} ${path} failed:`, e && e.cause ? e.cause : e);
      throw new HttpError(502, 'Shotcaller is unreachable right now, or took too long to respond.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`[shotcaller] ${method} ${path} -> ${res.status}:`, JSON.stringify(data));
    if (!res.ok) throw new HttpError(res.status, data.error || 'Shotcaller rejected the request.');
    return data;
  }
  const callSession = (subpath, method = 'GET', body, timeoutMs) => callBot(`/session${subpath}`, method, body, timeoutMs);
  // Starting a session creates channels and logs in relay bots ONE AT A TIME, not in parallel (see the bot's
  // own session.js) - so the time this can take scales with the party count, not just with how "slow" the bot
  // happens to be in general. On the bot's own side, each relay gets up to 3 join attempts at 20s each before
  // it gives up on that one relay alone - i.e. up to 60s just for a single struggling relay, before even
  // counting every other relay still waiting its turn behind it. A flat 45s budget covers a small, trouble-free
  // session comfortably but can run out on a bigger one (or a session where even one relay has to retry) while
  // the bot is still genuinely working - which reads back here as "something went wrong" even though the bot
  // goes on to finish the start seconds later, unaware anyone gave up on it. 15s per party plus a flat 20s for
  // everything else (channel creation, member-list fetch, etc.) comfortably covers one retry per relay even at
  // the full 12-party cap. At count=1 this comes out to the same 45s the old flat budget already was, so a
  // small, healthy start is not made to wait any longer than before - it only grows from there as parties are
  // added.
  const START_TIMEOUT_MS = (count) => 30000 + 15000 * count;

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
    return callSession('/start', 'POST', { count, channelId: chId, dedicatedCallerId: callerId, partyNames: names }, START_TIMEOUT_MS(count));
  }

  // ---------------------------------------------------------------- voice-presence attendance
  // Started only from server-community.js's post-parties route, right after a Shotcaller session starts
  // successfully for a specific event - never from the standalone Start panel (server-shotcaller's own
  // /api/shotcaller/start), which isn't tied to any one event or its party line-up, so it has nothing to match
  // voice presence against. `started` is the bot's own /session/start response (its `parties[]`, in the same
  // order the bot created them); `realRest` is the exact same filtered, ordered list of ev.parties the caller
  // already built to name those channels in the first place - reusing it here instead of recomputing it is what
  // keeps this lined up with the real channel ids even when some of ev.parties are placeholders skipped
  // entirely from the session.
  function beginVoiceTracking(ev, started, realRest) {
    if (ctx.effectiveAttendanceMode(ev) !== 'voice') return;
    if (!started || !Array.isArray(started.parties)) return;
    // Only one Shotcaller session can ever be active for this guild at a time (starting a new one stops
    // anything old first - see startSession's autoReplace) - so any OTHER event still flagged as "being
    // tracked" right now is stale the moment this one starts. Stop watching it rather than risk crediting the
    // wrong event later from a channel id the new session happens to reuse (the anchor channel, especially,
    // is very often the same existing voice channel every time).
    for (const other of db().events) if (other.id !== ev.id && other.voiceTracking) other.voiceTracking.active = false;
    const partyChannels = [{ channelId: started.parties[0] && started.parties[0].channelId, members: [...ev.parties[0].members] }]
      .concat(realRest.map((p, i) => ({ channelId: started.parties[i + 1] && started.parties[i + 1].channelId, members: [...p.members] })))
      .filter((pc) => pc.channelId);
    ev.voiceTracking = { active: true, partyChannels, seenAt: {} };
    save();
  }

  // Someone fully cut off from the conversation in both directions - can't be heard AND can't hear anyone
  // else - reads as "not really there" (AFK, alt-tabbed away, stepped away) rather than someone just
  // listening along without a mic. Only matters when Admin > Events has switched this check on; otherwise
  // simply being connected has always been enough.
  function presentIds(states, ignoreMuted) {
    return new Set((states || []).filter((s) => !(ignoreMuted && s.mute && s.deaf)).map((s) => s.id));
  }

  // Runs on its own clock (VOICE_POLL_INTERVAL_MS, default 10s - "check 3 times within any 30-second window"),
  // deliberately separate from the once-per-30s scheduler tick server.js already uses for reminders: that
  // cadence was fine for a single confirmation a minute or so later, but a faster, independently-checked
  // clock is what actually lets a 30-second-wide window hold more than one real sighting.
  async function pollVoiceAttendance() {
    const settings = db().settings;
    const tracked = db().events.filter((ev) => ev.voiceTracking && ev.voiceTracking.active && ctx.effectiveAttendanceMode(ev) === 'voice');
    if (!tracked.length) return;
    let status;
    try { status = await callSession(''); }
    catch { return; } // the bot being briefly unreachable just means this poll learns nothing new - try again next time
    if (!status || !status.active) {
      // The session ended (an officer stopped it, or it was auto-replaced by a new one for another event) -
      // nothing more to learn. Whoever was already marked attended during the session stays marked; this only
      // ends the watch so the next poll doesn't keep calling the bot about a session that is no longer there.
      for (const ev of tracked) ev.voiceTracking.active = false;
      save();
      return;
    }
    const ignoreMuted = !!settings.voiceAttendanceIgnoreMuted;
    const byChannel = new Map();
    for (const p of status.parties || []) {
      byChannel.set(p.channelId, presentIds(p.connectedStates || (p.connectedUserIds || []).map((id) => ({ id })), ignoreMuted));
    }
    // Extra channels (Admin > Events) are never part of the session itself, so they're read through the bot's
    // own channel-agnostic endpoint instead - read fresh every poll, since an admin could change the list at
    // any time and a stale list would keep checking (or stop checking) the wrong channels.
    const extraIds = (settings.voiceTrackExtraChannelIds || []).filter(Boolean);
    const extraSet = new Set();
    if (extraIds.length) {
      try {
        const r = await callBot(`/voice-presence?channels=${extraIds.map(encodeURIComponent).join(',')}`);
        for (const c of r.channels || []) if (c.found) for (const id of presentIds(c.connectedStates, ignoreMuted)) extraSet.add(id);
      } catch { /* extra channels are a bonus, not a reason to skip the party channels below */ }
    }
    const anyChannel = new Set(extraSet);
    for (const s of byChannel.values()) for (const id of s) anyChannel.add(id);
    const scope = settings.voiceAttendanceScope === 'any-channel' ? 'any-channel' : 'own-party';
    const offsetMs = (Number(settings.voiceTrackStartOffsetMinutes) || 0) * 60000;
    const now = Date.now();
    let anyChanged = false;
    for (const ev of tracked) {
      if (now < Date.parse(ev.start) + offsetMs) continue; // tracking hasn't opened yet for this event
      let evChanged = false;
      for (const party of ev.voiceTracking.partyChannels) {
        const own = byChannel.get(party.channelId) || new Set();
        const connected = scope === 'any-channel' ? anyChannel : (extraSet.size ? new Set([...own, ...extraSet]) : own);
        for (const memberId of party.members) {
          const m = findMember(memberId);
          if (!m || !connected.has(m.owner)) continue;
          // A rolling 30-second window, not a lifetime count - "seen at least twice within the last 30
          // seconds" is what "overall checktime: 30s, 3 times within it" actually asks for, rather than any
          // two sightings ever, however far apart.
          const times = (ev.voiceTracking.seenAt[memberId] = ev.voiceTracking.seenAt[memberId] || []);
          times.push(now);
          while (times.length && now - times[0] > 30000) times.shift();
          if (times.length >= 2 && !ev.attended.includes(memberId)) { ev.attended.push(memberId); evChanged = true; }
        }
      }
      if (evChanged) { syncAttendancePoints(ev); anyChanged = true; }
    }
    if (anyChanged) save();
  }
  const VOICE_POLL_MS = Number(process.env.VOICE_POLL_INTERVAL_MS || 10000);
  setInterval(() => { pollVoiceAttendance().catch((e) => console.error('[voice-attendance] poll failed:', e)); }, VOICE_POLL_MS);

  // ---------------------------------------------------------------- Testing: a live voice-attendance dry-run
  // Admin > Testing: lets an officer actually watch the whole voice-attendance pipeline work, end to end,
  // without needing a real event. Starts a throwaway 3-channel Shotcaller session (the anchor channel the
  // officer picks, plus 2 new ones the bot creates), waits the same kind of lead time a real event's
  // voiceTrackStartOffsetMinutes gives people to get settled, then watches for real people joining and reports
  // back exactly who got confirmed - the same rolling 30s/2-sightings rule pollVoiceAttendance uses for real
  // events - and whether they were muted/deafened at the time, so an officer can actually see the mute-ignoring
  // setting's effect before trusting it on a real event. Confirmation here is never gated by the mute-ignoring
  // setting itself - the whole point is to show every confirmed tester's mute state, not hide the ones it would
  // exclude.
  //
  // Single in-memory slot, not db.* and never saved: a server restart just loses it, which is fine - it was
  // only ever a live dry-run, nothing it does is a real event, nobody's attendance, points or warnings are
  // touched by any of this.
  let voiceTest = null;
  // Overridable by env for tests only, same pattern as VOICE_POLL_INTERVAL_MS above - production always gets
  // the real 3-minute lead time and 5s poll cadence; nothing here is meant to be guild-configurable.
  const VT_TRACK_DELAY_MS = Number(process.env.VOICE_TEST_DELAY_MS || 3 * 60000);    // "after 3 minutes will start to track"
  const VT_POLL_MS = Number(process.env.VOICE_TEST_POLL_MS || 5000);
  const VT_MAX_MS = 20 * 60000;           // safety net: auto-stop an abandoned test rather than leave a Discord voice session running forever
  const vtNameFor = (ownerId) => { const m = db().members.find((x) => x.owner === ownerId && x.active); return m ? m.name : nameOf(ownerId); };

  route('GET', '/api/admin/voice-test', () => voiceTest || { phase: null }, { officer: true });

  route('POST', '/api/admin/voice-test/start', async ({ body, user }) => {
    need(!voiceTest || ['ended', 'error'].includes(voiceTest.phase), 409, 'A test is already running - stop it first.');
    voiceTest = { phase: 'starting', startedAt: Date.now(), trackAt: null, channels: [], error: null, confirmed: [], seenAt: {} };
    try {
      const r = await startSession({ channelId: body.channelId, count: 3, partyNames: ['Test channel 2', 'Test channel 3'] });
      voiceTest.channels = (r.parties || []).map((p) => ({ channelId: p.channelId, name: p.name }));
      voiceTest.trackAt = Date.now() + VT_TRACK_DELAY_MS;
      voiceTest.phase = 'waiting';
      audit(user, 'voicetest.start', { type: 'guild' }, `${user.name} started a voice-attendance test.`);
    } catch (e) {
      voiceTest.phase = 'error';
      voiceTest.error = e.message || 'Could not start Shotcaller.';
    }
    return voiceTest;
  }, { officer: true });

  route('POST', '/api/admin/voice-test/stop', async ({ user }) => {
    if (voiceTest && ['starting', 'waiting', 'tracking'].includes(voiceTest.phase)) {
      try { await callSession('/stop', 'POST'); } catch { /* best effort - the test slot is cleared below regardless */ }
      audit(user, 'voicetest.stop', { type: 'guild' }, `${user.name} stopped the voice-attendance test.`);
    }
    voiceTest = null;
    return { ok: true };
  }, { officer: true });

  async function pollVoiceTest() {
    if (!voiceTest) return;
    if (Date.now() - voiceTest.startedAt > VT_MAX_MS) {                  // forgotten/abandoned - clean up quietly
      try { await callSession('/stop', 'POST'); } catch { /* already gone, or never really started - nothing to clean up */ }
      voiceTest = null;
      return;
    }
    if (voiceTest.phase === 'waiting') { if (Date.now() >= voiceTest.trackAt) voiceTest.phase = 'tracking'; return; }
    if (voiceTest.phase !== 'tracking') return;
    let status;
    try { status = await callSession(''); }
    catch { return; }                                                   // briefly unreachable - this poll just learns nothing new
    if (!status || !status.active) { voiceTest.phase = 'ended'; return; }   // stopped from elsewhere (Discord command, say)
    const testIds = new Set(voiceTest.channels.map((c) => c.channelId));
    const now = Date.now();
    const latestState = new Map();                                      // ownerId -> {mute, deaf}, refreshed every poll
    for (const p of status.parties || []) {
      if (!testIds.has(p.channelId)) continue;
      for (const s of p.connectedStates || []) {
        latestState.set(s.id, { mute: !!s.mute, deaf: !!s.deaf });
        const times = (voiceTest.seenAt[s.id] = voiceTest.seenAt[s.id] || []);
        times.push(now);
        while (times.length && now - times[0] > 30000) times.shift();
        if (times.length >= 2 && !voiceTest.confirmed.some((c) => c.ownerId === s.id)) {
          voiceTest.confirmed.push({ ownerId: s.id, name: vtNameFor(s.id), mute: !!s.mute, deaf: !!s.deaf, confirmedAt: new Date(now).toISOString() });
        }
      }
    }
    // Keep an already-confirmed tester's mute/deaf current instead of frozen at the moment they first qualified.
    for (const c of voiceTest.confirmed) { const st = latestState.get(c.ownerId); if (st) { c.mute = st.mute; c.deaf = st.deaf; } }
  }
  setInterval(() => { pollVoiceTest().catch((e) => console.error('[voice-test] poll failed:', e)); }, VT_POLL_MS);

  // ---------------------------------------------------------------- live panel
  route('GET', '/api/shotcaller/status', () => callSession(''), { officer: true });

  route('GET', '/api/shotcaller/voice-channels', () => callBot('/voice-channels'), { officer: true });

  route('POST', '/api/shotcaller/start', async ({ body, user }) => {
    const count = Math.round(Number(body.count));
    // A failure here throws an HttpError whose message is already the REAL reason (the bot's own rejection
    // text, or what went wrong reaching it at all) - the officer only ever sees a short generic toast in the
    // app itself, by design, since a raw network/bot error isn't something they could act on in the moment.
    // That real reason has nowhere else to land for someone who isn't the one hosting Guild Hall and can't get
    // at its server logs, so it goes in the audit log too (Admin > Audit) - visible right here in the app,
    // same place every other officer action already shows up.
    let r;
    try {
      r = await startSession({ channelId: body.channelId, count, partyNames: body.partyNames, dedicatedCallerId: body.dedicatedCallerId });
    } catch (e) {
      audit(user, 'shotcaller.start-failed', { type: 'guild' }, `${user.name} tried to start a Shotcaller session (${count} ${count === 1 ? 'party' : 'parties'}) - it failed: ${e.message || 'unknown error'}`);
      throw e;
    }
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
  // see server-community.js's post-parties route, the only other caller of startSession and of beginVoiceTracking.
  return { configured, checkCandidates, startSession, beginVoiceTracking };
};
