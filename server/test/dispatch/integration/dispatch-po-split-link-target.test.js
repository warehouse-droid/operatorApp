import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createSalesOrderPoAllocation,
  createScmPurchaseOrderSplit,
  getSalesOrderPoAllocationOptions,
  listDispatchOrders,
  listScmPurchaseOrders,
  listScmSchedule
} from "../../../src/dispatch-repository.js";

after(closeDb);

async function seedSplitLinkFixture({ salesPallets = 2 } = {}) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const baseId = 8_930_000_000_000 + Number(suffix.slice(-9)) * 10;
  const purchaseOrderId = baseId + 1;
  const salesOrderId = baseId + 2;
  const itemId = baseId + 3;
  const purchaseOrderRef = `PO-SPLIT-LINK-${suffix}`;
  const splitRef = `${purchaseOrderRef}-L1`;
  const salesOrderRef = `SO-SPLIT-LINK-${suffix}`;

  const purchaseLine = await query(
    `WITH inserted_order AS (
       INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, source_location_id,
         source_location, dispatch_vendor_yard, receipt_status,
         initial_scm_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, current_date, $3, 'Split Link Vendor', 'pendingReceipt',
         'Purchase Order : Pending Receipt', 15, '12441', 1,
         '3445', 'Split Link Vendor Yard', 'not_received',
         'Queued', true, now()
       )
       RETURNING netsuite_id
     )
     INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku,
       item_type, item_type_text, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       received_pallet_qty, received_layer_qty, received_section_qty,
       received_piece_qty, netsuite_received_qty, netsuite_received_baseline_qty,
       item_weight, netsuite_active, synced_at, raw
     )
     SELECT netsuite_id, $4, $5, 'Split Link Item', $6,
            'InvtPart', 'Inventory Item', 120, 'EA',
            15, '12441', 12, 0, 0, 0,
            10, 0, 0, 1,
            0, 0, 0, 0, 0, 0,
            2.5, true, now(), '{}'::jsonb
       FROM inserted_order
     RETURNING *`,
    [
      purchaseOrderId,
      purchaseOrderRef,
      baseId + 10,
      baseId + 11,
      itemId,
      `SPLIT-LINK-SKU-${suffix}`
    ]
  );

  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       fulfillment_status, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active
     ) VALUES (
       $1, $2, current_date, 'Split Link Customer', 'B',
       'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery',
       'open', 'open', 'Open', '100 Test Street, Toronto, ON', true
     )`,
    [salesOrderId, salesOrderRef]
  );
  const salesLine = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku,
       item_type, item_type_text, quantity, unit,
       pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       netsuite_committed_qty, netsuite_backordered_qty,
       netsuite_active, location_id, location
     ) VALUES (
       $1, $2, $3, 'Split Link Item', $4,
       'InvtPart', 'Inventory Item', $5, 'EA',
       $6, 0, 0, 0,
       10, 0, 0, 1,
       0, $5, true, 15, '12441'
     )
     RETURNING *`,
    [
      salesOrderId,
      baseId + 12,
      itemId,
      `SPLIT-LINK-SKU-${suffix}`,
      salesPallets * 10,
      salesPallets
    ]
  );

  const created = await createScmPurchaseOrderSplit({
    sourcePoRef: purchaseOrderRef,
    newPoRef: splitRef,
    destinationLocationId: 15,
    lines: [{ lineRowId: purchaseLine.rows[0].id, pallets: 7 }],
    createdBy: "dispatch-po-split-link-regression"
  });

  return {
    purchaseOrderId,
    purchaseOrderRef,
    sourceLine: purchaseLine.rows[0],
    salesOrderId,
    salesOrderRef,
    salesLine: salesLine.rows[0],
    splitRef,
    splitLine: created.lines[0]
  };
}

