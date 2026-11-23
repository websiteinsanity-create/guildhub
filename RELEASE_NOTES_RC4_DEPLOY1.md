# GuildHub 1.46.2-hotfix.5 RC4 – deployment package 1 (`rc4-deploy.1`)

Package: `guildhall-1.46.2-hotfix.5-rc4-deploy.1.zip`. Date: 2026-11-21.

Baseline: the independently audited `guildhall-1.46.2-hotfix.5-rc4.zip`, SHA-256
`07974f2597970013cf812a8c07264404e94e185fc90a3921c5c2985430ed92f3`. That archive is neither modified nor replaced.

## Classification

**This is code-identical repackaging. The application code does not change.**

- All 198 files of the audited archive are present.
- Of these, 196 are byte-identical. The two changed files are listed below; `RELEASE_FILES.sha256` is regenerated.
  - `docker-compose.yml`: one line.
  - `test/security-ledger-rc3.test.js`: one assertion that pins the Ledger mount path.
- Every application `.js` file, `public/` file, `package.json`, `Dockerfile`, `config.json` and catalog file is unchanged.
- The version stays `1.46.2-hotfix.5.rc.4`.
- No security fix, Ledger behaviour or Shotcaller integration is changed.

**Needs review before production (deployment configuration, not code):**

- the changed volume line in `docker-compose.yml`;
- the new `docker-compose.staging.yml`;
- the one-line test update. The audited test asserted the old path verbatim, so without the update the suite would
  report 1 failure against the corrected compose file. The test is not part of the image.

The new operator scripts in `deploy/rc4/` are read-only. The app never loads them, and `.dockerignore` keeps them out of the image.

Nothing here needs a renewed code audit. The image built from this package differs from one built from the audited
archive only by:

- `docker-compose.yml`;
- `docker-compose.staging.yml`;
- `RELEASE_FILES.sha256`.

The app does not read these files. Docs and `deploy/` are excluded from the image by `.dockerignore`.

**Not included:** the Discord event-time fix 1.46.2-hotfix.4.1. It remains a separate tracked release task and needs
explicit approval to be merged into the hotfix.5 line.

## Exact changes compared with audited RC4

| File | Status | Change |
|---|---|---|
| `docker-compose.yml` | changed | Line 77: Ledger mount `/opt/persistent_volume/data/GUILDHUB_LEDGER` → `/opt/persistent_volume/guildhub/GUILDHUB_LEDGER`. Nothing else. SHA-256 `4b306c19…0efd0` → `ae867287…181ad`. Identical to the owner-supplied corrected file. |
| `test/security-ledger-rc3.test.js` | changed (test only) | In the test "Docker, Compose and package lock activate production policy with the intended persistent mapping": the expected mount `/opt/persistent_volume/data/GUILDHUB_LEDGER:/app/security-ledger` → `/opt/persistent_volume/guildhub/GUILDHUB_LEDGER:/app/security-ledger`. All other assertions are unchanged (NODE_ENV, GUILDHUB_LEDGER_DIR, Dockerfile, package lock). |
| `docker-compose.staging.yml` | new | Staging stack, described below. SHA-256 `da80e824…420ba`. |
| `RELEASE_NOTES_RC4_DEPLOY1.md` | new | This file. |
| `INSTALL_STAGING_PORTAINER_RC4.md` | new | Portainer staging guide, which covers: one-time bootstrap, post-installation checklist, backup and rollback, start-up error table, production notes. |
| `deploy/rc4/guildhub-preflight.sh` | new | Read-only pre-flight check. Verdicts: FIRST-INIT-ALLOWED, ESTABLISHED, INTERRUPTED-INIT or STOP. |
| `deploy/rc4/guildhub-ledger-diagnose.sh` | new | Read-only diagnostics, delivered on 20 Nov. The only change is the default Ledger path, now the corrected one. |
| `deploy/rc4/guildhub-data-summary.js` | new | Read-only count of collections and uploads, for before/after comparison. Prints no names or IDs. |
| `deploy/rc4/guildhub-image-verify.js` | new | Read-only check of the code inside a built image against `RELEASE_FILES.sha256`. |
| `RELEASE_FILES.sha256` | regenerated | Covers all files of this package. |

The full SHA-256 list of every file is in `RELEASE_FILES.sha256`.

### Production `docker-compose.yml`

