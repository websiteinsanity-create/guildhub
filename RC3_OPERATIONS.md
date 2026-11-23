# RC3/RC4 production operations and recovery

Release candidate for independent review. RC4 changes only targeted identifier validation and recovery inspection; the RC3 storage/deployment architecture remains. No production deployment is authorized by this document. RC2 runbooks are superseded. Keep the immutable RC2 ZIP for evidence; do not run RC2 against RC3 state after migration/compaction.

## Production configuration and Portainer prerequisites

The shipped Dockerfile now sets `NODE_ENV=production` and installs util-linux, checking `/usr/bin/flock` during build. The shipped Compose explicitly forwards:

```
NODE_ENV=production
GUILDHUB_LEDGER_DIR=/app/security-ledger
```

Its security mount is the administrator's intended existing mapping, unchanged:

```
/opt/persistent_volume/data/GUILDHUB_LEDGER:/app/security-ledger
```

The existing DATA_DIR mapping, Discord settings, ports, network, secrets and application behavior are retained. Updating a source ZIP does NOT update a separately maintained Portainer stack automatically. Compare the effective stack/environment/mounts deliberately. No live stack was changed by this work.

Production refuses an unset/blank/relative Ledger directory, absent mount directory, symlinked directory/files, wrong UID or modes, inaccessible storage, unavailable flock, inconsistent state or missing binding. Directory must be a real 0700 directory owned by the actual container UID; Ledger files 0600. The Dockerfile retains the existing image UID behavior (normally root); verify the actual UID rather than assuming 1000. Do not chmod/chown unrelated host paths. App DATA_DIR and Ledger must both persist independently and remain outside public/ and proxy static aliases. Merely seeing a directory inside a container does not prove it is a persistent bind mount; inspect the effective host configuration.

Use a local Linux filesystem that correctly implements flock on the same inode, atomic rename and fsync. Separate overlay copies, network-filesystem lock anomalies and simultaneous RC2/RC3 writers are unsupported. Verify real container persistence, filesystem and power-loss characteristics on the host. The development fallback is explicitly warned and never used with NODE_ENV=production.

## Upgrade from a working RC2 installation

1. Stop RC2 cleanly, disable competing restart/update jobs, and confirm no old process/container is running. RC2 did not participate in kernel locking; mixed versions cannot be safely coordinated automatically.
2. Take coherent offline, access-controlled backups of DATA_DIR and the complete Ledger directory. Include key, head, journal, independent DATA_DIR/security-ledger-binding.json and security-ledger-binding.json.enrollment, legacy session-revocations.json, support state, database and media. Record a separately retained trusted high-water checkpoint outside both restore targets. Never publish keys or Ledger snapshots.
3. Preserve the current binding and Ledger. Do not replace them with application JSON exports or older files. Check ownership, 0700/0600, free space, memory headroom and effective environment/mounts.
4. Start RC3 with the explicit production settings. RC2 frames/key/head/binding are verified without resetting revocations. A clean RC2 stop removes its old presence lock; RC3 creates a permanent kernel-lock inode. Remove first-bootstrap acknowledgement if it was left configured.
5. If RC2 crashed and left a legacy UUID presence lock, first prove RC2 is stopped. ONLY then use `GUILDHUB_LEDGER_MIGRATE_LOCK=acknowledge-rc2-stopped` for the initial RC3 start, then remove it. Temporarily add one-time recovery variables to the actual container environment/Portainer stack explicitly; merely putting a variable that Compose does not forward in .env is insufficient. Without this acknowledgement RC3 refuses an unprovable legacy lock. Age/mtime/PID guessing never authorizes takeover.
6. Check health, authorized and revoked sessions, guest class restrictions, private media and `/api/admin/security-ledger` as a regular officer. Stage imports, then restart/recreate with both persistent mounts. New compaction layout is not backward-compatible with RC2's reader. Do not downgrade.

For installations predating any Ledger, stop/review the latest current security state and legacy revocations first, then set `GUILDHUB_LEDGER_BOOTSTRAP=acknowledge-current-state` for ONE first initialization. No historical revocation events are invented. Review existing guest grants, invitations, coach/class links, officer/Alliance settings and ownership against removal history. Missing historical data cannot be reconstructed; do not acknowledge unreviewed old backups. Originals are retained and a pre-ledger revocation mirror is preserved after successful migration. Remove the bootstrap flag after success.

## Crash recovery and locks

