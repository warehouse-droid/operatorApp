# Split address persistence evidence

## Incident

Read-only production investigation found SOA08748-S2 at **76 Heatherside Dr, Scarborough, ON M1W 1T7** in load-drop audits **21192** (2026-09-15 16:29:00 UTC) and **21198** (16:30:13 UTC). Saved plan 327 revisions 41–45 instead held **94 Mossbrook Crescent, Scarborough, ON M1W 2W9**. This proves that the browser used Heatherside; there was no separate successful split-details audit from the old form.

The old form treated SO splits as browser-local edits. Plan reconciliation replaced those edits with the existing global split definition. Parent refreshes and split materialization also copied the parent address. Regression tests reproduced each path before implementation: **7/7 initial tests failed**.

## Change and acceptance mapping

- The existing details endpoint now persists explicit SO split details, including equal-to-parent and empty addresses, in the canonical split definition. It also updates an existing materialized sales-order row. Unmaterialized splits are supported.
- Source refresh reapplies those explicit details after inheriting current source metadata. Cards and plan reconciliation retain the marker. Materialization reads the current saved override even if its caller holds an older plan.
- The form flushes pending split creation, reacquires the same order by ID, and calls the audited, lease-protected endpoint. Errors remain visible. Plan saves and edits share the fleet lock; source refresh uses the split row lock.

| Spec | Verification |
|---|---|
| 1: actual form and failed saves | `frontend/dispatch-split-address.test.js`; real Playwright form test |
| 2–4: persistence, refresh, sibling/source freshness, replacement/clearing, invalid-date rollback, retirement | `integration/dispatch-split-address.test.js` |
| 5: stale saves and concurrent prior save | `integration/dispatch-split-address-http.test.js`; observes a real PostgreSQL advisory-lock wait |
| 6: two destination visits and stable stop IDs | unit route test, HTTP reload test, Playwright refresh test |
| 7: lease/audit, existing quantities/dependencies and prior split-target fix | HTTP tests, full Dispatch suites, materialization harness, split-target browser regression |

## Verification

Reproduce all layers with `bash server/tools/dispatch-split-address-gauntlet.sh` from the repository root. This uses only disposable Docker PostgreSQL databases and cached test images; no production tests or new dependencies. The task-only patch permits reconstructing the baseline in a fresh checkout of this source state.

- Focused tests: **14 passed**, including **150 seeded property cases**. Two materialization/physical-visit harnesses passed.
- Browser: **2 passed**, covering address save/refresh/route grouping and the earlier hover changing the split target bug.
- Changed executable lines: **105/105 covered**. The checker excludes padded VM fixture wrappers from coverage evidence. Global legacy-file coverage is not used as a threshold.
- Manual mutants: **7/7 caught**. Property-only tests catch **3/7**; source refresh, confirmation, concurrency, and browser acknowledgement need their integration/browser-form assertions. This is an explicit property-suite boundary.
- Syntax: **5 production JavaScript files passed**. Lint: **0 new issues**, with **11 existing equality-style findings** retained. The two new helper functions pass undefined/unused-variable checks and complexity budget 12.
- Full Dispatch regression results and the verified pre-fix failures are recorded in `test-artifacts/split-address/regression-comparison.json`. Existing failures are preserved; no test assertions were relaxed or skipped to pass.
- Source hashes and Node version: `test-artifacts/split-address/static.json`. Cached tools: Node 20.20.2, fast-check 4.9.0, ESLint 10.8.0, c8 12.0.0; Playwright 1.62.1 for browser execution.

## Limits and verification corrections

Spec approval: **not obtained (autonomous run)**. No independent spec review occurred. Static types were not added to the legacy JavaScript modules; syntax, lint, executable database tests and mutation checks provide the applicable coverage. Dependency/license audit was not repeated because dependencies did not change. No external NetSuite or Google Maps calls were made during tests; refresh uses a simulated source feed and routing checks destination/visit identity.

The first HTTP concurrency fixture reused a unique plan date; the fixture was corrected to use a separate date. An existing cancellation test requires the literal disposable database name `mbt_test`, so the suite runner executes it separately after the cloned-database tests. Both changes preserve assertions. The initial c8 invocation picked up unrelated global coverage thresholds; the final command measures changed lines instead. A complexity check prompted reuse of normalized date/pickup values. A test-tool variable-shadowing lint error was fixed.

Suite health: property tests use a fixed seed; the broad suites and focused tests ran repeatedly. Randomized full-suite ordering was not added because each broad-suite file receives its own database and the existing runner uses deterministic ordering. Race verification uses an observed lock wait rather than an assumed sleep interval.

## Deployment and correction

The prepared image is `mbbs-operator-app:dispatch-split-address-20260915-v1`, a six-file layer over the current running image. Deployment checks source hashes, the current container/image/configuration, final tests, and app health. Prior files and image/configuration metadata are retained in `/home/ubuntu/operatorapp-deploy-backups/split-address-20260915`.

The details correction script guards plan 327 revision 45, exact split identities, current addresses, and absence of an executing/completed delivery. It saves the two user-confirmed destinations through the tested repository path with audit records and pins S1's equal-to-parent address. A subsequent normal plan save publishes these details to the driver snapshot, as described below. The dry run is stored in `test-artifacts/split-address/live-dry-run.json`. Final deployment/correction results are recorded below.

### Final outcome

- Deployed to app and webhook worker; health endpoint returned HTTP 200, both services running with zero restarts. Runtime hashes match the tested six-file candidate.
- Full Dispatch regression: **841/850 passed**, **9 verified pre-existing failures**, **0 new failures**, **0 skipped**.
- SOA08748-S1: **94 Mossbrook Crescent, Scarborough, ON M1W 2W9**; correction audit **21204**.
- SOA08748-S2: **76 Heatherside Dr, Scarborough, ON M1W 1T7**; correction audit **21205**.
- SOA08751 remains at Mossbrook. Both split overrides are saved in the global definitions and sales-order rows. The live canonical plan projection was verified. The initial details correction preserved revision 45; the normal plan save below subsequently published the addresses to the driver snapshot.
- Production test data: none. No NetSuite transaction, cargo quantity, driver assignment, or stop sequence was edited by the correction.

### Pre-existing regression failures (same before and after this patch)

- DP-05: remove → group → ungroup → replan is an exact, continuous command sequence
- DP-05: split → unsplit retires every global split definition
- DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries
- DP-13 and DP-16: checkpoint list is metadata-only and compact reads/commands record bounded timings
- POB03658: a matched parent update plus a new Driver-completed split stays out of Reconcile Review
- RP-05 active travel protects its destination while allowing work after it
- SO, PO, TO, and CO splits are global definitions while their date assignment remains independent
- grouped CO and CO-of-group are global without hiding the source-order lifecycle
- history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders

### Driver snapshot publication

The driver reader uses the confirmed snapshot. The form already follows a details update with a normal plan save; maintenance now does the same. An added HTTP assertion verifies the persisted snapshot and the real driver route reader after confirmation (**2/2 HTTP tests passed**).

The production save was rehearsed in a transaction and rolled back, including assertions for unchanged assignments, stop identities/order and all order item arrays. The identical save was then applied.

- Published plan revision **46**. Prior revision 45 archived as **17433**; plan correction audit **21207**.
- The driver-facing S1 delivery resolves to Mossbrook and S2 resolves to Heatherside. Route sequence, assignments and cargo remained unchanged.
- Rehearsal: `test-artifacts/split-address/plan-correction-rehearsal.json`; applied result: `test-artifacts/split-address/plan-correction-result.json`.
