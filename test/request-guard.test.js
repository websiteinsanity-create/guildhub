// Hotfix 1.46.2.2: request-guard.js - same-origin check for cookie mutations and proxy-aware client IP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sameOrigin, clientIp, parseTrusted, ipInList, _formatIp } = require('../request-guard');

const req = (headers = {}, remoteAddress = '203.0.113.9') => ({ headers, socket: { remoteAddress } });

test('sameOrigin with PUBLIC_URL: full origin (scheme, host, port) must match', () => {
  const PUB = 'https://guild.example.com';
  const cases = [
    [{ origin: 'https://guild.example.com' }, true, 'exact'],
    [{ origin: 'https://GUILD.example.com' }, true, 'host case-insensitive'],
    [{ origin: 'https://guild.example.com:443' }, true, 'default https port normalised'],
    [{ origin: 'http://guild.example.com' }, false, 'scheme mismatch http vs https'],
    [{ origin: 'https://guild.example.com:8443' }, false, 'port mismatch'],
    [{ origin: 'https://evil.example.com' }, false, 'other host'],
    [{ origin: 'https://guild.example.com.evil.com' }, false, 'suffix trick'],
    [{ origin: 'https://evil.com/guild.example.com' }, false, 'path trick'],
    [{ origin: 'null' }, false, 'Origin null'],
    [{ origin: '' }, false, 'empty Origin'],
    [{ origin: 'garbage' }, false, 'garbage Origin'],
    [{ origin: 'file://' }, false, 'file scheme'],
    [{ origin: 'https://user:pw@guild.example.com' }, false, 'credentials in origin'],
    [{ origin: 'https://guild.example.com, https://evil.com' }, false, 'two origins joined'],
    [{ origin: ['https://guild.example.com', 'https://guild.example.com'] }, false, 'array Origin'],
    [{ origin: 'https://evil.com', 'sec-fetch-site': 'same-origin' }, false, 'Origin wins over Sec-Fetch-Site'],
    [{ origin: 'https://guild.example.com', host: 'other.internal' }, true, 'Host ignored when PUBLIC_URL is set'],
  ];
  for (const [h, want, why] of cases) assert.equal(sameOrigin(req(h), PUB), want, why);
});

test('sameOrigin PUBLIC_URL normalisation: explicit default port, trailing path, non-default port', () => {
  assert.equal(sameOrigin(req({ origin: 'https://g.example' }), 'https://g.example:443/some/path/'), true);
  assert.equal(sameOrigin(req({ origin: 'http://g.example' }), 'http://g.example:80'), true);
  assert.equal(sameOrigin(req({ origin: 'http://localhost:3000' }), 'http://localhost:3000'), true);
  assert.equal(sameOrigin(req({ origin: 'http://localhost:3001' }), 'http://localhost:3000'), false);
  assert.equal(sameOrigin(req({ origin: 'http://localhost' }), 'http://localhost:3000'), false);
  assert.equal(sameOrigin(req({ origin: 'http://[::1]:3000' }), 'http://[::1]:3000'), true);
  assert.equal(sameOrigin(req({ origin: 'https://g.example' }), 'not a url'), false, 'misconfigured PUBLIC_URL fails closed');
});

test('sameOrigin without PUBLIC_URL (demo/passcode) compares Origin host with Host header', () => {
  const cases = [
    [{ origin: 'http://localhost:3000', host: 'localhost:3000' }, true, 'same host:port'],
    [{ origin: 'http://example.com', host: 'example.com:80' }, true, 'default port in Host'],
    [{ origin: 'https://example.com', host: 'example.com' }, true, 'https behind proxy, Host without port'],
    [{ origin: 'https://example.com', host: 'example.com:443' }, true, 'https default port'],
    [{ origin: 'http://localhost:3001', host: 'localhost:3000' }, false, 'port differs'],
    [{ origin: 'http://evil.com', host: 'localhost:3000' }, false, 'host differs'],
    [{ origin: 'http://localhost:3000' }, false, 'no Host header'],
    [{ origin: 'http://localhost:3000', host: 'localhost:3000, evil' }, false, 'garbage Host'],
    [{ origin: 'http://evil.com', host: 'evil.com@localhost' }, false, 'userinfo in Host'],
    [{ origin: 'null', host: 'localhost:3000' }, false, 'Origin null'],
  ];
  for (const [h, want, why] of cases) {
    assert.equal(sameOrigin(req(h), ''), want, why);
    assert.equal(sameOrigin(req(h), undefined), want, why + ' (undefined publicUrl)');
  }
});

