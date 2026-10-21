import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { previewOperatorOrderReopen, reopenOperatorOrder, searchOperatorReopenOrders } from "../../../src/operator-order-reopen-repository.js";
import { getDeliveryOrder } from "../../../src/delivery-repository.js";
import { getOperatorProgressDetails } from "../../../src/operator-order-progress-repository.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import fs from "node:fs";
import { reopenFixture, packedFields, resetInput, state, seedReopenGroup } from "../../support/control-order-reopen-fixture.mjs";
after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });

for (const kind of ["co_order", "vrma_order"]) {
  test(`${kind} returns to its Operator open state with retained photos`, () => rollback(async () => {
    const f = await reopenFixture();
    const ref = `${kind === "co_order" ? "CO" : "VRMA"}-${crypto.randomUUID()}`;
    const headerTable = kind === "co_order" ? "local_co_orders" : "scm_vrma_orders";
    const lineTable = kind === "co_order" ? "local_co_order_lines" : "scm_vrma_order_lines";
    const parent = kind === "co_order" ? "co_id" : "vrma_order_id";
    const vendor = `Reopen Vendor ${ref}`, yard = `Reopen Destination ${ref}`;
    if (kind === "vrma_order") {
      await query("INSERT INTO dispatch_local_vendors(name,active) VALUES($1,true)", [vendor]);
      await query("INSERT INTO dispatch_vendor_yards(vendor,yard,address,active) VALUES($1,$2,'100 Test Street',true)", [vendor, yard]);
    }
    const row = kind === "co_order" ? (await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,
      to_location_id,to_location,status,delivery_order_id,loaded_at,details,preparing_operator_id,preparing_started_at)
      VALUES($1,$2,1,'3445',26,'150','packed',-($3::bigint),now(),'{"sourceLoaded":true}', $4,now()) RETURNING *`,
    [ref, f.ref, f.id, f.packer.id])).rows[0] : (await query(`INSERT INTO scm_vrma_orders(vrma_ref,local_vendor,pickup_location,dropoff_location,
      operator_status,local_yard_order_status,loaded_at,preparing_operator_id,preparing_started_at)
      VALUES($1,$3,'3445',$4,'packed','Loaded',now(),$2,now()) RETURNING *`, [ref, f.packer.id, vendor, yard])).rows[0];
    const line = kind === "co_order" ? (await query(`INSERT INTO local_co_order_lines(co_id,line_id,item_id,item_name,quantity,unit,
      pallet_qty,layer_qty,section_qty,piece_qty,to_pcs,packed_piece_qty,packed_sales_qty,confirmed_at)
      VALUES($1,1,889201,'Local reopen',12,'PC',0,0,0,12,1,12,12,now()) RETURNING *`, [row.id])).rows[0]
      : (await query(`INSERT INTO scm_vrma_order_lines(vrma_order_id,item_id,item_name,quantity,unit,packed_piece_qty,
        packed_sales_qty,confirmed,confirmed_at,loaded_qty,loaded_uom) VALUES($1,889201,'Local reopen',12,'PC',12,12,true,now(),6,'PC') RETURNING *`, [row.id])).rows[0];
    const record = (await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,operator_id,photo_data_urls)
      VALUES('delivery_load',$1,$2,$3,$4,$5::jsonb) RETURNING *`, [kind, kind === "co_order" ? row.delivery_order_id : row.id, ref, f.packer.id, JSON.stringify(f.photos)])).rows[0];
    const preview = await previewOperatorOrderReopen({ orderRef: ref, actor: f.actor });
    assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
    const result = await reopenOperatorOrder(resetInput(f, preview, { orderRef: ref }));
    assert.equal(result.retainedPhotoCount, 2);
    const header = (await query(`SELECT * FROM ${headerTable} WHERE id=$1`, [row.id])).rows[0];
    assert.equal(header[kind === "co_order" ? "status" : "operator_status"], kind === "co_order" ? "pending_load" : "open");
    assert.equal(header.loaded_at, null);
    assert.equal(header.preparing_operator_id, null);
    const finalLine = (await query(`SELECT * FROM ${lineTable} WHERE ${parent}=$1`, [row.id])).rows[0];
    for (const field of packedFields) { assert.equal(Number(finalLine[field]), 0); }
    assert.equal(finalLine.confirmed_at, null);
    assert.equal(finalLine.quantity, line.quantity);
    assert.deepEqual((await query("SELECT * FROM operator_load_records WHERE id=$1", [record.id])).rows[0], record);
    const detail = await getDeliveryOrder(kind === "co_order" ? ref : `VRMA:${ref}`);
    assert.equal(detail.operatorReopen.retainedPhotoCount, 2);
  }));
}

