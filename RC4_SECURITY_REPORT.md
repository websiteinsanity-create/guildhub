# GuildHub 1.46.2-hotfix.5 RC4 — targeted correction report

**Status: candidate for Claude's independent verification. Production approval remains withheld.** No deployment, push, merge, live access or production-data change occurred. Work is on a separate RC4 branch based on the immutable RC3 release.

## Authoritative inputs and baseline

- RC3 ZIP SHA-256: `0288e997fdd6bc458fb178d121d21021b930c171c39883147b8fe4ecc6ec8ef2`; 196 entries, 195 source files plus manifest. ZIP CRC, every manifest hash and the unchanged baseline extraction are verified in the evidence.
- Claude's complete 12-page **Independent Production Security Audit** PDF, dated 14 November 2026, was read in full. It reconciles all seven RC2 findings and identifies RC3-01 High and RC3-02 Low. The previously missing narrative input is now supplied.
- Claude's supplied RC3 audit-evidence ZIP SHA-256: `380d10606d9c8e9ae5147a4d6543d032b62c098ac70e8388a11bc38095fc273e`. Original scripts were executed unchanged against isolated synthetic data. Originals, report text/PDF, results and logs are included in the review evidence.

## RC3-01 — High: prototype-derived kick target corrupts replay

### Independent reproduction

Unmodified `proto-key-kick.js`, same Node runtime and fake Discord:

| Result | RC3 | RC4 |
|---|---|---|
| Officer POST kick ownerKey=valueOf | **200** | **400** |
| Live service afterward | 200 | 200 |
| Restart | FATAL invalid session entry | **Started normally** |
| Offline tool in the original probe | Incorrectly calls signed history healthy after the failed restart | Refuses competing access because the successfully restarted service holds its kernel lock |

The final tool result is expected: the original script inspects while the fixed service is still live. Separate offline tests validate both semantic inspection and lock exclusion.

### Root cause and correction

A plain `db.users[owner]` lookup treated Object.prototype.valueOf as a registered account. Kick changed that function's properties and passed its name into revocation. The Ledger and legacy guard then combined an inherited function with a numeric timestamp through Math.max, yielding NaN. The event itself was signed with a finite time, so replay repeatedly regenerated an invalid state.

Corrections are limited to that class of security input/lookup defect:

- Kick requires a raw **string Discord ID matching the application's existing 15–25 digit convention**, plus an own, actual account record; unknown valid IDs return 404. Validation occurs before character/account/audit/revocation changes.
- Account dictionaries loaded from disk, reconciled from security state or installed by import use prototype-free maps. Relevant account lookups therefore cannot resolve built-in prototype functions.
- Officer identity lists are validated before either submitted role or user list can mutate settings. Discord mode requires Discord IDs; local demo mode preserves safe ordinary demo names. This is another route that can subsequently call user-session revocation.
- Ledger `notBefore` and `revoked` updates/merges use own-property numeric lookups. Burned-token lookup requires an own true entry under a real lowercase 64-character SHA-256 key.
- Security event identifiers, hashes, numeric values and the resulting state are checked **before signing, compaction, disk writes or publication**. Invalid events return 400 without poisoning the live writer. Actual storage failures still latch fail-closed as before.
- The standalone session guard uses the same safe principal checks and own numeric reads; legacy mirrors are validated consistently.
- Replay and offline semantic inspection enforce the same supported event/state rules. Inspection no longer labels an already-invalid prototype revocation healthy merely because its HMAC chain is valid.

Generic Ledger/session keys also serve local demo and support sessions, so they are not blindly restricted to Discord snowflakes. They must be nonempty trimmed printable strings up to the application's 64-character identity boundary, excluding Object.prototype names and `prototype`. Hash maps require SHA-256 keys. Production kick/officer targets use the stricter Discord-specific format. These checks preserve supported demo names such as `Demo Officer` and `support:SupportAI`.

### Atomic rejection and compatibility evidence

Six named prototype cases (`valueOf`, `toString`, `constructor`, `hasOwnProperty`, `__proto__`, `prototype`) plus malformed strings, controls, nonstrings, malformed hashes and non-finite/negative times are covered. Tests compare complete in-memory exports, Ledger state, file contents and directory inventory around rejection. They deliberately put the journal above its compaction threshold: a rejected event must not trigger even a maintenance write. A subsequent valid operation still succeeds and restarts correctly.

