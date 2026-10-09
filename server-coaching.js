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

  // A guest coach is an outsider, here only for the one class they were linked to - unlike a real (in-guild)
  // coach, they should never see footage of any other class, even footage its own owner or a real coach chose
  // to share with "everyone" or with a different class. That broader sharing is meant for guild members
  // browsing each other's VODs, not for someone outside the guild entirely.
  function isGuestCoach(user) { return db().guestCoaches.some((g) => g.discordId === user.key); }
  // Resolving a review's author to a display name has to cover both a real (in-guild) coach - an active member
  // - and a guest coach, who never has a member record at all.
  function reviewerName(key) {
    const m = db().members.find((x) => x.owner === key && x.active);
    if (m) return m.name;
    const g = db().guestCoaches.find((x) => x.discordId === key);
    return g ? g.name : key;
  }
  function canSeeVod(user, v) {
    if (isOfficer(user) || v.owner === user.key || v.postedBy === user.key) return true;
    if (isGuestCoach(user)) return coachesOf(v.owner).includes(user.key);
    if (coachesOf(v.owner).includes(user.key)) return true;   // the owner's own coach(es) can always see it, whatever the visibility is set to - not only when they happen to play the same class themselves
    if (v.visibility === 'everyone') return true;
    if (v.visibility === 'class') { const mine = db().members.find((m) => m.owner === user.key && m.active); return !!mine && classOf(mine) === v.visibleClass; }
    return false;   // private, and not the owner's coach
  }
  function canManageVod(user, v) {        // edit the title/note, delete it, change who posted it
    return isOfficer(user) || v.owner === user.key || coachesOf(v.owner).includes(user.key);
  }
  function canPromoteVisibility(user, v) {  // "everyone" / "a class" - the owner can choose this for their own VOD too, same as any coach or officer
    return isOfficer(user) || v.owner === user.key || coachesOf(v.owner).includes(user.key);
  }
  // When the owner themselves promotes visibility (rather than a coach or officer), "a class" can only
  // reasonably mean their own class - there is no sensible reason for a player to hand their own footage to a
  // class they do not play, so the client does not even offer the choice. A coach or officer keeps the full
  // picker, since cross-class sharing is sometimes exactly what they want (showing one class a strong example
  // from another, say).
  function promoteOwnClassOnly(user, v) { return v.owner === user.key && !isOfficer(user) && !coachesOf(v.owner).includes(user.key); }
  // "Finished reviewing" is deliberately narrower than canManageVod: a coach or officer declares themselves
  // done, never the player the VOD belongs to (they are the one being told, not the one confirming it), and
  // never on a spectator/overview recording, which is not really any one player's review to finish.
  function canReviewVod(user, v) { return !v.spectator && (isOfficer(user) || coachesOf(v.owner).includes(user.key)); }
  // A coaching point: a note pinned to an exact moment in the VOD, with an optional drawing that reappears on
  // its own during playback for a short window around that moment (see syncVodMarkerDisplay client-side) -
  // distinct from the live drawing overlay, which is never saved. Anyone who can manage the VOD can add one.
  function markerForClient(m) { return { ...m, strokes: Array.isArray(m.strokes) ? m.strokes : [], createdByName: reviewerName(m.createdBy) }; }
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
    // A guest coach (an applicant, never a member) gets none of the usual member/user lists that the client
    // would otherwise use to turn an owner key into a name or a class - so each VOD carries its own owner's
    // name and class here, resolved server-side where the full member list is actually available, instead of
    // relying on the client to look it up from data it may not have been sent.
    const vods = D.vods.filter((v) => canSeeVod(user, v)).map((v) => {
      const owner = D.members.find((m) => m.owner === v.owner && m.active);
      return {
        ...v,
        ownerName: owner ? owner.name : v.owner,
        ownerClass: owner ? classOf(owner) : '',
        markers: D.vodMarkers.filter((m) => m.vodId === v.id).map(markerForClient).sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
        // Each entry's canEdit/canResend is its own author only - even an officer cannot touch another coach's
        // review note, so the client never offers an Edit/Resend button it would just get a 403 from.
        reviews: (Array.isArray(v.reviews) ? v.reviews : []).map((r) => ({ ...r, byName: reviewerName(r.by), canEdit: r.by === user.key })),
        canManage: canManageVod(user, v), canPromote: canPromoteVisibility(user, v), promoteOwnClassOnly: promoteOwnClassOnly(user, v),
        canReview: canReviewVod(user, v),
      };
    });
    const myStudents = coach ? studentsOf(user.key) : [];
    return {
      isCoach: coach,
      myStudents,
      // Same reasoning as each VOD's ownerName above - a guest coach has no member list to resolve their own
      // students' names from, so hand the names over directly, keyed by the same owner key myStudents already
      // uses (the "For" picker on the post-a-VOD form needs exactly this).
      myStudentNames: Object.fromEntries(myStudents.map((key) => { const m = D.members.find((x) => x.owner === key && x.active); return [key, m ? m.name : key]; })),
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
      // A real YouTube URL never contains whitespace, but a pasted one sometimes picks up a stray space or
      // line break anyway - from how a link got shared, wrapped in a chat message, or copied out of one -
      // most often right after "/live/", "/shorts/" or "/embed/". A line that wraps and gets copied back out
      // often turns that same stray space into a literal "%20" instead (its URL-encoded form), which looks
      // like normal id characters at a glance (digits are "word" characters) and needs stripping on its own,
      // not just whitespace. Either way, strip it rather than rejecting an otherwise perfectly good link.
      const u = new URL(String(url || '').trim().replace(/\s+/g, '').replace(/%20/gi, ''));
      if (!/(^|\.)youtube\.com$/.test(u.hostname) && u.hostname !== 'youtu.be') return null;
      // youtu.be/ID and youtube.com/watch?v=ID are the two most common forms, but a VOD is very often a
      // livestream replay, which YouTube gives out as youtube.com/live/ID instead - and shorts/embed links get
      // pasted in sometimes too. All of these just put the id in a different place in the same URL.
      const pathMatch = /^\/(live|shorts|embed)\/([^/]+)/.exec(u.pathname);
      const raw = u.hostname === 'youtu.be' ? u.pathname.slice(1) : pathMatch ? pathMatch[2] : u.searchParams.get('v');
      // A real video id is exactly 11 letters/digits/-/_ characters, nothing else - but the same way a stray
      // space sometimes rides along with a pasted link, so can a stray leading or trailing character like a
      // lone "%" (seen in the wild right after "/live/"). Rather than rejecting the whole link over one odd
      // character next to an otherwise-valid id, look for the 11-character id itself within it.
      const id = /([\w-]{11})/.exec(raw || '');
      return id ? id[1] : null;
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
      visibility: 'private', visibleClass: '', reviews: [], finished: false,
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
      need(canPromoteVisibility(user, v), 403, 'Only the owner, a coach or an officer can change who else sees this.');
      need(['private', 'everyone', 'class'].includes(body.visibility), 400, 'Pick a valid visibility.');
      v.visibility = body.visibility;
      if (body.visibility === 'class') {
        // No class named (the owner's own picker never offers one - see promoteOwnClassOnly) falls back to
        // whatever class the owner currently plays, since that is the only sensible choice for them anyway.
        const ownerMember = D.members.find((m) => m.owner === v.owner && m.active);
        v.visibleClass = clean(body.visibleClass, 40) || (ownerMember ? classOf(ownerMember) : '');
      } else v.visibleClass = '';
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

  // ---------------------------------------------------------------- VOD reviews ("review note" / "add-on")
  // One append-only list per VOD. Writing a note here no longer marks the VOD as finished by itself (see the
  // dedicated /finished route below) - a coach can leave a note any time, including a quick one on a VOD they
  // are not done looking at yet, without it jumping the folder to "finished" behind their back.
  route('POST', '/api/vods/:id/reviews', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canReviewVod(user, v), 403, 'Only a coach or officer can review this VOD.');
    const note = clean(body.note, 1000);
    need(note, 400, 'Add a note before saving the review.');
    if (!Array.isArray(v.reviews)) v.reviews = [];
    const isFirst = v.reviews.length === 0;
    const review = { id: newId(), by: user.key, at: now(), note };
    v.reviews.push(review);
    save();
    audit(user, isFirst ? 'vod.review.write' : 'vod.review.addon', { type: 'vod', id: v.id, name: v.title }, `${user.name} ${isFirst ? 'wrote a review for' : 'added to the review of'} the VOD "${v.title}".`);
    const markerCount = D.vodMarkers.filter((mk) => mk.vodId === v.id).length;
    const points = markerCount ? ` (${markerCount} coaching point${markerCount === 1 ? '' : 's'})` : '';
    if (v.owner !== user.key) {
      notify(v.owner, `✅ ${user.name} ${isFirst ? 'reviewed' : 'added more to the review of'} your VOD "${v.title}"${points}.\n${note}\n${appUrl()}/#/vods/${v.id}`);
    }
    return { ...review, byName: reviewerName(review.by), canEdit: true };
  }, { applicant: true });

  route('PUT', '/api/vods/:id/reviews/:reviewId', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    const review = (v.reviews || []).find((r) => r.id === Number(params.reviewId));
    need(review, 404, 'Review not found.');
    // Only the coach/officer who actually wrote this entry can touch it - not even another officer, and not
    // the VOD's own owner, matching canReviewVod's "the one being told, not the one confirming it" split.
    need(review.by === user.key, 403, 'You can only edit your own review note.');
    const note = clean(body.note, 1000);
    need(note, 400, 'Add a note.');
    review.note = note;
    review.editedAt = now();
    save();
    return { ...review, byName: reviewerName(review.by), canEdit: true };
  }, { applicant: true });

  route('POST', '/api/vods/:id/reviews/:reviewId/resend', ({ user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    const review = (v.reviews || []).find((r) => r.id === Number(params.reviewId));
    need(review, 404, 'Review not found.');
    need(review.by === user.key, 403, 'You can only resend your own review note.');
    const markerCount = D.vodMarkers.filter((mk) => mk.vodId === v.id).length;
    const points = markerCount ? ` (${markerCount} coaching point${markerCount === 1 ? '' : 's'})` : '';
    if (v.owner !== user.key) {
      const lead = review.editedAt ? `${user.name} updated their review note on your VOD "${v.title}"` : `${user.name}'s review of your VOD "${v.title}"`;
      notify(v.owner, `✅ ${lead}${points}.\n${review.note}\n${appUrl()}/#/vods/${v.id}`);
    }
    audit(user, 'vod.review.resend', { type: 'vod', id: v.id, name: v.title }, `${user.name} resent their review note on the VOD "${v.title}".`);
    return { ok: true };
  }, { applicant: true });

  // Whether this VOD shows as finished in the folder - its own flag, deliberately separate from writing a
  // review note. Writing the first review note used to flip this on by itself, with no way back if a coach
  // did not actually mean to close it out yet; now a coach decides when it is done, and can just as easily
  // undo that if it was ticked by mistake.
  route('PUT', '/api/vods/:id/finished', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canReviewVod(user, v), 403, 'Only a coach or officer can mark a review as finished.');
    v.finished = !!body.finished;
    save();
    audit(user, v.finished ? 'vod.review.finish' : 'vod.review.unfinish', { type: 'vod', id: v.id, name: v.title }, `${user.name} marked the VOD "${v.title}" as ${v.finished ? 'finished' : 'not finished'}.`);
    return { finished: v.finished };
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
