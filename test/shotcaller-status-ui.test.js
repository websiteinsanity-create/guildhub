const {test}=require('node:test');
const vm=require('vm'),fs=require('fs'),assert=require('assert');
const storage=new Map(),nodes=new Map(),listeners={};
const node=key=>{
 if(!nodes.has(key)){
  const classes=new Set();
  nodes.set(key,{innerHTML:'',textContent:'',dataset:{},attrs:{},scrollTop:0,scrollHeight:900,clientHeight:600,style:{},
   classList:{toggle(k,on){if(on)classes.add(k);else classes.delete(k)},add(k){classes.add(k)},remove(k){classes.delete(k)},contains:k=>classes.has(k)},
   setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},addEventListener(){},focus(){ctx.document.activeElement=this},scrollBy({top}){this.scrollTop+=top},
   getClientRects:()=>[{}],querySelectorAll:()=>[node('#nav-mobile-close'),node('#footer-logout')]
  });
 }
 return nodes.get(key);
};
const ctx={console,window:{innerWidth:1440,matchMedia:()=>({matches:false}),addEventListener(){},requestAnimationFrame:fn=>fn()},
 document:{activeElement:null,addEventListener(k,fn){(listeners[k]??=[]).push(fn)},querySelector:node,querySelectorAll:()=>[]},
 localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},setTimeout(){},setInterval(){},URLSearchParams,location:{search:'',hash:'#/parties'},fetch:()=>new Promise(()=>{})};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../public/app.js'),'utf8'),ctx);



const run=s=>vm.runInContext(s,ctx);
run("S.user={key:'officer',role:'officer'};S.cfg={shotcallerOn:true,roles:[],classes:[]};S.settings.shotcaller={};render=()=>{};route=()=>({page:'shotcaller'})");
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../public/shotcaller.js'),'utf8'),ctx);

test('bridge stays available without an internal session and shutdown offers both choices',()=>{
 ctx.bridge={state:'waiting',desired:true,active:false,partnerGuildId:'alliance',sessions:[],mainEnabled:{},canManageMains:true};
 run("SC={loading:false,data:{active:false,sessionState:'inactive',bridge},error:''};UI.scTab='bridge'");
 const html=run('viewShotcaller()');assert(html.includes('aria-label="Alliance Bridge controls"'));assert(html.includes('>Waiting</strong>'));assert(html.includes('End Alliance Bridge'));
 const dialog=run('scBridgeStopDialog()');assert(dialog.includes('Keep Bridge Waiting'));assert(dialog.includes('End Alliance Bridge'));
});
test('System status works with the existing bot without inventing relay health or latency',()=>{
 run("UI.scTab='status';SC={loading:false,data:{active:true,parties:[{name:'Party one',connected:6}]},error:'',receivedAt:'2026-10-28T12:00:00Z',requestMs:12}");
 const html=run('viewShotcaller()');assert(html.includes('System status'));assert(html.includes('Limited telemetry'));assert(html.includes('Not reported'));assert(html.includes('Party one'));assert(html.includes('Not measured'));assert(!html.includes('1 / 1 ready'));assert(!html.includes('Stop session'));
});
test('reported telemetry shows actual bot states and remains accessible during failures',()=>{
 ctx.status={active:true,muted:false,parties:[{channelId:'a',name:'Alpha',connected:3},{channelId:'b',name:'Beta',connected:4}],diagnostics:{schemaVersion:1,sampledAt:'2026-10-28T12:00:00Z',uptimeSeconds:3660,memoryRssMiB:120,configuredRelays:8,expectedRelays:2,mainBot:{name:'Main <bot>',gatewayReady:true,voiceState:'ready',gatewayPingMs:20},relays:[{index:1,channelId:'a',name:'Relay 1',gatewayReady:true,voiceState:'ready',gatewayPingMs:25,rejoinAttempts:0,playerState:'idle'},{index:2,channelId:'b',name:'Relay 2',gatewayReady:true,voiceState:'disconnected',gatewayPingMs:30,rejoinAttempts:2,playerState:'idle'}]}};
 run("SC={loading:false,data:status,error:'',receivedAt:'2026-10-28T12:00:01Z',requestMs:5};UI.scTab='status'");
 let html=run('viewShotcaller()');assert(html.includes('1 / 2 ready'));assert(html.includes('Main &lt;bot&gt;'));assert(html.includes('disconnected'));assert(html.includes('1h 1m'));assert(html.includes('120 MiB'));assert(html.includes('not end-to-end speech delay'));
 run("SC.error='Network <error>'");html=run('viewShotcaller()');assert(html.includes('Last known snapshot'));assert(html.includes('Network &lt;error&gt;'));assert(html.includes('they are not live'));assert(html.includes('data-tab="session"'));
 run("S.cfg.shotcallerOn=false");html=run('viewShotcaller()');assert(html.includes('Not configured'));
 run("S.cfg.shotcallerOn=true;S.user.role='member'");assert.equal(run('viewShotcaller()'),'<div class="empty">Officers only.</div>');run("S.user.role='officer'");
});
test('failed polls retain the last snapshot and record observations without bot error logs',async()=>{
 ctx.fail=async()=>{throw Error('temporary failure');};run("api=fail;SC={loading:false,data:status,error:'',receivedAt:'2026-10-28T12:00:01Z',requestMs:5}");
 await run('pollShotcaller()');assert.equal(run('SC.data.parties.length'),2);assert.equal(run('SC.error'),'temporary failure');assert.equal(run('scStatusEvents[0].message'),'Control API request failed.');
 ctx.success=async()=>({active:false});run('api=success');await run('pollShotcaller()');assert.equal(run('SC.error'),'');assert.equal(run('SC.data.active'),false);assert(run('SC.receivedAt'));assert(run('scStatusEvents.some(e=>e.message===\'Control API responded.\')'));
});

