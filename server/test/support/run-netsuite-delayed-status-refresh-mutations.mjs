// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/netsuite-delayed-status-refresh-policy.red.test.js",
  "test/mbt/unit/netsuite-delayed-status-refresh-service.red.test.js",
  "test/mbt/property/netsuite-delayed-status-refresh.property.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "retry budget grows beyond eight attempts",
    target: "src/netsuite-delayed-status-refresh-policy.js",
    from: "export const DELAYED_STATUS_REFRESH_MAX_ATTEMPTS = 8;",
    to: "export const DELAYED_STATUS_REFRESH_MAX_ATTEMPTS = 9;"
  },
  {
    name: "first retry delay drifts",
    target: "src/netsuite-delayed-status-refresh-policy.js",
    from: "  30_000,",
    to: "  31_000,"
  },
  {
    name: "Pending Approval status code is inverted",
    target: "src/netsuite-delayed-status-refresh-policy.js",
    from: "normalizedStatusCode(row) === \"A\"",
    to: "normalizedStatusCode(row) === \"B\""
  },
  {
    name: "network errors are treated as missing results",
    target: "src/netsuite-delayed-status-refresh-policy.js",
    from: "  if (input.error) {",
    to: "  if (false && input.error) {"
  },
  {
    name: "sales allocation retry is disabled",
    target: "src/netsuite-delayed-status-refresh-policy.js",
    from: "  if (salesOrderAllocationRequiresRetry(input)) {",
    to: "  if (false) {"
  },
  {
    name: "refreshed status never succeeds",
    target: "src/netsuite-delayed-status-refresh-policy.js",
    from: "  return { outcome: \"succeeded\", reason: \"status_refreshed\", retryDelayMs: null };",
    to: "  return { outcome: \"failed\", reason: \"status_refreshed\", retryDelayMs: null };"
  },
  {
    name: "stale lease fencing is bypassed",
    target: "src/netsuite-delayed-status-refresh-service.js",
    from: "      if (!ownsLease) {",
    to: "      if (false) {"
  },
  {
    name: "overlapping in-process worker tick is allowed",
    target: "src/netsuite-delayed-status-refresh-service.js",
    from: "    if (running) {",
    to: "    if (false) {"
  },
  {
    name: "claimed jobs wait sequentially without starting their heartbeats",
    target: "src/netsuite-delayed-status-refresh-service.js",
    from: "      const results = await Promise.all(jobs.map((claimedJob) => (\n        processJob({ ...claimedJob, leaseMs })\n      )));",
    to: "      const results = [];\n      for (const claimedJob of jobs) {\n        results.push(await processJob({ ...claimedJob, leaseMs }));\n      }"
  },
  {
    name: "network failures emit false update events",
    target: "src/netsuite-delayed-status-refresh-service.js",
    from: "    if (operationError || (!remoteStatus && decision.reason !== \"missing_status\")) {",
    to: "    if (false) {"
  },
  {
    name: "supplemental audit failure erases the durable result",
    target: "src/netsuite-delayed-status-refresh-service.js",
    from: "    logger.error(\"Delayed NetSuite status refresh audit failed:\", errorMessage(error));",
    to: "    throw error;"
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
  process.stdout.write(`\n[delayed status refresh mutation] ${label}\n`);
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
  throw new Error("Delayed status refresh mutations require the writable disposable mutation container.");
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
console.log(`Delayed status refresh mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
