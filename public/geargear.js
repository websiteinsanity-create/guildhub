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
let gearThreadLoadSerial = 0;
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
  const serial = ++gearThreadLoadSerial;
  gearFolderImage = null;
  gearChatLastScroll = null; gearChatStickBottom = true;   // fresh thread: no scroll history to carry over
  api('/api/gearthreads/' + id + (build ? '?build=' + encodeURIComponent(build) : '')).then((full) => {
    if (serial !== gearThreadLoadSerial) return;
    const { chat, chatHasMore, ...data } = full;
    GEARTHREAD = { id: String(id), data, chat, chatHasMore, chatLoadingOlder: false };
    if (onGearThreadPage(id)) render();
    if (data.buildKey && UI.gearBuildPref) UI.gearBuildPref[String(id)] = data.buildKey;
    startGearChatPoll(id);
  }).catch((e) => {
    if (serial !== gearThreadLoadSerial) return;
    GEARTHREAD = { id: String(id), data: null, error: e.message || 'Could not load this gear thread.', chat: [], chatHasMore: false };
    if (onGearThreadPage(id)) render();
  });
}
// Runs a gear-thread write OTHER than chat, merges in whatever fields the server sent back (never chat - see
// threadFor()'s own comment server-side), and re-renders. Same shape as act() elsewhere, just without act()'s
// full /api/state refresh, which this page has no use for.
async function gearAct(fn) {
  const thread = GEARTHREAD;
  try { const result = await fn(); if (GEARTHREAD === thread) { Object.assign(thread.data, result); render(); } return true; }
  catch (e) { toast(e.message, true); return false; }
}

