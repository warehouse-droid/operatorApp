# PO/TO Schedule loading performance specification

The user approved this specification on 2026-08-28 by requesting: test first,
then code, then deploy; target two seconds; Completed jobs may be skipped unless
the selected statuses explicitly include `Completed`.

## Executable scenarios

1. **Default load omits completed work**
   - Given an active PO with canonical dispatch-completion evidence
   - When PO/TO Schedule is loaded without a status filter
   - Then the completed PO is absent and an otherwise equivalent queued PO is present.

2. **Completed is an explicit opt-in**
   - Given queued and completed POs
   - When status includes `Completed`
   - Then the completed PO is returned.
   - When status includes both `Queued` and `Completed`
   - Then both POs are returned.

3. **Planned status comes from the assignment projection**
   - Given a live PO assigned to a non-cancelled plan in
     `dispatch_plan_order_assignments`, with no snapshot JSON
   - When the schedule is loaded
   - Then it is Planned and retains projected date, time, driver, truck and load.

4. **Historical snapshot volume is outside the request path**
   - Given 1,000 historical/future plan dates containing legacy snapshot JSON
   - When one active PO is loaded
   - Then schedule lookup does not scan `dispatch_plan_snapshots` and completes
     in less than 2,000 ms after warm-up.

5. **Route-option lookup is bounded**
   - Schedule route locking must use indexed assignment/schedule evidence and
     must not search serialized `snapshot.trucks` text.

6. **Closed-order families are evaluated once per load**
   - PO and TO closed-family identities must be projected as set-based CTEs.
   - The schedule query must not execute a correlated family predicate once
     for every visible order.

7. **A fully split source PO is absent from active PO/TO Schedule**
   - Given an active source PO with 12 pallets and active split children
     allocating all 12 pallets
   - When the normal PO/TO Schedule is loaded
   - Then the source PO is absent while each split child remains available.
   - When one split is cancelled, only that split's quantity returns to the
     source row; when all splits are cancelled, the full source quantity returns.
   - An active PO with no mirrored active source lines remains visible because
     missing line evidence cannot prove that its quantity was fully split.

## Invariants

- Exact-reference search remains case-insensitive.
- Completed history remains available through explicit Completed selection.
- Explicit Completed history remains queryable even when the active source
  residual is zero.
- Cancelled plans cannot mark an order Planned.
- PO, TO and VRMA kind identity is preserved.
- Existing column filters and response fields remain compatible.
- No new runtime dependency or public endpoint is introduced.

## Setup and verification plan

- Use the existing Node test runner, PostgreSQL test container, c8 and ESLint.
- Add no dependencies.
- Persist a task-specific gauntlet, mutation runner and source-state command.
- Measure the optimized code against both synthetic 1,000-plan history and the
  deployed production-sized dataset before accepting the release.
- Build rollback-tagged Docker images before deployment.
