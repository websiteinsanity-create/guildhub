'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {startGuild}=require('./hf2-helpers');
const OFF='810000000000000001',OWNER='810000000000000002',COACH='810000000000000003',GUEST='810000000000000004',OTHER='810000000000000005';
const BW={primaryWeapon:'Staff',secondaryWeapon:'Crossbow'},T='2026-10-01T18:00:00.000Z';
function seed(){return {nextId:1000,users:Object.fromEntries([OFF,OWNER,COACH,GUEST,OTHER].map(k=>[k,{id:k,name:'User'+k.slice(-1),inGuild:k!==GUEST,accepted:k!==GUEST,lastLogin:new Date().toISOString()}])),members:[{id:1,owner:OWNER,name:'Inactive student',active:false,...BW,builds:[]},{id:2,owner:COACH,name:'Coach',active:true,...BW}],events:[],points:[],settings:{applications:{enabled:true},coachUserIds:[COACH]},guestCoaches:[{id:5,discordId:GUEST,via:'invite',name:'Guest'}],coachLinks:[{id:6,coach:COACH,class:'Battleweaver'},{id:7,coach:GUEST,class:'Battleweaver'}],vods:[{id:10,owner:OWNER,postedBy:COACH,title:'Private',type:'Wargame',recordedDate:'2026-10-01',note:'original',url:'https://youtu.be/abcdefghijk',videoId:'abcdefghijk',visibility:'private',reviews:[{id:11,by:COACH,note:'Review',at:T}],finished:false}],vodMarkers:[{id:12,vodId:10,createdBy:COACH,createdAt:T,timestamp:1,note:'marker',strokes:[]}],gearScreens:[{id:13,memberId:1,sectionId:14,images:['gearshot-aaaaaaaaaaaa.png'],previews:{'gearshot-aaaaaaaaaaaa.png':'gearthumb-bbbbbbbbbbbb.png'}}],gearSectionTypes:[{id:14,label:'Gear'}],gearFolder:[{id:15,memberId:1,image:'gearfolder-cccccccccccc.png',postedBy:OFF}],gearChat:[{id:16,memberId:1,text:'Hello'}],gearSkills:{'1:main':{active:[]}},gearSkillOwnership:{[OWNER]:[]},gearPotentials:{'1:main':{assignments:{},revision:2}},gearLinks:{'1:main':[]},partyBuilderNote:'Preserve me'};}
const start=()=>startGuild({seed:seed(),secret:'fictional-hotfix5-only',guild:'111111111111111111',env:{DISCORD_OFFICER_USER_IDS:OFF,ROLE_REFRESH_INTERVAL_MS:'3600000',SCHEDULER_INTERVAL_MS:'3600000'}});
const mutations=()=>[['PUT','/api/vods/10',{note:'forbidden'}],['DELETE','/api/vods/10'],['PUT','/api/vods/10',{visibility:'everyone'}],['POST','/api/vods/10/markers',{timestamp:2,note:'forbidden'}],['PUT','/api/vods/10/markers/12',{timestamp:2,note:'forbidden'}],['DELETE','/api/vods/10/markers/12'],['POST','/api/vods/10/reviews',{note:'forbidden'}],['PUT','/api/vods/10/reviews/11',{note:'forbidden'}],['DELETE','/api/vods/10/reviews/11'],['POST','/api/vods/10/reviews/11/resend',{}],['PUT','/api/vods/10/finished',{finished:true}],['POST','/api/vods',{owner:OWNER,url:'https://youtu.be/abcdefghijk',type:'Wargame',recordedDate:'2026-10-01'}]];
const projection=x=>({vods:x.vods,vodMarkers:x.vodMarkers,nextId:x.nextId,auditLog:x.auditLog});
test('SEC-01 accepted/unaccepted departed coaches: every VOD mutation denied on old and fresh sessions, legitimate guest retained',async()=>{
 for(const accepted of [true,false]){const s=seed();s.users[COACH].accepted=accepted;const g=await startGuild({seed:s,secret:'fictional-hf5',guild:'111111111111111111',env:{DISCORD_OFFICER_USER_IDS:OFF}});try{
  const old=await g.login(COACH),off=await g.login(OFF),owner=await g.login(OWNER);const guest=await g.login(GUEST,[],{inGuild:false});
  const fresh=await g.login(COACH,[],{inGuild:false}); // authoritative OAuth departure changes the shared live record
  const before=projection((await g.api('GET','/api/export',{cookie:off})).json);
  for(const cookie of [old,fresh]){
   const state=(await g.api('GET','/api/state',{cookie})).json;assert.equal(state.user.role,'applicant');assert.deepEqual(state.vods,[]);assert.deepEqual(state.myStudents,[]);
   for(const [method,url,body] of mutations())assert.equal((await g.api(method,url,{cookie,body})).status,403,accepted+' '+method+' '+url);
   assert.equal((await g.api('GET','/api/gearthreads/2',{cookie})).status,403);
  }
  assert.deepEqual(projection((await g.api('GET','/api/export',{cookie:off})).json),before);
  assert.equal((await g.api('GET','/api/state',{cookie:owner})).json.vods[0].id,10,'LOA owner keeps content');
  assert.equal((await g.api('GET','/api/state',{cookie:guest})).json.vods[0].id,10,'B04 guest retains class access');
  assert.equal((await g.api('POST','/api/vods/10/markers',{cookie:guest,body:{timestamp:5,note:'Guest own marker'}})).status,200);
  assert.equal((await g.api('PUT','/api/vods/10',{cookie:guest,body:{note:'no'}})).status,403);
 }finally{await g.close();}}
});
test('SEC-03 removing coach revokes postedBy visibility, while owner and officer retain historical VOD',async()=>{const g=await start();try{
 const off=await g.login(OFF),c=await g.login(COACH),owner=await g.login(OWNER);
 assert.equal((await g.api('GET','/api/state',{cookie:c})).json.vods.length,1);
 assert.equal((await g.api('PUT','/api/admin/coaches',{cookie:off,body:{userIds:[]}})).status,200);
 const st=(await g.api('GET','/api/state',{cookie:c})).json;assert.equal(st.isCoach,false);assert.deepEqual(st.vods,[]);
 for(const [method,url,body] of mutations())assert.equal((await g.api(method,url,{cookie:c,body})).status,403);
 for(const cookie of [owner,off])assert.equal((await g.api('GET','/api/state',{cookie})).json.vods[0].id,10);
 await g.login(OWNER,[],{inGuild:false});assert.equal((await g.api('GET','/api/state',{cookie:off})).json.vods[0].id,10,'officer reads departed owner history');
 assert.equal((await g.api('PUT','/api/vods/10',{cookie:off,body:{note:'Officer historical edit'}})).status,200);
 }finally{await g.close();}});
