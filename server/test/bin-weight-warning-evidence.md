# Advisory truck weight warnings in MBT Planning

Specification: [bin-weight-warning-spec.md](bin-weight-warning-spec.md).
The user explicitly replaced the previous truck-weight block with a soft warning.
Spec approval: not obtained (autonomous run); the requested behavior is explicit
in the user instruction. This is a scoped Tier 3 change to a planning API and
its confirmation checks. No dependencies, migrations or Git commits were added.

Read-only diagnosis found SOB123353 (trip
`496035cd-45af-4efe-9088-8754920d5506`) weighs 17,350 lb. BINTEST is configured
for 48,000 lb. Its existing Load 2 collection BIN00002X-1C has unknown cargo
weight, so the whole-plan checker estimates the bin's payload limit at about
60,000 lb. That existing load blocked saving a lighter Load 4. The trip remained
ready and unassigned in the database; no browser draft was saved on the user's
behalf.

Failure model: a partial implementation could remove one weight check but still
block assignment or confirmation, lose the warning after reload, mislabel an
estimate as measured weight, sum sequential trips instead of simultaneous cargo,
or accidentally remove physical-slot/custody/route protections. Real database,
browser, unit/property, adversarial and existing confirmation tests address these
paths. No new external, filesystem, subprocess, credential or dependency
capability was added to application code.

The behavioral RED run failed in five places: the old hard-capacity unit and
property expectations, transport assignment's SQL truck-weight predicate, the
unknown collection's whole-route check, and real-browser drag/save. Seventeen
tests ran; twelve unrelated assertions passed. After the implementation, all
17 focused tests passed including real browser save, confirm and reload. Static
checks then identified shadowed loop names and helper complexity. The helpers
were split without changing assertions; the final affected run follows that
refactor. The first broader run passed 447/448 tests; its one failure was the old cargo-routing assertion that truck overweight must reject assignment. That assertion was explicitly updated to the user-authorized warning behavior, retaining the bin-payload rejection and verifying assignment plus exact warning weights. The superseded run was stopped and fully cleaned before fresh verification.

| Specification clause | Verification |
| --- | --- |
| Overweight assignment, save, confirmation and descriptive warnings | `bin-weight-warning.test.js` and real Chromium `bin-weight-warning-browser.test.js` |
| Unknown collection estimate explicitly labelled | Loaded-collection integration fixture in `bin-weight-warning.test.js` |
| Reload retains warnings | Integration read and browser reload assertions; read-warning deletion mutant |
| Correctable invalid route remains readable | Integration test modifies a fixture action, verifies write validation still rejects, then reads the planning screen |
| Peak simultaneous weight and physical slots | Existing `bin-planning-domain.test.js` and 1,000 generated capacity cases in `bin-planning-properties.test.js` |
| Existing custody, reservation, sequence, source, bin payload and Driver protections | Entire affected BIN planning/transport/Driver, aggregate-routing and Dispatch weight regression selection; concurrency/adversarial suites included |
| Removing/moving visits filters stale warning context | Load/visit filter in the UI adapter; existing removal regressions. Real browser assertions now remove the linked route, save, reload and check that the old warning is absent; a visit-filter mutant checks this guard. |
| Customer data and Driver history preserved | Tests use disposable data only; production release has no migration or order-writing step |

Reproduce the full affected verification from the repository root:

```sh
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-weight-warning-20261024/candidate" \
  bash docker/run-bin-weight-warning-checks.sh
```

The persisted entry point checks syntax, lint/complexity, types and changed-line
secrets; runs all affected tests with coverage and in reverse order; repeats the
browser scenario three times; runs seven deliberate faults (three repeated against
properties alone); and requires complete changed executable-line coverage.
Tool versions and source hashes are captured in the operational validation record.
All test processes use the standard bounded disposable runner and registered
teardown. The runner removes test containers, database volumes, networks, coverage,
logs, browser artifacts and temporary mutant source copies, and verifies both
Docker container listings and live health.

