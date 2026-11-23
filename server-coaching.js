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
  // Hotfix 1.46.2.2 (SA-06): a coach link only grants anything while its coach is an ACTIVE coach - removing
  // someone as a coach in Admin, kicking them, or losing their coach role takes effect on the very next request.
  // The links themselves stay stored, so re-instating the coach restores exactly the access they had. The lead's
  // server-side resolver provides ctx.isActiveCoach(key); the fallback below mirrors the sign-in rule for a server
  // without it (Discord mode: persisted record, not kicked, coach flag; passcode mode: the Admin coach list;
  // either way a guest coach counts). A kicked account is never an active coach, whatever any list says.
  function isActiveCoachKey(key) {
    const D = db(), rec = D.users ? D.users[key] : null;
    if (rec && rec.kicked) return false;
    if (typeof ctx.isActiveCoach === 'function') return !!ctx.isActiveCoach(key);
    if ((D.guestCoaches || []).some((g) => g.discordId === key)) return true;
    if (!discord.loginEnabled) return ((D.settings && D.settings.coachUserIds) || []).includes(key);
    return !!(rec && rec.coach);
  }
  // LOA fix (hotfix.4): a player's coaching class and VOD ownership come from their content character (server.js:
  // active, or still a guild member while marked Inactive e.g. on leave) - never from the activity flag alone.
  const charOf = (key) => (typeof ctx.contentCharacterOf === 'function' ? ctx.contentCharacterOf(key) : db().members.find((x) => x.owner === key && x.active));
  const isContentChar = (m) => (typeof ctx.isContentCharacter === 'function' ? ctx.isContentCharacter(m) : !!m.active);
  const activeLinks = () => db().coachLinks.filter((l) => isActiveCoachKey(l.coach));
  function classesCoachedBy(coachKey) { return isActiveCoachKey(coachKey) ? db().coachLinks.filter((l) => l.coach === coachKey).map((l) => l.class) : []; }
  function studentsOf(coachKey) {
    const classes = classesCoachedBy(coachKey);
    if (!classes.length) return [];
    return [...new Set(db().members.filter((m) => isContentChar(m) && classes.includes(classOf(m))).map((m) => m.owner))];
  }
  function coachesOf(ownerKey) {
    const m = charOf(ownerKey);
    const cls = m ? classOf(m) : null;
    if (!cls) return [];
    return [...new Set(activeLinks().filter((l) => l.class === cls).map((l) => l.coach))];
  }

  // A guest coach is an outsider, here only for the one class they were linked to - unlike a real (in-guild)
  // coach, they should never see footage of any other class, even footage its own owner or a real coach chose
  // to share with "everyone" or with a different class. That broader sharing is meant for guild members
  // browsing each other's VODs, not for someone outside the guild entirely.
  function isGuestCoach(user) { return db().guestCoaches.some((g) => g.discordId === user.key); }
  // Whether the requesting user coaches this owner right now: their own per-request coach status (user.coach,
  // from the server-side resolver - a guest coach always counts, as before) AND an active coach link for the
  // owner's current class. A user who is not a coach has no coach links at all, whatever is stored.
  function coachesOwner(user, ownerKey) {
    if (!user || !user.key || !(user.coach || isGuestCoach(user))) return false;
    return coachesOf(ownerKey).includes(user.key);
  }
  // Resolving a review's author to a display name has to cover both a real (in-guild) coach - an active member
  // - and a guest coach, who never has a member record at all.
  function reviewerName(key) {
    const m = charOf(key);
    if (m) return m.name;
    const g = db().guestCoaches.find((x) => x.discordId === key);
    return g ? g.name : key;
  }
  // B04 (hotfix.3): a guest coach (not also an officer) is limited to coaching work inside their one class. They see
  // a VOD only while its owner is in that class - not because they posted it once (their class may have changed) -
  // and they never edit the recording itself, change who sees it, or delete it. Their own coaching points and review
  // notes are theirs to edit and delete; nobody else's.
  const isGuestOnly = (user) => !!user && !isOfficer(user) && isGuestCoach(user);
  // hotfix.4: VOD rights that come from BEING a guild member - one's own VODs, VODs one posted, "everyone" and class
  // sharing - need a current guild member (live: not kicked, not departed). A kicked player signing in again is an
  // applicant and gets the application page only (D-4); guest coaches keep exactly their B04 rules below.
  const isMemberUser = (user) => !!user && !!user.key && (typeof ctx.isCurrentGuildMember === 'function' ? ctx.isCurrentGuildMember(user.key) : !user.kicked);
  function canSeeVod(user, v) {
    if (isOfficer(user)) return true;
    const member = isMemberUser(user);
    if (member && v.owner === user.key) return true;                 // one's own VOD (also a guest coach later accepted as a member)
    if (isGuestCoach(user)) return coachesOwner(user, v.owner);
    if (!member) return false;                                        // kicked / departed / other applicants: nothing
    // Historical authorship is attribution, never a continuing access grant.
    if (coachesOwner(user, v.owner)) return true;   // the owner's own coach(es) can always see it, whatever the visibility is set to - not only when they happen to play the same class themselves
    if (v.visibility === 'everyone') return true;
    if (v.visibility === 'class') { const mine = charOf(user.key); return !!mine && classOf(mine) === v.visibleClass; }
    return false;   // private, and not the owner's coach
  }
  function canManageVod(user, v) {        // edit the title/note, delete it, change who posted it
    if (isGuestOnly(user)) return v.owner === user.key && isMemberUser(user);   // a guest coach manages only a VOD of their own
    return isOfficer(user) || (v.owner === user.key && isMemberUser(user)) || coachesOwner(user, v.owner);
  }
  function canPromoteVisibility(user, v) {  // "everyone" / "a class" - the owner can choose this for their own VOD too, same as any coach or officer
    if (isGuestOnly(user)) return v.owner === user.key && isMemberUser(user);
    return isOfficer(user) || (v.owner === user.key && isMemberUser(user)) || coachesOwner(user, v.owner);
  }
  // Adding coaching points (timestamp + drawing): everyone who can manage the VOD, plus a guest coach of its owner.
  function canAnnotateVod(user, v) { return canManageVod(user, v) || (isGuestOnly(user) && coachesOwner(user, v.owner)); }
  // Editing / deleting one coaching point: unchanged for managers; a guest coach only their own, while still coaching the owner.
  function canEditMarker(user, v, marker) {
    if (isGuestOnly(user)) return !!marker && marker.createdBy === user.key && coachesOwner(user, v.owner);
    return canManageVod(user, v);
  }
  // When the owner themselves promotes visibility (rather than a coach or officer), "a class" can only
  // reasonably mean their own class - there is no sensible reason for a player to hand their own footage to a
  // class they do not play, so the client does not even offer the choice. A coach or officer keeps the full
  // picker, since cross-class sharing is sometimes exactly what they want (showing one class a strong example
  // from another, say).
  function promoteOwnClassOnly(user, v) { return v.owner === user.key && !isOfficer(user) && !coachesOwner(user, v.owner); }
  // "Finished reviewing" is deliberately narrower than canManageVod: a coach or officer declares themselves
  // done, never the player the VOD belongs to (they are the one being told, not the one confirming it), and
  // never on a spectator/overview recording, which is not really any one player's review to finish.
  function canReviewVod(user, v) { return !v.spectator && (isOfficer(user) || coachesOwner(user, v.owner)); }
  // Editing or resending one's own earlier review note needs the same standing that writing it did (officer, or
  // an active coach of the owner) - a coach removed since then can no longer reword it or DM the player with it.
  function canEditOwnReview(user, v) { return isOfficer(user) || coachesOwner(user, v.owner); }
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
  function coachingState(user, selectedVod=undefined) {
    const D = db(), off = isOfficer(user), coach = isCoach(user);
    // A guest coach (an applicant, never a member) gets none of the usual member/user lists that the client
    // would otherwise use to turn an owner key into a name or a class - so each VOD carries its own owner's
    // name and class here, resolved server-side where the full member list is actually available, instead of
    // relying on the client to look it up from data it may not have been sent.
    const markersByVod=new Map();
    for(const marker of D.vodMarkers){if(!markersByVod.has(marker.vodId))markersByVod.set(marker.vodId,[]);markersByVod.get(marker.vodId).push(marker);}
    const vods = D.vods.filter((v) => canSeeVod(user, v)).map((v) => {
      const mayEditReviews = canEditOwnReview(user, v);
      const owner = charOf(v.owner);
      return {
        ...v,
        ownerName: owner ? owner.name : v.owner,
        ownerClass: owner ? classOf(owner) : '',
        markerCount:(markersByVod.get(v.id) || []).length,
        markers:selectedVod===undefined || Number(selectedVod)===v.id ? (markersByVod.get(v.id) || []).map((mk) => ({ ...markerForClient(mk), canEdit: canEditMarker(user, v, mk) })).sort((a,b)=>a.timestamp-b.timestamp || a.id-b.id) : [],
        // Each entry's canEdit/canResend is its own author only - even an officer cannot touch another coach's
        // review note, so the client never offers an Edit/Resend button it would just get a 403 from.
        reviews: (Array.isArray(v.reviews) ? v.reviews : []).map((r) => ({ ...r, byName: reviewerName(r.by), canEdit: r.by === user.key && mayEditReviews, canDelete: r.by === user.key && mayEditReviews })),
        canManage: canManageVod(user, v), canPromote: canPromoteVisibility(user, v), promoteOwnClassOnly: promoteOwnClassOnly(user, v), canAnnotate: canAnnotateVod(user, v),
        canReview: canReviewVod(user, v),
      };
    });
    const myStudents = coach ? studentsOf(user.key) : [];
    return {
      isCoach: coach,
      myCoachClasses: coach ? classesCoachedBy(user.key) : [],
      myStudents,
      // Same reasoning as each VOD's ownerName above - a guest coach has no member list to resolve their own
      // students' names from, so hand the names over directly, keyed by the same owner key myStudents already
      // uses (the "For" picker on the post-a-VOD form needs exactly this).
      myStudentNames: Object.fromEntries(myStudents.map((key) => { const m = charOf(key); return [key, m ? m.name : key]; })),
      myCoaches: coachesOf(user.key),
      // Which class the signed-in person themselves coaches, if they are a guest coach checking their own
      // status on the join/switch-class page - not meaningful for a regular coach, who can have several.
      myGuestCoachClass: (coach || isGuestCoach(user)) ? (classesCoachedBy(user.key)[0] || null) : null,
      vods,
      coachLinks: off ? D.coachLinks : [],   // the full link list is only useful for the Admin page
      // Same reasoning as coachLinks above - officer-only, matching the Member page's Mercenaries section,
      // which this sits right alongside.
      guestCoaches: off ? D.guestCoaches.map((g) => ({ ...g, class: (D.coachLinks.find((l) => l.coach === g.discordId) || {}).class || '' })) : [],
      // B04: invitations for the Admin list - status, class, creator and dates only (never a token or its hash).
      guestInvites: off && ctx.guestInvites ? ctx.guestInvites.list().map(ctx.guestInvites.view).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 200) : [],
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
        // A guest coach keeps their coach flag (they are never in either Admin list - see /api/guest-coaches/join).
        u.coach = selected.has(u.id) || (u.discordRoles || []).some((r) => st.coachRoleIds.includes(r)) || D.guestCoaches.some((g) => g.discordId === u.id);
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
    need(discord.loginEnabled ? D.users[coach] : !!charOf(coach), 400, discord.loginEnabled ? 'The coach has to have signed in with Discord before.' : 'Pick a known player.');
    need((config.classes || []).some((c) => c.name === cls), 400, 'Pick a real class.');
    need(!D.guestCoaches.some((g) => g.discordId === coach), 409, 'This is a guest coach - change their class under Guest coaches instead.');   // B04: one class per guest coach
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
  // B04 (hotfix.3): a guest coach is created ONLY by redeeming a single-use invitation from an officer (see
  // guest-invites.js and the Discord callback in server.js). The old public self-enrolment is gone for good.
  route('POST', '/api/guest-coaches/join', () => {
    need(false, 410, 'Joining as a guest coach now needs a personal invitation link from an officer.');
  }, { applicant: true });

  // Invitations: any current officer (live check) creates, lists and revokes them, whoever created them.
  route('GET', '/api/admin/guest-invites', () => ctx.guestInvites.list().map(ctx.guestInvites.view).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), { officer: true });
  route('POST', '/api/admin/guest-invites', ({ body, user }) => {
    const cls = clean(body.class, 40);
    need((config.classes || []).some((c) => c.name === cls), 400, 'Pick a real class.');
    const pendingCount = ctx.guestInvites.list().filter((x) => ctx.guestInvites.statusOf(x) === 'pending').length;
    need(pendingCount < 50, 409, 'There are already 50 open invitations. Revoke some first.');
    const { invite, token } = ctx.guestInvites.create({ cls, officer: user, newId });
    save();
    audit(user, 'guestcoach.invite.create', { type: 'class', id: cls, name: cls }, `${user.name} created guest-coach invitation #${invite.id} for ${cls} players (valid 72 hours).`);
    const base = String((ctx.publicUrl && ctx.publicUrl()) || '').replace(/\/+$/, '');
    return { invite: ctx.guestInvites.view(invite), link: `${base}/#/guest-invite/${token}` };   // the only time the token leaves the server
  }, { officer: true });
  route('DELETE', '/api/admin/guest-invites/:id', ({ user, params }) => {
    const r = ctx.guestInvites.revoke(params.id, user);
    need(r.status !== 404, 404, 'Invitation not found.');
    need(r.ok, 409, 'Only an open invitation can be revoked.');
    save();
    audit(user, 'guestcoach.invite.revoke', { type: 'class', id: r.invite.class, name: r.invite.class }, `${user.name} revoked guest-coach invitation #${r.invite.id} for ${r.invite.class} players.`);
    return ctx.guestInvites.view(r.invite);
  }, { officer: true });

  route('PUT', '/api/guest-coaches/:discordId/class', ({ body, user, params }) => {
    const D = db(), gc = D.guestCoaches.find((g) => g.discordId === params.discordId);
    need(gc, 404, 'Guest coach not found.');
    const cls = clean(body.class, 40);
    need((config.classes || []).some((c) => c.name === cls), 400, 'Pick a real class.');
    const before = (D.coachLinks.find((l) => l.coach === gc.discordId) || {}).class || 'no class';
    D.coachLinks = D.coachLinks.filter((l) => l.coach !== gc.discordId);
    D.coachLinks.push({ id: newId(), coach: gc.discordId, class: cls, linkedAt: now() });
    save();
    audit(user, 'guestcoach.reassign', { type: 'player', id: gc.discordId, name: gc.name }, `${user.name} moved the guest coach ${gc.name} (Discord ${gc.discordId}) from ${before} to ${cls} players.`);
    return { class: cls };
  }, { officer: true });

  route('DELETE', '/api/guest-coaches/:discordId', ({ user, params }) => {
    const D = db(), i = D.guestCoaches.findIndex((g) => g.discordId === params.discordId);
    need(i >= 0, 404, 'Guest coach not found.');
    const [gone] = D.guestCoaches.splice(i, 1);
    D.coachLinks = D.coachLinks.filter((l) => l.coach !== gone.discordId);
    if (D.users[gone.discordId]) D.users[gone.discordId].coach = false;
    save();
    if (typeof ctx.revokeUserSessions === 'function') ctx.revokeUserSessions(gone.discordId, 'guest coach removed');   // B04: every session ends now
    audit(user, 'guestcoach.remove', { type: 'player', id: gone.discordId, name: gone.name }, `${user.name} removed ${gone.name} (Discord ${gone.discordId}) as a guest coach and signed them out everywhere.`);
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
    const m = charOf(owner) || (isOfficer(user) ? D.members.find(x => x.owner === owner && !x.mercenary && !x.pendingApproval) : null);
    need(m, 404, 'That player has no character in the guild.');
    need(owner === user.key || isOfficer(user) || coachesOwner(user, owner), 403, "You can only post VODs for yourself or a player you coach.");
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
    const D = db(), original = D.vods.find((x) => x.id === Number(params.id));
    need(original, 404, 'VOD not found.');
    need(canManageVod(user, original), 403, 'You can only edit your own VODs, or VODs of a player you coach.');
    // Validate a detached candidate. A 400/403 must not change live or later-persisted state.
    const v = { ...original };
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
        const ownerMember = charOf(v.owner);
        v.visibleClass = clean(body.visibleClass, 40) || (ownerMember ? classOf(ownerMember) : '');
      } else v.visibleClass = '';
      need(v.visibility !== 'class' || (config.classes || []).some((c) => c.name === v.visibleClass), 400, 'Pick a real class.');
    }
    Object.assign(original, v);
    save();
    return original;
  }, { applicant: true });

  route('POST', '/api/vods/:id/markers', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canAnnotateVod(user, v), 403, 'You can only add coaching points to VODs you can manage.');
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
    const marker = D.vodMarkers.find((x) => x.id === Number(params.markerId) && x.vodId === v.id);
    need(canEditMarker(user, v, marker), 403, 'You can only edit coaching points on VODs you can manage.');
    need(marker, 404, 'Coaching point not found.');
    Object.assign(marker, cleanMarker(body), { updatedAt: now() });
    save();
    return markerForClient(marker);
  }, { applicant: true });

  route('DELETE', '/api/vods/:id/markers/:markerId', ({ user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    const i = D.vodMarkers.findIndex((x) => x.id === Number(params.markerId) && x.vodId === v.id);
    need(canEditMarker(user, v, D.vodMarkers[i]), 403, 'You can only delete coaching points from VODs you can manage.');
    need(i >= 0, 404, 'Coaching point not found.');
    D.vodMarkers.splice(i, 1);
    save();
    return { ok: true };
  }, { applicant: true });

  // ---------------------------------------------------------------- VOD reviews ("review note" / "add-on")
  // One append-only list per VOD. Writing a note here no longer marks the VOD as finished by itself (see the
  // dedicated /finished route below) - a coach can leave a note any time, including a quick one on a VOD they
  // are not done looking at yet, without it jumping the folder to "finished" behind their back.
  //
  // The note gets wrapped in a notify() DM to the player (see below) - Discord rejects any message content
  // over 2000 characters outright, and notify() is fire-and-forget (never surfaces that failure back to the
  // coach), so this has to stay comfortably under that limit even after the "<name> reviewed your VOD ..."
  // wrapper text and the link at the end are added on top of it. 300 characters of headroom covers that
  // wrapper with room to spare. Same idea as the 1900-char cap on the Discord party-post text in
  // server-community.js, just with more of a margin here since this one has more text wrapped around it.
  const REVIEW_NOTE_MAX = 1700;
  route('POST', '/api/vods/:id/reviews', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canReviewVod(user, v), 403, 'Only a coach or officer can review this VOD.');
    const note = clean(body.note, REVIEW_NOTE_MAX);
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
    need(canEditOwnReview(user, v), 403, 'Only a coach or officer can edit a review note.');
    const note = clean(body.note, REVIEW_NOTE_MAX);
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
    need(canEditOwnReview(user, v), 403, 'Only a coach or officer can resend a review note.');
    const markerCount = D.vodMarkers.filter((mk) => mk.vodId === v.id).length;
    const points = markerCount ? ` (${markerCount} coaching point${markerCount === 1 ? '' : 's'})` : '';
    if (v.owner !== user.key) {
      const lead = review.editedAt ? `${user.name} updated their review note on your VOD "${v.title}"` : `${user.name}'s review of your VOD "${v.title}"`;
      notify(v.owner, `✅ ${lead}${points}.\n${review.note}\n${appUrl()}/#/vods/${v.id}`);
    }
    audit(user, 'vod.review.resend', { type: 'vod', id: v.id, name: v.title }, `${user.name} resent their review note on the VOD "${v.title}".`);
    return { ok: true };
  }, { applicant: true });

  // B04 (hotfix.3): deleting one's own review note - the author only, with the same standing as editing it.
  route('DELETE', '/api/vods/:id/reviews/:reviewId', ({ user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    const list = Array.isArray(v.reviews) ? v.reviews : [];
    const i = list.findIndex((r) => r.id === Number(params.reviewId));
    need(i >= 0, 404, 'Review not found.');
    need(list[i].by === user.key, 403, 'You can only delete your own review note.');
    need(canEditOwnReview(user, v), 403, 'Only a coach or officer can delete a review note.');
    list.splice(i, 1);
    save();
    audit(user, 'vod.review.delete', { type: 'vod', id: v.id, name: v.title }, `${user.name} deleted their review note on the VOD "${v.title}".`);
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

  return { coachingState, studentsOf, classesCoachedBy };
};
