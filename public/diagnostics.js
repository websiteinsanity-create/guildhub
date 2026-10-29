// On-demand diagnostic reads. No session control, corrections or external messages.
let DIAG={data:null,error:'',busy:false,watch:false,timer:null};
async function readDiagnostics(){
 if(DIAG.busy || document.hidden || route().page!=='diagnostics')return;
 DIAG.busy=true;
 try{DIAG.data=await api('/api/admin/diagnostics');DIAG.error='';}catch(e){DIAG.error=e.message;}finally{DIAG.busy=false;}
 if(route().page==='diagnostics')render();
}
VIEWS.diagnostics=()=>{
 if(!isOfficer())return '<div class="empty">Officers only.</div>';
 const d=DIAG.data;
 return `<div class="page-head"><h1>Diagnostics</h1><div class="seg"><button class="btn primary" data-act="diag-refresh">Refresh</button><button class="btn" data-act="diag-watch">${DIAG.watch?'Stop monitoring':'Monitor this page'}</button>${d?'<button class="btn" data-act="diag-export">Download report</button>':''}</div></div>
 <p class="muted">Read-only diagnostics. Monitoring refreshes every 10 seconds while this page is visible. No AI is connected automatically. Support accounts have read-only access.</p>
 ${DIAG.error?`<div class="panel err">${esc(DIAG.error)}</div>`:''}
 ${!d?'<div class="panel">Select Refresh to load diagnostics.</div>':`
 <div class="panel"><h2>GuildHub process</h2><p>Version ${esc(d.version)} · Updated ${esc(d.at)}</p><p>Uptime: ${d.uptimeSeconds}s · Memory: ${d.memoryMiB.rss} MiB · Heap: ${d.memoryMiB.heap} MiB</p><p>Event loop: mean ${d.eventLoopMs.mean} ms · lifetime maximum ${d.eventLoopMs.max} ms</p><p>API requests: ${d.api.total} · Server errors: ${d.api.serverErrors}</p></div>
 <div class="panel"><h2>Attendance tracks</h2>${d.tracks.length?d.tracks.map(t=>`<div class="panel"><a href="#/events/${t.id}">${esc(t.title)}</a><p>${t.active?'Running':'Incomplete'} · ${t.checksDone}/${t.checksTotal} checks · ${t.recorded} recorded</p><p class="small muted">Run: ${esc(t.runId || 'Not reported')} · Session: ${esc(t.sessionBinding || 'Not reported')}</p></div>`).join(''):'<p>No running or incomplete tracks.</p>'}</div>
 <div class="panel"><h2>Recent API responses</h2><div style="overflow-x:auto"><table><thead><tr><th>Time</th><th>Method</th><th>Route pattern</th><th>Status</th><th>Duration</th></tr></thead><tbody>${d.api.recent.map(r=>`<tr><td>${esc(r.at)}</td><td>${esc(r.method)}</td><td>${esc(r.route)}</td><td>${r.status}</td><td>${r.ms} ms</td></tr>`).join('')}</tbody></table></div></div>
 <div class="panel"><h2>Coverage</h2>${d.limitations.map(x=>`<p class="muted">${esc(x)}</p>`).join('')}<p>Bot telemetry is available in <a href="#/shotcaller">Shotcaller → System status</a>. This report contains no raw server logs or credentials.</p></div>`}`;
};
ACTIONS['diag-refresh']=()=>readDiagnostics();
ACTIONS['diag-watch']=()=>{DIAG.watch=!DIAG.watch;readDiagnostics();render();};
ACTIONS['diag-export']=()=>{if(!DIAG.data)return;const url=URL.createObjectURL(new Blob([JSON.stringify(DIAG.data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='guildhub-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
AFTER_RENDER.push(page=>{
 if(page!=='diagnostics'){clearInterval(DIAG.timer);DIAG.timer=null;DIAG.watch=false;return;}
 if(DIAG.watch && !DIAG.timer)DIAG.timer=setInterval(()=>readDiagnostics(),10000);
 if(!DIAG.watch && DIAG.timer){clearInterval(DIAG.timer);DIAG.timer=null;}
});
let supportSettings=null,supportCode='';
const diagnosticsView=VIEWS.diagnostics;
VIEWS.diagnostics=()=>diagnosticsView()+(!isOfficer() || S.user.support?'':`<div class="panel"><h2>SupportAI access</h2><p><a href="/support">Open support login</a> · Username: SupportAI · Read-only</p><p>Generate a 12-character code valid for 10 minutes. It can be used once for a session lasting up to two hours. Generating a new code ends previous support access.</p><div class="seg"><button class="btn" data-act="support-load">Refresh access status</button><button class="btn primary" data-act="support-generate">Generate support code</button><button class="btn danger" data-act="support-revoke">Revoke support access</button></div>${supportCode?`<p><strong>One-time code: <code>${esc(supportCode)}</code></strong> <button class="btn sm" data-act="support-hide-code">Hide code</button></p><p class="muted">Shown only in this response. It cannot be retrieved again after leaving this page.</p>`:''}${supportSettings?`<p>Code: ${supportSettings.codePending?'Pending until '+esc(new Date(supportSettings.codeExpiresAt).toISOString()):'None'} · Session: ${supportSettings.sessionActive?'Active until '+esc(new Date(supportSettings.sessionExpiresAt).toISOString()):'None'}</p>`:''}</div>`);
ACTIONS['support-load']=async()=>{try{supportSettings=await api('/api/admin/support-access');render();}catch(e){toast(e.message,true);}};
ACTIONS['support-generate']=async()=>{if(!confirm('Generate a new code and end any existing support session?'))return;try{const result=await api('/api/admin/support-access/generate','POST',{});supportCode=result.code;const {code,...status}=result;supportSettings=status;render();}catch(e){toast(e.message,true);}};
ACTIONS['support-revoke']=async()=>{try{supportSettings=await api('/api/admin/support-access/revoke','POST',{});supportCode='';render();toast('Support access revoked.');}catch(e){toast(e.message,true);}};
ACTIONS['support-hide-code']=()=>{supportCode='';render();};
AFTER_RENDER.push(page=>{if(page!=='diagnostics'){supportCode='';supportSettings=null;}});
// This is only presentation; the server independently enforces the support read allowlist.
AFTER_RENDER.push(()=>{
 if(!S.user?.readOnly)return;
 const main=document.getElementById('main');if(!main)return;
 if(!main.querySelector('.support-readonly-banner')){const banner=document.createElement('p');banner.className='panel support-readonly-banner';banner.setAttribute('role','status');banner.textContent='SupportAI · Read-only access. Data changes, messages, uploads and session controls are blocked.';main.prepend(banner);}
 main.querySelectorAll('form button:not([type]),form button[type="submit"],input[type="submit"],input[type="file"]').forEach(el=>{el.disabled=true;el.title='Read-only support access';});
 main.querySelectorAll('[draggable="true"]').forEach(el=>el.draggable=false);
});