- The mounts are now:
  - `/opt/persistent_volume/guildhub/GUILDHUB_LEDGER:/app/security-ledger`
  - `/opt/persistent_volume/guildhub/data:/data`
- `NODE_ENV=production`, `GUILDHUB_LEDGER_DIR=/app/security-ledger` and `GUILDHUB_LEDGER_BOOTSTRAP=${GUILDHUB_LEDGER_BOOTSTRAP:-}` are unchanged.
- All Discord, Shotcaller, Alliance, proxy, port, health check, logging and Watchtower settings are unchanged.

The file still ends in an incomplete comment ("…docker compose up -"), exactly like audited RC4 and hotfix.4. This is
harmless and was deliberately not touched.

### Staging `docker-compose.staging.yml`

- **Names:** project `guildhub-test`, service `guildhub-test`, container `guild-hall-test`.
- **Image:** `guild-hall-test:rc4`, with `pull_policy: never`. The image is built once by hand, so the live tag
  `guild-hall:latest` can never be overwritten from staging, and Portainer's web editor needs no build context.
- **Port and URL:**
  - host port `${STAGING_HOST_PORT:-3100}` → container port 3000;
  - `PUBLIC_URL` is required, so deployment fails without it instead of falling back to a default.
- **Mounts:**
  - `/opt/persistent_volume/guildhub-test/GUILDHUB_LEDGER:/app/security-ledger`
  - `/opt/persistent_volume/guildhub-test/data:/data`
- **Ledger settings:** the same three as production.
- **Watchtower:** `com.centurylinklabs.watchtower.enable=false`.
- **No shared secrets:**
  - every value comes from the staging stack's own variables;
  - Shotcaller and Alliance are empty by default;
  - passcodes are required, so the defaults `guild` and `officer` are never used.
- **Discord messages:** none to live. Either use a staging bot that is only on the test server, or leave
  `DISCORD_BOT_TOKEN` empty. With it empty, every send, post, edit and delete function returns "No bot token set"
  without contacting Discord (`discord.js` lines 48, 148, 191, 211, 222).

## Upgrade compatibility: 1.46.2-hotfix.1 → RC4

The test was a real hotfix.1 server followed by a real RC4 server on the same data folder, with fake Discord and
fictional data (`TEST_RESULTS_RC4_DEPLOY1.md`).

- **No manual data migration is needed.** Every collection in `db.json` is byte-for-byte identical after the RC4
  start. The differences are:
  - `users.*.lastLogin`, which changes from new sign-ins;
  - a new empty `guestCoachInvites` collection.

  The data covered:
  - members and roles;
  - events and sign-ups;
  - attendance;
  - points, loot, leaves and warnings;
  - VODs, coaching points and coach links;
  - Gear Thread screenshots, notes and settings.
- **Uploads:** files are unchanged. Gear images stay private: 200 for the owner and officers, 401 when signed out.
- **Sessions:** cookies issued by hotfix.1 remain valid under RC4, so nobody has to sign in again. Sign-outs under RC4 are recorded in the Ledger and survive restarts.
- **Session revocations:** hotfix.1 keeps no server-side revocation list, so there is nothing to carry over.
  `session-revocations.pre-ledger.json` is only created when such a list exists.
- **One-way:** the upgrade cannot be safely reversed. hotfix.1 starts on RC4 data, but it ignores the Ledger, and a session signed out under RC4 is accepted again.
  - Rollback is a restore of the pre-upgrade backup only (guide, section 8).
- **Limitation:** the test used fictional demo data. Record shapes that exist only in the real staging data are
  covered by the before/after count comparison and the checklist in the guide.

## Ledger start-up behaviour (re-tested on this package)

| State | Result |
|---|---|
| Ledger folder 0755 | Refused: `permissions must be 0700`. Nothing is written. |
| 0700, bootstrap empty or with a trailing space | Refused: `missing trust root; refusing reinitialization`. Only `writer.lock` is written, and `db.json` is unchanged. |
| 0700, `acknowledge-current-state`, no binding | Initializes once. The Ledger gets `events.jsonl`, `head.json`, `key.json` and `writer.lock` (0600). `/data` gets the binding and enrollment files. |
| Restart without bootstrap | Starts. `key.json` is unchanged and revocations persist. |
| Restart with bootstrap left on | Starts and `key.json` is unchanged. The setting must still be removed. |
| Empty or wrong Ledger folder after initialization | Refused: `initialization conflicts with established enrollment`. No new key is created. |
