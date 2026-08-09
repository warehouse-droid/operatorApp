// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const INTEGRATION_TEST = "test/dispatch/integration/dispatch-save-recovery.red.test.js";
const CONCURRENCY_TEST = "test/dispatch/concurrency/dispatch-save-recovery-concurrency.red.test.js";
const RETENTION_TEST = "test/dispatch/integration/dispatch-v2-retention-outbox.red.test.js";
const BROWSER_HARNESS = "src/dispatch-save-coordination-harness.js";

/** @typedef {{name: string, path: string, from: string, to: string, detector: "browser" | "integration" | "retention"}} RecoveryMutant */
/** @type {readonly RecoveryMutant[]} */
const MUTANTS = Object.freeze([
  {
    name: "a repeated failed save inserts another recovery row",
    path: "src/dispatch-plan-repository.js",
    from: "if (existingRecovery) {",
    to: "if (false && existingRecovery) {",
    detector: "integration"
  },
  {
    name: "a failed candidate is written into the active snapshot",
    path: "src/server.js",
    from: "const recoveryDraft = await saveDispatchPlanRecoveryDraft(previousPlan.id, {",
    to: "const recoveryDraft = await saveDispatchPlanSnapshot(previousPlan.id, {",
    detector: "integration"
  },
  {
    name: "the recovery response claims the rejected candidate was applied",
    path: "src/server.js",
    from: "saved: true,\n    applied: false,\n    validationIssues,",
    to: "saved: true,\n    applied: true,\n    validationIssues,",
    detector: "integration"
  },
  {
    name: "business validation errors bypass durable recovery",
    path: "src/server.js",
    from: "return Number(error?.status) === 409",
    to: "return Number(error?.status) === 500",
    detector: "integration"
  },
  {
    name: "the browser clears the dirty state after backup-only acknowledgement",
    path: "public/dispatch.js",
    from: "if (responsePayload?.applied === false && responsePayload?.recoveryDraft) {\n      localPlanDirty = true;",
    to: "if (responsePayload?.applied === false && responsePayload?.recoveryDraft) {\n      localPlanDirty = false;",
    detector: "browser"
  },
  {
    name: "checkpoint retention deletes a durable recovery draft",
    path: "src/dispatch-planner-v2-repository.js",
    from: "AND archive_reason <> 'save_recovery'",
    to: "AND archive_reason = 'save_recovery'",
    detector: "retention"
  }
]);

/** @param {string} value @returns {string} */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle @returns {number} */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} file @returns {Promise<number>} */
function runNode(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        return reject(new Error(`${file} exited on signal ${signal}.`));
      }
      resolve(code ?? 1);
    });
  });
}

/** @param {"browser" | "integration" | "retention"} detector @param {string} label @returns {Promise<number>} */
async function runDetector(detector, label) {
  if (detector === "browser") {
    return runNode(BROWSER_HARNESS);
  }
  if (detector === "retention") {
    return runNodeTestFilesIsolated([RETENTION_TEST], {
      environment: process.env,
      label
    });
  }
  return runNodeTestFilesIsolated([INTEGRATION_TEST], {
    environment: process.env,
    label
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch save-recovery mutations require the writable disposable MBT test container.");
}

const originals = new Map();
for (const mutant of MUTANTS) {
  const target = path.resolve(mutant.path);
  if (!originals.has(target)) {
    originals.set(target, await readFile(target, "utf8"));
  }
}
const originalHashes = new Map([...originals].map(([target, source]) => [target, sha256(source)]));
let killed = 0;

try {
  for (const mutant of MUTANTS) {
    const target = path.resolve(mutant.path);
    const original = originals.get(target);
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target in ${mutant.path}.`);
    }
    await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
    const result = await runDetector(mutant.detector, `Dispatch recovery mutant: ${mutant.name}`);
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused detector.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(target, original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(target, original, "utf8");
  }
  for (const [target, originalHash] of originalHashes) {
    if (sha256(await readFile(target, "utf8")) !== originalHash) {
      throw new Error(`Dispatch save-recovery mutation source restoration failed: ${target}`);
    }
  }
}

if (killed !== MUTANTS.length) {
  throw new Error(`Dispatch save-recovery mutation score ${killed}/${MUTANTS.length}.`);
}
if (await runNode(BROWSER_HARNESS) !== 0) {
  throw new Error("The browser recovery harness failed after restoring mutation sources.");
}
const finalResult = await runNodeTestFilesIsolated([INTEGRATION_TEST, CONCURRENCY_TEST, RETENTION_TEST], {
  environment: process.env,
  label: "Dispatch recovery post-mutation green"
});
if (finalResult !== 0) {
  throw new Error("Recovery tests failed after restoring mutation sources.");
}

console.log(`Dispatch save-recovery mutation score: ${killed}/${MUTANTS.length} killed (100%); all sources restored.`);
