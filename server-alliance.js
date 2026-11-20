'use strict';
// One application/session. Partner operations remain guild-scoped; Insanity administrators
// use their unchanged Insanity identity and the Insanity authority for bridge administration.
module.exports=function install({route,need,shotcaller,allianceGuildId,audit,canAdmin=()=>false,access=()=>({enabled:true,officerRoleIds:[],officerUserIds:[]}),getDb,save=()=>{}}){
 const configured=()=>!!(allianceGuildId && allianceGuildId!==shotcaller.guildId && shotcaller.url && shotcaller.apiKey);
 const ready=()=>need(configured(),409,'Alliance Bridge is not configured.');
 const admin=user=>{need(canAdmin(user),403,'Insanity administrator access is required.');};
 async function bot(path,method='GET',body,{insanity=false}={}){
  ready();let res;
  try{res=await fetch(`${shotcaller.url}/api/guilds/${insanity?shotcaller.guildId:allianceGuildId}${path}`,{method,headers:{authorization:`Bearer ${shotcaller.apiKey}`,'content-type':'application/json',...(insanity?{'x-shotcaller-admin':'true'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(method==='POST' && path==='/session/start'?1100000:10000)});}
  catch{throw Object.assign(Error('Shotcaller is unreachable.'),{status:502});}
  const data=await res.json();need(res.ok,res.status,data.error || 'Shotcaller rejected the request.');return data;
 }
 async function permissions(){
  let bridge=null,bridgeError=null;if(configured())try{bridge=(await bot('/session','GET',undefined,{insanity:true})).bridge;}catch(e){bridgeError=e.message;}
  return{access:access(),bridge:bridge?{allowAllianceManage:!!bridge.allowAllianceManage,bufferMs:bridge.audio?.bufferMs ?? null}:null,bridgeError};
 }
 async function updatePermissions({body,user}){
  admin(user);need(typeof getDb==='function',503,'Alliance access persistence is unavailable.');const before=access(),next={...before};
  if(body.enabled!==undefined){need(typeof body.enabled==='boolean',400,'Portal access must be boolean.');next.enabled=body.enabled;}
  for(const key of ['officerRoleIds','officerUserIds'])if(body[key]!==undefined){need(Array.isArray(body[key]) && body[key].length<=100 && body[key].every(id=>typeof id==='string' && /^\d{15,25}$/.test(id)),400,'Supply valid Discord role or user IDs.');next[key]=[...new Set(body[key])];}
  if(body.allowAllianceManage!==undefined)need(typeof body.allowAllianceManage==='boolean',400,'Main permission must be boolean.');
  if(body.bufferMs!==undefined)need([20,40,60,80,100].includes(body.bufferMs),400,'Choose a 20 to 100 ms buffer in 20 ms steps.');
  let bridge=null;if(body.allowAllianceManage!==undefined || body.bufferMs!==undefined)bridge=await bot('/session/bridge','POST',{action:'settings',allowAllianceManage:body.allowAllianceManage,bufferMs:body.bufferMs},{insanity:true});
  getDb().settings.allianceAccess=next;save();
  audit(user,'alliance.permissions.update',{type:'guild',id:allianceGuildId},`${user.name} updated Alliance access and bridge permissions.`,before,next);
  return{access:next,bridge:bridge?{allowAllianceManage:!!bridge.allowAllianceManage,bufferMs:bridge.audio?.bufferMs ?? null}:null};
 }
 const opts={alliance:true},adminOpts={allianceAdmin:true};
 route('GET','/api/alliance/context',({user})=>({mode:canAdmin(user)?'insanity-admin':'partner',guildId:allianceGuildId,actor:{name:user.name},capabilities:{manageAlliance:true,managePermissions:canAdmin(user),manageBridgeMains:canAdmin(user),manageSwipe:canAdmin(user),manageAudio:canAdmin(user)}}),opts);
 route('GET','/api/alliance/status',async({user}={})=>{const s=await bot('/session');return {active:s.active,sessionState:s.sessionState,sessionId:s.sessionId,muted:s.muted,paused:s.paused,dedicated:s.dedicated || [],additionalCallers:s.additionalCallers || [],parties:s.parties || [],bridge:s.bridge&&canAdmin(user)?{...s.bridge,canManageMains:true,canSwipe:true}:s.bridge};},opts);
 route('GET','/api/alliance/voice-channels',()=>bot('/voice-channels'),opts);
 route('GET','/api/alliance/callers',()=>bot('/callers'),opts);
 for(const action of ['start','stop','mute','pause','dedicated','additional-callers','bridge']){
  route('POST','/api/alliance/'+action,async({body,user})=>{
   let value;
   if(action==='bridge'){need((canAdmin(user)?['start','end','pause','resume','restart','mains','swipe']:['start','end','pause','resume','restart','mains']).includes(body.action),403,'This bridge control is restricted to Insanity.');value={action:body.action,mainEnabled:body.mainEnabled,enabled:body.enabled};}
   else if(action==='start'){need(Number.isInteger(body.count) && body.count>=1 && body.count<=12,400,'Choose 1 to 12 parties.');value={channelId:body.channelId,count:body.count,dedicatedCallerId:body.dedicatedCallerId || null};}
   else value={sessionId:body.sessionId,bridgeChoice:body.bridgeChoice,muted:body.muted,paused:body.paused,userIds:body.userIds};
   if((action==='start' && value.dedicatedCallerId) || ['dedicated','additional-callers'].includes(action)){
    const {callers}=await bot('/callers');const ids=action==='start'?[value.dedicatedCallerId]:value.userIds;
    need(Array.isArray(ids) && ids.length<=(action==='additional-callers'?16:1) && ids.every(id=>callers.some(c=>c.id===id)),400,'Choose an authorised Alliance caller.');
   }
   const result=await bot('/session/'+action,'POST',value,{insanity:action==='bridge' && canAdmin(user)});
   audit(user,action==='bridge'?'alliance.bridge.'+body.action:'alliance.'+action,{type:action==='bridge'?'bridge':'guild',id:action==='bridge'?result.id:allianceGuildId},`${user.name} changed Alliance ${action}${action==='bridge'?' '+body.action:''} for guild ${allianceGuildId}.`);return result;
  },opts);
 }
 route('GET','/api/alliance/permissions',({user})=>{admin(user);return permissions();},adminOpts);
 route('PUT','/api/alliance/permissions',updatePermissions,adminOpts);
 route('GET','/api/alliance-management/overview',async({user})=>{
  admin(user);if(!configured())return{guilds:[],bridge:null,configured:false};
  const [partner,own,guild]=await Promise.allSettled([bot('/session'),bot('/session','GET',undefined,{insanity:true}),bot('/voice-channels')]);
  return{configured:true,guilds:[{guildId:allianceGuildId,name:'Alliance',portalUrl:'/alliance.html',reachable:partner.status==='fulfilled',discordGuildAvailable:guild.status==='fulfilled',sessionState:partner.status==='fulfilled'?partner.value.sessionState || (partner.value.active?'active':'inactive'):'unreachable',active:partner.status==='fulfilled' && !!partner.value.active,parties:partner.status==='fulfilled'?partner.value.parties?.length || 0:0,partnerAccessEnabled:access().enabled}],bridge:own.status==='fulfilled'?own.value.bridge:null,bridgeError:own.status==='rejected'?'Bridge status unavailable.':null};
 },adminOpts);
 route('GET','/api/alliance-management/permissions',({user})=>{admin(user);return permissions();},adminOpts);
 route('PUT','/api/alliance-management/permissions',updatePermissions,adminOpts);
 route('POST','/api/alliance-management/bridge',async({body,user})=>{admin(user);need(['start','end','pause','resume','restart','mains','swipe'].includes(body.action),400,'Unknown bridge action.');const result=await bot('/session/bridge','POST',{action:body.action,enabled:body.enabled,mainEnabled:body.mainEnabled},{insanity:true});audit(user,'alliance.bridge.'+body.action,{type:'bridge',id:result.id},`${user.name} changed the Alliance Bridge (${body.action}) for guild ${allianceGuildId}.`);return result;},adminOpts);
};
