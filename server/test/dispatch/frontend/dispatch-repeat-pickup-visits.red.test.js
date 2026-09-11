import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);
const dispatchHtml = await readFile(
  new URL("../../../public/dispatch.html", import.meta.url),
  "utf8"
);
const legacyRepositorySource = await readFile(
  new URL("../../../src/dispatch-plan-repository.js", import.meta.url),
  "utf8"
);
const commandRepositorySource = await readFile(
  new URL("../../../src/dispatch-planner-v2-repository.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = dispatchSource.indexOf(marker);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const signatureEnd = dispatchSource.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `Could not read ${name} signature.`);
  const open = signatureEnd + 2;
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {depth += 1;}
    if (dispatchSource[index] === "}") {depth -= 1;}
    if (!depth) {return dispatchSource.slice(start, index + 1);}
  }
  throw new Error(`Could not read ${name}.`);
}

test("RP-01/RP-02 dispatcher allocates each order to one editable pickup occurrence", () => {
  assert.match(functionBody("pickupOrdersForStop"), /pickupStopOrderRefs/);
  assert.match(functionBody("pickupStopOrderRefs"), /stop\.orderRefs/);
  assert.match(functionBody("makePickupStop"), /orderRefs:\s*\[order\.id\]/);
  assert.match(functionBody("ensurePickupStops"), /dispatchEditableRouteBoundary/);
  assert.match(functionBody("ensurePickupStops"), /pickupStopIncludesOrder/);
  assert.match(functionBody("ensurePickupStops"), /stopHasDriverActivity/);
  assert.match(functionBody("ensurePickupStops"), /activateSchema/);
  assert.match(functionBody("enablePickupVisitSchema"), /pickupVisitSchemaVersion\s*=\s*1/);
  assert.match(functionBody("planPayload"), /pickupVisitSchemaVersion/);
});

test("RP-02 late-order placement respects active travel and an exact future customer visit", () => {
  const boundary = functionBody("dispatchEditableRouteBoundary");
  assert.match(boundary, /driverActivityDetails/);
  assert.match(functionBody("driverActivityDetails"), /job_details|jobDetails/);
  assert.match(boundary, /toStopId|to_stop_id/);
  const placement = functionBody("lateOrderRoutePlacement");
  assert.match(placement, /samePhysicalAddress/);
  assert.match(placement, /dispatchEditableRouteBoundary/);
  assert.match(functionBody("addOrderToLoad"), /lateOrderRoutePlacement/);
});

test("RP-04 manual pickup split is whole-order, future-only, and persisted semantically", () => {
  assert.match(functionBody("canSplitPickupVisit"), /stopHasDriverActivity/);
  assert.match(functionBody("splitPickupVisit"), /orderRefs/);
  assert.match(functionBody("splitPickupVisit"), /enablePickupVisitSchema/);
  assert.match(dispatchSource, /data-action="open-pickup-visit-split"/);
  assert.match(dispatchSource, /data-form="pickup-visit-split"/);
  assert.match(dispatchSource, /commitPlanMutation\("split_pickup_visit"/);
  assert.match(functionBody("dispatchSemanticCommandType"), /split_pickup_visit/);
});

test("RP-08 sequence, timing, capacity, labels, and tooltips use visit-scoped orders", () => {
  assert.match(functionBody("sequenceWarningsForStops"), /pickupOrdersForStop/);
  assert.match(functionBody("pickupFootprintForStop"), /pickupOrdersForStop/);
  assert.match(functionBody("loadStats"), /pickedOrderLocations/);
  assert.match(dispatchSource, /Visit \$\{visitNumber\}\/\$\{visitCount\}/);
  assert.match(dispatchSource, /pickupOrdersForStop\(foundStop\.load, stop\)/);
  assert.match(dispatchHtml, /dispatch\.css\?v=20260903-repeat-pickup-visits-v1/);
  assert.match(dispatchHtml, /dispatch\.js\?v=20260911-maps-usage-v1/);
});

test("RP-06 save paths preserve untouched legacy loads and validate opted-in loads", () => {
  assert.match(legacyRepositorySource, /materializeDispatchPickupVisits\(sanitizedPlan,[\s\S]*allowLegacyPassthrough:\s*true/);
  assert.match(legacyRepositorySource, /materializeDispatchPickupVisits\(canonicalPlan,[\s\S]*allowLegacyPassthrough:\s*true/);
  assert.match(commandRepositorySource, /materializeDispatchPickupVisits\(result\.plan,[\s\S]*allowLegacyPassthrough:\s*true/);
});
