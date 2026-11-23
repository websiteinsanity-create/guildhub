> Historical RC2 document. Superseded for RC3 by RC3_OPERATIONS.md and RC3_LEDGER_DESIGN.md. Do not apply its presence-lock or missing-binding recovery instructions.

# GuildHub 1.46.2-hotfix.5 RC2 — engineering security report

**Status: release candidate for independent audit; deployment is NOT authorized.** No production access, deployment, push, merge or production-data change occurred. This is the implementation owner's evidence, not a substitute for Claude's independent audit.

## Identity and approved scope

Baseline: the supplied RC1 ZIP, SHA-256 `a742a57984ba959f556aa96038d456b1dd4a7ec5907fc133c36797a108954d4e`, 181 entries (180 source files plus RELEASE_FILES.sha256). ZIP CRC verified; all 180 source files match the preserved baseline checkout. RC1 commit `61bd31262aa9a53dd724e52cfc70be4f662ad5a2`, tree `4d16af9d3585c3b4c9ad938640c454bd431fd9e3`. Work uses a separate `hotfix/1.46.2-hotfix.5-rc2` branch.

Changes implement SEC-05 and SEC-06 plus necessary security-state reconciliation, tests, packaging and operational documentation. No Shotcaller/bridge/PTT/relay changes, frontend redesign, new feature, database reset or host stack change. Existing Discord membership and API-error fail-closed decisions remain approved; access.js, discord.js and the RC1 VOD authorization/validation code remain unchanged. HF4-06 remains an accepted Low issue, not silently fixed.

## SEC-05 — confirmed and repaired

Independent local reproduction with the SAME script against both source trees:

| Observation | RC1 | RC2 |
|---|---:|---:|
| Crafted backup import | 200 | 200 (content restored safely) |
| Begin sign-in using attacker token expiring in 2099 | 200 | 400 |
| OAuth state bound | Yes | No |
| Imported invitation | Pending | Revoked, hash stripped |
| Successful import in security audit | No | Yes |

Root cause: raw invitation records from backup data could re-enter the live pending-token set, bypassing issuance and lifetime controls. RC2 strips imported hashes, neutralizes pending/malformed invitation states, checks bounded timestamps on usable invitations and reconciles authorization against the durable current ledger. Current authorized B04 guests remain; stale backups cannot create or resurrect grants. Active pending links are invalidated conservatively during import. Relevant import intent/outcome and normal successful-import audit records are retained. Normal one-time issuance/redemption/revocation paths remain required.

Artifacts: `sec05-probe.cjs`, `sec05-rc1.json`, `sec05-rc2.json`; packaged regression tests include the hostile 2099 invitation.

## SEC-06 — authorization boundary

See SECURITY_LEDGER_DESIGN.md (recorded before implementation) and RC2_MIGRATION_AND_RECOVERY.md for the trust model, rollout gates and recovery commands.

The independent persistent ledger owns the latest security projection and monotonically restrictive session cutoffs/token revocations. It captures guest grants/class links, invite lifecycle, user membership/kick/role observations, officer/coach/Alliance database permissions, support one-time grant state and member/build ownership/class ACLs. Existing save paths commit the projection synchronously; dedicated session/support paths commit before acknowledging. An explicit new authorized grant can replace a previous policy decision; restoring stale data cannot.

Events use monotonic sequence, previous-frame SHA-256 and HMAC-SHA-256 with a separate random 256-bit key. The journal is append-only during normal operation. Key, journal, head and exclusive lock are in the configured owner-only directory. A separately signed DATA_DIR high-water binding detects ledger rollback when that newer binding survives. Writes fsync the journal and atomically replace/fsync both checkpoints before success. Full startup verification precedes authorization. Permission, identity, size or checkpoint failures latch HTTP unavailable, including login, private media and health. A crash-complete authenticated tail replays conservatively. Partial or corrupt history fails closed.

Startup merges existing valid session revocations without inventing missing guest history. A reviewed observed-state bootstrap, retained pre-ledger session mirror and explicit external-bootstrap acknowledgement make migration auditable and idempotent. Existing accepted Discord-membership rules remain unchanged. `SESSIONS_VALID_AFTER` becomes a durable monotonic global cutoff, also applied to invitations, so removing the environment value cannot undo it.

