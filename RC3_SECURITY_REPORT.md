# GuildHub 1.46.2-hotfix.5 RC3 — implementation and verification

**Outcome: candidate for Claude's independent review, NOT production authorization.** No production access, data modification, deployment, push or merge occurred. Work is on a separate RC3 branch against the verified immutable RC2 release.

## Inputs and identity

RC2 ZIP: SHA-256 `e0e1ad61fc624b3e0096f3b5d0f9e2ca396339b18e75e074659733680f03751b`, 190 entries, 189 source-manifest entries. CRC, every manifest hash and the unchanged baseline extraction were independently checked. Claude's supplied RC2 evidence ZIP SHA-256: `d66296e9e8e410b8b77dc8e71e014eafb4f8c16bd77de1c0534e8bfdacb4253d`.

**Input limitation:** that audit ZIP contains 34 directory/file entries with scripts, result JSON, logs and a stand-in Dockerfile, but no full independent RC2 narrative report. The available reproductions/results were read and used; the user's six correction requirements are implemented. The complete narrative report is still needed for a final finding-by-finding reconciliation. No conclusions absent from those inputs are invented.

## Required corrections and independently observed results

| Area | Root cause in RC2 | RC3 implementation / evidence |
|---|---|---|
| Production policy | NODE_ENV guard existed, but shipped Docker/Compose did not enable it or forward the Ledger directory | Dockerfile sets production and installs/checks util-linux; Compose explicitly sets production/path and includes the exact intended host mapping. Actual startup tests refuse blank/relative/missing/permissive paths before serving. |
| Stale locks | Exclusive-create presence file survives SIGKILL; no automatic ownership proof | Stable inode with Linux flock held by the Node process's inherited open file description. Actual process death releases ownership; separate live processes and the offline tool cannot acquire it. Legacy RC2 locks require explicit stopped-RC2 acknowledgement. |
| Capacity | Each changed login timestamp emitted a full policy snapshot, approximately 46 KB with 150 users | Routine policy set/delete patches; authenticated snapshots and immutable compressed archives bound active replay. Complete original logical history retained. Storage and filesystem warnings plus regular-officer capacity endpoint. |
| Rollback | Missing DATA_DIR binding was regenerated from a potentially older restored Ledger | Missing established binding now refuses startup. Recovery requires an independently retained signed checkpoint matching history. Enrollment marker also prevents old-genesis intent replay. |
| Failed import | Intent immediately replaced policy with a candidate lacking newer members, even when database rename failed | Prepared candidate is durable but current valid ACLs stay authoritative until commit. Startup resolves durable intent against exact installed database digest. Failed-rename reproduction now preserves owner edit 200, no quarantine. |
| First initialization | Crash after key publication leaves no journal/head and no resumable genesis | Durable exact initialization intent precedes publication; interrupted RC3 genesis resumes idempotently. Reviewed key-only RC2 recovery keeps the key and refuses established state. |
| Consistency | Old unsupported-Ledger documentation and mismatched package/lock versions | Current guidance corrected; RC2 reports clearly historical. package.json and both lockfile version entries agree on 1.46.2-hotfix.5.rc.3. |

### Rollback reproduction

A single synthetic probe ran against both trees. It creates a member session, captures the pre-logout Ledger, successfully logs out, restores that older Ledger, deletes its binding and empties the old session mirror:

- RC2: logout 200, server starts, old session returns **200** — the vulnerability is reproduced.
- RC3: logout 200, startup **refused: missing independent binding**.

Claude's unmodified SEC-05 probe independently also records `S6b.oldLedger_plus_deletedBinding.started=false` for RC3. Old DATA_DIR with a genuinely newer surviving Ledger still cannot resurrect guest/session revocations. Older valid binding checkpoints can be verified through retained archives after compaction; a missing binding is never automatically adopted.

### Capacity/replay measurements

Same local Node 24.22.1 runtime and unchanged audit scripts, synthetic data only:

| Probe | RC2 | RC3 |
|---|---:|---:|
| 150-user fixture, bytes per login | 46,367 | 565 |
| 2,000 changed-policy events, active journal | 96 MiB | 0.7 MiB |
| Startup replay for that fixture | 3,302 ms | 33 ms |
| Average append in the 2,000-event probe | 4.19 ms | 3.74 ms |

These are local observations, not hardware latency guarantees or production capacity promises. The replay fixture did not reach the 4 MiB RC3 threshold; separate compaction tests force repeated generations, verify all retained revocations and replay the full archived history. The audit's “bytes per non-security edit” includes an extra officer login, so it is not attributed entirely to ordinary edits. The old projected “logins until 512 MiB” metric ignores compression and is not a retention forecast.

