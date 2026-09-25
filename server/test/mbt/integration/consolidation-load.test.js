import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before, after } from "node:test";
import { app } from "../../../src/server.js";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";
import { updateOperatorRoles } from "../../../src/auth-repository.js";
import { submitOperatorNetSuitePostingAction } from "../../../src/operator-netsuite-posting-controller.js";
import { assertOperatorUploadYard, assertOperatorOrderPhotoYard } from "../../../src/operator-yard-authorization.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import * as posting from "../../../src/operator-netsuite-posting-repository.js";
import { createOperatorNetSuitePostingProcessor } from "../../../src/operator-netsuite-posting-service.js";
import { verifyOperatorNetSuitePostingRecord } from "../../../src/operator-netsuite-posting-adapter.js";
import { finalizeOperatorNetSuitePosting } from "../../../src/operator-netsuite-posting-finalizer.js";
import { completeConsolidatedLoad, configureConsolidationLoadEvents } from "../../../src/consolidation-load-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { config } from "../../../src/config.js";
import { operatorNetSuitePostingRuntime } from "../../../src/operator-netsuite-posting-runtime.js";
import * as delivery from "../../../src/delivery-repository.js";
import { claimPostingPhoto, completePostingPhoto } from "../../../src/operator-netsuite-posting-photo-queue.js";

