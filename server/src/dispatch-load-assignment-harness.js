import assert from "node:assert/strict";
import {
  changedLockedLoadAssignments,
  dispatchOwnYardCodes,
  driverLoadLanes,
  normalizeDispatchPlanLoadAssignments,
  validateDispatchLoadAssignments
} from "./dispatch-load-assignment.js";

function load(id, overrides = {}) {
  return {
    id,
    name: id,
    stops: [{ id: `${id}-P`, type: "pick", location: "12441" }],
    ...overrides
  };
}

function truck(id, plate, driverLogin, loads) {
  return { id, plate, driverLogin, driver: driverLogin, base: "12441", loads };
}

const legacy = normalizeDispatchPlanLoadAssignments({
  id: 1,
  planDate: "2026-07-17",
  trucks: [truck("T1", "AA100", "alex", [load("L1", { timing: { start: 420, finish: 480 } })])]
});
assert.equal(legacy.trucks[0].loads[0].driverLogin, "alex");
assert.equal(legacy.trucks[0].loads[0].truckPlate, "AA100");

const legacyNameOnly = normalizeDispatchPlanLoadAssignments({
  id: 11,
  planDate: "2026-07-17",
  trucks: [{ id: "T1", plate: "AA100", driver: "Alex", base: "12441", loads: [load("L1")] }]
});
assert.equal(legacyNameOnly.trucks[0].loads[0].driverLogin, "alex");

const legacyUnassigned = normalizeDispatchPlanLoadAssignments({
  id: 12,
  planDate: "2026-07-17",
  trucks: [{ id: "T1", plate: "AA100", driver: "Unassigned", base: "12441", loads: [load("L1")] }]
});
assert.equal(legacyUnassigned.trucks[0].loads[0].driverLogin, "");

const switchPlan = normalizeDispatchPlanLoadAssignments({
  id: 2,
  planDate: "2026-07-17",
  trucks: [
    truck("T1", "AA100", "alex", [load("L1", {
      returnOnly: true,
      returnYard: "12441",
      timing: { start: 420, finish: 480 },
      driverSequence: 0
    })]),
    truck("T2", "BB200", "jenny", [load("L2", {
      driverLogin: "alex",
      driverName: "Alex",
      switchYard: "12441",
      timing: { start: 490, finish: 550 },
      driverSequence: 1
    })])
  ]
});
assert.deepEqual(validateDispatchLoadAssignments(switchPlan, { switchMinutes: 10, requireAssignments: true }), []);
assert.equal(driverLoadLanes(switchPlan).find((lane) => lane.driverLogin === "alex").loads.length, 2);

const tooFast = structuredClone(switchPlan);
tooFast.trucks[1].loads[0].timing.start = 489;
tooFast.trucks[1].loads[0].plannedStartMinute = 489;
assert.ok(validateDispatchLoadAssignments(tooFast, { switchMinutes: 10 }).some((item) => item.code === "DISPATCH_DRIVER_TIME_CONFLICT"));

const truckOverlap = structuredClone(switchPlan);
truckOverlap.trucks[1].loads.push(load("L3", {
  driverLogin: "jenny",
  driverName: "Jenny",
  truckId: "T2",
  truckPlate: "BB200",
  timing: { start: 500, finish: 560 }
}));
assert.ok(validateDispatchLoadAssignments(truckOverlap).some((item) => item.code === "DISPATCH_TRUCK_OCCUPANCY_CONFLICT"));

const sequentialTruckShare = normalizeDispatchPlanLoadAssignments({
  id: 3,
  planDate: "2026-07-17",
  trucks: [truck("T1", "AA100", "alex", [
    load("L1", { timing: { start: 420, finish: 480 }, driverSequence: 0 }),
    load("L2", { driverLogin: "jenny", driverName: "Jenny", timing: { start: 480, finish: 540 }, driverSequence: 0 })
  ])]
});
assert.deepEqual(validateDispatchLoadAssignments(sequentialTruckShare, { requireAssignments: true }), []);

const invalidDriverHandoff = structuredClone(sequentialTruckShare);
invalidDriverHandoff.orders = [{ id: "SO-1", address: "Customer" }];
invalidDriverHandoff.trucks[0].loads[0].stops = [{ id: "DROP", type: "drop", orderId: "SO-1", location: "12441" }];
assert.equal(validateDispatchLoadAssignments(invalidDriverHandoff).some((item) => item.reason === "driver_handoff_yard_mismatch"), false);
assert.ok(validateDispatchLoadAssignments(invalidDriverHandoff, { requireAssignments: true }).some((item) => item.reason === "driver_handoff_yard_mismatch"));

const ownYardDropHandoff = structuredClone(sequentialTruckShare);
ownYardDropHandoff.orders = [{ id: "TO-1", destinationYard: "12441" }];
ownYardDropHandoff.trucks[0].loads[0].stops = [{ id: "DROP", type: "drop", orderId: "TO-1", location: "3445" }];
assert.deepEqual(validateDispatchLoadAssignments(ownYardDropHandoff, { requireAssignments: true }), []);

const poMultiDropHandoff = structuredClone(sequentialTruckShare);
poMultiDropHandoff.orders = [{ id: "PO-1", type: "PO" }];
poMultiDropHandoff.trucks[0].loads[0].stops = [{
  id: "PO-DROP",
  type: "drop",
  orderId: "PO-1",
  dropLocation: "12441",
  lineRowIds: [101]
}];
assert.deepEqual(validateDispatchLoadAssignments(poMultiDropHandoff, { requireAssignments: true }), []);
const legacyPoMultiDropLocationHandoff = structuredClone(poMultiDropHandoff);
delete legacyPoMultiDropLocationHandoff.trucks[0].loads[0].stops[0].dropLocation;
legacyPoMultiDropLocationHandoff.trucks[0].loads[0].stops[0].location = "12441";
assert.deepEqual(validateDispatchLoadAssignments(legacyPoMultiDropLocationHandoff, { requireAssignments: true }), []);

