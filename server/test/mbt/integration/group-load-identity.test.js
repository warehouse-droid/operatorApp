import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getDeliveryOrder, recordDeliveryLoad, unpackDeliveryLine } from "../../../src/delivery-repository.js";
import { assertNoCoSourcePacking } from "../../../src/co-source-packing-handoff.js";
import { packingOrder, packingGroup, packingState } from "../../support/group-underpack-fixture.mjs";

after(closeDb);
const scenario = run => withTransaction(run, { rollback: true });
const photos = { photoDataUrls: ["data:image/png;base64,dGVzdDE=", "data:image/png;base64,dGVzdDI="] };
const actor = "group-identity-operator";

async function fixture({ transfer = false, extraLine = false } = {}) {
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,'Group identity test','test','test','operator',ARRAY['operator'],true)", [actor]);
  const children = [await packingOrder({ transfer }), await packingOrder({ transfer })];
  const originalGroup = await packingGroup(children);
  const groupId = transfer ? "GTO-8601-8604" : "GOA-8601-8604";
  await query(`INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type)
    SELECT $2,plan_id,plan_date,order_type FROM dispatch_delivery_groups WHERE group_ref=$1`, [originalGroup, groupId]);
  await query("UPDATE dispatch_delivery_group_members SET group_ref=$2 WHERE group_ref=$1", [originalGroup, groupId]);
  await query("DELETE FROM dispatch_delivery_groups WHERE group_ref=$1", [originalGroup]);
  let unrelated;
  if (extraLine) {
    unrelated = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,
      quantity,unit,location_id,location,packed_piece_qty,packed_sales_qty,confirmed,confirmed_at,netsuite_active)
      VALUES($1,2,998190002,'Unrelated packing','UNRELATED','InvtPart',4,'PC',1,'3445',4,4,true,now(),true) RETURNING *`, [children[0].id])).rows[0];
  }
  const group = await getDeliveryOrder(groupId);
  assert.equal(group.is_dispatch_group, true);
  assert.equal(group.child_orders.length, 2);
  return { children, groupId, group, unrelated };
}

async function addCo(order, suffix = "test") {
  const ref = `CO-IDENTITY-${suffix}`;
  await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,to_location_id,to_location,status)
    VALUES($1,$2,1,'3445',28,'Other yard','pending_load')`, [ref, order.ref]);
  return ref;
}

async function loadRecords() {
  return (await query("SELECT * FROM operator_load_records ORDER BY id")).rows;
}

for (const transfer of [false, true]) {
  test(`${transfer ? "TO" : "SO"} group loads canonical children and retains group metadata`, () => scenario(async () => {
    const f = await fixture({ transfer });
    const result = await recordDeliveryLoad(f.groupId, actor, photos);
    assert.equal(result.groupLoad, true);
    assert.equal(result.sourceLoadRecords.length, 2);
    assert.equal(result.remainingLines, 0);
    assert.equal(result.localYardOrderStatus, "Loaded");
    for (const child of f.children) {
      const detail = await getDeliveryOrder(child.id);
      assert.equal(detail.operator_status, "loaded");
      assert.equal(Number(detail.lines[0].quantity), 93.26);
      assert.equal(Number(detail.lines[0].loaded_qty), 93.26);
      assert.equal(Number(detail.lines[0].packed_layer_qty), 0);
    }
    const records = (await loadRecords()).filter(row => row.response?.dispatchGroupId === f.groupId);
    assert.equal(records.length, 2);
    assert.ok(records.every(row => row.response.dispatchGroupId === f.groupId));
    const audit = (await query("SELECT * FROM delivery_audit_log WHERE action='delivery.group.order.load'")).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.groupId, f.groupId);
    assert.deepEqual(audit[0].details.childOrders.sort(), f.children.map(row => row.ref).sort());
  }));
}

test("CO on the second child blocks group loading before any child is changed", () => scenario(async () => {
  const f = await fixture();
  const coRef = await addCo(f.children[1]);
  const before = await Promise.all(f.children.map(packingState));
  const records = await loadRecords();
  await assert.rejects(recordDeliveryLoad(f.groupId, actor, photos), error =>
    error.code === "CO_SOURCE_PACKING_HANDOFF" && error.message.includes(coRef));
  assert.deepEqual(await Promise.all(f.children.map(packingState)), before);
  assert.deepEqual(await loadRecords(), records);
}));

