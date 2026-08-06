// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE = path.resolve("test/support/test-database-isolation.mjs");
const CONTRACT_SOURCE = path.resolve("test/mbt/infrastructure/test-database-isolation.test.js");
const MUTANTS = Object.freeze([
  Object.freeze({
    name: "test-file isolation runs outside the explicit isolated environment",
    from: "if (environment.MBT_TEST_ISOLATED !== \"1\") {",
    to: "if (false && environment.MBT_TEST_ISOLATED !== \"1\") {"
  }),
  Object.freeze({
    name: "test-file isolation accepts a non-PostgreSQL protocol",
    from: "!new Set([\"postgres:\", \"postgresql:\"]).has(parsed.protocol)",
    to: "false"
  }),
  Object.freeze({
    name: "test-file isolation accepts a non-Compose host",
    from: "parsed.hostname !== \"db\"",
    to: "false"
  }),
  Object.freeze({
    name: "test-file isolation accepts a non-test database user",
    from: "decodeURIComponent(parsed.username) !== \"mbt_test\"",
    to: "false"
  }),
  Object.freeze({
    name: "test-file isolation accepts a non-test base database",
    from: "databaseName !== BASE_DATABASE_NAME",
    to: "false"
  }),
  Object.freeze({
    name: "test-file isolation accepts a negative clone index",
    from: "if (!Number.isSafeInteger(index) || index < 0) {",
    to: "if (false) {"
  }),
  Object.freeze({
    name: "test-file isolation accepts an arbitrary clone target",
    from: `export function isolatedTestDatabaseUrl(databaseUrl, databaseName) {
  const parsed = parseDisposableDatabaseUrl(databaseUrl);
  if (!CLONE_DATABASE_PATTERN.test(databaseName) || databaseName.length > 63) {`,
    to: `export function isolatedTestDatabaseUrl(databaseUrl, databaseName) {
  const parsed = parseDisposableDatabaseUrl(databaseUrl);
  if (false) {`
  }),
  Object.freeze({
    name: "test-file isolation creates an empty database instead of a pristine clone",
    from: "`CREATE DATABASE ${quoteCloneDatabase(databaseName)} TEMPLATE ${quoteBaseDatabase()}`",
    to: "`CREATE DATABASE ${quoteCloneDatabase(databaseName)}`"
  }),
  Object.freeze({
    name: "test-file isolation drops clones without the force boundary",
    from: "`DROP DATABASE IF EXISTS ${quoteCloneDatabase(databaseName)} WITH (FORCE)`",
    to: "`DROP DATABASE IF EXISTS ${quoteCloneDatabase(databaseName)}`"
  }),
  Object.freeze({
    name: "test-file isolation no longer terminates template connections before cloning",
    from: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
    to: "SELECT pg_cancel_backend(pid) FROM pg_stat_activity"
  }),
  Object.freeze({
    name: "test-file isolation omits unconditional clone cleanup",
    from: `} finally {
        await dropCloneDatabase(admin, databaseName);
      }`,
    to: `} finally {
        // Mutant: leak the disposable clone.
      }`
  }),
  Object.freeze({
    name: "test-file isolation enables in-file test concurrency",
    from: "\"--test-concurrency=1\"",
    to: "\"--test-concurrency=2\""
  }),
  Object.freeze({
    name: "test-file isolation reuses one clone name for every file",
    from: "const databaseName = isolatedTestDatabaseName(runId, index);",
    to: "const databaseName = isolatedTestDatabaseName(runId, 0);"
  }),
  Object.freeze({
    name: "test-file isolation runs child tests against the shared base database",
    from: "DATABASE_URL: isolatedTestDatabaseUrl(databaseUrl, databaseName)",
    to: "DATABASE_URL: databaseUrl"
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

/** @param {string} contractTest */
function runContract(contractTest) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      contractTest
    ], { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Isolation mutation detector exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Test-database isolation mutations require the writable disposable MBT test container.");
}

const temporaryDirectory = await mkdtemp("/app/data/mbt-isolation-mutation-");
const target = path.join(temporaryDirectory, "test-database-isolation.mjs");
const contractTest = path.join(temporaryDirectory, "test-database-isolation.test.mjs");
const original = await readFile(SOURCE, "utf8");
const originalHash = sha256(original);
let killed = 0;
try {
  const contractSource = await readFile(CONTRACT_SOURCE, "utf8");
  const importNeedle = "../../support/test-database-isolation.mjs";
  if (occurrenceCount(contractSource, importNeedle) !== 2) {
    throw new Error("The isolation mutation contract import is ambiguous.");
  }
  await writeFile(
    contractTest,
    contractSource.replaceAll(importNeedle, "./test-database-isolation.mjs"),
    "utf8"
  );
  await writeFile(target, original, "utf8");
  for (const mutant of MUTANTS) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    try {
      await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
      if (await runContract(contractTest) === 0) {
        throw new Error(`${mutant.name}: survived the test-database isolation contract.`);
      }
      killed += 1;
      console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    } finally {
      await writeFile(target, original, "utf8");
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

if (sha256(await readFile(SOURCE)) !== originalHash) {
  throw new Error("Test-database isolation mutation testing did not restore its source exactly.");
}
if (killed !== MUTANTS.length) {
  throw new Error(`Test-database isolation mutation score ${killed}/${MUTANTS.length}; all mutants must be killed.`);
}
console.log(
  `Test-database isolation mutation score ${killed}/${MUTANTS.length}; source restored ${originalHash}.`
);