`writer.lock` now stays on disk. Its presence and timestamp do not mean a live writer exists. Linux flock, held by the application's open file description, is the ownership authority. SIGKILL/OOM/process termination automatically releases it; a competing live RC3 writer is refused. Never delete/rename a lock file or run age-based cleanup: that creates a second inode and defeats mutual exclusion.

Normal crashes with complete authenticated frames recover automatically after acquiring the kernel lock. Complete uncheckpointed events replay conservatively, including revocations for requests whose client lost the response. Staged compaction files are cleaned only after validating the published generation. The same lock excludes application writers and recovery tools. A restart loop cannot take ownership from a live writer.

A partial final event is NOT automatically discarded. The service remains unavailable until the operator stops all writers, preserves evidence and verifies that both signed checkpoints reference complete earlier frames. Run the offline tool as the owner:

```
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --I-confirm-all-writers-stopped
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --repair-tail --I-confirm-all-writers-stopped
```

Substitute actual DATA_DIR for /data. The tool verifies all archived event HMAC/sequence chains, snapshot/history endpoints, the complete active prefix and both checkpoints, then may preserve a durable partial-file copy and truncate ONLY uncommitted trailing bytes. Missing committed data or a bad complete frame is refused. A failed uncommitted revocation may remain unapplied; it never returned success. A complete durable revocation survives a failed checkpoint/client response.

**RC4 recovery correction:** inspection uses an existing lock read-only and never creates or rewrites its bytes. An absent or legacy RC2 lock is refused; inspection cannot establish that an RC2 process stopped. To migrate a legacy presence lock, first stop RC2 and all other writers, preserve security backups, then run the explicit mutating command:

```
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --unlock --I-confirm-all-writers-stopped --I-confirm-rc2-stopped
```

Both acknowledgements and `--unlock` are required for legacy conversion. A live kernel lock still cannot be taken over. The flags are operator assertions about old RC2 processes, not a PID/age-based proof. Modern read-only inspection preserves bytes, inode, mode, mtime and ctime; it may perform ordinary filesystem reads. Offline verification now checks event/state semantics as well as signatures, and refuses already-invalid security entries rather than declaring them healthy. Do not delete/reset a damaged Ledger or roll back revocations as a workaround; obtain case-specific independent recovery review.

`--unlock` is retained as an explicit mutating ownership check for compatibility (it refreshes modern lock metadata). It acquires the kernel lock and releases it without unlinking any file; it fails while a live writer holds the lock. It is normally unnecessary after RC3 crashes. It does not prove an old RC2 process stopped; that remains an explicit upgrade prerequisite.

## Missing binding and rollback

An established Ledger with missing DATA_DIR binding ALWAYS refuses startup. Restoring an older Ledger and deleting its binding must not restore old privileges. Restore a separately preserved, independently trusted signed checkpoint, while all writers are stopped:

```
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --restore-binding /trusted-offline/latest-binding.json --I-confirm-all-writers-stopped
```

The supplied file must be outside the Ledger directory, the destination must be absent, and the checkpoint must authenticate and match retained history. A checkpoint newer than a rolled-back journal is refused. An older legitimate DATA_DIR binding can be verified against the retained archives while a newer Ledger continues to enforce newer revocations.

Do NOT generate the “trusted” checkpoint from the suspect rolled-back Ledger/head. If no independent checkpoint survives, keep the application offline and obtain owner/independent recovery review; the tool cannot establish missing history or safely certify an old head. HMAC alone cannot distinguish a coherent rollback of EVERY local trust anchor. A host administrator or compromised application UID controlling the key, Ledger, binding, enrollment and backup/witness copies can forge or co-roll them back. Defending that requires an independently protected external trust anchor, not implemented here.

## Interrupted first initialization

RC3 writes a durable `initialization.json` intent containing the exact reviewed genesis and key BEFORE publishing components. A crash at intent/key/journal/head/binding publication resumes that same intent under the kernel lock, validates matching existing bytes and removes the intent only after all components are durable. A separately signed DATA_DIR/security-ledger-binding.json.enrollment records initialization versus established installation; a retained established marker refuses replay of an old genesis intent. Back up and protect this additional trust file. It never rebuilds genesis from a changed database or resets a completed Ledger.

RC2 could crash leaving only key.json, with no journal/head/binding and no intent. Safe automatic reconstruction is impossible from that alone. Stop all processes, preserve the key and all DATA_DIR files, and independently establish that initialization never completed and NO security operation was acknowledged. For this narrowly verified case ONLY, the owner may perform a one-time start with BOTH:

