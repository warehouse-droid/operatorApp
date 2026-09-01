// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import {
  createDispatchPlan,
  getDispatchPlanRevision,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";
import { cancelLocalCoOrder, listDispatchOrders, upsertLocalCoOrder } from "../../../src/dispatch-repository.js";
import { query } from "../../../src/db.js";
import {
  enrichDispatchOrdersWithDependencies,
  listOrderDependencies
} from "../../../src/order-dependency-repository.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;
const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
const dateYear = 2200 + (Number.parseInt(suffix.slice(0, 4), 16) % 500);

function testDate(day) {
  return `${dateYear}-01-${String(day).padStart(2, "0")}`;
}

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

function coOrder(coRef, sourceRef, { fromYard = "2967", toYard = "150" } = {}) {
  return {
    id: coRef,
    type: "CO",
    sourceTable: "local_co_orders",
    sourceOrderId: sourceRef,
    sourceYard: fromYard,
    destinationYard: toYard,
    pickupLocations: [fromYard],
    address: toYard,
    planOwned: true,
    testOnly: true
  };
}

function coTrucks(coRef) {
  return [{
    id: "CO-GLOBAL-TRUCK",
    plate: "CO-GLOBAL-TRUCK",
    loads: [{
      id: "co-global-load",
      name: "Global CO Load",
      stops: [
        { id: "co-global-pick", type: "pick", orderId: coRef, location: "2967" },
        { id: "co-global-drop", type: "drop", orderId: coRef, location: "150" }
      ]
    }]
  }];
}

async function seedPlan({ date, orders = [], trucks = [], status = "confirmed" }) {
  const plan = await createDispatchPlan({ planDate: date, note: "global CO lifecycle regression" });
  await query("UPDATE dispatch_plans SET status = $2 WHERE id = $1", [plan.id, status]);
  await query(
    `UPDATE dispatch_plan_snapshots
        SET orders = $2::jsonb, trucks = $3::jsonb, saved_at = now()
      WHERE plan_id = $1`,
    [plan.id, JSON.stringify(orders), JSON.stringify(trucks)]
  );
  return { id: String(plan.id), planDate: date };
}

async function seedLocalCo({ coRef, sourceRef, plan = null, status = "pending_load", toYard = "150" }) {
  const inserted = await query(
    `INSERT INTO local_co_orders (
       co_ref, source_order_ref, from_location_id, from_location,
       to_location_id, to_location, status,
       dispatch_plan_id, dispatch_plan_date, dispatch_truck_plate,
       dispatch_load_name, details
     ) VALUES ($1, $2, 28, '2967', $3, $4, $5, $6, $7::date, $8, $9, $10::jsonb)
     RETURNING id::text AS id`,
    [
      coRef,
      sourceRef,
      toYard === "150" ? 26 : 15,
      toYard,
      status,
      plan?.id || null,
      plan?.planDate || null,
      plan ? "CO-GLOBAL-TRUCK" : "",
      plan ? "Global CO Load" : "",
      JSON.stringify({ testOnly: true })
    ]
  );
  return inserted.rows[0].id;
}

async function coJson(coRef) {
  const result = await query("SELECT to_jsonb(co) AS value FROM local_co_orders co WHERE co_ref = $1", [coRef]);
  return result.rows[0]?.value;
}

test("the lightweight plan fence includes the persisted snapshot digest", async () => {
  const plan = await createDispatchPlan({
    planDate: testDate(21),
    note: "dependency fence digest regression"
  });
  const fence = await getDispatchPlanRevision(plan.id);
  const persisted = (await query(
    "SELECT plan_digest FROM dispatch_plan_snapshots WHERE plan_id = $1",
    [plan.id]
  )).rows[0]?.plan_digest;

  assert.equal(fence?.id, String(plan.id));
  assert.equal(fence?.digest, persisted);
  assert.match(fence?.digest || "", /^[0-9a-f]{64}$/u);
});

