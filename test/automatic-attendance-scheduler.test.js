const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const file=path.join(__dirname,'..','server-shotcaller.js');
function harness(previous,initialNow=Date.parse('2026-11-05T18:00:00Z')){
 let now=initialNow,status={active:true,sessionId:'shared-session',parties:[{index:1,channelId:'voice-1',connectedStates:[{id:'owner-1',mute:false,deaf:false}]}]},extraAvailable=true,hold=null;
 const db=previous || {settings:{voiceTrackStartOffsetMinutes:0,voiceTrackExtraChannelIds:[],shotcaller:{candidateUserIds:[]}},events:[],members:[{id:1,owner:'owner-1',active:true}],users:{}};
 const timers=new Map(),routes=new Map(),tickHooks=[],audits=[];let seq=0,reads=0;
 class Clock extends Date{static now(){return now;}}
 const ctx={db,tickHooks,shotcaller:{url:'http://fake',apiKey:'test',guildId:'guild-1'},route:(m,p,h)=>routes.set(m+' '+p,h),
  need:(v,code,msg)=>{if(!v){const e=Error(msg);e.status=code;throw e;}},HttpError:class extends Error{},save:()=>{},audit:(...args)=>audits.push(args),
  findEvent:id=>db.events.find(e=>e.id===Number(id)),findMember:id=>db.members.find(m=>m.id===Number(id)),eventFor:ev=>ev,
  effectiveAttendanceMode:ev=>ev.attendanceMode || 'voice',partyIsPlaceholder:()=>false,
  setAttended:(ev,ids)=>{ev.attended=[...new Set([...(ev.attended || []),...ids])];ev.attendanceTracked=true;}};
 const box={module:{exports:{}},require:createRequire(file),console,Date:Clock,process:{env:{VOICE_POLL_INTERVAL_MS:'10',SHOTCALLER_SESSION_CACHE_MS:'1'}},AbortSignal,
  setInterval:()=>({unref(){}}),setTimeout:(fn,delay)=>{const id={unref(){}};timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
  fetch:async url=>{reads++;if(hold)await hold;let data;if(String(url).includes('/voice-presence')){const ids=new URL(url).searchParams.get('channels').split(',');data={channels:ids.map(id=>({channelId:id,found:extraAvailable,connectedStates:[]}))};}else data=JSON.parse(JSON.stringify(status));return {ok:true,json:async()=>data};}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),box);const api=box.module.exports(ctx);
 const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
 return {db,api,routes,audits,get reads(){return reads;},get now(){return now;},setStatus:s=>{status=s;},get status(){return status;},setExtra:v=>extraAvailable=v,
  hold:p=>{hold=p;},settle,event:(id=1,extra={})=>{const ev={id,title:'Event '+id,start:new Date(now+1000).toISOString(),voiceTrackAuto:true,parties:[],attended:[],...extra};db.events.push(ev);return ev;},
  advance:async ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await settle();},
  tick:async()=>{await Promise.all(tickHooks.map(fn=>fn()));await settle();},
  manual:async(id,restart=false)=>{await routes.get('POST /api/events/:id/voice-track/'+(restart?'restart':'start'))({params:{id},user:{name:'Officer'}});await settle();}};
}
for(const association of ['same-event','other-event',null])test('scheduled attendance uses active guild session: '+association,async()=>{
 const h=harness();const e=h.event();h.status.eventId=association==='same-event'?1:association==='other-event'?99:null;
 await h.tick();assert.equal(e.voiceTracking,undefined);await h.advance(1000);await h.tick();assert.equal(e.voiceAutoStart.status,'started');assert.equal(e.voiceTracking.sessionBinding,'id:shared-session');
 await h.advance(10);await h.advance(10);assert.equal(e.voiceTracking.checksDone,3);assert.equal(e.attendanceTracked,true);assert.deepEqual([...e.attended],[1]);
});
test('inactive at deadline disables only this event; late session never auto-starts; manual preserves failure audit',async()=>{
 const h=harness(),e=h.event(),later=h.event(2,{start:new Date(h.now+100000).toISOString()});h.setStatus({active:false});await h.advance(1000);await h.tick();
 assert.equal(e.voiceTrackAuto,false);assert.equal(e.voiceAutoStart.status,'failed');assert.match(e.voiceAutoStart.reason,/No active Shotcaller session/);assert.equal(later.voiceTrackAuto,true);const failure=e.voiceAutoStart;
 h.setStatus({active:true,sessionId:'late',parties:[{index:1,channelId:'voice-1',connectedStates:[{id:'owner-1'}]}]});await h.tick();assert.equal(e.voiceTracking,undefined);
 await h.manual(1);assert.equal(e.voiceAutoStart,failure);assert.equal(e.voiceTracking.startSource,'manual');assert(h.audits.some(row=>row[1]==='event.voicetrack.auto-failed'));await h.advance(10);await h.advance(10);assert.equal(e.attendanceTracked,true);
});
for(const missing of ['parties','extra','gateway'])test('active session with unavailable '+missing+' fails without erasing attendance',async()=>{
 const h=harness(),e=h.event(1,{attended:[7]});if(missing==='parties')h.status.parties=[];if(missing==='extra'){e.voiceTrackExtraChannelIds=['missing'];h.setExtra(false);}if(missing==='gateway')h.status.diagnostics={mainBot:{gatewayReady:false}};
 await h.advance(1000);await h.tick();assert.equal(e.voiceTrackAuto,false);assert.equal(e.voiceTracking,undefined);assert.deepEqual(e.attended,[7]);assert.doesNotMatch(e.voiceAutoStart.reason,/No active Shotcaller/);
});
test('concurrent scheduler sweeps and manual start cannot duplicate a pending automatic start',async()=>{
 const h=harness(),e=h.event();await h.advance(1000);let release;h.hold(new Promise(r=>release=r));const first=h.api.checkAutomaticAttendance();await h.settle();await h.api.checkAutomaticAttendance();await assert.rejects(h.manual(1),/already in progress/);release();await first;await h.settle();assert.equal(e.voiceAutoStart.status,'started');assert.equal(h.reads,1);
});
test('restart before due time retains scheduling; restart after missed deadline never credits old event',async()=>{
 const h=harness();h.event();const before=harness(h.db,h.now+500);await before.advance(500);await before.tick();assert.equal(h.db.events[0].voiceAutoStart.status,'started');
 const old=harness();const e=old.event();const after=harness(old.db,old.now+2000);await after.tick();assert.equal(e.voiceAutoStart.code,'missed-time');assert.equal(e.voiceTrackAuto,false);assert.equal(e.voiceTracking,undefined);
});
test('restart during prerequisite verification fails safely without retrying',async()=>{
 const h=harness(),e=h.event(1,{voiceAutoStart:{status:'checking'}});const resumed=harness(h.db,h.now+2000);await resumed.tick();assert.equal(e.voiceAutoStart.code,'interrupted');assert.equal(resumed.reads,0);
});
test('independently scheduled events can share the same session without stopping each other',async()=>{
 const h=harness(),a=h.event(),b=h.event(2);await h.advance(1000);await h.tick();assert.equal(a.voiceTracking.active,true);assert.equal(b.voiceTracking.active,true);assert.notEqual(a.voiceTracking.runId,b.voiceTracking.runId);
});
test('manual prerequisite failure preserves prior track and saved attendance',async()=>{
 const h=harness(),old={active:false,finishedAt:h.now-1,seen:{old:{}},checksDone:3};const e=h.event(1,{voiceTracking:old,attended:[1],voiceTrackExtraChannelIds:['bad']});h.setExtra(false);await assert.rejects(h.manual(1,true),/extra voice channels/);assert.equal(e.voiceTracking,old);assert.deepEqual(e.attended,[1]);
});

