import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { changedDriverActivityAssignments } from "../../../src/dispatch-load-assignment.js";

function scenario(status = "complete", alias = "dropWeight") {
  const child = { id: "SOB121261", weight: 7744.966, address: "Recorded destination",
    items: [{ lineId: 1, itemId: 2883, quantity: 54.18, unit: "SQFT", pallets: 1, itemWeight: 22.59, lineWeight: 1223.9262 }] };
  const group = { id: "GOB-121261-121262", weight: 8784.966, address: child.address,
    childOrders: [child.id], childOrderDetails: [child], items: structuredClone(child.items) };
  const previousPlan = { orders: [group], trucks: [{ id: "T5", plate: "CC46868", loads: [{ id: "load", name: "Load 1",
    driverLogin: "li", driverName: "Li", truckId: "T5", truckPlate: "CC46868", driverSequence: 0,
    stops: [{ id: "pick", type: "pick", orderId: group.id, location: "3445", [alias]: group.weight },
      { id: "drop", type: "drop", orderId: group.id, location: group.address, [alias]: group.weight,
        timing: { arrival: 459, depart: 521 } }] }] }] };
  return { previousPlan, nextPlan: structuredClone(previousPlan), activity: [{ status, load_id: "load", stop_id: "drop", stop_type: "drop" }] };
}

function weightUpdate(input, value, alias) {
  const group = input.nextPlan.orders[0];
  group.weight = value; group.childOrderDetails[0].weight = value;
  for (const order of [group, ...group.childOrderDetails]) {
    for (const item of order.items) { item.itemWeight = value; item.lineWeight = value; }
  }
  for (const stop of input.nextPlan.trucks[0].loads[0].stops) { stop[alias] = value; }
}

for (const alias of ["weight", "dropWeight"]) {
  test(`weight-only ${alias} changes never lock executed work and do not mutate either plan`, () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100000000 }), fc.constantFrom("complete", "in_progress"), (value, status) => {
      const input = scenario(status, alias);
      weightUpdate(input, value / 1000, alias);
      const original = structuredClone(input);
      assert.deepEqual(changedDriverActivityAssignments(input.previousPlan, input.nextPlan, input.activity), []);
      assert.equal(evaluateExecutedPrefixPolicy(input).allowed, true);
      assert.deepEqual(input, original);
    }), { seed: 29092026, numRuns: 80 });
  });
}

test("unrelated executed-work errors omit group, child and stop weight differences", () => {
  const input = scenario();
  weightUpdate(input, 8984.966, "dropWeight");
  input.nextPlan.trucks[0].loads[0].plannedStartMinute = 500;
  const result = evaluateExecutedPrefixPolicy(input);
  assert.equal(result.allowed, false);
  assert.ok(result.conflicts.some(conflict => conflict.changes.some(change => change.field === "plannedStartMinute")));
  assert.doesNotMatch(JSON.stringify(result.conflicts), /"field":"(?:weight|dropWeight)"|weight:/iu);
});

test("weight-only order changes already pass when physical stops are unchanged", () => {
  const input = scenario();
  input.nextPlan.orders[0].weight = 8784.966199999999;
  input.nextPlan.orders[0].childOrderDetails[0].weight = 7744.9662;
  assert.equal(evaluateExecutedPrefixPolicy(input).allowed, true);
});

