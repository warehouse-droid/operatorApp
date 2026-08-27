import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createSalesOrderPoAllocation,
  createScmPurchaseOrderSplit,
  enrichDispatchOrdersWithPoTargetAllocations,
  getSalesOrderPoAllocationOptions,
  listDispatchOrders,
  listScmPurchaseOrders,
  listScmSchedule
} from "../../../src/dispatch-repository.js";

after(closeDb);

async function seedSplitLinkFixture({ salesPallets = 2, createSplit = true } = {}) {
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

  const created = createSplit
    ? await createScmPurchaseOrderSplit({
        sourcePoRef: purchaseOrderRef,
        newPoRef: splitRef,
        destinationLocationId: 15,
        lines: [{ lineRowId: purchaseLine.rows[0].id, pallets: 7 }],
        createdBy: "dispatch-po-split-link-regression"
      })
    : null;

  return {
    purchaseOrderId,
    purchaseOrderRef,
    sourceLine: purchaseLine.rows[0],
    salesOrderId,
    salesOrderRef,
    salesLine: salesLine.rows[0],
    splitRef,
    splitLine: created?.lines?.[0] || null
  };
}

test("Link PO finds an ordinary source PO by its updated PO ref and original NetSuite number", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture({ createSplit: false });
      const updatedPoRef = `${fixture.purchaseOrderRef}-REF`;
      await query(
        `UPDATE purchase_orders
            SET dispatch_ref = $2,
                dispatch_ref_updated_at = now(),
                dispatch_ref_updated_by = 'po-ref-link-search-regression'
          WHERE netsuite_id = $1`,
        [fixture.purchaseOrderId, updatedPoRef]
      );

      const options = await getSalesOrderPoAllocationOptions(fixture.salesOrderRef);
      const poLine = options.poLines.find((line) => Number(line.id) === Number(fixture.sourceLine.id));
      assert.equal(poLine?.poRef, updatedPoRef,
        "the current PO ref must be the primary Link PO search identity");
      assert.equal(poLine?.originalPoRef, fixture.purchaseOrderRef);
      assert.deepEqual(poLine?.poAliases, [updatedPoRef, fixture.purchaseOrderRef],
        "the original NetSuite PO number must remain a valid search alias");
      const targetLine = options.salesLines.find((line) => Number(line.id) === Number(fixture.salesLine.id));
      const candidate = targetLine?.poCandidates.find((entry) => Number(entry.poLineId) === Number(fixture.sourceLine.id));
      assert.equal(candidate?.poRef, updatedPoRef);
      assert.deepEqual(candidate?.poAliases, [updatedPoRef, fixture.purchaseOrderRef]);

      const linkedByUpdatedRef = await createSalesOrderPoAllocation({
        dispatchTargetRef: fixture.salesOrderRef,
        salesOrderRef: fixture.salesOrderRef,
        targetLineKey: targetLine.targetLineKey,
        poRef: updatedPoRef,
        targetSignature: options.order.targetSignature,
        quantities: { pallets: 1 },
        createdBy: "po-ref-link-search-regression"
      });
      assert.equal(linkedByUpdatedRef.poOrderRef, updatedPoRef);

      const linkedByOriginalRef = await createSalesOrderPoAllocation({
        dispatchTargetRef: fixture.salesOrderRef,
        salesOrderRef: fixture.salesOrderRef,
        targetLineKey: targetLine.targetLineKey,
        poLineId: fixture.sourceLine.id,
        poRef: fixture.purchaseOrderRef,
        targetSignature: options.order.targetSignature,
        quantities: { pallets: 1 },
        createdBy: "po-ref-link-search-regression"
      });
      assert.equal(linkedByOriginalRef.poOrderRef, updatedPoRef,
        "new allocation evidence must retain the current visible PO ref regardless of the accepted alias");
    });
  } finally {
    await rollback.rollback();
  }
});

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

