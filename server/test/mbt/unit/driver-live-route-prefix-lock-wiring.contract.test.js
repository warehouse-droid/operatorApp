import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relativePath) => fs.readFileSync(
  new URL(`../../../${relativePath}`, import.meta.url),
  "utf8"
);

test("full saves, incremental commands, restore, replay, and legacy validation share the prefix policy", () => {
  const repository = read("src/dispatch-plan-repository.js");
  const v2 = read("src/dispatch-planner-v2-repository.js");
  const replay = read("src/dispatch-planner-replay.js");
  const server = read("src/server.js");
  assert.match(repository, /pg_advisory_xact_lock\(hashtext\(\$1\)\)[\s\S]*assertDispatchExecutedPrefixPreserved/u);
  assert.match(repository, /evaluateDispatchExecutedPrefixPreservation/u);
  assert.match(repository, /evaluateExecutedPrefixPolicy\(/u);
  assert.match(v2, /evaluateExecutedPrefixPolicy\([\s\S]*activityForPlan/u);
  assert.match(replay, /evaluateExecutedPrefixPolicy\(/u);
  assert.ok((server.match(/evaluateExecutedPrefixPolicy\(/gu) || []).length >= 2);
  assert.match(server, /restoreExecutionPolicy = evaluateExecutedPrefixPolicy/u);
  const reconciliation = repository.slice(
    repository.indexOf("export async function reconcileSalesOrderFamilyInDispatchPlans"),
    repository.indexOf("export async function cleanupBilledSalesOrderFamilyFromDispatchPlans")
  );
  assert.match(reconciliation, /evaluateDispatchExecutedPrefixPreservation\(\{[\s\S]*previousPlan: originalPlan,[\s\S]*nextPlan: scrubbed\.plan[\s\S]*UPDATE dispatch_plan_snapshots/u);
});

test("repository-mediated snapshot writers cannot bypass the shared prefix guard", () => {
  const helper = read("src/dispatch-executed-prefix-repository.js");
  const coIdentity = read("src/dispatch-co-group-identity-repository.js");
  const coCargo = read("src/dispatch-co-cargo-repair.js");
  const delivery = read("src/delivery-repository.js");
  const dispatch = read("src/dispatch-repository.js");
  const binDispatch = read("src/mbt/bin-dispatch-service.js");

  assert.match(helper, /status IN \('in_progress', 'complete'\)[\s\S]*evaluateExecutedPrefixPolicy/u);
  assert.match(coIdentity, /evaluateDispatchExecutedPrefixPreservation\([\s\S]*UPDATE dispatch_plan_snapshots/u);
  assert.match(coCargo, /assertDispatchExecutedPrefixPreserved\([\s\S]*dispatch_plan_snapshot_history/u);

  const splitDeactivation = delivery.slice(
    delivery.indexOf("async function deactivateUnplannedDispatchSplitOrdersInTransaction"),
    delivery.indexOf("export async function deactivateUnplannedDispatchSplitOrders")
  );
  assert.match(splitDeactivation, /DISPATCH_FLEET_PLANNING_LOCK[\s\S]*assertDispatchExecutedPrefixPreserved\([\s\S]*UPDATE dispatch_plan_snapshots/u);

  const refMaintenance = dispatch.slice(
    dispatch.indexOf("async function updateDispatchSnapshotsForRef"),
    dispatch.indexOf("export function scmPurchaseOrderListKind")
  );
  assert.match(refMaintenance, /DISPATCH_FLEET_PLANNING_LOCK[\s\S]*assertDispatchExecutedPrefixPreserved\([\s\S]*UPDATE dispatch_plan_snapshots/u);

  const binPlanLock = binDispatch.slice(
    binDispatch.indexOf("async function lockPlan"),
    binDispatch.indexOf("async function assertBinTruck")
  );
  const binPersist = binDispatch.slice(
    binDispatch.indexOf("async function persistPlan"),
    binDispatch.indexOf("async function insertAssignmentHistory")
  );
  assert.match(binPlanLock, /DISPATCH_FLEET_PLANNING_LOCK/u);
  assert.match(binPersist, /assertDispatchExecutedPrefixPreserved\([\s\S]*UPDATE dispatch_plan_snapshots/u);
});

test("Driver start and completion serialize with saves and resolve through the authoritative cursor", () => {
  const repository = read("src/driver-repository.js");
  const server = read("src/server.js");
  assert.match(repository, /import \{ selectDriverRouteCursor \} from "\.\/driver-route-cursor\.js";/u);
  assert.match(repository, /status = 'in_progress'[\s\S]*selectDriverRouteCursor\(\{ jobs: baseJobs, statuses, activeRecords \}\)/u);
  assert.match(repository, /routeAttention: cursor\.attention/u);
  assert.match(repository, /passedPendingJobIds: cursor\.passedPendingJobIds/u);

  const start = server.slice(
    server.indexOf("async function startDriverPhysicalVisitJobs"),
    server.indexOf("function driverExecutionJobFingerprint")
  );
  const completion = server.slice(
    server.indexOf("export async function completeDriverJobOperationalEffects"),
    server.indexOf("function driverRequestClientVersion")
  );
  for (const section of [start, completion]) {
    assert.match(section, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/u);
    assert.match(section, /assertDriverExecutionJobIsCurrent/u);
  }
  assert.match(server, /routeAttention[\s\S]*emitAppEvent\("driver\.route\.attention"/u);
  assert.match(server, /DRIVER_ACTIVE_ROUTE_CONFLICT[\s\S]*driver\.route\.attention/u);
});

test("offline projection uses the same monotonic completed boundary", () => {
  const driver = read("public/driver.js");
  const projection = driver.slice(
    driver.indexOf("function projectOfflineRoute"),
    driver.indexOf("async function restoreDraftPhotos")
  );
  assert.match(projection, /inProgress[\s\S]*startedAt[\s\S]*latestCompletedIndex/u);
  assert.match(projection, /index > latestCompletedIndex && !jobIsComplete\(job\)/u);
  assert.match(projection, /const projectedJob = inProgress \|\| nextPending \|\| null/u);
});
