# Operator responsiveness and SOR replay, 24 September 2026

Scope: customer-pickup status feedback, Packed-list updates, and the paused SOR return workflow. User authorized isolated replay of all SOR orders and dummy test addresses. No live order address edits, NetSuite writes, new dependencies or commits.

## Findings and fixes

- Packed previously depended on a warm, current-yard cache. A server-confirmed packing result now inserts into the current yard's Packed list immediately, including a cold cache. Stale requests cannot remove it or expose another yard's orders.
- Pickup posting reads its authorized job status immediately and wakes on that job's completion event. Events trigger a status read; they never claim success themselves. A one-second fallback remains.
- A rejected Mark Packed request escaped its click handler's catch because the promise was returned without awaiting it. The server error is now visible and the order remains outside Packed.
- SOR collections were persisted as delivery splits. Replaying those definitions could remove the parent delivery and cancel its valid return. Rental collections now remain derived custom orders; migration 224 repairs only their definition metadata, retaining return IDs/status/cargo and assignments.
- Delivery source refresh also copied the delivery's `Rental` pickup into old collection definitions. The actual planner HTTP save succeeded, but confirmation failed after an extra pickup was inserted. Source refresh now excludes SOR collections, and canonical custom-return route/cargo take precedence over those stale definitions. Real sales splits still refresh.

## Why old orders triggered the outage

The SOR reconcile triggers run on ordinary header/line updates and planning/definition changes, including unchanged background upserts. A new SOR order was not required. At the incident the worker held the fleet lock while awaiting a catalog executor that needed the same lock; PostgreSQL could not detect the JavaScript side of the cycle. The pool exhausted and login stalled, while static health remained OK. The lock fix was already live before this release.

SOR00188 is the last successfully audited job at `2026-09-24T11:24:08.772495Z` (one cancellation). The next blocked source reference was not captured, so this is not proof that SOR00188 itself held the fatal lock.

Earlier regression missed production catalog mode, used mocked catalog callbacks and rollback transactions, and checked static health. The new runner uses real commits, real catalog mode/executor, forced fleet-lock contention, and authenticated staff login/database bootstrap probes. The pre-fix worker demonstrably fails that contention replay.

## Timings from the live database

Command creation through completion, collected through `13:41:59Z`:

| Operator pickup window | Completed | Median | P95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Before crash (Sep 23 to Sep 24 11:24Z) | 33 | 3.735 s | 23.153 s | 58.530 s |
| After recovery (12:36Z onward) | 20 | 3.706 s | 21.187 s | 23.620 s |
| After the first five recovery minutes | 15 | 3.326 s | 6.475 s | 8.423 s |

The latest inspected pickup spent about 4.7 s validating, transforming and verifying in NetSuite; local finalization was 64 ms. UI changes remove additional polling/list delay, not that external processing time. Requests stalled before command creation are absent from this metric, as are upload/rendering times.

Recent successful background Driver fulfillment had median 20.484 s (5 completed, 1 uncertain, 2 gate-disabled). The 20 pre-crash candidates were all gate-disabled, so there is no comparable successful baseline. Historical Driver HTTP/device duration evidence was unavailable; job start-to-completion includes travel and physical work and was not used as button response time.

## SOB120921-S1 uncertain

Read-only external-ID lookup found fulfillment **IF155073**, internal ID **1010888**, for command `1ba4e0ce-e7a3-4ae7-b38e-14b28cd01c5e`. All six requested physical lines match the requested quantities and location. NetSuite also returned line 10, item 4646 **Sales Credit - Hardscaping**, NonInvtPart, quantity 1. Strict recovery verification rejected that unexpected positive line. The candidate remains uncertain; no duplicate fulfillment was posted and no existing NetSuite transaction was changed.

## Reproduction and evidence

Run `bash tools/operator-responsiveness-gauntlet.sh` against the scoped captured candidate. It creates internal-network test databases; the historical private SOR snapshot is required for exact reproduction. Reports are under `test-artifacts/operator-responsiveness/` and `test-artifacts/sor-rentals/`. The snapshot hash and per-source hashes are recorded. The live SOR feature and legacy returns switch remain off.

73 focused tests and 25 real Operator Playwright tests pass. All 8 behavioral mutants are detected and all 38 changed executable lines are covered. Two failures in the broader global-order suite also occur on the unchanged live baseline; this release does not claim that the full repository is green. Lint remains at 876 baseline diagnostics and types at 236, with no new diagnostics.

All 137 SOR orders (365 lines) pass the production-mode replay, including forced contention and unchanged-source sync. Every currently eligible delivery (23) and return (21) is saved, confirmed and completed through the installed Driver PWA. A subsequent sync of all 137 preserves all 21 completed return rows exactly. See [SOR replay evidence](sor-all-orders-replay-evidence.md) for isolation, substitutions and limitations.

## Deployment

Deployed to `test.mbbsoperation.com`; the application container started at `2026-09-24T14:39:09.573546281Z`. Image: `mbbs-operator-app:operator-responsiveness-20260924-v1`, ID `sha256:5e6759e8ec10c0b7dcb3deeb1c30ee94d82b8a9b878319750211615503bfc945`. Only the application container restarted; database, webhook worker, Ollama and runtime configuration are unchanged. All 1043 expected source hashes match the scoped candidate.

Migration 224 repaired the legacy SOR return definition metadata. Both SOR switches are off. All 14 live return rows are identical to their pre-deployment capture (13 open, 1 cancelled); live addresses were not edited. Post-deployment database checks found 0 lock waiters and 0 old idle transactions.

Public bootstrap, Operator, Driver and SOR Admin pages returned HTTP 200. The public login handler rejected a random nonexistent account with the expected HTTP 401 in 78 ms; this checks the real database path, not any user's password. Local equivalents and deployed public asset hashes also passed.

Private deployment reports and rollback/source captures are under `/home/ubuntu/operatorapp-deploy-backups/operator-responsiveness-20260924-v1`.

A disposable Playwright container also checked the deployed public staff and Driver login screens at `2026-09-24T14:41:50.587Z`. Staff login painted in 312 ms, nonexistent credentials displayed a usable error, reload worked, and there were no page errors or HTTP 500 responses. This public check uses no real account credentials; successful authenticated staff/Driver flows are covered in isolation. The Driver page is checked using DOM/visible-form readiness because its background connections prevent network-idle readiness.
