import assert from "node:assert/strict";
import {
  changedDriverActivityAssignments,
  changedLockedLoadAssignments,
  dispatchOwnYardCodes,
  dispatchPhysicalStopVisits,
  driverLoadLanes,
  isValidDispatchStopTimeOverrideMinutes,
  normalizeDispatchPlanLoadAssignments,
  overlayLockedLoadDerivedSchedule,
  validateDispatchPlanTimingMetadata,
  validateDispatchLoadAssignments
} from "./dispatch-load-assignment.js";
import {
  dispatchLocationKey,
  dispatchLocationRoot,
  dispatchLocationsShareYard,
  uniqueDispatchLocations
} from "./dispatch-location.js";

assert.equal(dispatchLocationRoot("3445 : 3445 Special"), "3445");
assert.equal(dispatchLocationKey(" 3445 : 3445 Special "), "3445");
assert.equal(dispatchLocationsShareYard("3445", "3445 : 3445 Special"), true);
assert.equal(dispatchLocationsShareYard("3445 : Seasonal", "3445 : 3445 Special"), true);
assert.equal(dispatchLocationsShareYard("2967", "3445 : 3445 Special"), false);
assert.deepEqual(
  uniqueDispatchLocations(["3445 : 3445 Special", "3445", "2967"]),
  ["3445 : 3445 Special", "2967"]
);

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

const childOwnYardHandoff = structuredClone(sequentialTruckShare);
childOwnYardHandoff.orders = [{ id: "TO-CHILD", destinationYard: "3445 : 3445 Special" }];
childOwnYardHandoff.trucks[0].base = "3445";
childOwnYardHandoff.trucks[0].loads[0].stops = [{
  id: "DROP-CHILD",
  type: "drop",
  orderId: "TO-CHILD"
}];
childOwnYardHandoff.trucks[0].loads[1].switchYard = "3445";
assert.deepEqual(
  validateDispatchLoadAssignments(childOwnYardHandoff, { requireAssignments: true }),
  [],
  "A load ending at a child location must be available at its parent yard."
);

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

const lockedSchedule = structuredClone(lockedMultiDrop);
Object.assign(lockedSchedule.trucks[0].loads[0], {
  plannedStartMinute: 848,
  plannedFinishMinute: 1034,
  handoffTravelMinutes: 0,
  handoffTravelFrom: "",
  handoffTravelTo: "",
  timing: { start: 848, finish: 1034, scheduledStart: 848, previousFinish: 848 }
});
Object.assign(lockedSchedule.trucks[0].loads[0].stops[0], {
  arriveTime: "14:08",
  departTime: "15:38",
  timing: { arrival: 848, depart: 938 }
});
const routeCacheDrift = structuredClone(lockedSchedule);
Object.assign(routeCacheDrift.trucks[0].loads[0], {
  plannedStartMinute: 876,
  plannedFinishMinute: 1035,
  handoffTravelMinutes: 28,
  handoffTravelFrom: "12441",
  handoffTravelTo: "BWS Woodbridge",
  timing: { start: 876, finish: 1035, scheduledStart: 876, previousFinish: 876 },
  unrelatedClientField: "preserved"
});
Object.assign(routeCacheDrift.trucks[0].loads[0].stops[0], {
  arriveTime: "14:36",
  departTime: "16:06",
  timing: { arrival: 876, depart: 966 }
});
const overlaidRouteCacheDrift = overlayLockedLoadDerivedSchedule(
  lockedSchedule,
  routeCacheDrift,
  new Set(["L1"])
);
const overlaidLockedLoad = overlaidRouteCacheDrift.trucks[0].loads[0];
assert.equal(overlaidLockedLoad.plannedStartMinute, 848);
assert.equal(overlaidLockedLoad.plannedFinishMinute, 1034);
assert.deepEqual(overlaidLockedLoad.stops[0].timing, { arrival: 848, depart: 938 });
assert.equal(overlaidLockedLoad.unrelatedClientField, "preserved");
assert.equal(routeCacheDrift.trucks[0].loads[0].plannedStartMinute, 876, "Overlay must not mutate the submitted plan");
assert.equal(changedLockedLoadAssignments(lockedSchedule, overlaidRouteCacheDrift, new Set(["L1"])).length, 0);

const lockedStructuralMutations = [
  (plan) => { plan.trucks[0].loads[0].driverLogin = "other-driver"; },
  (plan) => { plan.trucks[0].loads[0].truckPlate = "CC300"; },
  (plan) => { plan.trucks[0].loads[0].stops[0].dropLocation = "2967"; },
  (plan) => { plan.trucks[0].loads[0].stops[0].orderId = "PO-OTHER"; },
  (plan) => { plan.orders[0].items[0].quantity = 99; }
];
for (const mutate of lockedStructuralMutations) {
  const submitted = structuredClone(routeCacheDrift);
  mutate(submitted);
  const overlaid = overlayLockedLoadDerivedSchedule(lockedSchedule, submitted, new Set(["L1"]));
  assert.equal(
    changedLockedLoadAssignments(lockedSchedule, overlaid, new Set(["L1"])).length,
    1,
    "Derived schedule overlay must not hide structural locked-load changes"
  );
}

const activityPlan = normalizeDispatchPlanLoadAssignments({
  id: 77,
  planDate: "2026-07-31",
  orders: [
    { id: "PO-A", items: [{ id: 101, quantity: 2 }] },
    { id: "PO-B", items: [{ id: 201, quantity: 3 }] },
    { id: "PO-C", items: [{ id: 301, quantity: 4 }] }
  ],
  trucks: [
    truck("T-A", "AA100", "alex", [load("L-A", {
      timing: { start: 420, finish: 600 },
      driverSequence: 0,
      stops: [
        { id: "PICK-A", type: "pick", orderId: "PO-A", location: "3445", lineRowIds: [101] },
        { id: "DROP-A", type: "drop", orderId: "PO-A", dropLocation: "Customer A", lineRowIds: [101] },
        { id: "DROP-B", type: "drop", orderId: "PO-B", dropLocation: "Customer B", lineRowIds: [201] }
      ]
    })]),
    truck("T-B", "BB200", "jenny", [load("L-B", {
      timing: { start: 420, finish: 540 },
      driverSequence: 0,
      stops: [{ id: "DROP-C", type: "drop", orderId: "PO-C", dropLocation: "Customer C", lineRowIds: [301] }]
    })])
  ]
});
const travelActivity = [{
  load_id: "L-A",
  stop_id: "travel-3445-12441",
  stop_type: "travel",
  order_refs: [],
  status: "in_progress"
}];
const pickupActivity = [{
  load_id: "L-A",
  stop_id: "PICK-A",
  stop_type: "pickup",
  order_refs: ["PO-A"],
  status: "complete"
}];
const changedActivityPlan = (mutate) => {
  const candidate = structuredClone(activityPlan);
  mutate(candidate);
  return candidate;
};

