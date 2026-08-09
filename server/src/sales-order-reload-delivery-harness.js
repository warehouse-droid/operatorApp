import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import {
  applyConfirmedDispatchPlanToDelivery,
  confirmDeliveryLine,
  getDeliveryOrder,
  listDeliveryLoadTrucks,
  listDeliveryOrders,
  recordDeliveryLoad,
  updateDeliveryStatus
} from "./delivery-repository.js";
import { assertSalesOrderReloadEligibility } from "./sales-order-reload.js";
import {
  createReloadCycle,
  listSalesOrderLoadAttempts,
  lockReloadAuthorizationSnapshot
} from "./sales-order-reload-repository.js";

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const orderId = 9980000000 + Number(runId.slice(-7));
const orderRef = `SOMRD${runId}`;
const operatorId = `reload-delivery-${runId}`;
const groupRef = `GROUP-RELOAD-DELIVERY-${runId}`;
const authorizationRequestId = "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e201";
const loadRequestId = "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e202";
const photos = [
  "data:image/jpeg;base64,cmVsb2FkLWRlbGl2ZXJ5LTE=",
  "data:image/jpeg;base64,cmVsb2FkLWRlbGl2ZXJ5LTI="
];

async function snapshotCanonical(lineId) {
  const result = await query(
    `SELECT o.operator_status, o.local_yard_order_status, o.preparing_operator_id,
            o.preparing_started_at, o.dispatch_planned, o.dispatch_plan_date::text,
            o.dispatch_truck_plate, o.dispatch_load_name,
            l.loaded_qty, l.loaded_uom, l.packed_pallet_qty, l.packed_layer_qty,
            l.packed_section_qty, l.packed_piece_qty, l.packed_sales_qty, l.confirmed
       FROM sales_orders o
       JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
      WHERE o.netsuite_id = $1 AND l.id = $2`,
    [orderId, lineId]
  );
  return result.rows;
}

