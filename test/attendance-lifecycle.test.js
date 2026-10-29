// Regression coverage for attendance lifecycle fixes.
// Exposes private functions in memory without changing their logic; controlled transport/clock.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const sourcePath=path.join(__dirname,'../server-shotcaller.js');
const raw=fs.readFileSync(sourcePath,'utf8');
const source=raw.replace('return { configured, checkCandidates, startSession, beginVoiceTracking, snapshotVoiceSession, cancelVoiceTracking };','return { configured, checkCandidates, startSession, beginVoiceTracking, snapshotVoiceSession, cancelVoiceTracking, _test:{runCheckSafe,pollVoiceTest,checkTimers,getVoiceTest:()=>voiceTest} };');
assert.notEqual(source,raw,'Only expose internals for observation; do not alter their logic.');
const NOW=Date.parse('2026-10-28T12:00:00Z'),user={key:'officer',name:'Officer'};
const status=(owner=null,channel='old-channel',sessionId='session-original')=>({active:true,sessionId,parties:[{index:1,channelId:channel,name:'Party 1',connectedStates:owner?[{id:owner,mute:false,deaf:false}]:[]}],dedicated:[],additionalCallers:[]});
const event=()=>({id:1,title:'Siege',start:new Date(NOW-60000).toISOString(),parties:[{members:[11]}],rsvps:{11:'yes'},attended:[],attendanceTracked:false,autoAttended:false,voiceTrackStartOffsetMinutes:0});
function harness(db,request=async()=>status(),clock={now:NOW}) {
 const routes=new Map(),timers=new Map(),tickHooks=[],module={exports:{}},logs=[];let timerId=0,attendanceWrites=0;
 class Clock extends Date{constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
 const ctx={db,shotcaller:{url:'http://fake-bot',apiKey:'test-key',guildId:'111111111111111111'},route:(method,url,fn)=>routes.set(method+' '+url,fn),need:(ok,code,message)=>{if(!ok){const e=Error(message);e.status=code;throw e;}},HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}},save(){},audit(){},findMember:id=>db.members.find(m=>m.id===id),findEvent:id=>db.events.find(e=>String(e.id)===String(id)),eventFor:e=>structuredClone(e),setAttended:(ev,ids)=>{attendanceWrites++;ev.attended=[...ids];ev.attendanceTracked=true;},partyIsPlaceholder:p=>!p.members.length,effectiveAttendanceMode:()=> 'voice',tickHooks};
 const context={module,exports:module.exports,require:require('node:module').createRequire(sourcePath),Date:Clock,URL,AbortSignal,console:{error:(...x)=>logs.push(x),warn:(...x)=>logs.push(x)},setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,fetch:async(url,opts)=>{const data=await request(url,opts);return{ok:true,status:200,json:async()=>data};},process:{env:{}}};
 vm.runInNewContext(source,context,{filename:sourcePath});const api=module.exports(ctx);
 return {api,routes,timers,tickHooks,clock,writes:()=>attendanceWrites,logs,call:(method,url,body={})=>routes.get(method+' '+url)({body,user,params:{id:'1'}})};
}
const dbFor=e=>({events:[e],members:[{id:11,name:'Alice',owner:'alice',active:true}],users:{},settings:{shotcaller:{candidateUserIds:[]}}});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('transient API errors retry without consuming checks or finalizing attendance',async()=>{
 const ev=event(),h=harness(dbFor(ev),async()=>{throw Error('temporary outage');});h.api.beginVoiceTracking(ev,status(),[]);await flush();
 await h.api._test.runCheckSafe(1,null);assert.equal(ev.voiceTracking.active,true);assert.equal(ev.voiceTracking.checksDone,1);assert.equal(ev.voiceTracking.checkErrors,1);
 await h.api._test.runCheckSafe(1,status('alice'));await h.api._test.runCheckSafe(1,status('alice'));
 assert.deepEqual(ev.attended,[11]);assert.equal(ev.attendanceTracked,true);assert.equal(ev.voiceTracking.checksDone,3);
});
test('exhausted failed reads preserve partial sightings without declaring absent players no-shows',async()=>{
 const ev=event(),h=harness(dbFor(ev),async()=>{throw Error('outage');});h.api.beginVoiceTracking(ev,status('alice'),[]);await flush();
 for(let i=0;i<5;i++)await h.api._test.runCheckSafe(1,null);
 assert.equal(ev.voiceTracking.incomplete,true);assert.equal(ev.voiceTracking.active,false);assert.equal(ev.attendanceTracked,false);assert.deepEqual(ev.attended,[11]);
});
test('three valid empty snapshots finalize tracked attendance even with zero attendees',async()=>{
 const ev=event(),h=harness(dbFor(ev));h.api.beginVoiceTracking(ev,status(),[]);await flush();await h.api._test.runCheckSafe(1,status());await h.api._test.runCheckSafe(1,status());
 assert.equal(ev.attendanceTracked,true);assert.equal(h.writes(),1);assert(ev.voiceTracking.finishedAt);
});
test('watchdog restart honors the future tracking gate',async()=>{
 const ev=event();ev.start=new Date(NOW+3600000).toISOString();const db=dbFor(ev),a=harness(db);a.api.beginVoiceTracking(ev,status('alice'),[]);await flush();
 const b=harness(db,async()=>status('alice'));await b.tickHooks[0]();await flush();assert.equal(ev.voiceTracking.checksDone,0);assert.equal(ev.voiceTracking.sessionSeen.length,0);assert.equal([...b.timers.values()][0].ms,3600000);
 b.clock.now=Date.parse(ev.start);[...b.timers.values()][0].fn();await flush();assert.equal(ev.voiceTracking.checksDone,1);
});
test('Track again owns a fresh run; pending old success and counters cannot contaminate it',async()=>{
 const ev=event();let release,calls=0;const pending=new Promise(r=>release=r),h=harness(dbFor(ev),async()=>++calls===1?pending:status());h.api.beginVoiceTracking(ev,status(),[]);await flush();
 const old=ev.voiceTracking,waiting=h.api._test.runCheckSafe(1,null);await flush();await h.call('POST','/api/events/:id/voice-track/restart');const fresh=ev.voiceTracking;assert.notEqual(fresh,old);await flush();assert.equal(fresh.checksDone,1);
 release(status('alice'));await waiting;assert.equal(fresh.checksDone,1);assert.equal(fresh.sessionSeen.length,0);
});
test('replacement bot session cannot credit an old event, including a reused anchor channel',async()=>{
 const ev=event(),h=harness(dbFor(ev));h.api.beginVoiceTracking(ev,status(),[]);await flush();await h.api._test.runCheckSafe(1,status('alice','old-channel','new-session'));
 assert.equal(ev.voiceTracking.active,false);assert.equal(ev.voiceTracking.finishReason,'session-changed');assert.equal(ev.attended.length,0);assert.equal(ev.attendanceTracked,false);
});
test('tracking and Deafened live counts do not depend on any party lineup',async()=>{
 const ev=event();ev.parties=[];const h=harness(dbFor(ev),async()=>({...status('alice'),parties:[{channelId:'old-channel',connectedStates:[{id:'alice',deaf:true,mute:false}]}]}));
 await h.call('POST','/api/events/:id/voice-track/start');const live=await h.call('GET','/api/events/:id/voice-track/live');assert.equal(live.deafenedCount,1);assert.equal(live.trackedCount,1);assert.equal(live.noShowCount,0);
});
test('completed test can be stopped, but its timeout cannot stop a different real session',async()=>{
 const ev=event();let current=status(),stops=0;const h=harness(dbFor(ev),async url=>{if(url.endsWith('/stop')){stops++;current={active:false,sessionState:'inactive'};return{ok:true};}return current;});
 await h.call('POST','/api/admin/voice-test/start',{channelId:'200000000000000001'});h.clock.now+=180001;await h.api._test.pollVoiceTest();for(let i=0;i<3;i++){h.clock.now+=10001;await h.api._test.pollVoiceTest();}
 assert.equal(h.api._test.getVoiceTest().phase,'ended');await h.call('POST','/api/admin/voice-test/stop');assert.equal(stops,1);assert.equal(h.api._test.getVoiceTest(),null);
 current=status();h.clock.now=NOW;await h.call('POST','/api/admin/voice-test/start',{channelId:'200000000000000001'});current=status(null,'new-channel','new-real-session');h.clock.now=NOW+1200001;await h.api._test.pollVoiceTest();assert.equal(stops,1);assert.equal(h.api._test.getVoiceTest(),null);
});
test('stopping during test startup waits for its result and cleans only its own late-created session',async()=>{
 const ev=event();let release,current={active:false,sessionState:'inactive'},stops=0;const pending=new Promise(r=>release=r);
 const h=harness(dbFor(ev),async url=>{if(url.endsWith('/start')){current=await pending;return current;}if(url.endsWith('/stop')){stops++;current={active:false,sessionState:'inactive'};return{ok:true};}return current;});
 const starting=h.call('POST','/api/admin/voice-test/start',{channelId:'200000000000000001'});await flush();const stopping=h.call('POST','/api/admin/voice-test/stop');release(status());await Promise.all([starting,stopping]);assert.equal(stops,1);assert.equal(current.active,false);assert.equal(h.api._test.getVoiceTest(),null);
});
test('stop invalidates cached status, and an old pending read cannot repopulate it',async()=>{
 const ev=event();let active=true,release;const pending=new Promise(r=>release=r);let reads=0;
 const h=harness(dbFor(ev),async url=>{if(url.endsWith('/stop')){active=false;return{ok:true};}reads++;if(reads===1)return pending;return active?status():{active:false,sessionState:'inactive'};});
 const old=h.call('GET','/api/shotcaller/status');await flush();await h.call('POST','/api/shotcaller/stop');release(status('alice'));assert.equal((await old).active,false);assert.equal((await h.call('GET','/api/shotcaller/status')).active,false);
});