test("invalid child quantities cannot partially load an otherwise valid group", () => scenario(async () => {
  const f = await fixture();
  await query("UPDATE sales_order_lines SET packed_layer_qty=9 WHERE id=$1", [f.children[1].lineId]);
  const before = await Promise.all(f.children.map(packingState));
  const records = await loadRecords();
  await assert.rejects(recordDeliveryLoad(f.groupId, actor, photos), { code: "DELIVERY_LOAD_VALIDATION_FAILED" });
  assert.deepEqual(await Promise.all(f.children.map(packingState)), before);
  assert.deepEqual(await loadRecords(), records);
}));

test("unpacking a virtual group line changes only its source lines and retains audit identity", () => scenario(async () => {
  const f = await fixture({ extraLine: true });
  const line = f.group.lines.find(row => row.sku === "PACKING-FIXTURE");
  assert.match(line.id, /^GRPLINE-/u);
  await unpackDeliveryLine(f.groupId, line.id, {}, actor);
  for (const child of f.children) {
    const updated = (await query("SELECT * FROM sales_order_lines WHERE id=$1", [child.lineId])).rows[0];
    for (const field of ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty", "loaded_qty"]) {
      assert.equal(Number(updated[field]), 0, field);
    }
    assert.equal(updated.confirmed, false);
    assert.equal(Number(updated.quantity), 93.26);
  }
  assert.deepEqual((await query("SELECT * FROM sales_order_lines WHERE id=$1", [f.unrelated.id])).rows[0], f.unrelated);
  const rows = (await query("SELECT * FROM delivery_audit_log WHERE action='delivery.group.line.unpack'")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line_id, null);
  assert.equal(rows[0].details.groupId, f.groupId);
  assert.equal(rows[0].details.groupLineId, line.id);
  assert.deepEqual(rows[0].details.childOrders.map(String).sort(), f.children.map(row => String(row.id)).sort());
}));

test("a failed group-unpack audit rolls back every child change", () => scenario(async () => {
  const f = await fixture({ extraLine: true });
  const before = await Promise.all(f.children.map(packingState));
  await query(`CREATE FUNCTION group_identity_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='delivery.group.line.unpack' THEN RAISE EXCEPTION 'group identity audit unavailable'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER group_identity_audit_fail BEFORE INSERT ON delivery_audit_log FOR EACH ROW EXECUTE FUNCTION group_identity_audit_fail()");
  const line = f.group.lines.find(row => row.sku === "PACKING-FIXTURE");
  await assert.rejects(unpackDeliveryLine(f.groupId, line.id, {}, actor), /group identity audit unavailable/u);
  assert.deepEqual(await Promise.all(f.children.map(packingState)), before);
}));

test("standalone SO handoff protection survives cancellation and source-yard scoping", () => scenario(async () => {
  const order = await packingOrder();
  const coRef = await addCo(order);
  const read = () => getDeliveryOrder(order.id);
  await assert.rejects(assertNoCoSourcePacking(await read()), { code: "CO_SOURCE_PACKING_HANDOFF" });
  await query("UPDATE local_co_orders SET from_location_id=28,from_location='Other yard' WHERE co_ref=$1", [coRef]);
  await assertNoCoSourcePacking(await read());
  await query("UPDATE local_co_orders SET from_location_id=1,from_location='3445',status='cancelled' WHERE co_ref=$1", [coRef]);
  const result = await recordDeliveryLoad(order.id, null, photos);
  assert.equal(result.remainingLines, 0);
}));

test("property: every canonical child is checked independently of position or virtual group ID", () => scenario(async () => {
  const children = [];
  for (let i = 0; i < 5; i += 1) {
    children.push(await packingOrder());
  }
  const coRef = await addCo(children[0]);
  const canonical = await Promise.all(children.map(row => getDeliveryOrder(row.id)));
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 4 }), fc.boolean(), fc.boolean(), async (ownerIndex, reverse, active) => {
    await query("UPDATE local_co_orders SET source_order_ref=$2,status=$3 WHERE co_ref=$1", [coRef, children[ownerIndex].ref, active ? "pending_load" : "cancelled"]);
    const group = { netsuite_id: reverse ? "GOA-8601-8604" : "GRP-PACKING-PROPERTY", order_type: "sales_order",
      is_dispatch_group: true, child_orders: reverse ? [...canonical].reverse() : canonical };
    if (active) {
      await assert.rejects(assertNoCoSourcePacking(group), { code: "CO_SOURCE_PACKING_HANDOFF" });
    } else {
      await assertNoCoSourcePacking(group);
    }
  }), { seed: 20260917, numRuns: 30, examples: [[4, false, true], [0, true, true], [2, false, false]] });
}));
