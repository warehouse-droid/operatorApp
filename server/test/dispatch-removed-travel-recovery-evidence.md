# Automatic removed-travel closure — 2026-09-11

Deployed to the app and webhook worker as
`mbbs-operator-app:removed-travel-recovery-20260911-v1`, image
`sha256:e6890adf56d09539d1417593ad6297964d0847e8b8533ec3162a21a0458df815`.
The app is healthy. The user explicitly requested automatic closure when travel
disappears, followed by a fresh start of replacement travel.

## Outcome

PWA next-job, day-state and day-plan reads detect in-progress travel that is
absent from the confirmed route. They re-read the route under the fleet and
driver-day transaction locks, then mark only the obsolete travel `superseded`.
The old timestamps/details remain, with a closure timestamp and an audit entry.
No arrival/completion is invented. Replacement travel remains pending.

Existing current travel and completed history stay intact. Missing physical
pickup/drop records still raise the original route-conflict error. A travel leg
added back with an identical identity is presented as pending and its explicit
start receives a fresh timestamp. Previous closure metadata remains available
to reject delayed events from an older manifest.

Offline manifests are superseded and queued events for the obsolete travel are
retained as evidence. Late uploads from a pre-closure travel manifest are also
retained as evidence before the generic superseded-manifest review barrier;
they cannot restart old travel or obstruct the replacement through that barrier.

## Verified live recovery

The normal PWA route lookup automatically closed Sety's record 3409 at
`2026-09-11T18:34:13.547Z`. Its status changed from `in_progress` to `superseded`;
the original start `2026-09-11T17:47:36.409Z` and null completion were preserved.
Audit 20330 records `driver_travel_superseded`, exactly once.

The returned job was the current 3445-to-Ayr travel, status `pending`, with
`startedAt: null` and `routeAttention: null`. No replacement job was started by
the verification. This live closure was authorized by the user's explicit
instruction to close removed travel automatically.

## Final focused checks

Run from the repository root:

```sh
bash server/tools/dispatch-removed-travel-recovery-gauntlet.sh
```

The default creates a separate test database. The final run reused the existing
internal test network:

```sh
TRAVEL_RECOVERY_TEST_NETWORK=mbbs-map-redraw-unit_mbt_test_internal \
  bash server/tools/dispatch-removed-travel-recovery-gauntlet.sh
```

| Check | Result |
| --- | --- |
| Existing pickup-editing, route-prefix, property/adversarial and planner tests | 36 passed |
| Automatic closure through all three PWA reads; disappeared/replaced travel; retained history; physical conflict; identical-leg return; concurrent refresh; late offline upload | 11 passed |
| Existing travel reopen, route save and Driver-start concurrency tests | 6 passed |
| Existing Driver PWA stop/evidence/manifest harness | Passed |
| Existing offline repository rollback harness | Passed |
| Syntax, scoped ESLint for new tests, diff whitespace | Passed |
| App/worker image, health and tested source hashes | Passed |
| Runtime source/public/migration comparison | 865 files; exactly the two intended source files changed |

All 53 test results above come from the final run after the last runtime edit.
Artifacts are in `server/test-artifacts/removed-travel-recovery/`, including the
test image identity, `unit-final.log`, `integration-final.log`,
`static-final.log`, runtime manifests and source hashes. Node was v20.20.2;
the existing dependency versions are in `package-lock.json`.

Initial automatic-closure tests reproduced 7 failures out of 9 cases. The late
offline test separately reproduced `review_required` instead of `evidence_only`.
The identical-leg return test separately reproduced the stale superseded state.
The offline fixture was corrected to use the current date because an expired
1898 manifest violates the existing expiry constraint; the test retains the
assertion that no operational event handler may execute.

## Release and scope

No dependencies, migrations, frontend assets or credentials changed. The release
extends the preceding hotfix image and replaces only `driver-repository.js` and
`driver-offline-service.js`. There are no external service calls in the repair.
The automatic database write on PWA refresh is the requested behavior. Existing
full-plan and Driver action locks protect it. The original explicit-reopen code
from the first hotfix remains unchanged.

Source SHA-256:

```text
829805802fce0fecd8829a52d0a94a2efba061fae84cc59ccd6f7711186b7d2d  src/driver-repository.js
543271b5f0c353e2f315c965be9ca6ea27989441366645dc9a54df336704edab  src/driver-offline-service.js
```

Release and rollback definitions are retained in
`docker/backups/removed-travel-recovery-20260911/`. The worker queue was empty
before its cutover. No commit was made.

This is the ongoing urgent production hotfix. The spec was not separately
approved before implementation (autonomous run); the user's automatic-closure
instruction is recorded in `dispatch-removed-travel-recovery-spec.md`. The full
repository suite, whole-project type/lint run, browser matrix, coverage, mutation
and randomized-order gauntlets were deferred. The focused tests do not claim
those broader assurances. Concurrent PWA refreshes were exercised against the
real database; a dedicated race that restores a removed leg while the refresh
waits on the planning lock was not separately exercised.
