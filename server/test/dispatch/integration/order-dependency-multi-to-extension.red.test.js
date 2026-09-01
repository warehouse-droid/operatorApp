import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { dispatchPhysicalStopVisits } from "../../../src/dispatch-load-assignment.js";
import { resolveDispatchSalesTarget } from "../../../src/dispatch-order-target-repository.js";
import {
  cancelLocalCoOrder,
  enrichDispatchOrdersWithPoTargetAllocations
} from "../../../src/dispatch-repository.js";
import {
  createOrderDependency,
  enrichDispatchOrdersWithDependencies,
  listOrderDependencies,
  syncOrderDependenciesForTransferOrder,
  validateDispatchPlanDependencies
} from "../../../src/order-dependency-repository.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "../../../src/order-sync-repository.js";
import { reconcileDependencyManagedPickups } from "../../../src/scm-dependency-plan-reconciler.js";

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

async function seedTransferOrder({
  id,
  ref,
  itemId,
  lineId,
  quantity = 10,
  sourceLocationId = 1,
  sourceLocation = "3445",
  destinationLocationId = 15,
  destinationLocation = "12441"
}) {
  const order = {
    id,
    tranid: ref,
    trandate: new Date().toISOString().slice(0, 10),
    status: "B",
    status_text: "Transfer Order : Pending Fulfillment",
    source_location_id: sourceLocationId,
    source_location: sourceLocation,
    destination_location_id: destinationLocationId,
    destination_location: destinationLocation
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
    location_id: sourceLocationId,
    location: sourceLocation
  };
  await upsertOutboundTransferOrders([order]);
  await upsertOutboundTransferOrderLines(id, [line]);
  await upsertInboundTransferOrders([order]);
  await upsertInboundTransferOrderLines(id, [{
    ...line,
    location_id: destinationLocationId,
    location: destinationLocation
  }]);
}

async function seedMultiLineTransferOrder({
  id,
  ref,
  lines,
  sourceLocationId,
  sourceLocation,
  destinationLocationId = 15,
  destinationLocation = "12441"
}) {
  const order = {
    id,
    tranid: ref,
    trandate: new Date().toISOString().slice(0, 10),
    status: "B",
    status_text: "Transfer Order : Pending Fulfillment",
    source_location_id: sourceLocationId,
    source_location: sourceLocation,
    destination_location_id: destinationLocationId,
    destination_location: destinationLocation
  };
  const transferLines = lines.map((line) => ({
    line_id: line.lineId,
    item_id: line.itemId,
    item_name: line.itemName,
    sku: line.sku,
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    quantity: line.quantity,
    unit: "EA",
    netsuite_received_qty: 0,
    location_id: sourceLocationId,
    location: sourceLocation
  }));
  await upsertOutboundTransferOrders([order]);
  await upsertOutboundTransferOrderLines(id, transferLines);
  await upsertInboundTransferOrders([order]);
  await upsertInboundTransferOrderLines(id, transferLines.map((line) => ({
    ...line,
    location_id: destinationLocationId,
    location: destinationLocation
  })));
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

async function seedPurchaseOrderAllocation({
  id,
  ref,
  lineId,
  itemId,
  salesOrderId,
  salesOrderRef,
  salesLineId,
  targetLineKey,
  quantity,
  vendorYard
}) {
  const purchaseLine = (await query(
    `WITH inserted_order AS (
       INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, source_location_id,
         source_location, dispatch_vendor_yard, dispatch_address, receipt_status,
         initial_scm_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, current_date, $3, 'Extreme Replay Vendor', 'pendingReceipt',
         'Purchase Order : Pending Receipt', 15, '12441', null,
         $4, $4, '10 Extreme Vendor Road', 'not_received',
         'Queued', true, now()
       )
       RETURNING netsuite_id
     )
     INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku,
       item_type, item_type_text, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       netsuite_received_qty, netsuite_active, synced_at, raw
     )
     SELECT netsuite_id, $5, $6, 'Multiple TO Item', $7,
            'InvtPart', 'Inventory Item', $8, 'EA',
            15, '12441', 0, 0, 0, $8,
            0, 0, 0, 1,
            0, true, now(), '{}'::jsonb
       FROM inserted_order
     RETURNING id`,
    [id, ref, id + 10, vendorYard, lineId, itemId, `MULTI-TO-${itemId}`, quantity]
  )).rows[0];
  await query(
    `INSERT INTO dispatch_so_po_allocations (
       sales_order_id, sales_order_ref, sales_line_id,
       po_order_id, po_order_ref, po_line_id,
       item_id, item_name, sku,
       allocated_piece_qty, allocated_sales_qty, status, created_by,
       dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, 'Multiple TO Item', $8,
       $9, $9, 'active', 'extreme-mixed-replay',
       $2, 'normal', $10
     )`,
    [
      salesOrderId,
      salesOrderRef,
      salesLineId,
      id,
      ref,
      purchaseLine.id,
      itemId,
      `MULTI-TO-${itemId}`,
      quantity,
      targetLineKey
    ]
  );
}

async function seedMultiLinePurchaseOrderAllocations({
  id,
  ref,
  salesOrderId,
  salesOrderRef,
  lines,
  vendorYard
}) {
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location_id,
       source_location, dispatch_vendor_yard, dispatch_address, receipt_status,
       initial_scm_status, netsuite_active, synced_at
     ) VALUES (
       $1, $2, current_date, $3, 'Ten Line Replay Vendor', 'pendingReceipt',
       'Purchase Order : Pending Receipt', 15, '12441', null,
       $4, $4, '20 Ten Line Vendor Road', 'not_received',
       'Queued', true, now()
     )`,
    [id, ref, id + 10, vendorYard]
  );
  for (const line of lines) {
    const purchaseLine = (await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku,
         item_type, item_type_text, quantity, unit,
         location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
         to_plt, to_lyr, to_sec, to_pcs,
         netsuite_received_qty, netsuite_active, synced_at, raw
       ) VALUES (
         $1, $2, $3, $4, $5,
         'InvtPart', 'Inventory Item', $6, 'EA',
         15, '12441', 0, 0, 0, $6,
         0, 0, 0, 1,
         0, true, now(), '{}'::jsonb
       ) RETURNING id`,
      [id, line.poLineId, line.itemId, line.itemName, line.sku, line.quantity]
    )).rows[0];
    await query(
      `INSERT INTO dispatch_so_po_allocations (
         sales_order_id, sales_order_ref, sales_line_id,
         po_order_id, po_order_ref, po_line_id,
         item_id, item_name, sku,
         allocated_piece_qty, allocated_sales_qty, status, created_by,
         dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8, $9,
         $10, $10, 'active', 'ten-line-extreme-replay',
         $2, 'normal', $11
       )`,
      [
        salesOrderId,
        salesOrderRef,
        line.salesLineId,
        id,
        ref,
        purchaseLine.id,
        line.itemId,
        line.itemName,
        line.sku,
        line.quantity,
        line.targetLineKey
      ]
    );
  }
}

