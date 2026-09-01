// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** @typedef {"custom" | "queue"} SuiteName */
/** @typedef {{name: string, target: string, suite: SuiteName, from: string, to: string}} Mutant */

const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
const targets = new Map([
  ["src/dispatch-custom-order-repository.js", ""],
  ["src/netsuite-order-webhook-queue-repository.js", ""]
]);

/** @type {Readonly<Record<SuiteName, readonly string[]>>} */
const suites = Object.freeze({
  custom: ["src/dispatch-custom-order-harness.js"],
  queue: [
    "--test",
    "--test-concurrency=1",
    "test/workload/integration/netsuite-order-webhook-queue.red.test.js"
  ]
});

/** @type {readonly Mutant[]} */
const mutants = Object.freeze([
  {
    name: "exact Custom Order ref can no longer recover its stable ID",
    target: "src/dispatch-custom-order-repository.js",
    suite: "custom",
    from: `    const stableId = /^\\d+$/.test(submittedStableId)
      ? submittedStableId
      : String(refMatch?.id || "");`,
    to: `    const stableId = /^\\d+$/.test(submittedStableId)
      ? submittedStableId
      : "";`
  },
  {
    name: "a ref match replaces an explicitly submitted stable Custom Order ID",
    target: "src/dispatch-custom-order-repository.js",
    suite: "custom",
    from: `    const stableId = /^\\d+$/.test(submittedStableId)
      ? submittedStableId
      : String(refMatch?.id || "");`,
    to: `    const stableId = String(refMatch?.id || "");`
  },
  {
    name: "timestamp-free webhook chronology falls back to payload-hash order",
    target: "src/netsuite-order-webhook-queue-repository.js",
    suite: "queue",
    from: `    const superseded = latestRow && envelope.sourceModifiedAt
      ? compareNetSuiteWebhookVersions(envelope, versionOfRow(latestRow)) < 0
      : false;`,
    to: `    const superseded = latestRow
      ? compareNetSuiteWebhookVersions(envelope, versionOfRow(latestRow)) < 0
      : false;`
  },
  {
    name: "timestamp-free queued snapshots no longer coalesce by arrival order",
    target: "src/netsuite-order-webhook-queue-repository.js",
    suite: "queue",
    from: "              $3::timestamptz IS NULL\n",
    to: "              false\n"
  }
]);

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {SuiteName} name @param {string} label */
function runSuite(name, label) {
  process.stdout.write(`\n[Dispatch stale identity/location mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [...suites[name]], {
    cwd: serverRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 180_000
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

/** @param {SuiteName} name @param {string} label */
function assertGreen(name, label) {
  const result = runSuite(name, label);
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${label}: focused suite did not pass.`);
  }
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch stale identity/location mutations require an isolated writable container.");
}

for (const target of targets.keys()) {
  targets.set(target, await readFile(new URL(`../../${target}`, import.meta.url), "utf8"));
}
const originalHashes = new Map([...targets].map(([target, source]) => [target, digest(source)]));

/** @param {string} target */
function originalSource(target) {
  const source = targets.get(target);
  if (source === undefined) {
    throw new Error(`Missing mutation source for ${target}.`);
  }
  return source;
}

assertGreen("custom", "custom baseline");
assertGreen("queue", "webhook baseline");

let killed = 0;
try {
  for (const mutant of mutants) {
    const original = originalSource(mutant.target);
    if (occurrences(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    const targetUrl = new URL(`../../${mutant.target}`, import.meta.url);
    await writeFile(targetUrl, original.replace(mutant.from, mutant.to), "utf8");
    const result = runSuite(mutant.suite, mutant.name);
    await writeFile(targetUrl, original, "utf8");
    if (result.status === 0) {
      throw new Error(`SURVIVED: ${mutant.name}`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${mutants.length}: ${mutant.name}`);
  }
} finally {
  for (const [target, original] of targets) {
    const targetUrl = new URL(`../../${target}`, import.meta.url);
    await writeFile(targetUrl, original, "utf8");
    if (digest(await readFile(targetUrl, "utf8")) !== originalHashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

assertGreen("custom", "restored custom source");
assertGreen("queue", "restored webhook source");
console.log(`Dispatch stale identity/location mutation score: ${killed}/${mutants.length} killed; sources restored.`);
