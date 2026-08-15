// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/operator-customer-pickup-photo-gate.red.test.js",
  "test/mbt/property/operator-customer-pickup-photo-gate.property.test.js",
  "test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js",
  "test/mbt/unit/feature-gate-catalog.test.js"
]);

const MUTANTS = Object.freeze([
  Object.freeze({
    name: "missing or malformed rows fail open",
    target: "src/operator-customer-pickup-photo-policy.js",
    from: "  const required = row?.enabled !== false;",
    to: "  const required = row?.enabled === true;"
  }),
  Object.freeze({
    name: "disabled policy still requires one photo",
    target: "src/operator-customer-pickup-photo-policy.js",
    from: "required ? OPERATOR_CUSTOMER_PICKUP_REQUIRED_PHOTO_COUNT : 0,",
    to: "required ? OPERATOR_CUSTOMER_PICKUP_REQUIRED_PHOTO_COUNT : OPERATOR_CUSTOMER_PICKUP_REQUIRED_PHOTO_COUNT,"
  }),
  Object.freeze({
    name: "missing database row disables evidence",
    target: "src/operator-customer-pickup-photo-policy.js",
    from: "  return materializeOperatorCustomerPickupPhotoRequirement(result.rows?.[0]);",
    to: "  return materializeOperatorCustomerPickupPhotoRequirement({ enabled: false });"
  }),
  Object.freeze({
    name: "migration defaults the evidence gate off",
    target: "migrations/165_operator_customer_pickup_photo_gate.sql",
    from: "  true,\n  'Require at least one Operator photo",
    to: "  false,\n  'Require at least one Operator photo"
  }),
  Object.freeze({
    name: "repository ignores the live required count",
    target: "src/delivery-repository.js",
    from: "requirePhotoReferences(photoDataUrls, photoRequirement.requiredPhotoCount);",
    to: "requirePhotoReferences(photoDataUrls, 0);"
  }),
  Object.freeze({
    name: "HTTP route reinstates a hard-coded two-photo precondition",
    target: "src/server.js",
    from: "requiredPhotoDataUrls(req.body?.photoDataUrls, 0);",
    to: "requiredPhotoDataUrls(req.body?.photoDataUrls);"
  }),
  Object.freeze({
    name: "Customer Pickup UI hard-codes two required photos",
    target: "public/operator.js",
    from: "  if (currentModule === \"customer-pickup-load\") return customerPickupRequiredPhotoCount();",
    to: "  if (currentModule === \"customer-pickup-load\") return 2;"
  }),
  Object.freeze({
    name: "zero-photo completion still invokes the uploader",
    target: "public/operator.js",
    from: "    const uploadedPhotoRefs = photos.length\n      ? await uploadOperatorPhotos(photos, {",
    to: "    const uploadedPhotoRefs = true\n      ? await uploadOperatorPhotos(photos, {"
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
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Customer Pickup photo-gate mutations require the writable disposable MBT mutation container.");
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
console.log(`Customer Pickup photo-gate mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
