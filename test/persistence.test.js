const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('shutdown waits for an in-flight disk write and persists newer changes before exiting',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const block=source.slice(source.indexOf('let dirty ='),source.indexOf('const newId ='));
  let release;const disk=new Map(),exits=[],events=[];
  const ctx={db:{collection:['first']},DB_FILE:'db.json',console,process:{env:{SAVE_DEBOUNCE_MS:'1'},on(){},exit:c=>exits.push(c)},setTimeout:()=>({unref(){}}),clearTimeout(){},
    fs:{promises:{writeFile:(p,data)=>new Promise(r=>{release=()=>{disk.set(p,data);events.push('async write');r();};}),rename:async(a,b)=>{disk.set(b,disk.get(a));events.push('async rename');}},writeFileSync:(p,data)=>{disk.set(p,data);events.push('final write');},renameSync:(a,b)=>{disk.set(b,disk.get(a));events.push('final rename');}}};
  vm.createContext(ctx);vm.runInContext(block,ctx);
  vm.runInContext('save();flush()',ctx);
  vm.runInContext("db.collection.push('latest');save()",ctx);
  const stop=vm.runInContext('shutdown(0)',ctx);
  assert.equal(exits.length,0,'must not exit before in-flight rename');
  await vm.runInContext('shutdown(0)',ctx);assert.equal(exits.length,0,'second signal does not interrupt final save');
  release();await stop;
  assert.deepEqual(JSON.parse(disk.get('db.json')).collection,['first','latest']);
  assert.deepEqual(events,['async write','async rename','final write','final rename']);assert.deepEqual(exits,[0]);
});
