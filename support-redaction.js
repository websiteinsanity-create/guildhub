// Clone API responses without changing server data or shared cached results.
const crypto=require('node:crypto');
module.exports=function(secret,knownSecrets=[]){
 const secrets=[...new Set([secret,...knownSecrets].filter(v=>typeof v==='string' && v.length>=4))].sort((a,b)=>b.length-a.length);
 const alias=id=>'ref_'+crypto.createHmac('sha256',secret).update(String(id)).digest('hex').slice(0,20);
 const sensitive=key=>/password|passcode|secret|credential|authorization|cookie|privatekey|apikey|accesstoken|refreshtoken|bottoken|sessiontoken|supportgrant|codehash|passwordhash|clientsecret/.test(key.replace(/[^a-z]/gi,'').toLowerCase()) || /^(token|hash|salt|pin|code)$/i.test(key);
 function text(value){
  let out=value;
  for(const s of secrets)out=out.split(s).join('[redacted]');
  out=out.replace(/https?:\/\/(?:[^/\s]+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"<>]+/gi,'[redacted webhook]');
  out=out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,'$1[redacted]@');
  out=out.replace(/([?&](?:token|password|passcode|key|secret|authorization|code)=)[^&#\s"<>]*/gi,'$1[redacted]');
  out=out.replace(/\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+\/-]+/gi,'[redacted credential]');
  out=out.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted token]');
  out=out.replace(/\b[A-Za-z0-9_-]{20,32}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g,'[redacted token]');
  return out.replace(/(?<!\d)\d{15,22}(?!\d)/g,alias);
 }
 function walk(value){
  if(typeof value==='string')return text(value);
  if(typeof value==='number' && Number.isInteger(value) && Math.abs(value)>=1e14)return alias(value);
  if(Array.isArray(value))return value.map(walk);
  if(value && typeof value==='object'){const result={};for(const [key,v] of Object.entries(value)){if(sensitive(key))continue;Object.defineProperty(result,key.replace(/(?<!\d)\d{15,22}(?!\d)/g,alias),{value:walk(v),enumerable:true,configurable:true,writable:true});}return result;}
  return value;
 }
 return walk;
};