const travelPickupCorrection = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops[0].location = "12441";
});
assert.equal(changedDriverActivityAssignments(activityPlan, travelPickupCorrection, travelActivity).length, 0);
const travelQuantityCorrection = changedActivityPlan((plan) => {
  plan.orders[0].items[0].quantity = 7;
});
assert.equal(changedDriverActivityAssignments(activityPlan, travelQuantityCorrection, travelActivity).length, 0);
const travelDriverChange = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].driverLogin = "jenny";
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, travelDriverChange, travelActivity)[0].reasons, ["assignment"]);
const travelTruckChange = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].truckPlate = "CC300";
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, travelTruckChange, travelActivity)[0].reasons, ["assignment"]);
const travelLoadRemoval = changedActivityPlan((plan) => {
  plan.trucks[0].loads = [];
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, travelLoadRemoval, travelActivity)[0].reasons, ["load"]);
const travelSequenceChange = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].driverSequence = 4;
});
assert.equal(changedDriverActivityAssignments(activityPlan, travelSequenceChange, travelActivity).length, 0);
const truckSwitchPickupCorrection = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops[0].location = "12441";
  plan.orders[0].items[0].quantity = 8;
});
assert.equal(changedDriverActivityAssignments(activityPlan, truckSwitchPickupCorrection, [{
  ...travelActivity[0],
  stop_id: "truck-switch-L-A",
  stop_type: "truck_switch",
  status: "complete"
}]).length, 0);

