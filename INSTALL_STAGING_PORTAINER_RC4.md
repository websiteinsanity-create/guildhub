# GuildHub 1.46.2-hotfix.5 RC4 – staging upgrade from 1.46.2-hotfix.1 (Portainer)

Package: `guildhall-1.46.2-hotfix.5-rc4-deploy.1.zip`. The app code is byte-identical to the audited RC4. See
`RELEASE_NOTES_RC4_DEPLOY1.md` for what is different.

This guide covers the staging environment only. Production follows the same steps with the live paths. It may
start only after the owner approves it once staging has passed (section 9).

| | Staging | Live (do not touch today) |
|---|---|---|
| Compose file | `docker-compose.staging.yml` | `docker-compose.yml` |
| Stack / container | `guildhub-test` / `guild-hall-test` | (your live stack) / `guild-hall` |
| Image | `guild-hall-test:rc4` (built locally, never pulled) | `guild-hall:latest` |
| Ledger folder | `/opt/persistent_volume/guildhub-test/GUILDHUB_LEDGER` | `/opt/persistent_volume/guildhub/GUILDHUB_LEDGER` |
| Data folder | `/opt/persistent_volume/guildhub-test/data` | `/opt/persistent_volume/guildhub/data` |
| Host port | `STAGING_HOST_PORT` (default 3100) | `PORT` (default 3000) |
| Watchtower | disabled (`enable=false`) | enabled label |

Throughout this guide:

```sh
REL=/opt/guildhub-release/guildhall-1.46.2-hotfix.5-rc4-deploy.1
TL=/opt/persistent_volume/guildhub-test/GUILDHUB_LEDGER
TD=/opt/persistent_volume/guildhub-test/data
```

All commands run as root on the Docker host. None of the scripts in `deploy/rc4/` change anything.

**Hard rules**

- Never delete, empty, reset or recreate anything in a Ledger folder, or the `security-ledger-binding*` files in a
  data folder.
- Never run two containers on the same data or Ledger folder.
- Never run hotfix.1 (or any version before RC4) against data that RC4 has started on. Rollback means restoring the backup (section 8).
- Staging gets no live Discord bot token, no live client secret, no live Shotcaller URL or key and no live Alliance settings.

---

## 1. Record the current state (hotfix.1 still running)

1. In Portainer, open the current staging stack. Note:
   - the stack name, container name and image;
   - the published host port and the URL;
   - the names (not the values) of its environment variables.

   Copy its compose text and environment list into a private note. This is your rollback configuration.

2. Note the live container's state, so you can prove later that it was not touched:

   ```sh
   docker inspect -f '{{.Name}} {{.Image}} {{.State.StartedAt}}' guild-hall
   ```

3. Run the read-only diagnostics against staging. Use the current staging container's name for `C`:

   ```sh
   C=<current staging container> LEDGER=$TL DATA=$TD sh $REL/deploy/rc4/guildhub-ledger-diagnose.sh
   ```

   Check section 3 (mounts). `/data` must come from `/opt/persistent_volume/guildhub-test/data`.

   **STOP** in any of these cases:
   - `/data` is a Docker named volume;
   - `/data` is any other folder;
   - `/data` is a live path.

   In those cases the paths in this guide do not match your staging environment.

## 2. Backup (required before the upgrade)

1. In Portainer, go to Stacks, open the current staging stack and click **Stop**. Wait until its container shows "exited".

2. Back up both folders together, keeping owners and modes:

   ```sh
   mkdir -p /opt/backups && chmod 700 /opt/backups
   B=/opt/backups/guildhub-test-hotfix1-pre-rc4-$(date +%Y%m%d-%H%M).tar.gz
   tar -C /opt/persistent_volume --numeric-owner -cpzf "$B" guildhub-test
   sha256sum "$B" > "$B.sha256" && tar -tzf "$B" | head -20 && ls -l "$B"
   ```

   The listing must include `guildhub-test/data/db.json` and `guildhub-test/data/uploads/`. The backup contains
   `secret.txt`, so keep it on the host or in an encrypted location.

3. Keep the hotfix.1 image for rollback:

   ```sh
   docker tag <hotfix.1 image or image ID from step 1> guild-hall-test:hotfix1-rollback
   ```

4. Count the data before the upgrade. Section 3 below has the matching "after" command. The script prints counts only:

   ```sh
   docker run --rm --network none -v $TD:/d:ro -v $REL/deploy/rc4:/s:ro --entrypoint node \
     guild-hall-test:hotfix1-rollback /s/guildhub-data-summary.js /d > /opt/backups/summary-before.txt
   ```

## 3. Unpack, verify and build the RC4 image

