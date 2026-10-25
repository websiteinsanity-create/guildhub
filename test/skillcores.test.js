const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateCatalog,validateActive}=require('../skillcore-catalog');
const source=require('../catalog/skillcores.en.json');
const clone=()=>structuredClone(source);
test('bundled Questlog snapshot has 271 unique, attributed entries and preserves source limitations',()=>{
  const c=validateCatalog(source);
  assert.equal(c.entries.length,271);
  assert.equal(c.entries.filter(e=>e.slot==='weapon').length,208);
  assert.equal(c.entries.filter(e=>e.slot==='equipment').length,63);
  assert.equal(c.entries.filter(e=>e.availability==='legacy').length,2);
  assert.equal(c.entries.filter(e=>e.descriptionStatus==='unresolved-source-tokens').length,3);
  for(const e of c.entries){assert(e.description.length);assert(e.icon.startsWith('https://cdn.questlog.gg/'));assert.equal(e.sourceUrl,source.sourceUrl);}
  assert.equal(c.gameVersion,'Not stated by source');
});
test('catalog imports reject malformed or duplicated records and automatically flag unresolved formulas',()=>{
  for(const change of [c=>c.entries.push(c.entries[0]),c=>c.entries[0].slot='armor',c=>c.entries[0].icon='javascript:alert(1)',c=>c.entries[0].weapons=['Sword'],c=>c.entries[0].id='__proto__',c=>c.entries[0].description='',c=>c.language='de']){
    const c=clone();change(c);assert.throws(()=>validateCatalog(c));
  }
  const c=clone();c.entries[0].description='unresolved.tooltip';c.entries[0].descriptionStatus='as-published';
  assert.equal(validateCatalog(c).entries[0].descriptionStatus,'unresolved-source-tokens');
});
const compatible=source.entries.filter(e=>e.weapons.some(w=>['Greatsword','Daggers'].includes(w)));
const weapons=compatible.filter(e=>e.slot==='weapon');
const equipment=compatible.filter(e=>e.slot==='equipment');
const good=[weapons[0].id,equipment[0].id,equipment[1].id];
const incompatible=source.entries.find(e=>e.slot==='equipment'&&e.weapons.length&&!e.weapons.some(w=>['Greatsword','Daggers'].includes(w)));
test('active-slot validation enforces 1 weapon, 2 equipment and build affinity',()=>{
  validateActive(good,source.entries,['Greatsword','Daggers']);
  for(const ids of [[weapons[0].id,weapons[1].id],equipment.slice(0,3).map(e=>e.id),[...good,weapons[1].id],[incompatible.id],['unknown']])assert.throws(()=>validateActive(ids,source.entries,['Greatsword','Daggers']));
});
async function server(seed){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guild-cores-'));
  if(seed)fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify(seed));
  const port=40000+Math.floor(Math.random()*20000);
  let proc;
  const boot=async()=>{
    proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),DATA_DIR:dir,MEMBER_PASSCODE:'m1',OFFICER_PASSCODE:'o1',DEMO_MODE:'1'},stdio:['ignore','pipe','inherit']});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),8000);proc.stdout.on('data',d=>{if(String(d).includes('running')){clearTimeout(timer);resolve();}});proc.once('exit',()=>{clearTimeout(timer);reject(Error('Early exit'));});});
  };
  const halt=()=>new Promise(r=>{proc.once('exit',r);proc.kill();});
  await boot();
  const call=async(p,method='GET',body,token)=>{const r=await fetch(`http://localhost:${port}`+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  const login=async(name,passcode)=>(await call('/api/login','POST',{name,passcode})).body.token;
  return{call,login,dir,restart:async(edit)=>{await halt();if(edit)edit(dir);await boot();},stop:async()=>{await halt();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('collection API shares unlimited ownership, isolates active builds, protects imports and persists data',async()=>{
  const s=await server();
  try{
    let officer=await s.login('Boss','o1'),ann=await s.login('Ann','m1'),bob=await s.login('Bob','m1');
    const created=await s.call('/api/members','POST',{name:'AnnChar',role:'DPS',primaryWeapon:'Greatsword',secondaryWeapon:'Daggers'},ann);
    assert.equal(created.status,200);const id=created.body.id,url=`/api/gearthreads/${id}`;
    const builds=await s.call(`/api/members/${id}/builds`,'POST',{name:'Alternative',role:'DPS',primaryWeapon:'Greatsword',secondaryWeapon:'Daggers'},officer);
    assert.equal(builds.status,200);const alt=String(builds.body.builds[0].id);
    const get=async(build='main')=>(await s.call(url+'?build='+build,'GET',undefined,ann)).body.skillcores;
    const put=(body,who=ann)=>s.call(url+'/skillcores','PUT',body,who);
    assert.equal((await s.call(url,'GET',undefined,bob)).status,403);
    assert.equal((await put({addOwned:good},bob)).status,403);
    assert.equal((await put({active:good})).status,400);
    const ids=source.entries.slice(0,25).map(e=>e.id);
    const owned=[...new Set([...ids,...good,...weapons.slice(0,2).map(e=>e.id),...equipment.slice(0,3).map(e=>e.id),incompatible.id])];
    assert.equal((await put({addOwned:owned})).status,200);
    assert.equal((await get(alt)).owned.length,owned.length);
    assert.equal((await put({active:good})).status,200);
    assert.deepEqual((await get()).active,good);assert.deepEqual((await get(alt)).active,[]);
    for(const active of [[weapons[0].id,weapons[1].id],equipment.slice(0,3).map(e=>e.id),[...good,weapons[1].id],[incompatible.id]])assert.equal((await put({active})).status,400);
    assert.deepEqual((await get()).active,good,'rejected updates are atomic');
    assert.equal((await put({build:alt,active:[good[0]]})).status,200);
    assert.equal((await put({removeOwned:[good[0]]})).status,409);
    assert.equal((await put({active:[]})).status,200);
    assert.equal((await put({removeOwned:[good[0]]})).status,409,'other build still uses it');
    assert.equal((await put({build:alt,active:[]})).status,200);
    assert.equal((await put({removeOwned:[good[0]]})).status,200);
    assert(!(await get(alt)).owned.includes(good[0]));
    const extra=source.entries.find(e=>!owned.includes(e.id)).id;
    assert.equal((await put({build:alt,addOwned:[extra,extra]})).status,200);
    assert.equal((await get()).owned.filter(id=>id===extra).length,1);
    const before=(await get()).owned;
    assert.equal((await put({owned:['unknown'],active:[]})).status,400);
    assert.deepEqual((await get()).owned,before);
    assert.equal((await s.call('/api/admin/skillcores/catalog','GET',undefined,ann)).status,403);
    assert.equal((await s.call('/api/admin/skillcores/catalog','PUT',clone(),ann)).status,403);
    const missing=clone();missing.entries=missing.entries.filter(e=>e.id!==extra);
    assert.equal((await s.call('/api/admin/skillcores/catalog','PUT',missing,officer)).status,409);
    const changed=clone();changed.entries.find(e=>e.id===extra).slot='equipment';changed.entries.find(e=>e.id===extra).weapons=[];
    assert.equal((await s.call('/api/admin/skillcores/catalog','PUT',changed,officer)).status,409);
    const next=clone();next.source+=' · import test';
    assert.equal((await s.call('/api/admin/skillcores/catalog','PUT',next,officer)).status,200);
    assert.equal((await s.call(`/api/members/${id}/builds/${alt}`,'DELETE',undefined,officer)).status,200);
    assert.deepEqual((await get()).owned,before,'build deletion preserves shared collection');
    await s.restart();ann=await s.login('Ann','m1');officer=await s.login('Boss','o1');
    assert.deepEqual((await get()).owned,before);
    assert.equal((await s.call('/api/admin/skillcores/catalog','GET',undefined,officer)).body.source,next.source);
  }finally{await s.stop();}
});
test('legacy per-build Owned lists merge without losing alternate active selections',async()=>{
  const s=await server();
  try{
    let officer=await s.login('Boss','o1'),ann=await s.login('Ann','m1');
    const m=(await s.call('/api/members','POST',{name:'Legacy',role:'DPS',primaryWeapon:'Greatsword',secondaryWeapon:'Daggers'},ann)).body;
    const builds=(await s.call(`/api/members/${m.id}/builds`,'POST',{name:'Alt',role:'DPS',primaryWeapon:'Greatsword',secondaryWeapon:'Daggers'},officer)).body;
    const alt=String(builds.builds[0].id),url=`/api/gearthreads/${m.id}`;
    await s.restart(dir=>{
      const p=path.join(dir,'db.json'),db=JSON.parse(fs.readFileSync(p,'utf8'));
      db.gearSkills[m.id]={owned:[good[0]],active:[good[0]]};
      db.gearSkills[`${m.id}:${alt}`]={owned:[good[1],good[2]],active:[good[1]]};
      fs.writeFileSync(p,JSON.stringify(db));
    });
    ann=await s.login('Ann','m1');
    const before=(await s.call(url,'GET',undefined,ann)).body.skillcores;
    assert.deepEqual(new Set(before.owned),new Set(good));assert.deepEqual(before.active,[good[0]]);
    assert.equal((await s.call(url+'/skillcores','PUT',{addOwned:[weapons[1].id]},ann)).status,200);
    const after=(await s.call(url+'?build='+alt,'GET',undefined,ann)).body.skillcores;
    assert(after.owned.includes(weapons[1].id));assert.deepEqual(after.active,[good[1]]);
    await s.restart();
    const db=JSON.parse(fs.readFileSync(path.join(s.dir,'db.json'),'utf8')); 
    assert.equal(db.gearSkills[m.id].owned,undefined);assert.equal(db.gearSkills[`${m.id}:${alt}`].owned,undefined);
  }finally{await s.stop();}
});
