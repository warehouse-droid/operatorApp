import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { changedDriverActivityAssignments } from "../../../src/dispatch-load-assignment.js";
import { activityAllocationScopeFixture } from "../../support/dispatch-activity-allocation-scope-fixture.mjs";

const policy = fixture => evaluateExecutedPrefixPolicy(fixture);
const group = plan => plan.orders.find(order => order.id === "GOA-8111-8113");

test("CO-SOM06255-S1 may be appended when an unrelated unassigned CO disappears", () => {
  const fixture = activityAllocationScopeFixture();
  const before = structuredClone(fixture);
  assert.deepEqual(policy(fixture), { allowed: true, conflicts: [] });
  assert.deepEqual(changedDriverActivityAssignments(fixture.previousPlan, fixture.nextPlan, fixture.activity), []);
  assert.deepEqual(fixture, before);
});

test("refreshing or adding an unassigned related CO does not lock the executed group", () => {
  for (const operation of ["refresh", "add"]) {
    const fixture = activityAllocationScopeFixture();
    fixture.nextPlan = structuredClone(fixture.previousPlan);
    if (operation === "add") { fixture.previousPlan.orders.shift(); }
    fixture.nextPlan.orders[0].items[0].quantity += 10;
    assert.equal(policy(fixture).allowed, true, operation);
  }
});

test("related CO cargo on a later load remains editable", () => {
  const fixture = activityAllocationScopeFixture();
  fixture.previousPlan.trucks[0].loads.push({ id: "co-later", driverSequence: 1,
    stops: [{ id: "co-drop", type: "drop", orderId: "CO-GOA-8111-8113" }] });
  fixture.nextPlan = structuredClone(fixture.previousPlan);
  fixture.nextPlan.orders[0].items[0].quantity += 10;
  assert.equal(policy(fixture).allowed, true);
});

test("completed COs, groups and nested allocations still reject real changes", () => {
  for (const field of ["quantity", "itemId", "destinationYard", "childQuantity", "missingOrder", "assignedCo", "nestedChild", "stopAlias"]) {
    const fixture = activityAllocationScopeFixture();
    fixture.previousPlan.orders.shift();
    if (field === "assignedCo") { group(fixture.previousPlan).type = "CO"; }
    if (field === "nestedChild") { fixture.previousPlan.trucks[0].loads[0].stops.forEach(stop => {
      stop.orderId = "SOA08111";
      if (stop.orderRefs) { stop.orderRefs = ["SOA08111"]; }
    }); }
    if (field === "stopAlias") { fixture.previousPlan.trucks[0].loads[0].stops.forEach(stop => {
      stop.orderRef = stop.orderId;
      delete stop.orderId;
      delete stop.orderRefs;
    }); }
    fixture.nextPlan = structuredClone(fixture.previousPlan);
    const nextGroup = group(fixture.nextPlan);
    if (field === "missingOrder") { fixture.nextPlan.orders = []; }
    else if (["childQuantity", "nestedChild"].includes(field)) { nextGroup.childOrderDetails[0].items[0].quantity += 1; }
    else { nextGroup.items[0][field === "assignedCo" || field === "stopAlias" ? "quantity" : field] = field === "destinationYard" ? "150" : 99; }
    assert.equal(policy(fixture).allowed, false, field);
    assert.ok(changedDriverActivityAssignments(fixture.previousPlan, fixture.nextPlan, fixture.activity)
      .some(change => change.reasons.includes("order_allocation")), field);
  }
});

test("every secondary order in a consolidated pickup remains protected", () => {
  const fixture = activityAllocationScopeFixture();
  fixture.previousPlan.orders.shift();
  const second = { id: "SO-SECOND", type: "SO", sourceYard: "3445", items: [{ itemId: 3, quantity: 4 }] };
  fixture.previousPlan.orders.push(second);
  const pickup = fixture.previousPlan.trucks[0].loads[0].stops[0];
  pickup.orderRefs.push(second.id);
  fixture.activity = [{ ...fixture.activity[0], order_refs: [...fixture.activity[0].order_refs, second.id] }];
  fixture.nextPlan = structuredClone(fixture.previousPlan);
  fixture.nextPlan.orders[1].items[0].quantity += 1;
  assert.equal(policy(fixture).allowed, false);
  assert.deepEqual(changedDriverActivityAssignments(fixture.previousPlan, fixture.nextPlan, fixture.activity)[0].reasons, ["order_allocation"]);
});

test("route and driver identity changes still fail even when unassigned catalog rows are removed", () => {
  for (const mutate of [
    load => { load.stops.reverse(); },
    load => { load.stops.pop(); },
    load => { load.stops[0].location = "150"; },
    load => { load.driverLogin = "someone-else"; }
  ]) {
    const fixture = activityAllocationScopeFixture();
    mutate(fixture.nextPlan.trucks[0].loads[0]);
    assert.equal(policy(fixture).allowed, false);
  }
});

test("property: only actual executed cargo changes block suffix edits across related catalog churn", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }),
    fc.boolean(), fc.boolean(), (quantity, delta, cargoChanged, inProgress) => {
      const fixture = activityAllocationScopeFixture({ quantity, status: inProgress ? "in_progress" : "complete" });
      if (cargoChanged) { group(fixture.nextPlan).childOrderDetails[0].items[0].quantity += delta; }
      assert.equal(policy(fixture).allowed, !cargoChanged);
      assert.equal(changedDriverActivityAssignments(fixture.previousPlan, fixture.nextPlan, fixture.activity).length, cargoChanged ? 1 : 0);
    }), { seed: 20260914, numRuns: 100 });
});

test("property: secondary pickup refs and exact nested children retain their cargo protection", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.integer({ min: 1, max: 1000 }),
    (nested, cargoChanged, quantity) => {
      const fixture = activityAllocationScopeFixture({ quantity });
      fixture.previousPlan.orders.shift();
      fixture.activity = [fixture.activity[0]];
      const pickup = fixture.previousPlan.trucks[0].loads[0].stops[0];
      if (nested) {
        pickup.orderId = "SOA08111";
        pickup.orderRefs = ["SOA08111"];
        fixture.previousPlan.trucks[0].loads[0].stops.pop();
      } else {
        fixture.previousPlan.orders.push({ id: "SECONDARY", type: "SO", sourceYard: "3445",
          items: [{ itemId: 3, quantity }] });
        pickup.orderRefs.push("SECONDARY");
        fixture.activity[0].order_refs.push("SECONDARY");
      }
      fixture.nextPlan = structuredClone(fixture.previousPlan);
      if (cargoChanged) {
        const target = nested ? group(fixture.nextPlan).childOrderDetails[0] : fixture.nextPlan.orders[1];
        target.items[0].quantity += 1;
      }
      assert.equal(policy(fixture).allowed, !cargoChanged);
      assert.equal(changedDriverActivityAssignments(fixture.previousPlan, fixture.nextPlan, fixture.activity).length, cargoChanged ? 1 : 0);
    }), { seed: 20260915, numRuns: 60 });
});
