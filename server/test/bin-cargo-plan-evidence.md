# Plan Delivery cargo evidence — 2026-10-23

Deployed at **2026-10-23T15:21:17Z** as
`mbbs-operator-app:bin-cargo-plan-20261023`, image
`sha256:ab380f70ece50e653b1344adbf66c743da1c2e84efdc02567f49c74d2ad96732`.
Application health, all eight deployed file hashes, configuration preservation,
and preservation of the other production services passed verification.
No database migration, dependency, or git commit was added.

Spec: [bin-cargo-routing-spec.md](bin-cargo-routing-spec.md), follow-up criteria
8–11. These supersede the original Details location. Spec approval: not obtained
(autonomous run). Tier 3 covers transactional saves, concurrent edits, exclusive
custom claims, and driver custody; the evidence covers the specified behaviors,
not every possible failure.

| Criterion | Executable evidence |
| --- | --- |
| 8. Cargo selection and one combined save in Plan Delivery; no editor in Details | `mbt/integration/bin-cargo-browser.test.js`, `bin-cargo-plan.test.js` |
| 9. Required Front Desk materials and pickup locations, enforced by browser and API | Cargo browser and plan tests: missing cargo, missing pickup, and No cargo are rejected without partial writes |
| 10. Reopening, assigned-but-unstarted cargo edits, locked workflow fields, optional manual/custom cargo, and immutable started work | Cargo browser, contract, routing, and driver tests; workflow browser regression |
| 11. Current bin-source/return-yard preview, preserved quantities, rollback, stale saves, and replay | `bin-order-workflow-browser.test.js`, cargo browser and plan tests; existing cargo contract tests |
| Existing invariants: purchased material identity, pricing/windows, bin payload, truck capacity, custom exclusivity, and driver custody | Existing cargo domain/property/routing/contract/driver suites and affected bin-selection, window, material, and Dispatch regressions |

Final validation completed **2026-10-23T15:20:48.416Z**, after the last runtime edit.
The built, validated, and deployed source maps match, with no source drift.
Source-map SHA-256:
`87312154ec1ec93b2176035a853027df9e8d6bbe4a08df772175da5208ab3fdd`.

- Affected regression suite: **357 tests across 79 files, 354 passed,
  3 independently reproduced baseline failures, zero new failures**.
- Reverse file-order repeat: **76/76 passed across 10 files**.
- Changed executable JavaScript lines: **121/121 covered**; changed-line branches
  **100/102**. No unmeasured JavaScript files.
- **10/10 manual mutants killed**: swallowed storage failure, skipped combined
  cargo validation, skipped required cargo, missing cargo persistence, purchased
  weight, custom exclusivity, bin custody, custom completion, material weight,
  and pickup/drop ordering. The last two were killed by the property suite alone.
- Static checks: six JavaScript files, zero new lint/type errors, zero baseline
  type errors in this scope, and zero secret findings.
- Real execution: Playwright against the application and disposable PostgreSQL;
  missing-pickup submission, mixed materials, optional custom cargo, assigned
  updates, load failure, failed-save retention/retry, and route previews exercised.
- Transaction tests cover a downstream database-trigger failure and rollback,
  exact retry, concurrent combined saves, and propagation of storage failures.

The three baseline failures are in
`test/dispatch/integration/dispatch-v2-command-flow.red.test.js`:

- DP-05: split → unsplit retires every global split definition
- history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders
- DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries

The baseline stage reran that file against the captured live version: nine
passed and three failed, with unchanged Dispatch sources verified. The gate
accepts only those exact failures in that one file; no test was skipped or removed.

RED observations included the missing mandatory combined-save behavior and
browser previews omitting the empty-bin pickup after changing an exchange to a
different bin, or replacing the collection customer address with the return
yard. These were corrected. An intermediate regression run also caught the new
validation message no longer matching the existing material-pickup contract;
the message was corrected, retaining the assertion. The legacy configured-order
fixture now attaches purchased material after configuration to represent already
configured orders that still need routing. Browser labels/location assertions
changed explicitly for the user's new popup requirement; backend guards remain.

Read-only live verification confirms the cargo editor is in Plan Delivery and
absent from Details. BIN00003D and BIN00004D each expose Gravel, 1 yd³ / 2,600 lb,
and yards 3445, 2967, and 150. BIN00003D still needs its pickup; BIN00004D already
has one saved. Both are editable. Their root order and pricing snapshots remain
unchanged from the preceding release capture. Static cargo JavaScript returns
200, and the unauthenticated cargo API returns 401. Verification did not write
customer orders or cargo routes.

Known limits: the affected suites were run, not every unrelated repository test.
Route-provider responses and simulated browser failures are controlled at the
network boundary; no paid route request or real customer driver completion was
performed. The storage-failure test injects an error at the database query
boundary; normal operations and rollback tests use real PostgreSQL. Two changed
branches remain unexercised. Supply-chain audit was not repeated because package
manifests and lockfiles are unchanged. No new external service integration.

Reproduce from the repository root using the retained candidate and baseline:

```sh
DISPATCH_SOURCE_SKIP_BUILD=1 \
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-cargo-plan-20261023/candidate" \
DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/bin-cargo-plan-20261023/candidate/migrations" \
bash docker/run-bin-cargo-plan-checks.sh
```

Toolchain: Node v20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0, Playwright 1.62.1, pg 8.21.0. Operational verification from
`server`: `python3 tools/bin-cargo-plan-release.py verify` and
`python3 tools/bin-cargo-plan-live-check.py`.

Audit records are in `deployments/bin-cargo-plan-20261023`: `validation.json`,
`prepared.json`, `built.json`, `deployment.json`, `live-verification.json`, and
`live-cargo-verification.json`. A narrow overlay over the captured live image
preserves unrelated workspace changes and retains a rollback image.
All test containers ran in `mbbs-tests.slice` with resource limits, unique
artifact directories, and registered teardown. After cleanup, both `docker ps`
and `docker ps -a` show only the four production containers. Disposable database
volumes/networks and generated test logs/artifacts were removed; `.runs` is empty.
