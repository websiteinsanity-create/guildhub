const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {startFakeDiscord}=require('./fake-discord');
const A='111111111111111111',B='222222222222222222',U='333333333333333333',ROLE='999999999999999999';
test('partner OAuth token is limited to its own voice routes and cannot use admin, roster or technical bridge actions',async()=>{
 const discord=await startFakeDiscord(),calls=[];discord.state.guildMembers[U]={roles:[ROLE]};
 const bot=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{calls.push({url:req.url,body:raw?JSON.parse(raw):null,admin:req.headers['x-shotcaller-admin']});res.setHeader('content-type','application/json');if(req.url.endsWith('/callers'))res.end(JSON.stringify({callers:[{id:U,name:'Caller'}]}));else res.end(JSON.stringify({active:false,sessionState:'inactive',audioTelemetry:{secretDiagnostic:true},diagnostics:{technical:true},bridge:{state:'waiting',desired:true}}));});});
 await new Promise(r=>bot.listen(0,'127.0.0.1',r));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guildhub-alliance-')),base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),DATA_DIR:dir,DISCORD_CLIENT_ID:'555',DISCORD_CLIENT_SECRET:'shh',PUBLIC_URL:base,DISCORD_GUILD_ID:A,DISCORD_API_BASE:discord.url,ALLIANCE_GUILD_ID:B,ALLIANCE_OFFICER_ROLE_IDS:ROLE,SHOTCALLER_URL:'http://127.0.0.1:'+bot.address().port,SHOTCALLER_API_KEY:'fake'},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('server timeout')),8000);proc.stdout.on('data',d=>{if(String(d).includes('running')){clearTimeout(t);resolve();}});proc.once('exit',()=>reject(Error('server exited')));});
  const start=await fetch(base+'/auth/discord?alliance=1',{redirect:'manual'});const cookie=start.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');const state=new URL(start.headers.get('location')).searchParams.get('state');
  const login=await fetch(base+'/auth/discord/callback?code='+U+'&state='+state,{redirect:'manual',headers:{cookie}});assert.equal(login.headers.get('location'),'/alliance.html');const session=login.headers.getSetCookie().find(s=>s.startsWith('gh_session=')).split(';')[0];
  const request=(p,body)=>fetch(base+p,{headers:{cookie:session,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  for(const p of ['/api/state','/api/admin/diagnostics','/api/shotcaller/status','/api/admin/alliance-bridge'])assert.equal((await request(p)).status,403,p);
  const status=await request('/api/alliance/status');assert.equal(status.status,200);const value=await status.json();assert.equal(value.audioTelemetry,undefined);assert.equal(value.diagnostics,undefined);assert(calls.at(-1).url.startsWith('/api/guilds/'+B+'/'));assert.equal(calls.at(-1).admin,undefined);
  const count=calls.length;for(const action of ['settings','swipe'])assert.equal((await request('/api/alliance/bridge',{action,enabled:true,bufferMs:100})).status,403);assert.equal(calls.length,count);
  const ended=await request('/api/alliance/bridge',{action:'end',guildId:A});assert.equal(ended.status,200,await ended.text());assert.equal(calls.at(-1).url,'/api/guilds/'+B+'/session/bridge');
  for(let i=0;i<40 && !fs.existsSync(path.join(dir,'db.json'));i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'db.json'))).users[U],undefined);
 }finally{proc.kill();if(proc.exitCode===null)await new Promise(r=>proc.once('exit',r));bot.close();discord.close();fs.rmSync(dir,{recursive:true,force:true});}
});
