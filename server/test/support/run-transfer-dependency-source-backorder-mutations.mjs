// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UNIT_TESTS = Object.freeze([
  "test/scm-transfer-dependency-workflow.test.js",
  "test/mbt/property/transfer-dependency-source-backorder.property.test.js"
]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string, suite: "unit" | "database"}>} */
const MUTANTS = Object.freeze([
  {
    name: "protected source quantity fails open",
    target: "src/transfer-dependency-source-backorder.js",
    from: "    allowed: protectedQuantity <= available + EPSILON,",
    to: "    allowed: true,",
    suite: "unit"
  },
  {
    name: "eligible source-backorder quantity is discarded",
    target: "src/transfer-dependency-source-backorder.js",
    from: "  const eligible = Math.min(requested, quantity(backorderEligibleQuantity));",
    to: "  const eligible = 0;",
    suite: "unit"
  },
  {
    name: "new proposals default to source backorder",
    target: "migrations/170_transfer_dependency_source_backorder.sql",
    from: "  ADD COLUMN IF NOT EXISTS allow_source_backorder boolean NOT NULL DEFAULT false;",
    to: "  ADD COLUMN IF NOT EXISTS allow_source_backorder boolean NOT NULL DEFAULT true;",
    suite: "unit"
  },
  {
    name: "persisted opt-in is forced off",
    target: "src/order-dependency-repository.js",
    from: "                    THEN COALESCE($9::boolean, allow_source_backorder)",
    to: "                    THEN false",
    suite: "database"
  },
  {
    name: "source-backorder setting audit is skipped",
    target: "src/order-dependency-repository.js",
    from: "    if (sourceBackorderChanges.length) {",
    to: "    if (false && sourceBackorderChanges.length) {",
    suite: "database"
  },
  {
    name: "proposal opt-in is ignored during stock validation",
    target: "src/order-dependency-repository.js",
    from: "    if (proposal.allowSourceBackorder === true) {",
    to: "    if (false) {",
    suite: "database"
  },
  {
    name: "UI no longer displays the saved opt-in",
    target: "public/scm-transfer-dependencies.js",
    from: "  const enabled = proposal.allowSourceBackorder === true;",
    to: "  const enabled = false;",
    suite: "unit"
  },
  {
    name: "UI drops the opt-in from Save Draft",
    target: "public/scm-transfer-dependencies.js",
    from: "    allowSourceBackorder: card.querySelector('[data-proposal-field=\"allowSourceBackorder\"]')?.checked === true,",
    to: "    allowSourceBackorder: false,",
    suite: "unit"
  },
  {
    name: "creation audit drops the authorized source shortfall",
    target: "src/order-dependency-repository.js",
    from: "      sourceBackorders: validation.sourceBackorders,\n      reservationOverrideCount:",
    to: "      sourceBackorders: [],\n      reservationOverrideCount:",
    suite: "unit"
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/**
 * @param {string} label
 * @param {string[]} args
 */
function runCommand(label, args) {
  process.stdout.write(`\n[transfer source-backorder mutation] ${label}\n`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

/**
 * @param {string} label
 * @param {"unit" | "database"} suite
 */
function runSuite(label, suite) {
  if (suite === "database") {
    return runCommand(label, ["src/transfer-dependency-reservation-harness.js"]);
  }
  return runCommand(label, ["--test", "--test-concurrency=1", ...UNIT_TESTS]);
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Transfer source-backorder mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map(({ target }) => target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runSuite(mutant.name, mutant.suite) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (sha256(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (runSuite("post-mutation restored unit source", "unit") !== 0
  || runSuite("post-mutation restored database source", "database") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`Transfer source-backorder mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
