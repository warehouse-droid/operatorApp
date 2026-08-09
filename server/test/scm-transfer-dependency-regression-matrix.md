# SCM Transfer-Dependency Workflow Regression Matrix

Run the focused persisted gauntlet from `server/`:

```bash
npm run gauntlet:scm-transfer-workflow
```

The gauntlet writes timestamped evidence and `latest.log` under
`server/test-artifacts/scm-transfer-dependency/`. Database-backed runs must use the
isolated test environment (`NODE_ENV=test`, `MBT_TEST_ISOLATED=1`) and a disposable
PostgreSQL database.

| Incident / behavior | Permanent executable guard |
| --- | --- |
| Confirming the first of two drafts in one Sales Order made the second click silently do nothing. | `test:scm-transfer-workflow` overlaps two proposal-scoped actions and proves both start; `test:order-dependencies` retains per-proposal NetSuite creation/recovery idempotency. |
| Rapid order or tab changes allowed an older response to overwrite the newest card, sometimes making two cards appear identical. | Deferred-response tests prove only the latest candidate, tab, and inventory request can commit state; the mutation suite proves stale-response protection is non-vacuous. |
| Returning from Created/Completed to Open waited for a broad NetSuite refresh. | The route contract proves cached Open rows are returned first and the broad refresh is scheduled in the background. Explicit single-order Refresh and Generate remain authoritative. |
| A created or printed dependency TO could not be corrected or printed again. | Database tests PATCH the exact existing NetSuite TO, reject stale revisions and any local/remote execution progress, preserve allocation conservation, invalidate only the current print pointer, and retain historic print rows. Reprint tests prove each deliberate reprint receives a later immutable job key. |
| Open results were not newest-first. | The shared ordering test freezes descending latest meaningful activity with deterministic Sales Order ID/reference tie-breaks. |
| Search was restricted to the selected workflow tab. | The query test freezes `reviewStatus=all`, cross-tab result stage adoption, and latest-first all-stage results across Open, Created, and Completed. |

## Required regression set

| Suite | Purpose |
| --- | --- |
| `test:scm-transfer-workflow` | The six user-facing workflow regressions and NetSuite PATCH/status contracts. |
| `test:scm-transfer-coverage` | Existing transfer coverage, reservation, proposal merge, and UI contract behavior. |
| `test:order-dependencies` | PostgreSQL-backed dependency lifecycle, exact quantity conservation, optimistic revision/recovery, progress rejection, and immutable reprint history. |
| `mutate:scm-transfer-workflow` | Must kill the global-lock, stale-response, active-tab-search, POST-instead-of-PATCH, missing-progress-gate, and reused-print-key mutants. |
| `syntax:legacy` | Browser and server syntax regression. |
| `test:baseline:mbt:full` | Repository-wide persisted harness inventory; `test:scm-transfer-workflow` is registered in `test/baseline-harnesses.json`. |

## Regression history

| Recorded | RED evidence | GREEN evidence | Release state |
| --- | --- | --- | --- |
| 2026-08-08 | The initial focused suite failed all 9 original scenarios. The later remote-status scenario separately failed before the explicit NetSuite execution gate was added. The direct-pickup over-allocation database scenario also failed before its conservation guard. | Focused suite: 12/12. Mutation suite: 6/6 killed. SCM transfer coverage and order-dependency rollback harnesses passed in the isolated database. | Not deployed by this work item. |