test("weight exceptions preserve quantity, pallets, identity, destination, timing and sequence locks", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000000 }), fc.constantFrom("quantity", "pallets", "itemId", "destination", "arrival", "sequence"), (weight, edit) => {
    const input = scenario();
    weightUpdate(input, weight, "dropWeight");
    const group = input.nextPlan.orders[0]; const load = input.nextPlan.trucks[0].loads[0];
    if (["quantity", "pallets", "itemId"].includes(edit)) {group.childOrderDetails[0].items[0][edit] += 1;}
    if (edit === "destination") {load.stops[1].location = "Different destination";}
    if (edit === "arrival") {load.stops[1].timing.arrival += 1;}
    if (edit === "sequence") {
      const future = { ...structuredClone(load), id: "future", driverSequence: 1, stops: [] };
      input.previousPlan.trucks[0].loads.push(structuredClone(future));
      input.nextPlan.trucks[0].loads.push(future);
      load.driverSequence = 2;
    }
    const result = evaluateExecutedPrefixPolicy(input);
    assert.equal(result.allowed, false, edit);
    assert.ok(result.conflicts.some(conflict => conflict.changes.some(change => !["weight", "dropWeight"].includes(change.field))), edit);
  }), { seed: 29092026, numRuns: 120 });
});

test("Li's 0,1,3 to 0,1,2 renumbering preserves actual load order for started and completed work", () => {
  for (const status of ["in_progress", "complete"]) {
    const input = scenario(status);
    const load = input.previousPlan.trucks[0].loads[0];
    const loads = [0, 1, 3].map((driverSequence, index) => ({ ...structuredClone(load), id: `load-${index}`, driverSequence }));
    input.previousPlan.trucks[0].loads = loads;
    input.nextPlan = structuredClone(input.previousPlan);
    input.nextPlan.trucks[0].loads.forEach((row, index) => { row.driverSequence = index; });
    input.activity[0].load_id = "load-2";
    const original = structuredClone(input);
    assert.equal(evaluateExecutedPrefixPolicy(input).allowed, true);
    assert.deepEqual(input, original);
    input.nextPlan.trucks[0].loads[2].driverSequence = -1;
    input.nextPlan.trucks[0].loads[0].driverSequence = 9;
    assert.equal(evaluateExecutedPrefixPolicy(input).allowed, false);
  }
});

test("unstarted later loads and stops may move, but cannot move before the in-progress stop", () => {
  const input = scenario("in_progress");
  const load = input.previousPlan.trucks[0].loads[0];
  load.stops.push({ id: "later-a", type: "drop", orderId: "LATER-A" }, { id: "later-b", type: "drop", orderId: "LATER-B" });
  input.previousPlan.trucks[0].loads.push({ ...structuredClone(load), id: "future-a", driverSequence: 1, stops: [] },
    { ...structuredClone(load), id: "future-b", driverSequence: 2, stops: [] });
  input.nextPlan = structuredClone(input.previousPlan);
  const [started, laterA, laterB] = input.nextPlan.trucks[0].loads;
  laterA.driverSequence = 2; laterB.driverSequence = 1;
  [started.stops[2], started.stops[3]] = [started.stops[3], started.stops[2]];
  assert.equal(evaluateExecutedPrefixPolicy(input).allowed, true);
  [started.stops[1], started.stops[2]] = [started.stops[2], started.stops[1]];
  assert.equal(evaluateExecutedPrefixPolicy(input).allowed, false);
});

test("closing sequence gaps in earlier completed loads never changes the protected route", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 1000 }), fc.constantFrom("complete", "in_progress"), (gap, status) => {
    const input = scenario(status);
    const template = input.previousPlan.trucks[0].loads[0];
    input.previousPlan.trucks[0].loads = [0, gap, gap + 1].map((driverSequence, index) => ({
      ...structuredClone(template), id: `sequence-${index}`, driverSequence
    }));
    input.nextPlan = structuredClone(input.previousPlan);
    input.nextPlan.trucks[0].loads.forEach((load, index) => { load.driverSequence = index; });
    input.activity[0].load_id = "sequence-2";
    assert.equal(evaluateExecutedPrefixPolicy(input).allowed, true);
    const loads = input.nextPlan.trucks[0].loads;
    [loads[0].driverSequence, loads[1].driverSequence] = [loads[1].driverSequence, loads[0].driverSequence];
    assert.equal(evaluateExecutedPrefixPolicy(input).allowed, false);
  }), { seed: 29092026, numRuns: 80 });
});
