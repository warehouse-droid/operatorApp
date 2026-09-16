import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { getDeliveryOrder } from "../../../src/delivery-repository.js";
import { getReceivingOrder, listReceivingOrders, listReceivingSources, searchReceivingItems } from "../../../src/receiving-repository.js";
import { readTransferCleanupState, createTransferCleanupManifest, applyTransferCleanupManifest, transferCleanupSummary, digest } from "../../../tools/to-cleanup-repository.mjs";
import { scenario, completeDriver } from "../support/fulfilled-so-fixture.js";
import { seedTransfer } from "../support/fulfilled-to-fixture.js";
after(closeDb);
const remote = (id, ref, status = "G") => ({ mode: "netsuite-read-only-select", transactionType: "TrnfrOrd", completedAt: new Date().toISOString(),
  rows: [{ id: String(id), tranid: ref, status, status_text: `Transfer Order : ${status === "G" ? "Received" : "Pending Receipt"}` }] });

test("TO apply changes both stages independently, preserves history and repeats with zero changes", () => scenario(async () => {
  const id = 827151001, ref = "TO-CLEANUP-APPLY";
  await seedTransfer(id, ref, { status: "B", scheduleStatus: "Queued" });
  const before = await readTransferCleanupState(), manifest = createTransferCleanupManifest(before, remote(id, ref));
  assert.equal(manifest.entries.length, 1);
  const result = await applyTransferCleanupManifest(manifest);
  assert.equal(result.changedOutboundLines, 1); assert.equal(result.changedReceivingLines, 1);
  assert.equal(result.addedCompletions, 1); assert.equal(result.protectedStateUnchanged, true);
  const delivery = await getDeliveryOrder(id), receiving = await getReceivingOrder(id);
  assert.equal(delivery.operator_status, "loaded"); assert.equal(delivery.lines[0].loaded_qty, "40");
  assert.equal(receiving.receipt_status, "received");
  assert.equal(receiving.lines.length, 0, "No remaining Receiving cargo after verified complete receipt");
  const repeat = await applyTransferCleanupManifest(manifest); assert.equal(repeat.changedOrders, 0);
  assert.equal(transferCleanupSummary(createTransferCleanupManifest(await readTransferCleanupState(), manifest.remote)).changedOrders, 0);
}));

test("Driver-delivered TO becomes Loaded directly; NetSuite and physical receipt evidence stay unchanged", () => scenario(async () => {
  const id = 827151002, ref = "TO-CLEANUP-LOCAL";
  await seedTransfer(id, ref, { status: "B", scheduleStatus: "Planned" }); await completeDriver(ref);
  const before = await readTransferCleanupState(), manifest = createTransferCleanupManifest(before, { ...remote(id, ref), rows: [] });
  assert.equal(manifest.entries[0].guard.locallyCompleted, true);
  await applyTransferCleanupManifest(manifest);
  const after = await readTransferCleanupState(), header = after.orders.find(row => row.tranid === ref);
  assert.equal(header.status, "B"); assert.equal(header.receiving_status, "not_received");
  assert.equal(header.outbound_operator_status, "loaded"); assert.equal(after.completions.length, before.completions.length);
  assert.deepEqual(after.lines.filter(row => row.line_stage === "receiving"), before.lines.filter(row => row.line_stage === "receiving"));
}));

test("confirmed Received TO leaves pending Receiving even when local delivery preserves a cached Pending Receipt label", () => scenario(async () => {
  const id = 827151004, ref = "TO-CLEANUP-LOCAL-RECEIVED";
  await seedTransfer(id, ref, { status: "F", scheduleStatus: "Planned" }); await completeDriver(ref);
  const manifest = createTransferCleanupManifest(await readTransferCleanupState(), remote(id, ref));
  await applyTransferCleanupManifest(manifest);
  const detail = await getReceivingOrder(id);
  assert.equal(detail.status, "F", "Direct Loaded path preserves cached NetSuite status");
  assert.equal(detail.receipt_status, "received");
  assert.equal((await listReceivingOrders({ orderType: "transfer_order" })).some(row => row.tranid === ref), false);
  assert.equal((await listReceivingSources()).length, 0);
  assert.equal((await searchReceivingItems({ orderType: "transfer_order", search: "Transfer cargo" })).length, 0);
}));

test("stale TO manifest is rejected before writes and rollback rehearsal leaves the database unchanged", () => scenario(async () => {
  const id = 827151003, ref = "TO-CLEANUP-STALE";
  await seedTransfer(id, ref);
  const before = await readTransferCleanupState(), manifest = createTransferCleanupManifest(before, remote(id, ref));
  await query("UPDATE transfer_orders SET memo='new operator work' WHERE netsuite_id=$1", [id]);
  await assert.rejects(applyTransferCleanupManifest(manifest), /projection changed|before-image stale/);
  const changed = await readTransferCleanupState();
  assert.equal(changed.orders[0].outbound_operator_status, before.orders[0].outbound_operator_status);
  assert.equal(digest(changed.lines), digest(before.lines));
}));