test('SEC-04 rejected VOD requests leave content, ID sequence and audit identical, also after another save and restart',async()=>{const g=await start();try{
 let off=await g.login(OFF);const cookie=await g.login(OWNER);const exp=async()=>projection((await g.api('GET','/api/export',{cookie:off})).json);const before=await exp();
 const invalid=[['PUT','/api/vods/10',{note:'must not stick',visibility:'class',visibleClass:'Invalid class'}],['PUT','/api/vods/10',{note:'must not stick',type:'Invalid',recordedDate:'2026-10-01'}],['PUT','/api/vods/10',{type:'Siege',recordedDate:'2026-10-01',visibility:'Invalid'}],['POST','/api/vods',{url:'not Youtube',type:'Wargame',recordedDate:'2026-10-01'}],['POST','/api/vods/10/markers',{timestamp:-1,note:'no'}],['PUT','/api/vods/10/markers/12',{timestamp:-1,note:'no'}],['POST','/api/vods/10/reviews',{note:''}],['PUT','/api/vods/10/reviews/11',{note:'tamper'}],['DELETE','/api/vods/10/markers/999',{}],['DELETE','/api/vods/10/reviews/999',{}]];
 for(const [method,url,body] of invalid){const r=await g.api(method,url,{cookie,body});assert.ok([400,403,404].includes(r.status),method+' '+url+' '+r.status);assert.deepEqual(await exp(),before);}
 assert.equal((await g.api('PUT','/api/prefs',{cookie,body:{auditTest:true}})).status,200);
 await g.restart();off=await g.login(OFF);assert.deepEqual(await exp(),before);
 }finally{await g.close();}});
test('SEC-02 complete current and legacy raw backup round-trip preserves all content and nested relationships',async()=>{const g=await start();try{
 const off=await g.login(OFF);const api=(m,p,b)=>g.api(m,p,{cookie:off,body:b});let before=(await api('GET','/api/export')).json;
 for(const modern of [true,false]){const payload=structuredClone(before);if(!modern)delete payload._guildhubBackup;
  assert.equal((await api('POST','/api/import',payload)).status,200);
  const after=(await api('GET','/api/export')).json;assert.equal(after.auditLog.at(-1).action,'security.backup.import');
  assert.ok(after.nextId>before.nextId);const comparable=structuredClone(after);comparable.auditLog=before.auditLog;comparable.nextId=before.nextId;assert.deepEqual(comparable,before);before=after;
 }
 await g.restart();const fresh=await g.login(OFF);const after=(await g.api('GET','/api/export',{cookie:fresh})).json;
 for(const key of ['vods','vodMarkers','gearScreens','gearFolder','gearChat','coachLinks','guestCoaches','gearSkills','gearSkillOwnership','gearPotentials','gearLinks','gearSectionTypes','partyBuilderNote'])assert.deepEqual(after[key],before[key],key);
 }finally{await g.close();}});