test("pending posting claim and active reload prevent reset and leave all evidence intact", () => rollback(async () => {
  const f = await reopenFixture();
  const id = crypto.randomUUID();
  await query(`INSERT INTO operator_netsuite_posting_commands(id,request_id,actor_operator_id,function_key,transaction_type,
    canonical_location_id,yard_code,gate_key,gate_revision,input_hash,input_snapshot,photo_refs)
    VALUES($1,$1,$2,'delivery_prep','IF',1,'3445','operator_netsuite_delivery_prep_if_3445',1,$3,'{}','[]')`, [id, f.packer.id, "0".repeat(64)]);
  await query(`INSERT INTO operator_netsuite_posting_order_claims(command_id,function_key,local_order_key)
    VALUES($1,'delivery_prep',$2)`, [id, `delivery_prep:sales_order:${f.id}`]);
  const initial = await state(f);
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.some(row => row.code === "OPERATOR_REOPEN_POSTING"));
  await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), { code: "OPERATOR_REOPEN_POSTING" });
  assert.deepEqual(await state(f), initial);
  await query("UPDATE operator_netsuite_posting_order_claims SET active=false,released_at=now() WHERE command_id=$1", [id]);
  await query(`INSERT INTO operator_reload_cycles(sales_order_id,order_ref,outbound_location_id,cycle_number,request_id,reason)
    VALUES($1,$2,1,1,$3,'Existing reload')`, [f.id, f.ref, crypto.randomUUID()]);
  const reload = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(reload.allowed, false);
  assert.ok(reload.blockers.some(row => row.code === "OPERATOR_REOPEN_RELOAD_ACTIVE"));
}));

test("search respects Control yards and literal wildcard input", () => rollback(async () => {
  const f = await reopenFixture();
  const foreign = await reopenFixture({ yard: 26 });
  assert.deepEqual(await searchOperatorReopenOrders({ search: foreign.ref, actor: f.actor }), []);
  const found = await searchOperatorReopenOrders({ search: f.ref.toLowerCase(), actor: f.actor });
  assert.equal(found.length, 1);
  assert.equal(found[0].orderRef, f.ref);
  assert.deepEqual(await searchOperatorReopenOrders({ search: "%%", actor: f.actor }), []);
  assert.deepEqual(await searchOperatorReopenOrders({ search: "__", actor: f.actor }), []);
}));

test("packing attribution survives a group audit with released preparing ownership", () => rollback(async () => {
  const f = await reopenFixture({ loaded: 0 });
  await query("UPDATE sales_orders SET preparing_operator_id=null,preparing_started_at=null WHERE netsuite_id=$1", [f.id]);
  await query("DELETE FROM delivery_audit_log WHERE order_id=$1", [f.id]);
  await query(`INSERT INTO delivery_audit_log(actor_operator_id,action,details) VALUES($1,'delivery.group.order.status',$2::jsonb)`,
    [f.packer.id, JSON.stringify({ status: "packed", childOrders: [Number(f.id)] })]);
  const details = await getOperatorProgressDetails([f.ref]);
  assert.equal(details[0].status, "packed");
  assert.equal(details[0].operator.id, f.packer.id);
}));

test("legacy loaded quantities with no load audit identify the order without inventing an operator", () => rollback(async () => {
  const f = await reopenFixture();
  await query("UPDATE sales_orders SET operator_status='open',preparing_operator_id=null,preparing_started_at=null WHERE netsuite_id=$1", [f.id]);
  await query("DELETE FROM operator_load_records WHERE id=$1", [f.record.id]);
  const preview = await previewScmDependencyMutation({ action: "link_po", targetRef: f.ref, payload: {} });
  const blocker = preview.blockers.find(row => row.code === "OPERATOR_ACTIVITY_STARTED");
  assert.match(blocker.message, /has loaded quantities; the operator was not recorded/u);
  assert.equal(blocker.details.orders[0].operator, null);
}));

test("a loaded source CO identifies its own ref and operator instead of the source SO packer", () => rollback(async () => {
  const f = await reopenFixture({ loaded: 0 });
  const coRef = `CO-ATTRIBUTION-${crypto.randomUUID()}`;
  await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,to_location,status,delivery_order_id,loaded_at)
    VALUES($1,$2,1,'3445','150','planned',-($3::bigint),now())`, [coRef, f.ref, f.id]);
  await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,operator_id)
    VALUES('local_co_load','co_order',-($1::bigint),$2,$3)`, [f.id, coRef, f.actor.id]);
  const preview = await previewScmDependencyMutation({ action: "link_po", targetRef: f.ref, payload: {} });
  const blocker = preview.blockers.find(row => row.code === "OPERATOR_ACTIVITY_STARTED");
  assert.ok(blocker.message.includes(coRef));
  assert.match(blocker.message, /loaded quantities.*Reopen Manager/u);
  assert.doesNotMatch(blocker.message, /Pat Packer/u);
}));

