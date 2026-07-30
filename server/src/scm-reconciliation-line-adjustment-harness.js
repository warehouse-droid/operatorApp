import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  listScmPoSplitLineAdjustmentOptions,
  reassignScmPoSplitLineSource
} from "./scm-reconciliation-repository.js";

const rollback = await beginRollbackContext();
const seed = Number(String(Date.now()).slice(-8));
const sourcePoId = 9000000000 + seed;
const splitPoId = -(9000000000 + seed);
const sourcePoRef = `PO-LINE-ADJUST-${seed}`;
const splitPoRef = `${sourcePoRef}-S1`;
const oldLineKey = 9100000000 + seed;
const candidateLineKey = 9200000000 + seed;

try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, status, status_text,
         receipt_status, netsuite_active, synced_at
       ) VALUES
         ($1, $2, DATE '2026-07-30', 'B', 'Purchase Order : Pending Receipt',
          'not_received', true, now()),
         ($3, $4, DATE '2026-07-30', 'B', 'Purchase Order Split',
          'not_received', true, now())`,
      [sourcePoId, sourcePoRef, splitPoId, splitPoRef]
    );
    const sourceLines = await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity,
         netsuite_received_qty, netsuite_received_baseline_qty,
         received_sales_qty, unit, location_id, location, netsuite_active,
         raw
       ) VALUES
         ($1, $2, 1784, 'PALLET', 'PALLET', 26,
          0, 0, 0, 'EACH', 15, '12441', true, '{}'::jsonb),
         ($1, $3, 1784, 'PALLET', 'PALLET', 24,
          24, 24, 0, 'EACH', 15, '12441', true, '{}'::jsonb)
       RETURNING id, line_id`,
      [sourcePoId, oldLineKey, candidateLineKey]
    );
    const oldSource = sourceLines.rows.find(
      (row) => Number(row.line_id) === oldLineKey
    );
    const candidate = sourceLines.rows.find(
      (row) => Number(row.line_id) === candidateLineKey
    );
    const child = await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity,
         netsuite_received_qty, netsuite_received_baseline_qty,
         received_sales_qty, unit, location_id, location, netsuite_active,
         raw
       ) VALUES (
         $1, $2, 1784, 'PALLET', 'PALLET', 24,
         0, 0, 0, 'EACH', 15, '12441', true,
         $3::jsonb
       )
       RETURNING id`,
      [
        splitPoId,
        oldLineKey,
        JSON.stringify({
          scmSplit: true,
          sourcePoId: String(sourcePoId),
          sourcePoRef,
          sourceLineId: String(oldSource.id)
        })
      ]
    );
    const split = await query(
      `INSERT INTO dispatch_scm_po_splits (
         source_po_id, source_po_ref, split_po_id, split_po_ref,
         status, created_by
       ) VALUES ($1, $2, $3, $4, 'active', 'harness')
       RETURNING id`,
      [sourcePoId, sourcePoRef, splitPoId, splitPoRef]
    );
    const ledger = await query(
      `INSERT INTO dispatch_scm_po_split_lines (
         split_id, source_line_id, split_line_id, item_id, sku, item_name,
         pallet_qty, layer_qty, section_qty, piece_qty, sales_qty, unit,
         requested_pallet_qty, requested_layer_qty, requested_section_qty,
         requested_piece_qty, requested_sales_qty
       ) VALUES (
         $1, $2, $3, 1784, 'PALLET', 'PALLET',
         0, 0, 0, 0, 24, 'EACH',
         0, 0, 0, 0, 24
       )
       RETURNING id`,
      [split.rows[0].id, oldSource.id, child.rows[0].id]
    );

    const options = await listScmPoSplitLineAdjustmentOptions({
      orderRef: splitPoRef
    });
    assert.equal(options.order.id, sourcePoId);
    assert.equal(options.adjustments.length, 1);
    const adjustmentOption = options.adjustments[0];
    assert.equal(adjustmentOption.ledgerLineId, Number(ledger.rows[0].id));
    assert.equal(adjustmentOption.currentSource.localLineId, Number(oldSource.id));
    assert.equal(adjustmentOption.candidates.length, 1);
    assert.equal(adjustmentOption.candidates[0].localLineId, Number(candidate.id));
    assert.equal(adjustmentOption.candidates[0].baselineQty, 24);
    assert.equal(adjustmentOption.candidates[0].recommendedBaselineQty, 0);
    assert.equal(adjustmentOption.candidates[0].requiresBaselineReduction, true);

    await assert.rejects(
      reassignScmPoSplitLineSource({
        ledgerLineId: ledger.rows[0].id,
        expectedSourceLineId: oldSource.id,
        newSourceLineId: candidate.id,
        note: "Harness exact IR line correction.",
        actor: "harness-admin"
      }),
      (error) => error.code === "SCM_SPLIT_LINE_BASELINE_CONFIRMATION_REQUIRED"
    );

    const changed = await reassignScmPoSplitLineSource({
      ledgerLineId: ledger.rows[0].id,
      expectedSourceLineId: oldSource.id,
      newSourceLineId: candidate.id,
      note: "Harness exact IR line correction.",
      allowBaselineReduction: true,
      expectedBaselineQty: 24,
      actor: "harness-admin"
    });
    assert.equal(changed.before.sourceLineKey, String(oldLineKey));
    assert.equal(changed.after.sourceLineKey, String(candidateLineKey));
    assert.equal(changed.after.candidateBaselineQty, 0);

    const stored = await query(
      `SELECT split_line.source_line_id,
              child.line_id AS child_line_key,
              child.raw->>'sourceLineId' AS child_source_line_id,
              candidate.netsuite_received_baseline_qty,
              audit.event_type,
              audit.actor
         FROM dispatch_scm_po_split_lines split_line
         JOIN purchase_order_lines child ON child.id = split_line.split_line_id
         JOIN purchase_order_lines candidate ON candidate.id = split_line.source_line_id
         JOIN scm_reconciliation_audit_events audit
           ON audit.id = $2
        WHERE split_line.id = $1`,
      [ledger.rows[0].id, changed.auditEventId]
    );
    assert.equal(Number(stored.rows[0].source_line_id), Number(candidate.id));
    assert.equal(String(stored.rows[0].child_line_key), String(candidateLineKey));
    assert.equal(stored.rows[0].child_source_line_id, String(candidate.id));
    assert.equal(Number(stored.rows[0].netsuite_received_baseline_qty), 0);
    assert.equal(stored.rows[0].event_type, "split_line.source_reassigned");
    assert.equal(stored.rows[0].actor, "harness-admin");
  });
  console.log("SCM reconciliation PO split source-line adjustment rollback harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
