import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { dispatchPlanAssignmentRows } from "../../../src/dispatch-planner-v2-repository.js";
import { assignment, fixtureHarness, planFor } from "../../support/dispatch-split-date-conflict-harness.mjs";

const markers = [{ type: "CUSTOM" }, { type: "", customOrder: true }, { type: "", sourceTable: "dispatch_custom_orders" }];
function collectionPlan(parent, marker = markers[0], grouped = false) {
  const ref = `${parent}-Return`;
  const plan = planFor(ref, { grouped });
  const order = grouped ? plan.orders[0].childOrderDetails[0] : plan.orders[0];
  Object.assign(order, marker, { parentOrderRef: parent, originalOrderId: parent });
  return plan;
}

for (const [index, marker] of markers.entries()) {
  test(`custom marker ${index}: a return is independent of its earlier delivery`, async () => {
    const plan = collectionPlan("SOR00221", marker);
    assert.deepEqual(await fixtureHarness([assignment("SOR00221")]).conflicts(plan), []);
    assert.deepEqual(await fixtureHarness([assignment("SOR00221")]).newlyPlanned({ orders: [], trucks: [] }, plan), []);
  });
  test(`custom marker ${index}: a return projection reserves only the return`, () => {
    const rows = dispatchPlanAssignmentRows(collectionPlan("SOR00221-S1", marker));
    assert.deepEqual(rows.map(row => [row.orderRef, row.assignmentKind]), [["SOR00221-S1-Return", "direct"]]);
  });
}

test("grouped returns remain independent and keep their exact duplicate protection", async () => {
  const plan = collectionPlan("SOR00221-S1", markers[0], true);
  assert.deepEqual(await fixtureHarness([assignment("SOR00221-S1")]).conflicts(plan), []);
  const rows = dispatchPlanAssignmentRows(plan);
  assert.equal(rows.some(row => row.orderRef === "SOR00221-S1"), false);
  assert.equal(rows.find(row => row.orderRef === "SOR00221-S1-Return").assignmentKind, "group_member");
  const conflict = await fixtureHarness([assignment("SOR00221-S1-Return")]).conflicts(plan);
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].orderRef, "SOR00221-S1-Return");
});

test("genuine explicit and inferred splits retain parent aliases and whole-parent conflicts", async () => {
  for (const metadata of [{ originalOrderId: "SOR00221" }, { parentOrderRef: "SOR00221" }, {}]) {
    const plan = planFor("SOR00221-S1");
    Object.assign(plan.orders[0], metadata);
    assert.equal(dispatchPlanAssignmentRows(plan).find(row => row.orderRef === "SOR00221").assignmentKind, "split_parent_alias");
    const conflicts = await fixtureHarness([assignment("SOR00221")]).conflicts(plan);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].orderRef, "SOR00221-S1");
  }
});

test("unassigned returns and return-only loads reserve no work", async () => {
  const plan = collectionPlan("SOR00221");
  const unassigned = { ...plan, trucks: [] };
  assert.deepEqual(dispatchPlanAssignmentRows(unassigned), []);
  plan.trucks[0].loads[0].returnOnly = true;
  plan.trucks[0].loads[0].stops = [{ id: "yard-return", type: "return", location: "3445" }];
  assert.deepEqual(dispatchPlanAssignmentRows(plan), []);
  assert.deepEqual(await fixtureHarness([assignment("SOR00221-Return")]).conflicts(plan), []);
});

test("property: linked custom returns stay independent while duplicate and genuine split guards remain", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 99999 }), fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: 0, max: markers.length - 1 }), fc.boolean(), fc.boolean(), async (id, split, index, grouped, lower) => {
      const parent = `SOR${String(id).padStart(5, "0")}${split ? `-S${split}` : ""}`;
      const plan = collectionPlan(parent, markers[index], grouped);
      const normalize = ref => lower ? ref.toLowerCase() : ref;
      assert.deepEqual(await fixtureHarness([assignment(normalize(parent))]).conflicts(plan), []);
      assert.equal(dispatchPlanAssignmentRows(plan).some(row => row.orderRef.toLowerCase() === parent.toLowerCase()), false);
      const duplicate = await fixtureHarness([assignment(normalize(`${parent}-Return`))]).conflicts(plan);
      assert.equal(duplicate.length, 1);
      assert.equal(duplicate[0].orderRef, `${parent}-Return`);
      const realSplit = planFor(`${parent}-S99`, { parent });
      assert.equal(dispatchPlanAssignmentRows(realSplit).find(row => row.orderRef === parent).assignmentKind, "split_parent_alias");
      assert.equal((await fixtureHarness([assignment(normalize(parent))]).conflicts(realSplit)).length, 1);
    }), { seed: 20261014, numRuns: 100 });
});
