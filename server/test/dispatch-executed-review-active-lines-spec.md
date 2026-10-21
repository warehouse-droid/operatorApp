# Current source lines in executed-order reviews

Spec approval: not obtained (autonomous run). Tier 2: a scoped internal query correction, preserving existing API shapes and execution policy.

The SOA09413 alert observed on 2026-09-28 compared three saved active lines with eight mirror rows. Five rows had already been made inactive on 2026-09-27. Their quantities total 63.675 and their weight totals 3972.41 lb, exactly the false additions in the alert. The latest retained webhook reports a source modification on 2026-09-27 at 18:36 UTC.

## Acceptance criteria

1. A grouped executed SO containing the three current SOA09413 lines (quantity total 1426.64, weight 50321.73) generates no review when its mirror also retains the five inactive historical rows. No new review ledger row is inserted.
2. Explicit current-source lookup excludes inactive rows even when historical search and fulfilled-order lookup are enabled. The default historical lookup retains its existing inactive cargo behavior.
3. After a real active line addition, quantity edit, or removal, the review reports that change. Previously inactive rows never appear as new additions. Repeating the read retains the same review token.
4. Stored false observations from the old eight-line source digest stop appearing when the current three-line digest is used; their audit records are preserved, including an existing acknowledgement. The same rule applies to pending observations.
5. Real pending/acknowledged reviews, completed-order lookup, nonblocking planning saves, source reconciliation, route protection, edit leases, and recorded driver/photo data retain existing behavior.

## Setup and verification

Use existing Docker images, Node, PostgreSQL, fast-check, c8, ESLint and TypeScript; no new dependencies. Capture the two production files before editing; preserve all unrelated workspace edits. Add a focused regression suite, reproducible checks and an evidence report. Run a failing regression before implementation, the existing source-review and fulfilled-SO suites, static baseline comparisons, changed-line coverage and targeted mutation tests in disposable internal test databases. Reproduce the live order through explicit read-only queries. No production database repair, acknowledgement, or deployment is part of this local correction.

Risks: accidentally retaining inactive lines (exact incident and lookup tests); hiding genuine changes (addition/removal/quantity tests); losing historical cargo (fulfilled-order regression); deleting evidence (ledger/source/driver equality assertions). Concurrency and authorization are unchanged and remain covered by the existing review suite.

## User clarification: notices and re-plan requests

The user confirmed that notices must not hold up source processing or valid planning saves, and that a genuine source update to a planned order should request re-planning. Treat this as a request for the dispatcher to review remaining work; do not automatically rearrange the route. This extends the review to planned physical stops before driver execution starts.

6. An actual source change to an assigned order with no driver activity produces a persistent, nonblocking re-plan notice. An unassigned pool order produces none. Groups name the affected child and group.
7. A partly executed route requests review of the remaining planned work; a fully executed order remains an informational source-review notice. The save comparison still protects only executed work and permits valid updates to future work.
8. A source-refresh event refreshes the notices without waiting for acknowledgement. The UI says re-plan requested where appropriate, keeps saving available, and records acknowledgement as review, without claiming that a route was replanned.

## Deployment authorization — 28 September 2026

The user explicitly requested deployment after reviewing the local outcome. Publish the four verified runtime files over the current application image, retaining the newer unrelated release already running. The webhook worker continues its existing source processing; the notice lookup, saved-plan comparison and browser display are served by the app. No schema migration is required.

Release acceptance: run the focused integration, property and browser checks against the captured candidate runtime; verify configuration and file hashes after cutover; verify local/public health and the served Dispatch asset; replay SOA09413 in a read-only transaction. Retain the exact previous image for rollback if cutover verification fails.

## User clarification: weight does not require review

The user identified SN1400072's calculated weight rounding (77531.9376 to 77531.938 lb) and explicitly requested that weight updates require neither review nor re-planning. This applies to all weight-only changes, not merely small rounding differences. Continue the authorized release correction and deploy it after verification.

9. Weight-only source changes generate no dispatcher notice for planned, partly executed or fully executed work. Source weight values still process, and executed-work reconciliation continues to protect recorded work.
10. Existing weight-only notices disappear without deletion or automatic acknowledgement. Genuine item, quantity and location differences remain reviewable, with weight omitted from their displayed changes.
11. A later weight-only update does not replace a genuine pending notice or reset its acknowledgement. Existing mixed weight/cargo notices remain compatible. A later genuine cargo change creates a new review.

Use the existing isolated database, property, browser and static tools; no new dependencies or schema changes. Preserve unrelated work and releases. Verify the real incident through read-only queries, including the existing stored observation.
