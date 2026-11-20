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
ctx.thread={memberId:41,name:'Player <one>',owner:'student',buildKey:'main',buildClass:'Oracle',builds:[{key:'main',name:'Main build',class:'Oracle'},{key:'42',name:'Alternate',class:'Seeker'}],canPostFolder:true,screens:[{sectionId:1,label:'Equipment',image:'/uploads/gear.png',note:'Saved note <one>',updatedAt:null},{sectionId:2,label:'Stats',image:'',note:'',updatedAt:null}],skillcores:{catalog:[]},questlogs:[{label:'Main build',url:'https://questlog.gg/example'}],folder:[{id:3,kind:'text',postedBy:'coach',postedByName:'Coach',at:'2026-10-24',text:'Upgrade <ring>'}]};
run("GEARTHREAD={id:'41',data:thread,chat:[],chatHasMore:false};route=()=>({page:'gearthreads',id:'41'})");

test('inline screenshot viewer and clipboard uploads respect dialog, build, size and text-paste boundaries',async()=>{
 let currentHtml='',requests=[],readers=[],notices=[];
 ctx.show=html=>{currentHtml=html;nodes.delete('#gear-dropzone');node('#dlg').innerHTML=html;node('#dlg').open=true;};
 ctx.dismiss=()=>{node('#dlg').open=false;};
 ctx.notice=(...args)=>notices.push(args);
 ctx.document.getElementById=id=>['gear-dropzone','gear-dropzone-input','gear-upload-status'].includes(id)?(currentHtml.includes('id="'+id+'"')?node('#'+id):null):node('#'+id);
 ctx.FileReader=class{readAsDataURL(file){this.file=file;readers.push(this);}};
 ctx.bridge=async(url,method,body)=>{requests.push({url,method,body});return {...ctx.thread};};
 run('openDialog=show;closeDialog=dismiss;toast=notice;api=(...args)=>bridge(...args)');
 let html=run('gearScreensHtml(thread)');assert(html.includes('data-act="gear-image-open"'));assert(!html.includes('target="_blank"'));assert(html.includes('Ctrl+V'));
 run("ACTIONS['gear-image-open']({}, {section:1})");assert(currentHtml.includes('gear-image-viewer'));assert(currentHtml.includes('/uploads/gear.png'));assert(currentHtml.includes('Actual size'));assert(currentHtml.includes('data-act="dlg-close"'));assert(!currentHtml.includes('target="_blank"'));
 const zoom=node('#zoom');zoom.getAttribute=k=>zoom.attrs[k];ctx.zoom=zoom;
 run("ACTIONS['gear-image-zoom'](zoom)");assert.equal(zoom.attrs['aria-pressed'],'true');assert(node('#dlg .gear-image-viewport img').classList.contains('actual-size'));
 run("ACTIONS['gear-image-zoom'](zoom)");assert.equal(zoom.textContent,'Actual size');assert(!node('#dlg .gear-image-viewport img').classList.contains('actual-size'));
 ctx.thread.folder.push({id:4,kind:'image',image:'/uploads/folder.png'});run("ACTIONS['gear-image-open']({}, {item:4})");assert(currentHtml.includes('/uploads/folder.png'));
 const file={name:'pasted.png',type:'image/png',size:1000},bodyTarget={closest:()=>null};
 const paste=(data,target=bodyTarget)=>{let prevented=false;const e={clipboardData:data,target,preventDefault(){prevented=true}};for(const listener of listeners.paste || [])listener(e);return prevented;};
 const tick=()=>new Promise(r=>setImmediate(r));
 const finish=async(reader=readers.at(-1))=>{reader.result='data:image/png;base64,UE5H';reader.onload();await tick();};
 // Other dialogs and ordinary text pastes are untouched.
 assert.equal(paste({files:[file]}),false);assert.equal(readers.length,0);
 ctx.dismiss();assert.equal(paste({files:[],items:[]}),false);
 const textTarget={closest:q=>q.includes('input,textarea')?{}:null};assert.equal(paste({files:[file]},textTarget),false);
 // Page paste targets the selected screenshot topic; the image is read once, not pasted as text.
 run("ACTIONS['gear-slide']({}, {section:2})");assert.equal(paste({files:[file]}),true);assert(currentHtml.includes('Upload Stats screenshot'));assert.equal(readers.length,1);assert.equal(readers[0].file,file);
 assert.equal(paste({files:[file]}),true);assert.equal(readers.length,1,'duplicate paste while reading is ignored');
 await finish();assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/gearthreads/41/screens/2');assert.equal(requests[0].body.build,'main');assert.equal(node('#dlg').open,false);
 // Clipboard item fallback works inside the upload modal, independently of the focused button.
 run("ACTIONS['gear-screen-upload-open']({}, {section:1})");assert.equal(paste({items:[{kind:'file',type:'image/png',getAsFile:()=>file}]}),true);await finish();assert.equal(requests.length,2);
 // Invalid and oversized inputs never reach FileReader or the API.
 run("ACTIONS['gear-screen-upload-open']({}, {section:1})");const n=readers.length;
 paste({files:[{...file,size:6000001}]});await tick();assert.equal(readers.length,n);assert(notices.some(v=>v[0].includes('too large')));
 ctx.bad={type:'text/plain',size:1};await run('gearDropHandler(bad)');assert.equal(readers.length,n);
 // Cancelling while reading and opening another build cannot upload or close another dialog.
 paste({files:[file]});ctx.dismiss();await finish();assert.equal(requests.length,2);
 run("ACTIONS['gear-screen-upload-open']({}, {section:1})");paste({files:[file]});run("GEARTHREAD={...GEARTHREAD,data:{...thread,buildKey:'42'}}");await finish();assert.equal(requests.length,2);
 // Failure leaves the modal open and lets the same action be retried.
 run("GEARTHREAD={id:'41',data:thread};ACTIONS['gear-screen-upload-open']({}, {section:1});api=async()=>{throw Error('Upload failed')}");paste({files:[file]});await finish();assert.equal(node('#dlg').open,true);assert.equal(run('gearUploadContext.busy'),false);assert(notices.some(v=>v[0]==='Upload failed'));
 paste({files:[file]});readers.at(-1).onerror();await tick();assert.equal(node('#dlg').open,true);assert.equal(run('gearUploadContext.busy'),false);
 // Folder paste attaches a draft; it never posts automatically. Plain text is still handled by the browser.
 ctx.dismiss();const folderTarget={closest:q=>q==='form[data-form="gear-folder-post"]'?{}:q.includes('input,textarea')?{}:null};
 assert.equal(paste({files:[file]},folderTarget),true);await finish();assert.equal(run('gearFolderImage'),'data:image/png;base64,UE5H');assert.equal(requests.length,2);assert.equal(paste({files:[],items:[]},folderTarget),false);
 run("route=()=>({page:'members'})");assert.equal(paste({files:[file]}),false);
});

