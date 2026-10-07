// Class coaches: a role narrower than officer (granted the same way, in Admin), each linked to the students
// they coach. Students (or their coach) post YouTube VOD links; a coach reviews them live over Discord voice,
// drawing on a transparent overlay while talking - nothing about that needs this server, since the drawing and
// the "watching together" both happen in the viewer's own browser and over Discord's own screen share. What
// this module actually owns: who is a coach, who they coach, and the VOD links themselves and who can see each one.

module.exports = function install(ctx) {
  const { route, need, clean, newId, save, config, isOfficer, isCoach, audit, discord, appUrl } = ctx;
  const notify = (ownerKey, text) => { discord.sendDM(ownerKey, text).catch(() => {}); };   // best effort, never blocks a request
  const db = () => ctx.db;
  const now = () => new Date().toISOString();

  // Same weapon-pair-to-class lookup the client uses for the live class preview on a character form, needed
  // here only to decide whether a VOD shared with "a class" should be visible to a particular viewer.
  function classOf(m) {
    if (!m || !m.primaryWeapon || !m.secondaryWeapon || m.primaryWeapon === m.secondaryWeapon) return null;
    const pair = [m.primaryWeapon, m.secondaryWeapon].sort().join('|');
    const hit = (config.classes || []).find((c) => [...c.weapons].sort().join('|') === pair);
    return hit ? hit.name : null;
  }

  // A coach is linked to one or more CLASSES, not to specific players one at a time - whoever is currently
  // playing that class is automatically "their student", so the list never needs manual upkeep as people join,
  // leave, or switch classes. Both directions are needed (a coach's own list of students; a player's own VODs
  // showing whose private view they are in), both computed fresh from the current roster each time.
  function classesCoachedBy(coachKey) { return db().coachLinks.filter((l) => l.coach === coachKey).map((l) => l.class); }
  function studentsOf(coachKey) {
    const classes = classesCoachedBy(coachKey);
    if (!classes.length) return [];
    return [...new Set(db().members.filter((m) => m.active && classes.includes(classOf(m))).map((m) => m.owner))];
  }
  function coachesOf(ownerKey) {
    const m = db().members.find((x) => x.owner === ownerKey && x.active);
    const cls = m ? classOf(m) : null;
    if (!cls) return [];
    return [...new Set(db().coachLinks.filter((l) => l.class === cls).map((l) => l.coach))];
  }

  function canSeeVod(user, v) {
    if (isOfficer(user) || v.owner === user.key || v.postedBy === user.key) return true;
    if (v.visibility === 'everyone') return true;
    if (v.visibility === 'class') { const mine = db().members.find((m) => m.owner === user.key && m.active); return !!mine && classOf(mine) === v.visibleClass; }
    return coachesOf(v.owner).includes(user.key);   // private: only the owner's own coach(es), handled above too but kept explicit
  }
  function canManageVod(user, v) {        // edit the title/note, delete it, change who posted it
    return isOfficer(user) || v.owner === user.key || coachesOf(v.owner).includes(user.key);
  }
  function canPromoteVisibility(user, v) {  // "everyone" / "a class" - never the owner's own choice
    return isOfficer(user) || coachesOf(v.owner).includes(user.key);
  }
  // A coaching point: a note pinned to an exact moment in the VOD, with an optional drawing that reappears on
  // its own during playback for a short window around that moment (see syncVodMarkerDisplay client-side) -
  // distinct from the live drawing overlay, which is never saved. Anyone who can manage the VOD can add one.
  function markerForClient(m) { return { ...m, strokes: Array.isArray(m.strokes) ? m.strokes : [] }; }
  function cleanMarker(body) {
    const timestamp = Number(body.timestamp);
    const before = Number(body.beforeSeconds === undefined ? 2 : body.beforeSeconds);
    const after = Number(body.afterSeconds === undefined ? 2 : body.afterSeconds);
    need(Number.isFinite(timestamp) && timestamp >= 0, 400, 'Pick a valid VOD timestamp.');
    need(Number.isFinite(before) && before >= 0 && before <= 10, 400, 'The time before must be between 0 and 10 seconds.');
    need(Number.isFinite(after) && after >= 0 && after <= 10, 400, 'The time after must be between 0 and 10 seconds.');
    const note = clean(body.note, 500);
    need(note, 400, 'Add a note to the coaching point.');
    // Strokes are optional - a coaching point can be a plain timestamped note with nothing drawn on it. Points
    // are stored as fractions of the video frame (0 to 1), not pixels, so they still line up correctly no
    // matter what size the player is drawn at when the point is viewed again later.
    const strokes = Array.isArray(body.strokes) ? body.strokes.slice(0, 200) : [];
    const safeStrokes = strokes.map((stroke) => {
      const points = Array.isArray(stroke && stroke.points) ? stroke.points.slice(0, 1000) : [];
      return {
        color: /^#[0-9a-fA-F]{6}$/.test(String((stroke && stroke.color) || '')) ? String(stroke.color) : '#e2685c',
        points: points.map((pt) => [Math.max(0, Math.min(1, Number(pt && pt[0]))), Math.max(0, Math.min(1, Number(pt && pt[1])))])
          .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1])),
      };
    }).filter((stroke) => stroke.points.length >= 2);
    return { timestamp: Math.round(timestamp * 1000) / 1000, beforeSeconds: Math.round(before * 100) / 100, afterSeconds: Math.round(after * 100) / 100, note, strokes: safeStrokes };
  }

  // What a signed-in person needs about coaching: their own coach status, who they coach (if anyone), who
  // coaches them (if anyone, just so their own profile can say so), and the VODs they can see.
  function coachingState(user) {
    const D = db(), off = isOfficer(user), coach = isCoach(user);
    const vods = D.vods.filter((v) => canSeeVod(user, v)).map((v) => ({
      ...v,
      markers: D.vodMarkers.filter((m) => m.vodId === v.id).map(markerForClient).sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
      canManage: canManageVod(user, v), canPromote: canPromoteVisibility(user, v),
    }));
    return {
      isCoach: coach,
      myStudents: coach ? studentsOf(user.key) : [],
      myCoaches: coachesOf(user.key),
      // Which class the signed-in person themselves coaches, if they are a guest coach checking their own
      // status on the join/switch-class page - not meaningful for a regular coach, who can have several.
      myGuestCoachClass: classesCoachedBy(user.key)[0] || null,
      vods,
      coachLinks: off ? D.coachLinks : [],   // the full link list is only useful for the Admin page
      // Same reasoning as coachLinks above - officer-only, matching the Member page's Mercenaries section,
      // which this sits right alongside.
      guestCoaches: off ? D.guestCoaches.map((g) => ({ ...g, class: (D.coachLinks.find((l) => l.coach === g.discordId) || {}).class || '' })) : [],
    };
  }

  // ---------------------------------------------------------------- Admin: who is a coach, who they coach
  route('PUT', '/api/admin/coaches', ({ body }) => {
    const st = db().settings;
    if (body.roleIds !== undefined) {
      const ids = Array.isArray(body.roleIds) ? body.roleIds : [];
      need(ids.length <= 10, 400, 'Pick up to 10 roles.');
      const cleanIds = [...new Set(ids.map((id) => String(id)))];
      need(cleanIds.every((id) => /^\d{15,25}$/.test(id)), 400, 'That does not look like a Discord role.');
      st.coachRoleIds = cleanIds;
    }
    if (body.userIds !== undefined) {
      const ids = Array.isArray(body.userIds) ? body.userIds : [];
      need(ids.length <= 100, 400, 'That is a lot of individually-chosen coaches - double check the list.');
      st.coachUserIds = [...new Set(ids.map((id) => clean(id, 40)).filter(Boolean))];
    }

    // Keep already-signed-in users in sync with the Admin setting. The session token is
    // deliberately short-lived state, so without this update a player selected here
    // would not become a coach until their next Discord sign-in.
    const D = db();
    if (body.userIds !== undefined) {
      const selected = new Set(st.coachUserIds);
      for (const u of Object.values(D.users)) {
        if (!u) continue;
        u.coach = selected.has(u.id) || (u.discordRoles || []).some((r) => st.coachRoleIds.includes(r));
      }
    }
    save();
    return st;
  }, { officer: true });

  route('POST', '/api/admin/coach-links', ({ body, user }) => {
    const D = db(), coach = clean(body.coach, 40), cls = clean(body.class, 40);
    need(coach && cls, 400, 'Pick a coach and a class.');
    // Discord mode: the coach must have an actual signed-in record. Passcode mode has no such record for
    // anyone at all (see /api/login), so a known player - someone who owns an active character - is the
    // closest equivalent, and the same set the admin picker itself was built from.
    need(discord.loginEnabled ? D.users[coach] : D.members.some((m) => m.owner === coach && m.active), 400, discord.loginEnabled ? 'The coach has to have signed in with Discord before.' : 'Pick a known player.');
    need((config.classes || []).some((c) => c.name === cls), 400, 'Pick a real class.');
    need(!D.coachLinks.some((l) => l.coach === coach && l.class === cls), 409, 'Already linked.');
    const link = { id: newId(), coach, class: cls, linkedAt: now() };
    D.coachLinks.push(link);
    save();
    audit(user, 'coach.link', { type: 'class', id: cls, name: cls }, `${user.name} linked ${D.users[coach] ? D.users[coach].name : coach} as a coach for ${cls} players.`);
    return link;
  }, { officer: true });

  route('DELETE', '/api/admin/coach-links/:id', ({ user, params }) => {
    const D = db(), i = D.coachLinks.findIndex((l) => l.id === Number(params.id));
    need(i >= 0, 404, 'Link not found.');
    const [gone] = D.coachLinks.splice(i, 1);
    save();
    audit(user, 'coach.unlink', { type: 'class', id: gone.class, name: gone.class }, `${user.name} removed ${D.users[gone.coach] ? D.users[gone.coach].name : gone.coach} as a coach for ${gone.class} players.`);
    return { ok: true };
  }, { officer: true });

  // ---------------------------------------------------------------- Guest class coaches
  // Someone outside the guild entirely, there only to coach one class - never a member in any other sense.
  // They reach this the same way a mercenary reaches event sign-up: a link an officer shares (Admin > Guest
  // coaches), which lets their very first Discord sign-in through even with general applications switched off
  // (see the OAuth callback in server.js). The link itself is the only gate, the same trust model mercenaries
  // already use - there is deliberately no approval step here either.
  route('POST', '/api/guest-coaches/join', ({ body, user }) => {
    const D = db(), cls = clean(body.class, 40);
    need(user.role === 'applicant', 400, 'Only someone who is not already a guild member can join as a guest coach.');
    need((config.classes || []).some((c) => c.name === cls), 400, 'Pick a real class.');
    if (!D.guestCoaches.some((g) => g.discordId === user.key)) {
      D.guestCoaches.push({ id: newId(), discordId: user.key, name: user.name, avatar: user.avatar || '', addedAt: now() });
    }
    // One class at a time, swapped rather than added to - a guest coach is "the Oracle guest coach", not
    // gradually accumulating classes the way a real coach might.
    D.coachLinks = D.coachLinks.filter((l) => l.coach !== user.key);
    D.coachLinks.push({ id: newId(), coach: user.key, class: cls, linkedAt: now() });
    // The session that just joined was issued before this existed, so its own token still says coach: false -
    // update the persisted record directly so the auth middleware's live re-check (the same one that already
    // keeps a regular coach's status current without a fresh sign-in) picks this up on their very next request.
    if (D.users[user.key]) D.users[user.key].coach = true;
    save();
    audit(user, 'guestcoach.join', { type: 'player', id: user.key, name: user.name }, `${user.name} joined as a guest coach for ${cls} players.`);
    return { class: cls };
  }, { applicant: true });

  route('PUT', '/api/guest-coaches/:discordId/class', ({ body, user, params }) => {
    const D = db(), gc = D.guestCoaches.find((g) => g.discordId === params.discordId);
    need(gc, 404, 'Guest coach not found.');
    const cls = clean(body.class, 40);
    need((config.classes || []).some((c) => c.name === cls), 400, 'Pick a real class.');
    D.coachLinks = D.coachLinks.filter((l) => l.coach !== gc.discordId);
    D.coachLinks.push({ id: newId(), coach: gc.discordId, class: cls, linkedAt: now() });
    save();
    audit(user, 'guestcoach.reassign', { type: 'player', id: gc.discordId, name: gc.name }, `${user.name} moved the guest coach ${gc.name} to ${cls} players.`);
    return { class: cls };
  }, { officer: true });

  route('DELETE', '/api/guest-coaches/:discordId', ({ user, params }) => {
    const D = db(), i = D.guestCoaches.findIndex((g) => g.discordId === params.discordId);
    need(i >= 0, 404, 'Guest coach not found.');
    const [gone] = D.guestCoaches.splice(i, 1);
    D.coachLinks = D.coachLinks.filter((l) => l.coach !== gone.discordId);
    if (D.users[gone.discordId]) D.users[gone.discordId].coach = false;
    save();
    audit(user, 'guestcoach.remove', { type: 'player', id: gone.discordId, name: gone.name }, `${user.name} removed ${gone.name} as a guest coach.`);
    return { ok: true };
  }, { officer: true });

  // ---------------------------------------------------------------- VODs
  function parseYoutube(url) {
    try {
      const u = new URL(String(url || '').trim());
      if (!/(^|\.)youtube\.com$/.test(u.hostname) && u.hostname !== 'youtu.be') return null;
      // youtu.be/ID and youtube.com/watch?v=ID are the two most common forms, but a VOD is very often a
      // livestream replay, which YouTube gives out as youtube.com/live/ID instead - and shorts/embed links get
      // pasted in sometimes too. All of these just put the id in a different place in the same URL.
      const pathMatch = /^\/(live|shorts|embed)\/([^/]+)/.exec(u.pathname);
      const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : pathMatch ? pathMatch[2] : u.searchParams.get('v');
      return /^[\w-]{11}$/.test(id || '') ? id : null;
    } catch { return null; }
  }

  const VOD_TYPES = config.vodTypes || [];
  const VOD_TYPES_WITH_ENEMY = config.vodTypesWithEnemy || [];   // Siege, BG and Testing have no single opponent worth naming
  const fmtVodDate = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`; };
  // The name is always built from type + date (+ enemy guild where that applies), never typed by hand - "Wargame
  // vs Rivals 21.07.2026" or "Siege 26.09.2026" - so the library stays consistent without anyone having to agree
  // on a naming convention themselves.
  const vodTitle = (type, recordedDate, enemyGuild) => enemyGuild ? `${type} vs ${enemyGuild} ${fmtVodDate(recordedDate)}` : `${type} ${fmtVodDate(recordedDate)}`;
  const validVodFields = (body, v) => {
    const type = body.type !== undefined ? clean(body.type, 30) : v.type;
    need(VOD_TYPES.includes(type), 400, 'Pick a real gameplay type.');
    const recordedDate = body.recordedDate !== undefined ? String(body.recordedDate).trim() : v.recordedDate;
    need(/^\d{4}-\d{2}-\d{2}$/.test(recordedDate) && !isNaN(new Date(recordedDate + 'T00:00:00Z')), 400, 'Pick a valid recording date.');
    const enemyGuild = VOD_TYPES_WITH_ENEMY.includes(type) ? clean(body.enemyGuild !== undefined ? body.enemyGuild : v.enemyGuild, 60) : '';
    // A wide-angle/overview recording, not any one player's own combat view - it goes in its own "Spectator
    // PoV" folder instead of a class folder regardless of whoever's account it is posted under, since the
    // owner's class is not really what the footage is about.
    const spectator = body.spectator !== undefined ? !!body.spectator : !!v.spectator;
    return { type, recordedDate, enemyGuild, spectator };
  };

  route('POST', '/api/vods', ({ body, user }) => {
    const D = db();
    const owner = clean(body.owner, 40) || user.key;
    const m = D.members.find((x) => x.owner === owner && x.active);
    need(m, 404, 'That player has no active character.');
    need(owner === user.key || isOfficer(user) || coachesOf(owner).includes(user.key), 403, "You can only post VODs for yourself or a player you coach.");
    const videoId = parseYoutube(body.url);
    need(videoId, 400, 'That does not look like a YouTube link.');
    const { type, recordedDate, enemyGuild, spectator } = validVodFields(body, { type: '', recordedDate: '', enemyGuild: '', spectator: false });
    const v = {
      id: newId(), owner, postedBy: user.key, postedAt: now(), url: String(body.url).trim(), videoId,
      type, recordedDate, enemyGuild, spectator, title: vodTitle(type, recordedDate, enemyGuild), note: clean(body.note, 500),
      visibility: 'private', visibleClass: '',
    };
    D.vods.push(v);
    save();
    audit(user, 'vod.create', { type: 'vod', id: v.id, name: v.title }, `${user.name} posted a VOD ("${v.title}") for ${m.name}.`);
    // Whoever coaches this player's current class gets a DM the moment a VOD is posted for them - private by
    // default or not, a coach can already see any VOD for their own students, so there is no visibility check
    // to make here. Posting for yourself does not DM yourself, and a spectator recording is not really "for"
    // any one class, so neither sends anything.
    if (!spectator) {
      // Guest coaches are deliberately left out here - notified on request would mean pinging someone outside
      // the guild for every single upload, which is not wanted. They can still always see the VOD itself
      // (coachesOf, used for visibility elsewhere, is untouched) - just no DM about it landing.
      const guestCoachIds = new Set(D.guestCoaches.map((g) => g.discordId));
      for (const coachKey of coachesOf(owner)) {
        if (coachKey !== user.key && !guestCoachIds.has(coachKey)) notify(coachKey, `🎬 New VOD posted for ${m.name}: "${v.title}"${v.note ? `\n${v.note}` : ''}\n${appUrl()}/#/vods/${v.id}`);
      }
    }
    return v;
  }, { applicant: true });   // a guest class coach (an applicant, never a member) can post a VOD for their student

  route('PUT', '/api/vods/:id', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canManageVod(user, v), 403, 'You can only edit your own VODs, or VODs of a player you coach.');
    if (body.type !== undefined || body.recordedDate !== undefined || body.enemyGuild !== undefined || body.spectator !== undefined) {
      Object.assign(v, validVodFields(body, v));
      v.title = vodTitle(v.type, v.recordedDate, v.enemyGuild);
    }
    if (body.note !== undefined) v.note = clean(body.note, 500);
    if (body.visibility !== undefined) {
      need(canPromoteVisibility(user, v), 403, 'Only a coach or an officer can change who else sees this.');
      need(['private', 'everyone', 'class'].includes(body.visibility), 400, 'Pick a valid visibility.');
      v.visibility = body.visibility;
      v.visibleClass = body.visibility === 'class' ? clean(body.visibleClass, 40) : '';
      need(v.visibility !== 'class' || (config.classes || []).some((c) => c.name === v.visibleClass), 400, 'Pick a real class.');
    }
    save();
    return v;
  }, { applicant: true });

  route('POST', '/api/vods/:id/markers', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canManageVod(user, v), 403, 'You can only add coaching points to VODs you can manage.');
    const data = cleanMarker(body);
    const marker = { id: newId(), vodId: v.id, createdBy: user.key, createdAt: now(), ...data };
    D.vodMarkers.push(marker);
    save();
    audit(user, 'vod.marker.create', { type: 'vod', id: v.id, name: v.title }, `${user.name} added a coaching point at ${data.timestamp}s to the VOD "${v.title}".`);
    return markerForClient(marker);
  }, { applicant: true });

  route('PUT', '/api/vods/:id/markers/:markerId', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canManageVod(user, v), 403, 'You can only edit coaching points on VODs you can manage.');
    const marker = D.vodMarkers.find((x) => x.id === Number(params.markerId) && x.vodId === v.id);
    need(marker, 404, 'Coaching point not found.');
    Object.assign(marker, cleanMarker(body), { updatedAt: now() });
    save();
    return markerForClient(marker);
  }, { applicant: true });

  route('DELETE', '/api/vods/:id/markers/:markerId', ({ user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canManageVod(user, v), 403, 'You can only delete coaching points from VODs you can manage.');
    const i = D.vodMarkers.findIndex((x) => x.id === Number(params.markerId) && x.vodId === v.id);
    need(i >= 0, 404, 'Coaching point not found.');
    D.vodMarkers.splice(i, 1);
    save();
    return { ok: true };
  }, { applicant: true });

  route('DELETE', '/api/vods/:id', ({ user, params }) => {
    const D = db(), i = D.vods.findIndex((x) => x.id === Number(params.id));
    need(i >= 0, 404, 'VOD not found.');
    need(canManageVod(user, D.vods[i]), 403, 'You can only delete your own VODs, or VODs of a player you coach.');
    const [gone] = D.vods.splice(i, 1);
    D.vodMarkers = D.vodMarkers.filter((m) => m.vodId !== gone.id);
    save();
    audit(user, 'vod.delete', { type: 'vod', id: gone.id, name: gone.title }, `${user.name} deleted the VOD "${gone.title}".`);
    return { ok: true };
  }, { applicant: true });

  return { coachingState, studentsOf };
};