test('attendance UI exposes scheduled, failure, manual, active and completed states safely',()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8'),features=fs.readFileSync(path.join(__dirname,'..','public','features.js'),'utf8');
 const helper=app.slice(app.indexOf('function voiceAutomaticStatus('),app.indexOf('function voiceTrackPanel('));
 const box={S:{settings:{voiceTrackStartOffsetMinutes:10},cfg:{defaultTimezone:'Europe/Berlin'}},esc:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'),Date};vm.createContext(box);vm.runInContext(helper,box);
 const ev={start:'2026-11-05T18:00:00Z',voiceTrackAuto:true};assert.match(box.voiceAutomaticStatus(ev),/Scheduled/);
 ev.voiceAutoStart={status:'failed',failedAt:Date.parse(ev.start),reason:'No active Shotcaller session was detected at the scheduled tracking time. Automatic tracking has been disabled for this event. You can still start tracking manually.'};assert.match(box.voiceAutomaticStatus(ev),/Automatic start failed/);assert.match(box.voiceAutomaticStatus(ev),/Automatic tracking unavailable/);
 ev.voiceTracking={active:true,startSource:'manual'};assert.match(box.voiceAutomaticStatus(ev),/Manually started · Tracking active/);assert.match(box.voiceAutomaticStatus(ev),/No active Shotcaller session/);
 ev.voiceTracking={active:false,finishedAt:Date.parse(ev.start)};assert.match(box.voiceAutomaticStatus(ev),/Tracking completed/);ev.voiceAutoStart.reason='<script>';assert.doesNotMatch(box.voiceAutomaticStatus(ev),/<script>/);
 const explanation='Automatic attendance tracking starts at the configured time when an active Shotcaller session and the required voice channels are available. The Shotcaller session does not need to be linked to this event.';
 assert(app.includes(explanation));assert(features.includes(explanation));assert(!app.includes('Tracking starts on its own the moment Shotcaller is started for this event'));assert(!features.includes('Starts on its own the moment Shotcaller is started for this event'));
});