test('gallery thumbnails, viewer navigation and multiple uploads append safely',async()=>{
 let html='',requests=[],pending=[];
 ctx.show=h=>{html=h;node('#dlg').open=true;nodes.delete('#gear-dropzone');};
 ctx.document.getElementById=id=>['gear-dropzone','gear-dropzone-input','gear-upload-status'].includes(id)?(html.includes('id="'+id+'"')?node('#'+id):null):node('#'+id);
 ctx.FileReader=class{readAsDataURL(file){this.file=file;pending.push(this);}};
 ctx.bridge=async(url,method,body)=>{requests.push({url,body});return {...ctx.thread};};
 ctx.thread.screens[0].images=[{id:'one',image:'/uploads/one.png'},{id:'two',image:'/uploads/two.png'}];
 run("GEARTHREAD={id:'41',data:thread};route=()=>({page:'gearthreads',id:'41'});api=(...args)=>bridge(...args);openDialog=show;closeDialog=()=>{document.querySelector('#dlg').open=false}");
 assert(run('gearScreensHtml(thread)').includes('2 screenshots'));assert(run('gearScreensHtml(thread)').includes('gear-gallery-move'));
 run("ACTIONS['gear-image-open'](null,{section:1,index:1})");assert(html.includes('2 / 2'));assert(html.includes('/uploads/two.png'));
 run("ACTIONS['gear-image-step'](null,{dir:1})");assert(html.includes('1 / 2'));
 run("ACTIONS['gear-screen-upload-open'](null,{section:1})");assert(html.includes('multiple'));
 ctx.files=[{type:'image/png',size:100,name:'one.png'},{type:'image/png',size:200,name:'two.png'}];
 const work=run('gearDropHandler(files)');assert.equal(pending.length,1);
 pending[0].result='data:image/png;base64,b25l';pending[0].onload();await new Promise(r=>setImmediate(r));assert.equal(pending.length,2);
 pending[1].result='data:image/png;base64,dHdv';pending[1].onload();await work;
 assert.equal(requests.length,2);assert(requests.every(r=>r.body.append===true&&r.body.build==='main'));assert.equal(node('#dlg').open,false);
});