for (const mutate of [
  (plan) => { plan.trucks[0].loads[0].stops[0].location = "12441"; },
  (plan) => { plan.trucks[0].loads[0].stops[0].orderId = "PO-B"; },
  (plan) => { plan.trucks[0].loads[0].stops[0].lineRowIds = [999]; }
]) {
  const changes = changedDriverActivityAssignments(activityPlan, changedActivityPlan(mutate), pickupActivity);
  assert.deepEqual(changes[0].reasons, ["stop"]);
  assert.deepEqual(changes[0].stopIds, ["PICK-A"]);
}
const activePickupAllocationChange = changedActivityPlan((plan) => {
  plan.orders[0].items[0].quantity = 9;
});
assert.deepEqual(
  changedDriverActivityAssignments(activityPlan, activePickupAllocationChange, pickupActivity)[0].reasons,
  ["order_allocation"]
);
const volatileLinePlan = structuredClone(activityPlan);
volatileLinePlan.orders[0].items = [{
  id: 119,
  lineId: 119,
  lineRowId: 119,
  itemId: 1784,
  sku: "PALLET",
  unit: "PLT",
  quantity: 300,
  pallets: 300
}];
volatileLinePlan.trucks[0].loads[0].stops[0].lineRowIds = [119];
const refreshedVolatileLine = structuredClone(volatileLinePlan);
Object.assign(refreshedVolatileLine.orders[0].items[0], {
  id: 159,
  lineId: 159,
  lineRowId: 159
});
assert.equal(
  changedDriverActivityAssignments(volatileLinePlan, refreshedVolatileLine, pickupActivity).length,
  0,
  "A regenerated database line ID must not look like an allocation change"
);
assert.equal(
  changedLockedLoadAssignments(volatileLinePlan, refreshedVolatileLine, new Set(["L-A"])).length,
  0,
  "The legacy whole-load guard must also ignore a regenerated allocation row ID"
);
const numericStringAllocation = structuredClone(refreshedVolatileLine);
numericStringAllocation.orders[0].items[0].quantity = "300.0";
numericStringAllocation.orders[0].items[0].pallets = "300";
assert.equal(
  changedDriverActivityAssignments(volatileLinePlan, numericStringAllocation, pickupActivity).length,
  0,
  "Numeric serialization differences must not look like an allocation change"
);
const duplicateAllocationLines = structuredClone(volatileLinePlan);
duplicateAllocationLines.orders[0].items = [
  { ...volatileLinePlan.orders[0].items[0], lineRowId: 119, quantity: 125, pallets: 125 },
  { ...volatileLinePlan.orders[0].items[0], lineRowId: 120, quantity: 175, pallets: 175 }
];
assert.equal(
  changedDriverActivityAssignments(duplicateAllocationLines, refreshedVolatileLine, pickupActivity).length,
  0,
  "Equivalent duplicate business-item rows must compare by their summed allocation"
);
const realAllocationChange = structuredClone(refreshedVolatileLine);
realAllocationChange.orders[0].items[0].quantity = 301;
assert.deepEqual(
  changedDriverActivityAssignments(volatileLinePlan, realAllocationChange, pickupActivity)[0].reasons,
  ["order_allocation"],
  "A real quantity change must remain protected"
);
assert.equal(
  changedLockedLoadAssignments(volatileLinePlan, realAllocationChange, new Set(["L-A"])).length,
  1,
  "The legacy whole-load guard must continue protecting a real quantity change"
);
const realItemChange = structuredClone(refreshedVolatileLine);
realItemChange.orders[0].items[0].itemId = 9999;
assert.deepEqual(
  changedDriverActivityAssignments(volatileLinePlan, realItemChange, pickupActivity)[0].reasons,
  ["order_allocation"],
  "A real inventory-item change must remain protected"
);
const destinationAllocationPlan = structuredClone(volatileLinePlan);
destinationAllocationPlan.orders[0].items = [
  { ...volatileLinePlan.orders[0].items[0], lineRowId: 119, destinationYard: "12441", quantity: 100, pallets: 100 },
  { ...volatileLinePlan.orders[0].items[0], lineRowId: 120, destinationYard: "2967", quantity: 200, pallets: 200 }
];
const redistributedDestinations = structuredClone(destinationAllocationPlan);
redistributedDestinations.orders[0].items[0].quantity = 150;
redistributedDestinations.orders[0].items[0].pallets = 150;
redistributedDestinations.orders[0].items[1].quantity = 150;
redistributedDestinations.orders[0].items[1].pallets = 150;
assert.deepEqual(
  changedDriverActivityAssignments(destinationAllocationPlan, redistributedDestinations, pickupActivity)[0].reasons,
  ["order_allocation"],
  "Moving an unchanged total between destinations must remain protected"
);
const groupedAllocationPlan = structuredClone(activityPlan);
groupedAllocationPlan.orders[0] = {
  id: "GROUP-A",
  childOrders: ["PO-A-1", "PO-A-2"],
  childOrderDetails: [
    { id: "PO-A-1", items: [{ itemId: 1784, sku: "PALLET", unit: "PLT", quantity: 100 }] },
    { id: "PO-A-2", items: [{ itemId: 1784, sku: "PALLET", unit: "PLT", quantity: 200 }] }
  ],
  items: [{ itemId: 1784, sku: "PALLET", unit: "PLT", quantity: 300 }]
};
groupedAllocationPlan.trucks[0].loads[0].stops[0].orderId = "GROUP-A";
const redistributedChildren = structuredClone(groupedAllocationPlan);
redistributedChildren.orders[0].childOrderDetails[0].items[0].quantity = 150;
redistributedChildren.orders[0].childOrderDetails[1].items[0].quantity = 150;
assert.deepEqual(
  changedDriverActivityAssignments(groupedAllocationPlan, redistributedChildren, [{
    ...pickupActivity[0],
    order_refs: ["PO-A-1"]
  }])[0].reasons,
  ["order_allocation"],
  "Moving an unchanged total between grouped child orders must remain protected"
);
const rematerializedActiveStop = structuredClone(refreshedVolatileLine);
rematerializedActiveStop.trucks[0].loads[0].stops[0].lineRowIds = [159];
assert.deepEqual(
  changedDriverActivityAssignments(volatileLinePlan, rematerializedActiveStop, pickupActivity)[0].reasons,
  ["stop"],
  "An active stop's exact line references remain evidence and must not be rematerialized"
);
const staleSourceYard = structuredClone(volatileLinePlan);
volatileLinePlan.orders[0].sourceYard = "12441";
volatileLinePlan.orders[0].pickupLocations = ["12441"];
volatileLinePlan.trucks[0].loads[0].stops[0].location = "12441";
staleSourceYard.orders[0].sourceYard = "3445";
staleSourceYard.orders[0].pickupLocations = ["12441"];
staleSourceYard.trucks[0].loads[0].stops[0].location = "12441";
assert.equal(
  changedDriverActivityAssignments(volatileLinePlan, staleSourceYard, pickupActivity).length,
  0,
  "A stale order-feed source yard must not override the materialized pickup stop"
);
const activePickupAddressChange = changedActivityPlan((plan) => {
  plan.orders[0].pickupAddressOverride = "12441 Woodbine Avenue";
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, activePickupAddressChange, pickupActivity)[0].reasons, ["stop"]);
const unstartedStopChange = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops[2].dropLocation = "Corrected Customer B";
});
assert.equal(changedDriverActivityAssignments(activityPlan, unstartedStopChange, pickupActivity).length, 0);
const unstartedSameOrderStopChange = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops[1].dropLocation = "Corrected future Customer A";
});
assert.equal(changedDriverActivityAssignments(activityPlan, unstartedSameOrderStopChange, pickupActivity).length, 0);
const unrelatedOrderChange = changedActivityPlan((plan) => {
  plan.orders[1].items[0].quantity = 12;
  plan.orders[1].address = "Corrected unstarted destination";
});
assert.equal(changedDriverActivityAssignments(activityPlan, unrelatedOrderChange, pickupActivity).length, 0);
const otherDriverChange = changedActivityPlan((plan) => {
  plan.trucks[1].loads[0].stops[0].dropLocation = "Corrected Customer C";
  plan.orders[2].items[0].quantity = 14;
});
assert.equal(changedDriverActivityAssignments(activityPlan, otherDriverChange, pickupActivity).length, 0);
const reorderedUnstartedStops = changedActivityPlan((plan) => {
  const [pickup, firstDrop, secondDrop] = plan.trucks[0].loads[0].stops;
  plan.trucks[0].loads[0].stops = [pickup, secondDrop, firstDrop];
});
assert.equal(changedDriverActivityAssignments(activityPlan, reorderedUnstartedStops, pickupActivity).length, 0);
const reorderedStartedStop = changedActivityPlan((plan) => {
  const [pickup, firstDrop, secondDrop] = plan.trucks[0].loads[0].stops;
  plan.trucks[0].loads[0].stops = [firstDrop, pickup, secondDrop];
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, reorderedStartedStop, pickupActivity)[0].stopIds, ["PICK-A"]);
const insertedBeforeStartedStop = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops.unshift({ id: "FUTURE-PICK", type: "pick", orderId: "PO-B", location: "12441" });
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, insertedBeforeStartedStop, pickupActivity)[0].stopIds, ["PICK-A"]);
assert.equal(changedDriverActivityAssignments(activityPlan, travelPickupCorrection, [
  { ...pickupActivity[0], status: "pending" },
  { ...travelActivity[0], status: "complete" }
]).length, 0);