let server, base;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); await closeDb(); });
async function request(session, path, method = "GET", body) {
  const response = await fetch(`${base}/api/delivery/consolidation-loads${path}`, { method,
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
}
async function fixture() {
  const first = await seedOperatorPickup(), second = await seedOperatorPickup();
  const plan = (await query(`INSERT INTO dispatch_plans(plan_date,status)
    SELECT day::date,'confirmed' FROM generate_series(DATE '2097-01-01',DATE '2097-12-31',INTERVAL '1 day') day
    WHERE NOT EXISTS(SELECT 1 FROM dispatch_plans p WHERE p.plan_date=day::date) ORDER BY day LIMIT 1 RETURNING id,plan_date::text`)).rows[0];
  const truck = { plate: "CONSOL-TRUCK", loads: [{ id: `load-${plan.id}`, name: "Load 2", driverSequence: 2,
    stops: [first, second].map((order) => ({ id: `drop-${order.orderId}`, type: "drop", orderId: order.tranid })) }] };
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')", [plan.id,
    JSON.stringify([first, second].map((order) => ({ id: order.tranid, type: "SO" }))), JSON.stringify([truck])]);
  for (const order of [first, second]) {
    await query(`UPDATE sales_orders SET sales_order_type='Delivery',operator_status='packed',dispatch_planned=true,
      dispatch_plan_date=$2,dispatch_truck_plate='CONSOL-TRUCK',dispatch_load_name='Load 2' WHERE netsuite_id=$1`, [order.orderId, plan.plan_date]);
    await query("UPDATE sales_order_lines SET packed_piece_qty=20,confirmed=true WHERE id=$1", [order.lineId]);
  }
  return { first, second, plan, truck, orders: [first, second] };
}
async function preview(f) {
  const result = await request(f.first, "/preview", "POST", { locationId: 1, orderIds: f.orders.map((order) => order.orderId) });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
function photos(id) { return [1, 2].map((n) => `r2://operator/operator-consolidation-load-photo/2026/09/15/${id}/photo-${n}.jpg`); }

async function addTransfer(f) {
  const orderId = String(9_930_000_000 + crypto.randomInt(10_000_000)), tranid = `TO-CONSOL-${orderId}`;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,local_yard_order_status,fulfillment_status,netsuite_active,dispatch_planned,dispatch_plan_date,dispatch_truck_plate,dispatch_load_name)
    VALUES($1,$2,'B','Pending Fulfillment',1,'3445',28,'2967','packed','Open','not_fulfilled',true,true,$3,'CONSOL-TRUCK','Load 2')`, [orderId, tranid, f.plan.plan_date]);
  const line = (await query(`INSERT INTO transfer_order_lines(line_stage,transfer_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,
    location_id,location,piece_qty,to_pcs,packed_piece_qty,loaded_qty,netsuite_active,confirmed)
    VALUES('outbound',$1,1,889201,'Item A','ITEM-A','InvtPart',20,'PC',1,'3445',20,1,20,0,true,true) RETURNING id`, [orderId])).rows[0];
  const order = { orderId, tranid, lineId: String(line.id) };
  f.orders.push(order);
  f.truck.loads[0].stops.push({ id: `drop-${orderId}`, type: "drop", orderId: tranid });
  await query("UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb,trucks=$3 WHERE plan_id=$1", [f.plan.id, JSON.stringify([{ id: tranid, type: "TO" }]), JSON.stringify([f.truck])]);
  return order;
}

test("packed selection is scoped and preview retains original order quantities", async () => {
  const f = await fixture();
  const listed = await request(f.first, `/orders?locationId=1&planDate=${f.plan.plan_date}&truckPlate=CONSOL-TRUCK`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.orders.map((order) => order.netsuite_id).sort(), f.orders.map((order) => order.orderId).sort());
  const batch = await preview(f);
  assert.equal(batch.snapshot.orders.length, 2);
  assert.equal(batch.snapshot.orders[0].lines[0].packed_piece_qty, 20);
  assert.equal(batch.snapshot.assignment.loadId, `load-${f.plan.id}`);
});
test("loading commits both orders with shared photos and creates no Sales Order IF work", async () => {
  const f = await fixture(), batch = await preview(f), refs = photos(batch.id);
  const result = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: refs });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.status, "completed");
  const replay = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: refs });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, result.data.id);
  const records = (await query("SELECT order_id,photo_data_urls FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rows;
  assert.equal(records.length, 2);
  for (const record of records) assert.deepEqual(record.photo_data_urls, refs);
  const statuses = (await query("SELECT local_yard_order_status FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])", [f.orders.map((order) => order.orderId)])).rows;
  assert.ok(statuses.every((order) => order.local_yard_order_status === "Loaded"));
  assert.equal((await query("SELECT 1 FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1", [f.first.operator.id])).rowCount, 0);
  assert.equal((await query("SELECT 1 FROM dispatch_order_completion_events WHERE order_ref=ANY($1::text[])", [f.orders.map((order) => order.tranid)])).rowCount, 0);
});
test("stale quantities, missing photos and foreign evidence are rejected without loading", async () => {
  const f = await fixture(), batch = await preview(f);
  for (const refs of [[], photos(batch.id).slice(0, 1), photos(crypto.randomUUID())]) {
    assert.equal((await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: refs })).status, 400);
  }
  await query("UPDATE sales_order_lines SET packed_piece_qty=19 WHERE id=$1", [f.second.lineId]);
  const result = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "CONSOLIDATION_LOAD_STALE");
  assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rowCount, 0);
});
test("failed local finalization rolls back all orders and retries the retained batch once", async () => {
  const f = await fixture(), batch = await preview(f);
  await query(`CREATE FUNCTION consolidation_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.order_id = '${f.second.orderId}' THEN RAISE EXCEPTION 'Injected second-order failure'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER consolidation_test_fail BEFORE INSERT ON operator_load_records FOR EACH ROW EXECUTE FUNCTION consolidation_test_fail()");
  try {
    const failed = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) });
    assert.equal(failed.status, 200);
    assert.equal(failed.data.status, "pending");
    assert.match(failed.data.error, /Injected second-order failure/);
    assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rowCount, 0);
    const rows = (await query("SELECT loaded_qty,packed_piece_qty FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])", [f.orders.map((order) => order.orderId)])).rows;
    assert.ok(rows.every((row) => Number(row.loaded_qty) === 0 && Number(row.packed_piece_qty) === 20));
    const pending = await request(f.first, "/pending?locationId=1");
    assert.ok(pending.data.some((row) => row.id === batch.id));
    const mutation = await fetch(`${base}/api/delivery/orders/${f.first.orderId}/unpack`, { method: "POST", headers: { authorization: `Bearer ${f.first.token}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(mutation.status, 409);
    for (const [name, args] of deliveryEdits(f.first)) {
      await assert.rejects(delivery[name](...args), { code: "CONSOLIDATION_LOAD_ORDER_CLAIMED" }, name);
    }
    const held = await delivery.getDeliveryOrder(f.first.orderId);
    assert.equal(held.operator_status, "packed");
    assert.equal(Number(held.lines[0].packed_piece_qty), 20);
    await assert.rejects(submitOperatorNetSuitePostingAction({ functionKey: "delivery_prep", orderId: f.first.orderId,
      actorOperatorId: f.first.operator.id, clientLocationId: 1, photoRefs: photos(batch.id), requestId: crypto.randomUUID() }),
    { code: "CONSOLIDATION_LOAD_ORDER_CLAIMED" });
  } finally {
    await query("DROP TRIGGER consolidation_test_fail ON operator_load_records");
    await query("DROP FUNCTION consolidation_test_fail()");
  }
  const resumed = await request(f.first, `/${batch.id}/resume`, "POST", {});
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.status, "completed");
});

function deliveryEdits(order) {
  const id = order.orderId, line = order.lineId, actor = order.operator.id;
  return [
    ["confirmDeliveryLine", [id, line, { pieces: 1 }, actor]],
    ["confirmDeliveryLines", [id, [{ lineId: line, values: { pieces: 1 } }], actor]],
    ["setDeliveryLinePackedQuantity", [id, line, { pieces: 1 }, actor]],
    ["setConsolidationDeliveryLinePackedQuantity", [id, line, { pieces: 1 }, actor]],
    ["unpackDeliveryLine", [id, line, {}, actor]],
    ["unpackDeliveryOrder", [id, actor]],
    ["updateDeliveryStatus", [id, "open", actor]],
    ["releaseCurrentDeliveryDraft", [id, actor]],
    ["markConsolidationDeliveryOrderPacked", [id, actor]],
    ["releaseConsolidationDeliveryOrder", [id, actor]]
  ];
}

test("ordinary packing, saved drafts, consolidation picking and unpacking still work outside a pending load", async () => {
  const f = await fixture(), { orderId: id, lineId: line, operator } = f.first, actor = operator.id;
  const quantity = async () => Number((await delivery.getDeliveryOrder(id)).lines[0].packed_piece_qty);
  await delivery.unpackDeliveryOrder(id, actor);
  assert.equal(await quantity(), 0);
  await delivery.confirmDeliveryLine(id, line, { pieces: 5 }, actor);
  assert.equal(await quantity(), 5);
  assert.deepEqual(await delivery.confirmDeliveryLines(id, [{ lineId: line, values: { pieces: 3 } }], actor), { confirmed: 1, failures: [] });
  assert.equal(await quantity(), 8);
  await delivery.setDeliveryLinePackedQuantity(id, line, { pieces: 6 }, actor);
  assert.equal(await quantity(), 6);
  await delivery.updateDeliveryStatus(id, "packed", actor);
  assert.equal((await delivery.getDeliveryOrder(id)).operator_status, "packed");
  await delivery.unpackDeliveryLine(id, line, {}, actor);
  assert.equal(await quantity(), 0);
  await delivery.confirmDeliveryLine(id, line, { pieces: 4 }, actor);
  await delivery.releaseCurrentDeliveryDraft(id, actor);
  assert.equal(await quantity(), 0);
  assert.equal((await delivery.getDeliveryOrder(id)).preparing_operator_id, null);
  await delivery.setConsolidationDeliveryLinePackedQuantity(id, line, { pieces: 7 }, actor);
  assert.equal(await quantity(), 7);
  await delivery.markConsolidationDeliveryOrderPacked(id, actor);
  assert.equal((await delivery.getDeliveryOrder(id)).operator_status, "packed");
  await delivery.releaseConsolidationDeliveryOrder(id, actor);
  assert.equal(await quantity(), 7);
  await delivery.unpackDeliveryOrder(id, actor);
  assert.equal(await quantity(), 0);
  assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id=$1", [id])).rowCount, 0);
});
test("another operator and revoked yard cannot inspect or submit a batch", async () => {
  const f = await fixture(), batch = await preview(f);
  assert.equal((await request(f.second, `/${batch.id}`)).status, 403);
  assert.equal((await request(f.second, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) })).status, 403);
  await updateOperatorRoles(f.first.operator.id, { role: "operator", roles: ["operator"], operatorYardLocationIds: [28] });
  assert.equal((await request(f.first, `/${batch.id}`)).status, 403);
});
test("racing duplicate submissions record each original order once", async () => {
  const f = await fixture(), batch = await preview(f);
  const results = await Promise.all([1, 2].map(() => request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) })));
  assert.ok(results.every((result) => result.status === 200), JSON.stringify(results));
  assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rowCount, 2);
});

test("competing batches accept one load and reject overlapping work", async () => {
  const f = await fixture(), a = await preview(f), b = await preview(f);
  const results = await Promise.all([a, b].map((batch) => request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rowCount, 2);
});

test("invalid selections, foreign yards and changed assignments cannot be submitted", async () => {
  const f = await fixture();
  for (const orderIds of [[], [null], [""], ["hostile-id"], [f.first.orderId, f.first.orderId], ["99999999999999"]]) {
    const invalid = await request(f.first, "/preview", "POST", { locationId: 1, orderIds });
    assert.ok([400, 409].includes(invalid.status), JSON.stringify(invalid));
  }
  assert.equal((await request(f.first, "/orders?locationId=28")).status, 403);
  assert.equal((await request(f.first, "/invalid-id")).status, 400);
  assert.equal((await request(f.first, `/${crypto.randomUUID()}`)).status, 404);
  const batch = await preview(f);
  assert.equal((await request(f.first, `/${batch.id}/resume`, "POST", {})).status, 409);
  const trucks = [{ ...f.truck, plate: "REASSIGNED-TRUCK" }];
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1", [f.plan.id, JSON.stringify(trucks)]);
  const changed = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, "CONSOLIDATION_LOAD_STALE");
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [f.second.orderId]);
  assert.equal((await request(f.first, "/preview", "POST", { locationId: 1, orderIds: f.orders.map((order) => order.orderId) })).status, 403);
});

test("CO and VRMA orders share load photos while preserving their local transitions", async () => {
  const f = await fixture(), suffix = crypto.randomUUID(), coRef = `CO-CONSOL-${suffix}`, vrmaRef = `VRMA-CONSOL-${suffix}`;
  const coId = (await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,to_location_id,to_location,status,
    delivery_order_id,dispatch_plan_id,dispatch_plan_date,dispatch_truck_plate,dispatch_load_name)
    VALUES($1,$2,1,'3445',28,'2967','packed',$3,$4,$5,'CONSOL-TRUCK','Load 2') RETURNING id`, [coRef, f.first.tranid, -Number(f.first.orderId), f.plan.id, f.plan.plan_date])).rows[0].id;
  await query(`INSERT INTO local_co_order_lines(co_id,line_id,item_id,item_name,quantity,unit,piece_qty,to_pcs,packed_piece_qty)
    VALUES($1,1,889201,'Item A',20,'PC',20,1,20)`, [coId]);
  const vendor = `Consol Vendor ${suffix}`, yard = `Consol Vendor Yard ${suffix}`;
  await query("INSERT INTO dispatch_local_vendors(name,active) VALUES($1,true)", [vendor]);
  await query("INSERT INTO dispatch_vendor_yards(vendor,yard,address,active) VALUES($1,$2,'100 Test Street',true)", [vendor, yard]);
  const vrmaId = (await query(`INSERT INTO scm_vrma_orders(vrma_ref,local_vendor,pickup_location,dropoff_location,status,operator_status)
    VALUES($1,$2,'3445',$3,'Queued','packed') RETURNING id`, [vrmaRef, vendor, yard])).rows[0].id;
  await query(`INSERT INTO scm_vrma_order_lines(vrma_order_id,item_id,item_name,quantity,unit,packed_sales_qty,confirmed)
    VALUES($1,889201,'Item A',20,'PC',20,true)`, [vrmaId]);
  await query(`INSERT INTO dispatch_vrma_plan_assignments(plan_id,order_ref,plan_date,truck_plate,load_name)
    VALUES($1,$2,$3,'CONSOL-TRUCK','Load 2')`, [f.plan.id, vrmaRef, f.plan.plan_date]);
  f.orders.push({ orderId: String(-Number(f.first.orderId)), tranid: coRef }, { orderId: `VRMA:${vrmaRef}`, tranid: vrmaRef });
  f.truck.loads[0].stops.push(...[coRef, vrmaRef].map((ref) => ({ id: `drop-${ref}`, type: "drop", orderId: ref })));
  await query("UPDATE dispatch_plan_snapshots SET orders=orders || $2::jsonb,trucks=$3 WHERE plan_id=$1", [f.plan.id,
    JSON.stringify([{ id: coRef, type: "CO", childOrders: [f.first.tranid] }, { id: vrmaRef, type: "PO" }]), JSON.stringify([f.truck])]);
  const batch = await preview(f), events = [];
  configureConsolidationLoadEvents((type, payload) => events.push({ type, payload }));
  const loaded = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.data));
  assert.equal(loaded.data.status, "completed", loaded.data.error);
  assert.equal((await query("SELECT status FROM local_co_orders WHERE id=$1", [coId])).rows[0].status, "planned");
  assert.equal((await query("SELECT operator_status FROM scm_vrma_orders WHERE id=$1", [vrmaId])).rows[0].operator_status, "loaded");
  const records = (await query("SELECT photo_data_urls FROM operator_load_records WHERE response->>'consolidationLoadId'=$1", [batch.id])).rows;
  assert.equal(records.length, 4);
  assert.ok(records.every((record) => JSON.stringify(record.photo_data_urls) === JSON.stringify(photos(batch.id))));
  assert.ok(events.some((event) => event.type === "receiving.order.updated" && event.payload.activatedCo.some((co) => co.co_ref === coRef)));
  assert.ok(events.some((event) => event.type === "dispatch.co.updated"));
  assert.equal((await query("SELECT 1 FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1", [f.first.operator.id])).rowCount, 0);
});

