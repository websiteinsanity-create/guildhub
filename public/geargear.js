'use strict';
/* ================= Personal Gear Threads: the content page ================= */
// One per-thread fetch (not bundled into /api/state - a single thread's chat/screenshots have no reason to
// ride along on every 30s poll for every other page). Mirrors the "fetched here, can't be awaited at render
// time" shape refresh() already uses for the loot/compliance stats: load in the background, re-render once
// it lands, and meanwhile show a plain loading state.
//
// Chat lives OUTSIDE GEARTHREAD.data on purpose (data = everything else: screens/skillcores/questlogs/
// folder). A real coaching write-up can run several thousand characters and a thread can run to thousands of
// messages over a character's life, so chat is paged (newest CHAT page loaded first, older pages fetched as
// the viewer scrolls up - see loadOlderGearChat) and polled for live updates independently of everything
// else on the page, which only ever needs a full reload.
let GEARTHREAD = { id: null, data: null };
let gearFolderImage = null;   // pending base64 image for the folder composer, attached separately from the text form (see CHANGES['gear-folder-image'] below)

// Chat scroll bookkeeping. gearChatLastScroll is kept up to date purely by the delegated scroll listener
// below (fires on every user scroll of .gear-chat-list), and gearChatStickBottom tracks whether that position
// was "close enough to the bottom" to count as following the conversation live. AFTER_RENDER then restores
// position after EVERY render of this page - whatever triggered it (a new message, an older page loading in,
// or something unrelated like saving a screenshot note) - rather than each caller having to know how to
// preserve scroll itself. See the AFTER_RENDER hook near the bottom of the chat section below.
let gearChatLastScroll = null;   // { top, height } of .gear-chat-list, last time the viewer (or a render) touched it
let gearChatStickBottom = true;
let gearChatPollTimer = null;
const gearBuildQ = () => (GEARTHREAD.data && GEARTHREAD.data.buildKey ? 'build=' + encodeURIComponent(GEARTHREAD.data.buildKey) : '');
const gearBuildKey = () => (GEARTHREAD.data && GEARTHREAD.data.buildKey) || 'main';
const onGearThreadPage = (id) => route().page === 'gearthreads' && String(route().id) === String(id);

function loadGearThread(id, build) {
  gearChatLastScroll = null; gearChatStickBottom = true;   // fresh thread: no scroll history to carry over
  api('/api/gearthreads/' + id + (build ? '?build=' + encodeURIComponent(build) : '')).then((full) => {
    const { chat, chatHasMore, ...data } = full;
    GEARTHREAD = { id: String(id), data, chat, chatHasMore, chatLoadingOlder: false };
    if (onGearThreadPage(id)) render();
    if (data.buildKey && UI.gearBuildPref) UI.gearBuildPref[String(id)] = data.buildKey;
    startGearChatPoll(id);
  }).catch((e) => {
    GEARTHREAD = { id: String(id), data: null, error: e.message || 'Could not load this gear thread.', chat: [], chatHasMore: false };
    if (onGearThreadPage(id)) render();
  });
}
// Runs a gear-thread write OTHER than chat, merges in whatever fields the server sent back (never chat - see
// threadFor()'s own comment server-side), and re-renders. Same shape as act() elsewhere, just without act()'s
// full /api/state refresh, which this page has no use for.
async function gearAct(fn) {
  try { Object.assign(GEARTHREAD.data, await fn()); render(); return true; }
  catch (e) { toast(e.message, true); return false; }
}