HTTP tests verify valid kicks revoke the existing session and preserve that revocation over restart. The officer-list combined invalid-user/valid-role test proves no partial role update occurs.

A compatibility probe created and compacted real history with the unchanged RC3 library, then opened it with RC4: security state preserved, original signed history bytes unchanged, all old revocations/burned hashes retained, further valid append and restart successful; semantic inspection verified 28 events. A packaged historical-v1 test separately covers legacy full-policy, user/token revocation and import frames through compaction and replay.

**Already damaged history:** RC4 does not delete, rewrite, skip or re-sign previously invalid signed events. An existing Ledger poisoned by an RC3 prototype attack remains fail-closed and is identified as invalid by offline inspection. Preserve all files and obtain case-specific independent recovery review. Resetting the Ledger or restoring an older checkpoint would lose later revocations and is not an authorized repair in this release.

## RC3-02 — Low: read-only recovery inspection launders an RC2 lock

### Independent reproduction

Claude's unchanged `rc3-probe.js` / `rc2CrashLegacyLock` scenario ran with a genuine RC2 fixture:

| Observation | RC3 | RC4 |
|---|---|---|
| Application start on legacy lock without stopped-RC2 acknowledgement | Refused | Refused |
| Read-only offline inspection with only generic all-writers-stopped acknowledgement | Rewrites legacy lock as v2 | **Refused; legacy bytes retained** |
| Application start afterward without migration acknowledgement | Incorrectly starts | **Still refused** |

The same probe verifies legitimate explicit application migration and later kernel crash recovery still work and revoked sessions stay 401.

### Correction

`ledger-lock.js` adds a read-only acquisition mode. Inspection uses an existing file descriptor opened read-only, takes the exclusive kernel lock, and does not create, truncate, replace or refresh the lock metadata. Unknown/legacy or absent locks are refused during inspection. A live kernel writer is still excluded.

Only explicit `--unlock` is a mutating lock command. To convert legacy RC2 metadata it additionally requires **both** acknowledgements:

```
node scripts/ledger-recover.js /app/security-ledger /data/security-ledger-binding.json --unlock --I-confirm-all-writers-stopped --I-confirm-rc2-stopped
```

A bare inspection, `--unlock` with only the generic acknowledgement, or an RC2-stopped acknowledgement without `--unlock` cannot convert legacy state. Modern repair/binding operations also do not implicitly migrate legacy locks. The operator must genuinely stop RC2 first; RC2 never held a kernel lock, so acknowledgement is not a technical proof of its absence. No age/PID guessing or lock unlinking was introduced.

Regression tests compare modern and legacy lock bytes, inode, mode, mtime and ctime, test absent-file refusal without creation, explicit migration, application reopen and active-writer denial even with all flags. The underlying kernel-lock and inode protocol remain unchanged.

## Production scope and files

Production logic changes:

- `server.js`: strict/own kick target checks; prototype-free account dictionaries on load/import.
- `server-community.js`: prevalidate officer identities before security-setting mutation.
- `security-ledger.js`: own-map reads, identifier/hash/state validation and pre-write rejection; exports shared validators/replay for the recovery tool.
- `session-guard.js`: protect the same standalone/mirror revocation paths.
- `security-state.js`: prototype-free reconciliation and consistent legacy revocation validation.
- `ledger-lock.js`: optional non-mutating acquisition.
- `scripts/ledger-recover.js`: explicit legacy migration acknowledgement and semantic inspection.

Necessary metadata/tests/docs: package and lock versions aligned to `1.46.2-hotfix.5.rc.4`; release builder identifies the RC3 baseline and fixed 14-November archive date; new RC4 regression suite; existing Discord test assertion correction explained below; current recovery addendum and this report/changelog. The complete patch and exact changed-file inventory are supplied.

No database or Ledger-format migration, history rewrite, key change, Docker/Compose change, frontend change, permission-policy redesign, bridge/Shotcaller change or attendance production change. Valid existing events and checkpoints remain supported. The RC3 operational architecture/trust limitations remain applicable.

## Tests and all observed failures

**Final complete suite: 581/581 pass, 0 failed, 0 skipped/cancelled, exit 0, Node 24.22.1/Linux, 91.78 seconds.** Sixteen RC4 tests were added; no prior security tests were removed.