const activeDropChange = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops[1].dropLocation = "Wrong Customer A";
});
const activeDrop = [{ ...pickupActivity[0], stop_id: "DROP-A", stop_type: "dropoff" }];
assert.deepEqual(changedDriverActivityAssignments(activityPlan, activeDropChange, activeDrop)[0].stopIds, ["DROP-A"]);
const insertedBeforeActiveDrop = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops.splice(1, 0, { id: "FUTURE-PICK", type: "pick", orderId: "PO-B", location: "12441" });
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, insertedBeforeActiveDrop, activeDrop)[0].stopIds, ["DROP-A"]);
const activeDropAllocationChange = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops[1].dropPallets = 5;
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, activeDropAllocationChange, activeDrop)[0].stopIds, ["DROP-A"]);
const activeDropAddressChange = changedActivityPlan((plan) => {
  plan.orders[0].address = "Changed completed destination";
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, activeDropAddressChange, activeDrop)[0].reasons, ["stop"]);
const activeFinalDrop = [{ ...pickupActivity[0], stop_id: "DROP-B", stop_type: "dropoff", order_refs: ["PO-B"] }];
const swappedExecutedPrefix = changedActivityPlan((plan) => {
  const [pickup, firstDrop, finalDrop] = plan.trucks[0].loads[0].stops;
  plan.trucks[0].loads[0].stops = [firstDrop, pickup, finalDrop];
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, swappedExecutedPrefix, activeFinalDrop)[0].stopIds, ["DROP-B"]);
const removedBeforeActive = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops.splice(0, 1);
});
assert.deepEqual(changedDriverActivityAssignments(activityPlan, removedBeforeActive, activeDrop)[0].stopIds, ["DROP-A"]);
const appendedAfterActive = changedActivityPlan((plan) => {
  plan.trucks[0].loads[0].stops.push({ id: "FUTURE-DROP", type: "drop", orderId: "PO-C", dropLocation: "Future" });
});
assert.equal(changedDriverActivityAssignments(activityPlan, appendedAfterActive, activeDrop).length, 0);
assert.equal(changedDriverActivityAssignments(activityPlan, swappedExecutedPrefix, travelActivity).length, 0);
assert.deepEqual(changedDriverActivityAssignments(activityPlan, activityPlan, [{
  ...pickupActivity[0],
  stop_id: "MISSING-ACTIVE-STOP"
}])[0].stopIds, ["MISSING-ACTIVE-STOP"]);
assert.equal(changedDriverActivityAssignments(activityPlan, travelPickupCorrection, activeDrop).length, 0);
assert.deepEqual(
  changedDriverActivityAssignments(activityPlan, travelPickupCorrection, [{ ...pickupActivity[0], stop_type: "pick" }])[0].stopIds,
  ["PICK-A"]
);
assert.deepEqual(
  changedDriverActivityAssignments(activityPlan, activeDropChange, [{ ...activeDrop[0], stop_type: "drop" }])[0].stopIds,
  ["DROP-A"]
);
assert.deepEqual(changedDriverActivityAssignments(activityPlan, unstartedStopChange, [{
  ...pickupActivity[0],
  stop_type: "pickup",
  stop_id: ""
}])[0].reasons, ["full_load"]);
assert.deepEqual(changedDriverActivityAssignments(activityPlan, unstartedStopChange, [{
  ...pickupActivity[0],
  stop_type: "legacy_unknown"
}])[0].reasons, ["full_load"]);
assert.equal(changedDriverActivityAssignments(activityPlan, travelPickupCorrection, [{
  ...pickupActivity[0],
  status: "pending"
}]).length, 0);

const reorderedLineIds = structuredClone(lockedMultiDrop);
reorderedLineIds.trucks[0].loads[0].stops[0].lineRowIds.reverse();
assert.equal(changedLockedLoadAssignments(lockedMultiDrop, reorderedLineIds, new Set(["L1"])).length, 0);

const missingTiming = normalizeDispatchPlanLoadAssignments({
  id: 4,
  planDate: "2026-07-17",
  trucks: [truck("T1", "AA100", "alex", [load("L1")])]
});
assert.ok(validateDispatchLoadAssignments(missingTiming, { requireAssignments: true }).some((item) => item.reason === "missing_interval"));

assert.equal(isValidDispatchStopTimeOverrideMinutes(undefined), true);
assert.equal(isValidDispatchStopTimeOverrideMinutes(null), true);
assert.equal(isValidDispatchStopTimeOverrideMinutes(0), true);
assert.equal(isValidDispatchStopTimeOverrideMinutes(1440), true);
assert.equal(isValidDispatchStopTimeOverrideMinutes("30"), false);
assert.equal(isValidDispatchStopTimeOverrideMinutes(30.5), false);
assert.equal(isValidDispatchStopTimeOverrideMinutes(1441), false);

const physicalVisitPlan = normalizeDispatchPlanLoadAssignments({
  id: 88,
  planDate: "2026-08-01",
  ownYardCodes: ["3445", "12441"],
  orders: [
    { id: "SO-VISIT-A", type: "SO", destinationYard: "3445", address: "3445 Kennedy Road", items: [{ lineRowId: "A", pallets: 2 }] },
    { id: "SO-VISIT-B", type: "SO", destinationYard: "3445", address: "3445 KENNEDY ROAD.", items: [{ lineRowId: "B", pallets: 3 }] },
    { id: "SO-VISIT-C", type: "SO", address: "100 Main Street, Toronto, ON", items: [{ lineRowId: "C", pallets: 2 }] },
    { id: "CUSTOM-VISIT", type: "CUSTOM", customOrder: true, stopMinutes: 55, address: "100 MAIN STREET TORONTO ON", items: [{ lineRowId: "D", pallets: 3 }] }
  ],
  trucks: [truck("VISIT-TRUCK", "VV100", "alex", [load("VISIT-LOAD", {
    ownYardFixedMinutes: 40,
    vendorFixedMinutes: 30,
    deliveryFixedMinutes: 30,
    minutesPerPallet: 2,
    timing: { start: 420, finish: 650 },
    stops: [
      { id: "OWN-A", type: "drop", orderId: "SO-VISIT-A", lineRowIds: ["A"] },
      { id: "OWN-B", type: "drop", orderId: "SO-VISIT-B", lineRowIds: ["B"] },
      { id: "DELIVERY-A", type: "drop", orderId: "SO-VISIT-C", lineRowIds: ["C"] },
      { id: "DELIVERY-B", type: "drop", orderId: "CUSTOM-VISIT", lineRowIds: ["D"] }
    ]
  })])]
});
const physicalVisits = dispatchPhysicalStopVisits(
  physicalVisitPlan,
  physicalVisitPlan.trucks[0],
  physicalVisitPlan.trucks[0].loads[0]
);
assert.equal(physicalVisits.length, 2, "Only adjacent equal-address drops should merge.");
assert.deepEqual(physicalVisits[0].stopIds, ["OWN-A", "OWN-B"]);
assert.equal(physicalVisits[0].plannedMinutes, 40, "An own-yard visit must apply Alex's fixed rule once.");
assert.deepEqual(physicalVisits[1].stopIds, ["DELIVERY-A", "DELIVERY-B"]);
assert.equal(physicalVisits[1].automaticMinutes, 40, "A grouped delivery must aggregate pallets under one fixed charge.");
assert.equal(physicalVisits[1].plannedMinutes, 55, "A mixed Custom visit must use the greater Custom duration without summing it.");

