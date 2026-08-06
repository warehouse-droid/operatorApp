// @ts-check

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const TARGET = fileURLToPath(new URL("../../src/mbt/bin-dispatch-service.js", import.meta.url));
const TEST_DATABASE_PREFIX = "mbt_p38_mut_";

const MUTANTS = Object.freeze([
  {
    name: "future-only search leaks the current front leg",
    from: "if (!search || searchable.includes(search)) {items.push(card);}",
    to: "if (!search || true) {items.push(card);}",
    tests: ["test/mbt/integration/bin-contract-front-leg.test.js"]
  },
  {
    name: "BIN truck compatibility comparison is inverted",
    from: "String(row.truck_type) !== \"bin\"",
    to: "String(row.truck_type) === \"bin\"",
    tests: ["test/mbt/integration/bin-dispatch-enabled.test.js"]
  },
  {
    name: "exact BIN asset comparison is inverted",
    from: "String(assignment.assetId || \"\") === required.assetId",
    to: "String(assignment.assetId || \"\") !== required.assetId",
    tests: ["test/mbt/integration/bin-dispatch-enabled.test.js"]
  },
  {
    name: "post-reservation failure injection is skipped",
    from: "if (typeof hooks.afterReservation === \"function\") {await hooks.afterReservation();}",
    to: "if (false && typeof hooks.afterReservation === \"function\") {await hooks.afterReservation();}",
    tests: ["test/mbt/integration/bin-dispatch-enabled.test.js"]
  },
  {
    name: "whole-leg stop identity comparison is inverted",
    from: "JSON.stringify(normalized.stopIds) !== JSON.stringify(expectedIds)",
    to: "JSON.stringify(normalized.stopIds) === JSON.stringify(expectedIds)",
    tests: ["test/mbt/integration/bin-dispatch-enabled.test.js"]
  },
  {
    name: "successor tentative-state eligibility is inverted",
    from: "String(next.status) !== \"tentative\"",
    to: "String(next.status) === \"tentative\"",
    tests: ["test/mbt/concurrency/bin-leg-advancement-races.test.js"]
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} env */
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/** @param {string} name */
function quotedDatabase(name) {
  if (!new RegExp(`^${TEST_DATABASE_PREFIX}[a-z0-9_]+$`, "u").test(name)) {
    throw new Error(`Unsafe P3.8 mutation database name: ${name}`);
  }
  return `"${name}"`;
}

/** @param {Client} admin @param {string} name */
async function dropTestDatabase(admin, name) {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()`,
    [name]
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase(name)}`);
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("P3.8 mutation tests require an explicitly ephemeral MBT test environment.");
}
const adminUrlText = String(process.env.MBT_P38_MUTATION_ADMIN_URL || "").trim();
if (!adminUrlText) {
  throw new Error("MBT_P38_MUTATION_ADMIN_URL is required.");
}
const adminUrl = new URL(adminUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("The P3.8 mutation admin URL must use PostgreSQL.");
}
adminUrl.pathname = "/postgres";

const original = await readFile(TARGET, "utf8");
const originalHash = sha256(original);
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
let killed = 0;
try {
  for (const [index, mutant] of MUTANTS.entries()) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}_${index}_${randomBytes(3).toString("hex")}`;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    try {
      await writeFile(TARGET, original.replace(mutant.from, mutant.to), "utf8");
      const env = {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        MBBS_ENV_FILE: ".env.mbt-test-does-not-exist"
      };
      const migrationExit = await run(process.execPath, ["src/migrate.js"], env);
      if (migrationExit !== 0) {
        throw new Error(`${mutant.name}: isolated migration failed.`);
      }
      const testExit = await run(process.execPath, [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        ...mutant.tests
      ], env);
      if (testExit === 0) {
        throw new Error(`${mutant.name}: survived its P3.8 target suite.`);
      }
      killed += 1;
    } finally {
      await writeFile(TARGET, original, "utf8");
      await dropTestDatabase(admin, databaseName);
    }
  }
} finally {
  await writeFile(TARGET, original, "utf8");
  await admin.end();
}

const restored = await readFile(TARGET, "utf8");
if (sha256(restored) !== originalHash) {
  throw new Error("P3.8 mutation testing did not restore the target source exactly.");
}
if (killed !== MUTANTS.length) {
  throw new Error(`P3.8 mutation score ${killed}/${MUTANTS.length}; all mutants must be killed.`);
}
console.log(`P3.8 mutation score ${killed}/${MUTANTS.length}; source restored ${originalHash}.`);
