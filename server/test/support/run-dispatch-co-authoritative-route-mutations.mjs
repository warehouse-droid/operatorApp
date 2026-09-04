// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const serverRoot = path.resolve(".");
const sourcePath = path.join(serverRoot, "public/dispatch.js");
const contractTest = "test/dispatch/frontend/dispatch-planner-performance.contract.test.js";
const propertyTest = "test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js";

const authoritativeStateLine =
  "  const authoritativeTransitCoState = Object.prototype.hasOwnProperty.call(fresh, \"transitCo\");";

const mutants = Object.freeze([
  {
    name: "active authoritative routes are mistaken for non-authoritative planner state",
    from: authoritativeStateLine,
    to: `  const authoritativeTransitCoState = Object.prototype.hasOwnProperty.call(fresh, "transitCo")
    && !fresh.transitCo;`,
    tests: [contractTest, propertyTest],
    propertyTests: [propertyTest]
  },
  {
    name: "sparse refreshes lose the original CO source yard",
    from: `    "transitOriginalPickupLocations",
    "transitOriginalSourceYard",
    "groupAliases",`,
    to: `    "transitOriginalPickupLocations",
    "groupAliases",`,
    tests: [contractTest]
  },
  {
    name: "every refresh is treated as authoritative even when transitCo is omitted",
    from: authoritativeStateLine,
    to: "  const authoritativeTransitCoState = true;",
    tests: [contractTest]
  }
]);

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/**
 * @param {string[]} files
 * @param {string} label
 */
function runTests(files, label) {
  process.stdout.write(`\n[CO authoritative-route mutation] ${label}\n`);
  return spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...files
  ], {
    cwd: serverRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 180_000
  });
}

/**
 * @param {string[]} files
 * @param {string} label
 */
function assertGreen(files, label) {
  const result = runTests(files, label);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${label}: focused tests did not pass.`);
  }
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("CO authoritative-route mutations require an isolated writable source copy.");
}

const original = await readFile(sourcePath, "utf8");
const originalHash = digest(original);
const allTests = [contractTest, propertyTest];
assertGreen(allTests, "baseline");

let killed = 0;
let propertyKilled = 0;
try {
  for (const mutant of mutants) {
    if (occurrences(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(sourcePath, original.replace(mutant.from, mutant.to), "utf8");
    const result = runTests(mutant.tests, mutant.name);
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      throw new Error(`SURVIVED: ${mutant.name}`);
    }
    killed += 1;
    if (mutant.propertyTests) {
      const propertyResult = runTests(mutant.propertyTests, `${mutant.name} (property only)`);
      if (propertyResult.error) {
        throw propertyResult.error;
      }
      if (propertyResult.status === 0) {
        throw new Error(`PROPERTY SURVIVED: ${mutant.name}`);
      }
      propertyKilled += 1;
    }
    await writeFile(sourcePath, original, "utf8");
    console.log(`KILLED ${killed}/${mutants.length}: ${mutant.name}`);
  }
} finally {
  await writeFile(sourcePath, original, "utf8");
  if (digest(await readFile(sourcePath, "utf8")) !== originalHash) {
    throw new Error("CO authoritative-route mutation source restoration failed.");
  }
}

assertGreen(allTests, "restored source");
console.log(`CO authoritative-route mutation score: ${killed}/${mutants.length} killed.`);
console.log(`Property-only mutation score: ${propertyKilled}/1 killed.`);
