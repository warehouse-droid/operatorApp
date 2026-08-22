import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../migrations/176_special_stock_request_workflow.sql", import.meta.url);
const sequencingMigrationUrl = new URL("../../../migrations/177_special_stock_request_two_stage_handoff.sql", import.meta.url);

test("special-stock migration is gated off and models cases, lines, orders, media, handoff, and immutable events", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const relation of [
    "sales_special_stock_cases",
    "sales_special_stock_lines",
    "sales_special_stock_order_lines",
    "sales_special_stock_media",
    "sales_special_stock_handoffs",
    "sales_special_stock_events"
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${relation}\\b`, "u"));
  }
  assert.match(sql, /'special_stock_request_workflow',\s*false/u);
  assert.match(sql, /UNIQUE \(request_id, line_number\)/u);
  assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*sales_order_netsuite_id[\s\S]*IS NOT NULL/u);
  assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*purchase_order_netsuite_id[\s\S]*IS NOT NULL/u);
  assert.match(sql, /fulfillment_method IN \('vendor_pickup', 'yard_pickup', 'mbt_delivery'\)/u);
  assert.match(sql, /handoff_route IN \('none', 'direct', 'via_yard'\)/u);
  assert.match(sql, /unit_purchase_cost numeric/u);
  assert.match(sql, /operational_completion_source/u);
  assert.match(sql, /vendor_pickup_date date/u);
  assert.match(sql, /vendor_pickup_reference text/u);
});

test("two-stage handoff migration records durable per-line PO readiness", async () => {
  const sql = await readFile(sequencingMigrationUrl, "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS po_ready boolean NOT NULL DEFAULT false/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS po_ready_by text REFERENCES operators/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS po_ready_at timestamptz/u);
  assert.match(sql, /po_ready_response_revision integer/u);
  assert.match(sql, /sales_special_stock_line_po_ready_check/u);
  assert.match(sql, /purchase_order_netsuite_id IS NOT NULL/u);
});
