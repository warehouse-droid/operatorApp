# Reconciled split receipts and current on-order audit

spec approval: not obtained (autonomous run)

User request: correct the stale 13 PLT for PER-MEL60-COP-RB at 2967 and
check current on-order calculations for all items. The newly created 6-PLT
POB03885 is legitimate separate supply.

Tier 2 calculation fix with production data verification. No new dependencies,
schema changes, Git commits, or NetSuite order writes. Use the existing cached
test image and disposable PostgreSQL runner. Preserve unrelated source changes;
deploy only the changed calculation helper over each service's current image.

## Acceptance scenarios

1. A 546-PC split with zero child receipt counters and an active reconciliation
   allocation of 546 received contributes zero incoming. With 85 available and
   a separate 252-PC NetSuite on-order balance, expected stock is 337 PC / 8.02381
   PLT at 42 PC/PLT. The new 252-PC order remains on order.
2. For partial receipts, remaining equals max(0, ordered minus the greatest of
   cumulative NetSuite received, baseline plus posted local receipts, and active
   reconciled received allocations). These are overlapping evidence, not additive.
3. Only active received allocations for the exact split line count. Fulfillment,
   inactive allocations, unrelated siblings, other items and source residuals
   cannot consume that split's incoming. Deactivation restores outstanding supply.
4. Planner, proposal snapshot, vendor alternative, and newly approved phase
   evidence agree. Existing phase approvals and completed proposals stay immutable.
5. Existing completion, receipt timestamp, closed/cancelled, ordinary relocation,
   same-yard/cross-yard blanket, reservation and over-receipt behavior survives.
6. Audit every current inventory item/yard and planning state using independent
   arithmetic and receipt evidence. Fetch current NetSuite inventory; distinguish
   refresh lag from formula defects. Report counts and unresolved exceptions.
7. Correct stale editable proposal inventory evidence only, preserving manually
   edited quantities, priorities, loads, and actual order/receipt records. Use a
   preview, transaction rollback rehearsal, before-state guards and durable audit.

## Failure model and evidence

- False removal of pending supply: exact-line, sibling, inactive and wrong-progress tests.
- Double subtraction: partial overlap examples and seeded arithmetic properties.
- Screen disagreement: real PostgreSQL calls through every shared consumer.
- Expensive correlated queries: time the complete live item/yard audit.
- Production edits overwriting work: guarded evidence-only updates with audit and rollback.
- Run focused/related suites before and after, types, lint, changed-line coverage,
  manual mutation, reversed test order, secret scan and live comparison. Record
  any skipped layer or baseline failure explicitly in the evidence report.
