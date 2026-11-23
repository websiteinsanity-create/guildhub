'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
test('Daily Schedule persistence drains concurrent dirty revisions instead of falsely reporting I/O failure',async()=>{
 const fn=source.slice(source.indexOf('async function persistScheduleState()'),source.indexOf('function ensureScheduleMessage('));let dirty=false,writes=0;
 const box={shuttingDown:false,flushTimer:null,flushInFlight:null,saveFailures:0,save:()=>{dirty=true;},clearTimeout(){},get dirty(){return dirty;},set dirty(v){dirty=v;},flush:async()=>{writes++;dirty=writes===1;}};
 vm.createContext(box);vm.runInContext(fn+'\nglobalThis.run=persistScheduleState;',box);await box.run();assert.equal(writes,2);assert.equal(dirty,false);
});
test('Daily Schedule persistence still rejects real I/O failures',async()=>{
 const fn=source.slice(source.indexOf('async function persistScheduleState()'),source.indexOf('function ensureScheduleMessage('));
 const box={shuttingDown:false,flushTimer:null,flushInFlight:null,dirty:true,saveFailures:0,save(){},clearTimeout(){},flush:async()=>{box.saveFailures++;}};
 vm.createContext(box);vm.runInContext(fn+'\nglobalThis.run=persistScheduleState;',box);await assert.rejects(box.run(),/Could not persist/);
});
test('one async database writer owns the temporary path while a later save remains pending',async()=>{
 const code=source.slice(source.indexOf('let afterPersist ='),source.indexOf('// Only used right before the process'));
 let writes=0,release;const files=new Map(),started=new Promise(resolve=>{release=resolve;});let unblock;
 const gate=new Promise(resolve=>{unblock=resolve;});
 const box={db:{events:[],value:1},DB_FILE:'/fictional/db.json',process:{env:{}},console,setTimeout:()=>({unref(){}}),clearTimeout(){},fs:{promises:{writeFile:async(file,data)=>{writes++;if(writes===1){release();await gate;}files.set(file,data);},rename:async(a,b)=>{assert.ok(files.has(a));files.set(b,files.get(a));files.delete(a);}}}};
 vm.createContext(box);vm.runInContext(code+'\nglobalThis.api={flush,save};',box);box.api.save();const first=box.api.flush();await started;
 box.db.value=2;box.api.save();const second=box.api.flush();assert.equal(first,second,'concurrent flush joins existing writer');unblock();await first;assert.equal(writes,1);
 await box.api.flush();assert.equal(JSON.parse(files.get('/fictional/db.json')).value,2);assert.equal(writes,2);
});