const customerDropsWithSharedPickupYardPlan = normalizeDispatchPlanLoadAssignments({
  id: 884,
  planDate: "2026-08-05",
  ownYardCodes: ["12441"],
  orders: [
    {
      id: "GOA-6369-6373",
      type: "SO",
      destinationAddress: "10 First Customer Road, Toronto, ON",
      items: [{ lineRowId: "GOA", pallets: 2 }]
    },
    {
      id: "GOB-116349-116350",
      type: "SO",
      destinationAddress: "20 Second Customer Avenue, Brampton, ON",
      items: [{ lineRowId: "GOB", pallets: 3 }]
    }
  ],
  trucks: [truck("CUSTOMER-DROP-TRUCK", "CE94487", "dao", [load("CUSTOMER-DROP-LOAD", {
    ownYardFixedMinutes: 40,
    deliveryFixedMinutes: 20,
    minutesPerPallet: 1,
    timing: { start: 530, finish: 684 },
    stops: [
      { id: "GOA-DROP", type: "drop", orderId: "GOA-6369-6373", location: "12441" },
      { id: "GOB-DROP", type: "drop", orderId: "GOB-116349-116350", location: "12441" }
    ]
  })])]
});
const customerDropsWithSharedPickupYardVisits = dispatchPhysicalStopVisits(
  customerDropsWithSharedPickupYardPlan,
  customerDropsWithSharedPickupYardPlan.trucks[0],
  customerDropsWithSharedPickupYardPlan.trucks[0].loads[0]
);
assert.equal(
  customerDropsWithSharedPickupYardVisits.length,
  2,
  "Distinct customer destination addresses must not merge when both stops retain the same pickup-yard location metadata."
);
assert.deepEqual(
  customerDropsWithSharedPickupYardVisits.map((visit) => visit.serviceType),
  ["delivery", "delivery"],
  "Customer destinations must use delivery dwell rules even when stop.location names an own yard."
);
assert.deepEqual(
  customerDropsWithSharedPickupYardVisits.map((visit) => visit.address),
  ["10 First Customer Road, Toronto, ON", "20 Second Customer Avenue, Brampton, ON"],
  "Physical visits must retain each customer's resolved destination address."
);

const legacyCustomerAddressPlan = normalizeDispatchPlanLoadAssignments({
  id: 886,
  planDate: "2026-08-05",
  ownYardCodes: ["12441"],
  orders: [{ id: "SO-LEGACY-ADDRESS", type: "SO", items: [{ lineRowId: "SO-LINE", pallets: 1 }] }],
  trucks: [truck("LEGACY-CUSTOMER-TRUCK", "SO100", "dao", [load("LEGACY-CUSTOMER-LOAD", {
    deliveryFixedMinutes: 20,
    minutesPerPallet: 1,
    timing: { start: 420, finish: 441 },
    stops: [{
      id: "LEGACY-CUSTOMER-DROP",
      type: "drop",
      orderId: "SO-LEGACY-ADDRESS",
      location: "99 Legacy Customer Road, Toronto, ON"
    }]
  })])]
});
const legacyCustomerAddressVisit = dispatchPhysicalStopVisits(
  legacyCustomerAddressPlan,
  legacyCustomerAddressPlan.trucks[0],
  legacyCustomerAddressPlan.trucks[0].loads[0]
)[0];
assert.equal(
  legacyCustomerAddressVisit.address,
  "99 Legacy Customer Road, Toronto, ON",
  "A legacy customer stop may use stop.location as a physical address without treating it as a destination-yard identity."
);
assert.equal(legacyCustomerAddressVisit.serviceType, "delivery");

const legacyScopedPoLocationPlan = normalizeDispatchPlanLoadAssignments({
  id: 885,
  planDate: "2026-08-05",
  ownYardCodes: ["12441"],
  orders: [{
    id: "PO-LEGACY-SCOPED",
    type: "PO",
    address: "Legacy purchase-order label",
    items: [{ lineRowId: "PO-LINE", pallets: 2 }]
  }],
  trucks: [truck("LEGACY-PO-TRUCK", "PO100", "dao", [load("LEGACY-PO-LOAD", {
    ownYardFixedMinutes: 40,
    deliveryFixedMinutes: 20,
    minutesPerPallet: 1,
    timing: { start: 420, finish: 460 },
    stops: [{
      id: "LEGACY-PO-DROP",
      type: "drop",
      orderId: "PO-LEGACY-SCOPED",
      location: "12441",
      line_row_ids: ["PO-LINE"]
    }]
  })])]
});
const legacyScopedPoLocationVisit = dispatchPhysicalStopVisits(
  legacyScopedPoLocationPlan,
  legacyScopedPoLocationPlan.trucks[0],
  legacyScopedPoLocationPlan.trucks[0].loads[0]
)[0];
assert.equal(
  legacyScopedPoLocationVisit.serviceType,
  "own_yard",
  "A legacy line-scoped PO may still use stop.location as its explicit destination yard."
);

