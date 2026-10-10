/* Shotcaller control panel: a live view onto a separate, self-hosted Discord bot's voice session (mute, stop,
   dedicated/extra callers). Officer-only. This sits on top of app.js/features.js the same way features.js sits
   on top of app.js - same globals (VIEWS, ACTIONS, FORMS, S, UI, $, esc, api, act, toast, openDialog, closeDialog,
   AFTER_RENDER, route, render, isOfficer, playerPickerFor).

   Everything here only reads/writes through /api/shotcaller/* and /api/admin/shotcaller, which the server
   proxies to the bot's own HTTP API (see server-shotcaller.js) - this file holds no session state beyond the
   last poll's answer, in SC below. A session can be started either from the Start dialog here (scStartDialog,
   which hits the bot's /voice-channels and /session/start routes) or with /shotcaller start in Discord - both
   land on the same bot-side Session, so either one shows up here the moment it's running. */

let SC = { loading: true, data: null, error: '' };
let scTimer = null, scActive = false;
// Set true the instant the Start form submits (before the request even goes out) and cleared once the bot
// answers - starting can legitimately take a while (relay bots log in and join one party at a time; see the
// scaling timeout in server-shotcaller.js), so the page shows this instead of the plain "Inactive" state for
// that whole stretch, rather than leaving the dialog open and looking stuck. Persists across a 5s poll tick
// (viewShotcaller checks it before SC.data.active) since the session genuinely isn't active yet partway
// through starting.
let scStarting = false;

async function pollShotcaller() {
  try { SC = { loading: false, data: await api('/api/shotcaller/status'), error: '' }; }
  catch (e) { SC = { loading: false, data: null, error: e.message }; }
  if (route().page === 'shotcaller' && !$('#dlg').open) render();
}
// Starts polling every 5s while the Shotcaller page is open (active or inactive, so a /shotcaller command run
// directly in Discord is picked up here too), and stops the moment the officer navigates elsewhere. Guarded by
// scActive so this only fires once per visit, not on every render while already there - pollShotcaller()'s own
// render() call would otherwise retrigger this same hook and turn the 5s interval into a tight loop.
AFTER_RENDER.push((page) => {
  if (page !== 'shotcaller') { clearInterval(scTimer); scTimer = null; scActive = false; return; }
  if (scActive) return;
  scActive = true;
  SC = { loading: true, data: null, error: '' };
  pollShotcaller();
  scTimer = setInterval(pollShotcaller, 5000);
});
// Same pattern as act(), but refreshes the Shotcaller poll instead of the whole app's /api/state - the two are
// unrelated, and there is no reason a mute/stop/caller change should wait on or trigger the bigger refresh.
async function scAct(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await pollShotcaller(); return true; }
  catch (e) { toast(e.message, true); return false; }
}