test("Dispatch enrichment adds a route-only PO residual without changing the SCM source quantity", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture({ createSplit: false, salesPallets: 2 });
      const options = await getSalesOrderPoAllocationOptions(fixture.salesOrderRef);
      const targetLine = options.salesLines.find((line) => Number(line.id) === Number(fixture.salesLine.id));
      await createSalesOrderPoAllocation({
        dispatchTargetRef: fixture.salesOrderRef,
        salesOrderRef: fixture.salesOrderRef,
        targetLineKey: targetLine.targetLineKey,
        poRef: fixture.purchaseOrderRef,
        poLineId: fixture.sourceLine.id,
        targetSignature: options.order.targetSignature,
        quantities: { pallets: 2 },
        createdBy: "dispatch-po-route-residual-regression"
      });

      const source = (await listDispatchOrders({ search: fixture.purchaseOrderRef }))
        .find((order) => order.id === fixture.purchaseOrderRef);
      const [enriched] = await enrichDispatchOrdersWithPoTargetAllocations([source]);

      assert.equal(source.pallets, 12);
      assert.equal(source.items[0].pallets, 12);
      assert.equal(enriched.pallets, 12, "SCM/source PO total is immutable under a Dispatch link");
      assert.equal(enriched.items[0].pallets, 12);
      assert.equal(enriched.poRouteProjection?.pallets, 10);
      assert.equal(enriched.poRouteProjection?.items[0]?.quantity, 100);
      assert.deepEqual(enriched.poRouteProjection?.targetRefs, [fixture.salesOrderRef]);
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

test("Link PO accepts an exact decimal pallet conversion without floating-point overrun", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture({ salesPallets: 38, createSplit: false });
      await query(
        `UPDATE sales_order_lines
            SET quantity = 1987.78,
                pallet_qty = 38,
                to_plt = 52.31,
                netsuite_backordered_qty = 1987.78
          WHERE id = $1`,
        [fixture.salesLine.id]
      );
      await query(
        `UPDATE purchase_order_lines
            SET quantity = 2040.09,
                pallet_qty = 39,
                to_plt = 52.31
          WHERE id = $1`,
        [fixture.sourceLine.id]
      );
      const split = await createScmPurchaseOrderSplit({
        sourcePoRef: fixture.purchaseOrderRef,
        newPoRef: fixture.splitRef,
        destinationLocationId: 15,
        lines: [{ lineRowId: fixture.sourceLine.id, pallets: 39 }],
        createdBy: "dispatch-po-decimal-conversion-regression"
      });
      const options = await getSalesOrderPoAllocationOptions(fixture.salesOrderRef);
      const targetLine = options.salesLines.find((line) => Number(line.id) === Number(fixture.salesLine.id));
      const candidate = targetLine?.poCandidates.find((entry) => entry.poRef === fixture.splitRef);
      assert.ok(candidate, "the 39-pallet split PO must match the 38-pallet SO line");

      const linked = await createSalesOrderPoAllocation({
        dispatchTargetRef: fixture.salesOrderRef,
        salesOrderRef: fixture.salesOrderRef,
        targetLineKey: targetLine.targetLineKey,
        poLineId: candidate.poLineId,
        poRef: fixture.splitRef,
        targetSignature: options.order.targetSignature,
        quantities: { pallets: 38 },
        createdBy: "dispatch-po-decimal-conversion-regression"
      });
      assert.equal(Number(linked.poOrderId), Number(split.split.splitPoId));
      assert.equal(linked.pallets, 38);
      assert.equal(linked.salesQty, 1987.78);
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

test("a fully linked PO inherits planned and completed lifecycle from its Driver target", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture({ createSplit: false, salesPallets: 12 });
      const options = await getSalesOrderPoAllocationOptions(fixture.salesOrderRef);
      const targetLine = options.salesLines.find((line) => Number(line.id) === Number(fixture.salesLine.id));
      await createSalesOrderPoAllocation({
        dispatchTargetRef: fixture.salesOrderRef,
        salesOrderRef: fixture.salesOrderRef,
        targetLineKey: targetLine.targetLineKey,
        poLineId: fixture.sourceLine.id,
        poRef: fixture.purchaseOrderRef,
        targetSignature: options.order.targetSignature,
        quantities: { pallets: 12 },
        createdBy: "dispatch-po-link-lifecycle-regression"
      });
      const currentPoRef = `${fixture.purchaseOrderRef}-CURRENT`;
      await query(
        `UPDATE purchase_orders
            SET dispatch_ref = $2,
                dispatch_ref_updated_at = now(),
                dispatch_ref_updated_by = 'dispatch-po-link-lifecycle-regression'
          WHERE netsuite_id = $1`,
        [fixture.purchaseOrderId, currentPoRef]
      );

      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note)
         VALUES (current_date, 'confirmed', 'fully linked PO lifecycle regression')
         RETURNING id, plan_date`,
        []
      );
      const assignment = {
        dispatchPlanned: true,
        dispatchPlanId: String(plan.rows[0].id),
        dispatchPlanDate: String(plan.rows[0].plan_date).slice(0, 10),
        dispatchTruckPlate: "LINK-PO-12",
        dispatchLoadName: "Load 12",
        dispatchDriverName: "Linked Driver"
      };
      await query(
        `INSERT INTO dispatch_plan_order_assignments (
           plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
           load_id, stop_id, assignment, updated_at
         ) VALUES ($1, $2, $3, $3, 'direct', $4, $5, $6::jsonb, now())`,
        [
          plan.rows[0].id,
          plan.rows[0].plan_date,
          fixture.salesOrderRef,
          `linked-load-${fixture.salesOrderId}`,
          `linked-stop-${fixture.salesOrderId}`,
          JSON.stringify(assignment)
        ]
      );

      const planned = (await listScmSchedule({
        exactRef: currentPoRef,
        audience: "operations"
      })).find((row) => row.orderRef === currentPoRef);
      assert.equal(planned?.calculatedStatus, "Planned");
      assert.equal(planned?.driver, "Linked Driver");
      assert.match(planned?.notes || "", /LINK-PO-12 Load 12/u);

      const jobId = `linked-po-complete-${fixture.salesOrderId}`;
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, truck_plate,
           load_id, load_name, stop_id, stop_type, order_refs,
           status, started_at, completed_at, job_details
         ) VALUES (
           $1, $2, $3, 'linked-driver', 'LINK-PO-12',
           $4, 'Load 12', $5, 'dropoff', $6::jsonb,
           'complete', now() - interval '5 minutes', now(), $7::jsonb
         )`,
        [
          jobId,
          plan.rows[0].id,
          plan.rows[0].plan_date,
          `linked-load-${fixture.salesOrderId}`,
          `linked-drop-${fixture.salesOrderId}`,
          JSON.stringify([fixture.salesOrderRef]),
          JSON.stringify({
            orderTypes: ["SO"],
            orders: [{ orderType: "SO", orderRef: fixture.salesOrderRef }]
          })
        ]
      );

      const completion = await query(
        `SELECT order_kind, order_ref, completion_evidence_type,
                completion_evidence_id, metadata
           FROM dispatch_order_completion_status
          WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
        [currentPoRef]
      );
      assert.equal(completion.rowCount, 1);
      assert.equal(completion.rows[0].completion_evidence_type, "driver_job");
      assert.equal(completion.rows[0].completion_evidence_id, jobId);
      assert.equal(completion.rows[0].metadata.directPoLink, true);

      const completed = (await listScmSchedule({
        exactRef: currentPoRef,
        audience: "scm"
      })).find((row) => row.orderRef === currentPoRef);
      assert.equal(completed?.calculatedStatus, "Completed");
      assert.equal(completed?.dispatchCompletionEvidenceType, "driver_job");
    });
  } finally {
    await rollback.rollback();
  }
});

test("a partial PO link cannot complete or hide its unplanned residual route", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitLinkFixture({ createSplit: false, salesPallets: 2 });
      const options = await getSalesOrderPoAllocationOptions(fixture.salesOrderRef);
      const targetLine = options.salesLines.find((line) => Number(line.id) === Number(fixture.salesLine.id));
      await createSalesOrderPoAllocation({
        dispatchTargetRef: fixture.salesOrderRef,
        salesOrderRef: fixture.salesOrderRef,
        targetLineKey: targetLine.targetLineKey,
        poLineId: fixture.sourceLine.id,
        poRef: fixture.purchaseOrderRef,
        targetSignature: options.order.targetSignature,
        quantities: { pallets: 2 },
        createdBy: "dispatch-po-partial-link-lifecycle-regression"
      });
      const jobId = `partial-linked-po-complete-${fixture.salesOrderId}`;
      await query(
        `INSERT INTO driver_job_records (
           job_id, driver_login, stop_type, order_refs,
           status, started_at, completed_at, job_details
         ) VALUES (
           $1, 'partial-linked-driver', 'dropoff', $2::jsonb,
           'complete', now() - interval '5 minutes', now(), $3::jsonb
         )`,
        [
          jobId,
          JSON.stringify([fixture.salesOrderRef]),
          JSON.stringify({
            orderTypes: ["SO"],
            orders: [{ orderType: "SO", orderRef: fixture.salesOrderRef }]
          })
        ]
      );

      const completion = await query(
        `SELECT 1
           FROM dispatch_order_completion_status
          WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
        [fixture.purchaseOrderRef]
      );
      assert.equal(completion.rowCount, 0,
        "the PO must remain open until its ten-pallet residual route is completed");
    });
  } finally {
    await rollback.rollback();
  }
});