test("Dispatch group selection expands original children without double loading or ambiguous assignments", async () => {
  const f = await fixture(), groupId = `GOA-CONSOL-${crypto.randomUUID()}`;
  const group = { id: groupId, type: "SO", childOrders: f.orders.map((order) => order.tranid),
    childOrderDetails: f.orders.map((order) => ({ id: order.tranid, type: "SO" })) };
  f.truck.loads[0].stops = [{ id: "group-drop", type: "drop", orderId: groupId }];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2,trucks=$3 WHERE plan_id=$1", [f.plan.id, JSON.stringify([group]), JSON.stringify([f.truck])]);
  await syncDispatchDeliveryGroupsFromPlan({ id: f.plan.id, planDate: f.plan.plan_date, status: "confirmed", orders: [group], trucks: [f.truck] });
  const listed = await request(f.first, `/orders?locationId=1&planDate=${f.plan.plan_date}`);
  assert.deepEqual(listed.data.orders.map((order) => order.netsuite_id).sort(), f.orders.map((order) => order.orderId).sort());
  const previewed = await request(f.first, "/preview", "POST", { locationId: 1, orderIds: [groupId] });
  assert.equal(previewed.status, 200, JSON.stringify(previewed.data));
  assert.equal(previewed.data.snapshot.orders.length, 2);
  assert.equal((await request(f.first, "/preview", "POST", { locationId: 1, orderIds: [groupId, f.first.orderId] })).status, 409);
  f.truck.loads.push({ ...f.truck.loads[0], id: "second-load" });
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1", [f.plan.id, JSON.stringify([f.truck])]);
  const ambiguous = await request(f.first, `/orders?locationId=1&planDate=${f.plan.plan_date}`);
  assert.deepEqual(ambiguous.data.orders, []);
  assert.equal((await request(f.first, `/${previewed.data.id}/submit`, "POST", { photoRefs: photos(previewed.data.id) })).status, 409);
  f.truck.loads.pop();
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1", [f.plan.id, JSON.stringify([f.truck])]);
  await updateOperatorRoles(f.first.operator.id, { role: "operator", roles: ["operator"], operatorYardLocationIds: [1, 28] });
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [f.second.orderId]);
  const scoped = await request(f.first, `/orders?locationId=1&planDate=${f.plan.plan_date}`);
  assert.deepEqual(scoped.data.orders.map((order) => order.netsuite_id), [f.first.orderId]);
  assert.equal((await request(f.first, "/preview", "POST", { locationId: 1, orderIds: [groupId] })).status, 403);
});