test("registered group preview resolves its members and rejects missing or repeated members", () => rollback(async () => {
  const first = await reopenFixture(), second = await reopenFixture();
  const groupRef = `GO-REOPEN-${crypto.randomUUID()}`;
  await seedReopenGroup(groupRef, [first.ref, second.ref]);
  const preview = await previewOperatorOrderReopen({ orderRef: groupRef, actor: first.actor });
  assert.equal(preview.orders.length, 2);
  const searched = await searchOperatorReopenOrders({ search: `${first.ref}+${second.ref}`, actor: first.actor });
  assert.equal(searched[0].orderType, "group_order");
  await assert.rejects(() => previewOperatorOrderReopen({ orderRef: first.ref + "+missing", actor: first.actor }), { status: 404 });
  await assert.rejects(() => previewOperatorOrderReopen({ orderRef: first.ref + "+" + first.ref, actor: first.actor }), { status: 404 });
}));

test("an untouched Open order and an owned preparing order are described without claiming they are packed", () => rollback(async () => {
  const f = await reopenFixture({ loaded: 0 });
  await query(`UPDATE sales_order_lines SET packed_pallet_qty=0,packed_layer_qty=0,packed_section_qty=0,packed_piece_qty=0,
    packed_sales_qty=0,confirmed=false,confirmed_at=null WHERE sales_order_id=$1`, [f.id]);
  await query("UPDATE sales_orders SET operator_status='open',preparing_operator_id=null,preparing_started_at=null WHERE netsuite_id=$1", [f.id]);
  const open = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(open.orders[0].progress, "open");
  await query("UPDATE sales_orders SET operator_status='preparing',preparing_operator_id=$2,preparing_started_at=now() WHERE netsuite_id=$1", [f.id, f.packer.id]);
  const preparing = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(preparing.orders[0].progress, "preparing");
  assert.equal(preparing.orders[0].operator.id, f.packer.id);
}));

test("receiving evidence and completed NetSuite steps prevent resetting an outbound TO", () => rollback(async () => {
  const f = await reopenFixture({ kind: "transfer_order" });
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,quantity,received_piece_qty,netsuite_active)
    VALUES($1,1,'receiving',889201,20,1,true)`, [f.id]);
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.ok(preview.blockers.some(row => row.code === "OPERATOR_REOPEN_RECEIVED"));
  await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), { code: "OPERATOR_REOPEN_RECEIVED" });
}));

test("legacy failed-fulfillment photo remains retained while a verified fulfillment blocks reset", () => rollback(async () => {
  const f = await reopenFixture();
  const record = (await query(`INSERT INTO delivery_fulfillment_records(order_id,operator_id,fulfillment_status,photo_data_url,photo_data_urls)
    VALUES($1,$2,'failed','data:image/jpeg;base64,AAAA','["data:image/jpeg;base64,AAAA"]') RETURNING id`, [f.id, f.packer.id])).rows[0];
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(preview.retainedPhotoCount, 3);
  assert.equal(preview.allowed, true);
  await query("UPDATE delivery_fulfillment_records SET item_fulfillment_id=123 WHERE id=$1", [record.id]);
  const verified = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.ok(verified.blockers.some(row => row.code === "OPERATOR_REOPEN_NETSUITE_EVIDENCE"));
}));

test("verified NetSuite transaction on a released claim cannot be silently reset", () => rollback(async () => {
  const f = await reopenFixture();
  const id = crypto.randomUUID();
  await query(`INSERT INTO operator_netsuite_posting_commands(id,request_id,actor_operator_id,function_key,transaction_type,
    canonical_location_id,yard_code,gate_key,gate_revision,input_hash,input_snapshot,photo_refs)
    VALUES($1,$1,$2,'delivery_prep','IF',1,'3445','operator_netsuite_delivery_prep_if_3445',1,$3,'{}','[]')`, [id, f.packer.id, "0".repeat(64)]);
  await query(`INSERT INTO operator_netsuite_posting_order_claims(command_id,function_key,local_order_key,active,released_at)
    VALUES($1,'delivery_prep',$2,false,now())`, [id, `delivery_prep:sales_order:${f.id}`]);
  await query(`INSERT INTO operator_netsuite_posting_steps(command_id,step_index,source_order_kind,source_netsuite_id,
    source_order_ref,transaction_type,external_id,payload_hash,payload,line_snapshot,netsuite_transaction_id)
    VALUES($1,1,'SO',$2,$3,'IF',$4,$5,'{}','[]',123)`, [id, f.id, f.ref, `reopen-${id}`, "0".repeat(64)]);
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.ok(preview.blockers.some(row => row.code === "OPERATOR_REOPEN_POSTING"));
  await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), { code: "OPERATOR_REOPEN_POSTING" });
}));

test("the additive correction migration is idempotent and a failed application rolls back", () => rollback(async () => {
  const migration = fs.readFileSync(new URL("../../../migrations/281_operator_order_reopens.sql", import.meta.url), "utf8");
  await query(migration);
  await query(migration);
  assert.equal((await query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='operator_order_reopens'::regclass AND NOT tgisinternal")).rows[0].count, 1);
  await query("DROP TABLE operator_order_reopens");
  await assert.rejects(() => withTransaction(() => query(migration + "\nSELECT nonexistent_migration_function();")), /does not exist/u);
  assert.equal((await query("SELECT to_regclass('operator_order_reopens') AS name")).rows[0].name, null);
}));
