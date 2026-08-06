import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { assertMbtPlaywrightReport } from "../../support/validate-playwright-report.mjs";

function report({
  expectedStatus = "passed",
  resultStatus = "passed",
  annotations = [],
  skipped = 0,
  unexpected = 0,
  flaky = 0,
  errors = []
} = {}) {
  return {
    suites: [{
      file: "p3-driver-bin-offline.spec.js",
      specs: [{
        title: "exact evidence",
        tests: [{
          expectedStatus,
          projectName: "webkit-mobile",
          annotations,
          results: [{ status: resultStatus, annotations, errors: [] }]
        }]
      }]
    }],
    errors,
    stats: { expected: 1, skipped, unexpected, flaky }
  };
}

test("P3 gauntlet property: arbitrary runtime skip annotations always fail closed", () => {
  fc.assert(fc.property(
    fc.string({ minLength: 0, maxLength: 200 }),
    (description) => {
      const annotation = { type: "skip", description };
      assert.throws(() => assertMbtPlaywrightReport(report({
        expectedStatus: "skipped",
        resultStatus: "skipped",
        annotations: [annotation],
        skipped: 1
      })));
    }
  ), { numRuns: 1_000, seed: 2026080501 });
});

test("P3 gauntlet property: hidden and fabricated skip signals always fail closed", () => {
  assert.throws(() => assertMbtPlaywrightReport(report({ expectedStatus: "skipped" })));
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 10_000 }),
    (skipped) => {
      assert.throws(() => assertMbtPlaywrightReport(report({ skipped })));
    }
  ), { numRuns: 1_000, seed: 2026080502 });
});

test("P3 gauntlet property: each report-level failure signal independently fails closed", () => {
  for (const invalid of [
    report({ errors: [{ message: "teardown" }] }),
    report({ unexpected: 1 }),
    report({ flaky: 1 })
  ]) {
    assert.throws(() => assertMbtPlaywrightReport(invalid));
  }

  assert.doesNotThrow(() => assertMbtPlaywrightReport(report()));
});
