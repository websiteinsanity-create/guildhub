> Historical RC2 document. Superseded for RC3 by RC3_OPERATIONS.md and RC3_LEDGER_DESIGN.md. Do not apply its presence-lock or missing-binding recovery instructions.

# GuildHub hotfix.5 RC2 — migration, persistence and recovery

Release candidate only. Claude must independently verify SEC-05, the security boundary and recovery before authorization. No production actions were performed. Existing Dockerfile, Compose and host paths are unchanged.

## Required deployment checks

The administrator's existing bind mount is:

```
/opt/persistent_volume/data/GUILDHUB_LEDGER:/app/security-ledger
```

Required container setting: `GUILDHUB_LEDGER_DIR=/app/security-ledger`. `DATA_DIR` must independently persist the application database, uploads, secret.txt, session-revocations.json, security-ledger-binding.json and support-grants.json. Do not put either directory under public/ or expose it through a reverse-proxy alias. A separate directory under DATA_DIR is for local development only; NODE_ENV=production refuses that fallback. A missing NODE_ENV does not establish persistence: explicitly verify the mount and configured path.

Ledger directory: real directory, owned by the container's effective UID, exactly mode 0700. Files exactly 0600; no symlinked ledger directory or files. Node must be able to create, append, rename and fsync there and atomically replace/fsync the DATA_DIR binding. Check real UID/GID on the chosen image, filesystem ownership, free space, read/write mount options and durable local filesystem semantics. Do not recursively chmod unrelated host folders. Network-filesystem locking and power-loss semantics are unverified; use a suitable local persistent filesystem. Run only ONE GuildHub writer per ledger. Never share it between live and staging instances.

The existing image is Node 22 Alpine. These RC2 tests ran on Node 24.22.1/Linux, not Alpine. Independently run `npm test` in the actual Node 22 Alpine image, then real Discord OAuth/role-refresh/invitation/media checks in staging. The production .dockerignore excludes test/, so the exact production image needs a read-only test-source mount for the suite; do not misreport a missing-tests run as a runtime pass. For example, from the verified extracted source on a staging host, with NO production env file or data/ledger mounts:

```
docker run --rm --entrypoint npm --mount type=bind,src="$PWD/test",dst=/app/test,readonly -e NODE_ENV=test <approved-rc2-image-digest> test
```

This uses the image's Node/Alpine runtime and application source with the verified matching test directory. Separately perform the staged persistent-volume/recreation test below. The repository has zero npm dependencies. Pin the independently approved image/digest and preserve the previous artifacts separately; automatic updates must not replace an approved candidate without review.

## First migration

1. Stop the old application; preserve a coherent, access-controlled copy of DATA_DIR, including the existing session revocation file and guest-coach state. Confirm it is the latest production state, not an old restored database. Review authorized guests, invitations, coach links, officer/coach lists, Alliance permissions and member ownership. Check any separate incident/removal records. Missing history cannot be reconstructed from current files.
2. Confirm the ledger mount is a real, empty 0700 directory with the proper UID. Verify DATA_DIR persistence and backups. Do not reuse another installation's key/journal.
3. For this first bootstrap only, set `GUILDHUB_LEDGER_BOOTSTRAP=acknowledge-current-state` alongside the required directory variable. This explicitly acknowledges current security grants were reviewed. Start RC2 in isolated staging first. Startup writes an authenticated observed-state bootstrap, not fictional historical revocation events. It preserves valid legacy token and user revocations, current guest/invitation states and support state. Malformed legacy security state refuses startup. Originals are retained; after the bootstrap is durable a 0600 session-revocations.pre-ledger.json copy is retained when a legacy mirror exists.
4. Verify startup/health and the new key.json, events.jsonl, head.json and DATA_DIR/security-ledger-binding.json. Do not print their contents to logs or chats. A legacy file or grant absent from the reviewed source cannot magically be recovered by migration. If history is doubtful, reconcile privileges with the owner before bootstrap; do not acknowledge unreviewed state.
5. Remove the bootstrap acknowledgement on subsequent starts. Repeated starts load the journal and do not create duplicate bootstrap events. Keep the configured persistent directory. The legacy mirror may only add restrictive session information, never remove a ledger restriction.

Do not delete or overwrite the old security files before migration succeeds. If initialization fails partway, keep all artifacts, stop every writer and investigate. Do not delete keys or the binding to force a new bootstrap. Restore a trusted coherent pre-migration checkpoint only after establishing that no later security operation was acknowledged and after independent recovery review.

## Backup/import semantics

Application JSON backups contain game/guild data and sanitized invitation history, not ledger keys/events or media bytes. Continue backing up uploads separately. An import preserves all supported content collections, with RC1's validation and atomic application database replacement.

Security policy is authoritative in the independent ledger: newer session revocations, global session cutoff, guest/coach removals and class restrictions, invitation redemption/revocation, support one-time state and officer/coach/Alliance DB permissions survive older imports and database rollbacks. Current explicitly authorized guests survive an older application backup. Trusted normal administration can explicitly regrant rights; an old import cannot.