// Infinite-scroll-up: fetch the next older page once the viewer scrolls near the top of the chat list.
async function loadOlderGearChat() {
  const t = GEARTHREAD;
  if (t.chatLoadingOlder || !t.chatHasMore || !t.chat.length) return;
  t.chatLoadingOlder = true;
  try {
    const { messages, hasMore } = await api(`/api/gearthreads/${t.id}/chat?before=${t.chat[0].id}&${gearBuildQ()}`);
    t.chat = [...messages, ...t.chat];
    t.chatHasMore = hasMore;
  } catch (e) { toast(e.message, true); }
  t.chatLoadingOlder = false;
  if (onGearThreadPage(t.id)) render();
}
// Live updates: poll for anything newer than what's already loaded, every few seconds, only while this exact
// thread is actually open and the tab is visible. Merges in new messages without touching older pages the
// viewer may have already scrolled back into.
function startGearChatPoll(id) {
  stopGearChatPoll();
  gearChatPollTimer = setInterval(async () => {
    if (!onGearThreadPage(id)) { stopGearChatPoll(); return; }
    if (document.hidden) return;
    try {
      const { messages } = await api(`/api/gearthreads/${id}/chat?${gearBuildQ()}`);
      const t = GEARTHREAD;
      const newestId = t.chat.length ? t.chat[t.chat.length - 1].id : 0;
      const fresh = messages.filter((m) => m.id > newestId);
      if (fresh.length) { t.chat.push(...fresh); gearChatStickBottom = true; render(); }
    } catch { /* quiet - the next tick just tries again */ }
  }, 8000);
}
function stopGearChatPoll() { if (gearChatPollTimer) { clearInterval(gearChatPollTimer); gearChatPollTimer = null; } }
// Scroll is delegated (capture phase, since 'scroll' does not bubble) so it keeps working across every
// re-render, even though .gear-chat-list is a brand new element each time render() rebuilds the page.
document.addEventListener('scroll', (e) => {
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains('gear-chat-list')) return;
  gearChatLastScroll = { top: el.scrollTop, height: el.scrollHeight };
  gearChatStickBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
  if (el.scrollTop < 60) loadOlderGearChat();
}, true);
AFTER_RENDER.push((page) => {
  if (page !== 'gearthreads') return;
  const list = $('.gear-chat-list');
  if (!list) return;
  if (gearChatStickBottom) list.scrollTop = list.scrollHeight;
  else if (gearChatLastScroll) list.scrollTop = Math.max(0, gearChatLastScroll.top + (list.scrollHeight - gearChatLastScroll.height));
});

function viewGearThread(id) {
  const m = S.members.find((x) => String(x.id) === String(id));
  const canSeeIndex = isOfficer() || S.isCoach;
  UI.gearBuildPref = UI.gearBuildPref || {};
  if (GEARTHREAD.id !== String(id)) { GEARTHREAD = { id: String(id), data: null, chat: [], chatHasMore: false }; loadGearThread(id, UI.gearBuildPref[String(id)]); }
  const sel = m && GEARTHREAD.data && GEARTHREAD.data.buildKey !== 'main' ? (m.builds || []).find((x) => String(x.id) === GEARTHREAD.data.buildKey) : null;   // the header follows the build being viewed
  const head = `<div class="page-head"><div><h1>${esc(m ? m.name : 'Gear thread')}</h1><div class="muted">${m ? `${esc(ownerName(m.owner))} · ${weaponLine(sel || m)}` : ''}</div></div>
    ${canSeeIndex ? `<a class="btn" href="#/gearthreads">&larr; Back to Gear Threads</a>` : ''}</div>`;
  if (GEARTHREAD.error) return `${head}<div class="empty">${esc(GEARTHREAD.error)}</div>`;
  if (!GEARTHREAD.data) return `${head}<div class="empty">Loading…</div>`;
  return head + renderGearThread(GEARTHREAD.data, GEARTHREAD.chat, GEARTHREAD.chatHasMore, GEARTHREAD.chatLoadingOlder);
}

/* ---- screenshots (section 2: a swipeable strip, one slide per topic) ----
   Topics themselves (add/rename/reorder/remove) are an Admin > Gear Threads screen - see gearSectionsAdmin()
   in features.js. Each slide here is keyed by the topic's stable sectionId, not its label, so a rename there
   never loses what's already uploaded under it. */
