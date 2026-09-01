// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [ui, server, dispatchRepository, db] = await Promise.all([
  readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/server.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/dispatch-repository.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/db.js", import.meta.url), "utf8")
]);

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const parametersOpen = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] === ")") parameterDepth -= 1;
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  assert.notEqual(parametersClose, -1, `${name} parameters are incomplete`);
  const brace = source.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

test("WL-18 Dispatch initial/search pool requests 200 bounded cards", () => {
  const load = functionBody(ui, "loadDispatchOrders");
  assert.match(load, /limit:\s*["']200["']/u);
  const search = functionBody(ui, "loadDispatchOrderSearch");
  assert.match(search, /limit:\s*["']200["']/u);
});

test("WL-19 planned assignment request path never falls back to scanning snapshot documents", () => {
  const resolver = functionBody(server, "dispatchPlannedAssignmentsFromSnapshots");
  assert.match(resolver, /dispatchPlannedAssignmentsFromProjection/u);
  assert.doesNotMatch(resolver, /dispatchPlannedAssignmentsFromLegacySnapshots/u);
  assert.doesNotMatch(resolver, /listDispatchSnapshotPlanRows/u);
});

test("WL-20 historical plan summary listing stays metadata-only", () => {
  const routeStart = server.indexOf('app.get("/api/dispatch/plans"');
  assert.notEqual(routeStart, -1);
  const route = server.slice(routeStart, routeStart + 500);
  assert.match(route, /listDispatchPlans/u);
  assert.doesNotMatch(route, /snapshot|orders|trucks/u);
});

test("WL-31 targeted catalog refreshes constrain source orders before feed aggregation", () => {
  const targeted = functionBody(server, "targetedDispatchMutationOrders");
  assert.match(targeted, /exactOrderRefs:\s*\[search\]/u);
  const logicalRefs = functionBody(server, "dispatchOrderLogicalRefs");
  assert.match(logicalRefs, /order\.netsuiteId/u);
  const searchMatcher = functionBody(server, "dispatchOrderMatchesSearch");
  assert.match(searchMatcher, /order\.netsuiteId/u);
  const restrictedRefs = functionBody(server, "listRestrictedScmDispatchOrderRefs");
  assert.match(restrictedRefs, /exactOrderRefs\s*=\s*\[\]/u);
  const snapshotDerived = functionBody(server, "listDispatchSnapshotDerivedOrders");
  assert.match(snapshotDerived, /exactOrderRefs\s*=\s*\[\]/u);
  assert.match(snapshotDerived, /dispatch_plan_order_assignments/u);
  assert.match(db, /options:\s*["']-c jit=off["']/u);

  assert.match(dispatchRepository, /exactOrderRefs\s*=\s*\[\]/u);
  assert.match(dispatchRepository, /OR\s+netsuite_id::text\s*=\s*\$3/u);
  const pushedPredicates = dispatchRepository.match(
    /cardinality\(\$8::text\[\]\)\s*=\s*0/g
  ) || [];
  assert.ok(
    pushedPredicates.length >= 6,
    `Expected exact-order predicates in every physical/local source branch, found ${pushedPredicates.length}.`
  );
});