const configuredOwnYardHandoff = structuredClone(sequentialTruckShare);
configuredOwnYardHandoff.summary = { ownYardCodes: ["CUSTOM-YARD"] };
configuredOwnYardHandoff.orders = [{ id: "TO-CUSTOM", destinationYard: "CUSTOM-YARD" }];
configuredOwnYardHandoff.trucks[0].base = "CUSTOM-YARD";
configuredOwnYardHandoff.trucks[0].loads[0].stops = [{ id: "DROP-CUSTOM", type: "drop", orderId: "TO-CUSTOM" }];
configuredOwnYardHandoff.trucks[0].loads[1].switchYard = "CUSTOM-YARD";
assert.deepEqual(dispatchOwnYardCodes(configuredOwnYardHandoff), ["CUSTOM-YARD"]);
assert.deepEqual(validateDispatchLoadAssignments(configuredOwnYardHandoff, { requireAssignments: true }), []);

const invalidHandoff = structuredClone(switchPlan);
invalidHandoff.trucks[0].loads[0].returnOnly = false;
invalidHandoff.trucks[0].loads[0].returnYard = "";
invalidHandoff.trucks[0].loads[0].stops = [{ id: "DROP", type: "drop", location: "Customer" }];
assert.equal(validateDispatchLoadAssignments(invalidHandoff).some((item) => item.code === "DISPATCH_TRUCK_HANDOFF_INVALID"), false);
assert.ok(validateDispatchLoadAssignments(invalidHandoff, { requireAssignments: true }).some((item) => item.code === "DISPATCH_TRUCK_HANDOFF_INVALID"));

const automaticApproach = structuredClone(invalidHandoff);
automaticApproach.trucks[1].loads[0].handoffTravelMinutes = 30;
automaticApproach.trucks[1].loads[0].handoffTravelFrom = "Customer";
automaticApproach.trucks[1].loads[0].handoffTravelTo = "12441";
automaticApproach.trucks[1].loads[0].timing.start = 520;
automaticApproach.trucks[1].loads[0].plannedStartMinute = 520;
automaticApproach.trucks[1].loads[0].timing.finish = 580;
automaticApproach.trucks[1].loads[0].plannedFinishMinute = 580;
assert.deepEqual(validateDispatchLoadAssignments(automaticApproach, { requireAssignments: true }), []);

const approachTooShort = structuredClone(automaticApproach);
approachTooShort.trucks[1].loads[0].timing.start = 519;
approachTooShort.trucks[1].loads[0].plannedStartMinute = 519;
assert.ok(validateDispatchLoadAssignments(approachTooShort, { requireAssignments: true }).some((item) => item.reason === "switch_approach_overlap"));

const unknownTruckStart = structuredClone(switchPlan);
unknownTruckStart.trucks[1].base = "";
assert.equal(validateDispatchLoadAssignments(unknownTruckStart, { requireAssignments: true }).some((item) => item.reason === "target_truck_yard_mismatch"), false);

const changed = structuredClone(switchPlan);
changed.trucks[0].loads[0].truckPlate = "CC300";
assert.equal(changedLockedLoadAssignments(switchPlan, changed, new Set(["L1"])).length, 1);
const changedSequence = structuredClone(switchPlan);
changedSequence.trucks[0].loads[0].driverSequence += 1;
assert.equal(changedLockedLoadAssignments(switchPlan, changedSequence, new Set(["L1"])).length, 1);

const lockedMultiDrop = structuredClone(switchPlan);
lockedMultiDrop.trucks[0].loads[0].stops = [{
  id: "PO-DROP-1",
  type: "drop",
  orderId: "PO-LOCKED",
  dropoffKey: "location:15",
  dropLocation: "12441",
  dropAddress: "12441 Address",
  destinationLocationId: 15,
  lineRowIds: [101, 102],
  timing: { arrival: 470, depart: 480 }
}];
lockedMultiDrop.orders = [{ id: "PO-LOCKED", items: [{ id: 101, quantity: 2 }, { id: 102, quantity: 3 }] }];
const changedLines = structuredClone(lockedMultiDrop);
changedLines.trucks[0].loads[0].stops[0].lineRowIds = [102];
assert.equal(changedLockedLoadAssignments(lockedMultiDrop, changedLines, new Set(["L1"])).length, 1);
const changedDrop = structuredClone(lockedMultiDrop);
changedDrop.trucks[0].loads[0].stops[0].dropLocation = "2967";
assert.equal(changedLockedLoadAssignments(lockedMultiDrop, changedDrop, new Set(["L1"])).length, 1);
const changedStopTiming = structuredClone(lockedMultiDrop);
changedStopTiming.trucks[0].loads[0].stops[0].timing.arrival = 475;
assert.equal(changedLockedLoadAssignments(lockedMultiDrop, changedStopTiming, new Set(["L1"])).length, 1);
const reorderedLineIds = structuredClone(lockedMultiDrop);
reorderedLineIds.trucks[0].loads[0].stops[0].lineRowIds.reverse();
assert.equal(changedLockedLoadAssignments(lockedMultiDrop, reorderedLineIds, new Set(["L1"])).length, 0);

const missingTiming = normalizeDispatchPlanLoadAssignments({
  id: 4,
  planDate: "2026-07-17",
  trucks: [truck("T1", "AA100", "alex", [load("L1")])]
});
assert.ok(validateDispatchLoadAssignments(missingTiming, { requireAssignments: true }).some((item) => item.reason === "missing_interval"));

console.log(JSON.stringify({ ok: true, tests: 29 }));
