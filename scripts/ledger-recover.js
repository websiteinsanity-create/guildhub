#!/usr/bin/env node
'use strict';
// OFFLINE: locks the stable inode. Never unlinks a lock or reconstructs a lost trust anchor automatically.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { canonical, strict, digest, atomic, apply, validateState } = require('../security-ledger');
const { acquire } = require('../ledger-lock');
function recover({ dir, binding, unlock = false, repairTail = false, trustedBinding, ack = false, legacyAck = false }) {
  if (!ack) throw Error('Stop every writer first; explicit acknowledgement required.');
  if(legacyAck && !unlock)throw Error('Legacy migration requires --unlock and explicit RC2-stopped acknowledgement.');
  strict(dir, true); const lock = acquire(path.join(dir, 'writer.lock'), strict, { allowLegacy: unlock && legacyAck, readOnly: !unlock });
  try {
    if (unlock) return { unlocked: true, kernelOwnershipVerified: true, lockFileRetained: true };
    strict(path.join(dir, 'key.json')); const secret = JSON.parse(fs.readFileSync(path.join(dir, 'key.json'), 'utf8'));
    if (secret.v !== 1 || typeof secret.id !== 'string' || !/^[a-f0-9]{64}$/.test(secret.key)) throw Error('Invalid key.');
    const verify = text => {
      const row = JSON.parse(text), mac = row.mac; delete row.mac;
      const expected = crypto.createHmac('sha256', Buffer.from(secret.key, 'hex')).update(canonical(row)).digest('hex');
      if (typeof mac !== 'string' || mac !== expected) throw Error('Authentication failure; restore a trusted coherent backup.');
      return row;
    };
    const read = file => { strict(file); return verify(fs.readFileSync(file, 'utf8')); };
    let file = path.join(dir, 'events.jsonl'), seq = 0, hash = '0'.repeat(64); const hashes = new Map([[0, hash]]);let state=null;
    const scan = text => {
      if (text && !text.endsWith('\n')) throw Error('Invalid complete prefix.');
      for (const line of text ? text.slice(0, -1).split('\n') : []) {
        const row = verify(line);
        if (row.v !== 1 || row.id !== secret.id || row.seq !== seq + 1 || row.prev !== hash || seq === 0 && row.type !== 'bootstrap' || seq > 0 && row.type === 'bootstrap') throw Error('Invalid complete prefix.');
        state=apply(state,row);validateState(state);
        seq++; hash = digest(line); hashes.set(seq, hash);
      }
    };
    const layoutFile = path.join(dir, 'layout.json');
    if (fs.existsSync(layoutFile)) {
      const layout = read(layoutFile);
      if (layout.id !== secret.id || layout.v !== 2 || !/^snapshot-[a-f0-9-]+\.json$/.test(layout.snapshot) || !/^journal-[a-f0-9-]+\.jsonl$/.test(layout.journal)) throw Error('Invalid layout.');
      const snap = read(path.join(dir, layout.snapshot));
      for (const archive of snap.archives) {
        if (!/^archive-[a-f0-9-]+\.gz$/.test(archive.name)) throw Error('Invalid archive path.');
        const f = path.join(dir, archive.name); strict(f); const bytes = fs.readFileSync(f);
        if (digest(bytes) !== archive.sha256) throw Error('Archive checksum mismatch.');
        scan(zlib.gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'));
        if (seq !== archive.lastSeq || hash !== archive.lastHash) throw Error('Archive range mismatch.');
      }
      if (seq !== snap.seq || hash !== snap.hash || snap.id !== secret.id) throw Error('Snapshot/history mismatch.');
      file = path.join(dir, layout.journal);
    }
    strict(file); const raw = fs.readFileSync(file), end = raw.lastIndexOf(10) + 1;
    scan(raw.subarray(0, end).toString('utf8'));
    if (!seq) throw Error('No complete authenticated prefix.');
    for (const checkpoint of [path.join(dir, 'head.json'), trustedBinding || binding]) {
      const p = read(checkpoint);
      if (p.id !== secret.id || !Number.isInteger(p.seq) || p.seq < 1 || p.seq > seq || hashes.get(p.seq) !== p.hash) throw Error('Committed checkpoint exceeds/mismatches prefix; refusing recovery.');
    }
    if (trustedBinding) {
      if (fs.existsSync(binding) || path.resolve(trustedBinding) === path.resolve(binding) || path.resolve(trustedBinding).startsWith(path.resolve(dir) + path.sep)) throw Error('Binding restoration requires an absent binding and an independently retained trusted checkpoint.');
      atomic(binding, fs.readFileSync(trustedBinding));
    }
    if (repairTail && end < raw.length) {
      atomic(file + '.partial-' + crypto.randomUUID(), raw);
      const fd = fs.openSync(file, 'r+'); try { fs.ftruncateSync(fd, end); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    }
    return { authenticatedEvents: seq, uncommittedTailBytes: raw.length - end, repaired: !!repairTail && end < raw.length, bindingRestored: !!trustedBinding };
  } finally { lock.close(); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args.length < 2) throw Error('Usage: node scripts/ledger-recover.js LEDGER_DIR DATA_BINDING [--unlock [--I-confirm-rc2-stopped]|--repair-tail|--restore-binding TRUSTED_CHECKPOINT] --I-confirm-all-writers-stopped');
    const at = args.indexOf('--restore-binding');
    console.log(JSON.stringify(recover({ dir: path.resolve(args[0]), binding: path.resolve(args[1]), unlock: args.includes('--unlock'), repairTail: args.includes('--repair-tail'), trustedBinding: at < 0 ? undefined : args[at + 1], ack: args.includes('--I-confirm-all-writers-stopped'), legacyAck: args.includes('--I-confirm-rc2-stopped') })));
  } catch (e) { console.error('RECOVERY REFUSED: ' + e.message); process.exitCode = 1; }
}
module.exports = { recover };