test("shared photo ownership and yard grants are enforced before upload or preview", async () => {
  const f = await fixture(), batch = await preview(f);
  const body = { recordType: "operator-consolidation-load-photo", orderId: batch.id, orderRef: "forged", source: "driver" };
  assert.equal(await assertOperatorUploadYard(f.first.operator, body), 1);
  assert.equal(body.orderRef, batch.id);
  assert.equal(body.source, "operator");
  await assertOperatorOrderPhotoYard(f.first.operator, photos(batch.id)[0]);
  await assert.rejects(assertOperatorUploadYard(f.second.operator, body), { status: 403 });
  await assert.rejects(assertOperatorOrderPhotoYard(f.second.operator, photos(batch.id)[0]), { status: 403 });
  const completed = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) });
  assert.equal(completed.data.status, "completed");
  await assert.rejects(assertOperatorUploadYard(f.first.operator, body), { status: 409 });
  await assertOperatorOrderPhotoYard(f.first.operator, photos(batch.id)[0]);
  const revoked = { ...f.first.operator, operatorYardLocationIds: [28] };
  await assert.rejects(assertOperatorOrderPhotoYard(revoked, photos(batch.id)[0]), { status: 403 });
  const replayChanged = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id).map((ref) => ref.replace("photo-", "retaken-")) });
  assert.equal(replayChanged.status, 409);
  assert.equal((await request(f.first, `/${batch.id}/resume`, "POST", {})).data.status, "completed");
});

