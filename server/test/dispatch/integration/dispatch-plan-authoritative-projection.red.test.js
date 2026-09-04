import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createDispatchPlan,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";

after(closeDb);

function groupOrder({ groupRef, salesOrderRef, salesLineId }) {
  const child = {
    id: salesOrderRef,
    type: "SO",
    sourceTable: "sales_orders",
    sourceYard: "12441",
    pickupLocations: ["12441"],
    address: "27 Authoritative Projection Road",
    items: [{
      lineRowId: String(salesLineId),
      lineId: "1",
      itemId: "2055",
      sku: "MBBS-Special Order",
      itemName: "MBBS-Special Order",
      quantity: 81.38,
      unit: "SQFT"
    }]
  };
  return {
    ...child,
    id: groupRef,
    customer: "1 order grouped",
    childOrders: [salesOrderRef],
    childOrderDetails: [child],
    isGrouped: true,
    planOwned: true
  };
}

function staleBoard(groupRef) {
  return [{
    id: "",
    plate: "",
    loads: [{
      id: `load-${groupRef}`,
      name: "Projection race load",
      plannedStartMinute: 480,
      plannedFinishMinute: 600,
      routeEstimate: { routeSignature: "before-po-link", totalMinutes: 120 },
      stops: [
        { id: "base-pick", type: "pick", orderId: groupRef, location: "12441" },
        { id: "customer-drop", type: "drop", orderId: groupRef, location: "27 Authoritative Projection Road" }
      ]
    }]
  }];
}

async function seedProjectionRace(planDate = "2098-09-03") {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const numeric = Number.parseInt(suffix.slice(0, 8), 16);
  const salesOrderId = 7_300_000_000 + numeric;
  const purchaseOrderId = 7_400_000_000 + numeric;
  const salesOrderRef = `SOB-FRESH-${suffix}`;
  const groupRef = `GOB-FRESH-${suffix}`;
  const purchaseOrderRef = `LOINC-FRESH-${suffix}`;
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       fulfillment_status, outbound_location_id, outbound_location,
       sales_order_type, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active, synced_at
     ) VALUES (
       $1, $2, $3::date, 'Projection customer', 'B',
       'Sales Order : Pending Fulfillment', 'not_fulfilled', 15, '12441',
       'Delivery', 'open', 'Open', '27 Authoritative Projection Road', true, now()
     )`,
    [salesOrderId, salesOrderRef, planDate]
  );
  const salesLine = (await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
       netsuite_active, synced_at
     ) VALUES ($1, 1, 2055, 'MBBS-Special Order', 'MBBS-Special Order', 81.38, 'SQFT', true, now())
     RETURNING id`,
    [salesOrderId]
  )).rows[0];
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor, status, status_text,
       destination_location_id, destination_location,
       dispatch_vendor_yard, dispatch_address, receipt_status,
       netsuite_active, synced_at
     ) VALUES (
       $1, $2, $3::date, 'Techo Bloc', 'pendingReceipt',
       'Purchase Order : Pending Receipt', 1, '3445',
       'TECHO BLOC Vaughan', '720 Arrow Rd. North York, ON M9M 2M1',
       'not_received', true, now()
     )`,
    [purchaseOrderId, purchaseOrderRef, planDate]
  );
  const purchaseLine = (await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, netsuite_active, synced_at
     ) VALUES ($1, 1, 2055, 'MBBS-Special Order', 'MBBS-Special Order', 81.38, 'SQFT', 1, '3445', true, now())
     RETURNING id`,
    [purchaseOrderId]
  )).rows[0];
  const plan = await createDispatchPlan({
    planDate,
    note: `authoritative projection ${suffix}`
  });
  const staleOrder = groupOrder({
    groupRef,
    salesOrderRef,
    salesLineId: salesLine.id
  });
  const first = await saveDispatchPlanSnapshot(plan.id, {
    planDate: plan.planDate,
    baseRevision: plan.revision,
    orders: [staleOrder],
    trucks: staleBoard(groupRef),
    summary: {},
    sessionId: `projection-before-${suffix}`
  });
  await query(
    `INSERT INTO dispatch_so_po_allocations (
       sales_order_id, sales_order_ref, sales_line_id,
       po_order_id, po_order_ref, po_line_id,
       item_id, item_name, sku, allocated_sales_qty, status, created_by,
       dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       2055, 'MBBS-Special Order', 'MBBS-Special Order', 81.38, 'active', 'projection-race-test',
       $7, 'group', $8
     )`,
    [
      salesOrderId,
      salesOrderRef,
      salesLine.id,
      purchaseOrderId,
      purchaseOrderRef,
      purchaseLine.id,
      groupRef,
      `${groupRef}::${salesOrderRef}::${salesLine.id}`
    ]
  );
  return { first, groupRef, plan, purchaseOrderRef, staleOrder };
}

