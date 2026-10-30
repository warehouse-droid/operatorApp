# MBR/Agg transport and projected BIN availability

Specification: [approved behaviors and failure model](mbr-aggregate-planning-spec.md).
The user authorized implementation of the agreed plan. Tier 3 was used because
this change affects permissions, concurrent reservations and source completion.
No dependency was added and no production test order was created.

## Behavior coverage

| Specification | Executable checks |
| --- | --- |
| 1–2: saved returns release a bin for later planning; physical custody stays unchanged; dependent plans cannot be broken | `unit/bin-availability.test.js`, `integration/bin-availability.test.js`, `bin-transport-dependencies.test.js`, `bin-transport-source-routes.test.js`, existing BIN selection/cargo/planning regressions |
| 3: Dispatcher assets/rates, other configuration Admin-only | `unit/dispatch-management-permissions.test.js`, matching integration test, asset/rate import and HTTP suites, Aggregate Routing browser test |
| 4–5: four tabs, stable catalog routing, Front Desk aggregates, hidden ordinary assignments | `aggregate-routing.test.js`, `aggregate-routing-browser.test.js`, `bin-transport-browser.test.js`, `bin-transport-frontdesk.test.js`, `bin-transport-ownership.test.js` |
| 6–7: one source claim, fractional allocations, no synthetic billing, concurrent over-allocation rejected | `bin-transport-trips.test.js`, `bin-transport-ownership.test.js`, `bin-transport-frontdesk.test.js`, `bin-transport-domain.test.js`, transport properties |
| 8–9: toolbar editor, capacity, immutable source windows, route actions, coalescing and linked delivery | `bin-transport-browser.test.js`, `bin-transport-planning.test.js`, `bin-transport-source-routes.test.js`, `bin-transport-linked-delivery.test.js`, existing workflow/cargo/browser suites |
| 10: original refs/BIN/quantities, scans/photos, optional SOR signature, partial completion, replay and frozen history | `bin-transport-driver.test.js`, `bin-transport-offline.test.js`, `bin-transport-fresh-source.test.js`, SOR signature/readiness/lifecycle regressions |
| 11: existing exchange, final collection, numbering, cargo and Front Desk boundaries | all affected BIN workflow, planning, linked delivery, final collection, cargo, driver and customer charge request suites |
| Migration and transaction failure | `bin-transport-migration.test.js`; concurrent allocation, idempotent commands, completion rollback and predecessor rollback assertions |

Test paths above are relative to `test/mbt` unless a shared Dispatch/SOR suite is
named. The suite list is defined by `tools/mbr-aggregate-suites.mjs` and each file
runs against an isolated database. The browser tests start the real application
against disposable fixtures and exercise saving, dragging and persistence.

## Failures found during implementation

Observed RED cases included unavailable projected returns, missing transport
routes and permissions, duplicate Front Desk aggregate cargo selection, source
changes before catalog refresh, linked cargo edits, per-trip timing ignored by
direct assignment, missing transport metadata in downloaded offline manifests,
missing SOR signature prompts, an inactive asset allowed to start a trip, and
delivery/protection fees incorrectly included in physical cargo quantities.
Each was corrected with its behavioral assertion retained. The migration test
reapplies the additive schema inside a disposable transaction and verifies
rollback restores the pre-existing routing override.

Existing negative permission tests now use an unauthorized role because the
approved behavior grants Dispatcher access. Existing browser tests now select
the approved Delivery/Exchange/Collection tab. These policy replacements are
documented in the append-only specification; route, evidence, audit and denial
assertions were retained. Test fixture errors found along the way were corrected
before counting their failures as behavioral evidence.

A reversed run exposed a detached-element error before mouse-down in the existing
linked-delivery browser helper (590 passed, 1 failed). A hover-only adjustment
passed five focused repeats but the next full run exposed the same race between
hover and its separate bounding-box read. The native single-step drag then failed
the unchanged four-stop assertion during the cross-column move.

The final harness keeps the original cross-column mouse path. It awaits the
optimizer save and initial network settling, then captures each visible bounding
box inside an auto-wait assertion using the existing 10-second locator budget.
It does not retry the drag or the route/save assertions. The optimizer's action
order is captured before saving, preserving that original assertion. Application
sources and the built image did not change. Failed-run records are retained as
`browser-detachment-validation-audit.json` and
`browser-bounding-box-validation-audit.json` in the release directory.

The following full run passed 591/591 forward but exposed the same unchecked
bounding-box read in the separate shared-planner browser helper (590/591 in
reverse). That helper now captures its visible source and target inside the
existing auto-wait budgets, without retrying the drag or changing any functional
assertion. Both browser scenarios are now repeated five times in isolation.
This failed run is retained as `shared-planner-browser-validation-audit.json`.

## Reproduction and release isolation

From the repository root, run:

```sh
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/mbr-aggregate-planning-20261023/candidate" \
  bash docker/run-mbr-aggregate-checks.sh
```

