'use strict';
const list=value=>Array.isArray(value)?value.map(String):String(value || '').split(',').map(v=>v.trim()).filter(Boolean);
const SNOWFLAKE=/^\d{15,25}$/;
const minutes=(v,d)=>{const n=Number(v);return Number.isFinite(n) && n>0?n*60e3:d*60e3;};
// User-facing texts for verifyPartner() reasons (never contain ids).
const PARTNER_MESSAGES={
 disabled:'Alliance access is disabled.',
 not_allowlisted:'Your Alliance officer access has been removed.',
 role_missing:'Your Alliance officer access has been removed.',
 not_member:'You are no longer a member of the Alliance Discord server.',
 bot_no_access:'Alliance access cannot be verified right now. Please contact an Insanity administrator.',
 unverifiable:'Alliance access cannot be verified right now. Please try again in a few minutes.',
 wrong_guild:'This Alliance session is not valid for the configured Alliance.',
 not_alliance:'Alliance officer access is required.',
};
const partnerMessage=reason=>PARTNER_MESSAGES[reason] || 'Alliance officer access is required.';
// Evaluate only authenticated Insanity identities. Never promote or replace their session role.
//
// Partner (role 'alliance') rights are decided per request by verifyPartner(): a live bot lookup of the
// partner's membership and roles in ALLIANCE_GUILD_ID, cached per key for ALLIANCE_VERIFY_FRESH_MINUTES
// (default 10). The allow decision is recomputed on every call from the cached LIVE roles and the CURRENT
// allowlist, so allowlist/enable changes apply immediately. While Discord errors (timeouts, 5xx, 429) a previous
// successful membership lookup may be reused up to ALLIANCE_VERIFY_MAX_STALE_MINUTES (default 30); never beyond.
// Unknown Member (10007) denies; the bot not being able to read the partner guild denies (fail-closed).
// Roles carried inside a token (user.allianceRoles) are never used.
module.exports=function createAlliancePolicy({getDb,discord,env=process.env,isOfficerKey=null,now=Date.now}){
 const freshMs=minutes(env.ALLIANCE_VERIFY_FRESH_MINUTES,10);
 const maxStaleMs=Math.max(freshMs,minutes(env.ALLIANCE_VERIFY_MAX_STALE_MINUTES,30));
 const allianceGuildId=()=>String(env.ALLIANCE_GUILD_ID || '');
 function access(){const stored=getDb().settings?.allianceAccess || {};return {enabled:stored.enabled!==false,officerRoleIds:list(stored.officerRoleIds ?? env.ALLIANCE_OFFICER_ROLE_IDS),officerUserIds:list(stored.officerUserIds ?? env.ALLIANCE_OFFICER_USER_IDS)};}
 function canAdmin(user){
  if(!user || !user.discord || user.support || user.readOnly || user.role==='alliance' || user.role==='applicant' || !discord.loginEnabled)return false;
  const db=getDb(),known=db.users?.[user.key];
  if(!known || known.kicked || known.applicant || known.inGuild!==true)return false;
  // Officer status comes from the lead's resolver (env/admin lists + FRESH Discord roles), never from the session.
  if(typeof isOfficerKey==='function'){try{return isOfficerKey(String(user.key))===true;}catch{return false;}}
  // Legacy fallback (no resolver injected): persisted lists and stored roles - still never the token's role.
  const users=[...list(discord.cfg.officerUserIds),...list(db.settings.officerUserIds)];
  const roles=[...list(discord.cfg.officerRoleIds),...list(db.settings.officerRoleIds)];
  return users.includes(String(user.key)) || list(known.discordRoles).some(id=>roles.includes(id));
 }

 // ---- live partner verification ----
 const cache=new Map();     // key -> { member:true, roles, at } | { member:false, at }
 const inflight=new Map();  // key -> Promise of a lookup result (dedupes concurrent requests)
 const diag={lastNoAccessAt:null,lastErrorAt:null,lastOkAt:null,lastNoAccessStatus:null};
 const CACHE_MAX=2000;
 function remember(key,entry){if(!cache.has(key) && cache.size>=CACHE_MAX){const oldest=cache.keys().next().value;cache.delete(oldest);}cache.delete(key);cache.set(key,entry);}
 function decide(key,roles,policy){
  if(policy.officerUserIds.includes(key))return'allowed';
  if(list(roles).some(id=>policy.officerRoleIds.includes(id)))return'allowed';
  return policy.officerRoleIds.length?'role_missing':'not_allowlisted';
 }
 const result=(key,reason,extra={})=>({ok:reason==='allowed',reason,key,...extra});
 async function lookup(guild,key){
  if(inflight.has(key))return inflight.get(key);
  const p=(async()=>{try{const r=await discord.guildMember(guild,key);return r && typeof r==='object'?r:{ok:false,kind:'error'};}catch{return{ok:false,kind:'error'};}})();
  inflight.set(key,p);
  try{return await p;}finally{inflight.delete(key);}
 }
 async function verifyPartner(user){
  if(!user || user.role!=='alliance' || !user.key)return result(user && user.key?String(user.key):null,'not_alliance');
  const key=String(user.key),guild=allianceGuildId();
  if(!SNOWFLAKE.test(key))return result(key,'not_alliance');
  if(!SNOWFLAKE.test(guild) || guild===String(discord.cfg?.guildId || '') || String(user.allianceGuildId || '')!==guild)return result(key,'wrong_guild');
  let policy=access();
  if(!policy.enabled)return result(key,'disabled');
  // Nobody can qualify: no live lookup needed.
  if(!policy.officerUserIds.includes(key) && !policy.officerRoleIds.length)return result(key,'not_allowlisted');
  const t=now(),entry=cache.get(key);
  if(entry && t-entry.at<freshMs){
   policy=access();
   if(!policy.enabled)return result(key,'disabled');
   return entry.member?result(key,decide(key,entry.roles,policy),{cached:true}):result(key,'not_member',{cached:true});
  }
  const r=await lookup(guild,key);
  policy=access();                       // the allowlist may have changed while we waited
  if(!policy.enabled)return result(key,'disabled');
  if(r.ok===true && Array.isArray(r.roles)){
   remember(key,{member:true,roles:r.roles.map(String),at:now()});diag.lastOkAt=now();
   return result(key,decide(key,r.roles,policy));
  }
  if(r.kind==='not_member'){remember(key,{member:false,at:now()});diag.lastOkAt=now();return result(key,'not_member');}
  if(r.kind==='no_access' || r.kind==='no_bot'){cache.delete(key);diag.lastNoAccessAt=now();diag.lastNoAccessStatus=r.status ?? r.kind;return result(key,'bot_no_access');}
  // timeout / 5xx / 429 / network: only a previous POSITIVE membership lookup may be reused, and never beyond maxStale.
  diag.lastErrorAt=now();
  const prev=cache.get(key);
  if(prev && prev.member && now()-prev.at<=maxStaleMs){
   return result(key,decide(key,prev.roles,policy),{cached:true,degraded:true});
  }
  return result(key,'unverifiable');
 }
 // Synchronous gate: requires the verifyPartner() result for this same user. Token roles are ignored.
 function canPartner(user,guildId,verification){
  const policy=access();
  return !!user && user.role==='alliance' && policy.enabled && !!guildId && user.allianceGuildId===guildId
   && !!verification && verification.ok===true && verification.reason==='allowed' && verification.key===String(user.key);
 }
 // Can the bot read members of the partner guild? Used for startup logging and the admin Discord check.
 // Reports reason codes only: 'ok' | 'bot_no_access' | 'unverifiable' | 'no_bot' | 'not_configured'.
 async function diagnose(){
  const guild=allianceGuildId();
  if(!SNOWFLAKE.test(guild) || guild===String(discord.cfg?.guildId || ''))return{ok:false,reason:'not_configured',guildConfigured:false};
  if(!discord.botEnabled)return{ok:false,reason:'no_bot',guildConfigured:true};
  let botId='100000000000000000';
  try{const me=typeof discord.botInfo==='function'?await discord.botInfo():null;if(me && me.ok && SNOWFLAKE.test(String(me.id)))botId=String(me.id);}catch{/* fall back to a placeholder id */}
  let r;try{r=await discord.guildMember(guild,botId);}catch{r={ok:false,kind:'error'};}
  r=r || {ok:false,kind:'error'};
  // 200 or Unknown Member both prove the bot can query that guild's member list.
  if(r.ok===true || r.kind==='not_member')return{ok:true,reason:'ok',guildConfigured:true,canReadMembers:true};
  if(r.kind==='no_access')return{ok:false,reason:'bot_no_access',status:r.status ?? null,guildConfigured:true,canReadMembers:false};
  if(r.kind==='no_bot')return{ok:false,reason:'no_bot',guildConfigured:true};
  return{ok:false,reason:'unverifiable',kind:r.kind || 'error',guildConfigured:true};
 }
 function forget(key){if(key===undefined)cache.clear();else cache.delete(String(key));}
 const verifyStats=()=>({cached:cache.size,freshMs,maxStaleMs,...diag});
 return{access,canAdmin,canPartner,verifyPartner,diagnose,partnerMessage,forget,verifyStats};
};
module.exports.partnerMessage=partnerMessage;
