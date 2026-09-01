// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{start: {line: number}, end?: {line: number}}} CoverageLocation */
/** @typedef {{loc?: CoverageLocation, locations?: CoverageLocation[]}} BranchLocation */
/** @typedef {{statementMap: Record<string, CoverageLocation>, s: Record<string, number>, branchMap: Record<string, BranchLocation>, b: Record<string, number[]>}} FileCoverage */

const serverRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.resolve(
  process.argv[2] || "test-artifacts/dispatch-planning-stale-coverage/coverage-final.json"
);
/** @type {Record<string, FileCoverage>} */
const report = JSON.parse(await readFile(reportPath, "utf8"));

const checks = Object.freeze([
  {
    file: "src/dispatch-custom-order-repository.js",
    statementMarkers: Object.freeze([
      "const submittedStableId = customOrderStableId(order);",
      "const stableId = /^\\d+$/.test(submittedStableId)"
    ]),
    branchMarker: "const stableId = /^\\d+$/.test(submittedStableId)",
    branchOutcomeOffsets: Object.freeze([1, 2])
  },
  {
    file: "src/netsuite-order-webhook-queue-repository.js",
    statementMarkers: Object.freeze([
      "const superseded = latestRow && envelope.sourceModifiedAt",
      "const replaced = await query("
    ]),
    branchMarker: "const superseded = latestRow && envelope.sourceModifiedAt",
    branchOutcomeOffsets: Object.freeze([1, 2])
  }
]);

/** @param {string} source @param {string} marker @param {string} file */
function lineForMarker(source, marker, file) {
  const lines = source.split("\n");
  const indexes = lines.flatMap((line, index) => line.includes(marker) ? [index + 1] : []);
  if (indexes.length !== 1) {
    throw new Error(`${file}: expected one coverage marker for ${marker}.`);
  }
  const line = indexes[0];
  if (line === undefined) {
    throw new Error(`${file}: coverage marker line disappeared after validation.`);
  }
  return line;
}

/** @param {string} file @returns {FileCoverage} */
function coverageFor(file) {
  const suffix = `/${file}`;
  const entries = Object.entries(report).filter(([key]) => key.endsWith(suffix));
  if (entries.length !== 1) {
    throw new Error(`${file}: expected one coverage document, found ${entries.length}.`);
  }
  const entry = entries[0];
  if (!entry) {
    throw new Error(`${file}: coverage document disappeared after validation.`);
  }
  return entry[1];
}

let statementMarkersCovered = 0;
let branchOutcomesCovered = 0;
for (const check of checks) {
  const source = await readFile(path.resolve(serverRoot, check.file), "utf8");
  const coverage = coverageFor(check.file);
  for (const marker of check.statementMarkers) {
    const line = lineForMarker(source, marker, check.file);
    const statementIds = Object.entries(coverage.statementMap)
      .filter(([, location]) => location.start.line === line)
      .map(([id]) => id);
    if (!statementIds.length || statementIds.every((id) => Number(coverage.s[id] || 0) === 0)) {
      throw new Error(`${check.file}:${line}: changed statement was not executed (${marker}).`);
    }
    statementMarkersCovered += 1;
  }

  const branchLine = lineForMarker(source, check.branchMarker, check.file);
  for (const offset of check.branchOutcomeOffsets) {
    const outcomeLine = branchLine + offset;
    const outcomeIds = Object.entries(coverage.branchMap)
      .filter(([, branch]) => {
        const locations = branch.locations || [];
        return branch.loc?.start?.line === outcomeLine
          || locations.some((location) => location.start.line === outcomeLine);
      })
      .map(([id]) => id);
    const covered = outcomeIds.some((id) => (coverage.b[id] || []).some((count) => Number(count) > 0));
    if (!covered) {
      throw new Error(`${check.file}:${outcomeLine}: changed decision outcome was not executed.`);
    }
    branchOutcomesCovered += 1;
  }
}

console.log(
  `Changed-line coverage: ${statementMarkersCovered}/${statementMarkersCovered} executable markers and `
  + `${branchOutcomesCovered}/${branchOutcomesCovered} decision outcomes covered; SQL arrival-order branch is mutation-tested.`
);
