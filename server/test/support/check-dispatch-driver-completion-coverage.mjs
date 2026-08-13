// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const coveragePath = path.resolve(process.argv[2]
  || "test-artifacts/dispatch-driver-completion-coverage/coverage-final.json");
const sourcePath = path.resolve("src/dispatch-history-mode.js");
const [coverageText, source] = await Promise.all([
  readFile(coveragePath, "utf8"),
  readFile(sourcePath, "utf8")
]);
/** @type {Record<string, FileCoverage>} */
const coverageDocument = JSON.parse(coverageText);
const locatedCoverage = Object.values(coverageDocument).find((entry) =>
  path.resolve(String(entry?.path || "")) === sourcePath
);
if (!locatedCoverage) {
  throw new Error("Dispatch history-mode coverage was not recorded.");
}
const fileCoverage = locatedCoverage;

const probes = [
  { label: "active delivery groups", needle: "WHERE group_row.active = true" },
  { label: "active schedule groups", needle: "WHERE LOWER(BTRIM(COALESCE(group_row.status, ''))) = 'active'" },
  { label: "active PO splits", needle: "FROM dispatch_scm_po_splits\n            WHERE LOWER" },
  { label: "group reverse edge", needle: "SELECT child_ref, parent_ref\n         FROM group_relations" },
  { label: "split forward edge", needle: "SELECT parent_ref, child_ref\n         FROM split_relations" },
  { label: "candidate reverse traversal", needle: "JOIN completion_edges edge ON edge.to_ref = candidate.order_ref" },
  { label: "Driver completion status", needle: "COALESCE(record.status, ''))) IN ('complete', 'completed')" },
  { label: "completion forward closure", needle: "JOIN completion_edges edge ON edge.from_ref = completed.order_ref" },
  { label: "conflict error", needle: "code: \"DISPATCH_ORDER_DRIVER_COMPLETED\"" }
];

/** @param {string} needle */
function lineForNeedle(needle) {
  const offset = source.indexOf(needle);
  assert.notEqual(offset, -1, `${needle}: coverage probe source was not found.`);
  return source.slice(0, offset).split("\n").length;
}

/** @param {number} line */
function statementHitForLine(line) {
  const candidates = Object.entries(fileCoverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .sort((left, right) => {
      const leftSpan = left[1].end.line - left[1].start.line;
      const rightSpan = right[1].end.line - right[1].start.line;
      return leftSpan - rightSpan;
    });
  assert(candidates.length, `No instrumented statement contains changed line ${line}.`);
  const [candidate] = candidates;
  assert(candidate);
  return Number(fileCoverage.s[candidate[0]] || 0);
}

for (const probe of probes) {
  const line = lineForNeedle(probe.needle);
  assert(statementHitForLine(line) > 0, `${probe.label} was not executed (line ${line}).`);
}

console.log(`Dispatch Driver-completion changed-line probes: ${probes.length}/${probes.length} executed.`);