```
GUILDHUB_LEDGER_BOOTSTRAP=acknowledge-current-state
GUILDHUB_LEDGER_RECOVER_INITIALIZATION=acknowledge-never-initialized
```

If a legacy lock remains, also apply the stopped-RC2 migration acknowledgement above. RC3 retains the existing key and records an observed current genesis through its durable intent. It refuses this path when a completed journal/head/layout/binding exists. Remove recovery/acknowledgement variables afterward. Do not use it to bypass a lost established Ledger or missing binding. If history is uncertain, remain offline and recover a trusted coherent backup under review.

## Compaction, capacity and monitoring

Routine policy changes are small set/delete patches, not complete copies of every user. At 4 MiB active-journal size the next write compacts under the same exclusive lock. Logical event sequence is never reset. Preparation verifies the active chain, then fsyncs a compressed immutable archive, an authenticated state snapshot and a fresh active journal. An atomically replaced/fsynced signed layout publishes the generation. Old derived files remain until that commit; cleanup only removes obsolete derived/staging generations whose content is already retained in the published archive chain.

Snapshots contain all current security state (including every retained session revocation and global cutoff, burned invite hashes and current grant revocations), current chain endpoint and authenticated archive digests/ranges. Every original logical event, including historical grant changes and audits, remains in the compressed archives. Startup validates snapshot signatures, required archive digests/ranges and the active HMAC chain. Offline inspection additionally replays every archived HMAC/sequence chain. Missing/corrupt archives are fatal. No automatic pruning or forgetting of revocations is implemented.

Active replay is bounded by the compaction threshold plus one event, but snapshots and immutable history necessarily grow with distinct security state/events. Total history cannot remain constant for infinitely many events. The default 512 MiB total Ledger budget now covers compressed history and derived files rather than 512 MiB of repeated raw snapshots. Temporary generation preparation needs additional space; approaching capacity fails closed instead of deleting history. The application emits warning/critical messages at 50%/75% budget or less than 64/16 MiB available filesystem space. Inspect current counts, bytes, disk space, sequence and warning through the regular-officer-only `GET /api/admin/security-ledger` endpoint. It exposes no keys, tokens, identities or file paths.

Monitor application/container logs, health, free space and this endpoint; set external alerting. Plan reviewed storage expansion/archival well before the hard budget. No remote archive service, indefinite constant-space retention, automated deletion policy or key-rotation service is introduced. Keep all archive files with the key/snapshot/layout/head; application JSON exports are NOT Ledger backups. Large pre-RC3 journals require staging with sufficient RAM/free space for first replay/compaction. Do not assume the login-capacity projection in the old benchmark models compaction or actual hardware durability.

## Import recovery

Application content is validated/staged as in RC1/RC2. A durable import preparation records candidate security policy, exact candidate database digest and conservative pending-invitation invalidation. Current member/owner ACLs remain valid until the database replacement succeeds. Then an import commit publishes the candidate policy. A failed rename records abort, leaving current ACLs intact; newly created members absent from the attempted backup are not quarantined on restart.

If the process dies between these steps, startup compares the actual database bytes against the durable intent and resolves commit/abort before authorization. Pending invitation invalidation remains restrictive even on failure; issue fresh normal invitations afterward. Imported unknown ownership remains quarantined only when content was actually restored, with existing officer review as before. Old imports never override later revocations or redeem imported hashes. Do not roll back security files when importing game content.

## Required external acceptance before production

This workspace has Node 24.22.1 and no Docker/Podman/Node 22 runtime. Kernel/process crash, filesystem fault and simultaneous-process tests are evidence, NOT a claim that real OOM, power loss, two containers or Portainer have been tested.

Build the exact RC3 image on staging, verify `/usr/bin/flock`, NODE_ENV, effective UID, mount identity and health refusal on a missing mount. The production .dockerignore omits tests; run the verified matching source tests in the exact image using a read-only fixture mount and NO production env/data:

```
docker run --rm --entrypoint npm --mount type=bind,src="$PWD/test",dst=/app/test,readonly -e NODE_ENV=test <approved-rc3-image-digest> test
```

Use separate synthetic persistent DATA_DIR/Ledger mounts for recreation/SIGKILL tests. Start two containers against the SAME staging Ledger and confirm only one serves; kill the owner and confirm a successor enforces old revocations. Exercise compaction, failed restore, old DB import, guest removal and missing binding. Check real Discord OAuth, permissions/media/LOA and Shotcaller smoke behavior in staging without production notifications. Independently review full recovery evidence and pin the approved image. Physical storage durability and correct host mounts require host confirmation.
