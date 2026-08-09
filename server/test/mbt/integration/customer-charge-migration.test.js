// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";

const migrationUrl = new URL("../../../migrations/142_mbt_frontdesk_customer_charge_requests.sql", import.meta.url);

after(async () => {
  await closeDb();
});

test("migration 142 installs the immutable customer-charge ledger and seeded MBT catalog", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const tables = await query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [[
      "mbt_frontdesk_charge_catalog",
      "mbt_frontdesk_charge_configurations",
      "mbt_frontdesk_charge_rates",
      "mbt_frontdesk_aggregate_distance_bands",
      "mbt_frontdesk_charge_requests",
      "mbt_frontdesk_charge_request_lines"
    ]]
  );
  assert.deepEqual(tables.rows.map((row) => row.table_name), [
    "mbt_frontdesk_aggregate_distance_bands",
    "mbt_frontdesk_charge_catalog",
    "mbt_frontdesk_charge_configurations",
    "mbt_frontdesk_charge_rates",
    "mbt_frontdesk_charge_request_lines",
    "mbt_frontdesk_charge_requests"
  ]);

  const catalog = await query(
    `SELECT item_code, item_kind, content_code, unit_of_measure, active
       FROM mbt_frontdesk_charge_catalog
      ORDER BY item_code`
  );
  assert.deepEqual(catalog.rows.map(({ active: _active, ...row }) => row), [
    { item_code: "AGG_CLEAR_LIMESTONE_34", item_kind: "aggregate_material", content_code: null, unit_of_measure: "YARD" },
    { item_code: "AGG_CRUSHER_RUN", item_kind: "aggregate_material", content_code: null, unit_of_measure: "YARD" },
    { item_code: "AGG_HPB", item_kind: "aggregate_material", content_code: null, unit_of_measure: "YARD" },
    { item_code: "AGG_LOADING", item_kind: "loading_fee", content_code: null, unit_of_measure: "VISIT" },
    { item_code: "AGG_SCREENING", item_kind: "aggregate_material", content_code: null, unit_of_measure: "YARD" },
    { item_code: "DUMP_ASPHALT", item_kind: "fixed_dump", content_code: "asphalt", unit_of_measure: "BIN" },
    { item_code: "DUMP_CONCRETE", item_kind: "fixed_dump", content_code: "concrete", unit_of_measure: "BIN" },
    { item_code: "DUMP_SOIL", item_kind: "fixed_dump", content_code: "soil", unit_of_measure: "BIN" }
  ]);
  assert.match(migration, /'AGG_CLEAR_LIMESTONE_34'[\s\S]*?'aggregate\.clear_limestone_34', false\)/u);
  assert.match(migration, /'AGG_CRUSHER_RUN'[\s\S]*?'aggregate\.crusher_run', false\)/u);
  assert.match(migration, /'AGG_HPB'[\s\S]*?'aggregate\.hpb', false\)/u);
  assert.match(migration, /'AGG_SCREENING'[\s\S]*?'aggregate\.screening', false\)/u);
  assert.match(migration, /'DUMP_SOIL'[\s\S]*?'dump\.soil', false\)/u);
  assert.match(migration, /'DUMP_ASPHALT'[\s\S]*?'dump\.asphalt', false\)/u);
  assert.match(migration, /'DUMP_CONCRETE'[\s\S]*?'dump\.concrete', false\)/u);
  assert.match(migration, /'AGG_LOADING'[\s\S]*?5000[\s\S]*?'aggregate\.loading', true\)/u);

  const dispatchColumns = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dispatch_custom_orders'
        AND column_name = 'mbt_charge_request_id'`
  );
  assert.equal(dispatchColumns.rowCount, 1);
  const serviceLineColumns = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_contract_service_lines'
        AND column_name = 'source_charge_request_id'`
  );
  assert.equal(serviceLineColumns.rowCount, 1);
});

