import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The release tool supplies the reviewed before-state and executes this source
// via stdin in the live application. No test container uses production data.
const expected = JSON.parse(process.env.DRIVER_REOPEN_BEFORE_STATE);
const mode = process.argv[2];
assert.ok(["repair", "verify"].includes(mode));
const source = name => pathToFileURL(path.resolve("src", name)).href;
const { pool, query, withTransaction, closeDb } = await import(source("db.js"));
pool.options.options = "-c jit=off -c statement_timeout=20000" + (mode === "verify" ? " -c default_transaction_read_only=on" : "");
const { loadDispatchOrdersForResponse } = await import(source("server.js"));
const { upsertDispatchOrderCatalog, listDispatchOrderPool } = await import(source("dispatch-order-catalog-repository.js"));
const { writeDispatchAudit } = await import(source("dispatch-audit-repository.js"));
const { DISPATCH_FLEET_PLANNING_LOCK } = await import(source("dispatch-fleet-status.js"));
const started = performance.now();
try {
  const result = await withTransaction(async () => {
    if (mode === "verify") {
      await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    } else {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    }
    const header = (await query("SELECT netsuite_id,tranid,status,fulfillment_status,netsuite_active,dispatch_planned FROM transfer_orders WHERE netsuite_id=1038306")).rows[0];
    assert.equal(header.tranid, "TOB01193");
    assert.equal(header.status, "B");
    assert.equal(header.netsuite_active, true);
    assert.equal(header.dispatch_planned, false);
    assert.equal(header.fulfillment_status, "not_fulfilled");
    assert.equal((await query("SELECT 1 FROM dispatch_order_completion_status WHERE order_ref='TOB01193'")).rowCount, 0);
    const events = (await query("SELECT to_jsonb(event)-'reopen_correction_id' AS event FROM dispatch_order_completion_events event WHERE upper(order_ref)='TOB01193' ORDER BY id")).rows.map(row => row.event);
    assert.deepEqual(events, expected.completionHistory);
    const drivers = (await query("SELECT id,md5(to_jsonb(record)::text) AS hash,status,jsonb_array_length(photo_data_urls) AS photos FROM driver_job_records record WHERE order_refs @> '[\"TOB01193\"]' ORDER BY id")).rows;
    assert.deepEqual(drivers.map(row => ({ id: Number(row.id), hash: row.hash, status: row.status, photos: row.photos })), expected.driverEvidence.map(({ id, hash, status, photos }) => ({ id, hash, status, photos })));
    const corrections = (await query("SELECT id,md5(to_jsonb(correction)::text) AS hash FROM driver_job_corrections correction WHERE id IN(80,81) ORDER BY id")).rows;
    assert.deepEqual(corrections.map(row => ({ id: Number(row.id), hash: row.hash })), expected.correctionEvidence);
    assert.equal((await query("SELECT 1 FROM dispatch_plan_order_assignments WHERE upper(order_ref)='TOB01193'")).rowCount, 0);
    const order = (await loadDispatchOrdersForResponse({ type: "TO", search: "TOB01193", exactOrderRefs: ["TOB01193"], includeCompletedScmSearch: true })).find(row => row.id === "TOB01193");
    assert.ok(order, "the reopened source order must be returned by Dispatch search");
    assert.notEqual(order.dispatchCompletionStatus, "completed");
    assert.notEqual(order.dispatchPlanningRestricted, true);
    let auditId = null;
    if (mode === "repair") {
      await upsertDispatchOrderCatalog({ orders: [order], source: "driver-pwa-reopen-repair" });
      const previous = await query("SELECT id FROM dispatch_audit_log WHERE action='driver_pwa_reopen_planning_repaired' AND order_id='TOB01193' AND source='driver-reopen-replan-20261006' LIMIT 1");
      if (previous.rowCount) {
        auditId = previous.rows[0].id;
      } else {
        const audit = await writeDispatchAudit({ action: "driver_pwa_reopen_planning_repaired", entityType: "transfer_order", entityId: "1038306", orderId: "TOB01193", operatorName: "User-authorized maintenance", source: "driver-reopen-replan-20261006", before: { activeCompletionCount: expected.activeCompletionCount, catalogueCount: expected.catalogueCount }, after: { activeCompletionCount: 0, searchable: true, eligible: true }, details: { correctionIds: [80,81], preservedCompletionEventId: expected.completionHistory[0].id, retainedDriverPhotos: drivers.reduce((sum, row) => sum + row.photos, 0) } });
        auditId = audit.id;
      }
    }
    const indexed = (await listDispatchOrderPool({ type: "TO", search: "TOB01193" })).orders.find(row => row.id === "TOB01193");
    assert.ok(indexed, "the indexed planning pool must also return TOB01193");
    assert.notEqual(indexed.dispatchCompletionStatus, "completed");
    assert.notEqual(indexed.dispatchPlanningRestricted, true);
    const eligible = (await query("SELECT eligible FROM dispatch_order_catalog_entries WHERE order_ref='TOB01193'")).rows[0];
    assert.equal(eligible.eligible, true);
    return { passed: true, mode, orderRef: order.id, sourceSearch: true, indexedSearch: true, planningEligible: true, unassigned: true, sourceStatus: order.scm?.status, activeCompletionCount: 0, completionHistoryPreserved: true, correctionHistoryPreserved: true, driverEvidencePreserved: true, driverStopsPending: drivers.every(row => row.status === "pending"), retainedDriverPhotoCount: drivers.reduce((sum, row) => sum + row.photos, 0), auditId };
  });
  console.log(JSON.stringify({ ...result, durationMs: Math.round(performance.now() - started), at: new Date().toISOString() }));
} finally { await closeDb(); }
