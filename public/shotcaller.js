/* Shotcaller control panel: a live view onto a separate, self-hosted Discord bot's voice session (mute, stop,
   dedicated/extra callers). Officer-only. This sits on top of app.js/features.js the same way features.js sits
   on top of app.js - same globals (VIEWS, ACTIONS, FORMS, S, UI, $, esc, api, act, toast, openDialog, closeDialog,
   AFTER_RENDER, route, render, isOfficer, playerPickerFor).

   Everything here only reads/writes through /api/shotcaller/* and /api/admin/shotcaller, which the server
   proxies to the bot's own HTTP API (see server-shotcaller.js) - this file holds no session state beyond the
   last poll's answer, in SC below. A session can be started either from the Start dialog here (scStartDialog,
   which hits the bot's /voice-channels and /session/start routes) or with /shotcaller start in Discord - both
   land on the same bot-side Session, so either one shows up here the moment it's running. */

let SC = { loading: true, data: null, error: '', receivedAt:null, requestMs:null };
let scStatusEvents=[];
function scObserve(previous,next) {
 const add=message=>scStatusEvents.unshift({at:new Date().toISOString(),message});
 if(next.error && next.error!==previous.error)add('Control API request failed.');
 if(!next.error && (previous.error || !previous.receivedAt))add('Control API responded.');
 if(next.data && !next.error && previous.data){if(!!next.data.active!==!!previous.data.active)add(next.data.active?'Session became active.':'Session ended.');if(next.data.active && next.data.muted!==previous.data.muted)add(next.data.muted?'Session audio muted.':'Session audio unmuted.');
 const old=previous.data.diagnostics?.relays || [];for(const r of next.data.diagnostics?.relays || []){const before=old.find(x=>x.index===r.index);if(before && before.voiceState!==r.voiceState)add('Relay '+r.index+' voice state: '+(r.voiceState || 'not reported')+'.');}}
 scStatusEvents=scStatusEvents.slice(0,12);
}
let scTimer = null, scActive = false;
// Set true the instant the Start form submits (before the request even goes out) and cleared once the bot
// answers - starting can legitimately take a while (relay bots log in and join one party at a time; see the
// scaling timeout in server-shotcaller.js), so the page shows this instead of the plain "Inactive" state for
// that whole stretch, rather than leaving the dialog open and looking stuck. Persists across a 5s poll tick
// (viewShotcaller checks it before SC.data.active) since the session genuinely isn't active yet partway
// through starting.
let scStarting = false;

