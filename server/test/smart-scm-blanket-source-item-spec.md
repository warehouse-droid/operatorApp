# Smart SCM Blanket same-source item addition

Assurance tier: 3 (inventory allocation and purchase-source lineage).

## Executable contract

A writable SCM user may add an item to a held, editable Smart SCM Blanket proposal before confirming its release when, and only when:

1. The selected purchase-order line belongs to the proposal's exact `blanket_source_po_id`.
2. The source purchase order is still active, open, and flagged as a Blanket PO.
3. The item is enabled for the selected destination yard and its current Item Master vendor-yard override still identifies the proposal's pickup source.
4. The source-line pallet conversion still matches the Item Master conversion used for planning.
5. The quantity is a positive whole number of pallets.
6. The quantity does not exceed the source line's physical open balance after committed sales allocations, active PO splits, receipts, and reserved/held Blanket releases, less planned allocations in the same planning run.
7. Adding the destination does not violate the pickup route's maximum-drop rule.
8. The same item/destination is not already present in the target load; that existing line must be adjusted instead.

The insert of the proposal line, its exact source allocation, derived proposal totals, plan revision, and audit record is one transaction. A failed check leaves all of them unchanged.

## Failure model

- A client submits a source-line ID from another PO while retaining a valid item ID.
- Search leaks an item from another PO or an item routed to another vendor pickup yard.
- Two requests race for the final source balance.
- Planned quantities in sibling loads are omitted from the available-to-add calculation.
- Reserved or held quantities are treated as reclaimable planning quantity.
- A stale NetSuite conversion causes pallet and sales quantity to diverge.
- A duplicate item/destination bypasses the proposal-line uniqueness rule.
- The source allocation is inserted but proposal totals or the proposal line are not, or vice versa.

## Required evidence

- Integration regression: same-source search and add succeeds; foreign-source and over-available attempts fail without mutation; exact source lineage and quantity conservation are queried from the database.
- UI/server contract: held Blanket cards expose a source-item search and route it through dedicated same-source endpoints.
- Mutation checks: changing the exact source-PO predicate or weakening the availability comparison is killed by the focused regression.
- Fresh Docker run using the isolated MBT database, followed by source-state and disposable-container cleanup.