test('availability dialog is officer-only, offers a single replacement and closes on return',()=>{
 let html='',closed=0;
 ctx.openDialog=value=>{html=value;node('#dlg').open=true;};ctx.closeDialog=()=>{closed++;node('#dlg').open=false;};
 let form=null;ctx.document.querySelector=selector=>selector==='#dlg form[data-form="sc-replacement"]'?form:node(selector);
 run("SC={data:{active:true,sessionId:'session',mainCaller:{showReplacement:true,absenceId:'absence'}},error:''};S.user={role:'officer'};S.settings.shotcaller={candidateUserIds:['caller']};route=()=>({page:'shotcaller'})");node('#dlg').open=false;
 run('scMainAvailability()');assert(html.includes('Main shotcaller unavailable'));assert(html.includes('type="radio"'));assert(html.includes('Set replacement'));assert(html.includes('Wait'));
 form={dataset:{absence:'absence',session:'session'}};run('SC.data.mainCaller.showReplacement=false;scMainAvailability()');assert.equal(closed,1);
 form=null;html='';node('#dlg').open=false;run('S.user.readOnly=true;SC.data.mainCaller.showReplacement=true;scMainAvailability()');assert.equal(html,'');
 ctx.document.querySelector=node;run('S.user.readOnly=false');
});

test('Bridge & Comms is the sole Shotcaller bridge surface and works during startup and failures',async()=>{
 run("S.user.role='officer';S.cfg.shotcallerOn=true;UI.scTab='session';SC={loading:false,error:'',data:{active:false,sessionState:'inactive',bridge}}");
 let html=run('viewShotcaller()');assert(html.includes('data-tab="bridge"'));assert(!html.includes('sc-alliance-bridge'));
 await run("ACTIONS['sc-tab'](null,{tab:'bridge'})");html=run('viewShotcaller()');assert(html.includes('sc-alliance-bridge'));assert(html.includes('End Alliance Bridge'));assert(!html.includes('sc-console-parties'));
 for(const [value,label] of [['off','Disconnected'],['waiting','Waiting'],['connecting','Connecting'],['active','Active'],['paused','Paused'],['reconnecting','Reconnecting']]){ctx.state=value;run('SC.data.bridge.state=state');assert(run('viewShotcaller()').includes('>'+label+'</strong>'));}
 run("SC.data.sessionState='starting'");assert(run('viewShotcaller()').includes('sc-alliance-bridge'));
 run("SC.error='offline'");html=run('viewShotcaller()');assert(html.includes('Status may be outdated'));assert(/<button[^>]*data-act="sc-bridge-toggle"[^>]*disabled/.test(html));
});
test('voice setup names describe the existing manual anchor and channel layouts',()=>{
 run("SC.error='';S.events=[];S.presets=[];S.prefs={};UI.scSetupDraft={}");
 const html=run("scStartForm([{id:'voice',name:'Raid'}])");assert(html.includes('Starting Voice Channel'));assert(html.includes('This channel becomes Party 1'));assert(html.includes('Numbered Party Channels'));assert(!html.includes('plain Party 1-N'));assert(!html.includes('Automatic Channel Selection'));
});
