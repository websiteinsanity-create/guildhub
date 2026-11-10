// Hotfix 1.46.2.1 (GH-01): private gear-thread images (gearshot-, gearthumb-, gearfolder-) are only served to
// someone who may open that build's gear thread; branding and event artwork stay public. Every case is also checked
// for parity with GET /api/gearthreads/:id?build=, the rule the images must follow. Fictional data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

const GUILD = '111111111111111111', OFFICER_ROLE = '900000000000000001', SECRET = 'private-uploads-test-secret';
const OWNER = '200000000000000001', OTHER = '200000000000000002', COACH_A = '200000000000000003', COACH_B = '200000000000000004', APPLICANT = '200000000000000005', OFFICER = '200000000000000006';
const T = '2026-10-01T18:00:00.000Z';
const png = (seed) => { const b = Buffer.alloc(300, seed); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); return b; };
const F = { shotMain: 'gearshot-aaaaaaaaaaaa.png', thumbMain: 'gearthumb-bbbbbbbbbbbb.png', folderMain: 'gearfolder-cccccccccccc.png', shotAlt: 'gearshot-dddddddddddd.png',
  orphan: 'gearshot-eeeeeeeeeeee.png', icon: 'icon-ffffffffffff.png', event: 'event-111111111111.png' };

let fake, dir, proc, base;
const user = (id, name, extra = {}) => ({ id, name, username: name.toLowerCase(), avatar: '', role: 'member', inGuild: true, ...extra });
function seed() {
  return {
    nextId: 9000,
    users: { [OWNER]: user(OWNER, 'Owner', { accepted: true }), [OTHER]: user(OTHER, 'Other', { accepted: true }), [COACH_A]: user(COACH_A, 'CoachA', { accepted: true, coach: true }),
      [COACH_B]: user(COACH_B, 'CoachB', { accepted: true, coach: true }), [APPLICANT]: user(APPLICANT, 'Applicant', { role: 'applicant', applicant: true }) },
    members: [
      { id: 501, owner: OWNER, name: 'Ownerchar', role: 'DPS', active: true, primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow', joinedAt: T,          // Battleweaver main build
        builds: [{ id: 7001, name: 'Alt', primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Daggers', role: 'Tank' }] },                              // Berserker extra build
      { id: 502, owner: OTHER, name: 'Otherchar', role: 'DPS', active: true, primaryWeapon: 'Staff', secondaryWeapon: 'Crossbow', joinedAt: T, builds: [] },
    ],
    coachLinks: [{ id: 801, coach: COACH_A, class: 'Battleweaver' }, { id: 802, coach: COACH_B, class: 'Berserker' }],
    gearScreens: [
      { id: 901, memberId: 501, sectionId: 1, images: [F.shotMain], previews: { [F.shotMain]: F.thumbMain }, note: '', updatedAt: T },
      { id: 902, memberId: 501, buildKey: '7001', sectionId: 1, images: [F.shotAlt], note: '', updatedAt: T },
    ],
    gearFolder: [{ id: 903, memberId: 501, buildKey: 'main', postedBy: OFFICER, postedByName: 'Officer', at: T, kind: 'image', text: '', url: '', image: F.folderMain }],
    settings: { coachUserIds: [COACH_A, COACH_B], applications: { enabled: true }, branding: { iconFile: F.icon } },
    gearSectionTypes: [{ id: 1, label: 'Gear' }, { id: 2, label: 'Stats' }],
    events: [], points: [],
  };
}
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const mint = (payload) => { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `gh_session=${body}.${sign(body)}`; };
async function login(id, roles = []) {
  fake.state.guildMembers[id] = { roles, nick: 'n' + id.slice(-2) };
  const s0 = await fetch(base + '/auth/discord', { redirect: 'manual' });
  const jar = s0.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  const st = new URL(s0.headers.get('location')).searchParams.get('state');
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${st}`, { redirect: 'manual', headers: { Cookie: jar } });
  const c = cb.headers.getSetCookie().find((x) => x.startsWith('gh_session=') && !x.startsWith('gh_session=;'));
  assert.ok(c, 'sign-in for ' + id); return c.split(';')[0];
}
const get = (p, cookie) => fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} });

before(async () => {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-private-uploads-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seed()));
  fs.writeFileSync(path.join(dir, 'secret.txt'), SECRET);
  for (const [i, f] of Object.values(F).entries()) fs.writeFileSync(path.join(dir, 'uploads', f), png(i + 1));
  const port = 41000 + Math.floor(Math.random() * 9000); base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'],
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dir, DISCORD_CLIENT_ID: '555', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_URL: base, DISCORD_GUILD_ID: GUILD,
      DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url } });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('server did not start')), 8000); proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } }); });
});
after(() => { if (proc) proc.kill(); if (fake) fake.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('media access matrix: owner, officer, coaches, unrelated member, applicant, anonymous, bad and expired sessions, support, alliance - in parity with the thread API', async () => {
  const S = {
    owner: await login(OWNER), officer: await login(OFFICER, [OFFICER_ROLE]), coachA: await login(COACH_A), coachB: await login(COACH_B),
    other: await login(OTHER), applicant: await login(APPLICANT), anonymous: null,
  };
  S.tampered = S.owner.slice(0, -3) + (S.owner.endsWith('AAA') ? 'BBB' : 'AAA');
  S.expired = mint({ key: OWNER, name: 'Owner', role: 'member', discord: true, exp: Date.now() - 1000 });
  S.alliance = mint({ key: '300000000000000001', name: 'Partner', role: 'alliance', discord: true, exp: Date.now() + 3600e3 });
  const gen = await fetch(base + '/api/admin/support-access/generate', { method: 'POST', headers: { Cookie: S.officer, 'Content-Type': 'application/json' }, body: '{}' });
  const code = (await gen.json()).code;
  const sl = await fetch(base + '/api/support/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'SupportAI', code }) });
  S.support = sl.headers.get('set-cookie').split(';')[0];

  // [file, build the file belongs to]
  const files = [[F.shotMain, 'main'], [F.thumbMain, 'main'], [F.folderMain, 'main'], [F.shotAlt, '7001']];
  const expected = {                                     // main / alt
    owner: [200, 200], officer: [200, 200], coachA: [200, 403], coachB: [403, 200], other: [403, 403], applicant: [403, 403],
    anonymous: [401, 401], tampered: [401, 401], expired: [401, 401], alliance: [403, 403], support: [200, 200],
  };
  const table = [];
  for (const [who, cookie] of Object.entries(S)) for (const [file, build] of files) {
    const r = await get('/uploads/' + file, cookie);
    const want = expected[who][build === 'main' ? 0 : 1];
    table.push(`${who} ${file.split('-')[0]}/${build}: ${r.status}`);
    assert.equal(r.status, want, `${who} -> ${file}`);
    assert.equal(r.headers.get('cache-control'), 'private, no-store', `${who} -> ${file}: never cacheable`);
    if (r.status === 200) { assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('content-security-policy'), "default-src 'none'"); assert.ok((await r.arrayBuffer()).byteLength === 300); }
    else assert.equal((await r.arrayBuffer()).byteLength, 0, 'no image bytes in an error');
    // parity: an image is downloadable exactly when that build's thread can be opened
    const api = await get(`/api/gearthreads/501?build=${build}`, cookie);
    assert.equal(r.status === 200, api.status === 200, `${who} ${build}: image ${r.status} vs thread ${api.status}`);
  }
  console.log(table.join('\n'));
});

test('unreferenced, unknown and malformed names reveal nothing', async () => {
  const officer = await login(OFFICER, [OFFICER_ROLE]);
  const orphan = await get('/uploads/' + F.orphan, officer);
  assert.equal(orphan.status, 404, 'a file no thread references is not served, not even to officers');
  assert.equal(orphan.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get('/uploads/gearshot-999999999999.png', officer)).status, 404);
  assert.equal((await get('/uploads/' + F.orphan)).status, 401, 'anonymous: authentication first, no existence oracle');
  for (const p of ['/uploads/gearshot-AAAAAAAAAAAA.png', '/uploads/gearshot-aaaaaaaaaaaa.png.html', '/uploads/..%2fdb.json', '/uploads/gearshot-aaaaaaaaaaaa.svg']) {
    const r = await get(p, officer); const body = Buffer.from(await r.arrayBuffer());
    assert.ok(!/^image\//.test(r.headers.get('content-type') || ''), p + ' is never served as an image');
    assert.ok(!body.includes(Buffer.from('89504e470d0a1a0a', 'hex')), p + ' contains no image bytes');   // unknown paths fall through to 404 or the app's index page
  }
  // Not covered here: a cookie with a non-ASCII signature (GH-11) hangs every request in 1.46.2 before any route runs.
  // That is a separate, pre-existing finding and deliberately not part of this hotfix.
});

test('branding and event artwork stay public and cacheable', async () => {
  for (const f of [F.icon, F.event]) {
    const r = await get('/uploads/' + f);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', f);
  }
  const cfg = await (await get('/api/config')).json();
  assert.equal(cfg.branding && cfg.branding.icon, '/uploads/' + F.icon, 'login screen still points at the public icon');
});

test('images uploaded through the real routes are served to the owner and refused to others', async () => {
  const owner = await login(OWNER), other = await login(OTHER), officer = await login(OFFICER, [OFFICER_ROLE]);
  const toUrl = (b) => 'data:image/png;base64,' + b.toString('base64');
  const up = await fetch(base + '/api/gearthreads/501/screens/2', { method: 'PUT', headers: { Cookie: owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: toUrl(png(40)), preview: toUrl(png(41)), build: 'main' }) });
  assert.equal(up.status, 200);
  const thread = await up.json();
  const img = thread.screens.find((s) => s.sectionId === 2).images[0];
  const fo = await fetch(base + '/api/gearthreads/501/folder', { method: 'POST', headers: { Cookie: officer, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'image', image: toUrl(png(42)), build: 'main' }) });
  assert.equal(fo.status, 200);
  const folderUrl = (await fo.json()).folder.find((x) => x.kind === 'image' && x.image.includes('gearfolder-') && !x.image.includes(F.folderMain)).image;
  for (const url of [img.image, img.preview, folderUrl]) {
    assert.match(url, /^\/uploads\/gear(shot|thumb|folder)-[a-f0-9]{12}\.png$/);
    assert.equal((await get(url, owner)).status, 200, 'owner ' + url);
    assert.equal((await get(url, other)).status, 403, 'other ' + url);
    assert.equal((await get(url)).status, 401, 'anonymous ' + url);
  }
});
