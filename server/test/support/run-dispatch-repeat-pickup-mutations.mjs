// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js",
  "test/dispatch/property/dispatch-repeat-pickup-visits.property.test.js",
  "test/dispatch/adversarial/dispatch-repeat-pickup-visits.adversarial.test.js",
  "test/dispatch/concurrency/dispatch-repeat-pickup-command.red.test.js",
  "test/dispatch/frontend/dispatch-repeat-pickup-visits.red.test.js",
  "test/mbt/unit/driver-repeat-pickup-visits.red.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "duplicate pickup allocations are accepted",
    target: "src/dispatch-pickup-visits.js",
    from: "          if (allocations.has(allocationKey)) {",
    to: "          if (false) {"
  },
  {
    name: "missing pickup allocations are accepted",
    target: "src/dispatch-pickup-visits.js",
    from: "          if (allocations.has(allocationKey)) continue;",
    to: "          if (true) continue;"
  },
  {
    name: "pickup after delivery is accepted",
    target: "src/dispatch-pickup-visits.js",
    from: "          if (index >= deliveryIndexes.get(refKey)) {",
    to: "          if (false) {"
  },
  {
    name: "active travel no longer protects its destination",
    target: "src/dispatch-pickup-visits.js",
    from: "      if (recordStatus(record) === \"in_progress\") boundary = Math.max(boundary, travelTargetIndex(load, record));",
    to: "      if (recordStatus(record) === \"in_progress\") boundary = Math.max(boundary, -1);"
  },
  {
    name: "executed-stop identity ignores pickup allocation",
    target: "src/dispatch-pickup-visits.js",
    from: "    orderRefs: [...refs].map((ref) => ref.toLowerCase()).sort()",
    to: "    orderRefs: []"
  },
  {
    name: "ambiguous legacy repeat pickups are guessed",
    target: "src/dispatch-pickup-visits.js",
    from: "  if (sameLocation.length === 1) {",
    to: "  if (sameLocation.length >= 1) {"
  },
  {
    name: "untouched legacy loads are subjected to the new strict validator",
    target: "src/dispatch-pickup-visits.js",
    from: "  const conflicts = validateMaterializedPickupVisits(next, { allowLegacyPassthrough });",
    to: "  const conflicts = validateMaterializedPickupVisits(next, { allowLegacyPassthrough: false });"
  },
  {
    name: "manual split can empty the original pickup visit",
    target: "src/dispatch-pickup-visits.js",
    from: "  if (requested.length >= sourceRefs.length) {",
    to: "  if (false) {"
  },
  {
    name: "completed customer visits are reused",
    target: "src/dispatch-pickup-visits.js",
    from: ".filter(({ stop, index }) => deliveryStop(stop) && index > boundary && normalizedAddress(deliveryAddress(plan, stop)) === key)",
    to: ".filter(({ stop }) => deliveryStop(stop) && normalizedAddress(deliveryAddress(plan, stop)) === key)"
  },
  {
    name: "Driver pickup jobs ignore visit-scoped order refs",
    target: "src/driver-repository.js",
    from: "  const explicitRefs = Array.isArray(pickup?.orderRefs)",
    to: "  const explicitRefs = false && Array.isArray(pickup?.orderRefs)"
  },
  {
    name: "dispatcher-created pickup stops omit explicit allocation",
    target: "public/dispatch.js",
    from: "    orderRefs: [order.id],",
    to: "    orderRefs: [],"
  }
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function runFocusedTests() {
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...TESTS
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {throw result.error;}
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Repeat-pickup mutations require the writable disposable MBT test container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
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
    if (runFocusedTests() === 0) {throw new Error(`${mutant.name}: survived its focused regressions.`);}
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (sha256(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Repeat-pickup mutation source restoration failed for ${target}.`);
    }
  }
}

if (runFocusedTests() !== 0) {throw new Error("Repeat-pickup tests failed after source restoration.");}
console.log(`Repeat-pickup mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
