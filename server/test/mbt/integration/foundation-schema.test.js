import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";

const EXPECTED_TABLES = Object.freeze([
  "mbt_feature_flags",
  "mbt_command_receipts",
  "mbt_audit_events",
  "netsuite_customers",
  "netsuite_customer_addresses",
  "netsuite_customer_contacts",
  "netsuite_customer_subsidiaries",
  "netsuite_customer_sync_state",
  "netsuite_customer_sync_runs",
  "netsuite_customer_sync_pages",
  "netsuite_customer_sync_conflicts",
  "mbt_customer_site_profiles",
  "mbt_yards",
  "mbt_materials",
  "mbt_dump_sites",
  "mbt_dump_site_materials",
  "mbt_bin_types",
  "mbt_bin_condition_codes",
  "mbt_bin_assets",
  "mbt_bin_asset_state",
  "mbt_bin_movements",
  "mbt_service_templates",
  "mbt_service_template_versions",
  "mbt_service_template_steps",
  "mbt_service_template_evidence_requirements",
  "dispatch_truck_bin_types",
  "mbt_rate_cards",
  "mbt_rate_card_versions",
  "mbt_rate_distance_bands",
  "mbt_rate_components",
  "mbt_dump_tariffs",
  "mbt_deposit_rules",
  "mbt_quotes",
  "mbt_contracts",
  "mbt_contract_amendments",
  "mbt_service_visits",
  "mbt_visit_steps",
  "mbt_visit_evidence_requirements",
  "mbt_evidence",
  "mbt_distance_snapshots",
  "mbt_bin_asset_reservations",
  "mbt_billing_cases",
  "mbt_billing_versions",
  "mbt_billing_lines",
  "mbt_deposit_records",
  "mbt_cross_charge_cases",
  "mbt_cross_charge_allocations",
  "mbt_netsuite_sales_order_chain",
  "mbt_netsuite_outbox",
  "mbt_netsuite_outbox_attempts",
  "mbt_netsuite_reconciliations",
  "mbt_netsuite_mappings",
  "mbt_netsuite_preflight_runs",
  "mbt_netsuite_preflight_checks"
]);

async function relationNames(names) {
  const result = await query(
    `SELECT requested.name,
            to_regclass('public.' || requested.name)::text AS relation_name
       FROM unnest($1::text[]) AS requested(name)
      ORDER BY requested.name`,
    [names]
  );
  return result.rows;
}

after(async () => {
  await closeDb();
});

test("F06/F16: migrations 102-107 create every Phase 1 relation", async () => {
  const rows = await relationNames(EXPECTED_TABLES);
  const missing = rows.filter((row) => !row.relation_name).map((row) => row.name);
  assert.deepEqual(missing, [], `Missing Phase 1 relations: ${missing.join(", ")}`);
});

test("F06: the four configured bin types are seeded exactly once", async () => {
  const exists = (await relationNames(["mbt_bin_types"]))[0].relation_name;
  assert.ok(exists, "mbt_bin_types must exist before checking its seed contract");
  const result = await query(
    `SELECT type_code, nominal_yards::text AS nominal_yards, active
       FROM mbt_bin_types
      WHERE type_code IN ('14YD', '20YD', '30YD', '40YD')
      ORDER BY nominal_yards`
  );
  assert.deepEqual(result.rows, [
    { type_code: "14YD", nominal_yards: "14", active: true },
    { type_code: "20YD", nominal_yards: "20", active: true },
    { type_code: "30YD", nominal_yards: "30", active: true },
    { type_code: "40YD", nominal_yards: "40", active: true }
  ]);
});

