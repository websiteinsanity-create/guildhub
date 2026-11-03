const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {startFakeDiscord}=require('./fake-discord');
const A='111111111111111111',B='222222222222222222',ADMIN='333333333333333333',MEMBER='444444444444444444',PARTNER='555555555555555555',AROLE='666666666666666666',PROLE='777777777777777777';
test('Insanity OAuth administrators open and administer the existing Alliance Portal with their unchanged cookie',async()=>{
 const fake=await startFakeDiscord(),calls=[],bridge={id:'test-bridge',state:'active',active:true,desired:true,mainEnabled:{[A]:true,[B]:true},canManageMains:false,sessions:[],events:[],allowAllianceManage:false,audio:{bufferMs:40}};
 const bot=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=raw?JSON.parse(raw):null;calls.push({url:req.url,admin:req.headers['x-shotcaller-admin'],body});res.setHeader('content-type','application/json');
  if(req.url.endsWith('/callers'))return res.end(JSON.stringify({callers:[]}));if(req.url.endsWith('/voice-channels'))return res.end(JSON.stringify({channels:[]}));
  if(req.url.endsWith('/session/bridge')){if(body.action==='pause'){bridge.paused=true;bridge.state='paused';}if(body.action==='resume'){bridge.paused=false;bridge.state='active';}if(body.action==='settings'){if(body.allowAllianceManage!==undefined)bridge.allowAllianceManage=body.allowAllianceManage;if(body.bufferMs!==undefined)bridge.audio.bufferMs=body.bufferMs;}return res.end(JSON.stringify(bridge));}
  res.end(JSON.stringify({active:false,sessionState:'inactive',parties:[],bridge}));});});
 await new Promise(r=>bot.listen(0,'127.0.0.1',r));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alliance-admin-')),base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),DATA_DIR:dir,DISCORD_CLIENT_ID:'555',DISCORD_CLIENT_SECRET:'shh',PUBLIC_URL:base,DISCORD_GUILD_ID:A,DISCORD_OFFICER_ROLE_IDS:AROLE,DISCORD_API_BASE:fake.url,ALLIANCE_GUILD_ID:B,ALLIANCE_OFFICER_ROLE_IDS:PROLE,SHOTCALLER_URL:'http://127.0.0.1:'+bot.address().port,SHOTCALLER_API_KEY:'test'},stdio:['ignore','pipe','pipe']});
 async function login(id,roles,partner=false){fake.state.guildMembers[id]={roles};const start=await fetch(base+'/auth/discord'+(partner?'?alliance=1':''),{redirect:'manual'}),cookie=start.headers.getSetCookie().map(s=>s.split(';')[0]).join('; '),state=new URL(start.headers.get('location')).searchParams.get('state');const callback=await fetch(base+'/auth/discord/callback?code='+id+'&state='+state,{redirect:'manual',headers:{cookie}});assert.equal(callback.status,302);return callback.headers.getSetCookie().find(s=>s.startsWith('gh_session=')).split(';')[0];}
 const request=(cookie,p,method='GET',body)=>fetch(base+p,{method,headers:{cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('server timeout')),8000);proc.stdout.on('data',d=>{if(String(d).includes('running')){clearTimeout(t);resolve();}});proc.once('exit',()=>reject(Error('server exited')));});
  const cookie=await login(ADMIN,[AROLE]);
  let state=await (await request(cookie,'/api/state')).json();assert.equal(state.user.role,'officer');assert.equal(state.user.canManageAlliance,true);
  // Remove any possibility of partner membership; subsequent management uses only the signed Insanity cookie.
  delete fake.state.guildMembers[ADMIN];
  const portal=await request(cookie,'/alliance.html');assert.equal(portal.status,200);assert.equal(portal.headers.getSetCookie().length,0);
  const context=await (await request(cookie,'/api/alliance/context')).json();assert.equal(context.mode,'insanity-admin');assert.equal(context.capabilities.managePermissions,true);
  const overview=await (await request(cookie,'/api/alliance-management/overview')).json();assert.equal(overview.guilds[0].guildId,B);
  const status=await (await request(cookie,'/api/alliance/status')).json();assert.equal(status.bridge.canManageMains,true);
  const mains=await request(cookie,'/api/alliance/bridge','POST',{action:'mains',mainEnabled:{[A]:false,[B]:true}});assert.equal(mains.status,200);assert.equal(calls.at(-1).url,`/api/guilds/${A}/session/bridge`);assert.equal(calls.at(-1).admin,'true');
  const pause=await request(cookie,'/api/alliance/pause','POST',{sessionId:'x',paused:true,guildId:A});assert.equal(pause.status,200);assert.equal(calls.at(-1).url,`/api/guilds/${B}/session/pause`);assert.equal(calls.at(-1).admin,undefined);
  const save=await request(cookie,'/api/alliance-management/permissions','PUT',{enabled:true,officerRoleIds:[PROLE],officerUserIds:[],allowAllianceManage:true,bufferMs:60});assert.equal(save.status,200);assert.equal(bridge.audio.bufferMs,60);
  for(const endpoint of ['/api/shotcaller/bridge','/api/alliance/bridge','/api/alliance-management/bridge'])for(const action of ['pause','resume','restart']){
   const r=await request(cookie,endpoint,'POST',{action,guildId:B});assert.equal(r.status,200);assert.equal(calls.at(-1).url,`/api/guilds/${A}/session/bridge`);
  }
  const member=await login(MEMBER,[]);state=await (await request(member,'/api/state')).json();assert.equal(state.user.canManageAlliance,false);assert.equal(state.settings.allianceAccess,undefined);
  for(const p of ['/api/alliance-management/overview','/api/alliance/permissions','/api/alliance/status'])assert.equal((await request(member,p)).status,403,p);
  assert.equal((await request(member,'/api/alliance/permissions','PUT',{enabled:false,role:'officer'})).status,403);
  for(const endpoint of ['/api/shotcaller/bridge','/api/alliance/bridge','/api/alliance-management/bridge'])for(const action of ['pause','resume','restart'])assert.equal((await request(member,endpoint,'POST',{action})).status,403);
  const partner=await login(PARTNER,[PROLE],true);assert.equal((await request(partner,'/api/alliance/status')).status,200);for(const p of ['/api/alliance-management/overview','/api/alliance/permissions','/api/state'])assert.equal((await request(partner,p)).status,403,p);
  for(const action of ['pause','resume']){assert.equal((await request(partner,'/api/alliance/bridge','POST',{action,guildId:A})).status,200);assert.equal(calls.at(-1).url,`/api/guilds/${B}/session/bridge`);assert.equal(calls.at(-1).admin,undefined);}
  assert.equal((await request(cookie,'/api/alliance/permissions','PUT',{enabled:false})).status,200);assert.equal((await request(partner,'/api/alliance/status')).status,403);assert.equal((await request(cookie,'/api/alliance/status')).status,200);
  state=await (await request(cookie,'/api/state')).json();assert.equal(state.user.role,'officer');assert.equal(state.user.canManageAlliance,true);assert.equal(state.user.key,ADMIN);
  const originalWrite=await request(cookie,'/api/events','POST',{title:'Original Insanity admin permissions',start:'2999-01-01T20:00:00Z'});assert.equal(originalWrite.status,200);
  const audit=await (await request(cookie,'/api/admin/audit')).json();assert(audit.entries.some(e=>e.action==='alliance.permissions.update' && e.byKey===ADMIN));
  for(const prefix of ['shotcaller.bridge.','alliance.bridge.'])for(const action of ['pause','resume'])assert(audit.entries.some(e=>e.action===prefix+action && e.byKey===ADMIN && e.targetType==='bridge' && e.targetId==='test-bridge' && Number.isFinite(Date.parse(e.at))));
 }finally{proc.kill();if(proc.exitCode===null)await new Promise(r=>proc.once('exit',r));bot.close();fake.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
