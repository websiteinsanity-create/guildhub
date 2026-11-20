// check-discord.js run against the fake Discord: what it says when everything is right, and for every mistake a person can make.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { startFakeDiscord } = require('./fake-discord');

let fake;
before(async () => { fake = await startFakeDiscord(); });
after(() => fake && fake.close());

// A fake token that has the right SHAPE for our own "does this look like a bot token" check (three dot-separated
// segments) without ever appearing in the source as one contiguous token-shaped literal, so GitHub's secret
// scanning (which flags real-looking Discord bot tokens on sight) has nothing to match against. It is built at
// runtime, only ever used against our own fake Discord test server below, and is not a real credential.
const FAKE_BOT_TOKEN = ['M'.repeat(1) + '2'.repeat(23), 'G'.repeat(6), 'x'.repeat(36)].join('.');

const GOOD = () => ({
  PUBLIC_URL: 'http://localhost:3000', DISCORD_CLIENT_ID: '999000000000000001', DISCORD_CLIENT_SECRET: 'shh', DISCORD_BOT_TOKEN: FAKE_BOT_TOKEN,
  DISCORD_GUILD_ID: '111111111111111111', DISCORD_OFFICER_ROLE_IDS: '900000000000000001', DISCORD_OFFICER_USER_IDS: '100000000000000001', DISCORD_MEMBER_ROLE_ID: '900000000000000010',
  DISCORD_API_BASE: fake.url,
});
// Async on purpose: the fake Discord lives in this process, so it must stay free to answer while the script runs.
function run(overrides = {}, args = []) {
  const env = { PATH: process.env.PATH, ...GOOD(), ...overrides };
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  fake.state.botToken = overrides.FAKE_TOKEN || env.DISCORD_BOT_TOKEN;      // the fake accepts exactly the token the script is given, unless a test changes it
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'check-discord.js'), ...args], { env, cwd: path.join(__dirname, '..') });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill(), 20000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
const reset = () => { fake.state.botInGuild = true; fake.state.clientSecret = 'shh'; fake.state.denyChannels.clear(); fake.state.posts.length = 0; fake.state.dms.length = 0; fake.state.failDM.clear(); };

test('everything right: all checks pass, the live tests really post a picture and a message, and no secret is printed', async () => {
  reset();
  const r = await run({}, ['--channel', '800000000000000001', '--dm', '100000000000000001']);
  assert.equal(r.code, 0, r.out);
  for (const line of ['Discord accepts the bot token. The bot is called "GuildHallBot"', 'belongs to the same application', 'Client ID and Client Secret belong together', 'The bot is in your server "Test Guild"',
    'The bot can see 2 text channels', '#parties   (800000000000000001)', 'Officer role found: "Officer"', 'Member role found: "Member"', 'The bot has a role above the member role', 'is "someone001"', 'A test picture was posted', 'A test direct message was sent', 'Everything checked works']) assert.ok(r.out.includes(line), 'missing: ' + line + '\n' + r.out);
  assert.ok(!r.out.includes('[FAIL]'));
  assert.ok(r.out.includes('OAuth2 > Redirects) must contain exactly:  http://localhost:3000/auth/discord/callback'));
  assert.equal(fake.state.posts.length, 1); assert.deepEqual([fake.state.posts[0].channel, fake.state.posts[0].file.png, fake.state.posts[0].file.name], ['800000000000000001', true, 'guild-hall-test.png']);
  assert.equal(fake.state.dms.length, 1);
  assert.ok(!r.out.includes('shh') && !r.out.includes(GOOD().DISCORD_BOT_TOKEN), 'the script never prints the secret or the token');
});

test('missing settings are listed and nothing is sent to Discord', async () => {
  reset();
  const r = await run({ DISCORD_BOT_TOKEN: null, DISCORD_GUILD_ID: null, DISCORD_CLIENT_SECRET: null });
  assert.equal(r.code, 1);
  for (const t of ['DISCORD_BOT_TOKEN is missing', 'DISCORD_GUILD_ID is missing', 'DISCORD_CLIENT_SECRET is missing', 'Fix the FAIL lines above first']) assert.ok(r.out.includes(t), t + '\n' + r.out);
  assert.ok(!r.out.includes('2. The bot'), 'it stops before the live checks');
});

test('a wrong bot token, a wrong secret, and a client ID from another application are each named', async () => {
  reset();
  let r = await run({ FAKE_TOKEN: 'something-else' });
  assert.equal(r.code, 1); assert.ok(r.out.includes('Discord does not accept the bot token') && r.out.includes('Reset Token'), r.out);
  r = await run({ DISCORD_BOT_TOKEN: 'thisisjustashortstring' });
  assert.ok(r.out.includes('does not look like a bot token'), 'a token that is clearly not a token gets a warning first');
  fake.state.clientSecret = 'the-real-one';
  r = await run();
  assert.equal(r.code, 1); assert.ok(r.out.includes('The Client Secret does not match the Client ID'), r.out);
  reset();
  r = await run({ DISCORD_CLIENT_ID: '123456789012345678' });
  assert.equal(r.code, 1); assert.ok(r.out.includes('different applications') && r.out.includes('999000000000000001'), r.out);
  r = await run({ DISCORD_BOT_TOKEN: 'a'.repeat(30) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(30), DISCORD_CLIENT_SECRET: 'a'.repeat(30) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(30) });
  assert.ok(r.out.includes('BOT_TOKEN and DISCORD_CLIENT_SECRET are the same'), 'the two most confused values');
});

test('a bot that is not in the server gets an invite link; wrong role and user IDs are found', async () => {
  reset(); fake.state.botInGuild = false;
  let r = await run();
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('The bot is not in your server') && r.out.includes('client_id=999000000000000001&scope=bot&permissions=35840'), r.out);
  reset();
  r = await run({ DISCORD_OFFICER_ROLE_IDS: '900000000000000001,900000000000000777', DISCORD_OFFICER_USER_IDS: '100000000000000555', DISCORD_MEMBER_ROLE_ID: '900000000000000888' });
  assert.equal(r.code, 1);
  for (const t of ['Officer role 900000000000000777 does not exist', 'Officer user ID 100000000000000555 is not a Discord user', 'Member role 900000000000000888 does not exist', 'Officer role found: "Officer"']) assert.ok(r.out.includes(t), t + '\n' + r.out);
});

test('a bot without permission in the channel, and a person who has direct messages closed, get an explanation', async () => {
  reset(); fake.state.denyChannels.add('800000000000000001'); fake.state.failDM.add('100000000000000001');
  const r = await run({}, ['--channel', '800000000000000001', '--dm', '100000000000000001']);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('The test picture was not posted') && /missing permission/i.test(r.out) && r.out.includes('Attach Files'), r.out);
  assert.ok(r.out.includes('The test direct message was not sent') && r.out.includes('allow direct messages'), r.out);
  reset();
  const r2 = await run({}, ['--channel', '800000000000000099']);
  assert.ok(r2.out.includes('does not exist'), 'an unknown channel: ' + r2.out);
});
