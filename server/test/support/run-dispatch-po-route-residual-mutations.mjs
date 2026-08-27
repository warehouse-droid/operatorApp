// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/dispatch/unit/dispatch-po-route-residual.red.test.js",
  "test/dispatch/frontend/dispatch-po-route-residual-ui.red.test.js",
  "test/dispatch/property/dispatch-po-route-residual.property.test.js",
  "test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js"
]);

const MUTANTS = Object.freeze([
  Object.freeze({
    name: "over-allocation creates negative residual freight",
    target: "src/dispatch-po-route-projection.js",
    from: "  return rounded(Math.max(number(total) - number(allocated), 0));",
    to: "  return rounded(number(total) - number(allocated));"
  }),
  Object.freeze({
    name: "cancelled PO links still subtract route freight",
    target: "src/dispatch-po-route-projection.js",
    from: "  return !status || status === \"active\";",
    to: "  return true;"
  }),
  Object.freeze({
    name: "negative hostile allocation inflates PO residual freight",
    target: "src/dispatch-po-route-projection.js",
    from: "  return Math.max(number(allocation[snake] ?? allocation[camel]), 0);",
    to: "  return number(allocation[snake] ?? allocation[camel]);"
  }),
  Object.freeze({
    name: "stale PO drop address overrides the current Dispatch address",
    target: "src/dispatch-po-route-projection.js",
    from: "      address: text(order.deliveryAddressOverride ?? order.delivery_address_override)\n        || text(original.address ?? order.destinationAddress ?? order.destination_address ?? destinationYard),",
    to: "      address: text(original.address ?? order.deliveryAddressOverride ?? order.delivery_address_override\n        ?? order.destinationAddress ?? order.destination_address ?? destinationYard),"
  }),
  Object.freeze({
    name: "existing PO stop keeps its full source quantities",
    target: "src/scm-dependency-plan-reconciler.js",
    from: "      entry.load.stops[entry.index] = projectedResidualStop(entry.stop, order, dropoffs[dropoffIndex]);",
    to: "      entry.load.stops[entry.index] = { ...entry.stop };"
  }),
  Object.freeze({
    name: "server route timing trusts stale explicit PO stop quantities",
    target: "src/dispatch-load-assignment.js",
    from: "  if (projection) {\n    const projected = dropoff[itemCamel] ?? dropoff[itemSnake];",
    to: "  if (false && projection) {\n    const projected = dropoff[itemCamel] ?? dropoff[itemSnake];"
  }),
  Object.freeze({
    name: "Driver PO pickup applies SO allocation filtering to residual items",
    target: "src/driver-repository.js",
    from: "    .map((item) => projection\n      ? item\n      : planItemForPickup(item, { ...context, orderType: planOrder?.type || context.orderType }))",
    to: "    .map((item) => planItemForPickup(item, { ...context, orderType: planOrder?.type || context.orderType }))"
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
  if (result.error) {throw result.error;}
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch PO residual mutations require the writable disposable mutation container.");
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
    if (typeof original !== "string") {throw new Error(`Missing mutation source ${mutant.target}.`);}
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {throw new Error(`${mutant.name}: survived the focused regression suite.`);}
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
console.log(`Dispatch PO residual mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
