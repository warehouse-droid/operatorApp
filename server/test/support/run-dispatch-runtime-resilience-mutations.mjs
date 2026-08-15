// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_TEST = "test/dispatch/frontend/dispatch-runtime-resilience.red.test.js";
const LEASE_PROPERTY_TEST = "test/dispatch/property/dispatch-edit-lease-session.property.test.js";
const DRIVER_ORDER_HARNESS = "src/dispatch-driver-order-harness.js";

/** @typedef {{name: string, path: string, from: string, to: string, detector: "runtime" | "property" | "driver"}} RuntimeMutant */
/** @type {readonly RuntimeMutant[]} */
const MUTANTS = Object.freeze([
  {
    name: "a missing compact-plan order is dereferenced",
    path: "public/dispatch.js",
    from: "function dropoffForStop(order = {}, stop = {}) {\n  const dropoffs = Array.isArray(order?.dropoffs) ? order.dropoffs : [];",
    to: "function dropoffForStop(order = {}, stop = {}) {\n  const dropoffs = order.dropoffs;",
    detector: "runtime"
  },
  {
    name: "the late global feed discards an assigned saved-plan order",
    path: "public/dispatch.js",
    from: "isOrderAssignedInCurrentPlan(order.id)\n    || shouldPreserveDuringFeedRefresh(order)",
    to: "false\n    || shouldPreserveDuringFeedRefresh(order)",
    detector: "runtime"
  },
  {
    name: "a reload token can cross to a different plan date",
    path: "public/dispatch.js",
    from: "if (planDate && stored.planDate !== String(planDate).slice(0, 10)) return null;",
    to: "if (false && planDate && stored.planDate !== String(planDate).slice(0, 10)) return null;",
    detector: "property"
  },
  {
    name: "the service worker claims unsupported browser-extension requests",
    path: "public/service-worker.js",
    from: "if (url.protocol !== \"http:\" && url.protocol !== \"https:\") return;",
    to: "if (false && url.protocol !== \"http:\" && url.protocol !== \"https:\") return;",
    detector: "runtime"
  },
  {
    name: "an empty stale saved driver lane is treated as valid forever",
    path: "public/dispatch.js",
    from: "const valid = new Set([...defaultOrder, ...historicalOrder]);",
    to: "const valid = new Set([...preferredOrder, ...defaultOrder, ...historicalOrder]);",
    detector: "driver"
  }
]);

/**
 * @param {string} value
 * @returns {string}
 */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 * @returns {number}
 */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/**
 * @param {string[]} arguments_
 * @returns {Promise<number>}
 */
function runNode(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        return reject(new Error(`${arguments_.join(" ")} exited on signal ${signal}.`));
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * @param {RuntimeMutant["detector"]} detector
 * @returns {Promise<number>}
 */
function runDetector(detector) {
  if (detector === "driver") {
    return runNode([DRIVER_ORDER_HARNESS]);
  }
  const file = detector === "property" ? LEASE_PROPERTY_TEST : RUNTIME_TEST;
  return runNode(["--test", "--test-concurrency=1", file]);
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch runtime-resilience mutations require the writable disposable MBT mutation container.");
}

const originals = new Map();
for (const mutant of MUTANTS) {
  const target = path.resolve(mutant.path);
  if (!originals.has(target)) {
    originals.set(target, await readFile(target, "utf8"));
  }
}
const originalHashes = new Map([...originals].map(([target, source]) => [target, sha256(source)]));
let killed = 0;

try {
  for (const mutant of MUTANTS) {
    const target = path.resolve(mutant.path);
    const original = originals.get(target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target in ${mutant.path}.`);
    }
    await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
    const result = await runDetector(mutant.detector);
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused detector.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(target, original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(target, original, "utf8");
  }
  for (const [target, originalHash] of originalHashes) {
    if (sha256(await readFile(target, "utf8")) !== originalHash) {
      throw new Error(`Dispatch runtime-resilience mutation source restoration failed: ${target}`);
    }
  }
}

if (killed !== MUTANTS.length) {
  throw new Error(`Dispatch runtime-resilience mutation score ${killed}/${MUTANTS.length}.`);
}
if (await runDetector("runtime") !== 0 || await runDetector("property") !== 0 || await runDetector("driver") !== 0) {
  throw new Error("Dispatch runtime-resilience tests failed after restoring mutation sources.");
}

console.log(`Dispatch runtime-resilience mutation score: ${killed}/${MUTANTS.length} killed (100%); all sources restored.`);
