// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/mbbs-cross-charge-route-pricing-v4.red.test.js",
  "test/mbt/property/mbbs-cross-charge-route-pricing-v4.property.test.js",
  "test/mbt/unit/mbbs-driver-billing-planner.red.test.js",
  "test/mbt/unit/mbbs-rate-card-charging-policy.red.test.js",
  "test/mbt/unit/local-billing-calculator-coverage-hardening.test.js"
]);
const ENDPOINT_OVERRIDE_TEST = "test/mbt/integration/mbbs-billing-candidates.test.js";
const ENDPOINT_OVERRIDE_PATTERN = "Dispatch pickup and delivery overrides both";

const MUTANTS = Object.freeze([
  Object.freeze({
    name: "included 75 km is charged again",
    target: "src/mbt/distance-band-pricing.js",
    from: "chargeableMetres = Math.max(0, rawDistanceMetres - Number(band.includedMetres));",
    to: "chargeableMetres = rawDistanceMetres;"
  }),
  Object.freeze({
    name: "CAD 385 base amount is discarded",
    target: "src/mbt/distance-band-pricing.js",
    from: "baseAmountMinor = Number(band.baseAmountMinor);",
    to: "baseAmountMinor = 0;"
  }),
  Object.freeze({
    name: "excess distance cents round down",
    target: "src/mbt/distance-band-pricing.js",
    from: "const excessAmount = ((BigInt(chargeableMetres) * BigInt(unitAmountMinor)) + 500n) / 1000n;",
    to: "const excessAmount = (BigInt(chargeableMetres) * BigInt(unitAmountMinor)) / 1000n;"
  }),
  Object.freeze({
    name: "incomplete base-plus-excess pairs are accepted",
    target: "src/mbt/distance-band-pricing.js",
    from: "if (hasBase !== hasIncluded) {",
    to: "if (false && hasBase !== hasIncluded) {"
  }),
  Object.freeze({
    name: "separate physical TO pickup visits collapse",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "? `DRIVER_LOAD|${driverLoadId}|PICKUP|${text(sharedPickup.key)}`",
    to: "? `DRIVER_LOAD|${driverLoadId}`"
  }),
  Object.freeze({
    name: "stale canonical TO origin wins over Dispatch pickup evidence",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "const origin = text(canonical.originAddressOverride)\n    || pickupAddresses[0]\n    || text(canonical.originAddress)",
    to: "const origin = text(canonical.originAddressOverride)\n    || text(canonical.originAddress)\n    || pickupAddresses[0]"
  }),
  Object.freeze({
    name: "explicit Dispatch pickup override is ignored for billing",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "const origin = text(canonical.originAddressOverride)\n    || pickupAddresses[0]",
    to: "const origin = pickupAddresses[0]"
  }),
  Object.freeze({
    name: "explicit Dispatch delivery override is ignored for billing",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "const destination = text(canonical.destinationAddressOverride)\n    || (occurrence.sourceType === \"TO\"",
    to: "const destination = (occurrence.sourceType === \"TO\""
  }),
  Object.freeze({
    name: "PO Dispatch delivery override is omitted from canonical billing data",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "const destinationOverride = retainedRouteLabel(row.dispatch_delivery_address);",
    to: "const destinationOverride = \"\";"
  }),
  Object.freeze({
    name: "multi-drop TO loses its longest-drop billing classification",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "? \"to_replenishment_multi_drop\"\n      : \"to_replenishment\";",
    to: "? \"to_replenishment\"\n      : \"to_replenishment\";"
  }),
  Object.freeze({
    name: "multi-drop TO charges one extra drop too many",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "billingRule === \"to_replenishment_multi_drop\"\n      ? Math.max(0, dropCount - 1)",
    to: "billingRule === \"to_replenishment_multi_drop\"\n      ? Math.max(0, dropCount)"
  }),
  Object.freeze({
    name: "one shared TO total is duplicated into every durable order",
    target: "src/mbt/local-billing-calculator.js",
    from: "const allocatedAmountMinor = base + remainderMinor;",
    to: "const allocatedAmountMinor = load.sharedTotalMinor;"
  }),
  Object.freeze({
    name: "billing candidate loses the longest-drop resolver strategy",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "distanceStrategy: text(unit.distanceStrategy) || \"sequential_route\",",
    to: "distanceStrategy: \"sequential_route\","
  }),
  Object.freeze({
    name: "rate-card TO additional-drop price is replaced by direct-pickup price",
    target: "src/mbt/mbbs-rate-card-policy.js",
    from: "input.toReplenishmentAdditionalDropUnitAmountMinor,\n        \"Replenishment TO additional-drop unit price\"",
    to: "input.directPickupUnitAmountMinor,\n        \"Replenishment TO additional-drop unit price\""
  })
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...TESTS
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    return result.status ?? 1;
  }
  const endpointResult = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    `--test-name-pattern=${ENDPOINT_OVERRIDE_PATTERN}`,
    ENDPOINT_OVERRIDE_TEST
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (endpointResult.error) {
    throw endpointResult.error;
  }
  return endpointResult.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("MBBS cross-charge v4 mutations require a writable disposable test container.");
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
    if (typeof original !== "string") {
      throw new Error(`Missing mutation source ${mutant.target}.`);
    }
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
console.log(`MBBS cross-charge v4 mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
