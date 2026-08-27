// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { getDeliveryOrder } from "../../../src/delivery-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function seedLinkedDeliveryOrder() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const baseId = 9_810_000_000 + Math.floor(Math.random() * 100_000);
  const salesOrderId = baseId;
  const salesOrderRef = `SO-LINKED-${suffix}`;
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, is_test_fixture
     ) VALUES (
       $1, $2, current_date, 'Linked quantity customer', 'B', 'Pending Fulfillment',
       15, '12441', 'Delivery', 'open', 'Open', 'not_fulfilled', true, false
     )`,
    [salesOrderId, salesOrderRef]
  );
  const lineResult = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location, pallet_qty, piece_qty,
       to_plt, to_pcs, loaded_qty, netsuite_active
     ) VALUES
       ($1, 1, 880101, 'Partial linked item', 'PARTIAL-LINKED', 'InvtPart',
        100, 'EA', 15, '12441', 10, 100, 10, 1, 0, true),
       ($1, 2, 880102, 'Fully linked item', 'FULLY-LINKED', 'InvtPart',
        50, 'EA', 15, '12441', 5, 50, 10, 1, 0, true)
     RETURNING id, line_id`,
    [salesOrderId]
  );
  const lineByNumber = new Map(lineResult.rows.map((line) => [Number(line.line_id), Number(line.id)]));

  const purchaseOrderId = baseId + 10;
  const purchaseOrderRef = `PO-LINKED-${suffix}`;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor, status, status_text,
       destination_location_id, destination_location, receipt_status,
       netsuite_active
     ) VALUES ($1, $2, current_date, 'Linked vendor', 'B', 'Pending Receipt',
               15, '12441', 'open', true)`,
    [purchaseOrderId, purchaseOrderRef]
  );
  const purchaseLine = await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location, pallet_qty, piece_qty,
       to_plt, to_pcs, netsuite_active
     ) VALUES ($1, 1, 880101, 'Partial linked item', 'PARTIAL-LINKED', 'InvtPart',
               35, 'EA', 15, '12441', 3.5, 35, 10, 1, true)
     RETURNING id`,
    [purchaseOrderId]
  );
  await query(
    `INSERT INTO dispatch_so_po_allocations (
       sales_order_id, sales_order_ref, sales_line_id,
       po_order_id, po_order_ref, po_line_id,
       item_id, item_name, sku,
       allocated_pallet_qty, allocated_piece_qty, allocated_sales_qty,
       status, dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
     ) VALUES
       ($1, $2, $3, $4, $5, $6, 880101, 'Partial linked item', 'PARTIAL-LINKED',
        2, 20, 20, 'active', $2, 'normal', $7),
       ($1, $2, $3, $4, $5, $6, 880101, 'Partial linked item', 'PARTIAL-LINKED',
        1.5, 15, 15, 'cancelled', $2, 'normal', $7)`,
    [
      salesOrderId,
      salesOrderRef,
      lineByNumber.get(1),
      purchaseOrderId,
      purchaseOrderRef,
      purchaseLine.rows[0].id,
      `${salesOrderRef}::${salesOrderRef}::${lineByNumber.get(1)}`
    ]
  );

  const dependencies = [
    { offset: 20, line: 1, mode: "direct_to_customer", sales: 30, pallets: 3 },
    { offset: 21, line: 1, mode: "yard_replenishment", sales: 10, pallets: 1 },
    { offset: 22, line: 2, mode: "direct_to_customer", sales: 50, pallets: 5 }
  ];
  for (const dependency of dependencies) {
    const transferOrderId = baseId + dependency.offset;
    const transferOrderRef = `TO-LINKED-${suffix}-${dependency.offset}`;
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         outbound_operator_status, local_yard_order_status,
         fulfillment_status, netsuite_active
       ) VALUES ($1, $2, current_date, 'B', 'Pending Fulfillment',
                 28, '2967', 15, '12441', 'open', 'Open', 'not_fulfilled', true)`,
      [transferOrderId, transferOrderRef]
    );
    const inserted = await query(
      `INSERT INTO order_dependencies (
         sales_order_id, sales_order_ref, transfer_order_id, transfer_order_ref,
         dependency_mode, same_load_required, status,
         source_location_id, source_location,
         accounting_destination_location_id, accounting_destination_location,
         dispatch_target_ref, dispatch_target_kind
       ) VALUES ($1, $2, $3, $4, $5, true, 'active',
                 28, '2967', 15, '12441', $2, 'normal')
       RETURNING id`,
      [salesOrderId, salesOrderRef, transferOrderId, transferOrderRef, dependency.mode]
    );
    const salesLineId = lineByNumber.get(dependency.line);
    await query(
      `INSERT INTO order_dependency_lines (
         dependency_id, sales_line_id, item_id, item_name, unit,
         allocated_quantity, pallet_qty, piece_qty,
         line_role, dispatch_target_line_key
       ) VALUES ($1, $2, $3, $4, 'EA', $5, $6, $5,
                 'sales_allocation', $7)`,
      [
        inserted.rows[0].id,
        salesLineId,
        dependency.line === 1 ? 880101 : 880102,
        dependency.line === 1 ? "Partial linked item" : "Fully linked item",
        dependency.sales,
        dependency.pallets,
        `${salesOrderRef}::${salesOrderRef}::${salesLineId}`
      ]
    );
  }
  return { salesOrderId };
}

test("L1-L4 repository projects PO and direct TO separately and retains fully linked evidence", async () => {
  await inRollback(async () => {
    const fixture = await seedLinkedDeliveryOrder();
    const order = await getDeliveryOrder(fixture.salesOrderId);
    assert.ok(order);
    assert.equal(order.lines.length, 2, "the fully linked line must remain visible for audit and scheduling");

    const partial = order.lines.find((line) => line.sku === "PARTIAL-LINKED");
    assert.ok(partial);
    assert.equal(Number(partial.original_quantity), 100);
    assert.equal(Number(partial.linked_po_sales_qty), 20);
    assert.equal(Number(partial.linked_direct_to_sales_qty), 30);
    assert.equal(Number(partial.linked_allocated_sales_qty), 50);
    assert.equal(Number(partial.operator_required_sales_qty), 50);
    assert.equal(Number(partial.quantity), 50);
    assert.equal(Number(partial.pallet_qty), 5);
    assert.equal(partial.linked_quantity_blocked, false);

    const fullyLinked = order.lines.find((line) => line.sku === "FULLY-LINKED");
    assert.ok(fullyLinked);
    assert.equal(Number(fullyLinked.original_quantity), 50);
    assert.equal(Number(fullyLinked.linked_po_sales_qty), 0);
    assert.equal(Number(fullyLinked.linked_direct_to_sales_qty), 50);
    assert.equal(Number(fullyLinked.operator_required_sales_qty), 0);
    assert.equal(fullyLinked.no_yard_load_required, true);
    assert.equal(fullyLinked.linked_supply_label, "No yard load required—direct supply");
  });
});
