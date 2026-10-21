import assert from "node:assert/strict";
import test from "node:test";
import { assertOrdinaryDispatchPreservesBins, sequenceBinVisit, assertBinRouteCapacity, binVisitGroups, preserveOrdinaryDispatchBins }
  from "../../../src/mbt/bin-planning-domain.js";

function stop(visitId, sequence, actionCode) {
  return { id: `${visitId}-${sequence}`, type: "drop", actionCode,
    mbt: { visitId, stopGroupId: visitId, stopSequence: sequence, mandatory: true } };
}
function sharedPlan() {
  return { orders: [{ id: "SO1", type: "SO" }], trucks: [
    { id: "1", truckType: "bin", driverLogin: "alice", driverId: "10", loads: [
      { id: "bin", plannedStartMinute: 420, plannedFinishMinute: 480, stops: [
        stop("visit", 1, "pick_empty_bin"), stop("visit", 2, "drop_empty_bin") ] } ] },
    { id: "2", loads: [{ id: "ordinary", stops: [{ id: "SO1", type: "drop" }] }] }
  ] };
}
test("ordinary Dispatch edits remain available with an unchanged BIN assignment", () => {
  const before = sharedPlan(); const after = structuredClone(before);
  after.orders.push({ id: "SO2", type: "SO" });
  after.trucks[1].loads[0].stops.push({ id: "SO2", type: "drop" });
  assert.equal(assertOrdinaryDispatchPreservesBins(before, after), true);
});
test("malformed or split routes cannot bypass whole-visit sequencing or physical capacity", () => {
  assert.throws(() => binVisitGroups([{ id: "ordinary", type: "SO" }]), e => e.code === "MBT_BIN_LOAD_REQUIRED");
  assert.throws(() => sequenceBinVisit([], "missing", 1), e => e.code === "MBT_BIN_VISIT_NOT_ASSIGNED");
  for (const direction of [0, 2, NaN, "1"]) {
    assert.throws(() => sequenceBinVisit([], "missing", direction), e => e.code === "MBT_BIN_SEQUENCE_INVALID");
  }
  for (const movements of [
    [{ assetId: "a", delta: -1 }], [{ assetId: "a", delta: 2 }], [{ assetId: "a", delta: 0, weightLbs: 100 }],
    [{ assetId: "a", delta: 1, weightLbs: -1 }], [{ assetId: "a", delta: 1, weightLbs: NaN }],
    [{ assetId: "a", delta: 1, weightLbs: 1 }, { assetId: "a", delta: 1, weightLbs: 1 }]
  ]) {
    assert.throws(() => assertBinRouteCapacity([{ slotCapacity: 2, capacityLbs: 100, movements }]),
      e => e.code === "MBT_BIN_ROUTE_INVALID");
  }
});
test("derived Dispatch stop timing is discarded while the authoritative BIN snapshot stays exact", () => {
  const before = sharedPlan(); const next = structuredClone(before);
  next.trucks[0].loads[0].stops[0].timing = { arrival: 450, depart: 460 };
  next.trucks[0].loads[0].stops[0].loadId = "bin";
  const saved = preserveOrdinaryDispatchBins(before, next);
  assert.deepEqual(saved, before); assert.notEqual(saved.trucks[0].loads[0].stops, before.trucks[0].loads[0].stops);
});
test("BIN deletion, insertion, stop edits, driver/truck/time changes are protected", () => {
  const edits = [
    p => p.trucks.splice(0, 1),
    p => p.trucks[0].loads[0].stops.pop(),
    p => p.trucks[0].loads[0].stops.reverse(),
    p => { p.trucks[0].loads[0].stops[0].actionCode = "tampered"; },
    p => { p.trucks[0].driverLogin = "bob"; },
    p => { p.trucks[0].id = "3"; },
    p => { p.trucks[0].loads[0].plannedStartMinute = 600; },
    p => p.orders.push({ id: "injected", type: "BIN" })
  ];
  for (const edit of edits) {
    const before = sharedPlan(); const after = structuredClone(before); edit(after);
    assert.throws(() => assertOrdinaryDispatchPreservesBins(before, after),
      e => e.code === "MBT_BIN_PLANNING_REQUIRED" && e.status === 409);
  }
});
test("derived summary changes and unrelated truck ordering do not block Dispatch", () => {
  const before = sharedPlan(); const after = structuredClone(before);
  after.summary = { updated: true }; after.trucks.reverse();
  assert.equal(assertOrdinaryDispatchPreservesBins(before, after), true);
  assert.equal(assertOrdinaryDispatchPreservesBins({}, { orders: [{ type: "SO" }] }), true);
});
test("hydrating a driver's display name does not change the BIN assignment", () => {
  const before = sharedPlan(); const after = structuredClone(before);
  after.trucks[0].driver = "Alice Smith";
  assert.equal(assertOrdinaryDispatchPreservesBins(before, after), true);
});
test("drag sequencing places a whole visit before another visit", () => {
  const a = [stop("a", 1, "collect_empty_bin"), stop("a", 2, "deliver_bin")];
  const b = [stop("b", 1, "collect_empty_bin"), stop("b", 2, "deliver_bin")];
  const c = [stop("c", 1, "collect_empty_bin"), stop("c", 2, "deliver_bin")];
  assert.deepEqual(sequenceBinVisit([...a, ...b, ...c], "c", { beforeVisitId: "a" }), [...c, ...a, ...b]);
  assert.deepEqual(sequenceBinVisit([...a, ...b, ...c], "a", { beforeVisitId: "c" }), [...b, ...a, ...c]);
  assert.throws(() => sequenceBinVisit([...a, ...b], "a", { beforeVisitId: "missing" }), e => e.status === 409);
});
test("sequencing moves one complete visit without reversing or splitting stops", () => {
  const a = [stop("a", 1, "pick_empty_bin"), stop("a", 2, "drop_empty_bin")];
  const b = [stop("b", 1, "pick_loaded_bin"), stop("b", 2, "return_empty_bin")];
  const all = [...a, ...b];
  assert.deepEqual(sequenceBinVisit(all, "b", -1), [...b, ...a]);
  assert.deepEqual(all, [...a, ...b]);
  assert.deepEqual(sequenceBinVisit(all, "a", -1), all);
  assert.throws(() => sequenceBinVisit([a[0], ...b, a[1]], "a", 1),
    e => e.code === "MBT_BIN_LEG_SPLIT_FORBIDDEN");
});
test("one slot carries sequential complete visits without summing the day's bins", () => {
  const route = { truckId: "1", slotCapacity: 1, capacityLbs: 1000,
    movements: [{ assetId: "a", delta: 1, weightLbs: 600 }, { assetId: "a", delta: -1 },
      { assetId: "b", delta: 1, weightLbs: 800 }, { assetId: "b", delta: -1 }] };
  assert.equal(assertBinRouteCapacity([route]), true);
});
test("peak occupancy and weight fail even when all bins are eventually unloaded", () => {
  for (const constraints of [{ slotCapacity: 1, capacityLbs: 2000 }, { slotCapacity: 2, capacityLbs: 1000 }]) {
    assert.throws(() => assertBinRouteCapacity([{ truckId: "1", ...constraints,
      movements: [{ assetId: "a", delta: 1, weightLbs: 600 }, { assetId: "b", delta: 1, weightLbs: 600 },
        { assetId: "a", delta: -1 }, { assetId: "b", delta: -1 }] }]),
    e => e.code === "MBT_BIN_CAPACITY_EXCEEDED");
  }
});
test("dumping reduces payload weight while the empty bin still occupies a slot", () => {
  const movements = [{ assetId: "a", delta: 1, weightLbs: 900 }, { assetId: "a", delta: 0, weightLbs: 100 },
    { assetId: "b", delta: 1, weightLbs: 500 }, { assetId: "a", delta: -1 }, { assetId: "b", delta: -1 }];
  assert.equal(assertBinRouteCapacity([{ truckId: "1", slotCapacity: 2, capacityLbs: 1000, movements }]), true);
  assert.throws(() => assertBinRouteCapacity([{ truckId: "1", slotCapacity: 1, capacityLbs: 1000, movements }]),
    e => e.code === "MBT_BIN_CAPACITY_EXCEEDED");
});
