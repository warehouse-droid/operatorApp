# SCM PO Group Rollup Recovery Specification

## Scope

Repair stale synthetic Purchase Order group reconciliation state without
changing NetSuite evidence, receipt quantities, split allocations, or member
operational status.

## Failure model

1. A member review is resolved, but its `PGOB-*` schedule stays blocked because
   the manual resolution path does not recompute affected groups.
2. A group rollup calculates a terminal result but fails to persist recovery
   from the legacy `Reconcile Review` status.
3. A rollup overwrites a legitimate operational status such as `In Transit`.
4. A partial failure resolves the member but leaves the group stale because the
   two changes are not in the same transaction.
5. The grouped UI treats a synthetic `PGOB-*` reference as a real Purchase
   Order, exposes invalid source-line actions, or displays the first member's
   complete parent PO lines as group lines.
6. A repair command targets the wrong group or member set.
7. A retry rewrites an already-correct group and creates needless schedule or
   audit churn.

## Executable scenarios

### Scenario 1: Manual member resolution repairs a stale completed group

Given a two-member active PO group whose members are both completed, and one
member's last blocking review is accepted, while the persisted group is the
legacy `Reconcile Review`/blocked state, when the resolution commits, then the
member review is resolved and the group becomes `Completed` and unblocked in
the same transaction.

### Scenario 2: A real blocking member keeps the group blocked

Given any active group member remains reconciliation-blocked or has review,
missing, or error reconciliation state, when the group is recomputed, then the
group remains blocked and a legacy `Reconcile Review` status is not cleared.

### Scenario 3: Operational group status is preserved

Given a group is `In Transit`, when its calculated rollup is `Completed`, then
the stored operational status remains `In Transit`; completion remains the
separate calculated status.

### Scenario 4: Legacy system status is recovered only when safe

Given the stored group status is `Reconcile Review`, when no member remains
blocked, then the stored status becomes the calculated rollup status. Any
other stored operational status remains unchanged.

### Scenario 5: Group repair is scoped and idempotent

Given an exact group reference and exact expected member references, when the
targeted repair runs, then only that group schedule may change. A mismatched
member set fails before mutation, and a second repair makes no write and emits
no additional repair audit event.

### Scenario 6: Synthetic group details are safe and truthful

Given a synthetic PO group is expanded in PO/TO Schedule, then its aggregate
totals and per-member summaries are shown, the first source PO's lines and
allocations are not presented as group-owned data, and retry, resolution, and
source-line adjustment actions are not offered on the synthetic reference.

## Invariants

- Member schedule statuses are not downgraded or overwritten by group repair.
- `purchase_order_lines`, receipt snapshots, reconciliation line quantities,
  and reconciliation allocations are unchanged.
- Existing grouped-PO behavior that preserves active operational statuses and
  avoids rewrites on exact retries remains green.
- Group and member resolution changes share the existing database transaction.
- No schema migration or new runtime dependency is introduced.

## Setup and gauntlet

- Use the repository's existing Node test runner, PostgreSQL rollback harness,
  c8, ESLint, TypeScript check, secret scanner, and Docker test image.
- Add a focused integration harness, pure unit/property tests, UI contract
  coverage, a persisted manual-mutation runner, source-state script, and one
  gauntlet entry point.
- Run tests against an isolated database created from every current migration.
- Production repair requires the exact group and member set, performs an
  audited transactional recomputation, and does not call NetSuite.
- New dependencies: none.

Spec approval: not separately obtained; execution proceeds autonomously from
the user's explicit request to fix this order and prevent recurrence.
