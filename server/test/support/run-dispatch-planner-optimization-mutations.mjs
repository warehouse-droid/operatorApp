// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OPTIMIZATION = path.resolve("src/dispatch-planner-optimization.js");
const REPLAY = path.resolve("src/dispatch-planner-replay.js");
const UNIT = "test/dispatch/unit/dispatch-planner-optimization.red.test.js";
const PROPERTY = "test/dispatch/property/dispatch-planner-delta.property.test.js";
const ADVERSARIAL = "test/dispatch/adversarial/dispatch-planner-history-replay.test.js";

const MUTANTS = Object.freeze([
  {
    name: "legacy orderRef and tranid identities are discarded",
    source: OPTIMIZATION,
    from: "value.id || value.orderId || value.orderRef || value.tranid || value.refNumber || value.plate || fallback",
    to: "value.id || value.orderId || value.refNumber || value.plate || fallback",
    tests: [UNIT]
  },
  {
    name: "a partial replacement is mistaken for a full-board replacement",
    source: OPTIMIZATION,
    from: "Array.isArray(delta.orders) && Array.isArray(delta.trucks)",
    to: "Array.isArray(delta.orders) || Array.isArray(delta.trucks)",
    tests: [UNIT, PROPERTY],
    propertyTests: [PROPERTY]
  },
  {
    name: "an unresolved recovery checkpoint expires",
    source: OPTIMIZATION,
    from: "if (normalized === \"recovery\" && !resolvedAt) {return null;}",
    to: "if (normalized === \"recovery\" && !resolvedAt) {return 90;}",
    tests: [UNIT]
  },
  {
    name: "causal source sequence is sorted newest first",
    source: OPTIMIZATION,
    from: "const sequenceDifference = (Number(left.sourceSequence) || 0) - (Number(right.sourceSequence) || 0);",
    to: "const sequenceDifference = (Number(right.sourceSequence) || 0) - (Number(left.sourceSequence) || 0);",
    tests: [UNIT]
  },
  {
    name: "candidate-only recovery state replaces the active replay plan",
    source: REPLAY,
    from: "if (event.planState && event.candidateOnly !== true) {",
    to: "if (event.planState && event.candidateOnly === true) {",
    tests: [ADVERSARIAL]
  },
  {
    name: "projection mismatches are counted as equal",
    source: REPLAY,
    from: "equal: differences.length === 0,",
    to: "equal: differences.length !== 0,",
    tests: [ADVERSARIAL]
  },
  {
    name: "covered historical interactions are reported as gaps",
    source: REPLAY,
    from: ".filter((key) => Number(interactionCoverage[key] || 0) === 0),",
    to: ".filter((key) => Number(interactionCoverage[key] || 0) > 0),",
    tests: [ADVERSARIAL]
  },
  {
    name: "the exclusive replay end is labeled as the following local day",
    source: REPLAY,
    from: "replayLocalDate(new Date(toTime - 1), timezone)",
    to: "replayLocalDate(new Date(toTime), timezone)",
    tests: [ADVERSARIAL]
  },
  {
    name: "assigned-order snapshot fallback is removed",
    source: REPLAY,
    from: ": Array.isArray(plan.assignedOrderSnapshots) ? plan.assignedOrderSnapshots : [];",
    to: ": [];",
    tests: [ADVERSARIAL]
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string[]} files @returns {Promise<number>} */
function runTests(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...files
    ], { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Mutation test process exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch planner mutation tests may run only in the explicitly ephemeral isolated test image.");
}

const originals = new Map();
for (const source of new Set(MUTANTS.map((mutant) => mutant.source))) {
  const value = await readFile(source, "utf8");
  originals.set(source, { value, hash: sha256(value) });
}

const baselineTests = [...new Set(MUTANTS.flatMap((mutant) => mutant.tests))];
if (await runTests(baselineTests) !== 0) {
  throw new Error("Dispatch planner mutation baseline must be green before mutation scoring.");
}

let killed = 0;
let propertyKilled = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.source)?.value || "";
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(mutant.source, original.replace(mutant.from, mutant.to), "utf8");
    if (await runTests(mutant.tests) === 0) {
      throw new Error(`${mutant.name}: survived its focused test suite.`);
    }
    killed += 1;
    if (mutant.propertyTests) {
      if (await runTests(mutant.propertyTests) === 0) {
        throw new Error(`${mutant.name}: survived the property suite when run alone.`);
      }
      propertyKilled += 1;
    }
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(mutant.source, original, "utf8");
  }
} finally {
  for (const [source, original] of originals) {
    await writeFile(source, original.value, "utf8");
    if (sha256(await readFile(source, "utf8")) !== original.hash) {
      throw new Error(`Dispatch planner mutation source restoration hash mismatch: ${source}`);
    }
  }
}

console.log(`Dispatch planner optimization mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
console.log(`Property-only mutation score: ${propertyKilled}/1 killed (100%).`);