Unknown restored security grants are denied. Unknown member/build ACLs are quarantined until existing officer edit operations explicitly review them. Officers retain historical access. Application JSON import remains atomic for content; security intent precedes installation. Failed final DB writes can leave restrictive invitation invalidations committed, intentionally. No success is reported on a failed security commit. See the operations guide for the post-rename completion-failure case.

### Explicit security limits

- HMAC is integrity protection, not encryption. Ledger snapshots include security identifiers, grant metadata and token hashes. Protect the directory and its backups.
- Host root or someone who can replace the HMAC key AND journal/head/binding can forge or coherently roll back every local trust anchor. This is demonstrably undetectable without an independent external witness. One unit test records this limitation; its pass is NOT a claim to defend that attack.
- Runtime guards validate file type/owner/mode, storage identity, journal size, key and checkpoints. Full journal HMAC replay occurs at startup, not on every request. Same-size journal content corruption is detected on restart; cached live security state cannot thereby be weakened. Host-level mutation is outside the unprivileged application attacker model.
- Missing DATA_DIR binding may be rebuilt from a valid external ledger/head with a warning to support old DATA_DIR recovery. A mismatched binding is refused. A missing key with surviving security state never silently reinitializes.
- Bootstrap cannot know about guest removals absent from every provided legacy file. Current security state must be reviewed before acknowledging it. No fabricated historical events.
- One writer only. Abrupt death requires offline lock review/unlock. This favors authorization safety over automatic crash recovery.
- 512 MiB journal cap; no automatic rotation, compaction or key rotation. Full snapshots and synchronous fsync require host capacity/latency monitoring and production-sized staging tests. Reaching the cap fails closed.
- Trusted environment-based administrator grants remain operator configuration. The ledger is not a way to revoke a deliberately configured host administrator.

## Regression evidence and failures

All tests use isolated temporary files, fictional identities, real local HTTP and fake Discord/Shotcaller where needed. No production Discord messages.

- SEC-01 through SEC-04 retained. Claude's original RC1 authorization probe ran unmodified against RC2: departed coaches' old and fresh sessions cannot mutate private VODs or expose their URL; revoked coach-list access remains denied; rejected updates remain unchanged immediately and after restart; LOA/inactive ownership and officer historical access work. Kicked old sessions return 401; fresh sign-in is restricted.
- B04 suites cover issuance, one-time redemption, class restriction, revocation, races, lifetime and reauthentication. The expiry fixture now provisions authoritative test state explicitly offline; a db.json-only restore is separately denied. No expiry/callback assertions were removed.
- GH-01 media, SA-01–SA-11/session/proxy/request guards, Alliance, support, attendance, schedule and the rest of the complete packaged suite remain exercised.
- Claude's unmodified backup probe confirms no missing seeded collections, 400 rejection of malformed inputs, preservation of revocation, retained VOD/Gear/coaching records, concurrent write/restart consistency and 503 atomic import failure with unchanged content/files. Its byte-for-byte roundtrip checks now differ by the REQUIRED new import audit record and nextId; these differences are documented rather than called passes. Dedicated RC2 roundtrip tests compare unchanged content while explicitly checking the new audit entry.

First RC2 full run: **542 tests, 538 passed, 4 failed**, retained in `full-first.log`. Causes were independently reproduced:

1. Version assertion did not accept the candidate suffix containing a second hyphen. Candidate metadata now uses the accepted semver-compatible `1.46.2-hotfix.5.rc.2`.
2. X08 incorrectly tested a missing invitation against falsiness; the test helper returns `{}` for absence. The assertion now checks absence of the ID, while still requiring 400/no OAuth state.
3. I06 injected pending invitations into only db.json after ledger initialization. Reconciliation correctly removed them. The trusted expiry fixture now updates the authoritative test ledger offline, preserving the full HTTP expiry/callback checks.
4. The event-chart test imported a previously unknown alternate character then assumed its ownership was immediately trusted. It now asserts owner edit denial, explicit officer review, and the SAME chart outcomes after that review. Attendance rules were not changed.