## Architecture and invariants

Implementation locations: `ledger-lock.js:7` (kernel ownership), `security-ledger.js:53` (policy patches), `:146` (authenticated layout), `:164` (compaction), `:206`/`:215` (initialization), `:253` (binding verification), `:277` (import crash resolution); `server.js:275` (production path validation) and the `/api/import` handler (prepare/commit/abort).

Every acknowledged revocation still has an fsynced authenticated event before success. Sequence numbers never reset. HMAC-SHA-256 authenticates events, state snapshots, layout, checkpoints and enrollment; SHA-256 binds the prior event and compressed archives. The random per-installation key is distinct from the session secret. No key or Ledger state is exposed by HTTP/export. Runtime guards now also detect same-size active-journal mutations through inode/size/mtime/ctime identity; full active HMAC and archive digest verification occurs at startup.

Compaction verifies the active chain, fsyncs compressed history and snapshot/fresh journal, then atomically/fsync publishes the layout. The old generation survives until publication. Before-publication failure leaves the old generation; after-publication failure leaves the new equivalent endpoint/state. Validated startup cleans only obsolete derived/staged generations. Snapshots preserve every retained session revocation/cutoff, burned invite hash and current security projection; archived events retain historical grants, removals and audit records. Offline inspection verifies every archived HMAC/sequence chain. No history or revocation pruning is implemented.

The 4 MiB active threshold is not a claim of constant total storage. Distinct revocations and immutable history grow. The default 512 MiB total budget, 50%/75% warnings and 64/16 MiB filesystem-space warnings provide operational limits. A generation needs staging space; exhaustion fails closed instead of deleting history. Capacity metadata is available only to regular officers at `GET /api/admin/security-ledger`, without identities, paths or tokens.

Import preparation retains current owner/member ACLs apart from conservative pending-invitation invalidation. Only a successful database installation commits the candidate policy. An interrupted intent is resolved from the actual database bytes before authorization. Unknown ownership from a successful restore remains quarantined pending existing officer review; failure must not quarantine an unaffected live member. These are deliberate security transaction semantics, not a general multi-file ACID guarantee.

RC3 initializes from a durable exact genesis intent, with a separately signed DATA_DIR enrollment record distinguishing an incomplete initialization from an established installation. Old intent replay against a retained established record is refused. Existing RC2 records migrate only after validating the existing binding. Key-only RC2 recovery is an explicitly reviewed, one-time never-initialized path, not automatic loss-of-history repair.

## Tests executed and failures retained

Full packaged suite on the release code: **565/565 pass, 0 failed, 0 skipped/cancelled, exit 0, 83.28 seconds** (`full-release.log`). Earlier development full runs passed 560/560 and 564/564 as coverage increased. Twenty RC3 tests were added; all prior test files remain.

New/retained tests cover:

- OS release across five real SIGKILL/restart cycles; live second-process denial; old mtime cannot steal ownership; recovery tool refuses a held lock.
- Repeated compaction with 300 policy changes and 300 distinct user revocations, exact post-restart state and 601 authenticated logical events retained.
- Real SIGKILL after archive, snapshot, fresh-journal and layout publication; SIGKILL during a partial archive temporary write; filesystem publication failure; missing/corrupt archives.
- Concurrent operations around compaction, monotonic sequences, warnings and safe exhaustion.
- Missing-binding rollback, trusted-checkpoint recovery, old valid binding through archived history and old-genesis replay after establishment.
- SIGKILL during initialization intent/component publication, idempotent exact-genesis recovery, reviewed key-only RC2 recovery and rejection of established-state reset.
- Production startup rejection cases; intended Docker/Compose metadata; version alignment.
- Prepared import before and after simulated database installation; real HTTP failed rename preserving a newer member's ownership after restart.
- Existing SEC-01–05, B04, GH-01, SA-01–11, LOA/inactive ownership, Discord membership/fail-closed policy, backup content and VOD permissions via the complete suite and unchanged independent probes.

Initial focused runs had expected old-contract failures and were NOT suppressed: three old unit assertions used RC2's presence-lock recovery/missing-binding adoption; one integration assertion expected SIGKILL restart to fail until manual unlock. Recovery was converted to kernel locking; assertions now enforce active-writer denial, automatic death recovery and missing-binding refusal while preserving the original revocation checks. All subsequent focused tests and full runs passed. Logs include the failed development runs.

