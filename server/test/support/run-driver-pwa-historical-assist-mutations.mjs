// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/driver-pwa-historical-assist-policy.red.test.js",
  "test/mbt/property/driver-pwa-historical-assist.property.test.js",
  "test/mbt/adversarial/driver-pwa-historical-assist-adversarial.test.js",
  "test/mbt/unit/driver-pwa-historical-assist-wiring.contract.test.js"
]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string}>} */
const MUTANTS = Object.freeze([
  {
    name: "Toronto today is accidentally accepted",
    target: "src/driver-historical-assist-policy.js",
    from: "  if (planDate >= companyDate) {",
    to: "  if (planDate > companyDate) {"
  },
  {
    name: "exactly ten seconds is accidentally rejected",
    target: "src/driver-historical-assist-policy.js",
    from: "  if (completed.getTime() - started.getTime() < HISTORICAL_ASSIST_MINIMUM_DURATION_MS) {",
    to: "  if (completed.getTime() - started.getTime() <= HISTORICAL_ASSIST_MINIMUM_DURATION_MS) {"
  },
  {
    name: "disabled Driver photo requirement is ignored",
    target: "src/driver-historical-assist-policy.js",
    from: "  if (configured === 0) {\n    return 0;\n  }",
    to: "  if (configured === 0) {\n    return 2;\n  }"
  },
  {
    name: "photo ceiling is weakened",
    target: "src/driver-historical-assist-policy.js",
    from: "export const HISTORICAL_ASSIST_MAX_PHOTOS = 20;",
    to: "export const HISTORICAL_ASSIST_MAX_PHOTOS = 21;"
  },
  {
    name: "photo references may come from the Driver upload namespace",
    target: "src/driver-historical-assist-evidence.js",
    from: '    parts[0] === "dispatch-assist",',
    to: '    parts[0] === "driver",'
  },
  {
    name: "uploaded photos are no longer request-bound",
    target: "src/driver-historical-assist-evidence.js",
    from: '  const expectedSubject = requestId ? `${requestId}-${photoId}` : String(photoId || "");',
    to: '  const expectedSubject = String(photoId || "");'
  },
  {
    name: "state hash depends on object insertion order",
    target: "src/driver-historical-assist-evidence.js",
    from: "return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));",
    to: "return Object.fromEntries(Object.keys(value).map((key) => [key, canonicalValue(value[key])]));"
  },
  {
    name: "later incomplete visits become actionable",
    target: "src/driver-historical-assist-policy.js",
    from: "  const actionable = visit.jobIds.includes(firstIncompleteJobId);",
    to: "  const actionable = true;"
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

/** @param {string} label @param {{expectFailure?: boolean}} [options] */
function runTests(label, { expectFailure = false } = {}) {
  process.stdout.write(`\n[historical-assist mutation] ${label}\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...TESTS], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0 && !expectFailure) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Historical-assist mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map(({ target }) => target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

if (runTests("baseline") !== 0) {
  throw new Error("Historical-assist mutation baseline must be green.");
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name, { expectFailure: true }) === 0) {
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
      throw new Error(`Historical-assist mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("restored source") !== 0) {
  throw new Error("Historical-assist tests failed after mutation source restoration.");
}
console.log(`Historical-assist mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
