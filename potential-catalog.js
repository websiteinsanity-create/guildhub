'use strict';
const catalog = require('./catalog/potential-abilities.en.json');
const slots = [
  ['weapon1','Weapon 1','weapon'],['weapon2','Weapon 2','weapon'],
  ['head','Head','armor'],['cloak','Cloak','armor'],['chest','Chest','armor'],
  ['hands','Hands','armor'],['legs','Legs','armor'],['feet','Feet','armor'],
  ['necklace','Necklace','accessory'],['bracelet','Bracelet','accessory'],
  ['ring1','Ring 1','accessory'],['ring2','Ring 2','accessory'],['belt','Belt','accessory']
].map(([id,label,category])=>({id,label,category}));
const entries = catalog.entries;
const lookup = new Map(entries.map(e=>[e.id,e]));
if (lookup.size !== 192 || entries.some(e=>!e.name || !e.description || e.language!=='en')) throw Error('Invalid potential ability catalog.');
function compatible(entry,slot,weapons) {
  if (!entry || !slot) return false;
  if (entry.mainCategory!=='universal' && entry.mainCategory!==slot.category) return false;
  const affinity = weapons;
  return !entry.weapons.length || entry.weapons.some(w=>affinity.includes(w));
}
function validateSelection(slotId,ids,weapons) {
  const slot=slots.find(s=>s.id===slotId);
  if (!slot) throw Error('Unknown equipment slot.');
  if (!Array.isArray(ids) || ids.length>1 || ids.some(id=>typeof id!=='string')) throw Error('Each equipment item can have at most one potential.');
  if (slot.category==='weapon' && !weapons[slotId==='weapon1'?0:1] && ids.length) throw Error('Set this build weapon before assigning potentials.');
  if (ids.some(id=>!compatible(lookup.get(id),slot,weapons))) throw Error('A potential does not match this slot category or build weapon.');
  return ids.slice();
}
module.exports={catalog,entries,lookup,slots,compatible,validateSelection};
