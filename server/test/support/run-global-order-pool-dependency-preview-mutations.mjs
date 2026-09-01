// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const GLOBAL_TESTS = Object.freeze([
  "test/dispatch/integration/dispatch-global-order-group-pool.red.test.js",
  "test/dispatch/property/dispatch-global-order-group-pool.property.test.js"
]);
const DEPENDENCY_TESTS = Object.freeze([
  "test/dispatch/integration/scm-dependency-preview-blockers.red.test.js"
]);
const BROWSER_TESTS = Object.freeze(["src/dispatch-save-coordination-harness.js"]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string, tests: readonly string[], nodeTest?: boolean}>} */
const MUTANTS = Object.freeze([
  {
    name: "cancelled zero-progress dependency is execution again",
    target: "src/scm-dependency-preview-service.js",
    from: "dependency.status NOT IN ('active', 'attention', 'cancelled')",
    to: "dependency.status NOT IN ('active', 'attention')",
    tests: DEPENDENCY_TESTS,
    nodeTest: true
  },
  {
    name: "global group projection is omitted from the order pool",
    target: "src/dispatch-order-catalog-repository.js",
    from: `       SELECT global_group.group_ref, global_group.order_type,
              global_group.eligible, global_group.search_text,
              global_group.card, global_group.updated_at
         FROM dispatch_global_order_groups global_group
        WHERE global_group.active = true`,
    to: `       SELECT global_group.group_ref, global_group.order_type,
              global_group.eligible, global_group.search_text,
              global_group.card, global_group.updated_at
         FROM dispatch_global_order_groups global_group
        WHERE false`,
    tests: GLOBAL_TESTS,
    nodeTest: true
  },
  {
    name: "raw members remain visible beside an active group",
    target: "src/dispatch-order-catalog-repository.js",
    from: "           WHERE lower(member.member_order_ref) = lower(candidate.order_ref)",
    to: "           WHERE false AND lower(member.member_order_ref) = lower(candidate.order_ref)",
    tests: GLOBAL_TESTS,
    nodeTest: true
  },
  {
    name: "a stale owner can reclaim a group transferred to another plan",
    target: "src/dispatch-delivery-group-repository.js",
    from: `    return existingSourcePlanId === undefined
      || existingSourcePlanId === planId
      || group.assigned;`,
    to: "    return true;",
    tests: GLOBAL_TESTS,
    nodeTest: true
  },
  {
    name: "canonical ungroup no longer retires the global definition",
    target: "src/dispatch-delivery-group-repository.js",
    from: "        AND NOT (lower(group_ref) = ANY($2::text[]))",
    to: "        AND false",
    tests: GLOBAL_TESTS,
    nodeTest: true
  },
  {
    name: "unassigned global group is treated as plan-owned",
    target: "public/dispatch.js",
    from: `        currentPlanId
        && groupPlanId === currentPlanId
        && (!currentDate || !groupPlanDate || groupPlanDate === currentDate)`,
    to: `        currentPlanId
        && groupPlanId !== currentPlanId
        && (!currentDate || !groupPlanDate || groupPlanDate === currentDate)`,
    tests: BROWSER_TESTS,
    nodeTest: false
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label @param {readonly string[]} tests @param {boolean} [nodeTest] */
function runTests(label, tests, nodeTest = true) {
  process.stdout.write(`\n[global pool/dependency mutation] ${label}\n`);
  const args = nodeTest ? ["--test", "--test-concurrency=1", ...tests] : [...tests];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 180_000
  });
  if (result.error) {throw result.error;}
  return result;
}

/** @param {import("node:child_process").SpawnSyncReturns<string>} result */
function printFailure(result) {
  process.stderr.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Global order-pool mutations require an isolated writable container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

for (const [label, tests, nodeTest] of [
  ["global baseline", GLOBAL_TESTS, true],
  ["dependency baseline", DEPENDENCY_TESTS, true],
  ["browser baseline", BROWSER_TESTS, false]
]) {
  const result = runTests(String(label), /** @type {readonly string[]} */ (tests), Boolean(nodeTest));
  if (result.status !== 0) {
    printFailure(result);
    throw new Error(`${label} did not pass before mutation.`);
  }
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrences(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    const result = runTests(mutant.name, mutant.tests, mutant.nodeTest !== false);
    await writeFile(path.resolve(mutant.target), original, "utf8");
    if (result.status === 0) {throw new Error(`SURVIVED: ${mutant.name}`);}
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (sha256(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

for (const [label, tests, nodeTest] of [
  ["restored global source", GLOBAL_TESTS, true],
  ["restored dependency source", DEPENDENCY_TESTS, true],
  ["restored browser source", BROWSER_TESTS, false]
]) {
  const result = runTests(String(label), /** @type {readonly string[]} */ (tests), Boolean(nodeTest));
  if (result.status !== 0) {
    printFailure(result);
    throw new Error(`${label} failed after source restoration.`);
  }
}
console.log(`Global pool/dependency mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
