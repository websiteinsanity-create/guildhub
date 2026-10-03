// A tiny stand-in for Discord's API, used by the tests.
const http = require('http');
function startFakeDiscord() {
  const state = { dms: [], guildMembers: {}, failDM: new Set(), tokens: {}, channels: {}, posts: [], roleAdds: [], roleFail: false, botInGuild: true, denyChannels: new Set(), denyDelete: new Set(), botToken: '', clientSecret: 'shh', knownUsers: ['100000000000000001'],
    roleList: [{ id: '900000000000000001', name: 'Officer', position: 5 }, { id: '900000000000000010', name: 'Member', position: 2 }, { id: '900000000000000099', name: 'GuildHallBot', position: 3 }],
    channelList: [{ id: '800000000000000001', name: 'parties', type: 0, position: 1 }, { id: '800000000000000002', name: 'general', type: 0, position: 0 }, { id: '800000000000000003', name: 'Voice', type: 2, position: 2 }] };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const raw = Buffer.concat(chunks), body = raw.toString('utf8');
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      // The page a browser would see on discord.com: it immediately "approves" and sends the browser back with a code.
      if (req.method === 'GET' && req.url.startsWith('/authorize')) {
        const q = new URL(req.url, 'http://x').searchParams;
        res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${state.nextUser}&state=${q.get('state')}` }); return res.end();
      }
      const path = req.url.replace(/^\/api\/v10/, '');
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, ''), isBot = /^Bot /.test(req.headers.authorization || '');
      if (isBot && state.botToken && req.headers.authorization !== 'Bot ' + state.botToken) return send(401, { message: '401: Unauthorized', code: 0 });     // a wrong bot token
      if (req.method === 'POST' && path === '/oauth2/token') {
        const f = new URLSearchParams(body); const code = f.get('code');
        if (f.get('grant_type') === 'client_credentials') return f.get('client_secret') === (state.clientSecret || 'shh') ? send(200, { access_token: 'cc-token' }) : send(401, { error: 'invalid_client' });
        if (!code || code.startsWith('bad')) return send(400, { error: 'invalid_grant' });
        state.tokens['tok-' + code] = code; return send(200, { access_token: 'tok-' + code });
      }
      if (req.method === 'GET' && path === '/users/@me' && isBot) return send(200, { id: '999000000000000001', username: 'GuildHallBot', bot: true });
      const gi = path.match(/^\/guilds\/(\d+)$/);
      if (req.method === 'GET' && gi && isBot) return state.botInGuild ? send(200, { id: gi[1], name: 'Test Guild' }) : send(404, { code: 10004, message: 'Unknown Guild' });
      const grl = path.match(/^\/guilds\/(\d+)\/roles$/);
      if (req.method === 'GET' && grl && isBot) return send(200, state.roleList);
      const gbm = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/);
      if (req.method === 'GET' && gbm && isBot) return gbm[2] === '999000000000000001' ? send(200, { roles: ['900000000000000099'] }) : send(404, { code: 10007, message: 'Unknown Member' });
      const um = path.match(/^\/users\/(\d+)$/);
      if (req.method === 'GET' && um && isBot) return state.knownUsers.includes(um[1]) ? send(200, { id: um[1], username: 'someone' + um[1].slice(-3) }) : send(404, { code: 10013, message: 'Unknown User' });
      const gc = path.match(/^\/guilds\/(\d+)\/channels$/);
      if (req.method === 'GET' && gc && isBot) return state.botInGuild ? send(200, state.channelList) : send(404, { code: 10004, message: 'Unknown Guild' });
      const gr = path.match(/^\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/);
      if (req.method === 'PUT' && gr && isBot) { if (state.roleFail) return send(403, { code: 50013, message: 'Missing Permissions' }); state.roleAdds.push({ user: gr[2], role: gr[3] }); res.writeHead(204); return res.end(); }
      const pm = path.match(/^\/channels\/(\d+)\/messages$/);
      if (req.method === 'POST' && pm && isBot && /^multipart\/form-data/.test(req.headers['content-type'] || '')) {
        if (!state.channelList.some((c) => c.id === pm[1])) return send(404, { code: 10003, message: 'Unknown Channel' });
        if (state.denyChannels.has(pm[1])) return send(403, { code: 50013, message: 'Missing Permissions' });
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])[1], parts = raw.toString('latin1').split('--' + boundary).slice(1, -1);
        const out = { channel: pm[1], content: '', file: null, mentions: [], deleted: false, components: null, id: '900000000000' + String(state.posts.length + 1).padStart(6, '0') };   // a realistic snowflake-shaped id (15+ digits), not just "1", "2", ... - real code validates the shape
        for (const p of parts) {
          const [head, ...rest] = p.split('\r\n\r\n'), data = rest.join('\r\n\r\n').replace(/\r\n$/, '');
          if (/name="payload_json"/.test(head)) { const pl = JSON.parse(Buffer.from(data, 'latin1').toString('utf8')); out.content = pl.content; out.mentions = (pl.allowed_mentions && pl.allowed_mentions.roles) || []; out.parseAll = !!(pl.allowed_mentions && pl.allowed_mentions.parse && pl.allowed_mentions.parse.length); out.components = pl.components || null; }
          if (/name="files\[0\]"/.test(head)) { const buf = Buffer.from(data, 'latin1'); out.file = { name: /filename="([^"]+)"/.exec(head)[1], size: buf.length, png: buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), base64: buf.toString('base64') }; }
        }
        state.posts.push(out); return send(200, { id: out.id });
      }
      const dm2 = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/);
      if (req.method === 'DELETE' && dm2 && isBot) {
        if (state.denyDelete.has(dm2[1])) return send(403, { code: 50013, message: 'Missing Permissions' });
        const post = state.posts.find((p) => p.id === dm2[2]);
        if (!post || post.channel !== dm2[1] || post.deleted) return send(404, { code: 10008, message: 'Unknown Message' });
        post.deleted = true; res.writeHead(204); return res.end();
      }
      if (req.method === 'GET' && path === '/users/@me') { const id = state.tokens[bearer]; return id ? send(200, { id, username: 'user' + id.slice(-3), global_name: 'Global ' + id.slice(-3), avatar: 'abc123' }) : send(401, {}); }
      const gm = path.match(/^\/users\/@me\/guilds\/(\d+)\/member$/);
      if (req.method === 'GET' && gm) { const id = state.tokens[bearer]; const m = state.guildMembers[id]; return m ? send(200, m) : send(404, { message: 'Unknown Guild Member' }); }
      if (req.method === 'POST' && path === '/users/@me/channels' && isBot) { const r = JSON.parse(body).recipient_id; state.channels['dm' + r] = r; return send(200, { id: 'dm' + r }); }
      const cm = path.match(/^\/channels\/(dm\d+)\/messages$/);
      if (req.method === 'POST' && cm && isBot) {
        const to = state.channels[cm[1]];
        if (state.failDM.has(to)) return send(403, { code: 50007, message: 'Cannot send messages to this user' });
        const out = { channel: cm[1], to, content: '', file: null, components: null };
        if (/^multipart\/form-data/.test(req.headers['content-type'] || '')) {
          // same parsing as the channel-messages multipart handler above - a DM with a picture attached (used to
          // send a mercenary a screenshot of just their own party) goes through the exact same Discord upload
          // shape as a normal channel post, just to a DM channel instead of a guild one.
          const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])[1], parts = raw.toString('latin1').split('--' + boundary).slice(1, -1);
          for (const p of parts) {
            const [head, ...rest] = p.split('\r\n\r\n'), data = rest.join('\r\n\r\n').replace(/\r\n$/, '');
            if (/name="payload_json"/.test(head)) { const pl = JSON.parse(Buffer.from(data, 'latin1').toString('utf8')); out.content = pl.content; out.components = pl.components || null; }
            if (/name="files\[0\]"/.test(head)) { const buf = Buffer.from(data, 'latin1'); out.file = { name: /filename="([^"]+)"/.exec(head)[1], size: buf.length, png: buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), base64: buf.toString('base64') }; }
          }
        } else {
          const pl = JSON.parse(body); out.content = pl.content; out.components = pl.components || null;
        }
        state.dms.push(out); return send(200, { id: String(state.dms.length) });
      }
      send(404, { message: 'not found ' + req.method + ' ' + path });
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ state, url: `http://localhost:${srv.address().port}/api/v10`, origin: `http://localhost:${srv.address().port}`, close: () => srv.close() })));
}
module.exports = { startFakeDiscord };
