// Hotfix 1.46.2.2 (F-B, F-D): server-side session revocation and strict session-token parsing.
//
// A session token stays a stateless HMAC-signed blob (no schema change, no session database). What changes:
//  - every token is parsed through one strict, non-throwing format check before any crypto (F-D, SA-08);
//  - a small revocation file (DATA_DIR/session-revocations.json, mode 600) records
//      revoked[sha256(signature)] = exp   -> one token (logout of this device; also works for pre-hotfix tokens)
//      notBefore[userKey]         = ms    -> every token of that user issued at or before that moment
//                                           (kick, officer removal, loss of the officer role)
//  - SESSIONS_VALID_AFTER (ISO time) rejects every token issued before it: the operational mitigation after
//    restoring an older copy of DATA_DIR, which would otherwise also restore an older revocation file.
// Tokens minted before this hotfix carry no `iat`; they all lived exactly 30 days (Discord / passcode), 8 h (Alliance)
// or 2 h (support), so `exp - 30 days` is used as their issue time: exact for 30-day tokens and earlier (= more
// likely to be revoked, never less) for the short-lived ones.
// Nothing here ever logs a token, a signature or a key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43}$/;
const LEGACY_LIFETIME_MS = 30 * 864e5;
const {validSecurityKey}=require('./security-ledger');
const ownNumber=(map,key)=>Object.hasOwn(map,key)?Number(map[key]):0;
const MAX_REVOKED = 200000;   // hard cap so the file can never grow without bound (oldest-expiring dropped first)

// Returns { body, sig } for a well-formed token string, otherwise null. Never throws, whatever the input.
function parseTokenString(token) {
  if (typeof token !== 'string' || token.length > 4140 || !TOKEN_RE.test(token)) return null;
  const dot = token.indexOf('.');
  return { body: token.slice(0, dot), sig: token.slice(dot + 1) };
}

const sigHash = (sig) => crypto.createHash('sha256').update(String(sig)).digest('hex');

function parseValidAfter(value, now = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const t = Date.parse(String(value).trim());
  if (!Number.isFinite(t)) throw new Error('SESSIONS_VALID_AFTER is not a valid date/time (use ISO 8601, e.g. 2026-11-10T12:00:00Z).');
  // A time in the future would refuse every new sign-in too (everyone locked out) - almost certainly a typo.
  if (t > now + 5 * 60e3) throw new Error('SESSIONS_VALID_AFTER is in the future, which would refuse every sign-in. Use the time of the restore (or now).');
  return t;
}

function createSessionGuard({ file, now = Date.now, validAfter = 0, log = console, ledger = null } = {}) {
  let state = { revoked: {}, notBefore: {} };
  let loadError = null;

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.revoked = raw && typeof raw.revoked === 'object' && raw.revoked ? raw.revoked : {};
      state.notBefore = raw && typeof raw.notBefore === 'object' && raw.notBefore ? raw.notBefore : {};
      require('./security-ledger').validateState({policy:{},sessions:state,burned:{},support:{pending:null,session:null}});
      try { fs.chmodSync(file, 0o600); } catch {}
    } catch (e) {
      // A damaged revocation file must not silently re-validate revoked sessions. Refuse to start; the operator
      // either repairs it or deletes it together with setting SESSIONS_VALID_AFTER (see DEPLOYMENT notes).
      loadError = e;
      throw new Error(`session-revocations.json could not be read (${e.code || 'invalid JSON'}). Refusing to start so revoked sessions cannot come back. Fix or remove the file and set SESSIONS_VALID_AFTER.`);
    }
  }

  function prune() {
    const t = now();
    for (const [h, exp] of Object.entries(state.revoked)) if (!(Number(exp) > t)) delete state.revoked[h];
    // notBefore only matters while a token issued before it could still be alive (30 days max).
    for (const [k, nb] of Object.entries(state.notBefore)) if (!(Number(nb) > t - LEGACY_LIFETIME_MS - 864e5)) delete state.notBefore[k];
    const entries = Object.entries(state.revoked);
    if (entries.length > MAX_REVOKED) {
      entries.sort((a, b) => a[1] - b[1]);
      for (const [h] of entries.slice(0, entries.length - MAX_REVOKED)) delete state.revoked[h];
    }
  }

  function persist() {
    if (!ledger) prune();
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  const issuedAt = (payload) => (Number.isFinite(payload.iat) ? payload.iat : Number(payload.exp) - LEGACY_LIFETIME_MS);

  // true when this (already signature-verified, unexpired) token must be refused.
  function isRevoked(payload, sig) {
    if (ledger) ledger.check();
    const iat = issuedAt(payload);
    if (!Number.isFinite(iat)) return true;
    if (validAfter && iat < validAfter) return true;
    if (Object.prototype.hasOwnProperty.call(state.revoked, sigHash(sig))) return true;
    const key = payload.key || payload.name;
    const nb = key != null && Object.prototype.hasOwnProperty.call(state.notBefore, String(key)) ? Number(state.notBefore[String(key)]) : 0;
    if (nb && iat <= nb) return true;
    return false;
  }

  // Logout: only this one token (this device).
  function revokeToken(sig, exp) {
    if (ledger) ledger.revokeToken(sigHash(sig),Number.isFinite(Number(exp)) ? Number(exp) : now()+LEGACY_LIFETIME_MS);
    state.revoked[sigHash(sig)] = Number.isFinite(Number(exp)) ? Number(exp) : now() + LEGACY_LIFETIME_MS;
    persist();
  }

  // Kick / officer removal / officer-role loss: every session of that user issued up to now.
  function revokeUser(key, reason = '') {
    if(!validSecurityKey(key))throw Object.assign(Error('Invalid session identifier.'),{status:400});
    if (ledger) ledger.revokeUser(key,now());
    state.notBefore[String(key)] = Math.max(ownNumber(state.notBefore,key),now());
    persist();
    if (log && log.log) log.log(`[sessions] all sessions of one user revoked${reason ? ` (${reason})` : ''}`);
  }

  // A new token is issued strictly after any notBefore of its user, even within the same millisecond.
  function nextIat(key) {
    const t = now();
    if(!validSecurityKey(key))throw Object.assign(Error('Invalid session identifier.'),{status:400});
    const nb = ownNumber(state.notBefore,key);
    return Math.max(t, nb + 1);
  }

  function stats() { return { revokedTokens: Object.keys(state.revoked).length, revokedUsers: Object.keys(state.notBefore).length, validAfter: validAfter || null, loadError: loadError ? String(loadError.message) : null }; }

  if (ledger) {
    // Restrictive legacy hints are merged, never allowed to remove a ledger revocation.
    if(fs.existsSync(file)){try{ledger.mergeSessions(require('./security-state').legacySessions(file));}catch(e){throw new Error('Legacy revocation mirror is inconsistent: '+e.message);}}
    state=ledger.sessions();
    validAfter=Math.max(validAfter,Number(state.globalValidAfter || 0));
    if(validAfter>Number(state.globalValidAfter || 0)){ledger.append('session.cutoff',{at:validAfter});state=ledger.sessions();}
  } else load();
  return { isRevoked, revokeToken, revokeUser, nextIat, stats, issuedAt };
}

module.exports = { createSessionGuard, parseTokenString, parseValidAfter, sigHash, TOKEN_RE };
