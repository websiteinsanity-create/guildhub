const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/alliance.js'),'utf8');
function ui(){const nodes=new Map(),listeners={},node=key=>{if(!nodes.has(key)){const classes=new Set();nodes.set(key,{innerHTML:'',textContent:'',hidden:true,open:false,dataset:{},classList:{remove:key=>classes.delete(key),toggle(key){if(classes.has(key)){classes.delete(key);return false;}classes.add(key);return true;}},setAttribute(){},focus(){}});}return nodes.get(key);};
 const context={document:{activeElement:null,querySelector:node,querySelectorAll:()=>[],addEventListener:(type,fn)=>{const previous=listeners[type];listeners[type]=event=>{previous?.(event);fn(event);};}},fetch:()=>new Promise(()=>{}),setInterval(){}};
 vm.createContext(context);vm.runInContext(source,context);return{context,node,listeners,run:code=>vm.runInContext(code,context)};
}
function buttonsAreStyled(html){const buttons=[...html.matchAll(/<button\b([^>]*)>/g)];assert(buttons.length>0);for(const [,attrs] of buttons)assert(/class="[^"]*\bbtn\b/.test(attrs),'unstyled button: '+attrs);}
const bridge={state:'active',desired:true,active:true,partnerGuildId:'insanity',mainEnabled:{insanity:true,alliance:true},canManageMains:true,swipe:false,events:[],sessions:[{guildId:'alliance',readyRelays:12,relays:12,warnings:[]}]};
test('all partner controls use the shared button styling in inactive, starting and active sessions',()=>{
 const h=ui();for(const phase of ['inactive','starting','active']){h.context.sample={active:phase==='active',sessionState:phase,parties:[],dedicated:[],additionalCallers:[],bridge};h.run('status=sample;paint()');buttonsAreStyled(h.node('#voice').innerHTML);}
 const page=fs.readFileSync(path.join(__dirname,'../public/alliance.html'),'utf8');buttonsAreStyled(page);assert(page.includes('/alliance.css'));assert(fs.readFileSync(path.join(__dirname,'../public/alliance.css'),'utf8').includes('color-scheme:dark'));
});
test('successful status hides the sign-in link and displays the authenticated state',async()=>{
 const h=ui();h.context.fetch=async()=>({ok:true,json:async()=>({active:false,sessionState:'inactive',bridge})});
 await h.run('poll()');assert.equal(h.node('#sign-in').hidden,true);assert.equal(h.node('#signed-in').hidden,false);
});
test('expired authentication restores the sign-in link; network errors do not invent a sign-out',async()=>{
 const h=ui();h.run('showAuthentication(true)');h.context.fetch=async()=>{throw Error('network down');};await h.run('poll()');assert.equal(h.node('#sign-in').hidden,true);
 h.context.fetch=async()=>({ok:false,status:401,json:async()=>({error:'Please sign in'})});await h.run('poll()');assert.equal(h.node('#sign-in').hidden,false);assert.equal(h.node('#signed-in').hidden,true);
});
test('a rejected bridge permission does not replace the authenticated header with a sign-in link',async()=>{
 const h=ui();h.run('showAuthentication(true)');h.context.fetch=async()=>({ok:false,status:403,json:async()=>({error:'Mains permission revoked'})});
 await assert.rejects(h.run("api('bridge',{action:'mains'})"),/revoked/);assert.equal(h.node('#sign-in').hidden,true);
});
test('shared partner button text has readable contrast on normal, danger and primary buttons',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../public/alliance.css'),'utf8');const value=name=>css.match(new RegExp('--'+name+':\\s*(#[0-9a-f]{6})','i'))[1];
 const luminance=hex=>{const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;};
 for(const [fg,bg] of [['text','panel-2'],['danger','panel-2'],['accent-ink','accent']]){const a=luminance(value(fg)),b=luminance(value(bg));assert((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5,fg+' / '+bg);}
});

test('reference dashboard has working navigation, three status cards and four functional panels',()=>{
 const h=ui();h.context.sample={active:false,sessionState:'inactive',parties:[],bridge};h.run('status=sample;paint()');
 const html=h.node('#voice').innerHTML,nav=h.node('#portal-nav').innerHTML;
 for(const label of ['Dashboard','Shotcaller','Bridge & Comms','Callers & Advisors','Discord Settings'])assert(nav.includes(label));
 for(const label of ['Internal Session','Alliance Bridge','Relay Status','Quick Actions','Session Setup','Bridge Status','Activity Log'])assert(html.includes(label));
 assert.equal((html.match(/class="stat-card"/g) || []).length,3);
 for(const [page,label] of [['shotcaller','Party Channels'],['bridge','PTT Priority'],['callers','Apply Main Caller'],['discord','Available Voice Channels']]){h.run(`navigate('${page}')`);assert(h.node('#voice').innerHTML.includes(label));assert(h.node('#portal-nav').innerHTML.includes(`data-page="${page}" aria-current="page"`));}
});
test('unavailable sessions are not shown as ready; partner settings expose no Insanity admin controls',()=>{
 const h=ui();h.context.sample={active:false,sessionState:'inactive',parties:[],bridge:{...bridge,sessions:[{guildId:'insanity',ready:false,relays:0,readyRelays:0},{guildId:'alliance',ready:true,paused:true,relays:12,readyRelays:12}]}};
 h.run('status=sample;paint()');assert(!h.node('#voice').innerHTML.includes('>Ready<'));assert(h.node('#voice').innerHTML.includes('No session'));h.run("navigate('discord')");const html=h.node('#voice').innerHTML;assert(html.includes('Managed by Insanity'));assert(!html.includes('/api/admin'));assert(!html.includes('data-action="swipe"'));
});
test('session setup choices survive a status refresh and navigation',async()=>{
 const h=ui();h.context.sample={active:false,sessionState:'inactive',parties:[],bridge};h.run("status=sample;channels=[{id:'channel',name:'Alliance Raid'}];setup.channelId='channel';paint()");
 h.listeners.change({target:{id:'setup-count',value:'12',dataset:{}}});h.listeners.change({target:{id:'setup-caller',value:'caller',dataset:{}}});
 h.context.fetch=async()=>({ok:true,json:async()=>h.context.sample});await h.run('poll()');h.run("navigate('shotcaller')");assert.equal(h.run('setup.count'),12);assert.equal(h.run('setup.callerId'),'caller');assert(h.node('#voice').innerHTML.includes('value="12" selected'));
});
test('delegation controls visibility of Bridge Main configuration, while bridge start remains available without a session',()=>{
 const h=ui();h.context.sample={active:false,sessionState:'inactive',parties:[],bridge:{...bridge,desired:false,active:false,canManageMains:false}};h.run("status=sample;navigate('bridge')");let html=h.node('#voice').innerHTML;assert(!html.includes('Apply Main Configuration'));assert(/data-action="bridge"[^>]*>/.test(html));
 h.run('status.bridge.canManageMains=true;status.bridge.desired=true;paint()');html=h.node('#voice').innerHTML;assert(html.includes('Apply Main Configuration'));
});

test('navigation cannot re-enable live actions after a failed status poll',async()=>{
 const h=ui();h.context.sample={active:false,sessionState:'inactive',parties:[],bridge};h.run('status=sample');h.context.fetch=async()=>{throw Error('offline');};await h.run('poll()');h.run("navigate('bridge')");let ran=false;h.context.mutation=()=>{ran=true;};await h.run('act(mutation)');assert.equal(ran,false);assert(h.node('#error').textContent.includes('offline'));
});
test('the new setup form sends its selected channel, party count and main caller to the existing endpoint',async()=>{
 const h=ui(),requests=[];h.context.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>({active:true})};};
 h.run("channels=[{id:'raid',name:'Alliance Raid'}];setup.channelId='raid';setup.count=12;setup.callerId='caller'");await h.run('startRequest()');assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/alliance/start');assert.deepEqual(requests[0].body,{channelId:'raid',count:12,dedicatedCallerId:'caller'});
});

