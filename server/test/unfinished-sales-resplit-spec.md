# Unfinished Sales Order split specification

Spec approval: not obtained (autonomous run). Tier 3: durable fulfillment, quantity conservation and concurrent operator/driver changes.

User scope: split SOA09143-S2 further while retaining completed S1. No extra buttons: reuse the existing split-order action and existing quantity editor. Never execute a real order split as a test.

Acceptance:
1. S1 contains 30 PALLET units and 1 charge, completed in a grouped October 2 delivery with retained driver photos. Open S2 contains 106 PALLET units and 3 charges. Splitting S2 into three parts creates root-family S3, S4, S5 and retires only S2.
2. Every source item quantity and packing-unit total is conserved within 0.000001. Reject unknown/duplicate lines, empty children, nonfinite/negative quantities, incomplete or excess allocations and stale source quantities. Children inherit canonical item identities, conversions, address overrides and instructions.
3. Completed/started driver work, immutable completion, actual packing/loading/fulfillment/receiving, current planning, pending posting/reload/consolidation, closed/inactive orders and structural dependency conflicts on the selected S2 still block. S1's activity and links do not block S2.
4. Completed S1 definitions, grouped card, route stops, driver records/photos, assignments and operational records remain intact. S2's replacement and new definitions/materialization commit atomically.
5. Numbering includes global-only, materialized and retired siblings. Never reuse a suffix or create nested S2-S1 references. Exact retry returns the same children without resetting subsequent work; a different retry fails.
6. Existing HTTP access and edit-lease requirements apply. Server recalculates status after acquiring shared fleet and operator locks. Concurrent operator packing/driver completion cannot be bypassed.
7. An unfinished split uses the existing action slot and editor; packed/loaded split guards remain. Original first-level splitting remains compatible.

Failure model: quantity inflation/loss -> examples plus randomized conservation and adversarial inputs; history erasure -> byte-for-byte S1 snapshot/route/evidence checks; race/stale browser -> PostgreSQL lock races and quantity fingerprints; duplicate numbering/retry -> persisted retry and global-only suffix tests; partial writes -> forced transaction failure rolls back retirement and children; unauthorized action -> real HTTP role/lease tests; UI context drift -> browser selection/quantity/editor tests.

Setup: use captured live source, surgically mirror changes into the dirty workspace, add focused tests and reproducible evidence scripts. Use existing Node/PostgreSQL/Playwright/c8/TypeScript/ESLint/fast-check tooling and the bounded disposable standard Compose configuration. No new dependencies, git commits or migrations planned. Persist code/logs/evidence; remove every test container, database volume and unused test network in registered teardown, and verify both Docker listings and live health. Deploy only tested file overlays on the exact live image with rollback retained.

Visible fixture correction after first green run: the browser fixture's current plan includes a completed S1 stop, so its save must retain S1 alongside S3-S5 (the earlier expected array incorrectly omitted it). The rollback check now uses the actual PostgreSQL numeric text representation `109`, preserving the same exact-quantity assertion. No production assertions were weakened. Also explicitly test stale native S2 quantity, even when the global definition has not refreshed, and malformed plan IDs.

Append-only clarification: the browser compares the normalized pre-split save payload's trucks against the post-split payload, since rendering already normalizes legacy route fields. Exact preservation remains required. Each converted child's sales quantity must also match its own canonical packing-unit conversions; duplicate canonical source line identities are rejected.

Additional adversarial and lifecycle checks: expired edit leases are rechecked after shared-lock waiting; failed HTTP resplits leave the browser order and route intact; operators lack Dispatch write authority; selected S2 PO links block, whereas completed S1 PO links remain unchanged. Browser route comparison uses its JSON wire representation so omitted `undefined` metadata is treated consistently.

Mutation audit: the numbering mutant was killed by example tests but initially survived the property tests. Strengthened the existing property to require the exact next suffix for every child and strengthened the preserved-history fixture to compare S1's native header/lines as well as its global definition. These are stricter applications of the existing numbering and history invariants; no assertion was weakened.
