# Completed-load allocation scope — 2026-09-14

The fix is deployed and healthy. Recovery 17308 for September 13 plan 326
passes the deployed executed-prefix check with CO-SOM06255-S1 in Load 5.
All three completed loads remain identical in the comparison, and a deliberate
change to recorded cargo is rejected. The recovery was not automatically
applied to the active plan; the user can retry Save.

## Cause and correction

The old snapshot contained an unassigned `CO-GOA-8111-8113` catalog row.
Its child references overlapped the SO group `GOA-8111-8113` on a completed
load. The submitted draft correctly omitted that unrelated CO. The old cargo
comparison searched all plan orders by shared source references and mistook
the omitted catalog row for removed executed cargo. This blocked the complete
save even though the new CO was in the final load and completed work was intact.

`driverActivityAllocationSignature` now selects orders named by the affected
load's stops, including consolidated pickup references and exact nested
children. It then applies the existing cargo comparison. Assigned COs, grouped
children, quantities, item identities, destinations, stop order and driver/truck
assignments retain their protections. No conflict code or transaction lock changed.

## Specification and failure model

Risk tier 3. Spec approval: not obtained (autonomous run). The user subsequently
explicitly authorized deployment after focused regression, followed by broader
regression. See `dispatch-activity-allocation-scope-spec.md`.

| Spec | Executed evidence | Result |
| --- | --- | --- |
| 1: harmless unassigned CO removal/addition/refresh and final-load append | New unit cases and 100 fixed-seed property cases; original source failed before the fix | Pass |
| 2: related CO on another future load remains editable | `related CO cargo on a later load remains editable` | Pass |
| 3: consolidated pickup and nested/grouped cargo protection | New unit cases, 60 additional property cases, existing grouped-allocation harness | Pass |
| 4: missing cargo, aliases, stop/driver changes remain rejected | Negative unit cases and existing route-prefix tests | Pass |
| 5: actually assigned CO remains protected | `completed COs, groups and nested allocations still reject real changes` | Pass |
| 6: persisted activity, successful save, rejection atomicity and races | New PostgreSQL save test; existing route-prefix integration/concurrency suite | Pass |
| 7: actual draft and recorded load preservation | In-memory read-only replay against both proposed and deployed code | Pass within the read-only boundary |

The database regression initially failed on the original cargo guard. With the
fix, the actual repository saves the synthetic final CO at revision 17 without
restoring the unrelated CO, preserves completed stops and driver records, and
rejects a changed cargo quantity without a partial write. Missing synthetic
fleet/CO setup was completed before the successful-save assertion could run;
the assertions were retained.

## Deployment

App start: `2026-09-14T15:51:28.415297765Z`, after focused tests passed.

- Image: `mbbs-operator-app:activity-allocation-scope-20260914-v1`.
- Immutable image: `sha256:8669ba1f16ffecf974b462ce92e48b3e9b399dba65375f417474f1b4d1fae043`.
- Runtime module SHA-256: `1711bb4567c4609b13d87301798aeff7db2ec1596ac9621efca3f143c7896ca7`.
- Original deployed module SHA-256: `ed66c11791536b49785a7986b22c5511a18fab3b9b5faba13e51ec88d3049658`, verified equal to the pre-change working file.

The image derives from the running `recorded-po-load-20260914-v1` image and
replaces only `/app/src/dispatch-load-assignment.js`. An exact-image smoke test
passed before cutover. Compose used `--no-deps --no-build --wait` and the
override in `docker/backups/activity-allocation-scope-20260914/compose.override.yml`.
The worker retains its prior image and September 11 start time. The previous
app image and override remain available for rollback.

After the broader run, the app still returns HTTP 200 for health, its source
hash matches the tested module, and the deployed read-only replay still passes.
No source-order repair, driver-record change, migration, or draft promotion was
performed. All database writes used synthetic data in a dedicated test database.

## Verification results

All results below use the same final runtime source. The broad baseline uses
the same working tree with the original deployed guard substituted, isolating
this change from pre-existing work.

