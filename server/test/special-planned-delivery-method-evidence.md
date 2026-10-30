# Special delivery methods during Dispatch arrangement — evidence

Spec approval was not obtained; this was an autonomous Tier 3 run under the user's change request. See [the executable specification](special-planned-delivery-method-spec.md).

Reproduce from the repository root with `sudo -n bash docker/run-special-planned-method-checks.sh gauntlet`. The runner captures the current live source, applies only this task's delta, uses a fresh isolated database for each file, and removes containers, volumes, networks and temporary artifacts on exit. No new dependencies or migrations.

Source identity: base image `sha256:c9c89d77e9450a3a84754de61d3a07fb17e9cfea22ee46bc18f1d2f6586e33a9` plus the five SHA-256 values in `server/deployments/special-planned-delivery-method-20261027/verified.json`. The runner computes and verifies those hashes, including after every mutation is restored. The final source patch is retained in the same release directory.

| Specification | Automated evidence | Result |
| --- | --- | --- |
| Planned Special orders remain editable; Backorder planning restrictions remain | `special-planned-delivery-method.test.js` integration and property tests; desktop 1440px and mobile 390px browser saves | Pass |
| Commercial fields and Dispatch snapshots survive changes; teams receive existing notices | Planned pickup round trip and verified MBT delivery; existing adapter, HTTP and durable-notice tests | Pass |
| New methods rebuild an unstarted handoff; identical pickup retains its planned route | Planned MBT delivery and same-method integration cases | Pass |
| Execution, closure, revision and yard protections | Pickup, dropoff and assigned-load travel; execution between claim and completion; existing scope/closure tests | Pass, subject to existing header-note failures below |
| Retry and concurrent update integrity | Concurrent planned saves, retry with saved remote target, notification-write rollback | Pass |

Final fresh run: **93 passed, 2 unchanged baseline failures, zero new failures** across ten focused regression files. All 11 new checks passed again after mutation restoration. File order was shuffled with seed 20261027. The new property ran 60 examples with seed 20261027.

Changed executable JavaScript line coverage: **47/47**, combining Node/c8 and browser V8 coverage. The HTML cache version is asserted and the updated script is exercised in the browser. Manual mutation: **3/3 killed** (planned-editor lock, ignored driver execution, retained stale handoff). Property tests alone kill 1/3; database-specific faults are covered by integration tests, not the UI property.

TypeScript diagnostics in the four runtime modules: 839 before, 839 after, zero new. ESLint: 29 before, 29 after, zero new. Existing untyped code prevents claiming globally clean types or lint. Syntax and whitespace checks passed. Tool versions: eslint 10.8.0, typescript 7.0.2, c8 12.0.0, fast-check 4.9.0, @playwright/test 1.62.1, pg 8.21.0; Node v20.20.2.

Two pre-existing failures remain in `special-header-note-http.test.js`: “issued, closed, cancelled, pending, uncertain and planned requests reject delivery header saves without writes” returns 200 instead of 409 for the legacy `operationally_complete=true` flag; “issued Note-only edits retain role, yard, workflow, revision, terminal and atomic rollback checks” reports a missing expected rejection. Both were reproduced against unchanged live source before this implementation. Their assertions were not weakened. The checker requires identical names, assertions and counts for these baseline failures.

The original planned-Special rejection expectations were explicitly superseded by the requested behavior. Initial new tests failed against the old restriction; the implementation then passed them. Test-fixture corrections supplied required Backorder inventory/manual-link fields and required handoff yard data. Harness corrections supplied the expected database alias, mirror role, writable browser configuration and the installed TypeScript/Playwright output formats.

No repository-wide suite, dependency audit, performance budget, or multi-version matrix is claimed; the change adds no dependencies or new network capabilities. External NetSuite writes and driver starts are not globally atomic. The existing operation journal and final execution recheck remain the recovery mechanism; no fleet lock is held across external calls. Production verification uses read-only case inspection and served assets, with no production fulfillment changes. Deployment and teardown results are recorded separately in the release directory.

Deployed on 2026-10-27 at 22:04 UTC as image `sha256:0f7b86b9e6bf534757b2702669751428d888a8aed6422c8791dd130770c46197`. Read-only inspection of 25 live Special requests found eight planned requests: one was editable and seven with execution evidence remained locked. Health and updated assets returned 200; all five deployed hashes matched validation. App configuration and dependency containers were unchanged. Final `docker ps` and `docker ps -a` contain only the four production containers; no task test volumes, networks, or temporary artifacts remain.