async function seedCoOverlay({ transferOrderRef, fromLocationId, fromLocation, toLocationId, toLocation }) {
  const coRef = `CO-${transferOrderRef}`;
  await query(
    `INSERT INTO local_co_orders (
       co_ref, source_order_ref, from_location_id, from_location,
       to_location_id, to_location, status, created_by, details
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_load', 'seeded-extreme-replay', $7::jsonb)`,
    [
      coRef,
      transferOrderRef,
      fromLocationId,
      fromLocation,
      toLocationId,
      toLocation,
      JSON.stringify({ seededReplay: true })
    ]
  );
  return coRef;
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

test("partial direct pickup and replenishment TOs preserve the SO residual without quantity attention", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const base = 8_960_000_000_000 + Number(suffix.slice(-9)) * 20;
      const itemId = base + 1;
      const salesRef = `SO-PARTIAL-TO-${suffix}`;
      const directTransferRef = `TO-PARTIAL-DIRECT-${suffix}`;
      const replenishmentTransferRef = `TO-PARTIAL-REPLENISH-${suffix}`;
      const directTransferId = base + 4;
      const replenishmentTransferId = base + 6;

      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, item_type, item_type_text, stock_unit, item_weight, to_pcs
         ) VALUES ($1, 'Partial TO Item', 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
        [itemId]
      );
      await seedSalesOrder({
        id: base + 2,
        ref: salesRef,
        itemId,
        lineId: base + 3,
        quantity: 50
      });
      await seedTransferOrder({
        id: directTransferId,
        ref: directTransferRef,
        itemId,
        lineId: base + 5,
        quantity: 20,
        sourceLocationId: 1,
        sourceLocation: "3445"
      });
      await seedTransferOrder({
        id: replenishmentTransferId,
        ref: replenishmentTransferRef,
        itemId,
        lineId: base + 7,
        quantity: 30,
        sourceLocationId: 26,
        sourceLocation: "150"
      });

      const directAllocation = await targetAllocation(salesRef, 20);
      await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: directTransferRef,
        targetSignature: directAllocation.signature,
        mode: "direct_to_customer",
        allocations: directAllocation.allocations,
        operatorId: "partial-to-red"
      });
      const replenishmentAllocation = await targetAllocation(salesRef, 30);
      await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: replenishmentTransferRef,
        targetSignature: replenishmentAllocation.signature,
        mode: "yard_replenishment",
        allocations: replenishmentAllocation.allocations,
        operatorId: "partial-to-red"
      });

      await query(
        `UPDATE transfer_order_lines
            SET quantity = CASE
                  WHEN transfer_order_id = $1 THEN 10
                  WHEN transfer_order_id = $2 THEN 20
                  ELSE quantity
                END
          WHERE transfer_order_id IN ($1, $2)`,
        [directTransferId, replenishmentTransferId]
      );

      const directSync = await syncOrderDependenciesForTransferOrder(directTransferId);
      const replenishmentSync = await syncOrderDependenciesForTransferOrder(replenishmentTransferId);
      assert.equal(directSync[0]?.attention, false);
      assert.equal(replenishmentSync[0]?.attention, false);

      const dependencies = await listOrderDependencies({ salesOrderRef: salesRef });
      const direct = dependencies.find((entry) => entry.transferOrderRef === directTransferRef);
      const replenishment = dependencies.find((entry) => entry.transferOrderRef === replenishmentTransferRef);
      assert.equal(direct?.status, "active");
      assert.equal(replenishment?.status, "active");
      assert.equal(direct?.lines[0]?.allocatedQuantity, 20);
      assert.equal(direct?.lines[0]?.effectiveAllocatedQuantity, 10);
      assert.equal(replenishment?.lines[0]?.allocatedQuantity, 30);
      assert.equal(replenishment?.lines[0]?.effectiveAllocatedQuantity, 20);

      const [enriched] = await enrichDispatchOrdersWithDependencies([{
        id: salesRef,
        type: "SO",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        items: [{
          itemId,
          itemName: "Partial TO Item",
          quantity: 50,
          salesQty: 50,
          pallets: 0,
          layers: 0,
          sections: 0,
          pieces: 50
        }]
      }]);
      assert.deepEqual(enriched.pickupLocations, ["12441", "3445"]);
      assert.equal(enriched.pickupLocations.includes("150"), false);
      assert.equal(enriched.directPickupManifest.length, 1);
      assert.equal(enriched.directPickupManifest[0].transferOrderRef, directTransferRef);
      assert.equal(enriched.directPickupManifest[0].items[0].quantity, 10);
      const normalYardPickupQuantity = 50 - enriched.directPickupManifest[0].items[0].quantity;
      assert.equal(normalYardPickupQuantity, 40);
      assert.equal(normalYardPickupQuantity + enriched.directPickupManifest[0].items[0].quantity, 50);

      const conflicts = await validateDispatchPlanDependencies({
        id: 0,
        planDate: "2099-01-01",
        orders: [
          enriched,
          {
            id: replenishmentTransferRef,
            type: "TO",
            sourceYard: "150",
            pickupLocations: ["150"]
          }
        ],
        trucks: [{
          id: "PARTIAL-TO-TRUCK",
          plate: "PARTIAL-TO-TRUCK",
          loads: [{
            id: "PARTIAL-TO-LOAD",
            name: "Partial TO Load",
            stops: [
              { id: "replenish-pick", type: "pick", orderId: replenishmentTransferRef, location: "150" },
              { id: "replenish-drop", type: "drop", orderId: replenishmentTransferRef, location: "12441" },
              { id: "sales-base-pick", type: "pick", orderId: salesRef, location: "12441" },
              { id: "sales-direct-pick", type: "pick", orderId: salesRef, location: "3445" },
              { id: "sales-drop", type: "drop", orderId: salesRef, location: "Customer" }
            ]
          }]
        }]
      });
      assert.deepEqual(conflicts, []);
    });
  } finally {
    await rollback.rollback();
  }
});

