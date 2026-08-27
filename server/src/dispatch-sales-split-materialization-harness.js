import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { applyConfirmedDispatchPlanToDelivery } from "./delivery-repository.js";

const rollback = await beginRollbackContext();
const seed = Number(String(Date.now()).slice(-7));
const parentId = 9970000000 + seed;
const parentRef = `HARNESS-SO-${seed}`;
const splitRef = `${parentRef}-S1`;
const purchaseOrderId = parentId + 1;
const purchaseOrderRef = `HARNESS-PO-${seed}`;
const lineId = 880000 + (seed % 100000);
const planDate = "2098-12-29";

function plannedTrucks(orderRef) {
  return [{
    id: `HARNESS-SALES-TRUCK-${seed}`,
    plate: "HARNESS",
    driver: "Harness",
    loads: [{
      id: `HARNESS-SALES-LOAD-${seed}`,
      name: "Load 1",
      stops: [{
        id: `HARNESS-SALES-DROP-${orderRef}`,
        type: "drop",
        orderId: orderRef,
        location: "12441"
      }]
    }]
  }];
}

function splitPlan({ lineRowId, pieces }) {
  return {
    id: `split-materialization-${seed}`,
    planDate,
    status: "confirmed",
    orders: [{
      id: splitRef,
      type: "SO",
      originalOrderId: parentRef,
      items: [{
        lineId,
        lineRowId,
        itemId: 990001,
        sku: `HARNESS-SKU-${seed}`,
        pieces,
        toPcs: 1
      }]
    }],
    trucks: plannedTrucks(splitRef)
  };
}

try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         operator_status, local_yard_order_status, fulfillment_status, netsuite_active
       ) VALUES (
         $1, $2, current_date, 'Split Harness Customer', 'B', 'Pending Fulfillment',
         1, '12441', 'Delivery', 'open', 'Open', 'not_fulfilled', true
       )`,
      [parentId, parentRef]
    );
    const parentLine = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
         location_id, location, piece_qty, to_pcs, netsuite_active
       ) VALUES (
         $1, $2, 990001, 'Split Harness Item', $3, 100, 'PC',
         1, '12441', 100, 1, true
       )
       RETURNING id`,
      [parentId, lineId, `HARNESS-SKU-${seed}`]
    );

    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      lineRowId: parentLine.rows[0].id,
      pieces: 10
    }));

    const created = await query(
      `SELECT line.id, line.quantity, line.piece_qty
         FROM sales_order_lines line
         JOIN sales_orders sales ON sales.netsuite_id = line.sales_order_id
        WHERE sales.tranid = $1 AND line.line_id = $2`,
      [splitRef, lineId]
    );
    assert.equal(created.rowCount, 1, "first materialization should create one synthetic line");
    const syntheticLineId = created.rows[0].id;

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor, status, status_text,
         netsuite_active, synced_at
       ) VALUES (
         $1, $2, current_date, 'Split Harness Vendor', 'pendingReceipt',
         'Purchase Order : Pending Receipt', true, now()
       )`,
      [purchaseOrderId, purchaseOrderRef]
    );
    const purchaseLine = await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku,
         item_type, item_type_text, quantity, unit, piece_qty, to_pcs,
         netsuite_active, synced_at
       ) VALUES (
         $1, $2, 990001, 'Split Harness Item', $3,
         'InvtPart', 'Inventory Item', 100, 'PC', 100, 1,
         true, now()
       )
       RETURNING id`,
      [purchaseOrderId, lineId, `HARNESS-SKU-${seed}`]
    );
    const allocation = await query(
      `INSERT INTO dispatch_so_po_allocations (
         sales_order_id, sales_order_ref, sales_line_id,
         po_order_id, po_order_ref, po_line_id,
         item_id, item_name, sku, allocated_piece_qty, allocated_sales_qty,
         created_by, dispatch_target_ref, dispatch_target_kind,
         dispatch_target_line_key
       ) VALUES (
         (SELECT netsuite_id FROM sales_orders WHERE tranid = $1), $1, $2,
         $3, $4, $5,
         990001, 'Split Harness Item', $6, 10, 10,
         'split-materialization-harness', $1, 'split', $7
       )
       RETURNING id`,
      [
        splitRef,
        syntheticLineId,
        purchaseOrderId,
        purchaseOrderRef,
        purchaseLine.rows[0].id,
        `HARNESS-SKU-${seed}`,
        `${splitRef}::${splitRef}::${lineId}`
      ]
    );

    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      lineRowId: Number(parentLine.rows[0].id) + 99999,
      pieces: 12
    }));

    const preservedAllocation = await query(
      `SELECT allocation.id, allocation.sales_line_id, line.piece_qty
         FROM dispatch_so_po_allocations allocation
         JOIN sales_order_lines line ON line.id = allocation.sales_line_id
        WHERE allocation.id = $1`,
      [allocation.rows[0].id]
    );
    assert.equal(preservedAllocation.rowCount, 1,
      "repeat split materialization must not cascade-delete an active PO allocation");
    assert.equal(preservedAllocation.rows[0].sales_line_id, syntheticLineId,
      "the selected split line identity must remain stable while preserving its PO allocation");
    assert.equal(Number(preservedAllocation.rows[0].piece_qty), 12,
      "the preserved split line must still receive its refreshed planned quantity");

    await query(
      `UPDATE sales_order_lines
          SET loaded_qty = 3,
              loaded_uom = 'PC',
              packed_piece_qty = 2,
              fulfilled_piece_qty = 1
        WHERE id = $1`,
      [syntheticLineId]
    );

    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      lineRowId: Number(parentLine.rows[0].id) + 99999,
      pieces: 20
    }));

    const rematerialized = await query(
      `SELECT line.id, line.quantity, line.piece_qty, line.loaded_qty,
              line.loaded_uom, line.packed_piece_qty, line.fulfilled_piece_qty
         FROM sales_order_lines line
         JOIN sales_orders sales ON sales.netsuite_id = line.sales_order_id
        WHERE sales.tranid = $1 AND line.line_id = $2
        ORDER BY line.id`,
      [splitRef, lineId]
    );
    assert.equal(rematerialized.rowCount, 1, "repeat materialization must remain unique by order and line");
    assert.equal(rematerialized.rows[0].id, syntheticLineId, "existing synthetic line identity must be preserved");
    assert.equal(Number(rematerialized.rows[0].quantity), 20, "planned quantity should refresh");
    assert.equal(Number(rematerialized.rows[0].piece_qty), 20, "planned unit breakdown should refresh");
    assert.equal(Number(rematerialized.rows[0].loaded_qty), 3, "loaded progress must be preserved");
    assert.equal(rematerialized.rows[0].loaded_uom, "PC", "loaded UOM must be preserved");
    assert.equal(Number(rematerialized.rows[0].packed_piece_qty), 2, "packed progress must be preserved");
    assert.equal(Number(rematerialized.rows[0].fulfilled_piece_qty), 1, "fulfilled progress must be preserved");
  });
  console.log("dispatch sales split materialization harness passed");
} finally {
  await rollback.rollback();
  await closeDb();
}
