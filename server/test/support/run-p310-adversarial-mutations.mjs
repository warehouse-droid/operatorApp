// @ts-check

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

const TEST_DATABASE_PREFIX = "mbt_p310_adv_mut_";
const SERVICE = "src/mbt/shadow-billing-service.js";
const CALCULATOR = "src/mbt/local-billing-calculator.js";
const TEST = "test/mbt/adversarial/shadow-billing-adversarial.test.js";
const SNAPSHOT_TEST = "test/mbt/adversarial/shadow-billing-snapshot-boundary-adversarial.test.js";

const MUTANTS = Object.freeze([
  {
    name: "a non-billing role may execute shadow billing",
    path: SERVICE,
    from: "if (!roles.includes(\"admin\") && !roles.includes(\"mbt_billing\")) {",
    to: "if (false && !roles.includes(\"admin\") && !roles.includes(\"mbt_billing\")) {",
    pattern: "every shadow-billing mutation rejects"
  },
  {
    name: "a billing case may consume another same-contract visit",
    path: SERVICE,
    from: "if (String(billingCase.service_visit_id) !== visitId) {",
    to: "if (false && String(billingCase.service_visit_id) !== visitId) {",
    pattern: "cannot consume another visit"
  },
  {
    name: "a ready visit may be billed before durable completion",
    path: SERVICE,
    from: "if (String(visit.status) !== \"completed\" || !visit.actual_completed_at) {",
    to: "if (false && (String(visit.status) !== \"completed\" || !visit.actual_completed_at)) {",
    pattern: "pre-completion billing"
  },
  {
    name: "pure calculation ignores rate-component currency drift",
    path: CALCULATOR,
    from: "if (component.currency !== undefined && currency(component.currency) !== expectedCurrency) {",
    to: "if (false && component.currency !== undefined && currency(component.currency) !== expectedCurrency) {",
    pattern: "configured rate component must match"
  },
  {
    name: "billing ignores an audited distance-metres override",
    path: SERVICE,
    from: "rawMetres: Number(distance.override_metres ?? distance.provider_metres),",
    to: "rawMetres: Number(distance.provider_metres),",
    pattern: "audited distance override"
  },
  {
    name: "dump billing loses the receipt-photo content hash",
    path: SERVICE,
    from: "contentSha256: String(receipt.photo_content_sha256),",
    to: "contentSha256: \"\",",
    pattern: "dump billing freezes"
  },
  {
    name: "cross-charge generation permits an absent rate band",
    path: SERVICE,
    from: "rateDistanceBandId: uuid(input.rateDistanceBandId, \"Rate distance-band ID\"),",
    to: "rateDistanceBandId: input.rateDistanceBandId,",
    pattern: "requires a band"
  },
  {
    name: "cross-charge dedupe ignores changed immutable source snapshots",
    path: SERVICE,
    from: "const evidenceMatches = evidencePairs.every(\n    ([actual, expected]) => canonicalSha256(actual) === canonicalSha256(expected)\n  );",
    to: "const evidenceMatches = true;",
    pattern: "dedupe key rejects changed source evidence"
  },
  {
    name: "an unknown component quantity silently disappears",
    path: SERVICE,
    from: "if (unknownCode) {",
    to: "if (false && unknownCode) {",
    pattern: "unknown component quantity keys"
  },
  {
    name: "approval ignores a missing zero-value line",
    path: SERVICE,
    from: "&& Number(complete.line_count) === expectedLineCount",
    to: "&& Number(complete.line_count) > 0",
    pattern: "approval compares line identities"
  },
  {
    name: "the version schema rejects valid signed discount tax",
    sql: `ALTER TABLE mbt_billing_versions
            DROP CONSTRAINT mbt_billing_versions_amounts_nonnegative;
          ALTER TABLE mbt_billing_versions
            ADD CONSTRAINT mbt_billing_versions_amounts_nonnegative
            CHECK (subtotal_minor >= 0 AND estimated_tax_minor >= 0 AND total_minor >= 0) NOT VALID;`,
    pattern: "signed discount tax can persist"
  },
  {
    name: "the completed-load snapshot table permits UPDATE mutation",
    sql: `DROP TRIGGER trg_mbt_mbbs_completed_load_snapshots_immutable
            ON mbt_mbbs_completed_load_snapshots;
          CREATE TRIGGER trg_mbt_mbbs_completed_load_snapshots_immutable
            BEFORE DELETE ON mbt_mbbs_completed_load_snapshots
            FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();`,
    pattern: "completed-load source is frozen"
  },
  {
    name: "the activated rate graph rejects discount components",
    sql: `ALTER TABLE mbt_rate_components
            DROP CONSTRAINT mbt_rate_components_kind;
          ALTER TABLE mbt_rate_components
            ADD CONSTRAINT mbt_rate_components_kind
            CHECK (
              component_kind IN (
                'base_transport', 'rental', 'extension', 'exchange', 'pickup',
                'downtown_surcharge', 'service', 'other'
              )
            ) NOT VALID;`,
    pattern: "activated rate graphs can represent a discount"
  },
  {
    name: "the public snapshot boundary accepts caller-authored loads",
    path: SERVICE,
    from: "if (Object.hasOwn(input, \"loads\")) {",
    to: "if (false && Object.hasOwn(input, \"loads\")) {",
    pattern: "snapshot generation rejects caller-authored loads",
    test: SNAPSHOT_TEST
  },
  {
    name: "cross-charge evidence loses its completed-load snapshot identity",
    path: SERVICE,
    from: "String(row.completed_load_snapshot_id)\n  ]));",
    to: "null\n  ]));",
    pattern: "snapshot generation rejects caller-authored loads",
    test: SNAPSHOT_TEST
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
    throw new Error(`Unsafe P3.10 adversarial mutation database name: ${name}`);
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

/** @param {string} connectionString @param {string} sql */
async function applySqlMutation(connectionString, sql) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("P3.10 adversarial mutation tests require an explicitly ephemeral MBT test environment.");
}
const adminUrlText = String(process.env.MBT_P310_MUTATION_ADMIN_URL || "").trim();
if (!adminUrlText) {
  throw new Error("MBT_P310_MUTATION_ADMIN_URL is required.");
}
const adminUrl = new URL(adminUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("The P3.10 mutation admin URL must use PostgreSQL.");
}
adminUrl.pathname = "/postgres";

const originals = new Map();
for (const mutant of MUTANTS) {
  const targetPath = mutant.path;
  if (!targetPath) {
    continue;
  }
  const target = path.resolve(targetPath);
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
    const targetPath = mutant.path;
    const from = mutant.from;
    const to = mutant.to;
    const target = targetPath ? path.resolve(targetPath) : null;
    const original = target ? originals.get(target) : null;
    if (target && (
      typeof original !== "string"
      || typeof from !== "string"
      || typeof to !== "string"
      || occurrenceCount(original, from) !== 1
    )) {
      throw new Error(`${mutant.name}: expected exactly one mutation target in ${targetPath}.`);
    }
    const databaseName = `${TEST_DATABASE_PREFIX}${process.pid}_${index}_${randomBytes(3).toString("hex")}`;
    const testUrl = new URL(adminUrl);
    testUrl.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    try {
      if (target && typeof original === "string"
          && typeof from === "string" && typeof to === "string") {
        await writeFile(target, original.replace(from, to), "utf8");
      }
      const env = {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        MBBS_ENV_FILE: ".env.mbt-test-does-not-exist"
      };
      if (await run(process.execPath, ["src/migrate.js"], env) !== 0) {
        throw new Error(`${mutant.name}: isolated migration failed.`);
      }
      if (mutant.sql) {
        await applySqlMutation(testUrl.toString(), mutant.sql);
      }
      if (await run(process.execPath, [
        "--test",
        "--test-concurrency=1",
        "--test-name-pattern",
        mutant.pattern,
        mutant.test || TEST
      ], env) === 0) {
        throw new Error(`${mutant.name}: survived its P3.10 adversarial detector.`);
      }
      killed += 1;
      console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    } finally {
      if (target && typeof original === "string") {
        await writeFile(target, original, "utf8");
      }
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
    throw new Error(`P3.10 mutation testing did not restore ${path.relative(process.cwd(), target)} exactly.`);
  }
}
if (killed !== MUTANTS.length) {
  throw new Error(`P3.10 adversarial mutation score ${killed}/${MUTANTS.length}; all mutants must be killed.`);
}
console.log(`P3.10 adversarial mutation score ${killed}/${MUTANTS.length}; all target sources restored.`);