// Infinite-scroll-up: fetch the next older page once the viewer scrolls near the top of the chat list.
async function loadOlderGearChat() {
  const t = GEARTHREAD;
  if (t.chatLoadingOlder || !t.chatHasMore || !t.chat.length) return;
  t.chatLoadingOlder = true;
  try {
    const { messages, hasMore } = await api(`/api/gearthreads/${t.id}/chat?before=${t.chat[0].id}&${gearBuildQ()}`);
    if (GEARTHREAD !== t) return;
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
      const t = GEARTHREAD;
      const { messages } = await api(`/api/gearthreads/${id}/chat?${gearBuildQ()}`);
      if (GEARTHREAD !== t || !onGearThreadPage(id)) return;
      const newestId = t.chat.length ? t.chat[t.chat.length - 1].id : 0;
      const fresh = messages.filter((m) => m.id > newestId);
      if (fresh.length) { t.chat.push(...fresh); render(); }
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
  const m = S.members.find(x => String(x.id) === String(id));
  const canSeeIndex = isOfficer() || S.isCoach;
  UI.gearBuildPref = UI.gearBuildPref || {};
  if (GEARTHREAD.id !== String(id)) { GEARTHREAD = { id: String(id), data: null, chat: [], chatHasMore: false }; loadGearThread(id, UI.gearBuildPref[String(id)]); }
  const t = GEARTHREAD.data, sel = m && t && t.buildKey !== 'main' ? (m.builds || []).find(x => String(x.id) === t.buildKey) : null;
  const head = `<div class="gear-workspace-head"><div>${canSeeIndex ? '<a class="gear-back-link" href="#/gearthreads">← Back to Gear Threads</a>' : ''}<div class="gear-person"><span class="gear-person-initial" aria-hidden="true">${esc((t?.name || m?.name || '?').slice(0,2).toUpperCase())}</span><div><h1>${esc(t?.name || m?.name || 'Gear thread')}</h1><div class="muted">${t?.buildClass ? esc(t.buildClass) : ''}${m ? `${t?.buildClass ? ' · ' : ''}${weaponLine(sel || m)}` : ''}</div></div></div></div>${t ? gearBuildTabsHtml(t) : ''}</div>`;
  if (GEARTHREAD.error) return `${head}<div class="empty">${esc(GEARTHREAD.error)}</div>`;
  if (!t) return `${head}<div class="empty">Loading…</div>`;
  return '<section class="gear-workspace">' + head + renderGearThread(t, GEARTHREAD.chat, GEARTHREAD.chatHasMore, GEARTHREAD.chatLoadingOlder) + '</section>';
}
// Keep unsaved text per viewer/thread/build when chat polling or other writes redraw the workspace.
const gearDrafts = new Map();
const gearDraftKey = (t, kind, section = '') => JSON.stringify([S.user.key, String(t.memberId), t.buildKey || 'main', kind, String(section)]);
const gearDraftValue = (t, kind, field, fallback = '', section = '') => gearDrafts.get(gearDraftKey(t,kind,section))?.[field] ?? fallback;
function gearClearSubmittedDraft(t, kind, fields, section = '') {
  const key = gearDraftKey(t,kind,section), draft = gearDrafts.get(key);
  if (!draft) return;
  for (const [field,value] of Object.entries(fields)) if (draft[field] === value) delete draft[field];
  if (!Object.keys(draft).length) gearDrafts.delete(key);
}
document.addEventListener('input', e => {
  const field = e.target, f = field.closest?.('form[data-form]'), t = GEARTHREAD.data;
  if (!t || !f || !['gear-note','gear-chat','gear-folder-post'].includes(f.dataset.form) || !field.name) return;
  const key = gearDraftKey(t,f.dataset.form,f.dataset.section || '');
  gearDrafts.set(key,{...gearDrafts.get(key),[field.name]:field.value});
});
const gearTopicKey = t => JSON.stringify([S.user.key,String(t.memberId),t.buildKey || 'main']);
function gearSelectedTopic(t) {
  const selected = UI.gearTopicPref?.[gearTopicKey(t)];
  return String(t.screens.find(s => String(s.sectionId) === selected)?.sectionId ?? t.screens[0]?.sectionId ?? '');
}

/* ---- screenshots (section 2: a swipeable strip, one slide per topic) ----
   Topics themselves (add/rename/reorder/remove) are an Admin > Gear Threads screen - see gearSectionsAdmin()
   in features.js. Each slide here is keyed by the topic's stable sectionId, not its label, so a rename there
   never loses what's already uploaded under it. */
function gearScreensHtml(t) {
  if (!t.screens.length) return '<div class="empty">No screenshot topics yet. An officer can set them up in Admin → Gear Threads.</div>';
  const selected = gearSelectedTopic(t);
  const tabs = t.screens.map(s => `<button type="button" role="tab" id="gear-topic-${s.sectionId}" aria-controls="gslide-${s.sectionId}" aria-selected="${String(s.sectionId) === selected}" tabindex="${String(s.sectionId) === selected ? 0 : -1}" class="gear-tab ${String(s.sectionId) === selected ? 'active' : ''}" data-act="gear-slide" data-section="${s.sectionId}">${esc(s.label)}</button>`).join('');
  const slides = t.screens.map(s => `<div class="gear-slide" role="tabpanel" aria-labelledby="gear-topic-${s.sectionId}" id="gslide-${s.sectionId}" ${String(s.sectionId) === selected ? '' : 'hidden'}>
      <div class="gear-screenshot-preview">${s.image ? `<button type="button" class="gear-image-open" data-act="gear-image-open" data-section="${s.sectionId}" aria-label="${esc('Enlarge ' + s.label + ' screenshot')}"><img class="gear-shot" src="${esc(s.image)}" alt="${esc(s.label)}"></button>` : '<div class="empty">No screenshot yet. Upload an image of your current setup.</div>'}</div>
      <div class="gear-slide-head"><button type="button" class="btn sm" data-act="gear-screen-upload-open" data-section="${s.sectionId}" data-label="${esc(s.label)}">${s.image ? 'Replace image' : 'Upload image'}</button><span class="muted small">Images up to 6 MB · paste a screenshot with Ctrl+V</span></div>
      <form data-form="gear-note" data-id="${t.memberId}" data-section="${s.sectionId}" class="gear-screenshot-note">
        <label for="gear-note-${s.sectionId}">Screenshot note</label><div class="gear-note-controls"><textarea id="gear-note-${s.sectionId}" name="note" maxlength="1000" placeholder="Anything the screenshot does not show…" data-autogrow>${esc(gearDraftValue(t,'gear-note','note',s.note,s.sectionId))}</textarea><button class="btn sm primary">Save note</button></div>
      </form>
      ${s.updatedAt ? `<div class="muted small">Updated by ${esc(s.updatedByName)} · ${new Date(s.updatedAt).toLocaleString()}</div>` : ''}
    </div>`).join('');
  return `<div class="gear-tabs gear-topic-tabs" role="tablist" aria-label="Screenshot topics">${tabs}</div><div class="gear-slides">${slides}</div>`;
}
ACTIONS['gear-slide'] = (el, d) => {
  const t = GEARTHREAD.data;
  if (!t || !t.screens.some(s => String(s.sectionId) === String(d.section))) return;
  (UI.gearTopicPref ||= {})[gearTopicKey(t)] = String(d.section);
  for (const s of t.screens) {
    const active = String(s.sectionId) === String(d.section), panel = document.getElementById('gslide-' + s.sectionId), button = document.getElementById('gear-topic-' + s.sectionId);
    if (panel) { panel.hidden = !active; if (active) autosizeAll(panel); }
    if (button) { button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); button.tabIndex = active ? 0 : -1; }
  }
};
ACTIONS['gear-image-open'] = (el,d) => {
  const t=GEARTHREAD.data;
  const image=d.section!==undefined ? t?.screens.find(s=>String(s.sectionId)===String(d.section)) : t?.folder.find(f=>f.kind==='image' && String(f.id)===String(d.item));
  if(!image?.image)return;
  const label=image.label || 'Coach folder image';
  openDialog(`<section class="gear-image-viewer" aria-label="${esc(label)}"><div class="gear-image-toolbar"><h2>${esc(label)}</h2><button type="button" class="btn sm" data-act="gear-image-zoom" aria-pressed="false">Actual size</button><button type="button" class="btn sm" data-act="dlg-close" autofocus>Close</button></div><div class="gear-image-viewport" tabindex="0" aria-label="Screenshot — scroll to inspect when zoomed"><img src="${esc(image.image)}" alt="${esc(label)}"></div></section>`,true);
};
ACTIONS['gear-image-zoom'] = el => {
  const image=$('#dlg .gear-image-viewport img');if(!image)return;
  const zoomed=el.getAttribute('aria-pressed')!=='true';
  image.classList.toggle('actual-size',zoomed);el.setAttribute('aria-pressed',String(zoomed));el.textContent=zoomed?'Fit to screen':'Actual size';
};
document.addEventListener('keydown', e => {
  if (!e.target?.matches?.('.gear-topic-tabs [role="tab"]') || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
  const buttons = [...document.querySelectorAll('.gear-topic-tabs [role="tab"]')];
  if (!buttons.length) return;
  e.preventDefault(); const index = buttons.indexOf(e.target);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length-1 : (index + (e.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next].focus(); ACTIONS['gear-slide'](buttons[next],buttons[next].dataset);
});

// The upload/replace button opens a small popup with a drag-and-drop zone plus a "choose a file" button,
// rather than triggering the OS file picker directly - gearUploadDialog() below is shared with anywhere else
// a single-image upload needs the same popup (so far just this one, but the folder's "attach image" could
// grow into it later without duplicating the dropzone markup/handlers).
function gearUploadDialog({ title, section, onFile }) {
  openDialog(`<h2>${esc(title)}</h2>
    <div class="gear-dropzone" id="gear-dropzone" tabindex="0" aria-label="Image upload: drop, choose a file or paste with Ctrl+V" data-section="${section == null ? '' : section}">
      <div class="gear-dropzone-inner">
        <div>Drag and drop an image here</div>
        <div class="muted small" style="margin-top:8px">or paste a screenshot with Ctrl+V (⌘+V on Mac)</div>
        <div class="muted small" style="margin:8px 0">or</div>
        <button type="button" class="btn primary" data-act="gear-dropzone-pick">Choose a file</button>
        <input type="file" id="gear-dropzone-input" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden" data-act="gear-dropzone-file">
      </div>
    </div>
    <p id="gear-upload-status" class="muted small" role="status" aria-live="polite">PNG, JPEG, GIF or WebP · up to 6 MB</p>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-act="dlg-close">Cancel</button></div>`);
  const context=gearUploadContext={thread:GEARTHREAD,zone:document.getElementById('gear-dropzone'),busy:false};
  gearDropHandler=async file=>{
    if(!gearUploadIsCurrent(context) || context.busy)return;
    context.busy=true;context.zone.setAttribute('aria-busy','true');
    const status=$('#gear-upload-status'),pick=document.getElementById('gear-dropzone-input');
    if(status)status.textContent='Uploading screenshot…';if(pick)pick.disabled=true;
    try{const ok=await onFile(file,context);if(ok && gearUploadIsCurrent(context))closeDialog();}
    finally{context.busy=false;context.zone.removeAttribute('aria-busy');if(pick)pick.disabled=false;if(gearUploadIsCurrent(context) && status)status.textContent='PNG, JPEG, GIF or WebP · up to 6 MB';}
  };
  context.zone?.focus();
}
let gearDropHandler = null, gearUploadContext = null;
const gearUploadIsCurrent = context => context===gearUploadContext && GEARTHREAD===context.thread && onGearThreadPage(context.thread.id) && $('#dlg')?.open && document.getElementById('gear-dropzone')===context.zone;
ACTIONS['gear-screen-upload-open'] = (el, d) => {
  const screen=GEARTHREAD.data?.screens.find(s=>String(s.sectionId)===String(d.section));if(!screen)return;
  gearUploadDialog({ title: `Upload ${screen.label} screenshot`, section: screen.sectionId, onFile: (file,context) => gearUploadScreenFile(screen.sectionId, file,context) });
};
ACTIONS['gear-dropzone-pick'] = () => { const i = document.getElementById('gear-dropzone-input'); if (i) i.click(); };
CHANGES['gear-dropzone-file'] = (el) => { const file = el.files[0]; el.value=''; if (file && gearDropHandler) gearDropHandler(file); };
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
function gearClipboardImage(data) {
  return [...(data?.files || [])].find(f=>f.type.startsWith('image/')) || [...(data?.items || [])].find(i=>i.kind==='file' && i.type.startsWith('image/'))?.getAsFile();
}
document.addEventListener('paste',e=>{
  if(!onGearThreadPage(GEARTHREAD.id))return;
  const upload=gearUploadContext && gearUploadIsCurrent(gearUploadContext);
  const folder=!$('#dlg')?.open && e.target?.closest?.('form[data-form="gear-folder-post"]') && GEARTHREAD.data?.canPostFolder;
  const pagePaste=!$('#dlg')?.open && !folder && !e.target?.closest?.('input,textarea,select,[contenteditable]') && GEARTHREAD.data?.screens.length;
  if(!upload && !folder && !pagePaste)return;
  const file=gearClipboardImage(e.clipboardData);if(!file)return;
  e.preventDefault();
  if(upload)gearDropHandler(file);
  else if(folder)CHANGES['gear-folder-image']({files:[file],value:''});
  else {ACTIONS['gear-screen-upload-open'](null,{section:gearSelectedTopic(GEARTHREAD.data)});gearDropHandler?.(file);}
});
function gearValidImage(file) {
  if(!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)){toast('Use a PNG, JPEG, GIF or WebP image.',true);return false;}
  if(file.size>6e6){toast('That picture is too large (limit 6 MB).',true);return false;}
  return true;
}
async function gearUploadScreenFile(sectionId, file,context) {
  if(!gearValidImage(file))return false;
  const thread=GEARTHREAD,id=thread.id,build=gearBuildKey();
  try{
    const image=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Could not read this image. Please try again.'));r.onabort=()=>reject(Error('Image reading was cancelled.'));r.readAsDataURL(file);});
    if(!gearUploadIsCurrent(context))return false;
    const ok=await gearAct(()=>api(`/api/gearthreads/${id}/screens/${sectionId}`,'PUT',{image,build}));
    if(ok && GEARTHREAD===thread)toast('Screenshot uploaded');return ok;
  }catch(e){toast(e.message,true);return false;}
}
FORMS['gear-note'] = (f, fd) => {
  const t = GEARTHREAD.data;
  return gearAct(async () => { const result = await api(`/api/gearthreads/${f.dataset.id}/screens/${f.dataset.section}`, 'PUT', { note: fd.note, build: t.buildKey || 'main' }); gearClearSubmittedDraft(t,'gear-note',{note:fd.note},f.dataset.section); return result; }).then(ok => ok && toast('Note saved'));
};

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
      <textarea name="text" maxlength="20000" aria-label="Message" placeholder="Write a message…" required data-autogrow>${esc(gearDraftValue(t,'gear-chat','text'))}</textarea>
      <button class="btn primary" ${gearChatSending.has(gearDraftKey(t,'gear-chat')) ? 'disabled' : ''}>Send</button>
    </form>`;
}
const gearChatSending = new Set();
FORMS['gear-chat'] = async (f, fd) => {
  const thread = GEARTHREAD, t = thread.data;
  if (!t || !fd.text || !fd.text.trim()) return;
  const key = gearDraftKey(t,'gear-chat');
  if (gearChatSending.has(key)) return;
  gearChatSending.add(key);
  const button = f.querySelector('button'); if (button) button.disabled = true;
  try {
    const msg = await api(`/api/gearthreads/${t.memberId}/chat`, 'POST', {text:fd.text,build:t.buildKey || 'main'});
    gearClearSubmittedDraft(t,'gear-chat',{text:fd.text});
    if (GEARTHREAD === thread) { thread.chat.push(msg); gearChatStickBottom = true; }
  } catch (e) { toast(e.message,true); }
  finally { gearChatSending.delete(key); if (GEARTHREAD === thread && onGearThreadPage(thread.id)) render(); }
};

/* ---- source-attributed skill-core collection ---- */
let gearCoreDialogContext = null, gearCoreSaving = false;
const gearCoreCompatible = (core,t) => !core.weapons?.length || core.weapons.some(w=>(t.skillcores.weapons || []).includes(w));
function gearCoreTile(core) {
  const warning=core.descriptionStatus==='unresolved-source-tokens'?' Source contains unresolved values.':'';
  return `<button type="button" class="gear-core-tile" data-act="gear-core-open" data-core="${esc(core.id)}" title="${esc(core.name+' · '+(core.weapons.join(' / ') || 'Universal')+'\n'+core.description+warning)}"><img src="${esc(core.icon)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer"><span>${esc(core.name)}</span></button>`;
}
function gearSkillcoresHtml(t) {
  const skills={catalog:[],active:[],owned:[],...t.skillcores}, lookup=new Map(skills.catalog.map(c=>[c.id,c]));
  const active=skills.active.map(id=>lookup.get(id)).filter(Boolean), unused=skills.owned.filter(id=>!skills.active.includes(id)).map(id=>lookup.get(id)).filter(Boolean).sort((a,b)=>a.name.localeCompare(b.name));
  const weapon=active.filter(c=>c.slot==='weapon'), equipment=active.filter(c=>c.slot==='equipment');
  return `<section class="gear-core-collection"><h3>Active <span class="muted small">${active.length}/3</span></h3><div class="gear-core-slot-label">Weapon · ${weapon.length}/1</div>${weapon.map(gearCoreTile).join('') || '<div class="gear-core-empty">No weapon core active</div>'}<div class="gear-core-slot-label">Armor / accessories · ${equipment.length}/2</div>${equipment.map(gearCoreTile).join('') || '<div class="gear-core-empty">No equipment cores active</div>'}<div class="gear-core-owned-head"><h3>Owned <span class="muted small">${unused.length}</span></h3><button type="button" class="btn sm" data-act="gear-core-picker">+ Add</button></div><div class="gear-core-owned-list">${unused.map(gearCoreTile).join('') || '<div class="muted small">No additional cores in your collection.</div>'}</div><p class="gear-core-source muted small">${skills.owned.length} owned in total · shared across builds</p></section>`;
}
function gearCorePickerResults() {
  const t=GEARTHREAD.data;if(!t)return '';
  const q=(UI.gearCoreQ || '').trim().toLowerCase();
  const list=t.skillcores.catalog.filter(c=>(UI.gearCoreLegacy || c.availability!=='legacy') && (!UI.gearCoreSlot || c.slot===UI.gearCoreSlot) && (!UI.gearCoreWeapon || (UI.gearCoreWeapon==='universal'?!c.weapons.length:c.weapons.includes(UI.gearCoreWeapon))) && (!q || (c.name+' '+c.description).toLowerCase().includes(q)));
  return `<div class="muted small gear-core-result-count">${list.length} cores · ${t.skillcores.metadata?.verifiedAt ? 'Source snapshot '+esc(t.skillcores.metadata.verifiedAt) : 'Local catalog'}</div><div class="gear-core-picker-list">${list.map(gearCoreTile).join('') || '<div class="empty">No matching skill cores.</div>'}</div>`;
}
ACTIONS['gear-core-picker'] = () => {
  const t=GEARTHREAD.data;if(!t)return;
  openDialog(`<div class="gear-core-picker"><h2>Skill cores</h2><p class="muted small">Choose a core to view its effect and add it to your collection.</p><div class="gear-core-filters"><input type="search" aria-label="Search skill cores" placeholder="Search name or effect…" data-core-search value="${esc(UI.gearCoreQ || '')}"><select aria-label="Skill-core slot" data-act="gear-core-filter" data-field="gearCoreSlot"><option value="">All slots</option><option value="weapon" ${UI.gearCoreSlot==='weapon'?'selected':''}>Weapon</option><option value="equipment" ${UI.gearCoreSlot==='equipment'?'selected':''}>Armor / accessories</option></select><select aria-label="Skill-core weapon" data-act="gear-core-filter" data-field="gearCoreWeapon">${opts(['',...new Set(t.skillcores.catalog.flatMap(c=>c.weapons))].filter(Boolean).sort(),UI.gearCoreWeapon,'All weapons')}<option value="universal" ${UI.gearCoreWeapon==='universal'?'selected':''}>Universal</option></select><label class="small muted"><input type="checkbox" data-act="gear-core-filter" data-field="gearCoreLegacy" ${UI.gearCoreLegacy?'checked':''}> Include historical entries</label></div><div id="gear-core-results">${gearCorePickerResults()}</div><div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Close</button></div></div>`,true);
};
function refreshGearCoreResults(){const results=$('#gear-core-results');if(results)results.innerHTML=gearCorePickerResults();}
CHANGES['gear-core-filter']=el=>{if(!['gearCoreSlot','gearCoreWeapon','gearCoreLegacy'].includes(el.dataset.field))return;UI[el.dataset.field]=el.type==='checkbox'?el.checked:el.value;refreshGearCoreResults();};
document.addEventListener('input',e=>{if(e.target.matches?.('[data-core-search]')){UI.gearCoreQ=e.target.value;refreshGearCoreResults();}});
ACTIONS['gear-core-open']=(el,d)=>{
  const thread=GEARTHREAD,t=thread.data,core=t?.skillcores.catalog.find(c=>c.id===d.core);if(!core)return;
  gearCoreDialogContext={thread,core};
  const skills=t.skillcores,owned=skills.owned.includes(core.id),active=skills.active.includes(core.id),sameSlot=skills.active.map(id=>skills.catalog.find(c=>c.id===id)).filter(c=>c?.slot===core.slot).length;
  const available=sameSlot<(core.slot==='weapon'?1:2) && skills.active.length<3,compatible=gearCoreCompatible(core,t);
  openDialog(`<div class="gear-core-details"><div class="gear-core-detail-head"><img src="${esc(core.icon)}" alt="" width="44" height="44" referrerpolicy="no-referrer"><h2>${esc(core.name)}</h2></div><p class="muted small">${core.slot==='weapon'?'Weapon':'Armor / accessories'} · ${esc(core.weapons.join(' / ') || 'Universal')}</p><div class="gear-core-effect">${esc(core.description)}</div>${core.descriptionStatus==='unresolved-source-tokens'?'<p class="gear-core-notice">The source contains unresolved formula values. These values have not been guessed.</p>':''}${core.availability==='legacy'?'<p class="gear-core-notice">Historical entry retained by the source. Verify availability in your game version.</p>':''}<a href="${esc(core.sourceUrl)}" target="_blank" rel="noopener noreferrer">View source ↗</a>${owned && !active && (!compatible || !available)?`<p class="muted small">${!compatible?'This core does not match this build’s weapons.':'Deactivate another core in this slot before activating this one.'}</p>`:''}<div class="dlg-actions"><button type="button" class="btn" data-act="gear-core-picker">Browse catalog</button>${owned?`<button type="button" class="btn danger" data-act="gear-core-update" data-operation="remove" ${active?'disabled title="Deactivate this core first"':''}>Remove from Owned</button><button type="button" class="btn primary" data-act="gear-core-update" data-operation="${active?'deactivate':'activate'}" ${!active && (!compatible || !available)?'disabled':''}>${active?'Deactivate':'Set active'}</button>`:'<button type="button" class="btn primary" data-act="gear-core-update" data-operation="add">Add to Owned</button>'}<button type="button" class="btn" data-act="dlg-close">Close</button></div></div>`,true);
};
ACTIONS['gear-core-update']=async(el,d)=>{
  if(gearCoreSaving)return;
  const context=gearCoreDialogContext;
  if(!context || GEARTHREAD!==context.thread){toast('This build has changed. Open the skill core again.',true);return;}
  const t=context.thread.data,id=context.core.id,body={build:t.buildKey};
  if(d.operation==='add')body.addOwned=[id];else if(d.operation==='remove')body.removeOwned=[id];else if(d.operation==='activate')body.active=[...t.skillcores.active,id];else if(d.operation==='deactivate')body.active=t.skillcores.active.filter(x=>x!==id);else return;
  gearCoreSaving=true;el.disabled=true;
  try{const ok=await gearAct(()=>api(`/api/gearthreads/${t.memberId}/skillcores`,'PUT',body));if(ok){closeDialog();toast('Skill cores saved');}else el.disabled=false;}finally{gearCoreSaving=false;}
};
// Optional catalog updates remain officer-only and never scrape an external site during page use.
function gearSkillCatalogAdmin(){
  const meta=UI.gearCatalogAdminMeta;
  return `<div class="panel"><h3>Skill-core catalog</h3><p class="muted small">A local English source snapshot is bundled. Import a validated JSON catalog to update it; existing player references are protected.</p>${meta?`<p>${meta.entries?.length ?? meta.count} entries · ${esc(meta.source)} · ${esc(meta.verifiedAt)}</p>`:''}<div class="link-row"><button type="button" class="btn sm" data-act="gear-core-catalog-check">Catalog details</button><label class="btn sm">Import JSON<input type="file" class="hidden" accept="application/json,.json" data-act="gear-core-catalog-import"></label></div><p class="muted small">Source snapshots may contain historical entries or unresolved formulas. Effects are displayed as published, without guessed values.</p></div>`;
}
ACTIONS['gear-core-catalog-check']=async()=>{try{UI.gearCatalogAdminMeta=await api('/api/admin/skillcores/catalog');render();}catch(e){toast(e.message,true);}};
CHANGES['gear-core-catalog-import']=async el=>{
  const file=el.files?.[0];if(!file)return;if(file.size>4e6){toast('Catalog files can be up to 4 MB.',true);return;}
  try{const data=JSON.parse(await file.text());UI.gearCatalogAdminMeta=await api('/api/admin/skillcores/catalog','PUT',data);render();toast('Catalog imported');}catch(e){toast(e.message,true);}finally{el.value='';}
};

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
      ${f.kind === 'image' ? `<button type="button" class="gear-image-open" data-act="gear-image-open" data-item="${f.id}" aria-label="Enlarge coach folder image"><img class="gear-shot" style="max-height:220px" src="${esc(f.image)}" alt="Coach folder image"></button>` : ''}
      ${f.kind === 'link' ? `<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.text || f.url)}</a>` : ''}
      ${f.kind === 'text' || (f.kind !== 'link' && f.text) ? `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(f.text)}</div>` : ''}
    </div>`).join('') : '<div class="muted small">Nothing posted here yet.</div>';
  const composer = t.canPostFolder ? `
    <form data-form="gear-folder-post" data-id="${t.memberId}" class="gear-folder-form">
      <textarea name="text" maxlength="1000" placeholder="Add a note, with an optional link or image attached" data-autogrow>${esc(gearDraftValue(t,'gear-folder-post','text'))}</textarea>
      <div class="row">
        <div class="field" style="flex:1"><input name="url" type="url" aria-label="Resource link" value="${esc(gearDraftValue(t,'gear-folder-post','url'))}" placeholder="https://... (optional link)" maxlength="300"></div>
        <label class="btn sm" style="margin:0">Attach image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-act="gear-folder-image" class="hidden"></label>
      </div>
      <div class="muted small" id="gear-folder-imgname">Attach an image or paste one here with Ctrl+V.</div>
      <button class="btn primary">Post</button>
    </form>` : '';
  return `<div class="gear-folder-list">${items}</div>${composer}`;
}
CHANGES['gear-folder-image'] = (el) => {
  const file = el.files[0]; if (!file) return;
  if (!gearValidImage(file)) { el.value = ''; return; }
  const thread = GEARTHREAD;
  const r = new FileReader();
  r.onload = () => { if (GEARTHREAD !== thread) return; gearFolderImage = r.result; const n = $('#gear-folder-imgname'); if (n) n.textContent = 'Attached: ' + file.name; };
  r.onerror = () => toast('Could not read this image. Please try again.',true);
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
  const draftThread = GEARTHREAD.data;
  gearAct(async () => { const result = await api(`/api/gearthreads/${f.dataset.id}/folder`, 'POST', body); gearClearSubmittedDraft(draftThread,'gear-folder-post',{text:fd.text || '',url:fd.url || ''}); return result; }).then((ok) => { if (ok) { f.reset(); gearFolderImage = null; } });
};
ACTIONS['gear-folder-del'] = (el, d) => { if (confirm('Remove this from the folder?')) gearAct(() => api(`/api/gearthreads/${d.id}/folder/${d.item}?${gearBuildQ()}`, 'DELETE')); };

