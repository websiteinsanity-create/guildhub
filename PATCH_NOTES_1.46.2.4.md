# GuildHub 1.46.2.4 – Security hotfix: sessions, authorization, guest-coach invitations and leave of absence

This security hotfix for production version 1.46.2 replaces the never-released 1.46.2.2 and 1.46.2.3 builds and
contains all of them, plus a fix for members on a leave of absence. It includes hotfix 1.46.2.1 (private gear-thread
images, GH-01) unchanged and nothing else from later GuildHub versions. GuildHub reports its version as
`1.46.2-hotfix.4`. Shotcaller is unchanged. `db.json` gains one list (`guestCoachInvites`) and guest-coach records gain a `via` field;
both are added automatically at start-up and nothing is removed or renamed. One new file appears in the data folder:
`session-revocations.json` (see below).

## What changes for players and officers

| Before | Now |
|---|---|
| Rights (officer, member, coach) were decided once at sign-in and kept in the cookie for 30 days | Rights are decided again on every request, from the current data |
| A kicked player kept their session and all their rights (even officer) until it expired | A kick signs the player out on every device at once. Signing in again only reaches the application page, even if they were accepted before |
| Removing an officer (Admin > Officers) took effect at their next sign-in | It takes effect at once and signs them out on every device |
| Losing the Discord officer role had no effect until the next sign-in | The bot re-reads Discord roles about every 10 minutes; losing officer status signs the person out everywhere |
| Removing or kicking a coach left their access to students' private VODs | A coach link only counts while the coach is still a coach. Re-instating them restores it. Guest coaches work as before |
| "Sign out" only deleted the cookie in the browser; a copied cookie kept working | Signing out ends that session on the server. Other devices of the same person stay signed in |
| Alliance partners kept access for 8 hours after losing their role or leaving the partner server | Partner membership and roles are checked live (cached up to 10 minutes) on every Alliance request |

Nothing changes in the user interface.

## Security fixes in detail
- **Live authorization (SA-01..SA-04):** new `access.js`. The session cookie only proves who someone is. The role, coach
  status and Alliance roles stored in it are ignored. Officer = `DISCORD_OFFICER_USER_IDS`, Admin > Officers users, or
  a Discord officer role that is *fresh* (see below). A kicked player is always an applicant (application page only)
  until an officer accepts a new application from them. Private gear-thread images use the same rules (GH-01 stays
  closed).
- **Discord role refresh (SA-02):** new `role-refresh.js`. Every ~10 minutes the bot reads the Discord roles of everyone
  who signed in within the last 30 days (one request at a time, respecting Discord rate limits). Discord errors never
  change stored roles and are never treated as a lost role. **Bounded freshness:** rights that come from a Discord
  role (officer by role, coach by role) need a successful role check (or sign-in) within the last
  `ROLE_MAX_STALE_MINUTES` (default 60). After that they are suspended (not deleted) until the next successful check.
  Officers named by user id are not affected.
- **Server-side sessions (SA-05):** new `session-guard.js`. New sessions carry a random session id and an issue time.
  Sign-out revokes exactly that session. A kick, removing an officer, or losing the officer role revokes all of
  that person's sessions. Revocations are stored in `DATA_DIR/session-revocations.json` (file mode 600) and survive
  restarts and container re-creation. Cookies from before this hotfix keep working for normal use, but their stored
  role is ignored and they can be revoked like any other.
- **Coach access (SA-06):** `server-coaching.js` only counts a coach link while its coach is an active coach.
- **Alliance Portal (SA-07):** `alliance-policy.js` checks the partner's membership and roles in the Alliance Discord
  server with the bot (cached 10 minutes; while Discord has errors an earlier *positive* result may be reused for
  `ALLIANCE_VERIFY_MAX_STALE_MINUTES`, default 30, never longer). Leaving the server, losing the role or removal from
  the allowlist ends access, including all Bridge controls. **If the bot cannot read the Alliance server, every
  partner request is refused** (fail-closed). The start-up log and Admin > Discord check show the result.
- **Malformed cookies (SA-08):** a session token must match a strict format before any cryptography is done. A
  malformed cookie used to stall every request; it now gets a normal answer (401).
- **Cross-site requests (SA-09, SA-10):** sign-out now has the same cross-site protection as every other change, and
  the `Origin` check compares scheme, host and port against `PUBLIC_URL`. The JSON check requires exactly
  `application/json`.
- **Client IP behind proxies (SA-11):** `X-Forwarded-For` is ignored unless the connection comes from an address in
  `TRUSTED_PROXIES`. Rate limits can no longer be bypassed with a forged header.
- **Requests in progress (found in adversarial testing):** the full permission check runs again after a request's
  data has arrived, just before anything is changed. A request that was opened before a kick, an officer removal or a
  sign-out can no longer complete with the old rights.
- **Discord RSVP buttons:** a kicked player, or someone who is no longer a guild member, can no longer answer events
  through the reminder or daily-schedule buttons.
- **Start-up safety:** an invalid or future `SESSIONS_VALID_AFTER`, or an unreadable `session-revocations.json`, stops
  the server with a clear `FATAL:` message (exit code 1) instead of starting with sessions in an unknown state.
