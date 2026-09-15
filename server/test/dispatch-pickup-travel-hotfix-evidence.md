# Pickup editing and travel reopening hotfix — 2026-09-11

Deployed to the app and webhook worker. Both use
`mbbs-operator-app:pickup-travel-hotfix-20260911-v1`, image
`sha256:847f3db28d6eee51d3c03f7814dbf4be3c90d40b760f4bdb688d35f17370c708`.
The app is healthy and the live health endpoint returned HTTP 200.

The user explicitly requested an urgent hotfix and clarified that the lock
starts at the specific pickup. Spec approval was not separately obtained
(autonomous run); see `dispatch-pickup-travel-hotfix-spec.md`. Confidence is
limited to the focused checks below, not a complete repository gauntlet.

## Behavior and live evidence

Travel previously included its destination in the protected physical-stop
prefix, and unidentified inter-load travel defaulted to locking the first
pickup. Travel now protects the preceding physical stops. Independent physical
pickup/drop records continue to protect their own recorded activity. Driver,
truck and preceding route-load protection remains in force.

Travel is now included in recorded-stop listing and the existing guarded reopen
action. Reopening still checks current assignment, latest activity, state hash,
offline work, rest and executing foreground actions; it preserves the correction
and audit history and does not impose photo requirements on travel.

Live read-only verification on plan 323 revision 43 found Dao's current travel
record 3395 in progress, eligible for restart with no blocker. Earlier travel
remained blocked by newer activity. Editing the pending pickup in Load 4 passed
the deployed policy with no conflicts. No live stop was restarted and no draft,
order or operational execution record was changed by the verification.

The private replay also contains older recovery drafts with differences in
other drivers' completed routes; those raw drafts continue to fail protection.
They were not applied. Planners should refresh the authoritative plan and retry
their pending-pickup edit. One captured recovery draft and an isolated edit of
Dao's current pickup both passed the corrected policy.

## Final verification

Reproduce with `bash server/tools/dispatch-pickup-travel-hotfix-gauntlet.sh` from
the repository root. With an existing migrated, isolated test database, the
final run used:

```sh
PICKUP_HOTFIX_TEST_NETWORK=mbbs-map-redraw-unit_mbt_test_internal \
  bash server/tools/dispatch-pickup-travel-hotfix-gauntlet.sh
```

The default command creates and migrates a separate temporary test database.
The reused network was checked to be internal. Toolchain: Node v20.20.2;
dependency versions are in `package-lock.json`. Final logs and the test image ID
are under `server/test-artifacts/pickup-travel-hotfix/`.

| Acceptance criterion / check | Evidence | Result |
| --- | --- | --- |
| Add/edit before first pickup, explicit/legacy/inter-load travel, both activity statuses | `dispatch-pickup-travel-hotfix.test.js` | Pass |
| Edit a later pickup after an earlier pickup in the same load completes | Same unit file | Pass |
| Started pickups, preceding physical history, assignment stay protected | Same unit file and existing route-prefix unit/property/adversarial tests | Pass |
| Travel listed, reopened, state hash checked, no extra photos, exact retry, retained timestamp and single audit/correction | `dispatch-travel-reopen-hotfix.test.js`, rollback transactions | 2 passed |
| Existing route save atomicity and concurrent Driver-start protections | Route-prefix integration/concurrency tests | 4 passed |
| Focused policy, property, adversarial and planner tests | `unit-final.log` | 36 passed, 0 failed |
| Database tests | `integration-final.log` | 6 passed, 0 failed |
| Legacy stop-reopen and manifest harness | `static-final.log` | Passed |
| Syntax for both runtime files, scoped ESLint for new tests, diff whitespace | Final script | Passed |
| Live app/worker image and both source hashes | Docker inspection and SHA-256 | Exact match |

The initial regression run failed 9 of 12 tests against the old implementation.
The integration test initially expected an identical retry object, while the
existing API adds `exactRetry: true`; the assertion was corrected to require
that flag and the entire original result, with the spec clarification recorded.
All reported counts come from the final run after the last runtime edit.

## Release boundaries and deferred checks

The release is based directly on the prior production image and copies only
`src/dispatch-planner-performance.js` and `src/driver-pwa-repository.js`.
Comparison of 865 source/public/migration files found exactly those two changes.
No dependency, migration, credential, API request schema or frontend asset changed.
The updated legacy test harness is kept in source but was not shipped as an
additional runtime replacement. No commit was made.

Runtime SHA-256:

```text
c34807688628f5b17b7b889617ee83c681b0e6022251f715200b985984ef2acc  src/dispatch-planner-performance.js
5e24fe9d264b673dd335cbadd7734f11e7990eccbf36373fecafbcc1bd106a78  src/driver-pwa-repository.js
```

The full repository suite, browser matrix, whole-project type/lint run,
changed-line coverage, mutation testing and randomized suite ordering were
deferred for the explicit urgent hotfix. No claim is made for those layers.
There are no new dependencies to audit or new network/filesystem capabilities.
The existing integration race test and both active/completed reopen cases passed.

Release and rollback Compose files and original runtime source are retained in
`docker/backups/pickup-travel-hotfix-20260911/`. The prior image remains available.
The worker had no queued/running webhook jobs before its cutover. An initial
read-only queue check used an incorrect table name; the corrected check against
`netsuite_order_webhook_inbox` returned no work before the worker was restarted.
