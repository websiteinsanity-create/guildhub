// Guild Hall <-> Shotcaller: a thin, officer-only proxy to the separate Shotcaller bot's live voice-session
// control API. This module holds no session state of its own - every route here just asks the bot what is
// going on right now, or tells it to do something, and relays the answer. See the Shotcaller repo's src/api.js
// for the other end of this.
//
// Switched off entirely (routes answer 400, GET /api/config reports shotcallerOn:false) unless SHOTCALLER_URL
// and SHOTCALLER_API_KEY are both set - DISCORD_GUILD_ID is reused from the existing Discord config, since
// Guild Hall already knows its own Discord server and there is no reason to ask for that twice.

module.exports = function install(ctx) {
  const { route, need, HttpError, save, audit, shotcaller, findMember, findEvent, eventFor, setAttended, partyIsPlaceholder } = ctx;
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

  // A plain "what's the session doing right now" read (GET /session) is hit from FOUR independent places at
  // once, each on its own clock, every single time an event is being voice-tracked: the background
  // pollVoiceAttendance loop below (every VOICE_POLL_MS), and - separately, per officer who happens to have a
  // tab open - the dashboard's "Attendance Tracking" panel (every 5s, see /voice-track/live below), the
  // Shotcaller page itself (every 5s, see /api/shotcaller/status below), and the admin voice test (every
  // VT_POLL_MS). With even two or three officers watching the same raid, that is several real network round
  // trips to the separate bot process every few seconds, all asking the exact same question - and it is
  // heaviest at exactly the moment the bot is busiest and slowest to answer anything: while a session is
  // still starting (creating channels and logging relays in one at a time, up to tens of seconds - see
  // START_TIMEOUT_MS above). Each of those redundant polls then sits waiting out its own timeout before giving
  // up, piling up pending requests against the same bot host right when things are already slow, which is what
  // actually read back as "the website lags while Shotcaller is starting/tracking" - Guild Hall's own server
  // was never blocked, it was just waiting on a bot that itself was swamped with duplicate questions.
  //
  // cachedSession() is a short-lived, request-coalescing cache for that one read: the first caller within the
  // window makes the real call, and anyone else - whether they ask a moment later (TTL) or at the very same
  // instant (the shared in-flight promise, which is what actually matters when several officers' 5s timers
  // happen to land close together) - gets that same answer instead of starting a second one. 3 seconds keeps
  // every reader well within "live" (shorter than any of the pollers above) while still collapsing the
  // overlapping ones into a single outbound call. A failed call is never cached - the next caller (or the next
  // tick) tries again fresh rather than being stuck repeating a stale error.
  const SESSION_CACHE_MS = Number(process.env.SHOTCALLER_SESSION_CACHE_MS || 3000);   // overridable for tests only, same pattern as VOICE_POLL_INTERVAL_MS
  let sessionCache = null;        // { at, promise } | null
  function cachedSession() {
    const now = Date.now();
    if (sessionCache && now - sessionCache.at < SESSION_CACHE_MS) return sessionCache.promise;
    const promise = callSession('').catch((e) => { sessionCache = null; throw e; });
    sessionCache = { at: now, promise };
    return promise;
  }

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
  // The dashboard's "Attendance Tracking" card (public/features.js attendanceTrackPanel) shows a track as
  // "running" while voiceTracking.active is true, and as "finished, not yet saved" for the 15 minutes after -
  // the window in which an officer can hit "Save track" by hand before it saves itself. One in-memory timer
  // per event is all that needs tracking (an event can only ever be mid-track once at a time) - lost on a
  // server restart, same as any other setTimeout, but that only ever widens the window to "whenever the
  // server next notices it's overdue", never loses the attendance itself (ev.attended already persisted the
  // moment each sighting was confirmed - "saving" a track is a bookkeeping close-out, not where the data lives).
  // A track is now a short, bounded thing: exactly VOICE_CHECKS_TOTAL checks, VOICE_POLL_MS apart, starting
  // the moment tracking begins (by hand or automatically) - no open-ended watch, no "awaiting save" window.
  // Anyone seen in ANY one of those checks counts as attended (a plain union across the checks, not a
  // repeat-sighting requirement) - a deliberate trade: fast and simple, at the cost of the old rolling-window
  // protection against a momentary connection blip being credited. checkTimers holds, per event, the timer for
  // whichever check hasn't fired yet (either the next of the 3, or - before the very first one - the wait for
  // voiceTrackStartOffsetMinutes to open, if tracking began before that gate was due to open).
  const checkTimers = new Map();
  function clearCheckTimer(evId) {
    const t = checkTimers.get(evId);
    if (t) { clearTimeout(t); checkTimers.delete(evId); }
  }
  function finishVoiceTracking(ev, user) {
    if (!ev.voiceTracking || ev.voiceTracking.finishedAt) return;
    ev.voiceTracking.finishedAt = Date.now();
    clearCheckTimer(ev.id);
    save();
    audit(user || { name: 'Guild Hall' }, 'event.voicetrack.finish', { type: 'event', id: ev.id, name: ev.title },
      `${user ? user.name : 'The system'} saved the voice-attendance track for "${ev.title}".`);
  }
  // The one path that actually credits whatever was collected (the union of every check's sightings) and
  // closes the track out - used whether the track is ending because all 3 checks ran out, because the
  // Shotcaller session itself ended early, because an officer hit "Finish tracking now" by hand, or because a
  // new track elsewhere just preempted this one. Safe to call more than once (finishVoiceTracking itself is a
  // no-op once finishedAt is set) and safe to call on an event with no voiceTracking at all.
  function finalizeTrack(ev, user) {
    const vt = ev.voiceTracking;
    if (vt && !vt.finishedAt) {
      const newlyCredited = (vt.sessionSeen || []).filter((id) => !ev.attended.includes(id));
      if (newlyCredited.length) setAttended(ev, [...ev.attended, ...newlyCredited], { mode: 'add', by: 'Voice tracking (automatic)' });
      vt.active = false;
    }
    finishVoiceTracking(ev, user);
  }
  // Some Shotcaller bot builds only report a per-party headcount (parties[].connected), not who specifically
  // is in each channel (no connectedStates or connectedUserIds at all) - enough for party management, but
  // voice-attendance crediting (pollVoiceAttendance below) has no ids to match members against, so it would
  // silently never credit anyone, forever, with nothing on screen to explain why. Detected once when tracking
  // begins and surfaced on the dashboard's Attendance Tracking card (features.js) instead.
  function presenceUnsupported(status) {
    const parties = (status && status.parties) || [];
    return parties.length > 0 && parties.every((p) => !Array.isArray(p.connectedStates) && !Array.isArray(p.connectedUserIds));
  }
  // channelId is all pollVoiceAttendance itself needs any more (it now credits anyone present in ANY of
  // these channels, not specifically this party's own members - see pollVoiceAttendance below); members is
  // kept purely for the dashboard's live deafened-count readout (/voice-track/live), which still only cares
  // about the players who were actually part of the original line-up when tracking began.
  //
  // realRest is recomputed fresh from ev.parties at call time - for the combined post-parties flow that's the
  // exact same array that was just used to start the session, so it lines up with started.parties by position
  // with no room for drift. But a party's channel is still worked out this positional way whenever there is
  // no frozen snapshot to fall back on (see snapshotVoiceSession and its use in beginVoiceTracking below) - if
  // a party has a leader, matching the bot's own echoed-back "<leader>'s Party" name first (falling back to
  // position only for whatever's left) still helps in that case, but is no help at all for a guild that
  // never assigns leaders when using voice tracking - which is exactly when the snapshot matters most.
  function computePartyChannels(ev, started, realRest) {
    const expectedNames = realRest.map((p) => { const m = p.leader ? findMember(p.leader) : null; return m ? `${m.name}'s Party` : null; });
    const botRest = started.parties.slice(1);
    const usedBot = new Set(), usedReal = new Set();
    const matched = new Array(realRest.length).fill(null);
    for (let i = 0; i < expectedNames.length; i++) {
      if (!expectedNames[i]) continue;
      const j = botRest.findIndex((bp, jj) => !usedBot.has(jj) && bp && bp.name === expectedNames[i]);
      if (j >= 0) { matched[i] = botRest[j]; usedBot.add(j); usedReal.add(i); }
    }
    let nextFree = 0;
    for (let i = 0; i < realRest.length; i++) {
      if (usedReal.has(i)) continue;
      while (nextFree < botRest.length && usedBot.has(nextFree)) nextFree++;
      if (nextFree < botRest.length) { matched[i] = botRest[nextFree]; usedBot.add(nextFree); nextFree++; }
    }
    return [{ channelId: started.parties[0] && started.parties[0].channelId, members: [...ev.parties[0].members] }]
      .concat(realRest.map((p, i) => ({ channelId: matched[i] && matched[i].channelId, members: [...p.members] })))
      .filter((pc) => pc.channelId);
  }
  const liveChannelKey = (started) => started.parties.map((p) => p && p.channelId).filter(Boolean).join(',');
  // Freezes this event's current party-to-channel layout the moment Shotcaller is actually told to start for
  // it - from the manual "Start Shotcaller session" dialog (when it was set up "from an event") and from the
  // combined post-parties flow, whether or not tracking begins immediately. Without this, "Start tracking
  // now" (clicked separately, maybe much later) and "Track again" would only ever have ev.parties AS IT IS
  // AT THAT LATER MOMENT to work from - fine if nothing changed, wrong if a party was reassigned by voice or
  // chat instead of re-posting the lineup, since a party's position no longer means what it meant when the
  // channels were actually created. Keyed by the live channel set itself (channelIds are freshly created by
  // the bot every session, so a genuinely new session can never collide with an old snapshot by accident).
  function snapshotVoiceSession(ev, started, realRest) {
    if (ctx.effectiveAttendanceMode(ev) !== 'voice' || !started || !Array.isArray(started.parties)) return;
    ev.voiceSessionSnapshot = { channelKey: liveChannelKey(started), partyChannels: computePartyChannels(ev, started, realRest) };
  }
  function beginVoiceTracking(ev, started, realRest) {
    if (ctx.effectiveAttendanceMode(ev) !== 'voice') return;
    if (!started || !Array.isArray(started.parties)) return;
    // Only one Shotcaller session can ever be active for this guild at a time (starting a new one stops
    // anything old first - see startSession's autoReplace) - so any OTHER event still flagged as "being
    // tracked" right now is stale the moment this one starts. Close it out (crediting whatever it already
    // collected) rather than leave it dangling or risk crediting the wrong event later from a channel id the
    // new session happens to reuse (the anchor channel, especially, is very often the same one every time).
    for (const other of db().events) {
      if (other.id !== ev.id && other.voiceTracking && other.voiceTracking.active) finalizeTrack(other, null);
    }
    // The frozen snapshot (above) wins whenever it's for THIS exact live session (same channel set) - it's
    // the authoritative record of what this event's parties looked like the moment the session actually
    // started, immune to anything done to ev.parties since. Recompute fresh only when there is no snapshot
    // for this session (an officer started Shotcaller some other way - the generic dialog with no event
    // chosen, say - so there was never anything to freeze).
    const snap = ev.voiceSessionSnapshot;
    const partyChannels = (snap && snap.channelKey === liveChannelKey(started)) ? snap.partyChannels : computePartyChannels(ev, started, realRest);
    ev.voiceTracking = { active: true, partyChannels, seen: {}, sessionSeen: [], channels: [], checksDone: 0, startedAt: Date.now(), finishedAt: null };
    if (presenceUnsupported(started)) {
      ev.voiceTracking.presenceUnsupported = true;
      audit({ name: 'Guild Hall' }, 'event.voicetrack.unsupported', { type: 'event', id: ev.id, name: ev.title },
        `Voice-attendance tracking started for "${ev.title}", but the Shotcaller bot in use only reports a headcount per channel, not who is in it - nobody will be credited until the bot reports per-user voice presence.`);
    }
    clearCheckTimer(ev.id);
    save();
    // voiceTrackStartOffsetMinutes still gates WHEN the 3 checks are allowed to begin (unchanged idea from
    // before - "don't credit people milling around before the event's own start/lead-time"), it just now
    // delays the whole short check-run rather than delaying crediting within an otherwise-endless poll. The
    // very first check reuses the session status we already have in hand (started) instead of asking the bot
    // again for something we were just told.
    const settings = db().settings;
    const offsetMs = (Number(ev.voiceTrackStartOffsetMinutes ?? settings.voiceTrackStartOffsetMinutes) || 0) * 60000;
    const gateAt = Date.parse(ev.start) + offsetMs;
    const now = Date.now();
    if (now >= gateAt) {
      runCheck(ev.id, started).catch((e) => console.error('[voice-attendance] check failed:', e));
    } else {
      checkTimers.set(ev.id, setTimeout(() => { runCheck(ev.id, null).catch((e) => console.error('[voice-attendance] check failed:', e)); }, gateAt - now));
    }
  }

  // The manual counterpart to the automatic start above - for when an officer switched "automatic tracking"
  // off for this event (Voice channel tracking and Reminders on the event page) and wants to begin crediting
  // sightings right now instead, on their own call, rather than the moment Shotcaller happens to start. Reuses
  // beginVoiceTracking itself: a live GET /session status has the exact same parties[]/channelId shape the bot's
  // own /session/start response does, so there is nothing special to build here - just read what the bot says
  // is running right now and hand it to the same function. Requires a Shotcaller session to actually be active
  // already (started separately, e.g. by posting this event's parties with "Also start Shotcaller" ticked but
  // automatic tracking off, or from the Shotcaller page) - this never starts a session of its own.
  route('POST', '/api/events/:id/voice-track/start', async ({ user, params }) => {
    const ev = findEvent(params.id);
    need(ev, 404, 'Event not found.');
    need(ctx.effectiveAttendanceMode(ev) === 'voice', 400, 'This event is not using voice tracking.');
    const status = await callSession('');
    need(status && status.active, 409, 'Shotcaller is not running right now - start it first, then come back and start tracking.');
    const realRest = ev.parties.slice(1).filter((p) => !partyIsPlaceholder(p));
    beginVoiceTracking(ev, status, realRest);
    audit(user, 'event.voicetrack.start', { type: 'event', id: ev.id, name: ev.title }, `${user.name} manually started voice-attendance tracking for "${ev.title}".`);
    return eventFor(ev, user);
  }, { officer: true });

  // "Track again" on the event page's voice panel: wipes this event's attendance all the way back to before
  // it was EVER tracked (not just whatever voice tracking itself credited - any hand correction an officer made
  // on the roster too), then immediately starts a fresh track exactly as /voice-track/start above does. Restores
  // from the one-shot attendanceUndo snapshot setAttended() takes on its very first write to this event, from
  // whichever source wrote first (voice, PIN, or a roster save) - so there is always something to restore to,
  // even for an event only voice tracking ever touched. Clears that snapshot afterwards so the fresh pass gets
  // its own, and beginVoiceTracking's own full replace of ev.voiceTracking naturally discards the old sighting
  // data (the "seen" popup log included) for the new pass to start building from scratch.
  route('POST', '/api/events/:id/voice-track/restart', async ({ user, params }) => {
    const ev = findEvent(params.id);
    need(ev, 404, 'Event not found.');
    need(ctx.effectiveAttendanceMode(ev) === 'voice', 400, 'This event is not using voice tracking.');
    const status = await callSession('');
    need(status && status.active, 409, 'Shotcaller is not running right now - start it first, then come back and start tracking.');
    const undo = ev.attendanceUndo;
    ev.attended = undo ? [...undo.attended] : [];
    ev.autoAttended = undo ? undo.autoAttended : false;
    ev.attendanceTracked = undo ? (undo.attendanceTracked === undefined ? false : undo.attendanceTracked) : false;
    ev.attendanceUndo = null;
    const realRest = ev.parties.slice(1).filter((p) => !partyIsPlaceholder(p));
    beginVoiceTracking(ev, status, realRest);
    audit(user, 'event.voicetrack.restart', { type: 'event', id: ev.id, name: ev.title }, `${user.name} reset and restarted voice-attendance tracking for "${ev.title}".`);
    return eventFor(ev, user);
  }, { officer: true });

  // Lets an officer finish a track by hand before its 3 checks run out on their own - the main way to move on
  // to the next event in a back-to-back lineup right away, on a Shotcaller session that stays up the whole
  // time, without waiting out even the short default check cycle. Credits whatever was collected so far
  // (finalizeTrack), same as a track finishing on its own. This never touches the session/bot itself, only
  // this event's own track.
  route('POST', '/api/events/:id/voice-track/finish', ({ user, params }) => {
    const ev = findEvent(params.id);
    need(ev, 404, 'Event not found.');
    need(ev.voiceTracking, 400, 'Tracking was never started for this event.');
    finalizeTrack(ev, user);
    return eventFor(ev, user);
  }, { officer: true });

  // Live numbers for the dashboard's "Attendance Tracking" card while a track is running: how many of this
  // event's tracked players have been confirmed so far, how many of them answered Going but have not been
  // seen at all yet, and - a live read, not from the confirmed-sightings record - how many are sitting in
  // voice deafened right now, regardless of the ignoreDeafened setting (that setting only governs whether a
  // deafened player still gets CREDITED; showing the raw count here is what lets an officer actually see its
  // effect rather than hiding the very thing it ignores).
  route('GET', '/api/events/:id/voice-track/live', async ({ params }) => {
    const ev = findEvent(params.id);
    need(ev, 404, 'Event not found.');
    const vt = ev.voiceTracking;
    const trackedCount = (ev.attended || []).length;
    const expectedIds = new Set(ev.parties.filter((p) => !partyIsPlaceholder(p)).flatMap((p) => p.members));
    const noShowCount = [...expectedIds].filter((mid) => (ev.rsvps[mid] === 'yes') && !ev.attended.includes(mid)).length;
    let deafenedCount = 0;
    if (vt && vt.active) {
      try {
        const settings = db().settings;
        const status = await cachedSession();   // see cachedSession() above - this is polled every 5s per officer watching the dashboard
        if (status && status.active) {
          const byChannel = new Map();
          for (const p of status.parties || []) byChannel.set(p.channelId, p.connectedStates || (p.connectedUserIds || []).map((id) => ({ id })));
          const evExtraIds = new Set([...(settings.voiceTrackExtraChannelIds || []), ...(ev.voiceTrackExtraChannelIds || [])].filter(Boolean));
          let extraStates = [];
          if (evExtraIds.size) {
            try {
              const r = await callBot(`/voice-presence?channels=${[...evExtraIds].map(encodeURIComponent).join(',')}`);
              extraStates = (r.channels || []).filter((c) => c.found).flatMap((c) => c.connectedStates || []);
            } catch { /* extra channels are a bonus for this readout too */ }
          }
          const memberIds = new Set(vt.partyChannels.flatMap((p) => p.members));
          const ownerIsDeaf = new Map();
          for (const pc of vt.partyChannels) for (const s of byChannel.get(pc.channelId) || []) if (s.deaf) ownerIsDeaf.set(s.id, true);
          for (const s of extraStates) if (s.deaf) ownerIsDeaf.set(s.id, true);
          for (const mid of memberIds) { const m = findMember(mid); if (m && ownerIsDeaf.get(m.owner)) deafenedCount++; }
        }
      } catch { /* bot unreachable right now just reads back as 0 - not worth failing the whole panel over */ }
    }
    return { active: !!(vt && vt.active), startedAt: (vt && vt.startedAt) || null, finishedAt: (vt && vt.finishedAt) || null, trackedCount, deafenedCount, noShowCount, presenceUnsupported: !!(vt && vt.presenceUnsupported) };
  }, { officer: true });

  // Two independent checks - mic-muted and deafened don't have to come together to be excluded any more.
  // ignoreMuted drops anyone who can't be heard; ignoreDeafened drops anyone who can't hear. Either, both or
  // neither can be switched on in Admin > Events; off (the default for both) simply being connected is enough,
  // as it always was before these checks existed.
  function presentIds(states, ignoreMuted, ignoreDeafened) {
    return new Set((states || []).filter((s) => !(ignoreMuted && s.mute) && !(ignoreDeafened && s.deaf)).map((s) => s.id));
  }

  // One of a track's (at most) VOICE_CHECKS_TOTAL checks. knownStatus lets the very first check reuse a
  // session status the caller already just fetched (starting Shotcaller, or "Start tracking now" reading
  // live status) instead of asking the bot again for something we were just told; every later check fetches
  // its own fresh (cached) read. Re-fetches the event fresh after each await, the same defensive pattern used
  // throughout this file, in case "Track again" or another event's track replaced this one's voiceTracking
  // object entirely while this check was waiting on the bot.
  async function runCheck(evId, knownStatus) {
    let ev = findEvent(evId);
    if (!ev || !ev.voiceTracking || !ev.voiceTracking.active || ev.voiceTracking.finishedAt) return;
    if (ctx.effectiveAttendanceMode(ev) !== 'voice') { finalizeTrack(ev, null); return; }
    let status = knownStatus;
    if (!status) { try { status = await cachedSession(); } catch { status = null; } }
    ev = findEvent(evId);
    if (!ev || !ev.voiceTracking || !ev.voiceTracking.active || ev.voiceTracking.finishedAt) return;
    if (!status || !status.active) { finalizeTrack(ev, null); return; } // session ended - nothing more to ever learn, close out now with whatever was collected
    const settings = db().settings;
    const ignoreMuted = !!settings.voiceAttendanceIgnoreMuted;
    const ignoreDeafened = !!settings.voiceAttendanceIgnoreDeafened;
    const byChannel = new Map();
    const rawByChannel = new Map();   // channelId -> every raw connected state (mute/deaf included), BEFORE the ignoreMuted/ignoreDeafened filter - for the "who got tracked, muted or not" popup, which needs to show everyone seen, not just who was eligible to be credited
    // channelLabels preserves the live session's own party order ("Channel 1", "Channel 2", ...) for the
    // popup's per-channel grouping below - built fresh every check from status.parties itself, so a channel
    // the bot reports with nobody in it still gets its own "empty" row instead of silently disappearing.
    const channelLabels = new Map();
    for (const p of status.parties || []) {
      const states = p.connectedStates || (p.connectedUserIds || []).map((id) => ({ id }));
      rawByChannel.set(p.channelId, states);
      byChannel.set(p.channelId, presentIds(states, ignoreMuted, ignoreDeafened));
      if (p.channelId) channelLabels.set(p.channelId, `Channel ${p.index}`);
    }
    // Extra channels (guild-wide, Admin > Events, plus this event's own picker) are never part of the session
    // itself, so they're read through the bot's own channel-agnostic endpoint instead.
    const evExtraIds = new Set([...(settings.voiceTrackExtraChannelIds || []), ...(ev.voiceTrackExtraChannelIds || [])].filter(Boolean));
    const extraPresence = new Map();     // channelId -> Set of owner ids present in it
    const rawExtraByChannel = new Map();   // channelId -> raw connected states, same reason as rawByChannel above
    if (evExtraIds.size) {
      try {
        const r = await callBot(`/voice-presence?channels=${[...evExtraIds].map(encodeURIComponent).join(',')}`);
        for (const c of r.channels || []) if (c.found) { rawExtraByChannel.set(c.channelId, c.connectedStates || []); extraPresence.set(c.channelId, presentIds(c.connectedStates, ignoreMuted, ignoreDeafened)); }
      } catch { /* extra channels are a bonus, not a reason to skip the party channels below */ }
    }
    let extraNum = 0;
    for (const id of evExtraIds) { extraNum++; if (!channelLabels.has(id)) channelLabels.set(id, `Extra channel ${extraNum}`); }
    ev = findEvent(evId);
    if (!ev || !ev.voiceTracking || !ev.voiceTracking.active || ev.voiceTracking.finishedAt) return;
    // Keep the popup's channel list (id + label + whether it currently has anyone in it) fresh every check -
    // this is what lets "Who got tracked" show an empty channel as empty rather than just omitting it.
    ev.voiceTracking.channels = [...channelLabels.entries()].map(([channelId, label]) => ({
      channelId, label, empty: !(rawByChannel.get(channelId) || rawExtraByChannel.get(channelId) || []).length,
    }));
    // Every owner currently connected to ANY channel of this live session - every channel the bot actually
    // reported just now (byChannel, built above from status.parties in full), plus whichever extra channels
    // apply - regardless of whether ev.voiceTracking.partyChannels' own name/position matching ever managed to
    // attach a Guild Hall party to that specific channel. partyChannels exists for DISPLAY purposes only (the
    // dashboard's per-party deafened-count readout, and the "who got tracked" popup's grouping) - it is not,
    // and must not be, the gate on who gets credited. Matching a channel to a named party can fail or guess
    // wrong (no leader to match by name, and no snapshot because the session wasn't started tied to this
    // event) without that ever meaning "stop looking at this channel" - every channel in THIS live session
    // belongs to this event's track by definition (only one event is ever actively tracked against a given
    // session at a time - see the "any OTHER event still flagged as active" cleanup in beginVoiceTracking), so
    // there is no risk of crediting someone from an unrelated session by simply checking all of them.
    const sessionOwners = new Set();
    for (const ids of extraPresence.values()) for (const owner of ids) sessionOwners.add(owner);
    for (const ids of byChannel.values()) for (const owner of ids) sessionOwners.add(owner);
    ev.voiceTracking.sessionSeen = ev.voiceTracking.sessionSeen || [];
    ev.voiceTracking.seen = ev.voiceTracking.seen || {};
    const creditedOwnerOf = new Map();   // memberId -> owner id, for the raw sighting pass below
    for (const ownerId of sessionOwners) {
      // Whoever currently plays that owner's one active character gets the credit - or, if nobody active
      // matches, whichever mercenary character this guild brought in under that owner specifically for this
      // event (a mercenary is never "active", by design - see board() in app.js). An owner connected who
      // matches neither simply can't be credited - there's nothing to credit it to.
      const m = db().members.find((x) => x.owner === ownerId && x.active) || db().members.find((x) => x.owner === ownerId && x.mercenary && x.mercFor === ev.id);
      if (!m) continue;
      creditedOwnerOf.set(m.id, ownerId);
      // A plain union across this track's checks - seen once, in any one of them, is enough. No repeat-
      // sighting requirement any more; finalizeTrack is what actually turns this into real attendance.
      if (!ev.voiceTracking.sessionSeen.includes(m.id)) ev.voiceTracking.sessionSeen.push(m.id);
    }
    // The "who got tracked" popup's own log: every raw sighting this check, muted/deafened included, for
    // anyone present in ANY of this event's channels (the full live session, same reasoning as sessionOwners
    // above - not just whichever subset partyChannels' own matching happened to attach a party name to) - not
    // just the ones the ignoreMuted/ignoreDeafened settings would actually credit. Reset to {} on every
    // beginVoiceTracking (a fresh ev.voiceTracking object each time), so "Track again" naturally clears it too.
    // credited flips true (and mutedAtCredit/deafenedAtCredit freeze) only for a sighting that actually passed
    // the owner's filter this check - a muted player under ignoreMuted still shows up here, just never credited.
    // Each raw sighting keeps the channel it was actually seen in this check (channelId/channelLabel,
    // overwritten right alongside lastSeenAt/muted/deafened below) - this is what the "Who got tracked" popup
    // groups by, so an officer can see not just who was tracked but which specific channel they were in.
    const rawStates = [];
    for (const [channelId, states] of rawExtraByChannel) for (const s of states) rawStates.push({ s, channelId });
    for (const [channelId, states] of rawByChannel) for (const s of states) rawStates.push({ s, channelId });
    for (const { s, channelId } of rawStates) {
      const ownerId = s.id;
      const m = db().members.find((x) => x.owner === ownerId && x.active) || db().members.find((x) => x.owner === ownerId && x.mercenary && x.mercFor === ev.id);
      const entry = (ev.voiceTracking.seen[ownerId] = ev.voiceTracking.seen[ownerId] || { credited: false });
      entry.lastSeenAt = Date.now();
      entry.muted = !!s.mute;
      entry.deafened = !!s.deaf;
      entry.memberId = m ? m.id : null;
      entry.memberName = m ? m.name : null;
      entry.channelId = channelId;
      entry.channelLabel = channelLabels.get(channelId) || null;
      if (!entry.credited && m && creditedOwnerOf.get(m.id) === ownerId) {
        entry.credited = true;
        entry.mutedAtCredit = !!s.mute;
        entry.deafenedAtCredit = !!s.deaf;
      }
    }
    ev.voiceTracking.checksDone = (ev.voiceTracking.checksDone || 0) + 1;
    if (ev.voiceTracking.checksDone >= VOICE_CHECKS_TOTAL) {
      finalizeTrack(ev, null);
    } else {
      clearCheckTimer(ev.id);
      checkTimers.set(ev.id, setTimeout(() => { runCheck(ev.id, null).catch((e) => console.error('[voice-attendance] check failed:', e)); }, VOICE_CHECK_MS));
      save();
    }
  }
  // VOICE_POLL_INTERVAL_MS (env var name kept from before this track-model change, for test compatibility) is
  // now the gap between each of a track's checks, not a continuous poll's cadence. VOICE_CHECKS_TOTAL is
  // fixed, not guild-configurable - 3 checks, "once at the start and twice more 10 seconds apart", exactly as
  // asked for.
  const VOICE_CHECK_MS = Number(process.env.VOICE_POLL_INTERVAL_MS || 10000);
  const VOICE_CHECKS_TOTAL = 3;

  // ---------------------------------------------------------------- Testing: a live voice-attendance dry-run
  // Admin > Testing: lets an officer actually watch the whole voice-attendance pipeline work, end to end,
  // without needing a real event. Starts a throwaway 3-channel Shotcaller session (the anchor channel the
  // officer picks, plus 2 new ones the bot creates), waits the same kind of lead time a real event's
  // voiceTrackStartOffsetMinutes gives people to get settled, then runs the same fixed quick-check cycle real
  // tracking runs - once, then VOICE_CHECKS_TOTAL - 1 more checks VOICE_CHECK_MS apart, anyone seen in ANY one
  // of those checks reported as confirmed - and whether they were muted/deafened at the time, so an officer
  // can actually see the mute-ignoring setting's effect before trusting it on a real event. Confirmation here
  // is never gated by the mute-ignoring setting itself - the whole point is to show every confirmed tester's
  // mute state, not hide the ones it would exclude.
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
    voiceTest = { phase: 'starting', startedAt: Date.now(), trackAt: null, channels: [], error: null, confirmed: [], checksDone: 0, checksTotal: VOICE_CHECKS_TOTAL, nextCheckAt: null };
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
    if (voiceTest.phase === 'waiting') {
      if (Date.now() >= voiceTest.trackAt) { voiceTest.phase = 'tracking'; voiceTest.nextCheckAt = Date.now(); }
      return;
    }
    if (voiceTest.phase !== 'tracking') return;
    if (Date.now() < voiceTest.nextCheckAt) return;                      // not due for the next of the 3 quick checks yet
    let status;
    try { status = await cachedSession(); }
    catch { return; }                                                   // briefly unreachable - this check just learns nothing new, doesn't count against the 3
    if (!status || !status.active) { voiceTest.phase = 'ended'; return; }   // stopped from elsewhere (Discord command, say)
    const testIds = new Set(voiceTest.channels.map((c) => c.channelId));
    const now = Date.now();
    // A plain union across the test's (at most 3) checks, same as real tracking - seen once, in any one of
    // them, is enough to be reported confirmed. Already-confirmed testers just get their mute/deaf refreshed.
    for (const p of status.parties || []) {
      if (!testIds.has(p.channelId)) continue;
      for (const s of p.connectedStates || []) {
        const existing = voiceTest.confirmed.find((c) => c.ownerId === s.id);
        if (existing) { existing.mute = !!s.mute; existing.deaf = !!s.deaf; }
        else voiceTest.confirmed.push({ ownerId: s.id, name: vtNameFor(s.id), mute: !!s.mute, deaf: !!s.deaf, confirmedAt: new Date(now).toISOString() });
      }
    }
    voiceTest.checksDone += 1;
    if (voiceTest.checksDone >= voiceTest.checksTotal) voiceTest.phase = 'ended';
    else voiceTest.nextCheckAt = now + VOICE_CHECK_MS;
  }
  setInterval(() => { pollVoiceTest().catch((e) => console.error('[voice-test] poll failed:', e)); }, VT_POLL_MS);

  // ---------------------------------------------------------------- live panel
  route('GET', '/api/shotcaller/status', () => cachedSession(), { officer: true });

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
    // This dialog can be "set up from an event" (public/shotcaller.js) - when it was, freeze that event's
    // current party layout against the channels the bot just created for it, right now, while they're still
    // guaranteed to match - see snapshotVoiceSession's own comment for why. Tracking itself still only
    // actually begins later, by hand ("Start tracking now") or via "Track again" - this only makes sure
    // whichever one of those runs later still finds the right channel for every party.
    if (body.eventId) {
      const ev = findEvent(body.eventId);
      if (ev) {
        const realRest = ev.parties.slice(1).filter((p) => !partyIsPlaceholder(p));
        snapshotVoiceSession(ev, r, realRest);
        save();
      }
    }
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
  return { configured, checkCandidates, startSession, beginVoiceTracking, snapshotVoiceSession };
};
