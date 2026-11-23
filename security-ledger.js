'use strict';
// Security authorization boundary. See RC3_LEDGER_DESIGN.md and RC3_OPERATIONS.md.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { acquire } = require('./ledger-lock');
const ZERO = '0'.repeat(64), MAX_BYTES = 512 * 1024 * 1024;
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));
const error = message => Object.assign(Error('Security Ledger: ' + message), { status: 503 });
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const validHash=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const validSecurityKey=v=>typeof v==='string' && v.length>0 && v.length<=64 && v.trim()===v && !/[\u0000-\u001f\u007f-\u009f]/.test(v) && !Object.hasOwn(Object.prototype,v) && v!=='prototype';
const ownNumber=(map,key)=>Object.hasOwn(map,key)?map[key]:0;
function validateSessionMaps(s){for(const kind of ['revoked','notBefore']){if(!object(s) || !Object.hasOwn(s,kind) || !object(s[kind]))throw error('invalid session map');for(const [key,value] of Object.entries(s[kind]))if(!(kind==='revoked'?validHash(key):validSecurityKey(key)) || !Number.isFinite(value) || value<0)throw error('invalid session entry');}}
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function parse(text) {
  const value = JSON.parse(text);
  const walk = x => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (['__proto__', 'prototype', 'constructor'].includes(k)) throw error('unsafe record'); walk(v); } };
  walk(value); return value;
}
function strict(file, dir = false) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile())) throw error('unexpected filesystem object');
  if (process.getuid && s.uid !== process.getuid()) throw error('incorrect filesystem owner');
  if ((s.mode & 0o777) !== (dir ? 0o700 : 0o600)) throw error('permissions must be ' + (dir ? '0700' : '0600'));
  return s;
}
function fsyncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file, text) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp'; let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file); fsyncDir(path.dirname(file));
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function validateSupport(v) {
  if (!object(v) || !Object.hasOwn(v, 'pending') || !Object.hasOwn(v, 'session')) throw error('invalid support state');
  const p = v.pending, s = v.session;
  if (p !== null && (!object(p) || !/^[a-f0-9]{64}$/.test(p.hash) || !/^[a-f0-9]{48}$/.test(p.salt) || !Number.isSafeInteger(p.expiresAt) || p.expiresAt < 0)) throw error('invalid support grant');
  if (s !== null && (!object(s) || typeof s.id !== 'string' || !s.id || !Number.isSafeInteger(s.expiresAt) || s.expiresAt < 0)) throw error('invalid support session');
}
function validateState(s) {
  if (!object(s) || !['policy','sessions','burned','support'].every(k=>Object.hasOwn(s,k)) || !object(s.policy) || !object(s.sessions) || !object(s.burned)) throw error('invalid state');
  validateSessionMaps(s.sessions);
  for(const [key,value] of Object.entries(s.burned))if(!validHash(key) || value!==true)throw error('invalid burned-token entry');
  if (s.sessions.globalValidAfter !== undefined && (!Number.isFinite(s.sessions.globalValidAfter) || s.sessions.globalValidAfter < 0)) throw error('invalid global cutoff');
  validateSupport(s.support);
}
function patch(before, after, prefix = [], out = { set: [], del: [] }) {
  if (canonical(before) === canonical(after)) return out;
  if (object(before) && object(after)) {
    for (const k of Object.keys(before)) if (!Object.hasOwn(after, k)) out.del.push([...prefix, k]);
    for (const k of Object.keys(after)) patch(before[k], after[k], [...prefix, k], out);
  } else out.set.push({ path: prefix, value: clone(after) });
  return out;
}
function applyPatch(target, data) {
  const parent = keys => {
    if (!keys.length || keys.some(k => typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k))) throw error('invalid patch path');
    let x = target; for (const k of keys.slice(0, -1)) { if (!object(x[k])) x[k] = {}; x = x[k]; } return x;
  };
  for (const keys of data.del) delete parent(keys)[keys.at(-1)];
  for (const row of data.set) parent(row.path)[row.path.at(-1)] = clone(row.value);
}
function validateSecurityEvent(type,data){
  if(!object(data))throw error('invalid event payload');
  const time=n=>Number.isFinite(n) && n>=0;
  if(type==='session.user' && (!validSecurityKey(data.key) || !time(data.at)))throw error('invalid session identifier or time');
  if(type==='session.token' && (!validHash(data.hash) || !time(data.exp)))throw error('invalid revocation hash or expiry');
  if(type==='session.cutoff' && !time(data.at))throw error('invalid session cutoff');
  if(type==='session.merge')validateSessionMaps(data);
  if(type==='bootstrap')validateState(data);
  if((type==='import' || type==='import.prepare') && data.burned!==undefined && (!Array.isArray(data.burned) || data.burned.some(h=>!validHash(h))))throw error('invalid burned-token hashes');
}
function apply(state, e) {
  validateSecurityEvent(e.type,e.data);
  if (e.type === 'bootstrap') { if (e.seq !== 1 || state) throw error('duplicate bootstrap'); validateState(e.data); return clone(e.data); }
  if (!state) throw error('bootstrap missing');
  if (e.type === 'policy' || e.type === 'import') { state.policy = clone(e.data.policy); if (e.type === 'import') for (const h of e.data.burned || []) state.burned[h] = true; }
  else if (e.type === 'policy.patch') applyPatch(state.policy, e.data);
  else if (e.type === 'import.prepare') {
    if (state.pendingImport) throw error('unresolved import');
    state.pendingImport = clone(e.data);
    state.policy = clone(e.data.restrictivePolicy);
    for (const h of e.data.burned || []) state.burned[h] = true;
  } else if (e.type === 'import.commit' || e.type === 'import.abort') {
    if (!state.pendingImport || state.pendingImport.operationId !== e.data.operationId) throw error('import transaction mismatch');
    if (e.type === 'import.commit') state.policy = state.pendingImport.policy;
    delete state.pendingImport;
  } else if (e.type === 'session.token') state.sessions.revoked[e.data.hash] = Math.max(ownNumber(state.sessions.revoked,e.data.hash), e.data.exp);
  else if (e.type === 'session.user') state.sessions.notBefore[e.data.key] = Math.max(ownNumber(state.sessions.notBefore,e.data.key), e.data.at);
  else if (e.type === 'session.cutoff') state.sessions.globalValidAfter = Math.max(state.sessions.globalValidAfter || 0, e.data.at);
  else if (e.type === 'session.merge') {
    for (const [h, n] of Object.entries(e.data.revoked)) state.sessions.revoked[h] = Math.max(ownNumber(state.sessions.revoked,h), n);
    for (const [k, n] of Object.entries(e.data.notBefore)) state.sessions.notBefore[k] = Math.max(ownNumber(state.sessions.notBefore,k), n);
  } else if (e.type === 'support') { validateSupport(e.data); state.support = clone(e.data); }
  else if (e.type !== 'audit') throw error('unknown event type');
  return state;
}
function openLedger({ dir, binding, initial, allowBootstrap = false, recoverInitialization = false, migrateLegacyLock = false, log = console,
  compactBytes = 4 * 1024 * 1024, totalLimitBytes = MAX_BYTES, fault = () => {} } = {}) {
  dir = path.resolve(dir); binding = path.resolve(binding); strict(dir, true);
  if (!Number.isSafeInteger(compactBytes) || compactBytes < 1024 || !Number.isSafeInteger(totalLimitBytes) || totalLimitBytes < compactBytes * 4) throw error('invalid capacity limits');
  const files = { key: path.join(dir, 'key.json'), head: path.join(dir, 'head.json'), lock: path.join(dir, 'writer.lock'), layout: path.join(dir, 'layout.json'), init: path.join(dir, 'initialization.json'), enrollment: binding + '.enrollment' };
  let lock, poison = null, key, id, state = null, seq = 0, hash = ZERO, size = 0, journal = path.join(dir, 'events.jsonl');
  let baseSeq = 0, baseHash = ZERO, archives = [], snapshotName = null, layoutText = null, headText = '', bindingText = '', enrollmentText = '', journalStat, totalBytes = 0, lastWarning = 0;
  const fail = message => { poison = error(message); throw poison; };
  function signed(p) { return canonical({ ...p, mac: crypto.createHmac('sha256', key).update(canonical(p)).digest('hex') }); }
  function verify(text) {
    const row = parse(text), mac = row.mac; delete row.mac;
    const expected = crypto.createHmac('sha256', key).update(canonical(row)).digest('hex');
    if (typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac) || !crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) throw error('authentication failed');
    return row;
  }
  function readSigned(file) { strict(file); return verify(fs.readFileSync(file, 'utf8')); }
  function stamp() { const s = fs.statSync(journal, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':'); }
  function checkpoint() {
    const text = signed({ v: 1, id, seq, hash }); atomic(files.head, text); headText = text; fault('afterHead');
    atomic(binding, text); bindingText = text; fault('afterBinding');
  }
  function countBytes() { return fs.readdirSync(dir).reduce((n, name) => { const s = fs.lstatSync(path.join(dir, name)); return n + (s.isFile() ? s.size : 0); }, 0); }
  function capacity() {
    const disk=fs.statfsSync(dir),diskFreeBytes=disk.bavail*disk.bsize;
    return { sequence: seq, activeBytes: size, compactAtBytes: compactBytes, totalBytes, totalLimitBytes, diskFreeBytes, archives: archives.length,
      warning: totalBytes >= totalLimitBytes * 0.75 || diskFreeBytes < 16*1024*1024 ? 'critical' : totalBytes >= totalLimitBytes * 0.5 || diskFreeBytes < 64*1024*1024 ? 'warning' : null };
  }
  function warn() {
    const c = capacity(), level = c.warning === 'critical' ? 2 : c.warning ? 1 : 0;
    if (level > lastWarning) log.warn?.('[security-ledger] capacity ' + c.warning + ': ' + totalBytes + '/' + totalLimitBytes + ' bytes; preserve archives and plan reviewed maintenance.');
    lastWarning = Math.max(lastWarning, level);
  }
  function check() {
    if (poison) throw poison;
    try {
      lock.check(); strict(dir, true); strict(files.key); strict(journal); strict(files.head); strict(binding); strict(files.enrollment);
      if (stamp() !== journalStat || fs.readFileSync(files.head, 'utf8') !== headText || fs.readFileSync(binding, 'utf8') !== bindingText || fs.readFileSync(files.enrollment,'utf8') !== enrollmentText || fs.readFileSync(files.key, 'utf8') !== canonical({ v: 1, id, key: key.toString('hex') })) fail('live storage identity changed');
      if (layoutText !== null && (strict(files.layout), fs.readFileSync(files.layout, 'utf8') !== layoutText)) fail('layout changed');
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); return true;
    } catch (e) { if (!poison) poison = error('storage unavailable or inconsistent'); throw poison; }
  }
  function verifyTail(raw, startingSeq, startingHash, applyToState) {
    if (raw.length && !raw.endsWith('\n')) throw error('truncated journal');
    let n = startingSeq, h = startingHash; const hashes = new Map([[n, h]]);
    for (const line of raw ? raw.slice(0, -1).split('\n') : []) {
      if (!line) throw error('empty event'); const e = verify(line);
      if (e.v !== 1 || e.id !== id || e.seq !== n + 1 || e.prev !== h || !Number.isSafeInteger(e.at)) throw error('sequence/chain mismatch');
      if (applyToState) state = apply(state, e);
      n++; h = digest(line); hashes.set(n, h);
    }
    return { seq: n, hash: h, hashes };
  }
  function safeName(name, re) { if (typeof name !== 'string' || !re.test(name)) throw error('invalid layout path'); return path.join(dir, name); }
  function loadLayout() {
    if (!fs.existsSync(files.layout)) return;
    const layout = readSigned(files.layout); layoutText = fs.readFileSync(files.layout, 'utf8');
    if (layout.v !== 2 || layout.id !== id) throw error('invalid layout');
    const snapFile = safeName(layout.snapshot, /^snapshot-[a-f0-9-]+\.json$/);
    const snap = readSigned(snapFile);
    if (snap.v !== 2 || snap.id !== id || !Number.isSafeInteger(snap.seq) || snap.seq < 1 || !Array.isArray(snap.archives)) throw error('invalid snapshot');
    let end = 0, previous = ZERO;
    for (const archive of snap.archives) {
      const file = safeName(archive.name, /^archive-[a-f0-9-]+\.gz$/); strict(file);
      if (archive.firstSeq !== end + 1 || archive.firstPrev !== previous || !Number.isSafeInteger(archive.lastSeq) || archive.lastSeq < archive.firstSeq || !/^[a-f0-9]{64}$/.test(archive.lastHash)) throw error('archive range mismatch');
      if (digest(fs.readFileSync(file)) !== archive.sha256) throw error('archive integrity mismatch');
      end = archive.lastSeq; previous = archive.lastHash;
    }
    if (end !== snap.seq || previous !== snap.hash) throw error('snapshot/history mismatch');
    validateState(snap.state); state = snap.state; seq = baseSeq = snap.seq; hash = baseHash = snap.hash; archives = snap.archives; snapshotName = layout.snapshot;
    journal = safeName(layout.journal, /^journal-[a-f0-9-]+\.jsonl$/);
  }
  function compact() {
    check(); if (!size) return capacity();
    // Validate the exact active chain before signing an immutable archive of it.
    const raw = fs.readFileSync(journal, 'utf8'), tail = verifyTail(raw, baseSeq, baseHash, false);
    if (tail.seq !== seq || tail.hash !== hash) fail('active journal changed before compaction');
    const packed = zlib.gzipSync(raw, { level: 9 }), archiveName = 'archive-' + (baseSeq + 1) + '-' + seq + '-' + digest(packed) + '.gz';
    const nextArchives = [...archives, { name: archiveName, sha256: digest(packed), firstSeq: baseSeq + 1, lastSeq: seq, firstPrev: baseHash, lastHash: hash }];
    const snapshot = signed({ v: 2, id, seq, hash, state, archives: nextArchives });
    const newSnapshot = 'snapshot-' + seq + '-' + digest(snapshot) + '.json';
    const newJournal = 'journal-' + crypto.randomUUID() + '.jsonl';
    if (totalBytes + packed.length + Buffer.byteLength(snapshot) > totalLimitBytes) fail('capacity exhausted during compaction');
    try {
      atomic(path.join(dir, archiveName), packed); fault('compactionArchive');
      atomic(path.join(dir, newSnapshot), snapshot); fault('compactionSnapshot');
      atomic(path.join(dir, newJournal), ''); fault('compactionJournal');
      const text = signed({ v: 2, id, snapshot: newSnapshot, journal: newJournal });
      atomic(files.layout, text); fault('compactionPublished');
      // After the durable pointer, both generations describe the identical seq/hash/state.
      layoutText = text; journal = path.join(dir, newJournal); archives = nextArchives; snapshotName = newSnapshot;
      baseSeq = seq; baseHash = hash; size = 0; journalStat = stamp(); cleanup(); totalBytes = countBytes(); warn(); return capacity();
    } catch (e) { if (!poison) poison = error('compaction interrupted; validated restart required'); throw poison; }
  }
  function cleanup() {
    const keep = new Set([path.basename(journal), snapshotName, ...archives.map(a => a.name)]);
    for (const name of fs.readdirSync(dir)) {
      if (/^(?:archive-[a-f0-9-]+\.gz|snapshot-[a-f0-9-]+\.json|journal-[a-f0-9-]+\.jsonl|events\.jsonl)$/.test(name) && !keep.has(name)) { strict(path.join(dir, name)); fs.unlinkSync(path.join(dir, name)); }
      if(/^(?:key\.json|head\.json|layout\.json|initialization\.json|events\.jsonl|archive-[a-f0-9-]+\.gz|snapshot-[a-f0-9-]+\.json|journal-[a-f0-9-]+\.jsonl)\.[a-f0-9-]{36}\.tmp$/.test(name)){strict(path.join(dir,name));fs.unlinkSync(path.join(dir,name));}
    }
    fsyncDir(dir);
  }
  function append(type, data) {
    check();
    // Reject before compaction, state publication or signing; bad input must not poison the writer.
    let e,next;
    try{validateSecurityEvent(type,data);e={v:1,id,seq:seq+1,at:Date.now(),type,data:clone(data),prev:hash};parse(canonical(e));next=apply(clone(state),e);validateState(next);}
    catch(cause){throw Object.assign(Error('Invalid security event: '+cause.message),{status:400});}
    try {
      if (size >= compactBytes) compact();
      const line = signed(e) + '\n';
      if (totalBytes + Buffer.byteLength(line) > totalLimitBytes) fail('capacity exhausted; preserve history and perform reviewed maintenance');
      const fd = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
      try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); fault('afterJournalFsync'); } finally { fs.closeSync(fd); }
      size += Buffer.byteLength(line); totalBytes += Buffer.byteLength(line); seq++; hash = digest(line.slice(0, -1)); state = next; journalStat = stamp();
      checkpoint(); warn(); return seq;
    } catch (e) { if (!poison) poison = error('durable commit failed; service must remain unavailable'); throw poison; }
  }
  function initialize(existingSecret) {
    if(fs.existsSync(files.enrollment))throw error('initialization conflicts with established enrollment; do not reset security state');
    if (!allowBootstrap || fs.existsSync(binding) || fs.existsSync(files.head) || fs.existsSync(journal)) throw error('missing trust root; refusing reinitialization');
    validateState(initial); id = existingSecret?.id || crypto.randomUUID(); key = existingSecret ? Buffer.from(existingSecret.key, 'hex') : crypto.randomBytes(32);
    const secret = canonical({ v: 1, id, key: key.toString('hex') });
    const e = { v: 1, id, seq: 1, at: Date.now(), type: 'bootstrap', data: clone(initial), prev: ZERO }, line = signed(e) + '\n';
    const head = signed({ v: 1, id, seq: 1, hash: digest(line.slice(0, -1)) });
    atomic(files.init, canonical({ v: 1, secret, journal: line, head })); fault('initializationIntent');
  }
  function finishInitialization() {
    strict(files.init); const intent = parse(fs.readFileSync(files.init, 'utf8')), secret = parse(intent.secret);
    if (intent.v !== 1 || secret.v !== 1 || typeof secret.id !== 'string' || !/^[a-f0-9]{64}$/.test(secret.key)) throw error('invalid initialization intent');
    id = secret.id; key = Buffer.from(secret.key, 'hex');
    const event = verify(intent.journal.trimEnd()), head = verify(intent.head);
    if (event.seq !== 1 || event.type !== 'bootstrap' || event.prev !== ZERO || event.id !== id || head.seq !== 1 || head.id !== id || head.hash !== digest(intent.journal.trimEnd())) throw error('invalid genesis intent');
    validateState(event.data);
    if(fs.existsSync(files.enrollment)){
      const enrollment=readSigned(files.enrollment);
      if(enrollment.id!==id || enrollment.status!=='initializing' || enrollment.genesisHash!==head.hash)throw error('initialization conflicts with established enrollment');
    }else atomic(files.enrollment,signed({v:1,id,status:'initializing',genesisHash:head.hash}));
    for (const [file, text] of [[files.key, intent.secret], [journal, intent.journal], [files.head, intent.head], [binding, intent.head]]) {
      if (fs.existsSync(file)) { strict(file); if (fs.readFileSync(file, 'utf8') !== text) throw error('initialization conflicts with existing state'); }
      else atomic(file, text);
      fault('initializationComponent');
    }
    fs.unlinkSync(files.init); fsyncDir(dir);
    atomic(files.enrollment,signed({v:1,id,status:'established'}));
  }
  function close() { if (lock) { lock.close(); lock = null; } }
  try {
    lock = acquire(files.lock, strict, {allowLegacy:migrateLegacyLock}); fsyncDir(dir);
    if (fs.existsSync(files.init)) finishInitialization();
    if (!fs.existsSync(files.key)) {
      if (fs.readdirSync(dir).some(n => n !== 'writer.lock' && !/\.tmp$/.test(n))) throw error('missing trust root; unexpected existing state');
      initialize(); finishInitialization();
    } else if (!fs.existsSync(journal) && !fs.existsSync(files.layout) && !fs.existsSync(files.head) && !fs.existsSync(binding) && recoverInitialization) {
      const secret = parse(fs.readFileSync(files.key, 'utf8'));
      if (secret.v !== 1 || typeof secret.id !== 'string' || !/^[a-f0-9]{64}$/.test(secret.key)) throw error('invalid trust root');
      initialize(secret); finishInitialization();
    }
    strict(files.key); const secret = parse(fs.readFileSync(files.key, 'utf8'));
    if (secret.v !== 1 || typeof secret.id !== 'string' || !/^[a-f0-9]{64}$/.test(secret.key)) throw error('invalid trust root');
    id = secret.id; key = Buffer.from(secret.key, 'hex');
    loadLayout(); strict(journal);
    if (fs.statSync(journal).size > MAX_BYTES) throw error('oversized journal');
    const tail = verifyTail(fs.readFileSync(journal, 'utf8'), baseSeq, baseHash, true); seq = tail.seq; hash = tail.hash; validateState(state);
    size = fs.statSync(journal).size;
    const anchor = (file, label) => {
      if (!fs.existsSync(file)) throw error(label + ' missing; restore an independently trusted checkpoint, never adopt an old ledger automatically');
      const row = readSigned(file);
      let expected=tail.hashes.get(row.seq);
      if(Number.isSafeInteger(row.seq) && row.seq<baseSeq){
        const archive=archives.find(a=>row.seq>=a.firstSeq && row.seq<=a.lastSeq);
        if(archive){const raw=zlib.gunzipSync(fs.readFileSync(path.join(dir,archive.name)),{maxOutputLength:MAX_BYTES}).toString('utf8');expected=verifyTail(raw,archive.firstSeq-1,archive.firstPrev,false).hashes.get(row.seq);}
      }
      if (row.id !== id || !Number.isSafeInteger(row.seq) || row.seq < 1 || row.seq > seq || expected !== row.hash) throw error(label + ' rollback or corruption');
    };
    anchor(files.head, 'journal/head'); anchor(binding, 'independent high-water binding');
    if(fs.existsSync(files.enrollment)){const enrollment=readSigned(files.enrollment);if(enrollment.id!==id || !['established','initializing'].includes(enrollment.status))throw error('enrollment mismatch');}
    atomic(files.enrollment,signed({v:1,id,status:'established'}));enrollmentText=fs.readFileSync(files.enrollment,'utf8');
    checkpoint(); journalStat = stamp(); cleanup(); totalBytes = countBytes(); warn(); check();
  } catch (e) { close(); throw error(e.message || 'startup validation failed'); }
  return {
    check, append, close, compact, capacity: () => { check(); return capacity(); },
    getState: () => { check(); return clone(state); }, policy: () => { check(); return clone(state.policy); },
    isBurned: h => { check(); return validHash(h) && Object.hasOwn(state.burned,h) && state.burned[h]===true; },
    syncPolicy: policy => { check(); const delta = patch(state.policy, policy); if (delta.set.length || delta.del.length) append('policy.patch', delta); },
    revokeToken: (hash, exp) => append('session.token', { hash, exp }), revokeUser: (key, at) => append('session.user', { key, at }),
    sessions: () => { check(); return clone(state.sessions); },
    mergeSessions: s => { check(); validateSessionMaps(s); if (Object.entries(s.revoked).some(([h, n]) => n > (ownNumber(state.sessions.revoked,h))) || Object.entries(s.notBefore).some(([k, n]) => n > (ownNumber(state.sessions.notBefore,k)))) append('session.merge', s); },
    setSupport: s => append('support', s), support: () => { check(); return clone(state.support); },
    recoverImport: databaseBytes => { check(); if (state.pendingImport) append(digest(databaseBytes) === state.pendingImport.databaseDigest ? 'import.commit' : 'import.abort', { operationId: state.pendingImport.operationId }); },
  };
}
module.exports = { openLedger, canonical, strict, atomic, digest, validSecurityKey, apply, validateState };
