import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  confirmDispatchPlan,
  createDispatchPlan,
  getCurrentDispatchPlan,
  getDispatchPlan,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";
import { applyDispatchV2Command, getDispatchV2Bootstrap } from "../../../src/dispatch-planner-v2-repository.js";
import { mapFrontend, mapPins, roadPath } from "../../support/google-map-redraw-fixture.mjs";

after(closeDb);

function googleFixture(suffix = "first") {
  return {
    source: "google_routes_v2",
    routeEstimateId: `google-id-${suffix}`,
    routeSignature: `google-route-${suffix}`,
    rawLegMinutes: [25, 25],
    legMinutes: [30, 30],
    rawDriveMinutes: 50,
    driveMinutes: 60,
    stayMinutes: 15,
    totalMinutes: 75,
    allowTolls: false,
    travelTimePercent: 20,
    routePath: structuredClone(roadPath),
    stopCoordinates: structuredClone(mapPins),
    asOf: "2026-09-30T18:00:00.000Z",
    googleAttempted: true
  };
}

function serializeEstimate(load, estimate, { viaCache = false } = {}) {
  let current = estimate;
  const api = mapFrontend([
    "serializableRouteEstimateForLoad", "routeEstimateMatchesMeta", "routeEstimateHasCompleteGoogleLegs", "cacheRouteEstimate"
  ], {
    estimateForLoad: () => current,
    mapStopsForLoad: () => load.stops,
    routeEstimateMeta: () => ({ id: "google-id-first", signature: "google-route-first" }),
    samePhysicalRouteStop: () => false,
    persistedRouteEstimateCache: {}, savePersistedRouteEstimateCache() {}
  });
  if (viaCache) current = api.cacheRouteEstimate({}, load, load.stops, estimate).estimate;
  return api.serializableRouteEstimateForLoad({}, load);
}

async function isolated(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(run);
  } finally {
    await rollback.rollback();
  }
}

async function seedRoutePlan() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const plan = await createDispatchPlan({ planDate: "2099-10-01", note: "Google route persistence fixture" });
  const truck = (await query(
    "INSERT INTO dispatch_trucks (plate, active) VALUES ($1, true) RETURNING id::text, plate",
    [`GM-${suffix}`]
  )).rows[0];
  const driver = (await query(
    "INSERT INTO dispatch_drivers (name, login, active) VALUES ($1, $2, true) RETURNING name, login",
    [`Google fixture ${suffix}`, `google-${suffix}`]
  )).rows[0];
  const orders = mapPins.map((_pin, index) => ({
    id: `SO-GOOGLE-${suffix}-${index}`, type: "SO", address: `${index + 1} Isolated Google Test Road`,
    items: [{ sku: "Delivery Charge", itemType: "OthCharge", quantity: 1 }], testOnly: true
  }));
  const load = {
    id: `google-load-${suffix}`, name: "Google fixture load", driverLogin: driver.login,
    driverName: driver.name, truckId: truck.id, truckPlate: truck.plate,
    pickupVisitSchemaVersion: 1, plannedStartMinute: 480, plannedFinishMinute: 555,
    stops: orders.map((order, index) => ({
      id: `google-stop-${suffix}-${index}`, type: "drop", orderId: order.id,
      orderRefs: [order.id], location: order.address,
      timing: { arrival: 480 + index * 35, depart: 485 + index * 35 }
    }))
  };
  return { plan, orders, truck, load };
}

function findEstimate(plan, loadId) {
  return plan.trucks.flatMap((truck) => truck.loads || []).find((load) => load.id === loadId)?.routeEstimate;
}

