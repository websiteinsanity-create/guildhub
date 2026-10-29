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
const gearImages = s => Array.isArray(s?.images) ? s.images : (s?.image ? [{id:s.image,image:s.image}] : []);
const gearGallerySelection = new Map();
const gearGalleryKey = (t,section) => gearTopicKey(t)+':'+section;
function gearGalleryIndex(t,s) { const i=gearImages(s).findIndex(x=>x.id===gearGallerySelection.get(gearGalleryKey(t,s.sectionId)));return Math.max(0,i); }
function gearGalleryHtml(t,s) {
  const images=gearImages(s), index=gearGalleryIndex(t,s), current=images[index];
  return `<div class="gear-slide-head"><b>${esc(s.label)}</b><span class="muted small">${images.length} screenshot${images.length===1?'':'s'}</span></div>
    <div class="gear-screenshot-preview">${current?`<button type="button" class="gear-image-open" data-act="gear-image-open" data-section="${s.sectionId}" data-index="${index}" aria-label="Enlarge ${esc(s.label)} screenshot"><img class="gear-shot" src="${esc(current.image)}" alt="${esc(s.label)}"></button>`:'<div class="empty">No screenshots yet. Add images of your current setup.</div>'}</div>
    <div class="gear-gallery-thumbs" aria-label="Screenshots">${images.map((im,i)=>`<div class="gear-gallery-thumb ${i===index?'selected':''}" draggable="true" data-gear-drag="${esc(im.id)}" data-section="${s.sectionId}">
      <button type="button" data-act="gear-gallery-select" data-section="${s.sectionId}" data-image="${esc(im.id)}" aria-label="Select screenshot ${i+1}" aria-pressed="${i===index}"><img src="${esc(im.preview || im.image)}" alt="Screenshot ${i+1}" loading="lazy">${i===0?'<span class="gear-cover">Main</span>':''}</button>
      <div class="gear-thumb-actions"><button type="button" data-act="gear-gallery-move" data-section="${s.sectionId}" data-image="${esc(im.id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="Move screenshot left">←</button><button type="button" data-act="gear-gallery-move" data-section="${s.sectionId}" data-image="${esc(im.id)}" data-dir="1" ${i===images.length-1?'disabled':''} aria-label="Move screenshot right">→</button><button type="button" data-act="gear-gallery-delete" data-section="${s.sectionId}" data-image="${esc(im.id)}" aria-label="Delete screenshot ${i+1}">×</button></div></div>`).join('')}</div>
      ${images.length>1?'<div class="muted small">Drag to reorder or use the arrows · First image is the cover</div>':''}`;
}
ACTIONS['gear-gallery-select']=(el,d)=>{gearGallerySelection.set(gearGalleryKey(GEARTHREAD.data,d.section),d.image);render();};
async function gearGalleryWrite(section,body){const t=GEARTHREAD;return gearAct(()=>api(`/api/gearthreads/${t.id}/screens/${section}`,'PUT',{...body,build:gearBuildKey()}));}
ACTIONS['gear-gallery-delete']=(el,d)=>{if(confirm('Delete this screenshot?'))return gearGalleryWrite(d.section,{removeId:d.image});};
ACTIONS['gear-gallery-move']=(el,d)=>{
 const s=GEARTHREAD.data.screens.find(s=>String(s.sectionId)===String(d.section)), ids=gearImages(s).map(x=>x.id), i=ids.indexOf(d.image),j=i+Number(d.dir);
 if(i<0||j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];return gearGalleryWrite(d.section,{order:ids});
};
let gearGalleryDrag=null;
document.addEventListener('dragstart',e=>{const el=e.target.closest?.('[data-gear-drag]');if(!el)return;gearGalleryDrag={thread:GEARTHREAD,section:el.dataset.section,id:el.dataset.gearDrag};e.dataTransfer.setData('text/plain',el.dataset.gearDrag);});
document.addEventListener('dragend',()=>{gearGalleryDrag=null;});
document.addEventListener('dragover',e=>{if(gearGalleryDrag&&e.target.closest?.('[data-gear-drag]'))e.preventDefault();});
document.addEventListener('drop',e=>{
 const dest=e.target.closest?.('[data-gear-drag]'),from=gearGalleryDrag;gearGalleryDrag=null;
 if(!dest||!from||from.thread!==GEARTHREAD||from.section!==dest.dataset.section)return;
 e.preventDefault();const s=GEARTHREAD.data.screens.find(x=>String(x.sectionId)===from.section),ids=gearImages(s).map(x=>x.id),i=ids.indexOf(from.id),j=ids.indexOf(dest.dataset.gearDrag);
 if(i<0||j<0||i===j)return;ids.splice(i,1);ids.splice(j,0,from.id);gearGalleryWrite(from.section,{order:ids});
});
function gearScreensHtml(t) {
  if (!t.screens.length) return '<div class="empty">No screenshot topics yet. An officer can set them up in Admin → Gear Threads.</div>';
  const selected = gearSelectedTopic(t);
  const tabs = t.screens.map(s => `<button type="button" role="tab" id="gear-topic-${s.sectionId}" aria-controls="gslide-${s.sectionId}" aria-selected="${String(s.sectionId) === selected}" tabindex="${String(s.sectionId) === selected ? 0 : -1}" class="gear-tab ${String(s.sectionId) === selected ? 'active' : ''}" data-act="gear-slide" data-section="${s.sectionId}">${esc(s.label)}</button>`).join('');
  const slides = t.screens.map(s => `<div class="gear-slide" role="tabpanel" aria-labelledby="gear-topic-${s.sectionId}" id="gslide-${s.sectionId}" ${String(s.sectionId) === selected ? '' : 'hidden'}>
      ${gearGalleryHtml(t,s)}
      <div class="gear-slide-head"><button type="button" class="btn sm primary" data-act="gear-screen-upload-open" data-section="${s.sectionId}">+ Add screenshots</button><span class="muted small">Images up to 6 MB each · paste with Ctrl+V</span></div>
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
let gearViewer=null;
ACTIONS['gear-image-open'] = (el,d) => {
 const t=GEARTHREAD.data, section=d.section!==undefined?t?.screens.find(s=>String(s.sectionId)===String(d.section)):null;
 const folder=d.item!==undefined?t?.folder.find(f=>f.kind==='image'&&String(f.id)===String(d.item)):null;
 const images=section?gearImages(section):(folder?[folder]:[]);if(!images.length)return;
 gearViewer={thread:GEARTHREAD,images,index:Math.min(images.length-1,Math.max(0,Number(d.index)||0)),label:section?.label||'Coach folder image'};
 gearRenderViewer();
};
function gearRenderViewer(){
 const v=gearViewer;if(!v||v.thread!==GEARTHREAD)return;
 openDialog(`<section class="gear-image-viewer" aria-label="${esc(v.label)}"><div class="gear-image-toolbar"><h2>${esc(v.label)}</h2><span aria-live="polite">${v.index+1} / ${v.images.length}</span><button type="button" class="btn sm" data-act="gear-image-zoom" aria-pressed="false">Actual size</button><button type="button" class="btn sm" data-act="dlg-close" autofocus>Close</button></div><div class="gear-viewer-stage">${v.images.length>1?'<button type="button" class="btn gear-viewer-prev" data-act="gear-image-step" data-dir="-1" aria-label="Previous screenshot">‹</button>':''}<div class="gear-image-viewport" tabindex="0" aria-label="Screenshot — scroll to inspect when zoomed"><img src="${esc(v.images[v.index].image)}" alt="${esc(v.label)} — ${v.index+1}"></div>${v.images.length>1?'<button type="button" class="btn gear-viewer-next" data-act="gear-image-step" data-dir="1" aria-label="Next screenshot">›</button>':''}</div><div class="gear-viewer-thumbs">${v.images.length>1?v.images.map((im,i)=>`<button type="button" data-act="gear-image-select" data-index="${i}" aria-label="Show screenshot ${i+1}" aria-pressed="${v.index===i}"><img src="${esc(im.preview || im.image)}" alt="Screenshot ${i+1}"></button>`).join(''):''}</div></section>`,true);
 $('#dlg .gear-image-viewport')?.focus();
}
ACTIONS['gear-image-step']=(el,d)=>{if(!gearViewer||gearViewer.thread!==GEARTHREAD)return;gearViewer.index=(gearViewer.index+Number(d.dir)+gearViewer.images.length)%gearViewer.images.length;gearRenderViewer();};
ACTIONS['gear-image-select']=(el,d)=>{if(!gearViewer||gearViewer.thread!==GEARTHREAD)return;const i=Number(d.index);if(!Number.isInteger(i)||i<0||i>=gearViewer.images.length)return;gearViewer.index=i;gearRenderViewer();};
document.addEventListener('keydown',e=>{if(!$('#dlg')?.open||!e.target?.closest?.('.gear-image-viewer')||!['ArrowLeft','ArrowRight'].includes(e.key))return;if($('#dlg .gear-image-viewport img')?.classList.contains('actual-size'))return;e.preventDefault();ACTIONS['gear-image-step'](null,{dir:e.key==='ArrowLeft'?-1:1});});
let gearSwipe=null;
document.addEventListener('touchstart',e=>{gearSwipe=null;if(e.touches.length!==1||!e.target.closest?.('.gear-image-viewport')||$('#dlg .gear-image-viewport img')?.classList.contains('actual-size'))return;gearSwipe={x:e.touches[0].clientX,y:e.touches[0].clientY,viewer:gearViewer};},{passive:true});
document.addEventListener('touchend',e=>{const start=gearSwipe;gearSwipe=null;if(!start||start.viewer!==gearViewer||!$('#dlg')?.open)return;const touch=e.changedTouches[0],dx=touch.clientX-start.x,dy=touch.clientY-start.y;if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)ACTIONS['gear-image-step'](null,{dir:dx<0?1:-1});},{passive:true});
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
        <div>Drag and drop images here</div>
        <div class="muted small" style="margin-top:8px">or paste a screenshot with Ctrl+V (⌘+V on Mac)</div>
        <div class="muted small" style="margin:8px 0">or</div>
        <button type="button" class="btn primary" data-act="gear-dropzone-pick">Choose images</button>
        <input type="file" id="gear-dropzone-input" multiple accept="image/png,image/jpeg,image/gif,image/webp" class="hidden" data-act="gear-dropzone-file">
      </div>
    </div>
    <p id="gear-upload-status" class="muted small" role="status" aria-live="polite">PNG, JPEG, GIF or WebP · up to 6 MB</p>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-act="dlg-close">Cancel</button></div>`);
  const context=gearUploadContext={thread:GEARTHREAD,zone:document.getElementById('gear-dropzone'),busy:false};
  gearDropHandler=async input=>{
    const files=Array.isArray(input)?input:[input];
    if(!files.length||!files.every(gearValidImage))return;
    if(!gearUploadIsCurrent(context) || context.busy)return;
    context.busy=true;context.zone.setAttribute('aria-busy','true');
    const status=$('#gear-upload-status'),pick=document.getElementById('gear-dropzone-input');
    if(status)status.textContent='Uploading screenshot…';if(pick)pick.disabled=true;
    try{let uploaded=0;for(const file of files){if(!gearUploadIsCurrent(context))break;if(status)status.textContent=`Uploading ${uploaded+1} / ${files.length}…`;const ok=await onFile(file,context);if(!ok)break;uploaded++;}if(uploaded===files.length && gearUploadIsCurrent(context))closeDialog();else if(uploaded)toast(`${uploaded} of ${files.length} screenshots uploaded. Remaining images were not uploaded.`,true);}
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
CHANGES['gear-dropzone-file'] = (el) => { const files = [...el.files]; el.value=''; if (files.length && gearDropHandler) gearDropHandler(files); };
// Delegated so it survives every re-render of the dialog's contents, same reasoning as the chat list's
// scroll listener above - the actual .gear-dropzone element is destroyed and recreated each time openDialog runs.
document.addEventListener('dragover', (e) => { const z = e.target.closest && e.target.closest('.gear-dropzone'); if (z) { e.preventDefault(); z.classList.add('over'); } });
document.addEventListener('dragleave', (e) => { const z = e.target.closest && e.target.closest('.gear-dropzone'); if (z && (e.target === z || !z.contains(e.relatedTarget))) z.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  const z = e.target.closest && e.target.closest('.gear-dropzone'); if (!z) return;
  e.preventDefault(); z.classList.remove('over');
  const files = [...(e.dataTransfer.files || [])];
  if (files.length && gearDropHandler) gearDropHandler(files);
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
async function gearPreview(image){
 try{const img=new Image();img.src=image;await img.decode();const scale=Math.min(1,480/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',.78);return data.length<400000?data:undefined;}catch{return undefined;}
}
async function gearUploadScreenFile(sectionId, file,context) {
  if(!gearValidImage(file))return false;
  const thread=GEARTHREAD,id=thread.id,build=gearBuildKey();
  try{
    const image=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Could not read this image. Please try again.'));r.onabort=()=>reject(Error('Image reading was cancelled.'));r.readAsDataURL(file);});
    const preview=await gearPreview(image);
    if(!gearUploadIsCurrent(context))return false;
    const ok=await gearAct(()=>api(`/api/gearthreads/${id}/screens/${sectionId}`,'PUT',{image,preview,build,append:true}));
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
    ${gearPotentialsHtml(t)}
    <div class="panel geargear-screens"><div class="gear-panel-heading"><h2>Screenshots</h2><span class="muted small">Your current setup</span></div>${gearScreensHtml(t)}</div>
    <div class="panel geargear-chat"><div class="gear-panel-heading"><h2>Discussion</h2><span class="muted small">Talk through your build</span></div>${gearChatHtml(t, chat, chatHasMore, chatLoadingOlder)}</div>
    <div class="geargear-side gear-workspace-resources">
      <div class="panel"><div class="gear-panel-heading"><h2>Questlog</h2><span class="muted small">Build links</span></div>${gearQuestlogHtml(t)}</div>
      <div class="panel"><div class="gear-panel-heading"><h2>Coach folder</h2><span class="muted small">Notes and resources</span></div>${gearFolderHtml(t)}</div>
    </div>
  </div>`;
}

