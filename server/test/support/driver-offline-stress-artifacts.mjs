// @ts-check

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeDiagnostic } from "./driver-offline-stress-model.mjs";

/** @typedef {{id: string, title: string, group: string, runtime: string, project: string}} StressCase */
/** @typedef {{organicErrors?: Record<string, unknown>[], injectedFaults?: Record<string, unknown>[]}} StressMetrics */
/**
 * @typedef {Record<string, unknown> & {
 *   id: string,
 *   title?: string,
 *   project: string,
 *   runtime: string,
 *   outcome: string,
 *   error?: unknown,
 *   metrics?: StressMetrics
 * }} StressResult
 */
/**
 * @typedef {{
 *   label: string,
 *   command: string[],
 *   exitCode: number,
 *   durationMs: number,
 *   signal?: string,
 *   error?: string
 * }} StressCommand
 */
/**
 * @typedef {{
 *   schemaVersion: number,
 *   runId: string,
 *   mode: string,
 *   seed: number,
 *   generatedAt: string,
 *   requested: number,
 *   executed: number,
 *   passed: number,
 *   failed: number,
 *   missing: number,
 *   browserAssignments: Record<string, number>,
 *   iOSProof: string,
 *   sourceState: {algorithm: string, digest: string, files: string[]},
 *   toolVersions: Record<string, string>,
 *   commands: StressCommand[],
 *   results: StressResult[]
 * }} StressReport
 */

function safeRunDirectory() {
  const configured = String(process.env.DOS_STRESS_RUN_DIR || "").trim();
  if (!configured) {throw new Error("DOS_STRESS_RUN_DIR is required for stress evidence.");}
  const absolute = path.resolve(configured);
  const artifactRoot = path.resolve("test-artifacts/driver-offline-stress/runs");
  if (absolute !== artifactRoot && !absolute.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error(`Stress evidence path is outside ${artifactRoot}.`);
  }
  return absolute;
}

/** @param {StressCase} testCase @param {Record<string, unknown>} result */
export async function recordStressResult(testCase, result) {
  const runDirectory = safeRunDirectory();
  const casesDirectory = path.join(runDirectory, "cases");
  await mkdir(casesDirectory, { recursive: true });
  const sanitized = sanitizeDiagnostic({
    schemaVersion: 1,
    id: testCase.id,
    title: testCase.title,
    group: testCase.group,
    runtime: testCase.runtime,
    project: testCase.project,
    seed: Number(process.env.DOS_STRESS_SEED || 20260812),
    soakPhase: String(process.env.DOS_STRESS_SOAK_PHASE || "standalone"),
    networkProfile: String(process.env.DOS_STRESS_NETWORK_PROFILE || "fault-cycling"),
    recordedAt: new Date().toISOString(),
    ...result
  });
  await writeFile(
    path.join(casesDirectory, `${testCase.id}.json`),
    `${JSON.stringify(sanitized, null, 2)}\n`,
    "utf8"
  );
}

/** @param {string} runDirectory @returns {Promise<StressResult[]>} */
async function readResults(runDirectory) {
  const directory = path.join(runDirectory, "cases");
  /** @type {string[]} */
  let files = [];
  try {
    files = (await readdir(directory)).filter((name) => /^DOS-\d{3}\.json$/u.test(name)).sort();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {throw error;}
  }
  return Promise.all(files.map(async (name) => /** @type {StressResult} */ (
    JSON.parse(await readFile(path.join(directory, name), "utf8"))
  )));
}

export async function stressSourceState() {
  const files = [
    "package.json",
    "public/driver.html",
    "public/driver-service-worker.js",
    "public/driver.css",
    "public/i18n.css",
    "public/i18n.js",
    "public/driver-offline-db.js",
    "public/driver-photo-hash.js",
    "public/driver-offline-photos.js",
    "public/driver-offline-sync.js",
    "public/driver-bin-ui.js",
    "public/driver.js",
    "src/driver-client-version.js",
    "src/driver-client-version-harness.js",
    "src/driver-offline-client-harness.js",
    "src/driver-offline-repository.js",
    "src/driver-photo-integrity-harness.js",
    "test/driver-offline-stress.playwright.config.mjs",
    "test/driver-offline-soak.compose.yml",
    "test/driver-offline-stress-spec.md",
    "test/driver-offline-stress/browser.spec.js",
    "test/driver-offline-stress/node-contract.test.js",
    "test/fixtures/driver-offline-stress-history.json",
    "test/mbt/property/driver-offline-stress-contract.test.js",
    "test/mbt/e2e/driver-pwa-cache-repair.spec.js",
    "test/mbt/unit/driver-pwa-cache-repair.test.js",
    "test/mbt/unit/driver-pwa-recovery-assets.test.js",
    "test/mbt/unit/driver-camera-ordinary-upload.test.js",
    "test/support/driver-offline-stress-artifacts.mjs",
    "test/support/driver-offline-soak-state.mjs",
    "test/support/driver-offline-stress-matrix.mjs",
    "test/support/driver-offline-stress-model.mjs",
    "test/support/run-driver-offline-soak.mjs",
    "test/support/run-driver-offline-stress-mutations.mjs",
    "test/support/run-driver-offline-stress.mjs",
    "test/support/validate-driver-offline-stress-matrix.mjs"
  ];
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file);
    digest.update(await readFile(file));
  }
  return { algorithm: "sha256", digest: digest.digest("hex"), files };
}

