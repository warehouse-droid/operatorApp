import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { getDeliveryOrder } from "../../../src/delivery-repository.js";
import { getReceivingOrder, listReceivingOrders } from "../../../src/receiving-repository.js";
import { listFulfilledTransferStates } from "../../../src/dispatch-fulfilled-to-repository.js";
import { readTransferCleanupState } from "../../../tools/to-cleanup-repository.mjs";
import { createConflictManifest, applyConflictManifest } from "../../../tools/to-conflict-repository.mjs";
import { scenario, completeDriver } from "../support/fulfilled-so-fixture.js";
import { seedTransfer } from "../support/fulfilled-to-fixture.js";
after(closeDb);

async function fixture(id, ref, { missing = false, driver = false } = {}) {
  await seedTransfer(id, ref, { status: "B", scheduleStatus: "Queued" });
  await query("UPDATE transfer_order_lines SET netsuite_active=false,sync_exception='line_deleted',quantity=1120,pallet_qty=16,to_plt=70 WHERE transfer_order_id=$1 AND line_stage='receiving'", [id]);
  if (missing) await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [id]);
  if (driver) await completeDriver(ref);
  return { mode: "netsuite-read-only-select", transactionType: "TrnfrOrd", completedAt: new Date().toISOString(), requested: [{ netsuite_id: String(id), tranid: ref }],
    orders: [{ id, tranid: ref, kind: "TO", recordType: "TrnfrOrd", status: "G", statusText: "Transfer Order : Received",
      lines: ["outbound", "receiving"].map(stage => ({ stage, sourceLineKey: "1", sourceLineAliases: ["1"], logicalLineIdentity: "transfer-anchor:1",
        identityStatus: "exact", identityIssue: "", itemId: 827159900, itemName: "Transfer cargo", itemType: "InvtPart", itemTypeText: "Inventory Item",
        quantity: 840, unit: "EA", palletQty: 12, layerQty: 0, sectionQty: 0, pieceQty: 0, toPlt: 70, toLyr: 0, toSec: 0, toPcs: 1,
        cumulativeProgressQuantity: 840, locationId: stage === "outbound" ? 1 : 15, location: stage === "outbound" ? "3445" : "12441", raw: {} })) }] };
}

test("authoritative TO repair is atomic, stage-isolated, preserves history, and repeats with zero changes", () => scenario(async () => {
  const id = 827161001, ref = "TO-CONFLICT-APPLY";
  const remote = await fixture(id, ref);
  await seedTransfer(827161099, "TO-UNRELATED-CONFLICT", { status: "B" });
  const before = await readTransferCleanupState(), manifest = createConflictManifest(before, remote);
  const result = await applyConflictManifest(manifest);
  assert.equal(result.changedOrders, 1); assert.equal(result.protectedStateUnchanged, true);
  const after = await readTransferCleanupState();
  const target = after.lines.filter(row => String(row.transfer_order_id) === String(id));
  assert.equal(target.length, 2); assert(target.every(row => Number(row.quantity) === 840 && row.netsuite_active && row.sync_exception === null));
  assert.equal(target.find(row => row.line_stage === "outbound").loaded_qty, 840);
  assert.equal(target.find(row => row.line_stage === "receiving").netsuite_received_qty, 840);
  assert.deepEqual(after.protected, before.protected);
  assert.deepEqual(after.lines.filter(row => String(row.transfer_order_id) !== String(id)), before.lines.filter(row => String(row.transfer_order_id) !== String(id)));
  assert.equal((await getDeliveryOrder(id)).operator_status, "loaded");
  assert.equal((await getReceivingOrder(id)).receipt_status, "received");
  assert(!(await listReceivingOrders({ orderType: "transfer_order" })).some(row => row.tranid === ref));
  assert.equal((await listFulfilledTransferStates([ref])).get(ref.toLowerCase()).eligible, true);
  assert.equal((await applyConflictManifest(manifest)).changedOrders, 0);
}));

test("missing current NetSuite lines get canonical IDs once; Driver completion keeps replanning blocked", () => scenario(async () => {
  const id = 827161002, ref = "TO-CONFLICT-MISSING";
  const remote = await fixture(id, ref, { missing: true, driver: true });
  const before = await readTransferCleanupState(), manifest = createConflictManifest(before, remote);
  const result = await applyConflictManifest(manifest);
  assert.equal(result.insertedLines, 1);
  const after = await readTransferCleanupState();
  const receipt = after.lines.find(row => row.line_stage === "receiving");
  assert(Number(receipt.id) > 0); assert.equal(Number(receipt.quantity), 840);
  assert.equal(after.orders[0].status, "G", "The authoritative conflict follow-up refreshes cached NetSuite status too");
  for (const field of ["fulfilled_at", "last_item_fulfillment_id", "received_at", "last_item_receipt_id"]) assert.deepEqual(after.orders[0][field], before.orders[0][field]);
  assert.equal((await listFulfilledTransferStates([ref])).get(ref.toLowerCase()).eligible, false);
  assert.deepEqual(after.protected, before.protected);
  assert.equal((await applyConflictManifest(manifest)).insertedLines, 0);
}));

test("rollback and stale manifest rejection preserve every original line and header", () => scenario(async () => {
  const id = 827161003, ref = "TO-CONFLICT-STALE";
  const remote = await fixture(id, ref), before = await readTransferCleanupState();
  const manifest = createConflictManifest(before, remote);
  const rolled = await applyConflictManifest(manifest, { rollback: true });
  assert.equal(rolled.changedOrders, 1); assert.deepEqual(await readTransferCleanupState(), before);
  await query("UPDATE transfer_orders SET memo='new live work' WHERE netsuite_id=$1", [id]);
  await assert.rejects(applyConflictManifest(manifest), /changed|stale/);
  const after = await readTransferCleanupState();
  assert.deepEqual(after.lines, before.lines); assert.equal(after.orders[0].outbound_operator_status, before.orders[0].outbound_operator_status);
}));

test("active Operator work or a newly cancelled order rejects the conflict correction", () => scenario(async () => {
  const id = 827161004, ref = "TO-CONFLICT-CANCELLED";
  const remote = await fixture(id, ref), before = await readTransferCleanupState();
  const manifest = createConflictManifest(before, remote);
  await query("UPDATE scm_transport_schedule SET status='Cancelled' WHERE order_ref=$1", [ref]);
  await assert.rejects(applyConflictManifest(manifest), /restricted|eligible|review/);
  assert.deepEqual((await readTransferCleanupState()).lines, before.lines);
}));
