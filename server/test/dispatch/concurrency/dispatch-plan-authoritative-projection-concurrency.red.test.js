import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  createDispatchPlan,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";

after(closeDb);

const isolated = process.env.MBT_TEST_ISOLATED === "1";

test("concurrent stale saves serialize behind one fresh relationship projection", { skip: !isolated }, async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const numeric = Number.parseInt(suffix.slice(0, 8), 16);
  const salesOrderId = 7_500_000_000 + numeric;
  const purchaseOrderId = 7_600_000_000 + numeric;
  const salesOrderRef = `SO-CONCURRENT-${suffix}`;
  const purchaseOrderRef = `PO-CONCURRENT-${suffix}`;
  let planId = null;
  try {
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         fulfillment_status, outbound_location_id, outbound_location,
         sales_order_type, operator_status, local_yard_order_status,
         dispatch_address, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2198-09-03', 'Concurrent customer', 'B',
         'Sales Order : Pending Fulfillment', 'not_fulfilled', 15, '12441',
         'Delivery', 'open', 'Open', '1 Concurrent Customer Road', true, now()
       )`,
      [salesOrderId, salesOrderRef]
    );
    const salesLineId = (await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
         netsuite_active, synced_at
       ) VALUES ($1, 1, 2055, 'MBBS-Special Order', 'MBBS-Special Order', 10, 'SQFT', true, now())
       RETURNING id`,
      [salesOrderId]
    )).rows[0].id;
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor, status, status_text,
         destination_location_id, destination_location,
         dispatch_vendor_yard, dispatch_address, receipt_status,
         netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2198-09-03', 'Techo Bloc', 'pendingReceipt',
         'Purchase Order : Pending Receipt', 1, '3445',
         'TECHO BLOC Vaughan', '720 Arrow Rd. North York, ON M9M 2M1',
         'not_received', true, now()
       )`,
      [purchaseOrderId, purchaseOrderRef]
    );
    const purchaseLineId = (await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
         location_id, location, netsuite_active, synced_at
       ) VALUES ($1, 1, 2055, 'MBBS-Special Order', 'MBBS-Special Order', 10, 'SQFT', 1, '3445', true, now())
       RETURNING id`,
      [purchaseOrderId]
    )).rows[0].id;
    const order = {
      id: salesOrderRef,
      type: "SO",
      sourceTable: "sales_orders",
      sourceYard: "12441",
      pickupLocations: ["12441"],
      address: "1 Concurrent Customer Road",
      items: [{
        lineRowId: String(salesLineId),
        itemId: "2055",
        sku: "MBBS-Special Order",
        quantity: 10,
        unit: "SQFT"
      }]
    };
    const trucks = [{
      id: "",
      plate: "",
      loads: [{
        id: `concurrent-load-${suffix}`,
        stops: [
          { id: "base-pick", type: "pick", orderId: salesOrderRef, location: "12441" },
          { id: "customer-drop", type: "drop", orderId: salesOrderRef, location: "1 Concurrent Customer Road" }
        ]
      }]
    }];
    const plan = await createDispatchPlan({
      planDate: "2198-09-03",
      note: `projection concurrency ${suffix}`
    });
    planId = plan.id;
    const first = await saveDispatchPlanSnapshot(plan.id, {
      planDate: plan.planDate,
      baseRevision: plan.revision,
      orders: [order],
      trucks,
      summary: {}
    });
    await query(
      `INSERT INTO dispatch_so_po_allocations (
         sales_order_id, sales_order_ref, sales_line_id,
         po_order_id, po_order_ref, po_line_id,
         item_id, item_name, sku, allocated_sales_qty, status, created_by,
         dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         2055, 'MBBS-Special Order', 'MBBS-Special Order', 10, 'active', 'projection-concurrency-test',
         $2, 'normal', $7
       )`,
      [
        salesOrderId,
        salesOrderRef,
        salesLineId,
        purchaseOrderId,
        purchaseOrderRef,
        purchaseLineId,
        `${salesOrderRef}::${salesOrderRef}::${salesLineId}`
      ]
    );

    const attempts = await Promise.allSettled(["A", "B"].map((session) => (
      saveDispatchPlanSnapshot(plan.id, {
        planDate: plan.planDate,
        baseRevision: first.revision,
        orders: [order],
        trucks,
        summary: {},
        sessionId: `projection-concurrency-${session}`
      })
    )));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      attempts.filter((result) => result.status === "rejected" && result.reason?.code === "STALE_DISPATCH_PLAN").length,
      1
    );

    const stored = (await query(
      "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [plan.id]
    )).rows[0];
    const storedOrder = stored.orders.find((candidate) => candidate.id === salesOrderRef);
    const storedStops = stored.trucks[0].loads[0].stops;
    assert.deepEqual(storedOrder.pickupLocations, ["12441", "TECHO BLOC Vaughan"]);
    assert.ok(
      storedStops.findIndex((stop) => stop.location === "TECHO BLOC Vaughan")
        < storedStops.findIndex((stop) => stop.id === "customer-drop")
    );
  } finally {
    if (planId) {
      await query("DELETE FROM dispatch_plans WHERE id = $1", [planId]);
    }
    await query("DELETE FROM dispatch_so_po_allocations WHERE sales_order_id = $1", [salesOrderId]);
    await query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
    await query("DELETE FROM purchase_orders WHERE netsuite_id = $1", [purchaseOrderId]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
    await query("DELETE FROM sales_orders WHERE netsuite_id = $1", [salesOrderId]);
  }
});
