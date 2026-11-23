// GuildHub - READ-ONLY data summary for before/after upgrade comparison. Prints counts only: no names, ids,
// tokens or message text. Usage (on the Docker host, any GuildHub image that has node):
//   docker run --rm --network none -v <DATA>:/d:ro -v <release>/deploy/rc4:/s:ro --entrypoint node <image> /s/guildhub-data-summary.js /d
'use strict';
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || '/data';
const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null);
const out = {};
for (const k of Object.keys(db).sort()) { const c = count(db[k]); if (c !== null) out[k] = c; }
const ev = Array.isArray(db.events) ? db.events : [];
out['events.rsvps(total)'] = ev.reduce((n, e) => n + Object.keys(e.rsvps || {}).length, 0);
out['events.attended(total)'] = ev.reduce((n, e) => n + (Array.isArray(e.attended) ? e.attended.length : 0), 0);
out['members.active'] = (db.members || []).filter((m) => m.active).length;
out['users.officers'] = Object.values(db.users || {}).filter((u) => u && u.role === 'officer').length;
let up = []; try { up = fs.readdirSync(path.join(dir, 'uploads')); } catch {}
out['uploads(files)'] = up.length;
out['uploads(gear, private)'] = up.filter((f) => /^(gearshot|gearthumb|gearfolder)-/.test(f)).length;
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(28) + v);
