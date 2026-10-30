# BIN workflow and bin re-selection evidence

Scope and acceptance criteria: [BIN order workflow specification](bin-order-workflow-spec.md), including cases 18–25. The release combines the previously implemented workflow with re-selection and stop labels over the captured live application. It does not deploy unrelated workspace changes.

## Behavior verified

- Front Desk creates orders; Planning selects bins, execution routes and loads. Collection includes dump and either yard return or one onward delivery. The three exchange routes retain their prerequisite and physical-bin rules.
- Re-selection preserves order, billing and surviving step identities; updates dependent dates atomically; requires edit leases and current revisions; and locks after a BIN step starts. Only affected released assignments are republished.
- Dispatch and Driver show readable action references and the physical bin for that action. Legacy display aliases preserve frozen stops and offline execution fingerprints.
- The suite covers stale state, authorization, missing leases, injected rollback, concurrent selections, selection versus a real driver start, lost-response retries, changed source routes, unrelated drafts, legacy assignments and browser interactions.

## Verification record

The pre-change baseline passed 302 tests in 70 files. Separate checks passed the populated legacy-schema upgrade, 19 tests against the rollback runtime with the additive schema present, and the planner drag/reorder browser scenario. The latter needed a precise drag target in its fixture; its behavior assertions were retained and passed on both runtimes.

The exact release candidate passed on 2026-10-23 UTC:

| Check | Result |
| --- | --- |
| Full affected regression suite | 75 files, 324 tests passed |
| Reverse-order focused suite | 10 files, 64 tests passed |
| Additional coverage-driven focused suite | 10 files, 65 tests passed, including the added aboard/yard pickup-evidence transition |
| Deliberate mutations | All 5 caught by the expected assertions |
| Generated selection/route cases | 250 selection sequences and 500 route budgets, seed 20261022 |
| Static checks | 32 JavaScript syntax checks; no introduced lint/type errors or secret findings |
| Runtime drift | No changes to the 37 candidate files throughout validation |
| Disposable cleanup | Both container listings, project volumes/networks and live health verified |

Reports: [full validation](../deployments/bin-selection-20261022/validation.json), [additional validation](../deployments/bin-selection-20261022/additional-validation.json), and [combined changed-line coverage](../deployments/bin-selection-20261022/coverage-audit.json). The additional test initially compared an immutable internal visit reference with its display alias; its corrected assertion independently preserves both identities. No runtime change was needed after the full regression run.

Observed changed-line coverage across the two passing runs is 729/740 (98.51%), with no unmeasured changed JavaScript files. Full-run changed-branch coverage is 329/412; the additional focused run reports 334/415. Coverage is not 100%: the remaining lines are the browser's foreign-date lease acquisition, the route fitter's unchanged scheduled-stop path, and two server adapters. The service's cross-date lease/transaction behavior is covered by database integration tests; the browser re-selection scenario uses one date. These are explicit coverage limits, not exclusions or assertions of complete Tier 3 coverage.

Toolchain: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1 and pg 8.21.0.

## Live release

Deployed at **2026-10-23 00:39:56 UTC** as `mbbs-operator-app:bin-selection-20261022`, image `sha256:48e8be19c82ada2002b7e4b3790b99310ecf999da62aed90f4cb037036e4676c`. Only migration `297_bin_order_workflows.sql` was applied. All 37 deployed file hashes match the candidate; application configuration and the database, webhook worker and Ollama services were preserved.

Live health, Planning, Front Desk, Driver and updated static assets returned HTTP 200; the unauthenticated Planning API remained protected with HTTP 401. Both `docker ps` and `docker ps -a` contained only the four production containers after teardown. No test networks, database volumes or BIN test artifact directories remained. The previous live image is retained as `mbbs-operator-app:bin-selection-rollback-20261022`.

Operational records: [deployment](../deployments/bin-selection-20261022/deployment.json), [migration](../deployments/bin-selection-20261022/migration-audit.json), [live verification](../deployments/bin-selection-20261022/live-verification.json), and [cleanup](../deployments/bin-selection-20261022/cleanup-audit.json).

## Method and limits

Tests use the existing Node, Playwright, fast-check, TypeScript, ESLint and c8 tools; no dependencies were added. Static checking covers JavaScript syntax, baseline-aware MBT/browser lint and checked MBT types, and changed-line secret scanning. It is not a whole-repository type check.

Five deliberate mutations check the started-work guard, stale asset revision, accidental publication of unrelated drafts, duplicate pickup for an aboard bin, and route overrun. Pure properties cover pickup identity and route budgets; database guards depend on integration tests. Changed-line coverage is reported separately from the application's global coverage threshold, with gaps disclosed rather than claimed as covered. Route-gateway responses are injected in isolated tests; no paid live route request or synthetic production order is created.

Every run uses `mbbs-tests.slice` and the standard memory, CPU, PID and tmpfs limits. The retention wrapper removes temporary logs, browser coverage, mutated source copies and test artifacts. Compose teardown removes containers, disposable databases and networks and checks both Docker container listings and production health. Operational release and rollback records remain available.