test("database constraints reject contradictory cash tax/export evidence", async () => {
  const id = crypto.randomUUID();
  await assert.rejects(
    query(
      `INSERT INTO mbt_frontdesk_charge_requests (
         charge_request_id, request_number, request_kind, status,
         payment_method, payment_category, tax_mode, tax_rate_basis_points,
         netsuite_export_policy, pricing_snapshot, netsuite_ready_snapshot,
         current_contract_total_minor, pre_tax_revenue_minor,
         included_hst_minor, added_hst_minor, request_total_minor,
         resulting_contract_total_minor, required_deposit_minor, due_now_minor,
         currency, billing_address_text, service_address_text, contract_telephone,
         order_from_150, reason, created_by, updated_by
       ) VALUES (
         $1, $2, 'aggregate_order', 'draft',
         'cash', 'cash', 'included', 1300,
         'eligible_non_cash', '{}'::jsonb, '{}'::jsonb,
         0, 8850, 1150, 0, 10000, 10000, 0, 10000,
         'CAD', '1 Billing Road', '2 Service Road', '416-555-0100',
         true, 'Constraint regression', 'test', 'test'
       )`,
      [id, `MBT-R-${id.slice(0, 12).toUpperCase()}`]
    ),
    /mbt_frontdesk_charge_requests_payment_tax_export/u
  );
});