function gearScreensHtml(t) {
  if (!t.screens.length) return '<div class="muted small">No screenshot topics have been set up yet - an officer can add some in Admin &gt; Gear Threads.</div>';
  const tabs = t.screens.map((s) => `<button type="button" class="gear-tab" data-act="gear-slide" data-section="${s.sectionId}">${esc(s.label)}</button>`).join('');
  const slides = t.screens.map((s) => `
    <div class="gear-slide" id="gslide-${s.sectionId}">
      <div class="gear-slide-head"><b>${esc(s.label)}</b>
        <button type="button" class="btn sm" data-act="gear-screen-upload-open" data-section="${s.sectionId}" data-label="${esc(s.label)}">${s.image ? 'Replace' : 'Upload'}</button>
      </div>
      ${s.image ? `<img class="gear-shot" src="${esc(s.image)}" alt="${esc(s.label)}">` : `<div class="empty" style="padding:40px 16px">No screenshot yet</div>`}
      <form data-form="gear-note" data-id="${t.memberId}" data-section="${s.sectionId}">
        <textarea name="note" maxlength="1000" placeholder="Notes for ${esc(s.label)} - anything the screenshot doesn't already show" data-autogrow>${esc(s.note)}</textarea>
        <button class="btn sm primary">Save note</button>
      </form>
      ${s.updatedAt ? `<div class="muted small">Updated by ${esc(s.updatedByName)} · ${new Date(s.updatedAt).toLocaleString()}</div>` : ''}
    </div>`).join('');
  return `<div class="gear-tabs">${tabs}</div><div class="gear-slides">${slides}</div>`;
}
ACTIONS['gear-slide'] = (el, d) => { const s = document.getElementById('gslide-' + d.section); if (s) s.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }); };

