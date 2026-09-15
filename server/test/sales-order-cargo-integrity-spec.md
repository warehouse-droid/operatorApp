# Sales Order cargo and grouped item identity — 2026-09-11

Tier 3: this repairs persisted operational cargo. User authorization: use Sales
Order ordered quantities without subtracting NetSuite fulfillment, fix missing
item IDs, and repair SOB119965 in the September 11 plan. Spec approval: not
obtained (autonomous run); these criteria translate the explicit request.

## Acceptance criteria

1. Single and batch Sales Order detail reads retain fully fulfilled material
   lines, zero-quantity nonmaterial lines, original ordered quantities, stable
   line/item IDs, and manual pallet/layer quantities. SOB119965 retains all seven
   lines, including 735.04 sqft / 8 pallets and 61.25 sqft / 5 layers; curb stays 37.
2. Sales Order list, individual, SOV and pickup lookups do not exclude an order
   using ordered minus fulfilled quantity. Existing order-status, location,
   delivery-method and excluded-prefix rules remain. PO/TO filters and live
   fulfillment-posting capacity checks are unchanged.
3. Compact cards retain itemId and lineRowId. Grouping first loads every selected
   compact order, including incomplete nested groups. Failed/missing hydration or
   a changed selection cannot create a truncated group.
4. Adding an unambiguous item ID to an otherwise identical legacy allocation is
   metadata enrichment. Actual item replacement, ambiguous SKU-to-ID mappings,
   quantity changes, child reassignment and stop/driver edits stay protected.
5. The narrow SOB119965 repair restores five falsely inactive source lines and
   the verified cargo in GOB-119964-119965 / plan 323 (2026-09-11). It preserves
   other orders, all stops, driver jobs/progress, packed/loaded quantities and
   NetSuite state. It archives the old plan, increments revision, updates the
   relevant projections and writes an audit. Repeating it is a no-op.
6. Repair preconditions are checked under the shared planning lock and row
   locks. Unexpected order/line identities or quantities abort and roll back.
7. Compatibility refinement from review: a direct local CO owns its own cargo;
   incomplete informational SO/TO children do not block grouping complete CO
   manifests. An aggregate group of COs still requires complete member cargo.

## Failure model and validation

- Partial or excessive repair: exact seven-line source checks, historical cargo
  comparison, narrow writes, invariant assertions, backup and rollback rehearsal.
- Concurrent dispatch save: shared advisory lock, locked current revision and
  atomic archival/update; rehearse before applying to current data.
- Accidental protection bypass: adversarial and property tests for changed IDs,
  ambiguous names/SKUs, quantities and driver prefix regression suite.
- Compact/truncated grouping: executable browser-function tests for all selected
  orders, failed fetch and changed selection; existing grouping harnesses.
- Sync removes cargo again: exercise both detail readers and real read-only
  NetSuite query, then verify persisted data after the deployment and repair.

## Setup

Use existing Docker Node 20, node:test, fast-check, ESLint, TypeScript and V8
coverage. No new dependencies, migrations, commits or external NetSuite writes.
Add focused tests, a repeatable validation/mutation entry point, and a narrow
repair tool. Keep runtime backups and raw operational evidence private in the
ignored backup/artifact directories. Deploy app and webhook worker together.
