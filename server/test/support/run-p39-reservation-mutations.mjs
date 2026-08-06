// @ts-check

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const TARGETS = Object.freeze({
  asset: fileURLToPath(new URL("../../src/mbt/asset-service.js", import.meta.url)),
  dispatch: fileURLToPath(new URL("../../src/mbt/bin-dispatch-service.js", import.meta.url))
});
const TEST_DATABASE_PREFIX = "mbt_p39_res_mut_";
const SCENARIO_TESTS = Object.freeze([
  "test/mbt/integration/driver-bin-reservation-hardening.test.js",
  "test/mbt/integration/driver-bin-loaded-exchange.test.js"
]);

/** @type {ReadonlyArray<{name: string, target: "asset" | "dispatch", from: string, to: string}>} */
const MUTANTS = Object.freeze([
  {
    name: "exact holds are replaced by legacy state transitions",
    target: "dispatch",
    from: "return assignments.length > 1 || customerLocated ? \"exact_hold\" : \"state_transition\";",
    to: "return \"state_transition\";"
  },
  {
    name: "one asset in a multi-slot exchange is not reserved",
    target: "dispatch",
    from: "for (const assetAssignment of assetAssignments) {",
    to: "for (const assetAssignment of assetAssignments.slice(0, 1)) {"
  },
  {
    name: "the exact server-owned visit asset comparison is inverted",
    target: "asset",
    from: "if (!expectedAssetId || expectedAssetId !== String(input.assetId)) {",
    to: "if (!expectedAssetId || expectedAssetId === String(input.assetId)) {"
  },
  {
    name: "the customer-site identity comparison is skipped",
    target: "asset",
    from: "if (customerLocated\n      && String(state.customer_site_profile_id || \"\")",
    to: "if (false && customerLocated\n      && String(state.customer_site_profile_id || \"\")"
  },
  {
    name: "the append-only reservation movement loses its visit attribution",
    target: "asset",
    from: "visitId: reservation.visitId,",
    to: "visitId: null,"
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
    throw new Error(`Unsafe P3.9 reservation mutation database name: ${name}`);
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
  throw new Error("P3.9 reservation mutation tests require an explicitly ephemeral MBT test environment.");
}
const adminUrlText = String(process.env.MBT_P39_MUTATION_ADMIN_URL || "").trim();
if (!adminUrlText) {
  throw new Error("MBT_P39_MUTATION_ADMIN_URL is required.");
}
const adminUrl = new URL(adminUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("The P3.9 reservation mutation admin URL must use PostgreSQL.");
}
adminUrl.pathname = "/postgres";

const original = Object.fromEntries(await Promise.all(
  Object.entries(TARGETS).map(async ([name, path]) => [name, await readFile(path, "utf8")])
));
const originalHashes = Object.fromEntries(
  Object.entries(original).map(([name, source]) => [name, sha256(source)])
);
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
let killed = 0;
try {
  for (const [index, mutant] of MUTANTS.entries()) {
    const targetPath = TARGETS[mutant.target];
    const targetSource = original[mutant.target];
    if (!targetPath || occurrenceCount(targetSource, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}_${index}_${randomBytes(3).toString("hex")}`;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    try {
      await writeFile(targetPath, targetSource.replace(mutant.from, mutant.to), "utf8");
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
        "--test-name-pattern=loaded pickup|exchange reserves|customer-located",
        ...SCENARIO_TESTS
      ], env);
      if (testExit === 0) {
        throw new Error(`${mutant.name}: survived the P3.9 reservation scenario suite.`);
      }
      killed += 1;
    } finally {
      await writeFile(targetPath, targetSource, "utf8");
      await dropTestDatabase(admin, databaseName);
    }
  }
} finally {
  await Promise.all(Object.entries(TARGETS).map(
    ([name, path]) => writeFile(path, original[name], "utf8")
  ));
  await admin.end();
}

for (const [name, path] of Object.entries(TARGETS)) {
  const restored = await readFile(path, "utf8");
  if (sha256(restored) !== originalHashes[name]) {
    throw new Error(`P3.9 reservation mutation testing did not restore ${name} exactly.`);
  }
}
if (killed !== MUTANTS.length) {
  throw new Error(`P3.9 reservation mutation score ${killed}/${MUTANTS.length}; all mutants must be killed.`);
}
console.log(
  `P3.9 reservation mutation score ${killed}/${MUTANTS.length}; `
  + `source restored asset=${originalHashes.asset} dispatch=${originalHashes.dispatch}.`
);