const scName = (id) => { const u = (S.users || []).find((x) => x.id === id); return u ? u.name : id; };
// A picker scoped to the Admin-curated candidate list (Admin > Shotcaller), not the whole roster - dedicated
// and extra callers are both drawn from the same shortlist.
function candidatePickerFor(name, selected = []) {
  const list = (S.settings.shotcaller.candidateUserIds || []).map((id) => ({ key: id, name: scName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="pp"><input type="search" class="pp-filter" placeholder="Search callers" aria-label="Search callers"><div class="scrollbox">${
    list.map((p) => `<label class="tagpick" data-n="${esc(p.name.toLowerCase())}"><input type="checkbox" name="${name}" value="${esc(p.key)}" ${selected.includes(p.key) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')
    || '<span class="muted small">No candidates yet - add some in Admin &gt; Shotcaller.</span>'
  }</div></div>`;
}
const scChip = (id, removeAct) => `<span class="chip">${esc(scName(id))} <span style="opacity:.6;cursor:pointer" data-act="${removeAct}" data-id="${esc(id)}"> ✕</span></span>`;

function viewShotcaller() {
  if (!isOfficer()) return '<div class="empty">Officers only.</div>';
  if (!S.cfg.shotcallerOn) return `<div class="page-head"><div><h1>Shotcaller</h1></div></div>
    <div class="panel"><div class="muted">Shotcaller is not set up on this server yet. Set <code>SHOTCALLER_URL</code> and <code>SHOTCALLER_API_KEY</code> in the server's environment to turn this page on.</div></div>`;
  if (SC.loading) return '<div class="page-head"><div><h1>Shotcaller</h1></div></div><div class="panel"><div class="muted">Loading…</div></div>';
  if (SC.error) return `<div class="page-head"><div><h1>Shotcaller</h1></div></div><div class="panel"><div class="warn-line">${esc(SC.error)}</div></div>`;
  if (scStarting) return scStartingPage();
  return SC.data.active ? scActivePage(SC.data) : scInactivePage();
}
VIEWS.shotcaller = () => viewShotcaller();

function scActivePage(d) {
  const connected = d.parties.reduce((n, p) => n + (p.connected || 0), 0);
  return `<div class="page-head"><div><h1>Shotcaller</h1><div class="muted">Live control for the active voice session. A new one can also be started with <code>/shotcaller start</code> in Discord.</div></div></div>

  <div class="stats">
    <div class="stat"><div class="k">Session</div><div class="v" style="font-size:28px">🟢 Active</div></div>
    <div class="stat" ${d.muted ? 'style="--c:#eba23c"' : ''}><div class="k">Audio</div><div class="v" style="font-size:28px">${d.muted ? '🔇 Muted' : '🔊 On'}</div></div>
    <div class="stat"><div class="k">Parties</div><div class="v">${d.parties.length}</div></div>
    <div class="stat"><div class="k">Players connected</div><div class="v">${connected}</div></div>
  </div>

  <div class="events-layout">
    <div class="cal">
      <div class="panel"><h3>Parties</h3>
        <div class="parties" style="margin-top:12px">${d.parties.map((p) => `
          <div class="panel" style="margin:0;padding:14px${p.connected ? '' : ';opacity:.6'}">
            <div style="display:flex;justify-content:space-between;align-items:center"><strong>${esc(p.name)}</strong></div>
            <div class="muted small" style="margin-top:6px">${p.connected ? '🔊' : '⚪'} ${p.connected} connected</div>
          </div>`).join('') || '<div class="muted small">No parties.</div>'}
        </div>
      </div>
    </div>

    <aside class="ev-side">
      <div class="panel"><h3>Controls</h3>
        <div class="seg" style="margin-top:10px">
          <button class="btn sm" data-act="sc-mute">${d.muted ? '🔊 Unmute' : '🔇 Mute'}</button>
          <button class="btn sm danger" data-act="sc-stop">■ Stop session</button>
        </div>
        ${d.muted ? '<div class="muted small" style="margin-top:8px">Audio is muted - nobody hears the dedicated caller or any callouts right now. Parties can still talk to each other locally in Discord as normal.</div>' : ''}
      </div>

      <div class="panel"><h3>Dedicated caller</h3>
        <div class="muted small" style="margin:8px 0">Heard by every other party, wherever they're standing.</div>
        <div class="seg">${d.dedicated.length ? d.dedicated.map((id) => scChip(id, 'sc-dedicated-remove')).join('') : '<span class="muted small">No caller selected</span>'}</div>
        <button class="btn sm" style="margin-top:10px" data-act="sc-dedicated-manage">Manage dedicated caller(s)</button>
      </div>

      <div class="panel"><h3>Extra callers</h3>
        <div class="muted small" style="margin:8px 0">On top of anyone with the configured caller role.</div>
        <div class="seg">${d.additionalCallers.length ? d.additionalCallers.map((id) => scChip(id, 'sc-extra-remove')).join('') : '<span class="muted small">None set</span>'}</div>
        <button class="btn sm" style="margin-top:10px" data-act="sc-extra-manage">Manage extra callers</button>
      </div>

      <div class="panel" style="opacity:.55"><h3>Bridge</h3>
        <div class="muted small" style="margin-top:8px">Cross-guild bridge control is coming in a future update.</div>
      </div>
    </aside>
  </div>`;
}

function scStartingPage() {
  return `<div class="page-head"><div><h1>Shotcaller</h1><div class="muted">Starting the session - this can take up to a minute while voice channels are created and the relay bots connect.</div></div></div>

  <div class="stats">
    <div class="stat" style="--c:#eba23c"><div class="k">Session</div><div class="v" style="font-size:28px">🟡 Starting…</div></div>
    <div class="stat" style="--c:var(--muted)"><div class="k">Audio</div><div class="v" style="font-size:28px">—</div></div>
    <div class="stat"><div class="k">Parties</div><div class="v">—</div></div>
    <div class="stat"><div class="k">Players connected</div><div class="v">—</div></div>
  </div>

  <div class="events-layout">
    <div class="cal">
      <div class="panel"><h3>Parties</h3>
        <div style="margin-top:12px;padding:40px 20px;text-align:center;border:1px dashed var(--line);border-radius:8px">
          <strong class="muted" style="font-size:17px">Setting up voice channels…</strong>
        </div>
      </div>
    </div>

    <aside class="ev-side">
      <div class="panel"><h3>Controls</h3>
        <div class="seg" style="margin-top:10px"><button class="btn sm" disabled>▶ Starting…</button></div>
      </div>
    </aside>
  </div>`;
}

function scInactivePage() {
  return `<div class="page-head"><div><h1>Shotcaller</h1><div class="muted">Live control for the active voice session. A new one can also be started with <code>/shotcaller start</code> in Discord.</div></div></div>

  <div class="stats">
    <div class="stat" style="--c:var(--muted)"><div class="k">Session</div><div class="v" style="font-size:28px">⚪ Inactive</div></div>
    <div class="stat" style="--c:var(--muted)"><div class="k">Audio</div><div class="v" style="font-size:28px">🔇 Off</div></div>
    <div class="stat"><div class="k">Parties</div><div class="v">—</div></div>
    <div class="stat"><div class="k">Players connected</div><div class="v">—</div></div>
  </div>

  <div class="events-layout">
    <div class="cal">
      <div class="panel"><h3>Parties</h3>
        <div style="margin-top:12px;padding:40px 20px;text-align:center;border:1px dashed var(--line);border-radius:8px">
          <strong style="color:var(--danger);font-size:17px">No voice channels created</strong>
        </div>
      </div>
    </div>

    <aside class="ev-side">
      <div class="panel"><h3>Controls</h3>
        <div class="seg" style="margin-top:10px"><button class="btn sm" style="background:#6fcf8b;border-color:#6fcf8b;color:#0d1f14" data-act="sc-start">▶ Start session</button></div>
      </div>

      <div class="panel"><h3>Dedicated caller</h3>
        <div class="muted small" style="margin:8px 0">Heard by every other party, wherever they're standing.</div>
        <div class="seg"><span class="muted small">No caller selected</span></div>
        <button class="btn sm" style="margin-top:10px" data-act="sc-dedicated-manage">Manage dedicated caller(s)</button>
      </div>

      <div class="panel"><h3>Extra callers</h3>
        <div class="muted small" style="margin:8px 0">On top of anyone with the configured caller role.</div>
        <div class="seg"><span class="muted small">None set</span></div>
        <button class="btn sm" style="margin-top:10px" data-act="sc-extra-manage">Manage extra callers</button>
      </div>

      <div class="panel" style="opacity:.55"><h3>Bridge</h3>
        <div class="muted small" style="margin-top:8px">Cross-guild bridge control is coming in a future update.</div>
      </div>
    </aside>
  </div>`;
}

/* ---------------------------------------------------------------- actions */
ACTIONS['sc-mute'] = () => {
  if (!SC.data) return;
  const next = !SC.data.muted;
  SC.data.muted = next; render();                                      // optimistic, same idea as rsvpNow()
  api('/api/shotcaller/mute', 'POST', { muted: next })
    .then((r) => { if (SC.data) SC.data.muted = r.muted; render(); })
    .catch((e) => { if (SC.data) SC.data.muted = !next; render(); toast(e.message, true); });
};
ACTIONS['sc-stop'] = () => {
  if (!confirm('Stop this Shotcaller session? The relay bots and dedicated caller will disconnect from voice. Party channels stay up until everyone leaves them.')) return;
  scAct(() => api('/api/shotcaller/stop', 'POST'), 'Shotcaller session stopped');
};
// Start dialog: ported from the approved mockup (voice channel / mode / voice-channel-setup / dedicated caller).
// Needs the bot's live voice-channel list, so it's fetched first - the dialog only opens once that answers.
async function scStartDialog() {
  let channels;
  try { channels = (await api('/api/shotcaller/voice-channels')).channels || []; }
  catch (e) { toast(e.message, true); return; }
  if (!channels.length) return toast('No voice channels found in that Discord server.', true);
  const last = SC.data && SC.data.lastVoiceChannel;
  const lastId = last && channels.some((c) => c.id === last.channelId) ? last.channelId : channels[0].id;
  const st = S.settings.shotcaller;
  const candidates = (st.candidateUserIds || []).map((id) => ({ key: id, name: scName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  // Only events/presets that actually have parties to match are worth offering here.
  const upcomingEvents = S.events.filter((e) => e.parties.length && new Date(e.start) >= Date.now() - 3 * 36e5).sort((a, b) => new Date(a.start) - new Date(b.start));
  const presetsWithParties = S.presets.filter((p) => p.parties.length);
  openDialog(`<form data-form="shotcaller-start"><h2>Start Shotcaller session</h2>
    <div class="field"><label>Voice channel (becomes Party 1 - yours)</label>
      <select name="channelId">${channels.map((c) => `<option value="${esc(c.id)}" ${c.id === lastId ? 'selected' : ''}>🔊 ${esc(c.name)}${last && c.id === last.channelId ? ' (last used)' : ''}</option>`).join('')}</select></div>
    <div class="row">
      <div class="field"><label>Mode</label>
        <select name="mode" data-act="sc-mode" id="sc-mode">
          <option value="8" selected>GvG - 8 parties</option>
          <option value="12">Full Guild - 12 parties</option>
          <option value="custom">Custom - 1 to 12</option>
        </select></div>
      <div class="field hidden" id="sc-custom"><label>Number of parties (1-12)</label><input type="number" name="customCount" min="1" max="12" value="8"></div>
    </div>
    <div class="muted small hidden" id="sc-mode-note" style="margin-top:-6px;margin-bottom:12px"></div>
    <div class="field"><label>Voice channel setup</label>
      <select name="setupKind" data-act="sc-setup" id="sc-setup">
        <option value="default" selected>Default - plain Party 1-N</option>
        ${upcomingEvents.length ? '<option value="event">Event-related parties - match an event\'s line-up</option>' : ''}
        ${presetsWithParties.length ? '<option value="preset">Use preset - match a saved line-up</option>' : ''}
      </select></div>
    <div class="field hidden" id="sc-setup-event"><label>Event</label>
      <select name="eventId">${upcomingEvents.map((e) => { const n = 1 + e.parties.slice(1).filter((p) => !partyIsPlaceholder(p)).length; return `<option value="${e.id}">${esc(e.title)} - ${fmtShort(e.start)} (${n} ${n === 1 ? 'party' : 'parties'}${n !== e.parties.length ? `, ${e.parties.length - n} placeholder` : ''})</option>`; }).join('')}</select>
      <div class="muted small" style="margin-top:6px">Party count comes from this event's non-placeholder parties, and the channels Shotcaller creates are renamed to match its party leaders.</div></div>
    <div class="field hidden" id="sc-setup-preset"><label>Preset</label>
      <select name="presetId">${presetsWithParties.map((p) => { const n = 1 + p.parties.slice(1).filter((x) => !partyIsPlaceholder(x)).length; return `<option value="${p.id}">${esc(p.name)} (${n} ${n === 1 ? 'party' : 'parties'}${n !== p.parties.length ? `, ${p.parties.length - n} placeholder` : ''})</option>`; }).join('')}</select>
      <div class="muted small" style="margin-top:6px">Party count comes from this preset's non-placeholder parties, and the channels Shotcaller creates are renamed to match its party leaders.</div></div>
    <div class="field"><label>Shotcaller</label>
      <select name="dedicatedCallerId">
        <option value="">No dedicated caller - anyone can call out</option>
        ${candidates.map((c) => `<option value="${esc(c.key)}" ${c.key === st.defaultCallerId ? 'selected' : ''}>${esc(c.name)}${c.key === st.defaultCallerId ? ' (default)' : ''}</option>`).join('')}
      </select>
      <div class="muted small" style="margin-top:6px">Defaults to whoever's set as the default caller in Admin - not necessarily you. Pick someone else here just for this session, or set a new default in Admin.</div></div>
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button>
      <button class="btn" style="background:#6fcf8b;color:#0d1f14;border-color:#6fcf8b;font-weight:600">Start session</button></div>
  </form>`);
}
ACTIONS['sc-start'] = () => scStartDialog();
CHANGES['sc-mode'] = (el) => { $('#sc-custom').classList.toggle('hidden', el.value !== 'custom'); };
CHANGES['sc-setup'] = (el) => {
  const overridden = el.value !== 'default';
  $('#sc-setup-event').classList.toggle('hidden', el.value !== 'event');
  $('#sc-setup-preset').classList.toggle('hidden', el.value !== 'preset');
  const modeSel = $('#sc-mode'), note = $('#sc-mode-note'), customInput = $('#sc-custom input');
  modeSel.disabled = overridden;
  if (customInput) customInput.disabled = overridden;
  note.classList.toggle('hidden', !overridden);
  note.textContent = overridden ? `Party count is set by the ${el.value === 'event' ? 'chosen event' : 'chosen preset'} above, not by Mode.` : '';
};
FORMS['shotcaller-start'] = (f, fd) => {
  let count, partyNames = [];
  if (fd.setupKind === 'event' || fd.setupKind === 'preset') {
    const chosen = fd.setupKind === 'event' ? byId(S.events, fd.eventId) : byId(S.presets, fd.presetId);
    if (!chosen || !chosen.parties.length) return toast('Pick a valid event or preset.', true);
    // channels[0] is always the picked voice channel above (Party 1) and is never renamed - it's an existing
    // channel you chose yourself, not one Shotcaller creates, so it always counts regardless of its own
    // placeholder status. Placeholder parties after that are skipped entirely - no voice channel for them, and
    // they don't count toward the 12-party cap - same rule the combined Post-to-Discord+Start flow uses
    // (server-community.js). partyNames[0] names channels[1] (Party 2), and so on, matching the bot's own
    // /start endpoint indexing.
    const realRest = chosen.parties.slice(1).filter((p) => !partyIsPlaceholder(p));
    if (1 + realRest.length > 12) return toast(`"${chosen.title || chosen.name}" has ${1 + realRest.length} non-placeholder parties - Shotcaller supports at most 12.`, true);
    count = 1 + realRest.length;
    partyNames = realRest.map((p) => { const ld = p.leader ? byId(S.members, p.leader) : null; return ld ? `${ld.name}'s Party` : null; });
  } else {
    count = fd.mode === 'custom' ? Math.round(Number(fd.customCount)) : Number(fd.mode);
  }
  if (!Number.isInteger(count) || count < 1 || count > 12) return toast('Pick a party count from 1 to 12.', true);
  // Starting can legitimately take a while, more so with more parties (server-shotcaller.js scales its own
  // patience with the count) - rather than leaving the dialog open and looking stuck for that whole stretch,
  // close it immediately and switch the page itself into a "starting" state (scStartingPage) until the bot
  // answers, same as any other long-running background request here.
  closeDialog();
  scStarting = true;
  render();
  (async () => {
    try {
      await api('/api/shotcaller/start', 'POST', { channelId: fd.channelId, count, partyNames, dedicatedCallerId: fd.dedicatedCallerId || null });
      toast('Shotcaller session started');
    } catch (e) {
      toast(e.message, true);
    } finally {
      scStarting = false;
      await pollShotcaller();
    }
  })();
};

ACTIONS['sc-dedicated-manage'] = () => {
  const sel = (SC.data && SC.data.dedicated) || [];
  openDialog(`<form data-form="sc-dedicated"><h2>Manage dedicated caller(s)</h2>
    <div class="muted small" style="margin:-4px 0 10px">Heard by every other party, wherever they're standing. Candidates are set in Admin &gt; Shotcaller.</div>
    ${candidatePickerFor('scded', sel)}
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div></form>`);
};
FORMS['sc-dedicated'] = (f) => {
  const ids = [...f.querySelectorAll('input[name=scded]:checked')].map((i) => i.value);
  scAct(async () => { await api('/api/shotcaller/dedicated', 'POST', { userIds: ids }); closeDialog(); }, 'Dedicated caller(s) updated');
};
ACTIONS['sc-dedicated-remove'] = (el, d) => scAct(() => api('/api/shotcaller/dedicated', 'POST', { userIds: (SC.data.dedicated || []).filter((id) => id !== d.id) }), 'Removed');

ACTIONS['sc-extra-manage'] = () => {
  const sel = (SC.data && SC.data.additionalCallers) || [];
  openDialog(`<form data-form="sc-extra"><h2>Manage extra callers</h2>
    <div class="muted small" style="margin:-4px 0 10px">On top of anyone with the configured caller role. Candidates are set in Admin &gt; Shotcaller.</div>
    ${candidatePickerFor('scext', sel)}
    <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button class="btn primary">Save</button></div></form>`);
};
FORMS['sc-extra'] = (f) => {
  const ids = [...f.querySelectorAll('input[name=scext]:checked')].map((i) => i.value);
  scAct(async () => { await api('/api/shotcaller/additional-callers', 'POST', { userIds: ids }); closeDialog(); }, 'Extra callers updated');
};
ACTIONS['sc-extra-remove'] = (el, d) => scAct(() => api('/api/shotcaller/additional-callers', 'POST', { userIds: (SC.data.additionalCallers || []).filter((id) => id !== d.id) }), 'Removed');

/* ---------------------------------------------------------------- Admin: who can be picked as a caller */
function shotcallerAdmin() {
  const st = S.settings.shotcaller, ids = st.candidateUserIds || [];
  return `<div class="panel"><h3>Shotcaller</h3>
    <div class="muted small" style="margin:-6px 0 10px">Who can be picked as the dedicated or extra caller(s) on the Shotcaller page. Only players picked here show up there.</div>
    <form data-form="shotcaller-callers">
      <label><b>Possible callers</b></label>
      <div class="muted small" style="margin:2px 0 6px">Only players who have signed in before can be picked.</div>
      ${playerPickerFor('sccaller', ids)}
      <label style="margin-top:14px;display:block"><b>Default caller</b></label>
      <div class="muted small" style="margin:2px 0 6px">Pre-selected on the Shotcaller page's Start dialog - whoever starts a session there can still pick someone else, or nobody, just for that session.</div>
      <select name="scdefault" id="sc-default-select">
        <option value="">No default</option>
        ${ids.map((id) => `<option value="${esc(id)}" ${id === st.defaultCallerId ? 'selected' : ''}>${esc(scName(id))}</option>`).join('')}
      </select>
      <button class="btn primary" style="margin-top:14px">Save</button>
    </form>
  </div>`;
}
FORMS['shotcaller-callers'] = (f) => act(() => api('/api/admin/shotcaller', 'PUT', {
  candidateUserIds: [...f.querySelectorAll('input[name=sccaller]:checked')].map((i) => i.value),
  defaultCallerId: f.elements.scdefault.value,
}), 'Saved');
