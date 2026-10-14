// Tests for the daily schedule Discord post: a banner message plus one message per event for that guild "day"
// (4am cutover, same as the Daily Schedule dashboard panel), each event's own message carrying its own live
// ✅/❌ buttons directly below its own text. Discord always renders a message's buttons after all of that
// SAME message's text, never interleaved mid-message - so this is deliberately several separate messages, not
// one combined post, to get per-event text-then-buttons with the banner on top. A fake Discord API
// (test/fake-discord.js) stands in for Discord.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startFakeDiscord } = require('./fake-discord');

const interactionKeys = crypto.generateKeyPairSync('ed25519');
const interactionPublicKeyHex = interactionKeys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
function signedInteraction(bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), interactionKeys.privateKey).toString('hex');
  return { body, headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp } };
}

const GUILD = '111111111111111111', OFFICER_ROLE = '900000000000000001';
const A = '100000000000000001', B = '100000000000000002';
const PARTIES_CHANNEL = '800000000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(100); } }

let fake, dir, proc, port, base;
const sessions = {};

async function startServer() {
  fake = await startFakeDiscord();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-dailysched-'));
  port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dir, SCHEDULER_INTERVAL_MS: '300', DISCORD_DM_DELAY_MS: '0',
      DISCORD_CLIENT_ID: '555', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_URL: base, DISCORD_GUILD_ID: GUILD,
      DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake.url,
      DISCORD_PUBLIC_KEY: interactionPublicKeyHex,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
}
async function stopServer() {
  if (proc) { proc.kill(); await new Promise((r) => proc.once('exit', r)); }
  fake && fake.close();
  dir && fs.rmSync(dir, { recursive: true, force: true });
}
async function discordLogin(id, roles = []) {
  fake.state.guildMembers[id] = { roles };
  const start = await fetch(base + '/auth/discord', { redirect: 'manual' });
  const oauth = /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${oauth}`, { redirect: 'manual', headers: { Cookie: `gh_oauth=${oauth}` } });
  return /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '')[1];
}
const call = async (p, method = 'GET', body, who) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: `gh_session=${sessions[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const state = async (who) => (await call('/api/state', 'GET', null, who)).body;
const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();
const click = async (customId, userId) => {
  const { body, headers } = signedInteraction({ type: 3, data: { custom_id: customId }, user: { id: userId } });
  const res = await fetch(`${base}/discord/interactions`, { method: 'POST', headers, body });
  return { status: res.status, body: await res.json() };
};
// Every real message posted to the daily-schedule channel so far, in post order.
const schedulePosts = () => fake.state.posts.filter((p) => p.channel === PARTIES_CHANNEL && !p.deleted);
const bannerPosts = () => schedulePosts().filter((p) => p.file);
const eventPosts = () => schedulePosts().filter((p) => !p.file);
const postFor = (title) => eventPosts().find((p) => p.content.includes(title));

before(async () => {
  await startServer();
  sessions.A = await discordLogin(A, [OFFICER_ROLE]);
  sessions.B = await discordLogin(B, []);
  // postHour: 0 makes the automatic tick fire the instant it is enabled, regardless of the real wall-clock
  // hour where the test happens to run - guildHour(now) is never less than 0, so the "not time yet" guard in
  // dailyScheduleTick never holds anything back. This keeps the test deterministic without faking the clock.
  await call('/api/admin/discord', 'PUT', { dailySchedulePost: { channelId: PARTIES_CHANNEL, postHour: 0 } }, 'A');
});
after(stopServer);

test('officers set the channel/hour/mention-roles for the daily schedule post, members cannot', async () => {
  assert.equal((await call('/api/admin/discord', 'PUT', { dailySchedulePost: { postHour: 5 } }, 'B')).status, 403);
  const bad = await call('/api/admin/discord', 'PUT', { dailySchedulePost: { postHour: 24 } }, 'A');
  assert.equal(bad.status, 400);
  const saved = (await call('/api/admin/discord', 'PUT', { dailySchedulePost: { mentionRoleIds: [OFFICER_ROLE] } }, 'A')).body;
  assert.deepEqual(saved.dailySchedulePost.mentionRoleIds, [OFFICER_ROLE]);
  assert.equal(saved.dailySchedulePost.channelId, PARTIES_CHANNEL, 'earlier setting (in before()) untouched by this unrelated field update');
  await call('/api/admin/discord', 'PUT', { dailySchedulePost: { mentionRoleIds: [] } }, 'A');   // leave it clean for the tests below
});

test('switching the automatic post on posts the banner once for today, even across several scheduler ticks', async () => {
  const ev = (await call('/api/events', 'POST', { title: 'Auto post test event', type: 'Other', start: inMinutes(120), reminders: false }, 'A')).body;
  assert.equal((await call('/api/admin/discord', 'PUT', { dailySchedulePost: { enabled: true } }, 'B')).status, 403, 'officers only');
  await call('/api/admin/discord', 'PUT', { dailySchedulePost: { enabled: true } }, 'A');
  await waitFor(() => postFor('Auto post test event'));
  const banner = await waitFor(() => bannerPosts()[0]);
  assert.match(banner.content, /Today's schedule/);
  assert.equal(banner.file.name, 'daily-schedule.png');
  assert.ok(banner.file.png, 'a real PNG, not an empty/broken attachment');
  assert.equal(banner.components, null, 'the banner message carries no buttons of its own');

  const countAfterFirst = schedulePosts().length;
  await sleep(1200);   // several more scheduler ticks (300ms each)
  assert.equal(schedulePosts().length, countAfterFirst, 'still exactly one banner + one event message for today, not reposted per tick');
  assert.equal(bannerPosts().length, 1, 'only one banner ever, for the whole day');
  await call('/api/admin/discord', 'PUT', { dailySchedulePost: { enabled: false } }, 'A');
});

test('each event gets its own separate message, text with its own buttons directly below, posted after the banner', async () => {
  const lead = (await call('/api/members', 'POST', { name: 'ScheduleLead', role: 'Tank', primaryWeapon: 'Sword & Shield', secondaryWeapon: 'Greatsword' }, 'A')).body;
  const mem = (await call('/api/members', 'POST', { name: 'ScheduleMem', role: 'DPS' }, 'B')).body;
  const ev1 = (await call('/api/events', 'POST', { title: 'Siege prep', type: 'Castle Siege', start: inMinutes(150), reminders: false }, 'A')).body;
  const ev2 = (await call('/api/events', 'POST', { title: 'Guild bosses run', type: 'Guild bosses', start: inMinutes(180), reminders: false }, 'A')).body;
  await call(`/api/events/${ev1.id}/rsvp`, 'POST', { memberId: lead.id, status: 'yes' }, 'A');

  const before = schedulePosts().length;   // the earlier auto-post test already has a banner + one event message for today
  const posted = await call('/api/admin/discord/daily-schedule/post-now', 'POST', {}, 'A');
  assert.equal(posted.status, 200, JSON.stringify(posted.body));

  assert.equal(bannerPosts().length, 1, 'still just the one banner - "post now" never reposts it');
  assert.equal(schedulePosts().length, before + 2, 'two brand-new messages, one for each new event - the earlier event keeps its own existing message');

  const p1 = postFor('Siege prep'), p2 = postFor('Guild bosses run');
  assert.ok(p1 && p2, 'each event has its own message');
  assert.notEqual(p1.id, p2.id, 'genuinely separate messages, not one shared post');
  assert.match(p1.content, /🔒 Mandatory/, 'Castle Siege is a mandatory type');
  assert.match(p1.content, /✅ 1 going · ❌ 0 can't · ❔ 1 no reply/, 'Siege prep: Lead answered yes, Mem has not answered');
  assert.match(p2.content, /✅ 0 going · ❌ 0 can't · ❔ 2 no reply/, 'Guild bosses run: nobody has answered yet');
  assert.doesNotMatch(p1.content, /Guild bosses run/, "each event's message only ever mentions its own event");

  assert.equal(p1.components.length, 1, "one action row - this event's own buttons, directly under its own text in THIS message");
  const [goBtn, noBtn] = p1.components[0].components;
  assert.equal(goBtn.custom_id, `schedrsvp:${ev1.id}:yes`);
  assert.equal(noBtn.custom_id, `schedrsvp:${ev1.id}:no`);

  // clicking it answers inside Discord: a private ephemeral confirmation, and only THIS event's own message is touched
  const r = await click(noBtn.custom_id, B);
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 4, 'a private, ephemeral reply - not UPDATE_MESSAGE');
  assert.equal(r.body.data.flags, 64, 'ephemeral: only the clicker sees this');
  assert.match(r.body.data.content, /can't come/i);
  assert.equal((await state('A')).events.find((e) => e.id === ev1.id).rsvps[mem.id], 'no');

  const refreshed = await waitFor(() => { const p = eventPosts().find((x) => x.id === p1.id); return p && p.edits ? p : null; });
  assert.equal(schedulePosts().length, before + 2, 'still the same messages - refreshed, not reposted');
  assert.match(refreshed.content, /✅ 1 going · ❌ 1 can't · ❔ 0 no reply/, 'Siege prep now also shows Mem\'s "can\'t"');
  const p2again = eventPosts().find((x) => x.id === p2.id);
  assert.equal(p2again.edits || 0, 0, "Guild bosses run's own separate message is untouched by Siege prep's click");

  // pressing "post now" again just refreshes the still-current messages instead of posting duplicates
  const again = await call('/api/admin/discord/daily-schedule/post-now', 'POST', {}, 'A');
  assert.equal(again.status, 200);
  assert.equal(schedulePosts().length, before + 2, 'no duplicate messages');
});

test('a bad click (unknown event, closed sign-ups, no character) replies ephemerally without crashing', async () => {
  const { body: missingBody, headers: missingHeaders } = signedInteraction({ type: 3, data: { custom_id: 'schedrsvp:999999:yes' }, user: { id: A } });
  const missing = await fetch(`${base}/discord/interactions`, { method: 'POST', headers: missingHeaders, body: missingBody });
  const missingJson = await missing.json();
  assert.equal(missingJson.type, 4);
  assert.match(missingJson.data.content, /could not be found/);

  const closed = (await call('/api/events', 'POST', { title: 'Already closing', type: 'Other', start: inMinutes(1), signupCloseMinutes: 2, reminders: false }, 'A')).body;
  await sleep(1300);   // sign-ups close 2 minutes before the start of an event only 1 minute out - already closed
  const r = await click(`schedrsvp:${closed.id}:yes`, A);
  assert.equal(r.body.type, 4);
  assert.match(r.body.data.content, /already closed/);

  const r2 = await click(`schedrsvp:${closed.id}:yes`, '999999999999999999');
  assert.match(r2.body.data.content, /could not find your character/i);
});

test('changing the channel clears the tracked live messages, so the next post goes out fresh rather than editing messages in the old channel', async () => {
  const GENERAL_CHANNEL = '800000000000000002';
  const before = (await state('A')).settings;
  assert.equal(before.dailySchedulePost.channelId, PARTIES_CHANNEL);
  const after = (await call('/api/admin/discord', 'PUT', { dailySchedulePost: { channelId: GENERAL_CHANNEL } }, 'A')).body;
  assert.equal(after.dailySchedulePost.channelId, GENERAL_CHANNEL);
  assert.equal(after.dailySchedulePost.current, null, 'no live messages carried over to the new channel');
  await call('/api/admin/discord', 'PUT', { dailySchedulePost: { channelId: PARTIES_CHANNEL } }, 'A');   // restore for any later test runs
});

test('a new game day deletes yesterday\'s banner and event messages before posting today\'s fresh ones', async () => {
  // A standalone server+fake-bot pair, separate from the shared one above, seeded with a db.json that already
  // has a "yesterday" live block tracked - the cleanest way to exercise a real day rollover without waiting
  // for one or faking the system clock.
  const fake2 = await startFakeDiscord();
  const oldBanner = { channel: PARTIES_CHANNEL, content: 'old banner', file: { name: 'old.png' }, mentions: [], deleted: false, components: null, id: '900000000000000101' };
  const oldEvent = { channel: PARTIES_CHANNEL, content: 'old event', file: null, mentions: [], deleted: false, components: null, id: '900000000000000102' };
  fake2.state.posts.push(oldBanner, oldEvent);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-hall-dailysched-rollover-'));
  const yesterday = new Date(Date.now() - 36 * 3600000).toISOString().slice(0, 10);   // a calendar day definitely not "today"
  fs.writeFileSync(path.join(dir2, 'db.json'), JSON.stringify({
    nextId: 1000,
    settings: {
      dailySchedulePost: {
        channelId: PARTIES_CHANNEL, channelName: 'parties', mentionRoleIds: [], enabled: false, postHour: 0,
        lastPostedDay: yesterday,
        current: { gameDay: yesterday, channelId: PARTIES_CHANNEL, bannerMessageId: oldBanner.id, events: { 1: oldEvent.id } },
      },
    },
  }));
  const port2 = 40000 + Math.floor(Math.random() * 20000), base2 = `http://localhost:${port2}`;
  const proc2 = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port2), DATA_DIR: dir2, SCHEDULER_INTERVAL_MS: '300', DISCORD_DM_DELAY_MS: '0',
      DISCORD_CLIENT_ID: '555', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_URL: base2, DISCORD_GUILD_ID: GUILD,
      DISCORD_OFFICER_ROLE_IDS: OFFICER_ROLE, DISCORD_BOT_TOKEN: 'bot-token', DISCORD_API_BASE: fake2.url,
      DISCORD_PUBLIC_KEY: interactionPublicKeyHex,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 8000);
      proc2.stdout.on('data', (d) => { if (String(d).includes('running')) { clearTimeout(t); resolve(); } });
      proc2.on('exit', (c) => reject(new Error('server exited early: ' + c)));
    });
    fake2.state.guildMembers[A] = { roles: [OFFICER_ROLE] };
    const start = await fetch(base2 + '/auth/discord', { redirect: 'manual' });
    const oauth = /gh_oauth=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
    const cb = await fetch(`${base2}/auth/discord/callback?code=${A}&state=${oauth}`, { redirect: 'manual', headers: { Cookie: `gh_oauth=${oauth}` } });
    const session2 = /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '')[1];
    const call2 = async (p, method = 'GET', body) => {
      const res = await fetch(base2 + p, { method, headers: { 'Content-Type': 'application/json', Cookie: `gh_session=${session2}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    await call2('/api/events', 'POST', { title: 'Today real event', type: 'Other', start: inMinutes(60), reminders: false });
    const posted = await call2('/api/admin/discord/daily-schedule/post-now', 'POST', {});
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    assert.equal(fake2.state.posts.find((p) => p.id === oldBanner.id).deleted, true, "yesterday's banner message was deleted");
    assert.equal(fake2.state.posts.find((p) => p.id === oldEvent.id).deleted, true, "yesterday's event message was deleted");
    const live = fake2.state.posts.filter((p) => p.channel === PARTIES_CHANNEL && !p.deleted);
    assert.ok(live.some((p) => p.file), "today's fresh banner was posted");
    assert.ok(live.some((p) => p.content.includes('Today real event')), "today's fresh event message was posted");
  } finally {
    proc2.kill();
    await new Promise((r) => proc2.once('exit', r));
    fake2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});
