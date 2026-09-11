import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { createDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { reconcileDispatchPlanGlobalOrderDefinitions } from "../../../src/dispatch-delivery-group-repository.js";
import { digestDispatchPlan } from "../../../src/dispatch-planner-performance.js";
import { applyDispatchV2Command, getDispatchV2Bootstrap } from "../../../src/dispatch-planner-v2-repository.js";
import { dispatchRequiredPickupVisitLocations, materializeDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";

after(closeDb);

test("full and incremental saves omit empty pickups and still restore required physical pickups", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const ref = `SO-EMPTY-PICKUP-${crypto.randomUUID().slice(0, 8)}`;
      const truck = (await query(
        "INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true) RETURNING id::text, plate",
        [`TEST-${crypto.randomUUID().slice(0, 8)}`]
      )).rows[0];
      const plan = await createDispatchPlan({ planDate: "2098-09-05", note: "empty pickup save regression" });
      const order = {
        id: ref, type: "SO", sourceYard: "3445", pickupLocations: ["3445"],
        address: "100 Isolated Test Road",
        items: [{ sku: "Delivery Charge", itemType: "OthCharge", quantity: 1 }]
      };
      const trucks = [{ id: truck.id, plate: truck.plate, loads: [{
        id: "empty-pickup-load", name: "Test load", pickupVisitSchemaVersion: 1,
        stops: [{ id: "delivery", type: "drop", orderId: ref, location: order.address }]
      }] }];
      const saved = await saveDispatchPlanSnapshot(plan.id, {
        planDate: plan.planDate, baseRevision: plan.revision, orders: [order], trucks, summary: {}
      });
      assert.ok(saved.revision > plan.revision);
      assert.deepEqual(saved.trucks[0].loads[0].stops.map((stop) => stop.type), ["drop"]);

      const { payload: result } = await applyDispatchV2Command({
        planId: plan.id,
        command: {
          commandId: crypto.randomUUID(), commandType: "update_load", baseRevision: saved.revision,
          baseDigest: digestDispatchPlan(saved),
          payload: { planDelta: { s: { ...saved.summary, emptyPickupRegression: true } } }
        }
      });
      assert.equal(result.plan.revision, saved.revision + 1);
      const stored = (await query(
        "SELECT trucks, summary FROM dispatch_plan_snapshots WHERE plan_id = $1", [plan.id]
      )).rows[0];
      assert.equal(stored.summary.emptyPickupRegression, true);
      assert.deepEqual(stored.trucks[0].loads[0].stops.map((stop) => stop.type), ["drop"]);

      // Full saves repair missing future pickups before their final validation.
      // The invariant is that physical cargo cannot persist without its pickup.
      const withCargo = await saveDispatchPlanSnapshot(plan.id, {
        planDate: plan.planDate, baseRevision: result.plan.revision,
        orders: [{ ...order, items: [{ sku: "Physical cargo", quantity: 1 }] }],
        trucks, summary: stored.summary
      });
      const physicalStops = withCargo.trucks[0].loads[0].stops;
      assert.deepEqual(physicalStops.map((stop) => stop.type), ["pick", "drop"]);
      assert.equal(physicalStops[0].location, "3445");
      assert.deepEqual(physicalStops[0].orderRefs, [ref]);
      const revision = (await query("SELECT revision FROM dispatch_plans WHERE id = $1", [plan.id])).rows[0].revision;
      assert.equal(Number(revision), result.plan.revision + 1);
    });
  } finally {
    await rollback.rollback();
  }
});

