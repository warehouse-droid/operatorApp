import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSource = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
const repositorySource = fs.readFileSync(new URL("../../../src/dispatch-repository.js", import.meta.url), "utf8");
const plannerSource = fs.readFileSync(new URL("../../../src/dispatch-planner-v2-repository.js", import.meta.url), "utf8");
const planRepositorySource = fs.readFileSync(new URL("../../../src/dispatch-plan-repository.js", import.meta.url), "utf8");
const catalogRepositorySource = fs.readFileSync(
  new URL("../../../src/dispatch-order-catalog-repository.js", import.meta.url),
  "utf8"
);
const migrationSource = fs.readFileSync(
  new URL("../../../migrations/193_dispatch_assignment_projection_invariant.sql", import.meta.url),
  "utf8"
);
const loadMigrationSource = fs.readFileSync(
  new URL("../../../migrations/195_dispatch_load_assignment_projection_invariant.sql", import.meta.url),
  "utf8"
);

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.ok(start >= 0 && end > start, `${startMarker} source block must remain discoverable`);
  return source.slice(start, end);
}

test("the recurring catalog worker verifies projection reality instead of trusting a cached ready flag", () => {
  const start = serverSource.indexOf("export async function dispatchOrderCatalogTick()");
  const end = serverSource.indexOf("export async function scmPurchaseOrderCatalogTick()", start);
  assert.ok(start >= 0 && end > start, "dispatchOrderCatalogTick source block must remain discoverable");
  const worker = serverSource.slice(start, end);

  assert.doesNotMatch(
    worker,
    /state\.assignmentsReady\s*\?/u,
    "a stale true flag must never suppress the real projection backfill"
  );
  assert.match(worker, /await backfillDispatchPlanProjections\(\{ batchSize: 25 \}\)/u);
});

test("PO reference snapshot rewrites enter the fleet lock before selecting mutable plans", () => {
  const start = repositorySource.indexOf("async function updateDispatchSnapshotsForRef(");
  const end = repositorySource.indexOf("export function scmPurchaseOrderListKind", start);
  assert.ok(start >= 0 && end > start, "PO reference rewrite source block must remain discoverable");
  const rewrite = repositorySource.slice(start, end);
  const lock = rewrite.indexOf("SELECT pg_advisory_xact_lock(hashtext($1))");
  const snapshotRead = rewrite.indexOf("FROM dispatch_plan_snapshots snapshot");

  assert.ok(lock >= 0, "the PO reference rewrite must acquire the shared fleet-planning lock");
  assert.ok(snapshotRead > lock, "the fleet lock must be held before snapshots are selected or rewritten");
  assert.match(rewrite, /FOR UPDATE OF plan, snapshot/u);
});

test("projection backfill owns the fleet lock and mutable snapshot rows for its whole repair", () => {
  const backfill = sourceBlock(
    plannerSource,
    "export async function backfillDispatchPlanProjections(",
    "async function otherDateAssignment("
  );
  const lock = backfill.indexOf("SELECT pg_advisory_xact_lock(hashtext($1))");
  const snapshotRead = backfill.indexOf("FROM dispatch_plans p");

  assert.ok(lock >= 0 && snapshotRead > lock);
  assert.match(backfill, /FOR UPDATE OF p, s/u);
  assert.match(backfill, /return withTransaction\(async \(\) =>/u);
  const loadProjection = backfill.indexOf("syncDispatchPlanLoadProjection(plan)");
  const orderProjection = backfill.indexOf("syncDispatchPlanOrderAssignments(plan)");
  assert.ok(loadProjection >= 0 && orderProjection > loadProjection,
    "backfill must refresh the load projection before publishing order-projection readiness");
});

test("catalog readiness is derived from live plan/projection revision parity", () => {
  const getter = sourceBlock(
    catalogRepositorySource,
    "export async function getDispatchOrderCatalogState()",
    "export async function markDispatchOrderCatalogReady("
  );
  const readyWriter = sourceBlock(
    catalogRepositorySource,
    "export async function markDispatchOrderCatalogReady(",
    "export async function markDispatchOrderCatalogFailed("
  );

  assert.match(getter, /actual_assignments_ready/u);
  assert.match(getter, /projection\.source_revision <> COALESCE\(plan\.revision, 0\)/u);
  assert.match(getter, /row\.assignments_ready === true && row\.actual_assignments_ready === true/u);
  assert.match(readyWriter, /assignments_ready = \$2::boolean AND NOT EXISTS/u);
});

test("known lifecycle writers synchronize projections inside their write transaction", () => {
  for (const [start, end] of [
    ["export async function createDispatchPlan(", "export async function getDispatchPlan("],
    ["export async function reconcileSalesOrderFamilyInDispatchPlans(", "export async function cleanupBilledSalesOrderFamilyFromDispatchPlans("],
    ["async function confirmDispatchPlanTransaction(", "export async function confirmDispatchPlan("],
    ["export async function reopenDispatchPlan(", ""]
  ]) {
    const writer = sourceBlock(planRepositorySource, start, end);
    assert.match(writer, /syncDispatchPlannerReadProjections\(/u, `${start} must synchronize before commit`);
  }
  assert.doesNotMatch(serverSource, /Dispatch plan projection refresh failed/u);
});

test("V2 commands synchronize the load projection before publishing assignment readiness", () => {
  const writer = sourceBlock(
    plannerSource,
    "export async function applyDispatchV2Command(",
    "function checkpointResult("
  );
  const loadProjection = writer.indexOf("syncDispatchPlanLoadProjection(result.plan)");
  const orderProjection = writer.indexOf("syncDispatchPlanOrderAssignments(result.plan)");
  assert.ok(loadProjection >= 0 && orderProjection > loadProjection);
});

test("the database invalidates cached readiness for every present or future plan writer", () => {
  assert.match(migrationSource, /AFTER INSERT OR DELETE OR UPDATE OF revision, status/u);
  assert.match(migrationSource, /FOR EACH STATEMENT/u);
  assert.match(migrationSource, /SET assignments_ready = false/u);
  assert.match(loadMigrationSource, /AFTER INSERT ON dispatch_plan_snapshots/u);
  assert.match(loadMigrationSource, /AFTER UPDATE OF orders, trucks ON dispatch_plan_snapshots/u);
  assert.match(loadMigrationSource, /DELETE FROM dispatch_plan_projection_state/u);
  assert.match(loadMigrationSource, /snapshot\.schema_version >= 2/u);
});
