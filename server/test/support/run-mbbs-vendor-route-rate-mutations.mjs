// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/mbbs-vendor-route-rates.red.test.js",
  "test/mbt/unit/mbbs-driver-billing-planner.red.test.js",
  "test/mbt/property/mbbs-vendor-route-rates.property.test.js",
  "test/mbt/unit/mbbs-vendor-route-rate-card.red.test.js",
  "test/mbt/unit/mbbs-order-billing-v3.contract.test.js",
  "test/mbt/integration/mbbs-rate-card-charging-policy.test.js",
  "test/mbt/integration/mbbs-vendor-route-candidates.red.test.js"
]);

const SCHEMA_PROPERTIES = Object.freeze([
  "test/mbt/property/mbbs-vendor-route-rates.property.test.js"
]);

const MUTANTS = Object.freeze([
  Object.freeze({
    name: "negative vendor-route money is accepted",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  if (typeof value !== \"number\" || !Number.isSafeInteger(value) || value < 0) {",
    to: "  if (typeof value !== \"number\" || !Number.isSafeInteger(value)) {"
  }),
  Object.freeze({
    name: "schema-v3 vendor-route calculation regresses to schema v2 only",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  const supportedSchema = policy.schemaVersion === 2 || policy.schemaVersion === 3;",
    to: "  const supportedSchema = policy.schemaVersion === 2;",
    tests: SCHEMA_PROPERTIES
  }),
  Object.freeze({
    name: "unsupported vendor-route policy schemas are accepted",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  if (!supportedSchema || policy.currency !== \"CAD\") {",
    to: "  if (policy.currency !== \"CAD\") {"
  }),
  Object.freeze({
    name: "schema-v3 rate-card graphs regress to schema v2 only",
    target: "src/mbt/rate-card-configuration-service.js",
    from: "    const supportedVendorRoutePolicy = normalized.mbbsChargingPolicy.schemaVersion === 2\n      || normalized.mbbsChargingPolicy.schemaVersion === 3;",
    to: "    const supportedVendorRoutePolicy = normalized.mbbsChargingPolicy.schemaVersion === 2;"
  }),
  Object.freeze({
    name: "reverse VRMA loses PO pair-price parity",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  if (!new Set([\"PO\", \"VRMA\"]).has(sourceType)) {",
    to: "  if (sourceType !== \"PO\") {"
  }),
  Object.freeze({
    name: "partial vendor-yard names select money",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "      && exactNames.has(normalizedText(rate.vendorYardName))",
    to: "      && [...exactNames].some((name) => normalizedText(rate.vendorYardName).includes(name))"
  }),
  Object.freeze({
    name: "the base pickup/drop pair is charged as an extra stop",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  const additionalStopCount = Math.max(0, routeStopCount - 2);",
    to: "  const additionalStopCount = Math.max(0, routeStopCount - 1);"
  }),
  Object.freeze({
    name: "distinct immutable Driver loads collapse into one PO leg",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "      const key = [\"PO\", \"VRMA\"].includes(reference.sourceType) && retainedLoadId\n        ? `${baseKey}|DRIVER_LOAD|${retainedLoadId}`\n        : baseKey;",
    to: "      const key = baseKey;"
  }),
  Object.freeze({
    name: "different PO references on distinct loads collapse by common route",
    target: "src/mbt/mbbs-driver-billing-planner.js",
    from: "    const groupKey = driverLoadId\n      ? `DRIVER_LOAD|${driverLoadId}|ORIGIN|${normalizedOrigin || missingOriginScope}`\n      : `LEGACY|${text(canonicalOrder.billingGroupKey) || routeKey || missingOriginScope}`;",
    to: "    const groupKey = text(canonicalOrder.billingGroupKey) || routeKey || missingOriginScope;"
  }),
  Object.freeze({
    name: "flat pricing uses the distance-band base amount",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  const baseAmountMinor = pricingMethod === \"vendor_yard_flat\"\n    ? vendorRouteAmountMinor\n    : distanceBandAmountMinor;",
    to: "  const baseAmountMinor = pricingMethod === \"vendor_yard_flat\"\n    ? distanceBandAmountMinor\n    : vendorRouteAmountMinor;"
  }),
  Object.freeze({
    name: "the Permacon Cambridge 150 source label regresses to legacy BS",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  ...seedRows(\"permacon_cambridge\", \"Permacon - Cambridge\", [[\"12441\", 550], [\"2967\", 600], [\"3445\", 600], [\"150\", 550]]),",
    to: "  ...seedRows(\"permacon_cambridge\", \"Permacon - Cambridge\", [[\"12441\", 550], [\"2967\", 600], [\"3445\", 600], [\"BS\", 550]]),"
  }),
  Object.freeze({
    name: "the Unilock Georgetown 150 source label regresses to legacy BS",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  ...seedRows(\"unilock_georgetown\", \"Unilock - Georgetown\", [[\"12441\", 450], [\"2967\", 450], [\"3445\", 450], [\"150\", 400]]),",
    to: "  ...seedRows(\"unilock_georgetown\", \"Unilock - Georgetown\", [[\"12441\", 450], [\"2967\", 450], [\"3445\", 450], [\"BS\", 400]]),"
  }),
  Object.freeze({
    name: "a supplied vendor-yard price changes by one dollar",
    target: "src/mbt/mbbs-vendor-route-rates.js",
    from: "  ...seedRows(\"beaver_valley_maple\", \"Beaver Valley Stone - Maple\", fourYardPrices([200, 250, 250, 300])),",
    to: "  ...seedRows(\"beaver_valley_maple\", \"Beaver Valley Stone - Maple\", fourYardPrices([201, 250, 250, 300])),"
  }),
  Object.freeze({
    name: "an exact flat pair unnecessarily depends on the routing provider",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "  const shouldResolveDistance = pricingMethod === \"distance_band\"\n    || (Boolean(vendorRate) && identity.endpointOverride === true);",
    to: "  const shouldResolveDistance = true\n    || (Boolean(vendorRate) && identity.endpointOverride === true);"
  }),
  Object.freeze({
    name: "conversion accepts a tampered retained vendor-route price",
    target: "src/mbt/shadow-billing-service.js",
    from: "  if (!sameVendorRouteRate(vendorRate, entry.selectedVendorRouteRate)) {",
    to: "  if (false && !sameVendorRouteRate(vendorRate, entry.selectedVendorRouteRate)) {"
  }),
  Object.freeze({
    name: "Billing sends a hidden flat choice instead of the visible selection",
    target: "public/mbt-billing.js",
    from: "                  pricingMethod: state.pricingSelections.get(candidateId)",
    to: "                  pricingMethod: \"vendor_yard_flat\""
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

/** @param {string} label @param {readonly string[]} [tests] */
function runTests(label, tests = TESTS) {
  process.stdout.write(`\n[mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...tests
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("MBBS vendor-route mutations require the writable disposable MBT mutation container.");
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
    const tests = "tests" in mutant ? mutant.tests : TESTS;
    if (runTests(mutant.name, tests) === 0) {
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
console.log(`MBBS vendor-route mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
