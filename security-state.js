'use strict';
const {canonical}=require('./security-ledger');
const clone=v=>JSON.parse(JSON.stringify(v));
const USER=['accepted','inGuild','discordRoles','lastLogin','kicked','kickedAt','kickedBy','kickReason','role','applicant','coach'];
const ACL=['owner','primaryWeapon','secondaryWeapon','mercenary','pendingApproval','mercFor','securityQuarantined'];
const pick=(x,keys)=>Object.fromEntries(keys.filter(k=>x[k]!==undefined).map(k=>[k,clone(x[k])]));
function extract(db){return {users:Object.fromEntries(Object.entries(db.users || {}).map(([k,u])=>[k,pick(u,USER)])),settings:pick(db.settings || {},['officerUserIds','officerRoleIds','coachUserIds','coachRoleIds','allianceAccess']),coachLinks:clone(db.coachLinks || []),guestCoaches:clone(db.guestCoaches || []),guestCoachInvites:clone(db.guestCoachInvites || []),members:Object.fromEntries((db.members || []).map(m=>[String(m.id),{...pick(m,ACL),builds:(m.builds || []).map(b=>({id:b.id,...pick(b,['primaryWeapon','secondaryWeapon','securityQuarantined'])}))}]))};}
function restoreFields(target,record,keys){for(const k of keys){if(record[k]===undefined)delete target[k];else target[k]=clone(record[k]);}}
function reconcile(db,policy){
 db.users=Object.assign(Object.create(null),db.users);db.settings ||= {};
 for(const k of Object.keys(db.users))if(!Object.hasOwn(policy.users,k)){Object.assign(db.users[k],{kicked:true,accepted:false,inGuild:false,discordRoles:[],role:'applicant',applicant:true,coach:false});}
 for(const [k,record] of Object.entries(policy.users)){db.users[k] ||= {id:k,name:'Restored account'};restoreFields(db.users[k],record,USER);}
 restoreFields(db.settings,policy.settings,['officerUserIds','officerRoleIds','coachUserIds','coachRoleIds','allianceAccess']);
 for(const key of ['coachLinks','guestCoaches','guestCoachInvites'])db[key]=clone(policy[key]);
 for(const m of db.members || []){
  const acl=policy.members[String(m.id)];if(!acl){m.securityQuarantined=true;continue;}restoreFields(m,acl,ACL);
  for(const b of m.builds || []){const known=acl.builds.find(x=>x.id===b.id);if(known)restoreFields(b,known,['primaryWeapon','secondaryWeapon','securityQuarantined']);else b.securityQuarantined=true;}
 }
 let max=Number(db.nextId || 1)-1;const visit=v=>{if(!v || typeof v!=='object')return;if(Number.isSafeInteger(v.id))max=Math.max(max,v.id);for(const x of Object.values(v))visit(x);};visit(policy);db.nextId=Math.max(Number(db.nextId || 1),max+1);
 return db;
}
function invalidateImported(db){let count=0;for(const inv of db.guestCoachInvites || []){delete inv.tokenHash;if(inv.status==='pending' || !['redeemed','revoked'].includes(inv.status)){inv.status='revoked';inv.revokedAt=new Date().toISOString();inv.invalidationReason='backup import';count++;}}return count;}
function prepareImport(db,ledger){const imported=clone(db.guestCoachInvites || []);let invalidated=invalidateImported(db);const history=clone(db.guestCoachInvites || []);reconcile(db,ledger.policy());const burned=[];
 for(const inv of db.guestCoachInvites){if(inv.status==='pending'){if(inv.tokenHash)burned.push(inv.tokenHash);delete inv.tokenHash;inv.status='revoked';inv.revokedAt=new Date().toISOString();inv.invalidationReason='backup import';invalidated++;}}
 const seen=new Set(db.guestCoachInvites.map(x=>x.id));for(const row of history)if(!seen.has(row.id)){db.guestCoachInvites.push(row);seen.add(row.id);}
 return {invalidated,burned,importedCount:imported.length};}
function legacySessions(file){const fs=require('node:fs');if(!fs.existsSync(file))return {revoked:{},notBefore:{}};const x=JSON.parse(fs.readFileSync(file,'utf8'));for(const key of ['revoked','notBefore']){if(!x[key] || typeof x[key]!=='object' || Array.isArray(x[key]))throw Error('Invalid legacy revocation map');for(const [k,n] of Object.entries(x[key]))if(!Number.isFinite(n) || n<0 || ['__proto__','constructor','prototype'].includes(k) || key==='revoked' && !/^[a-f0-9]{64}$/.test(k))throw Error('Invalid legacy revocation entry');}require('./security-ledger').validateState({policy:{},sessions:{revoked:x.revoked,notBefore:x.notBefore},burned:{},support:{pending:null,session:null}});return {revoked:x.revoked,notBefore:x.notBefore};}
module.exports={extract,reconcile,invalidateImported,prepareImport,legacySessions,canonical};