test('sameOrigin without Origin: Sec-Fetch-Site decides, else only JSON bodies pass', () => {
  const PUB = 'https://guild.example.com';
  const cases = [
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'SAME-ORIGIN' }, true],
    [{ 'sec-fetch-site': 'none' }, true],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{ 'sec-fetch-site': 'same-site' }, false],
    [{ 'sec-fetch-site': 'weird' }, false],
    [{ 'sec-fetch-site': '' }, false],
    [{ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, false],
    [{ 'content-type': 'application/json' }, true],
    [{ 'content-type': 'Application/JSON; charset=utf-8' }, true],
    [{ 'content-type': 'text/plain; application/json' }, false],
    [{ 'content-type': 'text/plain;charset=application/json' }, false],
    [{ 'content-type': 'application/x-www-form-urlencoded' }, false],
    [{ 'content-type': 'multipart/form-data; boundary=x' }, false],
    [{ 'content-type': 'application/jsonp' }, false],
    [{}, false],
  ];
  for (const [h, want] of cases) {
    assert.equal(sameOrigin(req(h), PUB), want, JSON.stringify(h));
    assert.equal(sameOrigin(req(h), ''), want, JSON.stringify(h) + ' (no PUBLIC_URL)');
  }
});

test('sameOrigin never throws on garbage input', () => {
  for (const r of [null, undefined, {}, { headers: null }, { headers: { origin: 42 } }, { headers: { origin: {} } }, req({ origin: 'x'.repeat(10000) })]) {
    assert.equal(sameOrigin(r, 'https://g.example'), false);
  }
});

test('parseTrusted / ipInList: IPv4, IPv6, CIDRs, mapped IPv4, garbage ignored', () => {
  const list = parseTrusted(' 10.0.0.0/8, 172.18.0.0/16 ,192.168.1.5, ::1, fd00::/8, 2001:db8::/32, ::ffff:100.64.0.0/106, bogus, 1.2.3.4/33, 300.1.1.1, ::/x, ,');
  assert.equal(list.length, 7, 'invalid entries are dropped');
  const cases = [
    ['10.1.2.3', true], ['11.0.0.1', false],
    ['172.18.0.2', true], ['172.19.0.2', false],
    ['::ffff:172.18.0.2', true, 'mapped IPv4 matches IPv4 CIDR'],
    ['::FFFF:172.18.0.2', true],
    ['0:0:0:0:0:ffff:ac12:0002', true, 'hex-form mapped IPv4'],
    ['192.168.1.5', true], ['192.168.1.6', false],
    ['::1', true], ['0:0:0:0:0:0:0:1', true], ['[::1]', true], ['::2', false],
    ['fd12:3456::1', true], ['fe80::1', false],
    ['2001:db8:ffff::1', true], ['2001:db9::1', false],
    ['100.64.3.4', true, 'mapped CIDR stored as IPv4 /10'], ['100.128.0.1', false],
    ['010.1.2.3', false, 'leading zeros rejected'],
    ['', false], ['garbage', false], ['1.2.3', false], ['1.2.3.4.5', false], ['::1::2', false],
  ];
  for (const [ip, want, why] of cases) assert.equal(ipInList(ip, list), want, why || ip);
  assert.equal(ipInList('10.0.0.1', '10.0.0.0/8'), true, 'accepts a raw string list');
  assert.equal(ipInList('10.0.0.1', ['10.0.0.0/8']), true, 'accepts an array of strings');
  assert.equal(ipInList('10.0.0.1', ''), false);
  assert.equal(ipInList('10.0.0.1', undefined), false);
  assert.equal(ipInList(null, list), false);
  assert.equal(ipInList('8.8.8.8', '0.0.0.0/0'), true, '/0 matches everything of that family');
  assert.equal(ipInList('::1', '0.0.0.0/0'), false, 'but not the other family');
});

test('IP formatting normalises mapped IPv4, ports and brackets', () => {
  assert.equal(_formatIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(_formatIp('1.2.3.4:5678'), '1.2.3.4');
  assert.equal(_formatIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(_formatIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(_formatIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(_formatIp('2001:db8::1:443'), '2001:db8::1:443', 'unbracketed IPv6 is never treated as having a port');
  assert.equal(_formatIp('unknown'), null);
});

test('clientIp: no TRUSTED_PROXIES -> socket address only, all forwarding headers ignored', () => {
  const r = req({ 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '2.2.2.2', 'x-real-ip': '3.3.3.3' }, '203.0.113.9');
  assert.equal(clientIp(r), '203.0.113.9');
  assert.equal(clientIp(r, {}), '203.0.113.9');
  assert.equal(clientIp(r, { trustedProxies: '' }), '203.0.113.9');
  assert.equal(clientIp(r, { trustedProxies: '', header: 'cf-connecting-ip' }), '203.0.113.9');
  assert.equal(clientIp(req({}, '::ffff:198.51.100.7')), '198.51.100.7', 'mapped peer is reported as IPv4');
});

test('clientIp: spoofed headers from an untrusted peer are ignored', () => {
  const T = { trustedProxies: '172.18.0.0/16, ::1' };
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }, '203.0.113.9'), T), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '172.18.0.5' }, '203.0.113.9'), T), '203.0.113.9');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.1.1.1' }, '203.0.113.9'), { ...T, header: 'cf-connecting-ip' }), '203.0.113.9', 'Cloudflare header from untrusted peer');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }, '2001:db8::5'), T), '2001:db8::5');
});