async function storedEstimate(planId, loadId) {
  const row = (await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id = $1", [planId])).rows[0];
  return findEstimate(row, loadId);
}

test("Google timings, road geometry and stop positions survive save, compact update, confirmation and date reload", async () => {
  await isolated(async () => {
    const { plan, orders, truck, load } = await seedRoutePlan();
    const first = serializeEstimate(load, googleFixture());
    assert.deepEqual(first.routePath, roadPath);
    assert.deepEqual(first.stopCoordinates, mapPins);
    const saved = await saveDispatchPlanSnapshot(plan.id, {
      planDate: plan.planDate, baseRevision: plan.revision, orders,
      trucks: [{ ...truck, loads: [{ ...load, routeEstimate: first }] }], summary: {}
    });
    assert.deepEqual(await storedEstimate(plan.id, load.id), first);
    assert.deepEqual(findEstimate(await getDispatchPlan(plan.id), load.id), first);
    assert.deepEqual(findEstimate((await getDispatchV2Bootstrap({ planId: plan.id })).plan, load.id), first);

    // A real compact planner update must retain a newly refreshed estimate in
    // the canonical snapshot, not just in its command acknowledgement.
    const refreshed = {
      ...first, asOf: "2026-09-30T18:05:00.000Z",
      routePath: [mapPins[0], { lat: 43.36, lng: -80.39 }, ...roadPath.slice(1)]
    };
    const updatedTrucks = saved.trucks.map((parent) => ({
      ...parent, loads: parent.loads.map((entry) => entry.id === load.id ? { ...entry, routeEstimate: refreshed } : entry)
    }));
    const { payload } = await applyDispatchV2Command({
      planId: plan.id,
      command: {
        commandId: crypto.randomUUID(), commandType: "update_load", compactReceipt: true,
        baseRevision: saved.revision, baseDigest: saved.digest,
        payload: { planDelta: { t: updatedTrucks } }
      }
    });
    assert.ok(payload.acknowledgement || payload.plan);
    assert.deepEqual(await storedEstimate(plan.id, load.id), refreshed);
    await assert.rejects(saveDispatchPlanSnapshot(plan.id, {
      planDate: plan.planDate, baseRevision: saved.revision, orders,
      trucks: saved.trucks, summary: saved.summary
    }), (error) => error.code === "STALE_DISPATCH_PLAN");
    assert.deepEqual(await storedEstimate(plan.id, load.id), refreshed,
      "an older save must not overwrite the latest Google geometry or provider timestamp");
    const confirmed = await confirmDispatchPlan(plan.id);
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(findEstimate(confirmed, load.id), refreshed);
    assert.deepEqual(await storedEstimate(plan.id, load.id), refreshed);
    assert.deepEqual(findEstimate(await getCurrentDispatchPlan({ planDate: plan.planDate }), load.id), refreshed);
    assert.deepEqual(findEstimate((await getDispatchV2Bootstrap({ planId: plan.id })).plan, load.id), refreshed);
  });
});

test("the saved Google estimate records its provider timestamp so a reload can identify the latest result", async () => {
  for (const viaCache of [false, true]) {
    await isolated(async () => {
      const { plan, orders, truck, load } = await seedRoutePlan();
      const fixture = googleFixture();
      const serialized = serializeEstimate(load, fixture, { viaCache });
      await saveDispatchPlanSnapshot(plan.id, {
        planDate: plan.planDate, baseRevision: plan.revision, orders,
        trucks: [{ ...truck, loads: [{ ...load, routeEstimate: serialized }] }], summary: {}
      });
      assert.equal((await storedEstimate(plan.id, load.id)).asOf, fixture.asOf);
      assert.equal(findEstimate(await getDispatchPlan(plan.id), load.id).asOf, fixture.asOf);
    });
  }
});

test("a Google result for an older route cannot enter the saved route metadata", () => {
  const load = { id: "stale-google-load", stops: mapPins.map((_pin, index) => ({ id: String(index) })) };
  assert.equal(serializeEstimate(load, googleFixture("stale")), null);
  assert.equal(serializeEstimate(load, { ...googleFixture(), source: "fallback" }), null);
  assert.equal(serializeEstimate(load, { ...googleFixture(), legMinutes: [30] }), null);
});
