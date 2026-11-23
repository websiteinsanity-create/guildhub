'use strict';
// Supported raw GuildHub 1.46.2 exports and versioned hotfix.5 exports. Media bytes
// and session revocations remain separate volume files, never part of a JSON backup.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const LISTS = ['members','events','points','duties','presets','presetRules','loot','series','changes','requests','tags','notices','leaves','warnings','explanations','applications','auditLog','coachLinks','vods','vodScreenshots','vodMarkers','guestCoaches','guestCoachInvites','gearChat','gearScreens','gearFolder','gearSectionTypes'];
const MAPS = ['users','profiles','playerTags','prefs','noticeAcks','gearSkills','gearLinks','gearPotentials','gearSkillOwnership','attendanceStarting'];
const ROOTS = new Set([...LISTS,...MAPS,'nextId','settings','infoBoard','partyBuilderNote','skillCoreCatalog','_guildhubBackup']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = message => { const error = new Error('Invalid or unsupported backup: '+message); error.status = 400; throw error; };
function check(value, depth=0) {
  if (depth > 80) invalid('nesting is too deep.');
  if (!value || typeof value !== 'object') return;
  for (const [key,v] of Object.entries(value)) {
    if (['__proto__','prototype','constructor'].includes(key)) invalid('unsafe property name.');
    check(v,depth+1);
  }
}
function validate(body) {
  if (!object(body)) invalid('expected a database object.');
  check(body);
  for (const key of Object.keys(body)) if (!ROOTS.has(key)) invalid('unknown collection '+key+'.');
  if (body._guildhubBackup !== undefined && (!object(body._guildhubBackup) || body._guildhubBackup.formatVersion !== 1)) invalid('unsupported format version.');
  for (const key of ['members','events','points']) if (!Array.isArray(body[key])) invalid(key+' must be an array.');
  for (const key of LISTS) if (body[key] !== undefined) {
    if (!Array.isArray(body[key]) || body[key].some(x=>!object(x))) invalid(key+' must contain records.');
    const seen=new Set();
    for(const row of body[key]) if(row.id !== undefined) {
      if(!Number.isSafeInteger(row.id) || row.id<1 || seen.has(row.id)) invalid(key+' has invalid or duplicate record IDs.');
      seen.add(row.id);
    }
  }
  for(const key of [...MAPS,'settings','infoBoard','skillCoreCatalog']) if(body[key] !== undefined && !object(body[key])) invalid(key+' must be an object.');
  if(body.nextId !== undefined && (!Number.isSafeInteger(body.nextId) || body.nextId<1)) invalid('nextId is invalid.');
  if(body.partyBuilderNote !== undefined && typeof body.partyBuilderNote !== 'string') invalid('partyBuilderNote is invalid.');
  for(const row of body.members) {
    if(!Number.isSafeInteger(row.id)) invalid('member ID missing.');
    if(row.name !== undefined && typeof row.name !== 'string') invalid('member name is invalid.');
    for(const key of ['builds','questlogs']) if(row[key] !== undefined && (!Array.isArray(row[key]) || row[key].some(v=>!object(v)))) invalid('invalid member '+key+'.');
  }
  for(const rec of Object.values(body.users || {})) if(!object(rec)) invalid('invalid user record.');
  for(const row of body.vods || []) if(row.reviews !== undefined && (!Array.isArray(row.reviews) || row.reviews.some(v=>!object(v)))) invalid('invalid VOD reviews.');
  for(const row of body.gearScreens || []) {
    if(row.images !== undefined && (!Array.isArray(row.images) || row.images.some(x=>typeof x!=='string')))invalid('invalid screenshot images.');
    if(row.previews !== undefined && (!object(row.previews) || Object.values(row.previews).some(x=>typeof x!=='string')))invalid('invalid screenshot previews.');
  }
  for(const row of Object.values(body.gearSkills || {})) if(!object(row) || ['active','owned'].some(k=>row[k]!==undefined && (!Array.isArray(row[k]) || row[k].some(x=>typeof x!=='string'))))invalid('invalid skill-core selection.');
  for(const row of Object.values(body.gearSkillOwnership || {})) if(!Array.isArray(row) || row.some(x=>typeof x!=='string'))invalid('invalid skill-core ownership.');
  for(const row of Object.values(body.gearLinks || {})) if(!Array.isArray(row) || row.some(x=>!object(x)))invalid('invalid build links.');
  for(const row of Object.values(body.gearPotentials || {})) if(!object(row) || row.assignments!==undefined && !object(row.assignments))invalid('invalid potentials.');
  const members=new Set(body.members.map(x=>x.id)),vods=new Set((body.vods || []).map(x=>x.id)),presets=new Set((body.presets || []).map(x=>x.id));
  for(const row of body.vodMarkers || []) if(!vods.has(row.vodId)) invalid('orphaned VOD marker.');
  for(const row of body.presetRules || []) if(!presets.has(row.presetId)) invalid('orphaned preset rule.');
  for(const key of ['gearScreens','gearFolder','gearChat']) for(const row of body[key] || []) {
    if(!members.has(row.memberId)) invalid('orphaned '+key+' record.');
    const m=body.members.find(m=>m.id===row.memberId);
    if(row.buildKey && row.buildKey!=='main' && !(m.builds || []).some(b=>String(b.id)===String(row.buildKey))) invalid('unknown gear build.');
  }
  for(const row of [...body.events,...(body.presets || [])]) if(row.parties !== undefined) {
    if(!Array.isArray(row.parties) || row.parties.length>20) invalid('invalid party list.');
    for(const p of row.parties) {
      const ids=Array.isArray(p)?p:p?.members;
      if(!Array.isArray(ids) || ids.some(id=>!members.has(Number(id)))) invalid('party references unknown member.');
    }
  }
  for(const ev of body.events) {
    for(const k of ['attended','loaOverride','reminderLog']) if(ev[k] !== undefined && !Array.isArray(ev[k])) invalid('invalid event '+k+'.');
    for(const k of ['rsvps','pinEntries','remindersSent']) if(ev[k] !== undefined && !object(ev[k])) invalid('invalid event '+k+'.');
    if(ev.start !== undefined && !Number.isFinite(Date.parse(ev.start))) invalid('invalid event date.');
  }
  for(const series of body.series || []) if(series.skipped !== undefined && !Array.isArray(series.skipped)) invalid('invalid recurring skipped dates.');
  if(body.infoBoard?.categories !== undefined && !Array.isArray(body.infoBoard.categories)) invalid('invalid info board.');
  if(body.skillCoreCatalog) { try {require('./skillcore-catalog').validateCatalog(body.skillCoreCatalog);} catch {invalid('invalid skill-core catalog.');} }
}
function validateSettings(value, defaults, prefix='settings') {
  for(const [key,expected] of Object.entries(defaults)) {
    const actual=value[key];if(actual===undefined || expected===null)continue;
    if(Array.isArray(expected)){if(!Array.isArray(actual))invalid(prefix+'.'+key+' must be an array.');}
    else if(object(expected)){if(!object(actual))invalid(prefix+'.'+key+' must be an object.');validateSettings(actual,expected,prefix+'.'+key);}
    else if(typeof actual!==typeof expected || typeof actual==='number' && !Number.isFinite(actual))invalid(prefix+'.'+key+' has an invalid type.');
  }
}
function prepareDatabase(body, defaults, migrate) {
  validate(body);
  validateSettings(body.settings || {},defaults);
  const candidate=JSON.parse(JSON.stringify(body));
  delete candidate._guildhubBackup;
  require('./security-state').invalidateImported(candidate);
  candidate.settings={...structuredClone(defaults),...(candidate.settings || {})};
  // Allocate above IDs in nested reviews, builds, etc. as well as top-level lists.
  let maxId=0;
  const visit=v=>{if(!v || typeof v!=='object')return;if(Number.isSafeInteger(v.id))maxId=Math.max(maxId,v.id);for(const x of Object.values(v))visit(x);};
  visit(candidate);
  if(maxId>=Number.MAX_SAFE_INTEGER-1) invalid('ID space exhausted.');
  candidate.nextId=Math.max(candidate.nextId || 1,maxId+1);
  try { migrate(candidate); } catch { invalid('legacy migration failed.'); }
  return candidate;
}
function exportDatabase(db, version) {
  return {...db,guestCoachInvites:require('./guest-invites').stripForExport(db.guestCoachInvites),_guildhubBackup:{formatVersion:1,applicationVersion:version}};
}
function commitDatabase(file, candidate) {
  const tmp=file+'.restore-'+randomUUID();let fd;
  try {
    fd=fs.openSync(tmp,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify(candidate));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,file); // last fallible commit operation; memory is swapped only after success
  } catch(error) {
    if(fd!==undefined)try{fs.closeSync(fd);}catch{}
    try{fs.unlinkSync(tmp);}catch{}
    const e=new Error('Backup could not be committed; the existing database was retained.');e.status=503;throw e;
  }
}
module.exports={LISTS,MAPS,validate,prepareDatabase,exportDatabase,commitDatabase};