test('clientIp: trusted peer -> walk X-Forwarded-For right to left', () => {
  const T = { trustedProxies: '172.18.0.0/16, 10.0.0.0/8, ::1, fd00::/8' };
  const cases = [
    ['1.1.1.1', '172.18.0.2', '1.1.1.1', 'single hop'],
    ['1.1.1.1', '::ffff:172.18.0.2', '1.1.1.1', 'mapped trusted peer (Docker dual-stack)'],
    ['6.6.6.6, 1.1.1.1', '172.18.0.2', '1.1.1.1', 'client-supplied left entry ignored'],
    ['6.6.6.6, 1.1.1.1, 10.0.0.7', '172.18.0.2', '1.1.1.1', 'multi-hop: trusted entries skipped'],
    ['6.6.6.6,1.1.1.1,10.0.0.7,172.18.0.9', '172.18.0.2', '1.1.1.1', 'no spaces, two trusted hops'],
    ['2001:db8::77, fd00::3', '::1', '2001:db8::77', 'IPv6 chain'],
    ['[2001:db8::77]:5555', '::1', '2001:db8::77', 'bracketed IPv6 with port'],
    ['1.1.1.1:4321', '172.18.0.2', '1.1.1.1', 'IPv4 with port'],
    ['::ffff:8.8.4.4', '172.18.0.2', '8.8.4.4', 'mapped client'],
    ['10.0.0.1, 172.18.0.3', '172.18.0.2', '172.18.0.2', 'all hops trusted -> peer'],
    ['', '172.18.0.2', '172.18.0.2', 'empty header -> peer'],
    ['garbage', '172.18.0.2', '172.18.0.2', 'garbage -> peer'],
    ['1.1.1.1, unknown', '172.18.0.2', '172.18.0.2', 'unparsable hop ends the trusted chain -> peer, never further left'],
    ['1.1.1.1, , 10.0.0.1', '172.18.0.2', '172.18.0.2', 'empty hop ends the chain'],
    ['6.6.6.6, 999.1.1.1', '172.18.0.2', '172.18.0.2', 'invalid octet'],
    ['1.1.1.1, 2.2.2.2', '172.18.0.2', '2.2.2.2', 'rightmost untrusted wins'],
  ];
  for (const [xff, peer, want, why] of cases) assert.equal(clientIp(req({ 'x-forwarded-for': xff }, peer), T), want, why);
  assert.equal(clientIp(req({}, '172.18.0.2'), T), '172.18.0.2', 'no header -> peer');
  assert.equal(clientIp(req({ 'x-forwarded-for': ['6.6.6.6', '1.1.1.1'] }, '172.18.0.2'), T), '1.1.1.1', 'array header joined');
  assert.equal(clientIp(req({ 'x-forwarded-for': Array(200).fill('1.1.1.1').join(',') }, '172.18.0.2'), T), '172.18.0.2', 'absurdly long chain -> peer');
});

test('clientIp: cf-connecting-ip only from a trusted peer, single valid IP only, else XFF walk', () => {
  const T = { trustedProxies: '172.18.0.0/16', header: 'cf-connecting-ip' };
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '6.6.6.6' }, '172.18.0.2'), T), '1.1.1.1');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '2001:db8::9' }, '172.18.0.2'), T), '2001:db8::9');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '6.6.6.6' }, '172.18.0.2'), { ...T, header: 'CF-Connecting-IP' }), '1.1.1.1', 'option is case-insensitive');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.1.1.1, 2.2.2.2', 'x-forwarded-for': '6.6.6.6' }, '172.18.0.2'), T), '6.6.6.6', 'list -> fall back to XFF');
  assert.equal(clientIp(req({ 'cf-connecting-ip': 'nope' }, '172.18.0.2'), T), '172.18.0.2', 'garbage -> fall back to peer');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.1.1.1' }, '172.18.0.2'), { trustedProxies: '172.18.0.0/16' }), '172.18.0.2', 'without header option the CF header is ignored');
  assert.equal(clientIp(req({ 'cf-connecting-ip': ['1.1.1.1', '2.2.2.2'] }, '172.18.0.2'), T), '172.18.0.2', 'duplicated header ignored');
});

test('clientIp never throws on garbage input', () => {
  const T = { trustedProxies: '0.0.0.0/0' };
  for (const r of [null, undefined, {}, { headers: {} }, { socket: null }, { socket: {}, headers: {} }, { socket: { remoteAddress: 42 }, headers: {} }, req({ 'x-forwarded-for': 12345 }, '1.2.3.4'), req({}, 'garbage')]) {
    assert.doesNotThrow(() => clientIp(r, T));
    assert.equal(typeof clientIp(r, T), 'string');
  }
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }, '9.9.9.9'), { trustedProxies: 12345 }), '9.9.9.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }, '9.9.9.9'), { trustedProxies: [null, {}, 'x'] }), '9.9.9.9');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: undefined } }), '');
});

test('parseTrusted accepts a pre-parsed list so the server can parse TRUSTED_PROXIES once', () => {
  const parsed = parseTrusted('172.18.0.0/16');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }, '172.18.0.2'), { trustedProxies: parsed }), '1.1.1.1');
  assert.deepEqual(parseTrusted(parsed), parsed);
});