test('Insanity admin context retains all five Portal pages and adds administration without changing identity',()=>{
 const h=ui();h.context.sample={active:false,sessionState:'inactive',parties:[],bridge};h.context.context={mode:'insanity-admin',actor:{name:'Insanity Officer'},capabilities:{managePermissions:true,manageSwipe:true}};
 h.run("status=sample;applyPortalContext(context);portalPermissions={access:{enabled:true,officerRoleIds:[],officerUserIds:[]},bridge:{bufferMs:40,allowAllianceManage:false}};navigate('discord')");
 assert.equal(h.node('#return-to-guildhub').hidden,false);assert.equal(h.node('#access-title').textContent,'Insanity Admin');assert(h.node('#voice').innerHTML.includes('Save Alliance Settings'));assert(h.node('#admin-context').textContent.includes('Insanity Officer'));
 h.run("navigate('bridge')");assert(h.node('#voice').innerHTML.includes('data-action="swipe"'));for(const title of ['Dashboard','Shotcaller','Bridge & Comms','Callers & Advisors','Discord Settings'])assert(h.node('#portal-nav').innerHTML.includes(title));
});
test('partner context has no new administration forms or Insanity Swipe control',()=>{
 const h=ui();h.context.sample={active:false,sessionState:'inactive',parties:[],bridge};h.run("status=sample;applyPortalContext({mode:'partner',capabilities:{}});navigate('discord')");assert.equal(h.node('#return-to-guildhub').hidden,true);assert(!h.node('#voice').innerHTML.includes('Save Alliance Settings'));h.run("navigate('bridge')");assert(!h.node('#voice').innerHTML.includes('data-action="swipe"'));
});

test('partner setup and readiness do not depend on caller presence',()=>{const h=ui();h.context.sample={active:true,sessionState:'active',parties:[],bridge};h.run('status=sample;paint()');const html=h.node('#voice').innerHTML;assert(html.includes('Starting Voice Channel'));assert(html.includes('This channel becomes Party 1'));assert(h.run('available({ready:true,readyRelays:12,relays:12,callerId:"caller",mainAvailable:false})'));});
