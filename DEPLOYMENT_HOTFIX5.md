# GuildHub hotfix.5 — current deployment guidance (RC3)

RC3 implements a persistent Security Ledger. Production requires explicit GUILDHUB_LEDGER_DIR=/app/security-ledger and NODE_ENV=production; the shipped Dockerfile/Compose now activate this behavior. The existing intended host mount is /opt/persistent_volume/data/GUILDHUB_LEDGER:/app/security-ledger. No live stack has been changed.

Follow [RC3_OPERATIONS.md](RC3_OPERATIONS.md) for mount/UID/0700/0600 checks, reviewed first bootstrap, RC2 lock migration, kernel crash recovery, compaction, binding restoration, imports and staging prerequisites. Read [RC3_LEDGER_DESIGN.md](RC3_LEDGER_DESIGN.md) for the trust model. A directory or environment variable alone is not evidence of persistence.

Older RC1 statements that this variable only emits an unsupported-feature warning are obsolete. RC2 runbooks are historical and superseded. Do not run RC2/RC1 against migrated RC3 state or use hotfix.4's lossy importer for rollback.