test("a CO planned on another date cannot be cancelled and reports its owning route", async () => {
  const sourceRef = `GOA-GLOBAL-${suffix}-1`;
  const coRef = `CO-${sourceRef}`;
  const owner = await seedPlan({
    date: testDate(10),
    orders: [coOrder(coRef, sourceRef)],
    trucks: coTrucks(coRef)
  });
  await seedLocalCo({ coRef, sourceRef, plan: owner });
  const viewingPlan = await seedPlan({ date: testDate(11) });
  const lease = await fixture.acquireLease({ planDate: viewingPlan.planDate, sessionId: `co-global-${suffix}-1` });
  const beforeRow = await coJson(coRef);

  const result = await fixture.request(
    `/api/dispatch/co-orders/${encodeURIComponent(coRef)}?sessionId=co-global-${suffix}-1&planDate=${viewingPlan.planDate}&editLeaseToken=${encodeURIComponent(lease)}&response=targeted`,
    { method: "DELETE" }
  );

  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_CO_ALREADY_PLANNED");
  assert.deepEqual(result.payload.conflicts, [{
    planId: owner.id,
    planDate: owner.planDate,
    status: "confirmed",
    truckId: "CO-GLOBAL-TRUCK",
    truckPlate: "CO-GLOBAL-TRUCK",
    loadId: "co-global-load",
    loadName: "Global CO Load",
    source: "snapshot"
  }]);
  assert.deepEqual(await coJson(coRef), beforeRow, "a rejected cancellation must not touch timestamps or details");
});

test("assignment metadata blocks cancellation when a snapshot projection is stale", async () => {
  const sourceRef = `GOA-GLOBAL-${suffix}-2`;
  const coRef = `CO-${sourceRef}`;
  const owner = await seedPlan({ date: testDate(12), orders: [], trucks: [] });
  await seedLocalCo({ coRef, sourceRef, plan: owner });
  const beforeRow = await coJson(coRef);
  const viewingPlan = await seedPlan({ date: testDate(13) });
  const lease = await fixture.acquireLease({ planDate: viewingPlan.planDate, sessionId: `co-global-${suffix}-2` });

  const result = await fixture.request(
    `/api/dispatch/co-orders/${encodeURIComponent(coRef)}?sessionId=co-global-${suffix}-2&planDate=${viewingPlan.planDate}&editLeaseToken=${encodeURIComponent(lease)}`,
    { method: "DELETE" }
  );

  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_CO_ALREADY_PLANNED");
  assert.equal(result.payload.conflicts?.[0]?.source, "assignment");
  assert.equal(result.payload.conflicts?.[0]?.planDate, owner.planDate);
  assert.deepEqual(await coJson(coRef), beforeRow);
});

