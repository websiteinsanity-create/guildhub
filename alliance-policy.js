'use strict';
const list=value=>Array.isArray(value)?value.map(String):String(value || '').split(',').map(v=>v.trim()).filter(Boolean);
// Evaluate only authenticated Insanity identities. Never promote or replace their session role.
module.exports=function createAlliancePolicy({getDb,discord,env=process.env}){
 function access(){const stored=getDb().settings?.allianceAccess || {};return {enabled:stored.enabled!==false,officerRoleIds:list(stored.officerRoleIds ?? env.ALLIANCE_OFFICER_ROLE_IDS),officerUserIds:list(stored.officerUserIds ?? env.ALLIANCE_OFFICER_USER_IDS)};}
 function canAdmin(user){
  if(!user || !user.discord || user.support || user.readOnly || user.role==='alliance' || user.role==='applicant' || !discord.loginEnabled)return false;
  const db=getDb(),known=db.users?.[user.key];
  if(!known || known.kicked || known.applicant || known.inGuild!==true)return false;
  const users=[...list(discord.cfg.officerUserIds),...list(db.settings.officerUserIds)];
  const roles=[...list(discord.cfg.officerRoleIds),...list(db.settings.officerRoleIds)];
  return users.includes(String(user.key)) || list(known.discordRoles).some(id=>roles.includes(id));
 }
 function canPartner(user,guildId){const policy=access();return !!user && user.role==='alliance' && policy.enabled && user.allianceGuildId===guildId && (policy.officerUserIds.includes(String(user.key)) || list(user.allianceRoles).some(id=>policy.officerRoleIds.includes(id)));}
 return{access,canAdmin,canPartner};
};
