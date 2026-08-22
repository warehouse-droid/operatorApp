// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { confirmCustomerPickupLines } from "../../../src/delivery-repository.js";
import {
  buildItemReceiptPayload,
  confirmPurchaseOrderReceivingLines,
  getReceivableReceivingOrder
} from "../../../src/receiving-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function identities() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const base = 9_960_000_000 + Math.floor(Math.random() * 100_000);
  return { suffix, base };
}

async function seedOperator(suffix) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt, role, roles, active
     ) VALUES ($1, $2, 'Page Confirm Operator', 'test', 'test', 'operator', ARRAY['operator']::text[], true)`,
    [id, `page-confirm-${suffix}`]
  );
  return id;
}

async function seedPickupOrder(base, suffix) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, is_test_fixture
     ) VALUES (
       $1, $2, current_date, 'Page Confirm Pickup Customer', 'B', 'Sales Order : Pending Fulfillment',
       1, '3445', 'Pick-Up',
       'open', 'Open', 'open', true, false
     )`,
    [base, `PICKUP-PAGE-${suffix}`]
  );
  const lines = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location, piece_qty, to_pcs,
       packed_piece_qty, loaded_qty, netsuite_active
     ) VALUES
       ($1, $2, 880101, 'Pickup Page Item 1', 'PICKUP-PAGE-1', 'InvtPart', 2, 'PC', 1, '3445', 2, 1, 0, 0, true),
       ($1, $3, 880102, 'Pickup Page Item 2', 'PICKUP-PAGE-2', 'InvtPart', 3, 'PC', 1, '3445', 3, 1, 0, 0, true)
     RETURNING id`,
    [base, base + 101, base + 102]
  );
  return lines.rows.map((line) => line.id);
}

async function seedPurchaseOrder(base, suffix) {
  const orderId = base + 10;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, receipt_status, netsuite_active
     ) VALUES (
       $1, $2, current_date, 990101, 'Page Confirm Vendor', 'B', 'Purchase Order : Pending Receipt',
       1, '3445', 'open', true
     )`,
    [orderId, `PO-PAGE-${suffix}`]
  );
  const lines = await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location, piece_qty, to_pcs,
       netsuite_received_qty, netsuite_received_baseline_qty, netsuite_active
     ) VALUES
       ($1, $2, 881101, 'PO Page Item 1', 'PO-PAGE-1', 'InvtPart', 4, 'PC', 1, '3445', 4, 1, 0, 0, true),
       ($1, $3, 881102, 'PO Page Item 2', 'PO-PAGE-2', 'InvtPart', 5, 'PC', 1, '3445', 5, 1, 0, 0, true)
     RETURNING id`,
    [orderId, base + 201, base + 202]
  );
  return { orderId, lineIds: lines.rows.map((line) => line.id) };
}

async function seedSalesQuantityOnlyPurchaseOrder(base, suffix) {
  const orderId = base + 30;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, receipt_status, netsuite_active
     ) VALUES (
       $1, $2, current_date, 990102, 'Sales Quantity Vendor', 'B',
       'Purchase Order : Pending Receipt', 15, '12441', 'not_received', true
     )`,
    [orderId, `PO-SALES-QTY-${suffix}`]
  );
  const lines = await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku,
       item_type, item_type_text, quantity, unit,
       location_id, location, pallet_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       received_sales_qty, netsuite_received_qty,
       netsuite_received_baseline_qty, pack_quantity_source, netsuite_active
     ) VALUES
       ($1, $2, 2055, 'MBBS-Special Order', 'MBBS-Special Order',
        'NonInvtPart', 'Non-inventory Item', 734.4, 'SQFT',
        15, '12441', 9,
        0, 0, 0, 0,
        0, 0, 0, 'netsuite_manual', true),
       ($1, $3, 1784, 'PALLET', 'PALLET',
        'InvtPart', 'Inventory Item', 9, 'EACH',
        15, '12441', 0,
        0, 0, 0, 0,
        0, 0, 0, 'sales_only', true)
     RETURNING id, line_id, sku`,
    [orderId, base + 301, base + 302]
  );
  return { orderId, lines: lines.rows };
}

test("Customer Pickup page confirmation confirms each unique visible line and reports failures", async () => {
  await inRollback(async () => {
    const { base, suffix } = identities();
    const operatorId = await seedOperator(suffix);
    const [firstLineId, secondLineId] = await seedPickupOrder(base, suffix);

    const result = await confirmCustomerPickupLines(base, [
      { lineId: firstLineId, values: { pieces: 2 } },
      { lineId: firstLineId, values: { pieces: 2 } },
      { lineId: secondLineId, values: { pieces: 3 } },
      { lineId: base + 999, values: { pieces: 1 } }
    ], operatorId);

    assert.equal(result.confirmed, 2);
    assert.equal(result.failures.length, 1);
    assert.equal(String(result.failures[0].lineId), String(base + 999));
    const rows = await query(
      `SELECT id, packed_piece_qty, confirmed
         FROM sales_order_lines
        WHERE sales_order_id = $1
        ORDER BY id`,
      [base]
    );
    assert.deepEqual(
      rows.rows.map((line) => [Number(line.packed_piece_qty), line.confirmed]),
      [[2, true], [3, true]]
    );
  });
});

test("Purchase Order page confirmation is deduplicated and cannot be used for Transfer Orders", async () => {
  await inRollback(async () => {
    const { base, suffix } = identities();
    const operatorId = await seedOperator(suffix);
    const { orderId, lineIds: [firstLineId, secondLineId] } = await seedPurchaseOrder(base, suffix);

    const result = await confirmPurchaseOrderReceivingLines(orderId, [
      { lineId: firstLineId, values: { pieces: 4 } },
      { lineId: firstLineId, values: { pieces: 4 } },
      { lineId: secondLineId, values: { pieces: 5 } },
      { lineId: base + 998, values: { pieces: 1 } }
    ], operatorId);

    assert.equal(result.confirmed, 2);
    assert.equal(result.failures.length, 1);
    const rows = await query(
      `SELECT id, received_piece_qty, confirmed_by
         FROM purchase_order_lines
        WHERE purchase_order_id = $1
        ORDER BY id`,
      [orderId]
    );
    assert.deepEqual(
      rows.rows.map((line) => [Number(line.received_piece_qty), line.confirmed_by]),
      [[4, operatorId], [5, operatorId]]
    );

    const transferOrderId = base + 20;
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         receiving_status, netsuite_active
       ) VALUES (
         $1, $2, current_date, 'B', 'Transfer Order : Pending Receipt',
         28, '2967', 1, '3445', 'not_received', true
       )`,
      [transferOrderId, `TO-PAGE-${suffix}`]
    );
    await assert.rejects(
      confirmPurchaseOrderReceivingLines(transferOrderId, [], operatorId),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /Purchase Order/u);
        return true;
      }
    );
  });
});

test("sales-quantity-only PO confirmations remain receivable and build exact receipt quantities", async () => {
  await inRollback(async () => {
    const { base, suffix } = identities();
    const operatorId = await seedOperator(suffix);
    const { orderId, lines } = await seedSalesQuantityOnlyPurchaseOrder(base, suffix);

    const confirmation = await confirmPurchaseOrderReceivingLines(orderId, [
      { lineId: lines[0].id, values: { salesQty: 734.4 } },
      { lineId: lines[1].id, values: { salesQty: 9 } }
    ], operatorId);
    assert.deepEqual(confirmation, { confirmed: 2, failures: [] });

    const order = await getReceivableReceivingOrder(orderId);
    assert.equal(order.receivableLines.length, 2);
    const payload = buildItemReceiptPayload(order, order.receivableLines);
    assert.deepEqual(
      payload.item.items.map((item) => ({
        orderLine: item.orderLine,
        quantity: item.quantity,
        itemReceive: item.itemReceive,
        location: item.location
      })),
      [
        { orderLine: Number(lines[0].line_id), quantity: 734.4, itemReceive: true, location: 15 },
        { orderLine: Number(lines[1].line_id), quantity: 9, itemReceive: true, location: 15 }
      ]
    );
  });
});
