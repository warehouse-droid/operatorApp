// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const coveragePath = path.resolve(process.argv[2]
  || "test-artifacts/smart-scm-manual-controls-coverage/coverage-final.json");
/** @type {Record<string, FileCoverage>} */
const coverageDocument = JSON.parse(await readFile(coveragePath, "utf8"));

const targets = [
  {
    path: path.resolve("src/smart-scm-planning-repository.js"),
    probes: [
      { label: "manual backorder authorization", needle: "allowBackorder: manual" },
      { label: "backorder quantity", needle: "backorderPallets: manual ?" },
      { label: "automatic/manual confirmation gate", needle: "return limit?.allowBackorder !== true" },
      { label: "execution backorder evidence", needle: "sourceBackorderPallets: positive(sourceBackorders.get" }
    ]
  },
  {
    path: path.resolve("src/smart-scm-blanket-repository.js"),
    probes: [
      { label: "physical open ceiling", needle: "if (requested > open)" },
      { label: "minimal donor reduction", needle: "requested + competingBeforePallets - open" },
      { label: "deterministic donor reduction", needle: "allocation.reducedPallets = Math.min" },
      { label: "same-run competing lock", needle: "WHERE other_proposal.run_id = $1" },
      { label: "planned-only competing lock", needle: "AND allocation.status = 'planned'" },
      { label: "competing allocation update", needle: "SET planned_pallets = $2, planned_sales_qty = $3" },
      { label: "zero donor line cleanup", needle: "A zero-quantity competing Blanket line could not be removed." },
      { label: "zero donor proposal cleanup", needle: "DELETE FROM scm_smart_proposals WHERE id = $1" },
      { label: "target exact source conservation", needle: "const conserved = await query(" },
      { label: "source-item exact PO identity", needle: "blanketSourceLineMatchesProposal(source, proposal, itemId)" },
      { label: "source-item same-run availability", needle: "physicalOpenPallets - plannedPallets" },
      { label: "source-item exact allocation", needle: "Blanket source-PO item added to proposal" }
    ]
  }
];

/** @param {FileCoverage} fileCoverage @param {number} line */
function statementHitForLine(fileCoverage, line) {
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

let executed = 0;
let total = 0;
for (const target of targets) {
  const [source, fileCoverage] = await Promise.all([
    readFile(target.path, "utf8"),
    Promise.resolve(Object.values(coverageDocument).find((entry) =>
      path.resolve(String(entry?.path || "")) === target.path
    ))
  ]);
  assert(fileCoverage, `${path.basename(target.path)} coverage was not recorded.`);
  for (const probe of target.probes) {
    total += 1;
    const offset = source.indexOf(probe.needle);
    assert.notEqual(offset, -1, `${probe.needle}: coverage probe source was not found.`);
    const line = source.slice(0, offset).split("\n").length;
    assert(statementHitForLine(fileCoverage, line) > 0, `${probe.label} was not executed (line ${line}).`);
    executed += 1;
  }
}

console.log(`Smart SCM manual-control changed-line probes: ${executed}/${total} executed.`);
