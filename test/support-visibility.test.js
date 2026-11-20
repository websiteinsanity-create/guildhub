const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
test('public response field names survive credential-name collisions; ID keys and secrets are still scrubbed',()=>{
 const clean=require('../support-redaction')('test-secret',['user','role','officer','readOnly','support']);
 const out=clean({user:{role:'officer',support:true,readOnly:true},'100000000000000001':{password:'never expose'},notes:'Contains officer password'});
 assert(out.user);assert.equal(out.user.readOnly,true);assert.equal(out.user.support,true);assert.equal(out.user.role,'[redacted]');assert(!Object.keys(out).includes('100000000000000001'));assert(!JSON.stringify(out).includes('never expose'));assert(!out.notes.includes('officer'));
});
test('real state response retains leadership visibility when officer is also the configured passcode',async()=>{
 const file=path.join(__dirname,'api.test.js'),raw=fs.readFileSync(file,'utf8'),box={exports:{}};
 const setup=raw.slice(0,raw.indexOf('// Runs a test body')).replace("OFFICER_PASSCODE: 'o1'","OFFICER_PASSCODE: 'officer'").replace("officer: await login('Boss', 'o1')","officer: await login('Boss', 'officer')");
 assert.notEqual(setup,raw.slice(0,raw.indexOf('// Runs a test body')));
 vm.runInNewContext(setup+'\nmodule.exports=startServer;',{module:box,require:createRequire(file),__dirname,process,console,setTimeout,clearTimeout,fetch});
 const s=await box.exports();try{
  const issued=await s.call('/api/admin/support-access/generate','POST',{},s.officer);assert.equal(issued.status,200);
  const login=await fetch(s.base+'/api/support/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SupportAI',code:issued.body.code})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const get=async url=>{const r=await fetch(s.base+url,{headers:{Cookie:cookie}});return{status:r.status,body:await r.json()};};
  const state=await get('/api/state?compact=1');assert.equal(state.status,200);assert.equal(state.body.user.role,'officer');assert.equal(state.body.user.support,true);assert.equal(state.body.user.readOnly,true);assert.equal(state.body.user.canViewLeadership,true);
  for(const url of ['/api/admin/diagnostics','/api/admin/audit','/api/admin/gear-sections'])assert.equal((await get(url)).status,200,url);
  const blocked=await fetch(s.base+'/api/events',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({title:'Forbidden',start:'2027-01-01T20:00:00Z'})});assert.equal(blocked.status,403);
  assert.equal((await get('/api/export')).status,403);
  assert.equal((await s.call('/api/events','POST',{title:'Regular officer',start:'2027-01-01T20:00:00Z'},s.officer)).status,200);
 }finally{await s.stop();}
});
test('support navigation and role badge expose leadership reads even with a redacted legacy role',()=>{
 const nodes=new Map(),node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',dataset:{},style:{},scrollTop:0,scrollHeight:900,clientHeight:600,classList:{toggle(){},add(){},remove(){},contains:()=>false},setAttribute(){},removeAttribute(){},addEventListener(){},querySelectorAll:()=>[],getClientRects:()=>[{}]});return nodes.get(key);};
 const ctx={console,window:{innerWidth:1440,matchMedia:()=>({matches:false}),addEventListener(){},requestAnimationFrame:fn=>fn()},document:{activeElement:null,addEventListener(){},querySelector:node,querySelectorAll:()=>[]},localStorage:{getItem:()=>null,setItem(){}},setTimeout(){},setInterval(){},URLSearchParams,location:{search:'',hash:'#/diagnostics'},fetch:()=>new Promise(()=>{})};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),ctx);
 vm.runInContext("S.user={key:'support:SupportAI',name:'SupportAI',role:'[redacted]',support:true,readOnly:true,canViewLeadership:true};S.cfg={};S.settings.hiddenSections=['loot','requests'];",ctx);
 for(const page of ['diagnostics','shotcaller','auditlog','admin','approvals','loot','requests'])assert(vm.runInContext(`canSee('${page}')`,ctx),page);
 vm.runInContext("renderNavProfile('diagnostics')",ctx);assert([...nodes.values()].some(n=>n.innerHTML.includes('Support · Read-only')));
 vm.runInContext("S.user={key:'normal',name:'Member',role:'member'}",ctx);assert.equal(vm.runInContext("canSee('diagnostics')",ctx),false);
});
