// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { query } from "../../../src/db.js";
import {
  createDispatchCustomOrder,
  dispatchOrderFromCustomOrder
} from "../../../src/dispatch-custom-order-repository.js";

let fixture;

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

/** @param {string} planId @param {string} date */
async function bootstrap(planId, date) {
  const result = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${encodeURIComponent(planId)}&date=${encodeURIComponent(date)}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /private, no-store/i);
  assert.ok(result.payload.plan?.digest, "Bootstrap must supply the digest required for a guarded command.");
  return result.payload;
}

/** @param {ReturnType<typeof bootstrap> extends Promise<infer T> ? T : never} boot @param {string} planId @param {string} lease @param {string} commandId @param {string} commandType @param {Record<string, unknown>} payload */
async function command(boot, planId, lease, commandId, commandType, payload) {
  return fixture.request(`/api/dispatch/v2/plans/${planId}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId,
      baseRevision: boot.plan.revision,
      baseDigest: boot.plan.digest,
      sessionId: "dispatch-v2-command-flow",
      commandType,
      payload
    }
  });
}

async function seedReconciliationCompletedPurchaseOrder({
  netsuiteId,
  lineId,
  ref,
  driverCompletedPlanId = null,
  isBlanket = false
}) {
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       source_location, destination_location_id, destination_location,
       dispatch_vendor_yard, dispatch_address, receipt_status,
       initial_scm_status, is_blanket_po, netsuite_active, synced_at
     ) VALUES (
       $1, $2, DATE '2023-03-01', 991001, 'History Mode Vendor', 'B', 'Purchase Order : Received',
       'History Vendor Yard', 1, '3445',
       'History Vendor Yard', '3445 Kennedy Road, Toronto, ON', 'received',
       'Queued', $3::boolean, true, now()
     )`,
    [netsuiteId, ref, isBlanket]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       item_weight, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, location_id, location,
       netsuite_received_qty, netsuite_received_baseline_qty,
       netsuite_active, synced_at, raw
     ) VALUES (
       $1, $2, $1, $1, 'History Mode Item', $3, 10, 'EA',
       5, 1, 0, 0, 0,
       10, 0, 0, 1, 1, '3445',
       10, 10,
       true, now(), '{}'::jsonb
     )`,
    [lineId, netsuiteId, `${ref}-ITEM`]
  );
  const state = await query(
    `INSERT INTO scm_reconciliation_order_state (
       order_kind, source_order_netsuite_id, source_order_ref,
       application_status, reconciliation_status, reconciliation_source,
       ordered_qty, received_qty, remaining_qty, quantity_summary,
       reconciled_at, completed_at
     ) VALUES (
       'PO', $1, $2,
       'Completed', 'ok', 'nightly',
       10, 10, 0, $3::jsonb,
       now() - interval '1 day', now() - interval '1 day'
     )
     RETURNING id`,
    [
      netsuiteId,
      ref,
      JSON.stringify({
        family: { ordered: 10, received: 10, remaining: 0, applicationStatus: "Completed" },
        targets: { [ref]: { ordered: 10, received: 10, remaining: 0, applicationStatus: "Completed" } }
      })
    ]
  );
  await query(
    `INSERT INTO scm_transport_schedule (
       order_kind, source_table, source_id, order_ref, display_ref,
       method, pickup_point, dropoff_point, brand, content, weight_lbs, status,
       reconciliation_order_state_id, created_by, updated_by
     ) VALUES (
       'PO', 'purchase_orders', $1, $2, $2,
       'MBT', 'History Vendor Yard', '3445', 'History Mode Vendor', $2, 50, 'Completed',
       $3, 'dispatch-history-test', 'reconciliation'
     )`,
    [netsuiteId, ref, state.rows[0].id]
  );
  if (driverCompletedPlanId) {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
         load_id, load_name, stop_id, stop_type, order_refs,
         status, started_at, completed_at
       ) VALUES (
         $1, $2, DATE '2023-03-02', 'history-driver', 'HISTORY-TRUCK', 'HISTORY-TRUCK',
         'history-source-load', 'History source load', $3, 'drop', $4::jsonb,
         'complete', now() - interval '2 days', now() - interval '2 days'
       )`,
      [`dispatch-history-complete-${ref}`, driverCompletedPlanId, `dispatch-history-stop-${ref}`, JSON.stringify([ref])]
    );
  }
}

