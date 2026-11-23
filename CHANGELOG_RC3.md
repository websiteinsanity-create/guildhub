# 1.46.2-hotfix.5 RC3

- Production Docker/Compose now enable NODE_ENV=production, explicit Ledger path and the intended persistent mapping; image installs the kernel-lock CLI. Startup validates ownership, permissions, absolute paths and storage before traffic.
- Replace presence locks with retained-descriptor Linux flock. Process death releases ownership automatically. Permanent lock files are never deleted/age-stolen; legacy RC2 crash locks require explicit stopped-RC2 migration acknowledgement.
- Routine policy deltas replace repeated full snapshots. Authenticated state checkpoints and compressed immutable history bound active replay; warnings expose storage budget and actual filesystem pressure.
- Missing established bindings fail closed, including old-Ledger rollback. A signed independent enrollment record prevents resurrection through old initialization intent. Offline binding recovery requires an independently retained trusted checkpoint.
- Two-phase import intent/commit reconciles against the installed database digest on restart. Failed restores preserve current valid member ownership; conservative invitation invalidation remains.
- Durable initialization intent resumes interrupted RC3 bootstrap. Reviewed key-only RC2 recovery never resets the key or bypasses completed state.
- Correct obsolete Ledger docs and align package/lockfile versions. Preserve all existing security tests and approved authorization policies; add crash, corruption, compaction, rollback, production-startup and failed-import regressions.
- No production actions, bridge/voice/attendance redesign or unrelated application change. Independent Claude review and external Node 22 Alpine/real-container/Discord staging remain required.
