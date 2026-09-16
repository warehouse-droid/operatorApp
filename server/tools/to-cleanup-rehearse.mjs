import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, listDeliveryOrders } from "../src/delivery-repository.js";
import { getReceivingOrder, listReceivingOrders } from "../src/receiving-repository.js";
import { listFulfilledTransferStates } from "../src/dispatch-fulfilled-to-repository.js";
import { readTransferCleanupState, createTransferCleanupManifest, applyTransferCleanupManifest, transferCleanupSummary, digest } from "./to-cleanup-repository.mjs";
import { openTransferLines } from "./to-cleanup-domain.mjs";
const directory = "test-artifacts/to-cleanup-20260915", input = `${directory}/production`;
const read = name => JSON.parse(readFileSync(`${input}/${name}`, "utf8"));
assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Captured data can only be replayed in an isolated test container");
assert.equal((await query("SELECT current_database() AS name")).rows[0].name, "mbt_test");
const captured = read("before.json"), manifest = read("manifest.json");
assert.equal(captured.claims.length, 0, "Active claims require their own reproduced fixtures");

async function insert(table, records) {
  if (!records.length) {return;}
  const columns = (await query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1
    AND is_generated='NEVER' ORDER BY ordinal_position`, [table])).rows.map(row => row.column_name)
    .filter(column => records.some(record => Object.hasOwn(record, column)));
  const names = columns.map(name => `"${name}"`).join(",");
  await query(`INSERT INTO ${table} (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [JSON.stringify(records)]);
}

try {
  assert.equal((await query("SELECT count(*)::int AS n FROM transfer_orders")).rows[0].n, 0, "Rehearsal requires an empty test database");
  await withTransaction(async () => {
    // Only this isolated seed bypasses links to unrelated historic actors/plans.
    // Target rows, both line stages and reconciliation evidence are exact copies.
    await query("SET LOCAL session_replication_role='replica'");
    await insert("transfer_orders", captured.orders);
    await insert("transfer_order_lines", captured.lines);
    await insert("dispatch_scm_to_splits", captured.splits);
    await insert("scm_reconciliation_order_state", captured.reconciliation);
    await insert("scm_transport_schedule", captured.schedules);
    await insert("receiving_receipt_records", captured.receipts);
    await insert("dispatch_order_completion_events", captured.completions.map(row => ({ ...row, id: row.completion_event_id,
      order_kind: "TO", actor_type: "system", reason: "Isolated copy of existing completion evidence" })));
    await query("SELECT setval(pg_get_serial_sequence('dispatch_order_completion_events','id'),COALESCE(max(id),1),max(id) IS NOT NULL) FROM dispatch_order_completion_events");
    for (const ref of captured.driverCompletedRefs) {
      await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,started_at,completed_at)
        VALUES($1,'isolated-to-rehearsal','dropoff',$2::jsonb,'complete',now(),now())`, [`isolated-to-${ref}`, JSON.stringify([ref])]);
    }
  });
  const before = await readTransferCleanupState();
  assert.deepEqual(before.orders, captured.orders); assert.deepEqual(before.lines, captured.lines);
  const recreated = createTransferCleanupManifest(before, manifest.remote);
  assert.deepEqual(recreated.entries.map(entry => ({ id: entry.id, guard: entry.guard, before: entry.before, after: entry.after })),
    manifest.entries.map(entry => ({ id: entry.id, guard: entry.guard, before: entry.before, after: entry.after })), "Captured candidate evidence was not reproduced exactly");
  assert.deepEqual(recreated.held, manifest.held);
  const rollback = await applyTransferCleanupManifest(manifest, { rollback: true });
  assert.equal(rollback.changedOrders, transferCleanupSummary(manifest).changedOrders);
  assert.deepEqual(await readTransferCleanupState(), before, "Rollback changed test fixtures");
  const applied = await applyTransferCleanupManifest(manifest), after = await readTransferCleanupState();
  const byId = new Map(after.orders.map(row => [String(row.netsuite_id), row]));
  for (const entry of manifest.entries) {
    assert.equal(byId.get(entry.id).outbound_operator_status, "loaded", entry.ref);
    assert.equal(openTransferLines(after.lines.filter(line => String(line.transfer_order_id) === entry.id)).length, 0, entry.ref);
    if (entry.receiving) {assert.equal(byId.get(entry.id).receiving_status, "received", entry.ref);}
    if (entry.guard.locallyCompleted) {for (const key of ["status", "status_text", "fulfillment_status", "fulfilled_at", "last_item_fulfillment_id"]) {
      assert.deepEqual(byId.get(entry.id)[key], entry.before.order[key], `Local delivery must not reconcile NetSuite: ${entry.ref}`);
    }}
  }
  for (const skipped of [...manifest.held, ...manifest.unchanged]) {
    assert.deepEqual(byId.get(skipped.id), captured.orders.find(row => String(row.netsuite_id) === skipped.id));
  }
  const active = await listDeliveryOrders({ status: "active", orderType: "transfer_order" });
  const selectedRefs = new Set(manifest.entries.map(entry => entry.ref));
  assert(!active.some(order => selectedRefs.has(order.tranid)), "Cleaned TO remains in active Delivery work");
  const receivingActive = await listReceivingOrders({ orderType: "transfer_order" });
  const receivedRefs = new Set(manifest.entries.filter(entry => entry.receiving).map(entry => entry.ref));
  assert(!receivingActive.some(order => receivedRefs.has(order.tranid)), "Cleaned received TO remains in active Receiving work");
  const samples = [...new Map([manifest.entries[0], ...manifest.entries.filter(entry => entry.guard.locallyCompleted).slice(0, 2),
    ...manifest.entries.filter(entry => entry.before.order.receiving_status !== entry.after.order.receiving_status).slice(0, 3)]
    .filter(Boolean).map(entry => [entry.id, entry])).values()];
  for (const entry of samples) {
    const delivery = await getDeliveryOrder(entry.id), receiving = await getReceivingOrder(entry.id);
    if (delivery) {assert.equal(delivery.operator_status, "loaded", entry.ref);}
    if (receiving && entry.receiving) {assert.equal(receiving.receipt_status, "received", entry.ref);}
  }
  const planning = await listFulfilledTransferStates(manifest.entries.map(entry => entry.ref));
  for (const entry of manifest.entries.filter(candidate => candidate.guard.locallyCompleted)) {assert.equal(planning.get(entry.ref.toLowerCase())?.eligible, false, entry.ref);}
  const repeated = await applyTransferCleanupManifest(manifest); assert.equal(repeated.changedOrders, 0);
  const report = { manifestSha256: digest(manifest), copiedOrders: captured.orders.length,
    copiedLines: captured.lines.length, ...applied, mode: "isolated-captured-transfer-rehearsal", rollbackVerified: true, idempotent: true, skippedOrdersPreserved: true,
    receivingFeedClear: true, deliveryFeedClear: true, localReplanningBlocked: manifest.entries.filter(entry => entry.guard.locallyCompleted).length,
    netSuitePlanningAllowed: manifest.entries.filter(entry => !entry.guard.locallyCompleted && planning.get(entry.ref.toLowerCase())?.eligible).length };
  writeFileSync(`${directory}/rehearsal.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally { await closeDb(); }
