import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import { assertSalesOrderReloadEligibility } from "./sales-order-reload.js";
import {
  cancelReloadCycle,
  createReloadCycle,
  findLocalSalesOrderIdentity,
  findReloadCycleByRequestId,
  getActiveReloadCycleForOrder,
  getReloadCycle,
  listActiveReloadOrders,
  listSalesOrderLoadAttempts,
  lockReloadAuthorizationSnapshot,
  lockReloadCycle,
  recordReloadLoadAttempt,
  releaseReloadDraft,
  updateReloadCycleStatus,
  updateReloadPackedQuantity
} from "./sales-order-reload-repository.js";

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const orderId = 9970000000 + Number(runId.slice(-7));
const orderRef = `SOMR${runId}`;
const operatorId = `reload-operator-${runId}`;
const groupRef = `GROUP-RELOAD-${runId}`;
const requestIds = {
  authorization: "a1f63fd5-7b2c-4f18-9f8e-5de2a0e0e101",
  firstLoad: "a1f63fd5-7b2c-4f18-9f8e-5de2a0e0e102",
  secondLoad: "a1f63fd5-7b2c-4f18-9f8e-5de2a0e0e103",
  secondAuthorization: "a1f63fd5-7b2c-4f18-9f8e-5de2a0e0e104"
};
const photos = [
  "data:image/jpeg;base64,cmVsb2FkLXBob3RvLTE=",
  "data:image/jpeg;base64,cmVsb2FkLXBob3RvLTI="
];

async function jsonSnapshot(sql, params) {
  const result = await query(sql, params);
  return result.rows;
}

