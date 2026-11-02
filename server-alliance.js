'use strict';
// Separate partner surface: never forwards an arbitrary guild id or API path from the browser.
module.exports=function install({route,need,shotcaller,allianceGuildId,audit}){
 const ready=()=>need(allianceGuildId && allianceGuildId!==shotcaller.guildId && shotcaller.url && shotcaller.apiKey,409,'Alliance Bridge is not configured.');
 async function bot(path,method='GET',body){
  ready();let res;
  try{res=await fetch(`${shotcaller.url}/api/guilds/${allianceGuildId}${path}`,{method,headers:{authorization:`Bearer ${shotcaller.apiKey}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(method==='POST' && path==='/session/start'?1100000:10000)});}
  catch{throw Object.assign(Error('Shotcaller is unreachable.'),{status:502});}
  const data=await res.json();need(res.ok,res.status,data.error || 'Shotcaller rejected the request.');return data;
 }
 const opts={alliance:true};
 route('GET','/api/alliance/status',async()=>{const s=await bot('/session');return {active:s.active,sessionState:s.sessionState,sessionId:s.sessionId,muted:s.muted,paused:s.paused,dedicated:s.dedicated || [],additionalCallers:s.additionalCallers || [],parties:s.parties || [],bridge:s.bridge};},opts);
 route('GET','/api/alliance/voice-channels',()=>bot('/voice-channels'),opts);
 route('GET','/api/alliance/callers',()=>bot('/callers'),opts);
 for(const action of ['start','stop','mute','pause','dedicated','additional-callers','bridge']){
  route('POST','/api/alliance/'+action,async({body,user})=>{
   let value;
   if(action==='bridge'){need(['start','end','mains'].includes(body.action),403,'This bridge control is restricted to Insanity.');value={action:body.action,mainEnabled:body.mainEnabled};}
   else if(action==='start'){
    need(Number.isInteger(body.count) && body.count>=1 && body.count<=12,400,'Choose 1 to 12 parties.');
    value={channelId:body.channelId,count:body.count,dedicatedCallerId:body.dedicatedCallerId || null};
   }else value={sessionId:body.sessionId,bridgeChoice:body.bridgeChoice,muted:body.muted,paused:body.paused,userIds:body.userIds};
   if((action==='start' && value.dedicatedCallerId) || ['dedicated','additional-callers'].includes(action)){
    const {callers}=await bot('/callers');const ids=action==='start'?[value.dedicatedCallerId]:value.userIds;
    need(Array.isArray(ids) && ids.length<=(action==='additional-callers'?16:1) && ids.every(id=>callers.some(c=>c.id===id)),400,'Choose an authorised Alliance caller.');
   }
   const result=await bot('/session/'+action,'POST',value);
   audit(user,'alliance.'+action,{type:'guild',id:allianceGuildId},`${user.name} changed Alliance ${action}.`);return result;
  },opts);
 }
};