async function toolVersions() {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  return {
    node: process.version,
    playwright: packageJson.devDependencies?.["@playwright/test"] || "unknown",
    fastCheck: packageJson.devDependencies?.["fast-check"] || "unknown",
    c8: packageJson.devDependencies?.c8 || "unknown",
    postgresqlDriver: packageJson.dependencies?.pg || "unknown"
  };
}

/** @param {StressReport} report */
function markdownReport(report) {
  const failedRows = report.results
    .filter(({ outcome }) => outcome !== "passed")
    .map(({ id, project, error }) => `| ${id} | ${project} | ${String(error || "missing result").replaceAll("|", "\\|")} |`)
    .join("\n");
  const organic = report.results.flatMap(({ id, metrics }) => (
    (metrics?.organicErrors || []).map((error) => ({ id, ...error }))
  ));
  const injected = report.results.flatMap(({ id, metrics }) => (
    (metrics?.injectedFaults || []).map((fault) => ({ id, ...fault }))
  ));
  return `# Driver offline stress evidence

- Run ID: \`${report.runId}\`
- Mode: \`${report.mode}\`
- Seed: \`${report.seed}\`
- Requested/executed/passed/failed/missing: **${report.requested}/${report.executed}/${report.passed}/${report.failed}/${report.missing}**
- Browser assignment: ${JSON.stringify(report.browserAssignments)}
- Source SHA-256: \`${report.sourceState.digest}\`
- Tool versions: ${JSON.stringify(report.toolVersions)}
- Historical input: deterministic anonymized aggregate clone; no driver, customer, address, device, or object IDs copied.
- iOS scope: Playwright mobile WebKit emulation only. This is not physical iPhone/CriOS proof.

## Error separation

- Organic IndexedDB errors: **${organic.length}**
- Deliberately injected IndexedDB/network/quota faults: **${injected.length}**
- Historical production signature guarded: \`driver_indexeddb_unknownerror\` / “Error preparing Blob/File data to be stored in object store”.

## Failed or missing cases

| Case | Runtime | Failure |
|---|---|---|
${failedRows || "| — | — | None |"}

## Safety interpretation

An injected fault is a passing detector when the application retains immutable evidence and later converges. A desired-behavior assertion remains failed when production does not meet it; the report never converts that defect into a pass. The remediation recommendation is in \`test/driver-offline-stress-remediation.md\`.
`;
}

/** @param {StressResult[]} [results] @returns {StressResult[]} */
export function sanitizeStressResults(results = []) {
  return results.map((result) => sanitizeDiagnostic(result));
}

/**
 * @param {{
 *   selectedCases: StressCase[],
 *   mode: string,
 *   seed: number,
 *   runId: string,
 *   commands?: StressCommand[]
 * }} input
 * @returns {Promise<StressReport>}
 */
export async function generateStressEvidence({ selectedCases, mode, seed, runId, commands = [] }) {
  const runDirectory = safeRunDirectory();
  const observed = await readResults(runDirectory);
  const byId = new Map(observed.map((result) => [result.id, result]));
  const results = selectedCases.map((testCase) => byId.get(testCase.id) || {
    id: testCase.id,
    title: testCase.title,
    project: testCase.project,
    runtime: testCase.runtime,
    outcome: "missing",
    error: "The test process did not persist a result."
  });
  /** @type {StressReport} */
  const report = {
    ...sanitizeDiagnostic({
    schemaVersion: 1,
    runId,
    mode,
    seed,
    generatedAt: new Date().toISOString(),
    requested: selectedCases.length,
    executed: results.filter(({ outcome }) => outcome !== "missing").length,
    passed: results.filter(({ outcome }) => outcome === "passed").length,
    failed: results.filter(({ outcome }) => outcome === "failed").length,
    missing: results.filter(({ outcome }) => outcome === "missing").length,
    browserAssignments: Object.fromEntries(["webkit-mobile", "chromium-mobile", "chromium-desktop"].map((project) => [
      project,
      selectedCases.filter((testCase) => testCase.project === project).length
    ])),
    iOSProof: "emulation-only",
    sourceState: await stressSourceState(),
    toolVersions: await toolVersions(),
    commands
    }),
    // Keep all 320 named outcomes. Each outcome is still sanitized and bounded
    // independently, while the general diagnostic sanitizer retains its
    // conservative 100-item ceiling for untrusted nested arrays.
    results: sanitizeStressResults(results)
  };
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDirectory, "evidence.md"), markdownReport(report), "utf8");
  await writeFile(
    path.resolve(`test-artifacts/driver-offline-stress/latest-${mode}.json`),
    `${JSON.stringify({ runId, runDirectory, evidence: path.join(runDirectory, "evidence.md") }, null, 2)}\n`,
    "utf8"
  );
  return report;
}