// Skill-core icons come from Questlog's CDN. If it can't be reached (offline server, blocked host, moved file) show a
// plain empty square instead of the browser's broken-image glyph.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.closest && t.closest('.gear-core-tile, .gear-core-detail-head')) t.classList.add('icon-missing');
}, true);

/* Potentials stay on the main thread; the accordion changes visibility, never pages. */
function gearCombinedSkillcoresHtml(t) {
 const skills={catalog:[],active:[],owned:[],...t.skillcores},lookup=new Map(skills.catalog.map(c=>[c.id,c]));
 const active=skills.active.map(id=>lookup.get(id)).filter(Boolean),unused=skills.owned.filter(id=>!skills.active.includes(id)).map(id=>lookup.get(id)).filter(Boolean);
 const ownedKey='gear-owned-cores:'+gearTopicKey(t);let ownedOpen=false;try{ownedOpen=localStorage.getItem(ownedKey)==='open';}catch{}
 const position=(slot,index)=>{const core=active.filter(c=>c.slot===slot)[index];return `<div class="gear-core-position"><span class="muted small">${slot==='weapon'?'Weapon core · 1 slot':'Armor / accessory core · slot '+(index+1)}</span>${core?gearCoreTile(core):`<button type="button" class="gear-core-tile" data-act="gear-core-picker">+ Choose a skill core</button>`}</div>`;};
 return `<section class="gear-combined-cores"><div class="gear-panel-heading"><h2>Active skill cores</h2><span class="muted small">${active.length}/3 active · 1 weapon + 2 armor / accessories</span></div><div class="gear-combined-core-grid">${position('weapon',0)}${position('equipment',0)}${position('equipment',1)}</div><details class="gear-core-owned-dropdown" data-potential-key="${esc(ownedKey)}" ${ownedOpen?'open':''}><summary>Other owned skill cores (${unused.length})</summary><div class="gear-combined-owned-list">${unused.map(gearCoreTile).join('') || '<span class="muted small">No additional cores in your collection.</span>'}</div></details><div class="gear-combined-core-footer"><span class="muted small">${skills.owned.length} owned · shared across builds</span><button type="button" class="btn sm" data-act="gear-core-picker">+ Add skill cores</button></div></section>`;
}
const gearPotentialIcons = {
 head:'<path d="M8 31V15l12-9 12 9v16l-8 4h-8Z M20 7v28 M9 19l8 4m14-4-8 4"/>',
 cloak:'<path d="m14 7 6-3 6 3 3 10 7 18H4l7-18Z M14 7l6 8 6-8 M20 15v20"/>',
 chest:'<path d="m13 5-9 8 5 9 4-3-2 16h18l-2-16 4 3 5-9-9-8-7 5Z M20 10v22"/>',
 hands:'<path d="m10 7 13-2 3 13 8 9-6 9-17-7-4-12Z M10 13l15-2m-16 9 17-2m-14 8 17-2"/>',
 legs:'<path d="M10 5h20l-1 14 4 17H22l-2-16-2 16H7l4-17Z M10 11h20"/>',
 feet:'<path d="M13 5h15l-1 19 7 7v5H7v-8l6-8Z M12 17h15M9 30h22"/>',
 necklace:'<path d="M8 6c-1 13 2 20 12 22C30 26 33 19 32 6 M20 23l6 8-6 7-6-7Z"/>',
 bracelet:'<ellipse cx="20" cy="20" rx="15" ry="10"/><path d="M5 20v7c8 9 22 9 30 0v-7 M16 11l4-5 4 5-4 6Z"/>',
 ring1:'<circle cx="20" cy="23" r="12"/><path d="m14 9 6-6 6 6-6 7Z"/>',
 ring2:'<circle cx="20" cy="23" r="12"/><path d="m14 9 6-6 6 6-6 7Z"/>',
 belt:'<path d="M3 14h34v14H3Z M15 11h10v20H15Z M19 20h11"/>',
 weapon1:'<path d="m12 5 4 9-1 18-4 4-4-4-1-18Z M3 21h16 M23 14l7-5 7 5v12l-7 9-7-9Z"/>',
 weapon2:'<path d="m31 4 5 5-18 21-6-6Z M8 22l12 12 M11 29l-6 7 M3 33l5 5"/>'
};
function gearPotentialIcon(slot) {
 return `<svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${gearPotentialIcons[slot] || gearPotentialIcons.chest}</svg>`;
}
function gearPotentialCompatible(e,slot,p) {
 const ws=p.weapons;
 return (e.mainCategory==='universal' || e.mainCategory===slot.category) && (!e.weapons.length || e.weapons.some(w=>ws.includes(w)));
}
function gearPotentialsHtml(t) {
 const p=t.potentials;if(!p)return '';
 const lookup=new Map(p.catalog.map(e=>[e.id,e]));
 const count=p.slots.filter(s=>(p.assignments[s.id] || []).length).length;
 const key='gear-potentials:'+gearTopicKey(t);
 let open=true;try{open=localStorage.getItem(key)!=='closed';}catch{}
 const button=s=>{const ids=p.assignments[s.id] || [],w=s.id==='weapon1'?p.weapons[0]:s.id==='weapon2'?p.weapons[1]:'';return `<button type="button" class="gear-potential-slot slot-${s.id} ${ids.length?'is-assigned':''}" data-act="gear-potential-open" data-slot="${s.id}" aria-label="${esc(s.label+(w?' · '+w:'')+' · '+ids.length+' assigned potentials')}"><span>${esc(s.label)}</span>${s.category==='weapon' && w?weaponIcon(w):gearPotentialIcon(s.id)}${w?`<small>${esc(w)}</small>`:''}<small class="gear-potential-slot-count">${p.legacyAssignments?.[s.id]?.length?'Review':ids.length?'Assigned':'Assign'}</small></button>`;};
 return `<details class="panel gear-potentials" data-potential-key="${esc(key)}" ${open?'open':''}><summary><span class="gear-potential-title">Potentials</span><span class="muted small">${count} / ${p.slots.length} slots assigned</span><span class="gear-potential-chevron" aria-hidden="true">›</span></summary>${gearCombinedSkillcoresHtml(t)}<div class="gear-potentials-body"><section class="gear-equipment"><h2>Equipment</h2><p class="muted small">Select a slot to edit its potentials.</p><div class="gear-equipment-map"><img class="gear-potential-body" src="/assets/potential-body.svg" alt="Armored equipment mannequin">${p.slots.filter(s=>s.category!=='accessory').map(button).join('')}</div><div class="gear-potential-accessories">${p.slots.filter(s=>s.category==='accessory').map(button).join('')}</div></section><section class="gear-potential-overview"><h2>Assigned potentials</h2><p class="muted small">Every slot in this build, at a glance.</p><div class="gear-potential-summary-grid">${p.slots.map(s=>{const ids=p.assignments[s.id] || [];return `<button type="button" class="gear-potential-summary" data-act="gear-potential-open" data-slot="${s.id}" aria-label="${esc('Edit '+s.label+' potentials')}"><span class="gear-potential-summary-icon">${gearPotentialIcon(s.id)}</span><span class="gear-potential-summary-content"><span class="muted small">${esc(s.label)}</span>${p.legacyAssignments?.[s.id]?.length?'<span class="small gear-potential-warning">Previous selections need review. Choose one potential.</span>':ids.length?ids.map(id=>{const e=lookup.get(id);return `<span class="gear-potential-assignment"><strong>${esc(e?.name || 'Unavailable potential')}</strong><span class="small muted">${esc(e?.description || 'Remove this assignment and select an available potential.')}</span>${e && !gearPotentialCompatible(e,s,p)?'<span class="small gear-potential-warning">Review: build weapons changed</span>':''}</span>`;}).join(''):'<span class="muted small">Unassigned</span>'}</span><span class="gear-potential-edit" aria-hidden="true">✎</span></button>`;}).join('')}</div></section></div></details>`;
}
document.addEventListener('toggle',event=>{
 const key=event.target?.dataset?.potentialKey;if(!key)return;
 try{localStorage.setItem(key,event.target.open?'open':'closed');}catch{}
},true);
let gearPotentialDialog=null,gearPotentialSaving=false;
ACTIONS['gear-potential-open']=(el,d)=>{
 const thread=GEARTHREAD,t=thread.data,p=t?.potentials,slot=p?.slots.find(s=>s.id===d.slot);if(!slot)return;
 gearPotentialDialog={thread,t,slot:slot.id,revision:p.revision};
 const selected=new Set(p.assignments[slot.id] || []),legacy=p.legacyAssignments?.[slot.id] || [];
 const available=p.catalog.filter(e=>gearPotentialCompatible(e,slot,p) || selected.has(e.id) || legacy.includes(e.id));
 const emptyWeapon=slot.category==='weapon' && !p.weapons[slot.id==='weapon1'?0:1];
 openDialog(`<form data-form="gear-potentials-save" class="gear-potential-picker"><h2>${esc(slot.label)} potentials</h2><p class="muted small">Choose one potential for this item, or leave it unassigned. Changes apply to this build only.</p>${emptyWeapon?'<p class="gear-potential-warning">Set this build weapon before assigning potentials.</p>':''}<label class="gear-potential-search">Search potentials<input type="search" data-potential-search placeholder="Search name or effect…" aria-label="Search potentials"></label><p class="muted small">Potentials from both build weapons are available on either weapon slot. Check your item for exact roll eligibility.</p>${legacy.length?'<p class="gear-potential-warning">Previous multiple selections are saved for review. Choose one potential to equip.</p>':''}<label class="gear-potential-option"><input type="radio" name="potential" value="" ${!selected.size?'checked':''}><span><strong>No potential</strong><span class="muted small">Leave this item unassigned.</span></span></label><div class="gear-potential-options">${available.map(e=>{const compatible=gearPotentialCompatible(e,slot,p);return `<label class="gear-potential-option" data-potential-text="${esc((e.name+' '+e.description).toLowerCase())}"><input type="radio" name="potential" value="${esc(e.id)}" ${selected.has(e.id)?'checked':''} ${emptyWeapon && !selected.has(e.id)?'disabled':''}><span class="gear-potential-option-icon">${gearPotentialIcon(slot.id)}${e.iconUrl?`<img src="${esc(e.iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true">`:''}</span><span><strong>${esc(e.name)}</strong><span class="muted small">${esc(e.description)}</span>${!compatible?'<span class="gear-potential-warning small">No longer matches this build; deselect to remove.</span>':''}</span></label>`;}).join('')}</div><p class="muted small" data-potential-empty hidden>No matching potentials.</p><div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save potentials</button></div></form>`,true);
};
document.addEventListener('input',event=>{
 if(!event.target?.matches?.('[data-potential-search]'))return;
 const form=event.target.closest('form'),q=event.target.value.trim().toLowerCase();let visible=0;
 form.querySelectorAll('[data-potential-text]').forEach(row=>{row.hidden=!row.dataset.potentialText.includes(q);if(!row.hidden)visible++;});
 form.querySelector('[data-potential-empty]').hidden=visible>0;
});
FORMS['gear-potentials-save']=async f=>{
 const c=gearPotentialDialog;if(gearPotentialSaving || !c)return;
 if(GEARTHREAD!==c.thread || GEARTHREAD.data!==c.t){toast('This build changed. Reopen the slot to edit it.',true);return;}
 const ids=[...f.querySelectorAll('input[name="potential"]:checked')].map(el=>el.value).filter(Boolean);
 if(ids.length>1){toast('Each equipment item can have at most one potential.',true);return;}
 const submit=f.querySelector('button[type="submit"],button:not([type])');if(submit)submit.disabled=true;
 gearPotentialSaving=true;
 try {
  const ok=await gearAct(()=>api(`/api/gearthreads/${c.t.memberId}/potentials`,'PUT',{build:c.t.buildKey || 'main',slot:c.slot,ids,revision:c.revision}));
  if(ok && GEARTHREAD===c.thread && gearPotentialDialog===c && $('#dlg')?.contains(f)){closeDialog();toast('Potentials saved');}
 }finally{gearPotentialSaving=false;if(submit)submit.disabled=false;}
};
