// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PURE_TESTS = Object.freeze([
  "test/mbt/unit/special-stock-request-domain.red.test.js",
  "test/mbt/property/special-stock-request-domain.property.test.js",
  "test/mbt/unit/special-stock-request-policy.red.test.js",
  "test/mbt/unit/special-stock-request-netsuite.red.test.js"
]);
const DATABASE_TESTS = Object.freeze([
  "test/mbt/integration/special-stock-request-workflow.red.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "Sales store authorization fails open",
    target: "src/special-stock-request-domain.js",
    from: "  if (!authorized.has(storeLocationId)) {",
    to: "  if (false) {"
  },
  {
    name: "no-projection accepts a conflicting date",
    target: "src/special-stock-request-domain.js",
    from: "  if (availabilityMode === \"no_projection\" && suppliedDate) {",
    to: "  if (false) {"
  },
  {
    name: "non-acceptance no longer requires a reason",
    target: "src/special-stock-request-domain.js",
    from: "  if (decision !== \"accepted\" && !reason) {",
    to: "  if (false) {"
  },
  {
    name: "Sales may accept without an exact item mapping",
    target: "src/special-stock-request-domain.js",
    from: "  if (decision === \"accepted\") {",
    to: "  if (false) {"
  },
  {
    name: "pending lines are released into orders",
    target: "src/special-stock-request-domain.js",
    from: "  if (lines.some((line) => !TERMINAL_SALES_DECISIONS.has(String(line?.salesDecision || \"\").toLowerCase()))) {",
    to: "  if (false) {"
  },
  {
    name: "mixed vendors are accepted",
    target: "src/special-stock-request-domain.js",
    from: "  if (vendorIds.size !== 1 || lines.some((line) => !Number.isSafeInteger(Number(line?.responseVendorId)))) {",
    to: "  if (vendorIds.size < 1) {"
  },
  {
    name: "PO release bypasses the second SCM response",
    target: "src/special-stock-request-domain.js",
    from: "  if (release.acceptedLines.some((line) => line?.poReady !== true)) {",
    to: "  if (false) {"
  },
  {
    name: "reversed delivery windows are accepted",
    target: "src/special-stock-request-domain.js",
    from: "    if (windowStart >= windowEnd) {",
    to: "    if (false) {"
  },
  {
    name: "yard pickup may bypass the yard",
    target: "src/special-stock-request-domain.js",
    from: "  if (method === \"yard_pickup\" && route !== \"via_yard\") {",
    to: "  if (false) {"
  },
  {
    name: "manual-link quantity comparison is skipped",
    target: "src/special-stock-request-domain.js",
    from: "      if (Math.abs(Number(candidate.quantity) - Number(expected.quantity)) > 0.000001) return false;",
    to: "      if (false) return false;"
  },
  {
    name: "SCM-only fields leak to Sales and Dispatch",
    target: "src/special-stock-request-policy.js",
    from: "  if (audience === \"scm\" || audience === \"admin\") {",
    to: "  if (true) {"
  },
  {
    name: "duplicate NetSuite markers are accepted",
    target: "src/special-stock-request-netsuite.js",
    from: "  if (matches.length > 1) {",
    to: "  if (false) {"
  },
  {
    name: "custom shipping address override is disabled",
    target: "src/special-stock-request-netsuite.js",
    from: "    payload.shipOverride = true;",
    to: "    payload.shipOverride = false;"
  },
  {
    name: "closed case starts a remote order operation",
    target: "src/special-stock-request-repository.js",
    from: "    if (special.close_status !== \"active\") {",
    to: "    if (false) {",
    suite: "database"
  },
  {
    name: "case closes while remote order outcome is unresolved",
    target: "src/special-stock-request-repository.js",
    from: "    if ([special.sales_order_operation_status, special.purchase_order_operation_status]\n      .some((status) => status === \"creating\" || status === \"attention\")) {",
    to: "    if (false) {",
    suite: "database"
  }
]);

/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** @param {string} source @param {string} needle */
const occurrenceCount = (source, needle) => source.split(needle).length - 1;

/**
 * @param {string} label
 * @param {{showFailure?: boolean, suite?: string | undefined}} [options]
 */
function runTests(label, { showFailure = false, suite = "unit" } = {}) {
  process.stdout.write(`\n[special stock mutation] ${label}\n`);
  const tests = suite === "database" ? DATABASE_TESTS : PURE_TESTS;
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if (showFailure && result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Special-stock mutations require the writable disposable MBT mutation container.");
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
    if (runTests(mutant.name, { suite: mutant.suite }) === 0) {
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

if (runTests("post-mutation restored source", { showFailure: true }) !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
if (runTests("post-mutation restored database source", { showFailure: true, suite: "database" }) !== 0) {
  throw new Error("Database workflow failed after mutation source restoration.");
}
console.log(`Special-stock mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