1. Copy the ZIP and its `.sha256` to `/opt/guildhub-release/`, then check and unpack:

   ```sh
   cd /opt/guildhub-release
   sha256sum -c guildhall-1.46.2-hotfix.5-rc4-deploy.1.zip.sha256
   mkdir "$REL" && unzip -q guildhall-1.46.2-hotfix.5-rc4-deploy.1.zip -d "$REL"
   cd "$REL" && sha256sum -c --quiet RELEASE_FILES.sha256 && echo MANIFEST OK
   ```

2. Optional: confirm that the code is identical to the audited RC4. Unpack the audited
   `guildhall-1.46.2-hotfix.5-rc4.zip` into `/tmp/rc4-audited` and run:

   ```sh
   diff -r /tmp/rc4-audited "$REL"
   ```

   The only output allowed is the files listed in `RELEASE_NOTES_RC4_DEPLOY1.md`.

3. Build the staging image. It needs internet access for the base image `node:22-alpine` and `apk`:

   ```sh
   docker build -t guild-hall-test:rc4 "$REL"
   docker run --rm --entrypoint node guild-hall-test:rc4 -e "console.log(require('/app/package.json').version)"
   ```

   The second command must print `1.46.2-hotfix.5.rc.4`.

   The tag `guild-hall:latest` (live) is not touched. Do not use `docker compose build` with the production file.

4. Check the code inside the image against the manifest. Documentation and tests are not copied into the image, so the script skips them:

   ```sh
   docker run --rm --network none -v $REL/deploy/rc4:/s:ro --entrypoint node guild-hall-test:rc4 /s/guildhub-image-verify.js /app
   ```

   The last line must start with `IMAGE CODE OK`.

## 4. Prepare and check the Ledger folder

1. The folder exists already. It must be owned by root (the container runs as root) and have mode 0700:

   ```sh
   stat -c '%A %a %U:%G %n' $TL
   ls -la $TL
   ```

2. If the mode or owner is wrong, fix only the folder itself. This deletes nothing:

   ```sh
   chown root:root $TL
   chmod 700 $TL
   ```

3. Run the pre-flight check with the staging container stopped:

   ```sh
   LEDGER=$TL DATA=$TD sh $REL/deploy/rc4/guildhub-preflight.sh
   ```

   The expected result for staging today is `VERDICT: FIRST-INIT-ALLOWED`. This means the Ledger folder is empty
   (a lone `writer.lock` is fine) and `/data` has no `security-ledger-binding*` files.

   For any other verdict, stop. Do not set the bootstrap variable, and send the output for review.

## 5. Create the RC4 staging stack in Portainer (one-time Ledger bootstrap)

1. If the old staging container is already named `guild-hall-test`, rename it. Do not delete it:

   ```sh
   docker rename guild-hall-test guild-hall-test-hotfix1
   ```

   It stays stopped. Never start it again on this data.

2. Go to Portainer, then Stacks, then **Add stack**:
   - Name: `guildhub-test`.
   - Web editor: paste `docker-compose.staging.yml` unchanged.

3. Add these environment variables (Advanced mode accepts `NAME=value` lines):

   | Variable | Value |
   |---|---|
   | `GUILDHUB_LEDGER_BOOTSTRAP` | `acknowledge-current-state` (exactly this, no quotes, no spaces). **First deployment only.** |
   | `PUBLIC_URL` | The staging URL, e.g. `https://guildhub-test.example.org`. No slash at the end. If you reuse staging's current URL and port, keep them. |
   | `STAGING_HOST_PORT` | The staging host port, e.g. `3100`. Must not be the live port. |
   | `MEMBER_PASSCODE`, `OFFICER_PASSCODE` | Staging-only values. Only used if Discord login is not configured. |
   | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | The staging Discord application. Its OAuth redirect must be `<PUBLIC_URL>/auth/discord/callback`. |
   | `DISCORD_GUILD_ID`, `DISCORD_OFFICER_ROLE_IDS`, `DISCORD_OFFICER_USER_IDS` | Your Discord test server. |
   | `DISCORD_BOT_TOKEN` | Empty (no Discord messages at all), or a staging bot that is a member of the test server only. |
   | `SHOTCALLER_URL`, `SHOTCALLER_API_KEY`, `ALLIANCE_*` | Leave out, unless you have a separate test Shotcaller. |

   About `DISCORD_BOT_TOKEN`:
   - The staging data may contain channel IDs of the live server. A bot that is not a member of the live server cannot post there.
   - With the token empty, the code sends nothing. Every send function returns "No bot token set".
   - Role re-checks also need the bot. Without it, put testers who need officer rights in `DISCORD_OFFICER_USER_IDS`.

4. Click **Deploy the stack**. Then check that the bootstrap value really reached the container:

   ```sh
   C=guild-hall-test LEDGER=$TL DATA=$TD sh $REL/deploy/rc4/guildhub-ledger-diagnose.sh
   ```

   Section 4 must show:

   ```
   NODE_ENV=|production|
   GUILDHUB_LEDGER_DIR=|/app/security-ledger|
   GUILDHUB_LEDGER_BOOTSTRAP=|acknowledge-current-state|
   ```

   Section 3 must show exactly the two `guildhub-test` paths.

