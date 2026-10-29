const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
test('every registered business mutation is blocked before handler execution for support; ordinary admin still works',async()=>{
 const file=path.join(__dirname,'api.test.js'),raw=fs.readFileSync(file,'utf8'),box={exports:{}};
 vm.runInNewContext(raw.slice(0,raw.indexOf('// Runs a test body'))+'\nmodule.exports=startServer;',{module:box,require:createRequire(file),__dirname,process,console,setTimeout,clearTimeout,fetch});
 const s=await box.exports();try{
 const generated=await s.call('/api/admin/support-access/generate','POST',{},s.officer);assert.equal(generated.status,200);const code=generated.body.code;
 const login=await fetch(s.base+'/api/support/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SupportAI',code})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const before=(await s.call('/api/export','GET',null,s.officer)).body;
 const calls=new Set();for(const name of fs.readdirSync(path.join(__dirname,'..')).filter(n=>n.endsWith('.js'))){const source=fs.readFileSync(path.join(__dirname,'..',name),'utf8');for(const match of source.matchAll(/route\(\s*'(POST|PUT|DELETE|PATCH)'\s*,\s*'([^']+)'/g)){if(['/api/login','/api/support/login','/api/logout'].includes(match[2]))continue;calls.add(match[1]+' '+match[2].replace(/:\w+/g,'1'));}}
 assert(calls.size>80);
 for(const action of calls){const [method,url]=action.split(' ');const response=await fetch(s.base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({})});assert.equal(response.status,403,action);assert((await response.json()).error.includes('read-only'),action);}
 for(const url of ['/api/state','/api/attendance-stats','/api/admin/diagnostics','/api/admin/audit']){const response=await fetch(s.base+url,{headers:{Cookie:cookie}});assert.equal(response.status,200,url);const result=await response.json();if(url==='/api/state')assert.equal(result.user.readOnly,true);}
 for(const url of ['/api/export','/api/admin/support-access'])assert.equal((await fetch(s.base+url,{headers:{Cookie:cookie}})).status,403,url);
 const after=(await s.call('/api/export','GET',null,s.officer)).body;
 for(const field of ['members','events','points','presets','warnings','requests','settings','notices'])assert.deepEqual(after[field],before[field],field+' unchanged');
 assert.equal((await s.call('/api/events','POST',{title:'Normal admin write',start:'2027-01-01T20:00:00Z'},s.officer)).status,200);
 assert.equal((await fetch(s.base+'/api/logout',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,200);
 console.log('Verified blocked mutation routes:',calls.size);
 }finally{await s.stop();}
});
test('read allowlist rejects new endpoints, backup exports and every non-GET method',()=>{
 const allowed=require('../support-read-policy');assert(allowed('GET','/api/admin/diagnostics'));assert(allowed('GET','/api/events/20/tracking-state'));assert(allowed('GET','/api/gearthreads/10/chat'));
 for(const method of ['POST','PUT','DELETE','PATCH','HEAD','OPTIONS'])assert.equal(allowed(method,'/api/state'),false);
 for(const url of ['/api/new-destructive-endpoint','/api/export','/api/admin/support-access','/api/events/20/tracking-state/extra'])assert.equal(allowed('GET',url),false);
});
