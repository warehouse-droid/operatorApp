// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  applyRootMigrationsThrough,
  createTemporaryMigrationDatabase,
  dropTemporaryMigrationDatabase,
  runOfficialMigrationRunner
} from "../../support/migration-upgrade.mjs";

const { Client } = pg;

const MBT_FOUNDATION_MIGRATIONS = Object.freeze([
  "102_mbt_authorities_flags_audit.sql",
  "103_netsuite_customer_master_foundation.sql",
  "104_mbt_assets_templates_fleet.sql",
  "105_mbt_rates_contracts_visits.sql",
  "106_mbt_billing_outbox.sql",
  "107_mbt_netsuite_mappings_preflight.sql",
  "108_mbt_netsuite_sandbox_readiness.sql",
  "109_mbt_local_first_configuration.sql"
]);

/**
 * @param {import("pg").Client} client
 * @returns {Promise<{
 *   operatorId: string,
 *   tokenHash: string,
 *   truckId: string,
 *   planId: string,
 *   scheduleId: string
 * }>}
 */
async function seedRepresentativeSchema101Records(client) {
  const operatorId = "mbt-upgrade-operator";
  const tokenHash = "mbt-upgrade-session-token-hash"; // secret-scan: allow deterministic hash fixture
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO operators (
         id,
         username,
         display_name,
         password_hash,
         password_salt,
         role,
         roles,
         yard_location_ids,
         active,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'admin', ARRAY['admin']::text[],
               ARRAY[]::integer[], true, $6, $6)`,
      [
        operatorId,
        "mbt-upgrade-admin",
        "MBT Upgrade Admin",
        "test-only-password-hash",
        "test-only-password-salt",
        "2026-08-03T00:00:00.000Z"
      ]
    );
    await client.query(
      `INSERT INTO operator_sessions (
         token_hash,
         operator_id,
         created_at,
         expires_at,
         last_seen_at
       )
       VALUES ($1, $2, $3, $4, $3)`,
      [
        tokenHash,
        operatorId,
        "2026-08-03T00:01:00.000Z",
        "2099-08-03T00:01:00.000Z"
      ]
    );
    const truckResult = await client.query(
      `INSERT INTO dispatch_trucks (
         plate,
         capacity_lbs,
         travel_time_percent,
         display_order,
         active,
         base_yard,
         created_at,
         updated_at
       )
       VALUES ('UPGRADE-TRUCK-01', 48750.25, 7.500, 9, true, '3445', $1, $1)
       RETURNING id::text AS id`,
      ["2026-08-03T00:02:00.000Z"]
    );
    const planResult = await client.query(
      `INSERT INTO dispatch_plans (
         plan_date,
         status,
         note,
         revision,
         created_at,
         updated_at
       )
       VALUES ('2099-07-31', 'draft', 'Preserve this upgrade plan', 17, $1, $1)
       RETURNING id::text AS id`,
      ["2026-08-03T00:03:00.000Z"]
    );
    const truckId = truckResult.rows[0].id;
    const planId = planResult.rows[0].id;
    await client.query(
      `INSERT INTO dispatch_plan_snapshots (
         plan_id,
         orders,
         trucks,
         summary,
         saved_at
       )
       VALUES (
         $1,
         $2::jsonb,
         $3::jsonb,
         $4::jsonb,
         $5
       )`,
      [
        planId,
        JSON.stringify([{
          id: "upgrade-order-1",
          reference: "UPGRADE-SO-001",
          type: "SO",
          stops: [{ id: "upgrade-stop-1", location: "12441" }]
        }]),
        JSON.stringify([{
          id: truckId,
          loads: [{ id: "upgrade-load-1", orderIds: ["upgrade-order-1"] }]
        }]),
        JSON.stringify({ source: "schema-101", totalLoads: 1 }),
        "2026-08-03T00:04:00.000Z"
      ]
    );
    const scheduleResult = await client.query(
      `INSERT INTO scm_transport_schedule (
         order_kind,
         source_table,
         source_id,
         order_ref,
         display_ref,
         is_special_order,
         method,
         pickup_point,
         dropoff_point,
         brand,
         content,
         weight_lbs,
         status,
         eta_date,
         notes,
         created_by,
         updated_by,
         created_at,
         updated_at,
         reconciliation_blocked
       )
       VALUES (
         'PO', 'purchase_orders', 900001, 'UPGRADE-PO-001', 'Upgrade PO',
         false, 'MBT', '2967', '3445', 'Upgrade Vendor', 'Preserve MBT method',
         12345.75, 'Hold', '2099-07-30', 'Unchanged by MBT domain migration',
         'mbt-upgrade-test', 'mbt-upgrade-test', $1, $1, false
       )
       RETURNING id::text AS id`,
      ["2026-08-03T00:05:00.000Z"]
    );
    await client.query("COMMIT");
    return {
      operatorId,
      tokenHash,
      truckId,
      planId,
      scheduleId: scheduleResult.rows[0].id
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * @param {import("pg").Client} client
 * @param {string} sql
 * @param {unknown[]} parameters
 * @returns {Promise<{snapshot: Record<string, unknown>, checksum: string}>}
 */
async function captureExactRow(client, sql, parameters) {
  const result = await client.query(sql, parameters);
  assert.equal(result.rowCount, 1, "The representative upgrade record must exist exactly once.");
  return result.rows[0];
}

/**
 * @param {import("pg").Client} client
 * @param {{operatorId: string, tokenHash: string, truckId: string, planId: string, scheduleId: string}} ids
 * @returns {Promise<Record<string, unknown>>}
 */
async function captureLegacyState(client, ids) {
  const operator = await captureExactRow(
    client,
    `SELECT to_jsonb(selected) AS snapshot,
            md5(to_jsonb(selected)::text) AS checksum
       FROM (
         SELECT id, username, display_name, password_hash, password_salt,
                role, roles, yard_location_ids, active, created_at, updated_at
           FROM operators
          WHERE id = $1
       ) AS selected`,
    [ids.operatorId]
  );
  const session = await captureExactRow(
    client,
    `SELECT to_jsonb(selected) AS snapshot,
            md5(to_jsonb(selected)::text) AS checksum
       FROM (
         SELECT token_hash, operator_id, created_at, expires_at, last_seen_at
           FROM operator_sessions
          WHERE token_hash = $1
       ) AS selected`,
    [ids.tokenHash]
  );
  const truck = await captureExactRow(
    client,
    `SELECT to_jsonb(selected) AS snapshot,
            md5(to_jsonb(selected)::text) AS checksum
       FROM (
         SELECT id, plate, capacity_lbs, travel_time_percent, display_order,
                active, base_yard, created_at, updated_at
           FROM dispatch_trucks
          WHERE id = $1
       ) AS selected`,
    [ids.truckId]
  );
  const plan = await captureExactRow(
    client,
    `SELECT to_jsonb(selected) AS snapshot,
            md5(to_jsonb(selected)::text) AS checksum
       FROM (
         SELECT id, plan_date, status, note, created_by, confirmed_by,
                confirmed_at, revision, created_at, updated_at
           FROM dispatch_plans
          WHERE id = $1
       ) AS selected`,
    [ids.planId]
  );
  const snapshot = await captureExactRow(
    client,
    `SELECT to_jsonb(selected) AS snapshot,
            md5(to_jsonb(selected)::text) AS checksum
       FROM (
         SELECT plan_id, orders, trucks, summary, saved_at
           FROM dispatch_plan_snapshots
          WHERE plan_id = $1
       ) AS selected`,
    [ids.planId]
  );
  const schedule = await captureExactRow(
    client,
    `SELECT to_jsonb(selected) - ARRAY['dispatch_plan_id', 'dispatch_previous_state', 'remark_override']::text[] AS snapshot,
            md5((to_jsonb(selected) - ARRAY['dispatch_plan_id', 'dispatch_previous_state', 'remark_override']::text[])::text) AS checksum
       FROM (
         SELECT *
           FROM scm_transport_schedule
          WHERE id = $1
       ) AS selected`,
    [ids.scheduleId]
  );
  const counts = await client.query(
    `SELECT
       (SELECT count(*)::int FROM operators WHERE id = $1) AS operators,
       (SELECT count(*)::int FROM operator_sessions WHERE token_hash = $2) AS sessions,
       (SELECT count(*)::int FROM dispatch_trucks WHERE id = $3) AS trucks,
       (SELECT count(*)::int FROM dispatch_plans WHERE id = $4) AS plans,
       (SELECT count(*)::int FROM dispatch_plan_snapshots WHERE plan_id = $4) AS snapshots,
       (SELECT count(*)::int FROM scm_transport_schedule WHERE id = $5) AS schedules`,
    [ids.operatorId, ids.tokenHash, ids.truckId, ids.planId, ids.scheduleId]
  );
  return {
    operator,
    session,
    truck,
    plan,
    snapshot,
    schedule,
    counts: counts.rows[0]
  };
}

test("F06/F16: schema-101 upgrade preserves representative legacy records and is migration-runner idempotent", {
  timeout: 120_000
}, async () => {
  /** @type {Awaited<ReturnType<typeof createTemporaryMigrationDatabase>> | null} */
  let temporaryDatabase = null;
  /** @type {import("pg").Client | null} */
  let client = null;
  try {
    temporaryDatabase = await createTemporaryMigrationDatabase({
      databaseUrl: String(process.env.DATABASE_URL || "")
    });
    client = new Client({ connectionString: temporaryDatabase.databaseUrl });
    await client.connect();

    const baselineFiles = await applyRootMigrationsThrough(client, { through: 101 });
    assert.equal(baselineFiles.length, 101);
    assert.equal(baselineFiles[0], "001_baseline_current_schema.sql");
    assert.equal(baselineFiles.at(-1), "101_smart_scm_vendor_reply_destinations.sql");

    const ids = await seedRepresentativeSchema101Records(client);
    const before = await captureLegacyState(client, ids);
    assert.deepEqual(before.counts, {
      operators: 1,
      sessions: 1,
      trucks: 1,
      plans: 1,
      snapshots: 1,
      schedules: 1
    });

    const firstRunner = await runOfficialMigrationRunner({
      databaseUrl: temporaryDatabase.databaseUrl
    });
    assert.equal(firstRunner.exitCode, 0, firstRunner.stderr);
    for (const filename of MBT_FOUNDATION_MIGRATIONS) {
      assert.match(firstRunner.stdout, new RegExp(`Applied ${filename.replaceAll(".", "\\.")}`));
    }
    assert.match(firstRunner.stdout, /Applied 139_sales_order_reload_cycles\.sql/);
    assert.match(firstRunner.stdout, /Applied 140_driver_yard_dependency_soft_mode\.sql/);
    assert.match(firstRunner.stdout, /Applied 141_transfer_dependency_revision_reprint\.sql/);
    assert.match(firstRunner.stdout, /Applied 142_mbt_frontdesk_customer_charge_requests\.sql/);
    assert.match(firstRunner.stdout, /Applied 143_mbt_item_charge_bases_and_aggregate\.sql/);
    assert.match(firstRunner.stdout, /Applied 144_mbt_mbbs_billing_address_overrides\.sql/);
    assert.match(firstRunner.stdout, /Applied 145_scm_po_split_active_ref_uniqueness\.sql/);
    assert.match(firstRunner.stdout, /Applied 146_smart_scm_blanket_load_merge\.sql/);
    assert.match(firstRunner.stdout, /Applied 147_scm_po_vendor_reference_backfill\.sql/);
    assert.match(firstRunner.stdout, /Applied 148_scm_po_history_line_financial_backfill\.sql/);
    assert.match(firstRunner.stdout, /Applied 149_sales_stock_requests\.sql/);
    assert.match(firstRunner.stdout, /Applied 150_stock_request_closed_status\.sql/);
    assert.match(firstRunner.stdout, /Applied 151_stock_request_remarks\.sql/);
    assert.match(firstRunner.stdout, /Applied 152_sales_stock_request_over_availability_gate\.sql/);
    assert.match(firstRunner.stdout, /Applied 153_driver_camera_device_copy_gate\.sql/);
    assert.match(firstRunner.stdout, /Applied 154_sales_order_delivery_instructions\.sql/);
    assert.match(firstRunner.stdout, /Applied 155_delivery_instruction_media_replacement\.sql/);
    assert.match(firstRunner.stdout, /Applied 156_scm_vendor_item_price\.sql/);
    assert.match(firstRunner.stdout, /Applied 157_yard_movement_history_indexes\.sql/);
    assert.match(firstRunner.stdout, /Applied 158_mbt_mbbs_candidate_billing\.sql/);
    assert.match(firstRunner.stdout, /Applied 159_dispatch_order_completion_status\.sql/);
    assert.match(firstRunner.stdout, /Applied 160_mbt_mbbs_rate_card_charging_policy\.sql/);
    assert.match(firstRunner.stdout, /Applied 161_mbt_rate_card_version_cutover\.sql/);
    assert.match(firstRunner.stdout, /Applied 162_dispatch_po_delivery_address_override\.sql/);
    assert.match(firstRunner.stdout, /Applied 163_dispatch_scm_unplan_state\.sql/);
    assert.match(firstRunner.stdout, /Applied 164_sales_order_partial_reattempt\.sql/);
    assert.match(firstRunner.stdout, /Applied 165_operator_customer_pickup_photo_gate\.sql/);
    assert.match(firstRunner.stdout, /Applied 166_mbt_mbbs_po_vrma_vendor_route_rates\.sql/);
    assert.match(firstRunner.stdout, /Applied 171_netsuite_delayed_status_refresh_outbox\.sql/);
    assert.match(firstRunner.stdout, /Applied 176_special_stock_request_workflow\.sql/);
    assert.match(firstRunner.stdout, /Applied 177_special_stock_request_two_stage_handoff\.sql/);
    assert.match(firstRunner.stdout, /Applied 178_operator_netsuite_posting_gates\.sql/);
    assert.match(firstRunner.stdout, /Applied 179_sales_order_reattempt_current_item_corrections\.sql/);
    assert.match(firstRunner.stdout, /Applied 180_sales_order_completion_fulfillment\.sql/);
    assert.match(firstRunner.stdout, /Applied 181_smart_scm_phased_planning_po_split_editing\.sql/);
    assert.match(firstRunner.stdout, /Applied 182_dispatch_direct_po_link_execution\.sql/);
    assert.match(firstRunner.stdout, /Applied 183_scm_authoritative_schedule_status\.sql/);
    assert.match(firstRunner.stdout, /Applied 184_scm_schedule_remarks\.sql/);

    const after = await captureLegacyState(client, ids);
    assert.deepEqual(after, before, "Migrations 102-184 must not rewrite representative schema-101 field values.");

    const scheduleRemark = await client.query(
      `SELECT remark_override
         FROM scm_transport_schedule
        WHERE id = $1`,
      [ids.scheduleId]
    );
    assert.deepEqual(scheduleRemark.rows, [{ remark_override: null }],
      "The new local remark must be additive and must not reinterpret legacy planning notes.");

    const truckCapability = await client.query(
      `SELECT bin_service_enabled, bin_slot_capacity
         FROM dispatch_trucks
        WHERE id = $1`,
      [ids.truckId]
    );
    assert.deepEqual(truckCapability.rows, [{
      bin_service_enabled: false,
      bin_slot_capacity: 0
    }]);

    const legacyMethod = await client.query(
      `UPDATE scm_transport_schedule
          SET method = 'MBT'
        WHERE id = $1
      RETURNING method`,
      [ids.scheduleId]
    );
    assert.deepEqual(legacyMethod.rows, [{ method: "MBT" }]);
    const methodConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'scm_transport_schedule'::regclass
          AND contype = 'c'`
    );
    assert.match(methodConstraint.rows.map((row) => row.definition).join("\n"), /MBT/);
    const reconciliationOrderKindConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'scm_reconciliation_order_state'::regclass
          AND conname = 'scm_reconciliation_order_state_order_kind_check'`
    );
    assert.equal(reconciliationOrderKindConstraint.rowCount, 1);
    assert.match(reconciliationOrderKindConstraint.rows[0].definition, /'SO'::text/);
    assert.match(reconciliationOrderKindConstraint.rows[0].definition, /'PO'::text/);
    assert.match(reconciliationOrderKindConstraint.rows[0].definition, /'TO'::text/);

    const receiptsBeforeNoOp = await client.query(
      `SELECT filename, applied_at::text AS applied_at
         FROM schema_migrations
        ORDER BY filename`
    );
    const blanketMergeColumns = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'scm_smart_proposals'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [["merged_at", "merged_by", "merged_into_proposal_id"]]
    );
    assert.deepEqual(blanketMergeColumns.rows.map((row) => row.column_name), [
      "merged_at",
      "merged_by",
      "merged_into_proposal_id"
    ]);
    const deliveryInstructionTables = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        "sales_order_delivery_instruction_media",
        "sales_order_delivery_instruction_upload_tickets",
        "sales_order_delivery_instructions"
      ]]
    );
    assert.deepEqual(deliveryInstructionTables.rows.map((row) => row.table_name), [
      "sales_order_delivery_instruction_media",
      "sales_order_delivery_instruction_upload_tickets",
      "sales_order_delivery_instructions"
    ]);
    const replacementColumn = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'sales_order_delivery_instruction_upload_tickets'
          AND column_name = 'replacement_media_id'`
    );
    assert.equal(replacementColumn.rowCount, 1);

    const vendorPriceColumns = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'scm_netsuite_vendor_item_codes'
          AND column_name IN ('vendor_price', 'vendor_price_synced_at')
        ORDER BY column_name`
    );
    assert.deepEqual(vendorPriceColumns.rows.map((row) => row.column_name), [
      "vendor_price",
      "vendor_price_synced_at"
    ]);

    const yardMovementIndexes = await client.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        "idx_driver_job_records_movement_activity",
        "idx_local_co_receipt_records_movement_activity",
        "idx_operator_load_records_movement_activity",
        "idx_receiving_receipt_records_movement_activity"
      ]]
    );
    assert.deepEqual(yardMovementIndexes.rows.map((row) => row.indexname), [
      "idx_driver_job_records_movement_activity",
      "idx_local_co_receipt_records_movement_activity",
      "idx_operator_load_records_movement_activity",
      "idx_receiving_receipt_records_movement_activity"
    ]);

    const delayedRefreshTables = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        "netsuite_delayed_status_refresh_attempts",
        "netsuite_delayed_status_refresh_jobs"
      ]]
    );
    assert.deepEqual(delayedRefreshTables.rows.map((row) => row.table_name), [
      "netsuite_delayed_status_refresh_attempts",
      "netsuite_delayed_status_refresh_jobs"
    ]);

    const dependencyManagementTables = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        "driver_push_subscriptions",
        "driver_route_device_presence",
        "scm_dependency_action_receipts",
        "scm_dependency_change_request_devices",
        "scm_dependency_change_requests"
      ]]
    );
    assert.deepEqual(dependencyManagementTables.rows.map((row) => row.table_name), [
      "driver_push_subscriptions",
      "driver_route_device_presence",
      "scm_dependency_action_receipts",
      "scm_dependency_change_request_devices",
      "scm_dependency_change_requests"
    ]);

    const manifestSupersedeColumns = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'driver_offline_manifests'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [["superseded_by_request_id", "superseded_reason"]]
    );
    assert.deepEqual(manifestSupersedeColumns.rows.map((row) => row.column_name), [
      "superseded_by_request_id",
      "superseded_reason"
    ]);

    const specialStockRequestTables = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        "sales_special_stock_cases",
        "sales_special_stock_events",
        "sales_special_stock_handoffs",
        "sales_special_stock_lines",
        "sales_special_stock_media",
        "sales_special_stock_order_lines"
      ]]
    );
    assert.deepEqual(specialStockRequestTables.rows.map((row) => row.table_name), [
      "sales_special_stock_cases",
      "sales_special_stock_events",
      "sales_special_stock_handoffs",
      "sales_special_stock_lines",
      "sales_special_stock_media",
      "sales_special_stock_order_lines"
    ]);

    const phasedPlanningColumns = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('scm_smart_settings', 'skip_12441_enabled'),
            ('scm_smart_settings', 'inventory_planning_mode'),
            ('scm_smart_planning_runs', 'planning_phase'),
            ('scm_smart_planning_runs', 'phase_one_approved_at'),
            ('scm_smart_planning_runs', 'phase_one_approved_by'),
            ('scm_smart_planning_runs', 'phase_two_basis'),
            ('scm_smart_planning_runs', 'phase_two_created_at'),
            ('dispatch_scm_po_splits', 'revision'),
            ('dispatch_scm_po_splits', 'updated_at')
          )
        ORDER BY table_name, column_name`
    );
    assert.deepEqual(phasedPlanningColumns.rows, [
      { table_name: "dispatch_scm_po_splits", column_name: "revision" },
      { table_name: "dispatch_scm_po_splits", column_name: "updated_at" },
      { table_name: "scm_smart_planning_runs", column_name: "phase_one_approved_at" },
      { table_name: "scm_smart_planning_runs", column_name: "phase_one_approved_by" },
      { table_name: "scm_smart_planning_runs", column_name: "phase_two_basis" },
      { table_name: "scm_smart_planning_runs", column_name: "phase_two_created_at" },
      { table_name: "scm_smart_planning_runs", column_name: "planning_phase" },
      { table_name: "scm_smart_settings", column_name: "inventory_planning_mode" },
      { table_name: "scm_smart_settings", column_name: "skip_12441_enabled" }
    ]);
    const splitChangeEventTable = await client.query(
      `SELECT to_regclass('public.dispatch_scm_po_split_change_events')::text AS table_name,
              EXISTS (
                SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'dispatch_scm_po_split_change_events'::regclass
                   AND tgname = 'trg_dispatch_scm_po_split_change_events_immutable'
                   AND NOT tgisinternal
              ) AS immutable_trigger`
    );
    assert.deepEqual(splitChangeEventTable.rows, [{
      table_name: "dispatch_scm_po_split_change_events",
      immutable_trigger: true
    }]);

    assert.equal(receiptsBeforeNoOp.rowCount, 184);
    assert.equal(
      receiptsBeforeNoOp.rows.at(-1)?.filename,
      "184_scm_schedule_remarks.sql"
    );
    assert.deepEqual(
      receiptsBeforeNoOp.rows
        .map((row) => row.filename)
        .filter((filename) => /^(?:10[2-9])_/.test(filename)),
      MBT_FOUNDATION_MIGRATIONS
    );

    const secondRunner = await runOfficialMigrationRunner({
      databaseUrl: temporaryDatabase.databaseUrl
    });
    assert.equal(secondRunner.exitCode, 0, secondRunner.stderr);
    assert.equal(secondRunner.stdout.trim(), "", "A second official migration run must apply no files.");
    const receiptsAfterNoOp = await client.query(
      `SELECT filename, applied_at::text AS applied_at
         FROM schema_migrations
        ORDER BY filename`
    );
    assert.deepEqual(receiptsAfterNoOp.rows, receiptsBeforeNoOp.rows);
  } finally {
    if (client) {
      await client.end().catch(() => undefined);
    }
    if (temporaryDatabase) {
      await dropTemporaryMigrationDatabase(temporaryDatabase);
    }
  }
});