test("F06: every pre-existing truck defaults to BIN-disabled with zero slots", async () => {
  const migration = await query(
    `SELECT applied_at
       FROM schema_migrations
      WHERE filename = '104_mbt_assets_templates_fleet.sql'`
  );
  assert.equal(migration.rowCount, 1);
  const columns = await query(
    `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dispatch_trucks'
        AND column_name IN ('bin_service_enabled', 'bin_slot_capacity')
      ORDER BY column_name`
  );
  assert.equal(columns.rowCount, 2, "dispatch_trucks must expose both BIN capability columns");
  assert.ok(columns.rows.every((row) => row.is_nullable === "NO"));
  const unsafe = await query(
    `SELECT id, plate, bin_service_enabled, bin_slot_capacity
       FROM dispatch_trucks
      WHERE created_at <= $1
        AND (bin_service_enabled IS DISTINCT FROM false
         OR bin_slot_capacity IS DISTINCT FROM 0)`,
    [migration.rows[0].applied_at]
  );
  assert.deepEqual(unsafe.rows, []);
});

test("F05/F08/F09/F11: immutable Phase 1 tables have database triggers", async () => {
  const required = [
    "mbt_audit_events",
    "mbt_bin_movements",
    "mbt_billing_versions",
    "mbt_billing_lines",
    "mbt_netsuite_outbox_attempts"
  ];
  const result = await query(
    `SELECT c.relname AS table_name,
            count(*) FILTER (WHERE NOT t.tgisinternal)::int AS trigger_count
       FROM pg_class c
       LEFT JOIN pg_trigger t ON t.tgrelid = c.oid
      WHERE c.relname = ANY($1::text[])
      GROUP BY c.relname
      ORDER BY c.relname`,
    [required]
  );
  assert.deepEqual(
    result.rows.map((row) => row.table_name),
    [...required].sort(),
    "Every immutable table must exist"
  );
  assert.ok(
    result.rows.every((row) => Number(row.trigger_count) >= 1),
    `Missing immutability trigger: ${JSON.stringify(result.rows)}`
  );
});

test("F05: the database requires the complete privileged audit envelope", async () => {
  const requiredColumns = [
    "actor_operator_id",
    "actor_roles",
    "before_state",
    "after_state",
    "reason",
    "revision_before",
    "revision_after",
    "correlation_id",
    "request_id",
    "idempotency_key"
  ];
  const columns = await query(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_audit_events'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [requiredColumns]
  );
  assert.equal(columns.rowCount, requiredColumns.length);
  assert.ok(columns.rows.every((row) => row.is_nullable === "NO"), JSON.stringify(columns.rows));

  const constraints = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_audit_events'::regclass
        AND contype = 'c'`
  );
  const definitions = constraints.rows.map((row) => row.definition).join("\n");
  assert.match(definitions, /cardinality\(actor_roles\) > 0/i);
  assert.match(definitions, /btrim\(reason\)/i);
  assert.match(definitions, /btrim\(idempotency_key\)/i);
});

test("F07/F11/F12: critical deduplication indexes are partial or unique at the database", async () => {
  const expectedFragments = [
    ["mbt_bin_asset_reservations", "asset_id", "released_at IS NULL"],
    ["mbt_bin_asset_reservations", "visit_id", "reservation_slot"],
    ["mbt_cross_charge_cases", "root_reference", "physical_load_id"],
    ["mbt_deposit_records", "funds_confirmation_receipt_id", "UNIQUE"],
    ["mbt_netsuite_outbox", "external_idempotency_key", "UNIQUE"]
  ];
  const result = await query(
    `SELECT tablename, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])`,
    [[...new Set(expectedFragments.map(([table]) => table))]]
  );
  for (const [table, ...fragments] of expectedFragments) {
    const definitions = result.rows
      .filter((row) => row.tablename === table)
      .map((row) => row.indexdef)
      .join("\n");
    for (const fragment of fragments) {
      assert.match(
        definitions.toUpperCase(),
        new RegExp(fragment.toUpperCase().replaceAll(" ", "\\s+")),
        `${table} index contract is missing ${fragment}`
      );
    }
  }
});

test("F06: the unrelated Smart SCM MBT method constraint remains present", async () => {
  const result = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'scm_transport_schedule'::regclass
        AND contype = 'c'`
  );
  const definitions = result.rows.map((row) => row.definition).join("\n");
  assert.match(definitions, /MBT/);
});