try {
  await withTransaction(async () => {
    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids
       ) VALUES ($1, $2, 'Re-load Delivery Harness', 'hash', 'salt', 'yard_manager', $3::text[], $4::integer[])`,
      [operatorId, operatorId, ["yard_manager"], [15]]
    );
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         operator_status, local_yard_order_status, fulfillment_status,
         netsuite_active, dispatch_planned, dispatch_plan_date,
         dispatch_truck_plate, dispatch_load_name
       ) VALUES (
         $1, $2, CURRENT_DATE, 'Re-load Delivery Customer', 'B', 'Sales Order : Pending Fulfillment',
         15, '12441', 'Delivery',
         'loaded', 'Loaded', 'not_fulfilled',
         true, true, CURRENT_DATE, 'RELOAD-DELIVERY-TRUCK', 'Re-load Delivery Group'
       )`,
      [orderId, orderRef]
    );
    const lineResult = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_description,
         item_type, quantity, unit, location_id, location,
         pallet_qty, layer_qty, section_qty, piece_qty,
         to_plt, to_lyr, to_sec, to_pcs,
         packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
         packed_sales_qty, confirmed, loaded_qty, loaded_uom, netsuite_active
       ) VALUES (
         $1, 72001, 1354, 'Re-load Delivery Item', 'RELOAD-DELIVERY', 'Frozen completed line',
         'InvtPart', 61.5, 'SQFT', 15, '12441',
         1, 0, 0, 0,
         61.5, 10.25, 0, 0,
         0, 0, 0, 0,
         0, false, 61.5, 'SQFT', true
       ) RETURNING id`,
      [orderId]
    );
    const lineId = Number(lineResult.rows[0].id);
    await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref, operator_id,
         photo_data_url, photo_data_urls, line_snapshot, response
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2, $3,
         $4, $5::jsonb, $6::jsonb, $7::jsonb
       )`,
      [
        orderId,
        orderRef,
        operatorId,
        photos[0],
        JSON.stringify(photos),
        JSON.stringify([{ lineId: 72001, itemId: 1354, itemName: "Re-load Delivery Item", loadedQty: 61.5, loadedUom: "SQFT" }]),
        JSON.stringify({ localYardOrderStatus: "Loaded" })
      ]
    );
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES (CURRENT_DATE, 'draft', 'Re-load delivery invariant')
       RETURNING id, plan_date::text`
    );
    const ordinaryLoadedTrucks = await listDeliveryLoadTrucks({
      locationId: 15,
      planDate: plan.rows[0].plan_date
    });
    assert.equal(
      ordinaryLoadedTrucks.some((truck) => truck.truck_plate === "RELOAD-DELIVERY-TRUCK"),
      false,
      "An ordinary loaded Sales Order must not make its truck actionable in Per Load View."
    );

    const replan = {
      id: plan.rows[0].id,
      planDate: plan.rows[0].plan_date,
      status: "confirmed",
      orders: [{ id: orderRef, type: "SO" }],
      trucks: [{
        plate: "RELOAD-REPLAN-TRUCK",
        loads: [{
          name: "Re-load Replan Load",
          stops: [{ type: "drop", orderId: orderRef }]
        }]
      }]
    };
    const eligibility = assertSalesOrderReloadEligibility(await lockReloadAuthorizationSnapshot(orderId));
    await query(
      `UPDATE sales_orders
          SET dispatch_planned = false,
              dispatch_plan_date = null,
              dispatch_truck_plate = null,
              dispatch_load_name = null,
              dispatch_parking_spot = null,
              dispatch_planned_at = null
        WHERE netsuite_id = $1`,
      [orderId]
    );
    await applyConfirmedDispatchPlanToDelivery(replan);
    const ordinaryLoadedPlanFlag = (await query(
      "SELECT dispatch_planned FROM sales_orders WHERE netsuite_id = $1",
      [orderId]
    )).rows[0]?.dispatch_planned;
    assert.equal(
      ordinaryLoadedPlanFlag,
      false,
      "An ordinary loaded Sales Order must remain protected from accidental re-planning."
    );

    const cycle = await createReloadCycle({
      order: eligibility.order,
      targets: eligibility.targets,
      reason: "Returned load needs new wrap and photographs",
      requestId: authorizationRequestId,
      actor: { id: operatorId }
    });
    await applyConfirmedDispatchPlanToDelivery(replan);
    const replannedCanonical = (await query(
      `SELECT dispatch_planned, dispatch_plan_date::text, dispatch_truck_plate, dispatch_load_name,
              operator_status, local_yard_order_status
         FROM sales_orders
        WHERE netsuite_id = $1`,
      [orderId]
    )).rows[0];
    assert.equal(
      replannedCanonical.dispatch_planned,
      true,
      "A loaded Sales Order with an active re-load cycle must regain its planned assignment."
    );
    assert.equal(replannedCanonical.dispatch_plan_date, plan.rows[0].plan_date);
    assert.equal(replannedCanonical.dispatch_truck_plate, "RELOAD-REPLAN-TRUCK");
    assert.equal(replannedCanonical.dispatch_load_name, "Re-load Replan Load");
    assert.equal(replannedCanonical.operator_status, "loaded", "Canonical prior-load progress must remain unchanged.");
    assert.equal(replannedCanonical.local_yard_order_status, "Loaded", "Canonical prior-load status must remain unchanged.");
    const reloadTruckOptions = await listDeliveryLoadTrucks({
      locationId: 15,
      planDate: plan.rows[0].plan_date
    });
    assert.ok(
      reloadTruckOptions.some((truck) => truck.truck_plate === "RELOAD-REPLAN-TRUCK"),
      "A truck with a loaded canonical Sales Order must become actionable when that order has an active re-load."
    );

    const standaloneReplan = (await listDeliveryOrders({
      locationId: 15,
      status: "active",
      orderType: "sales_order"
    })).find((order) => String(order.netsuite_id) === String(orderId));
    assert.ok(standaloneReplan, "An authorized re-load placed on a new plan must reappear in Operator.");
    assert.equal(standaloneReplan.dispatch_planned, true, "The Operator card must classify the re-load under Planned.");
    assert.equal(standaloneReplan.reload_authorized, true);

    await query(
      `INSERT INTO dispatch_delivery_groups (
         group_ref, plan_id, plan_date, order_type, truck_plate, load_name, active
       ) VALUES ($1, $2, CURRENT_DATE, 'sales_order', 'RELOAD-DELIVERY-TRUCK', 'Re-load Delivery Group', true)`,
      [groupRef, plan.rows[0].id]
    );
    await query(
      `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
       VALUES ($1, $2, 0)`,
      [groupRef, orderRef]
    );
    const canonicalBefore = await snapshotCanonical(lineId);
    const groupBefore = (await query(
      `SELECT g.group_ref, g.plan_id, g.plan_date::text, g.truck_plate, g.load_name,
              m.member_order_ref, m.position
         FROM dispatch_delivery_groups g
         JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
        WHERE g.group_ref = $1`,
      [groupRef]
    )).rows;

    const direct = await getDeliveryOrder(orderId);
    assert.equal(direct.reload_authorized, true);
    assert.equal(direct.reload_cycle.id, cycle.id);
    assert.equal(direct.reload_cycle.reason, "Returned load needs new wrap and photographs");
    assert.equal(direct.operator_status, "open");
    assert.equal(direct.local_yard_order_status, "Re-load Authorized");
    assert.equal(direct.lines.length, 1);
    assert.equal(direct.lines[0].reload_line, true);
    assert.equal(Number(direct.lines[0].quantity), 61.5);
    assert.equal(Number(direct.lines[0].loaded_qty), 0);
    assert.equal(Number(direct.lines[0].canonical_loaded_qty), 61.5);

    const active = await listDeliveryOrders({ locationId: 15, status: "active", orderType: "sales_order" });
    assert.equal(active.some((order) => String(order.netsuite_id) === String(orderId)), false, "A grouped child must not be duplicated as a standalone Operator card.");
    const groupListOrder = active.find((order) => String(order.netsuite_id) === groupRef);
    assert.ok(groupListOrder, "The existing dispatch group must reappear when a completed child is authorized for re-load.");
    assert.equal(groupListOrder.reload_authorized, true);
    assert.deepEqual(groupListOrder.reload_child_order_refs, [orderRef]);

    const grouped = await getDeliveryOrder(groupRef);
    assert.equal(grouped.reload_authorized, true);
    assert.deepEqual(grouped.reload_child_order_refs, [orderRef]);
    assert.equal(grouped.lines.length, 1);
    assert.equal(grouped.lines[0].reload_line, true);
    assert.equal(grouped.lines[0].source_lines[0].reloadLine, true);
    assert.equal(Number(grouped.lines[0].loaded_qty), 0);

    await confirmDeliveryLine(groupRef, grouped.lines[0].id, { pallets: 1 }, operatorId);
    const preparing = await getDeliveryOrder(groupRef);
    assert.equal(preparing.operator_status, "preparing");
    assert.equal(Number(preparing.lines[0].packed_pallet_qty), 1);
    await updateDeliveryStatus(groupRef, "packed", operatorId);
    const packed = await getDeliveryOrder(groupRef);
    assert.equal(packed.operator_status, "packed");

    await assert.rejects(
      () => recordDeliveryLoad(groupRef, operatorId, { photoDataUrls: [photos[0]], requestId: loadRequestId }),
      (error) => /At least 2 photos/.test(error.message)
    );
    const loaded = await recordDeliveryLoad(groupRef, operatorId, { photoDataUrls: photos, requestId: loadRequestId });
    assert.equal(loaded.localOnly, true);
    assert.equal(loaded.netSuiteUpdated, false);
    assert.equal(loaded.reloadCycleId, cycle.id);
    assert.equal(loaded.completed, true);
    const duplicate = await recordDeliveryLoad(groupRef, operatorId, { photoDataUrls: photos, requestId: loadRequestId });
    assert.equal(duplicate.id, loaded.id);
    assert.equal(duplicate.idempotent, true);

    const attempts = await listSalesOrderLoadAttempts(orderId);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.attemptKind).sort(), ["original", "reload"]);
    assert.equal(attempts.find((attempt) => attempt.attemptKind === "reload").reason, "Returned load needs new wrap and photographs");

    assert.deepEqual(await snapshotCanonical(lineId), canonicalBefore, "Operator re-load must not rewrite canonical Sales Order progress.");
    const groupAfter = (await query(
      `SELECT g.group_ref, g.plan_id, g.plan_date::text, g.truck_plate, g.load_name,
              m.member_order_ref, m.position
         FROM dispatch_delivery_groups g
         JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
        WHERE g.group_ref = $1`,
      [groupRef]
    )).rows;
    assert.deepEqual(groupAfter, groupBefore, "Operator re-load must not rewrite dispatch group membership or assignment.");
  }, { rollback: true });

  console.log(JSON.stringify({
    ok: true,
    scenarios: 35,
    groupedChildSupported: true,
    canonicalProgressPreserved: true,
    dispatchGroupPreserved: true
  }));
} finally {
  await closeDb();
}
