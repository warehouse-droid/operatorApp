# Smart SCM proposal line ordering

Spec approval: not obtained (autonomous run). Implements the requested ordering without a separate approval stop.

Tier 3: order submission. Failure model: a reorder could change quantities or pricing, lose an ancillary PALLET, use an obsolete row set, overwrite another SCM user's order, or display a different order from NetSuite. Validate a complete permutation, lock the proposal and compare the prior order, preserve payload objects, retain the order during vendor staging, and test the browser and database boundaries.

## Acceptance scenarios

1. Given three material lines followed by PALLET, dragging PALLET above the third material line saves `[material 1, material 2, PALLET, material 3]`. Both the proposal and Vendor Replies show this order after reload.
2. Editable PO and TO proposals and editable Vendor Replies provide a drag handle, row numbers, and keyboard ArrowUp/ArrowDown movement. A drop can only move rows within the same load. Input values remain in place while saving the order.
3. Saving an order changes only the order and audit metadata. Material IDs, quantities, prices, destinations, pallet overrides, totals, and reservations remain intact.
4. Duplicate, missing, foreign, malformed, or excessive line keys are rejected before any persistent change. An outdated expected order is rejected with HTTP 409. Locked, executing, completed, cancelled, superseded, or linked NetSuite orders cannot be reordered locally.
5. A vendor confirmation retains the requested material/PALLET order in its review child and outgoing purchase order, including multiple destinations and partial confirmation. A zero-quantity PALLET is omitted without disturbing other lines.
6. TO submission retains the same order, including its physical PALLET line. Existing dependency transfers without a saved order retain their current behavior.
7. A synced NetSuite PO is displayed in its NetSuite line sequence, with PALLET interleaved, even when permanent NetSuite line IDs are out of order. Inactive lines stay absent; quantities, prices, and confirmation evidence remain intact.
8. Adding or removing lines retains the relative order of surviving keys and adds new keys once. Reapplying an order is idempotent. Unknown saved keys do not remove current rows.
9. Legacy proposals with no saved order keep the existing material-then-PALLET order. Existing SCM vendor, proposal, financial, and transfer tests must have zero new failures.
10. The additive database migration is idempotent and permits the legacy empty order. Migration application and rollback are rehearsed against a disposable database.

Clarification during implementation: the held vendor child also retains the relative PALLET/material order from its parent (scenario 5), and TO preparation is verified against the real repository before the payload is built (scenario 6).

## Setup and scope

Use the installed Node 20, node:test, fast-check, ESLint, TypeScript, c8, and Playwright tools in the existing test images. Add no dependencies, make no commits, and do not change a running production app or real NetSuite records. Add a shared ordering helper, drag interaction, authenticated reorder endpoint, a JSON order column, regression/property/database/browser tests, and a reproducible check entry point. Preserve the workspace's existing unrelated edits; capture touched-file baselines for review and changed-line coverage.

## Deployment authorization and acceptance

On 2026-09-30 the user explicitly requested deployment with a short cutover. This authorizes the scoped app release and additive line-order migration, superseding the implementation phase's local-only deployment scope. Construct the release over the current live app, preserve unrelated live features and service configuration, validate the exact candidate before switching, apply only `244_smart_scm_line_order.sql`, retain the previous app image for rollback, and verify the public page/assets, schema, authentication and PALLET sequence after cutover. Do not create or modify real NetSuite orders to verify the release.
