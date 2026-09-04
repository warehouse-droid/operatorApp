// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** @typedef {"property" | "lifecycle" | "retirement" | "coGroup" | "replay" | "frontend" | "completion"} SuiteName */
/** @typedef {{name: string, target: string, suite: SuiteName, from: string, to: string}} Mutant */

const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
const targets = new Map([
  ["src/dispatch-delivery-group-repository.js", ""],
  ["src/dispatch-order-catalog-repository.js", ""],
  ["src/dispatch-planner-performance.js", ""],
  ["src/dispatch-history-mode.js", ""],
  ["public/dispatch.js", ""]
]);

/** @type {Readonly<Record<SuiteName, readonly string[]>>} */
const suites = Object.freeze({
  property: [
    "--test",
    "test/dispatch/property/dispatch-derived-order-freshness.property.test.js"
  ],
  lifecycle: [
    "--test",
    "--test-concurrency=1",
    "test/dispatch/integration/dispatch-derived-order-freshness.red.test.js"
  ],
  retirement: [
    "--test",
    "--test-concurrency=1",
    "test/dispatch/integration/dispatch-global-order-group-pool.red.test.js"
  ],
  coGroup: [
    "--test",
    "--test-concurrency=1",
    "test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js"
  ],
  replay: [
    "--test",
    "--test-concurrency=1",
    "test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js"
  ],
  frontend: [
    "--test",
    "test/dispatch/frontend/dispatch-planner-performance.contract.test.js"
  ],
  completion: [
    "--test",
    "--test-concurrency=1",
    "test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js"
  ]
});

/** @type {readonly Mutant[]} */
const mutants = Object.freeze([
  {
    name: "a stale CO base route overrides the current raw NetSuite yard",
    target: "src/dispatch-delivery-group-repository.js",
    suite: "property",
    from: "  const pickupLocations = rawPickups.length ? rawPickups : fallbackPickups;",
    to: "  const pickupLocations = fallbackPickups.length ? fallbackPickups : rawPickups;"
  },
  {
    name: "an obsolete CO origin is appended after NetSuite already supplied a fresh pickup",
    target: "src/dispatch-planner-performance.js",
    suite: "property",
    from: `        !candidate.transitOriginalPickupLocations?.length
        && !candidate.pickupLocations?.length
        && active.fromYard`,
    to: `        !candidate.transitOriginalPickupLocations?.length
        && active.fromYard`
  },
  {
    name: "a legitimate NetSuite pickup matching the CO destination is discarded",
    target: "src/dispatch-planner-performance.js",
    suite: "property",
    from: `        ? candidate.pickupLocations.filter((location) => (
            (
              !candidate.transitOriginalPickupLocations?.length
              || locationKey(location) !== destination
            )
            && !relationshipPickupKeys.has(locationKey(location))
          ))`,
    to: `        ? candidate.pickupLocations.filter((location) => (
            locationKey(location) !== destination
            && !relationshipPickupKeys.has(locationKey(location))
          ))`
  },
  {
    name: "an active CO drops current PO and direct vendor pickups",
    target: "src/dispatch-planner-performance.js",
    suite: "property",
    from: "    next.pickupLocations = [active.toYard, ...relationshipPickups].filter((location) => {",
    to: "    next.pickupLocations = [active.toYard].filter((location) => {"
  },
  {
    name: "group members ignore the latest NetSuite child snapshot",
    target: "src/dispatch-delivery-group-repository.js",
    suite: "lifecycle",
    from: "    const direct = freshByRef.get(ref);",
    to: "    const direct = null;"
  },
  {
    name: "a NetSuite SO refresh replaces one aliased grouped-CO member",
    target: "src/dispatch-delivery-group-repository.js",
    suite: "coGroup",
    from: `    if (direct && !(candidateType === "CO" && directType !== "CO")) {
      return cloneOrder(direct);
    }`,
    to: `    if (direct) {
      return cloneOrder(direct);
    }`
  },
  {
    name: "a delayed catalog refresh may reinsert an inactive group shadow",
    target: "src/dispatch-order-catalog-repository.js",
    suite: "lifecycle",
    from: `       FROM dispatch_global_order_groups
      WHERE lower(group_ref) = ANY($1::text[])
     UNION`,
    to: `       FROM dispatch_global_order_groups
      WHERE active = true
        AND lower(group_ref) = ANY($1::text[])
     UNION`
  },
  {
    name: "ungroup stops deleting an already-stale catalog shadow",
    target: "src/dispatch-delivery-group-repository.js",
    suite: "retirement",
    from: `        WHERE lower(catalog.order_ref) = ANY($1::text[])`,
    to: `        WHERE false
          AND lower(catalog.order_ref) = ANY($1::text[])`
  },
  {
    name: "a stale force-save may reactivate a retired group or split",
    target: "src/dispatch-delivery-group-repository.js",
    suite: "replay",
    from: "  if (rejectRetiredGlobalOrderRefs && blockedRetiredRefs.size) {",
    to: "  if (false && rejectRetiredGlobalOrderRefs && blockedRetiredRefs.size) {"
  },
  {
    name: "the browser ignores active PO relationship pickups",
    target: "public/dispatch.js",
    suite: "frontend",
    from: "    ...(Array.isArray(order.poPickupManifest) ? order.poPickupManifest : []),",
    to: "    ...[],"
  },
  {
    name: "the browser ignores active direct relationship pickups",
    target: "public/dispatch.js",
    suite: "frontend",
    from: "    ...(Array.isArray(order.directPickupManifest) ? order.directPickupManifest : [])",
    to: "    ...[]"
  },
  {
    name: "an active CO collapses the browser route to its destination yard",
    target: "public/dispatch.js",
    suite: "frontend",
    from: "      ? [order.transitCo.toYard, ...relationshipPickupLocations]",
    to: "      ? [order.transitCo.toYard]"
  },
  {
    name: "relationship pickups leak into CO rollback history",
    target: "public/dispatch.js",
    suite: "frontend",
    from: "      && !relationshipPickupKeys.has(normalizedPickupLocation(location))",
    to: "      && true"
  },
  {
    name: "a completed pickup is again treated as terminal delivery",
    target: "src/dispatch-history-mode.js",
    suite: "completion",
    from: "          AND LOWER(BTRIM(COALESCE(record.stop_type, ''))) = 'dropoff'",
    to: "          AND TRUE"
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
  process.stdout.write(`\n[Derived-order freshness mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [...suites[name]], {
    cwd: serverRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 240_000
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
  throw new Error("Derived-order freshness mutations require an isolated writable source copy.");
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

assertGreen("property", "property baseline");
assertGreen("lifecycle", "lifecycle baseline");
assertGreen("retirement", "retirement baseline");
assertGreen("coGroup", "grouped CO baseline");
assertGreen("replay", "exact event replay baseline");
assertGreen("frontend", "browser projection baseline");
assertGreen("completion", "terminal delivery baseline");

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

assertGreen("property", "restored property source");
assertGreen("lifecycle", "restored lifecycle source");
assertGreen("retirement", "restored retirement source");
assertGreen("coGroup", "restored grouped CO source");
assertGreen("replay", "restored exact event replay source");
assertGreen("frontend", "restored browser projection source");
assertGreen("completion", "restored terminal delivery source");
console.log(`Derived-order freshness mutation score: ${killed}/${mutants.length} killed; sources restored.`);
