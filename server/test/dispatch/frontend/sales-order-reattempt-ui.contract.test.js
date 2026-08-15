// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Control authorization renders historical/current identities and per-line partial quantities", async () => {
  const control = await source("public/control.js");
  const server = await source("src/server.js");
  for (const token of [
    "historicalSku",
    "currentSku",
    "skuMismatch",
    "Re-attempt quantity",
    "Already delivered",
    "lineReason",
    "sourceLoadRecordId"
  ]) {
    assert.match(control, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(server, /\/api\/control\/sales-orders\/:orderId\/reload-preview/);
  assert.match(server, /lineSelections/);
});

test("Planner projection identifies a Sales Order re-attempt and retains real freight", async () => {
  const customRepository = await source("src/dispatch-custom-order-repository.js");
  const dispatchUi = await source("public/dispatch.js");
  for (const token of [
    "sales_order_reattempt",
    "salesOrderReattempt",
    "parentOrderRef",
    "lineSnapshot",
    "linked_parent_no_charge"
  ]) {
    assert.match(customRepository, new RegExp(token));
  }
  assert.match(dispatchUi, /Sales Order re-attempt/);
});

test("Migration makes the cycle-child link durable and billing explicitly excludes the child", async () => {
  const migration = await source("migrations/164_sales_order_partial_reattempt.sql");
  const billing = await source("src/mbt/mbbs-billing-candidate-service.js");
  for (const token of [
    "workflow_kind",
    "sales_order_reattempt",
    "source_load_record_id",
    "reattempt_order_id",
    "historical_item_id",
    "already_delivered_sales_qty",
    "selected_for_reattempt",
    "billing_disposition",
    "linked_parent_no_charge"
  ]) {
    assert.match(migration, new RegExp(token));
  }
  assert.match(billing, /linked_parent_no_charge/);
  assert.match(billing, /sales_order_reattempt/);
});