| Layer | Result |
| --- | --- |
| Focused tests, including new repository save and existing allocation harness | 15/15 pass |
| New fixed-seed property cases | 160 cases pass; seeds 20260914 and 20260915 |
| Existing route-prefix unit/property/adversarial/integration/concurrency/wiring suite | 22/22 pass |
| Broader Dispatch policies | 51/52 pass; identical pre-existing failure on both versions |
| Full MBT, 462 isolated files | 2,297 pass, 2 pre-existing failures, 1 pre-existing skip; zero new failures |
| Full legacy compatibility | 134/134 pass on both versions |
| Changed executable lines | 17/17 covered |
| Deliberate defects | 5/5 killed by the unit suite and independently 5/5 by properties alone; copied source restored and green |
| Both actual test-file orders | 9/9 pass; reverse order uses separate processes because Node sorts file arguments |
| Configured TypeScript check | 233 existing diagnostics on both versions; zero added |
| Strict focused ESLint | Zero errors/warnings |
| Source syntax, shell/Python syntax, secret scan and diff whitespace | Pass |
| Live draft replay and final deployed health/source check | Pass |

The five defects reintroduce unrelated catalog matching, ignore cargo entirely,
omit secondary pickup references, omit exact nested assignments, and bypass all
execution checks. Every one fails the ordinary suite and the property tests.
The final bypass also demonstrates that the route/reassignment regression
assertions can fail.

The first coverage invocation inherited repository-wide 95% line/90% branch
thresholds and stopped despite 15 passing tests. The task's specified gate is
100% of changed executable lines. The persisted checker enforces 17/17;
whole-module coverage is 94.19% lines and 78.13% branches. This is not a claim
of complete branch coverage. Initial test-tool brace-style diagnostics were
fixed and strict lint reran successfully.

### Pre-existing failures and limits

1. `p3-gauntlet-contract.test.js`: the existing unpacked-split browser spec
   does not import the shared worker-scoped E2E fixture.
2. `production-runtime-contract.test.js`: the retained test image's Dockerfile
   lacks the production Dockerfile statement expected by the contract.
3. `dispatch-repeat-pickup-visits.red.test.js`, RP-05: its active-travel
   destination-lock expectation fails identically with the original guard.

The existing skipped full-suite case is the migration-175 billing-upgrade case.
No tests were weakened or skipped to obtain these results. No browser layout
matrix was run because this is a backend-only comparison change; real repository
execution and the recorded draft check cover the affected behavior.

Automatic approval review rejected exporting the operational plan/draft/driver
payload to a local file. No payload was exported. The approved narrower replay
keeps that data in memory inside a PostgreSQL `READ ONLY` transaction and emits
only assertions. Production save/confirmation was therefore not used as a test;
successful saves were exercised with synthetic fixtures. The live replay depends
on retained recovery 17308 and the current plan/driver state.

No dependency was added, so dependency/license audits were not rerun. The
runtime change adds no network, filesystem, subprocess or environment access.
No commit was made; unrelated working-tree changes were preserved. Base Git
commit is `36a26ac4c3f76b9fe2bd39fe2773144db0a28ce2`; the module hash above identifies
the deployed change more precisely than that dirty-tree commit.

## Reproduce

Run `bash server/tools/dispatch-activity-allocation-scope-gauntlet.sh` with the
retained test image available. It reconstructs the original guard from the
persisted reverse patch, creates/resets only the task-specific isolated test
database, runs all listed suites and checks, and compares baseline failures.
The live check is read-only. To verify the installed code directly, run
`bash server/tools/check-dispatch-activity-allocation-scope-live.sh deployed`.

Tool versions: Node 20.20.2, fast-check 4.9.0, ESLint 10.8.0, TypeScript 7.0.2,
c8 12.0.0. Artifacts are under
`server/test-artifacts/activity-allocation-scope/`; the machine-readable final
report is `final/summary.json`, with full logs and coverage alongside it.