test('one unchanged Shotcaller session supports independent completed tracks for consecutive events',async()=>{
 const first=event(),second={...event(),id:2,title:'Second event',attended:[],parties:[]},db=dbFor(first);db.events.push(second);db.members.push({id:22,name:'Bob',owner:'bob',active:true});let stops=0;
 const h=harness(db,async url=>{if(url.endsWith('/stop'))stops++;return status();});
 h.api.beginVoiceTracking(first,status('alice'),[]);await flush();await h.api._test.runCheckSafe(1,status('alice'));await h.api._test.runCheckSafe(1,status('alice'));
 assert.equal(first.attendanceTracked,true);assert.deepEqual(first.attended,[11]);const runId=first.voiceTracking.runId;
 h.api.beginVoiceTracking(second,status('bob'),[]);await flush();await h.api._test.runCheckSafe(2,status('bob'));await h.api._test.runCheckSafe(2,status('bob'));
 assert.equal(second.attendanceTracked,true);assert.deepEqual(second.attended,[22]);assert.deepEqual(first.attended,[11]);assert.notEqual(second.voiceTracking.runId,runId);assert.equal(second.voiceTracking.sessionBinding,first.voiceTracking.sessionBinding);assert.equal(stops,0);
});

test('configured extra-channel transport failure retries rather than consuming a partial attendance snapshot',async()=>{
 const ev=event(),db=dbFor(ev);db.settings.voiceTrackExtraChannelIds=['extra'];let fail=true;
 const h=harness(db,async url=>{if(url.includes('/voice-presence')){if(fail)throw Error('extra-channel outage');return{channels:[{channelId:'extra',found:true,connectedStates:[{id:'alice'}]}]};}return status();});
 h.api.beginVoiceTracking(ev,status(),[]);await flush();assert.equal(ev.voiceTracking.checksDone,0);assert.equal(ev.attendanceTracked,false);
 fail=false;for(let i=0;i<3;i++)await h.api._test.runCheckSafe(1,status());
 assert.equal(ev.voiceTracking.checksDone,3);assert.equal(ev.attendanceTracked,true);assert.deepEqual(ev.attended,[11]);
});
test('manual cancellation discards an already pending voice read without stopping the bot session',async()=>{
 const ev=event();let release;const waiting=new Promise(r=>release=r),h=harness(dbFor(ev),async()=>waiting);
 h.api.beginVoiceTracking(ev,status(),[]);await flush();const pending=h.api._test.runCheckSafe(1,null);await flush();
 h.api.cancelVoiceTracking(ev);ev.attended=[];const writes=h.writes();release(status('alice'));await pending;
 assert.equal(ev.voiceTracking.active,false);assert(ev.voiceTracking.finishedAt);assert.deepEqual(ev.attended,[]);assert.equal(h.writes(),writes);
});
