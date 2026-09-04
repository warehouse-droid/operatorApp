import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  getScmPurchaseOrderSplitSourceLines,
  listScmPurchaseOrders
} from "../../../src/dispatch-repository.js";
import {
  listScmPoSplitLineAdjustmentOptions,
  reassignScmPoSplitLineSource
} from "../../../src/scm-reconciliation-repository.js";

after(closeDb);

function fixtureIdentity() {
  const token = crypto.randomUUID().replaceAll("-", "");
  const seed = Number.parseInt(token.slice(0, 10), 16);
  const base = 7_700_000_000_000 + (seed * 30);
  return {
    sourcePoId: base + 1,
    completedChildPoId: -(base + 2),
    openChildPoId: -(base + 3),
    oldLineKey: base + 100,
    replacementLineKey: base + 200,
    threeLineKey: base + 500,
    sixLineKey: base + 900,
    earlyMaterialLineKey: base + 1100,
    lateMaterialLineKey: base + 1200,
    sourceRef: `PO-PALLET-CONSERVE-${token.slice(0, 12)}`,
    completedChildRef: `SN-PALLET-FOUR-${token.slice(0, 12)}`,
    openChildRef: `SN-PALLET-SIX-${token.slice(0, 12)}`
  };
}

test("a reduced stale PALLET child rebinds to the exact replacement and conserves 13 family units", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = fixtureIdentity();
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, dispatch_ref, trandate, vendor_id, vendor,
           status, status_text, destination_location_id, destination_location,
           source_location_id, source_location, dispatch_vendor_yard,
           receipt_status, initial_scm_status, netsuite_active, synced_at
         ) VALUES
           ($1,$2,NULL,current_date,331,'Sequence Vendor','E',
            'Purchase Order : Pending Billing/Partially Received',1,'3445',1,
            'Sequence Vendor Yard','Sequence Vendor Yard','partially_received','Queued',true,now()),
           ($3,$4,$4,current_date,331,'Sequence Vendor','B',
            'Purchase Order : Pending Receipt',1,'3445',1,
            'Sequence Vendor Yard','Sequence Vendor Yard','not_received','Queued',true,now()),
           ($5,$6,$6,current_date,331,'Sequence Vendor','B',
            'Purchase Order : Pending Receipt',1,'3445',1,
            'Sequence Vendor Yard','Sequence Vendor Yard','not_received','Queued',true,now())`,
        [fixture.sourcePoId, fixture.sourceRef,
          fixture.completedChildPoId, fixture.completedChildRef,
          fixture.openChildPoId, fixture.openChildRef]
      );

      const sources = await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, item_description,
           quantity, netsuite_received_qty, netsuite_received_baseline_qty,
           received_sales_qty, unit, location_id, location, pallet_qty,
           layer_qty, section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
           netsuite_active, item_weight, raw, synced_at
         ) VALUES
           ($1,$2,1784,'PALLET','PALLET','Old removed PALLET line',4,0,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,false,40,$6::jsonb,now()),
           ($1,$3,1784,'PALLET','PALLET','Replacement received PALLET line',4,4,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,true,40,$7::jsonb,now()),
           ($1,$4,1784,'PALLET','PALLET','Unsplit three PALLET line',3,0,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,true,40,$8::jsonb,now()),
           ($1,$5,1784,'PALLET','PALLET','Six PALLET child source',6,0,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,true,40,$9::jsonb,now())
         RETURNING id, line_id`,
        [fixture.sourcePoId, fixture.oldLineKey, fixture.replacementLineKey,
          fixture.threeLineKey, fixture.sixLineKey,
          JSON.stringify({ lineSequenceNumber: 4, orderLine: 4 }),
          JSON.stringify({ lineSequenceNumber: 8, orderLine: 6 }),
          JSON.stringify({ lineSequenceNumber: 7, orderLine: 15 }),
          JSON.stringify({ lineSequenceNumber: 5, orderLine: 14 })]
      );
      const byKey = new Map(sources.rows.map((row) => [Number(row.line_id), row]));
      const oldSource = byKey.get(fixture.oldLineKey);
      const replacement = byKey.get(fixture.replacementLineKey);
      const threeSource = byKey.get(fixture.threeLineKey);
      const sixSource = byKey.get(fixture.sixLineKey);

      await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, item_description,
           quantity, netsuite_received_qty, netsuite_received_baseline_qty,
           received_sales_qty, unit, location_id, location, pallet_qty,
           layer_qty, section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
           netsuite_active, item_weight, raw, synced_at
         ) VALUES
           ($1,$2,27841,'EARLY MATERIAL','EARLY MATERIAL','Visible sequence two',1,0,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,true,1,$4::jsonb,now()),
           ($1,$3,27842,'LATE MATERIAL','LATE MATERIAL','Visible sequence nine',1,0,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,true,1,$5::jsonb,now())`,
        [fixture.sourcePoId, fixture.earlyMaterialLineKey,
          fixture.lateMaterialLineKey,
          JSON.stringify({ lineSequenceNumber: 2, orderLine: 2 }),
          JSON.stringify({ lineSequenceNumber: 9, orderLine: 9 })]
      );

      const children = await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, item_description,
           quantity, netsuite_received_qty, netsuite_received_baseline_qty,
           received_sales_qty, unit, location_id, location, pallet_qty,
           layer_qty, section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
           netsuite_active, item_weight, raw, synced_at
         ) VALUES
           ($1,$2,1784,'PALLET','PALLET','Completed four PALLET child',4,0,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,true,40,$5::jsonb,now()),
           ($3,$4,1784,'PALLET','PALLET','Open six PALLET child',6,0,0,0,
            'EACH',1,'3445',0,0,0,0,0,0,0,0,true,40,$6::jsonb,now())
         RETURNING id, purchase_order_id`,
        [fixture.completedChildPoId, fixture.oldLineKey,
          fixture.openChildPoId, fixture.sixLineKey,
          JSON.stringify({ scmSplit: true, sourceLineId: String(oldSource.id) }),
          JSON.stringify({ scmSplit: true, sourceLineId: String(sixSource.id) })]
      );
      const completedChildLine = children.rows.find(
        (row) => Number(row.purchase_order_id) === fixture.completedChildPoId
      );
      const openChildLine = children.rows.find(
        (row) => Number(row.purchase_order_id) === fixture.openChildPoId
      );

      const headers = await query(
        `INSERT INTO dispatch_scm_po_splits (
           source_po_id, source_po_ref, split_po_id, split_po_ref,
           status, created_by, details
         ) VALUES
           ($1,$2,$3,$4,'active','sequence-conservation-test','{}'::jsonb),
           ($1,$2,$5,$6,'active','sequence-conservation-test','{}'::jsonb)
         RETURNING id, split_po_id`,
        [fixture.sourcePoId, fixture.sourceRef,
          fixture.completedChildPoId, fixture.completedChildRef,
          fixture.openChildPoId, fixture.openChildRef]
      );
      const completedHeader = headers.rows.find(
        (row) => Number(row.split_po_id) === fixture.completedChildPoId
      );
      const openHeader = headers.rows.find(
        (row) => Number(row.split_po_id) === fixture.openChildPoId
      );

      const staleLedger = await query(
        `INSERT INTO dispatch_scm_po_split_lines (
           split_id, source_line_id, split_line_id, item_id, sku, item_name,
           pallet_qty, layer_qty, section_qty, piece_qty, sales_qty, unit,
           requested_pallet_qty, requested_layer_qty, requested_section_qty,
           requested_piece_qty, requested_sales_qty
         ) VALUES
           ($1,$2,$3,1784,'PALLET','PALLET',0,0,0,0,4,'EACH',0,0,0,0,7),
           ($4,$5,$6,1784,'PALLET','PALLET',0,0,0,0,6,'EACH',0,0,0,0,6)
         RETURNING id, split_id`,
        [completedHeader.id, oldSource.id, completedChildLine.id,
          openHeader.id, sixSource.id, openChildLine.id]
      );
      const completedLedger = staleLedger.rows.find(
        (row) => Number(row.split_id) === Number(completedHeader.id)
      );

      await query(
        `SELECT dispatch_record_order_completion(
           'PO', $1, now(), 'driver_job', $2, NULL, current_date, NULL,
           'driver', 'sequence-conservation-driver', '', '{}'::jsonb
         )`,
        [fixture.completedChildRef, `sequence-conservation:${fixture.completedChildRef}`]
      );

      const options = await listScmPoSplitLineAdjustmentOptions({
        orderRef: fixture.sourceRef
      });
      assert.equal(options.adjustments.length, 1,
        "only the exact four-unit replacement has current capacity");
      const option = options.adjustments[0];
      assert.equal(option.ledgerLineId, Number(completedLedger.id));
      assert.equal(option.requestedQty, 7);
      assert.equal(option.currentQty, 4);
      assert.deepEqual(option.candidates.map((candidate) => candidate.localLineId), [
        Number(replacement.id)
      ]);
      assert.equal(option.candidates[0].requestedQty, 7);
      assert.equal(option.candidates[0].currentQty, 4);

      const previewDidNotMutate = await query(
        `SELECT source_line_id, sales_qty, requested_sales_qty
           FROM dispatch_scm_po_split_lines
          WHERE id = $1`,
        [completedLedger.id]
      );
      assert.deepEqual(previewDidNotMutate.rows, [{
        source_line_id: oldSource.id,
        sales_qty: "4",
        requested_sales_qty: "7"
      }]);

      const changed = await reassignScmPoSplitLineSource({
        ledgerLineId: completedLedger.id,
        expectedSourceLineId: oldSource.id,
        newSourceLineId: replacement.id,
        note: "NetSuite replaced the completed four-PALLET source line; conserve the current family quantity.",
        actor: "sequence-conservation-admin"
      });
      assert.equal(changed.before.sourceLineKey, String(fixture.oldLineKey));
      assert.equal(changed.after.sourceLineKey, String(fixture.replacementLineKey));

      const stored = await query(
        `SELECT ledger.source_line_id, ledger.sales_qty, ledger.requested_sales_qty,
                child.line_id AS child_line_key, child.quantity AS child_quantity,
                child.raw->>'lineSequenceNumber' AS child_line_sequence,
                audit.event_type, audit.actor
           FROM dispatch_scm_po_split_lines ledger
           JOIN purchase_order_lines child ON child.id = ledger.split_line_id
           JOIN scm_reconciliation_audit_events audit ON audit.id = $2
          WHERE ledger.id = $1`,
        [completedLedger.id, changed.auditEventId]
      );
      assert.deepEqual(stored.rows, [{
        source_line_id: replacement.id,
        sales_qty: "4",
        requested_sales_qty: "7",
        child_line_key: String(fixture.replacementLineKey),
        child_quantity: "4",
        child_line_sequence: "8",
        event_type: "split_line.source_reassigned",
        actor: "sequence-conservation-admin"
      }]);

      const sourceLines = await getScmPurchaseOrderSplitSourceLines(
        fixture.completedChildRef
      );
      assert.deepEqual(
        sourceLines.lines
          .filter((line) => Number(line.itemId) === 1784)
          .map((line) => line.netSuiteLineSequence),
        [5, 7, 8],
        "source choices must use NetSuite sequence, not SKU or unique-key order"
      );

      const rows = await listScmPurchaseOrders({
        search: fixture.sourceRef,
        includeAllDiscoverable: true
      });
      const refs = new Set([
        fixture.sourceRef,
        fixture.completedChildRef,
        fixture.openChildRef
      ]);
      const palletUnits = new Map(rows
        .filter((order) => refs.has(order.id))
        .map((order) => [
          order.id,
          order.items
            .filter((line) => Number(line.itemId) === 1784)
            .reduce((sum, line) => sum + Number(line.quantity || 0), 0)
        ]));
      assert.equal(palletUnits.get(fixture.sourceRef), 3);
      assert.equal(palletUnits.get(fixture.completedChildRef), 4);
      assert.equal(palletUnits.get(fixture.openChildRef), 6);
      assert.equal([...palletUnits.values()].reduce((sum, value) => sum + value, 0), 13);
      assert.deepEqual(
        rows.find((order) => order.id === fixture.sourceRef)?.items
          .map((line) => Number(line.netSuiteLineSequence)),
        [2, 7, 9],
        "the hydrated PO card must expose and order its rows by NetSuite sequence"
      );
      assert.equal(
        rows.find((order) => order.id === fixture.completedChildRef)?.dispatchCompleted,
        true,
        "line lineage repair must not discard child completion evidence"
      );

      assert.equal(Number(threeSource.id) > 0, true,
        "the explicit three-unit residual line remains a distinct source line");
    });
  } finally {
    await rollback.rollback();
  }
});
