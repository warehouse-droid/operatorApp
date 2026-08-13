// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const coveragePath = path.resolve(process.argv[2] || "test-artifacts/scm-po-split-ref-reuse-coverage/coverage-final.json");
const sourcePath = path.resolve("src/dispatch-repository.js");
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
  throw new Error("Dispatch repository coverage was not recorded.");
}
const fileCoverage = locatedCoverage;

const probes = [
  { label: "split rename checks the current visible ref", needle: "WHERE lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) = lower($1)", occurrence: 1 },
  { label: "ordinary PO rename checks the current visible ref", needle: "WHERE lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) = lower($1)", occurrence: 2 },
  { label: "new split checks the current visible ref", needle: "WHERE lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) = lower($1)", occurrence: 3 },
  { label: "retired split children do not reserve refs", needle: "AND retired_split.status = 'cancelled'", occurrence: 3 },
  {
    label: "active split refs remain exclusive",
    needle: "WHERE lower(split_po_ref) = lower($1)\n            AND status = 'active'",
    occurrence: 1
  },
  { label: "a new lifecycle reserves a ledger identity", needle: "SELECT nextval(pg_get_serial_sequence('dispatch_scm_po_splits', 'id'))::bigint AS id", occurrence: 1 },
  { label: "the child PO identity includes its lifecycle", needle: "scm-po:${source.netsuite_id}:${splitRef}:${splitHeaderId}", occurrence: 1 },
  { label: "the split ledger uses the reserved identity", needle: "id, source_po_id, source_po_ref, split_po_id, split_po_ref, created_by, details", occurrence: 1 },
  { label: "the child line identity includes its lifecycle", needle: "scm-po-line:${split.id}:${splitRef}:${childLineIdentity}", occurrence: 1 }
];

/** @param {string} needle @param {number} occurrence */
function lineForOccurrence(needle, occurrence) {
  let offset = -1;
  for (let index = 0; index < occurrence; index += 1) {
    offset = source.indexOf(needle, offset + 1);
    assert.notEqual(offset, -1, `${needle}: occurrence ${occurrence} was not found.`);
  }
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
  const line = lineForOccurrence(probe.needle, probe.occurrence);
  assert(statementHitForLine(line) > 0, `${probe.label} was not executed (line ${line}).`);
}

console.log(`SCM PO split changed-line probes: ${probes.length}/${probes.length} executed.`);
