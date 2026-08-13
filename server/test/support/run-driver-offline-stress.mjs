// @ts-check

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateStressEvidence } from "./driver-offline-stress-artifacts.mjs";
import {
  DEFAULT_STRESS_SEED,
  selectStressCases,
  validateStressMatrix
} from "./driver-offline-stress-matrix.mjs";

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

const mode = process.argv[2] || "full";
if (!["smoke", "full", "stable-drain"].includes(mode)) {
  throw new Error("Usage: node test/support/run-driver-offline-stress.mjs {smoke|full|stable-drain}");
}
const seed = Number(process.env.DOS_STRESS_SEED || DEFAULT_STRESS_SEED);
if (!Number.isSafeInteger(seed) || seed < 1) {throw new Error("DOS_STRESS_SEED must be a positive integer.");}
const caseId = String(process.env.DOS_STRESS_CASE_ID || "").trim();
const selectedCases = selectStressCases({ mode, caseId, seed });
const validation = validateStressMatrix();
if (!validation.valid) {throw new Error(validation.errors.join("\n"));}

const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
const runIdOverride = String(process.env.DOS_STRESS_RUN_ID_OVERRIDE || "").trim();
if (runIdOverride && !/^[a-z0-9][a-z0-9._-]{0,120}$/u.test(runIdOverride)) {
  throw new Error("DOS_STRESS_RUN_ID_OVERRIDE is invalid.");
}
const runId = runIdOverride || `${mode}-seed-${seed}-${timestamp}`;
const runDirectory = path.resolve("test-artifacts/driver-offline-stress/runs", runId);
await mkdir(path.join(runDirectory, "cases"), { recursive: true });

const environment = {
  ...process.env,
  DOS_STRESS_MODE: mode,
  DOS_STRESS_SEED: String(seed),
  DOS_STRESS_RUN_ID: runId,
  DOS_STRESS_RUN_DIR: runDirectory,
  ...(caseId ? { DOS_STRESS_CASE_ID: caseId } : {})
};
process.env.DOS_STRESS_MODE = mode;
process.env.DOS_STRESS_SEED = String(seed);
process.env.DOS_STRESS_RUN_ID = runId;
process.env.DOS_STRESS_RUN_DIR = runDirectory;
if (caseId) {process.env.DOS_STRESS_CASE_ID = caseId;}
/** @type {StressCommand[]} */
const commands = [];

/** @param {string} label @param {string} command @param {string[]} args @returns {Promise<number>} */
function run(label, command, args) {
  return new Promise((resolve) => {
    process.stdout.write(`\n[driver-offline-stress] ${label}\n`);
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit"
    });
    child.on("error", (error) => {
      commands.push({ label, command: [command, ...args], exitCode: 1, durationMs: Date.now() - startedAt, error: error.message });
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const exitCode = code ?? 1;
      commands.push({ label, command: [command, ...args], exitCode, signal: signal || "", durationMs: Date.now() - startedAt });
      resolve(exitCode);
    });
  });
}

await writeFile(path.join(runDirectory, "run.json"), `${JSON.stringify({
  schemaVersion: 1,
  runId,
  mode,
  seed,
  caseId,
  soakPhase: String(process.env.DOS_STRESS_SOAK_PHASE || "standalone"),
  networkProfile: String(process.env.DOS_STRESS_NETWORK_PROFILE || "fault-cycling"),
  requestedCaseIds: selectedCases.map(({ id }) => id),
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`
}, null, 2)}\n`, "utf8");

let infrastructureFailure = false;
const propertyStatus = await run(
  "property, mutation-probe, matrix, and sanitization contracts",
  process.execPath,
  ["--test", "--test-concurrency=1", "test/mbt/property/driver-offline-stress-contract.test.js"]
);
infrastructureFailure ||= propertyStatus !== 0;

if (selectedCases.some(({ runtime }) => runtime === "node-postgresql")) {
  const nodeStatus = await run(
    "Node/PostgreSQL named cases",
    process.execPath,
    ["--test", "--test-concurrency=1", "test/driver-offline-stress/node-contract.test.js"]
  );
  infrastructureFailure ||= nodeStatus !== 0;
}

if (selectedCases.some(({ runtime }) => runtime === "browser")) {
  const playwrightStatus = await run(
    "real-browser IndexedDB named cases",
    path.resolve("node_modules/.bin/playwright"),
    ["test", "--config", "test/driver-offline-stress.playwright.config.mjs"]
  );
  infrastructureFailure ||= playwrightStatus !== 0;
}

const report = await generateStressEvidence({ selectedCases, mode, seed, runId, commands });
await writeFile(path.join(runDirectory, "commands.json"), `${JSON.stringify(commands, null, 2)}\n`, "utf8");
console.log(`\n[driver-offline-stress] evidence: ${path.join(runDirectory, "evidence.md")}`);
console.log(`[driver-offline-stress] ${report.passed}/${report.requested} passed; ${report.failed} failed; ${report.missing} missing.`);

if (
  infrastructureFailure
  || report.executed !== report.requested
  || report.failed > 0
  || report.missing > 0
) {
  process.exitCode = 1;
}
