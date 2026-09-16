# Persist NetSuite orderLine for incomplete PO / SO / TO

Tier 3: line identity controls inventory transactions.
Spec approval: not obtained (autonomous run). The user authorized schema,
incomplete-order synchronization, and the sending/receiving webhook changes.

## Acceptance criteria

1. Add nullable `netsuite_order_line` to sales, purchase, and transfer order
   lines. It stores a positive, safe integer REST source-sublist identifier,
   independently of the existing stable `line_id`. Never derive it from array
   position, item/SKU, a unique line key, or the historical TO offset.
2. Add `netsuite_order_line_synced_at` so a backfill can distinguish observations
   and avoid replacing a newer webhook mapping. Migrate twice safely; existing
   unknown mappings remain null. Invalid non-positive database values fail.
3. Sync readers, reconciliation mappers, canonical upserts, and mirror snapshots
   carry the mapping for SO, PO, and both TO stages. A legacy payload that omits
   it preserves a known mapping; a changed stable line identity cannot retain
   its predecessor's mapping. Conflicting explicit identifiers fail closed.
4. Both direct and scheduled NetSuite senders emit `orderLine` from the item's
   actual `line` field, independently from `lineuniquekey`. Missing line values
   remain unknown. The application receiver persists the supplied mapping.
5. Transfer accounting/receiving rows map to their exact visible source anchor;
   repeated items remain distinct. Ambiguous mappings are reported, not guessed.
6. Refresh mappings for incomplete NetSuite PO/SO/TO orders with bounded batches,
   an inspectable dry run, restartable apply, and per-kind coverage totals. Save
   mappings only after exact source order, stable key, and item identity match.
   Include applicable local split descendants through their source-line ledgers.
7. Backfill modifies mapping fields only: operator packing, confirmations,
   receiving/fulfillment progress, planning, quantities, and statuses remain
   unchanged. No NetSuite transaction is created or edited for verification.
8. Existing IF/IR posting validation remains unchanged in this task. This is the
   prerequisite storage/sync change; it does not enable direct posting.

## Failure model and verification

- Wrong line after reorder / repeated SKU / TO accounting rows: exact-key mapping
  unit/property tests and read-only comparison against REST source sublists.
- Legacy webhook erases mapping / rekey retains wrong mapping: database upsert
  and webhook integration tests, including missing/malformed/conflicting fields.
- Backfill races a webhook or writes another source: conditional database updates,
  transaction tests, and idempotent repeated application.
- Migration or deployment loses existing work: additive schema, isolated migration
  rehearsal, before/after progress checks, app/worker image rollback.
- Partial backfill appears complete: explicit unresolved/conflict counts and
  durable results, verified against final database coverage.
- Sender code does not run in NetSuite: execute both SuiteScript entry points in
  the VM harness with mocked NetSuite boundaries; report actual deployment access.

## Setup and evidence

Use existing Docker Node 20/PostgreSQL test images, TypeScript, ESLint, c8, and
fast-check. No dependency changes, git reset, or checkpoint commits. Preserve
the pre-existing dirty workspace with a complete non-secret source snapshot.
Add tests, a repeatable gauntlet, mutation script, mapping backfill CLI, deployment
helper, and evidence under `test-artifacts/order-line-storage`.
Run failing behavior tests before implementation, targeted and full regression
against the captured baseline, static checks, changed-line coverage, independent
property mutation runs, and a read-only live rehearsal before authorized apply.
Any unavailable external NetSuite script deployment is reported explicitly with
the exact prepared files and remaining step.

Fixture correction: the progress-preservation scenario uses `received_piece_qty`
for PO and `packed_piece_qty` for SO/TO. PO has no packed quantity column; the
original fixture failed on that nonexistent column after storing the mapping.
The expected preserved operational quantity remains exactly 3.

Backfill fixture correction: transfer lines require `line_stage='outbound'`.
After supplying it, the migration test passes and all six unimplemented backfill
tests fail on behavior. Discovery preserves the established SOT exclusion policy.
Discovery fixtures use SOBTEST instead of SOTEST, which legitimately matched
the SOT exclusion; all 21 expected incomplete status/type combinations remain.

Live rehearsal found NetSuite Subtotal rows (including a legacy null item ID).
Report these as non-fulfillable exclusions. Missing inventory identities remain
unresolved. A real HTTP reader test caught transfer destination rows surviving
the local source-location filter after fetching all anchors; the filter now
enforces location and direction together, with a recorded RED/GREEN regression.

## Inactive local source lines

The live coverage audit found SOV02280 pending fulfillment in NetSuite with all
five local source lines inactive. Backfill must cache exact NetSuite mappings on
these rows without changing their status, quantities, or any other progress.
Inactive historical rows absent from the authoritative source are reported as
excluded; identity ambiguity or item mismatches remain unresolved. The update
also compares the observed active flag so a concurrent retirement wins.

The added unit and real-database SO/PO/TO assertions failed before this correction
(`red-inactive-source.log`). Existing inactive receiving history remains excluded
by the other thread's IR validation fix; storing a mapping does not reactivate it.