/* ---- the five-section grid itself ---- */
// One tab per build this person may open (a coach only gets the builds of the class they coach). Each build has
// its own chat, screenshots, skill cores, build links and folder.
function gearBuildTabsHtml(t) {
  if (!t.builds || t.builds.length < 2) return '';
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
  return `<div class="geargear-grid gear-workspace-grid">
    <div class="panel geargear-screens"><div class="gear-panel-heading"><h2>Screenshots</h2><span class="muted small">Your current setup</span></div>${gearScreensHtml(t)}</div>
    <div class="panel geargear-chat"><div class="gear-panel-heading"><h2>Discussion</h2><span class="muted small">Talk through your build</span></div>${gearChatHtml(t, chat, chatHasMore, chatLoadingOlder)}</div>
    <div class="geargear-side gear-workspace-resources">
      <div class="panel"><div class="gear-panel-heading"><h2>Questlog</h2><span class="muted small">Build links</span></div>${gearQuestlogHtml(t)}</div>
      <div class="panel"><div class="gear-panel-heading"><h2>Coach folder</h2><span class="muted small">Notes and resources</span></div>${gearFolderHtml(t)}</div>
      <div class="panel"><div class="gear-panel-heading"><h2>Skill cores</h2></div>${gearSkillcoresHtml(t)}</div>
    </div>
  </div>`;
}

// Skill-core icons come from Questlog's CDN. If it can't be reached (offline server, blocked host, moved file) show a
// plain empty square instead of the browser's broken-image glyph.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.closest && t.closest('.gear-core-tile, .gear-core-detail-head')) t.classList.add('icon-missing');
}, true);