Omit `DISPATCH_SOURCE_RUNTIME` to validate the workspace. The existing
`mbbs-dispatch-source-test:latest` image supplies the pinned toolchain; versions
and source hashes are recorded in the validation audit. The command runs static
checks, the affected suite with coverage, the entire suite in reversed order,
five deliberate mutants against both unit/property tests and properties alone,
three additional source-ownership/linked-delivery guard mutants against database
tests, five isolated repetitions of each affected drag browser scenario, and a
changed-line coverage report merged with real Chromium execution.

The candidate is a three-way overlay of the captured live application and this
task's workspace delta. Unrelated dirty files are not included. The release
requires exact source-hash equality with the validated candidate, captures a
rollback image, applies migration 309 transactionally and verifies application
health, source hashes, new assets and unauthorized API access after replacement.
Rollback restores the application image while retaining the additive tables.

Every test run uses `mbbs-tests.slice`, bounded resources and automatic cleanup.
Containers, disposable databases, volumes, networks, logs, temporary source
copies and browser/coverage artifacts are removed. Only concise evidence and
operational release/rollback records are retained.

## Verification limits

The suite covers the affected features and their existing BIN, asset/rate and SOR
regressions; it is not the entire application's unrelated test corpus. Changed
line and branch coverage are measured and reported, not claimed to be exhaustive.
Remaining gaps include some browser edit/cancel/error paths, historical trip
navigation and defensive server error branches. The underlying source ownership,
dependency, custody, quantity and linked-delivery boundaries have database tests.

The tests use disposable database fixtures and real Chromium/HTTP execution.
They do not perform a real road journey, scan physical hardware, upload photos to
production storage or make paid route-provider calls. Existing route/evidence
boundaries are injected where appropriate. Concurrency tests exercise competing
transactions and rollback, not every possible interleaving. The final report
records exact source hashes, tool versions and results from the fresh run.

## Final fresh verification

Completed `2026-10-24T01:35:54.274Z` against the exact built candidate, after the final
browser-helper edit. All seven runner stages exited 0. No tests were skipped,
cancelled or left failing. Runtime source drift: 0 files.

| Layer | Result |
| --- | --- |
| Affected suite, 141 isolated files | 591/591 passed |
| Entire affected suite in reversed order | 591/591 passed |
| Browser stability, five repeats of each drag scenario | 10/10 passed |
| Syntax, delta lint/complexity and strict type checks | 50 JavaScript files; 0 new lint errors; 0 new type errors; 0 baseline type errors |
| Diff secret scan | 0 findings |
| New domain properties | 6 properties × 1,000 cases, seed 231026; passed in both suite orders |
| Five domain mutants against unit/property tests | 5/5 killed |
| Same five mutants against properties alone | 5/5 killed |
| Database source-ownership and linked-delivery guard mutants | 3/3 killed |
| Changed executable JavaScript lines | 1769/1842 (96.04%); no unmeasured JavaScript files |
| Branches on changed lines | 987/1131 (87.27%) |

The coverage gaps are the explicit limits described above, not a claim of
complete path coverage. The scope contains 55 runtime files. Its reproducible
SHA-256 tree identifier is
`d6d6b5c480a49c2f673d4310ae73bec7a8829ed2a01074cecd86d54139253f62`.
The audit preserves every file hash, the seven stage results and durations, and
the measured coverage totals in
`deployments/mbr-aggregate-planning-20261023/validation-audit.json`.

Toolchain: Node v20.20.2, TypeScript 7.0.2,
ESLint 10.8.0, c8 12.0.0, fast-check
4.9.0, Playwright 1.62.1, and pg
8.21.0. These are the existing runner's versions; no dependency
or lockfile changed. No checkpoint commit was made in the unrelated dirty tree.

Teardown completed successfully. Both `docker ps` and `docker ps -a` showed only
the four production containers, and production health passed. Disposable test
databases, containers, networks, coverage output, browser files and logs were
removed by the registered runner cleanup.

## Live release verification

Deployed at `2026-10-24T01:36:49Z` to `https://test.mbbsoperation.com`.
Image: `mbbs-operator-app:mbr-aggregate-20261023`; immutable image ID:
`sha256:097d8788b450c3842c3f25e698f93c93dde4953909dccf4bcb926f23c255ae7a`.
Migration `309_bin_transport_planning.sql` applied successfully in its guarded
transaction. All 55 live runtime hashes matched the validated candidate.
Application configuration and the other three services were preserved.
The rollback image is `mbbs-operator-app:mbr-aggregate-rollback-20261023`.

Local health, MBT Planning, Front Desk, Driver, Assets and Configuration checks
passed. Public health and pages returned 200; the transport and routing APIs
returned 401 without credentials. Three public JavaScript response bodies
matched their candidate hashes exactly. The initial Python urllib health probe
received 403; the release's curl client verified the listed public responses.
No application change was made for that client-specific probe result.

Final cleanup audit at `2026-10-24T01:37:40.790511+00:00` found exactly four running
application containers and no stopped test containers. Disposable containers,
volumes, networks and test artifact runs were all zero. Live verification was
read-only and did not alter customer orders. Concise deployment, migration,
public-site and cleanup audit records are retained in the release directory.

The final host-retention dry run retained the latest five deployment copies and
reported zero deletion actions. Its operational manifest is
`/home/ubuntu/storage-cleanup/retention-audit/20261024T013852859121Z-plan.json`.