Claude's prior adversarial script still returns **14/15**, with its sole failure the explicitly approved Low **HF4-06 owner class-sharing** issue (200 versus desired 403). This is reported, not counted as an all-pass probe. The full npm suite has no failures.

Other independent probes:

- SEC-05: far-2099, within-72-hour, no-status and redeemed-hash crafted imports do not bind OAuth or grant coaching. Legitimate B04 guest/class access survives; redeemed/revoked links and removed guests stay denied after old imports/rollbacks.
- Authorization: departed coaches denied, URL not exposed, historical postedBy access absent, rejected update unchanged after restart, LOA/inactive and officer historical access retained.
- Backup: supported content retained; malformed inputs 400; atomic final-write failure 503 with unchanged bytes/content; revocations remain effective. Old exact roundtrip checks differ by required import audit/nextId as already documented in RC2, not content loss.
- ENOSPC before any durable frame returns failure; that uncommitted revocation may be absent after restart. ENOSPC after journal fsync preserves revocation on restart. Partial uncommitted frames require verified offline repair. No failed operation is reported as successful.
- Claude's old bootstrap fault injector no longer hits RC3's atomic publication path (its result showed no SIGKILL); it is NOT counted as a crash proof. RC3-specific phase and partial-write injectors perform actual SIGKILL tests instead.
- Private Ledger HTTP paths return the SPA fallback without secrets; they are not file downloads. Export contains neither the key nor MAC metadata. Same-size active-file mutation now latches service unavailable.

## Changes, compatibility and deployment

The complete RC2-to-RC3 patch and exact changed-file list are in the evidence bundle. Operational changes are confined to the Ledger core/new lock helper, recovery/build scripts, server integration, Docker/Compose/env/version metadata, necessary tests and documentation. `access.js`, `discord.js`, `server-coaching.js`, private media rules, Shotcaller/bridge/PTT and frontend assets remain byte-identical to RC2; unchanged-file hashes are supplied.

No SQL/schema reset or production-data migration was performed. New authenticated layout/snapshot/archive/initialization and DATA_DIR enrollment files are additive persistent security structures. Existing RC2 frames remain readable. After RC3 compaction, RC2 cannot read the generation; rollback to old code is unsupported and can remove security enforcement. Do not use hotfix.4's lossy importer. Preserve the independently newer Ledger when restoring game data; application JSON export is not a Ledger/key/media backup.

Dockerfile/Compose source changes are intentional and required for production behavior. No live Portainer configuration was modified. Source changes do not prove the separately maintained actual stack has updated environment/mounts. `RC3_OPERATIONS.md` contains explicit first-bootstrap, legacy lock, key-only initialization, trusted binding, partial-tail, compaction and staging/recreation instructions.

## Remaining limitations and release gates

1. Claude must independently audit the exact RC3 artifact, kernel-lock assumption, compaction, migration, import durability and rollback handling before any authorization. Obtain the missing full RC2 narrative report and reconcile any unrepresented findings.
2. This environment has Node 24.22.1/Linux, no Docker/Podman or Node 22. No actual Node 22 Alpine build/test, two-container overlap, Portainer recreation, real Discord, production database, desktop/mobile visual pass, physical OOM or power-cut test was performed. SIGKILL and filesystem injection prove specific process/fault paths only.
3. Linux `/usr/bin/flock` and correct shared-inode semantics are required. There is no unsafe portable presence-lock fallback. Windows/macOS direct Node runs need a suitable Linux environment; container/host ownership and filesystem guarantees require staging confirmation. Never run RC2 and RC3 concurrently.
4. HMAC is not encryption and cannot protect against an actor with the application UID/key plus write access to every trust file. A fully privileged host actor can forge or coherently roll back key, Ledger, binding, enrollment and all trusted backup/witness copies. An independent external trust anchor is required against that threat and is not implemented. A trusted recovery checkpoint is an operator trust decision, not something inferred from the suspect Ledger.
5. Archive/state storage is not constant forever. Monitor budget, free space and latency; plan reviewed expansion/retention before hard exhaustion. No remote archive service, automatic history deletion, KMS/key rotation or indefinite retention guarantee is added.
6. Damaged committed history/keys remain fail-closed. A partial unacknowledged tail requires verified offline repair. A failed import can still invalidate pending invitations conservatively, so issue fresh normal links after recovery. Legacy missing revocation history cannot be reconstructed.
7. HF4-06 remains Low by explicit owner decision. Accepted Discord membership and temporary API-error denial are unchanged. Existing browser/CDN copies of previously exposed media are not revoked by Ledger changes.

**Release handoff:** RC3 plus reproducible source package/evidence is prepared for independent review. Production approval remains withheld.