test("missing linked TO material-line identity remains an attention blocker", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const base = 8_980_000_000_000 + Number(suffix.slice(-9)) * 20;
      const itemId = base + 1;
      const salesRef = `SO-MISSING-TO-LINE-${suffix}`;
      const transferRef = `TO-MISSING-LINE-${suffix}`;
      const transferId = base + 4;
      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, item_type, item_type_text, stock_unit, item_weight, to_pcs
         ) VALUES ($1, 'Missing TO Line Item', 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
        [itemId]
      );
      await seedSalesOrder({ id: base + 2, ref: salesRef, itemId, lineId: base + 3, quantity: 10 });
      await seedTransferOrder({ id: transferId, ref: transferRef, itemId, lineId: base + 5, quantity: 10 });
      const allocation = await targetAllocation(salesRef, 10);
      const dependency = await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: transferRef,
        targetSignature: allocation.signature,
        mode: "direct_to_customer",
        allocations: allocation.allocations,
        operatorId: "missing-to-line-red"
      });
      await query(
        `UPDATE order_dependency_lines
            SET transfer_outbound_line_id = null,
                transfer_receiving_line_id = null
          WHERE dependency_id = $1`,
        [dependency.id]
      );

      const sync = await syncOrderDependenciesForTransferOrder(transferId);
      assert.equal(sync[0]?.attention, true);
      assert.match(sync[0]?.attentionReason || "", /no longer contains a linked material line/u);
      const [stored] = await listOrderDependencies({ salesOrderRef: salesRef });
      assert.equal(stored.status, "attention");
    });
  } finally {
    await rollback.rollback();
  }
});