Scope limits: this is the affected regression suite, not the full unrelated
application corpus. Browser fixtures model cargo and routes; they do not represent
physical Driver evidence. Weight warnings remain advisory planning information.
The separate bin payload limit, positive/finite cargo checks and physical bin-slot
limit retain their existing enforcement. No dependency audit is needed because
package manifests and lockfiles are unchanged. No performance budget was specified;
this change adds read-only capacity queries to the planning feed and has no timing
benchmark. Source hashes identify the release because the shared workspace has
unrelated uncommitted work.

Deployment-copy retention completed at `2026-10-24T03:57:03.669427+00:00`.
The reviewed obsolete sixth copy was pruned with production unchanged and healthy.
Six operational records were archived first at
`/home/ubuntu/storage-cleanup/retention-audit/20261024T035531-gob122647-sales-pickup-records-audit.json`.
The applied manifest is `20261024T035702225708Z-plan.json`; the current release,
its immediate baseline and rollback copies are retained.

A later full run passed 448/448 in normal order. Reverse order crossed Toronto
midnight and passed 447/448: `bin-transport-offline.test.js` failed with
`MBT_DRIVER_BIN_ASSET_TIME_CONFLICT`. Its generic fixture records registration at
06:00 UTC on the plan date, later than the real-time event immediately after
midnight. A separate disposable run against the unchanged live baseline reproduced
the same failure at 04:07 UTC, establishing that this was a pre-existing fixture
clock defect. The offline test now records the same past synthetic clock baseline
already used by the existing Driver offline fixture, before planning and issuing
the manifest. All event, chronology, evidence and replay assertions remain intact;
no Driver implementation was changed. The failed release-gate metadata is retained
as `validation-midnight-audit.json`; its disposable data and logs were removed.

## Final fresh verification

Completed `2026-10-24T04:25:34.923Z` after the last application and test-fixture edits.
Source drift: 0. All results below come from that single run.

| Layer | Result |
| --- | --- |
| Entire affected suite, 112 files | 448/448 passed, no skips |
| Entire suite in reverse order | 448/448 passed, no skips |
| Real-browser repetitions | 3/3 passed |
| Static checks | 7 JavaScript files; 0 new lint/complexity/type errors; 0 secret findings |
| Deliberate faults | 7/7 killed |
| Weight faults against properties alone | 3/3 killed |
| Changed executable lines | 89/89 (100%); no unmeasured files |
| Branches on changed lines | 58/67 (86.57%) |

Branch coverage is measured, not exhaustive. Optional metadata/default branches
are not all exercised; the warning bounds, preserved physical-slot rejection,
transport assignment, confirmation, persistence and removal have direct assertions
and deliberate-fault checks. The capacity property runs 1,000 cases with seed
9272027 and verifies peak simultaneous cargo rather than a daily sum.

Runtime source-tree SHA-256:
`1b21c05011d552265ad100971fd4a03806bd842672837aeb0dd7c6fc67cf8e34`.
Tools: node v20.20.2, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0, playwright 1.62.1, pg 8.21.0.
The persisted audit is `deployments/bin-weight-warning-20261024/validation-audit.json`.

Registered teardown completed successfully. The runner checked running and all
container lists and live health, and removed its disposable databases, containers,
networks, coverage, browser output, mutant copies and logs.

## Deployment and public verification

Deployed `2026-10-24T04:26:16Z` as `mbbs-operator-app:bin-weight-warning-20261024`
(`sha256:9dd2aa832462f06a70377d85b8bb7b4e06753f52297ddc985919b2413e725173`). All eight runtime hashes match the tested candidate;
application configuration and the other services were preserved. No schema
migration was required.

At `2026-10-24T04:26:53.621305+00:00`, public health and MBT Planning returned 200, and the
public HTML plus both changed JavaScript assets matched the candidate exactly.
The unauthenticated planning API returned 401. BINTEST remains configured at
48,000 lb; the 14YD payload remains
27,215 kg. The reported 17,350 lb trip is still
ready and unassigned in persistent storage; no customer plan was written by this
release. The user can retry their pending Save against the new advisory policy.

Both running/all-container lists contain exactly the four application services.
Disposable containers, volumes, networks and test-artifact runs are all zero.
The reproducible read-only release check is
`python3 server/tools/bin-weight-warning-verify.py` from the repository root.
Its operational record is `public-cleanup-audit.json` in the release directory.
