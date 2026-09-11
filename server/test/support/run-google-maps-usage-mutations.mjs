// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/google-maps-usage-policy.red.test.js",
  "test/mbt/property/google-maps-usage-policy.property.test.js",
  "test/mbt/unit/google-maps-gateway.red.test.js",
  "test/dispatch/adversarial/google-maps-usage-replay.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "hard limit rejects the final safe unit",
    target: "src/google-maps-usage-policy.js",
    from: "  if (afterUsage > limits.hardLimit) return { admitted: false, reason: \"hard_limit\", budgetState: \"exhausted\", units: requestedUnits };",
    to: "  if (afterUsage >= limits.hardLimit) return { admitted: false, reason: \"hard_limit\", budgetState: \"exhausted\", units: requestedUnits };"
  },
  {
    name: "automatic work bypasses its subsystem allowance",
    target: "src/google-maps-usage-policy.js",
    from: "  if (automatic && usesSharedReserve) {",
    to: "  if (!automatic && usesSharedReserve) {"
  },
  {
    name: "traffic mode is omitted from route identity",
    target: "src/google-maps-usage-policy.js",
    from: "    trafficAware: Boolean(trafficAware),",
    to: "    trafficAware: false,"
  },
  {
    name: "different locations are treated as zero-distance duplicates",
    target: "src/google-maps-usage-policy.js",
    from: "    if (normalizedLocation(routeStopLocation(previous)) === normalizedLocation(routeStopLocation(stop))) return 0;",
    to: "    if (normalizedLocation(routeStopLocation(previous)) !== normalizedLocation(routeStopLocation(stop))) return 0;"
  },
  {
    name: "controlled monitor restores automatic ETA fan-out",
    target: "src/google-maps-usage-replay.js",
    from: "    monitorEta: 0,",
    to: "    monitorEta: legacyMonitorEta,"
  },
  {
    name: "malformed source previews are reported as valid",
    target: "src/google-maps-usage-replay.js",
    from: "      if (sourceValidation && !sourceValidation.valid) {",
    to: "      if (sourceValidation && sourceValidation.valid) {"
  },
  {
    name: "ordinary high-waypoint calls bypass the cost guard",
    target: "src/google-maps-gateway.js",
    from: "    if (stops.length > MAX_STANDARD_ROUTE_STOPS && !input.trafficAware) {",
    to: "    if (stops.length > MAX_STANDARD_ROUTE_STOPS && input.trafficAware) {"
  },
  {
    name: "denied quota decisions invoke Google",
    target: "src/google-maps-gateway.js",
    from: "    if (!admission?.admitted) {",
    to: "    if (admission?.admitted) {"
  }
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function runTests(label) {
  process.stdout.write(`\n[Google Maps usage mutation] ${label}\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...TESTS], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {throw result.error;}
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Google Maps mutations require the writable disposable mutation container.");
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
    process.stdout.write(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}\n`);
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
process.stdout.write(`Google Maps usage mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.\n`);