test("today bootstrap rehydrates an active CO owned by a different date onto its grouped source", async () => {
  const sourceRef = `GOA-GLOBAL-${suffix}-3`;
  const childRefs = [`SOA-${suffix}-31`, `SOA-${suffix}-32`];
  const coRef = `CO-${sourceRef}`;
  const owner = await seedPlan({
    date: testDate(14),
    orders: [coOrder(coRef, sourceRef)],
    trucks: coTrucks(coRef)
  });
  await seedLocalCo({ coRef, sourceRef, plan: owner });
  const grouped = {
    id: sourceRef,
    type: "SO",
    childOrders: childRefs,
    childOrderDetails: childRefs.map((id) => ({ id, type: "SO", pickupLocations: ["2967"], sourceYard: "2967" })),
    pickupLocations: ["2967"],
    sourceYard: "2967",
    planOwned: true,
    testOnly: true
  };
  const today = await seedPlan({
    date: testDate(15),
    orders: [grouped],
    trucks: [{ id: "TODAY", plate: "TODAY", loads: [{
      id: "today-load",
      name: "Today Load",
      stops: [{ id: "today-drop", type: "drop", orderId: sourceRef, location: "Test Customer" }]
    }] }]
  });

  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${today.id}&date=${today.planDate}`);

  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  const hydrated = bootstrap.payload.plan?.assignedOrderSnapshots?.find((order) => order.id === sourceRef);
  assert.ok(hydrated);
  assert.deepEqual(hydrated.transitCo, {
    id: coRef,
    fromYard: "2967",
    toYard: "150",
    sourceOrderId: sourceRef
  });
  assert.deepEqual(hydrated.transitOriginalPickupLocations, ["2967"]);
  assert.equal(hydrated.transitOriginalSourceYard, "2967");
  assert.deepEqual(hydrated.pickupLocations, ["150"]);
  assert.equal(hydrated.sourceYard, "150");
  assert.ok(hydrated.childOrderDetails.every((child) => child.transitCo?.id === coRef));
});

test("a CO referenced only by a cancelled plan can still be cancelled", async () => {
  const sourceRef = `GOA-GLOBAL-${suffix}-4`;
  const coRef = `CO-${sourceRef}`;
  const cancelledPlan = await seedPlan({
    date: testDate(16),
    orders: [coOrder(coRef, sourceRef)],
    trucks: coTrucks(coRef),
    status: "cancelled"
  });
  await seedLocalCo({ coRef, sourceRef, plan: cancelledPlan });
  const viewingPlan = await seedPlan({ date: testDate(17) });
  const lease = await fixture.acquireLease({ planDate: viewingPlan.planDate, sessionId: `co-global-${suffix}-4` });

  const result = await fixture.request(
    `/api/dispatch/co-orders/${encodeURIComponent(coRef)}?sessionId=co-global-${suffix}-4&planDate=${viewingPlan.planDate}&editLeaseToken=${encodeURIComponent(lease)}`,
    { method: "DELETE" }
  );

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal((await coJson(coRef))?.status, "cancelled");
});

test("an active TO transit CO redirects its direct dependency and cancellation restores the original source", async () => {
  const numericSeed = Number.parseInt(suffix, 16);
  const salesOrderId = 6_000_000_000 + (numericSeed * 2);
  const transferOrderId = salesOrderId + 1;
  const salesOrderRef = `SOA-CO-DEPENDENCY-${suffix}`;
  const transferOrderRef = `TOA-CO-DEPENDENCY-${suffix}`;
  const coRef = `CO-${transferOrderRef}`;

  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, operator_status,
       local_yard_order_status, fulfillment_status, netsuite_active, is_test_fixture
     ) VALUES (
       $1, $2, current_date, 'CO dependency routing fixture', 'B', 'Pending Fulfillment',
       15, '12441', 'open', 'Open', 'not_fulfilled', true, true
     )`,
    [salesOrderId, salesOrderRef]
  );
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, trandate, status, status_text,
       from_location_id, from_location, to_location_id, to_location,
       outbound_operator_status, local_yard_order_status, fulfillment_status,
       dispatch_planned, netsuite_active
     ) VALUES (
       $1, $2, current_date, 'B', 'Pending Fulfillment',
       28, '2967', 15, '12441',
       'open', 'Open', 'not_fulfilled', false, true
     )`,
    [transferOrderId, transferOrderRef]
  );
  await query(
    `INSERT INTO order_dependencies (
       sales_order_id, sales_order_ref, dispatch_target_ref, dispatch_target_kind,
       transfer_order_id, transfer_order_ref, dependency_mode, same_load_required,
       status, source_location_id, source_location,
       accounting_destination_location_id, accounting_destination_location,
       reconciliation_status
     ) VALUES (
       $1, $2, $2, 'normal', $3, $4, 'direct_to_customer', true,
       'active', 28, '2967', 15, '12441', 'pending'
     )`,
    [salesOrderId, salesOrderRef, transferOrderId, transferOrderRef]
  );
  await seedLocalCo({ coRef, sourceRef: transferOrderRef, toYard: "150" });

  const activeDependencies = await listOrderDependencies({ salesOrderRef });
  assert.equal(activeDependencies.length, 1);
  assert.equal(activeDependencies[0].sourceLocation, "150");
  assert.equal(activeDependencies[0].dependencySourceLocation, "2967");
  assert.equal(activeDependencies[0].transitCoRef, coRef);

  const [activeOrder] = await enrichDispatchOrdersWithDependencies([{
    id: salesOrderRef,
    type: "SO",
    sourceYard: "12441",
    pickupLocations: ["12441"],
    items: []
  }]);
  assert.equal(activeOrder.directPickupManifest[0].location, "150");
  assert.deepEqual(activeOrder.pickupLocations, ["12441", "150"]);

  const cancelled = await cancelLocalCoOrder(coRef, { requestedBy: `co-dependency-${suffix}` });
  assert.equal(cancelled?.status, "cancelled");

  const cancelledDependencies = await listOrderDependencies({ salesOrderRef });
  assert.equal(cancelledDependencies[0].sourceLocation, "2967");
  assert.equal(cancelledDependencies[0].dependencySourceLocation, "2967");
  assert.equal(cancelledDependencies[0].transitCoRef, "");

  const [cancelledOrder] = await enrichDispatchOrdersWithDependencies([{
    id: salesOrderRef,
    type: "SO",
    sourceYard: "12441",
    pickupLocations: ["12441"],
    items: []
  }]);
  assert.equal(cancelledOrder.directPickupManifest[0].location, "2967");
  assert.deepEqual(cancelledOrder.pickupLocations, ["12441", "2967"]);
});

test("the global TO feed exposes the CO depot as both pickupLocations and sourceYard", async () => {
  const numericSeed = Number.parseInt(suffix, 16);
  const transferOrderId = 7_000_000_000_000 + numericSeed;
  const transferOrderRef = `TOA-GLOBAL-PICKUP-${suffix}`;
  const coRef = `CO-${transferOrderRef}`;
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, trandate, status, status_text,
       from_location_id, from_location, to_location_id, to_location,
       outbound_operator_status, local_yard_order_status, fulfillment_status,
       dispatch_planned, netsuite_active
     ) VALUES (
       $1, $2, current_date, 'B', 'Transfer Order : Pending Fulfillment',
       28, '2967', 26, '150',
       'open', 'Open', 'not_fulfilled', false, true
     )`,
    [transferOrderId, transferOrderRef]
  );
  await query(
    `INSERT INTO transfer_order_lines (
       line_stage, transfer_order_id, line_id, item_id, item_name, sku,
       quantity, unit, location_id, location, pallet_qty, to_plt,
       netsuite_active, raw
     ) VALUES (
       'outbound', $1, $2, $3, 'Global CO pickup item', $4,
       10, 'EA', 28, '2967', 1, 10, true, '{}'::jsonb
     )`,
    [transferOrderId, transferOrderId + 1, transferOrderId + 2, `GLOBAL-CO-${suffix}`]
  );
  await upsertLocalCoOrder({
    sourceOrderRef: transferOrderRef,
    fromYard: "2967",
    toYard: "12441",
    order: {
      id: coRef,
      type: "CO",
      sourceOrderType: "TO",
      sourceYard: "2967",
      destinationYard: "12441",
      pickupLocations: ["2967"],
      items: [{
        lineId: transferOrderId + 1,
        itemId: transferOrderId + 2,
        sku: `GLOBAL-CO-${suffix}`,
        quantity: 10,
        pallets: 1,
        toPlt: 10
      }]
    },
    requestedBy: `global-pickup-${suffix}`,
    reactivateCancelled: true
  });

  const feed = await listDispatchOrders({
    search: transferOrderRef,
    exactOrderRefs: [transferOrderRef]
  });
  const source = feed.find((order) => order.id === transferOrderRef);
  const co = feed.find((order) => order.id === coRef);
  assert.ok(source, "the source TO must remain globally addressable");
  assert.equal(source.sourceYard, "12441");
  assert.deepEqual(source.pickupLocations, ["12441"]);
  assert.equal(source.transitOriginalSourceYard, "2967");
  assert.equal(source.transitCo?.id, coRef);
  assert.ok(co, "the CO must be returned by an exact source-order lookup");
  assert.equal(co.sourceOrderId, transferOrderRef);
  assert.equal(co.sourceOrderType, "TO");
});

