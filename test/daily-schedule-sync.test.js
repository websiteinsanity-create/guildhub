const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const logic=source.slice(source.indexOf('let DAILY_SCHEDULE_BANNER'),source.indexOf('let ticking = false;'));
const dates=source.slice(source.indexOf('const dateFormatter ='),source.indexOf('// Who receives the PIN'));
function harness(previous,clock=Date.parse('2026-11-05T12:00:00Z'),shared){
 let now=clock,dirty=false,persisted,seq=0;const timers=new Map(),calls=[];
 const messages=shared || new Map(),nonces=new Map();let failure=false,failAfterSend=false,editHold=null,failBanner=false;
 const db=previous || {settings:{dailySchedulePost:{channelId:'channel',mentionRoleIds:[],postHour:8,enabled:false,current:null}},events:[],members:[]};
 const discord={actionButtons:rows=>rows,
  postMessage:async(channel,payload)=>{calls.push(['POST',channel,payload]);if(failure || failBanner && !payload.components)return {ok:false,error:'Temporary Discord error'};
    let id=nonces.get(payload.nonce);if(!id || messages.get(id)?.deleted){id='m'+(++seq);while(messages.has(id))id='m'+(++seq);nonces.set(payload.nonce,id);messages.set(id,{channel,...payload,deleted:false});}
    if(failAfterSend){failAfterSend=false;throw Error('Response lost after send');}return {ok:true,id};},
  editMessage:async(channel,id,payload)=>{if(editHold && id!==db.settings.dailySchedulePost.current?.bannerMessageId)await editHold;calls.push(['PATCH',id,payload]);if(failure)return {ok:false,status:503,error:'Temporary Discord error'};
    if(!messages.has(id) || messages.get(id).deleted)return {ok:false,status:404,missingMessage:true,error:'Unknown Message'};
    Object.assign(messages.get(id),payload);return {ok:true};},
  deleteMessage:async(channel,id)=>{calls.push(['DELETE',id]);if(failure)return {ok:false,error:'Temporary Discord error'};if(messages.has(id))messages.get(id).deleted=true;return {ok:true};}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const box={db,discord,crypto,Date:Clock,Intl,JSON,Set,Map,Number,Math,String,Object,process:{env:{DAILY_SCHEDULE_SYNC_MS:'10'}},console:{error(){}},PUBLIC_DIR:'.',fs:{readFileSync(){throw Error('no banner')}},path,
  shuttingDown:false,flushTimer:null,flushInFlight:null,config:{defaultTimezone:'Europe/Berlin'},afterPersist:()=>{},tickHooks:[],route:()=>{},need:(v,c,m)=>{if(!v)throw Error(m);},audit:{log(){}},
  unix:iso=>Math.floor(Date.parse(iso)/1000),findEvent:id=>db.events.find(e=>e.id===Number(id)),
  save:()=>{dirty=true;},get dirty(){return dirty;},set dirty(v){dirty=v;},
  flush:async()=>{persisted=JSON.parse(JSON.stringify(db));dirty=false;box.afterPersist();},
  setTimeout:(fn,delay)=>{const id={unref(){}};timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)};
 vm.createContext(box);vm.runInContext(dates+logic+'\nglobalThis.api={ensureScheduleMessage,dailyScheduleTick,queueScheduleSync,gameDay};',box);
 const settle=async()=>{for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r));};
 return {db,calls,messages,api:box.api,get now(){return now;},get persisted(){return persisted;},setFailure:v=>failure=v,setBannerFailure:v=>failBanner=v,holdEdit:p=>editHold=p,loseResponse:()=>failAfterSend=true,
  event:(id,title='Event '+id,at=now+3600000)=>{const ev={id,title,start:new Date(at).toISOString(),rsvps:{},mandatory:false};db.events.push(ev);return ev;},
  flush:box.flush,settle,save:async()=>{box.save();await box.flush();},
  advance:async ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await settle();},
  post:async()=>{const r=await box.api.ensureScheduleMessage(box.api.gameDay(now));await settle();return r;},
  visible:()=>[...messages.values()].filter(m=>!m.deleted)};
}
async function publish(h){const e=h.event(1);assert.equal((await h.post()).ok,true);return e;}
test('today create/delete/rename/time/moves synchronize existing block; tomorrow-only changes do nothing',async()=>{
 const h=harness(),e=await publish(h),cur=h.db.settings.dailySchedulePost.current,id=cur.events[1],banner=cur.bannerMessageId;
 e.title='Renamed';e.start=new Date(h.now+7200000).toISOString();await h.save();await h.advance(10);assert.match(h.messages.get(id).content,/Renamed/);assert.equal(cur.events[1],id);assert.equal(cur.bannerMessageId,banner);
 const extra=h.event(2);await h.save();await h.advance(10);assert(cur.events[2]);h.db.events=h.db.events.filter(e=>e.id!==2);await h.save();await h.advance(10);assert.equal(cur.events[2],undefined);
 e.start=new Date(h.now+86400000).toISOString();await h.save();await h.advance(10);assert(h.messages.get(id).deleted);assert.equal(cur.events[1],undefined);
 let count=h.calls.length;e.title='Tomorrow only';await h.save();await h.advance(10);assert.equal(h.calls.length,count);
 e.start=new Date(h.now+3600000).toISOString();await h.save();await h.advance(10);assert(cur.events[1]);assert.match(h.messages.get(cur.events[1]).content,/Tomorrow only/);
});
test('deleting a Discord event message replaces only the confirmed missing message',async()=>{
 const h=harness(),e=await publish(h),cur=h.db.settings.dailySchedulePost.current,old=cur.events[1];h.messages.get(old).deleted=true;e.title='Changed';await h.save();await h.advance(10);
 assert.notEqual(cur.events[1],old);assert.equal(h.visible().length,2);assert.equal(h.calls.filter(c=>c[0]==='POST').length,3);
});
test('Discord transient failure does not repost or roll back edits; recovery patches same ID',async()=>{
 const h=harness(),e=await publish(h),cur=h.db.settings.dailySchedulePost.current,id=cur.events[1];h.setFailure(true);e.title='Saved despite Discord outage';await h.save();await h.advance(10);
 assert(cur.syncError);assert.equal(h.calls.filter(c=>c[0]==='POST').length,2);assert.equal(h.persisted.events[0].title,e.title);h.setFailure(false);await h.advance(1000);
 assert.equal(cur.events[1],id);assert.match(h.messages.get(id).content,/Saved despite/);assert.equal(cur.syncError,null);
});
test('rapid changes coalesce and latest saved event wins',async()=>{
 const h=harness(),e=await publish(h);const before=h.calls.length;for(let i=0;i<20;i++){e.title='Latest '+i;await h.save();}await h.advance(10);
 assert.equal(h.calls.filter(c=>c[0]==='PATCH' && c[1]===h.db.settings.dailySchedulePost.current.events[1]).length,1);assert.match(h.messages.get(h.db.settings.dailySchedulePost.current.events[1]).content,/Latest 19/);
});
test('restart rediscovers saved pending synchronization without publishing duplicates',async()=>{
 const h=harness(),e=await publish(h);e.title='Pending at restart';await h.save();const restarted=harness(h.persisted,h.now+100,h.messages);
 await restarted.api.dailyScheduleTick();await restarted.advance(10);assert.match(restarted.messages.get(restarted.db.settings.dailySchedulePost.current.events[1]).content,/Pending at restart/);assert.equal(restarted.calls.filter(c=>c[0]==='POST').length,0);
});
test('publication hour stays unchanged and future-only changes do not create a new schedule',async()=>{
 const h=harness(null,Date.parse('2026-11-05T05:00:00Z'));h.db.settings.dailySchedulePost.enabled=true;h.event(1,'Tomorrow',h.now+86400000);await h.save();await h.advance(10);await h.api.dailyScheduleTick();assert.equal(h.calls.length,0);
 await h.advance(2*3600000);await h.api.dailyScheduleTick();assert.equal(h.visible().length,1);assert.match(h.visible()[0].content,/Today's schedule/);
});
test('game day boundary uses the existing guild timezone conventions; old pending work cannot post future day',async()=>{
 const h=harness(null,Date.parse('2026-11-05T02:59:59Z')),e=h.event(1,'Boundary',Date.parse('2026-11-05T02:59:59Z'));await h.post();e.start=new Date(h.now).toISOString();e.title='Pending before reset';await h.save();await h.advance(2000);assert.equal(h.calls.filter(c=>c[0]==='POST').length,2);
 assert.equal(h.api.gameDay(Date.parse('2026-11-05T03:00:00Z')),'2026-11-05');
});
test('serialized concurrent publication creates only one banner and one message per event',async()=>{
 const h=harness();h.event(1);await Promise.all([h.post(),h.post(),h.post()]);assert.equal(h.visible().length,2);
});
test('lost POST response retries with the same nonce, without a duplicate message',async()=>{
 const h=harness();h.event(1);h.loseResponse();assert.equal((await h.post()).ok,false);await h.advance(1000);assert.equal(h.visible().length,2);assert(h.calls.filter(c=>c[0]==='POST').every(c=>c[2].nonce));
});

test('deleted banner is restored without reposting the event messages',async()=>{
 const h=harness();await publish(h);const cur=h.db.settings.dailySchedulePost.current,banner=cur.bannerMessageId,id=cur.events[1];h.messages.get(banner).deleted=true;await h.post();assert.notEqual(cur.bannerMessageId,banner);assert.equal(cur.events[1],id);assert.equal(h.visible().length,2);
});

test('a change saved during a pending Discord edit wins after the older edit finishes',async()=>{
 const h=harness(),e=await publish(h),id=h.db.settings.dailySchedulePost.current.events[1];let release;h.holdEdit(new Promise(r=>release=r));e.title='Older in flight';await h.save();await h.advance(10);e.title='Newest saved';await h.save();await h.advance(10);release();await h.settle();await h.advance(10);assert.match(h.messages.get(id).content,/Newest saved/);assert.equal(h.visible().length,2);
});
test('time changes retain chronological ordering using the existing message slots',async()=>{
 const h=harness();const a=h.event(1,'First',h.now+3600000),b=h.event(2,'Second',h.now+7200000);await h.post();b.start=new Date(h.now+1800000).toISOString();await h.save();await h.advance(10);const posts=h.visible().filter(m=>m.components);assert.match(posts[0].content,/Second/);assert.match(posts[1].content,/First/);assert.equal(h.calls.filter(c=>c[0]==='POST').length,3);
});

test('a decorative-banner failure does not block the event messages, and retries restore the banner',async()=>{
 const h=harness();h.event(1);h.setBannerFailure(true);assert.equal((await h.post()).ok,false);const id=h.db.settings.dailySchedulePost.current.events[1];assert(id);assert.equal(h.visible().length,1);h.setBannerFailure(false);await h.advance(1000);assert(h.db.settings.dailySchedulePost.current.bannerMessageId);assert.equal(h.db.settings.dailySchedulePost.current.events[1],id);assert.equal(h.visible().length,2);
});
