# PO split search and refresh recovery

Requested 2026-10-29 after POB04160 was missing and search/loading were slow.
Spec approval: not obtained (autonomous run under the user's instruction to fix).
Tier 3 applies to refresh-worker concurrency. No dependencies or commits planned.

Acceptance:

1. An abandoned running refresh older than five minutes is claimable again;
   recent and actively locked refreshes cannot be stolen.
2. Every claim has a distinct token. Superseded workers cannot execute a refresh
   or complete/fail another worker's claim.
3. Refresh writes and completion commit together. A failed callback rolls back
   catalog changes. An update arriving during execution is refreshed afterward.
4. Searching one PO does not calculate linked delivery progress or planning for
   unrelated POs. Both exact and partial searches preserve aliases, filters,
   pagination, current statuses, restricted visibility, and split locks.
5. Search and initial 200-card loading each finish in under 1,000 ms on the live
   dataset. Measure repeated reads and compare candidate results against the
   original implementation in one consistent read-only snapshot. Timing includes
   repository status hydration; browser/network time is reported separately if
   available. No TTL cache or stale-response shortcut is introduced.

Failure model: abandoned claim (age recovery test), duplicate execution (row-lock
race), stale worker writes (token test), lost refresh (enqueue race), partial
publication (rollback test), missing/misclassified results (baseline parity and
existing status/direct-shipping suites), unbounded work (query-plan test and
production timing). Test data and all generated output remain in the bounded
disposable Compose environment with unconditional cleanup.

Setup uses installed Node, PostgreSQL, c8, ESLint, TypeScript, and fast-check.
Persist focused tests, a reproducible check runner, and concise evidence. Preserve
the current live image and apply only this task's patch when preparing a release.

Adversarial refinement: malformed numeric Driver references must not be coerced
into matching string order identifiers. A numeric reference leaves the PO at
Direct ship; a genuine string reference can establish In Transit. Also compare
all catalog pages and the PO/TO schedule, beyond the first-page latency sample.
The same repeated sub-second server budget also applies to a POB04160 schedule
search and the default PO/TO schedule load. Completed-order pruning may only skip
work for views that already exclude authoritative Completed rows; explicit
searches, completed views, and status projections must retain those rows.
