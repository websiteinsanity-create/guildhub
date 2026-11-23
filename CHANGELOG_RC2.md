> Historical RC2 document. Superseded for RC3 by RC3_OPERATIONS.md and RC3_LEDGER_DESIGN.md. Do not apply its presence-lock or missing-binding recovery instructions.

# hotfix.5 RC2

- SEC-05: imported invitation hashes can no longer create redeemable guest links; enforce valid bounded invitation lifetime and retain import security audit evidence.
- SEC-06: add independent HMAC-authenticated append-only ledger, fsync/checkpoint protocol, strict permissions, one-writer lock, rollback high-water binding and fail-closed startup/runtime checks.
- Preserve session revocations, global cutoff, guest/invite lifecycle, coaching/administrative/Alliance permissions, support one-time state and ownership/class ACLs across old application backups.
- Add reviewed legacy migration and conservative import reconciliation/quarantine, plus narrow offline recovery tooling.
- Retain SEC-01–04, B04, GH-01, SA-01–11 and the approved membership policy. HF4-06 remains documented.
- Add adversarial durability/migration/import tests; keep all previous security tests; correct fixtures only where the ledger intentionally invalidates stale security state. Fix child-exit cleanup race.
- Harden release packaging to refuse newly introduced runtime/security files. Keep Docker/Compose, frontend and communication behavior unchanged.

Read SECURITY_LEDGER_DESIGN.md, RC2_MIGRATION_AND_RECOVERY.md and RC2_SECURITY_REPORT.md before independent review. No deployment authorization is implied.