// The upload/replace button opens a small popup with a drag-and-drop zone plus a "choose a file" button,
// rather than triggering the OS file picker directly - gearUploadDialog() below is shared with anywhere else
// a single-image upload needs the same popup (so far just this one, but the folder's "attach image" could
// grow into it later without duplicating the dropzone markup/handlers).
function gearUploadDialog({ title, section, onFile }) {
  gearDropHandler = onFile;
  openDialog(`<h2>${esc(title)}</h2>
    <div class="gear-dropzone" id="gear-dropzone" data-section="${section == null ? '' : section}">
      <div class="gear-dropzone-inner">
        <div>Drag and drop an image here</div>
        <div class="muted small" style="margin:8px 0">or</div>
        <button type="button" class="btn primary" data-act="gear-dropzone-pick">Choose a file</button>
        <input type="file" id="gear-dropzone-input" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden" data-act="gear-dropzone-file">
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-act="dlg-close">Cancel</button></div>`);
}
let gearDropHandler = null;
ACTIONS['gear-screen-upload-open'] = (el, d) => {
  const sectionId = d.section;
  gearUploadDialog({ title: `Upload ${d.label} screenshot`, section: sectionId, onFile: (file) => gearUploadScreenFile(sectionId, file) });
};
ACTIONS['gear-dropzone-pick'] = () => { const i = document.getElementById('gear-dropzone-input'); if (i) i.click(); };
CHANGES['gear-dropzone-file'] = (el) => { const file = el.files[0]; if (file && gearDropHandler) gearDropHandler(file); };
// Delegated so it survives every re-render of the dialog's contents, same reasoning as the chat list's
// scroll listener above - the actual .gear-dropzone element is destroyed and recreated each time openDialog runs.
document.addEventListener('dragover', (e) => { const z = e.target.closest && e.target.closest('.gear-dropzone'); if (z) { e.preventDefault(); z.classList.add('over'); } });
document.addEventListener('dragleave', (e) => { const z = e.target.closest && e.target.closest('.gear-dropzone'); if (z && (e.target === z || !z.contains(e.relatedTarget))) z.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  const z = e.target.closest && e.target.closest('.gear-dropzone'); if (!z) return;
  e.preventDefault(); z.classList.remove('over');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && gearDropHandler) gearDropHandler(file);
});
function gearUploadScreenFile(sectionId, file) {
  if (!/^image\//.test(file.type)) { toast('That is not an image file.', true); return; }
  if (file.size > 6e6) { toast('That picture is too large (limit 6 MB).', true); return; }
  const id = GEARTHREAD.id;
  const r = new FileReader();
  r.onload = () => { closeDialog(); gearAct(() => api(`/api/gearthreads/${id}/screens/${sectionId}`, 'PUT', { image: r.result, build: gearBuildKey() })).then((ok) => ok && toast('Screenshot uploaded')); };
  r.readAsDataURL(file);
}
FORMS['gear-note'] = (f, fd) => gearAct(() => api(`/api/gearthreads/${f.dataset.id}/screens/${f.dataset.section}`, 'PUT', { note: fd.note, build: gearBuildKey() })).then((ok) => ok && toast('Note saved'));

/* ---- chat (section 1) - paged (infinite-scroll-up) and live-polled; see the module comment up top ---- */
function gearChatHtml(t, chat, chatHasMore, chatLoadingOlder) {
  const top = chatLoadingOlder ? '<div class="muted small" style="text-align:center;padding:6px">Loading older messages…</div>'
    : (chatHasMore ? '<div class="muted small" style="text-align:center;padding:6px">Scroll up for older messages</div>' : (chat.length ? '<div class="muted small" style="text-align:center;padding:6px">Start of the conversation</div>' : ''));
  const list = chat.length ? chat.map((c) => `
    <div class="gear-chat-msg ${c.by === S.user.key ? 'me' : ''}">
      <div class="gear-chat-meta"><b>${esc(c.byName)}</b><span class="muted small">${new Date(c.at).toLocaleString()}</span></div>
      <div class="gear-chat-text">${esc(c.text)}</div>
    </div>`).join('') : '<div class="muted small">No messages yet - say hello.</div>';
  return `<div class="gear-chat-list">${top}${list}</div>
    <form data-form="gear-chat" data-id="${t.memberId}" class="gear-chat-form">
      <textarea name="text" maxlength="20000" placeholder="Message ${esc(t.name)}'s thread..." required data-autogrow></textarea>
      <button class="btn primary">Send</button>
    </form>`;
}
FORMS['gear-chat'] = (f, fd) => {
  if (!fd.text || !fd.text.trim()) return;
  api(`/api/gearthreads/${f.dataset.id}/chat`, 'POST', { text: fd.text, build: gearBuildKey() }).then((msg) => {
    GEARTHREAD.chat.push(msg);
    gearChatStickBottom = true;
    f.reset();
    render();
  }).catch((e) => toast(e.message, true));
};

/* ---- skill cores (section 3) ---- */
// The catalog (what skill cores even exist) is still to come - see server-geargear.js's SKILLCORE_CATALOG.
// Until then there is nothing real to pick from, so this says so plainly instead of showing an empty, useless
// checklist.
function gearSkillcoresHtml(t) {
  if (!t.skillcores.catalog.length) return `<div class="muted small">Your officers haven't added the skill core list yet. Once they do, you'll be able to mark which ones you own and which are active on your gear right now.</div>`;
  // Built once real catalog data exists (see the module comment above) - two checkbox columns, "Owned" and
  // "Active", with Active implicitly limited to whatever is already ticked as Owned.
  return `<div class="muted small">Skill core picker goes here.</div>`;
}

/* ---- questlog (section 4) - the same field a character's own edit form already has ---- */
function gearQuestlogHtml(t) {
  const links = t.questlogs.length ? t.questlogs.map((l) => `<div class="link-row"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(l))}</a></div>`).join('') : '<div class="muted small">No links yet.</div>';
  return `${links}<button type="button" class="btn sm" style="margin-top:10px" data-act="gear-ql-edit" data-id="${t.memberId}">${t.questlogs.length ? 'Edit links' : 'Add links'}</button>`;
}
ACTIONS['gear-ql-edit'] = (el, d) => {
  const t = GEARTHREAD.data;
  openDialog(`<form data-form="gear-questlogs" data-id="${d.id}">
    <h2>${'Questlog links'}</h2>
    <div class="field"><label>Links (up to 6)</label>
      <div id="ql-rows">${(t.questlogs.length ? t.questlogs : [{ label: '', url: '' }]).map(qlRow).join('')}</div>
      <button type="button" class="btn sm" data-act="ql-add" style="margin-top:4px">+ Add another link</button>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div>
  </form>`);
};
FORMS['gear-questlogs'] = (f) => gearAct(() => api(`/api/gearthreads/${f.dataset.id}/questlogs`, 'PUT', { links: collectLinks(f), build: gearBuildKey() })).then((ok) => ok && (closeDialog(), toast('Questlog' + ' saved')));

/* ---- folder (section 5) - admins/coaches post, the player only views ---- */
function gearFolderHtml(t) {
  const items = t.folder.length ? t.folder.map((f) => `
    <div class="gear-folder-item">
      <div class="gear-chat-meta"><b>${esc(f.postedByName)}</b><span class="muted small">${new Date(f.at).toLocaleString()}</span>
        ${(isOfficer() || f.postedBy === S.user.key) ? `<button type="button" class="x" data-act="gear-folder-del" data-id="${t.memberId}" data-item="${f.id}" aria-label="Remove">×</button>` : ''}</div>
      ${f.kind === 'image' ? `<img class="gear-shot" style="max-height:220px" src="${esc(f.image)}" alt="">` : ''}
      ${f.kind === 'link' ? `<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.text || f.url)}</a>` : ''}
      ${f.kind === 'text' || (f.kind !== 'link' && f.text) ? `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(f.text)}</div>` : ''}
    </div>`).join('') : '<div class="muted small">Nothing posted here yet.</div>';
  const composer = t.canPostFolder ? `
    <form data-form="gear-folder-post" data-id="${t.memberId}" class="gear-folder-form">
      <textarea name="text" maxlength="1000" placeholder="Add a note, with an optional link or image attached" data-autogrow></textarea>
      <div class="row">
        <div class="field" style="flex:1"><input name="url" type="url" placeholder="https://... (optional link)" maxlength="300"></div>
        <label class="btn sm" style="margin:0">Attach image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-act="gear-folder-image" class="hidden"></label>
      </div>
      <div class="muted small" id="gear-folder-imgname"></div>
      <button class="btn primary">Post</button>
    </form>` : '';
  return `<div class="gear-folder-list">${items}</div>${composer}`;
}
CHANGES['gear-folder-image'] = (el) => {
  const file = el.files[0]; if (!file) return;
  if (file.size > 6e6) { toast('That picture is too large (limit 6 MB).', true); el.value = ''; return; }
  const r = new FileReader();
  r.onload = () => { gearFolderImage = r.result; const n = $('#gear-folder-imgname'); if (n) n.textContent = 'Attached: ' + file.name; };
  r.readAsDataURL(file);
};
FORMS['gear-folder-post'] = (f, fd) => {
  const text = (fd.text || '').trim(), url = (fd.url || '').trim();
  let body;
  if (gearFolderImage) body = { kind: 'image', image: gearFolderImage, text };
  else if (url) body = { kind: 'link', url, text };
  else if (text) body = { kind: 'text', text };
  else { toast('Write something, paste a link, or attach an image first.', true); return; }
  body.build = gearBuildKey();
  gearAct(() => api(`/api/gearthreads/${f.dataset.id}/folder`, 'POST', body)).then((ok) => { if (ok) { f.reset(); gearFolderImage = null; } });
};
ACTIONS['gear-folder-del'] = (el, d) => { if (confirm('Remove this from the folder?')) gearAct(() => api(`/api/gearthreads/${d.id}/folder/${d.item}?${gearBuildQ()}`, 'DELETE')); };