test("concurrent plan ownership and cancellation cannot commit a planned cancelled CO", async () => {
  const sourceRef = `GOA-GLOBAL-${suffix}-RACE`;
  const coRef = `CO-${sourceRef}`;
  await seedLocalCo({ coRef, sourceRef });
  const plan = await seedPlan({ date: testDate(18), status: "draft" });
  const revision = Number((await query("SELECT revision FROM dispatch_plans WHERE id = $1", [plan.id])).rows[0].revision);

  const [saveResult, cancelResult] = await Promise.allSettled([
    saveDispatchPlanSnapshot(plan.id, {
      planDate: plan.planDate,
      baseRevision: revision,
      orders: [coOrder(coRef, sourceRef)],
      trucks: coTrucks(coRef).map((truck) => ({ ...truck, id: "", plate: "" })),
      summary: {},
      sessionId: `co-global-${suffix}-race-save`
    }),
    cancelLocalCoOrder(coRef, { requestedBy: `co-global-${suffix}-race-cancel` })
  ]);

  assert.equal([saveResult, cancelResult].filter((result) => result.status === "fulfilled").length, 1);
  const finalCo = await coJson(coRef);
  const snapshot = (await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1", [plan.id])).rows[0];
  const planned = JSON.stringify(snapshot?.trucks || []).includes(coRef);
  assert.equal(planned && finalCo?.status === "cancelled", false);
  if (planned) {
    assert.notEqual(finalCo?.status, "cancelled");
    assert.equal(cancelResult.status, "rejected");
    assert.equal(cancelResult.reason?.code, "DISPATCH_CO_ALREADY_PLANNED");
  } else {
    assert.equal(finalCo?.status, "cancelled");
    assert.equal(saveResult.status, "rejected");
    assert.equal(saveResult.reason?.code, "DISPATCH_CO_NOT_ACTIVE");
  }
});

test("a cancelled CO is scrubbed from a stale save without blocking unrelated planning", async () => {
  const sourceRef = `SOA-GLOBAL-${suffix}-STALE`;
  const unrelatedRef = `SOA-GLOBAL-${suffix}-UNRELATED`;
  const coRef = `CO-${sourceRef}`;
  await seedLocalCo({ coRef, sourceRef, status: "cancelled" });
  const plan = await seedPlan({ date: testDate(19), status: "draft" });
  const revision = Number((await query(
    "SELECT revision FROM dispatch_plans WHERE id = $1",
    [plan.id]
  )).rows[0].revision);

  await saveDispatchPlanSnapshot(plan.id, {
    planDate: plan.planDate,
    baseRevision: revision,
    orders: [
      {
        id: sourceRef,
        type: "SO",
        pickupLocations: ["150"],
        sourceYard: "150",
        transitCo: { id: coRef, fromYard: "2967", toYard: "150" },
        transitOriginalPickupLocations: ["2967"],
        transitOriginalSourceYard: "2967"
      },
      coOrder(coRef, sourceRef),
      { id: unrelatedRef, type: "SO", pickupLocations: ["12441"], sourceYard: "12441" }
    ],
    trucks: [{
      id: "",
      plate: "",
      loads: [{
        id: "stale-co-and-unrelated",
        name: "Stale CO and unrelated work",
        stops: [
          { id: "stale-co-pick", type: "pick", orderId: coRef, location: "2967" },
          { id: "stale-co-drop", type: "drop", orderId: coRef, location: "150" },
          { id: "unrelated-drop", type: "drop", orderId: unrelatedRef, location: "Customer" }
        ]
      }]
    }],
    summary: {},
    sessionId: `co-global-${suffix}-stale-save`
  });

  const saved = (await query(
    "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
    [plan.id]
  )).rows[0];
  const savedText = JSON.stringify(saved);
  assert.doesNotMatch(savedText, new RegExp(coRef),
    "cancelled CO cards, metadata, and physical stops must be removed atomically");
  assert.match(savedText, new RegExp(unrelatedRef),
    "an unrelated plan edit must still commit when stale CO state is auto-reconciled");
  const restoredSource = saved.orders.find((order) => order.id === sourceRef);
  assert.equal(restoredSource?.transitCo ?? null, null);
});

test("a mixed CO group drops only its cancelled child and still protects its active child", async () => {
  const cancelledSource = `SOA-GLOBAL-${suffix}-GROUP-CANCELLED`;
  const activeSource = `SOA-GLOBAL-${suffix}-GROUP-ACTIVE`;
  const cancelledRef = `CO-${cancelledSource}`;
  const activeRef = `CO-${activeSource}`;
  const groupRef = `GOA-GLOBAL-${suffix}-CO-GROUP`;
  const truckPlate = `CO-GROUP-${suffix}`;
  await seedLocalCo({ coRef: cancelledRef, sourceRef: cancelledSource, status: "cancelled" });
  await seedLocalCo({ coRef: activeRef, sourceRef: activeSource });
  await query("INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true)", [truckPlate]);
  const plan = await seedPlan({ date: testDate(20), status: "draft" });
  const revision = Number((await query(
    "SELECT revision FROM dispatch_plans WHERE id = $1",
    [plan.id]
  )).rows[0].revision);

  await saveDispatchPlanSnapshot(plan.id, {
    planDate: plan.planDate,
    baseRevision: revision,
    orders: [{
      ...coOrder(groupRef, cancelledSource),
      id: groupRef,
      sourceOrderId: cancelledSource,
      relatedSoId: cancelledSource,
      childOrders: [cancelledRef, activeRef],
      childOrderDetails: [
        { ...coOrder(cancelledRef, cancelledSource), pallets: 1, weight: 100 },
        { ...coOrder(activeRef, activeSource), pallets: 2, weight: 200 }
      ],
      pallets: 3,
      weight: 300
    }],
    trucks: [{
      id: truckPlate,
      plate: truckPlate,
      loads: [{
        id: "co-group-load",
        name: "CO group load",
        stops: [{
          id: "co-group-stop",
          type: "pick",
          orderId: groupRef,
          groupedOrderRefs: [cancelledRef, activeRef],
          location: "2967"
        }]
      }]
    }],
    summary: {},
    sessionId: `co-global-${suffix}-group-save`
  });

  const saved = (await query(
    "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
    [plan.id]
  )).rows[0];
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(cancelledRef));
  assert.match(JSON.stringify(saved), new RegExp(activeRef));
  const group = saved.orders.find((order) => order.id === groupRef);
  assert.deepEqual(group?.childOrders, [activeRef]);
  assert.equal(group?.pallets, 2);
  assert.equal(group?.weight, 200);
  assert.equal(group?.sourceOrderId || "", "");
  assert.deepEqual(saved.trucks[0].loads[0].stops[0].groupedOrderRefs, [activeRef]);

  const groupOnlyTrucks = structuredClone(saved.trucks);
  delete groupOnlyTrucks[0].loads[0].stops[0].groupedOrderRefs;
  await query(
    "UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb WHERE plan_id = $1",
    [plan.id, JSON.stringify(groupOnlyTrucks)]
  );

  await query(
    `UPDATE local_co_orders
        SET dispatch_plan_id = NULL,
            dispatch_plan_date = NULL,
            dispatch_truck_plate = NULL,
            dispatch_load_name = NULL
      WHERE co_ref = $1`,
    [activeRef]
  );

  await assert.rejects(
    cancelLocalCoOrder(activeRef, { requestedBy: `co-global-${suffix}-group-cancel` }),
    (error) => error?.code === "DISPATCH_CO_ALREADY_PLANNED"
  );
});

test("a stale client cannot implicitly reactivate a cancelled CO", async () => {
  const sourceRef = `SOA-GLOBAL-${suffix}-RECREATE`;
  const coRef = `CO-${sourceRef}`;
  await seedLocalCo({ coRef, sourceRef, status: "cancelled" });

  await assert.rejects(
    upsertLocalCoOrder({
      sourceOrderRef: sourceRef,
      fromYard: "2967",
      toYard: "150",
      order: { id: coRef, type: "CO", sourceOrderId: sourceRef, items: [] },
      requestedBy: `co-global-${suffix}-stale-client`
    }),
    (error) => error?.code === "DISPATCH_CO_CANCELLED"
  );
  assert.equal((await coJson(coRef))?.status, "cancelled");

  const recreated = await upsertLocalCoOrder({
    sourceOrderRef: sourceRef,
    fromYard: "2967",
    toYard: "150",
    order: { id: coRef, type: "CO", sourceOrderId: sourceRef, items: [] },
    requestedBy: `co-global-${suffix}-explicit-recreate`,
    reactivateCancelled: true
  });
  assert.equal(recreated.status, "pending_load");
});