async function seedReconciliationCompletedSalesOrder({
  netsuiteId,
  lineId,
  ref,
  driverCompletedPlanId = null,
  includeReconciliationAudit = true
}) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
       outbound_location_id, outbound_location, delivery_method_id, sales_order_type,
       expected_delivery_date, dispatch_address, operator_status,
       local_yard_order_status, fulfillment_status, dispatch_planned,
       netsuite_active, synced_at
     ) VALUES (
       $1, $2, DATE '2023-03-01', 991002, 'History Mode Customer', 'F', 'Sales Order : Pending Billing',
       1, '3445', 1, 'Delivery',
       DATE '2023-03-01', '55 History Road, Toronto, ON', 'fulfilled',
       'Shipped', 'fulfilled', false,
       false, now()
     )`,
    [netsuiteId, ref]
  );
  await query(
    `INSERT INTO sales_order_lines (
       id, sales_order_id, line_id, item_id, item_name, sku, item_description,
       quantity, unit, item_weight, pallet_qty, layer_qty, section_qty, piece_qty,
       packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_section_qty, fulfilled_piece_qty,
       netsuite_active, synced_at
     ) VALUES (
       $1, $2, $1, $1, 'History SO Item', $3, 'Reconciliation-complete sales order item',
       10, 'EA', 5, 1, 0, 0, 0,
       1, 0, 0, 0,
       10, 0, 0, 1,
       1, 0, 0, 0,
       false, now()
     )`,
    [lineId, netsuiteId, `${ref}-ITEM`]
  );
  if (includeReconciliationAudit) {
    await query(
      `INSERT INTO scm_reconciliation_audit_events (
         event_key, source, event_type, record_type, action, validation_status,
         netsuite_transaction_id, transaction_ref,
         parent_order_kind, parent_order_netsuite_id, parent_order_ref,
         occurred_at, payload, actor
       ) VALUES (
         $1, 'system', 'order.applied', 'SO', 'apply', 'accepted',
         $2, $3, 'SO', $2, $3,
         now() - interval '1 day', $4::jsonb, 'dispatch-history-test'
       )`,
      [
        `dispatch-history-so:${ref}`,
        netsuiteId,
        ref,
        JSON.stringify({
          orderKind: "SO",
          sourceOrderId: netsuiteId,
          sourceOrderRef: ref,
          familyOrderRefs: [ref],
          dryRun: false,
          fulfilledByHeader: true,
          reconciliationStatus: "current",
          applicationStatus: "Completed"
        })
      ]
    );
  }
  if (driverCompletedPlanId) {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
         load_id, load_name, stop_id, stop_type, order_refs,
         status, started_at, completed_at
       ) VALUES (
         $1, $2, DATE '2023-03-02', 'history-driver', 'HISTORY-SO-TRUCK', 'HISTORY-SO-TRUCK',
         'history-so-source-load', 'History SO source load', $3, 'drop', $4::jsonb,
         'complete', now() - interval '2 days', now() - interval '2 days'
       )`,
      [`dispatch-history-complete-${ref}`, driverCompletedPlanId, `dispatch-history-stop-${ref}`, JSON.stringify([ref])]
    );
  }
}

test("DP-05: remove → group → ungroup → replan is an exact, continuous command sequence", async () => {
  const seeded = await fixture.seedPlan({ date: "2025-01-15", refs: ["DP-A", "DP-B", "DP-C", "DP-D"] });
  const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-command-flow" });
  let current = await bootstrap(seeded.id, seeded.plan_date);

  let result = await command(current, seeded.id, lease, "dp05-remove-a", "remove_order", { orderRef: "DP-A" });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.revision, current.plan.revision + 1);
  assert.deepEqual(result.payload.patch.removedOrderRefs, ["DP-A"]);
  current = result.payload;

  result = await command(current, seeded.id, lease, "dp05-group-b-c", "group_orders", { orderRefs: ["DP-B", "DP-C"] });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.revision, current.plan.revision + 1);
  assert.equal(result.payload.patch.group.orderRefs.length, 2);
  const groupRef = result.payload.patch.group.ref;
  current = result.payload;

  result = await command(current, seeded.id, lease, "dp05-ungroup-b-c", "ungroup_orders", { groupRef });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.patch.ungroupedOrderRefs.sort(), ["DP-B", "DP-C"]);
  current = result.payload;

  result = await command(current, seeded.id, lease, "dp05-replan-a", "assign_order", {
    orderRef: "DP-A", truckId: "DP-V2-TEST", loadId: "dp-v2-load-1", afterStopId: "dp-v2-stop-3"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.revision, current.plan.revision + 1);
  assert.deepEqual(result.payload.patch.assignedOrderRefs, ["DP-A"]);

  const finalBoard = await bootstrap(seeded.id, seeded.plan_date);
  assert.equal(finalBoard.plan.revision, seeded.revision + 4);
  assert.deepEqual(finalBoard.plan.board.orderRefs.filter((ref) => ref === "DP-A"), ["DP-A"]);
  assert.deepEqual(finalBoard.plan.board.orderRefs.filter((ref) => ref === "DP-B"), ["DP-B"]);
  assert.deepEqual(finalBoard.plan.board.orderRefs.filter((ref) => ref === "DP-C"), ["DP-C"]);
});

