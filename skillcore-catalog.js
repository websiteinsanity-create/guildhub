'use strict';
// Local, source-attributed catalog. No runtime scraping and no guessed game effects.
const WEAPONS = ['Sword & Shield','Greatsword','Daggers','Longbow','Crossbow','Staff','Wand & Tome','Spear','Orb','Gauntlet'];
function validateCatalog(input) {
  if (!input || input.schemaVersion !== 1 || input.language !== 'en' || !Array.isArray(input.entries)) throw Error('Expected an English skill-core catalog with schemaVersion 1 and an entries array.');
  if (!input.entries.length) throw Error('The imported catalog must contain entries.');
  const seen = new Set();
  const url = (raw,label) => { if (typeof raw !== 'string') throw Error(`${label} must be an HTTPS URL.`); let u;try{u=new URL(raw);}catch{throw Error(`${label} must be an HTTPS URL.`);} if(u.protocol!=='https:' || u.username || u.password)throw Error(`${label} must be an HTTPS URL.`);return u.href; };
  const text = (raw,label,max) => { if(typeof raw!=='string' || !raw.trim() || raw.length>max)throw Error(`${label} is required (maximum ${max} characters).`);return raw.trim(); };
  const entries = input.entries.map((e,i)=>{
    const id = text(e.id,'Core ID',160);if(!/^[a-zA-Z0-9_.:-]+$/.test(id) || ['__proto__','constructor','prototype'].includes(id))throw Error(`Invalid core ID in row ${i+1}.`);
    if(seen.has(id))throw Error(`Duplicate core ID: ${id}`);seen.add(id);
    if(!['weapon','equipment'].includes(e.slot))throw Error(`Invalid slot for ${id}; use weapon or equipment.`);
    const weapons=e.weapons || [];
    if(!Array.isArray(weapons) || (e.slot==='weapon' && !weapons.length) || weapons.some(w=>!WEAPONS.includes(w)))throw Error(`Valid weapon compatibility is required for ${id}.`);
    return {id,name:text(e.name,'Name',160),slot:e.slot,weapons:[...new Set(weapons)],rarity:text(e.rarity,'Rarity',60),description:text(e.description,'Description',12000),icon:url(e.icon,'Icon'),sourceUrl:url(e.sourceUrl,'Source URL'),descriptionStatus:e.descriptionStatus==='unresolved-source-tokens' || /\.tooltip\b/.test(e.description)?'unresolved-source-tokens':'as-published',availability:e.availability==='legacy'?'legacy':'as-listed'};
  });
  const date=text(input.verifiedAt,'Verification date',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date)throw Error('Verification date must be YYYY-MM-DD.');
  return {schemaVersion:1,language:'en',source:text(input.source,'Source',200),gameVersion:text(input.gameVersion,'Game version',100),verifiedAt:date,entries};
}
function validateActive(ids, catalog, weapons) {
  const lookup=new Map(catalog.map(e=>[e.id,e]));
  if(ids.length>3)throw Error('At most three skill cores can be active per build.');
  if(ids.some(id=>!lookup.has(id)))throw Error('Unknown active skill core.');
  const active=ids.map(id=>lookup.get(id)), weapon=active.filter(e=>e.slot==='weapon');
  if(weapon.length>1)throw Error('Only one weapon skill core can be active.');
  if(active.filter(e=>e.slot==='equipment').length>2)throw Error('Only two armor/accessory skill cores can be active.');
  if(active.some(e=>e.weapons.length && !e.weapons.some(w=>weapons.includes(w))))throw Error('This skill core does not match the selected build weapons.');
}
module.exports={validateCatalog,validateActive,WEAPONS};
