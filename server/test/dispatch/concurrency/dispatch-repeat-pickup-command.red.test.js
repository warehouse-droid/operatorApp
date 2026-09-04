import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDispatchPlanCommand,
  createDispatchCommandReceiptStore,
  digestDispatchPlan
} from "../../../src/dispatch-planner-performance.js";

function fixture() {
  return {
    id: 101,
    planDate: "2026-09-03",
    revision: 4,
    orders: ["A", "B", "C"].map((id) => ({ id, pickupLocations: ["3445"], address: `${id} address` })),
    trucks: [{ id: "T", loads: [{ id: "L", stops: [
      { id: "P", type: "pick", location: "3445", orderId: "A", orderRefs: ["A", "B", "C"] },
      ...["A", "B", "C"].map((id) => ({ id: `D-${id}`, type: "drop", orderId: id, orderRefs: [id] }))
    ] }] }]
  };
}

test("RP-09 only one same-revision pickup split delta can win", () => {
  const source = fixture();
  const baseDigest = digestDispatchPlan(source);
  const command = (commandId, newStopId, movedRef) => ({
    commandId,
    baseRevision: 4,
    baseDigest,
    type: "split_pickup_visit",
    payload: {
      actionName: "split_pickup_visit",
      affectedOrderRefs: [movedRef],
      planDelta: {
        t: [{ ...source.trucks[0], loads: [{ ...source.trucks[0].loads[0], stops: [
          { ...source.trucks[0].loads[0].stops[0], orderRefs: ["A", "B", "C"].filter((ref) => ref !== movedRef) },
          { id: newStopId, type: "pick", location: "3445", orderId: movedRef, orderRefs: [movedRef] },
          ...source.trucks[0].loads[0].stops.slice(1)
        ] }] }]
      }
    }
  });
  const receipts = createDispatchCommandReceiptStore();
  const winner = applyDispatchPlanCommand({ plan: source, command: command("browser-a", "P-A", "C"), receiptStore: receipts });
  assert.equal(winner.revision, 5);
  assert.equal(winner.patch.actionName, "split_pickup_visit");
  assert.throws(
    () => applyDispatchPlanCommand({ plan: winner.plan, command: command("browser-b", "P-B", "B"), receiptStore: receipts }),
    (error) => error.code === "STALE_DISPATCH_PLAN"
  );
  assert.deepEqual(winner.plan.trucks[0].loads[0].stops.filter((stop) => stop.type === "pick").map((stop) => stop.id), ["P", "P-A"]);
});
