'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openLedger}=require('../security-ledger');
const {extract}=require('../security-state');
const {recover}=require('../scripts/ledger-recover');
const {createSessionGuard}=require('../session-guard');
const {startGuild}=require('./hf2-helpers');
const BAD=['valueOf','toString','constructor','hasOwnProperty','__proto__','prototype'];
const OFF='770000000000000001',MEM='770000000000000002',OTHER='770000000000000003';
const init=()=>({policy:extract({users:{},members:[],settings:{}}),sessions:{revoked:{},notBefore:{}},burned:{},support:{pending:null,session:null}});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gh-rc4-')),dir=path.join(root,'ledger'),binding=path.join(root,'binding.json');fs.mkdirSync(dir,{mode:0o700});let l;
 return {root,dir,binding,open:()=>l=openLedger({dir,binding,initial:init(),allowBootstrap:true,compactBytes:1024}),clean(){l?.close();fs.rmSync(root,{recursive:true,force:true});}};
}
function files(root){const out={};for(const n of fs.readdirSync(root).sort()){const p=path.join(root,n);if(fs.statSync(p).isDirectory())for(const [k,v]of Object.entries(files(p)))out[n+'/'+k]=v;else out[n]=fs.readFileSync(p).toString('base64');}return out;}
function lockState(file){const s=fs.statSync(file,{bigint:true});return {bytes:fs.readFileSync(file,'utf8'),ino:s.ino,mode:s.mode,mtime:s.mtimeNs,ctime:s.ctimeNs};}
for(const key of BAD)test('RC3-01 rejects '+key+' before signing, compacting or changing state',()=>{
 const f=fixture();try{let l=f.open();l.append('audit',{text:'x'.repeat(2048)});const before=files(f.root),state=l.getState();
 for(const attempt of [()=>l.revokeUser(key,Date.now()),()=>l.append('session.user',{key,at:Date.now()}),()=>l.mergeSessions({revoked:{},notBefore:Object.fromEntries([[key,1]])}),()=>l.mergeSessions({revoked:Object.fromEntries([[key,1]]),notBefore:{}}),()=>l.append('import',{policy:l.policy(),burned:[key]})]){assert.throws(attempt);assert.deepEqual(files(f.root),before);assert.deepEqual(l.getState(),state);assert.equal(l.isBurned(key),false);}
 l.revokeUser(MEM,1);l.close();l=f.open();assert.equal(l.sessions().notBefore[MEM],1);assert.ok(l.check());
 }finally{f.clean();}
});
test('RC3-01 malformed identities, hashes, cutoffs and non-finite numbers cannot poison a writer',()=>{
 const f=fixture();try{const l=f.open(),before=files(f.root),state=l.getState();
 for(const key of ['',null,42,{},[],true,' x','x ','x\n','x'.repeat(65)])assert.throws(()=>l.revokeUser(key,1));
 for(const n of [NaN,Infinity,-Infinity,-1,'123',null,undefined]){assert.throws(()=>l.revokeUser(MEM,n));assert.throws(()=>l.revokeToken('a'.repeat(64),n));assert.throws(()=>l.append('session.cutoff',{at:n}));}
 for(const hash of [...BAD,'','a'.repeat(63),'A'.repeat(64),null,{}]){assert.throws(()=>l.revokeToken(hash,1));assert.throws(()=>l.append('import.prepare',{burned:[hash]}));assert.equal(l.isBurned(hash),false);}
 for(const merge of [{},{revoked:[],notBefore:{}},{revoked:{},notBefore:{u:NaN}},{revoked:{[MEM]:1},notBefore:{}}])assert.throws(()=>l.mergeSessions(merge));
 assert.deepEqual(files(f.root),before);assert.deepEqual(l.getState(),state);assert.ok(l.check());
 }finally{f.clean();}
});
test('RC3-01 accepted operations retain own numeric entries and valid hashes across compaction, replay and semantic inspection',()=>{
 const f=fixture();try{let l=f.open();const hash=crypto.createHash('sha256').update('old-token').digest('hex'),burn=crypto.createHash('sha256').update('used-invite').digest('hex');
 l.revokeUser(MEM,10);l.revokeUser(MEM,5);l.revokeToken(hash,100);l.mergeSessions({revoked:{[hash]:200},notBefore:{[MEM]:20,'Demo Officer':30,'support:SupportAI':40}});
 l.append('import',{policy:l.policy(),burned:[burn]});const expected=l.sessions();l.compact();l.close();l=f.open();assert.deepEqual(l.sessions(),expected);assert.equal(l.sessions().notBefore[MEM],20);assert.equal(l.isBurned(burn),true);l.close();assert.ok(recover({dir:f.dir,binding:f.binding,ack:true}).authenticatedEvents>=5);
 }finally{f.clean();}
});
test('RC3-01 standalone session guard refuses prototype keys without changing memory or its persistent mirror',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gh-guard-rc4-'));try{const file=path.join(root,'sessions.json');const guard=createSessionGuard({file,now:()=>100,log:{log(){}}});guard.revokeUser(MEM);const before=fs.readFileSync(file),stats=guard.stats();for(const key of BAD){assert.throws(()=>guard.revokeUser(key));assert.throws(()=>guard.nextIat(key));assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(guard.stats(),stats);}assert.equal(guard.isRevoked({iat:50,key:MEM},'a'),true);assert.equal(guard.nextIat(MEM),101);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
async function guild(){return startGuild({guild:'111111111111111111',secret:'synthetic-rc4-secret',seed:{nextId:100,users:Object.fromEntries([OFF,MEM,OTHER].map(k=>[k,{id:k,name:k,accepted:true,inGuild:true}])),members:[{id:1,owner:MEM,name:'Member',active:true,builds:[]}],events:[],points:[],settings:{applications:{enabled:true}}},env:{DISCORD_OFFICER_USER_IDS:OFF}});}
test('RC3-01 kick HTTP matrix rejects prototype/malformed/unregistered targets atomically; real kick revokes and survives restart',async()=>{
 const g=await guild();try{const admin=await g.login(OFF),member=await g.login(MEM);await g.restart();const before=(await g.api('GET','/api/export',{cookie:admin})).json,disk=files(g.dir);
 for(const key of [...BAD,'','bad-id','1','12345678901234','1'.repeat(26),' '+MEM,MEM+' ',null,{},[],Number(MEM)]){const r=await g.api('POST','/api/admin/kick',{cookie:admin,body:{ownerKey:key,reason:'x'}});assert.equal(r.status,400,JSON.stringify(key));assert.deepEqual((await g.api('GET','/api/export',{cookie:admin})).json,before);assert.deepEqual(files(g.dir),disk);}
 assert.equal((await g.api('POST','/api/admin/kick',{cookie:admin,body:{ownerKey:'770000000000000099'}})).status,404);assert.deepEqual(files(g.dir),disk);
 assert.equal((await g.api('POST','/api/admin/kick',{cookie:admin,body:{ownerKey:MEM}})).status,200);assert.equal((await g.api('GET','/api/state',{cookie:member})).status,401);await g.restart();assert.equal((await g.api('GET','/api/state',{cookie:member})).status,401);assert.equal((await g.api('GET','/api/state',{cookie:admin})).status,200);
 assert.equal((await g.api('POST','/api/admin/kick',{cookie:admin,body:{ownerKey:OTHER}})).status,200);await g.restart();assert.equal((await g.api('GET','/api/state',{cookie:admin})).status,200);
 }finally{await g.close();}
});
test('RC3-01 invalid officer identities cannot partially update role lists or persisted security state',async()=>{
 const g=await guild();try{const admin=await g.login(OFF);await g.restart();const before=(await g.api('GET','/api/export',{cookie:admin})).json,disk=files(g.dir);
 for(const key of [...BAD,'bad-id',null,Number(MEM)]){assert.equal((await g.api('PUT','/api/admin/officers',{cookie:admin,body:{roleIds:['770000000000000010'],userIds:[key]}})).status,400);assert.deepEqual((await g.api('GET','/api/export',{cookie:admin})).json,before);assert.deepEqual(files(g.dir),disk);}
 assert.equal((await g.api('PUT','/api/admin/officers',{cookie:admin,body:{userIds:[MEM]}})).status,200);await g.restart();assert.equal((await g.api('GET','/api/state',{cookie:admin})).status,200);
 }finally{await g.close();}
});
test('RC3-02 read-only modern inspection changes neither lock contents/inode/timestamps nor security files',()=>{
 const f=fixture();try{const l=f.open();l.revokeUser(MEM,1);l.close();const file=path.join(f.dir,'writer.lock'),before=files(f.root),lock=lockState(file);assert.ok(recover({dir:f.dir,binding:f.binding,ack:true}).authenticatedEvents);assert.deepEqual(files(f.root),before);assert.deepEqual(lockState(file),lock);f.open().close();}finally{f.clean();}
});
test('RC3-02 legacy inspection and incomplete migration acknowledgement cannot launder the lock',()=>{
 const f=fixture();try{const l=f.open();l.close();const file=path.join(f.dir,'writer.lock');for(const legacy of [crypto.randomUUID(),JSON.stringify({id:'legacy',pid:999999})]){fs.writeFileSync(file,legacy);const lock=lockState(file),before=files(f.root);assert.throws(()=>recover({dir:f.dir,binding:f.binding,ack:true}),/legacy lock/);assert.throws(()=>recover({dir:f.dir,binding:f.binding,unlock:true,ack:true}),/legacy lock/);assert.throws(()=>recover({dir:f.dir,binding:f.binding,legacyAck:true,ack:true}),/requires --unlock/);assert.deepEqual(files(f.root),before);assert.deepEqual(lockState(file),lock);assert.throws(()=>f.open(),/legacy lock/);}
 assert.equal(recover({dir:f.dir,binding:f.binding,unlock:true,ack:true,legacyAck:true}).unlocked,true);assert.equal(JSON.parse(fs.readFileSync(file)).v,2);f.open().close();
 }finally{f.clean();}
});
test('RC3-02 explicit migration flags never bypass an active kernel lock; absent locks are not created by inspection',()=>{
 const f=fixture();try{const l=f.open(),file=path.join(f.dir,'writer.lock'),before=lockState(file);assert.throws(()=>recover({dir:f.dir,binding:f.binding,unlock:true,ack:true,legacyAck:true}),/lock/);assert.deepEqual(lockState(file),before);l.close();fs.unlinkSync(file);assert.throws(()=>recover({dir:f.dir,binding:f.binding,ack:true}),/ENOENT/);assert.equal(fs.existsSync(file),false);assert.equal(recover({dir:f.dir,binding:f.binding,unlock:true,ack:true}).unlocked,true);f.open().close();}finally{f.clean();}
});
function historicalFrames(f,events){
 const {canonical,digest}=require('../security-ledger');const file=path.join(f.dir,'events.jsonl');const secret=JSON.parse(fs.readFileSync(path.join(f.dir,'key.json')));let raw=fs.readFileSync(file,'utf8'),last=JSON.parse(raw.trimEnd().split('\n').at(-1)),hash=digest(raw.trimEnd().split('\n').at(-1)),seq=last.seq;
 for(const [type,data]of events){const record={v:1,id:secret.id,seq:++seq,at:Date.now(),type,data,prev:hash};const line=canonical({...record,mac:crypto.createHmac('sha256',Buffer.from(secret.key,'hex')).update(canonical(record)).digest('hex')});raw+=line+'\n';hash=digest(line);}
 fs.writeFileSync(file,raw);return raw;
}
test('RC3-01 valid historical v1 full-policy/session/import frames retain every revocation and original signed bytes',()=>{
 const f=fixture();try{let l=f.open();const policy=l.policy();l.close();const hash='a'.repeat(64),burn='b'.repeat(64);const raw=historicalFrames(f,[['policy',{policy}],['session.user',{key:MEM,at:8}],['session.user',{key:'Demo Officer',at:9}],['session.token',{hash,exp:2e12}],['import',{policy,burned:[burn]}]]);l=f.open();assert.equal(fs.readFileSync(path.join(f.dir,'events.jsonl'),'utf8'),raw);assert.equal(l.sessions().notBefore[MEM],8);assert.equal(l.sessions().notBefore['Demo Officer'],9);assert.equal(l.sessions().revoked[hash],2e12);assert.equal(l.isBurned(burn),true);l.compact();l.close();l=f.open();assert.equal(l.sessions().notBefore[MEM],8);assert.equal(l.sessions().revoked[hash],2e12);l.close();assert.equal(recover({dir:f.dir,binding:f.binding,ack:true}).authenticatedEvents,6);}finally{f.clean();}
});
test('RC3-01 already-invalid signed prototype events remain fail-closed and offline inspection does not certify them healthy',()=>{
 const f=fixture();try{const l=f.open();l.close();historicalFrames(f,[['session.user',{key:'valueOf',at:1}]]);assert.throws(()=>f.open(),/invalid session identifier/);const before=files(f.root);assert.throws(()=>recover({dir:f.dir,binding:f.binding,ack:true}),/invalid session identifier/);assert.deepEqual(files(f.root),before);}finally{f.clean();}
});