test("database constraints conserve due-now and line-level tax evidence", async () => {
  const invalidDueId = crypto.randomUUID();
  await assert.rejects(
    query(
      `INSERT INTO mbt_frontdesk_charge_requests (
         charge_request_id, request_number, request_kind, status,
         payment_method, payment_category, tax_mode, tax_rate_basis_points,
         netsuite_export_policy, pricing_snapshot, netsuite_ready_snapshot,
         current_contract_total_minor, pre_tax_revenue_minor,
         included_hst_minor, added_hst_minor, request_total_minor,
         resulting_contract_total_minor, required_deposit_minor, due_now_minor,
         currency, billing_address_text, service_address_text, contract_telephone,
         order_from_150, reason, created_by, updated_by
       ) VALUES (
         $1, $2, 'aggregate_order', 'draft',
         'card', 'non_cash', 'exclusive', 1300,
         'eligible_non_cash', '{}'::jsonb, '{}'::jsonb,
         0, 10000, 0, 1300, 11300, 11300, 0, 11301,
         'CAD', '1 Billing Road', '2 Service Road', '416-555-0100',
         true, 'Due-now conservation regression', 'test', 'test'
       )`,
      [invalidDueId, `MBT-R-${invalidDueId.slice(0, 12).toUpperCase()}`]
    ),
    /mbt_frontdesk_charge_requests_due_now_conservation/u
  );

  const requestId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_frontdesk_charge_requests (
       charge_request_id, request_number, request_kind, status,
       payment_method, payment_category, tax_mode, tax_rate_basis_points,
       netsuite_export_policy, pricing_snapshot, netsuite_ready_snapshot,
       current_contract_total_minor, pre_tax_revenue_minor,
       included_hst_minor, added_hst_minor, request_total_minor,
       resulting_contract_total_minor, required_deposit_minor, due_now_minor,
       currency, billing_address_text, service_address_text, contract_telephone,
       order_from_150, reason, created_by, updated_by
     ) VALUES (
       $1, $2, 'aggregate_order', 'draft',
       'card', 'non_cash', 'exclusive', 1300,
       'eligible_non_cash', '{}'::jsonb, '{}'::jsonb,
       0, 10000, 0, 1300, 11300, 11300, 0, 11300,
       'CAD', '1 Billing Road', '2 Service Road', '416-555-0100',
       true, 'Line conservation regression', 'test', 'test'
     )`,
    [requestId, `MBT-R-${requestId.slice(0, 12).toUpperCase()}`]
  );
  const lineId = crypto.randomUUID();
  await assert.rejects(
    query(
      `INSERT INTO mbt_frontdesk_charge_request_lines (
         charge_request_line_id, charge_request_id, sequence_number,
         line_code, line_type, description, item_code,
         quantity_milli_units, unit_of_measure, unit_amount_minor,
         configured_amount_minor, pre_tax_amount_minor,
         included_hst_minor, added_hst_minor, customer_amount_minor,
         taxable, payment_timing, pricing_snapshot
       ) VALUES (
         $1, $2, 1, 'aggregate_hpb', 'aggregate_material', 'HPB', 'AGG_HPB',
         1000, 'YARD', 10000, 10000, 10000, 0, 1300, 12600,
         true, 'due_now', '{}'::jsonb
       )`,
      [lineId, requestId]
    ),
    /mbt_frontdesk_charge_request_lines_tax_conservation/u
  );
});

test("a valid non-cash request stores pre-tax lines and never creates a NetSuite outbox row", async () => {
  const requestId = crypto.randomUUID();
  const lineId = crypto.randomUUID();
  const outboxBefore = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  await query(
    `INSERT INTO mbt_frontdesk_charge_requests (
       charge_request_id, request_number, request_kind, status,
       payment_method, payment_category, tax_mode, tax_rate_basis_points,
       netsuite_export_policy, pricing_snapshot, netsuite_ready_snapshot,
       current_contract_total_minor, pre_tax_revenue_minor,
       included_hst_minor, added_hst_minor, request_total_minor,
       resulting_contract_total_minor, required_deposit_minor, due_now_minor,
       currency, billing_address_text, service_address_text, contract_telephone,
       order_from_150, reason, created_by, updated_by
     ) VALUES (
       $1, $2, 'aggregate_order', 'draft',
       'card', 'non_cash', 'exclusive', 1300,
       'eligible_non_cash', $3::jsonb, $4::jsonb,
       0, 10000, 0, 1300, 11300, 11300, 0, 11300,
       'CAD', '1 Billing Road', '2 Service Road', '416-555-0100',
       true, 'Valid migration regression', 'test', 'test'
     )`,
    [
      requestId,
      `MBT-R-${requestId.slice(0, 12).toUpperCase()}`,
      JSON.stringify({ schemaVersion: "mbt-customer-charge-v1" }),
      JSON.stringify({ schemaVersion: "mbt-netsuite-ready-customer-charge-v1", taxMode: "netsuite_calculated" })
    ]
  );
  await query(
    `INSERT INTO mbt_frontdesk_charge_request_lines (
       charge_request_line_id, charge_request_id, sequence_number,
       line_code, line_type, description, item_code,
       quantity_milli_units, unit_of_measure, unit_amount_minor,
       configured_amount_minor, pre_tax_amount_minor,
       included_hst_minor, added_hst_minor, customer_amount_minor,
       taxable, payment_timing, pricing_snapshot
     ) VALUES (
       $1, $2, 1, 'aggregate_hpb', 'aggregate_material', 'HPB', 'AGG_HPB',
       1000, 'YARD', 10000, 10000, 10000, 0, 1300, 11300,
       true, 'due_now', '{}'::jsonb
     )`,
    [lineId, requestId]
  );
  const retained = await query(
    `SELECT request_total_minor::int, added_hst_minor::int, netsuite_export_policy,
            netsuite_ready_snapshot->>'taxMode' AS netsuite_tax_mode
       FROM mbt_frontdesk_charge_requests
      WHERE charge_request_id = $1`,
    [requestId]
  );
  assert.deepEqual(retained.rows[0], {
    request_total_minor: 11_300,
    added_hst_minor: 1_300,
    netsuite_export_policy: "eligible_non_cash",
    netsuite_tax_mode: "netsuite_calculated"
  });
  const outboxAfter = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.equal(outboxAfter.rows[0].count, outboxBefore.rows[0].count);
});
