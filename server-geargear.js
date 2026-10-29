// Personal Gear Threads: one page per character, replacing the guild's old Discord-based gear-tracking
// workflow. Five pieces live here, each its own small collection rather than nested inside the member record,
// same reasoning as VODs living separately from the member they're about (a thread can grow a lot of content
// over a character's lifetime, and nothing else ever needs to load it along with the plain roster list):
//   - gearChat: a shared running conversation on the thread (member + their coach + officers)
//   - gearScreens: one ordered screenshot gallery+note per admin-defined topic (db.gearSectionTypes, officer-managed in
//     Admin - see the routes near the bottom of this file) - a screen row is keyed by the topic's stable id,
//     not its label, so renaming a topic in Admin never orphans the screenshot already sitting under it
//   - gearSkills: active cores per build; gearSkillOwnership: shared ownership per player.
//     A source-attributed bundled English catalog is installed locally; officers may import updates.
//   - questlogs: NOT owned here - it's the same field a character's own edit form already has
//     (server-features.js's pickMember/cleanLinks); this module only adds a second, coach-reachable door to it
//   - gearFolder: one-directional postings from admins/coaches that the player can see but not add to
//
// Permission model (the user's own words): "Member edit their page on their own, coaches can see and write
// into the players, their class is coached by them. Officers can do all of it." canAccessThread() below is
// that sentence as code - everything else in this file (and the "Gear Threads" nav entry's own canSee() on
// the client) is built on exactly that one check, plus a narrower one for the folder (coach/officer only).
module.exports = function install(ctx) {
  const { route, need, clean, num, newId, save, config, isOfficer, isCoach, findMember, cleanLinks, audit, hooks } = ctx;
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const db = () => ctx.db;
  const now = () => new Date().toISOString();

  // Same weapon-pair-to-class lookup server-coaching.js already has - duplicated locally rather than
  // imported, same call server-coaching.js itself makes about classOf (see its own comment): this module
  // should keep working even if coaching's internals ever change shape.
  function classOf(m) {
    if (!m || !m.primaryWeapon || !m.secondaryWeapon || m.primaryWeapon === m.secondaryWeapon) return null;
    const pair = [m.primaryWeapon, m.secondaryWeapon].sort().join('|');
    const hit = (config.classes || []).find((c) => [...c.weapons].sort().join('|') === pair);
    return hit ? hit.name : null;
  }
  // ctx.coaching is attached by server-features.js right after server-coaching.js installs (the same
  // late-binding trick used for ctx.reevaluateWarnings) - by the time any request actually reaches a route
  // below, it is always there, even though this module is required a few lines after that assignment.
  //
  // PER BUILD: a character can have a main build plus up to six extra ones (m.builds), and each build has its
  // own class (a Warden build and a Predator build on one character are two different classes). A thread is
  // therefore not one thing per character but one per build - key 'main' is the character's own main build,
  // any other key is that build's id. Everything stored below carries a buildKey, and a row without one is
  // 'main', so threads that existed before builds were split need no migration at all.
  // Who may open a build's thread: the owner and officers see every build; a coach only sees builds whose
  // CLASS they coach (so the Warden coach never sees the Predator build, the Predator coach never the Warden).
  function buildsOf(m) {
    return [{ key: 'main', name: 'Main build', class: classOf(m), mode: m.mode || '', role: m.role || '' }]
      .concat((m.builds || []).map((b) => ({ key: String(b.id), name: b.name || 'Build', class: classOf(b), mode: b.mode || '', role: b.role || '' })));
  }
  const rowKey = (r) => r.buildKey || 'main';
  const coachedClasses = (user) => (isCoach(user) && ctx.coaching ? ctx.coaching.classesCoachedBy(user.key) : []);
  function canAccessBuild(user, m, b) {
    return isOfficer(user) || m.owner === user.key || (!!b.class && coachedClasses(user).includes(b.class));
  }
  const visibleBuilds = (user, m) => buildsOf(m).filter((b) => canAccessBuild(user, m, b));
  // The whole-page check: can this person open this character's thread at all (= at least one build of it).
  function canAccessThread(user, m) { return visibleBuilds(user, m).length > 0; }
  // Which build a request is about: the one named in body/query, else the first one this person may see.
  function buildFor(user, m, raw) {
    const vis = visibleBuilds(user, m);
    need(vis.length, 403, 'You cannot open this gear thread.');
    if (raw === undefined || raw === null || raw === '') return vis[0];
    const key = String(raw), hit = buildsOf(m).find((b) => b.key === key);
    need(hit, 404, 'That build does not exist.');
    need(canAccessBuild(user, m, hit), 403, 'You cannot open this build\'s gear thread.');
    return hit;
  }
  // The folder is one-directional - the player it's about can read it, same as everything else on their own
  // thread, but never posts into it themselves (that's what the chatbox is for).
  function canPostFolder(user, m, b) { return isOfficer(user) || (isCoach(user) && !!b.class && coachedClasses(user).includes(b.class)); }

  function member(id) {
    const m = findMember(id);
    need(m, 404, 'Character not found.');
    return m;
  }

  // Screenshot topics: officer-managed, db().gearSectionTypes = [{ id, label }], seeded with four defaults in
  // server.js's migrate() and editable from here on in Admin (add / rename / reorder / remove - see the
  // routes near the bottom of this file). A gearScreens row is keyed by id, never by label, specifically so
  // renaming a topic carries its screenshot and note forward instead of orphaning them under the old name.
  const sectionTypes = () => db().gearSectionTypes;

  // Source snapshot is bundled; no dependency on Questlog availability during normal use.
  const {validateCatalog,validateActive} = require('./skillcore-catalog');
  const bundledCatalog=validateCatalog(require('./catalog/skillcores.en.json'));
  const catalog = () => db().skillCoreCatalog || bundledCatalog;
  const catalogEntries = () => catalog().entries;
  const potentials = require('./potential-catalog');
  const potentialKey = (memberId,key) => `${memberId}:${key}`;
  function potentialsFor(m,b) {
    const build=b.key==='main'?m:(m.builds || []).find(x=>String(x.id)===b.key);
    const row=(db().gearPotentials || {})[potentialKey(m.id,b.key)] || {assignments:{},revision:0};
    const weapons=[build?.primaryWeapon || '',build?.secondaryWeapon || ''];
    // Preserve earlier multi-selection records for review, without treating them as equipped.
    const assignments={},legacyAssignments={};
    for(const [slot,ids] of Object.entries(row.assignments || {})) {
      if(Array.isArray(ids) && ids.length>1)legacyAssignments[slot]=ids;
      else if(Array.isArray(ids) && ids.length===1)assignments[slot]=ids;
    }
    return {catalog:potentials.entries,slots:potentials.slots,weapons,assignments,legacyAssignments,revision:row.revision,updatedAt:row.updatedAt || null};
  }

  // ---------------------------------------------------------------- images (screenshots, folder attachments)
  // Same sniff-by-magic-bytes + content-hash-filename approach as the branding upload in server-features.js,
  // just under its own file-name prefix so the two can never collide in /uploads.
  const sniff = (buf) => {
    if (buf.length > 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 6 && buf.subarray(0, 6).toString('latin1') === 'GIF87a') return 'gif';
    if (buf.length > 6 && buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
    if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    return null;
  };
  function saveImage(prefix, dataUrl, maxBytes) {
    const buf = Buffer.from(String(dataUrl || '').replace(/^data:[^,]*,/, ''), 'base64');
    need(buf.length > 100, 400, 'That does not look like an image.');
    need(buf.length <= maxBytes, 413, `Images can be up to ${Math.round(maxBytes / 1e6)} MB.`);
    const ext = sniff(buf);
    need(ext, 400, 'Only PNG, JPEG, GIF or WebP pictures are allowed.');
    const name = `${prefix}-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)}.${ext}`;
    fs.writeFileSync(path.join(ctx.UPLOAD_DIR, name), buf);
    return name;
  }
  const screenImages = row => Array.isArray(row?.images) ? row.images : (row?.image ? [row.image] : []);
  function dropImage(name) {
    if (!name || db().gearScreens.some(r => screenImages(r).includes(name)) || db().gearFolder.some(r => r.image === name)) return;
    fs.rmSync(path.join(ctx.UPLOAD_DIR, name), { force: true });
  }

  // ---------------------------------------------------------------- reading a whole thread
  function screensFor(memberId, key) {
    const D = db();
    return sectionTypes().map((t) => {
      const row = D.gearScreens.find((s) => s.memberId === memberId && rowKey(s) === key && s.sectionId === t.id);
      return row
        ? { sectionId: t.id, label: t.label, image: screenImages(row)[0] ? '/uploads/' + screenImages(row)[0] : '', images: screenImages(row).map(name => ({id:name,image:'/uploads/'+name})), note: row.note, updatedAt: row.updatedAt, updatedByName: row.updatedByName }
        : { sectionId: t.id, label: t.label, image: '', images: [], note: '', updatedAt: null, updatedByName: '' };
    });
  }
  // Active cores and build links are per build: main keeps the original keys (member id; m.questlogs),
  // every other build gets "<memberId>:<buildId>" and its own entry in db.gearLinks.
  const skillKey = (memberId, key) => (key === 'main' ? memberId : `${memberId}:${key}`);
  const linksKey = (memberId, key) => `${memberId}:${key}`;
  const linksFor = (m, key) => (key === 'main' ? m.questlogs || [] : db().gearLinks[linksKey(m.id, key)] || []);
  function ownedFor(m) {
    const shared = (db().gearSkillOwnership || {})[m.owner];
    if (Array.isArray(shared)) return shared;
    // Migrate legacy per-build ownership by union, including every class on this player's character.
    return [...new Set(Object.entries(db().gearSkills).filter(([k])=>k===String(m.id) || k.startsWith(m.id+':')).flatMap(([,row])=>row.owned || []))];
  }
  function skillsFor(m, b) {
    const row = db().gearSkills[skillKey(m.id,b.key)] || {active:[]};
    const build = b.key==='main'?m:(m.builds || []).find(x=>String(x.id)===b.key);
    const owned=ownedFor(m), active=(row.active || []).filter(id=>owned.includes(id));
    return {catalog:catalogEntries(),metadata:{source:catalog().source,gameVersion:catalog().gameVersion,verifiedAt:catalog().verifiedAt,count:catalogEntries().length},owned,active,weapons:[build?.primaryWeapon,build?.secondaryWeapon].filter(Boolean)};
  }

  // threadFor() deliberately does NOT include chat any more - a coach's VOD review can run to several
  // thousand characters repeated many times over a long thread (real example: a single timestamped breakdown
  // of one VOD ran ~3000 characters on its own), so a thread's chat history needs to be paged, not shipped
  // whole on every single screenshot/questlog/folder write this file returns. Chat has its own routes and its
  // own paging below; every OTHER route here returns threadFor() as before, and the client leaves whatever
  // chat it already has loaded untouched when it gets a response with no chat field in it.
  function threadFor(user, m, b) {
    const D = db(), key = b.key;
    return {
      memberId: m.id, name: m.name, owner: m.owner,
      builds: visibleBuilds(user, m), buildKey: key, buildClass: b.class,
      canPostFolder: canPostFolder(user, m, b),
      isOwner: m.owner === user.key,
      screens: screensFor(m.id, key),
      skillcores: skillsFor(m, b),
      potentials: potentialsFor(m, b),
      questlogs: linksFor(m, key),
      folder: D.gearFolder.filter((f) => f.memberId === m.id && rowKey(f) === key).map((f) => (f.image ? { ...f, image: '/uploads/' + f.image } : f))
        .sort((a, b) => b.at.localeCompare(a.at)),
    };
  }

  // ---------------------------------------------------------------- chat (paged - oldest-first within a page, newest page by default)
  const CHAT_PAGE = 50;
  // ids come from the same shared newId() counter every other collection in the app uses, so they are not
  // sequential WITHIN gearChat alone - but they are still strictly increasing in the order messages were
  // actually created, which is all a stable "insertion order" sort needs.
  function chatForMember(memberId, key) { return db().gearChat.filter((c) => c.memberId === memberId && rowKey(c) === key).sort((a, b) => a.id - b.id); }
  // beforeId: paging backwards in time for "load older messages" (infinite-scroll-up) - omit it for the
  // newest page, which is what both the initial thread load and the live-update poll ask for.
  function chatPage(memberId, key, beforeId) {
    let all = chatForMember(memberId, key);
    if (beforeId != null) {
      const i = all.findIndex((c) => c.id === beforeId);
      all = i >= 0 ? all.slice(0, i) : all;
    }
    const hasMore = all.length > CHAT_PAGE;
    return { messages: all.slice(Math.max(0, all.length - CHAT_PAGE)), hasMore };
  }

  route('GET', '/api/gearthreads/:id', ({ user, params, query }) => {
    const m = member(params.id), b = buildFor(user, m, query.build);
    const { messages, hasMore } = chatPage(m.id, b.key, null);
    return { ...threadFor(user, m, b), chat: messages, chatHasMore: hasMore };
  });

  route('GET', '/api/gearthreads/:id/chat', ({ user, params, query }) => {
    const m = member(params.id), b = buildFor(user, m, query.build);
    const before = query.before !== undefined ? Number(query.before) : null;
    const { messages, hasMore } = chatPage(m.id, b.key, Number.isFinite(before) ? before : null);
    return { messages, hasMore };
  });

  // A real VOD-review message can run to several thousand characters (see the module comment above) - this
  // cap exists to stop genuine abuse, not to limit a normal long coaching write-up.
  const CHAT_MSG_MAX = 20000;
  // A generous hard ceiling per thread, purely a storage safety net - a guild running this for years before
  // anyone ever hits it would be a lot of chatting. Drops the oldest in one batch past that point, same shape
  // as the audit log's own cap, rather than ever silently truncating what "load older" can still reach.
  const CHAT_HARD_CAP = 20000;
  route('POST', '/api/gearthreads/:id/chat', ({ body, user, params }) => {
    const m = member(params.id), b = buildFor(user, m, body.build);
    const text = clean(body.text, CHAT_MSG_MAX);
    need(text, 400, 'Write a message first.');
    const D = db();
    const msg = { id: newId(), memberId: m.id, buildKey: b.key, by: user.key, byName: user.name, at: now(), text };
    D.gearChat.push(msg);
    const mine = chatForMember(m.id, b.key);
    if (mine.length > CHAT_HARD_CAP) {
      const dropIds = new Set(mine.slice(0, mine.length - CHAT_HARD_CAP).map((c) => c.id));
      D.gearChat = D.gearChat.filter((c) => !dropIds.has(c.id));
    }
    save();
    return msg;
  });

  // ---------------------------------------------------------------- screenshots
  route('PUT', '/api/gearthreads/:id/screens/:section', ({ body, user, params }) => {
    const m = member(params.id), b = buildFor(user, m, body.build);
    const sectionId = Number(params.section);
    const type = sectionTypes().find((t) => t.id === sectionId);
    need(type, 404, 'Not a real screenshot section.');
    const D = db();
    let row = D.gearScreens.find((s) => s.memberId === m.id && rowKey(s) === b.key && s.sectionId === sectionId);
    if (body.remove) {
      const old = screenImages(row);
      if (row) D.gearScreens = D.gearScreens.filter(s => s !== row);
      old.forEach(dropImage);
      audit(user, 'geargear.screen.remove', { type: 'member', id: m.id, name: m.name }, `${user.name} removed the "${type.label}" gallery from ${m.name}'s gear thread.`);
      save(); return threadFor(user, m, b);
    }
    const old = screenImages(row), note = body.note !== undefined ? clean(body.note, 1000) : (row ? row.note : '');
    let images = [...old];
    if (body.removeId !== undefined) {
      need(images.includes(body.removeId), 404, 'Screenshot not found.');
      images = images.filter(id => id !== body.removeId);
    }
    if (body.order !== undefined) {
      need(Array.isArray(body.order) && body.order.length === images.length && new Set(body.order).size === images.length && body.order.every(id => images.includes(id)), 409, 'The gallery changed. Refresh it before reordering.');
      images = [...body.order];
    }
    if (body.image) {
      const image = saveImage('gearshot', body.image, 6e6);
      // Legacy clients may replace the cover; the gallery UI always appends.
      if (body.append === true) { if (!images.includes(image)) images.push(image); }
      else images = [image, ...images.slice(1).filter(id => id !== image)];
    }
    if (!row) { row = { id: newId(), memberId: m.id, buildKey: b.key, sectionId, note: '' }; D.gearScreens.push(row); }
    row.images = images; row.image = images[0] || '';
    old.filter(id => !images.includes(id)).forEach(dropImage);
    row.note = note;
    row.updatedAt = now();
    row.updatedByName = user.name;
    audit(user, 'geargear.screen.update', { type: 'member', id: m.id, name: m.name }, `${user.name} updated the "${type.label}" screenshot on ${m.name}'s gear thread.`);
    save();
    return threadFor(user, m, b);
  });

  // ---------------------------------------------------------------- Admin: the screenshot topic list itself
  // Add / rename / reorder / remove - kept by stable id (see the module comment up top) so a rename never
  // loses what was already uploaded under that topic. Removing a topic is the one destructive case: every
  // player's screenshot+note under it is gone for good, so its image file is cleaned up too rather than left
  // behind as an orphaned upload nothing ever links to again.
  route('GET', '/api/admin/gear-sections', () => sectionTypes(), { officer: true });
  route('POST', '/api/admin/gear-sections', ({ body, user }) => {
    const label = clean(body.label, 40);
    need(label, 400, 'Give the topic a name.');
    const D = db();
    need(D.gearSectionTypes.length < 20, 400, 'That is a lot of screenshot topics - 20 is the most you can have at once.');
    need(!D.gearSectionTypes.some((t) => t.label.toLowerCase() === label.toLowerCase()), 409, 'There is already a topic with that name.');
    const type = { id: newId(), label };
    D.gearSectionTypes.push(type);
    save();
    audit(user, 'geargear.section.add', { type: 'guild' }, `${user.name} added a "${label}" screenshot topic to Gear Threads.`);
    return sectionTypes();
  }, { officer: true });
  route('PUT', '/api/admin/gear-sections/:id', ({ body, user, params }) => {
    const D = db(), type = D.gearSectionTypes.find((t) => t.id === Number(params.id));
    need(type, 404, 'Topic not found.');
    const label = clean(body.label, 40);
    need(label, 400, 'Give the topic a name.');
    need(!D.gearSectionTypes.some((t) => t.id !== type.id && t.label.toLowerCase() === label.toLowerCase()), 409, 'There is already a topic with that name.');
    const old = type.label;
    type.label = label;
    save();
    if (old !== label) audit(user, 'geargear.section.rename', { type: 'guild' }, `${user.name} renamed the "${old}" screenshot topic to "${label}".`);
    return sectionTypes();
  }, { officer: true });
  route('POST', '/api/admin/gear-sections/:id/move', ({ body, params }) => {
    const D = db(), list = D.gearSectionTypes, i = list.findIndex((t) => t.id === Number(params.id));
    need(i >= 0, 404, 'Topic not found.');
    const j = body.dir === 'up' ? i - 1 : i + 1;
    need(j >= 0 && j < list.length, 400, "Can't move it further.");
    [list[i], list[j]] = [list[j], list[i]];
    save();
    return sectionTypes();
  }, { officer: true });
  route('DELETE', '/api/admin/gear-sections/:id', ({ user, params }) => {
    const D = db(), id = Number(params.id), i = D.gearSectionTypes.findIndex((t) => t.id === id);
    need(i >= 0, 404, 'Topic not found.');
    const [gone] = D.gearSectionTypes.splice(i, 1);
    const orphaned = D.gearScreens.filter((s) => s.sectionId === id);
    D.gearScreens = D.gearScreens.filter((s) => s.sectionId !== id);
    for (const row of orphaned) screenImages(row).forEach(dropImage);
    save();
    audit(user, 'geargear.section.remove', { type: 'guild' }, `${user.name} removed the "${gone.label}" screenshot topic from Gear Threads${orphaned.length ? ` (along with ${orphaned.length} existing screenshot${orphaned.length === 1 ? '' : 's'} under it)` : ''}.`);
    return sectionTypes();
  }, { officer: true });

  // ---------------------------------------------------------------- skill cores
  route('GET','/api/admin/skillcores/catalog',()=>catalog(),{officer:true});
  route('PUT','/api/gearthreads/:id/potentials',({body,user,params})=>{
    const m=member(params.id),b=buildFor(user,m,body.build),current=potentialsFor(m,b);
    need(Number.isSafeInteger(body.revision) && body.revision===current.revision,409,'Potentials changed. Refresh this thread before saving.');
    let selection;
    try {selection=potentials.validateSelection(body.slot,body.ids,current.weapons);}catch(e){need(false,400,e.message);}
    const assignments={...((db().gearPotentials || {})[potentialKey(m.id,b.key)]?.assignments || {})};
    if(selection.length)assignments[body.slot]=selection;else delete assignments[body.slot];
    db().gearPotentials ||= {};
    db().gearPotentials[potentialKey(m.id,b.key)]={assignments,revision:current.revision+1,updatedAt:now()};
    audit(user,'geargear.potentials.update',{type:'member',id:m.id,name:m.name},`${user.name} updated ${body.slot} potentials for ${m.name} (${b.name}).`);
    save();return threadFor(user,m,b);
  });
  route('PUT','/api/admin/skillcores/catalog',({body,user})=>{
    let next;try{next=validateCatalog(body);}catch(e){need(false,400,e.message);}
    const lookup=new Map(next.entries.map(e=>[e.id,e]));
    const referenced=new Set([...Object.values(db().gearSkillOwnership || {}).flat(),...Object.values(db().gearSkills).flatMap(row=>[...(row.owned || []),...(row.active || [])])]);
    need([...referenced].every(id=>lookup.has(id)),409,'The new catalog would remove skill cores still referenced by players. Keep their stable IDs in the catalog.');
    const previous=new Map(catalogEntries().map(e=>[e.id,e]));
    need([...referenced].every(id=>!previous.has(id) || (lookup.get(id).slot===previous.get(id).slot && JSON.stringify(lookup.get(id).weapons)===JSON.stringify(previous.get(id).weapons))),409,'Referenced skill-core slot and weapon compatibility cannot be changed by an import.');
    db().skillCoreCatalog=next;save();audit(user,'skillcores.catalog.import',{type:'guild'},`${user.name} imported ${next.entries.length} skill cores (${next.gameVersion}).`);
    return {count:next.entries.length,source:next.source,gameVersion:next.gameVersion,verifiedAt:next.verifiedAt};
  },{officer:true});
  route('PUT', '/api/gearthreads/:id/skillcores', ({ body, user, params }) => {
    const m=member(params.id), b=buildFor(user,m,body.build), entries=catalogEntries(), ids=new Set(entries.map(e=>e.id));
    const list=value=>{need(Array.isArray(value) && value.every(id=>typeof id==='string'),400,'Skill cores must be an array of IDs.');return [...new Set(value)];};
    const oldOwned=ownedFor(m), current=db().gearSkills[skillKey(m.id,b.key)] || {active:[]};
    // Delta updates prevent a coach editing one build from overwriting ownership added on another.
    let owned=oldOwned.slice();
    if(body.addOwned!==undefined){const add=list(body.addOwned);need(add.every(id=>ids.has(id)),400,'Unknown skill core.');owned=[...new Set([...owned,...add])];}
    if(body.removeOwned!==undefined){const remove=list(body.removeOwned);owned=owned.filter(id=>!remove.includes(id));}
    if(body.owned!==undefined){owned=list(body.owned);need(owned.every(id=>ids.has(id)),400,'Unknown skill core.');}
    const removed=oldOwned.filter(id=>!owned.includes(id));
    // Coaches may not remove ownership that affects an inaccessible build. Owners/officers can remove
    // only after deactivating that core everywhere; no silent cross-build changes.
    const affected=Object.entries(db().gearSkills).filter(([k])=>k===String(m.id) || k.startsWith(m.id+':')).some(([,row])=>(row.active || []).some(id=>removed.includes(id)));
    need(!affected,409,'Deactivate this skill core in every build before removing it from Owned.');
    const active=body.active===undefined?(current.active || []):list(body.active);
    need(active.every(id=>owned.includes(id)),400,'Active skill cores must be owned.');
    const build=b.key==='main'?m:(m.builds || []).find(x=>String(x.id)===b.key);
    try{validateActive(active,entries,[build?.primaryWeapon,build?.secondaryWeapon].filter(Boolean));}catch(e){need(false,400,e.message);}
    db().gearSkillOwnership ||= {};Object.defineProperty(db().gearSkillOwnership,m.owner,{value:owned,writable:true,enumerable:true,configurable:true});
    for(const [k,row] of Object.entries(db().gearSkills))if(k===String(m.id)||k.startsWith(m.id+':'))delete row.owned;
    db().gearSkills[skillKey(m.id,b.key)]={active};save();
    return threadFor(user,m,b);
  });

  // ---------------------------------------------------------------- questlog (same field as the character's own edit form - see pickMember/cleanLinks - just reachable from a coach here too)
  route('PUT', '/api/gearthreads/:id/questlogs', ({ body, user, params }) => {
    const m = member(params.id), b = buildFor(user, m, body.build);
    if (b.key === 'main') m.questlogs = cleanLinks(body.links);
    else db().gearLinks[linksKey(m.id, b.key)] = cleanLinks(body.links);
    audit(user, 'geargear.questlogs', { type: 'member', id: m.id, name: m.name }, `${user.name} updated the Questlog links on ${m.name}'s gear thread.`);
    save();
    return threadFor(user, m, b);
  });

  // ---------------------------------------------------------------- folder (admins/coaches post, player views only)
  route('POST', '/api/gearthreads/:id/folder', ({ body, user, params }) => {
    const m = member(params.id), b = buildFor(user, m, body.build);
    need(canPostFolder(user, m, b), 403, 'Only a coach or officer can post into this folder.');
    const kind = ['text', 'link', 'image'].includes(body.kind) ? body.kind : 'text';
    const text = clean(body.text, 1000);
    const item = { id: newId(), memberId: m.id, buildKey: b.key, postedBy: user.key, postedByName: user.name, at: now(), kind, text, url: '', image: '' };
    if (kind === 'link') {
      item.url = clean(body.url, 300);
      need(/^https?:\/\/[^\s<>"']+$/i.test(item.url), 400, 'Links must start with http:// or https://');
    } else if (kind === 'image') {
      item.image = saveImage('gearfolder', body.image, 6e6);
    } else {
      need(text, 400, 'Write something before posting.');
    }
    db().gearFolder.push(item);
    audit(user, 'geargear.folder.post', { type: 'member', id: m.id, name: m.name }, `${user.name} posted to ${m.name}'s gear-thread folder.`);
    save();
    return threadFor(user, m, b);
  });

  route('DELETE', '/api/gearthreads/:id/folder/:itemId', ({ user, params, query }) => {
    const m = member(params.id), b = buildFor(user, m, query.build);
    const D = db();
    const item = D.gearFolder.find((f) => f.id === Number(params.itemId) && f.memberId === m.id && rowKey(f) === b.key);
    need(item, 404, 'Folder item not found.');
    need(isOfficer(user) || item.postedBy === user.key, 403, 'You can only remove your own folder posts.');
    D.gearFolder = D.gearFolder.filter((f) => f !== item);
    dropImage(item.image);
    audit(user, 'geargear.folder.remove', { type: 'member', id: m.id, name: m.name }, `${user.name} removed a post from ${m.name}'s gear-thread folder.`);
    save();
    return threadFor(user, m, b);
  });

  // ---------------------------------------------------------------- clean-up
  // Deleting a build (or a whole character) takes its thread with it, including the uploaded image files.
  function dropBuildData(memberId, key) {
    const D = db();
    const mine = (r) => r.memberId === memberId && rowKey(r) === key;
    const removedImages = [...D.gearScreens.filter(mine).flatMap(screenImages), ...D.gearFolder.filter(mine).map(r => r.image)];
    D.gearScreens = D.gearScreens.filter((r) => !mine(r));
    D.gearFolder = D.gearFolder.filter((r) => !mine(r));
    removedImages.forEach(dropImage);
    D.gearChat = D.gearChat.filter((r) => !mine(r));
    delete D.gearSkills[skillKey(memberId, key)];
    delete D.gearLinks[linksKey(memberId, key)];
    if(D.gearPotentials)delete D.gearPotentials[potentialKey(memberId,key)];
  }
  ctx.gearDropBuild = (memberId, buildId) => dropBuildData(memberId, String(buildId));
  hooks.memberDeleted.push((m) => {
    for (const b of buildsOf(m)) dropBuildData(m.id, b.key);
    const D = db();
    for (const k of Object.keys(D.gearSkills)) if (k.startsWith(m.id + ':')) delete D.gearSkills[k];
    for (const k of Object.keys(D.gearPotentials || {})) if (k.startsWith(m.id + ':')) delete D.gearPotentials[k];
  });

  return { canAccessThread };
};
