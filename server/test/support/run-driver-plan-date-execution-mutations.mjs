// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/driver-plan-date-execution.red.test.js",
  "test/mbt/property/driver-plan-date-execution.property.test.js",
  "test/mbt/adversarial/driver-plan-date-execution-adversarial.test.js",
  "test/mbt/unit/driver-plan-date-execution-wiring.contract.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "company calendar accidentally changes to UTC",
    target: "src/driver-plan-date-policy.js",
    from: 'export const DRIVER_COMPANY_TIME_ZONE = "America/Toronto";',
    to: 'export const DRIVER_COMPANY_TIME_ZONE = "UTC";'
  },
  {
    name: "Toronto midnight remains locked",
    target: "src/driver-plan-date-policy.js",
    from: "  if (planDate > companyDate) {",
    to: "  if (planDate >= companyDate) {"
  },
  {
    name: "past routes are blocked instead of future routes",
    target: "src/driver-plan-date-policy.js",
    from: "  if (planDate > companyDate) {",
    to: "  if (planDate < companyDate) {"
  },
  {
    name: "invalid plan dates fail open",
    target: "src/driver-plan-date-policy.js",
    from: '      allowed: false,\n      code: "DRIVER_PLAN_DATE_INVALID",',
    to: '      allowed: true,\n      code: "DRIVER_PLAN_DATE_INVALID",'
  },
  {
    name: "assertion no longer rejects blocked work",
    target: "src/driver-plan-date-policy.js",
    from: "  if (decision.allowed) return decision;",
    to: "  return decision;"
  },
  {
    name: "repository persistence boundary is removed",
    target: "src/driver-repository.js",
    from: "  assertDriverPlanExecutionDate(job.planDate);\n  await assertNoClosedNetSuiteOrders(job.orderRefs || [], \"start Driver work\");",
    to: "  void job.planDate;\n  await assertNoClosedNetSuiteOrders(job.orderRefs || [], \"start Driver work\");"
  },
  {
    name: "offline start guard is removed before BIN dispatch",
    target: "src/server.js",
    from: "    assertDriverPlanExecutionDate(job.planDate);\n  }\n  const mbtApplication = await applyMbtDriverBinOfflineEvent({",
    to: "    void job.planDate;\n  }\n  const mbtApplication = await applyMbtDriverBinOfflineEvent({"
  },
  {
    name: "PWA protection unlocks blocked future routes",
    target: "public/driver.js",
    from: "  if ((currentJob || dvirMode) && !planExecution.allowed) {",
    to: "  if ((currentJob || dvirMode) && planExecution.allowed) {"
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

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[driver-plan-date mutation] ${label}\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...TESTS], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Driver plan-date mutations require the writable disposable MBT mutation container.");
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
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {
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

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`Driver plan-date mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