5. Check the logs. Portainer: container `guild-hall-test`, then Logs. Or from the shell: `docker logs guild-hall-test`.

   - Success is a line containing `running` and no `FATAL`.
   - If there is a FATAL, use the error table in section 10. Do not keep redeploying blindly. A refused start
     writes only `writer.lock` and changes nothing in `/data` (tested).

6. When the container is healthy, the Ledger exists. Check it:

   ```sh
   ls -la $TL
   LEDGER=$TL DATA=$TD sh $REL/deploy/rc4/guildhub-preflight.sh
   ```

   - `ls` must show `events.jsonl`, `head.json`, `key.json` and `writer.lock`, all `-rw-------` (0600).
   - The pre-flight check must print `VERDICT: ESTABLISHED`.

## 6. Remove the bootstrap setting (same day, right after step 5)

1. In Portainer, open the `guildhub-test` stack and go to Environment variables:
   - delete `GUILDHUB_LEDGER_BOOTSTRAP`, or set it to empty;
   - click **Update the stack**. This recreates the container.

2. Check the result:

   ```sh
   docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' guild-hall-test | grep LEDGER_BOOTSTRAP
   ```

   It must show `GUILDHUB_LEDGER_BOOTSTRAP=` with nothing after it.

   The container must start healthy. A healthy restart without the variable proves the Ledger is reused.

3. Prove that further restarts reuse the same trust root:

   ```sh
   stat -c '%y %s %n' $TL/key.json
   docker restart guild-hall-test
   sleep 20
   stat -c '%y %s %n' $TL/key.json
   docker logs --since 2m guild-hall-test | grep -c FATAL
   ```

   - The two `stat` lines must be identical.
   - The FATAL count must be `0`.

4. Make a second backup (section 8). From now on, the Ledger folder and the data folder only belong together as a pair.

## 7. Post-installation checklist

Tick every line. "Before" means `summary-before.txt` and your notes from section 1.

**Installation**

- [ ] The version in the container is `1.46.2-hotfix.5.rc.4`:
  ```sh
  docker exec guild-hall-test node -e "console.log(require('/app/package.json').version)"
  ```
- [ ] `docker ps` shows `guild-hall-test` as healthy, with image `guild-hall-test:rc4`.
- [ ] The mounts are exactly the two `guildhub-test` folders. No live path appears (diagnostics, section 3).
- [ ] The label is `com.centurylinklabs.watchtower.enable=false`:
  ```sh
  docker inspect -f '{{json .Config.Labels}}' guild-hall-test
  ```
- [ ] `GUILDHUB_LEDGER_BOOTSTRAP` is empty in the running container.
- [ ] The live container `guild-hall` has the same image and the same `StartedAt` as in section 1.2.
- [ ] Live is still reachable and working.
- [ ] Watchtower's log shows nothing about `guild-hall-test`.

**Ledger**

- [ ] Ledger folder `0700 root:root`. Files `events.jsonl`, `head.json`, `key.json` and `writer.lock` are `0600`.
- [ ] `$TD` contains `security-ledger-binding.json` and `security-ledger-binding.json.enrollment`. The enrollment status is `established` (diagnostics, section 7).
- [ ] A restart without bootstrap is healthy and `key.json` is unchanged (step 6.3).

**Data and functions (hotfix.1 to RC4)**

- [ ] The counts are unchanged:
  ```sh
  docker run --rm --network none -v $TD:/d:ro -v $REL/deploy/rc4:/s:ro --entrypoint node guild-hall-test:rc4 /s/guildhub-data-summary.js /d > /opt/backups/summary-after.txt
  diff /opt/backups/summary-before.txt /opt/backups/summary-after.txt
  ```
  Expected differences:
  - a new `guestCoachInvites 0` line;
  - changes that come from your own test actions after the upgrade;
  - automatic no-show warnings for past events. The scheduler issues these with the same rule as hotfix.1
    (`server-compliance.js` line 143 is identical); one appeared in the rehearsal. With a bot token set, such a
    warning can also send a DM, which is one more reason staging must never use the live bot.
- [ ] Members and permissions:
  - an officer and a normal member sign in via Discord;
  - the officer sees the officer areas;
  - the member does not;
  - the roster and character count are as before.
- [ ] Events and sign-ups:
  - past and upcoming events are listed;
  - existing sign-ups are shown;
  - a tester can change a sign-up and set it back.
- [ ] Attendance history: a past event shows the same attendance as before.
- [ ] Gear Threads:
  - an existing thread opens with its screenshots for its owner and for an officer;
  - after signing out, a direct image link returns 401.
