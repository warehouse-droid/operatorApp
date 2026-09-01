// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UNIT_TESTS = Object.freeze([
  "test/mbt/unit/scm-dependency-management-policy.red.test.js",
  "test/mbt/unit/scm-dependency-plan-reconciler.red.test.js",
  "test/mbt/unit/scm-dependency-command-service.red.test.js",
  "test/mbt/unit/driver-route-change-service.red.test.js"
]);
const DATABASE_TESTS = Object.freeze([
  "test/mbt/integration/driver-route-superseded-fence.red.test.js"
]);
const QUANTITY_PROPERTY_TESTS = Object.freeze([
  "test/dispatch/property/order-dependency-quantity.property.test.js"
]);
const QUANTITY_INTEGRATION_TESTS = Object.freeze([
  "test/dispatch/integration/order-dependency-multi-to-extension.red.test.js",
  "test/dispatch/integration/order-dependency-quantity-replay.red.test.js"
]);
const CO_COMPATIBILITY_TESTS = Object.freeze([
  "test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js"
]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string, tests: readonly string[]}>} */
const MUTANTS = Object.freeze([
  {
    name: "hidden Driver device is accepted as ready",
    target: "src/scm-dependency-management-policy.js",
    from: "    if (!device.visible || !device.online || !heartbeatFresh) {",
    to: "    if (false) {",
    tests: UNIT_TESTS
  },
  {
    name: "pending Driver evidence is accepted as clean",
    target: "src/scm-dependency-management-policy.js",
    from: "    if (device.syncState !== \"clean\" || pendingEventCount > 0 || pendingPhotoCount > 0) {",
    to: "    if (false) {",
    tests: UNIT_TESTS
  },
  {
    name: "screen-off request skips durable pending state",
    target: "src/scm-dependency-command-service.js",
    from: "      if (preview?.routeReadiness?.pendingRequestRequired) {",
    to: "      if (false) {",
    tests: UNIT_TESTS
  },
  {
    name: "same TO may move to another logical target",
    target: "src/scm-dependency-management-policy.js",
    from: "  if (existingTarget && requestedTarget !== existingTarget) {",
    to: "  if (false) {",
    tests: UNIT_TESTS
  },
  {
    name: "manual pickup is ignored and duplicated",
    target: "src/scm-dependency-plan-reconciler.js",
    from: "      const priorPickup = stops.slice(0, index).find((stop) => stop?.type === \"pick\" && samePlace(stop.location, location));",
    to: "      const priorPickup = undefined;",
    tests: UNIT_TESTS
  },
  {
    name: "new events on a superseded manifest stay pending",
    target: "src/driver-offline-repository.js",
    from: "      if (manifest.superseded_at) {",
    to: "      if (false) {",
    tests: DATABASE_TESTS
  },
  {
    name: "queued pre-supersede event can still apply",
    target: "src/driver-offline-service.js",
    from: "      if (manifest.supersededAt) {",
    to: "      if (false) {",
    tests: DATABASE_TESTS
  },
  {
    name: "failed offline-grant lookup is treated as authenticated",
    target: "src/driver-offline-repository.js",
    from: "  if (!result.rowCount) return null;\n  if (!touch) return mapGrant(result.rows[0]);",
    to: "  if (!result.rowCount) return { grantId: \"unsafe-mutant\" };\n  if (!touch) return mapGrant(result.rows[0]);",
    tests: DATABASE_TESTS
  },
  {
    name: "partial TO contribution ignores the current TO quantity cap",
    target: "src/order-dependency-quantity.js",
    from: "      : Math.min(allocated, Math.max(0, number(remaining)));",
    to: "      : allocated;",
    tests: QUANTITY_PROPERTY_TESTS
  },
  {
    name: "multiple item allocations share one TO quantity budget",
    target: "src/order-dependency-quantity.js",
    from: "    const itemKey = String(line.itemId || line.itemName || line.id);\n    const remaining = remainingByItem.get(itemKey);",
    to: "    const itemKey = \"shared-item-budget\";\n    const remaining = remainingByItem.get(itemKey);",
    tests: QUANTITY_PROPERTY_TESTS
  },
  {
    name: "receiving quantity cannot supply a missing outbound projection",
    target: "src/order-dependency-quantity.js",
    from: "    remainingByItem.set(itemKey, outbound ?? receiving);",
    to: "    remainingByItem.set(itemKey, outbound);",
    tests: QUANTITY_PROPERTY_TESTS
  },
  {
    name: "direct pickup manifest uses the stale saved allocation",
    target: "src/order-dependency-repository.js",
    from: "    item.quantity += number(line.effectiveAllocatedQuantity ?? line.allocatedQuantity);",
    to: "    item.quantity += number(line.allocatedQuantity);",
    tests: QUANTITY_INTEGRATION_TESTS
  },
  {
    name: "reduced TO quantity becomes an attention blocker again",
    target: "src/order-dependency-repository.js",
    from: "      const attention = beforeDelivery && (unavailable || missingMaterialLine);",
    to: "      const attention = beforeDelivery && (unavailable || missingMaterialLine || quantityLimited);",
    tests: QUANTITY_INTEGRATION_TESTS
  },
  {
    name: "zero-contribution direct dependency still creates a pickup",
    target: "src/order-dependency-repository.js",
    from: "      const routedDirect = direct.filter(dependencyHasEffectiveMaterial);",
    to: "      const routedDirect = direct;",
    tests: QUANTITY_INTEGRATION_TESTS
  },
  {
    name: "zero-contribution direct dependency still blocks route validation",
    target: "src/order-dependency-repository.js",
    from: "      if (!dependencyHasEffectiveMaterial(dependency)) continue;",
    to: "      if (false) continue;",
    tests: QUANTITY_INTEGRATION_TESTS
  },
  {
    name: "legacy CO dependency with unknown lines loses its routed pickup",
    target: "src/order-dependency-quantity.js",
    from: "  if (!materialLines.length) return true;",
    to: "  if (!materialLines.length) return false;",
    tests: CO_COMPATIBILITY_TESTS
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

/** @param {string} label @param {readonly string[]} tests */
function runTests(label, tests) {
  process.stdout.write(`\n[SCM dependency mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...tests
  ], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("SCM dependency mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map(({ target }) => target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

const baseline = [...new Set(MUTANTS.flatMap(({ tests }) => tests))];
if (runTests("baseline", baseline) !== 0) {
  throw new Error("SCM dependency mutation baseline must be green.");
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name, mutant.tests) === 0) {
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
      throw new Error(`SCM dependency mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("restored source", baseline) !== 0) {
  throw new Error("SCM dependency tests failed after mutation source restoration.");
}
console.log(`SCM dependency mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
