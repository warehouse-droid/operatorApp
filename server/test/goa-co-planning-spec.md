# GOA CO route and planning fixes

User request, 1 October 2026. Focus: the first two reported issues.
Spec approval: not obtained (autonomous run).
Tier 3: saved Dispatch plans and order dependency interpretation.

## Acceptance criteria

1. CO-GOA-9611-9612 uses its stored route, 2967 to 3445, even when
   its source sales-order children now pick up at 3445. Rental decoration,
   catalog hydration and browser normalization preserve this CO route.
2. A CO and a group of COs carry only their own CO planning identities.
   Informational source SO/TO children do not become assigned deliveries.
3. A CO with an unplanned replenishment TO can be placed and saved before
   that TO. Its source delivery still requires the TO to be planned earlier
   or sequenced before its pickup. Direct pickup delivery checks survive.
4. Saving or refreshing the CO does not retarget the dependency or mark its
   source group/SOs as planned. CO cargo and source item quantities survive.
5. Both CO-first and delivery-first order-array ordering produce the same
   validation result; multiple delivery assignments retain their checks.
6. Ordinary SO groups, SOR rental pickup routing, TOs, aggregate CO groups,
   lifecycle/cargo checks, leases and execution protections keep their behavior.

## Failure model and checks

- Route overwritten by informational children: pure projector properties,
  real PostgreSQL feed/catalog tests, actual Chromium normalization.
- False delivery identity or missed real delivery: alias properties, mixed
  CO/delivery plan ordering, real dependency validation and synchronization.
- Accidental quantities or operational data changes: immutable fixture and
  read-only live probes; no production data repair or planning operation.
- Partial deployment or unrelated concurrent edits: capture current image,
  apply only scoped diff, verify source hashes and retain rollback image.

## Setup and verification

Use existing Docker Node/Chromium, PostgreSQL, Node tests, fast-check, c8,
ESLint and TypeScript. No new dependencies, migrations or commits.
Preserve existing dirty-worktree changes. Add focused frontend, property and
database tests, a reproducible test/check entry point and evidence report.
Record RED assertions before implementation. Compare full tests, types and
lint against an unchanged baseline, run focused tests in both orders, measure
changed-line coverage, kill at least three realistic manual mutants, and run
the real feed and browser with realistic CO input. Deploy the scoped patch
over the latest verified live image and verify the requested order read-only.
The user has released TOB01180 and requested focus on issues one and two;
dependency deletion is outside this implementation scope.

Verification setup amendment: the existing E2E image stores its pinned Chromium
under `/ms-playwright`. Correct the test runner's browser path and bound each
full-suite child process to 90 seconds, recording timeouts as failures. The
initial comparison attempts stalled after browser startup failed before fixture
cleanup; preserve their logs and restart both comparisons under the same setup.
