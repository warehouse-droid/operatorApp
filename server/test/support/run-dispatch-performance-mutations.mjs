// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE = path.resolve("src/dispatch-planner-performance.js");
const UNIT = "test/dispatch/unit/dispatch-performance-contract.test.js";
const PROPERTY = "test/dispatch/property/dispatch-performance-command.property.test.js";
const ADVERSARIAL = "test/dispatch/adversarial/dispatch-performance-safety.test.js";

const MUTANTS = Object.freeze([
  {
    name: "compact snapshot includes the entire unassigned order pool",
    from: "orders: (plan.orders || []).filter((order) => refs.has(orderRef(order))).map(clone),",
    to: "orders: (plan.orders || []).map(clone),",
    tests: [UNIT, PROPERTY],
    propertyTests: [PROPERTY]
  },
  {
    name: "an exact command retry is rejected instead of replayed",
    from: "if (stored.bodyDigest !== bodyDigest) {",
    to: "if (stored.bodyDigest === bodyDigest) {",
    tests: [UNIT, PROPERTY],
    propertyTests: [PROPERTY]
  },
  {
    name: "the same revision accepts a mismatched snapshot digest",
    from: "if (text(command.baseDigest) && text(command.baseDigest) !== currentDigest) {",
    to: "if (text(command.baseDigest) && text(command.baseDigest) === currentDigest) {",
    tests: [UNIT]
  },
  {
    name: "synthetic travel activity freezes the physical route suffix",
    from: "if (type && !PHYSICAL_STOP_TYPES.has(type)) {continue;}",
    to: "if (false && type && !PHYSICAL_STOP_TYPES.has(type)) {continue;}",
    tests: [ADVERSARIAL]
  },
  {
    name: "checkpoint retention deletes the exact seven-day boundary",
    from: "return Number.isFinite(timestamp) && timestamp < cutoff;",
    to: "return Number.isFinite(timestamp) && timestamp <= cutoff;",
    tests: [ADVERSARIAL]
  },
  {
    name: "browser compact-board replacement is silently ignored",
    from: "case \"replace_plan\": return replacePlan(plan, payload);",
    to: "case \"replace_plan\": return { replaced: false, affectedOrderRefs: [] };",
    tests: [UNIT]
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
        return reject(new Error(`Mutation test process exited on signal ${signal}.`));
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch mutation tests may run only in the explicitly ephemeral isolated test image.");
}

const original = await readFile(SOURCE, "utf8");
const originalHash = sha256(original);
let killed = 0;
let propertyKilled = 0;

try {
  for (const mutant of MUTANTS) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(SOURCE, original.replace(mutant.from, mutant.to), "utf8");
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
    await writeFile(SOURCE, original, "utf8");
  }
} finally {
  await writeFile(SOURCE, original, "utf8");
  if (sha256(await readFile(SOURCE, "utf8")) !== originalHash) {
    throw new Error("Dispatch mutation source restoration hash mismatch.");
  }
}

console.log(`Dispatch mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
console.log(`Property-only mutation score: ${propertyKilled}/2 killed (100%).`);
