// @ts-check

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

const TEST_DATABASE_PREFIX = "mbt_p310_recon_mut_";
const SERVICE = "src/mbt/pilot-reconciliation-service.js";

const MUTANTS = Object.freeze([
  {
    name: "a non-billing actor can append comparison evidence",
    path: SERVICE,
    from: "if (!roles.includes(\"admin\") && !roles.includes(\"mbt_billing\")) {",
    to: "if (false && !roles.includes(\"admin\") && !roles.includes(\"mbt_billing\")) {",
    tests: ["test/mbt/integration/pilot-reconciliation-hardening.test.js"]
  },
  {
    name: "a numeric string is accepted as raw distance evidence",
    path: SERVICE,
    from: "if (typeof value !== \"number\" || !Number.isSafeInteger(value) || value < minimum) {",
    to: "if (!Number.isSafeInteger(Number(value)) || Number(value) < minimum) {",
    tests: ["test/mbt/integration/pilot-reconciliation-hardening.test.js"]
  },
  {
    name: "the exact distance audit threshold requires a note",
    path: SERVICE,
    from: "requiresAuditNote: distanceDeltaMetres > distanceAuditThresholdMetres,",
    to: "requiresAuditNote: distanceDeltaMetres >= distanceAuditThresholdMetres,",
    tests: ["test/mbt/integration/pilot-reconciliation-hardening.test.js"]
  },
  {
    name: "exact application/manual evidence is reported as a variance",
    path: SERVICE,
    from: "if (!equalEvidence(application[applicationField], manual[manualField])) {",
    to: "if (equalEvidence(application[applicationField], manual[manualField])) {",
    tests: ["test/mbt/integration/pilot-reconciliation.test.js"]
  },
  {
    name: "an empty correction reference is accepted",
    path: SERVICE,
    from: "if (keys.length !== 2 || keys[0] !== \"entityId\" || keys[1] !== \"kind\") {",
    to: "if (false && (keys.length !== 2 || keys[0] !== \"entityId\" || keys[1] !== \"kind\")) {",
    tests: ["test/mbt/integration/pilot-reconciliation-hardening.test.js"]
  },
  {
    name: "same-kind reconciliation rows return in random UUID order",
    path: SERVICE,
    from: "reconciliation_row.application_evidence_id,\n               reconciliation_row.manual_reference,\n               reconciliation_row.reconciliation_row_id",
    to: "reconciliation_row.application_evidence_id,\n               reconciliation_row.reconciliation_row_id",
    tests: ["test/mbt/integration/pilot-reconciliation-hardening.test.js"]
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
    throw new Error(`Unsafe P3.10 reconciliation mutation database name: ${name}`);
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
  throw new Error("P3.10 reconciliation mutations require an explicitly ephemeral MBT test environment.");
}
const adminUrlText = String(process.env.MBT_P310_MUTATION_ADMIN_URL || "").trim();
if (!adminUrlText) {
  throw new Error("MBT_P310_MUTATION_ADMIN_URL is required.");
}
const adminUrl = new URL(adminUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("The P3.10 reconciliation mutation admin URL must use PostgreSQL.");
}
adminUrl.pathname = "/postgres";

const originals = new Map();
for (const mutant of MUTANTS) {
  const target = path.resolve(mutant.path);
  if (!originals.has(target)) {
    originals.set(target, await readFile(target, "utf8"));
  }
}
const hashes = new Map([...originals].map(([target, source]) => [target, sha256(source)]));
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
let killed = 0;
try {
  for (const [index, mutant] of MUTANTS.entries()) {
    const target = path.resolve(mutant.path);
    const original = originals.get(target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one target in ${mutant.path}.`);
    }
    const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}_${index}_${randomBytes(3).toString("hex")}`;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    try {
      await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
      const env = {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        MBBS_ENV_FILE: ".env.mbt-test-does-not-exist"
      };
      if (await run(process.execPath, ["src/migrate.js"], env) !== 0) {
        throw new Error(`${mutant.name}: isolated migration failed.`);
      }
      if (await run(process.execPath, [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        ...mutant.tests
      ], env) === 0) {
        throw new Error(`${mutant.name}: survived its P3.10 reconciliation suite.`);
      }
      killed += 1;
      console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    } finally {
      await writeFile(target, original, "utf8");
      await dropTestDatabase(admin, databaseName);
    }
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(target, original, "utf8");
  }
  await admin.end();
}

for (const [target, expectedHash] of hashes) {
  if (sha256(await readFile(target)) !== expectedHash) {
    throw new Error(`P3.10 reconciliation mutations did not restore ${path.relative(process.cwd(), target)}.`);
  }
}
if (killed !== MUTANTS.length) {
  throw new Error(`P3.10 reconciliation mutation score ${killed}/${MUTANTS.length}.`);
}
console.log(`P3.10 reconciliation mutation score ${killed}/${MUTANTS.length}; all sources restored.`);
