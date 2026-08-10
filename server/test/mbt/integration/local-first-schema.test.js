import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";

after(async () => {
  await closeDb();
});

test("LC01/LC03-R1: local item schema owns item type and rental period without duplicate prices", async () => {
  const columns = await query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_local_item_settings'
      ORDER BY ordinal_position`
  );
  assert.deepEqual(columns.rows.map(({ column_name }) => column_name), [
    "item_code",
    "display_name",
    "description",
    "category",
    "bin_type_id",
    "pricing_mode",
    "netsuite_mapping_local_key",
    "active",
    "revision",
    "created_by",
    "updated_by",
    "created_at",
    "updated_at",
    "system_owned",
    "applicable_service_types",
    "applicable_legacy_source_types",
    "item_type",
    "rental_period_days",
    "charge_basis",
    "density_lbs_per_yard"
  ]);
  const forbidden = new Set([
    "default_unit_amount_minor",
    "currency",
    "unit_of_measure",
    "netsuite_item_id"
  ]);
  assert.equal(columns.rows.some(({ column_name }) => forbidden.has(column_name)), false);

  const seeds = await query(
    `SELECT s.item_code, s.item_type, s.rental_period_days,
            s.category, s.pricing_mode,
            b.type_code AS bin_type_code,
            s.netsuite_mapping_local_key, s.active
       FROM mbt_local_item_settings s
       LEFT JOIN mbt_bin_types b ON b.bin_type_id = s.bin_type_id
      WHERE s.system_owned
      ORDER BY CASE s.item_code
        WHEN 'DELIVERY_CROSS_CHARGE' THEN 1
        WHEN '14YD' THEN 2
        WHEN '20YD' THEN 3
        WHEN '40YD' THEN 4
        WHEN 'DUMP' THEN 5
        ELSE 99 END`
  );
  assert.deepEqual(seeds.rows, [
    {
      item_code: "DELIVERY_CROSS_CHARGE",
      item_type: "delivery_fee",
      rental_period_days: null,
      category: "cross_charge",
      pricing_mode: "rate_card",
      bin_type_code: null,
      netsuite_mapping_local_key: "delivery_charge",
      active: true
    },
    {
      item_code: "14YD",
      item_type: "bin",
      rental_period_days: 14,
      category: "bin_charge",
      pricing_mode: "rental_item",
      bin_type_code: "14YD",
      netsuite_mapping_local_key: "bin_14yd",
      active: true
    },
    {
      item_code: "20YD",
      item_type: "bin",
      rental_period_days: 14,
      category: "bin_charge",
      pricing_mode: "rental_item",
      bin_type_code: "20YD",
      netsuite_mapping_local_key: "bin_20yd",
      active: true
    },
    {
      item_code: "40YD",
      item_type: "bin",
      rental_period_days: 14,
      category: "bin_charge",
      pricing_mode: "rental_item",
      bin_type_code: "40YD",
      netsuite_mapping_local_key: "bin_40yd",
      active: true
    },
    {
      item_code: "DUMP",
      item_type: "dump",
      rental_period_days: null,
      category: "dump",
      pricing_mode: "rate_card",
      bin_type_code: null,
      netsuite_mapping_local_key: null,
      active: true
    }
  ]);
  const retained = await query(
    "SELECT active FROM mbt_bin_types WHERE type_code = '30YD'"
  );
  assert.deepEqual(retained.rows, [{ active: true }]);
});

test("LC10: billing cases and immutable versions default to local-only intent", async () => {
  const columns = await query(
    `SELECT table_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'posting_mode'
        AND table_name IN ('mbt_billing_cases', 'mbt_billing_versions')
      ORDER BY table_name`
  );
  assert.deepEqual(columns.rows, [
    {
      table_name: "mbt_billing_cases",
      is_nullable: "NO",
      column_default: "'local_only'::text"
    },
    {
      table_name: "mbt_billing_versions",
      is_nullable: "NO",
      column_default: "'local_only'::text"
    }
  ]);
  const definitions = await query(
    `SELECT conrelid::regclass::text AS table_name,
            pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN ('mbt_billing_cases'::regclass, 'mbt_billing_versions'::regclass)
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%posting_mode%'
      ORDER BY conrelid::regclass::text`
  );
  assert.equal(definitions.rowCount, 2);
  assert.ok(definitions.rows.every(({ definition }) => (
    /local_only/.test(definition) && /netsuite_future/.test(definition)
  )));

  const immutableRevisionEvidence = await query(
    `SELECT is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_billing_versions'
        AND column_name = 'billing_case_revision_before'`
  );
  assert.deepEqual(immutableRevisionEvidence.rows, [{
    is_nullable: "YES",
    column_default: null
  }]);
  const revisionConstraint = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_billing_versions'::regclass
        AND conname = 'mbt_billing_versions_case_revision_before_positive'`
  );
  assert.equal(revisionConstraint.rowCount, 1);
  assert.match(revisionConstraint.rows[0].definition,
    /billing_case_revision_before IS NULL.*billing_case_revision_before > 0/is);
  const requiredForFutureWrites = await query(
    `SELECT convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_billing_versions'::regclass
        AND conname = 'mbt_billing_versions_revision_evidence_required'`
  );
  assert.equal(requiredForFutureWrites.rowCount, 1);
  assert.equal(requiredForFutureWrites.rows[0].convalidated, false);
  assert.match(requiredForFutureWrites.rows[0].definition,
    /billing_case_revision_before IS NOT NULL/i);
});

