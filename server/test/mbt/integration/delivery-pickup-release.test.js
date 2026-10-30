import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, closeDb, withTransaction, pool } from "../../../src/db.js";
import { upsertSalesOrders } from "../../../src/order-sync-repository.js";
import { updateSalesOrderLocalMethod } from "../../../src/dispatch-repository.js";
import { getDeliveryOrder } from "../../../src/delivery-repository.js";
import { packingOrder } from "../../support/group-underpack-fixture.mjs";

after(closeDb);
const scenario = callback => withTransaction(callback, { rollback: true });
const action = "delivery.packing.release_on_pickup";
const packedFields = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];

async function state(id) {
  return {
    header: (await query("SELECT * FROM sales_orders WHERE netsuite_id=$1", [id])).rows[0],
    lines: (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id", [id])).rows,
    audit: (await query("SELECT * FROM delivery_audit_log WHERE order_id=$1 AND action=$2 ORDER BY id", [id, action])).rows,
    loads: (await query("SELECT * FROM operator_load_records WHERE order_id=$1", [id])).rows
  };
}

async function change(id, method = "Pick-Up") {
  await query("UPDATE sales_orders SET sales_order_type=$2 WHERE netsuite_id=$1", [id, method]);
}

async function sync(id, method = "Pick-Up") {
  const previous = (await state(id)).header;
  await upsertSalesOrders([{ id, tranid: previous.tranid, trandate: "2026-10-22", status: "B", status_text: "Pending Fulfillment",
    delivery_method: method, delivery_method_id: method === "Pick-Up" ? 1 : 2, outbound_location_id: 1 }]);
}

function assertReleased(actual) {
  for (const line of actual.lines) {
    for (const field of packedFields) { assert.equal(Number(line[field]), 0, field); }
  }
  assert.equal(actual.header.preparing_operator_id, null);
  assert.equal(actual.header.preparing_started_at, null);
  assert.equal(actual.loads.length, 0);
}

test("NetSuite Delivery to Pick-Up releases active and inactive delivery packing atomically", async () => scenario(async () => {
  const order = await packingOrder(), unrelated = await packingOrder();
  await query("UPDATE sales_orders SET preparing_operator_id='fixture',preparing_started_at=now() WHERE netsuite_id=$1", [order.id]);
  await query(`UPDATE sales_order_lines SET packed_pallet_qty=1,packed_section_qty=2,packed_piece_qty=3,packed_sales_qty=4,
    confirmed=true,confirmed_at=now(),sync_exception='qty_reduced',sync_exception_at=now() WHERE sales_order_id=$1`, [order.id]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_type,quantity,packed_sales_qty,netsuite_active,
    sync_exception,sync_exception_at,confirmed,confirmed_at) VALUES($1,2,123,'InvtPart',10,10,false,'line_deleted',now(),true,now())`, [order.id]);
  const before = await state(order.id), untouched = await state(unrelated.id);
  await sync(order.id);
  const actual = await state(order.id);
  assertReleased(actual);
  assert.equal(actual.header.operator_status, "open");
  assert.equal(actual.header.local_yard_order_status, "Open");
  for (const line of actual.lines) {
    assert.equal(line.confirmed, false); assert.equal(line.confirmed_at, null);
    assert.equal(line.sync_exception, null); assert.equal(line.sync_exception_at, null);
  }
  assert.equal(actual.lines[1].netsuite_active, false);
  assert.equal(actual.audit.length, 1);
  assert.equal(actual.audit[0].details.fromMethod, "Delivery");
  assert.equal(actual.audit[0].details.toMethod, "Pick-Up");
  assert.equal(actual.audit[0].details.releasedLines.length, 2);
  assert.equal(Number(actual.audit[0].details.releasedLines[0].packed_layer_qty), Number(before.lines[0].packed_layer_qty));
  assert.deepEqual(await state(unrelated.id), untouched);
  const visible = await getDeliveryOrder(order.id);
  assert.equal(visible.delivery_method, "Pick-Up"); assert.equal(visible.operator_status, "open");
}));

test("Dispatch local override releases packing; a retained Delivery override suppresses a remote pickup change", async () => scenario(async () => {
  const local = await packingOrder();
  await updateSalesOrderLocalMethod(local.ref, { method: "Pick-Up", updatedBy: "test" });
  assertReleased(await state(local.id));
  assert.equal((await state(local.id)).audit.length, 1);
  const retained = await packingOrder();
  await query("UPDATE sales_orders SET sales_order_type_override=true WHERE netsuite_id=$1", [retained.id]);
  const before = await state(retained.id);
  await sync(retained.id);
  const actual = await state(retained.id);
  assert.equal(actual.header.sales_order_type, "Delivery");
  assert.deepEqual(actual.lines, before.lines); assert.equal(actual.audit.length, 0);
}));

test("repeat pickup sync preserves new pickup packing without duplicate release", async () => scenario(async () => {
  const order = await packingOrder();
  await sync(order.id);
  await query("UPDATE sales_order_lines SET packed_sales_qty=7,confirmed=true,confirmed_at=now() WHERE id=$1", [order.lineId]);
  const before = await state(order.id);
  await sync(order.id);
  const actual = await state(order.id);
  assert.deepEqual(actual.lines, before.lines); assert.equal(actual.audit.length, 1);
}));

test("other method transitions preserve packing", async () => scenario(async () => {
  for (const [from, to] of [["Pick-Up", "Delivery"], ["Other", "Pick-Up"], ["Delivery", "Other"], ["Delivery", "Delivery"]]) {
    const order = await packingOrder();
    await change(order.id, from);
    await query("UPDATE sales_order_lines SET packed_sales_qty=7 WHERE id=$1", [order.lineId]);
    const before = await state(order.id);
    await change(order.id, to);
    const actual = await state(order.id);
    assert.deepEqual(actual.lines, before.lines); assert.deepEqual(actual.audit, before.audit);
  }
}));

test("partial loads and fulfilled quantities survive release; complete loads keep their status and confirmation", async () => scenario(async () => {
  for (const complete of [false, true]) {
    const order = await packingOrder({ quantity: 10, salesOnly: true, packed: complete ? 0 : 6, loaded: complete ? 10 : 4 });
    await query(`UPDATE sales_order_lines SET loaded_uom='SQFT',fulfilled_pallet_qty=2,confirmed=true,confirmed_at=now() WHERE id=$1`, [order.lineId]);
    if (complete) { await query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded' WHERE netsuite_id=$1", [order.id]); }
    const before = await state(order.id);
    await change(order.id);
    const actual = await state(order.id);
    assertReleased(actual);
    for (const field of ["quantity", "loaded_qty", "loaded_uom", "fulfilled_pallet_qty", "netsuite_active"]) {
      assert.equal(actual.lines[0][field], before.lines[0][field], field);
    }
    assert.equal(actual.header.operator_status, complete ? "loaded" : "partial_loaded");
    assert.equal(actual.header.local_yard_order_status, complete ? "Loaded" : "Partial Loaded");
    if (complete) { assert.equal(actual.lines[0].confirmed, true); assert.deepEqual(actual.lines[0].confirmed_at, before.lines[0].confirmed_at); }
  }
}));

test("stale packed header and obsolete warnings clear even when quantities were already reset", async () => scenario(async () => {
  const order = await packingOrder({ packed: 0 });
  await query("UPDATE sales_order_lines SET sync_exception='qty_reduced',sync_exception_at=now() WHERE id=$1", [order.lineId]);
  await change(order.id);
  const actual = await state(order.id);
  assert.equal(actual.header.operator_status, "open"); assert.equal(actual.lines[0].sync_exception, null);
}));

test("rollback restores method, quantities, status and release audit together", async () => scenario(async () => {
  const order = await packingOrder(), before = await state(order.id);
  await withTransaction(async () => { await change(order.id); assert.equal((await state(order.id)).audit.length, 1); }, { rollback: true });
  assert.deepEqual(await state(order.id), before);
}));

test("concurrent Operator quantity lock rejects a method change retryably, then retry releases", async () => scenario(async () => {
  const order = await packingOrder(), before = await state(order.id), other = await pool.connect();
  try {
    await other.query("BEGIN");
    await other.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${order.id}`]);
    await assert.rejects(() => withTransaction(() => change(order.id)), { code: "40001" });
    assert.deepEqual(await state(order.id), before);
  } finally { await other.query("ROLLBACK"); other.release(); }
  await change(order.id); assertReleased(await state(order.id));
}));

