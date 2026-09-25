import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getReceivingOrder, getReceivableReceivingOrder, buildItemReceiptPayload, confirmReceivingLine, recordReceivingReceipt } from "../../../src/receiving-repository.js";
import { fixture, draft, posted, legacyReceipt, orderId, parentId, actor, photos } from "../../support/receiving-followup-fixture.mjs";

after(closeDb);
const scenario = run => withTransaction(run, { rollback: true });
const selected = command => command.steps[0].payload.item.items.filter(row => row.itemReceive);
const records = async () => (await query("SELECT * FROM receiving_receipt_records WHERE order_id=$1 ORDER BY id", [orderId])).rows;

test("IR14645 leaves only the 28-pallet line visible without rewriting the prior receipt or source rows", () => scenario(async () => {
  await fixture();
  const first = await draft();
  await posted(first);
  const receipt = await legacyReceipt(first);
  const before = (await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[]) ORDER BY id", [[parentId, orderId]])).rows;
  const order = await getReceivingOrder(orderId);
  assert.deepEqual(order.lines.map(row => [row.sku, Number(row.quantity)]), [["PALLET", 28]]);
  assert.deepEqual((await records())[0], receipt);
  assert.deepEqual((await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[]) ORDER BY id", [[parentId, orderId]])).rows, before);
}));

test("the pallet follow-up creates a distinct IR draft and omits the already completed NetSuite line", () => scenario(async () => {
  const f = await fixture();
  const first = await draft();
  await posted(first);
  const receipt = await legacyReceipt(first);
  await confirmReceivingLine(orderId, f.pallet.id, { salesQty: 28 }, actor);
  const next = await draft();
  assert.notEqual(next.steps[0].externalId, first.steps[0].externalId);
  assert.deepEqual(selected(next), [{ orderLine: 34, quantity: 28, itemReceive: true, location: 1 }]);
  assert.equal(next.steps[0].sourceNetSuiteId, parentId);
  assert.equal(next.steps[0].payload.memo, "SN1400625");
  assert.equal(next.steps[0].payload.custbody9, "SN1400625");
  assert.ok(!next.steps[0].payload.item.items.some(row => row.orderLine === 25));
  assert.deepEqual(next.steps[0].payload.item.items.filter(row => !row.itemReceive).map(row => row.orderLine), [1, 24]);
  await posted(next, 994071, "IR-SECOND");
  const result = await recordReceivingReceipt(orderId, actor, { photoDataUrls: photos,
    payload: next.inputSnapshot.localPayload, response: {}, itemReceiptId: 994071, itemReceiptTranid: "IR-SECOND" });
  assert.equal(result.receiptStatus, "received");
  assert.deepEqual((await getReceivingOrder(orderId)).lines, []);
  assert.equal((await records()).length, 2);
  assert.deepEqual((await records())[0], receipt);
}));

test("a newly recorded partial receipt immediately consumes its confirmations", () => scenario(async () => {
  await fixture();
  const order = await getReceivableReceivingOrder(orderId);
  const result = await recordReceivingReceipt(orderId, actor, { photoDataUrls: photos,
    payload: buildItemReceiptPayload(order, order.receivableLines), response: {}, itemReceiptId: 994070, itemReceiptTranid: "IR14645" });
  assert.equal(result.receiptStatus, "partial_received");
  assert.deepEqual((await getReceivingOrder(orderId)).lines.map(row => row.sku), ["PALLET"]);
  await assert.rejects(getReceivableReceivingOrder(orderId), /No confirmed lines/u);
}));

test("duplicate successful receipt evidence and failed attempts cannot consume extra quantity", () => scenario(async () => {
  await fixture();
  const first = await draft();
  await legacyReceipt(first);
  await legacyReceipt(first);
  await legacyReceipt(first, { id: 994072, status: "failed" });
  await legacyReceipt(first, { id: 994073, status: "submitted" });
  await legacyReceipt(first, { id: 994074, order: parentId });
  await query("UPDATE purchase_order_lines SET quantity=720,pallet_qty=20 WHERE purchase_order_id=$1 AND line_id=4737066", [orderId]);
  const order = await getReceivingOrder(orderId);
  assert.deepEqual(order.lines.map(row => [Number(row.line_id), Number(row.quantity)]), [[4737066, 360], [4851536, 28]]);
  assert.equal(Number(order.lines[0].received_pallet_qty), 0);
}));

test("recording the same verified IR twice is idempotent", () => scenario(async () => {
  await fixture();
  const order = await getReceivableReceivingOrder(orderId);
  const input = { photoDataUrls: photos, payload: buildItemReceiptPayload(order, order.receivableLines), response: {}, itemReceiptId: 994070, itemReceiptTranid: "IR14645" };
  const first = await recordReceivingReceipt(orderId, actor, input);
  assert.deepEqual(await recordReceivingReceipt(orderId, actor, input), first);
  assert.equal((await records()).length, 1);
}));

test("a partly received product can be freshly confirmed for its balance while earlier confirmations stay consumed", () => scenario(async () => {
  const f = await fixture();
  await query("UPDATE purchase_order_lines SET quantity=720,pallet_qty=20 WHERE id=$1", [f.children[0].id]);
  const first = await draft();
  await legacyReceipt(first);
  let order = await getReceivingOrder(orderId);
  assert.equal(Number(order.lines[0].quantity), 360);
  assert.equal(Number(order.lines[0].received_pallet_qty), 0);
  await assert.rejects(getReceivableReceivingOrder(orderId), /No confirmed lines/u);
  await confirmReceivingLine(orderId, f.children[0].id, { pallets: 10 }, actor);
  order = await getReceivableReceivingOrder(orderId);
  assert.deepEqual(order.receivableLines.map(row => Number(row.line_id)), [4737066]);
  const payload = buildItemReceiptPayload(order, order.receivableLines);
  assert.equal(payload.item.items.find(row => row.itemReceive).quantity, 360);
  const result = await recordReceivingReceipt(orderId, actor, { photoDataUrls: photos, payload, response: {}, itemReceiptId: 994071, itemReceiptTranid: "IR-SECOND" });
  assert.equal(result.receiptStatus, "partial_received");
  assert.deepEqual((await getReceivingOrder(orderId)).lines.map(row => row.sku), ["PALLET"]);
}));

test("a prior local-only receipt counts once by command and does not select a deselected pallet", () => scenario(async () => {
  await fixture();
  const first = await draft();
  await legacyReceipt(first, { id: null });
  await legacyReceipt(first, { id: null });
  const order = await getReceivingOrder(orderId);
  assert.deepEqual(order.lines.map(row => [row.sku, Number(row.quantity)]), [["PALLET", 28]]);
}));

test("a failed receipt audit rolls back the receipt and header together", () => scenario(async () => {
  await fixture();
  const order = await getReceivableReceivingOrder(orderId);
  const header = (await query("SELECT * FROM purchase_orders WHERE netsuite_id=$1", [orderId])).rows;
  await query(`CREATE FUNCTION receiving_followup_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='receiving.order.receive' THEN RAISE EXCEPTION 'receipt audit unavailable'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER receiving_followup_audit_fail BEFORE INSERT ON delivery_audit_log FOR EACH ROW EXECUTE FUNCTION receiving_followup_audit_fail()");
  await assert.rejects(recordReceivingReceipt(orderId, actor, { photoDataUrls: photos,
    payload: buildItemReceiptPayload(order, order.receivableLines), response: {}, itemReceiptId: 994070, itemReceiptTranid: "IR14645" }), /receipt audit unavailable/u);
  assert.deepEqual(await records(), []);
  assert.deepEqual((await query("SELECT * FROM purchase_orders WHERE netsuite_id=$1", [orderId])).rows, header);
}));

test("property: local receipt progress overlaps NetSuite totals and remains isolated to each line", () => scenario(async () => {
  const f = await fixture();
  await query("UPDATE purchase_order_lines SET received_pallet_qty=0,received_sales_qty=0,to_plt=0,pallet_qty=0 WHERE purchase_order_id=$1", [orderId]);
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), async (total, local, remote) => {
    await query("DELETE FROM receiving_receipt_records WHERE order_id=$1", [orderId]);
    await query("UPDATE purchase_order_lines SET quantity=$2,netsuite_received_qty=$3 WHERE id=$1", [f.children[0].id, total, remote]);
    await query(`INSERT INTO receiving_receipt_records(order_id,item_receipt_id,receipt_status,payload)
      VALUES($1,994070,'partial_received',$2)`, [orderId, JSON.stringify({ item: { items: [{ orderLine: 4737066, itemReceive: true, quantity: local }] } })]);
    const order = await getReceivingOrder(orderId);
    const line = order.lines.find(row => Number(row.line_id) === 4737066);
    const remaining = Math.max(total - Math.max(local, remote), 0);
    assert.equal(Number(line?.quantity || 0), remaining);
    assert.equal(Number(order.lines.find(row => Number(row.line_id) === 4851536).quantity), 28);
  }), { seed: 14645, numRuns: 35, examples: [[100, 40, 40], [100, 60, 40], [100, 40, 60]] });
}));