test("mixed native Transfer Orders use the backend gate and keep Sales Order loading local", async () => {
  const f = await fixture();
  const transfer = await addTransfer(f), batch = await preview(f);
  const loaded = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id) });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.data));
  assert.equal(loaded.data.status, "completed");
  assert.equal(loaded.data.commandId, null, "The backend gate defaults off");
  assert.equal((await query("SELECT local_yard_order_status FROM transfer_orders WHERE netsuite_id=$1", [transfer.orderId])).rows[0].local_yard_order_status, "Loaded");
  assert.equal((await query("SELECT 1 FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1", [f.first.operator.id])).rowCount, 0);
});

test("durable native TO failures retain the whole load; verified remote steps are never duplicated on retry", async () => {
  const f = await fixture(), transfers = [await addTransfer(f), await addTransfer(f)], batch = await preview(f), refs = photos(batch.id);
  await query("UPDATE operator_consolidated_loads SET status='pending',photo_refs=$2 WHERE id=$1", [batch.id, JSON.stringify(refs)]);
  for (const order of f.orders) await query("INSERT INTO operator_consolidated_load_claims(batch_id,order_id) VALUES($1,$2)", [batch.id, order.orderId]);
  await completeConsolidatedLoad(batch.id, { preflight: true });
  assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rowCount, 0);
  const draft = buildOperatorNetSuitePostingDraft({ requestId: batch.id, actorOperatorId: f.first.operator.id, functionKey: "delivery_prep", transactionType: "IF",
    policy: { gateKey: "operator_netsuite_delivery_prep_if_3445", revision: 1, effective: true, functionKey: "delivery_prep", transactionType: "IF", locationId: 1, yardCode: "3445" },
    photoRefs: refs, localOrderKeys: batch.snapshot.orders.map((order) => `delivery_prep:${order.order_type}:${order.netsuite_id}`),
    localOperation: { kind: "delivery_consolidation_load", orderId: batch.id, orderType: "consolidation_load" },
    targets: transfers.map((order) => ({ sourceOrderKind: "TO", sourceNetSuiteId: order.orderId, sourceOrderRef: order.tranid,
      selectedLines: [{ orderLine: 2, quantity: 20, location: 1, localOrderKey: `delivery_prep:transfer_order:${order.orderId}`, localLineId: order.lineId }], availableLines: [{ orderLine: 2, location: 1 }] })) });
  const { command } = await posting.createOrReplayOperatorNetSuitePostingCommand(draft);
  await query("UPDATE operator_consolidated_loads SET command_id=$2 WHERE id=$1", [batch.id, command.id]);
  const remote = new Map(), writes = [], events = [];
  configureConsolidationLoadEvents((type, payload) => events.push({ type, payload }));
  let phase = "first-fails";
  const processor = createOperatorNetSuitePostingProcessor({ workerId: "consolidation-native-test", finalize: finalizeOperatorNetSuitePosting,
    repository: { get: posting.getOperatorNetSuitePostingCommand, claim: posting.claimOperatorNetSuitePostingCommand, renew: posting.renewOperatorNetSuitePostingLease,
      startAttempt: posting.startOperatorNetSuitePostingAttempt, success: posting.recordOperatorNetSuitePostingStepSuccess,
      failure: posting.recordOperatorNetSuitePostingStepFailure, attention: posting.markOperatorNetSuitePostingCommandAttention,
      fail: posting.failOperatorNetSuitePostingCommand, complete: posting.completeOperatorNetSuitePostingCommand },
    adapter: { findByExternalId: async (step) => remote.get(step.externalId) || null, verify: verifyOperatorNetSuitePostingRecord,
      fetchById: async (step) => remote.get(step.externalId), transform: async (step) => {
        if (phase === "first-fails" || (phase === "second-fails" && writes.length === 1)) throw Object.assign(new Error("Injected native TO rejection"), { status: 400, netsuiteResponseReceived: true });
        writes.push(step.sourceNetSuiteId);
        const record = { id: 8100 + writes.length, tranId: `IF-TEST-${writes.length}`, transactionType: "IF", externalId: step.externalId,
          createdFromId: step.sourceNetSuiteId, item: { items: step.payload.item.items } };
        remote.set(step.externalId, record); return { id: record.id };
      } }
  });
  for (const expectedWrites of [0, 1]) {
    const failed = await processor.process(command.id);
    assert.equal(failed.status, "attention");
    assert.equal(writes.length, expectedWrites);
    assert.equal((await request(f.first, `/${batch.id}`)).data.status, "pending");
    assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rowCount, 0);
    assert.equal(events.length, 0);
    await posting.resumeOperatorNetSuitePostingCommand(command.id);
    phase = expectedWrites === 0 ? "second-fails" : "success";
  }
  const completed = await processor.process(command.id);
  assert.equal(completed.status, "completed", completed.lastError);
  assert.equal(writes.length, 2);
  assert.deepEqual([...new Set(writes)].sort(), transfers.map((order) => Number(order.orderId)).sort());
  assert.equal((await request(f.first, `/${batch.id}`)).data.status, "completed");
  const records = (await query("SELECT photo_data_urls,response FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rows;
  assert.equal(records.length, 4);
  assert.ok(records.every((record) => JSON.stringify(record.photo_data_urls) === JSON.stringify(refs)));
  assert.equal(events.filter((event) => event.type === "delivery.order.loaded").length, 4);
  assert.equal((await query("SELECT 1 FROM operator_consolidated_load_claims WHERE batch_id=$1 AND active", [batch.id])).rowCount, 0);
  await processor.process(command.id);
  assert.equal(writes.length, 2);
});

