import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../../../src/dispatch-plan-repository.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");

test("the repository save boundary refreshes relationship projections after structural authority", () => {
  assert.match(source, /stripDispatchRelationshipProjections/u);
  assert.match(source, /enrichDispatchOrdersWithDependencies/u);
  assert.match(source, /enrichDispatchOrdersWithPoTargetAllocations/u);
  assert.match(source, /reconcileAuthoritativeDispatchOrderProjection/u);
  assert.match(
    source,
    /reconcileDispatchPlanGlobalOrderDefinitions[\s\S]+stripDispatchRelationshipProjections[\s\S]+enrichDispatchOrdersWithDependencies[\s\S]+enrichDispatchOrdersWithPoTargetAllocations/u,
    "relationship data must be projected after global structural data"
  );
});

test("a read-time repaired route cannot be discarded by the HTTP no-change shortcut", () => {
  assert.match(serverSource, /function dispatchPlanProjectionRefreshRequired/u);
  assert.equal(
    (serverSource.match(/!dispatchPlanProjectionRefreshRequired\(previousPlan\)/gu) || []).length,
    2
  );
});
