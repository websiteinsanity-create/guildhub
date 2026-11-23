// B04 (hotfix.3) test helper: enrol a guest coach the only way that exists now - an officer creates a single-use
// invitation, the invitee starts the Discord sign-in with it (POST /auth/discord/invite), and the OAuth callback
// redeems it for the Discord account the fake Discord reports. Used by the existing coaching tests that used to
// rely on the removed public ?guestcoach=1 link + POST /api/guest-coaches/join.

// Officer creates an invitation; returns { link, token, invite }.
async function createInvite(base, officerCookie, cls) {
  const r = await fetch(base + '/api/admin/guest-invites', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: officerCookie }, body: JSON.stringify({ class: cls }) });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`creating an invitation failed: ${r.status} ${JSON.stringify(body)}`);
  const token = /#\/guest-invite\/([A-Za-z0-9_-]{43})$/.exec(body.link)[1];
  return { link: body.link, token, invite: body.invite };
}

// Starts the sign-in through an invitation and completes the callback as Discord account `id`.
// Returns { cookie, location, status } - cookie is null when the redemption or sign-in was refused.
async function redeemInvite(base, token, id) {
  const start = await fetch(base + '/auth/discord/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token }) });
  const sb = await start.json().catch(() => ({}));
  if (start.status !== 200) return { cookie: null, status: start.status, error: sb.error };
  const state = new URL(sb.location).searchParams.get('state');
  const cb = await fetch(`${base}/auth/discord/callback?code=${id}&state=${state}`, { redirect: 'manual', headers: { Cookie: `gh_oauth=${state}` } });
  const m = /gh_session=([^;]+)/.exec(cb.headers.get('set-cookie') || '');
  return { cookie: m && m[1] ? `gh_session=${m[1]}` : null, status: cb.status, location: cb.headers.get('location') };
}

async function inviteGuestCoach(base, officerCookie, cls, id) {
  const { token } = await createInvite(base, officerCookie, cls);
  const r = await redeemInvite(base, token, id);
  if (!r.cookie) throw new Error(`guest-coach invitation was not redeemed: ${r.status} ${r.error || r.location || ''}`);
  return r.cookie;
}

module.exports = { createInvite, redeemInvite, inviteGuestCoach };
