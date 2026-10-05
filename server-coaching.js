// Class coaches: a role narrower than officer (granted the same way, in Admin), each linked to the students
// they coach. Students (or their coach) post YouTube VOD links; a coach reviews them live over Discord voice,
// drawing on a transparent overlay while talking - nothing about that needs this server, since the drawing and
// the "watching together" both happen in the viewer's own browser and over Discord's own screen share. What
// this module actually owns: who is a coach, who they coach, and the VOD links themselves and who can see each one.

module.exports = function install(ctx) {
  const { route, need, clean, newId, save, config, isOfficer, isCoach, audit } = ctx;
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

  // Everyone this Discord account coaches, and everyone who coaches them - both directions are needed (a coach
  // looking at their list of students; a student's own VODs showing whose private view they're in).
  const coachesOf = (ownerKey) => db().coachLinks.filter((l) => l.student === ownerKey).map((l) => l.coach);
  const studentsOf = (ownerKey) => db().coachLinks.filter((l) => l.coach === ownerKey).map((l) => l.student);

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

  // What a signed-in person needs about coaching: their own coach status, who they coach (if anyone), who
  // coaches them (if anyone, just so their own profile can say so), and the VODs they can see.
  function coachingState(user) {
    const D = db(), off = isOfficer(user), coach = isCoach(user);
    const vods = D.vods.filter((v) => canSeeVod(user, v)).map((v) => ({ ...v, canManage: canManageVod(user, v), canPromote: canPromoteVisibility(user, v) }));
    return {
      isCoach: coach,
      myStudents: coach ? studentsOf(user.key) : [],
      myCoaches: coachesOf(user.key),
      vods,
      coachLinks: off ? D.coachLinks : [],   // the full link list is only useful for the Admin page
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
    save();
    return st;
  }, { officer: true });

  route('POST', '/api/admin/coach-links', ({ body, user }) => {
    const D = db(), coach = clean(body.coach, 40), student = clean(body.student, 40);
    need(coach && student && coach !== student, 400, 'Pick a coach and a student.');
    need(D.users[coach], 400, 'The coach has to have signed in with Discord before.');
    need(D.members.some((m) => m.owner === student && m.active), 400, 'Pick an active player.');
    need(!D.coachLinks.some((l) => l.coach === coach && l.student === student), 409, 'Already linked.');
    const link = { id: newId(), coach, student, linkedAt: now() };
    D.coachLinks.push(link);
    save();
    audit(user, 'coach.link', { type: 'player', id: student, name: D.users[student] ? D.users[student].name : student }, `${user.name} linked ${D.users[coach].name} as a coach for ${D.users[student] ? D.users[student].name : student}.`);
    return link;
  }, { officer: true });

  route('DELETE', '/api/admin/coach-links/:id', ({ user, params }) => {
    const D = db(), i = D.coachLinks.findIndex((l) => l.id === Number(params.id));
    need(i >= 0, 404, 'Link not found.');
    const [gone] = D.coachLinks.splice(i, 1);
    save();
    audit(user, 'coach.unlink', { type: 'player', id: gone.student, name: D.users[gone.student] ? D.users[gone.student].name : gone.student }, `${user.name} removed ${D.users[gone.coach] ? D.users[gone.coach].name : gone.coach} as a coach for ${D.users[gone.student] ? D.users[gone.student].name : gone.student}.`);
    return { ok: true };
  }, { officer: true });

  // ---------------------------------------------------------------- VODs
  function parseYoutube(url) {
    try {
      const u = new URL(String(url || '').trim());
      if (!/(^|\.)youtube\.com$/.test(u.hostname) && u.hostname !== 'youtu.be') return null;
      const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
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
    return { type, recordedDate, enemyGuild };
  };

  route('POST', '/api/vods', ({ body, user }) => {
    const D = db();
    const owner = clean(body.owner, 40) || user.key;
    const m = D.members.find((x) => x.owner === owner && x.active);
    need(m, 404, 'That player has no active character.');
    need(owner === user.key || isOfficer(user) || coachesOf(owner).includes(user.key), 403, "You can only post VODs for yourself or a player you coach.");
    const videoId = parseYoutube(body.url);
    need(videoId, 400, 'That does not look like a YouTube link.');
    const { type, recordedDate, enemyGuild } = validVodFields(body, { type: '', recordedDate: '', enemyGuild: '' });
    const v = {
      id: newId(), owner, postedBy: user.key, postedAt: now(), url: String(body.url).trim(), videoId,
      type, recordedDate, enemyGuild, title: vodTitle(type, recordedDate, enemyGuild), note: clean(body.note, 500),
      visibility: 'private', visibleClass: '',
    };
    D.vods.push(v);
    save();
    audit(user, 'vod.create', { type: 'vod', id: v.id, name: v.title }, `${user.name} posted a VOD ("${v.title}") for ${m.name}.`);
    return v;
  });

  route('PUT', '/api/vods/:id', ({ body, user, params }) => {
    const D = db(), v = D.vods.find((x) => x.id === Number(params.id));
    need(v, 404, 'VOD not found.');
    need(canManageVod(user, v), 403, 'You can only edit your own VODs, or VODs of a player you coach.');
    if (body.type !== undefined || body.recordedDate !== undefined || body.enemyGuild !== undefined) {
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
  });

  route('DELETE', '/api/vods/:id', ({ user, params }) => {
    const D = db(), i = D.vods.findIndex((x) => x.id === Number(params.id));
    need(i >= 0, 404, 'VOD not found.');
    need(canManageVod(user, D.vods[i]), 403, 'You can only delete your own VODs, or VODs of a player you coach.');
    const [gone] = D.vods.splice(i, 1);
    save();
    audit(user, 'vod.delete', { type: 'vod', id: gone.id, name: gone.title }, `${user.name} deleted the VOD "${gone.title}".`);
    return { ok: true };
  });

  return { coachingState, studentsOf };
};