test("HTTP admission with the native gate enabled posts only TO and resumes the retained batch", async () => {
  const f = await fixture(), transfer = await addTransfer(f), batch = await preview(f);
  const previous = { ...config.netsuite }, fetchBoundary = globalThis.fetch, calls = [];
  let allowTransform = false, savedRecord = null;
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'test-consolidation-token',now()+INTERVAL '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='operator_netsuite_delivery_prep_if_3445'");
  config.netsuite.directAccessEnabled = true;
  config.netsuite.restBaseUrl = "https://netsuite.invalid/services/rest";
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin === base) return fetchBoundary(input, options);
    assert.equal(url.hostname, "netsuite.invalid", "No real external requests are permitted");
    calls.push({ path: url.pathname, method: options.method, body: options.body });
    if (url.pathname.endsWith("/suiteql")) {
      const sql = JSON.parse(options.body).q;
      if (sql.includes('FROM location l')) return json({ items: [{ id: 1 }, { id: 28 }, { id: 15 }, { id: 26 }], hasMore: false });
      if (sql.includes("next_transaction.id")) return json({ items: savedRecord ? [{ id: savedRecord.id }] : [], hasMore: false });
      if (sql.includes("NextTransactionLineLink")) return json({ items: [], hasMore: false });
      assert.match(sql, /t\.type AS record_type/);
      return json({ hasMore: false, items: [-20, -20, 20].map((quantity, index) => ({ id: Number(transfer.orderId), record_type: "TrnfrOrd", tranid: transfer.tranid,
        order_line_number: index + 2, source_line_key: String(index + 1), do_not_print_line: index === 0 ? "F" : "T", line_sequence_number: index + 1,
        item_id: 889201, item_name: "Item A", item_type: "InvtPart", signed_quantity: quantity, ordered_quantity: 20,
        cumulative_progress_quantity: 0, progress_raw: 0, unit: "PC", source_location_id: 1, destination_location_id: 28, to_pcs: 1 })) });
    }
    if (url.pathname.includes("/!transform/")) {
      assert.match(url.pathname, new RegExp(`/transferorder/${transfer.orderId}/!transform/itemfulfillment$`));
      if (!allowTransform) return json({ error: "Injected native rejection" }, 400);
      const payload = JSON.parse(options.body);
      savedRecord = { id: 88001, tranId: "IF-CONSOL-TEST", transactionType: "IF", externalId: payload.externalId,
        createdFromId: Number(transfer.orderId), item: payload.item };
      return json({}, 201, { location: "https://netsuite.invalid/services/rest/record/v1/itemFulfillment/88001" });
    }
    if (url.pathname.includes("/itemFulfillment/")) return json(savedRecord);
    assert.match(url.pathname, new RegExp(`/transferOrder/${transfer.orderId}$`));
    return json({ item: { items: [{ orderLine: 2, item: { id: "889201" }, quantity: 20 }] } });
  };
  try {
    const accepted = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: photos(batch.id), queueIf: true });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.commandId, batch.id);
    await operatorNetSuitePostingRuntime.enqueue(batch.id);
    assert.equal((await posting.getOperatorNetSuitePostingCommand(batch.id)).status, "attention");
    assert.equal((await request(f.first, `/${batch.id}`)).data.status, "pending");
    allowTransform = true;
    assert.equal((await request(f.first, `/${batch.id}/resume`, "POST", {})).status, 200);
    assert.equal((await request(f.first, `/${batch.id}/resume`, "POST", {})).status, 200);
    await operatorNetSuitePostingRuntime.enqueue(batch.id);
    const completed = await request(f.first, `/${batch.id}`);
    assert.equal(completed.data.status, "completed", completed.data.error);
    const command = await posting.getOperatorNetSuitePostingCommand(batch.id);
    assert.equal(command.steps.length, 1);
    assert.equal(command.steps[0].sourceOrderKind, "TO");
    assert.equal(command.steps[0].netSuiteTransactionId, 88001);
    assert.equal(calls.some((call) => /salesorder/i.test(call.path)), false);
    assert.equal((await query("SELECT 1 FROM operator_load_records WHERE response->>'consolidationLoadId'=$1", [batch.id])).rowCount, 3);
  } finally {
    await operatorNetSuitePostingRuntime.enqueue(batch.id);
    globalThis.fetch = fetchBoundary;
    Object.assign(config.netsuite, previous);
    await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_delivery_prep_if_3445'");
  }
});

