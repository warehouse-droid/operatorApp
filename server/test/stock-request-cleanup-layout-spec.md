# Stock request cleanup and layout — 2026-09-27

Spec approval: not obtained (autonomous run). Cleanup scope explicitly approved by the user: application SPREQ records only; retain closed NetSuite orders.

## Executable requirements

1. Remove only request IDs 57–64, SPREQ-000002–SPREQ-000009, and their owned case/line/event/handoff/document-cache rows. Preserve every other request, local mirrored SO/PO, and every NetSuite transaction. Never submit or retry an order operation.
2. Save a complete private, durable backup before deletion. Lock the selected records and compare the complete snapshot with the backup before deleting atomically. Reject missing/replaced identities, changed dependencies, active order operations, transfers, or media requiring external cleanup. Rehearse deletion and restoration inside a rolled-back transaction before committing.
3. Search and filters share a row at desktop widths on Sales and SCM stock request pages. Small screens may wrap without horizontal overflow. Yard filters allow multiple checked yards and clearing the selection. Empty means all authorized yards.
4. Special yard filtering accepts validated plural IDs and intersects the existing Sales authorization. SCM may filter all yards. Regular From/To yard filters also support multiple yards. Preserve existing singular API parameters and single-yard validation.
5. On Sales Special details, SO and PO references appear directly after the first request summary, without duplicate reference sections. Sales retains SO preview only. Once an SO exists, hide Case lines even if no PO exists and even after closure. Keep pre-SO lines, adjustments, fulfillment details, and SCM previews available.
6. Filtering must preserve batched queue reads and loaded-card selection behavior. Do not modify monetary calculations, create/edit/close orders, or add periodic refreshes.

## Failure model and evidence

Tier 3: data deletion and authorization intersection. Risks: broad deletion, stale backup/concurrent edits, partial deletion, unrecorded cascades, restoration failure, order mutation, authorization widening, queue regression. Guard with an exact manifest, inbound FK inventory, transaction locks/timeouts, snapshot hashes, rollback rehearsal/restoration equality, preserved-record hashes, and real PostgreSQL checks. Use RED then GREEN filter/access assertions, property checks, representative manual mutants, syntax/lint/type checks where useful, and browser checks at desktop/mobile widths. Record skipped layers and reasons in evidence. Only scoped runtime files are deployed over the current image.
