// @ts-check

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

const TEST_DATABASE_PREFIX = "mbt_p39_mut_";
const EXECUTION = "src/mbt/driver-bin-execution-service.js";

const MUTANTS = Object.freeze([
  {
    name: "dump receipt cents no longer balance",
    path: "src/mbt/driver-bin-contract.js",
    from: "if (subtotalMinor + taxMinor !== totalMinor) {invalid(\"The dump receipt total must equal subtotal plus tax.\");}",
    to: "if (subtotalMinor + taxMinor === totalMinor) {invalid(\"The dump receipt total must equal subtotal plus tax.\");}",
    tests: ["test/mbt/property/driver-bin-event.property.test.js"]
  },
  {
    name: "a current frozen execution snapshot is rejected",
    path: EXECUTION,
    from: "if (String(mbt.executionSnapshotHash || \"\") !== currentHash) {",
    to: "if (String(mbt.executionSnapshotHash || \"\") === currentHash) {",
    tests: ["test/mbt/integration/driver-bin-execution.test.js"]
  },
  {
    name: "exact BIN scan verification is bypassed",
    path: EXECUTION,
    from: "if (String(scan.assetId) !== String(expected.assetId) || !accepted.has(value)) {",
    to: "if (false && (String(scan.assetId) !== String(expected.assetId) || !accepted.has(value))) {",
    tests: ["test/mbt/integration/driver-bin-execution.test.js"]
  },
  {
    name: "an uploaded-but-not-durable photo satisfies a requirement",
    path: EXECUTION,
    from: ".filter((/** @type {Record<string, any>} */ photo) => photo.objectReference && references.has(photo.objectReference))",
    to: ".filter((/** @type {Record<string, any>} */ photo) => photo.objectReference)",
    tests: ["test/mbt/integration/driver-bin-loaded-exchange.test.js"]
  },
  {
    name: "post-movement rollback injection is skipped",
    path: EXECUTION,
    from: "await invokeCompletionHook(hooks, \"afterMovements\", { executionContext, evidenceIds, receipt, movements });",
    to: "if (false) await invokeCompletionHook(hooks, \"afterMovements\", { executionContext, evidenceIds, receipt, movements });",
    tests: ["test/mbt/integration/driver-bin-execution.test.js"]
  },
  {
    name: "an exchange may collapse outgoing and incoming onto one BIN",
    path: EXECUTION,
    from: "if (!outgoing || !incoming || String(outgoing.assetId) === String(incoming.assetId)) {",
    to: "if (!outgoing || !incoming) {",
    tests: ["test/mbt/integration/driver-bin-loaded-exchange.test.js"]
  },
  {
    name: "a later physical stop may skip an earlier blocking step",
    path: EXECUTION,
    from: "Number(candidate.sequence_number) < Number(step.sequence_number)",
    to: "Number(candidate.sequence_number) > Number(step.sequence_number)",
    tests: ["test/mbt/integration/driver-bin-loaded-exchange.test.js"]
  },
  {
    name: "offline completion identity is no longer transaction-locked",
    path: EXECUTION,
    from: "\"SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))\"",
    to: "\"SELECT $1::text, $2::text\"",
    tests: ["test/mbt/concurrency/driver-bin-sync-races.test.js"]
  },
  {
    name: "server receipt time replaces the device occurrence timestamp",
    path: EXECUTION,
    from: "normalized.immutablePayloadHash, normalized.occurredAt,\n      normalized.receivedAt, appliedAt, JSON.stringify(body)",
    to: "normalized.immutablePayloadHash, normalized.receivedAt,\n      normalized.receivedAt, appliedAt, JSON.stringify(body)",
    tests: ["test/mbt/integration/driver-bin-execution.test.js"]
  },
  {
    name: "the database rejects the allowed five-minute device clock lead",
    path: "migrations/120_mbt_p3_driver_clock_evidence.sql",
    from: "device_occurred_at <= server_received_at + interval '5 minutes'",
    to: "device_occurred_at <= server_received_at + interval '0 minutes'",
    tests: ["test/mbt/integration/driver-bin-time-evidence.test.js"]
  },
  {
    name: "required signature photos disappear from the offline upload budget",
    path: EXECUTION,
    from: "&& [\"photo\", \"signature\"].includes(requirement.evidenceType)",
    to: "&& requirement.evidenceType === \"photo\"",
    tests: ["test/mbt/integration/driver-bin-signature-photo.test.js"]
  },
  {
    name: "whole-route order ignores earlier manifest jobs",
    path: EXECUTION,
    from: "const earlier = context.jobs.slice(0, context.currentIndex);",
    to: "const earlier = [];",
    tests: ["test/mbt/integration/driver-bin-manifest-integrity.test.js"]
  },
  {
    name: "durable BIN start is not required before completion",
    path: EXECUTION,
    from: "if (!started.rowCount) {",
    to: "if (false && !started.rowCount) {",
    tests: ["test/mbt/integration/driver-bin-manifest-integrity.test.js"]
  },
  {
    name: "pre-manifest occurrence time is accepted",
    path: EXECUTION,
    from: "if (normalized.occurredAt < manifestContext.generatedAt) {",
    to: "if (false && normalized.occurredAt < manifestContext.generatedAt) {",
    tests: ["test/mbt/integration/driver-bin-manifest-integrity.test.js"]
  },
  {
    name: "stale asset occurrence time may regress the movement timeline",
    path: EXECUTION,
    from: "timestamp(state.changed_at, \"asset state change time\") > normalized.occurredAt",
    to: "false && timestamp(state.changed_at, \"asset state change time\") > normalized.occurredAt",
    tests: ["test/mbt/integration/driver-bin-manifest-integrity.test.js"]
  },
  {
    name: "template before-state validation is skipped",
    path: EXECUTION,
    from: "beforeStatuses: templateBefore ? [templateBefore] : defaultBeforeStatuses(actionCode),",
    to: "beforeStatuses: [],",
    tests: ["test/mbt/integration/driver-bin-template-state-guard.test.js"]
  },
  {
    name: "template after-state contradiction is ignored",
    path: EXECUTION,
    from: "if (!templateAfter || templateAfter === derivedAfter) {return;}",
    to: "if (true || !templateAfter || templateAfter === derivedAfter) {return;}",
    tests: ["test/mbt/integration/driver-bin-template-state-guard.test.js"]
  },
  {
    name: "exact frozen location identity is not compared",
    path: EXECUTION,
    from: "&& actualIdentity !== String(expectedLocation.identity);",
    to: "&& false;",
    tests: ["test/mbt/integration/driver-bin-template-state-guard.test.js"]
  },
  {
    name: "active dump acceptance is not required at application time",
    path: EXECUTION,
    from: "if (!acceptance.rowCount) {",
    to: "if (false && !acceptance.rowCount) {",
    tests: ["test/mbt/integration/driver-bin-manifest-integrity.test.js"]
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
    throw new Error(`Unsafe P3.9 mutation database name: ${name}`);
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
  throw new Error("P3.9 mutation tests require an explicitly ephemeral MBT test environment.");
}
const adminUrlText = String(process.env.MBT_P39_MUTATION_ADMIN_URL || "").trim();
if (!adminUrlText) {
  throw new Error("MBT_P39_MUTATION_ADMIN_URL is required.");
}
const adminUrl = new URL(adminUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("The P3.9 mutation admin URL must use PostgreSQL.");
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
      throw new Error(`${mutant.name}: expected exactly one mutation target in ${mutant.path}.`);
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
        throw new Error(`${mutant.name}: survived its P3.9 target suite.`);
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
    throw new Error(`P3.9 mutation testing did not restore ${path.relative(process.cwd(), target)} exactly.`);
  }
}
if (killed !== MUTANTS.length) {
  throw new Error(`P3.9 mutation score ${killed}/${MUTANTS.length}; all mutants must be killed.`);
}
console.log(`P3.9 mutation score ${killed}/${MUTANTS.length}; all target sources restored.`);
