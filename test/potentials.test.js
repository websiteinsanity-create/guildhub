const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {catalog,entries,slots,compatible,validateSelection}=require('../potential-catalog');
test('potential catalog preserves displayed values and all supplied categories',()=>{
 assert.equal(entries.length,192);assert.equal(new Set(entries.map(e=>e.id)).size,192);
 assert.equal(entries.filter(e=>e.kind==='enchant').length,60);
 assert.equal(entries.filter(e=>e.kind==='skill-level').length,120);
 assert.equal(entries.find(e=>e.id==='all_double_attack').value,50);
 assert.equal(entries.find(e=>e.id==='skill_cooldown_modifier').displayValue,'+2.5%');
 assert.equal(slots.length,13);assert.equal(catalog.language,'en');
});
test('category and weapon checks reject unknown, duplicate and mismatched selections',()=>{
 const ws=['Sword & Shield','Greatsword'],ench='SkillSet_WP_Item_Gear_SW2_05_2';
 assert.throws(()=>validateSelection('weapon2',[ench,'all_accuracy'],ws));
 assert.deepEqual(validateSelection('weapon2',[ench],ws),[ench]);
 assert.deepEqual(validateSelection('head',[],ws),[]);
 assert.deepEqual(validateSelection('weapon1',[ench],ws),[ench]);
 assert.deepEqual(validateSelection('weapon2',['SkillSet_WP_Item_Gear_SW_11'],ws),['SkillSet_WP_Item_Gear_SW_11']);
 for(const [slot,ids] of [['weapon1',['SkillSet_WP_Item_Gear_ORB_12']],['head',[ench]],['head',['missing']],['__proto__',[]],['weapon2',[ench,ench]],['weapon2','bad']])assert.throws(()=>validateSelection(slot,ids,ws));
 assert.throws(()=>validateSelection('weapon2',[ench],['Sword & Shield','']));
 assert(compatible(entries.find(e=>e.id==='all_armor'),slots.find(s=>s.id==='belt'),ws));
});
async function server(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guild-potentials-')),port=40000+Math.floor(Math.random()*20000);let proc;
 const boot=async()=>{proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),DATA_DIR:dir,MEMBER_PASSCODE:'m1',OFFICER_PASSCODE:'o1',DEMO_MODE:'1'},stdio:['ignore','pipe','inherit']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),10000);proc.stdout.on('data',d=>{if(String(d).includes('running')){clearTimeout(timer);resolve();}});proc.once('exit',()=>{clearTimeout(timer);reject(Error('Early exit'));});});};
 const halt=()=>new Promise(r=>{proc.once('exit',r);proc.kill();});await boot();
 const call=async(p,method='GET',body,token)=>{const r=await fetch(`http://localhost:${port}`+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 const login=async(name,passcode)=>(await call('/api/login','POST',{name,passcode})).body.token;
 return{call,login,dir,restart:async(edit)=>{await halt();if(edit)edit(dir);await boot();},stop:async()=>{await halt();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('API persists isolated build selections, protects writes, detects conflicts and cleans removed builds',async()=>{
 const s=await server();try{
 let owner=await s.login('Ann','m1'),officer=await s.login('Boss','o1'),other=await s.login('Bob','m1');
 const created=await s.call('/api/members','POST',{name:'AnnChar',role:'Tank',primaryWeapon:'Sword & Shield',secondaryWeapon:'Greatsword'},owner);assert.equal(created.status,200);
 const id=created.body.id,url=`/api/gearthreads/${id}`;
 const altResult=await s.call(`/api/members/${id}/builds`,'POST',{name:'Heal',role:'Healer',primaryWeapon:'Orb',secondaryWeapon:'Wand & Tome'},officer);assert.equal(altResult.status,200);
 const alt=String(altResult.body.builds[0].id);
 const read=async(build='main')=>(await s.call(url+'?build='+build,'GET',undefined,owner)).body.potentials;
 const write=(body,who=owner)=>s.call(url+'/potentials','PUT',{build:'main',...body},who);
 const ench='SkillSet_WP_Item_Gear_SW2_05_2',ids=['SkillSet_WP_Item_Gear_SW_11'];
 assert.equal((await read()).revision,0);
 assert.equal((await s.call(url,'GET',undefined,other)).status,403);
 assert.equal((await write({slot:'weapon2',ids,revision:0},other)).status,403);
 assert.equal((await write({slot:'weapon2',ids,revision:0})).status,200);
 assert.deepEqual((await read()).assignments.weapon2,ids);
 assert.deepEqual((await read(alt)).assignments,{});
 assert.equal((await write({slot:'weapon2',ids:[],revision:0})).status,409);
 assert.equal((await write({slot:'weapon2',ids})).status,409);
 for(const body of [{slot:'head',ids:[ench]},{slot:'__proto__',ids:[]},{slot:'weapon1',ids:['SkillSet_WP_Item_Gear_ORB_12']},{slot:'weapon2',ids:['missing']},{slot:'weapon2',ids:[ench,'all_accuracy']},{slot:'head',ids:['hp_max','all_armor']},{slot:'ring1',ids:['hp_max','all_armor']},{slot:'weapon2',ids:[ench,ench]},{slot:'weapon2',ids:null}])assert.equal((await write({...body,revision:1})).status,400);
 assert.deepEqual((await read()).assignments.weapon2,ids);
 assert.equal((await read()).revision,1);
 assert.equal((await write({slot:'chest',ids:['SkillSet_WP_SW2_S_CounterAttack'],revision:1},officer)).status,200);
 assert.equal((await write({build:alt,slot:'weapon1',ids:['SkillSet_WP_Item_Gear_ORB_12'],revision:0})).status,200);
 await s.restart();owner=await s.login('Ann','m1');officer=await s.login('Boss','o1');
 assert.deepEqual((await read()).assignments.weapon2,ids);assert.equal((await read()).revision,2);
 assert.equal((await read(alt)).assignments.weapon1.length,1);
 assert.equal((await write({slot:'weapon2',ids:[],revision:2})).status,200);
 assert.equal((await read()).assignments.weapon2,undefined);
 await s.restart(dir=>{const file=path.join(dir,'db.json'),db=JSON.parse(fs.readFileSync(file,'utf8'));db.gearPotentials[`${id}:main`].assignments.weapon1=[ench,'all_accuracy'];db.gearPotentials[`${id}:main`].assignments.belt=['hp_max','all_armor'];fs.writeFileSync(file,JSON.stringify(db));});
 owner=await s.login('Ann','m1');officer=await s.login('Boss','o1');
 const legacy=await read();assert.equal(legacy.assignments.weapon1,undefined);assert.deepEqual(legacy.legacyAssignments.weapon1,[ench,'all_accuracy']);
 assert.equal((await write({slot:'weapon1',ids:[ench],revision:legacy.revision})).status,200);
 assert.deepEqual((await read()).assignments.weapon1,[ench]);assert.deepEqual((await read()).legacyAssignments.belt,['hp_max','all_armor']);

 assert.equal((await s.call(`/api/members/${id}/builds/${alt}`,'DELETE',undefined,officer)).status,200);
 await s.restart();
 const db=JSON.parse(fs.readFileSync(path.join(s.dir,'db.json'),'utf8'));
 assert(!db.gearPotentials[`${id}:${alt}`]);assert(db.gearPotentials[`${id}:main`]);
 }finally{await s.stop();}
});
