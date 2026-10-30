# Delivery to pickup packing release

Tier 3: local operational quantity state and concurrent loading. Spec approval:
not obtained (autonomous run); the user explicitly requested automatic release.

Acceptance criteria (named tests in delivery-pickup-release.test.js):

1. NetSuite Delivery -> Pick-Up releases all five packed quantities, draft
   confirmations, preparing ownership, and obsolete qty_reduced/line_deleted
   warnings; the order becomes open when nothing was loaded. Include inactive
   lines, sales-only quantities, and an unrelated order.
2. Dispatch's local Delivery -> Pick-Up override has the same behavior. A
   NetSuite change hidden by an effective Delivery override releases nothing.
3. Repeated Pick-Up synchronization preserves new pickup packing and creates no
   duplicate release audit. Pickup -> Delivery and unrelated methods do nothing.
4. Partial and complete loaded quantities, fulfillment quantities, source
   quantities, inactive flags, and completed confirmations remain intact.
5. A stale packed header with zero packed quantities becomes open on transition.
6. Every release records before-state in delivery_audit_log in the same
   transaction. Rollback restores method, lines, status, and audit together.
7. Concurrent Operator packing/loading cannot race the transition: use the
   existing order advisory lock, fail retryably when busy. Pending consolidated
   loads reject the method change without altering their evidence.
8. Randomized quantities preserve loaded/source quantities and release drafts.
9. SOA10368 repair is limited to its verified pickup, unloaded, zero-packed
   state, removes stale packing warnings, and records the previous state.

Failure model: accidental shipment (assert no load records/fulfillment writes),
lost completed quantities (exact preservation tests), duplicate release wiping a
new pickup draft (repeat-sync test), half-applied method changes (rollback test),
concurrent load (two database connections), silent changes (audit assertions).

Setup: existing Node test runner, fast-check, ESLint, and disposable Compose
runner; no new dependencies or git commits. Implement a database transition
trigger so sync, webhook worker, and local overrides share one atomic rule.
Add a migration, integration tests, reproducible checks/mutations, and concise
evidence. Tests use only disposable data under mbbs-tests.slice. No bulk repair
of other existing pickup orders. No UI or external NetSuite writes are needed.