test("DP-05: browser ungroup deactivates its durable delivery group before a hard refresh", async () => {
  const childRefs = ["SOB116758", "SOB117328"];
  const groupRef = "GOB-116758-117328";
  const seeded = await fixture.seedPlan({ date: "2025-01-16", refs: childRefs });
  const lease = await fixture.acquireLease({
    planDate: seeded.plan_date,
    sessionId: "dispatch-v2-delivery-group"
  });
  let current = await bootstrap(seeded.id, seeded.plan_date);
  const groupedOrder = {
    ...jsonClone(current.plan.assignedOrderSnapshots[0]),
    id: groupRef,
    orderId: groupRef,
    refNumber: groupRef,
    type: "SO",
    customer: "2 orders grouped",
    childOrders: childRefs,
    childOrderDetails: jsonClone(current.plan.assignedOrderSnapshots),
    planOwned: true
  };
  const groupedTrucks = jsonClone(current.plan.trucks);
  groupedTrucks[0].loads[0].stops = [{
    id: "dp-v2-group-drop",
    type: "drop",
    orderId: groupRef,
    location: "Grouped delivery"
  }];

  let result = await command(current, seeded.id, lease, "dp05-browser-group", "replace_plan", {
    planDate: seeded.plan_date,
    orders: [groupedOrder],
    trucks: groupedTrucks,
    summary: current.plan.summary,
    actionName: "group_order"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const projectedGroup = await query(
    `SELECT active,
            ARRAY(
              SELECT member_order_ref
                FROM dispatch_delivery_group_members
               WHERE group_ref = $1
               ORDER BY position
            ) AS member_refs
       FROM dispatch_delivery_groups
      WHERE group_ref = $1`,
    [groupRef]
  );
  assert.equal(projectedGroup.rows[0]?.active, true);
  assert.deepEqual(projectedGroup.rows[0]?.member_refs, childRefs);

  current = result.payload;
  const ungroupedTrucks = jsonClone(current.plan.trucks);
  ungroupedTrucks[0].loads[0].stops = [];
  result = await command(current, seeded.id, lease, "dp05-browser-ungroup", "replace_plan", {
    planDate: seeded.plan_date,
    orders: [],
    trucks: ungroupedTrucks,
    summary: current.plan.summary,
    actionName: "ungroup_order",
    refreshOrderPool: true
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(
    (await query("SELECT active FROM dispatch_delivery_groups WHERE group_ref = $1", [groupRef])).rows[0]?.active,
    false,
    "Ungroup must deactivate the Operator-facing projection in the same transaction as the plan snapshot."
  );

  const refreshed = await bootstrap(seeded.id, seeded.plan_date);
  assert.equal(
    refreshed.plan.assignedOrderSnapshots.some((order) => order.id === groupRef),
    false,
    "A hard refresh must not restore the removed group from the saved plan."
  );
  assert.equal(refreshed.plan.board.orderRefs.includes(groupRef), false);
});

test("DP-05: a late cross-date order feed cannot resurrect GOB-116758-117328 after ungroup and an unrelated save", async () => {
  const childRefs = ["SOB116758", "SOB117328"];
  const groupRef = "GOB-116758-117328";
  const owner = await fixture.seedPlan({ date: "2039-08-09", refs: childRefs });
  const ownerLease = await fixture.acquireLease({
    planDate: owner.plan_date,
    sessionId: "dispatch-v2-cross-date-ungroup"
  });
  let current = await bootstrap(owner.id, owner.plan_date);
  const groupedOrder = {
    ...jsonClone(current.plan.assignedOrderSnapshots[0]),
    id: groupRef,
    orderId: groupRef,
    refNumber: groupRef,
    type: "SO",
    customer: "2 orders grouped",
    childOrders: childRefs,
    childOrderDetails: jsonClone(current.plan.assignedOrderSnapshots),
    groupPlanId: owner.id,
    groupPlanDate: owner.plan_date,
    planOwned: true
  };
  const groupedTrucks = jsonClone(current.plan.trucks);
  groupedTrucks[0].loads[0].stops = [{
    id: "dp-v2-cross-date-group-drop",
    type: "drop",
    orderId: groupRef,
    location: "Grouped delivery"
  }];

  let result = await command(current, owner.id, ownerLease, "dp05-cross-date-group", "replace_plan", {
    planDate: owner.plan_date,
    orders: [groupedOrder],
    trucks: groupedTrucks,
    summary: current.plan.summary,
    actionName: "group_order"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  current = result.payload;

  const ungroupedTrucks = jsonClone(current.plan.trucks);
  ungroupedTrucks[0].loads[0].stops = [];
  result = await command(current, owner.id, ownerLease, "dp05-cross-date-ungroup", "replace_plan", {
    planDate: owner.plan_date,
    orders: [],
    trucks: ungroupedTrucks,
    summary: current.plan.summary,
    actionName: "ungroup_order",
    refreshOrderPool: true
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  current = result.payload;

  const copiedPlan = await fixture.seedPlan({ date: "2039-08-10", refs: ["DP-CROSS-DATE-COPY-SEED"] });
  const copiedGroup = {
    ...groupedOrder,
    dispatchSnapshotSourcePlanId: copiedPlan.id,
    dispatchSnapshotSourcePlanDate: copiedPlan.plan_date
  };
  await query(
    `UPDATE dispatch_plan_snapshots
        SET orders = orders || $2::jsonb,
            saved_at = now()
      WHERE plan_id = $1`,
    [copiedPlan.id, JSON.stringify([copiedGroup])]
  );
  assert.equal(
    (await query(
      `SELECT count(*)::int AS count
         FROM dispatch_plan_snapshots s
         CROSS JOIN LATERAL jsonb_array_elements(s.orders) item(value)
        WHERE s.plan_id = $1
          AND item.value->>'id' = $2`,
      [copiedPlan.id, groupRef]
    )).rows[0].count,
    1,
    "The regression fixture must contain the stale group in the following date's snapshot."
  );

  const lateFeed = await fixture.request(`/api/dispatch/orders?search=${encodeURIComponent(groupRef)}`);
  assert.equal(lateFeed.response.status, 200, JSON.stringify(lateFeed.payload));
  assert.equal(
    lateFeed.payload.some((order) => order.id === groupRef),
    false,
    "The global order feed must not source a group from a snapshot that does not own it."
  );

  result = await command(current, owner.id, ownerLease, "dp05-cross-date-unrelated-save", "replace_plan", {
    planDate: owner.plan_date,
    orders: current.plan.assignedOrderSnapshots,
    trucks: current.plan.trucks,
    summary: { ...current.plan.summary, unrelatedSaveAfterUngroup: true },
    affectedOrderRefs: ["DP-UNRELATED-ORDER"],
    actionName: "drop_order_new_load"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));

  const hardRefresh = await bootstrap(owner.id, owner.plan_date);
  assert.equal(hardRefresh.plan.assignedOrderSnapshots.some((order) => order.id === groupRef), false);
  assert.equal(hardRefresh.plan.board.orderRefs.includes(groupRef), false);
  assert.equal(
    (await query(
      `SELECT count(*)::int AS count
         FROM dispatch_plan_snapshots s
         CROSS JOIN LATERAL jsonb_array_elements(s.orders) item(value)
        WHERE s.plan_id = $1
          AND item.value->>'id' = $2`,
      [owner.id, groupRef]
    )).rows[0].count,
    0,
    "The unrelated save must not persist the stale cross-date group back into the owning plan."
  );
});

test("DP-07: a previous-date order may be removed and re-added to its own plan, but not another active date", async () => {
  const prior = await fixture.seedPlan({ date: "2024-01-15", refs: ["DP-HISTORY-A"] });
  const lease = await fixture.acquireLease({ planDate: prior.plan_date, sessionId: "dispatch-v2-previous-date" });
  let current = await bootstrap(prior.id, prior.plan_date);

  let result = await command(current, prior.id, lease, "dp07-remove", "remove_order", { orderRef: "DP-HISTORY-A" });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  current = result.payload;
  result = await command(current, prior.id, lease, "dp07-re-add", "assign_order", {
    orderRef: "DP-HISTORY-A", truckId: "DP-V2-TEST", loadId: "dp-v2-load-1"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));

  const other = await fixture.seedPlan({ date: "2024-01-16", refs: ["DP-OTHER"] });
  const otherLease = await fixture.acquireLease({ planDate: other.plan_date, sessionId: "dispatch-v2-other-date" });
  const otherBoot = await bootstrap(other.id, other.plan_date);
  result = await command(otherBoot, other.id, otherLease, "dp07-cross-date", "assign_order", {
    orderRef: "DP-HISTORY-A", truckId: "DP-V2-TEST", loadId: "dp-v2-load-1"
  });
  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_ORDER_ALREADY_PLANNED");
});

test("history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders", async () => {
  const planDate = "2023-03-01";
  const allowedRef = "DP-HISTORY-RECON-COMPLETE";
  const driverCompletedRef = "DP-HISTORY-DRIVER-COMPLETE";
  const blanketRef = "DP-HISTORY-BLANKET-COMPLETE";
  const completedSalesOrderRef = "SOM05565";
  const driverCompletedSalesOrderRef = "SOM05566";
  const unprovenInactiveSalesOrderRef = "SOM05567";
  const source = await fixture.seedPlan({ date: "2023-03-02", refs: ["DP-HISTORY-SOURCE-CONTROL"] });
  await seedReconciliationCompletedPurchaseOrder({
    netsuiteId: 991001001,
    lineId: 991001101,
    ref: allowedRef
  });
  await seedReconciliationCompletedPurchaseOrder({
    netsuiteId: 991001002,
    lineId: 991001102,
    ref: driverCompletedRef,
    driverCompletedPlanId: source.id
  });
  await seedReconciliationCompletedPurchaseOrder({
    netsuiteId: 991001003,
    lineId: 991001103,
    ref: blanketRef,
    isBlanket: true
  });
  await seedReconciliationCompletedSalesOrder({
    netsuiteId: 991002001,
    lineId: 991002101,
    ref: completedSalesOrderRef
  });
  await seedReconciliationCompletedSalesOrder({
    netsuiteId: 991002002,
    lineId: 991002102,
    ref: driverCompletedSalesOrderRef,
    driverCompletedPlanId: source.id
  });
  await seedReconciliationCompletedSalesOrder({
    netsuiteId: 991002003,
    lineId: 991002103,
    ref: unprovenInactiveSalesOrderRef,
    includeReconciliationAudit: false
  });

  const target = await fixture.seedPlan({ date: planDate, refs: [] });
  const lease = await fixture.acquireLease({
    planDate,
    sessionId: "dispatch-v2-history-edit"
  });

  const ordinaryFeed = await fixture.request(`/api/dispatch/orders?search=${encodeURIComponent("DP-HISTORY-")}`);
  assert.equal(ordinaryFeed.response.status, 200, JSON.stringify(ordinaryFeed.payload));
  assert.equal(ordinaryFeed.payload.some((order) => order.id === allowedRef), false,
    "Current Dispatch order visibility must remain unchanged outside History Edit Mode.");
  assert.equal(ordinaryFeed.payload.some((order) => order.id === driverCompletedRef), false);

  const ordinarySalesOrderFeed = await fixture.request(
    `/api/dispatch/orders?search=${encodeURIComponent(completedSalesOrderRef)}`
  );
  assert.equal(ordinarySalesOrderFeed.response.status, 200, JSON.stringify(ordinarySalesOrderFeed.payload));
  assert.equal(ordinarySalesOrderFeed.payload.some((order) => order.id === completedSalesOrderRef), false,
    "A reconciliation-complete SO must remain absent from current Dispatch planning.");

  const noLeaseFeed = await fixture.request(
    `/api/dispatch/orders?search=${encodeURIComponent("DP-HISTORY-")}&historyPlanDate=${planDate}&sessionId=dispatch-v2-history-edit`
  );
  assert.equal(noLeaseFeed.response.status, 409, JSON.stringify(noLeaseFeed.payload));
  assert.match(String(noLeaseFeed.payload.code || ""), /DISPATCH_PLAN_EDIT_LEASE/u);

  const futureHistoryFeed = await fixture.request("/api/dispatch/orders?historyPlanDate=2999-01-01", {
    headers: { "x-dispatch-edit-lease": lease }
  });
  assert.equal(futureHistoryFeed.response.status, 400, JSON.stringify(futureHistoryFeed.payload));
  assert.equal(futureHistoryFeed.payload.code, "DISPATCH_HISTORY_DATE_INVALID");

  const emptyHistoryFeed = await fixture.request(
    `/api/dispatch/orders?historyPlanDate=${planDate}`,
    { headers: { "x-dispatch-edit-lease": lease } }
  );
  assert.equal(emptyHistoryFeed.response.status, 200, JSON.stringify(emptyHistoryFeed.payload));
  assert.equal(emptyHistoryFeed.payload.some((order) => order.id === allowedRef), false,
    "History Edit Mode must not preload every reconciliation-complete PO.");
  assert.equal(emptyHistoryFeed.payload.some((order) => order.id === completedSalesOrderRef), false,
    "History Edit Mode must not preload every reconciliation-complete SO.");

  const historyFeed = await fixture.request(
    `/api/dispatch/orders?search=${encodeURIComponent("DP-HISTORY-")}&historyPlanDate=${planDate}`,
    { headers: { "x-dispatch-edit-lease": lease } }
  );
  assert.equal(historyFeed.response.status, 200, JSON.stringify(historyFeed.payload));
  const allowedOrder = historyFeed.payload.find((order) => order.id === allowedRef);
  assert.ok(allowedOrder, "A reconciliation-complete PO must be available to a leased past-date plan.");
  assert.equal(allowedOrder.historicalReconciliationComplete, true);
  assert.equal(allowedOrder.historicalPlanDate, planDate);
  assert.equal(
    historyFeed.payload.some((order) => order.id === driverCompletedRef),
    false,
    "Driver PWA-completed work must remain absent even in History Edit Mode."
  );
  assert.equal(
    historyFeed.payload.some((order) => order.id === blanketRef),
    false,
    "History Edit Mode must not weaken the existing blanket-order restriction."
  );

  const salesOrderHistoryFeed = await fixture.request(
    `/api/dispatch/orders?search=${encodeURIComponent(completedSalesOrderRef)}&historyPlanDate=${planDate}`,
    { headers: { "x-dispatch-edit-lease": lease } }
  );
  assert.equal(salesOrderHistoryFeed.response.status, 200, JSON.stringify(salesOrderHistoryFeed.payload));
  const completedSalesOrder = salesOrderHistoryFeed.payload.find((order) => order.id === completedSalesOrderRef);
  assert.ok(completedSalesOrder,
    "An explicit history search must reveal a reconciliation-complete SO such as SOM05565.");
  assert.equal(completedSalesOrder.type, "SO");
  assert.equal(completedSalesOrder.netsuiteActive, false);
  assert.equal(completedSalesOrder.historicalReconciliationComplete, true);
  assert.equal(completedSalesOrder.historicalPlanDate, planDate);
  assert.equal(completedSalesOrder.items.some((item) => item.sku === `${completedSalesOrderRef}-ITEM`), true);

  const driverCompletedSalesOrderFeed = await fixture.request(
    `/api/dispatch/orders?search=${encodeURIComponent(driverCompletedSalesOrderRef)}&historyPlanDate=${planDate}`,
    { headers: { "x-dispatch-edit-lease": lease } }
  );
  assert.equal(driverCompletedSalesOrderFeed.response.status, 200, JSON.stringify(driverCompletedSalesOrderFeed.payload));
  assert.equal(driverCompletedSalesOrderFeed.payload.some((order) => order.id === driverCompletedSalesOrderRef), false,
    "A Driver PWA-completed SO must remain absent from history search.");

  const unprovenSalesOrderFeed = await fixture.request(
    `/api/dispatch/orders?search=${encodeURIComponent(unprovenInactiveSalesOrderRef)}&historyPlanDate=${planDate}`,
    { headers: { "x-dispatch-edit-lease": lease } }
  );
  assert.equal(unprovenSalesOrderFeed.response.status, 200, JSON.stringify(unprovenSalesOrderFeed.payload));
  assert.equal(unprovenSalesOrderFeed.payload.some((order) => order.id === unprovenInactiveSalesOrderRef), false,
    "An inactive fulfilled SO without accepted reconciliation proof must remain hidden.");

  let current = await bootstrap(target.id, planDate);
  const allowedTrucks = jsonClone(current.plan.trucks);
  allowedTrucks[0].loads[0].stops.push({
    id: "dp-history-reconciliation-drop",
    type: "drop",
    orderId: allowedRef,
    location: "3445 Kennedy Road, Toronto, ON"
  });
  let result = await command(current, target.id, lease, "dp-history-reconciliation-add", "replace_plan", {
    planDate,
    orders: [allowedOrder],
    trucks: allowedTrucks,
    summary: current.plan.summary,
    affectedOrderRefs: [allowedRef],
    actionName: "drop_order_new_load"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.board.orderRefs.includes(allowedRef), true);
  current = result.payload;

  const salesOrderTrucks = jsonClone(current.plan.trucks);
  salesOrderTrucks[0].loads[0].stops.push({
    id: "dp-history-sales-order-drop",
    type: "drop",
    orderId: completedSalesOrderRef,
    location: "55 History Road, Toronto, ON"
  });
  result = await command(current, target.id, lease, "dp-history-sales-order-add", "replace_plan", {
    planDate,
    orders: [...current.plan.assignedOrderSnapshots, completedSalesOrder],
    trucks: salesOrderTrucks,
    summary: current.plan.summary,
    affectedOrderRefs: [completedSalesOrderRef],
    actionName: "drop_order_new_load"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.board.orderRefs.includes(completedSalesOrderRef), true);
  current = result.payload;

  const blanketOrder = {
    ...jsonClone(allowedOrder),
    id: blanketRef,
    orderId: blanketRef,
    refNumber: blanketRef,
    originalPoRef: blanketRef,
    netsuiteId: 991001003
  };
  const blanketTrucks = jsonClone(current.plan.trucks);
  blanketTrucks[0].loads[0].stops.push({
    id: "dp-history-blanket-drop",
    type: "drop",
    orderId: blanketRef,
    location: "3445 Kennedy Road, Toronto, ON"
  });
  result = await command(current, target.id, lease, "dp-history-blanket-add", "replace_plan", {
    planDate,
    orders: [...current.plan.assignedOrderSnapshots, blanketOrder],
    trucks: blanketTrucks,
    summary: current.plan.summary,
    affectedOrderRefs: [blanketRef],
    actionName: "drop_order_new_load"
  });
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.applied, false);
  assert.ok(
    result.payload.validationIssues?.some((issue) => issue.code === "DISPATCH_RESTRICTED_SCM_ORDER"),
    "A forged history save must not bypass the existing blanket-order restriction."
  );

  const blockedOrder = {
    ...jsonClone(allowedOrder),
    id: driverCompletedRef,
    orderId: driverCompletedRef,
    refNumber: driverCompletedRef,
    originalPoRef: driverCompletedRef,
    netsuiteId: 991001002
  };
  const blockedTrucks = jsonClone(current.plan.trucks);
  blockedTrucks[0].loads[0].stops.push({
    id: "dp-history-driver-completed-drop",
    type: "drop",
    orderId: driverCompletedRef,
    location: "3445 Kennedy Road, Toronto, ON"
  });
  result = await command(current, target.id, lease, "dp-history-driver-completed-add", "replace_plan", {
    planDate,
    orders: [...current.plan.assignedOrderSnapshots, blockedOrder],
    trucks: blockedTrucks,
    summary: current.plan.summary,
    affectedOrderRefs: [driverCompletedRef],
    actionName: "drop_order_new_load"
  });
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.applied, false);
  assert.ok(
    result.payload.validationIssues?.some((issue) => issue.code === "DISPATCH_ORDER_DRIVER_COMPLETED"),
    "The server must reject a forged compact-board save for Driver PWA-completed work."
  );

  const blockedSalesOrder = {
    ...jsonClone(completedSalesOrder),
    id: driverCompletedSalesOrderRef,
    orderId: driverCompletedSalesOrderRef,
    refNumber: driverCompletedSalesOrderRef,
    netsuiteId: 991002002
  };
  const blockedSalesOrderTrucks = jsonClone(current.plan.trucks);
  blockedSalesOrderTrucks[0].loads[0].stops.push({
    id: "dp-history-driver-completed-sales-order-drop",
    type: "drop",
    orderId: driverCompletedSalesOrderRef,
    location: "55 History Road, Toronto, ON"
  });
  result = await command(current, target.id, lease, "dp-history-driver-completed-sales-order-add", "replace_plan", {
    planDate,
    orders: [...current.plan.assignedOrderSnapshots, blockedSalesOrder],
    trucks: blockedSalesOrderTrucks,
    summary: current.plan.summary,
    affectedOrderRefs: [driverCompletedSalesOrderRef],
    actionName: "drop_order_new_load"
  });
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.applied, false);
  assert.ok(
    result.payload.validationIssues?.some((issue) => issue.code === "DISPATCH_ORDER_DRIVER_COMPLETED"),
    "The server must reject a forged history save for a Driver PWA-completed SO."
  );

  const unprovenSalesOrder = {
    ...jsonClone(completedSalesOrder),
    id: unprovenInactiveSalesOrderRef,
    orderId: unprovenInactiveSalesOrderRef,
    refNumber: unprovenInactiveSalesOrderRef,
    netsuiteId: 991002003,
    historicalReconciliationComplete: true
  };
  const unprovenSalesOrderTrucks = jsonClone(current.plan.trucks);
  unprovenSalesOrderTrucks[0].loads[0].stops.push({
    id: "dp-history-unproven-sales-order-drop",
    type: "drop",
    orderId: unprovenInactiveSalesOrderRef,
    location: "55 History Road, Toronto, ON"
  });
  result = await command(current, target.id, lease, "dp-history-unproven-sales-order-add", "replace_plan", {
    planDate,
    orders: [...current.plan.assignedOrderSnapshots, unprovenSalesOrder],
    trucks: unprovenSalesOrderTrucks,
    summary: current.plan.summary,
    affectedOrderRefs: [unprovenInactiveSalesOrderRef],
    actionName: "drop_order_new_load"
  });
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.applied, false);
  assert.ok(
    result.payload.validationIssues?.some((issue) => issue.code === "DISPATCH_HISTORY_RECONCILIATION_REQUIRED"),
    "The server must reject a forged history save for an inactive SO without reconciliation proof."
  );

  const hardRefresh = await bootstrap(target.id, planDate);
  assert.equal(hardRefresh.plan.board.orderRefs.includes(allowedRef), true);
  assert.equal(hardRefresh.plan.board.orderRefs.includes(completedSalesOrderRef), true);
  assert.equal(hardRefresh.plan.board.orderRefs.includes(blanketRef), false);
  assert.equal(hardRefresh.plan.board.orderRefs.includes(driverCompletedRef), false);
  assert.equal(hardRefresh.plan.board.orderRefs.includes(driverCompletedSalesOrderRef), false);
  assert.equal(hardRefresh.plan.board.orderRefs.includes(unprovenInactiveSalesOrderRef), false);
});

test("DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries", async () => {
  const refs = Array.from({ length: 609 }, (_, index) => `DP-FEED-${index + 1}`);
  refs[0] = "DP-CO-SOURCE";
  const seeded = await fixture.seedPlan({ date: "2025-02-15", refs });
  const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-co-split" });
  let current = await bootstrap(seeded.id, seeded.plan_date);

  let result = await command(current, seeded.id, lease, "dp11-co", "upsert_co", {
    sourceOrderRef: "DP-CO-SOURCE", co: { refNumber: "DP-CO-1", customer: "Targeted Customer" }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.patch.sourceOrder.refNumber, "DP-CO-SOURCE");
  assert.equal(result.payload.patch.co.refNumber, "DP-CO-1");
  assert.ok(result.responseBytes < 250_000, "A one-order CO change must not return the 609-order feed.");
  current = result.payload;

  const splitBody = { sourceOrderRef: "DP-CO-SOURCE", parts: [{ quantity: 1 }, { quantity: 1 }] };
  result = await command(current, seeded.id, lease, "dp12-split", "split_order", splitBody);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.patch.split.sourceOrderRef, "DP-CO-SOURCE");
  assert.equal(result.payload.patch.split.parts.length, 2);
  const splitRefs = result.payload.patch.split.parts.map((part) => part.refNumber);
  assert.equal(new Set(splitRefs).size, 2);

  const replay = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId: "dp12-split",
      baseRevision: current.plan.revision,
      baseDigest: current.plan.digest,
      sessionId: "dispatch-v2-co-split",
      commandType: "split_order",
      payload: splitBody
    }
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("x-dispatch-idempotent-replay"), "true");
  assert.deepEqual(replay.payload.patch.split.parts.map((part) => part.refNumber), splitRefs);
});

test("DP-05/DP-16: the browser compact-board replacement uses the durable fast path and archives its predecessor", async () => {
  const seeded = await fixture.seedPlan({ date: "2025-02-20", refs: ["DP-REPLACE-A", "DP-REPLACE-B"] });
  const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-replace" });
  const current = await bootstrap(seeded.id, seeded.plan_date);
  const trucks = structuredClone(current.plan.trucks);
  trucks[0].loads[0].stops.reverse();
  const body = {
    commandId: "dp-replace-once",
    baseRevision: current.plan.revision,
    baseDigest: current.plan.digest,
    sessionId: "dispatch-v2-replace",
    commandType: "replace_plan",
    payload: {
      planDate: seeded.plan_date,
      orders: current.plan.assignedOrderSnapshots,
      trucks,
      summary: current.plan.summary,
      affectedOrderRefs: ["DP-REPLACE-A", "DP-REPLACE-B"],
      actionName: "group_order"
    }
  };

  const first = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.plan.revision, current.plan.revision + 1);
  assert.deepEqual(first.payload.plan.trucks, trucks);
  assert.ok(first.durationMs < 1_000, `replace_plan acknowledgement took ${first.durationMs}ms`);

  const persisted = await bootstrap(seeded.id, seeded.plan_date);
  assert.deepEqual(persisted.plan.trucks, trucks);
  const history = await query(
    "SELECT revision, archive_reason FROM dispatch_plan_snapshot_history WHERE plan_id = $1 ORDER BY id DESC LIMIT 1",
    [seeded.id]
  );
  assert.equal(Number(history.rows[0]?.revision), current.plan.revision);
  assert.equal(history.rows[0]?.archive_reason, "before_incremental_command");

  const replay = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("x-dispatch-idempotent-replay"), "true");
  assert.equal(replay.payload.plan.revision, first.payload.plan.revision);
});

test("DP-27: consecutive Custom Order saves accept the digest acknowledged before the jsonb reload", async () => {
  const custom = await createDispatchCustomOrder({
    refNumber: "DP-DATE-CUSTOM",
    pickupLocation: "3445",
    dropoffLocation: "27 Persistence Test Road",
    orderDetails: "Exercise database Date serialization",
    weightLbs: 1200,
    stopMinutes: 30
  }, "dispatch-v2-command-flow");
  const seeded = await fixture.seedPlan({ date: "2025-02-23", refs: [custom.refNumber] });
  const snapshot = dispatchOrderFromCustomOrder(custom);
  snapshot.localDispatchStatus = "planned";
  const trucks = [{
    plate: "DP-V2-TEST",
    id: "DP-V2-TEST",
    loads: [{
      id: "dp-v2-load-1",
      name: "Load 1",
      stops: [{
        id: "dp-v2-custom-drop",
        type: "drop",
        orderId: custom.refNumber,
        location: custom.dropoffLocation
      }]
    }]
  }];
  await query(
    "UPDATE dispatch_plan_snapshots SET orders = $2::jsonb, trucks = $3::jsonb, saved_at = now() WHERE plan_id = $1",
    [seeded.id, JSON.stringify([snapshot]), JSON.stringify(trucks)]
  );

  const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-date-digest" });
  let current = await bootstrap(seeded.id, seeded.plan_date);
  let result = await command(current, seeded.id, lease, "dp27-save-one", "replace_plan", {
    planDate: seeded.plan_date,
    orders: current.plan.assignedOrderSnapshots,
    trucks: current.plan.trucks,
    summary: { ...current.plan.summary, saveSequence: 1 },
    affectedOrderRefs: [custom.refNumber],
    actionName: "dispatch_plan_autosaved"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  current = result.payload;

  result = await command(current, seeded.id, lease, "dp27-save-two", "replace_plan", {
    planDate: seeded.plan_date,
    orders: current.plan.assignedOrderSnapshots,
    trucks: current.plan.trucks,
    summary: { ...current.plan.summary, saveSequence: 2 },
    affectedOrderRefs: [custom.refNumber],
    actionName: "dispatch_plan_undo"
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.plan.revision, current.plan.revision + 1);
  assert.equal(result.payload.plan.summary.saveSequence, 2);
});

test("DP-07: a rejected compact-board replacement is retained without changing the confirmed plan", async () => {
  await fixture.seedPlan({ date: "2025-02-21", refs: ["DP-REPLACE-FOREIGN"] });
  const target = await fixture.seedPlan({ date: "2025-02-22", refs: ["DP-REPLACE-TARGET"] });
  await query(
    "UPDATE dispatch_plans SET status = 'confirmed', confirmed_at = now(), revision = revision + 1 WHERE id = $1",
    [target.id]
  );
  const lease = await fixture.acquireLease({ planDate: target.plan_date, sessionId: "dispatch-v2-replace-conflict" });
  const current = await bootstrap(target.id, target.plan_date);
  const activeBefore = (await query(
    `SELECT p.status, p.revision::int AS revision, p.confirmed_at,
            s.orders, s.trucks, s.summary, s.saved_at, s.plan_digest
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [target.id]
  )).rows[0];
  const orders = [
    ...current.plan.assignedOrderSnapshots,
    { id: "DP-REPLACE-FOREIGN", type: "SO", items: [] }
  ];
  const trucks = structuredClone(current.plan.trucks);
  trucks[0].loads[0].stops.push({
    id: "dp-v2-foreign-stop",
    type: "delivery",
    orderId: "DP-REPLACE-FOREIGN",
    orderRefs: ["DP-REPLACE-FOREIGN"]
  });
  const result = await fixture.request(`/api/dispatch/v2/plans/${target.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId: "dp-replace-cross-date-block",
      baseRevision: current.plan.revision,
      baseDigest: current.plan.digest,
      sessionId: "dispatch-v2-replace-conflict",
      commandType: "replace_plan",
      payload: {
        planDate: target.plan_date,
        orders,
        trucks,
        summary: current.plan.summary,
        affectedOrderRefs: ["DP-REPLACE-FOREIGN"]
      }
    }
  });

  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
  assert.equal(result.payload.saved, true);
  assert.equal(result.payload.applied, false);
  assert.ok(result.payload.recoveryDraft?.id);
  assert.ok(
    (result.payload.validationIssues || []).some((issue) => issue.code === "DISPATCH_ORDER_ALREADY_PLANNED")
  );
  assert.equal(
    (await query("SELECT count(*)::int AS count FROM dispatch_plan_commands WHERE command_id = 'dp-replace-cross-date-block'")).rows[0].count,
    0
  );
  assert.deepEqual(
    jsonClone((await query(
      `SELECT p.status, p.revision::int AS revision, p.confirmed_at,
              s.orders, s.trucks, s.summary, s.saved_at, s.plan_digest
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1`,
      [target.id]
    )).rows[0]),
    jsonClone(activeBefore),
    "A rejected incremental save must not mutate the confirmed plan."
  );
  assert.equal(
    (await query(
      "SELECT archive_reason FROM dispatch_plan_snapshot_history WHERE id = $1",
      [result.payload.recoveryDraft.id]
    )).rows[0]?.archive_reason,
    "save_recovery"
  );
});
