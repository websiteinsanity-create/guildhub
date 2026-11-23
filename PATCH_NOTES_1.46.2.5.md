# GuildHub 1.46.2-hotfix.5 — release candidate

Based only on verified hotfix.4, ZIP SHA-256 `335d37417c573e50a65d560644a691d0d7d0975fe302b85927b9d548e6aeaafe`. This candidate is for Claude's independent audit, not authorized for production deployment.

## Security fixes

- SEC-01: live coach permissions require membership or an explicit B04 guest-coach grant. Departed ordinary coaches cannot use any VOD operation through stale sessions or reauthentication. Coaching links remain stored but grant no rights while authorization is absent.
- SEC-02: exports/imports preserve all supported database collections/maps, including VODs, annotations, coaches, Gear galleries, ownership, links, skills, potentials and custom catalogs. Legacy raw 1.46.2-family JSON exports and the new version-1 envelope are supported. Unknown future roots/formats, malformed structures and broken supported references are refused before touching live state. Detached migration, a single-writer barrier, reauthorization and an atomic file replacement precede the memory swap. Failed commits leave the existing database intact. JSON import limit is 32,000,000 bytes; media files and signing/revocation files require a full volume backup separately.
- SEC-03: `postedBy` is attribution only. It no longer grants continuing access to somebody else's private VOD after a coach/class authorization change.
- SEC-04: VOD edits validate a detached candidate. Failed requests do not mutate the live record, even if other changes are later saved. Other VOD mutation paths were reviewed and negatively tested.

## Explicitly approved membership decision

The owner chose to withdraw membership after a confirmed Discord departure, including previously accepted applicants. Acceptance alone no longer overrides nonmembership, in live authorization or OAuth. An accepted outsider must join Discord before gaining member content access. Existing accepted accounts already in Discord retain their normal access, including when the configured member role cannot be assigned. B04 guest access remains class-limited and valid without Discord membership. Kicks still override all grants.

Explicit configured officer-user-ID grants remain the existing administrator mechanism and retain officer access to historical content. This is not a redesign of administrator authority or demo/passcode mode.

## Reliability and test fixes

- Serialize asynchronous database flushes; concurrent flush requests share the active writer rather than writing the same temporary path twice.
- Daily Schedule persistence drains newly dirty revisions rather than misclassifying another successful mutation as a disk failure. Initial persistence errors enter the recorded retry path as well.
- Test fixtures request an OS-selected available port instead of guessing an ephemeral port; the API-only fixture uses port zero directly. Test concurrency is bounded to four files. No assertion was dropped to obtain a clean run.
- Only B12's proxy fixture forces an IPv4 client. Other origin-security fixtures retain their original hostname and negative-origin expectations.
- The legacy no-PIN fallback test explicitly starts tracking manually; a separate deterministic test demonstrates that a scheduler failure before a late session start correctly prevents late automatic retry.
- Older acceptance tests now explicitly exercise the owner's new Discord-membership requirement. B04's accepted guest test verifies the outsider state and then explicitly joins Discord before testing member content.

## Ledger compatibility — RC3

RC3 has a functional authenticated persistent Ledger, kernel-backed exclusive locking, verifiable compressed checkpoints and strict production startup validation. Docker/Compose now set NODE_ENV=production and pass the intended persistent directory. See RC3_OPERATIONS.md for migration, capacity, recovery and independent staging gates. Earlier RC1 statements claiming no Ledger are superseded. SEC-01 through SEC-05 remain required.