test("LC12: billing lines accept complete local identity while preserving legacy mapping identity", async () => {
  const columns = await query(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mbt_billing_lines'
        AND column_name IN (
          'local_item_code', 'local_item_revision', 'netsuite_item_mapping_key'
        )
      ORDER BY column_name`
  );
  assert.deepEqual(columns.rows, [
    { column_name: "local_item_code", is_nullable: "YES" },
    { column_name: "local_item_revision", is_nullable: "YES" },
    { column_name: "netsuite_item_mapping_key", is_nullable: "YES" }
  ]);
  const definitions = await query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'mbt_billing_lines'::regclass
        AND contype = 'c'`
  );
  const joined = definitions.rows.map(({ definition }) => definition).join("\n");
  assert.match(joined, /local_item_code IS NULL.*local_item_revision IS NULL/is);
  assert.match(joined, /local_item_code IS NOT NULL.*local_item_revision IS NOT NULL/is);
  assert.match(joined, /local_item_revision > 0/i);
  assert.match(joined, /local_item_code IS NOT NULL.*netsuite_item_mapping_key IS NOT NULL/is);
});

test("LC11: local-only chain and outbox guards are installed with named constraint errors", async () => {
  const trigger = await query(
    `SELECT t.tgname, p.proname
       FROM pg_trigger t
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND t.tgname IN (
          'trg_mbt_local_only_sales_order_chain',
          'trg_mbt_local_only_sales_order_outbox'
        )
      ORDER BY t.tgname`
  );
  assert.deepEqual(trigger.rows, [
    {
      tgname: "trg_mbt_local_only_sales_order_chain",
      proname: "mbt_reject_local_only_sales_order_chain"
    },
    {
      tgname: "trg_mbt_local_only_sales_order_outbox",
      proname: "mbt_reject_local_only_sales_order_outbox"
    }
  ]);

  const constraintText = await query(
    `SELECT p.proname, pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
      WHERE p.proname IN (
        'mbt_reject_local_only_sales_order_chain',
        'mbt_reject_local_only_sales_order_outbox'
      )
      ORDER BY p.proname`
  );
  assert.equal(constraintText.rowCount, 2);
  const definitions = new Map(constraintText.rows.map((row) => [row.proname, row.definition]));
  assert.match(definitions.get("mbt_reject_local_only_sales_order_chain"),
    /CONSTRAINT\s*=\s*'mbt_local_only_sales_order_chain'/i);
  assert.match(definitions.get("mbt_reject_local_only_sales_order_outbox"),
    /operation_type[\s\S]*create_sales_order[\s\S]*update_sales_order/i);
  assert.match(definitions.get("mbt_reject_local_only_sales_order_outbox"),
    /CONSTRAINT\s*=\s*'mbt_local_only_sales_order_outbox'/i);
});

test("LC04: immutable policy columns reject direct identity drift", async () => {
  const original = await query(
    "SELECT revision::int AS revision FROM mbt_local_item_settings WHERE item_code = '20YD'"
  );
  await assert.rejects(
    () => query(
      "UPDATE mbt_local_item_settings SET netsuite_mapping_local_key = $1 WHERE item_code = '20YD'",
      [`hostile_${crypto.randomUUID().replaceAll("-", "")}`]
    ),
    (error) => error?.code === "55000"
  );
  const afterState = await query(
    "SELECT revision::int AS revision FROM mbt_local_item_settings WHERE item_code = '20YD'"
  );
  assert.deepEqual(afterState.rows, original.rows);
});
