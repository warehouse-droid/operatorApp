// @ts-check

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

const TEST_DATABASE_PREFIX = "mbt_p311_mut_";
const VERTICAL_TEST = "test/mbt/integration/p3-local-pilot-end-to-end.test.js";
const SNAPSHOT_TEST = "test/mbt/adversarial/p311-completed-load-snapshot-integrity.test.js";
const CONFIRMATION_TEST = "test/mbt/integration/bin-dispatch-confirmation.test.js";
const BIN_HARDENING_TEST = "test/mbt/integration/bin-dispatch-hardening.test.js";
const HTTP_CONFIRMATION_TEST = "test/mbt/integration/bin-dispatch-confirmation-http.test.js";
const CONFIRMATION_RACE_TEST = "test/mbt/concurrency/bin-dispatch-confirmation-races.test.js";
const DISABLED_DISPATCH_TEST = "test/mbt/integration/dispatch-bin-disabled.test.js";
const DISPATCH_SAFETY_TEST = "test/mbt/unit/dispatch-bin-safety.test.js";
const CONFIRMATION_WIRING_TEST = "test/mbt/unit/bin-dispatch-confirm-wiring.test.js";
const ASSIGNMENT_SCAN_TEST = "test/mbt/integration/dispatch-assignment-bin-scan.test.js";
const BIN_DISPATCH = "src/mbt/bin-dispatch-service.js";
const SHADOW_BILLING = "src/mbt/shadow-billing-service.js";
const DISPATCH_REPOSITORY = "src/dispatch-plan-repository.js";
const DRIVER_REPOSITORY = "src/driver-repository.js";
const SERVER = "src/server.js";
const FROZEN_TEST_HASHES = Object.freeze({
  [VERTICAL_TEST]: "8b364021ec36ca853a41e806457ba4cfdf2d7482c9d008bc47b2fa5b0a92435c",
  [SNAPSHOT_TEST]: "c436c4866fab19e2689afb8063447235f0d401f008e8e262dbfc53fd052e6e9f",
  [CONFIRMATION_TEST]: "3d83082e3167014e56e3c8ce06c6ab2e7412f40276e87268447129c306953bdb",
  [BIN_HARDENING_TEST]: "c46451dfeb69d2b9c30647fa0bd49ac25b9628216474d990c2d37f3a57fb0a4c",
  [HTTP_CONFIRMATION_TEST]: "e88f4a2235e7d593e06e150153890cc33254f004b723f55385cc43860eac742f",
  [CONFIRMATION_RACE_TEST]: "8d07f5ef78a5ffc678eafb15a52de1d77e550803a8077ea34ac32e51a9cd2eae",
  [DISABLED_DISPATCH_TEST]: "3535c690cfa2615b20ea8bc40007ed9a82957efae789712bc69209c95e3577eb",
  [DISPATCH_SAFETY_TEST]: "ba7a3292dc55b428c9620960d33afff65c0379d55d3412b0492efd81ea1548d7",
  [CONFIRMATION_WIRING_TEST]: "a607b44a36a87b50003478e9a8ca12cc5b6450cb0a4630cf865963f111f71b02",
  [ASSIGNMENT_SCAN_TEST]: "9204888172d04a252c9e7ff8cdeca8d69798a03ebbc6592acfd9fe954c9a7364"
});

