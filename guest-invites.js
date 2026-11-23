// B04 fix (1.46.2-hotfix.3): single-use guest-coach invitations.
//
// Before, the guest-coach "invite link" was one fixed public address and anyone with a Discord account could enrol
// as a guest coach for any class. Now a (live) officer creates an invitation for exactly one class; only the first
// eligible Discord account that completes a Discord sign-in through it becomes a guest coach for that class.
//
// - Token: 32 bytes from the CSPRNG (256 bits), base64url (43 chars). Only its SHA-256 is stored. The raw token is
//   returned once, to the creating officer, inside a link whose token sits in the URL FRAGMENT
//   (#/guest-invite/<token>), which a browser never sends in a request line - so it does not reach access logs.
// - Valid 72 hours, revocable while pending, consumed by exactly one redemption. Expiry is computed, never stored.
// - Redemption only happens in the Discord OAuth callback, after Discord has proven the identity. The invitation is
//   bound to the OAuth `state` on the server when the sign-in starts (memory, 10 minutes), so no token travels
//   through the OAuth round trip and nothing the client sends at the callback can swap it.
// - Check-and-set is one synchronous block (Node never interleaves it), so two concurrent redemptions cannot both win;
//   the caller writes the result to disk at once.
// - Invitations created before SESSIONS_VALID_AFTER (post-restore cut-off) are never valid.
// Nothing here logs a token or a token hash, and `view()` never returns either.
const crypto = require('node:crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const LIFETIME_MS = 72 * 3600e3;
const PENDING_TTL_MS = 10 * 60e3;
const PENDING_MAX = 2000;
const PER_INVITE_MAX = 5;
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function createGuestInvites({ getDb, now = Date.now, validAfter = 0, ledger = null }) {
  const list = () => { const D = getDb(); if (!Array.isArray(D.guestCoachInvites)) D.guestCoachInvites = []; return D.guestCoachInvites; };
  const pendingByState = new Map();   // OAuth state -> { inviteId, tokenHash, at }

  function statusOf(inv, t = now()) {
    if (!inv || typeof inv !== 'object') return 'invalid';
    if (inv.status !== 'pending') return inv.status === 'redeemed' || inv.status === 'revoked' ? inv.status : 'invalid';
    const exp = Date.parse(inv.expiresAt), created = Date.parse(inv.createdAt);
    if (!Number.isFinite(exp) || !Number.isFinite(created) || t >= exp || created < validAfter || created > t || exp <= created || exp-created > LIFETIME_MS) return 'expired';
    if (typeof inv.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(inv.tokenHash)) return 'invalid';   // e.g. restored from an export (hash stripped)
    if(ledger && ledger.isBurned(inv.tokenHash))return 'revoked';
    return 'pending';
  }
  // Listing / response view: never the token, never its hash.
  const view = (inv) => ({ id: inv.id, class: inv.class, status: statusOf(inv), createdAt: inv.createdAt, expiresAt: inv.expiresAt,
    createdByName: inv.createdByName || '', redeemedAt: inv.redeemedAt || null, redeemedByName: inv.redeemedByName || '', redeemedBy: inv.redeemedBy || null,
    revokedAt: inv.revokedAt || null, revokedByName: inv.revokedByName || '' });

  function create({ cls, officer, newId }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    const inv = { id: newId(), tokenHash: hashToken(token), class: cls, createdBy: officer.key, createdByName: officer.name || '',
      createdAt: new Date(t).toISOString(), expiresAt: new Date(t + LIFETIME_MS).toISOString(), status: 'pending' };
    list().push(inv);
    return { invite: inv, token };
  }

  // A pending, unexpired invitation for this token, or null. Format check first; the hash comparison is constant-time
  // and scans every record (no early exit). Never throws.
  function findUsable(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const want = Buffer.from(hashToken(token), 'hex');
    let hit = null;
    for (const inv of list()) {
      if (!inv || typeof inv.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(inv.tokenHash)) continue;
      if (crypto.timingSafeEqual(Buffer.from(inv.tokenHash, 'hex'), want) && !hit) hit = inv;
    }
    return hit && statusOf(hit) === 'pending' ? hit : null;
  }

  function prunePending() {
    const t = now();
    for (const [s, p] of pendingByState) if (t - p.at > PENDING_TTL_MS) pendingByState.delete(s);
    while (pendingByState.size >= PENDING_MAX) pendingByState.delete(pendingByState.keys().next().value);
  }
  // Start of a sign-in through an invitation: nothing is consumed; the invitation is only bound to this OAuth state.
  function begin(token, state) {
    const inv = findUsable(token);
    if (!inv) return null;
    prunePending();
    // At most PER_INVITE_MAX open sign-ins per invitation (newest kept): someone holding one link can never push
    // other invitees' sign-ins out of the shared store, and the store stays small (open invites are capped at 50).
    const mine = [...pendingByState].filter(([, p]) => p.inviteId === inv.id);
    for (const [s] of mine.slice(0, Math.max(0, mine.length - PER_INVITE_MAX + 1))) pendingByState.delete(s);
    pendingByState.set(state, { inviteId: inv.id, tokenHash: inv.tokenHash, at: now() });
    return inv;
  }
  // Once per callback: the binding is removed whatever happens next, so the same state can never redeem twice.
  function takePending(state) {
    if (typeof state !== 'string') return null;
    const p = pendingByState.get(state);
    pendingByState.delete(state);
    if (!p || now() - p.at > PENDING_TTL_MS) return null;
    return p;
  }

  // Atomic redemption: synchronous from the status check to the status change. Returns { ok, invite } or { ok:false, reason }.
  function redeem(pending, identity) {
    const inv = list().find((x) => x && x.id === pending.inviteId && x.tokenHash === pending.tokenHash);
    if (!inv || statusOf(inv) !== 'pending') return { ok: false, reason: 'not_pending' };
    inv.status = 'redeemed';
    inv.redeemedBy = String(identity.id);
    inv.redeemedByName = identity.name || '';
    inv.redeemedAt = new Date(now()).toISOString();
    for (const [s, p] of pendingByState) if (p.inviteId === inv.id) pendingByState.delete(s);
    return { ok: true, invite: inv };
  }

  function revoke(id, officer) {
    const inv = list().find((x) => x && x.id === Number(id));
    if (!inv) return { ok: false, status: 404 };
    if (statusOf(inv) !== 'pending') return { ok: false, status: 409, invite: inv };
    inv.status = 'revoked';
    inv.revokedBy = officer.key;
    inv.revokedByName = officer.name || '';
    inv.revokedAt = new Date(now()).toISOString();
    for (const [s, p] of pendingByState) if (p.inviteId === inv.id) pendingByState.delete(s);
    return { ok: true, invite: inv };
  }

  return { create, begin, takePending, redeem, revoke, view, statusOf, findUsable, LIFETIME_MS, list };
}

// Export copies carry no token hashes: a restored export can never revive an invitation.
const stripForExport = (invites) => (Array.isArray(invites) ? invites.map(({ tokenHash, ...rest }) => rest) : []);

module.exports = { createGuestInvites, hashToken, stripForExport, TOKEN_RE, LIFETIME_MS };