test("accepted quantity drift holds every order until the original snapshot is restored", async () => {
  const f = await fixture(), batch = await preview(f);
  await query("UPDATE operator_consolidated_loads SET status='pending',photo_refs=$2 WHERE id=$1", [batch.id, JSON.stringify(photos(batch.id))]);
  for (const order of f.orders) await query("INSERT INTO operator_consolidated_load_claims(batch_id,order_id) VALUES($1,$2)", [batch.id, order.orderId]);
  await query("UPDATE sales_order_lines SET packed_piece_qty=19 WHERE id=$1", [f.first.lineId]);
  await assert.rejects(completeConsolidatedLoad(batch.id), { code: "CONSOLIDATION_LOAD_STALE" });
  assert.equal((await query("SELECT 1 FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rowCount, 0);
  await query("UPDATE sales_order_lines SET packed_piece_qty=20 WHERE id=$1", [f.first.lineId]);
  await completeConsolidatedLoad(batch.id);
  const replay = await completeConsolidatedLoad(batch.id);
  assert.equal(replay.sourceLoadRecords.length, 2);
});

test("additive batch migration can be rolled back without losing existing saved work", async () => {
  const before = (await query("SELECT count(*)::int AS count FROM operator_consolidated_loads")).rows[0].count;
  const photosBefore = (await query("SELECT count(*)::int AS count FROM operator_posting_photo_uploads")).rows[0].count;
  assert.ok(before > 0);
  const migration = await readFile(new URL("../../../migrations/200_operator_consolidated_loads.sql", import.meta.url), "utf8");
  await withTransaction(async () => {
    await query("DROP TABLE operator_posting_photo_uploads");
    await query("DROP TABLE operator_consolidated_load_claims");
    await query("DROP TABLE operator_consolidated_loads");
    await query(migration);
    await query(await readFile(new URL("../../../migrations/201_operator_posting_photo_uploads.sql", import.meta.url), "utf8"));
    assert.equal((await query("SELECT count(*)::int AS count FROM operator_consolidated_loads")).rows[0].count, 0);
  }, { rollback: true });
  assert.equal((await query("SELECT count(*)::int AS count FROM operator_consolidated_loads")).rows[0].count, before);
  assert.equal((await query("SELECT count(*)::int AS count FROM operator_posting_photo_uploads")).rows[0].count, photosBefore);
});

test("consolidation accepts durable photo data and uploads after completion without changing replay identity", async () => {
  const f = await fixture(), batch = await preview(f);
  const refs = ["proof-one", "proof-two"].map((value) => `data:image/jpeg;base64,${Buffer.from(value).toString("base64")}`);
  const submitted = await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: refs });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.status, "completed");
  for (let i = 0; i < 2; i += 1) {
    const job = await claimPostingPhoto({ ownerId: batch.id });
    assert.equal(job.batchId, batch.id);
    assert.equal(await completePostingPhoto(job, photos(batch.id)[i]), true);
  }
  const completed = (await request(f.first, `/${batch.id}`)).data;
  assert.deepEqual(completed.photoRefs, photos(batch.id));
  const saved = (await query("SELECT photo_data_urls FROM operator_load_records WHERE order_id::text=ANY($1::text[])", [f.orders.map((order) => order.orderId)])).rows;
  assert.equal(saved.length, 2);
  for (const row of saved) {assert.deepEqual(row.photo_data_urls, photos(batch.id));}
  assert.equal((await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: refs })).status, 200);
  assert.equal((await request(f.first, `/${batch.id}/submit`, "POST", { photoRefs: refs.map((ref) => ref.replace("cHJvb2Y", "YXhvb2Y")) })).status, 409);
});
