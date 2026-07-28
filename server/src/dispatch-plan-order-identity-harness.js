import assert from "node:assert/strict";
import {
  dispatchPlannedAssignmentMap,
  dispatchPlannedOrderConflictRefs,
  dispatchPlannedOrderRefs
} from "./dispatch-plan-repository.js";

function planWithDrop(orderId, orders, { planId = "PLAN-A", planDate = "2026-07-22" } = {}) {
  return {
    id: planId,
    planDate,
    orders,
    trucks: [{
      id: "TRUCK-1",
      plate: "TEST-1",
      loads: [{
        id: "LOAD-1",
        name: "Load 1",
        stops: [{ id: `${orderId}-DROP`, type: "drop", orderId }]
      }]
    }]
  };
}

const splitOrders = [
  { id: "SOA05680-S1", type: "SO", originalOrderId: "SOA05680" },
  { id: "SOA05680-S2", type: "SO", originalOrderId: "SOA05680" }
];
const splitOnePlan = planWithDrop("SOA05680-S1", splitOrders);
const splitTwoPlan = planWithDrop("SOA05680-S2", splitOrders, {
  planId: "PLAN-B",
  planDate: "2026-07-24"
});
const splitOneRefs = dispatchPlannedOrderRefs(splitOnePlan);
const splitTwoRefs = dispatchPlannedOrderRefs(splitTwoPlan);

assert.deepEqual([...splitOneRefs], ["SOA05680-S1"]);
assert.deepEqual([...splitTwoRefs], ["SOA05680-S2"]);
assert.equal(
  [...splitOneRefs].some((ref) => splitTwoRefs.has(ref)),
  false,
  "Planning one split segment must not reserve its parent or block a sibling segment."
);
assert.deepEqual(
  [...dispatchPlannedOrderConflictRefs(splitTwoPlan, splitOnePlan)],
  [],
  "Different split segments must be independently plannable across dates."
);

const splitAssignments = dispatchPlannedAssignmentMap(splitOnePlan);
assert.equal(splitAssignments.has("SOA05680-S1"), true);
assert.equal(splitAssignments.has("SOA05680"), false);
assert.equal(splitAssignments.has("SOA05680-S2"), false);
assert.equal(splitAssignments.get("SOA05680-S1")?.plannedOrderRef, "SOA05680-S1");

const groupedPlan = planWithDrop("GROUP-1", [
  {
    id: "GROUP-1",
    type: "SO",
    childOrders: ["SOA05680-S1", "SO-OTHER"],
    childOrderDetails: [
      { id: "SOA05680-S1", type: "SO", originalOrderId: "SOA05680" },
      {
        id: "SO-OTHER",
        type: "SO",
        childOrders: ["SO-NESTED"],
        childOrderDetails: [{ id: "SO-NESTED", type: "SO" }]
      }
    ]
  },
  ...splitOrders
]);
const groupedRefs = dispatchPlannedOrderRefs(groupedPlan);

assert.deepEqual(
  [...groupedRefs],
  ["GROUP-1", "SOA05680-S1", "SO-OTHER", "SO-NESTED"],
  "A group must reserve its exact nested members."
);
assert.equal(groupedRefs.has("SOA05680"), false, "A grouped split must not reserve the split parent.");
assert.equal(groupedRefs.has("SOA05680-S2"), false, "A grouped split must not reserve a sibling segment.");
assert.equal(groupedRefs.has("SO-NESTED"), true);

const duplicateSplitOneRefs = dispatchPlannedOrderRefs(
  planWithDrop("SOA05680-S1", splitOrders, { planId: "PLAN-C", planDate: "2026-07-25" })
);
const duplicateSplitOnePlan = planWithDrop(
  "SOA05680-S1",
  splitOrders,
  { planId: "PLAN-C", planDate: "2026-07-25" }
);
assert.equal(
  [...splitOneRefs].some((ref) => duplicateSplitOneRefs.has(ref)),
  true,
  "The exact same split segment must remain blocked on another date."
);
assert.deepEqual([...dispatchPlannedOrderConflictRefs(duplicateSplitOnePlan, splitOnePlan)], ["SOA05680-S1"]);
assert.equal(
  [...groupedRefs].some((ref) => splitOneRefs.has(ref)),
  true,
  "A split segment already consumed by a group must remain blocked independently."
);
assert.deepEqual([...dispatchPlannedOrderConflictRefs(groupedPlan, splitOnePlan)], ["SOA05680-S1"]);

const unsplitParentPlan = planWithDrop("SOA05680", [{ id: "SOA05680", type: "SO" }], {
  planId: "PLAN-PARENT",
  planDate: "2026-07-20"
});
assert.deepEqual(
  [...dispatchPlannedOrderConflictRefs(splitTwoPlan, unsplitParentPlan)],
  ["SOA05680-S2"],
  "A split segment must still conflict with an already-planned unsplit parent."
);
assert.deepEqual(
  [...dispatchPlannedOrderConflictRefs(unsplitParentPlan, splitTwoPlan)],
  ["SOA05680"],
  "An unsplit parent must still conflict with an already-planned split segment."
);

console.log("Dispatch planning identity checks passed.");
