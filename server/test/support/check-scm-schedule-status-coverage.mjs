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

const reportPath = path.resolve(process.argv[2] || "test-artifacts/scm-schedule-status-coverage/coverage-final.json");
/** @type {Record<string, FileCoverage>} */
const coverageDocument = JSON.parse(await readFile(reportPath, "utf8"));

/** @type {readonly CoverageProbe[]} */
const probes = Object.freeze([
  {
    file: "src/dispatch-repository.js",
    label: "schedule saves distinguish omitted and explicit absence revisions",
    needle: "const revisionSupplied = expectedUpdatedAt !== undefined;"
  },
  {
    file: "src/dispatch-repository.js",
    label: "malformed revisions fail closed",
    needle: "if (revisionSupplied && parsedRevision && Number.isNaN(parsedRevision.getTime()))"
  },
  {
    file: "src/dispatch-repository.js",
    label: "exact microsecond browser revisions are detected",
    needle: "const exactRevision = typeof expectedRevision === \"string\""
  },
  {
    file: "src/dispatch-repository.js",
    label: "successful saves advance the revision monotonically",
    needle: "updated_at = GREATEST(clock_timestamp(), scm_transport_schedule.updated_at + interval '1 microsecond')"
  },
  {
    file: "src/dispatch-repository.js",
    label: "atomic upsert misses become stale conflicts",
    needle: "if (!result.rowCount) {"
  },
  {
    file: "src/dispatch-repository.js",
    label: "active split refs fill blank packing slips",
    needle: "NULLIF(b.split_ref, ''),"
  },
  {
    file: "src/dispatch-repository.js",
    label: "new split schedules retain their split packing reference",
    needle: "packing_slip_ref = COALESCE(NULLIF(scm_transport_schedule.packing_slip_ref, ''), EXCLUDED.packing_slip_ref)"
  },
  {
    file: "src/server.js",
    label: "HTTP saves read the expected revision",
    needle: "if (Object.prototype.hasOwnProperty.call(body, \"expectedUpdatedAt\"))"
  },
  {
    file: "src/server.js",
    label: "HTTP saves reject a missing revision",
    needle: "throw Object.assign(new Error(\"Refresh this schedule row before saving it.\")"
  },
  {
    file: "src/server.js",
    label: "the PUT route passes the required revision to the repository",
    needle: "expectedUpdatedAt: requiredScmScheduleRevision(req.body || {})",
    occurrence: 2
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
