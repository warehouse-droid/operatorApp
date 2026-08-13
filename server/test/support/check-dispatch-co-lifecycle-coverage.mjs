// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const coveragePath = path.resolve(process.argv[2]
  || "test-artifacts/dispatch-co-lifecycle-coverage/coverage-final.json");
/** @type {Record<string, FileCoverage>} */
const document = JSON.parse(await readFile(coveragePath, "utf8"));

/** @type {Array<{ path: string, probes: Array<[string, string]> }>} */
const files = [
  {
    path: path.resolve("src/dispatch-co-lifecycle.js"),
    probes: [
      ["snapshot conflict scan", "const conflicts = planConflictRows(rows, cleanRef);"],
      ["assignment fallback", "if (assignedPlanId && !conflicts.some"],
      ["global cancellation rejection", "throw new DispatchCoAlreadyPlannedError(cleanRef, conflicts);"],
      ["serialized cancellation write", "SET status = 'cancelled',"],
      ["save/cancel inactive assertion", "if (conflicts.length) throw new DispatchCoNotActiveError(conflicts);"],
      ["global relationship hydration", "const orders = (plan.orders || []).map((order) => applyActiveTransitCoMetadata("]
    ]
  },
  {
    path: path.resolve("src/dispatch-co-recovery.js"),
    probes: [
      ["recovery predicate validation", "const validation = validateRecoveryState({ co, lines, plan });"],
      ["dry-run branch", "if (!apply || validation.alreadyRecovered) return base;"],
      ["exact recovery update", "SET status = 'pending_load',"],
      ["line preservation verification", "if (fingerprint(updatedLines.rows) !== lineFingerprint)"],
      ["durable recovery audit", "await writeDispatchAudit({"]
    ]
  },
  {
    path: path.resolve("src/dispatch-planner-performance.js"),
    probes: [
      ["active relationship application", "export function applyActiveTransitCoMetadata(order = {}, activeCos = []) {"],
      ["original pickup capture", "next.transitOriginalPickupLocations = originalPickups.filter((location) => {"]
    ]
  },
  {
    path: path.resolve("src/dispatch-plan-repository.js"),
    probes: [
      ["legacy save lifecycle assertion", "await assertActiveDispatchCosForPlan({"]
    ]
  }
];

/**
 * @param {string} source
 * @param {string} needle
 * @returns {number}
 */
function lineFor(source, needle) {
  const offset = source.indexOf(needle);
  assert.notEqual(offset, -1, `${needle}: coverage probe source was not found.`);
  return source.slice(0, offset).split("\n").length;
}

/**
 * @param {FileCoverage} coverage
 * @param {number} line
 * @returns {number}
 */
function statementHits(coverage, line) {
  const candidates = Object.entries(coverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .sort((left, right) => (
      (left[1].end.line - left[1].start.line) - (right[1].end.line - right[1].start.line)
    ));
  assert(candidates.length, `No instrumented statement contains changed line ${line}.`);
  const candidate = candidates[0];
  assert(candidate, `No instrumented statement contains changed line ${line}.`);
  return Number(coverage.s[candidate[0]] || 0);
}

let executed = 0;
for (const file of files) {
  const source = await readFile(file.path, "utf8");
  const coverage = Object.values(document).find((entry) => path.resolve(String(entry.path || "")) === file.path);
  assert(coverage, `${path.basename(file.path)} coverage was not recorded.`);
  for (const [label, needle] of file.probes) {
    const line = lineFor(source, needle);
    assert.ok(statementHits(coverage, line) > 0, `${label} was not executed (line ${line}).`);
    executed += 1;
  }
}

process.stdout.write(`Dispatch CO changed-line probes: ${executed}/${executed} executed.\n`);