test("four TO dependencies plus one PO preserve mixed direct, replenishment, and zero-source routing", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const base = 8_990_000_000_000 + Number(suffix.slice(-9)) * 100;
      const itemId = base + 1;
      const salesOrderId = base + 2;
      const salesRef = `SO-EXTREME-MIXED-${suffix}`;
      const purchaseOrderRef = `PO-EXTREME-MIXED-${suffix}`;
      const transfers = [
        {
          id: base + 10,
          ref: `TO-EXTREME-DIRECT-A-${suffix}`,
          mode: "direct_to_customer",
          saved: 15,
          current: 10,
          sourceLocationId: 1,
          sourceLocation: "3445"
        },
        {
          id: base + 20,
          ref: `TO-EXTREME-DIRECT-B-${suffix}`,
          mode: "direct_to_customer",
          saved: 15,
          current: 15,
          sourceLocationId: 26,
          sourceLocation: "150"
        },
        {
          id: base + 30,
          ref: `TO-EXTREME-REPLENISH-A-${suffix}`,
          mode: "yard_replenishment",
          saved: 20,
          current: 20,
          sourceLocationId: 28,
          sourceLocation: "2967"
        },
        {
          id: base + 40,
          ref: `TO-EXTREME-REPLENISH-B-${suffix}`,
          mode: "yard_replenishment",
          saved: 20,
          current: 15,
          sourceLocationId: 1,
          sourceLocation: "3445"
        }
      ];

      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, item_type, item_type_text, stock_unit, item_weight, to_pcs
         ) VALUES ($1, 'Multiple TO Item', 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
        [itemId]
      );
      const salesLine = await seedSalesOrder({
        id: salesOrderId,
        ref: salesRef,
        itemId,
        lineId: base + 3,
        quantity: 100
      });
      const initialTarget = await resolveDispatchSalesTarget({ dispatchTargetRef: salesRef });
      await seedPurchaseOrderAllocation({
        id: base + 50,
        ref: purchaseOrderRef,
        lineId: base + 51,
        itemId,
        salesOrderId,
        salesOrderRef: salesRef,
        salesLineId: salesLine.id,
        targetLineKey: initialTarget.lines[0].targetLineKey,
        quantity: 10,
        vendorYard: "Extreme Vendor Yard"
      });

      for (const [index, transfer] of transfers.entries()) {
        await seedTransferOrder({
          id: transfer.id,
          ref: transfer.ref,
          itemId,
          lineId: base + 60 + index,
          quantity: transfer.saved,
          sourceLocationId: transfer.sourceLocationId,
          sourceLocation: transfer.sourceLocation
        });
        const allocation = await targetAllocation(salesRef, transfer.saved);
        await createOrderDependency({
          dispatchTargetRef: salesRef,
          transferOrderRef: transfer.ref,
          targetSignature: allocation.signature,
          mode: transfer.mode,
          allocations: allocation.allocations,
          operatorId: "extreme-mixed-replay"
        });
      }
      for (const transfer of transfers) {
        await query(
          "UPDATE transfer_order_lines SET quantity = $2 WHERE transfer_order_id = $1",
          [transfer.id, transfer.current]
        );
        const sync = await syncOrderDependenciesForTransferOrder(transfer.id);
        assert.equal(sync[0]?.attention, false, transfer.ref);
      }
      const seededCoMask = 0b0101;
      const seededCoCandidates = [
        { index: 0, toLocationId: 28, toLocation: "2967" },
        { index: 1, toLocationId: 1, toLocation: "3445" },
        { index: 2, toLocationId: 26, toLocation: "150" },
        { index: 3, toLocationId: 28, toLocation: "2967" }
      ];
      const seededCos = [];
      for (const candidate of seededCoCandidates) {
        if ((seededCoMask & (1 << candidate.index)) === 0) {continue;}
        const transfer = transfers[candidate.index];
        seededCos.push({
          transfer,
          coRef: await seedCoOverlay({
            transferOrderRef: transfer.ref,
            fromLocationId: transfer.sourceLocationId,
            fromLocation: transfer.sourceLocation,
            toLocationId: candidate.toLocationId,
            toLocation: candidate.toLocation
          })
        });
      }
      assert.deepEqual(
        seededCos.map(({ transfer }) => transfer.ref),
        [transfers[0].ref, transfers[2].ref],
        "the seeded CO selection must be deterministic"
      );

      const baseOrder = {
        id: salesRef,
        type: "SO",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        items: [{
          lineRowId: salesLine.id,
          itemId,
          itemName: "Multiple TO Item",
          sku: `MULTI-TO-${itemId}`,
          quantity: 100,
          salesQty: 100,
          pallets: 0,
          layers: 0,
          sections: 0,
          pieces: 100
        }]
      };
      const enrich = async () => {
        const [poLinked] = await enrichDispatchOrdersWithPoTargetAllocations([baseOrder]);
        return (await enrichDispatchOrdersWithDependencies([poLinked]))[0];
      };
      const materializeRoute = (order) => reconcileDependencyManagedPickups({
        plan: {
          id: 0,
          planDate: "2099-01-01",
          orders: [order],
          trucks: [{
            id: "EXTREME-TRUCK",
            plate: "EXTREME-TRUCK",
            loads: [{
              id: "EXTREME-LOAD",
              name: "Extreme mixed dependencies",
              stops: [{ id: "extreme-drop", type: "drop", orderId: salesRef, location: "Customer" }]
            }]
          }]
        },
        enrichedOrders: [order],
        affectedTargetRefs: [salesRef]
      });
      const assertNonEmptyRoute = (order, expectedLocations) => {
        const plan = materializeRoute(order);
        const truck = plan.trucks[0];
        const load = truck.loads[0];
        const pickupLocations = load.stops
          .filter((stop) => stop.type === "pick")
          .map((stop) => stop.location);
        assert.deepEqual(
          pickupLocations,
          order.pickupLocations,
          "materialized pickup order must follow the enriched route"
        );
        assert.deepEqual(new Set(pickupLocations), new Set(expectedLocations));
        const pickupVisits = dispatchPhysicalStopVisits(plan, truck, load)
          .filter((visit) => visit.type === "pick");
        assert.equal(pickupVisits.length, expectedLocations.length);
        assert.ok(pickupVisits.every((visit) => visit.pallets > 0), "no generated pickup may be empty");
      };

      const enriched = await enrich();
      assert.equal(enriched.orderDependencies.length, 4);
      assert.equal(enriched.poPickupManifest.length, 1);
      assert.deepEqual(
        new Set(enriched.pickupLocations),
        new Set(["12441", "Extreme Vendor Yard", "2967", "150"])
      );
      assert.equal(enriched.pickupLocations.includes("3445"), false, "replenishment-only yard must not leak");
      assert.deepEqual(
        enriched.directPickupManifest
          .map((entry) => [entry.transferOrderRef, entry.location, entry.items[0].quantity])
          .sort(([left], [right]) => left.localeCompare(right)),
        [
          [transfers[0].ref, "2967", 10],
          [transfers[1].ref, "150", 15]
        ].sort(([left], [right]) => left.localeCompare(right))
      );
      const poDirect = enriched.poPickupManifest[0].items[0].quantity;
      const toDirect = enriched.directPickupManifest
        .flatMap((entry) => entry.items)
        .reduce((sum, item) => sum + Number(item.quantity), 0);
      const baseResidual = 100 - poDirect - toDirect;
      assert.equal(baseResidual, 65);
      assert.equal(baseResidual + poDirect + toDirect, 100);
      assertNonEmptyRoute(enriched, ["12441", "Extreme Vendor Yard", "2967", "150"]);

      const zeroedDirect = transfers[1];
      await query(
        "UPDATE transfer_order_lines SET quantity = 0 WHERE transfer_order_id = $1",
        [zeroedDirect.id]
      );
      const zeroSync = await syncOrderDependenciesForTransferOrder(zeroedDirect.id);
      assert.equal(zeroSync[0]?.attention, false);
      const zeroed = await enrich();
      const zeroedDependency = zeroed.orderDependencies.find((entry) =>
        entry.transferOrderRef === zeroedDirect.ref);
      assert.equal(zeroedDependency.status, "active");
      assert.equal(zeroedDependency.lines[0].allocatedQuantity, zeroedDirect.saved);
      assert.equal(zeroedDependency.lines[0].effectiveAllocatedQuantity, 0);
      assert.deepEqual(
        new Set(zeroed.pickupLocations),
        new Set(["12441", "Extreme Vendor Yard", "2967"])
      );
      assert.equal(zeroed.directPickupManifest.some((entry) => entry.transferOrderRef === zeroedDirect.ref), false);
      const zeroedToDirect = zeroed.directPickupManifest
        .flatMap((entry) => entry.items)
        .reduce((sum, item) => sum + Number(item.quantity), 0);
      assert.equal(100 - poDirect - zeroedToDirect, 80);
      assertNonEmptyRoute(zeroed, ["12441", "Extreme Vendor Yard", "2967"]);
      const zeroedConflicts = await validateDispatchPlanDependencies({
        id: 0,
        planDate: "2099-01-01",
        orders: [
          zeroed,
          { id: transfers[2].ref, type: "TO", sourceYard: "2967", pickupLocations: ["2967"] },
          { id: transfers[3].ref, type: "TO", sourceYard: "3445", pickupLocations: ["3445"] }
        ],
        trucks: [{
          id: "EXTREME-ZERO-TRUCK",
          plate: "EXTREME-ZERO-TRUCK",
          loads: [{
            id: "EXTREME-ZERO-REPLENISH-LOAD",
            name: "Replenishment before zero-contribution route",
            stops: [
              { id: "zero-replenish-a-pick", type: "pick", orderId: transfers[2].ref, location: "2967" },
              { id: "zero-replenish-a-drop", type: "drop", orderId: transfers[2].ref, location: "12441" },
              { id: "zero-replenish-b-pick", type: "pick", orderId: transfers[3].ref, location: "3445" },
              { id: "zero-replenish-b-drop", type: "drop", orderId: transfers[3].ref, location: "12441" }
            ]
          }, {
            id: "EXTREME-ZERO-SALES-LOAD",
            name: "Zero-contribution direct source",
            stops: [
              { id: "zero-sales-base", type: "pick", orderId: salesRef, location: "12441" },
              { id: "zero-sales-po", type: "pick", orderId: salesRef, location: "Extreme Vendor Yard" },
              { id: "zero-sales-direct", type: "pick", orderId: salesRef, location: "2967" },
              { id: "zero-sales-drop", type: "drop", orderId: salesRef, location: "Customer" }
            ]
          }]
        }]
      });
      assert.deepEqual(zeroedConflicts, [], "zero-contribution direct TO must not require an empty pickup");

      await query(
        "UPDATE transfer_order_lines SET quantity = $2 WHERE transfer_order_id = $1",
        [zeroedDirect.id, zeroedDirect.current]
      );
      const restored = await enrich();
      assert.equal(restored.pickupLocations.filter((location) => location === "150").length, 1);
      assertNonEmptyRoute(restored, ["12441", "Extreme Vendor Yard", "2967", "150"]);

      const conflicts = await validateDispatchPlanDependencies({
        id: 0,
        planDate: "2099-01-01",
        orders: [
          restored,
          { id: transfers[2].ref, type: "TO", sourceYard: "2967", pickupLocations: ["2967"] },
          { id: transfers[3].ref, type: "TO", sourceYard: "3445", pickupLocations: ["3445"] }
        ],
        trucks: [{
          id: "EXTREME-VALIDATION-TRUCK",
          plate: "EXTREME-VALIDATION-TRUCK",
          loads: [{
            id: "EXTREME-VALIDATION-REPLENISH-LOAD",
            name: "Extreme replenishment load",
            stops: [
              { id: "replenish-a-pick", type: "pick", orderId: transfers[2].ref, location: "2967" },
              { id: "replenish-a-drop", type: "drop", orderId: transfers[2].ref, location: "12441" },
              { id: "replenish-b-pick", type: "pick", orderId: transfers[3].ref, location: "3445" },
              { id: "replenish-b-drop", type: "drop", orderId: transfers[3].ref, location: "12441" }
            ]
          }, {
            id: "EXTREME-VALIDATION-SALES-LOAD",
            name: "Extreme sales load",
            stops: [
              { id: "sales-base-pick", type: "pick", orderId: salesRef, location: "12441" },
              { id: "sales-po-pick", type: "pick", orderId: salesRef, location: "Extreme Vendor Yard" },
              { id: "sales-direct-a", type: "pick", orderId: salesRef, location: "2967" },
              { id: "sales-direct-b", type: "pick", orderId: salesRef, location: "150" },
              { id: "sales-drop", type: "drop", orderId: salesRef, location: "Customer" }
            ]
          }]
        }]
      });
      assert.deepEqual(conflicts, []);
      await cancelLocalCoOrder(seededCos[0].coRef, { requestedBy: "seeded-extreme-replay" });
      const canonicalDirectRoute = await enrich();
      assert.deepEqual(
        new Set(canonicalDirectRoute.pickupLocations),
        new Set(["12441", "Extreme Vendor Yard", "3445", "150"]),
        "cancelling the direct CO must restore its canonical TO source"
      );
      assertNonEmptyRoute(canonicalDirectRoute, ["12441", "Extreme Vendor Yard", "3445", "150"]);
    });
  } finally {
    await rollback.rollback();
  }
});

