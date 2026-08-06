import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import pg from "pg";

import { closeDb, query } from "../../../src/db.js";
import {
  applyRootMigrationsThrough,
  createTemporaryMigrationDatabase,
  dropTemporaryMigrationDatabase,
  runOfficialMigrationRunner
} from "../../support/migration-upgrade.mjs";

const MIGRATION = "108_mbt_netsuite_sandbox_readiness.sql";
const SCHEMA_107_MIGRATIONS = Object.freeze([
  "102_mbt_authorities_flags_audit.sql",
  "103_netsuite_customer_master_foundation.sql",
  "104_mbt_assets_templates_fleet.sql",
  "105_mbt_rates_contracts_visits.sql",
  "106_mbt_billing_outbox.sql",
  "107_mbt_netsuite_mappings_preflight.sql"
]);
const { Client } = pg;

async function applySchema107(client) {
  await applyRootMigrationsThrough(client, { through: 101 });
  for (const filename of SCHEMA_107_MIGRATIONS) {
    const sql = await readFile(new URL(`../../../migrations/${filename}`, import.meta.url), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

after(async () => {
  await closeDb();
});

test("P2-F03/P2-F04: migration 108 installs the sandbox-readiness evidence schema", async () => {
  const applied = await query(
    "SELECT filename FROM schema_migrations WHERE filename = $1",
    [MIGRATION]
  );
  assert.deepEqual(applied.rows, [{ filename: MIGRATION }]);

  const relations = await query(
    `SELECT requested.name,
            to_regclass('public.' || requested.name)::text AS relation_name
       FROM unnest($1::text[]) AS requested(name)
      ORDER BY requested.name`,
    [[
      "mbt_netsuite_mappings",
      "mbt_netsuite_preflight_checks",
      "mbt_netsuite_preflight_runs",
      "mbt_netsuite_preflight_signoffs"
    ]]
  );
  assert.ok(
    relations.rows.every(({ relation_name: relationName }) => relationName),
    `Missing Phase 2 relation: ${JSON.stringify(relations.rows)}`
  );
});

test("P2-F03: preflight runs expose a database-enforced singleton lease", async () => {
  const columns = await query(
    `SELECT column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_netsuite_preflight_runs'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [["lease_expires_at", "lease_owner", "lease_token"]]
  );
  assert.deepEqual(columns.rows, [
    {
      column_name: "lease_expires_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "YES"
    },
    {
      column_name: "lease_owner",
      data_type: "text",
      udt_name: "text",
      is_nullable: "YES"
    },
    {
      column_name: "lease_token",
      data_type: "uuid",
      udt_name: "uuid",
      is_nullable: "YES"
    }
  ]);

  const indexes = await query(
    `SELECT indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'mbt_netsuite_preflight_runs'`
  );
  const singleton = indexes.rows
    .map(({ indexdef }) => String(indexdef))
    .find((definition) => /CREATE UNIQUE INDEX/i.test(definition)
      && /status/i.test(definition)
      && /pending/i.test(definition)
      && /running/i.test(definition));
  assert.ok(singleton, `Missing active-run singleton index: ${JSON.stringify(indexes.rows)}`);

  const definitions = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_netsuite_preflight_runs'::regclass
        AND contype = 'c'`
  );
  const joined = definitions.rows.map(({ definition }) => definition).join("\n");
  assert.doesNotMatch(joined, /read_only_production/i);
  assert.match(joined, /read_only_sandbox/i);
});

test("P2-F03/P2-F05: persisted checks include a constrained severity and stable check code", async () => {
  const columns = await query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_netsuite_preflight_checks'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [["check_type", "expected_snapshot", "message", "observed_snapshot", "severity"]]
  );
  assert.deepEqual(columns.rows, [
    { column_name: "check_type", data_type: "text", is_nullable: "NO" },
    { column_name: "expected_snapshot", data_type: "jsonb", is_nullable: "NO" },
    { column_name: "message", data_type: "text", is_nullable: "NO" },
    { column_name: "observed_snapshot", data_type: "jsonb", is_nullable: "YES" },
    { column_name: "severity", data_type: "text", is_nullable: "NO" }
  ]);

  const constraints = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_netsuite_preflight_checks'::regclass
        AND contype = 'c'`
  );
  const joined = constraints.rows.map(({ definition }) => definition).join("\n");
  assert.match(joined, /severity/i);
  for (const severity of ["error", "warning", "info"]) {
    assert.match(joined, new RegExp(severity, "i"));
  }
});

test("P2-F04: signoff evidence is uniquely bound to one run and carries the complete audit envelope", async () => {
  const expectedColumns = [
    "audit_note",
    "configuration_hash",
    "correlation_id",
    "idempotency_key",
    "preflight_run_id",
    "request_id",
    "runtime_fingerprint",
    "signed_at",
    "signed_by",
    "signoff_id"
  ];
  const columns = await query(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_netsuite_preflight_signoffs'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [expectedColumns]
  );
  assert.deepEqual(
    columns.rows,
    expectedColumns.map((columnName) => ({ column_name: columnName, is_nullable: "NO" }))
  );

  const constraints = await query(
    `SELECT contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_netsuite_preflight_signoffs'::regclass
      ORDER BY contype, definition`
  );
  const joined = constraints.rows.map(({ contype, definition }) => `${contype}:${definition}`).join("\n");
  assert.match(joined, /u:UNIQUE \(preflight_run_id\)/i);
  assert.match(joined, /f:FOREIGN KEY \(preflight_run_id\).*ON DELETE RESTRICT/i);
  assert.match(joined, /configuration_hash.*\{64\}/i);
  for (const requiredText of ["audit_note", "correlation_id", "idempotency_key", "request_id", "signed_by"]) {
    assert.match(joined, new RegExp(`btrim\\(${requiredText}\\)`, "i"));
  }
});

test("P2-F03/P2-F04: runs and signoffs bind evidence to a SHA-256 runtime fingerprint", async () => {
  const columns = await query(
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND column_name = 'runtime_fingerprint'
      ORDER BY table_name`,
    [["mbt_netsuite_preflight_runs", "mbt_netsuite_preflight_signoffs"]]
  );
  assert.deepEqual(columns.rows, [
    {
      table_name: "mbt_netsuite_preflight_runs",
      column_name: "runtime_fingerprint",
      is_nullable: "NO"
    },
    {
      table_name: "mbt_netsuite_preflight_signoffs",
      column_name: "runtime_fingerprint",
      is_nullable: "NO"
    }
  ]);
  for (const table of ["mbt_netsuite_preflight_runs", "mbt_netsuite_preflight_signoffs"]) {
    const constraints = await query(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = $1::regclass
          AND contype = 'c'`,
      [table]
    );
    assert.match(
      constraints.rows.map(({ definition }) => definition).join("\n"),
      /runtime_fingerprint.*\{64\}/i
    );
  }

  const legacyRunId = randomUUID();
  await query(
    `INSERT INTO mbt_netsuite_preflight_runs (
       preflight_run_id, configuration_hash, mapping_snapshot,
       adapter_kind, account_id, environment_name, status,
       required_check_count, passed_required_count, failed_required_count,
       optional_check_count, passed_optional_count, requested_by,
       correlation_id, started_at, completed_at
     ) VALUES (
       $1, $2, '[]'::jsonb, 'phase1_read_only_fake', 'P1_TEST_ACCOUNT',
       'test', 'passed', 1, 1, 0, 0, 0, 'p1-compatibility-test',
       'p1-compatibility-runtime-default', clock_timestamp(), clock_timestamp()
     )`,
    [legacyRunId, "0".repeat(64)]
  );
  const legacy = await query(
    `SELECT runtime_fingerprint
       FROM mbt_netsuite_preflight_runs
      WHERE preflight_run_id = $1`,
    [legacyRunId]
  );
  assert.deepEqual(legacy.rows, [{ runtime_fingerprint: "0".repeat(64) }]);
});

test("P2-F04: terminal runs, their checks, and signoffs have database immutability triggers", async () => {
  const required = [
    "mbt_netsuite_preflight_checks",
    "mbt_netsuite_preflight_runs",
    "mbt_netsuite_preflight_signoffs"
  ];
  const triggers = await query(
    `SELECT c.relname AS table_name,
            count(*) FILTER (WHERE NOT t.tgisinternal)::int AS trigger_count
       FROM pg_class c
       LEFT JOIN pg_trigger t ON t.tgrelid = c.oid
      WHERE c.relname = ANY($1::text[])
      GROUP BY c.relname
      ORDER BY c.relname`,
    [required]
  );
  assert.deepEqual(triggers.rows.map(({ table_name: tableName }) => tableName), [...required].sort());
  assert.ok(
    triggers.rows.every(({ trigger_count: triggerCount }) => Number(triggerCount) >= 1),
    `Missing Phase 2 immutability trigger: ${JSON.stringify(triggers.rows)}`
  );

  const definitions = await query(
    `SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname, t.tgname`,
    [required]
  );
  const checkDefinitions = definitions.rows
    .filter(({ table_name: tableName }) => tableName === "mbt_netsuite_preflight_checks")
    .map(({ definition }) => definition)
    .join("\n");
  const signoffDefinitions = definitions.rows
    .filter(({ table_name: tableName }) => tableName === "mbt_netsuite_preflight_signoffs")
    .map(({ definition }) => definition)
    .join("\n");
  assert.match(checkDefinitions, /BEFORE (?=[^\n]*INSERT)(?=[^\n]*UPDATE)(?=[^\n]*DELETE)/i);
  assert.match(signoffDefinitions, /BEFORE INSERT/i);
});

test("P2-F03/P2-F04: schema-107 upgrade closes unleased work, retains terminal production-kind history, and is idempotent", {
  timeout: 120_000
}, async () => {
  let temporaryDatabase = null;
  let client = null;
  try {
    temporaryDatabase = await createTemporaryMigrationDatabase({
      databaseUrl: String(process.env.DATABASE_URL || "")
    });
    client = new Client({ connectionString: temporaryDatabase.databaseUrl });
    await client.connect();
    await applySchema107(client);

    const pendingRunId = randomUUID();
    const historicalRunId = randomUUID();
    const historicalCheckId = randomUUID();
    await client.query(
      `INSERT INTO mbt_netsuite_preflight_runs (
         preflight_run_id, configuration_hash, mapping_snapshot,
         adapter_kind, account_id, environment_name, status,
         required_check_count, passed_required_count, failed_required_count,
         optional_check_count, passed_optional_count, requested_by,
         correlation_id, started_at
       ) VALUES (
         $1, $2, '[]'::jsonb, 'phase1_read_only_fake', 'P2_UPGRADE_FAKE',
         'test', 'pending', 3, 1, 0, 1, 0, 'p2-upgrade-admin',
         'p2-upgrade-pending', clock_timestamp()
       )`,
      [pendingRunId, "a".repeat(64)]
    );
    await client.query(
      `INSERT INTO mbt_netsuite_preflight_runs (
         preflight_run_id, configuration_hash, mapping_snapshot,
         adapter_kind, account_id, environment_name, status,
         required_check_count, passed_required_count, failed_required_count,
         optional_check_count, passed_optional_count, requested_by,
         correlation_id, started_at, completed_at
       ) VALUES (
         $1, $2, '[]'::jsonb, 'read_only_production', 'P2_RETAINED_PRODUCTION',
         'production', 'passed', 1, 1, 0, 0, 0, 'p2-upgrade-admin',
         'p2-upgrade-history', clock_timestamp(), clock_timestamp()
       )`,
      [historicalRunId, "b".repeat(64)]
    );
    await client.query(
      `INSERT INTO mbt_netsuite_preflight_checks (
         preflight_check_id, preflight_run_id, sequence_number, check_type,
         required, mapping_type, local_key, expected_snapshot,
         observed_snapshot, status, message
       ) VALUES (
         $1, $2, 0, 'retained_production_history', true,
         'subsidiary', 'mbt', '{"active":true}'::jsonb,
         '{"active":true,"id":"33"}'::jsonb, 'passed',
         'Retain this terminal schema-107 check exactly.'
       )`,
      [historicalCheckId, historicalRunId]
    );
    const before = await client.query(
      `SELECT r.to_json AS run, c.to_json AS check
         FROM (
           SELECT to_jsonb(selected) AS to_json
             FROM (
               SELECT preflight_run_id, configuration_hash, mapping_snapshot,
                      adapter_kind, account_id, environment_name, status,
                      required_check_count, passed_required_count,
                      failed_required_count, optional_check_count,
                      passed_optional_count, requested_by, correlation_id,
                      started_at, completed_at, error_code, error_message,
                      created_at, updated_at
                 FROM mbt_netsuite_preflight_runs
                WHERE preflight_run_id = $1
             ) selected
         ) r
         CROSS JOIN (
           SELECT to_jsonb(selected) AS to_json
             FROM (
               SELECT preflight_check_id, preflight_run_id, sequence_number,
                      check_type, required, mapping_type, local_key,
                      external_record_type, external_id, expected_snapshot,
                      observed_snapshot, status, message, checked_at, created_at
                 FROM mbt_netsuite_preflight_checks
                WHERE preflight_check_id = $2
             ) selected
         ) c`,
      [historicalRunId, historicalCheckId]
    );
    assert.equal(before.rowCount, 1);

    await client.end();
    client = null;
    const first = await runOfficialMigrationRunner({
      databaseUrl: temporaryDatabase.databaseUrl
    });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /Applied 108_mbt_netsuite_sandbox_readiness\.sql/);

    client = new Client({ connectionString: temporaryDatabase.databaseUrl });
    await client.connect();
    const closed = await client.query(
      `SELECT status, required_check_count::int, passed_required_count::int,
              failed_required_count::int, completed_at IS NOT NULL AS completed,
              error_code, error_message, lease_token, lease_owner,
              lease_expires_at
         FROM mbt_netsuite_preflight_runs
        WHERE preflight_run_id = $1`,
      [pendingRunId]
    );
    assert.deepEqual(closed.rows, [{
      status: "unable_to_verify",
      required_check_count: 3,
      passed_required_count: 1,
      failed_required_count: 2,
      completed: true,
      error_code: "MBT_NETSUITE_PREFLIGHT_LEGACY_RUN_CLOSED",
      error_message: "A pre-Phase 2 preflight had no durable lease and was safely closed during migration.",
      lease_token: null,
      lease_owner: null,
      lease_expires_at: null
    }]);

    const retained = await client.query(
      `SELECT r.to_json AS run, c.to_json AS check
         FROM (
           SELECT to_jsonb(selected) AS to_json
             FROM (
               SELECT preflight_run_id, configuration_hash, mapping_snapshot,
                      adapter_kind, account_id, environment_name, status,
                      required_check_count, passed_required_count,
                      failed_required_count, optional_check_count,
                      passed_optional_count, requested_by, correlation_id,
                      started_at, completed_at, error_code, error_message,
                      created_at, updated_at
                 FROM mbt_netsuite_preflight_runs
                WHERE preflight_run_id = $1
             ) selected
         ) r
         CROSS JOIN (
           SELECT to_jsonb(selected) AS to_json
             FROM (
               SELECT preflight_check_id, preflight_run_id, sequence_number,
                      check_type, required, mapping_type, local_key,
                      external_record_type, external_id, expected_snapshot,
                      observed_snapshot, status, message, checked_at, created_at
                 FROM mbt_netsuite_preflight_checks
                WHERE preflight_check_id = $2
             ) selected
         ) c`,
      [historicalRunId, historicalCheckId]
    );
    assert.deepEqual(retained.rows, before.rows);

    await assert.rejects(
      () => client.query(
        `INSERT INTO mbt_netsuite_preflight_runs (
           preflight_run_id, configuration_hash, mapping_snapshot,
           adapter_kind, account_id, environment_name, status,
           runtime_fingerprint, requested_by, correlation_id, completed_at
         ) VALUES (
           $1, $2, '[]'::jsonb, 'read_only_production', 'NEW_PRODUCTION',
           'production', 'failed', $3, 'p2-upgrade-admin',
           'p2-upgrade-new-production', clock_timestamp()
         )`,
        [randomUUID(), "c".repeat(64), "d".repeat(64)]
      ),
      (error) => error?.code === "23514"
    );

    await client.end();
    client = null;
    const second = await runOfficialMigrationRunner({
      databaseUrl: temporaryDatabase.databaseUrl
    });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(second.stdout.trim(), "");
  } finally {
    if (client) {
      await client.end().catch(() => undefined);
    }
    if (temporaryDatabase) {
      await dropTemporaryMigrationDatabase(temporaryDatabase);
    }
  }
});
