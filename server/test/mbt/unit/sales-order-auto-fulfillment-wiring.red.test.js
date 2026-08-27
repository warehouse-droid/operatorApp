// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relativePath) => readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8");

test("L5/L12 Delivery SO ownership changes without changing Customer Pickup or native TO ownership", async () => {
  const [admission, targets] = await Promise.all([
    source("src/operator-netsuite-posting-admission.js"),
    source("src/operator-netsuite-posting-targets.js")
  ]);
  assert.match(admission, /resolution\.netSuitePostingOwner === "driver_completion"/u);
  assert.match(admission, /reason: "driver_completion_owned"/u);
  assert.match(targets, /const netSuitePostingOwner = functionKey === "delivery_prep"/u);
  assert.match(targets, /\? "driver_completion"[\s\S]*: "operator"/u);
  assert.match(targets, /order_type === "sales_order"/u);
});

test("L6/L10 the scheduler is wired only to a Sales Order Item Fulfillment", async () => {
  const [adapter, runtime, server] = await Promise.all([
    source("src/sales-order-auto-fulfillment-netsuite-adapter.js"),
    source("src/sales-order-auto-fulfillment-runtime.js"),
    source("src/server.js")
  ]);
  assert.match(adapter, /sourceOrderKind: "SO"/u);
  assert.match(adapter, /transactionType: "IF"/u);
  assert.doesNotMatch(adapter, /sourceOrderKind: "(?:PO|TO|VRMA)"/u);
  assert.match(runtime, /config\.netsuite\?\.directAccessEnabled !== true/u);
  assert.match(runtime, /renew: renewSalesOrderAutoFulfillmentCandidateLease/u);
  assert.match(server, /startSalesOrderAutoFulfillmentRuntime\(\)/u);
});

test("L10/L11 schema defaults off, is append-only, and atomically fences gate cutovers", async () => {
  const [migration, repository] = await Promise.all([
    source("migrations/180_sales_order_completion_fulfillment.sql"),
    source("src/sales-order-auto-fulfillment-repository.js")
  ]);
  for (const yard of ["3445", "2967", "12441", "150"]) {
    assert.match(
      migration,
      new RegExp(`\\('dispatch_netsuite_sales_order_if_${yard}', false,`, "u")
    );
  }
  assert.match(migration, /trg_dispatch_so_po_execution_immutable/u);
  assert.match(migration, /trg_dispatch_sales_order_if_audit_immutable/u);
  assert.match(migration, /NEW\.order_kind <> 'SO'[\s\S]*'driver_job', 'manual_dispatch'/u);
  const candidateTrigger = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION dispatch_enqueue_sales_order_if_candidate"),
    migration.indexOf("DROP TRIGGER IF EXISTS trg_dispatch_enqueue_sales_order_if_candidate")
  );
  assert.doesNotMatch(candidateTrigger, /direct_dependency/u);
  assert.match(repository, /flag\.enabled = true/u);
  assert.match(repository, /candidate\.completion_event_id > watermark\.activation_event_id/u);
  assert.match(repository, /candidate\.gate_revision = flag\.revision/u);
  assert.match(repository, /WHERE status IN \('discovered', 'waiting_evidence', 'queued'\)/u);
  assert.doesNotMatch(repository, /WHERE status IN \([^)]*'uncertain'/u);
});
