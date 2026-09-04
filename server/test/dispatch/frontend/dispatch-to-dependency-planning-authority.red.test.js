import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);
const dependencyRepositorySource = await readFile(
  new URL("../../../src/order-dependency-repository.js", import.meta.url),
  "utf8"
);

function sourceFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const parametersOpen = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < source.length; index += 1) {
    if (source[index] === "(") {parameterDepth += 1;}
    if (source[index] === ")") {parameterDepth -= 1;}
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  const open = source.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {depth += 1;}
    if (source[index] === "}") {depth -= 1;}
    if (!depth) {return source.slice(start, index + 1);}
  }
  throw new Error(`Could not read ${name}.`);
}

const placementBlockSource = sourceFunctionBody(
  dispatchSource,
  "replenishmentPlacementBlockMessage"
);
const comparePlanDateSource = sourceFunctionBody(dispatchSource, "comparePlanDate");

const evaluatePlacement = Function(
  "authoritativeAssignments",
  "dependencyOverrides",
  `"use strict";
    const currentPlanDate = "2026-09-02";
    const assignmentsByRef = new Map(
      authoritativeAssignments.map((assignment) => [
        String(assignment.orderRef || "").trim().toUpperCase(),
        assignment
      ])
    );
    function dispatchPlannedAssignment(orderRef) {
      return assignmentsByRef.get(String(orderRef || "").trim().toUpperCase()) || null;
    }
    function orderById() { return null; }
    function orderAssignment() { return {}; }
    function replenishmentDependencyComplete() { return false; }
    function replenishmentTransferCompletionInLoad() { return null; }
    function replenishmentLoadPrecedence() { return null; }
    ${comparePlanDateSource}
    ${placementBlockSource}
    const order = {
      id: "SOA07771",
      orderDependencies: [{
        mode: "yard_replenishment",
        status: "active",
        transferOrderRef: "TOB00985",
        transferDispatchPlanned: false,
        transferDispatchPlanDate: "",
        plannedPlanId: null,
        plannedDate: null,
        ...dependencyOverrides
      }]
    };
    return replenishmentPlacementBlockMessage(
      order,
      { id: "tomorrow-truck", loads: [] },
      { id: "tomorrow-load", stops: [] }
    );`
);

test("a prior Dispatch assignment overrides stale dependency-card planning metadata", () => {
  const message = evaluatePlacement([{
    orderRef: "TOB00985",
    dispatchPlanId: "264",
    dispatchPlanDate: "2026-08-31"
  }], {});

  assert.equal(
    message,
    "",
    "tomorrow planning must use the authoritative assignment projection and must not wait for Driver completion"
  );
});

test("same-day or absent TO placement still blocks when route precedence cannot be proved", () => {
  assert.match(
    evaluatePlacement([{
      orderRef: "TOB00985",
      dispatchPlanId: "266",
      dispatchPlanDate: "2026-09-02"
    }], {}),
    /requires TOB00985 to be planned before this delivery/u
  );
  assert.match(
    evaluatePlacement([], {}),
    /requires TOB00985 to be planned before this delivery/u
  );
});

test("server prior-plan validation reads the assignment projection including aliases", () => {
  const body = sourceFunctionBody(dependencyRepositorySource, "priorPlannedTransferRefs");
  assert.match(body, /dispatch_plan_order_assignments/u);
  assert.match(body, /planned_order_ref/u);
  assert.doesNotMatch(body, /jsonb_array_elements/u);
});