test("save reloads a newer PO allocation after a planner submits a stale grouped order", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const { first, groupRef, plan, purchaseOrderRef, staleOrder } = await seedProjectionRace();

      const saved = await saveDispatchPlanSnapshot(plan.id, {
        planDate: plan.planDate,
        baseRevision: first.revision,
        orders: [staleOrder],
        trucks: staleBoard(groupRef),
        summary: {},
        sessionId: "projection-after-link"
      });
      const order = saved.orders.find((candidate) => candidate.id === groupRef);
      const load = saved.trucks[0].loads[0];
      const techoIndex = load.stops.findIndex((stop) => (
        stop.type === "pick" && stop.location === "TECHO BLOC Vaughan"
      ));
      const dropIndex = load.stops.findIndex((stop) => stop.id === "customer-drop");

      assert.deepEqual(order.pickupLocations, ["12441", "TECHO BLOC Vaughan"]);
      assert.deepEqual(order.poPickupManifest.map((entry) => [entry.poOrderRef, entry.location]), [
        [purchaseOrderRef, "TECHO BLOC Vaughan"]
      ]);
      assert.ok(techoIndex >= 0 && techoIndex < dropIndex, "the committed Techo pickup must precede delivery");
      assert.equal(load.routeEstimate, undefined);

      const stored = (await query(
        "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
        [plan.id]
      )).rows[0];
      assert.deepEqual(
        stored.orders.find((candidate) => candidate.id === groupRef)?.pickupLocations,
        ["12441", "TECHO BLOC Vaughan"],
        "the invariant must be persisted, not just overlaid in the response"
      );
      assert.ok(
        stored.trucks[0].loads[0].stops.some((stop) => stop.location === "TECHO BLOC Vaughan"),
        "the persisted route must contain the pickup"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("authoritative route repair cannot rewrite an executed physical prefix", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
      const orderRef = `SO-PREFIX-${suffix}`;
      const loadId = `load-prefix-${suffix}`;
      const plan = await createDispatchPlan({
        planDate: "2098-09-04",
        note: `executed prefix ${suffix}`
      });
      const order = {
        id: orderRef,
        type: "SO",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        address: "1 Prefix Customer Road"
      };
      const trucks = [{
        id: "",
        plate: "",
        loads: [{
          id: loadId,
          name: "Executed prefix load",
          stops: [
            { id: "prefix-pick", type: "pick", orderId: orderRef, location: "12441" },
            { id: "prefix-drop", type: "drop", orderId: orderRef, location: "1 Prefix Customer Road" }
          ]
        }]
      }];
      const saved = await saveDispatchPlanSnapshot(plan.id, {
        planDate: plan.planDate,
        baseRevision: plan.revision,
        orders: [order],
        trucks,
        summary: {}
      });
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
           load_id, load_name, stop_id, stop_type, order_refs,
           status, started_at, completed_at
         ) VALUES (
           $1, $2, $3::date, 'projection-prefix-driver', '', '',
           $4, 'Executed prefix load', 'prefix-drop', 'drop', $5::jsonb,
           'complete', now(), now()
         )`,
        [
          `projection-prefix-${crypto.randomUUID()}`,
          plan.id,
          plan.planDate,
          loadId,
          JSON.stringify([orderRef])
        ]
      );
      const changedTrucks = structuredClone(trucks);
      changedTrucks[0].loads[0].stops.unshift({
        id: "late-pick",
        type: "pick",
        orderId: orderRef,
        location: "Late Vendor"
      });

      await assert.rejects(
        saveDispatchPlanSnapshot(plan.id, {
          planDate: plan.planDate,
          baseRevision: saved.revision,
          orders: [order],
          trucks: changedTrucks,
          summary: {}
        }),
        (error) => error?.code === "DISPATCH_ACTIVE_LOAD_LOCKED"
      );
      assert.equal(
        Number((await query("SELECT revision FROM dispatch_plans WHERE id = $1", [plan.id])).rows[0].revision),
        saved.revision,
        "a rejected active-prefix edit must not advance the plan revision"
      );
    });
  } finally {
    await rollback.rollback();
  }
});