const mixedOwnYardAddressPlan = normalizeDispatchPlanLoadAssignments({
  id: 880,
  planDate: "2026-08-01",
  ownYardCodes: ["150"],
  orders: [
    { id: "TO-150", type: "TO", destinationYard: "150", items: [{ lineRowId: "TO", pallets: 1 }] },
    { id: "SO-150", type: "SO", address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada", items: [{ lineRowId: "SO", pallets: 2 }] }
  ],
  trucks: [truck("MIXED-YARD-TRUCK", "MY100", "alex", [load("MIXED-YARD-LOAD", {
    ownYardFixedMinutes: 30,
    deliveryFixedMinutes: 20,
    minutesPerPallet: 1,
    timing: { start: 420, finish: 520 },
    stops: [
      { id: "TO-150-DROP", type: "drop", orderId: "TO-150", dropLocation: "150" },
      { id: "SO-150-DROP", type: "drop", orderId: "SO-150" }
    ]
  })])]
});
const mixedOwnYardAddressVisits = dispatchPhysicalStopVisits(
  mixedOwnYardAddressPlan,
  mixedOwnYardAddressPlan.trucks[0],
  mixedOwnYardAddressPlan.trucks[0].loads[0]
);
assert.equal(mixedOwnYardAddressVisits.length, 1, "A yard-coded drop and the same resolved street address must be one physical visit.");
assert.deepEqual(mixedOwnYardAddressVisits[0].stopIds, ["TO-150-DROP", "SO-150-DROP"]);
assert.equal(mixedOwnYardAddressVisits[0].plannedMinutes, 23, "A mixed-service physical visit must apply one delivery fixed charge plus its aggregate footprint.");

const pickupOverrideVisitPlan = normalizeDispatchPlanLoadAssignments({
  id: 883,
  planDate: "2026-08-01",
  ownYardCodes: ["3445"],
  orders: [{
    id: "OVERRIDE-PICKUP",
    type: "SO",
    pickupLocations: ["3445"],
    pickupAddressOverride: "81 External Vendor Road, Caledon, ON",
    items: [{ lineRowId: "OV", pallets: 2 }]
  }],
  trucks: [truck("OVERRIDE-TRUCK", "OV100", "alex", [load("OVERRIDE-LOAD", {
    ownYardFixedMinutes: 40,
    vendorFixedMinutes: 31,
    timing: { start: 420, finish: 520 },
    stops: [
      { id: "OVERRIDE-PICK", type: "pick", orderId: "OVERRIDE-PICKUP", location: "3445" },
      { id: "OVERRIDE-DROP", type: "drop", orderId: "OVERRIDE-PICKUP", dropAddress: "90 Customer Road" }
    ]
  })])]
});
const pickupOverrideVisit = dispatchPhysicalStopVisits(
  pickupOverrideVisitPlan,
  pickupOverrideVisitPlan.trucks[0],
  pickupOverrideVisitPlan.trucks[0].loads[0]
)[0];
assert.equal(pickupOverrideVisit.serviceType, "vendor_yard", "A physical pickup-address override must control service classification.");
assert.equal(pickupOverrideVisit.plannedMinutes, 31, "An external pickup override must use the assigned driver's vendor rule, not the logical yard rule.");

const footprintParityPlan = normalizeDispatchPlanLoadAssignments({
  id: 881,
  planDate: "2026-08-01",
  orders: [
    { id: "STOP-EXPLICIT", type: "SO", items: [{ lineRowId: "E", pallets: 9 }] },
    {
      id: "MULTI-LINES",
      type: "PO",
      items: [
        { lineRowId: "A", pallets: 2 },
        { lineRowId: "B", pallets: 7 }
      ],
      dropoffs: [
        { key: "east", destinationYard: "East", lineRowIds: ["A"] },
        { key: "west", destinationYard: "West", lineRowIds: ["B"] }
      ]
    },
    {
      id: "DROPOFF-SCOPED",
      type: "PO",
      items: [{ lineRowId: "DS", pallets: 99 }],
      dropoffs: [
        { key: "scoped", destinationYard: "Scoped", pallets: 5 },
        { key: "other", destinationYard: "Other", pallets: 94 }
      ]
    },
    { id: "STOP-LOOSE", type: "SO", items: [{ lineRowId: "SL", pallets: 8 }] },
    {
      id: "DROPOFF-LOOSE",
      type: "PO",
      items: [{ lineRowId: "DL", pallets: 20 }],
      dropoffs: [
        { key: "loose", destinationYard: "Loose", pallets: 2, sections: 3 },
        { key: "full", destinationYard: "Full", pallets: 18 }
      ]
    },
    { id: "ITEM-LOOSE", type: "SO", items: [{ lineRowId: "IL", pallets: 1, pieces: 9 }] },
    { id: "SPLIT-PRECEDENCE", type: "SO", items: [{ lineRowId: "SP", pallets: 4, splitQty: 4000 }] }
  ],
  trucks: [truck("FOOTPRINT-TRUCK", "FT100", "alex", [load("FOOTPRINT-LOAD", {
    deliveryFixedMinutes: 10,
    minutesPerPallet: 1,
    timing: { start: 420, finish: 800 },
    stops: [
      { id: "STOP-EXPLICIT-DROP", type: "drop", orderId: "STOP-EXPLICIT", dropAddress: "1 Parity Road", dropPallets: 3 },
      { id: "MULTI-EAST-DROP", type: "drop", orderId: "MULTI-LINES", dropoffKey: "east", dropAddress: "2 Parity Road" },
      { id: "MULTI-WEST-DROP", type: "drop", orderId: "MULTI-LINES", dropoffKey: "west", dropAddress: "3 Parity Road", lineRowIds: ["A"] },
      { id: "DROPOFF-SCOPED-DROP", type: "drop", orderId: "DROPOFF-SCOPED", dropoffKey: "scoped", dropAddress: "4 Parity Road" },
      { id: "STOP-LOOSE-DROP", type: "drop", orderId: "STOP-LOOSE", dropAddress: "5 Parity Road", dropPallets: 0, dropLayers: 2 },
      { id: "DROPOFF-LOOSE-DROP", type: "drop", orderId: "DROPOFF-LOOSE", dropoffKey: "loose", dropAddress: "6 Parity Road" },
      { id: "ITEM-LOOSE-DROP", type: "drop", orderId: "ITEM-LOOSE", dropAddress: "7 Parity Road", lineRowIds: ["IL"] },
      { id: "SPLIT-PRECEDENCE-DROP", type: "drop", orderId: "SPLIT-PRECEDENCE", dropAddress: "8 Parity Road", lineRowIds: ["SP"] }
    ]
  })])]
});
const footprintVisits = dispatchPhysicalStopVisits(
  footprintParityPlan,
  footprintParityPlan.trucks[0],
  footprintParityPlan.trucks[0].loads[0]
);
const footprintVisit = (stopId) => footprintVisits.find((visit) => visit.stopIds.includes(stopId));
assert.equal(footprintVisits.length, 8, "Distinct destinations must remain distinct physical visits in the footprint fixture.");
assert.equal(footprintVisit("STOP-EXPLICIT-DROP").pallets, 3, "stop.dropPallets must override item and order pallets.");
assert.equal(footprintVisit("STOP-EXPLICIT-DROP").automaticMinutes, 13, "The delivery rule must consume the stop-scoped footprint.");
assert.equal(footprintVisit("MULTI-EAST-DROP").pallets, 2, "A multi-destination drop must fall back to its dropoff lineRowIds.");
assert.equal(footprintVisit("MULTI-WEST-DROP").pallets, 2, "Stop lineRowIds must take precedence over the matched dropoff lineRowIds.");
assert.equal(footprintVisit("DROPOFF-SCOPED-DROP").pallets, 5, "Matched dropoff pallets must override whole-order and item pallets.");
assert.equal(footprintVisit("STOP-LOOSE-DROP").pallets, 1, "Stop-scoped loose layers must reserve one footprint pallet even with zero full pallets.");
assert.equal(footprintVisit("DROPOFF-LOOSE-DROP").pallets, 3, "Dropoff-scoped loose sections must reserve one additional footprint pallet.");
assert.equal(footprintVisit("ITEM-LOOSE-DROP").pallets, 2, "Selected item loose pieces must reserve one additional footprint pallet.");
assert.equal(footprintVisit("SPLIT-PRECEDENCE-DROP").pallets, 4, "splitQty is a sales quantity and must never replace the item's pallet count.");
assert.equal(footprintVisit("SPLIT-PRECEDENCE-DROP").automaticMinutes, 14, "A large splitQty must not inflate delivery dwell time.");

const pickupFootprintParityPlan = normalizeDispatchPlanLoadAssignments({
  id: 882,
  planDate: "2026-08-01",
  ownYardCodes: ["3445"],
  orders: [
    {
      id: "PICKUP-A",
      type: "SO",
      pickupLocations: ["3445"],
      items: [{ lineRowId: "PA", pallets: 2, layers: 1, splitQty: 2000 }]
    },
    {
      id: "PICKUP-B",
      type: "SO",
      pickupLocations: ["3445"],
      items: [{ lineRowId: "PB", pallets: 3, sections: 2, splitQty: 3000 }]
    }
  ],
  trucks: [truck("PICKUP-FOOTPRINT-TRUCK", "PF100", "alex", [load("PICKUP-FOOTPRINT-LOAD", {
    ownYardFixedMinutes: 40,
    timing: { start: 420, finish: 600 },
    stops: [
      { id: "PICKUP-FOOTPRINT", type: "pick", orderId: "PICKUP-A", location: "3445" },
      { id: "PICKUP-A-DROP-1", type: "drop", orderId: "PICKUP-A", dropAddress: "11 Parity Road" },
      { id: "PICKUP-A-DROP-2", type: "drop", orderId: "PICKUP-A", dropAddress: "12 Parity Road" },
      { id: "PICKUP-B-DROP", type: "drop", orderId: "PICKUP-B", dropAddress: "13 Parity Road" }
    ]
  })])]
});
const pickupFootprintVisit = dispatchPhysicalStopVisits(
  pickupFootprintParityPlan,
  pickupFootprintParityPlan.trucks[0],
  pickupFootprintParityPlan.trucks[0].loads[0]
)[0];
assert.equal(
  pickupFootprintVisit.pallets,
  7,
  "A pickup footprint must aggregate each order at the location once, use pallets instead of splitQty, and reserve one loose pallet per order."
);

const firstPickupPlan = normalizeDispatchPlanLoadAssignments({
  id: 89,
  planDate: "2026-08-01",
  ownYardCodes: ["12441"],
  orders: [{ id: "FIRST-PICKUP-ORDER", type: "SO", sourceYard: "12441", items: [{ pallets: 4 }] }],
  trucks: [truck("FIRST-PICKUP-TRUCK", "FP100", "li", [load("FIRST-LOAD", {
    ownYardFixedMinutes: 40,
    timing: { start: 420, finish: 500 },
    stops: [{ id: "FIRST-PICKUP", type: "pick", orderId: "FIRST-PICKUP-ORDER", location: "12441" }]
  })])]
});
const firstPickupVisit = dispatchPhysicalStopVisits(
  firstPickupPlan,
  firstPickupPlan.trucks[0],
  firstPickupPlan.trucks[0].loads[0]
)[0];
assert.equal(firstPickupVisit.serviceType, "own_yard");
assert.equal(firstPickupVisit.plannedMinutes, 40, "The first pickup in the first load must use the assigned driver's own-yard duration, never zero.");

const livePolicyPlan = normalizeDispatchPlanLoadAssignments({
  id: 90,
  planDate: "2026-08-01",
  ownYardCodes: ["12441", "150"],
  orders: [
    { id: "LI-CLARK-A", type: "TO", destinationYard: "150", address: "150 Clark Blvd, Brampton, ON", pallets: 7 },
    { id: "LI-CLARK-B", type: "TO", destinationYard: "150", address: "150 CLARK BLVD BRAMPTON ON", pallets: 7 },
    { id: "SETY-YARD-A", type: "TO", destinationYard: "12441", address: "12441 Woodbine Avenue", pallets: 8 },
    { id: "SETY-YARD-B", type: "TO", destinationYard: "12441", address: "12441 WOODBINE AVENUE", pallets: 7 }
  ],
  trucks: [
    truck("LI-TRUCK", "LI100", "li", [load("LI-CLARK-LOAD", {
      ownYardFixedMinutes: 40,
      deliveryFixedMinutes: 20,
      minutesPerPallet: 3,
      timing: { start: 500, finish: 600 },
      stops: [
        { id: "LI-CLARK-DROP-A", type: "drop", orderId: "LI-CLARK-A" },
        { id: "LI-CLARK-DROP-B", type: "drop", orderId: "LI-CLARK-B" }
      ]
    })]),
    truck("SETY-TRUCK", "SE100", "sety", [load("SETY-12441-LOAD", {
      ownYardFixedMinutes: 30,
      timing: { start: 500, finish: 600 },
      stops: [
        { id: "SETY-YARD-DROP-A", type: "drop", orderId: "SETY-YARD-A", dropLocation: "12441" },
        { id: "SETY-YARD-DROP-B", type: "drop", orderId: "SETY-YARD-B", dropLocation: "12441" }
      ]
    })])
  ]
});
assert.equal(
  dispatchPhysicalStopVisits(livePolicyPlan, livePolicyPlan.trucks[0], livePolicyPlan.trucks[0].loads[0])[0].serviceType,
  "own_yard",
  "The Clark/150 destination must retain own-yard precedence even though it has a street address."
);
assert.equal(
  dispatchPhysicalStopVisits(livePolicyPlan, livePolicyPlan.trucks[0], livePolicyPlan.trucks[0].loads[0])[0].plannedMinutes,
  40,
  "Li's consecutive Clark/150 drops must apply his 40-minute own-yard rule once."
);
assert.equal(
  dispatchPhysicalStopVisits(livePolicyPlan, livePolicyPlan.trucks[1], livePolicyPlan.trucks[1].loads[0])[0].plannedMinutes,
  30,
  "Sety's consecutive 12441 drops must apply his 30-minute own-yard rule once."
);

const overriddenPhysicalVisit = structuredClone(physicalVisitPlan);
for (const stop of overriddenPhysicalVisit.trucks[0].loads[0].stops.slice(2)) stop.stopTimeOverrideMinutes = 0;
assert.equal(
  dispatchPhysicalStopVisits(overriddenPhysicalVisit, overriddenPhysicalVisit.trucks[0], overriddenPhysicalVisit.trucks[0].loads[0])[1].plannedMinutes,
  0,
  "A dispatcher override of zero is valid and must win over every automatic rule."
);
const conflictingPhysicalVisit = structuredClone(physicalVisitPlan);
conflictingPhysicalVisit.trucks[0].loads[0].stops[2].stopTimeOverrideMinutes = 75;
assert.ok(validateDispatchPlanTimingMetadata(conflictingPhysicalVisit).some((item) => item.code === "DISPATCH_GROUPED_STOP_TIME_OVERRIDE_CONFLICT"));
const invalidPhysicalVisit = structuredClone(physicalVisitPlan);
invalidPhysicalVisit.trucks[0].loads[0].stops[0].stopTimeOverrideMinutes = "75";
assert.ok(validateDispatchPlanTimingMetadata(invalidPhysicalVisit).some((item) => item.code === "DISPATCH_STOP_TIME_OVERRIDE_INVALID"));

const activeVisitBaseline = structuredClone(physicalVisitPlan);
Object.assign(activeVisitBaseline.trucks[0].loads[0], {
  plannedStartMinute: 420,
  plannedFinishMinute: 650,
  timing: { start: 420, finish: 650, scheduledStart: 420, previousFinish: 420 }
});
activeVisitBaseline.trucks[0].loads[0].stops.forEach((stop, index) => {
  stop.timing = { arrival: 430 + (index * 40), depart: 450 + (index * 40) };
});
const activeVisitStatuses = [{
  load_id: "VISIT-LOAD",
  stop_id: "OWN-A",
  stop_type: "dropoff",
  status: "complete"
}];
const futureOverride = structuredClone(activeVisitBaseline);
for (const stop of futureOverride.trucks[0].loads[0].stops.slice(2)) stop.stopTimeOverrideMinutes = 70;
futureOverride.trucks[0].loads[0].plannedFinishMinute = 700;
futureOverride.trucks[0].loads[0].timing.finish = 700;
futureOverride.trucks[0].loads[0].stops[0].timing = { arrival: 435, depart: 455 };
futureOverride.trucks[0].loads[0].stops[1].timing = { arrival: 455, depart: 475 };
futureOverride.trucks[0].loads[0].stops[2].timing = { arrival: 520, depart: 590 };
futureOverride.trucks[0].loads[0].stops[3].timing = { arrival: 520, depart: 590 };
assert.equal(validateDispatchPlanTimingMetadata(futureOverride, {
  previousPlan: activeVisitBaseline,
  statuses: activeVisitStatuses
}).some((item) => item.code === "DISPATCH_STOP_TIME_OVERRIDE_LOCKED"), false);
const activeOverride = structuredClone(futureOverride);
for (const stop of activeOverride.trucks[0].loads[0].stops.slice(0, 2)) stop.stopTimeOverrideMinutes = 60;
assert.ok(validateDispatchPlanTimingMetadata(activeOverride, {
  previousPlan: activeVisitBaseline,
  statuses: activeVisitStatuses
}).some((item) => item.code === "DISPATCH_STOP_TIME_OVERRIDE_LOCKED"));
const suffixOverlay = overlayLockedLoadDerivedSchedule(
  activeVisitBaseline,
  futureOverride,
  new Set(["VISIT-LOAD"]),
  { activityStatuses: activeVisitStatuses }
);
assert.equal(suffixOverlay.trucks[0].loads[0].plannedStartMinute, 420);
assert.equal(suffixOverlay.trucks[0].loads[0].plannedFinishMinute, 700, "The future timing suffix must remain recalculated.");
assert.deepEqual(suffixOverlay.trucks[0].loads[0].stops[0].timing, { arrival: 430, depart: 450 });
assert.deepEqual(suffixOverlay.trucks[0].loads[0].stops[1].timing, { arrival: 470, depart: 490 }, "Every member of the active physical visit belongs to the immutable prefix.");
assert.deepEqual(suffixOverlay.trucks[0].loads[0].stops[2].timing, { arrival: 520, depart: 590 }, "A future visit's recalculated timing must survive the overlay.");

const endingTripPlan = normalizeDispatchPlanLoadAssignments({
  id: 99,
  planDate: "2026-08-01",
  trucks: [truck("END-TRUCK", "EE100", "alex", [
    load("DAY-LOAD", { timing: { start: 420, finish: 480 }, driverSequence: 0 }),
    load("FINAL-RETURN", {
      returnOnly: true,
      manual: true,
      endingTrip: true,
      returnYard: "12441",
      stops: [],
      timing: { start: 480, finish: 540 },
      driverSequence: 1
    })
  ])]
});
assert.equal(validateDispatchPlanTimingMetadata(endingTripPlan).length, 0);
const staleEndingTripPlan = structuredClone(endingTripPlan);
staleEndingTripPlan.trucks[0].loads[0].endingTrip = true;
assert.ok(validateDispatchPlanTimingMetadata(staleEndingTripPlan).some((item) => item.reason === "not_manual_return"));
const laterLoadAfterEnding = structuredClone(endingTripPlan);
laterLoadAfterEnding.trucks[0].loads.push(load("LATER-LOAD", { timing: { start: 540, finish: 600 }, driverSequence: 2 }));
assert.ok(validateDispatchPlanTimingMetadata(laterLoadAfterEnding).some((item) => item.reason === "not_final_driver_load"));

console.log(JSON.stringify({ ok: true, tests: 133 }));
