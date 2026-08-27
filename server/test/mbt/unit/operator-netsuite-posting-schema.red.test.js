// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../migrations/178_operator_netsuite_posting_gates.sql", import.meta.url);

test("G1/P5/P6 migration seeds twelve off gates and durable exactly-once posting state", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const expectedKeys = [
    "operator_netsuite_customer_pickup_if_3445",
    "operator_netsuite_receiving_ir_3445",
    "operator_netsuite_delivery_prep_if_3445",
    "operator_netsuite_customer_pickup_if_2967",
    "operator_netsuite_receiving_ir_2967",
    "operator_netsuite_delivery_prep_if_2967",
    "operator_netsuite_customer_pickup_if_12441",
    "operator_netsuite_receiving_ir_12441",
    "operator_netsuite_delivery_prep_if_12441",
    "operator_netsuite_customer_pickup_if_150",
    "operator_netsuite_receiving_ir_150",
    "operator_netsuite_delivery_prep_if_150"
  ];
  for (const flagKey of expectedKeys) {
    assert.match(migration, new RegExp(`\\('${flagKey}',\\s*false,`, "u"), flagKey);
  }
  assert.equal((migration.match(/operator_netsuite_[a-z0-9_]+',\s*false,/gu) || []).length, 12);
  assert.match(migration, /ON CONFLICT \(flag_key\) DO NOTHING/u);

  for (const table of [
    "operator_netsuite_posting_commands",
    "operator_netsuite_posting_steps",
    "operator_netsuite_posting_order_claims",
    "operator_netsuite_posting_attempts"
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
  }

  assert.match(migration, /request_id uuid NOT NULL UNIQUE/u);
  assert.match(migration, /input_hash text NOT NULL/u);
  assert.match(migration, /gate_revision bigint NOT NULL/u);
  assert.match(migration, /external_id text NOT NULL UNIQUE/u);
  assert.match(migration, /payload_hash text NOT NULL/u);
  assert.match(migration, /UNIQUE \(command_id, source_order_kind, source_netsuite_id\)/u);
  assert.match(migration, /WHERE active = true/u);
  assert.match(migration, /lease_token uuid/u);
  assert.match(migration, /lease_expires_at timestamptz/u);
  assert.match(migration, /UNIQUE \(step_id, attempt_number\)/u);
  assert.match(migration, /CHECK \(function_key IN \('customer_pickup', 'receiving', 'delivery_prep'\)\)/u);
  assert.match(migration, /CHECK \(transaction_type IN \('IF', 'IR'\)\)/u);
});
