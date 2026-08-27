# Operator Linked Quantity and Completion Fulfillment — Evidence

Date: 2026-08-26 UTC

Specification status: approved Tier 3. The implementation gauntlet performed no
deployment or live NetSuite operation. Production deployment was subsequently
authorized explicitly on 2026-08-26. All four completion-driven Sales Order
Item Fulfillment gates remain default-off after deployment.

## Outcome

- Operator Delivery Prep now projects the physical MBBS-yard residual as the
  Dispatch target minus active Link PO quantity minus active
  `direct_to_customer` Link TO quantity. Yard-replenishment TOs are not
  subtracted.
- Every line retains original, PO-linked, direct-TO-linked, combined-linked,
  and Operator-required quantities. A fully direct line remains visible as
  audit evidence but cannot be confirmed as yard-loaded. Over-allocation fails
  closed.
- Delivery Prep records only the residual local loading evidence and cannot
  create a Delivery SO Item Fulfillment, even if the older Operator Delivery
  Prep posting cell is enabled. Customer Pickup SO and native TO behavior is
  unchanged.
- Accepted Driver customer-drop completion, or an audited Dispatch manual
  completion, creates one immutable candidate for each real Sales Order child.
  Its frozen snapshot conserves Operator residual plus completed PO/direct-TO
  evidence against the exact Dispatch target.
- Split quantities post against the positive NetSuite parent and exact line;
  grouped children remain independent by real SO. Active line claims serialize
  concurrent candidates.
- Live NetSuite status and line drift are checked immediately before posting.
  Closed, changed, ambiguous, or otherwise unsafe work enters visible Admin
  attention with reasoned recovery choices instead of being retried blindly.
- Deterministic external IDs, renewable leases, read-before-create recovery,
  verification, immutable attempts, and atomic finalization provide exactly-once
  behavior across duplicate events, worker races, restarts, and uncertain
  responses.
- Yard gates are independent for 3445, 2967, 12441, and 150. Enabling a gate
  records an activation watermark so old completions do not post automatically;
  Admin can explicitly preview and queue selected historical work.

## RED and fault proof

The executable contract first isolated the unsafe boundaries: linked quantities
remaining in Operator work, yard replenishment being misclassified as direct,
over-allocation clamping, Delivery SO admission at Operator load, duplicate PO
or TO identities, mixed/already-fulfilled live lines, skipped external-ID
recovery, stale leases, gate-off claims, pre-watermark backlog, wrong direct-TO
drop evidence, and accidental TO transforms. The persisted mutation runner
independently inverted each of these critical guards and the tests killed every
mutant.

## Verification evidence

- Fresh isolated PostgreSQL migrations 001 through 180 applied successfully.
- The focused executable contract passed twice on the fresh database: 44/44 on
  each run, including repository, HTTP, UI contract, property, and wiring tests.
- Property testing exercised 2,000 generated conservation/over-allocation cases.
- The adjacent Operator NetSuite posting suite passed 60/60 and the Order
  Dependency harness passed, preserving Customer Pickup, PO/TO, grouping,
  splitting, Link PO, Link TO, and direct-ship ownership boundaries.
- The decisive full Node regression passed 2,010 tests in 405 files. One
  pre-existing migration-v4 case remained explicitly skipped.
- The full browser regression passed 480/480 across desktop Chromium, mobile
  Chromium, and mobile WebKit, including Dispatch restore, Operator workflows,
  Driver online/offline and iPhone cache/viewport behavior, Admin gates, and
  related SCM/Sales screens.
- Focused changed-policy coverage passed at 91.67% statements/lines, 100%
  functions, and 77.58% branches, above the persisted 90/90/90/75 thresholds.
- Persisted mutation testing killed 22/22 non-equivalent critical mutants
  (100%) and verified that all mutated sources were restored.
- Strict TypeScript, zero-warning focused ESLint, and legacy public JavaScript
  syntax checks passed.
- Production dependency inspection completed without adding a dependency.
  License policy passed 396 packages; the existing documented
  `buffers@0.1.1` metadata exception remains unchanged.
- Focused secret scanning, fixed-file source hashing, and `git diff --check`
  passed on the final evidence-bearing source.

## Release boundary

The worker tests use a deterministic fake NetSuite adapter. Before any yard gate
is enabled, an allowlisted NetSuite sandbox must prove create, external-ID
lookup, and verification for a representative split, group child, residual plus
direct PO, and residual plus direct TO completion. Deployment does not authorize
gate activation; that production NetSuite proof remains outstanding.

## Production deployment record

- Explicit deployment authorization: 2026-08-26 UTC.
- Branch and repository base: `codex/dockerVer` at
  `8ed7d9b80dd02e5331dfda35b092fbfa4e0c2d6c`; the already accepted dirty
  worktree was deployed without committing or discarding unrelated changes.
- Prior running image:
  `sha256:8eb739016b10fa545caa82cde21ade3955b2b4dbab869369a64adc7e3133d2dd`.
- Deployed image:
  `sha256:4b56879412b91bf2bf5ce73f45909e89678e9be16f54e761f938e184ba09ee7a`.
- The 21 GB live database was not subjected to a high-load full dump because
  migration 180 is additive and does not rewrite or delete existing records.
  The prior application image ID was recorded before cutover, but Docker removed
  that untagged image when the old container was recreated. Immediate image
  rollback is therefore unavailable; the additive schema remains backward
  compatible, and the deployed image passed every post-cutover check.
- Migration 180 applied in 1.7 seconds while the prior application stayed
  healthy. Its post-migration state was four gates present, four disabled,
  zero enabled, zero activation watermarks, zero candidates, and zero backfill
  execution events.
- The generic initial-Phase-3 readiness command reported no missing migration
  and no Dispatch collision, but remained `ready: false` solely because seven
  established MBT production modules were already enabled. Those live modules
  were intentionally not disabled. The deployment-specific migration, gate,
  trigger, and empty-queue checks passed.
- App-only force-recreate plus Docker health wait completed in 7.4 seconds.
  The application, PostgreSQL, and Ollama containers were healthy afterward;
  the application had zero restarts and sampled at 0.90% CPU and 134.1 MiB.
- `/health` returned 200; Admin, Operator, Dispatch, Driver, and MBT Gates pages
  returned 200; the unauthenticated fulfillment Admin API returned the expected
  401. Startup logs contained no migration, runtime, or worker error.
- Driver client version remained `2026.08.12.3`, offline mode remained disabled,
  and no Driver PWA version bump was introduced.
- Final production state remained four gates disabled, zero activation
  watermarks, zero candidates, and therefore zero NetSuite fulfillment work.
