# Dispatch PO Reference Projection Consistency Specification

Tier: 3 — a stale cross-date assignment projection can either block all Dispatch additions or allow the same order onto two dates.

Spec approval: not obtained before implementation (autonomous production-incident run).

## Failure model

| Failure mode | Required evidence |
| --- | --- |
| A PO display-reference rewrite advances plan revisions but leaves assignment projections behind | Integration regression reproduces the revision mismatch before the fix and proves zero mismatch after it |
| A routed PO keeps its old identity in the assignment index | Integration regression asserts the old assignment disappears and the new assignment retains its load and stop |
| A snapshot changes while its stored digest still describes the old content | Integration regression recomputes and compares the persisted digest |
| A projection update commits only part of a multi-plan rewrite | The reference rewrite and all affected projections execute in the same database transaction under the fleet-planning advisory lock |
| Another legacy writer creates a stale projection later while the catalog readiness flag still says ready | The recurring catalog worker invokes the idempotent projection backfill without trusting the cached readiness flag |
| Repair overwrites a dispatcher draft or applies SN1399547 twice | Production verification proves the active plan excludes SN1399547 while recovery snapshot 16566 retains it; the index repair does not mutate either snapshot |

## Executable acceptance scenarios

1. Given an active plan whose PO is routed on a load and whose assignment projection matches revision N, when the PO display reference changes, then the snapshot and assignment use only the new reference, the plan and projection both report revision N+1, and the load/stop identity is unchanged.
2. Given an active historical plan that contains the PO card but no route assignment, when the PO display reference changes, then its empty assignment projection still advances to the new plan revision and does not leave the global readiness fence stale.
3. For every rewritten plan, the persisted snapshot digest equals a fresh digest of the stored plan after the rewrite.
4. A subsequent projection backfill reports zero affected plans; the rewrite itself, rather than a later startup, establishes consistency.
5. A recurring catalog pass checks actual projection state even when `assignments_ready` is already true, so an unexpected stale writer self-heals.
6. Existing cross-date duplicate prevention remains fail-closed: no command may treat an unprojected plan as proof that an order is available.

## Setup and constraints

- Use the existing Node test runner, PostgreSQL integration fixtures, ESLint, and secret scanner. Add no dependency.
- Add a focused database integration test before implementation and observe an assertion failure (RED).
- Run tests against the disposable isolated database; never point tests at production.
- Preserve all existing public APIs and the dispatcher recovery-draft behavior.
- Do not commit automatically because the shared worktree already contains unrelated user changes.
- Deployment, if required, uses a new immutable image and a short health-checked cutover with the current image retained for rollback.

## Future-writer prevention addendum

The first incident fix closed the PO-reference writer and made full catalog
refreshes verify reality. The follow-up writer inventory found that lifecycle
and reconciliation paths could still advance a plan revision and depend on a
best-effort after-commit projection refresh. The following scenarios extend the
spec without weakening the original fail-closed duplicate protection:

7. Any direct insert, revision change, status change, or delete on
   `dispatch_plans` invalidates the stored assignment-readiness marker at the
   database boundary. A future writer cannot commit a new revision while
   leaving the marker truthy merely because it forgot application glue.
8. A projection synchronization recomputes global readiness from actual active
   plan/projection revisions in its own transaction. The marker becomes true
   only when no active mismatch exists.
9. Catalog-state reads independently verify actual revision parity. Even if a
   corrupted or legacy caller forces the cached bit true, the API and rollout
   policy report assignments not ready.
10. Confirm, Reopen, and Sales Order reconciliation return only after their
    assignment and relation projections carry the committed plan revision.
    They do not rely on an asynchronous event callback.
11. The ten-second catalog maintenance tick repairs projection drift even when
    there is no catalog refresh row to claim.
12. Before an assignment command rejects an incomplete index, it performs the
    same locked, idempotent repair and rechecks. If the repaired projection
    proves the order belongs to another date, the command returns
    `DISPATCH_ORDER_ALREADY_PLANNED`; it must never proceed as if the order were
    unplanned. If repair cannot establish parity, the original warming-up error
    remains fail-closed.
13. Projection backfill holds the shared fleet-planning lock and row-locks the
    exact plans/snapshots it materializes, preventing a repair from racing a
    concurrent plan save.

Setup addendum: add one additive PostgreSQL migration for the invalidation
trigger; add no dependency. Migration deployment must be followed by the
existing idempotent backfill before the optimized pool is considered ready.
Spec approval was not obtained before implementation (autonomous incident
hardening requested after deployment).
