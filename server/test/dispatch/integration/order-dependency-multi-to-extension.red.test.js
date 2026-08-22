import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { resolveDispatchSalesTarget } from "../../../src/dispatch-order-target-repository.js";
import {
  createOrderDependency,
  listOrderDependencies
} from "../../../src/order-dependency-repository.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "../../../src/order-sync-repository.js";

after(closeDb);

async function seedSalesOrder({ id, ref, itemId, lineId, quantity = 10 }) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       fulfillment_status, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active
     ) VALUES (
       $1, $2, current_date, 'Multiple TO Regression', 'B',
       'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery',
       'open', 'open', 'Open', '100 Test Street, Toronto, ON', true
     )`,
    [id, ref]
  );
  return (await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku,
       item_type, item_type_text, quantity, unit,
       pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       netsuite_committed_qty, netsuite_backordered_qty,
       netsuite_active, location_id, location
     ) VALUES (
       $1, $2, $3, 'Multiple TO Item', $4,
       'InvtPart', 'Inventory Item', $5, 'EA',
       0, 0, 0, $5,
       0, 0, 0, 1,
       0, $5, true, 15, '12441'
     ) RETURNING *`,
    [id, lineId, itemId, `MULTI-TO-${itemId}`, quantity]
  )).rows[0];
}

async function seedTransferOrder({ id, ref, itemId, lineId, quantity = 10 }) {
  const order = {
    id,
    tranid: ref,
    trandate: new Date().toISOString().slice(0, 10),
    status: "B",
    status_text: "Transfer Order : Pending Fulfillment",
    source_location_id: 1,
    source_location: "3445",
    destination_location_id: 15,
    destination_location: "12441"
  };
  const line = {
    line_id: lineId,
    item_id: itemId,
    item_name: "Multiple TO Item",
    sku: `MULTI-TO-${itemId}`,
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    quantity,
    unit: "EA",
    netsuite_received_qty: 0,
    location_id: 1,
    location: "3445"
  };
  await upsertOutboundTransferOrders([order]);
  await upsertOutboundTransferOrderLines(id, [line]);
  await upsertInboundTransferOrders([order]);
  await upsertInboundTransferOrderLines(id, [{ ...line, location_id: 15, location: "12441" }]);
}

async function targetAllocation(targetRef, pieces) {
  const target = await resolveDispatchSalesTarget({ dispatchTargetRef: targetRef });
  assert.equal(target.lines.length, 1);
  return {
    signature: target.signature,
    allocations: [{
      targetLineKey: target.lines[0].targetLineKey,
      quantities: { pieces }
    }]
  };
}

test("same TO extends its existing target while distinct TOs may share that target", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const base = 8_940_000_000_000 + Number(suffix.slice(-9)) * 20;
      const itemId = base + 1;
      const salesRef = `SO-MULTI-TO-${suffix}`;
      const otherSalesRef = `SO-MULTI-TO-OTHER-${suffix}`;
      const firstTransferRef = `TO-MULTI-A-${suffix}`;
      const secondTransferRef = `TO-MULTI-B-${suffix}`;

      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, item_type, item_type_text, stock_unit, item_weight,
           to_pcs
         ) VALUES ($1, 'Multiple TO Item', 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
        [itemId]
      );
      await seedSalesOrder({ id: base + 2, ref: salesRef, itemId, lineId: base + 3 });
      await seedSalesOrder({ id: base + 4, ref: otherSalesRef, itemId, lineId: base + 5 });
      await seedTransferOrder({ id: base + 6, ref: firstTransferRef, itemId, lineId: base + 7 });
      await seedTransferOrder({ id: base + 8, ref: secondTransferRef, itemId, lineId: base + 9 });

      const firstAllocation = await targetAllocation(salesRef, 2);
      const created = await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: firstTransferRef,
        targetSignature: firstAllocation.signature,
        mode: "direct_to_customer",
        allocations: firstAllocation.allocations,
        operatorId: "multi-to-red"
      });
      assert.equal(created.lines[0].allocatedQuantity, 2);

      const extensionAllocation = await targetAllocation(salesRef, 3);
      const extended = await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: firstTransferRef,
        targetSignature: extensionAllocation.signature,
        mode: "direct_to_customer",
        allocations: extensionAllocation.allocations,
        operatorId: "multi-to-red"
      });
      assert.equal(extended.id, created.id);
      assert.equal(created.effectiveAction, "link_to");
      assert.equal(extended.effectiveAction, "extend_to");
      assert.equal(extended.lines.length, 1);
      assert.equal(extended.lines[0].allocatedQuantity, 5);

      const secondAllocation = await targetAllocation(salesRef, 2);
      const second = await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: secondTransferRef,
        targetSignature: secondAllocation.signature,
        mode: "direct_to_customer",
        allocations: secondAllocation.allocations,
        operatorId: "multi-to-red"
      });
      assert.equal(second.effectiveAction, "link_to");
      assert.notEqual(second.id, created.id);
      const dependencies = await listOrderDependencies({ salesOrderRef: salesRef });
      assert.equal(dependencies.length, 2);
      assert.deepEqual(
        dependencies.map((entry) => entry.transferOrderRef).sort(),
        [firstTransferRef, secondTransferRef].sort()
      );

      const crossTargetAllocation = await targetAllocation(otherSalesRef, 1);
      await assert.rejects(
        createOrderDependency({
          dispatchTargetRef: otherSalesRef,
          transferOrderRef: firstTransferRef,
          targetSignature: crossTargetAllocation.signature,
          mode: "direct_to_customer",
          allocations: crossTargetAllocation.allocations,
          operatorId: "multi-to-red"
        }),
        (error) => error?.status === 409 && error?.code === "TO_ALREADY_LINKED_ELSEWHERE"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("same-target extension cannot silently change dependency mode", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const base = 8_950_000_000_000 + Number(suffix.slice(-9)) * 20;
      const itemId = base + 1;
      const salesRef = `SO-MODE-${suffix}`;
      const transferRef = `TO-MODE-${suffix}`;
      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, item_type, item_type_text, stock_unit, item_weight, to_pcs
         ) VALUES ($1, 'Multiple TO Item', 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
        [itemId]
      );
      await seedSalesOrder({ id: base + 2, ref: salesRef, itemId, lineId: base + 3 });
      await seedTransferOrder({ id: base + 4, ref: transferRef, itemId, lineId: base + 5 });
      const first = await targetAllocation(salesRef, 2);
      await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: transferRef,
        targetSignature: first.signature,
        mode: "yard_replenishment",
        allocations: first.allocations,
        operatorId: "multi-to-mode-red"
      });
      const extension = await targetAllocation(salesRef, 1);
      await assert.rejects(
        createOrderDependency({
          dispatchTargetRef: salesRef,
          transferOrderRef: transferRef,
          targetSignature: extension.signature,
          mode: "direct_to_customer",
          allocations: extension.allocations,
          operatorId: "multi-to-mode-red"
        }),
        (error) => error?.status === 409 && error?.code === "DEPENDENCY_MODE_MISMATCH"
      );
    });
  } finally {
    await rollback.rollback();
  }
});
