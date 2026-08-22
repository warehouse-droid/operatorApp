// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/netsuite-m2m-auth.red.test.js",
  "test/mbt/unit/netsuite-m2m-settings.red.test.js",
  "test/mbt/unit/netsuite-m2m-runtime.red.test.js",
  "test/mbt/concurrency/netsuite-m2m-token-races.test.js",
  "test/mbt/property/netsuite-m2m-auth.property.test.js",
  "test/mbt/unit/pending-approval-reconciliation.red.test.js",
  "test/mbt/property/pending-approval-reconciliation.property.test.js",
  "test/mbt/integration/pending-approval-reconciliation-repository.red.test.js"
]);

const MUTANTS = Object.freeze([
  Object.freeze({
    name: "client assertion advertises the wrong signing algorithm",
    tests: ["test/mbt/unit/netsuite-m2m-auth.red.test.js"],
    target: "src/netsuite-m2m-auth.js",
    from: "  const header = encodedJson({ typ: \"JWT\", alg: \"PS256\", kid: keyId });",
    to: "  const header = encodedJson({ typ: \"JWT\", alg: \"RS256\", kid: keyId });"
  }),
  Object.freeze({
    name: "near-expiry access token is reused",
    tests: ["test/mbt/unit/netsuite-m2m-auth.red.test.js"],
    target: "src/netsuite-m2m-auth.js",
    from: "      && this.cached.expiresAt - nowMs > TOKEN_REFRESH_SAFETY_MS",
    to: "      && this.cached.expiresAt - nowMs > 0"
  }),
  Object.freeze({
    name: "parallel token requests bypass single-flight protection",
    tests: ["test/mbt/concurrency/netsuite-m2m-token-races.test.js"],
    target: "src/netsuite-m2m-auth.js",
    from: "    if (this.inFlight?.key === key) {return this.inFlight.promise;}",
    to: "    if (false && this.inFlight?.key === key) {return this.inFlight.promise;}"
  }),
  Object.freeze({
    name: "token assertion accepts a non-NetSuite host",
    tests: ["test/mbt/unit/netsuite-m2m-auth.red.test.js"],
    target: "src/netsuite-m2m-auth.js",
    from: "      || !url.hostname.toLowerCase().endsWith(\".suitetalk.api.netsuite.com\")",
    to: "      || false"
  }),
  Object.freeze({
    name: "failed activation probe still promotes staged credentials",
    tests: ["test/mbt/unit/netsuite-m2m-settings.red.test.js"],
    target: "src/netsuite-m2m-settings.js",
    from: "      const evidence = await probe(credentials);\n      if (evidence?.ok !== true) {throw new Error(\"The read-only NetSuite M2M activation probe did not succeed.\");}\n      state.revision += 1;\n      state.active = {",
    to: "      const evidence = await probe(credentials);\n      if (false && evidence?.ok !== true) {throw new Error(\"The read-only NetSuite M2M activation probe did not succeed.\");}\n      state.revision += 1;\n      state.active = {"
  }),
  Object.freeze({
    name: "browser fallback destroys the reusable M2M mapping",
    tests: ["test/mbt/unit/netsuite-m2m-settings.red.test.js"],
    target: "src/netsuite-m2m-settings.js",
    from: "      state.revision += 1;\n      state.authMode = \"authorization_code\";\n      await this.writeState(state);",
    to: "      state.revision += 1;\n      state.active = null;\n      state.authMode = \"authorization_code\";\n      await this.writeState(state);"
  }),
  Object.freeze({
    name: "Pending Approval scope admits partial text matches",
    tests: [
      "test/mbt/unit/pending-approval-reconciliation.red.test.js",
      "test/mbt/property/pending-approval-reconciliation.property.test.js"
    ],
    target: "src/pending-approval-reconciliation.js",
    from: "  return statusCode(row) === \"A\" || /^pending(?: supervisor)? approval$/i.test(text);",
    to: "  return statusCode(row) === \"A\" || /pending/i.test(text);"
  }),
  Object.freeze({
    name: "conditional update overwrites an order that left Pending Approval",
    tests: ["test/mbt/integration/pending-approval-reconciliation-repository.red.test.js"],
    target: "src/pending-approval-reconciliation-repository.js",
    from: "      WHERE netsuite_id = $1\n        AND ${PENDING_APPROVAL_SQL}\n    RETURNING netsuite_id::text AS \"netsuiteId\",",
    to: "      WHERE netsuite_id = $1\n    RETURNING netsuite_id::text AS \"netsuiteId\","
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
    stdio: "inherit"
  });
  if (result.error) {throw result.error;}
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("NetSuite M2M mutations require the writable disposable MBT mutation container.");
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
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`NetSuite M2M mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
