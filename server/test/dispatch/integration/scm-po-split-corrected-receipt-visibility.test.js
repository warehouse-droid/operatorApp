import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createScmPurchaseOrderSplit,
  listScmPurchaseOrders
} from "../../../src/dispatch-repository.js";

after(closeDb);

test("PO Split keeps a corrected Pending Bill source visible by its remaining baseline", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const sourcePoId = -(8_870_000_000_000 + Number(suffix.slice(-9)));
      const splitPoId = sourcePoId - 1;
      const sourceLineId = sourcePoId - 2;
      const splitLineId = sourcePoId - 3;
      const sourceRef = `PO-CORRECTED-PENDING-BILL-${suffix}`;
      const splitRef = `${sourceRef}-L1`;

      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
           destination_location_id, destination_location, source_location_id,
           source_location, dispatch_vendor_yard, receipt_status,
           initial_scm_status, netsuite_active, synced_at
         ) VALUES
           ($1, $2, current_date, $3, 'Corrected Receipt Vendor', 'F',
            'Purchase Order : Pending Bill', 15, '12441', 1,
            '3445', 'Corrected Receipt Yard', 'not_received',
            'Queued', true, now()),
           ($4, $5, current_date, $3, 'Corrected Receipt Vendor', 'B',
            'Purchase Order : Pending Receipt', 15, '12441', 1,
            '3445', 'Corrected Receipt Yard', 'not_received',
            'Queued', true, now())`,
        [sourcePoId, sourceRef, Math.abs(sourcePoId) + 100, splitPoId, splitRef]
      );

      await query(
        `INSERT INTO purchase_order_lines (
           id, purchase_order_id, line_id, item_id, item_name, sku,
           quantity, unit, location_id, location,
           pallet_qty, layer_qty, section_qty, piece_qty,
           to_plt, to_lyr, to_sec, to_pcs,
           received_pallet_qty, received_layer_qty, received_section_qty,
           received_piece_qty, netsuite_received_qty,
           netsuite_received_baseline_qty, netsuite_active, synced_at, raw
         ) VALUES
           ($1, $2, 1001, 2001, 'Corrected Receipt Item', 'CORRECTED-ITEM',
            100, 'EA', 15, '12441',
            10, 0, 0, 0,
            10, 0, 0, 1,
            0, 0, 0, 0, 100,
            0, true, now(), '{}'::jsonb),
           ($3, $4, 1001, 2001, 'Corrected Receipt Item', 'CORRECTED-ITEM',
            40, 'EA', 15, '12441',
            4, 0, 0, 0,
            10, 0, 0, 1,
            0, 0, 0, 0, 0,
            0, true, now(), '{}'::jsonb)`,
        [sourceLineId, sourcePoId, splitLineId, splitPoId]
      );

      const split = await query(
        `INSERT INTO dispatch_scm_po_splits (
           source_po_id, source_po_ref, split_po_id, split_po_ref,
           status, created_by, details
         ) VALUES ($1, $2, $3, $4, 'active', 'corrected-receipt-regression', '{}'::jsonb)
         RETURNING id`,
        [sourcePoId, sourceRef, splitPoId, splitRef]
      );
      await query(
        `INSERT INTO dispatch_scm_po_split_lines (
           split_id, source_line_id, split_line_id, item_id, sku, item_name,
           pallet_qty, layer_qty, section_qty, piece_qty, sales_qty, unit
         ) VALUES ($1, $2, $3, 2001, 'CORRECTED-ITEM', 'Corrected Receipt Item',
                   4, 0, 0, 0, 40, 'EA')`,
        [split.rows[0].id, sourceLineId, splitLineId]
      );
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, source_table, source_id, order_ref, method,
           pickup_point, dropoff_point, status, created_by, updated_by
         ) VALUES ('PO', 'purchase_orders', $1, $2, 'MBT',
                   'Corrected Receipt Yard', '12441', 'Hold',
                   'corrected-receipt-regression', 'corrected-receipt-regression')`,
        [sourcePoId, sourceRef]
      );

      const rows = await listScmPurchaseOrders({ search: sourceRef });
      const source = rows.find((row) => String(row.id) === sourceRef);
      assert.ok(source,
        "a corrected source PO must not disappear merely because NetSuite still says Pending Bill");
      assert.equal(source.netsuiteStatusText, "Purchase Order : Pending Bill");
      assert.equal(source.scm?.status, "Hold");
      assert.equal(source.items.length, 1);
      assert.equal(source.items[0].quantity, 60,
        "PO Split must use the corrected local received baseline and active split allocation");
      assert.equal(source.items[0].pallets, 6);
      assert(rows.some((row) => String(row.id) === splitRef),
        "searching the source must continue to include its active split child");
    });
  } finally {
    await rollback.rollback();
  }
});

test("PO Split exposes no selectable quantity for a genuinely fully received Pending Bill order", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const purchaseOrderId = -(8_880_000_000_000 + Number(suffix.slice(-9)));
      const orderRef = `PO-FULLY-RECEIVED-PENDING-BILL-${suffix}`;
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
           destination_location_id, destination_location, source_location_id,
           source_location, dispatch_vendor_yard, receipt_status,
           initial_scm_status, netsuite_active, synced_at
         ) VALUES (
           $1, $2, current_date, $3, 'Fully Received Vendor', 'F',
           'Purchase Order : Pending Bill', 15, '12441', 1,
           '3445', 'Fully Received Yard', 'received',
           'Queued', true, now()
         )`,
        [purchaseOrderId, orderRef, Math.abs(purchaseOrderId) + 100]
      );
      await query(
        `INSERT INTO purchase_order_lines (
           id, purchase_order_id, line_id, item_id, item_name, sku,
           quantity, unit, location_id, location,
           pallet_qty, layer_qty, section_qty, piece_qty,
           to_plt, to_lyr, to_sec, to_pcs,
           received_pallet_qty, received_layer_qty, received_section_qty,
           received_piece_qty, netsuite_received_qty,
           netsuite_received_baseline_qty, netsuite_active, synced_at, raw
         ) VALUES (
           $1, $2, 1001, 2001, 'Fully Received Item', 'FULLY-RECEIVED-ITEM',
           100, 'EA', 15, '12441',
           10, 0, 0, 0,
           10, 0, 0, 1,
           10, 0, 0, 0, 100,
           100, true, now(), '{}'::jsonb
         )`,
        [purchaseOrderId - 1, purchaseOrderId]
      );

      const rows = await listScmPurchaseOrders({ search: orderRef });
      const fullyReceived = rows.find((row) => String(row.id) === orderRef);
      assert.ok(fullyReceived, "an exact search may retain the zero-balance header for inspection");
      assert.deepEqual(fullyReceived.items, [],
        "a fully received baseline must expose no selectable PO Split lines");
      await assert.rejects(
        createScmPurchaseOrderSplit({
          sourcePoRef: orderRef,
          newPoRef: `${orderRef}-L1`,
          destinationLocationId: 15,
          lines: [{ lineRowId: purchaseOrderId - 1, pallets: 1 }],
          createdBy: "fully-received-regression"
        }),
        /only has 0 PLT remaining/,
        "the repository must reject a split even if a stale client submits the fully received line"
      );
    });
  } finally {
    await rollback.rollback();
  }
});