All imported invitation hashes are stripped and pending/malformed invitations become non-redeemable. An import also invalidates currently pending invitations conservatively: create new invitations through the normal officer workflow afterward. Import intent/completion/failure is recorded in the ledger; successful imports add security.backup.import to the normal audit view. Imported ordinary audit history remains application data, not the authoritative ledger.

Unknown restored user grants are denied. Unknown restored member/build ownership/class ACLs are quarantined. Officers retain historical content access; review and save the member (and, where applicable, each extra build) through the existing officer edit operation to release its quarantine. Review ownership and weapon/class fields explicitly. Imports overlay the latest known ACLs rather than silently reverting ownership or sharing grants. No existing UI redesign is included.

There is no multi-file distributed transaction. Import stages/validates content, commits a conservative security intent, then atomically renames the application database. If that final rename fails, application data remains unchanged, but pending invitation invalidation can remain committed. If final ledger completion recording fails after the database rename, HTTP fails closed; inspect the durable intent/database on recovery rather than assuming nothing committed. A failed operation never proves rollback of an already durable security restriction. SEC-04's rejected validation/update requests still leave their content unchanged.

## Normal restarts and container recreation (staging procedure)

Use synthetic staging identities and a separate persistent ledger/data pair. Start with the exact `/app/security-ledger` container path and the intended mount. Log in, create/redeem an invitation, remove its guest and log out a member. Save an older application-only backup for the restore probe. Stop the container cleanly, remove/recreate the container while retaining BOTH mounts, and confirm old sessions and invitations remain denied. Import the older application backup and repeat. Confirm a fresh authorized session still works. Record image digest, effective UID, mount inspection and results without recording credentials. This container test has NOT been run in this workspace.

A clean shutdown flushes the application DB and removes only the owned writer lock. SIGKILL, host crash or interrupted migration leaves an exclusive lock on purpose: automatic container restart remains unhealthy until safe offline recovery. This sacrifices automatic availability instead of guessing whether another container is still writing.

## Offline crash recovery

Stop ALL containers/processes with access to the ledger and prevent restart policies from starting them while maintenance occurs. Preserve a coherent byte-for-byte copy of the ledger directory plus DATA_DIR binding, database, revocation mirror and support state. Protect these copies as security secrets. The explicit acknowledgement below is an operator assertion, not proof that other writers stopped.

If only a stale lock remains, run from the RC2 source as the owning UID:

```
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --unlock --I-confirm-all-writers-stopped
```

Use the actual DATA_DIR if it is not /data. Inspect the complete authenticated prefix without modifications:

```
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --I-confirm-all-writers-stopped
```

If startup reports a partial final frame and every signed checkpoint refers only to complete authenticated preceding frames, the narrowly scoped repair may preserve a copy and truncate ONLY the uncommitted partial tail:

```
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --repair-tail --I-confirm-all-writers-stopped
```

The tool refuses missing committed data or a bad complete prefix/checkpoint. It never resets keys, invents events, resigns a journal, or repairs arbitrary corruption. Complete authenticated events beyond an older checkpoint replay conservatively on startup; an interrupted request may already have revoked access. If a complete event is corrupt, a committed frame is missing, a key is lost or checkpoints mismatch, keep the service offline and restore/reconcile a trusted coherent backup under independent review. Do not clear files until it starts.

A lost DATA_DIR binding can be regenerated from the surviving authenticated external ledger/head with a warning. This supports old DATA_DIR restoration; it reduces independent rollback-witness coverage. A mismatched binding is not ignored.

## Ledger backups, retention and rollback

Take coherent OFFLINE backups of key+journal+head and the independent DATA_DIR binding together. Encrypt and restrict access to backups; key.json authenticates the whole ledger. Preserve a newer independently controlled high-water copy/witness when possible. Keep the live external ledger when restoring older game data. A session-revocations.json copy alone is NOT a ledger backup. Application export/import must never restore or reset ledger files.

HMAC gives integrity, not encryption. The journal contains security identifiers, grant snapshots, timestamps, audit descriptions and hashed tokens; it is sensitive and not a general export. The append-only journal has a 512 MiB hard cap. Monitor size/free space/latency and treat capacity planning as a release gate. No automatic rotation, compaction, key rotation or retention deletion is implemented: reaching the cap fails closed. Plan reviewed offline archival/continuation before capacity is exhausted. Full policy snapshots cost space and synchronous fsync adds security-operation latency; a production-sized performance/power-loss test remains required.

Rolling back application code to RC1 or earlier removes ledger enforcement. RC1 and hotfix.4 MUST NOT be run against the live state after ledger-protected revocations. Hotfix.4's importer additionally loses content. Restoration of all local trust anchors (key, events, head AND binding) to an older consistent set is undetectable without an external trusted witness. Host root or an attacker with the key and all filesystem backups can forge or co-roll back the ledger. The application does not claim protection against that actor. Do not perform a rollback without a reviewed forward-security reconciliation procedure.
