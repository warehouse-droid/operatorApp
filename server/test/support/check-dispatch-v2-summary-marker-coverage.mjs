// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const coveragePath = path.resolve(process.argv[2]
  || "test-artifacts/dispatch-v2-summary-marker-coverage/coverage-final.json");
/** @type {Record<string, FileCoverage>} */
const coverageDocument = JSON.parse(await readFile(coveragePath, "utf8"));

/** @type {Array<{path: string, probes: Array<{label: string, needle: string}>}>} */
const files = [
  {
    path: path.resolve("src/dispatch-plan-repository.js"),
    probes: [
      { label: "summary marker selection", needle: "const existingV2Format = Number(summary?.dispatchPlanFormat?.version || 0)" },
      { label: "new-plan marker", needle: "const initialSummary = dispatchPlanV2Summary({}, {" },
      { label: "new-plan digest", needle: "JSON.stringify(initialSummary), initialDigest" }
    ]
  },
  {
    path: path.resolve("src/dispatch-planner-v2-repository.js"),
    probes: [
      { label: "Toronto company date", needle: "const parts = Object.fromEntries(new Intl.DateTimeFormat" },
      { label: "bootstrap normalization", needle: "? dispatchPlanV2Summary(summary, {" },
      { label: "bounded repair selection", needle: "const candidates = await query(" },
      { label: "repair summary", needle: "const summary = dispatchPlanV2Summary(row.summary || {}, {" },
      { label: "repair metadata update", needle: "const updated = await query(" },
      { label: "repair digest", needle: "digestDispatchPlan(repairedPlan)," },
      { label: "command normalization", needle: "result.plan.summary = dispatchPlanV2Summary(result.plan.summary || {}, {" }
    ]
  }
];

/** @param {string} source @param {string} needle */
function lineForNeedle(source, needle) {
  const offset = source.indexOf(needle);
  assert.notEqual(offset, -1, `${needle}: coverage probe source was not found.`);
  return source.slice(0, offset).split("\n").length;
}

/** @param {FileCoverage} coverage @param {number} line */
function statementHitForLine(coverage, line) {
  const candidates = Object.entries(coverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .sort((left, right) => {
      const leftSpan = left[1].end.line - left[1].start.line;
      const rightSpan = right[1].end.line - right[1].start.line;
      return leftSpan - rightSpan;
    });
  assert(candidates.length, `No instrumented statement contains changed line ${line}.`);
  const [candidate] = candidates;
  assert(candidate);
  return Number(coverage.s[candidate[0]] || 0);
}

let executed = 0;
for (const file of files) {
  const source = await readFile(file.path, "utf8");
  const coverage = Object.values(coverageDocument).find((entry) =>
    path.resolve(String(entry?.path || "")) === file.path
  );
  assert(coverage, `${path.basename(file.path)} coverage was not recorded.`);
  for (const probe of file.probes) {
    const line = lineForNeedle(source, probe.needle);
    assert(statementHitForLine(coverage, line) > 0, `${probe.label} was not executed (line ${line}).`);
    executed += 1;
  }
}

console.log(`Dispatch V2 summary-marker changed-line probes: ${executed}/${executed} executed.`);
