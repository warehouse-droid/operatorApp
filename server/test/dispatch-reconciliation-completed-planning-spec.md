# Reconciliation-completed Dispatch planning specification

Status: implementation authorized by the user on 2026-09-08. The specification was written before implementation; separate interactive approval was not available during the urgent autonomous repair.

## Incident

NetSuite reconciliation can calculate a PO/TO target as `Completed` because its receipt quantity is fully allocated while also recording `operationallyCompleted: false`. Dispatch currently treats the calculated label as proof that delivery happened. The order is returned by explicit search as read-only and every plan save/confirm path rejects it. `SN1399744` is the production replay: its persisted schedule is `Queued`, it has no active plan, no Driver job, and no canonical Dispatch completion, but its reconciliation target is `Completed` from inferred receipt allocation.

## Required behavior

1. An explicit Dispatch search may return a PO/TO target whose accepted/current reconciliation target is `Completed` and whose target evidence says it is not operationally completed.
2. Such a row is marked `dispatchReconciliationPlanningEligible: true`; it is not marked `dispatchPlanningRestricted`, and the UI permits drag/drop.
3. Targeted order hydration used by save/refresh commands must resolve the same row, including when it is outside the default 500-order pool.
4. All save, restore, legacy-save, and confirm guards allow that exact target while it remains reconciliation-only complete.
5. A Driver can start and complete the resulting physical visit through the ordinary Driver PWA. Required photos are written to `driver_job_records`, the ordinary immutable Dispatch completion projection is created, and supplemental completed-stop photos remain append-only through the existing evidence API.
6. As soon as a genuine Driver completion exists, the target is no longer reconciliation-only: explicit search may show it, but it is search-only and every new planning attempt is rejected.
7. Blanket orders, Hold, Cancelled, reconciliation Review/Missing/Pending, hidden targets, manually/operationally completed targets, non-MBT schedules, and genuinely NetSuite-closed orders remain restricted.
8. Read eligibility never changes SCM schedule status, reconciliation state, receipt allocation, split lineage, locations, Driver records, or completion evidence.

## Failure model

- Treating quantity reconciliation as proof of physical delivery strands unplanned inbound children.
- Broadly reopening every `Completed` row permits duplicate Driver delivery and duplicate photos.
- Checking only direct references misses completion inherited through active split/group lineage.
- Search succeeds while targeted mutation hydration fails, causing a drag/save race that still rejects the row.
- A reconciliation replay after planning or after Driver completion reopens a genuinely completed visit.
- Stale catalog or schedule `Completed` values bypass the canonical Driver-completion boundary.
- Relaxing the generic restricted-order guard accidentally reopens Hold, Cancelled, blanket, non-MBT, review, or NetSuite-closed orders.
- Driver completion succeeds but the completed-visit record is absent, preventing supplemental photo evidence.
- Concurrent/replayed Driver completion or photo append overwrites existing evidence instead of remaining idempotent and append-only.

## Observable invariants

- Eligibility requires a reconciled PO/TO target with application status `Complete`/`Completed`, non-blocking reconciliation, `hidden != true`, `preserveOperationalStatus != true`, and `operationallyCompleted != true`.
- Eligibility is bounded to requested target references and is denied if the canonical completion projection or Driver-PWA completion closure contains the reference.
- The operational schedule may stay `Queued`/`Hold`; reconciliation presentation may stay `Completed`. Dispatch eligibility is a separate fact.
- A genuine Driver completion always wins over reconciliation-only eligibility.
- Existing completed-stop photo validation, limits, state hashes, immutable addition ledger, and replay rules are unchanged.

## Verification

- RED/GREEN HTTP integration replay for a reconciliation-only completed PO target and ordinary completed PO/TO controls.
- Repository integration tests for eligible, blocking-state, canonical-completion, and Driver-completion cases.
- Static wiring checks for search annotation, targeted hydration, and every restricted-order guard.
- Existing Driver completion split-isolation, POB03658 lifecycle, and completed-stop photo append suites.
- Production read-only replay for `SN1399744` before and after cutover.
