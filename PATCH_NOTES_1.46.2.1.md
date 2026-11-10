# GuildHub 1.46.2.1 – Security hotfix: private gear-thread images (GH-01)

This is a hotfix for the production version 1.46.2 and changes nothing else. GuildHub reports its version as
`1.46.2-hotfix.1`, the semver form of 1.46.2.1. Shotcaller is unchanged (4.6.0). There is no migration, no new or
changed setting, and no change to the database, the data format or any uploaded file.

## What changes
Until now, every file under `/uploads/` could be downloaded **without signing in** if you knew its name. That
included the private images of a gear thread.

From this version:

| File | Who can download it | Caching |
|---|---|---|
| `gearshot-…` (gear-thread screenshot), `gearthumb-…` (its preview), `gearfolder-…` (folder attachment) | Only someone who may open **that build's** gear thread: the owner, officers, the coach of that build's class, and read-only support access, exactly as in the app | `private, no-store`, never cached |
| `icon-…`, `background-…` (guild branding), `event-…` (event artwork) | Everyone, as before (the login screen needs them) | Unchanged (public) |

Answers for private images:

| Answer | When |
|---|---|
| **401** | Not signed in, or the session is invalid or expired |
| **403** | Signed in but not allowed (an unrelated member, an applicant, an Alliance session, or a coach of another class) |
| **404** | No gear thread references the file (for example a leftover file) |

Error answers contain no image data. Inside the app nothing changes for people who are allowed to see the images.

## Files changed
- `server.js`: the `/uploads/` handler checks private gear images (new `privateUploadStatus`). Other files are served as before.
- `server-geargear.js`: new `ctx.gearMediaAccess`. It finds the gear thread a file belongs to and applies the existing `canAccessBuild` rule.
- `test/private-uploads.test.js` (new): the access matrix; parity with the thread API; public images; real uploads.
- `test/gear-builds.test.js`: two image downloads now send the owner's session.
- `test/api.test.js`: the version check accepts a hotfix suffix.
- `package.json`, `package-lock.json`: version `1.46.2-hotfix.1`; the new test is in the test list.

## Known limits (fixed only in the next major release)
- Old links to gear images that were shared, or that sit in browser caches, stop working for everyone without access. Copies **already** downloaded or cached cannot be recalled.
- File names stay the same. Someone who has access anyway can still use an old link.
- Files of deleted gear-thread entries stay on disk. They are no longer reachable (404).
- 1.46.2 cannot end a session at a kick (that came in 1.46.4). A kicked player keeps their access to images until their cookie expires, exactly as for the rest of the app.
- A deliberately damaged session cookie can still leave a request without an answer (GH-11). This is unchanged and not part of this hotfix.

## Staging, deployment and rollback (Docker / Portainer)
Deploy only after staging has passed and after explicit approval. The steps are the same as for any 1.46.2 update.
`.env`, `docker-compose.yml` and the data folder stay as they are.

**Before (on the server):**
1. Back up the data folder while the container is stopped, or at least make a copy:
   `sudo tar czf ~/guildhub-data-before-1.46.2.1-$(date +%F).tgz -C /opt/persistent_volume/guildhub data`
2. Keep the current image for rollback: `docker tag guild-hall:latest guild-hall:rollback-1.46.2`
3. Unpack 1.46.2.1 into a **new** folder next to the old one and copy `.env` into it. Keep the old folder.

**Deploy:**
4. In the new folder: `docker compose build` and then `docker compose up -d`.
   **Portainer:** Stacks → guildhub → Editor. Update the stack from the new folder (or Git ref) and keep the environment variables unchanged.
5. Check:
   - `https://<address>/api/config` shows `"version":"1.46.2-hotfix.1"`.
   - The container is `healthy`.
   - Your own gear thread still shows its screenshots.
   - A gear-image link (right-click an image → copy link) opened in a **private window** without signing in returns an error, not the image.
   - The guild icon on the login screen is visible.

**Rollback (safe, because the data doesn't change):**
- Docker:
  1. `docker compose down` in the new folder.
  2. `docker tag guild-hall:rollback-1.46.2 guild-hall:latest`.
  3. In the **old** folder: `docker compose up -d --no-build`. If your compose version builds anyway, `docker compose up -d --build` rebuilds 1.46.2 from the old folder.
- Portainer: deploy the stack again from the old folder or Git ref.

After a rollback, private images are publicly reachable again (as in 1.46.2).