/* ---- the five-section grid itself ---- */
// One tab per build this person may open (a coach only gets the builds of the class they coach). Each build has
// its own chat, screenshots, skill cores, build links and folder.
function gearBuildTabsHtml(t) {
  if (!t.builds || t.builds.length < 2) return t.builds && t.builds[0] && t.builds[0].class ? `<div class="muted small" style="margin-bottom:8px">${esc(t.builds[0].class)}</div>` : '';
  return `<div class="gear-tabs gear-build-tabs" style="margin-bottom:12px">${t.builds.map((b) =>
    `<button type="button" class="gear-tab ${b.key === t.buildKey ? 'active' : ''}" data-act="gear-build" data-id="${t.memberId}" data-build="${esc(b.key)}">${esc(b.name)}${b.class ? ` · ${esc(b.class)}` : ''}</button>`).join('')}</div>`;
}
ACTIONS['gear-build'] = (el, d) => {
  UI.gearBuildPref = UI.gearBuildPref || {};
  UI.gearBuildPref[String(d.id)] = d.build;
  stopGearChatPoll();
  GEARTHREAD = { id: String(d.id), data: null, chat: [], chatHasMore: false };
  loadGearThread(d.id, d.build);
  render();
};
function renderGearThread(t, chat, chatHasMore, chatLoadingOlder) {
  return `${gearBuildTabsHtml(t)}<div class="geargear-grid">
    <div class="panel geargear-screens"><h3>Screenshots</h3>${gearScreensHtml(t)}</div>
    <div class="panel geargear-chat"><h3>Chat</h3>${gearChatHtml(t, chat, chatHasMore, chatLoadingOlder)}</div>
    <div class="geargear-side">
      <div class="panel"><h3>Skill cores</h3>${gearSkillcoresHtml(t)}</div>
      <div class="panel"><h3>${'Questlog'}</h3>${gearQuestlogHtml(t)}</div>
      <div class="panel"><h3>Folder</h3>${gearFolderHtml(t)}</div>
    </div>
  </div>`;
}
