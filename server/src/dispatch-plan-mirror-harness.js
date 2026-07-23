import assert from "node:assert/strict";
import { translateDriverOrientedDispatchPlan } from "./dispatch-plan-mirror.js";

const drivers = ["alpha", "bravo", "charlie"].map((login, index) => ({
  id: String(index + 1),
  login,
  name: login.toUpperCase(),
  license: "AZ",
  ownYardFixedMinutes: 40 + index,
  vendorFixedMinutes: 30 + index,
  deliveryFixedMinutes: 35 + index,
  minutesPerPallet: 1
}));
const fleet = ["ONE", "TWO", "THREE"].map((plate, index) => ({
  id: String(index + 10), plate, capacityLbs: 45000 + index, travelTimePercent: index
}));
const sourcePlan = {
  id: 112,
  revision: 17,
  planDate: "2026-07-22",
  status: "confirmed",
  orders: [{ id: "SO-1", type: "SO" }],
  summary: { driverLaneOrder: ["bravo", "alpha"], planned: 1 },
  trucks: [
    {
      id: "source-1", plate: "ONE", driverLogin: "alpha", base: "old-base", loads: [{
        id: "L1", name: "Load 1", driverLogin: "bravo", driverName: "BRAVO",
        truckId: "source-1", truckPlate: "ONE", switchYard: "12441", parkingSpot: "P1",
        stops: [{ id: "S1", type: "drop", orderId: "SO-1" }]
      }]
    },
    { id: "source-2", plate: "TWO", driverLogin: "bravo", loads: [] },
    { id: "source-3", plate: "THREE", driverLogin: "charlie", loads: [] }
  ]
};

const translated = translateDriverOrientedDispatchPlan({
  sourcePlan,
  destinationDrivers: drivers,
  destinationTrucks: fleet,
  targetDate: "2026-07-22"
});
assert.equal(translated.plan.trucks[0].id, "10");
assert.equal(translated.plan.trucks[0].driverLogin, "bravo");
assert.equal(translated.plan.trucks[0].base, "12441");
assert.equal(translated.plan.trucks[0].parkingSpot, "P1");
assert.equal(translated.plan.trucks[0].loads[0].truckId, "10");
assert.equal(translated.plan.trucks[0].loads[0].driverLogin, "bravo");
assert.equal(translated.plan.trucks[1].driverLogin, "alpha");
assert.equal(translated.plan.trucks[1].loads.length, 1);
assert.equal(translated.plan.trucks[2].driverLogin, "charlie");
assert.equal(new Set(translated.plan.trucks.map((truck) => truck.driverLogin)).size, 3);
assert.equal(translated.plan.summary.driverLaneOrder, undefined);
assert.equal(translated.plan.summary.mirrorTranslation.mode, "driver_loads_to_legacy_trucks");
assert.equal(translated.report.reassignedParentTruckCount, 1);
assert.equal(translated.report.inactiveScaffoldingTruckCount, 2);
assert.deepEqual(translated.report.driverMappings.map((row) => row.source), [
  "active_load", "legacy_scaffolding", "legacy_scaffolding"
]);

const timed = structuredClone(sourcePlan);
timed.trucks[0].loads[0].plannedStartMinute = 600;
timed.trucks[0].loads.push({
  id: "L0", name: "Earlier Load", driverLogin: "bravo", driverName: "BRAVO",
  truckId: "source-1", truckPlate: "ONE", switchYard: "12441", parkingSpot: "P1",
  plannedStartMinute: 480, driverSequence: 0, stops: [{ id: "S0", type: "drop", orderId: "SO-1" }]
});
const timedTranslation = translateDriverOrientedDispatchPlan({
  sourcePlan: timed,
  destinationDrivers: drivers,
  destinationTrucks: fleet,
  targetDate: "2026-07-22"
});
assert.deepEqual(timedTranslation.plan.trucks[0].loads.map((load) => load.id), ["L0", "L1"]);
assert.deepEqual(timedTranslation.plan.trucks[0].loads.map((load) => load.start), ["08:00", "10:00"]);
assert.equal(timedTranslation.report.reorderedLoadCount, 2);
assert.equal(timedTranslation.report.materializedLoadStartCount, 2);

const ambiguous = structuredClone(sourcePlan);
ambiguous.trucks[0].loads.push({
  id: "L2", driverLogin: "alpha", truckPlate: "ONE",
  stops: [{ id: "S2", type: "drop", orderId: "SO-1" }]
});
assert.throws(() => translateDriverOrientedDispatchPlan({
  sourcePlan: ambiguous,
  destinationDrivers: drivers,
  destinationTrucks: fleet,
  targetDate: "2026-07-22"
}), /multiple active load drivers/);

console.log(JSON.stringify({ ok: true, tests: 20, report: translated.report }));
