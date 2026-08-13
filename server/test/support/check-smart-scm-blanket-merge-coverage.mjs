// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const coveragePath = path.resolve(process.argv[2]
  || "test-artifacts/smart-scm-blanket-merge-coverage/coverage-final.json");
const sourcePath = path.resolve("src/smart-scm-blanket-repository.js");
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
  throw new Error("Blanket repository coverage was not recorded.");
}
const fileCoverage = locatedCoverage;

const probes = [
  { label: "selection minimum", needle: "if (ids.length < 2) throw httpError" },
  { label: "selection maximum", needle: "if (ids.length > 20) throw httpError" },
  { label: "active workspace hides merge lineage", needle: "const activeProposals = run.proposals.filter" },
  { label: "idempotent replacement recovery", needle: "if (replay) return replay;" },
  { label: "same ready run guard", needle: "throw httpError(\"Blanket loads must belong to the same current ready planning run.\"" },
  { label: "same source PO guard", needle: "throw httpError(\"Selected loads must use the same source Blanket PO.\"" },
  { label: "reservation guard", needle: "throw httpError(\"A selected Blanket load is already reserved or has vendor history" },
  { label: "current source header lock", needle: "const sourceOrder = await query(" },
  { label: "proposal line lock", needle: "const lineResult = await query(" },
  { label: "exact allocation validation", needle: "const allocatedByLine = new Map();" },
  { label: "current source line validation", needle: "const sourceLines = await query(" },
  { label: "drop bound", needle: "if (new Set(combined.map((line) => line.destinationLocationId)).size > maximumDrops)" },
  { label: "capacity reallocation", needle: "[allocated] = smartScmAllocateProRata(weighted, settings.truck_capacity_lbs);" },
  { label: "deterministic replacement insert", needle: "const insertedProposal = await query(" },
  { label: "exact replacement allocation insert", needle: "const plannedSalesQty = round(plannedPallets * source.salesPerPallet);" },
  { label: "source allocation release", needle: "const deletedAllocations = await query(" },
  { label: "derived capacity validation", needle: "const derived = await refreshSmartScmProposalDerived(mergedProposalId);" },
  { label: "superseded lineage update", needle: "const superseded = await query(" },
  { label: "revision record", needle: "const revision = await recordSmartScmProposalRevision(first.run_id" },
  { label: "audit record", needle: "action: \"smart_scm.blanket.proposals_merged\"" },
  { label: "post-commit workspace refresh", needle: "workspace: await listSmartScmBlanketWorkspace()" }
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

console.log(`Blanket merge changed-line probes: ${probes.length}/${probes.length} executed.`);
