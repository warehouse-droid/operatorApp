import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function reportedFile(value, fallback) {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return fallback;
}

function collectSuiteTests(suite, inheritedFile) {
  const suiteFile = reportedFile(suite?.file, inheritedFile);
  const directTests = asArray(suite?.specs).flatMap((spec) => {
    const specFile = reportedFile(spec?.file, suiteFile);
    return asArray(spec?.tests).map((playwrightTest) => ({ playwrightTest, spec, file: specFile }));
  });
  const nestedTests = asArray(suite?.suites)
    .flatMap((nestedSuite) => collectSuiteTests(nestedSuite, suiteFile));
  return [...directTests, ...nestedTests];
}

function collectTests(suites) {
  return asArray(suites).flatMap((suite) => collectSuiteTests(suite, ""));
}

function annotationsFor(playwrightTest) {
  const resultAnnotations = asArray(playwrightTest?.results)
    .flatMap((result) => asArray(result?.annotations));
  return [
    ...asArray(playwrightTest?.annotations),
    ...resultAnnotations
  ];
}

function isSkipped(playwrightTest) {
  const results = asArray(playwrightTest?.results);
  return playwrightTest?.expectedStatus === "skipped"
    || results.some((result) => result?.status === "skipped")
    || annotationsFor(playwrightTest).some((annotation) => (
      annotation?.type === "skip" || annotation?.type === "fixme"
    ));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertReportContainers(report) {
  if (!isRecord(report) || !Array.isArray(report.suites) || !isRecord(report.stats)) {
    throw new TypeError("A valid Playwright JSON report is required.");
  }
  if (!Array.isArray(report.errors)) {
    throw new TypeError("A valid Playwright JSON report must expose report-level errors.");
  }
}

function assertReportOutcome(report) {
  if (report.errors.length > 0) {
    throw new Error("The Playwright JSON report contains report-level errors.");
  }
  if (report.stats.unexpected !== 0) {
    throw new Error("The Playwright JSON report contains unexpected tests.");
  }
  if (report.stats.flaky !== 0) {
    throw new Error("The Playwright JSON report contains flaky tests.");
  }
  if (!Number.isSafeInteger(report.stats.skipped) || report.stats.skipped < 0) {
    throw new TypeError("The Playwright JSON report skip count is invalid.");
  }
}

export function assertMbtPlaywrightReport(report) {
  assertReportContainers(report);
  assertReportOutcome(report);
  const tests = collectTests(report.suites);
  const skipped = tests.filter(({ playwrightTest }) => isSkipped(playwrightTest));
  if (skipped.length !== 0) {
    throw new Error("The Playwright JSON report contains a forbidden runtime skip.");
  }
  if (report.stats.skipped !== skipped.length) {
    throw new Error("The Playwright JSON report skip count does not match its test results.");
  }
  return {
    schemaVersion: "mbt-playwright-report-validation-v1",
    totalTests: tests.length,
    skippedTests: skipped.length,
    disclosedSkips: 0
  };
}

async function main() {
  const reportPath = path.resolve(process.argv[2] || "test-artifacts/playwright/report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  console.log(JSON.stringify(assertMbtPlaywrightReport(report)));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
