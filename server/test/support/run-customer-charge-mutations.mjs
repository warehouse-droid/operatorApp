// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CALCULATOR_TESTS = Object.freeze([
  "test/mbt/contracts/customer-charge-regression.test.js"
]);
const WORKFLOW_TEST = "test/mbt/integration/customer-charge-request-workflow.test.js";

const MUTANTS = Object.freeze([
  {
    name: "cash HST is added instead of extracted",
    file: "src/mbt/customer-charge-calculator.js",
    from: "roundedRatio(configuredAmountMinor, taxRateBasisPoints, 10_000 + taxRateBasisPoints, \"Included HST\")",
    to: "roundedRatio(configuredAmountMinor, taxRateBasisPoints, 10_000, \"Included HST\")",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "non-cash HST uses the tax-included divisor",
    file: "src/mbt/customer-charge-calculator.js",
    from: "roundedRatio(configuredAmountMinor, taxRateBasisPoints, 10_000, \"Added HST\")",
    to: "roundedRatio(configuredAmountMinor, taxRateBasisPoints, 10_000 + taxRateBasisPoints, \"Added HST\")",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "non-garbage receives a garbage deposit",
    file: "src/mbt/customer-charge-calculator.js",
    from: "if (bin.incomingContentCode !== \"garbage\") {",
    to: "if (false && bin.incomingContentCode !== \"garbage\") {",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "non-garbage revenue is deferred instead of fully due",
    file: "src/mbt/customer-charge-calculator.js",
    from: "const dueNow = bin.incomingContentCode !== \"garbage\";",
    to: "const dueNow = false;",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "attached aggregate loses the one loading fee",
    file: "src/mbt/customer-charge-calculator.js",
    from: "if (kind !== \"aggregate_order\" && aggregateLines.length > 0) {",
    to: "if (false && kind !== \"aggregate_order\" && aggregateLines.length > 0) {",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "fixed per-bin dump line is omitted",
    file: "src/mbt/customer-charge-calculator.js",
    from: "if (bin.fixedDumpMinor > 0) {",
    to: "if (false && bin.fixedDumpMinor > 0) {",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "exactly 30 km falls outside the standard aggregate band",
    file: "src/mbt/customer-charge-calculator.js",
    from: "(index === 0 ? distanceMetres >= band.minimumMetres : distanceMetres > band.minimumMetres)",
    to: "(index === 0 ? distanceMetres > band.minimumMetres : distanceMetres > band.minimumMetres)",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "cash becomes eligible for future NetSuite export",
    file: "src/mbt/customer-charge-calculator.js",
    from: "const netsuiteExportPolicy = paymentCategory === \"cash\" ? \"excluded_cash\" : \"eligible_non_cash\";",
    to: "const netsuiteExportPolicy = paymentCategory === \"cash\" ? \"eligible_non_cash\" : \"excluded_cash\";",
    testArgs: CALCULATOR_TESTS
  },
  {
    name: "rolling contract total sums drafts instead of confirmed requests",
    file: "src/mbt/customer-charge-request-service.js",
    from: "WHERE contract_id = $1::uuid\n        AND status = 'confirmed'\n        AND request_kind <> 'initial_bin'",
    to: "WHERE contract_id = $1::uuid\n        AND status = 'draft'\n        AND request_kind <> 'initial_bin'",
    testArgs: ["--test-name-pattern=cash initial then card add", WORKFLOW_TEST]
  },
  {
    name: "Front Desk role can edit the Admin pricing sheet",
    file: "src/mbt/customer-charge-request-service.js",
    from: "if (!normalized.roles.some((role) => ADMIN_ROLES.has(String(role).trim().toLowerCase()))) {",
    to: "if (false && !normalized.roles.some((role) => ADMIN_ROLES.has(String(role).trim().toLowerCase()))) {",
    testArgs: ["--test-name-pattern=admin atomically configures", WORKFLOW_TEST]
  },
  {
    name: "stale customer-charge configuration revision is accepted",
    file: "src/mbt/customer-charge-request-service.js",
    from: "if (actualRevision !== expectedRevision) {",
    to: "if (false && actualRevision !== expectedRevision) {",
    testArgs: ["--test-name-pattern=admin atomically configures", WORKFLOW_TEST]
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {readonly string[]} testArgs */
function runTests(testArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...testArgs
    ], { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Customer-charge mutation detector exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Customer-charge mutations require the explicitly writable disposable MBT test image.");
}

let killed = 0;
for (const mutant of MUTANTS) {
  const target = path.resolve(mutant.file);
  const original = await readFile(target, "utf8");
  const originalHash = sha256(original);
  if (occurrences(original, mutant.from) !== 1) {
    throw new Error(`${mutant.name}: expected exactly one mutation target in ${mutant.file}.`);
  }
  try {
    await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
    const exitCode = await runTests(mutant.testArgs);
    if (exitCode === 0) {
      throw new Error(`${mutant.name}: survived its customer-charge detector set.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
  } finally {
    await writeFile(target, original, "utf8");
    if (sha256(await readFile(target)) !== originalHash) {
      throw new Error(`${mutant.name}: source restoration hash mismatch.`);
    }
  }
}

console.log(`Customer-charge mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