const MUTANTS = Object.freeze([
  {
    name: "scheduled completion replaces the actual Driver completion basis",
    path: BIN_DISPATCH,
    from: "const completedAt = new Date(completed.actual_completed_at);",
    to: "const completedAt = new Date(completed.scheduled_end_at);",
    tests: [VERTICAL_TEST]
  },
  {
    name: "the accepted rental-calendar interval is dropped",
    path: BIN_DISPATCH,
    from: "const start = new Date(completedAt.getTime() + rentalCalendarDays * 24 * 60 * 60 * 1000);",
    to: "const start = new Date(completedAt.getTime());",
    tests: [VERTICAL_TEST]
  },
  {
    name: "the accepted return-window duration is not preserved",
    path: BIN_DISPATCH,
    from: "return { start, end: new Date(start.getTime() + priorDurationMs) };",
    to: "return { start, end: priorEnd };",
    tests: [VERTICAL_TEST]
  },
  {
    name: "the established scheduled successor window is rejected when actual completion is absent",
    path: BIN_DISPATCH,
    from: "if (!completed.actual_completed_at) {return { start: priorStart, end: priorEnd };}",
    to: "if (!completed.actual_completed_at) {throw new Error(\"mutant: scheduled fallback deleted\");}",
    tests: [BIN_HARDENING_TEST]
  },
  {
    name: "a completed-load snapshot source hash is ignored",
    path: SHADOW_BILLING,
    from: "const snapshotMatches = canonicalSha256(sourceSnapshot) === String(row.source_snapshot_hash)\n    && sourceSnapshot.completed === true",
    to: "const snapshotMatches = sourceSnapshot.completed === true",
    tests: [SNAPSHOT_TEST]
  },
  {
    name: "an independent completed-load command bypasses the durable dedupe authority",
    path: SHADOW_BILLING,
    from: "WHERE cross_charge.deduplication_key = $1`,",
    to: "WHERE false AND cross_charge.deduplication_key = $1`,",
    tests: [VERTICAL_TEST]
  },
  {
    name: "local-only MBBS generation invokes an external transport",
    path: SHADOW_BILLING,
    from: "const hooks = dependencies.hooks || {};\n  const payload = { ...normalized, reason };",
    to: "if (typeof dependencies.transport === \"function\") {await dependencies.transport();}\n  const hooks = dependencies.hooks || {};\n  const payload = { ...normalized, reason };",
    tests: [VERTICAL_TEST]
  },
  {
    name: "a missing or duplicated exact Driver pilot scope is accepted",
    path: BIN_DISPATCH,
    from: "if (matching.length !== 1 || String(visit.planned_driver_id || \"\") !== truck.driverId) {",
    to: "if (false || String(visit.planned_driver_id || \"\") !== truck.driverId) {",
    tests: [CONFIRMATION_TEST]
  },
  {
    name: "a physically moved BIN asset is accepted from stale reservation evidence",
    path: BIN_DISPATCH,
    from: "&& reservationStateMatches(visit, assigned.length, row)",
    to: "&& true",
    tests: [CONFIRMATION_TEST]
  },
  {
    name: "aggregate BIN slot and configured weight capacity are ignored",
    path: BIN_DISPATCH,
    from: "if (aggregate.groups > aggregate.slotCapacity\n        || aggregate.requiredWeightLbs > aggregate.capacityLbs) {",
    to: "if (false) {",
    tests: [CONFIRMATION_TEST]
  },
  {
    name: "the locked visit may drift to another Toronto plan date",
    path: BIN_DISPATCH,
    from: "if (String(visit.scheduled_plan_date || \"\") !== String(plan.planDate)) {",
    to: "if (false) {",
    tests: [CONFIRMATION_TEST]
  },
  {
    name: "current dump-site material rejection is ignored",
    path: BIN_DISPATCH,
    from: "|| current.accepted !== true) {",
    to: "|| false) {",
    tests: [CONFIRMATION_TEST]
  },
  {
    name: "a caller-tampered mandatory stop group bypasses canonical equality",
    path: BIN_DISPATCH,
    from: "|| !sameCanonicalValue(arrayValue(assignment.stops), group.stops)) {",
    to: "|| false) {",
    tests: [CONFIRMATION_TEST]
  },
  {
    name: "the repository confirmation seam skips its locked BIN validator",
    path: DISPATCH_REPOSITORY,
    from: "await binBoundary.validate({",
    to: "await Promise.resolve({",
    tests: [CONFIRMATION_TEST]
  },
  {
    name: "the HTTP Confirm comparison treats browser-derived MBT timing as authoritative",
    path: SERVER,
    from: "delete stop.timing;",
    to: "void stop.timing;",
    tests: [HTTP_CONFIRMATION_TEST, CONFIRMATION_WIRING_TEST]
  },
  {
    name: "the multi-driver materializer defaults to enabling BIN jobs",
    path: DRIVER_REPOSITORY,
    from: "export function planJobsForDrivers(plan, driverLogins = [], { allowBin = false } = {}) {",
    to: "export function planJobsForDrivers(plan, driverLogins = [], { allowBin = true } = {}) {",
    tests: [DISPATCH_SAFETY_TEST, ASSIGNMENT_SCAN_TEST]
  },
  {
    name: "the default repository confirmation path omits the BIN fail-closed guard",
    path: DISPATCH_REPOSITORY,
    from: "assertBinDispatchCapability(currentPlan, { operation: \"confirm\" });",
    to: "void currentPlan;",
    tests: [DISABLED_DISPATCH_TEST]
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
    throw new Error(`Unsafe P3.11 mutation database name: ${name}`);
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
  throw new Error("P3.11 mutations require an explicitly ephemeral MBT test environment.");
}
const adminUrlText = String(process.env.MBT_P311_MUTATION_ADMIN_URL || "").trim();
if (!adminUrlText) {
  throw new Error("MBT_P311_MUTATION_ADMIN_URL is required.");
}
const adminUrl = new URL(adminUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("The P3.11 mutation admin URL must use PostgreSQL.");
}
adminUrl.pathname = "/postgres";

for (const [testPath, expectedHash] of Object.entries(FROZEN_TEST_HASHES)) {
  const actualHash = sha256(await readFile(path.resolve(testPath)));
  if (actualHash !== expectedHash) {
    throw new Error(`Frozen P3.11 detector changed: ${testPath} (${actualHash}).`);
  }
}

const originals = new Map();
for (const mutant of MUTANTS) {
  const target = path.resolve(mutant.path);
  if (!originals.has(target)) {originals.set(target, await readFile(target, "utf8"));}
}
const sourceHashes = new Map([...originals].map(([target, source]) => [target, sha256(source)]));
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
        throw new Error(`${mutant.name}: survived its P3.11 target suite.`);
      }
      killed += 1;
      console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    } finally {
      await writeFile(target, original, "utf8");
      await dropTestDatabase(admin, databaseName);
    }
  }
} finally {
  for (const [target, original] of originals) {await writeFile(target, original, "utf8");}
  await admin.end();
}

for (const [target, expectedHash] of sourceHashes) {
  if (sha256(await readFile(target)) !== expectedHash) {
    throw new Error(`P3.11 mutations did not restore ${path.relative(process.cwd(), target)}.`);
  }
}
if (killed !== MUTANTS.length) {
  throw new Error(`P3.11 mutation score ${killed}/${MUTANTS.length}.`);
}
console.log(`P3.11 mutation score ${killed}/${MUTANTS.length}; frozen detectors and all sources restored.`);
