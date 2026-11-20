#!/usr/bin/env node
// Guild Hall: checks your Discord setup, step by step, and tells you in plain words what works and what does not.
//
//   node check-discord.js                     checks everything, then offers two optional live tests
//   node check-discord.js --channel <id>      also posts a test picture into that channel
//   node check-discord.js --dm <your user id> also sends a test direct message to that person
//
// It reads the same .env file as the app and uses the same Discord code, so if this works, the app works.
// It never prints your token or secret.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

if (typeof fetch !== 'function') { console.error('This needs Node.js 18 or newer (https://nodejs.org). You have ' + process.version + '.'); process.exit(1); }

// The .env file next to this script (real environment variables win), same rules as the app.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: the checks below will say what is missing */ }

const { createDiscord, isSnowflake } = require('./discord');
const discord = createDiscord({ ...process.env, DEMO_MODE: '0', DISCORD_DM_DELAY_MS: '0' });
const cfg = discord.cfg;

// ---------------------------------------------------------------- output
let fails = 0, warns = 0;
const line = (tag, text, hints) => { console.log(` [${tag}] ${text}`); for (const h of [].concat(hints || [])) console.log(`         ${h}`); };
const ok = (t, h) => line(' OK ', t, h);
const bad = (t, h) => { fails++; line('FAIL', t, h); };
const warn = (t, h) => { warns++; line(' !! ', t, h); };
const info = (t, h) => line('info', t, h);
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// A small PNG (a crimson banner) for the picture test.
function testPicture() {
  const w = 240, h = 80, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 172; raw[o + 1] = 45 + Math.round(y / 2); raw[o + 2] = 76; } }
  const crc = (buf) => { let c, t = crc.t || (crc.t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; })); c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const ask = (rl, q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
const flag = (name) => { const i = process.argv.indexOf(name); return i > -1 ? String(process.argv[i + 1] || '') : ''; };

async function main() {
  console.log('Guild Hall: Discord check');

  // ------------------------------------------------------------ 1. the settings in .env
  head('1. Your settings (.env file)');
  const fromFile = fs.existsSync(path.join(__dirname, '.env'));
  fromFile ? ok('.env file found') : warn('No .env file next to this script', 'Copy .env.example to .env and fill it in (README, "Discord setup"). Real environment variables are used too.');
  if (cfg.publicUrl) {
    /^https?:\/\/[^\s/]+/i.test(cfg.publicUrl) ? ok(`PUBLIC_URL is ${cfg.publicUrl}`) : bad('PUBLIC_URL does not look like a web address', 'Example: https://guild.example.com  or  http://localhost:3000');
    if (/^http:\/\//i.test(cfg.publicUrl) && !/localhost|127\.0\.0\.1/.test(cfg.publicUrl)) warn('PUBLIC_URL uses http:// on the internet', 'Use https:// for a site your players open over the internet (a reverse proxy or a tunnel does that for you).');
  } else bad('PUBLIC_URL is missing', 'The address your players open, for example https://guild.example.com');
  cfg.clientId ? (isSnowflake(cfg.clientId) ? ok('DISCORD_CLIENT_ID looks right') : bad('DISCORD_CLIENT_ID does not look right', 'It is a long number (17 to 20 digits): Developer Portal > your application > General Information > Application ID.')) : bad('DISCORD_CLIENT_ID is missing', 'Developer Portal > OAuth2 > Client ID.');
  cfg.clientSecret ? ok('DISCORD_CLIENT_SECRET is set') : bad('DISCORD_CLIENT_SECRET is missing', 'Developer Portal > OAuth2 > Reset Secret, then copy it (it is shown only once).');
  if (cfg.botToken) {
    /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(cfg.botToken) ? ok('DISCORD_BOT_TOKEN has the shape of a bot token')
      : warn('DISCORD_BOT_TOKEN does not look like a bot token', 'A bot token is one long line with two dots in it. You may have copied the Client Secret or the Public Key. Developer Portal > Bot > Reset Token.');
    if (cfg.botToken === cfg.clientSecret) bad('DISCORD_BOT_TOKEN and DISCORD_CLIENT_SECRET are the same', 'They are two different things. The token is on the Bot page, the secret on the OAuth2 page.');
  } else bad('DISCORD_BOT_TOKEN is missing', 'Developer Portal > Bot > Reset Token.');
  cfg.guildId ? (isSnowflake(cfg.guildId) ? ok('DISCORD_GUILD_ID looks right') : bad('DISCORD_GUILD_ID does not look right', 'Discord > User Settings > Advanced > Developer Mode on, then right-click your server icon > Copy Server ID.')) : bad('DISCORD_GUILD_ID is missing', 'Right-click your server icon > Copy Server ID (needs Developer Mode).');
  const idsOk = [...cfg.officerRoleIds, ...cfg.officerUserIds, cfg.memberRoleId].filter(Boolean).every(isSnowflake);
  cfg.officerRoleIds.length || cfg.officerUserIds.length ? (idsOk ? ok('Officers are set (DISCORD_OFFICER_ROLE_IDS / DISCORD_OFFICER_USER_IDS)') : bad('An officer or member ID does not look right', 'They are long numbers separated by commas, without spaces or quotes.'))
    : warn('No officers set', 'Put your own user ID into DISCORD_OFFICER_USER_IDS, otherwise nobody can use the Admin tools.');
  if (!cfg.clientId || !cfg.botToken || !cfg.guildId) { console.log('\nFix the FAIL lines above first, then run this again. The live checks need those three.'); return finish(); }

  // ------------------------------------------------------------ 2. the bot itself
  head('2. The bot');
  let bot;
  try { bot = await discord.botInfo(); } catch (e) { bad('Could not reach Discord', ['Check the internet connection, a firewall or a proxy.', String(e.message || e)]); return finish(); }
  if (bot.ok) {
    ok(`Discord accepts the bot token. The bot is called "${bot.name}"`);
    bot.id === cfg.clientId ? ok('DISCORD_CLIENT_ID belongs to the same application as the bot')
      : bad('DISCORD_CLIENT_ID and the bot are from different applications', [`The bot's application ID is ${bot.id}, but DISCORD_CLIENT_ID is ${cfg.clientId}.`, 'Copy both from the same application in the Developer Portal.']);
  } else bad('Discord does not accept the bot token', [bot.error, 'Developer Portal > Bot > Reset Token, copy the new token into DISCORD_BOT_TOKEN (no quotes, no spaces), and restart.']);

  // ------------------------------------------------------------ 3. sign-in
  head('3. Sign in with Discord');
  const cc = await discord.checkClientSecret().catch((e) => ({ ok: false, error: String(e.message || e) }));
  if (cc.ok) ok('Client ID and Client Secret belong together');
  else if (cc.error === 'invalid_client') bad('The Client Secret does not match the Client ID', 'Developer Portal > OAuth2 > Reset Secret, copy the new secret into DISCORD_CLIENT_SECRET, and restart.');
  else warn('Could not verify the Client Secret', cc.error);
  info(`The Developer Portal (OAuth2 > Redirects) must contain exactly:  ${discord.redirectUri()}`, 'I cannot check this from here. If sign-in later says "Invalid OAuth2 redirect_uri", this line is wrong or missing.');

  // ------------------------------------------------------------ 4. your Discord server
  head('4. Your Discord server');
  const g = await discord.guildInfo().catch((e) => ({ ok: false, error: String(e.message || e) }));
  let inServer = false;
  if (g.ok) { inServer = true; ok(`The bot is in your server "${g.name}"`); }
  else bad('The bot is not in your server (or the server ID is wrong)', [g.error, `Add it with this link (you need the Manage Server permission): ${discord.inviteUrl(false)}`, 'Also check DISCORD_GUILD_ID: it must be the ID of that same server.']);
  if (inServer) {
    const ch = await discord.listChannels();
    if (ch.ok && ch.channels.length) {
      ok(`The bot can see ${ch.channels.length} text ${ch.channels.length === 1 ? 'channel' : 'channels'}`);
      for (const c of ch.channels.slice(0, 15)) console.log(`         #${c.name}   (${c.id})`);
      if (ch.channels.length > 15) console.log(`         ... and ${ch.channels.length - 15} more`);
    } else bad('The bot sees no text channels', ch.error || 'Give the bot role "View Channels" in the server or channel settings.');
    const rl = await discord.listRoles();
    if (rl.ok) {
      const byId = new Map(rl.roles.map((r) => [r.id, r]));
      for (const id of cfg.officerRoleIds) byId.has(id) ? ok(`Officer role found: "${byId.get(id).name}"`) : bad(`Officer role ${id} does not exist on this server`, 'Server Settings > Roles > right-click the role > Copy Role ID.');
      if (cfg.memberRoleId) byId.has(cfg.memberRoleId) ? ok(`Member role found: "${byId.get(cfg.memberRoleId).name}"`) : bad(`Member role ${cfg.memberRoleId} does not exist on this server`, 'Check DISCORD_MEMBER_ROLE_ID, or delete that line if you do not need it.');
      if (cfg.memberRoleId && byId.has(cfg.memberRoleId) && bot.ok) {
        const me = await discord.botMember(bot.id);
        if (me.ok) {
          const top = Math.max(0, ...me.roles.map((r) => (byId.get(r) || { position: 0 }).position));
          top > byId.get(cfg.memberRoleId).position ? ok('The bot has a role above the member role, so it can hand the member role to accepted applicants (it also needs "Manage Roles")')
            : warn('The bot\'s highest role is not above the member role', 'Only matters if you want accepted applicants to get the member role automatically. Server Settings > Roles: drag the bot\'s role above it.');
        }
      }
    } else warn('Could not read the roles of your server', rl.error);
    for (const id of cfg.officerUserIds) {
      const u = await discord.lookupUser(id);
      u.ok ? ok(`Officer user ID ${id} is "${u.name}"`) : bad(`Officer user ID ${id} is not a Discord user`, 'Right-click the person > Copy User ID (needs Developer Mode).');
    }
  }

  // ------------------------------------------------------------ 5. live tests (optional)
  let channelId = flag('--channel'), userId = flag('--dm');
  if (!channelId && !userId && process.stdin.isTTY && inServer) {
    console.log('\nTwo optional live tests. Press Enter to skip either one.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    channelId = await ask(rl, 'Channel ID to post a test picture into: ');
    userId = await ask(rl, 'Your Discord user ID for a test direct message: ');
    rl.close();
  }
  if (channelId || userId) head('5. Live tests');
  if (channelId) {
    const r = await discord.postMessage(channelId, { content: '✅ Guild Hall test: the bot can post pictures in this channel. You can delete this message.', file: { name: 'guild-hall-test.png', type: 'image/png', buffer: testPicture() } });
    r.ok ? ok('A test picture was posted. Look in that channel: this is what "Post to Discord" needs') : bad('The test picture was not posted', [r.error, 'The bot needs View Channel, Send Messages and Attach Files in that channel (channel settings > Permissions).']);
  }
  if (userId) {
    const r = await discord.sendDM(userId, '✅ Guild Hall test: the bot can send you direct messages. PINs, reminders and decisions will arrive like this.');
    r.ok ? ok('A test direct message was sent. Look in your Discord messages') : bad('The test direct message was not sent', [r.error, 'The person must share a server with the bot and allow direct messages from server members (Discord > User Settings > Privacy & Safety).']);
  }
  if (!channelId && !userId) info('Live tests skipped. Run with --channel <channel id> and/or --dm <user id> to try posting and messaging.');
  return finish();
}

function finish() {
  console.log('\n' + '='.repeat(60));
  if (fails) console.log(`${fails} ${fails === 1 ? 'problem' : 'problems'} to fix${warns ? `, ${warns} ${warns === 1 ? 'warning' : 'warnings'}` : ''}. Fix the FAIL lines, then run this again.`);
  else console.log(`Everything checked works${warns ? ` (${warns} ${warns === 1 ? 'warning' : 'warnings'} above)` : ''}.\nNext: start the app, open ${cfg.publicUrl || 'it'}, press "Sign in with Discord", then Admin > Discord > "Check the connection".`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => { console.error('\nUnexpected error: ' + (e && e.message || e)); process.exitCode = 1; });
