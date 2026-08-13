// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { cancelLocalCoOrder } from "../../../src/dispatch-repository.js";
import { query } from "../../../src/db.js";
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