test("ten SO lines split exactly across direct TO, replenishment TO, direct PO, and seeded CO overlays", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const base = 9_010_000_000_000 + Number(suffix.slice(-9)) * 1_000;
      const salesOrderId = base + 1;
      const salesRef = `SO-TEN-LINE-${suffix}`;
      const directTransfer = {
        id: base + 100,
        ref: `TO0001-${suffix}`,
        sourceLocationId: 1,
        sourceLocation: "3445"
      };
      const replenishmentTransfer = {
        id: base + 200,
        ref: `TO0002-${suffix}`,
        sourceLocationId: 26,
        sourceLocation: "150"
      };
      const purchaseOrder = { id: base + 300, ref: `PO0001-${suffix}` };
      const salesLines = [];

      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer, status, status_text,
           outbound_location_id, outbound_location, sales_order_type,
           fulfillment_status, operator_status, local_yard_order_status,
           dispatch_address, netsuite_active
         ) VALUES (
           $1, $2, current_date, 'Ten Line Replay', 'B',
           'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery',
           'open', 'open', 'Open', '30 Ten Line Customer Road', true
         )`,
        [salesOrderId, salesRef]
      );
      for (let index = 0; index < 10; index += 1) {
        const itemId = base + 10 + index;
        const quantity = 10 + index;
        const itemName = `Ten Line Item ${index + 1}`;
        const sku = `TEN-LINE-${index + 1}-${suffix}`;
        await query(
          `INSERT INTO inventory_items (
             item_id, item_name, item_type, item_type_text, stock_unit, item_weight, to_pcs
           ) VALUES ($1, $2, 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
          [itemId, itemName]
        );
        const row = (await query(
          `INSERT INTO sales_order_lines (
             sales_order_id, line_id, item_id, item_name, sku,
             item_type, item_type_text, quantity, unit,
             pallet_qty, layer_qty, section_qty, piece_qty,
             to_plt, to_lyr, to_sec, to_pcs,
             netsuite_committed_qty, netsuite_backordered_qty,
             netsuite_active, location_id, location
           ) VALUES (
             $1, $2, $3, $4, $5,
             'InvtPart', 'Inventory Item', $6, 'EA',
             0, 0, 0, $6,
             0, 0, 0, 1,
             0, $6, true, 15, '12441'
           ) RETURNING *`,
          [salesOrderId, base + 30 + index, itemId, itemName, sku, quantity]
        )).rows[0];
        salesLines.push({
          itemId,
          itemName,
          sku,
          quantity,
          salesLineId: row.id,
          lineRowId: row.id,
          transferLineId: base + 50 + index,
          poLineId: base + 70 + index
        });
      }

      await seedMultiLineTransferOrder({
        ...directTransfer,
        lines: salesLines.slice(0, 3).map((line) => ({
          ...line,
          lineId: line.transferLineId
        }))
      });
      await seedMultiLineTransferOrder({
        ...replenishmentTransfer,
        lines: salesLines.slice(3, 6).map((line) => ({
          ...line,
          lineId: line.transferLineId
        }))
      });

      const directTarget = await resolveDispatchSalesTarget({ dispatchTargetRef: salesRef });
      const targetLineByItem = new Map(directTarget.lines.map((line) => [String(line.itemId), line]));
      await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: directTransfer.ref,
        targetSignature: directTarget.signature,
        mode: "direct_to_customer",
        allocations: salesLines.slice(0, 3).map((line) => ({
          targetLineKey: targetLineByItem.get(String(line.itemId)).targetLineKey,
          quantities: { pieces: line.quantity }
        })),
        operatorId: "ten-line-extreme-replay"
      });
      const replenishmentTarget = await resolveDispatchSalesTarget({ dispatchTargetRef: salesRef });
      const replenishmentLineByItem = new Map(
        replenishmentTarget.lines.map((line) => [String(line.itemId), line])
      );
      await createOrderDependency({
        dispatchTargetRef: salesRef,
        transferOrderRef: replenishmentTransfer.ref,
        targetSignature: replenishmentTarget.signature,
        mode: "yard_replenishment",
        allocations: salesLines.slice(3, 6).map((line) => ({
          targetLineKey: replenishmentLineByItem.get(String(line.itemId)).targetLineKey,
          quantities: { pieces: line.quantity }
        })),
        operatorId: "ten-line-extreme-replay"
      });
      const poTarget = await resolveDispatchSalesTarget({ dispatchTargetRef: salesRef });
      const poTargetLineByItem = new Map(poTarget.lines.map((line) => [String(line.itemId), line]));
      await seedMultiLinePurchaseOrderAllocations({
        ...purchaseOrder,
        salesOrderId,
        salesOrderRef: salesRef,
        vendorYard: "Ten Line Vendor Yard",
        lines: salesLines.slice(6).map((line) => ({
          ...line,
          targetLineKey: poTargetLineByItem.get(String(line.itemId)).targetLineKey
        }))
      });

      const seededCoMask = 0b11;
      const directCoRef = (seededCoMask & 0b01) === 0 ? "" : await seedCoOverlay({
        transferOrderRef: directTransfer.ref,
        fromLocationId: directTransfer.sourceLocationId,
        fromLocation: directTransfer.sourceLocation,
        toLocationId: 28,
        toLocation: "2967"
      });
      const replenishmentCoRef = (seededCoMask & 0b10) === 0 ? "" : await seedCoOverlay({
        transferOrderRef: replenishmentTransfer.ref,
        fromLocationId: replenishmentTransfer.sourceLocationId,
        fromLocation: replenishmentTransfer.sourceLocation,
        toLocationId: 1,
        toLocation: "3445"
      });
      assert.ok(directCoRef && replenishmentCoRef, "the seeded CO mask must select both replay variants");

      const baseOrder = {
        id: salesRef,
        type: "SO",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        items: salesLines.map((line) => ({
          lineRowId: line.lineRowId,
          itemId: line.itemId,
          itemName: line.itemName,
          sku: line.sku,
          quantity: line.quantity,
          salesQty: line.quantity,
          pallets: 0,
          layers: 0,
          sections: 0,
          pieces: line.quantity
        }))
      };
      const enrich = async () => {
        const [poLinked] = await enrichDispatchOrdersWithPoTargetAllocations([baseOrder]);
        return (await enrichDispatchOrdersWithDependencies([poLinked]))[0];
      };
      const enriched = await enrich();
      assert.equal(enriched.items.length, 10, "the customer drop must retain all ten SO lines");
      assert.equal(enriched.orderDependencies.length, 2);
      assert.equal(enriched.directPickupManifest.length, 1);
      assert.equal(enriched.directPickupManifest[0].location, "2967");
      assert.equal(enriched.directPickupManifest[0].items.length, 3);
      assert.equal(enriched.poPickupManifest.length, 1);
      assert.equal(enriched.poPickupManifest[0].items.length, 4);
      assert.deepEqual(
        new Set(enriched.pickupLocations),
        new Set(["12441", "2967", "Ten Line Vendor Yard"])
      );
      assert.equal(enriched.pickupLocations.includes("150"), false);
      assert.equal(enriched.pickupLocations.includes("3445"), false,
        "the replenishment CO destination must not leak into the SO route");

      const directDependency = enriched.orderDependencies.find((entry) =>
        entry.transferOrderRef === directTransfer.ref);
      const replenishmentDependency = enriched.orderDependencies.find((entry) =>
        entry.transferOrderRef === replenishmentTransfer.ref);
      assert.equal(directDependency.lines.length, 3);
      assert.equal(replenishmentDependency.lines.length, 3);
      const ownershipCounts = new Map(salesLines.map((line) => [String(line.itemId), 0]));
      const claim = (itemId) => ownershipCounts.set(
        String(itemId),
        Number(ownershipCounts.get(String(itemId)) || 0) + 1
      );
      enriched.directPickupManifest.flatMap((entry) => entry.items).forEach((item) => claim(item.itemId));
      replenishmentDependency.lines
        .filter((line) => line.lineRole === "sales_allocation")
        .forEach((line) => claim(line.itemId));
      enriched.poPickupManifest.flatMap((entry) => entry.items).forEach((item) => claim(item.itemId));
      assert.deepEqual([...ownershipCounts.values()], Array(10).fill(1),
        "each SO line must be owned by exactly one TO/PO path");

      const totalQuantity = salesLines.reduce((sum, line) => sum + line.quantity, 0);
      const directQuantity = enriched.directPickupManifest.flatMap((entry) => entry.items)
        .reduce((sum, item) => sum + Number(item.quantity), 0);
      const poQuantity = enriched.poPickupManifest.flatMap((entry) => entry.items)
        .reduce((sum, item) => sum + Number(item.quantity), 0);
      const baseQuantity = totalQuantity - directQuantity - poQuantity;
      const replenishmentQuantity = salesLines.slice(3, 6)
        .reduce((sum, line) => sum + line.quantity, 0);
      assert.equal(baseQuantity, replenishmentQuantity);
      assert.equal(baseQuantity + directQuantity + poQuantity, totalQuantity);

      const route = reconcileDependencyManagedPickups({
        plan: {
          id: 0,
          planDate: "2099-01-01",
          orders: [enriched],
          trucks: [{
            id: "TEN-LINE-TRUCK",
            plate: "TEN-LINE-TRUCK",
            loads: [{
              id: "TEN-LINE-LOAD",
              stops: [{ id: "ten-line-drop", type: "drop", orderId: salesRef, location: "Customer" }]
            }]
          }]
        },
        enrichedOrders: [enriched],
        affectedTargetRefs: [salesRef]
      });
      const routeTruck = route.trucks[0];
      const routeLoad = routeTruck.loads[0];
      const routePickups = routeLoad.stops.filter((stop) => stop.type === "pick");
      assert.deepEqual(new Set(routePickups.map((stop) => stop.location)),
        new Set(["12441", "2967", "Ten Line Vendor Yard"]));
      const pickupVisits = dispatchPhysicalStopVisits(route, routeTruck, routeLoad)
        .filter((visit) => visit.type === "pick");
      assert.equal(pickupVisits.length, 3);
      assert.ok(pickupVisits.every((visit) => visit.pallets > 0));

      const conflicts = await validateDispatchPlanDependencies({
        id: 0,
        planDate: "2099-01-01",
        orders: [
          enriched,
          {
            id: replenishmentTransfer.ref,
            type: "TO",
            sourceYard: "3445",
            pickupLocations: ["3445"]
          }
        ],
        trucks: [{
          id: "TEN-LINE-VALIDATION-TRUCK",
          plate: "TEN-LINE-VALIDATION-TRUCK",
          loads: [{
            id: "TEN-LINE-REPLENISH-LOAD",
            stops: [
              { id: "ten-line-replenish-pick", type: "pick", orderId: replenishmentTransfer.ref, location: "3445" },
              { id: "ten-line-replenish-drop", type: "drop", orderId: replenishmentTransfer.ref, location: "12441" }
            ]
          }, {
            id: "TEN-LINE-SALES-LOAD",
            stops: [
              { id: "ten-line-base-pick", type: "pick", orderId: salesRef, location: "12441" },
              { id: "ten-line-po-pick", type: "pick", orderId: salesRef, location: "Ten Line Vendor Yard" },
              { id: "ten-line-to-pick", type: "pick", orderId: salesRef, location: "2967" },
              { id: "ten-line-sales-drop", type: "drop", orderId: salesRef, location: "Customer" }
            ]
          }]
        }]
      });
      assert.deepEqual(conflicts, []);

      await cancelLocalCoOrder(replenishmentCoRef, { requestedBy: "ten-line-extreme-replay" });
      const withoutReplenishmentCo = await enrich();
      assert.deepEqual(new Set(withoutReplenishmentCo.pickupLocations),
        new Set(["12441", "2967", "Ten Line Vendor Yard"]));
      await cancelLocalCoOrder(directCoRef, { requestedBy: "ten-line-extreme-replay" });
      const canonicalRoute = await enrich();
      assert.deepEqual(new Set(canonicalRoute.pickupLocations),
        new Set(["12441", "3445", "Ten Line Vendor Yard"]));
    });
  } finally {
    await rollback.rollback();
  }
});
