// Fills a data folder with a fake guild so you can click around.
//   node seed-demo.js            -> writes to ./demo-data (or $DATA_DIR)
// Safe: it never touches ./data unless you point DATA_DIR at it, and it refuses to
// overwrite an existing db.json.

const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR || path.join(__dirname, 'demo-data');
const file = path.join(dir, 'db.json');
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(file)) {
  console.log('Demo data already exists in', dir, '(delete that folder to reset it).');
  process.exit(0);
}

let id = 1;
const next = () => id++;
const H = 36e5, D = 24 * H;
const now = Date.now();
const at = (ms) => new Date(ms).toISOString();

// name, role, primary, secondary, rank, owner, specialization
const cast = [
  ['Vaelin', 'Tank', 'Sword & Shield', 'Greatsword', 'Guild Master', 'Ash', 'Endurance'],
  ['Isolde', 'Healer', 'Wand & Tome', 'Orb', 'Officer', 'Mira', 'Endurance'],
  ['Kestrel', 'DPS', 'Longbow', 'Daggers', 'Officer', 'Dax', 'Crit'],
  ['Marrow', 'DPS', 'Daggers', 'Crossbow', 'Veteran', 'Marrow', 'Burst'],
  ['Thorne', 'Tank', 'Sword & Shield', 'Spear', 'Veteran', 'Thorne', 'Endurance'],
  ['Wren', 'Healer', 'Wand & Tome', 'Longbow', 'Officer', 'Wren', 'Evasion'],
  ['Cassian', 'DPS', 'Greatsword', 'Crossbow', 'Member', 'Cassian', ''],
  ['Odalys', 'DPS', 'Staff', 'Wand & Tome', 'Member', 'Odalys', 'Crit'],
  ['Brannoch', 'DPS', 'Crossbow', 'Sword & Shield', 'Member', 'Brannoch', ''],
  ['Lyra', 'DPS', 'Longbow', 'Staff', 'Member', 'Lyra', 'Evasion'],
  ['Fenn', 'DPS', 'Daggers', 'Longbow', 'Member', 'Fenn', 'Crit'],
  ['Halvard', 'Tank', 'Greatsword', 'Sword & Shield', 'Member', 'Halvard', 'Endurance'],
  ['Sable', 'Healer', 'Wand & Tome', 'Orb', 'Recruit', 'Sable', ''],
  ['Rook', 'DPS', 'Spear', 'Daggers', 'Recruit', 'Rook', ''],
];
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const members = cast.map(([name, role, primaryWeapon, secondaryWeapon, rank, owner, specialization], i) => ({
  id: next(), owner, joinedAt: at(now - (60 - i * 3) * D), name, role, primaryWeapon, secondaryWeapon, rank,
  specialization, gearScore: Math.round(2100 + rnd() * 600), level: 50, discord: name.toLowerCase(),
  timezone: i % 3 === 0 ? 'CET, evenings' : i % 3 === 1 ? 'GMT, late' : 'EST',
  notes: '', active: i !== 13,
  questlogs: i % 4 === 3 ? [] : i % 3 === 0 ? [{ label: 'Main', url: `https://example.com/questlog/${name.toLowerCase()}` }, { label: 'Alt profile', url: `https://example.com/questlog/${name.toLowerCase()}-alt` }] : [{ label: '', url: `https://example.com/questlog/${name.toLowerCase()}` }],
  builds: [], mode: 'PvE',
}));
const ids = members.map((m) => m.id);

