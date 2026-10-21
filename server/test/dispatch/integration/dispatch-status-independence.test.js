import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { closeDb, query } from "../../../src/db.js";
import { scenario, seedSalesOrder, completeDriver } from "../support/fulfilled-so-fixture.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import { executeScmDependencyCommand } from "../../../src/scm-dependency-command-service.js";
import { overlayFulfilledSalesDeliveryPlanning } from "../../../src/dispatch-fulfilled-so-repository.js";

after(closeDb);
const actor = { id: "dispatch-status-test", sessionId: "dispatch-status-test", surface: "dispatch" };
const ref = "SO-STATUS-INDEPENDENT";
const id = 817158801;

async function fixture() {
  await seedSalesOrder(id, ref);
  await query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded',fulfillment_status='fulfilled' WHERE netsuite_id=$1", [id]);
  await query("UPDATE sales_order_lines SET loaded_qty=4,item_type='InvtPart',piece_qty=4,pallet_qty=0,to_pcs=1 WHERE sales_order_id=$1", [id]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active,receipt_status)
    VALUES($1,'PO-STATUS-INDEPENDENT','pendingReceipt','Purchase Order : Pending Receipt',true,'not_received')`, [id + 1]);
  return (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,piece_qty,to_pcs,netsuite_active)
    VALUES($1,1,817159900,'Test cargo','FULFILLED-TEST','InvtPart',4,'EA',4,1,true) RETURNING id`, [id + 1])).rows[0].id;
}

test("Pending Billing and Operator loaded quantities allow real PO link and unlink without resetting execution evidence", () => scenario(async () => {
  const poLineId = await fixture();
  const command = { action: "link_po", targetRef: ref, payload: { poRef: "PO-STATUS-INDEPENDENT", salesLineId: id, poLineId, quantities: { pieces: 1 } } };
  const preview = await previewScmDependencyMutation(command, actor);
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  const result = await executeScmDependencyCommand({ ...command, requestId: randomUUID(), payloadHash: createHash("sha256").update(JSON.stringify(command)).digest("hex") }, actor);
  assert.equal(result.status, "applied");
  const allocation = (await query("SELECT id FROM dispatch_so_po_allocations WHERE sales_order_ref=$1 AND status='active'", [ref])).rows[0];
  assert.ok(allocation);
  const unlink = { action: "unlink_po", targetRef: ref, payload: { allocationId: allocation.id } };
  await executeScmDependencyCommand({ ...unlink, requestId: randomUUID(), payloadHash: createHash("sha256").update(JSON.stringify(unlink)).digest("hex") }, actor);
  assert.equal((await query("SELECT status FROM dispatch_so_po_allocations WHERE id=$1", [allocation.id])).rows[0].status, "cancelled");
  assert.equal(Number((await query("SELECT loaded_qty FROM sales_order_lines WHERE id=$1", [id])).rows[0].loaded_qty), 4);
  assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1", [id])).rows[0].operator_status, "loaded");
}));

test("current Dispatch evidence clears cached NetSuite completion while preserving real delivery completion", () => scenario(async () => {
  await fixture();
  const order = { id: ref, type: "SO", dispatchCompletionStatus: "completed", dispatchCompletedAt: "2026-01-01",
    scm: { status: "Completed" }, operatorStatus: "loaded", fulfillmentStatus: "fulfilled" };
  const [pending] = await overlayFulfilledSalesDeliveryPlanning([order]);
  assert.equal(pending.dispatchCompletionStatus, "");
  assert.equal(pending.dispatchCompletedAt, null);
  assert.notEqual(pending.scm.status, "Completed");
  assert.equal(pending.operatorStatus, "loaded");
  assert.equal(pending.fulfillmentStatus, "fulfilled");
  await completeDriver(ref);
  const [completed] = await overlayFulfilledSalesDeliveryPlanning([order]);
  assert.equal(completed.dispatchCompletionStatus, "completed");
  assert.equal(completed.dispatchPlanningRestricted, true);
}));

test("Driver activity still blocks a dependency mutation when Operator status is ignored", () => scenario(async () => {
  await fixture();
  await completeDriver(ref, { stopType: "pickup", status: "in_progress" });
  const preview = await previewScmDependencyMutation({ action: "link_po", targetRef: ref, payload: { poRef: "PO-STATUS-INDEPENDENT" } }, actor);
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.some(blocker => blocker.code === "DRIVER_ACTIVITY_STARTED"));
}));
