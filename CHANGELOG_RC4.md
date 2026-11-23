# hotfix.5 RC4 — targeted security corrections

- RC3-01: reject non-Discord/inherited kick targets before mutation; use prototype-free account maps and validate officer identifiers before role/user updates.
- RC3-01: use own numeric/hash map entries, validate events and resulting state before any signing/compaction/write, protect standalone revocations and mirrors, and reject invalid historical semantics during inspection.
- RC3-02: inspection acquires an existing modern lock read-only; legacy conversion requires explicit --unlock plus both all-writers-stopped and RC2-stopped acknowledgements. Active kernel locks remain exclusive.
- Add prototype/malformed-input, state/file atomicity, valid-history replay/compaction and inspection/migration regressions. Preserve all prior security tests. Correct the independently reproduced stale-response PIN test assertion only; production attendance is unchanged.
- Align release metadata and document targeted recovery behavior. No schema/storage-format/crypto/deployment/UI/communication redesign. Already-invalid history is not reset or rewritten.
- Candidate only: independent Claude verification and staging prerequisites remain mandatory.