async function seedAllocatedGroup() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const numeric = Number.parseInt(suffix.slice(0, 8), 16);
  const groupRef = `GO-PICKUP-${suffix}`;
  const purchaseOrderId = 7_600_000_000 + numeric;
  const purchaseOrderRef = `PO-PICKUP-${suffix}`;
  const vendor = "Pickup Regression Vendor";
  const plan = await createDispatchPlan({ planDate: "2098-09-06", note: "group pickup save regression" });
  const truck = (await query(
    "INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true) RETURNING id::text, plate",
    [`TEST-${suffix}`]
  )).rows[0];
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor, status, status_text,
       destination_location_id, destination_location, dispatch_vendor_yard,
       dispatch_address, receipt_status, netsuite_active, synced_at
     ) VALUES ($1, $2, $3::date, $4, 'pendingReceipt', 'Purchase Order : Pending Receipt',
       1, '3445', $4, '20 Test Vendor Road', 'not_received', true, now())`,
    [purchaseOrderId, purchaseOrderRef, plan.planDate, vendor]
  );
  const poLine = (await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, netsuite_active, synced_at
     ) VALUES ($1, 1, 2055, 'MBBS-Special Order', 'MBBS-Special Order', 140, 'SQFT', 1, '3445', true, now())
     RETURNING id`,
    [purchaseOrderId]
  )).rows[0];
  const children = [];
  for (const [index, quantity, pallets] of [[0, 100, 5], [1, 40, 2]]) {
    const salesOrderId = 7_700_000_000 + numeric * 2 + index;
    const salesOrderRef = `SO-PICKUP-${suffix}-${index}`;
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text, fulfillment_status,
         outbound_location_id, outbound_location, sales_order_type, operator_status,
         local_yard_order_status, dispatch_address, netsuite_active, synced_at
       ) VALUES ($1, $2, $3::date, 'Test customer', 'B', 'Sales Order : Pending Fulfillment',
         'not_fulfilled', 1, '2967', 'Delivery', 'open', 'Open', '30 Test Delivery Road', true, now())`,
      [salesOrderId, salesOrderRef, plan.planDate]
    );
    const line = (await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
         pallet_qty, netsuite_active, synced_at
       ) VALUES ($1, 1, 2055, 'MBBS-Special Order', 'MBBS-Special Order', $2, 'SQFT', $3, true, now())
       RETURNING id`,
      [salesOrderId, quantity, pallets]
    )).rows[0];
    await query(
      `INSERT INTO dispatch_so_po_allocations (
         sales_order_id, sales_order_ref, sales_line_id, po_order_id, po_order_ref, po_line_id,
         item_id, item_name, sku, allocated_sales_qty, status, created_by,
         dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
       ) VALUES ($1, $2, $3, $4, $5, $6, 2055, 'MBBS-Special Order', 'MBBS-Special Order',
         $7, 'active', 'pickup-save-test', $8, 'group', $9)`,
      [salesOrderId, salesOrderRef, line.id, purchaseOrderId, purchaseOrderRef, poLine.id,
        quantity, groupRef, `${groupRef}::${salesOrderRef}::${line.id}`]
    );
    children.push({
      id: salesOrderRef, type: "SO", sourceTable: "sales_orders", sourceYard: "2967",
      pickupLocations: ["2967", vendor], address: "30 Test Delivery Road", pallets,
      items: [{
        lineRowId: String(line.id), lineId: 1, itemId: 2055, sku: "MBBS-Special Order",
        itemType: "NonInvtPart", quantity, unit: "SQFT", pallets,
        poAllocatedSalesQty: quantity, poAllocatedPallets: 0
      }]
    });
  }
  // Global definitions can contain raw sales-quantity allocations while the
  // planner's hydrated group already has their physical-pallet equivalents.
  const staleGroup = {
    ...children[0], id: groupRef, isGrouped: true, planOwned: true, pallets: 7,
    childOrders: children.map((child) => child.id), childOrderDetails: children,
    items: children.flatMap((child) => child.items),
    poPickupManifest: [{
      poOrderRef: purchaseOrderRef, location: vendor,
      items: [{ itemId: 2055, sku: "MBBS-Special Order", quantity: 140 }]
    }]
  };
  const trucks = [{ id: truck.id, plate: truck.plate, loads: [{
    id: `load-${suffix}`, pickupVisitSchemaVersion: 1,
    stops: [
      { id: "vendor-pick", type: "pick", orderId: groupRef, orderRefs: [groupRef], location: vendor },
      { id: "group-drop", type: "drop", orderId: groupRef, location: staleGroup.address }
    ]
  }] }];
  const saved = await saveDispatchPlanSnapshot(plan.id, {
    planDate: plan.planDate, baseRevision: plan.revision, orders: [staleGroup], trucks, summary: {}
  });
  assert.deepEqual(saved.orders[0].items.map((item) => item.poAllocatedPallets), [5, 2]);
  assert.deepEqual(saved.trucks[0].loads[0].stops.map((stop) => stop.id), ["vendor-pick", "group-drop"]);
  await query("UPDATE dispatch_global_order_groups SET full_order = $2::jsonb WHERE group_ref = $1", [
    groupRef, JSON.stringify(staleGroup)
  ]);
  const reloaded = await reconcileDispatchPlanGlobalOrderDefinitions(saved);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(reloaded.orders[0], reloaded), ["2967", vendor]);
  assert.equal(materializeDispatchPickupVisits(reloaded, { allowLegacyPassthrough: true }).conflicts[0]?.code,
    "DISPATCH_PICKUP_ORDER_MISSING", "fixture must reproduce the false requirement after global refresh");
  return { saved, groupRef, vendor };
}

