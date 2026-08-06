import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertMbtPlaywrightReport } from "../../support/validate-playwright-report.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const validatorPath = path.resolve(testDirectory, "../../support/validate-playwright-report.mjs");

function testResult({
  expectedStatus = "passed",
  resultStatus = "passed",
  annotations = [],
  stats = {}
} = {}) {
  return {
    config: { projects: [{ id: "webkit-mobile", name: "webkit-mobile" }] },
    suites: [{
      title: "p3-driver-bin-offline.spec.js",
      file: "p3-driver-bin-offline.spec.js",
      specs: [{
        title: "airplane draft preserves exact evidence",
        file: "p3-driver-bin-offline.spec.js",
        tests: [{
          annotations,
          expectedStatus,
          projectName: "webkit-mobile",
          results: [{ status: resultStatus, annotations, errors: [] }]
        }]
      }]
    }],
    errors: [],
    stats: {
      expected: 1,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
      ...stats
    }
  };
}

test("P3 gauntlet: a fully executed WebKit evidence test is accepted with zero skips", () => {
  assert.deepEqual(assertMbtPlaywrightReport(testResult()), {
    schemaVersion: "mbt-playwright-report-validation-v1",
    totalTests: 1,
    skippedTests: 0,
    disclosedSkips: 0
  });
});

test("P3 gauntlet: every runtime skip and fixme fails closed", () => {
  for (const report of [
    testResult({
      expectedStatus: "skipped",
      resultStatus: "skipped",
      annotations: [{ type: "skip", description: "browser limitation" }],
      stats: { expected: 0, skipped: 1 }
    }),
    testResult({ annotations: [{ type: "fixme", description: "later" }] })
  ]) {
    assert.throws(() => assertMbtPlaywrightReport(report), /forbidden runtime skip/i);
  }
});

test("P3 gauntlet: statistically hidden or fabricated skips fail closed", () => {
  const hidden = testResult({
    expectedStatus: "skipped",
    resultStatus: "skipped",
    annotations: [{ type: "skip", description: "hidden" }]
  });
  assert.throws(() => assertMbtPlaywrightReport(hidden), /forbidden runtime skip/i);

  const fabricated = testResult({ stats: { expected: 0, skipped: 1 } });
  assert.throws(() => assertMbtPlaywrightReport(fabricated), /skip count/i);
});

test("P3 gauntlet: malformed or failing Playwright reports fail closed", () => {
  assert.throws(() => assertMbtPlaywrightReport(null), /valid Playwright JSON report/i);

  const missingErrors = testResult();
  delete missingErrors.errors;
  assert.throws(() => assertMbtPlaywrightReport(missingErrors), /expose report-level errors/i);

  const reportError = testResult();
  reportError.errors.push({ message: "global teardown failed" });
  assert.throws(() => assertMbtPlaywrightReport(reportError), /report-level errors/i);

  assert.throws(
    () => assertMbtPlaywrightReport(testResult({ stats: { unexpected: 1 } })),
    /unexpected tests/i
  );
  assert.throws(
    () => assertMbtPlaywrightReport(testResult({ stats: { flaky: 1 } })),
    /flaky tests/i
  );
  assert.throws(
    () => assertMbtPlaywrightReport(testResult({ stats: { skipped: -1 } })),
    /skip count is invalid/i
  );
});

test("P3 gauntlet: the persisted CLI validates a zero-skip JSON report", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mbt-playwright-report-"));
  try {
    const reportPath = path.join(temporaryDirectory, "report.json");
    await writeFile(reportPath, JSON.stringify(testResult()));
    const result = spawnSync(process.execPath, [validatorPath, reportPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: "mbt-playwright-report-validation-v1",
      totalTests: 1,
      skippedTests: 0,
      disclosedSkips: 0
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
