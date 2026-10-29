// Integration tests: each test starts the real server on a random port with a throw-away data folder.
// Run with:  npm test   (needs Node 18+, no dependencies)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer(seedDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-test-'));
  if (seedDb) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seedDb));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, MEMBER_PASSCODE: 'm1', OFFICER_PASSCODE: 'o1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
  const base = `http://localhost:${port}`;
  const call = async (p, method = 'GET', body, token) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (name, code) => (await call('/api/login', 'POST', { name, passcode: code })).body.token;
  return {
    base, call, login,
    officer: await login('Boss', 'o1'), member: await login('Zed', 'm1'), other: await login('Other', 'm1'),
    // Waits for the process to actually exit before clearing its data directory - it now flushes a final save
    // on SIGTERM (see server.js), so deleting the directory out from under that write would be a race.
    stop: async () => { proc.kill(); await new Promise((r) => proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// Runs a test body against a fresh server and always cleans up.
const withServer = (name, fn, seed) => test(name, async () => { const s = await startServer(seed); try { await fn(s); } finally { await s.stop(); } });

const final=require('../attendance-finality');
const past=()=>new Date(Date.now()-7200000).toISOString();
const state=async s=>(await s.call('/api/state','GET',null,s.officer)).body;
const call=(s,url,method='GET',body)=>s.call(url,method,body,s.officer);
async function cast(s){
 const a=(await s.call('/api/members','POST',{name:'Alpha',role:'DPS'},s.member)).body;
 const b=(await s.call('/api/members','POST',{name:'Bravo',role:'Tank'},s.other)).body;
 const exp=(await call(s,'/api/export')).body;for(const m of exp.members)m.joinedAt=new Date(Date.now()-864e5).toISOString();
 assert.equal((await call(s,'/api/import','POST',exp)).status,200);return{a,b};
}
async function event(s,extra={}){const r=await call(s,'/api/events','POST',{title:'Integrity',type:'Castle Siege',start:past(),mandatory:true,points:10,attendanceModeOverride:'voice',...extra});assert.equal(r.status,200);return r.body;}
async function rules(s){assert.equal((await call(s,'/api/admin/compliance','PUT',{enabled:true,finalAfterMinutes:5,noShowLimit:1,noReplyLimit:0,minAttendance:0,minEvents:1})).status,200);}
async function allStats(s){const now=Date.now();return Promise.all(['/api/attendance-stats','/api/attendance-stats?windowDays=all&mandatoryOnly=1',`/api/attendance-stats?from=${now-864e5}&to=${now+864e5}`].map(async url=>(await call(s,url)).body));}
test('finality requires completed attendance and an expired PIN window',()=>{
 const now=Date.now(),ev={start:past(),attendanceTracked:true};assert(final(ev,now,5));
 assert(!final({...ev,attendanceTracked:false},now,5));assert(!final({...ev,voiceTracking:{active:true}},now,5));assert(!final({...ev,voiceTracking:{incomplete:true}},now,5));
 assert(final({...ev,autoAttended:true,voiceTracking:{incomplete:true}},now,5));
 const pin={...ev,pin:{at:new Date(now).toISOString()},pinWindowMinutes:60};assert(!final(pin,now+3600000,5));assert(final(pin,now+3600001,5));
});
withServer('untracked and incomplete events cannot lower any percentage or issue warnings',async s=>{
 const {b}=await cast(s),ev=await event(s);await call(s,`/api/events/${ev.id}/rsvp`,'POST',{memberId:b.id,status:'yes'});await rules(s);
 for(const rows of await allStats(s))assert.equal(rows.find(x=>x.owner==='Other').counted,0);
 await call(s,'/api/admin/compliance/run','POST',{});assert.equal((await state(s)).warnings.length,0);
 const exp=(await call(s,'/api/export')).body,e=exp.events.find(x=>x.id===ev.id);e.attendanceTracked=true;e.voiceTracking={active:false,incomplete:true,finishedAt:Date.now()};await call(s,'/api/import','POST',exp);
 for(const rows of await allStats(s))assert.equal(rows.find(x=>x.owner==='Other').counted,0);
 await call(s,'/api/admin/compliance/run','POST',{});assert.equal((await state(s)).warnings.length,0);
});
withServer('PIN opening/reopening defers statistics and warnings until the actual closing time',async s=>{
 const {a,b}=await cast(s),ev=await event(s,{attendanceModeOverride:'pin',pinEnabled:true,pinWindowMinutes:60});
 await call(s,`/api/events/${ev.id}/rsvp`,'POST',{memberId:b.id,status:'yes'});await call(s,`/api/events/${ev.id}/attendance`,'POST',{memberIds:[a.id]});await rules(s);
 const opened=await call(s,`/api/events/${ev.id}/pin/send`,'POST',{mode:'new'});assert.equal(opened.body.pinInfo.state,'open');
 for(const rows of await allStats(s))assert.equal(rows.find(x=>x.owner==='Other').counted,0);
 await call(s,'/api/admin/compliance/run','POST',{});assert.equal((await state(s)).warnings.length,0);
 const exp=(await call(s,'/api/export')).body;exp.events.find(x=>x.id===ev.id).pin.at=new Date(Date.now()-7200000).toISOString();await call(s,'/api/import','POST',exp);
 for(const rows of await allStats(s))assert.equal(rows.find(x=>x.owner==='Other').counted,1);
 await call(s,'/api/admin/compliance/run','POST',{});assert.equal((await state(s)).warnings.filter(w=>w.ownerKey==='Other' && w.status==='active').length,1);
 await call(s,`/api/events/${ev.id}/pin/send`,'POST',{mode:'reopen'});for(const rows of await allStats(s))assert.equal(rows.find(x=>x.owner==='Other').counted,0);
});
const seeded=()=>({nextId:100,members:[{id:1,owner:'Zed',name:'Player',active:true,role:'DPS',rank:'Member'}],events:[{id:2,title:'Running track',type:'Castle Siege',start:past(),mandatory:true,attendanceModeOverride:'voice',rsvps:{1:'yes'},attended:[1],attendanceTracked:true,autoAttended:false,points:10,parties:[],voiceTracking:{active:true,runId:'integrity',sessionBinding:'id:session',gateAt:Date.now()+60000,checksDone:1,sessionSeen:[1],seen:{},startedAt:Date.now()},attendanceUndo:{attended:[],autoAttended:false,attendanceTracked:false,savedBy:'Voice',savedAt:past()}}],points:[]});
for(const [action,body] of [['attendance/undo',{}],['attendance',{memberIds:[]}],['attendance-status',{owner:'Zed',status:'noshow'}]])withServer(action+' cancels the run; Finish cannot resurrect sightings',async s=>{
 const changed=await call(s,'/api/events/2/'+action,'POST',body);assert.equal(changed.status,200,JSON.stringify(changed.body));
 const ev=(await state(s)).events.find(e=>e.id===2);assert.deepEqual(ev.attended,[]);assert.equal(ev.voiceTracking.active,false);assert(ev.voiceTracking.finishedAt);
 assert.deepEqual((await call(s,'/api/events/2/voice-track/finish','POST',{})).body.attended,[]);
},seeded());
withServer('actual roster-save button preserves hidden credits even with a stale client snapshot',async s=>{
 const {a,b}=await cast(s),ev=await event(s);await call(s,`/api/events/${ev.id}/attendance`,'POST',{memberIds:[a.id,b.id]});
 const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),start=app.indexOf("  else if (a === 'roster-save') {"),end=app.indexOf("  else if (a === 'attendance-undo')",start),block=app.slice(start+"  else if (a === 'roster-save') {".length,end).trim();let done;const saved=new Promise(r=>done=r),vm=require('node:vm');
 vm.runInNewContext('(function(){'+block.slice(0,-1)+'})()',{d:{id:ev.id},S:{events:[{...ev,attended:[]}],members:[a,b]},UI:{},byId:(xs,id)=>xs.find(e=>e.id==id),document:{querySelectorAll:()=>[{dataset:{m:String(b.id)},value:'participated'}]},ROSTER6:{participated:{attended:true,rsvp:'yes'},noreply:{attended:false,rsvp:'none'}},api:async(url,method,body)=>{const r=await call(s,url,method,body);if(r.status>=400)throw Error(JSON.stringify(r.body));return r.body;},toast(msg,error){assert(!error,msg);},refresh:async()=>done()});await saved;
 assert.deepEqual((await state(s)).events.find(e=>e.id===ev.id).attended.sort((a,b)=>a-b),[a.id,b.id]);
});
withServer('points remain opt-in and existing event credit recalculates without duplication',async s=>{
 const {a}=await cast(s),ev=await event(s);assert.equal((await state(s)).settings.pointsEnabled,false);
 await call(s,`/api/events/${ev.id}/attendance`,'POST',{memberIds:[a.id]});assert.equal((await state(s)).points.length,0);
 await call(s,'/api/settings','PUT',{pointsEnabled:true});await call(s,`/api/events/${ev.id}/attendance`,'POST',{memberIds:[a.id]});
 let entries=(await state(s)).points.filter(p=>p.eventId===ev.id);assert.equal(entries[0].delta,10);const ledgerId=entries[0].id;
 await call(s,`/api/events/${ev.id}`,'PUT',{...ev,points:25});entries=(await state(s)).points.filter(p=>p.eventId===ev.id);assert.equal(entries.length,1);assert.equal(entries[0].id,ledgerId);assert.equal(entries[0].delta,25);
 await call(s,`/api/events/${ev.id}`,'PUT',{...ev,points:0});assert.equal((await state(s)).points.filter(p=>p.eventId===ev.id).length,0);
});
