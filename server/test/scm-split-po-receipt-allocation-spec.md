# Split PO receipt allocation specification

Status: implementation contract (2026-08-27)

Approval record: explicit line-by-line approval was not obtained; this is an autonomous repair of the reported split PO calculation defect. Production is read-only during diagnosis, and all mutation tests must use an isolated rollback-only database.

## Failure model (Tier 3)

A source PO may be split into children delivered to different yards. Item Receipt lines remain linked to the source PO line and carry their actual receiving location. The current reconciler first totals the source-line receipt quantity, allocates that total across every split child by plan order, then separately compares every receipt location with only the parent PO destination. A valid receipt for a split child at another yard therefore creates a family-wide conflict after the child quantity was already calculated correctly.

Production witness: split PO `3022019914` has two ledger lines totaling 1,584. Its calculated target is ordered 1,584, received 1,584, remaining 0, and `Completed`; nevertheless the family-wide parent-destination warning changed it to `Reconcile Review`.

## Required invariants

1. Allocate each linked receipt line by its actual receiving location before applying existing split priority rules.
2. A receipt location may consume capacity only from active split targets whose child PO destination equals that location, plus the source residual when the location equals the parent destination.
3. Multiple children at the same destination retain the existing deterministic priority: exact/pinned evidence first, then actual dispatch time, ETA, creation time, and stable reference order.
4. Receipt quantities with no location continue through the conservative legacy allocator using only remaining capacity.
5. Known-location quantity with no matching destination capacity is an allocation conflict and remains `Reconcile Review`; it must never spill into a different yard.
6. Allocation across all location buckets plus unlocated quantity must equal the source line's reconciled received total. Any mismatch or overflow remains review.
7. The child target's current split quantity is the capacity. Immutable requested quantity remains diagnostic evidence but must not permit over-allocation after a legitimate unplanned edit.
8. Fully allocated valid receipts at a split child's destination are not an incorrect-parent-location error.
9. Existing source-line identity, planned quantity decrease, pinned allocation, incomplete split ledger, closed order, and driver completion protections remain unchanged.
10. A family review is created only for genuine unallocated/conflicting quantity; a correctly allocated child is not reviewed merely because its destination differs from the parent.
11. No memo or free-text matching is used.
12. No NetSuite, PO split, dispatch plan, operator, or driver evidence is mutated by the calculation.

## Acceptance evidence

- Unit tests cover two destinations, same-destination deterministic ordering, unlocated fallback, unknown destination, overflow, fractional quantities, and target-order invariance.
- A rollback-only repository integration test reproduces `3022019914`: a parent at yard 3445, a fully received split child at yard 12441, and no false review.
- A wrong-yard receipt remains review in the same integration test.
- Existing SCM reconciliation, split PO, PO/TO schedule, and status-precedence suites pass.
- Lint, type checks, mutation checks, source-state checks, and secret scanning pass.
- Deployment is excluded until separately requested.
