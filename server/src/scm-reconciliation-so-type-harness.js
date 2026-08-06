import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "./db.js";
import * as salesOrderReconciliation from "./sales-order-reconciliation.js";
import {
  createScmReconciliationRun,
  listLocalScmReconciliationSources
} from "./scm-reconciliation-repository.js";

assert.equal(
  typeof salesOrderReconciliation.normalizeSalesOrderReconciliationType,
  "function",
  "SO reconciliation needs one canonical Delivery/Pick-Up filter normalizer."
);
assert.equal(salesOrderReconciliation.normalizeSalesOrderReconciliationType("Delivery"), "delivery");
assert.equal(salesOrderReconciliation.normalizeSalesOrderReconciliationType("Pick-Up"), "pickup");
assert.equal(salesOrderReconciliation.normalizeSalesOrderReconciliationType("pickup"), "pickup");
assert.equal(salesOrderReconciliation.normalizeSalesOrderReconciliationType("all"), "all");
assert.equal(salesOrderReconciliation.normalizeSalesOrderReconciliationType("unknown"), "");
assert.equal(salesOrderReconciliation.normalizeSalesOrderReconciliationType("", "delivery"), "delivery");

const [
  serviceSource,
  netSuiteSource,
  controlSource,
  serverSource,
  migrationSource,
  dbOnlyMigrationSource
] = await Promise.all([
  "scm-reconciliation-service.js",
  "netsuite.js",
  "../public/control.js",
  "server.js",
  "../migrations/132_so_reconciliation_type_filter.sql",
  "../migrations/134_so_reconciliation_db_only.sql"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

assert.match(serviceSource, /soOrderType:\s*proposalRun\.soOrderType/,
  "Applying a reviewed dry run must preserve its exact SO type filter.");
assert.match(serviceSource, /soOrderType:\s*run\.soOrderType/,
  "Run source resolution and NetSuite discovery must use the persisted SO type filter.");
assert.match(serviceSource, /targetOnly\s*\?\s*"all"\s*:\s*run\.soOrderType/,
  "Exact-ID batches must not drop locally overridden Delivery/Pick-Up orders.");
assert.match(serviceSource, /filterDbBackedSalesOrderReconciliationCandidates/,
  "The reconciliation worker must enforce the local SO manifest after every NetSuite fetch.");
assert.match(serviceSource, /scope\s*===\s*"SO"[\s\S]*?resumeUsesFrozenTargets/,
  "A broad SO run must use exact local IDs instead of NetSuite discovery.");
assert.match(serviceSource, /SO_RECONCILIATION_LOCAL_SOURCE_MISSING/,
  "A targeted SO absent from the local DB must fail before any NetSuite fallback lookup.");
assert.match(netSuiteSource, /soOrderType/,
  "The NetSuite reconciliation query must accept the SO type filter.");
assert.match(netSuiteSource, /BUILTIN\.DF\(t\.custbody3\)/,
  "Broad NetSuite discovery must filter the Sales Order delivery-method field.");
assert.match(
  netSuiteSource,
  /NVL\(BUILTIN\.DF\(tl\.location\),\s*BUILTIN\.DF\(t\.location\)\)/,
  "SO reconciliation must resolve the line/header location text without passing NVL into BUILTIN.DF."
);
assert.doesNotMatch(
  netSuiteSource,
  /BUILTIN\.DF\(NVL\(tl\.location,\s*t\.location\)\)/,
  "NetSuite rejects BUILTIN.DF around an NVL location expression with UNEXPECTED_ERROR."
);
assert.match(serverSource, /soOrderType:\s*req\.body\?\.soOrderType/,
  "The Admin API must pass the selected SO type into the reconciliation service.");
assert.match(controlSource, /name="soOrderType"/,
  "The Admin form must expose an SO type selector.");
assert.match(controlSource, /option value="delivery"/,
  "The SO type selector must offer Delivery.");
assert.match(controlSource, /option value="pickup"/,
  "The SO type selector must offer Pick-Up.");
assert.match(controlSource, /body\.soOrderType = soOrderType/,
  "The Admin request must send the selected SO type.");
assert.match(migrationSource, /so_order_type_filter\s+text\s+NOT NULL\s+DEFAULT 'all'/i,
  "Historical runs must retain an explicit all-SO meaning after migration.");
assert.match(
  dbOnlyMigrationSource,
  /scm_reconciliation_order_state_order_kind_check[\s\S]*?order_kind\s+IN\s*\('SO',\s*'PO',\s*'TO'\)/i,
  "SO Skip persistence must use the same constrained state table as PO/TO."
);

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query(
      `UPDATE scm_reconciliation_runs
          SET status = 'interrupted', completed_at = now(), updated_at = now()
        WHERE status IN ('queued', 'running')`
    );
    const suffix = String(Date.now()).slice(-9);
    const deliveryId = 8_810_000_000 + Number(suffix);
    const pickupId = deliveryId + 1;
    const poId = deliveryId + 2;
    const deliveryRef = `TST-SO-DEL-${suffix}`;
    const pickupRef = `TST-SO-PICK-${suffix}`;
    const poRef = `TST-PO-${suffix}`;
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, status, status_text, sales_order_type,
         netsuite_active, is_test_fixture, synced_at
       ) VALUES
         ($1, $2, 'B', 'Sales Order : Pending Fulfillment', 'Delivery', true, false, now()),
         ($3, $4, 'B', 'Sales Order : Pending Fulfillment', 'Pick-Up', true, false, now())`,
      [deliveryId, deliveryRef, pickupId, pickupRef]
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, status, status_text, destination_location_id,
         destination_location, netsuite_active, synced_at
       ) VALUES (
         $1, $2, 'B', 'Purchase Order : Pending Receipt', 1,
         'SO Type Harness Yard', true, now()
       )`,
      [poId, poRef]
    );

    const deliverySources = await listLocalScmReconciliationSources({
      kind: "SO",
      soOrderType: "delivery"
    });
    assert.equal(deliverySources.some((source) => source.id === deliveryId), true);
    assert.equal(deliverySources.some((source) => source.id === pickupId), false,
      "Delivery reconciliation must not include Pick-Up Sales Orders.");

    const pickupSources = await listLocalScmReconciliationSources({
      kind: "SO",
      soOrderType: "pickup"
    });
    assert.equal(pickupSources.some((source) => source.id === pickupId), true);
    assert.equal(pickupSources.some((source) => source.id === deliveryId), false,
      "Pick-Up reconciliation must not include Delivery Sales Orders.");

    const mixedSources = await listLocalScmReconciliationSources({
      kind: "",
      soOrderType: "delivery"
    });
    assert.equal(mixedSources.some((source) => source.kind === "SO" && source.id === deliveryId), true);
    assert.equal(mixedSources.some((source) => source.kind === "SO" && source.id === pickupId), false,
      "All-scope filtering must affect only the SO portion of the source manifest.");
    assert.equal(mixedSources.some((source) => source.kind === "PO" && source.id === poId), true,
      "All-scope SO filtering must retain PO/TO sources.");

    const run = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "SO",
      soOrderType: "pickup",
      dryRun: true,
      requestedBy: "so-type-harness"
    });
    assert.equal(run.soOrderType, "pickup",
      "A run must return the same SO type filter it durably stored.");
    const stored = await query(
      "SELECT so_order_type_filter FROM scm_reconciliation_runs WHERE id = $1",
      [run.id]
    );
    assert.equal(stored.rows[0]?.so_order_type_filter, "pickup");
  });
  console.log("SCM SO Delivery/Pick-Up filter harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
