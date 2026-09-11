# NetSuite IR split-reference reconciliation specification

Spec approval: not obtained (autonomous run following the user's direct request).

## Scope

Use the split-child reference recorded in a NetSuite Item Receipt memo as
stronger allocation evidence than the receipt yard. This applies only to PO
split children belonging to the same source PO. Existing TO, unsplit PO, and
IR-without-reference behavior remains unchanged.

No new dependency is allowed. Migration 196 may add one nullable text column
for the durable IR memo. No git checkpoint commits are authorized.

## Failure model

- A memo names a child from another source PO or a cancelled child.
- A memo contains two different child references.
- Two active targets expose the same current or historical alias.
- An IR line names a child that does not contain that source item line.
- Referenced receipt quantity exceeds that child's line capacity.
- Product and pallet lines are posted in separate IRs for one child.
- A stale snapshot has no memo and must retain the existing location policy.
- Reconciliation overwrites a user-authoritative HOLD/completed status or
  split-child location.
- A retry stores a stale IR snapshot over newer evidence.

## Executable scenarios

1. `SN1398749 (for pallet)`, lowercase variants, and whitespace variants each
   resolve to the one active `SN1398749` target.
2. A memo with no `SN` reference is classified as absent and uses the existing
   destination allocator.
3. A memo with an unknown, cross-source, cancelled, or multi-reference value is
   fail-closed and produces a reconciliation review reason.
4. A reference shared by two candidate target aliases is ambiguous and cannot
   allocate receipt quantity.
5. A correct memo allocates a wrong-yard IR line exactly to its named child,
   provided the source line/item and quantity fit that child's split ledger.
6. Multiple IRs may bind to one child only while cumulative per-item receipt
   quantity stays within its ledger capacity; separate pallet IRs are valid.
7. Excess referenced quantity remains unallocated and forces review.
8. The linked-transaction SuiteQL projection imports `event_t.memo`; snapshots
   persist it durably and expose it to reconciliation evidence.
9. Applying exact reference evidence does not change split-child location and
   preserves user-authoritative HOLD status.
10. Current production families are first evaluated in a rollback-only dry
    run. Only results with zero ambiguity, zero overflow, unchanged locations,
    and expected statuses may be applied.
11. Historical non-`SN` aliases containing regular-expression punctuation are
    treated as literal, bounded references, and older nested snapshot memo
    shapes remain readable during migration/replay.
12. A BWS blanket source whose IR memo has no usable child reference may fall
    back to a matching split destination even while the user keeps that child
    on HOLD. If more than one unfinished child for the item can consume the
    same location evidence, the quantity remains unallocated for review.
13. Replaying reconciliation after a later source-PO refresh and creation of a
    new HOLD split child leaves historical referenced receipts on their
    original child; the new child starts at zero and the old location conflict
    does not reappear.

## Failure gates

- Unit, integration, property, migration, and NetSuite query-contract tests.
- Changed-line coverage for the pure reference matcher/allocation policy.
- At least five meaningful manual mutants, all killed.
- Syntax, lint, typecheck, dependency tree, and secret scan.
- Existing reconciliation and full MBT suites must add no failures.
- A post-deploy production audit must show no open false location reviews and
  no newly changed split-child locations.
