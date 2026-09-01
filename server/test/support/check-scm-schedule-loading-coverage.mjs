// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{ file: string, label: string, needle: string, occurrence?: number }} CoverageProbe
 * @typedef {{
 *   path?: string,
 *   statementMap: Record<string, { start: { line: number }, end: { line: number } }>,
 *   s: Record<string, number>
 * }} FileCoverage
 */

const reportPath = path.resolve(
  process.argv[2] || "test-artifacts/scm-schedule-loading/coverage/coverage-final.json"
);
/** @type {Record<string, FileCoverage>} */
const coverageDocument = JSON.parse(await readFile(reportPath, "utf8"));

/** @type {readonly CoverageProbe[]} */
const probes = Object.freeze([
  {
    file: "src/dispatch-repository.js",
    label: "Completed history requires an explicit opt-in",
    needle: "const includeCompleted = cleanView === \"completed\""
  },
  {
    file: "src/dispatch-repository.js",
    label: "the schedule query uses the assignment projection",
    needle: "FROM dispatch_plan_order_assignments assignment",
    occurrence: 3
  },
  {
    file: "src/dispatch-repository.js",
    label: "cancelled plans are excluded from projected planning state",
    needle: "AND p.status <> 'cancelled'",
    occurrence: 2
  },
  {
    file: "src/dispatch-repository.js",
    label: "closed PO families use the set projection",
    needle: "WHERE closed_family.netsuite_id = po.netsuite_id"
  },
  {
    file: "src/dispatch-repository.js",
    label: "default schedule loading filters completed work",
    needle: "OR LOWER(BTRIM(effective_status.status)) NOT IN ('complete', 'completed')"
  },
  {
    file: "src/dispatch-repository.js",
    label: "normal schedule loading removes zero-residual source POs",
    needle: "HAVING $24::boolean"
  },
  {
    file: "src/dispatch-planner-v2-repository.js",
    label: "assignment ETA is projected from route minutes",
    needle: "Math.floor(minute / 60)"
  },
  {
    file: "src/dispatch-planner-v2-repository.js",
    label: "assignment order kind is persisted",
    needle: "dispatchOrderKind: orderKind"
  }
]);

/** @type {Map<string, string>} */
const sourceCache = new Map();
/** @type {Map<string, FileCoverage>} */
const coverageCache = new Map();

/** @param {string} file */
async function sourceFor(file) {
  let source = sourceCache.get(file);
  if (source === undefined) {
    source = await readFile(path.resolve(file), "utf8");
    sourceCache.set(file, source);
  }
  return source;
}

/** @param {string} file */
function coverageFor(file) {
  let fileCoverage = coverageCache.get(file);
  if (fileCoverage === undefined) {
    const expected = path.resolve(file);
    const located = Object.values(coverageDocument).find((entry) =>
      path.resolve(String(entry?.path || "")) === expected
    );
    assert.ok(located, `${file} is missing from the c8 report.`);
    coverageCache.set(file, located);
    fileCoverage = located;
  }
  return fileCoverage;
}

/** @param {CoverageProbe} probe */
async function lineFor(probe) {
  const source = await sourceFor(probe.file);
  let offset = -1;
  for (let index = 0; index < (probe.occurrence || 1); index += 1) {
    offset = source.indexOf(probe.needle, offset + 1);
    assert.notEqual(offset, -1, `${probe.label}: source marker was not found.`);
  }
  return source.slice(0, offset).split("\n").length;
}

/** @param {FileCoverage} fileCoverage @param {number} line */
function statementHitsAtLine(fileCoverage, line) {
  return Object.entries(fileCoverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .map(([id]) => Number(fileCoverage.s[id] || 0));
}

for (const probe of probes) {
  const line = await lineFor(probe);
  const hits = statementHitsAtLine(coverageFor(probe.file), line);
  assert.ok(hits.length, `${probe.label}: no instrumented statement contains line ${line}.`);
  assert.ok(hits.some((count) => count > 0), `${probe.label}: line ${line} was not executed.`);
}

console.log(JSON.stringify({
  ok: true,
  probes: probes.length,
  files: [...new Set(probes.map((probe) => probe.file))]
}));