test("pending consolidated load rejects the method change without changing its snapshot", async () => scenario(async () => {
  const order = await packingOrder();
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt)
    VALUES('pickup-release-test','pickup-release-test','Fixture','unused','unused')`);
  await query(`INSERT INTO operator_consolidated_loads(id,operator_id,location_id,snapshot,snapshot_hash,status)
    VALUES('a2588276-753b-4eb1-88b4-a29334445678','pickup-release-test',1,'{}','fixture','pending')`);
  await query(`INSERT INTO operator_consolidated_load_claims(batch_id,order_id)
    VALUES('a2588276-753b-4eb1-88b4-a29334445678',$1)`, [String(order.id)]);
  const before = await state(order.id);
  await assert.rejects(() => withTransaction(() => change(order.id)), /pending Consolidation Load/);
  assert.deepEqual(await state(order.id), before);
  assert.equal((await query("SELECT status FROM operator_consolidated_loads WHERE operator_id='pickup-release-test'")).rows[0].status, "pending");
}));

test("random source and loaded quantities remain unchanged while every packed unit releases", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 1000 }), async (quantity, loaded) => {
    await scenario(async () => {
      const order = await packingOrder({ quantity, loaded, salesOnly: true, packed: quantity });
      const before = await state(order.id);
      await change(order.id);
      const actual = await state(order.id); assertReleased(actual);
      assert.equal(actual.lines[0].quantity, before.lines[0].quantity);
      assert.equal(actual.lines[0].loaded_qty, before.lines[0].loaded_qty);
    });
  }), { numRuns: 25, seed: 10368 });
});