test("SCM remaining quantity ignores legacy Dispatch links on a split source", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture();
      await query(
        `INSERT INTO dispatch_so_po_allocations (
           sales_order_id, sales_order_ref, sales_line_id,
           po_order_id, po_order_ref, po_line_id,
           item_id, item_name, sku,
           allocated_pallet_qty, allocated_sales_qty, created_by,
           dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, 2, 20, 'legacy-parent-link',
           $2, 'normal', $10
         )`,
        [
          fixture.salesOrderId,
          fixture.salesOrderRef,
          fixture.salesLine.id,
          fixture.purchaseOrderId,
          fixture.purchaseOrderRef,
          fixture.sourceLine.id,
          fixture.sourceLine.item_id,
          fixture.sourceLine.item_name,
          fixture.sourceLine.sku,
          `${fixture.salesOrderRef}::${fixture.salesOrderRef}::${fixture.salesLine.id}`
        ]
      );

      const splitRows = await listScmPurchaseOrders({ search: fixture.purchaseOrderRef });
      const source = splitRows.find((row) => row.id === fixture.purchaseOrderRef);
      const sourceItem = source?.items?.find((item) => item.sku === fixture.sourceLine.sku);
      assert.equal(sourceItem?.pallets, 5,
        "only active SCM splits and receipts reduce the PO Split source balance");
      assert.equal(sourceItem?.quantity, 50);

      const scheduleRows = await listScmSchedule({ exactRef: fixture.purchaseOrderRef });
      const schedule = scheduleRows.find((row) => String(row.sourceId) === String(fixture.purchaseOrderId));
      assert.equal(schedule?.totalPalletQty, 5);
      assert.match(schedule?.content || "", new RegExp(`${fixture.sourceLine.sku} 5 PLT`));
    });
  } finally {
    await rollback.rollback();
  }
});

test("Link PO requires an active split child instead of its source line", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture();
      const options = await getSalesOrderPoAllocationOptions(fixture.salesOrderRef);
      const refs = options.poLines.map((line) => line.poRef);
      assert.ok(refs.includes(fixture.splitRef), "the active split child must be selectable");
      assert.ok(!refs.includes(fixture.purchaseOrderRef),
        "the split source must not remain selectable as an operational PO target");

      const targetLine = options.salesLines.find((line) => Number(line.id) === Number(fixture.salesLine.id));
      await assert.rejects(
        createSalesOrderPoAllocation({
          dispatchTargetRef: fixture.salesOrderRef,
          salesOrderRef: fixture.salesOrderRef,
          targetLineKey: targetLine.targetLineKey,
          poLineId: fixture.sourceLine.id,
          poRef: fixture.purchaseOrderRef,
          targetSignature: options.order.targetSignature,
          quantities: { pallets: 2 },
          createdBy: "dispatch-po-split-link-regression"
        }),
        (error) => error?.status === 409 && error?.code === "DISPATCH_PO_SPLIT_SOURCE_REQUIRES_CHILD"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("Dispatch Planning source-PO search returns the split ref and relationship metadata", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture();
      const orders = await listDispatchOrders({
        type: "PO",
        search: fixture.purchaseOrderRef,
        includeScmLinkedSearchRefs: true
      });
      const child = orders.find((order) => order.id === fixture.splitRef);
      assert.ok(child, "searching the source PO must return its operational split ref");
      assert.equal(child.sourcePoRef, fixture.purchaseOrderRef);
      assert.deepEqual(child.sourcePoRefs, [fixture.purchaseOrderRef]);
      assert.deepEqual(child.correspondingPoRefs, [fixture.splitRef]);

      const source = orders.find((order) => order.id === fixture.purchaseOrderRef);
      assert.ok(source, "the remaining source PO stays visible alongside its refs");
      assert.ok(source.correspondingPoRefs.includes(fixture.splitRef));
    });
  } finally {
    await rollback.rollback();
  }
});

test("a fully linked split child keeps its complete PO Split lines visible", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture({ salesPallets: 7 });
      const options = await getSalesOrderPoAllocationOptions(fixture.salesOrderRef);
      const targetLine = options.salesLines.find((line) => Number(line.id) === Number(fixture.salesLine.id));
      await createSalesOrderPoAllocation({
        dispatchTargetRef: fixture.salesOrderRef,
        salesOrderRef: fixture.salesOrderRef,
        targetLineKey: targetLine.targetLineKey,
        poLineId: fixture.splitLine.id,
        poRef: fixture.splitRef,
        targetSignature: options.order.targetSignature,
        quantities: { pallets: 7 },
        createdBy: "dispatch-po-split-link-regression"
      });

      const splitRows = await listScmPurchaseOrders({ search: fixture.splitRef });
      const child = splitRows.find((row) => row.id === fixture.splitRef);
      const childItem = child?.items?.find((item) => item.sku === fixture.sourceLine.sku);
      assert.ok(childItem, "a fully Dispatch-linked active split line must remain visible in PO Split");
      assert.equal(childItem.pallets, 7);
      assert.equal(childItem.quantity, 70);
    });
  } finally {
    await rollback.rollback();
  }
});
