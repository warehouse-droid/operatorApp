Dispatch pool session retention — 2026-09-15

The browser retains orders discovered through search, pagination and targeted
updates until the page is reloaded. Bounded feed refreshes merge current data
without dropping those discoveries. Successful searches reuse their results;
failed or empty searches can retry. Live and historical searches have separate
cache scopes. Explicit retirement still removes orders and fences late feeds.

Pool updates reconcile existing DOM nodes. Search/date inputs stay mounted;
unchanged cards have no DOM mutations, and changed cards update in place.
Selection, input ranges and visible scroll anchors survive background refreshes.
Browse and search cursors are independent, and delayed responses cannot replace
a newer search or another order-type tab's pagination.

CO creation notifications load the specific CO into the session pool. Local CO
saves retain it immediately. The repository ranks COs by their full creation
timestamp instead of the date plus a negative delivery ID. Creation/update
timestamps now reach the optimized catalog's recency ordering.
The timestamp lookup uses the CO reference so legacy COs without a delivery ID
retain their creation/update timestamps as well.

Validation:

- 14/14 real Chromium browser tests pass.
- 75/75 existing frontend and driver/save-coordination checks pass.
- The 501-CO database fixture passes: the newest CO is inside the first 500
  and first optimized page; older orders remain searchable, and cancelled COs
  remain excluded.
- The database regression run passes 17/19 tests. The two failures in
  `dispatch-global-derived-order-pool.red.test.js` reproduce with unchanged
  source (`null.type` and `null.childOrders`). The baseline also fails the new
  CO recency test, which passes with this change.
- The initial nine browser checks reproduce six failures against the original
  source; all nine pass after the fix. Five additional race/scroll/assignment
  checks also pass.
- Syntax checks and `git diff --check` pass. The release image hashes match the
  tested source for all three shipped files.

Logs and baseline copies: `server/test-artifacts/dispatch-pool-session/`.
Database runner: `bash server/tools/dispatch-pool-session-test.sh` (isolated,
temporary PostgreSQL; use `POOL_SESSION_BASELINE=1` for the baseline comparison).

Deployed image: `mbbs-operator-app:dispatch-pool-session-20260915-v2`.
Compose override: `docker/backups/dispatch-pool-session-20260915/compose.override.yml`.
Base/rollback image: `mbbs-operator-app:sov-dispatch-20260914-v1`.
Only `public/dispatch.js`, `public/dispatch.html` and `src/dispatch-repository.js`
are overlaid on the running SOV release. No migration or saved-plan repair is
part of this change. The normal startup catalog refresh repopulates existing CO
timestamps.

Deployment status: deployed and verified on both app and webhook worker.
Both services are running with zero restarts; the app is healthy. Health, page
and script requests return HTTP 200 and running file hashes match the tested
release. The startup catalog refresh completed successfully. All 32 CO catalog
entries now have recency timestamps, including the five legacy entries without
delivery IDs. The newest CO, `CO-GOA-8668-8669`, is already assigned to plan 324
and correctly remains outside the unassigned pool.

Final verification: `server/test-artifacts/dispatch-pool-session/summary.json`.