- [ ] Coaching and VODs: existing VODs, coaching points and coach links are shown, and a coach sees their students.
- [ ] Leaves, warnings, loot and the info board are shown as before.
- [ ] Discord integration:
  - sign-in works with the staging application;
  - with a staging bot, a test reminder or DM reaches a tester on the test server;
  - nothing appears on the live Discord server.
- [ ] Session revocation:
  - sign out a tester;
  - restart the container;
  - the old browser tab must still be signed out.
- [ ] Sessions from hotfix.1 stay valid after the upgrade (tested). Testers do not need to sign in again.

When every box is ticked, staging passes. Report the result to the owner. Production needs the owner's explicit approval.

## 8. Backup and rollback

**Routine backup after RC4 is established.** Always back up both folders together, with the container stopped:

```sh
docker stop guild-hall-test
tar -C /opt/persistent_volume --numeric-owner -cpzf /opt/backups/guildhub-test-rc4-$(date +%Y%m%d-%H%M).tar.gz guildhub-test
docker start guild-hall-test
```

A Ledger without its matching data folder, or the other way round, does not start. That is deliberate.

**Rollback A: RC4 never started successfully.** This means no `key.json` in `$TL` and no binding file in `$TD`.

1. Stop and remove the `guildhub-test` stack. Bind-mounted folders stay.
2. Rename `guild-hall-test-hotfix1` back to its old name and start the old staging stack.
3. Leave `writer.lock` where it is.

RC4 wrote nothing else.

**Rollback B: RC4 has started on the data.** This is the case once `key.json` or the binding exists. Do not
start hotfix.1 on this data.

Starting hotfix.1 on this data was tested: hotfix.1 starts and ignores the Ledger. Sessions that RC4 had signed out
become valid again, and security history is bypassed. A later RC4 start would then also miss whatever happened in
between.

The only supported way back:

1. Stop the `guildhub-test` stack.
2. Keep the RC4 state by renaming it. Nothing is deleted:
   ```sh
   mv /opt/persistent_volume/guildhub-test /opt/persistent_volume/guildhub-test.rc4-$(date +%Y%m%d-%H%M)
   ```
3. Restore the pre-upgrade backup:
   ```sh
   sha256sum -c <backup>.sha256
   tar -C /opt/persistent_volume --numeric-owner -xpzf <backup>
   ```
4. Start the hotfix.1 staging stack with image `guild-hall-test:hotfix1-rollback`.

Changes made on staging after the upgrade are then gone. The kept RC4 folder must not be mounted again.

Do not upgrade again from the restored backup without the owner's approval. That upgrade starts with a new first
initialization from section 4.

## 9. Production (only after staging passes and the owner approves)

Production is not part of today's work. When it is approved:

1. Use `docker-compose.yml` from this package. Its only change is the Ledger mount
   `/opt/persistent_volume/guildhub/GUILDHUB_LEDGER:/app/security-ledger`.
2. Follow sections 1 to 8 with these values:
   - `LEDGER=/opt/persistent_volume/guildhub/GUILDHUB_LEDGER`
   - `DATA=/opt/persistent_volume/guildhub/data`
   - `C=guild-hall`
3. Watch for these differences from staging:
   - The pre-flight check must print `FIRST-INIT-ALLOWED` before the single bootstrap start.
   - The old path `/opt/persistent_volume/data/GUILDHUB_LEDGER` from the failed attempt is left as it is. If it
     contains anything other than `writer.lock`, **STOP** and send the output for review.

## 10. Start-up errors

| Message in the log | Meaning | What to do |
|---|---|---|
| `permissions must be 0700` | The Ledger folder is 0755, typically because Docker created it. | `chmod 700` the folder only. Run pre-flight, then start. |
| `missing trust root; refusing reinitialization` while pre-flight says FIRST-INIT-ALLOWED | The bootstrap value did not reach the container. Typical causes: set on the wrong stack, stack not redeployed, a typo or a trailing space. | Check diagnostics section 4 for exactly `\|acknowledge-current-state\|`. |
| `missing trust root; refusing reinitialization` with any other pre-flight verdict | `/data` is already bound, or Ledger files are missing. | **STOP.** Never bootstrap. Send diagnostics and pre-flight output. |
| `missing trust root; unexpected existing state` | Unknown files are in the Ledger folder. | **STOP.** Delete nothing. |
| `initialization conflicts with established enrollment` | This `/data` was already enrolled, and the mounted Ledger folder is the wrong one or empty. | **STOP.** Find the real Ledger folder (diagnostics, section 5). |
| `writer lock: exclusive kernel lock unavailable` | Another container or process uses the same Ledger folder. | Stop the other one. Check that live and staging do not share paths. |
| `GUILDHUB_LEDGER_DIR is required in production` | The variable is missing. | Use the shipped compose file unchanged. |
