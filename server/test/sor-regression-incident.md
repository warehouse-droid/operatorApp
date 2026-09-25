# SOR database lock and regression gap — 24 September 2026

## What failed

The SOR return worker acquired the global dispatch fleet planning lock in a database transaction. Before committing, it awaited immediate catalog refresh. That refresh queued behind another serial-executor task which needed the same fleet lock. PostgreSQL saw a transaction waiting in JavaScript, so its normal database deadlock detector could not break this cycle. Other workers accumulated behind the lock and consumed the app database connection pool. Staff login and other database-backed pages then stalled while static HTTP health remained green.

Incident observations: the first blocker was idle in a transaction for over an hour after a savepoint release, holding both the fleet and catalog advisory locks. Restart restored login, then the SOR worker recreated the blockage shortly after startup. Disabling automatic returns and restarting again stopped the recurrence. The Delivery SO Item Fulfillment gate was not identified as the initiating worker; it could wait behind the same shared lock.

## Why the previous regression missed it

1. **Configuration mismatch.** `tools/sor-rentals-test-env.sh` did not pass `DISPATCH_PLANNER_ORDER_POOL_MODE`. `normalizeDispatchPlannerMode` defaults to `off`; production is `on`. `refreshDispatchOrderCatalogRefsNow` and `dispatchOrderCatalogTick` return early when it is off. The background startup test therefore omitted the live catalog interaction.
2. **Wrong transaction observation.** Queue tests wrapped the worker in rollback transactions and passed empty or throwing refresh callbacks. They tested queue behavior, but could not prove that another database connection could see committed returns or acquire the worker's lock.
3. **Concurrency tested at the wrong boundary.** Existing tests ran concurrent return upserts and conflicting Admin edits. They did not overlap the return worker with the catalog executor. Many passing assertions or line coverage cannot establish correct lock ordering.
4. **Insufficient availability check.** The startup rehearsal waited ten seconds and checked queue drain and `/health`. `/health` only returns static JSON. The built-image smoke also used `app.listen`, which does not start periodic workers. Neither check established login availability under background contention.
5. **Driver regression scope.** The later isolated PWA test exercised real driver APIs and online/offline behavior, but used the same catalog-off configuration and did not exercise SOR background-worker concurrency. Its success did not validate that subsystem.

This was a validation gap in the implementation and release checks. The original evidence overstated assurance for production background concurrency.

## Corrections

- Independent, default-off Admin gate `sor_rental_workflow`; live gate left off. Existing settings, assigned jobs, returns and evidence retained.
- Return writes now commit before catalog refresh. A failed refresh retains a version-guarded durable retry. A nested invocation defers until the outer transaction commits; rollback discards it.
- New independent-connection and serial-executor tests verify lock release, committed visibility, failed-refresh retry, unchanged return identity and queue-version protection.
- The Playwright recovery check explicitly enables catalog mode `on`, signs in through the actual staff page, exercises Admin controls and forces the real SOR Admin-triggered worker and real catalog executor to wait on the same fleet lock. Refresh is not stubbed.
- The exact same production-mode check fails on the pre-fix worker with `SOR/catalog deadlock: production-mode workers did not finish`. This is the deterministic release regression for this incident.
- After the overlap, verify concurrent database-backed login bootstrap requests and a real staff login. Deployment checks now include `/api/auth/bootstrap-needed` rather than relying only on `/health`.
- Deploy validation checks source hashes in both focused and browser reports against the release candidate, and requires the original-code failure evidence.

`/health` remains a liveness endpoint, not a database-readiness signal. These tests prove this particular dependency cycle is detected; they do not prove the absence of every possible concurrency defect. No live NetSuite fulfillment or physical Driver device was exercised in this recovery check.

## Reproduction

With the existing isolated Docker/Playwright test toolchain available, run `sudo -n bash tools/sor-feature-gate-gauntlet.sh` from `server`. Set `SOR_CANDIDATE_ROOT` to the staged release directory to verify that exact source. The command uses a disposable PostgreSQL database on an internal Docker network and never uses the live database. Focused tests, browser checks, syntax/lint/type comparisons and deliberate mutants are implemented in persisted `tools/sor-feature-gate-*` scripts.

The initial ten-second startup check and static health response remain documented as limitations; the new deterministic contention check is required by the SOR recovery release validation.
