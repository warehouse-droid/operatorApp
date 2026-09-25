# SOR pause and lock recovery

Spec approval: not obtained (autonomous run under explicit implementation authorization).
Tier 3: concurrency recovery; no dependencies or commits added.

1. Add independent Admin gate `sor_rental_workflow`, disabled by default. Missing gate fails closed. Authorized administrators can toggle with revision and audit protection.
2. Off: no rental metadata refresh, return worker or new signature prompt; SOR deliveries/returns/groups excluded from new planning in both pool implementations. Previously assigned orders, evidence and settings remain readable. Saved signature uploads remain accepted.
3. Existing SOB/PO/TO/driver workflows remain operational. No data deletion or unrelated releases.
4. Deploy gate OFF and restart app before fixing worker. Verify DB-backed login, not just /health.
5. Then fix: return reconciliation commits/releases fleet lock before catalog refresh. Concurrent catalog refresh completes without deadlock; failed refresh retains a durable retry; repeated queue processing creates no duplicates; newer queue versions survive.
6. Keep gate OFF after deploying fix.

Failure model: accidental activation (migration + gate tests); cached/grouped SOR leak (both pool tests); destructive rollback (data counts + additive migration rollback); pool starvation (real independent DB connection during refresh + concurrent lock test); lost refresh retry (failure/retry + queue-version test).
Setup: existing Docker images, isolated internal network and disposable PostgreSQL; existing Node test/Playwright tools; scoped patches over captured live image. Preserve unrelated workspace changes. Full repository suite has pre-existing failures documented in driver-workflow-evidence.md; use focused SOR/gate/workflow regressions and record limits.

Appendix: A worker invoked inside an outer transaction defers until that transaction commits. A rollback discards the deferred work. Existing queue tests are moved from rollback-only wrappers to committed isolated fixtures, preserving their assertions, because catalog refresh now observes committed data.
