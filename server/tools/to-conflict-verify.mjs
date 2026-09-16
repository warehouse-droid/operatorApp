import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, listDeliveryOrders } from "../src/delivery-repository.js";
import { getReceivingOrder, listReceivingOrders } from "../src/receiving-repository.js";
import { listFulfilledTransferStates } from "../src/dispatch-fulfilled-to-repository.js";
import { loadDispatchOrdersForResponse } from "../src/server.js";
import { readTransferCleanupState } from "./to-cleanup-repository.mjs";
import { createConflictManifest, conflictSummary } from "./to-conflict-repository.mjs";
pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=60000";
const directory = process.argv[2], manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8"));

async function verifyState() {
  const state = await readTransferCleanupState(), repeated = createConflictManifest(state, manifest.remote), summary = conflictSummary(repeated);
  assert.equal(summary.changedOrders, 0); assert.equal(summary.orders, manifest.entries.length);
  const planning = await listFulfilledTransferStates(manifest.entries.map(entry => entry.ref));
  for (const entry of manifest.entries) {
    const order = state.orders.find(row => String(row.netsuite_id) === entry.id);
    assert.equal(order.status, "G", entry.ref); assert.equal(order.receiving_status, "received", entry.ref); assert.equal(order.outbound_operator_status, "loaded", entry.ref);
    assert.equal(planning.get(entry.ref.toLowerCase())?.eligible, !entry.guard.locallyCompleted, entry.ref);
    for (const field of ["fulfilled_at", "received_at", "last_item_fulfillment_id", "last_item_receipt_id"]) {
      assert.deepEqual(order[field], entry.before.order[field], `Physical evidence changed: ${entry.ref}`);
    }
  }
  return summary;
}

async function projections() {
  const result = [];
  for (const entry of manifest.entries) {
    const delivery = await getDeliveryOrder(entry.id, { includeNetSuiteClosed: true });
    const receipt = await getReceivingOrder(entry.id, { includeNetSuiteClosed: true });
    assert.equal(delivery?.operator_status, "loaded", entry.ref);
    if (receipt) {assert.equal(receipt.receipt_status, "received", entry.ref);}
    assert.equal(delivery.warning_count, 0, entry.ref);
    result.push({ ref: entry.ref, operator: delivery.operator_status, receiving: receipt?.receipt_status || "outside Receiving worklist",
      warnings: delivery.warning_count, lines: delivery.lines.map(line => ({ id: line.id, item: line.item_name, quantity: line.quantity, loaded: line.loaded_qty, unit: line.unit })) });
  }
  return result;
}

async function verifyFeeds() {
  const refs = new Set(manifest.entries.map(entry => entry.ref));
  const active = await listDeliveryOrders({ status: "active", orderType: "transfer_order" });
  const receiving = await listReceivingOrders({ orderType: "transfer_order" });
  assert(!active.some(row => refs.has(row.tranid))); assert(!receiving.some(row => refs.has(row.tranid)));
  return { removedFromActiveDelivery: true, removedFromPendingReceiving: true };
}

async function dispatchSamples() {
  const samples = new Set(["TOB00956", ...manifest.entries.filter(entry => !entry.guard.locallyCompleted).slice(0, 2).map(entry => entry.ref),
    ...manifest.entries.filter(entry => entry.guard.locallyCompleted).slice(0, 2).map(entry => entry.ref)]);
  const result = [];
  for (const ref of samples) {
    const rows = await loadDispatchOrdersForResponse({ type: "TO", search: ref, exactOrderRefs: [ref], includeCompletedScmSearch: true });
    const order = rows.find(row => row.id === ref), entry = manifest.entries.find(row => row.ref === ref);
    assert(order, ref); assert.equal(order.dispatchCompletionStatus, "completed", ref);
    assert.equal(order.dispatchPlanningRestricted, entry.guard.locallyCompleted, ref);
    result.push({ ref, completed: order.dispatchCompletionStatus, planningAllowed: order.dispatchFulfilledTransferPlanningEligible,
      restricted: order.dispatchPlanningRestricted });
  }
  return result;
}

try {
  const report = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const summary = await verifyState(), orders = await projections(), feeds = await verifyFeeds(), dispatch = await dispatchSamples();
    return { verifiedAt: new Date().toISOString(), ...summary, orders, ...feeds, dispatch, blockers: [] };
  }, { rollback: true });
  writeFileSync(`${directory}/runtime-verification.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, orders: report.orders.length }));
} finally { await closeDb(); }
