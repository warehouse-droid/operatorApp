import fs from "node:fs";
import vm from "node:vm";
import { dispatchPlannedOrderRefs } from "../../src/dispatch-plan-repository.js";

export function conflictHarness(listAssignments, source = fs.readFileSync(new URL("../../src/server.js", import.meta.url), "utf8")) {
  const start = source.indexOf("function dispatchSplitParentRefs(");
  const end = source.indexOf("function dispatchDateCompare(", start);
  if (start < 0 || end <= start) { throw new Error("Dispatch conflict implementation was not found"); }
  const context = vm.createContext({ dispatchPlannedOrderRefs, listDispatchPlanOrderAssignmentsProjection: listAssignments });
  vm.runInContext(source.slice(start, end), context, {
    filename: new URL("../../src/server.js", import.meta.url).pathname,
    lineOffset: source.slice(0, start).split("\n").length - 1
  });
  return {
    conflicts: async plan => JSON.parse(JSON.stringify(await context.findDispatchPlanDateConflictsFromProjection(plan))),
    newlyPlanned: async (before, after) => JSON.parse(JSON.stringify(await context.findNewDispatchPlanDateConflicts(before, after)))
  };
}

export function planFor(ref, { parent = "", type = "SO", grouped = false } = {}) {
  const child = { id: ref, type, ...(parent ? { originalOrderId: parent } : {}) };
  const order = grouped ? { id: "GO-TARGET", type, childOrders: [ref], childOrderDetails: [child] } : child;
  return { id: "329", planId: "329", planDate: "2026-09-17", orders: [order],
    trucks: [{ id: "T4", loads: [{ id: "load-target", stops: [{ id: "drop-target", type: "drop", orderId: order.id }] }] }] };
}

export function assignment(orderRef, kind = "direct", overrides = {}) {
  return { orderRef, assignmentKind: kind, plannedOrderRef: orderRef, planId: "322", planDate: "2026-09-10", status: "confirmed", ...overrides };
}

export function fixtureHarness(rows, source) {
  return conflictHarness(async ({ orderRefs, excludePlanId, excludePlanDate }) => rows.filter(row =>
    orderRefs.some(ref => ref.toLowerCase() === row.orderRef.toLowerCase())
    && row.planId !== excludePlanId && row.planDate !== excludePlanDate
  ), source);
}
