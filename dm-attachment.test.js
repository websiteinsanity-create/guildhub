// sendDM() gained an optional file attachment (needed to DM a mercenary their own party picture). Tested
// directly against the fake Discord rather than through a full server, since this is a discord.js-level change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFakeDiscord } = require('./fake-discord');
const { createDiscord } = require('../discord.js');

test('sendDM can carry a file attachment, alongside the plain-text DMs it already sends', async () => {
  const fake = await startFakeDiscord();
  try {
    const discord = createDiscord({ DISCORD_BOT_TOKEN: 'bot-token', DISCORD_GUILD_ID: '111111111111111111', DISCORD_API_BASE: fake.url });
    const userId = '100000000000000050';

    const plain = await discord.sendDM(userId, 'Just text, as before');
    assert.equal(plain.ok, true);
    assert.equal(fake.state.dms.at(-1).content, 'Just text, as before');
    assert.equal(fake.state.dms.at(-1).file, null, 'no attachment when none is given');

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
    const withFile = await discord.sendDM(userId, 'Here is your party', { name: 'my-party.png', type: 'image/png', buffer: png });
    assert.equal(withFile.ok, true);
    const sent = fake.state.dms.at(-1);
    assert.equal(sent.content, 'Here is your party');
    assert.ok(sent.file, 'the attachment made it through');
    assert.equal(sent.file.name, 'my-party.png');
    assert.equal(sent.file.png, true, 'the bytes are intact and still look like a real PNG');

    // it is a DM, not a channel post - only the one player can ever see it
    assert.equal(sent.channel, 'dm' + userId);
  } finally {
    fake.close();
  }
});
