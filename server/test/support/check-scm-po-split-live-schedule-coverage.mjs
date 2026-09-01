// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {"ui" | "catalog" | "revision"} ReportKey */
/** @typedef {{ report: ReportKey, file: string, label: string, needle: string }} CoverageProbe */
/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

/** @type {Record<ReportKey, string>} */
const reports = {
  ui: process.argv[2] || "test-artifacts/scm-po-split-live-schedule/ui/coverage-final.json",
  catalog: process.argv[3] || "test-artifacts/scm-po-split-live-schedule/catalog/coverage-final.json",
  revision: process.argv[4] || "test-artifacts/scm-po-split-live-schedule/revision/coverage-final.json"
};

/** @type {readonly CoverageProbe[]} */
const probes = Object.freeze([
  {
    report: "ui",
    file: "public/dispatch-scm.js",
    label: "sub-millisecond revision precision is retained",
    needle: 'fractional: fractional.padEnd(9, "0").slice(0, 9)'
  },
  {
    report: "ui",
    file: "public/dispatch-scm.js",
    label: "card and detail revisions are ordered",
    needle: "const detailIsAtLeastAsFresh = detailRevision.milliseconds > cardRevision.milliseconds"
  },
  {
    report: "ui",
    file: "public/dispatch-scm.js",
    label: "one complete winning schedule state is selected",
    needle: "scm: detailIsAtLeastAsFresh"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "catalog overlay reads exact live schedule precision",
    needle: ") AS schedule_concurrency_updated_at,"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "catalog overlay reads live editable fields",
    needle: "schedule.method AS schedule_method,"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "editable state is mapped to the exact PO identity",
    needle: "const exactScheduleEvidence = evidenceByRef.get(text(orderRef(order)).toLowerCase()) || {};"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "live method replaces persisted catalog method",
    needle: 'method: text(exactScheduleEvidence.schedule_method) || "MBT",'
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "live assignment supplies a missing schedule ETA date",
    needle: "|| text(order.dispatchPlanDate) || text(order.scm?.etaDate),"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "live assignment supplies a missing schedule ETA time",
    needle: "|| text(order.dispatchEtaTime) || text(order.scm?.etaTime),"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "live assignment supplies a missing schedule driver",
    needle: "|| text(order.dispatchDriverName) || text(order.dispatchDriverLogin)"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "live assignment supplies a missing schedule load annotation",
    needle: "|| assignmentScheduleNotes(order) || text(order.scm?.notes),"
  },
  {
    report: "catalog",
    file: "src/scm-purchase-order-catalog-repository.js",
    label: "optimistic revision uses the exact microsecond token",
    needle: "? exactScheduleEvidence.schedule_concurrency_updated_at"
  },
  {
    report: "revision",
    file: "src/dispatch-repository.js",
    label: "schedule save rereads the final committed PO identity",
    needle: "const committed = await query("
  },
  {
    report: "revision",
    file: "src/dispatch-repository.js",
    label: "schedule save returns the committed row",
    needle: "return committed.rows[0] || result.rows[0];"
  },
  {
    report: "revision",
    file: "src/dispatch-repository.js",
    label: "unchanged PO refs do not rewrite the mirror",
    needle: "AND COALESCE(dispatch_ref, '') IS DISTINCT FROM $2"
  },
  {
    report: "revision",
    file: "src/dispatch-repository.js",
    label: "reference synchronization advances time monotonically",
    needle: "updated_at = GREATEST(clock_timestamp(), s.updated_at + interval '1 microsecond')"
  },
  {
    report: "revision",
    file: "src/dispatch-repository.js",
    label: "unchanged schedule references are a no-op",
    needle: "s.packing_slip_ref IS DISTINCT FROM NULLIF($3, '')"
  }
]);

/** @type {Map<ReportKey, Record<string, FileCoverage>>} */
const reportDocuments = new Map();
/** @type {Map<string, string>} */
const sourceDocuments = new Map();

/**
 * @param {ReportKey} key
 * @returns {Promise<Record<string, FileCoverage>>}
 */
async function reportDocument(key) {
  let document = reportDocuments.get(key);
  if (document === undefined) {
    const reportPath = reports[key];
    assert.ok(reportPath, `Unknown coverage report ${key}.`);
    /** @type {Record<string, FileCoverage>} */
    const loadedDocument = JSON.parse(await readFile(path.resolve(reportPath), "utf8"));
    reportDocuments.set(key, loadedDocument);
    document = loadedDocument;
  }
  return document;
}

/** @param {string} file */
async function sourceDocument(file) {
  let source = sourceDocuments.get(file);
  if (source === undefined) {
    source = await readFile(path.resolve(file), "utf8");
    sourceDocuments.set(file, source);
  }
  return source;
}

/** @param {string} file @param {string} needle */
async function lineFor(file, needle) {
  const source = await sourceDocument(file);
  const offset = source.indexOf(needle);
  assert.notEqual(offset, -1, `Coverage marker not found in ${file}: ${needle}`);
  return source.slice(0, offset).split("\n").length;
}

for (const probe of probes) {
  const document = await reportDocument(probe.report);
  const expectedPath = path.resolve(probe.file);
  const coverage = Object.values(document).find((entry) =>
    path.resolve(String(entry?.path || "")) === expectedPath
  );
  assert.ok(coverage, `${probe.label}: ${probe.file} is missing from ${probe.report} coverage.`);
  const line = await lineFor(probe.file, probe.needle);
  const statementIds = Object.entries(coverage.statementMap || {})
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .map(([id]) => id);
  assert.ok(statementIds.length, `${probe.label}: no statement contains line ${line}.`);
  assert.ok(statementIds.some((id) => Number(coverage.s?.[id] || 0) > 0),
    `${probe.label}: changed line ${line} was not executed.`);
}

console.log(JSON.stringify({
  ok: true,
  changedLineProbeCoverage: "100%",
  probes: probes.length,
  files: [...new Set(probes.map((probe) => probe.file))]
}));