try {
  await withTransaction(async () => {
    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids
       ) VALUES ($1, $2, 'Re-load Harness Operator', 'hash', 'salt', 'yard_manager', $3::text[], $4::integer[])`,
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
         $1, $2, CURRENT_DATE, 'Re-load Harness Customer', 'B', 'Sales Order : Pending Fulfillment',
         15, '12441', 'Delivery',
         'loaded', 'Loaded', 'not_fulfilled',
         true, true, CURRENT_DATE, 'RELOAD-TRUCK', 'Re-load Harness Load'
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
         $1, 71001, 1354, 'Re-load Harness Item', 'RELOAD-HARNESS', 'Frozen original line',
         'InvtPart', 143.5, 'SQFT', 15, '12441',
         2, 2, 0, 0,
         61.5, 10.25, 0, 0,
         0, 0, 0, 0,
         0, false, 71.75, 'SQFT', true
       ) RETURNING id`,
      [orderId]
    );
    const lineId = Number(lineResult.rows[0].id);
    const originalLoad = await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref, operator_id,
         photo_data_url, photo_data_urls, line_snapshot, response
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2, $3,
         $4, $5::jsonb, $6::jsonb, $7::jsonb
       ) RETURNING id`,
      [
        orderId,
        orderRef,
        operatorId,
        photos[0],
        JSON.stringify(photos),
        JSON.stringify([{ lineId: 71001, itemId: 1354, itemName: "Re-load Harness Item", loadedQty: 71.75, loadedUom: "SQFT" }]),
        JSON.stringify({ localYardOrderStatus: "Loaded" })
      ]
    );
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES (CURRENT_DATE, 'draft', 'Re-load invariant') RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_delivery_groups (
         group_ref, plan_id, plan_date, order_type, truck_plate, load_name, active
       ) VALUES ($1, $2, CURRENT_DATE, 'sales_order', 'RELOAD-TRUCK', 'Re-load Harness Load', true)`,
      [groupRef, plan.rows[0].id]
    );
    await query(
      `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
       VALUES ($1, $2, 0)`,
      [groupRef, orderRef]
    );

    const canonicalBefore = await jsonSnapshot(
      `SELECT o.operator_status, o.local_yard_order_status, o.dispatch_planned,
              o.dispatch_plan_date::text, o.dispatch_truck_plate, o.dispatch_load_name,
              l.loaded_qty, l.loaded_uom, l.packed_pallet_qty, l.packed_layer_qty,
              l.packed_section_qty, l.packed_piece_qty, l.packed_sales_qty, l.confirmed
         FROM sales_orders o
         JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
        WHERE o.netsuite_id = $1`,
      [orderId]
    );
    const dispatchBefore = await jsonSnapshot(
      `SELECT g.group_ref, g.plan_id, g.plan_date::text, g.truck_plate, g.load_name,
              m.member_order_ref, m.position
         FROM dispatch_delivery_groups g
         JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
        WHERE g.group_ref = $1`,
      [groupRef]
    );

    const identity = await findLocalSalesOrderIdentity(orderId);
    assert.deepEqual(identity, {
      netsuiteId: orderId,
      tranid: orderRef,
      outboundLocationId: 15
    });
    const snapshot = await lockReloadAuthorizationSnapshot(orderId);
    assert.equal(snapshot.priorLoadCount, 1);
    assert.equal(snapshot.completedDropoff, false);
    assert.equal(snapshot.activeCycle, null);
    assert.equal(snapshot.activeDraft, false);
    assert.equal(snapshot.activeConsolidation, false);
    const eligibility = assertSalesOrderReloadEligibility(snapshot);
    assert.equal(eligibility.targets[0].targetSalesQty, 71.75);

    const cycle = await createReloadCycle({
      order: eligibility.order,
      targets: eligibility.targets,
      reason: "Damaged wrap; truck returned",
      requestId: requestIds.authorization,
      actor: { id: operatorId }
    });
    assert.equal(cycle.status, "authorized");
    assert.equal(cycle.cycleNumber, 1);
    assert.equal(cycle.lines[0].targetSalesQty, 71.75);
    assert.equal((await findReloadCycleByRequestId(requestIds.authorization)).id, cycle.id);
    assert.equal((await getActiveReloadCycleForOrder(orderId)).id, cycle.id);
    assert.equal((await getReloadCycle(cycle.id)).lines.length, 1);
    assert.equal((await lockReloadCycle(cycle.id)).id, cycle.id);

    await assert.rejects(
      () => createReloadCycle({
        order: eligibility.order,
        targets: eligibility.targets,
        reason: "Duplicate active cycle",
        requestId: "a1f63fd5-7b2c-4f18-9f8e-5de2a0e0e199",
        actor: { id: operatorId }
      }),
      (error) => error?.code === "23505",
      "The database must enforce exactly one active cycle per Sales Order."
    );

    const activeOrders = await listActiveReloadOrders({ locationId: 15 });
    assert.equal(activeOrders.length, 1);
    assert.equal(activeOrders[0].netsuite_id, orderId);
    assert.equal(activeOrders[0].reload_cycle.id, cycle.id);
    assert.deepEqual(await listActiveReloadOrders({ locationId: 1 }), []);

    const firstPacked = await updateReloadPackedQuantity({
      orderId,
      lineId,
      values: { pallets: 4 },
      operatorId,
      absolute: true
    });
    assert.equal(firstPacked.cycle.status, "preparing");
    assert.ok(firstPacked.cycle.activityStartedAt, "The first Operator mutation must permanently start the cycle.");
    assert.equal(firstPacked.line.packedPalletQty, 1);
    assert.equal(firstPacked.line.packedTotalSalesQty, 61.5);
    await updateReloadCycleStatus({ orderId, status: "packed", operatorId });

    await assert.rejects(
      () => recordReloadLoadAttempt(orderId, operatorId, {
        requestId: "a1f63fd5-7b2c-4f18-9f8e-5de2a0e0e188",
        photoDataUrls: [photos[0]]
      }),
      (error) => /At least 2 photos/.test(error.message)
    );
    const firstAttempt = await recordReloadLoadAttempt(orderId, operatorId, {
      requestId: requestIds.firstLoad,
      photoDataUrls: photos
    });
    assert.equal(firstAttempt.localOnly, true);
    assert.equal(firstAttempt.reloadCycleId, cycle.id);
    assert.equal(firstAttempt.completed, false);
    assert.equal(firstAttempt.remainingSalesQty, 10.25);
    assert.equal(firstAttempt.attemptLines[0].loadedQty, 61.5);
    const duplicateFirst = await recordReloadLoadAttempt(orderId, operatorId, {
      requestId: requestIds.firstLoad,
      photoDataUrls: photos
    });
    assert.equal(duplicateFirst.id, firstAttempt.id);
    assert.equal(duplicateFirst.idempotent, true);

    const secondPacked = await updateReloadPackedQuantity({
      orderId,
      lineId,
      values: { layers: 10 },
      operatorId,
      absolute: true
    });
    assert.equal(secondPacked.line.packedLayerQty, 1);
    assert.equal(secondPacked.line.packedTotalSalesQty, 10.25);
    await updateReloadCycleStatus({ orderId, status: "packed", operatorId });
    const secondAttempt = await recordReloadLoadAttempt(orderId, operatorId, {
      requestId: requestIds.secondLoad,
      photoDataUrls: photos
    });
    assert.equal(secondAttempt.completed, true);
    assert.equal(secondAttempt.remainingSalesQty, 0);
    assert.equal((await getReloadCycle(cycle.id)).status, "completed");
    assert.equal(await getActiveReloadCycleForOrder(orderId), null);

    const attempts = await listSalesOrderLoadAttempts(orderId);
    assert.equal(attempts.length, 3, "The original load and both re-load attempts must remain separate.");
    assert.deepEqual(
      attempts.map((attempt) => attempt.attemptKind).sort(),
      ["original", "reload", "reload"]
    );
    assert.ok(attempts.filter((attempt) => attempt.attemptKind === "reload").every((attempt) =>
      attempt.reason === "Damaged wrap; truck returned"
      && attempt.operatorId === operatorId
      && attempt.photos.length === 2
      && attempt.attemptLines.length === 1
    ));
    assert.equal(Number(originalLoad.rows[0].id), attempts.find((attempt) => attempt.attemptKind === "original").id);

    const canonicalAfter = await jsonSnapshot(
      `SELECT o.operator_status, o.local_yard_order_status, o.dispatch_planned,
              o.dispatch_plan_date::text, o.dispatch_truck_plate, o.dispatch_load_name,
              l.loaded_qty, l.loaded_uom, l.packed_pallet_qty, l.packed_layer_qty,
              l.packed_section_qty, l.packed_piece_qty, l.packed_sales_qty, l.confirmed
         FROM sales_orders o
         JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
        WHERE o.netsuite_id = $1`,
      [orderId]
    );
    const dispatchAfter = await jsonSnapshot(
      `SELECT g.group_ref, g.plan_id, g.plan_date::text, g.truck_plate, g.load_name,
              m.member_order_ref, m.position
         FROM dispatch_delivery_groups g
         JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
        WHERE g.group_ref = $1`,
      [groupRef]
    );
    assert.deepEqual(canonicalAfter, canonicalBefore, "Re-load work must not mutate canonical SO progress.");
    assert.deepEqual(dispatchAfter, dispatchBefore, "Re-load work must not mutate Dispatch grouping or assignment.");

    const secondCycle = await createReloadCycle({
      order: eligibility.order,
      targets: eligibility.targets,
      reason: "Sequential re-load",
      requestId: requestIds.secondAuthorization,
      actor: { id: operatorId }
    });
    assert.equal(secondCycle.cycleNumber, 2);
    const released = await releaseReloadDraft(orderId, operatorId);
    assert.equal(released.status, "authorized");
    const cancelled = await cancelReloadCycle({ cycleId: secondCycle.id, reason: "No longer required", actor: { id: operatorId } });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelReason, "No longer required");

    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, photo_data_urls, status, completed_at
       ) VALUES (
         $1, CURRENT_DATE, 'reload-driver', 'RELOAD-TRUCK', 'RELOAD-LOAD', 'Re-load Harness Load',
         'RELOAD-DROPOFF', 'dropoff', $2::jsonb, '[]'::jsonb, 'complete', now()
       )`,
      [`RELOAD-JOB-${runId}`, JSON.stringify([groupRef])]
    );
    const completedSnapshot = await lockReloadAuthorizationSnapshot(orderId);
    assert.equal(completedSnapshot.completedDropoff, true, "A grouped child must inherit its group's completed drop-off guard.");
  }, { rollback: true });

  console.log(JSON.stringify({
    ok: true,
    scenarios: 20,
    canonicalProgressPreserved: true,
    dispatchGroupPreserved: true,
    attemptsPreserved: 3
  }));
} finally {
  await closeDb();
}