test('SEC-02 unsupported, malformed, duplicate-ID, dangling-reference and prototype-bearing backups fail atomically',async()=>{const g=await start();try{
 const off=await g.login(OFF),call=(m,p,b)=>g.api(m,p,{cookie:off,body:b});const original=(await call('GET','/api/export')).json;
 const cases=[x=>x.settings.coachUserIds='invalid',x=>x.settings.shotcaller=[],x=>x.gearScreens[0].images={},x=>x.gearScreens[0].previews=[],x=>x.gearSkillOwnership[OWNER]={},x=>x.gearPotentials['1:main'].assignments=[],x=>x.vods={},x=>x.gearScreens=null,x=>x.users=[],x=>x.members.push({...x.members[0]}),x=>x.vodMarkers[0].vodId=99,x=>x.gearScreens[0].memberId=99,x=>x._guildhubBackup.formatVersion=999,x=>x.futureSecurityStore=[],x=>x.members[0].builds={},x=>x.nextId=-1,x=>Object.defineProperty(x.users,'__proto__',{value:{role:'officer'},enumerable:true})];
 for(const mutate of cases){const bad=structuredClone(original);mutate(bad);assert.equal((await call('POST','/api/import',bad)).status,400);assert.deepEqual((await call('GET','/api/export')).json,original);}
 await g.restart();const c=await g.login(OFF);const e=(await g.api('GET','/api/export',{cookie:c})).json;for(const key of ['vods','gearScreens','coachLinks'])assert.deepEqual(e[key],original[key]);
 }finally{await g.close();}});
test('SEC-02 commit failure preserves old bytes and removes temporary restore file',()=>{const backup=require('../backup'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'gh-hf5-restore-')),file=path.join(dir,'db.json');fs.writeFileSync(file,'{"old":true}');const rename=fs.renameSync;try{
 fs.renameSync=()=>{throw Error('simulated disk/permission failure');};assert.throws(()=>backup.commitDatabase(file,{new:true}),e=>e.status===503);assert.equal(fs.readFileSync(file,'utf8'),'{"old":true}');assert.deepEqual(fs.readdirSync(dir),['db.json']);
 }finally{fs.renameSync=rename;fs.rmSync(dir,{recursive:true,force:true});}});
test('SEC-02 HTTP commit failure returns 503 without replacing in-memory state or persistent bytes',async()=>{const g=await start();try{
 const preload=path.join(g.dir,'simulate-restore-error.cjs');fs.writeFileSync(preload,"const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(a,b)=>{if(String(a).includes('.restore-'))throw Error('Simulated permission failure');return rename(a,b)};");
 await g.restart({NODE_OPTIONS:'--require '+preload});const off=await g.login(OFF),api=(m,p,b)=>g.api(m,p,{cookie:off,body:b});
 const before=(await api('GET','/api/export')).json;const bad=structuredClone(before);bad.partyBuilderNote='must not be installed';
 assert.equal((await api('POST','/api/import',bad)).status,503);assert.deepEqual((await api('GET','/api/export')).json,before);
 await g.stop();const disk=JSON.parse(fs.readFileSync(path.join(g.dir,'db.json'),'utf8'));assert.equal(disk.partyBuilderNote,'Preserve me');assert.deepEqual(disk.vods,before.vods);assert.ok(!fs.readdirSync(g.dir).some(x=>x.includes('.restore-')));
 }finally{await g.close();}});
test('SEC-02 supported JSON exports larger than the legacy 2 MB route cap restore without truncation',async()=>{const g=await start();try{
 const off=await g.login(OFF),api=(m,p,b)=>g.api(m,p,{cookie:off,body:b});const data=(await api('GET','/api/export')).json;data.prefs[OWNER]={largeBackupCanary:'x'.repeat(2100000)};
 assert.equal((await api('POST','/api/import',data)).status,200);const after=(await api('GET','/api/export')).json;assert.equal(after.auditLog.at(-1).action,'security.backup.import');after.auditLog=data.auditLog;after.nextId=data.nextId;assert.deepEqual(after,data);
 }finally{await g.close();}});