- New `secret.txt` files are created readable by the owner only. An existing file is never changed.

## Leave of absence: content stays visible

A player marked **Inactive** (for example during a leave of absence) disappeared from parts of GuildHub, although
they are still a guild member. This was already the case in 1.46.2:

- their VODs lost their class and were filed under a collapsed "Other" folder, for themselves and for officers;
- the Gear Threads list did not show their character (also not for officers), and their own "My Gear Thread" link
  disappeared;
- their class coach no longer had them as a student and could not see their private VODs;
- they could not post a new VOD or share one with their class.

Now "Inactive" only affects attendance, reminders, events and the roster, as intended. As long as a player is still
a guild member, their own character keeps carrying their VODs, Gear Thread and coaching class, whether it is marked
Active or Inactive, with or without a leave. Kicked players and players who are no longer members do not get
anything back. Nothing about leaves, warnings or attendance changes. Inactive characters are marked "Inactive" in the
Gear Threads list.

While checking this, two older gaps were closed: a kicked player who signed in again (application page only) could
still list, edit, re-share and delete their own VODs, and a player who had left the guild without being kicked could
still post VODs. Rights that come from being a guild member now need current membership; officers still see a
removed player's content, and nothing is deleted.

## Guest coaches: invitations instead of a public link (B04)

| Before | Now |
|---|---|
| One fixed public link (`/#/guest-coach`); anyone with a Discord account could enrol as a guest coach for any class and then see, review and delete that class's private VODs | An officer creates a personal invitation for one class. It works once, for 72 hours, and can be revoked while unused |
| A guest coach picked and changed their own class | The invitation sets the class; only an officer can change it |
| A guest coach could edit or delete a student's VOD and anyone's coaching points | A guest coach adds coaching points, drawings and review notes, and edits or deletes only their own. They cannot edit, re-share or delete the recording |

- **Admin > Guest coaches** and **Roster > Coaches**: pick a class, create an invitation, copy the link (it is shown
  once), see open invitations with class, creator, creation and expiry time, revoke them. The guest-coach list shows
  each coach's Discord ID and whether they were invited or joined through the old public link.
- **Existing guest coaches keep their access and their class.** They are marked "Old public link - review" so
  officers can check them. Anyone who enrolled through the old public link without being wanted stays active until
  an officer removes them. Please review the list after updating.
- The invited person opens the link and signs in with Discord. Only that Discord sign-in uses the invitation, and only
  for someone outside the guild (not a member, not kicked, not already a guest coach). A refused sign-in does not use
  it up. Afterwards they sign in normally, without the link; their access does not expire until an officer removes it.
- Removing a guest coach signs them out everywhere at once. Changing their class takes effect at once.
- Review notes can now be deleted by their author.
- Invitation secrets are never stored (only a hash), never shown again after creation, and not included in backups
  downloaded from Admin. Creating, using and revoking invitations, class changes and removals are in the audit log.

## New settings (all optional)

| Setting | Default | Meaning |
|---|---|---|
| `TRUSTED_PROXIES` | empty | Comma-separated IPs/CIDRs of reverse proxies whose `X-Forwarded-For` is believed. Empty = use the connection's address only |
| `CLIENT_IP_HEADER` | empty | `cf-connecting-ip` to use Cloudflare's header; only honoured from a `TRUSTED_PROXIES` address |
| `ROLE_MAX_STALE_MINUTES` | 60 | How long Discord-role-based rights stay valid without a successful role check |
| `ROLE_REFRESH_INTERVAL_MS` | 600000 | Role refresh interval (10 minutes) |
| `ALLIANCE_VERIFY_FRESH_MINUTES` | 10 | How long a partner check is reused |
| `ALLIANCE_VERIFY_MAX_STALE_MINUTES` | 30 | How long a positive partner check may be reused while Discord has errors |
| `SESSIONS_VALID_AFTER` | empty | ISO time. Every session issued before it is refused. Use after restoring an older backup of the data folder |

## Requirements
- The Discord bot (`DISCORD_BOT_TOKEN`) must be a member of the guild server (for the role refresh) and of the
  Alliance server (for partner checks). Without the bot in the guild server, Discord-role-based officers lose officer
  rights 60 minutes after signing in. Officers listed by user id are unaffected.

## Known limitations
- Restoring an older copy of the whole data folder also restores an older `session-revocations.json`. Set
  `SESSIONS_VALID_AFTER` to the restore time (everyone signs in again), or keep the current revocation file.
- GuildHub has no separate ban; a kick is the removal mechanism.
- Guest coaches who enrolled through the old public link keep their access until an officer reviews and removes them.
- Restoring an older copy of the whole data folder can make an invitation that was used or revoked after that backup
  usable again until it expires (72 hours at most). Setting `SESSIONS_VALID_AFTER` after a restore also invalidates
  every invitation created before it.
- Removing an officer from `DISCORD_OFFICER_USER_IDS` (environment) takes effect at the next restart, without signing
  that person out; their sessions continue with their remaining rights.