// extra builds: PvE / PvP variants and a second class for some players
const build = (o) => ({ id: next(), gearScore: 0, specialization: '', notes: '', ...o });
const isoldePvp = build({ name: 'PvP support', mode: 'PvP', role: 'Healer', primaryWeapon: 'Wand & Tome', secondaryWeapon: 'Staff', specialization: 'Wisdom', gearScore: 2500 });
const kestrelHeal = build({ name: 'Off-heal', mode: 'PvE', role: 'Healer', primaryWeapon: 'Wand & Tome', secondaryWeapon: 'Longbow', specialization: 'Support', gearScore: 2100 });
const vaelinPvp = build({ name: 'PvP tank', mode: 'PvP', role: 'Tank', primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Daggers', specialization: 'Endurance', gearScore: 2300 });
members[1].builds.push(isoldePvp); members[2].builds.push(kestrelHeal); members[0].builds.push(vaelinPvp);
members[4].mode = 'PvP';
members[0].jobs = 'Guild master: siege plans and alliance talks'; members[1].jobs = 'Healer training and the DKP ledger'; members[2].jobs = 'Managing the Wargames'; members[5].jobs = 'Onboarding recruits';

const events = [];
const points = [];
const duties = [];
const presets = [];
const series = [], changes = [], requests = [], tags = [], playerTags = {}, profiles = {};
const infoBoard = { title: 'Guild info', categories: [] };
const leaves = [], warnings = [], explanations = [];
const loot = [];
function addEvent(title, type, startMs, pts, going, maybe, attended, createdBy = 'Ash', mandatory = false) {
  const ev = { id: next(), createdBy, title, type, start: at(startMs), description: '', points: pts, mandatory, maxSignups: 0, signupCloseMinutes: 30, pinWindowMinutes: 15, reminders: true, rsvps: {}, attended: attended || [], parties: [], pin: null, pinEntries: {}, remindersSent: {}, reminderLog: [] };
  going.forEach((m) => (ev.rsvps[m] = 'yes'));
  // (players in the "maybe" list have simply not answered yet)
  events.push(ev);
  for (const m of ev.attended) points.push({ id: next(), memberId: m, delta: pts, reason: `Attended: ${title}`, eventId: ev.id, at: at(startMs + 2 * H), by: 'system' });
  return ev;
}

// past events with attendance recorded (mandatory ones feed the "Qualified for loot" list)
addEvent('Archboss: Kazar', 'Archboss', now - 12 * D, 5, ids.slice(0, 12), [], ids.slice(0, 9), 'Ash', true);
addEvent('Riftstone fight', 'Riftstone', now - 9 * D, 3, ids.slice(0, 11), [], ids.slice(0, 10));
addEvent('Castle siege: Stonegard', 'Castle Siege', now - 7 * D, 10, ids.slice(0, 13), [], [...ids.slice(0, 7), ids[9], ids[10], ids[11]], 'Ash', true);
addEvent('Archboss: Morokai', 'Archboss', now - 4 * D, 5, ids.slice(0, 12), [], [...ids.slice(0, 6), ids[8], ids[10]], 'Mira', true);
addEvent('Dungeon night', 'Dungeon', now - 3 * D, 2, ids.slice(0, 8), [], ids.slice(0, 6));
addEvent('Castle siege: Stonegard', 'Castle Siege', now - 2 * D, 10, ids.slice(0, 13), [], [...ids.slice(0, 5), ...ids.slice(7, 12)], 'Ash', true);

// upcoming
const soon = new Date(now + D); soon.setHours(20, 0, 0, 0);
const siege = addEvent('Castle siege: Stonegard', 'Castle Siege', soon.getTime(), 10, ids.slice(0, 10), ids.slice(10, 12), [], 'Ash', true);
siege.description = 'Meet at the war table 15 minutes early. Bring siege potions and be in voice chat.';
siege.parties = [
  { name: 'Frontline', leader: ids[4], builds: { [ids[2]]: String(kestrelHeal.id) }, members: [ids[4], ids[1], ids[2], ids[3], ids[6], ids[7]] },   // Kestrel plays the healer build here
  { name: 'Backline', leader: ids[0], members: [ids[0], ids[5], ids[8], ids[9]] },
];
const boss = new Date(now + 3 * D); boss.setHours(21, 0, 0, 0);
addEvent('Archboss: Tevent', 'Archboss', boss.getTime(), 5, ids.slice(0, 5), [ids[8]], [], 'Mira', true);
const dun = new Date(soon); dun.setHours(18, 0, 0, 0);
addEvent('Dungeon run', 'Dungeon', dun.getTime(), 2, ids.slice(4, 9), [], [], 'Dax');
const guild = new Date(soon); guild.setHours(21, 30, 0, 0);
addEvent('Guild contracts', 'Guild Contract', guild.getTime(), 1, ids.slice(5, 9), [], [], 'Wren');
const wg = new Date(now + 2 * D); wg.setHours(20, 0, 0, 0);
addEvent('Wargames', 'Wargames', wg.getTime(), 4, ids.slice(0, 9), [ids[9]], [], 'Ash', true);
const tax = new Date(now + 2 * D); tax.setHours(17, 30, 0, 0);
addEvent('Tax delivery', 'Tax delivery', tax.getTime(), 1, ids.slice(2, 5), [], [], 'Dax');
const wb = new Date(now + 5 * D); wb.setHours(19, 0, 0, 0);
addEvent('Worldboss', 'Worldboss (Conflict)', wb.getTime(), 3, ids.slice(0, 7), [], [], 'Mira');
const rift = new Date(now + 4 * D); rift.setHours(20, 0, 0, 0);
addEvent('Riftstone fight', 'Riftstone', rift.getTime(), 3, ids.slice(0, 8), [], [], 'Ash');

// A guild boss that just started, with its attendance PIN already created (players can type 4821 in for the next 15 minutes;
// officers can press "New PIN" on the event at any time). In demo mode nothing is really sent to Discord.
const pinEv = addEvent('Guild bosses', 'Guild bosses', now - 5 * 60000, 3, ids.slice(0, 9), [], [], 'Ash', true);
pinEv.pin = { code: '4821', at: at(now), by: 'automatic', sent: [{ id: 'Ash', name: 'Ash', why: 'leadership', ok: false, error: 'Demo mode: nothing is sent to Discord.' }] };
pinEv.parties = [{ name: 'Boss team', leader: ids[0], members: [ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]] }];

// a weekly recurring event: every Monday 21:00 Berlin time (the server creates the dates when it starts)
const todayIso = new Date(now).toISOString().slice(0, 10);
series.push({ id: next(), title: 'Boonstone fight', type: 'Boonstone', weekdays: [1], intervalWeeks: 1, time: '21:00', tz: 'Europe/Berlin', startDate: todayIso, endDate: '',
  description: 'Weekly boonstone fight. Be in voice chat 15 minutes early.', points: 3, mandatory: false, maxSignups: 0, signupCloseMinutes: 30, pinWindowMinutes: 15, reminders: true, skipped: [], createdBy: 'Ash', at: at(now) });

// leave of absence (Sable is away this week) and one warning for a player with several no-shows
leaves.push({ id: next(), ownerKey: 'Sable', name: 'Sable', from: new Date(now - 2 * D).toISOString().slice(0, 10), to: new Date(now + 5 * D).toISOString().slice(0, 10), reason: 'Exams', status: 'approved', by: 'Sable', at: at(now - 3 * D), decidedBy: 'Ash', decidedAt: at(now - 3 * D) });
leaves.push({ id: next(), ownerKey: 'Odalys', name: 'Odalys', from: new Date(now + 10 * D).toISOString().slice(0, 10), to: new Date(now + 17 * D).toISOString().slice(0, 10), reason: 'Holiday', status: 'pending', by: 'Odalys', at: at(now - 1 * H) });
warnings.push({ id: next(), ownerKey: 'Cassian', name: 'Cassian', kind: 'noshow', reason: '3 no-shows in the last 30 days (limit 3)', auto: true, by: 'system', at: at(now - 2 * D), status: 'active', expiresAt: at(now + 58 * D) });

// leadership tags (only the leadership sees them)
const tTrial = { id: next(), name: 'Trial', color: '#e2a24a' }, tLead = { id: next(), name: 'Raid leader', color: '#5fb8e8' }, tTalk = { id: next(), name: 'Needs a talk', color: '#e2685c' };
tags.push(tTrial, tLead, tTalk);
playerTags.Cassian = [tTrial.id]; playerTags.Mira = [tLead.id]; playerTags.Sable = [tTrial.id, tTalk.id];

// info buttons on the dashboard (under "Next event"): each button opens a popup with the leadership's text
infoBoard.categories = [
  { title: 'Guild rules', buttons: [
    { label: 'Loot rules', text: 'Loot goes to players with at least 60% attendance on mandatory events in the last 14 days.\nAsk in the Requests section if you need Lucent or a specific item for a build.' },
    { label: 'Attendance', text: 'Say Going or Can\'t for every event. If you say Going, please come: no-shows are tracked.\nSign-ups close 30 minutes before the start.' },
    { label: 'Siege etiquette', text: 'Be in voice chat 15 minutes early. Follow your party leader.' } ] },
  { title: 'Links', buttons: [
    { label: 'Discord', text: 'Our server: https://discord.gg/example' },
    { label: 'Questlog help', text: 'Paste the link to your character on Questlog into your profile so the leadership can check your gear.' } ] },
];

// player profiles
profiles.Mira = { bio: 'Healer main since launch. Happy to teach newcomers.', modes: ['PvE', 'PvP'], updatedAt: at(now - 3 * D) };
profiles.Marrow = { bio: 'Dagger player, mostly here for the siege nights.', modes: ['PvP'], updatedAt: at(now - 8 * D) };

// changes waiting for the leadership (weapons and builds need approval by default)
changes.push({ id: next(), status: 'pending', kind: 'member', ownerKey: 'Cassian', memberId: ids[6], changes: { primaryWeapon: { from: 'Greatsword', to: 'Spear' } }, by: 'Cassian', byKey: 'Cassian', at: at(now - 2 * H) });
changes.push({ id: next(), status: 'pending', kind: 'build', op: 'add', ownerKey: 'Lyra', memberId: ids[9], data: { name: 'PvP bow', mode: 'PvP', role: 'DPS', primaryWeapon: 'Longbow', secondaryWeapon: 'Crossbow', specialization: 'Crit', gearScore: 2400, notes: '' }, by: 'Lyra', byKey: 'Lyra', at: at(now - 5 * H) });

// lucent and item requests, per build
requests.push({ id: next(), memberId: ids[1], buildKey: String(isoldePvp.id), kind: 'Lucent', item: '', amount: 1500, lootType: 'Item', reason: 'Enchanting my PvP support set', status: 'open', by: 'Mira', byKey: 'Mira', at: at(now - 6 * H) });
requests.push({ id: next(), memberId: ids[3], buildKey: 'main', kind: 'Item', item: 'Skillcore: Poison Cloud', amount: 0, lootType: 'Skillcore', reason: 'Missing for the siege rotation', status: 'open', by: 'Marrow', byKey: 'Marrow', at: at(now - 26 * H) });
requests.push({ id: next(), memberId: ids[7], buildKey: 'main', kind: 'Lucent', item: '', amount: 800, lootType: 'Item', reason: '', status: 'approved', note: 'Paid out on Friday', decidedBy: 'Ash', decidedAt: at(now - 20 * H), by: 'Odalys', byKey: 'Odalys', at: at(now - 2 * D) });

// saved party presets
presets.push({
  id: next(), name: 'Castle siege line-up', description: 'Main groups for sieges. Swap healers if someone is away.', createdBy: 'Ash', at: at(now - 7 * D),
  parties: [
    { name: 'Frontline', leader: ids[4], members: [ids[4], ids[1], ids[2], ids[3], ids[6], ids[7]] },
    { name: 'Backline', leader: ids[0], members: [ids[0], ids[5], ids[8], ids[9], ids[10], ids[11]] },
    { name: 'Flank', leader: ids[11], members: [ids[12], ids[13]] },
  ],
});
presets.push({
  id: next(), name: 'Archboss squad', description: 'One tight group for boss rotations.', createdBy: 'Mira', at: at(now - 3 * D),
  parties: [{ name: 'Boss team', leader: ids[0], members: [ids[0], ids[1], ids[2], ids[3], ids[7], ids[8]] }],
});

// leadership tasks: character index, text, status
[
  [0, 'Final call on siege lineups', 'doing'],
  [0, 'Alliance talks with Nightfall', 'doing'],
  [0, 'Review recruit applications', 'todo'],
  [1, 'Run Sunday healer training', 'doing'],
  [1, 'Keep the DKP ledger up to date', 'doing'],
  [1, 'Post the weekly event schedule', 'done'],
  [2, 'Trial two DPS recruits', 'todo'],
  [2, 'Plan the Archboss rotation', 'doing'],
  [5, 'Onboard new recruits in Discord', 'doing'],
].forEach(([i, text, status], n) => duties.push({ id: next(), memberId: ids[i], text, status, at: at(now - (10 - n) * H), by: 'Ash' }));

// loot log: who received which item and when (the dashboard counts these per player)
[
  [4, '', 'Lucent', 2, 1200], [1, 'Ancient Oracle Staff', 'Item', 1], [3, 'Boss Cloak of Vigor', 'Item', 2], [4, 'Legendary Greatsword', 'Item', 5], [0, 'Trait extract x3', 'Shard', 6],
  [3, 'Shadow Dagger', 'Item', 9], [7, 'Rare Belt of Focus', 'Item', 12], [1, 'Skillcore: Heal Pulse', 'Skillcore', 3], [3, 'Skillcore: Shadow Step', 'Skillcore', 4],
].forEach(([i, item, type, daysAgo, amount]) => loot.push({ id: next(), memberId: ids[i], item, type, amount: amount || 0, date: new Date(now - daysAgo * D).toISOString().slice(0, 10), by: 'Ash', at: at(now - daysAgo * D) }));

// some manual ledger entries
points.push({ id: next(), memberId: ids[3], delta: -8, reason: 'Loot spent', at: at(now - 5 * D), by: 'Ash' });
points.push({ id: next(), memberId: ids[1], delta: 4, reason: 'Manual bonus', at: at(now - 4 * D), by: 'Ash' });

fs.writeFileSync(file, JSON.stringify({ nextId: id, members, events, points, duties, presets, loot, series, changes, requests, tags, playerTags, profiles, infoBoard, notices: [], noticeAcks: {}, leaves, warnings, explanations, settings: {} }, null, 2));
console.log(`Demo guild written to ${dir}: ${members.length} characters, ${events.length} events.`);
