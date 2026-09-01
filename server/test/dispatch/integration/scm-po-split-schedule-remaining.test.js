import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createScmPurchaseOrderSplit,
  listScmSchedule
} from "../../../src/dispatch-repository.js";

after(closeDb);

test("PO/TO Schedule shows only source PO residual and hides a fully split source", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const purchaseOrderId = 8_760_000_000_000 + Number(suffix.slice(-9));
      const purchaseOrderRef = `PO-SCHEDULE-REMAINING-${suffix}`;
      const splitRef = `SN-SCHEDULE-REMAINING-${suffix}`;
      const finalSplitRef = `SN-SCHEDULE-FINAL-${suffix}`;
      const sku = `SPLIT-SCHEDULE-SKU-${suffix}`;
      const sourceLine = await query(
        `WITH inserted_order AS (
           INSERT INTO purchase_orders (
             netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
             foreign_total, destination_location_id, destination_location,
             source_location_id, source_location, dispatch_vendor_yard,
             receipt_status, initial_scm_status, netsuite_active, synced_at
           ) VALUES (
             $1, $2, current_date, $3, 'Schedule Split Vendor', 'pendingReceipt',
             'Purchase Order : Pending Receipt', 1200, 1, '3445', 15, '12441',
             'Schedule Split Vendor Yard', 'not_received', 'Queued', true, now()
           )
           RETURNING netsuite_id
         )
         INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
           location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
           to_plt, to_lyr, to_sec, to_pcs,
           received_pallet_qty, received_layer_qty, received_section_qty,
           received_piece_qty, netsuite_received_qty, netsuite_received_baseline_qty,
           item_weight, netsuite_active, synced_at, raw
         )
         SELECT netsuite_id, $4, $5, 'Schedule Split Item', $6, 120, 'EA',
                1, '3445', 12, 0, 0, 0,
                10, 0, 0, 1,
                0, 0, 0, 0, 0, 0,
                2.5, true, now(), '{}'::jsonb
           FROM inserted_order
         RETURNING id`,
        [
          purchaseOrderId,
          purchaseOrderRef,
          purchaseOrderId + 1,
          purchaseOrderId + 2,
          purchaseOrderId + 3,
          sku
        ]
      );

      const created = await createScmPurchaseOrderSplit({
        sourcePoRef: purchaseOrderRef,
        newPoRef: splitRef,
        destinationLocationId: 1,
        lines: [{ lineRowId: sourceLine.rows[0].id, pallets: 7 }],
        createdBy: "split-schedule-regression"
      });

      const parentRows = await listScmSchedule({ exactRef: purchaseOrderRef });
      const parent = parentRows.find((row) => String(row.sourceId) === String(purchaseOrderId));
      assert.ok(parent, "the source PO must remain visible in PO/TO Schedule");
      assert.equal(parent.totalPalletQty, 5);
      assert.equal(parent.weightLbs, 125);
      assert.match(parent.content, new RegExp(`${sku} 5 PLT`));
      assert.doesNotMatch(parent.content, new RegExp(`${sku} 12 PLT`));

      const splitRows = await listScmSchedule({ exactRef: splitRef });
      const child = splitRows.find((row) => String(row.sourceId) === String(created.split.splitPoId));
      assert.ok(child, "the split child must remain visible in PO/TO Schedule");
      assert.equal(child.totalPalletQty, 7);
      assert.equal(child.weightLbs, 175);
      assert.match(child.content, new RegExp(`${sku} 7 PLT`));

      const finalSplit = await createScmPurchaseOrderSplit({
        sourcePoRef: purchaseOrderRef,
        newPoRef: finalSplitRef,
        destinationLocationId: 1,
        lines: [{ lineRowId: sourceLine.rows[0].id, pallets: 5 }],
        createdBy: "split-schedule-regression"
      });

      const fullySplitRows = await listScmSchedule({ exactRef: purchaseOrderRef });
      assert.equal(
        fullySplitRows.some((row) => String(row.sourceId) === String(purchaseOrderId)),
        false,
        "a source PO with no quantity remaining after active splits must be hidden"
      );

      await query(
        `UPDATE dispatch_scm_po_splits
            SET status = 'cancelled', cancelled_at = now()
          WHERE id = $1`,
        [finalSplit.split.id]
      );
      const partiallyRestoredRows = await listScmSchedule({ exactRef: purchaseOrderRef });
      const partiallyRestored = partiallyRestoredRows.find((row) => String(row.sourceId) === String(purchaseOrderId));
      assert.equal(partiallyRestored?.totalPalletQty, 5, "cancelling one split must restore only its source residual");

      await query(
        `UPDATE dispatch_scm_po_splits
            SET status = 'cancelled', cancelled_at = now()
          WHERE id = $1`,
        [created.split.id]
      );
      const restoredRows = await listScmSchedule({ exactRef: purchaseOrderRef });
      const restored = restoredRows.find((row) => String(row.sourceId) === String(purchaseOrderId));
      assert.equal(restored?.totalPalletQty, 12, "cancelled splits must not reduce the source PO");
      assert.equal(restored?.weightLbs, 300);
      assert.match(restored?.content || "", new RegExp(`${sku} 12 PLT`));
    });
  } finally {
    await rollback.rollback();
  }
});
