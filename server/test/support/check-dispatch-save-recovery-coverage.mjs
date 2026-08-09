// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

const reportPath = path.resolve(process.argv[2] || "test-artifacts/dispatch-save-recovery-coverage/coverage-final.json");
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
    const covered = Number(coverage.s?.[id] || 0) > 0;
    lines.set(line, Boolean(lines.get(line)) || covered);
  }
  return lines;
}

/** @param {any} coverage @param {string} source @param {string} startMarker @param {string} endMarker */
function rangeScore(coverage, source, startMarker, endMarker) {
  const start = uniqueMarkerLine(source, startMarker);
  const end = uniqueMarkerLine(source, endMarker);
  const statements = [...coveredStatementLines(coverage)]
    .filter(([line]) => line >= start && line < end);
  const covered = statements.filter(([, hit]) => hit).length;
  return { covered, total: statements.length, pct: statements.length ? (covered / statements.length) * 100 : 0 };
}

const repositoryCoverage = coverageFor("/src/dispatch-plan-repository.js");
const plannerV2Coverage = coverageFor("/src/dispatch-planner-v2-repository.js");
const serverCoverage = coverageFor("/src/server.js");
const repositorySource = await readFile(path.resolve("src/dispatch-plan-repository.js"), "utf8");
const plannerV2Source = await readFile(path.resolve("src/dispatch-planner-v2-repository.js"), "utf8");
const serverSource = await readFile(path.resolve("src/server.js"), "utf8");
const repositoryScore = rangeScore(
  repositoryCoverage,
  repositorySource,
  "export async function saveDispatchPlanRecoveryDraft",
  "export async function saveDispatchPlanSnapshot"
);
const helperScore = rangeScore(
  serverCoverage,
  serverSource,
  "const DISPATCH_RECOVERY_EXCLUDED_ERROR_CODES",
  "function dispatchTruckSequenceKey"
);
const retentionScore = rangeScore(
  plannerV2Coverage,
  plannerV2Source,
  "export async function pruneExpiredDispatchV2Checkpoints",
  "export async function pendingDispatchV2Followups"
);

const probes = [
  [repositoryCoverage, repositorySource, "const existingRecovery = existing.rows[0];"],
  [repositoryCoverage, repositorySource, "const inserted = await query("],
  [serverCoverage, serverSource, "return Number(error?.status) === 409"],
  [serverCoverage, serverSource, "const recoveryDraft = await saveDispatchPlanRecoveryDraft(previousPlan.id, {"],
  [serverCoverage, serverSource, "return res.status(202).json({\n    code: \"DISPATCH_PLAN_RECOVERY_SAVED\""],
  [serverCoverage, serverSource, "const recoveryCommand = command || submittedCommand;"],
  [serverCoverage, serverSource, "previousPlan && recoveryCandidate && isDispatchPlanRecoveryValidationError(error)"],
  [serverCoverage, serverSource, "recoveryCandidate = { ...recoveryCandidate, summary: storedSummary };"]
];
const missedProbes = probes.filter(([coverage, source, marker]) => {
  const line = uniqueMarkerLine(source, marker);
  return coveredStatementLines(coverage).get(line) !== true;
});

if (repositoryScore.pct < 90 || helperScore.pct < 90 || retentionScore.pct < 90 || missedProbes.length) {
  throw new Error(
    `Recovery coverage failed: repository ${repositoryScore.covered}/${repositoryScore.total}, `
    + `server helpers ${helperScore.covered}/${helperScore.total}, `
    + `retention ${retentionScore.covered}/${retentionScore.total}, `
    + `probes ${probes.length - missedProbes.length}/${probes.length}.`
  );
}

console.log(
  `Recovery coverage passed: repository ${repositoryScore.covered}/${repositoryScore.total} statements (${repositoryScore.pct.toFixed(1)}%), `
  + `server helpers ${helperScore.covered}/${helperScore.total} (${helperScore.pct.toFixed(1)}%), `
  + `retention ${retentionScore.covered}/${retentionScore.total} (${retentionScore.pct.toFixed(1)}%), `
  + `probes ${probes.length}/${probes.length}.`
);
