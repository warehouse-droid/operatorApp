# BIN workflow edit locks — evidence, 2026-10-23

Spec: [bin-workflow-edit-locks-spec.md](bin-workflow-edit-locks-spec.md).
Spec approval: not obtained (autonomous run). Tier 3 for concurrent planning and
preservation of issued instructions. No dependencies, commits or migrations added.

Deployed `mbbs-operator-app:bin-workflow-edit-locks-20261023` at `2026-10-23T18:44:14Z`. All seven runtime
files match the validated candidate. Application configuration and other services
were preserved. The release overlays `mbbs-operator-app:regular-close-inline-20261023`;
its image is retained for rollback. Runtime manifest digest: `546f35dcb0e269f2437b2fcfe74c4a5c61175e9e0169f8fde56cb4afc33e6ee7`
(SHA-256 of sorted, compact JSON sourceHashes in the operational validation record).

Final fresh candidate run: **344/344 tests in 79 BIN workflow/planning/cargo/driver
files passed**, **13/13 focused tests passed in reverse file order**, **7/7 deliberate
mutants killed** (three independently by the property suite), **247/247 changed
JavaScript lines executed**, and **208/213 scoped branches executed**. Syntax,
strict types, lint, complexity and diff-secret checks passed with zero new errors;
the type baseline also had zero errors. Three new property tests exercise 750
seeded cases. Real Chromium tests exercised both unplanned, delivery planned, and
collection planned routes, including saves through the actual HTTP endpoints.

| Acceptance criterion | Executable evidence |
| --- | --- |
| Both unplanned: sequence, dump and destination editable, including an outward receiving link | `bin-workflow-edit-locks.test.js`: both unplanned; `bin-workflow-edit-browser.test.js`: both unplanned |
| Either planned: sequence/reuse locked; dump and destination depend on Collection | Planned-delivery and planned-collection tests in both files; forged changes rejected by server |
| Preserve planned leg, plan, windows, claims and evidence | Full visit/steps/evidence/claims snapshots and complete saved-plan comparisons before/after partial saves |
| Withdrawn issued history does not lock a draft | Confirm, withdraw both legs, edit, then compare all assignment history rows |
| Retain linked cargo; detach safely and reselect/relink before planning | Linked-source, cargo/window preservation and detach/relink tests; detached receiving card and server assignment blocked |
| Started work, stale revision and races remain protected | Started-onward detach rollback; simultaneous planning/editing; generated current-work states; existing driver/concurrency regressions |
| Planned receiving order remains displayed while unplanned replacement changes | Third Chromium case; Collection and saved plan remain identical |
| Customer windows/material remain order-owned | Existing workflow, cargo and browser regressions, including no Dispatch time inputs |

RED evidence: the original implementation failed five of six initial integration
cases and both original browser cases. The existing race behavior was retained and
its regression test kills a stale-planning-revision mutant. The later planned-
receiving-order browser case first failed with an empty selected destination.
During implementation, regressions caught irrelevant delivery fields on Collection
orders, missing linked-order explanation, and foreign keys while rebuilding draft
steps. Fixes preserve external dependency tuples transactionally and restrict edits
to editable legs. No assertions were weakened. An existing storage-failure test's
SQL fault-injection matcher was updated for the replacement guard query; its error
identity assertion stayed unchanged. Refactors reduced function complexity below
the existing limit of 12.

The adversarial checks reject forged sequence/reuse, planned bin/dump/destination/
cargo changes and detachment of started onward work, and verify rollback. Mutants
also cover over-locking Collection and ignoring current plans. There is no claim of
exhaustive interleaving or branch coverage: five scoped branches were not executed.
The full unrelated application suite was not run. Dependency/license audits and
migration rollback rehearsal were not applicable because those inputs did not change.

Live verification used a read-only transaction for **BIN00002X-1C**: both exchange
legs remain ready and unplanned, with their existing revisions (C=12, D=8), all
sequence/delivery/collection permissions true, and the current receiving target
selectable. Origin HTTP routes and served popup bytes match the release. An
unauthenticated check through the public hostname returned HTTP 403, so public-edge
browser access was not independently verified; authenticated UI behavior was
verified in isolated Chromium.

All tests used the standard bounded disposable runner under `mbbs-tests.slice`.
Containers, temporary databases, volumes, networks, screenshots, logs, mutation
copies and coverage artifacts were removed automatically. Final `docker ps` and
`docker ps -a` showed only the four production containers, and the application is
healthy. Only source evidence and operational release/rollback records remain.

Reproduce from the repository root (the captured candidate and comparison baseline
are operational deployment records):

```sh
DISPATCH_SOURCE_SKIP_BUILD=1 \
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-workflow-edit-locks-20261023/candidate" \
DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/bin-workflow-edit-locks-20261023/candidate/migrations" \
bash docker/run-bin-workflow-edit-checks.sh
```

The runner invokes persisted static, suite, mutation and changed-line coverage tools.
The live read-only script is `tools/bin-workflow-edit-live-check.mjs`. Release guards,
rollback and source verification are in `tools/bin-workflow-edit-release.py`.

| Tool | Recorded version |
| --- | --- |
| node | v20.20.2 |
| typescript | 7.0.2 |
| eslint | 10.8.0 |
| c8 | 12.0.0 |
| fast-check | 4.9.0 |
| playwright | 1.62.1 |
| pg | 8.21.0 |
