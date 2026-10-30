# BIN cargo routing evidence — 2026-10-23

Deployed at 2026-10-23T14:30:13Z. Image `mbbs-operator-app:bin-cargo-routing-20261023`,
`sha256:47674139f0f97f178769a509507496bfaf8854ce15cdb98e22566927e772f0a0`. Application health, configuration preservation,
other-service preservation and all 22 runtime file hashes verified.
Source-map SHA-256: `b8a1204ebe5008bac20e8a89c96b94a3bdc2d86cc55ea6c226bbf3bf7d4be394`.
Final validation completed at 2026-10-23T14:29:34.606Z, after the last runtime edit.

Spec: [bin-cargo-routing-spec.md](bin-cargo-routing-spec.md).
Spec approval: not obtained (autonomous run). Tier 3 for transactional route
changes, exclusive custom-order claims and driver custody. These checks cover
specified behavior; they are not proof against every possible failure.

| Spec | Executable evidence |
| --- | --- |
| 1. Purchased materials and required pickup locations | `mbt/integration/bin-cargo-routing.test.js`, `bin-cargo-contract.test.js`, `bin-cargo-browser.test.js` |
| 2. Mixed materials, manual additions, existing or one-off custom cargo | `mbt/unit/bin-cargo-domain.test.js`, `mbt/property/bin-cargo.property.test.js`, browser test; existing `item-charge-basis-and-aggregate.test.js` |
| 3. Physical route, pickup/drop ordering and reuse after dumping | Domain/property tests, routing/driver tests, the two cargo exchange scenarios in `mbt/integration/bin-order-workflow.test.js` |
| 4. Revisions, leases, replay, rollback, immutable started work, pricing/windows | Cargo routing/contract tests; existing bin-selection, bin-window and planning permission regressions |
| 5. Exclusive custom claims and completion at drop | Cargo contract race tests and driver rollback/replay tests; ordinary Dispatch/custom-order regressions |
| 6. Driver instructions, evidence, custody and weight | `bin-cargo-driver.test.js`, `bin-cargo-driver-browser.test.js`, payload/truck-capacity tests |
| 7. Details controls and existing planning layout | Real planning browser test plus existing planning/read-only/search/collection browser suites |

- Affected regression suite: 352 tests across 78 files; 349 passed,
  3 independently reproduced baseline failures, zero new failures.
- Reverse file-order repeat: 71/71 passed across 9 files.
- Changed executable JavaScript lines: 599/599 covered;
  changed-line branches 495/517. No unmeasured JS files.
- Six of six manual mutants killed: purchased weight, custom exclusivity, bin
  custody, custom completion, material weight and pickup/drop ordering. The last
  two were killed by the property suite alone (200 generated cases, fixed seed).
- Syntax checked for 18 JS files; zero new lint/type errors and zero
  secret findings. Three existing router type diagnostics remain in the baseline.
  New MBT functions satisfy the complexity limit of 12.
- Real execution: planning and Driver PWA browser tests against the server and
  disposable PostgreSQL; scan/photo driver events, rollback and replay exercised.
  Migration rollback and cancellation-claim release verified in disposable DBs.

The three baseline failures are from
`test/dispatch/integration/dispatch-v2-command-flow.red.test.js`:

- DP-05: split → unsplit retires every global split definition
- history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders
- DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries

The baseline stage reruns that file against the captured unchanged live source
(9 passed, 3 failed). The release gate accepts only those exact failures in that
single file after baseline reproduction; none are skipped or removed.

RED observations included missing cargo behavior, malformed-UUID handling,
new Front Desk material reconciliation, premature reused-bin pickup, and an
unnecessary restriction on loading a separate replacement bin. Regression
checks found and fixed a legacy bin-reselection route-estimate regression.
The legacy upgrade fixture now removes/reapplies the new foreign-key table while
retaining its behavioral assertions. Static failures were fixed by null narrowing
and smaller functions. Final results above supersede intermediate runs.

Read-only production verification: BIN00003D and BIN00004D both expose Gravel,
1 yd³ / 2,600 lb, and active yards 3445, 2967 and 150. Both remain editable and
await Dispatch's pickup selection. Their order and pricing snapshots match the
pre-release capture. New static asset returns 200; unauthenticated cargo API
returns 401. No production cargo routes or customer orders were created by
verification.

Known scope: bin payload is enforced when a limit is configured; current live
bin types have no limit configured. Truck weight includes actual cargo. Route
provider responses are controlled at the network boundary in tests; no paid
Google request or real customer driver completion was made for verification.
The affected suites, rather than every unrelated repository suite, were run.
No dependencies or commits added. Supply-chain audit was not rerun because the
package manifests/lockfile are unchanged. No new external service integration.

Reproduce from the repository root using the retained exact candidate and
captured live baseline:

```sh
DISPATCH_SOURCE_SKIP_BUILD=1 \
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-cargo-routing-20261023/candidate" \
DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/bin-cargo-routing-20261023/candidate/migrations" \
bash docker/run-bin-cargo-checks.sh
```

Toolchain: node v20.20.2, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0, playwright 1.62.1, pg 8.21.0.
Operational commands (from `server`): `python3 tools/bin-cargo-release.py verify`
and `python3 tools/bin-cargo-live-check.py`.

Audit records: `deployments/bin-cargo-routing-20261023/validation.json`,
`prepared.json`, `built.json`, `deployment.json`, `live-verification.json`,
`live-cargo-verification.json`. The source overlay and rollback image preserve
unrelated workspace edits. All test runs used bounded containers in
`mbbs-tests.slice`, unique artifact directories and registered teardown.
`docker ps` and `docker ps -a` show only the four production containers after
cleanup; disposable database volumes/networks and full test artifacts were removed.