test('retroactively entered past event is never auto-tracked with the people in voice now',async()=>{
 const h=harness();const e=h.event(1,{start:new Date(h.now-7*864e5).toISOString(),createdAt:h.now});await h.tick();
 assert.equal(e.voiceTracking,undefined);assert.equal(e.voiceAutoStart,undefined);assert.equal(e.voiceTrackAuto,true);assert.deepEqual(e.attended,[]);
});
test('first start after an update leaves old untracked history alone instead of flagging every event',async()=>{
 const h=harness();const old=h.event(1,{start:new Date(h.now-3*864e5).toISOString()});const recent=h.event(2,{start:new Date(h.now-60000).toISOString()});
 await h.tick();assert.equal(old.voiceAutoStart,undefined);assert.equal(old.voiceTrackAuto,true);assert.equal(recent.voiceAutoStart.code,'missed-time');
 assert.equal(h.audits.filter(r=>r[1]==='event.voicetrack.auto-failed').length,1);
});
test('an event created a few minutes after its start (ad-hoc) still auto-tracks',async()=>{
 const h=harness();const e=h.event(1,{start:new Date(h.now-5*60000).toISOString(),createdAt:h.now});await h.tick();assert.equal(e.voiceAutoStart.status,'started');
});
test('a sweep far beyond the start window marks the event missed instead of starting late',async()=>{
 const h=harness();const e=h.event();await h.advance(16*60000);await h.tick();assert.equal(e.voiceTracking,undefined);assert.equal(e.voiceAutoStart.code,'missed-time');
});
test('switching automatic tracking back on after a failure re-arms the next scheduled start',async()=>{
 const h=harness(),e=h.event();h.setStatus({active:false});await h.advance(1000);await h.tick();assert.equal(e.voiceAutoStart.status,'failed');
 e.voiceTrackAuto=true;e.voiceTrackAutoChangedAt=h.now+1;e.start=new Date(h.now+5000).toISOString();
 h.setStatus({active:true,sessionId:'s2',parties:[{index:1,channelId:'voice-1',connectedStates:[{id:'owner-1'}]}]});
 await h.advance(2);await h.tick();assert.equal(e.voiceTracking,undefined,'not before the new time');await h.advance(5000);await h.tick();assert.equal(e.voiceAutoStart.status,'started');assert.equal(e.voiceTracking.startSource,'automatic');
});
