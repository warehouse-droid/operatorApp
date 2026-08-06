// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const UNIT = Object.freeze(["test/mbt/unit/asset-csv-import.test.js"]);
const SERVICE = Object.freeze(["test/mbt/integration/asset-csv-import.test.js"]);
const HTTP = Object.freeze(["test/mbt/integration/asset-csv-import-http.test.js"]);

const MUTANTS = Object.freeze([
  {
    name: "asset CSV accepts non-boolean active values",
    path: "src/mbt/asset-csv-import.js",
    tests: UNIT,
    from: "if (normalized !== \"true\" && normalized !== \"false\") {",
    to: "if (false && normalized !== \"true\" && normalized !== \"false\") {"
  },
  {
    name: "asset CSV accepts duplicate in-file identities",
    path: "src/mbt/asset-csv-import.js",
    tests: UNIT,
    from: "if (seen.has(identity)) {",
    to: "if (false && seen.has(identity)) {"
  },
  {
    name: "asset CSV direct service accepts a non-Admin actor",
    path: "src/mbt/asset-csv-import-service.js",
    tests: SERVICE,
    from: "if (!operatorId || !roles.some((role) => role.toLowerCase() === \"admin\")) {",
    to: "if (false && (!operatorId || !roles.some((role) => role.toLowerCase() === \"admin\"))) {"
  },
  {
    name: "asset CSV apply ignores preview ownership",
    path: "src/mbt/asset-csv-import-service.js",
    tests: SERVICE,
    from: "        AND actor_operator_id = $2\n      FOR UPDATE`,",
    to: "        AND $2 = $2\n      FOR UPDATE`,"
  },
  {
    name: "asset CSV apply skips the rollback detector",
    path: "src/mbt/asset-csv-import-service.js",
    tests: SERVICE,
    from: "        await input.hooks?.afterAssetRegistration?.({",
    to: "        if (false) await input.hooks?.afterAssetRegistration?.({"
  },
  {
    name: "asset CSV apply accepts stale reference and target snapshots",
    path: "src/mbt/asset-csv-import-service.js",
    tests: SERVICE,
    from: "      if (fresh.targetRevisionToken !== targetRevisionToken\n          || canonicalSha256(fresh.staged) !== normalizedHash) {",
    to: "      if (false) {"
  },
  {
    name: "asset CSV preview parses the body before capability authorization",
    path: "src/mbt/router.js",
    tests: HTTP,
    from: "    \"/assets/import/preview\",\n    requireMbtAdmin,\n    authorizeAssetImport,\n    boundedImportBody,",
    to: "    \"/assets/import/preview\",\n    requireMbtAdmin,\n    boundedImportBody,"
  }
]);

/** @param {string | Buffer} value */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {readonly string[]} tests */
function runTests(tests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...tests
    ], { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`P3.5a mutation test exited on ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("P3.5a mutations require the writable disposable MBT mutation container.");
}

let killed = 0;
for (const mutant of MUTANTS) {
  const target = path.resolve(mutant.path);
  const original = await readFile(target, "utf8");
  const originalHash = hash(original);
  if (occurrences(original, mutant.from) !== 1) {
    throw new Error(`${mutant.name}: expected one target in ${mutant.path}.`);
  }
  try {
    await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
    if (await runTests(mutant.tests) === 0) {
      throw new Error(`${mutant.name}: survived.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
  } finally {
    await writeFile(target, original, "utf8");
    if (hash(await readFile(target)) !== originalHash) {
      throw new Error(`${mutant.name}: source restoration failed.`);
    }
  }
}

console.log(`P3.5a server mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
