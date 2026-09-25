import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getReceivableReceivingOrder, buildItemReceiptPayload, recordReceivingReceipt } from "../../../src/receiving-repository.js";
import { fixture, orderId, parentId, actor, photos } from "../../support/receiving-followup-fixture.mjs";

after(closeDb);
test("concurrent finalization of one verified IR records and audits it once", async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  await withTransaction(fixture);
  try {
    const order = await getReceivableReceivingOrder(orderId);
    const input = { photoDataUrls: photos, payload: buildItemReceiptPayload(order, order.receivableLines),
      response: {}, itemReceiptId: 994070, itemReceiptTranid: "IR14645" };
    const results = await Promise.all(Array.from({ length: 8 }, () => recordReceivingReceipt(orderId, actor, input)));
    assert.ok(results.every(result => result.receiptStatus === "partial_received" && result.itemReceiptId === 994070));
    assert.equal((await query("SELECT id FROM receiving_receipt_records WHERE order_id=$1", [orderId])).rowCount, 1);
    assert.equal((await query("SELECT id FROM delivery_audit_log WHERE action='receiving.order.receive' AND details->>'receivingOrderId'=$1", [String(orderId)])).rowCount, 1);
  } finally {
    await withTransaction(async () => {
      await query("DELETE FROM receiving_receipt_records WHERE order_id=$1", [orderId]);
      await query("DELETE FROM delivery_audit_log WHERE actor_operator_id=$1", [actor]);
      await query("DELETE FROM dispatch_scm_po_splits WHERE split_po_id=$1", [orderId]);
      await query("DELETE FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])", [[orderId, parentId]]);
      await query("DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])", [[orderId, parentId]]);
      await query("DELETE FROM operators WHERE id=$1", [actor]);
    });
  }
});