The separate 78-test reproduction run then passed. Earlier focused import tests also failed their old exact-equality expectations because of the new mandated audit record; those now explicitly verify audit changes and preserve content-equality assertions. A canonical object-order comparison was replaced with structural equality, retaining all values. No failures were suppressed. New tests increased the suite by 22 (14 ledger, 8 HTTP/integration). **Final full suite: 545/545 passed, 0 failed, 0 skipped/cancelled on Node 24.22.1 (exit 0, 84.04 seconds); the preceding corrected full run also passed 545/545.** No Node 22 or container pass is claimed.

The earlier four hotfix.4 audit failures were already addressed/investigated in RC1: schedule persistence barrier, IPv4 proxy fixture, port allocation/startup and voice fallback fixture. This release does not broaden or weaken those fixes; the narrowed voice-fallback fixture from RC1 is still a coverage limitation. The unchanged image cleanup hook was repaired to await child exit before deleting its temp directory, preventing the ENOTEMPTY race Claude observed.

## Adversarial coverage map

| Scenario | Evidence |
|---|---|
| 2099 crafted invitation; strip/hash/audit | SEC-05 probe and ledger integration |
| Redeemed token replay; removed guest resurrection | Integration old JSON and raw DB/mirror restores |
| Removed officer, kicked user, class reassignment | Integration restore against newer policy |
| Revoked session/support resurrection | Integration mirror rollback and restart |
| Global cutoff env removal | Ledger/guard regression |
| Crash between journal fsync and head replacement | Real child SIGKILL, startup lock refusal, offline unlock, 401 replay |
| Partial writes/corruption/truncation | Injected writes; startup refusal; narrowly permitted recovery |
| Missing directory/key; bad permissions/head | Unit startup/failure tests |
| Concurrent operations; duplicate/out-of-order events | 40 parallel callers; sequence/chain rejection |
| Ledger-only rollback | Surviving independent binding rejects startup |
| All trust anchors rolled back | Explicit demonstration of threat-model limit |
| Migration/repeated startup | Legacy revocations and one bootstrap retained |
| Direct HTTP paths to ledger/security files | Integration no key exposure; existing path/media suites |

## Changes and compatibility

Production changes: backup.js; guest-invites.js; server-audit.js; server-features.js; server-geargear.js; server.js; session-guard.js; support-grants.js; new security-ledger.js and security-state.js. Operational tool: new scripts/ledger-recover.js. Release/version: package.json and scripts/build-release.py. Exact changed-file inventory and complete patch are in the evidence; test/documentation changes are enumerated there.

No SQL or destructive database migration. New persistent security files and additive `securityQuarantined` ACL metadata are introduced deliberately. Older application content backups remain supported, subject to conservative authorization reconciliation; they are not a mechanism for reverting security privileges. Existing JSON content structure and media bytes are preserved. Older application code does not enforce the ledger and is not a safe rollback target after RC2 revocations.

Dockerfile, docker-compose.yml, existing frontend, relay/bridge code and deployment mechanism were not modified. The administrator must verify the already intended mount/env/ownership; this report does not certify their current host setup.

## Release gates and remaining risks

1. Claude independently audits this exact ZIP, SEC-05, journal/trust model, migration, restore reconciliation and durability.
2. Run the full suite on Node 22 Alpine, stage real Discord authorization and invitation flows, and test actual container recreation with `/app/security-ledger` and persistent DATA_DIR. Docker/Podman and Node 22 were unavailable here; browser/mobile and production-database tests were not performed.
3. Verify host UID/permissions, free-space and fsync behavior; coherent encrypted security backups; monitoring/capacity; a procedure for stale-lock recovery; independently approved image pinning. Do not deploy until these pass.
4. HF4-06 (owner class sharing) remains Low by owner approval. Accepted-member Discord requirement and fail-closed Discord API behavior remain approved. Prior public caches/media copies are not erased by these changes.
5. Do not downgrade to RC1/hotfix.4 against this ledger-protected installation. That loses the security boundary; hotfix.4's importer additionally loses data.

**Hand-off outcome:** RC2 implements the approved fixes and is ready to be examined as a candidate. It is NOT self-certified production-ready.