let scPollSerial=0;
async function pollShotcaller() {
  const serial=++scPollSerial;
  const previous=SC,start=Date.now();
  try { const data=await api('/api/shotcaller/status');if(serial!==scPollSerial)return;SC={loading:false,data,error:'',receivedAt:new Date().toISOString(),requestMs:Date.now()-start}; }
  catch (e) { if(serial!==scPollSerial)return;SC={...SC,loading:false,error:e.message}; }
  scObserve(previous,SC);
  const editingSetup=UI.scTab==='setup' && document.querySelector('.sc-setup-panel .sc-start-form');
  if (route().page === 'shotcaller' && !$('#dlg').open && !editingSetup) render();
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

let scMutePending = null, scStopping = false, scSetupLoading = false, scSetupChannels = null, scStartLoading = false;
function scPageHeader() {
 return `<header class="page-head"><div><div class="sc-eyebrow">GUILD VOICE · FOCUSED CONSOLE</div><h1>Shotcaller</h1><p>Live voice control for your guild.</p></div></header>`;
}
function scTabs() {
 const selected=UI.scTab || 'session';
 return `<nav class="sc-console-tabs" aria-label="Shotcaller sections">${[['session','Session','shotcaller'],['setup','Session setup','admin'],['status','System status','audit']].map(([id,label,icon])=>`<button type="button" data-act="sc-tab" data-tab="${id}" class="${selected===id?'active':''}" aria-pressed="${selected===id}">${navIcon(icon)} ${label}</button>`).join('')}<span>${selected==='status'?'Read-only diagnostics':'Setup applies to the next session'}</span></nav>`;
}
function scCallerList(ids,removeAct) {
 return ids.length?`<div class="sc-caller-list">${ids.map(id=>`<div class="sc-caller-person"><span class="sc-initials" aria-hidden="true">${esc(scName(id).slice(0,2).toUpperCase())}</span><strong>${esc(scName(id))}</strong><button class="btn sm sc-remove" data-act="${removeAct}" data-id="${esc(id)}" aria-label="Remove ${esc(scName(id))}">×</button></div>`).join('')}</div>`:'<p class="sc-secondary">No callers selected</p>';
}
function scCallers(d,active,starting) {
 const next=UI.scSetupDraft?.dedicatedCallerId ?? S.settings.shotcaller?.defaultCallerId;
 return `<aside class="sc-console-callers"><h2>${navIcon('member')} Callers</h2><section><div class="sc-section-heading"><h3>Dedicated callers</h3>${active?'<button class="btn sm" data-act="sc-dedicated-manage">Manage ›</button>':''}</div><p class="sc-secondary">Heard across all parties.</p>${active?scCallerList(d.dedicated||[],'sc-dedicated-remove'):`<p class="sc-next-caller">${next?esc(scName(next)):'No dedicated caller selected'}<small>Next session</small></p>${!starting?'<button class="btn sm" data-act="sc-tab" data-tab="setup">Choose caller</button>':''}`}</section><section><div class="sc-section-heading"><h3>Extra callers</h3>${active?'<button class="btn sm" data-act="sc-extra-manage">Manage ›</button>':''}</div><p class="sc-secondary">In addition to the configured caller role.</p>${active?scCallerList(d.additionalCallers||[],'sc-extra-remove'):'<p class="sc-secondary">Manage extra callers once the session is active.</p>'}</section></aside>`;
}
function scSessionConsole(d={},state='inactive') {
 const active=state==='active',starting=state==='starting';
 const parties=active?(d.parties||[]):[],connected=parties.reduce((n,p)=>n+Math.max(0,Number(p.connected)||0),0);
 const muted=active&&(scMutePending===null?!!d.muted:scMutePending);
 return `<div class="sc-console-top"><section class="sc-console-session ${starting?'is-starting':''}"><div class="sc-session-state"><span class="sc-live-dot ${active?'live':starting?'starting':''}"></span><h2>${starting?'Starting session…':active?'Live session':'No active session'}</h2><span class="sc-audio ${muted?'muted':''}">${navIcon('shotcaller')} Audio ${active?(muted?'muted':'on'):'off'}</span></div><div class="sc-session-totals"><div><strong>${active?connected:'—'}</strong><span>connected</span></div><div><strong>${active?parties.length:'—'}</strong><span>party channels</span></div></div>${starting?'<p class="sc-session-note" role="status">Setting up voice channels and connecting relay bots.</p>':muted?'<p class="sc-session-note">Callouts are muted across parties. Local Discord conversations still work.</p>':!active?'<p class="sc-session-note">Start a voice session for your event, a saved line-up or a custom party setup.</p>':''}<div class="sc-session-actions">${active?`<button class="btn" data-act="sc-mute" ${scMutePending!==null||scStopping?'disabled':''}>${muted?'Unmute session':'Mute session'}</button><button class="btn danger" data-act="sc-stop" ${scStopping?'disabled':''}>${scStopping?'Stopping…':'Stop session'}</button>`:`<button class="btn primary" data-act="sc-start" ${starting?'disabled':''}>${starting?'Starting session…':'Start session'}</button>${!starting?'<button class="btn" data-act="sc-tab" data-tab="setup">Session setup</button>':''}`}</div></section>${scCallers(d,active,starting)}</div><section class="sc-console-parties"><div class="sc-section-heading"><h2>${navIcon('shotcaller')} Party channels</h2>${active?`<span>${parties.length} channels · ${connected} connected</span>`:''}</div>${active?`<div class="sc-party-grid">${parties.map(p=>`<article class="sc-channel ${p.connected?'':'is-empty'}"><span class="sc-channel-icon" aria-hidden="true">${navIcon('shotcaller')}</span><div><h3>${esc(p.name)}</h3><div class="sc-channel-count"><strong>${Math.max(0,Number(p.connected)||0)}</strong><span>connected</span></div></div></article>`).join('')||'<p class="sc-secondary">No party channels reported.</p>'}</div>`:starting?`<div class="sc-start-animation" role="status"><div class="sc-start-symbol" aria-hidden="true"><span></span>${navIcon('shotcaller')}</div><strong>Preparing your voice session<span class="sc-loading-dots" aria-hidden="true">…</span></strong><p>Channels and relay bots are being prepared. This can take a little while.</p></div>`:'<div class="sc-session-empty"><span aria-hidden="true">'+navIcon('shotcaller')+'</span><strong>Your party channels will appear here</strong><p>Choose a voice channel, party setup and caller to get started.</p></div>'}</section><div class="sc-bridge-note">${navIcon('requests')}<strong>Bridge</strong><span>Not available yet</span></div>`;
}
function viewShotcaller() {
 if(!isOfficer())return '<div class="empty">Officers only.</div>';
 const header=scPageHeader();
 if(UI.scTab==='status')return `<section class="sc-workspace">${header}${scTabs()}${scSystemStatus()}</section>`;
 if(!S.cfg.shotcallerOn)return `<section class="sc-workspace">${header}${scTabs()}<div class="panel sc-message"><h2>Shotcaller is not connected</h2><p>Configure the Shotcaller connection in the server settings to enable voice controls.</p></div></section>`;
 if(scStarting)return `<section class="sc-workspace">${header}${scTabs()}${scSessionConsole({},'starting')}</section>`;
 if(SC.loading)return `<section class="sc-workspace">${header}${scTabs()}<div class="sc-message" role="status">Loading voice session…</div></section>`;
 if(SC.error)return `<section class="sc-workspace">${header}${scTabs()}<div class="panel sc-message"><h2>Unable to load voice session</h2><p>${esc(SC.error)}</p><button class="btn" data-act="sc-retry">Try again</button></div></section>`;
 const phase=SC.data?.sessionState || SC.data?.diagnostics?.sessionState;
 if(phase==='starting')return scStartingPage();
 if(['stopping','stop-failed'].includes(phase))return `<section class="sc-workspace">${header}${scTabs()}<div class="panel sc-message"><h2>${phase==='stopping'?'Stopping session…':'Session cleanup needs attention'}</h2><p>New sessions stay locked until voice connections and cleanup are finished.</p>${phase==='stop-failed'?'<button class="btn" data-act="sc-stop">Retry stop</button>':''}</div></section>`;
 if(UI.scTab==='setup')return `<section class="sc-workspace">${header}${scTabs()}<section class="sc-setup-panel"><h2>Next session setup</h2><p>These settings apply to the next session you start here. The current session stays unchanged.</p>${scSetupChannels?scStartForm(scSetupChannels,true):`<div class="sc-message" role="status">${scSetupLoading?'Loading voice channels…':'<button class="btn" data-act="sc-load-setup">Load voice channels</button>'}</div>`}</section></section>`;
 return SC.data?.active?scActivePage(SC.data):scInactivePage();
}
function scActivePage(d) { return `<section class="sc-workspace">${scPageHeader()}${scTabs()}${scSessionConsole(d,'active')}</section>`; }
function scStartingPage() { return `<section class="sc-workspace">${scPageHeader()}${scTabs()}${scSessionConsole({},'starting')}</section>`; }
function scInactivePage() { return `<section class="sc-workspace">${scPageHeader()}${scTabs()}${scSessionConsole({},'inactive')}</section>`; }
VIEWS.shotcaller=()=>viewShotcaller();
let scStatusRefreshing=false;
ACTIONS['sc-retry']=async el=>{if(scStatusRefreshing)return;scStatusRefreshing=true;if(el)el.disabled=true;try{await pollShotcaller();}finally{scStatusRefreshing=false;if(el)el.disabled=false;}};
ACTIONS['sc-tab']=async(el,d)=>{
 UI.scTab=['setup','status'].includes(d.tab)?d.tab:'session';render();
 if(UI.scTab==='setup'&&!scSetupChannels)await ACTIONS['sc-load-setup']();
};

/* Read-only operational view. A reported channel member count never implies a healthy relay. */
function scSystemStatus() {
 const configured=!!S.cfg.shotcallerOn,stale=!!SC.error,d=SC.data || {},diag=d.diagnostics?.schemaVersion===1?d.diagnostics:null;
 const number=value=>typeof value==='number' && Number.isFinite(value) && value>=0?value:null;
 const n=value=>number(value)===null?'Not reported':esc(String(Math.round(value)));
 const ms=value=>number(value)===null?'Not reported':n(value)+' ms';
 const date=value=>{const x=new Date(value);return value && Number.isFinite(x.getTime())?esc(x.toLocaleString('en-GB')):'No successful update yet';};
 const uptime=value=>number(value)===null?'Not reported':`${Math.floor(value/3600)}h ${Math.floor(value%3600/60)}m`;
 const badge=(text,kind='unknown')=>`<span class="sc-status-badge is-${kind}">${esc(text)}</span>`;
 const gateway=value=>value===true?badge('Online','ok'):value===false?badge('Offline','bad'):badge('Not reported');
 const voice=value=>value?badge(value,value==='ready'?'ok':['destroyed','disconnected'].includes(value)?'bad':'warn'):badge(diag && !d.active?'No session':'Not reported');
 const parties=Array.isArray(d.parties)?d.parties:[],relays=Array.isArray(diag?.relays)?diag.relays:[];
 const ready=relays.filter(r=>r.voiceState==='ready' && r.gatewayReady===true).length;
 const humans=parties.reduce((sum,p)=>sum+Math.max(0,Number(p.connected)||0),0);
 const apiState=!configured?'Not configured':SC.loading?'Checking':stale?'Unreachable':SC.receivedAt?'Responding':'Not checked';
 const metric=(label,value,detail)=>`<article class="sc-status-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
 const row=(name,bot,channel,rejoins,player)=>`<tr><th scope="row"><strong>${esc(name)}</strong>${bot?.name?`<small>${esc(bot.name)}</small>`:''}</th><td>${esc(channel || '—')}</td><td>${gateway(bot?.gatewayReady)}</td><td>${voice(bot?.voiceState)}</td><td>${ms(bot?.gatewayPingMs)}</td><td>${rejoins===null?'—':n(rejoins)}</td><td>${esc(player || 'Not reported')}</td></tr>`;
 const relayRows=diag?relays.map(r=>row('Relay '+r.index,r,parties.find(p=>p.channelId===r.channelId)?.name || r.channelId,r.rejoinAttempts,r.playerState)).join(''):parties.map((p,i)=>row('Relay '+(i+1),null,p.name,null,null)).join('');
 return `<section class="sc-system-status"><div class="sc-section-heading"><div><h2>System status</h2><p class="sc-secondary">Read-only health and connection information.</p></div><button type="button" class="btn" data-act="sc-retry" ${!configured || scStatusRefreshing?'disabled':''}>Refresh status</button></div>${!configured?'<div class="sc-status-notice">Configure the existing Shotcaller integration to receive status updates.</div>':''}${stale && configured?`<div class="sc-status-notice is-error" role="status"><strong>Control API unavailable.</strong> ${esc(SC.error)}${SC.data?' Values below are from the last successful response; they are not live.':''}</div>`:''}${!diag?'<div class="sc-status-notice">This bot does not report detailed telemetry yet. Session and channel data remain available; individual bot connections, gateway ping and process metrics are not inferred. Install the optional status addon to report them.</div>':''}<div class="sc-status-metrics">${metric('Control API',apiState,'GuildHub → Shotcaller control API')}${metric('Session',!SC.data?'Not reported':['starting','stopping','stop-failed'].includes(d.sessionState || diag?.sessionState)?(d.sessionState || diag.sessionState):d.active?(d.muted?'Active · muted':'Active'):'Inactive',stale?'Last known state':'Reported session state')}${metric('Relay voice connections',diag&&d.active?ready+' / '+(number(diag.expectedRelays)??relays.length)+' ready':'Not reported','Requires gateway online and voice ready')}${metric('People in party channels',SC.data?String(humans):'Not reported','Human members; excludes bots')}</div><section class="panel sc-status-panel"><div class="sc-section-heading"><h2>Bots & voice connections</h2>${badge(stale?'Last known snapshot':diag?'Reported telemetry':'Limited telemetry',stale?'warn':'unknown')}</div><div class="sc-status-table-wrap"><table class="sc-status-table"><thead><tr><th>Bot</th><th>Voice channel</th><th>Discord gateway</th><th>Voice connection</th><th>Gateway ping</th><th>Rejoin attempts</th><th>Audio player</th></tr></thead><tbody>${row('Main bot',diag?.mainBot,d.active?parties[0]?.name:null,null,null)}${relayRows}</tbody></table></div>${!d.active?'<p class="sc-secondary">No active session relay connections are reported. Idle bots are not assumed to be offline.</p>':''}<p class="sc-secondary">Gateway ping is a Discord connection metric, not end-to-end speech delay. An idle audio player is normal when nobody is speaking.</p></section><div class="sc-status-bottom"><section class="panel sc-status-panel"><h2>Process & updates</h2><dl class="sc-status-facts"><div><dt>Bot process uptime</dt><dd>${uptime(diag?.uptimeSeconds)}</dd></div><div><dt>Bot memory (RSS)</dt><dd>${number(diag?.memoryRssMiB)===null?'Not reported':n(diag.memoryRssMiB)+' MiB'}</dd></div><div><dt>Configured relay tokens</dt><dd>${n(diag?.configuredRelays)}</dd></div><div><dt>Last successful update</dt><dd>${date(SC.receivedAt)}</dd></div><div><dt>Bot snapshot time</dt><dd>${diag?date(diag.sampledAt):'Not reported'}</dd></div><div><dt>Status request (HTTP)</dt><dd>${ms(SC.requestMs)}</dd></div><div><dt>Voice transmission delay</dt><dd>Not measured</dd></div></dl><p class="sc-secondary">Refreshes every 5 seconds while this page is open. The server may briefly reuse a cached response. HTTP request time includes the proxy/cache and does not measure voice latency.</p></section><section class="panel sc-status-panel"><h2>Recent observations</h2><p class="sc-secondary">Status changes observed in this browser, not bot logs.</p><ol class="sc-status-observations">${scStatusEvents.map(event=>`<li><time>${date(event.at)}</time><span>${esc(event.message)}</span></li>`).join('') || '<li>No status changes observed yet.</li>'}</ol></section></div></section>`;
}
ACTIONS['sc-load-setup']=async()=>{
 if(scSetupLoading)return;scSetupLoading=true;render();
 try{scSetupChannels=(await api('/api/shotcaller/voice-channels')).channels||[];}
 catch(error){toast(error.message,true);}
 finally{scSetupLoading=false;render();}
};

/* ---------------------------------------------------------------- actions */
ACTIONS['sc-mute']=async()=>{
 if(!SC.data?.active||scMutePending!==null||scStopping)return;
 const previous=!!SC.data.muted;scMutePending=!previous;render();
 try{const reply=await api('/api/shotcaller/mute','POST',{muted:scMutePending});if(SC.data)SC.data.muted=!!reply.muted;}
 catch(error){if(SC.data)SC.data.muted=previous;toast(error.message,true);}
 finally{scMutePending=null;await pollShotcaller();}
};
ACTIONS['sc-stop']=async()=>{
 if((!SC.data?.active && !['stopping','stop-failed'].includes(SC.data?.sessionState))||scStopping)return;
 if(!confirm('Stop this Shotcaller session? The relay bots and dedicated caller will disconnect from voice. Party channels stay up until everyone leaves them.'))return;
 scStopping=true;scPollSerial++;render();
 try{await scAct(()=>api('/api/shotcaller/stop','POST',{sessionId:SC.data?.sessionId}),'Shotcaller session stopped');}
 finally{scStopping=false;render();}
};
// Start dialog: ported from the approved mockup (voice channel / mode / voice-channel-setup / dedicated caller).
// Needs the bot's live voice-channel list, so it's fetched first - the dialog only opens once that answers.
async function scStartDialog(){
 if(scStarting||scStartLoading)return;
 scStartLoading=true;
 try{
  const channels=(await api('/api/shotcaller/voice-channels')).channels||[];
  if(!channels.length){toast('No voice channels found in that Discord server.',true);return;}
  openDialog(scStartForm(channels),true);
 }catch(error){toast(error.message,true);}
 finally{scStartLoading=false;}
}
function scStartForm(channels,configure=false){
  const draft=UI.scSetupDraft || {};
  const last = SC.data && SC.data.lastVoiceChannel;
  const lastId=channels.some(c=>c.id===draft.channelId)?draft.channelId:last&&channels.some(c=>c.id===last.channelId)?last.channelId:channels[0]?.id;
  const st = S.settings.shotcaller || {};
  const candidates = (st.candidateUserIds || []).map((id) => ({ key: id, name: scName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  // Only events/presets that actually have parties to match are worth offering here.
  const upcomingEvents = S.events.filter((e) => e.parties.length && new Date(e.start) >= Date.now() - 3 * 36e5).sort((a, b) => new Date(a.start) - new Date(b.start));
  const presetsWithParties = S.presets.filter((p) => p.parties.length);
  const kind=(draft.setupKind==='event'&&upcomingEvents.length)||(draft.setupKind==='preset'&&presetsWithParties.length)?draft.setupKind:'default';
  const mode=['8','12','custom'].includes(draft.mode)?draft.mode:'8';
  return `<form class="sc-start-form" data-form="${configure?'shotcaller-configure':'shotcaller-start'}">${configure?'':'<h2>Start Shotcaller session</h2>'}
    <div class="field"><label>Voice channel (becomes Party 1 - yours)</label>
      <select name="channelId">${channels.map((c) => `<option value="${esc(c.id)}" ${c.id === lastId ? 'selected' : ''}>${esc(c.name)}${last && c.id === last.channelId ? ' (last used)' : ''}</option>`).join('')}</select></div>
    <div class="row">
      <div class="field"><label>Mode</label>
        <select name="mode" data-act="sc-mode" id="sc-mode" ${kind!=='default'?'disabled':''}>
          <option value="8" ${mode==='8'?'selected':''}>GvG - 8 parties</option>
          <option value="12" ${mode==='12'?'selected':''}>Full Guild - 12 parties</option>
          <option value="custom" ${mode==='custom'?'selected':''}>Custom - 1 to 12</option>
        </select></div>
      <div class="field ${mode==='custom'?'':'hidden'}" id="sc-custom"><label>Number of parties (1-12)</label><input type="number" name="customCount" min="1" max="12" value="${Number(draft.customCount)||8}" ${kind!=='default'?'disabled':''}></div>
    </div>
    <div class="muted small hidden" id="sc-mode-note" style="margin-top:-6px;margin-bottom:12px"></div>
    <div class="field"><label>Voice channel setup</label>
      <select name="setupKind" data-act="sc-setup" id="sc-setup">
        <option value="default" ${kind==='default'?'selected':''}>Default - plain Party 1-N</option>
        ${upcomingEvents.length ? `<option value="event" ${kind==='event'?'selected':''}>Event-related parties - match an event\'s line-up</option>` : ''}
        ${presetsWithParties.length ? `<option value="preset" ${kind==='preset'?'selected':''}>Use preset - match a saved line-up</option>` : ''}
      </select></div>
    <div class="field ${kind==='event'?'':'hidden'}" id="sc-setup-event"><label>Event</label>
      <select name="eventId">${upcomingEvents.map((e) => { const n = 1 + e.parties.slice(1).filter((p) => !partyIsPlaceholder(p)).length; return `<option value="${e.id}" ${String(draft.eventId)===String(e.id)?'selected':''}>${esc(e.title)} - ${fmtShort(e.start)} (${n} ${n === 1 ? 'party' : 'parties'}${n !== e.parties.length ? `, ${e.parties.length - n} placeholder` : ''})</option>`; }).join('')}</select>
      <div class="muted small" style="margin-top:6px">Party count comes from this event's non-placeholder parties, and the channels Shotcaller creates are renamed to match its party leaders.</div></div>
    <div class="field ${kind==='preset'?'':'hidden'}" id="sc-setup-preset"><label>Preset</label>
      <select name="presetId">${presetsWithParties.map((p) => { const n = 1 + p.parties.slice(1).filter((x) => !partyIsPlaceholder(x)).length; return `<option value="${p.id}" ${String(draft.presetId)===String(p.id)?'selected':''}>${esc(p.name)} (${n} ${n === 1 ? 'party' : 'parties'}${n !== p.parties.length ? `, ${p.parties.length - n} placeholder` : ''})</option>`; }).join('')}</select>
      <div class="muted small" style="margin-top:6px">Party count comes from this preset's non-placeholder parties, and the channels Shotcaller creates are renamed to match its party leaders.</div></div>
    <div class="field"><label>Shotcaller</label>
      <select name="dedicatedCallerId">
        <option value="">No dedicated caller - anyone can call out</option>
        ${candidates.map((c) => `<option value="${esc(c.key)}" ${c.key === (draft.dedicatedCallerId ?? st.defaultCallerId) ? 'selected' : ''}>${esc(c.name)}${c.key === st.defaultCallerId ? ' (default)' : ''}</option>`).join('')}
      </select>
      <div class="muted small" style="margin-top:6px">Defaults to whoever's set as the default caller in Admin - not necessarily you. Pick someone else here just for this session, or set a new default in Admin.</div></div>
    <div class="dlg-actions">${configure?'':'<button type="button" class="btn" data-act="dlg-close">Cancel</button>'}
      <button class="btn primary" ${!channels.length?'disabled':''}>${configure?'Save next session setup':'Start session'}</button></div>
  </form>`;
}
ACTIONS['sc-start']=()=>scStartDialog();
FORMS['shotcaller-configure']=(form,fd)=>{
 UI.scSetupDraft={...fd,mode:fd.mode||$('#sc-mode')?.value||'8',customCount:fd.customCount||$('#sc-custom input')?.value||'8'};
 UI.scTab='session';render();toast('Setup saved for the next session you start here');
};
CHANGES['sc-mode'] = (el) => { $('#sc-custom').classList.toggle('hidden', el.value !== 'custom'); };
CHANGES['sc-setup'] = (el) => {
  const overridden = el.value !== 'default';
  $('#sc-setup-event').classList.toggle('hidden', el.value !== 'event');
  $('#sc-setup-preset').classList.toggle('hidden', el.value !== 'preset');
  const modeSel = $('#sc-mode'), note = $('#sc-mode-note'), customInput = $('#sc-custom input');
  modeSel.disabled = overridden;
  if (customInput) customInput.disabled = overridden;
  note.classList.toggle('hidden', !overridden);
  note.textContent = overridden ? `Party count is set by the ${el.value === 'event' ? 'chosen event' : 'chosen preset'}, not by Mode.` : '';
};
FORMS['shotcaller-start'] = (f, fd) => {
  if(scStarting)return;
  UI.scTab='session';
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
      // eventId (when this session was set up "from an event" above) lets the server freeze this event's
      // current party line-up against the channels the bot is about to create for it right now - see
      // server-shotcaller.js's /api/shotcaller/start route. Without a leader on every party (this guild's
      // setup doesn't use them), that frozen snapshot is the only way "Start tracking now" - clicked
      // separately, maybe much later, maybe after parties were reassigned by voice instead of re-posted -
      // still finds each party's actual channel instead of guessing from whatever order the parties happen
      // to be in by then.
      await api('/api/shotcaller/start', 'POST', { channelId: fd.channelId, count, partyNames, dedicatedCallerId: fd.dedicatedCallerId || null, eventId: fd.setupKind === 'event' ? fd.eventId : null });
      delete UI.scSetupDraft;
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

/* ---------------------------------------------------------------- Admin > Events: extra always-tracked channels */
// Cache of the bot's live voice-channel list, loaded on demand (same shape scStartDialog already fetches),
// so Admin > Events doesn't have to await anything itself just to render - it shows saved ids as plain chips
// until an officer actually asks for names, then re-renders with real ones.
let SC_CHANNELS = null;
ACTIONS['sc-load-channels'] = () => act(async () => { SC_CHANNELS = (await api('/api/shotcaller/voice-channels')).channels || []; });
function voiceExtraChannelsField(selectedIds) {
  if (!S.cfg.shotcallerOn) return '<div class="muted small">Set up Shotcaller first (see the README) to pick channels here.</div>';
  if (!SC_CHANNELS) {
    return `<div class="muted small" style="margin-bottom:6px">${selectedIds.length ? `${selectedIds.length} channel${selectedIds.length === 1 ? '' : 's'} saved.` : 'None picked yet.'}</div>
      <button type="button" class="btn sm" data-act="sc-load-channels">Load channel list</button>`;
  }
  // A saved id the bot no longer lists (renamed/deleted channel, or the bot removed from the server) still
  // shows, still checked, so saving the form again doesn't silently drop it without anyone noticing - an
  // officer has to actually untick it to remove it.
  const known = new Set(SC_CHANNELS.map((c) => c.id));
  const stale = selectedIds.filter((id) => !known.has(id));
  const rows = SC_CHANNELS.concat(stale.map((id) => ({ id, name: `(channel ${id}, not found)` })));
  // A guild with a lot of voice channels can have long, similar-looking names - fixed to a one-line, truncated
  // row (chan-pick-box below) so every row is the same height and the box reliably shows about 6 of them
  // before it needs to scroll, instead of ballooning whenever a name happens to wrap onto two lines.
  return `<div class="scrollbox chan-pick-box">${rows.map((c) => `<label class="tagpick"><input type="checkbox" name="vtxc" value="${esc(c.id)}" ${selectedIds.includes(c.id) ? 'checked' : ''}><span class="chan-name" title="${esc(c.name)}">🔊 ${esc(c.name)}</span></label>`).join('') || '<span class="muted small">No voice channels found.</span>'}</div>`;
}

/* ---------------------------------------------------------------- Admin > Testing: a live voice-attendance dry-run */
// A real end-to-end test of the whole voice-attendance pipeline (Admin > Events) without needing a real event:
// starts a throwaway 3-channel Shotcaller session, waits 3 minutes, then watches who actually shows up and
// reports back who got confirmed - same rolling 30s/2-sightings rule the real feature uses - and whether they
// were muted/deafened at the time. Nothing here ever touches a real event, attendance, points or warnings.
let VT_TIMER = null;
function voiceTestAnchorPicker() {
  if (!S.cfg.shotcallerOn) return '<div class="muted small">Set up Shotcaller first (see the README) to run this test.</div>';
  if (!SC_CHANNELS) return '<button type="button" class="btn sm" data-act="sc-load-channels">Load channel list</button>';
  if (!SC_CHANNELS.length) return '<div class="muted small">No voice channels found for the bot to use as an anchor.</div>';
  return `<select id="vt-anchor" aria-label="Anchor voice channel for the test">${SC_CHANNELS.map((c) => `<option value="${esc(c.id)}">🔊 ${esc(c.name)}</option>`).join('')}</select>`;
}
function testingAdmin() {
  const showVoice = S.cfg.shotcallerOn;
  return `<div class="panel"><h3>Testing</h3>
    ${showVoice ? `<div class="muted small" style="margin:-6px 0 10px">Run a live dry-run of voice-attendance tracking (Admin &gt; Events) without a real event. This starts a throwaway Shotcaller session: the anchor channel you pick below, plus 2 new channels the bot creates (3 total). After 3 minutes it starts checking who is actually present, the same way a real tracked event would, and shows exactly who gets confirmed and whether they were muted or deafened at the time. Nothing here touches any real event, attendance, points or warnings - stop it any time.</div>
    <div class="field"><label>Anchor channel</label>${voiceTestAnchorPicker()}</div>
    <button class="btn" data-act="voicetest-run" style="margin-top:4px">Run attendance test</button>
    <h4 class="sub-head" style="margin-top:18px">DM button test</h4>` : ''}
    <div class="muted small" style="margin:${showVoice ? '-2px' : '-6px'} 0 10px">Sends a real Discord DM with Yes/No buttons to the players picked below - the same mechanism event reminders use (see README, "Discord setup" step 8) - so you can check end-to-end that DMs and button clicks actually work. The popup below fills in live as each player taps a button; their own DM then changes to say which one they clicked.</div>
    <div class="field"><label>Players</label>${playerPickerFor('dmtest', [])}</div>
    <button type="button" class="btn" data-act="dmtest-run" style="margin-top:4px">Start test</button>
  </div>`;
}
function dmTestDialogHtml(t) {
  if (!t || !t.id) return `<h3>DM button test</h3><div class="muted">No test is running.</div><div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Close</button></div>`;
  const rows = t.players.map((p) => {
    const r = t.results[p.key];
    const status = !r ? '<span class="muted small">Waiting…</span>'
      : r.answer === 'yes' ? '<span class="pos small">Clicked Yes</span>'
      : r.answer === 'no' ? '<span class="neg small">Clicked No</span>'
      : `<span class="muted small">Could not be sent${r.error ? ` (${esc(r.error)})` : ''}</span>`;
    return `<div class="rsvp-row"><span>${esc(p.name)}</span>${status}</div>`;
  }).join('');
  return `<h3>DM button test</h3>
    <div class="scrollbox" style="max-height:260px;margin-top:6px">${rows}</div>
    <div class="dlg-actions" style="margin-top:14px"><button type="button" class="btn danger" data-act="dmtest-stop">Stop test</button></div>`;
}
let DMT_TIMER = null;
async function pollDmTest() {
  let t;
  try { t = await api('/api/admin/dm-test'); } catch { return; }
  if (!$('#dlg').open) { clearInterval(DMT_TIMER); DMT_TIMER = null; return; }
  openDialog(dmTestDialogHtml(t), false);
}
ACTIONS['dmtest-run'] = async () => {
  const keys = [...document.querySelectorAll('input[name=dmtest]:checked')].map((i) => i.value);
  if (!keys.length) return toast('Pick at least one player.', true);
  openDialog(dmTestDialogHtml({ id: 'pending', players: keys.map((k) => ({ key: k, name: k })), results: {} }));
  let t;
  try {
    t = await api('/api/admin/dm-test/start', 'POST', { playerKeys: keys });
  } catch (e) {
    openDialog(`<h3>DM button test</h3><div class="err" style="margin-bottom:10px">${esc(e.message)}</div><div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Close</button></div>`);
    return;
  }
  openDialog(dmTestDialogHtml(t), false);
  clearInterval(DMT_TIMER);
  DMT_TIMER = setInterval(pollDmTest, 2000);
};
ACTIONS['dmtest-stop'] = () => {
  clearInterval(DMT_TIMER); DMT_TIMER = null;
  act(async () => { await api('/api/admin/dm-test/stop', 'POST'); closeDialog(); }, 'Test stopped');
};
function voiceTestDialogHtml(t) {
  if (!t || !t.phase) return `<h3>Attendance tracking test</h3><div class="muted">No test is running.</div><div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Close</button></div>`;
  if (t.phase === 'error') {
    return `<h3>Attendance tracking test</h3><div class="err" style="margin-bottom:10px">${esc(t.error || 'Something went wrong.')}</div>
      <div class="dlg-actions"><button type="button" class="btn" data-act="dlg-close">Close</button></div>`;
  }
  // Three checklist steps, each either done (already past), active (the phase we're literally in right now,
  // including "ended" counting as tracking still being the active/most-recent step) or pending (not reached yet).
  const steps = ['starting', 'waiting', 'tracking'];
  const at = steps.indexOf(t.phase === 'ended' ? 'tracking' : t.phase);
  const step = (key, label, extra) => {
    const i = steps.indexOf(key);
    const mark = i < at ? '✅' : i > at ? '○' : t.phase === 'ended' ? '✅' : '⏳';
    return `<div class="muted small" style="margin:3px 0"><span style="margin-right:6px">${mark}</span>${esc(label)}${extra || ''}</div>`;
  };
  const waitLeft = t.trackAt ? until(new Date(t.trackAt).toISOString()) : '';
  const channelNames = t.channels.length ? t.channels.map((c) => esc(c.name)).join(', ') : '';
  return `<h3>Attendance tracking test</h3>
    ${step('starting', 'Starting bots…')}
    ${step('waiting', t.channels.length ? `Bots are active${channelNames ? ` (${channelNames})` : ''}` : 'Bots are active')}
    ${t.phase === 'waiting' ? `<div class="muted small" style="margin:3px 0 3px 22px">Waiting ${waitLeft.replace(/^in /, '')} before tracking starts…</div>` : ''}
    ${step('tracking', t.phase === 'ended' ? 'Tracking ended' : `Tracking now - quick check ${Math.min((t.checksDone || 0) + 1, t.checksTotal || 3)} of ${t.checksTotal || 3}`)}
    <div style="margin-top:14px"><b>Confirmed players</b>
      ${t.confirmed.length ? `<div class="scrollbox" style="max-height:220px;margin-top:6px">${t.confirmed.map((c) => `<div class="rsvp-row"><span>${esc(c.name)}</span><span class="muted small">${c.mute && c.deaf ? 'Muted + deafened' : c.mute ? 'Muted' : c.deaf ? 'Deafened' : 'Not muted'}</span></div>`).join('')}</div>`
        : `<div class="muted small" style="margin-top:6px">${t.phase === 'tracking' ? `Nobody confirmed yet - join one of the test channels${channelNames ? `: ${channelNames}` : ''} before the checks finish.` : 'Nobody has been checked yet.'}</div>`}
    </div>
    <div class="dlg-actions" style="margin-top:14px"><button type="button" class="btn danger" data-act="voicetest-stop">Stop test</button></div>`;
}
async function pollVoiceTest() {
  let t;
  try { t = await api('/api/admin/voice-test'); } catch { return; }
  if (!$('#dlg').open) { clearInterval(VT_TIMER); VT_TIMER = null; return; }
  if (!t.phase) { clearInterval(VT_TIMER); VT_TIMER = null; }
  openDialog(voiceTestDialogHtml(t), false);
}
ACTIONS['voicetest-run'] = async () => {
  const sel = $('#vt-anchor');
  if (!sel || !sel.value) return toast('Pick an anchor channel first.', true);
  openDialog(voiceTestDialogHtml({ phase: 'starting', channels: [], confirmed: [] }));
  try {
    await api('/api/admin/voice-test/start', 'POST', { channelId: sel.value });
  } catch (e) {
    // A failure here (most often "already running", or the bot unreachable) never even got as far as creating
    // a server-side voiceTest slot with its own phase:'error' - show it directly instead of leaving the
    // placeholder dialog stuck on "Starting bots..." forever with no poll loop ever started to move it along.
    openDialog(voiceTestDialogHtml({ phase: 'error', error: e.message, channels: [], confirmed: [] }));
    return;
  }
  clearInterval(VT_TIMER);
  VT_TIMER = setInterval(pollVoiceTest, 2000);
  pollVoiceTest();
};
ACTIONS['voicetest-stop'] = () => {
  clearInterval(VT_TIMER); VT_TIMER = null;
  act(async () => { await api('/api/admin/voice-test/stop', 'POST'); closeDialog(); }, 'Test stopped');
};
// Closing the dialog any other way (Escape, clicking the backdrop) must stop the live test too, not just the
// polling - otherwise the throwaway Shotcaller session (and its 2 bot-created channels) is left running with
// nobody watching it until the server's own VT_MAX_MS safety net eventually cleans it up.
$('#dlg').addEventListener('close', () => {
  if (VT_TIMER) { clearInterval(VT_TIMER); VT_TIMER = null; api('/api/admin/voice-test/stop', 'POST').catch(() => {}); }
  if (DMT_TIMER) { clearInterval(DMT_TIMER); DMT_TIMER = null; api('/api/admin/dm-test/stop', 'POST').catch(() => {}); }
});

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
