# PO item weight refresh

Scope approved by the user's request: refresh POB03658 first, then keep PO item
weights current. Spec approval: not obtained (autonomous run). Use the existing
old-coder evidence workflow, Tier 2 for the metadata fix; the queue's lease and
transaction boundaries receive explicit failure tests. No dependencies, schema
changes, commits, or NetSuite writes are planned. Existing Docker test tools and
temporary PostgreSQL databases will be used. Preserve unrelated worktree edits
and deploy only this task's patch over the running application image.

## Acceptance scenarios

1. POB03658 has 39 lines. The Storm, Platinum, and Dune TV80S lines hold 26.08
   lb/SQFT but live NetSuite item weights are 36.6459. Refresh those three weights;
   every other line field, including quantities and receipt confirmations, is
   unchanged. All 39 saved weights match the live source afterward.
2. Both ordinary and bulk inventory sync detect an active PO line whose weight
   differs from its synced item master. Queue a durable existing PO refresh,
   deduplicated per order. Matching weights, unrelated items, and inactive lines
   or orders do not queue unnecessary work. The queue write rolls back with sync.
3. Every configured delayed PO refresh reads fresh PO lines from NetSuite before
   committing weights. An older webhook's weight therefore cannot remain after
   that check. SO and TO behavior stays intact. Existing callers without the
   optional PO-weight callbacks retain their status-only behavior.
4. Match fresh weights by PO ID, NetSuite unique line ID, and item ID. Change only
   item_weight on active matching lines; preserve source payloads, quantities,
   confirmations, allocations, financial fields, and inventory balances. Duplicate
   line IDs, invalid IDs, negative or nonfinite weights fail before any write.
   Explicit zero and unavailable (null/empty) weights replace an old weight.
5. Use fresh item weights to recalculate PO and split display totals through the
   existing readers. A changed weight produces an audit and the existing mirror
   event. The existing post-commit events refresh Dispatch and SCM catalogs.
6. A failed NetSuite read or write is retried, never acknowledged as success.
   A lost lease cannot update a weight. Failed writes roll back with the job.
   A repeated successful correction changes zero lines and creates no extra
   correction audit. Incoming quantity edits are preserved by the metadata-only
   update, and a changed item identity is never given the previous item's weight.

## Failure model and checks

- Stale source: fresh network read at the existing background refresh boundary;
  test a stale webhook followed by the newer source weight.
- Wrong row or overwritten operational data: real PostgreSQL identity and
  protected-field assertions, including a same-line/different-item case.
- Read failure, partial write, or stale worker: retry, transaction rollback, and
  lease-fencing tests; existing delayed-worker integration coverage.
- Invalid/ambiguous metadata: concrete cases plus generated weights/IDs.
- Inventory/PO lock inversion: inventory sync only enqueues; it never writes PO
  lines while holding inventory locks. Weight application does not write inventory.
- Cached display: real PO/split reader assertions and catalog event wiring.

## Evidence plan and limits

Persist RED, focused regression, changed-line coverage, manual mutation, static
analysis, full-suite baseline comparison, shuffled focused run, source hashes,
dependency/secret scan, live verification and scoped deployment evidence. No
full browser UI change is intended. Background freshness depends on successful
NetSuite reads and the existing queue/sync cadence; exhausted retries remain
visible in the existing job failure records. NetSuite item edits are detected
when the relevant item is next included in inventory sync or its PO refreshes.

Clarification from schema inspection: splits hold their own item_weight copies.
Follow the active split-line ledger (including descendants), using the original
NetSuite PO as refresh identity. Detect child-only drift even if the parent is
already correct. Correct matching active child weights, preserve every other
child/ledger field, and queue catalog refreshes for each changed PO reference.
