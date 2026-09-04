// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{start: {line: number}, end: {line: number}}} CoverageLocation */
/** @typedef {{path?: string, statementMap: Record<string, CoverageLocation>, s: Record<string, number>, branchMap: Record<string, {loc: CoverageLocation, locations?: CoverageLocation[]}>, b: Record<string, number[]>}} FileCoverage */

const serverRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourcePath = path.join(serverRoot, "src/dispatch-planner-performance.js");
const historySourcePath = path.join(serverRoot, "src/dispatch-history-mode.js");
const reportPath = path.resolve(process.argv[2]
  || "test-artifacts/dispatch-derived-order-freshness/coverage/coverage-final.json");
/** @type {Record<string, FileCoverage>} */
const report = JSON.parse(await readFile(reportPath, "utf8"));
const coverageEntry = Object.values(report).find((entry) => path.resolve(String(entry.path || "")) === sourcePath);
if (!coverageEntry) {
  throw new Error("dispatch-planner-performance.js coverage was not recorded.");
}
const coverage = coverageEntry;
const source = await readFile(sourcePath, "utf8");
const historyCoverage = Object.values(report).find((entry) => path.resolve(String(entry.path || "")) === historySourcePath);
if (!historyCoverage) {
  throw new Error("dispatch-history-mode.js coverage was not recorded.");
}
const historySource = await readFile(historySourcePath, "utf8");

const statementMarkers = Object.freeze([
  "const relationshipPickupLocations = (candidate = {}) => [",
  "...(Array.isArray(candidate.poPickupManifest) ? candidate.poPickupManifest : []),",
  "...(Array.isArray(candidate.directPickupManifest) ? candidate.directPickupManifest : [])",
  "].map((entry) => text(entry?.location)).filter(Boolean);",
  "const relationshipPickups = relationshipPickupLocations(candidate);",
  "const relationshipPickupKeys = new Set(relationshipPickups.map(locationKey).filter(Boolean));",
  "&& !relationshipPickupKeys.has(locationKey(location))",
  "&& !candidate.pickupLocations?.length",
  "const activePickupKeys = new Set();",
  "next.pickupLocations = [active.toYard, ...relationshipPickups].filter((location) => {",
  "if (!key || activePickupKeys.has(key)) {return false;}"
]);

const branchMarkers = Object.freeze([
  "...(Array.isArray(candidate.poPickupManifest) ? candidate.poPickupManifest : []),",
  "...(Array.isArray(candidate.directPickupManifest) ? candidate.directPickupManifest : [])",
  "|| locationKey(location) !== destination",
  "&& !relationshipPickupKeys.has(locationKey(location))",
  "&& !candidate.pickupLocations?.length",
  "if (!key || activePickupKeys.has(key)) {return false;}"
]);

/** @param {string} marker */
function lineForMarker(marker) {
  const lines = source.split("\n");
  const matches = lines.flatMap((line, index) => line.includes(marker) ? [index + 1] : []);
  assert.equal(matches.length, 1, `Expected one coverage marker for ${marker}.`);
  return Number(matches[0]);
}

/** @param {number} line */
function statementHits(line) {
  const candidates = Object.entries(coverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .sort((left, right) => (
      (left[1].end.line - left[1].start.line) - (right[1].end.line - right[1].start.line)
    ));
  assert(candidates.length, `No instrumented statement contains changed line ${line}.`);
  const candidate = candidates[0];
  assert(candidate, `Changed-line statement disappeared for line ${line}.`);
  return Number(coverage.s[candidate[0]] || 0);
}

let statementsCovered = 0;
for (const marker of statementMarkers) {
  const line = lineForMarker(marker);
  assert.ok(statementHits(line) > 0, `Changed statement was not executed at line ${line}: ${marker}`);
  statementsCovered += 1;
}

let branchOutcomesCovered = 0;
let branchOutcomeTotal = 0;
for (const marker of branchMarkers) {
  const line = lineForMarker(marker);
  const branches = Object.entries(coverage.branchMap).filter(([, branch]) => (
    branch.loc.start.line === line
    || (branch.locations || []).some((location) => location.start.line === line)
  ));
  assert(branches.length, `No instrumented decision contains changed line ${line}: ${marker}`);
  for (const [id] of branches) {
    branchOutcomeTotal += 1;
    assert.ok(
      (coverage.b[id] || []).some((count) => Number(count) > 0),
      `Changed decision outcome was not executed at line ${line}: ${marker}`
    );
    branchOutcomesCovered += 1;
  }
}

const terminalDropMarker = "AND LOWER(BTRIM(COALESCE(record.stop_type, ''))) = 'dropoff'";
const terminalDropLines = historySource.split("\n")
  .flatMap((line, index) => line.includes(terminalDropMarker) ? [index + 1] : []);
assert.equal(terminalDropLines.length, 1, "Expected one terminal Driver-stop completion guard.");
const terminalDropLine = Number(terminalDropLines[0]);
const terminalDropStatements = Object.entries(historyCoverage.statementMap)
  .filter(([, location]) => location.start.line <= terminalDropLine && location.end.line >= terminalDropLine)
  .sort((left, right) => (
    (left[1].end.line - left[1].start.line) - (right[1].end.line - right[1].start.line)
  ));
assert(terminalDropStatements.length, "No instrumented statement contains the terminal Driver-stop guard.");
assert.ok(
  Number(historyCoverage.s[terminalDropStatements[0][0]] || 0) > 0,
  "The terminal Driver-stop completion guard was not executed."
);

console.log(
  `Dispatch derived-order changed-line coverage: ${statementsCovered}/${statementMarkers.length} statements and `
  + `${branchOutcomesCovered}/${branchOutcomeTotal} instrumented decision outcomes executed; `
  + "terminal Driver-stop guard executed."
);