for (const scenario of ["full", "partial", "cancelled"]) {
  test(`incremental group save refreshes ${scenario} PO allocations after the global definition is reloaded`, async () => {
    const rollback = await beginRollbackContext();
    try {
      await rollback.run(async () => {
        const { saved, groupRef, vendor } = await seedAllocatedGroup();
        if (scenario === "partial") {
          await query(`UPDATE dispatch_so_po_allocations SET allocated_sales_qty = allocated_sales_qty / 2
            WHERE dispatch_target_ref = $1`, [groupRef]);
        } else if (scenario === "cancelled") {
          await query("UPDATE dispatch_so_po_allocations SET status = 'cancelled' WHERE dispatch_target_ref = $1", [groupRef]);
        }
        const { plan } = await getDispatchV2Bootstrap({ planId: saved.id });
        const command = {
          commandId: crypto.randomUUID(), commandType: "update_load", compactReceipt: true,
          baseRevision: plan.revision, baseDigest: plan.digest,
          payload: { planDelta: { s: { ...plan.summary, pickupRefreshRegression: scenario } } }
        };
        if (scenario === "cancelled") {
          const before = (await query(
            "SELECT orders, trucks, summary FROM dispatch_plan_snapshots WHERE plan_id = $1", [saved.id]
          )).rows[0];
          await assert.rejects(applyDispatchV2Command({ planId: saved.id, command }),
            (error) => error.code === "DISPATCH_PICKUP_ORDER_WRONG_YARD"
              && error.conflicts.some((conflict) => conflict.orderRef === groupRef));
          const after = (await query(
            "SELECT orders, trucks, summary FROM dispatch_plan_snapshots WHERE plan_id = $1", [saved.id]
          )).rows[0];
          assert.deepEqual(after, before, "invalid manual pickups must not commit a partial save");
          assert.equal(Number((await query("SELECT revision FROM dispatch_plans WHERE id = $1", [saved.id])).rows[0].revision), saved.revision);
          return;
        }
        const { payload: result } = await applyDispatchV2Command({ planId: saved.id, command });
        assert.equal(result.plan.revision, saved.revision + 1);
        const stored = (await query(
          "SELECT orders, trucks, summary FROM dispatch_plan_snapshots WHERE plan_id = $1", [saved.id]
        )).rows[0];
        const order = stored.orders.find((candidate) => candidate.id === groupRef);
        const required = scenario === "full" ? [vendor] : ["2967", vendor];
        assert.deepEqual(dispatchRequiredPickupVisitLocations(order, stored), required);
        assert.deepEqual(materializeDispatchPickupVisits(stored, { allowLegacyPassthrough: true }).conflicts, []);
        assert.deepEqual(order.items.map((item) => Number(item.poAllocatedPallets || 0)),
          scenario === "full" ? [5, 2] : [2.5, 1]);
        const stops = stored.trucks[0].loads[0].stops;
        assert.deepEqual(stops.filter((stop) => stop.type === "pick").map((stop) => stop.location).sort(), [...required].sort());
        if (scenario === "full") assert.deepEqual(stops, saved.trucks[0].loads[0].stops, "no empty pickup or route rewrite");
        const replay = await applyDispatchV2Command({ planId: saved.id, command });
        assert.equal(replay.replay, true);
        assert.equal(replay.payload.plan.revision, result.plan.revision, "retry must not apply the save twice");
      });
    } finally {
      await rollback.rollback();
    }
  });
}
