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

test("Completed current-item corrections are append-only, explicit, and visible", async () => {
  const migration = await source("migrations/179_sales_order_reattempt_current_item_corrections.sql");
  const server = await source("src/server.js");
  const control = await source("public/control.js");
  const customRepository = await source("src/dispatch-custom-order-repository.js");
  for (const token of [
    "sales_order_reattempt_item_corrections",
    "idempotency_key",
    "expected_state_fingerprint",
    "before_item_id",
    "after_item_id",
    "driver_completion_reconciliation",
    "operator_load_evidence_missing",
    "mbt_reject_immutable_mutation"
  ]) {
    assert.match(migration, new RegExp(token));
  }
  assert.match(server, /\/api\/control\/sales-order-reattempts\/:orderRef\/current-item-correction-preview/);
  assert.match(server, /\/api\/control\/sales-order-reattempts\/:orderRef\/current-item-corrections/);
  assert.match(server, /assertSalesOrderReattemptDriverReady/);
  assert.match(control, /Effective\/current item/);
  assert.match(control, /Historical first-attempt item/);
  assert.match(control, /Operator load evidence is absent/);
  assert.match(control, /currentQuantitySupportsTarget/);
  assert.match(control, /\(line\.skuMismatch \|\| line\.itemMismatch\) && !line\.identityCorrected/);
  assert.match(customRepository, /effectiveSku/);
  assert.match(customRepository, /historicalSku/);
});

test("Correction controls remain tappable in the mobile Control layout", async () => {
  const control = await source("public/control.js");
  const css = await source("public/control.css");
  assert.match(control, /sales-order-physical-confirmation/);
  assert.match(control, /lockSalesOrderReloadPage/);
  assert.match(control, /unlockSalesOrderReloadPage/);
  assert.match(css, /\.sales-order-physical-confirmation\s*\{[^}]*grid-template-columns:\s*28px minmax\(0, 1fr\)/su);
  assert.match(css, /\.sales-order-reload-panel\s*\{[^}]*overflow-x:\s*hidden/su);
  assert.match(css, /\.sales-order-reload-modal\s*\{[^}]*overflow-y:\s*auto/su);
  assert.match(css, /html\.sales-order-reload-open,[\s\S]*?body\.sales-order-reload-open\s*\{[^}]*overflow:\s*hidden/u);
  assert.match(css, /@media \(max-width: 720px\)\s*\{[^}]*\.photo-lightbox\s*\{[^}]*padding:\s*12px/su);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.loaded-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
});
