const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
function helper(name){const file=path.join(__dirname,name),raw=fs.readFileSync(file,'utf8'),box={exports:{}};const discord=name==='discord.test.js';vm.runInNewContext(raw.slice(0,raw.indexOf(discord?'before(async':'// Runs a test body'))+(discord?'\nmodule.exports={startServer,stopServer,discordLogin,call,sessions,getBase:()=>base};':'\nmodule.exports=startServer;'),{module:box,require:createRequire(file),__dirname,process:discord?{...process,env:{...process.env,SUPPORT_DISCORD_USER_IDS:'100000000000000009'}}:process,Buffer,URL,URLSearchParams,console,setTimeout,clearTimeout,fetch});return box.exports;}
test('real HTTP one-time login, redaction across state/detail/audit, replay rejection and revocation',async()=>{
 const id='100000000000000001',other='100000000000000002',start=new Date(Date.now()-864e5).toISOString();
 const seed={members:[{id:1,owner:id,name:'Freki',active:true,role:'DPS',joinedAt:'2020-01-01',specialization:'Long specialization',questlogs:[{url:'https://questlog.gg/build/test',label:'Visible build'}]}],users:{[id]:{id,name:'Freki'}},profiles:{[id]:{notes:'Visible personal note'}},leaves:[{id:3,ownerKey:id,from:'2020-01-01',to:'2020-01-02',status:'approved',reason:'Visible leave reason'}],warnings:[{id:4,ownerKey:id,name:'Freki',status:'active',reason:'Visible warning'}],events:[{id:2,title:'Siege',start,mandatory:true,parties:[{name:'Party',members:[1],leader:1}],rsvps:{1:'yes'},attended:[1],attendanceTracked:true,voiceTracking:{active:false,checksDone:3,seen:{[id]:{memberId:1,memberName:'Freki',channelId:other,credited:true}}}}],auditLog:[{id:5,byKey:id,byName:'Freki',at:start,action:'test.read',targetName:'Siege',description:'Visible audit <@'+id+'>',targetId:other}],settings:{pointsEnabled:false,legacyPassword:'PASSWORD_CANARY',legacyBotToken:'TOKEN_CANARY'}};
 const s=await helper('api.test.js')(seed);try{
 assert.equal((await s.call('/api/admin/support-access/generate','POST',{},s.member)).status,403);
 assert.equal((await s.call('/api/admin/support-access','PUT',{password:'Retired password'},s.officer)).status,404);
 const generated=await s.call('/api/admin/support-access/generate','POST',{},s.officer);assert.equal(generated.status,200);const code=generated.body.code;assert.equal(code.length,12);
 const status=await s.call('/api/admin/support-access','GET',null,s.officer);assert(!JSON.stringify(status).includes(code));assert.equal(status.body.codePending,true);
 const login=()=>fetch(s.base+'/api/support/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SupportAI',code})});
 const attempts=await Promise.all([login(),login()]);assert.equal(attempts.filter(r=>r.status===200).length,1);const success=attempts.find(r=>r.status===200),cookie=success.headers.get('set-cookie').split(';')[0];assert(success.headers.get('set-cookie').includes('HttpOnly'));assert.deepEqual(await success.json(),{ok:true});assert.equal((await login()).status,401);
 const get=async url=>{const r=await fetch(s.base+url,{headers:{Cookie:cookie}});return{status:r.status,body:await r.json()};};
 let owner;
 for(const url of ['/api/state','/api/events/2/tracking-state','/api/admin/audit','/api/attendance-stats','/api/admin/diagnostics','/api/config']){
  const r=await get(url);assert.equal(r.status,200,url);const text=JSON.stringify(r.body);for(const canary of [id,other,'PASSWORD_CANARY','TOKEN_CANARY',code])assert(!text.includes(canary),url+' leaked '+canary);
  if(url==='/api/state'){assert.equal(r.body.members[0].name,'Freki');owner=r.body.members[0].owner;assert.match(owner,/^ref_/);assert.equal(r.body.users[0].id,owner);assert.equal(r.body.profiles[owner].notes,'Visible personal note');assert.equal(r.body.leaves[0].reason,'Visible leave reason');assert.equal(r.body.warnings[0].reason,'Visible warning');assert.equal(r.body.members[0].questlogs[0].label,'Visible build');}
  if(url.endsWith('tracking-state'))assert.equal(Object.keys(r.body.voiceTracking.seen)[0],owner);
 }
 const original=(await s.call('/api/state','GET',null,s.officer)).body;assert.equal(original.members[0].owner,id);assert.equal(original.settings.legacyPassword,'PASSWORD_CANARY','redaction never modifies source or admin results');
 const audit=(await s.call('/api/admin/audit','GET',null,s.officer)).body;assert(!JSON.stringify(audit).includes(code));assert(JSON.stringify(audit).includes('support.code.generate'));assert(JSON.stringify(audit).includes('support.login'));
 const renewed=await s.call('/api/admin/support-access/generate','POST',{},s.officer);assert.equal((await get('/api/state')).status,401);
 await s.call('/api/admin/support-access/revoke','POST',{},s.officer);
 const revoked=await fetch(s.base+'/api/support/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SupportAI',code:renewed.body.code})});assert.equal(revoked.status,401);
 }finally{await s.stop();}
});
test('one-time sign-in works with Discord OAuth enabled and old Discord support grants are gone',async()=>{
 const h=helper('discord.test.js');await h.startServer();try{
 const officer=await h.discordLogin('100000000000000001',['900000000000000001']);h.sessions.officer=officer.cookie;
 const issued=await h.call('/api/admin/support-access/generate','POST',{},'officer');assert.equal(issued.status,200);
 const response=await fetch(h.getBase()+'/api/support/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SupportAI',code:issued.body.code})});assert.equal(response.status,200);h.sessions.support=response.headers.get('set-cookie').split(';')[0];
 assert.equal((await h.call('/api/state','GET',null,'support')).body.user.readOnly,true);
 const bad=await fetch(h.getBase()+'/api/support/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://wrong.invalid'},body:'{}'});assert.equal(bad.status,403);
 const legacy=await h.discordLogin('100000000000000009');assert(!legacy.cookie || (await (async()=>{h.sessions.legacy=legacy.cookie;return h.call('/api/state','GET',null,'legacy');})()).body.user.role!=='officer');
 }finally{await h.stopServer();}
});
