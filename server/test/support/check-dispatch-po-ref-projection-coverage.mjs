// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

const reportPath = path.resolve(
  process.argv[2] || "test-artifacts/dispatch-po-ref-projection/coverage/coverage-final.json"
);
const report = JSON.parse(await readFile(reportPath, "utf8"));

/** @param {string} suffix */
function coverageFor(suffix) {
  const entry = Object.entries(report).find(([file]) => file.endsWith(suffix));
  if (!entry) {
    throw new Error(`Coverage report is missing ${suffix}.`);
  }
  return entry[1];
}

/** @param {string} source @param {string} marker */
function uniqueMarkerLine(source, marker) {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`Expected one coverage marker: ${marker}`);
  }
  return source.slice(0, first).split("\n").length;
}

/** @param {any} coverage */
function coveredStatementLines(coverage) {
  const lines = new Map();
  for (const [id, location] of Object.entries(coverage.statementMap || {})) {
    const line = Number(location.start.line);
    lines.set(line, Boolean(lines.get(line)) || Number(coverage.s?.[id] || 0) > 0);
  }
  return lines;
}

const repositoryCoverage = coverageFor("/src/dispatch-repository.js");
const plannerCoverage = coverageFor("/src/dispatch-planner-v2-repository.js");
const planRepositoryCoverage = coverageFor("/src/dispatch-plan-repository.js");
const catalogRepositoryCoverage = coverageFor("/src/dispatch-order-catalog-repository.js");
const serverCoverage = coverageFor("/src/server.js");
const repositorySource = await readFile(path.resolve("src/dispatch-repository.js"), "utf8");
const plannerSource = await readFile(path.resolve("src/dispatch-planner-v2-repository.js"), "utf8");
const planRepositorySource = await readFile(path.resolve("src/dispatch-plan-repository.js"), "utf8");
const catalogRepositorySource = await readFile(
  path.resolve("src/dispatch-order-catalog-repository.js"),
  "utf8"
);
const serverSource = await readFile(path.resolve("src/server.js"), "utf8");

const probes = [
  [repositoryCoverage, repositorySource, "await runQuery(\"SELECT pg_advisory_xact_lock(hashtext($1))\", [DISPATCH_FLEET_PLANNING_LOCK]);"],
  [repositoryCoverage, repositorySource, "const snapshots = await runQuery(\n    `SELECT snapshot.plan_id"],
  [repositoryCoverage, repositorySource, "const nextPlan = {\n      id: String(row.plan_id),"],
  [repositoryCoverage, repositorySource, "[row.plan_id, JSON.stringify(next.orders), JSON.stringify(next.trucks), digestDispatchPlan(nextPlan)]"],
  [repositoryCoverage, repositorySource, "const revisions = await runQuery("],
  [repositoryCoverage, repositorySource, "await syncDispatchPlanOrderAssignments(plan, { execute: runQuery });"],
  [repositoryCoverage, repositorySource, "await syncDispatchPlanRelationEdges(plan, { execute: runQuery });"],
  [plannerCoverage, plannerSource, "export async function syncDispatchPlanOrderAssignments(plan = {}, { execute = query } = {}) {\n  const runQuery"],
  [plannerCoverage, plannerSource, "export async function syncDispatchPlanRelationEdges(plan = {}, { execute = query } = {}) {\n  const runQuery"],
  [plannerCoverage, plannerSource, "await refreshDispatchAssignmentProjectionReadiness(runQuery);"],
  [plannerCoverage, plannerSource, "const ready = await refreshDispatchAssignmentProjectionReadiness();"],
  [plannerCoverage, plannerSource, "await backfillDispatchPlanProjections({ batchSize: 25 });"],
  [plannerCoverage, plannerSource, "deferredAssignmentError = error;"],
  [planRepositoryCoverage, planRepositorySource, "await syncDispatchPlannerReadProjections(created);"],
  [planRepositoryCoverage, planRepositorySource, "await syncDispatchPlannerReadProjections(cleanPlan);"],
  [planRepositoryCoverage, planRepositorySource, "await syncDispatchPlanLoadAssignments(plan, { allowBin: binBoundary !== null });"],
  [planRepositoryCoverage, planRepositorySource, "const plan = await getDispatchPlan(planId);\n    await syncDispatchPlannerReadProjections(plan);\n    return plan;"],
  [catalogRepositoryCoverage, catalogRepositorySource, "assignmentsReady: row.assignments_ready === true && row.actual_assignments_ready === true,"],
  [serverCoverage, serverSource, "      await backfillDispatchPlanProjections({ batchSize: 25 });\n    });\n    const refreshes"]
];
const missed = probes.filter(([coverage, source, marker]) => {
  const line = uniqueMarkerLine(String(source), String(marker));
  return coveredStatementLines(coverage).get(line) !== true;
});
if (missed.length) {
  throw new Error(`Dispatch PO-reference changed-line probes missed ${missed.length}/${probes.length} statements.`);
}
console.log(`Dispatch PO-reference changed-line probes passed: ${probes.length}/${probes.length}.`);