Runs retained in the evidence:

- Existing focused Ledger suites: 42/42; broader security selection: 65/65; initial new RC4 tests: 14/14, then expanded historical checks brought coverage to 16.
- First complete run: 579/579 passed before the two additional historical tests.
- Expanded complete run: **580/581**, one failure in unchanged `test/discord.test.js`: expected pin.sent count 2, captured count 0.
- Final complete run after the narrow test correction: **581/581**.

### PIN test failure investigated, not dismissed

The production PIN code is byte-identical to RC3. `generatePin()` publishes a code with `sent:[]`, then asynchronous `sendPinDMs()` assigns the completed result. The test captured an early HTTP response object, waited for fake Discord to observe delivery and then asserted against the OLD object. HTTP JSON snapshots do not update when server state changes.

An isolated diagnostic source copy delayed fake Discord's PIN responses by 300 ms. It deterministically recorded **capturedSent=0, latestSent=2, delivered=2**, then reproduced the old assertion failure (21/22). No production code was edited. The actual test now polls a fresh server response for the persisted delivery result before asserting the same count; all recipient/content/PIN/attendance assertions remain. The delayed diagnostic then passed 22/22, and the complete suite passed. Both diagnostic logs and the diagnostic-only patch are supplied.

A first compatibility-probe comparison also used JSON.stringify equality, which flagged property ordering despite unchanged values/history. Structural deep equality independently confirmed state preservation; signed bytes remained unchanged throughout. The first result and corrected script/results are retained, not hidden as a product fix.

### Original probes and crash evidence

- `proto-key-kick.js`: unchanged RC3 exploit reproduced; RC4 returns 400 and restarts normally.
- `rc3-probe.js` legacy-lock scenario: unchanged laundering reproduced on RC3 and blocked on RC4.
- `unsafeKeySnapshot`: the unchanged probe's attempted constructor revocation now throws BEFORE any event. This is the expected refusal, not an all-pass continuation of a probe designed to accept that call. Packaged tests prove the writer stays usable afterward.
- Unchanged SEC-01–04 authorization and SEC-05 invite/rollback probes preserve departed/removed-coach denial, atomic VOD rejection, legitimate class-limited guests and old-backup protection.
- Unchanged backup probe preserves applicable content, rejects malformed input and retains atomic write-failure/revocation behavior. Exact content comparisons still differ only by the mandated import audit record/nextId as documented in RC2/RC3.
- Prior adversarial script: **14/15**, sole failure remains the accepted Low HF4-06 owner class-sharing issue. It is not reported as all-pass.
- Unchanged crash harness, explicitly parameterized to 25 random SIGKILL rounds with 8 KiB compaction threshold: **2,250 acknowledged revocations, zero lost; 25/25 competing writers refused; 107 archive generations; 2,577 authenticated events inspected; no reopen failures**. This is process/fault evidence, not a new real OOM or power-loss/container test.

## Remaining risks and release prerequisites

1. Claude must independently verify this exact RC4 ZIP and targeted diff before release authorization. This report is implementation-owner evidence, not independent production approval.
2. Tests here used Node 24.22.1. Docker/Podman and Node 22 Alpine were unavailable; no RC4 real Discord, production database, actual container recreation, physical OOM/power-cut or browser visual pass is claimed. Claude's supplied RC3 Node 22/stand-in-container results are historical RC3 evidence, not silently promoted to RC4 results. Build/test the exact Node 22 Alpine image and real host/staging flows before production.
3. Existing invalid signed history is refused, not auto-repaired or rolled back. Do not discard later revocations. Recovery needs a separately reviewed case-specific plan if the RC3 attack was previously run against a real installation.
4. Legacy lock migration still depends on truthful operator confirmation that old RC2 writers are stopped; no kernel lock can prove ownership against old code that never acquired it. Read-only inspection no longer bypasses that requirement.
5. RC3's documented full-filesystem/key-holder/coherent-rollback limitations, capacity/retention limits, host ownership/mount requirements and external trust-anchor boundary are unchanged. HF4-06 remains Low by explicit approval.

**Handoff: RC4 candidate, complete diff/inventory, reproducible build evidence, tests and original reproductions are provided. No deployment/push/merge or production-data operation was performed.**
