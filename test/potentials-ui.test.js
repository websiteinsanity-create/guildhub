const {test}=require('node:test'),path=require('node:path');
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
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),ctx);



ctx.document.getElementById=id=>node('#'+id);
const run=s=>vm.runInContext(s,ctx);
run("S.user={key:'coach',role:'member'};S.isCoach=true;S.members=[];S.users=[];S.cfg={classes:[]};render=()=>{};autosizeAll=()=>{};toast=()=>{};");
vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/geargear.js'),'utf8'),ctx);
const {entries,slots}=require('../potential-catalog');
ctx.thread={memberId:41,name:'Thorne',owner:'coach',buildKey:'main',potentials:{catalog:entries,slots,weapons:['Sword & Shield','Greatsword'],assignments:{weapon2:['SkillSet_WP_Item_Gear_SW2_05_2']},revision:4}};
run("GEARTHREAD={id:'41',data:thread};route=()=>({page:'gearthreads',id:'41'})");
test('main-page accordion shows all slots and full effects and remembers its state per build',()=>{
 let html=run('gearPotentialsHtml(thread)');
 assert(html.includes('>Potentials</span>'));assert(html.includes('1 / 13 slots assigned'));
 assert(html.includes('Boosts Guillotine Blade Damage by 15%.'));
 assert.equal((html.match(/data-act="gear-potential-open"/g)||[]).length,26);
 assert(html.includes('src="/assets/potential-body.svg"'));assert(html.includes(' open>'));
 assert(html.includes('Active skill cores'));assert(html.includes('Other owned skill cores'));
 assert(html.indexOf('gear-combined-cores')>html.indexOf('>Potentials</span>'));
 const key=run("'gear-potentials:'+gearTopicKey(thread)");
 for(const listener of listeners.toggle)listener({target:{dataset:{potentialKey:key},open:false}});
 assert(!run('gearPotentialsHtml(thread)').includes(' open>'));
 assert(run("gearPotentialsHtml({...thread,buildKey:'other'})").includes(' open>'));
});
test('legacy multiple assignments require review instead of appearing equipped',()=>{
 ctx.legacyThread={...ctx.thread,potentials:{...ctx.thread.potentials,assignments:{},legacyAssignments:{weapon2:['SkillSet_WP_Item_Gear_SW2_05_2','all_accuracy']}}};
 const html=run('gearPotentialsHtml(legacyThread)');assert(html.includes('0 / 13 slots assigned'));assert(html.includes('Previous selections need review'));
});
test('slot editor filters correctly and keeps complete descriptions and existing selections',()=>{
 let html='';ctx.show=s=>{html=s;};run('openDialog=show');
 run("ACTIONS['gear-potential-open']({}, {slot:'weapon2'})");
 assert(html.includes('Guillotine Blade Enchant'));assert(html.includes('Boosts Guillotine Blade Damage by 15%.'));
 assert(html.includes('Shield Strike Enchant'));assert(!html.includes('Healing Wave Enchant'));assert(!html.includes('Guillotine Blade Lv +1'));assert(html.includes('checked'));
 run("ACTIONS['gear-potential-open']({}, {slot:'weapon1'})");
 assert(html.includes('Shield Strike Enchant'));assert(html.includes('Guillotine Blade Enchant'));assert(!html.includes('Healing Wave Enchant'));
 assert(html.includes('name="potential"'));assert(html.includes('type="radio"'));assert(!html.includes('type="checkbox"'));assert(html.includes('No potential'));
 assert(html.includes('data-potential-search'));assert(!html.includes('target="_blank"'));
 run("ACTIONS['gear-potential-open']({}, {slot:'head'})");
 assert(html.includes('Death Blow Lv +1'));assert(!html.includes('Willbreaker Lv +1'));
 assert(!html.includes('Guillotine Blade Enchant'));
});
test('saving uses the captured build and revision; switching builds prevents a stale submit',async()=>{
 let requests=[],closed=0,notices=[];
 ctx.bridge=async(...args)=>{requests.push(args);return {...ctx.thread};};
 ctx.notice=(...args)=>notices.push(args);ctx.close=()=>closed++;
 run('api=(...args)=>bridge(...args);toast=notice;closeDialog=close;openDialog=()=>{}');
 const form={querySelectorAll:()=>[{value:'SkillSet_WP_Item_Gear_SW2_05_2'}],querySelector:()=>({disabled:false})};
 ctx.form=form;node('#dlg').contains=f=>f===form;
 run("GEARTHREAD={id:'41',data:thread};ACTIONS['gear-potential-open']({}, {slot:'weapon2'})");
 await run("FORMS['gear-potentials-save'](form)");
 assert.equal(requests.length,1);assert.equal(requests[0][0],'/api/gearthreads/41/potentials');
 assert.equal(requests[0][2].build,'main');assert.equal(requests[0][2].revision,4);
 assert.equal(requests[0][2].ids.length,1);assert.equal(closed,1);
 run("ACTIONS['gear-potential-open']({}, {slot:'weapon2'});GEARTHREAD={id:'41',data:{...thread,buildKey:'other'}}");
 await run("FORMS['gear-potentials-save'](form)");assert.equal(requests.length,1);assert(notices.some(n=>n[0].includes('build changed')));
});
