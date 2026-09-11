# Driver live-route prefix lock verification evidence

Date: 2026-09-10 UTC

## Outcome

The Driver live-route prefix protection passed its complete focused gauntlet and
all affected normal, shuffled, replay, offline, reconciliation, photo-evidence,
and concurrency scenarios. No deployment or production mutation was performed.

The executable behavior is defined in
`driver-live-route-prefix-lock-spec.md`.

## Focused gauntlet

Command:

```text
bash server/tools/driver-live-route-prefix-lock-gauntlet.sh
```

Final result:

- 22/22 focused unit, property, adversarial, integration, and concurrency tests
  passed.
- `driver-route-cursor.js` coverage is 100% statements, 100% functions, 100%
  lines, and 91.13% branches.
- Strict ESLint passed for the policy, every shared repository writer, the
  Driver projection, tests, and replay.
- The BL42349 replay rejected deletion of the empty and populated predecessor
  loads with `DISPATCH_ROUTE_PREFIX_LOCKED`, kept Driver job `3022191978`
  active, advanced to `future-stop` only after completion, and fabricated no
  completion evidence for skipped work.
- 12/12 persisted mutants were killed, including bypasses through automated
  reconciliation, stale completed boundaries, active Driver work, and offline
  first-gap fallback.

## Complete repository suites

### Isolated Node suite

All 450 test files were exercised. 446 files passed and four current-worktree
contract checks failed:

1. `p3-gauntlet-contract.test.js` reports two existing mutation runners that
   are not registered in the P3 manifest:
   `run-schedule-column-mutations.mjs` and
   `run-scm-ir-split-reference-mutations.mjs`.
2. `delivery-instruction-contract.test.js` still expects an older Dispatch
   asset cache token than the current pending Dispatch bundle.
3. `migration-upgrade.test.js` expects migration 195 while pending migration
   196 exists.
4. `p3-predeploy-readiness.test.js` has not yet added pending migration 196 to
   its inventory.

Every route-prefix, reconciliation, Driver photo, offline, BIN lifecycle, and
race test passed. The normal predeploy-readiness and local-pilot integration
tests also passed; only the separate P3 inventory contract above is stale.

### Shuffled isolation

Each configured deterministic seed exercised all 450 files in a different
order, for 1,350 file executions in total:

- `2026080301`: only the same four current-worktree contract failures.
- `2026080337`: only the same four current-worktree contract failures.
- `2026080399`: only the same four current-worktree contract failures.

The focused route-prefix unit, property, adversarial, integration, concurrency,
and wiring tests passed in every shuffled placement. No new order-dependent
failure appeared.

### Legacy baseline harnesses

All 134 configured harnesses were exercised. 130 passed. Four unrelated UI
harnesses contain stale asset cache-token assertions:

- `test:scm-reconciliation-ui`
- `test:operator-camera-schedule`
- `test:scm-weight-schedule`
- `test:dispatch-driver-order`

All affected reconciliation integrations, Driver schedule/offline harnesses,
and Dispatch load-assignment harnesses passed.

### Playwright browser matrix

The complete 501-case desktop Chromium, mobile Chromium, and mobile WebKit
matrix was exercised. The first pass was 496/501. Isolated rebuilt reruns then
cleared three failures:

- completed-stop photo append and retained-draft revalidation: 1/1 passed on
  desktop Chromium;
- BIN accessible asset selection after rerender: 1/1 passed on mobile
  Chromium;
- Driver PWA cache repair: 3/3 passed on mobile WebKit after updating its stale
  expected shell/token to v41 and `20260910-route-prefix-cursor-v1`.

Two outstanding failures are both in the separate
`dispatch-active-co-manifest-pickup.spec.js` case:

- mobile Chromium cannot click the load title because the order-pool panel
  overlays and intercepts the pointer;
- mobile WebKit calls Chromium-only `page.coverage.startJSCoverage`, where
  `page.coverage` is unavailable.

The desktop variant of that case passed. Neither failure exercises the Driver
route-prefix implementation, but both remain release-suite failures and should
be resolved before a later deployment.

## Static and security checks

- Legacy public-asset syntax check passed.
- Focused strict lint passed.
- Secret scan passed across 28 new/changed route-lock paths with no
  high-confidence findings.
- `git diff --check` passed.
- Full-repository lint still reports only existing unrelated issues in
  `sales-order-reattempt-correction.spec.js` (four browser-global diagnostics)
  and `application-workload-gauntlet.mjs` (eight `curly` diagnostics).
- Full-repository TypeScript checking still reports only existing unrelated
  pending-work errors in `dispatch-actual-arrival-policy.js`,
  `dispatch-actual-arrival-repository.js`,
  `dispatch-actual-arrival-service.js`,
  `check-dispatch-derived-order-freshness-coverage.mjs`, and
  `run-dispatch-repeat-pickup-mutations.mjs`.

## Environment boundary

Testing used only the isolated `mbt_test` Docker network and disposable
PostgreSQL instances/clones. The production stack, production database, and
deployment images were not changed.

## Subsequent whole-worktree deployment — 2026-09-11

The environment boundary above describes the earlier test-only run. The user
subsequently authorized whole-worktree deployment and a commit after successful
production post-checks. The previously outstanding browser and legacy cache
contracts were resolved; the final runtime passed the full 2,258-test MBT run,
134 legacy harnesses, and all 501 configured browser cases with the exact
missing-input replay aggregation documented in the release report.

A fresh focused run passed all 22 route-prefix tests, including the Mike
BL42349 replay. The tested route-prefix implementation is now deployed to
both app and worker. Public/direct-app post-checks passed, Driver assets match
the release, driver-oriented planning is enabled, and the Dispatch assignment
projection remains ready. No live driver's job was changed to perform these
checks. See [the whole-worktree release evidence](whole-worktree-deployment-20260911-evidence.md)
for the source/image identity, short cutover measurement, and operational limits.
