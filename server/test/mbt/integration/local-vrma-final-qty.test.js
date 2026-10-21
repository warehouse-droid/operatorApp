import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import fc from "fast-check";
import { app } from "../../../src/server.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import * as delivery from "../../../src/delivery-repository.js";
import { getScmVrmaOrder, completeScmVrmaOrderOverride, listScmSchedule } from "../../../src/dispatch-repository.js";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";

const vendor = `VRMA-final-${crypto.randomUUID()}`;
const photos = ["data:image/jpeg;base64,AA==", "data:image/jpeg;base64,AQ=="];
let session, server, base;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const password = crypto.randomUUID();
  await createOperator({ username: vendor, displayName: "VRMA final quantity", password, role: "operator", operatorYardLocationIds: [1] });
  session = await loginOperator(vendor, password);
  await query("INSERT INTO dispatch_local_vendors(name) VALUES($1)", [vendor]);
  await query("INSERT INTO dispatch_vendor_yards(vendor,yard,address,active) VALUES($1,'Return yard','Fixture Road',true)", [vendor]);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});
const rollback = fn => withTransaction(fn, { rollback: true });
async function fixture(lines = [{ estimate: 100, packed: 80 }, { estimate: 40, packed: 0 }], status = "packed") {
  const ref = `LOCAL-VRMA-${crypto.randomUUID()}`;
  const { rows: [order] } = await query(`INSERT INTO scm_vrma_orders(vrma_ref,local_vendor,pickup_location,dropoff_location,operator_status)
    VALUES($1,$2,'3445','Return yard',$3) RETURNING id`, [ref, vendor, status]);
  for (const line of lines) {
    await query(`INSERT INTO scm_vrma_order_lines(vrma_order_id,item_name,quantity,unit,weight_lbs,
      piece_qty,to_pcs,packed_piece_qty,packed_sales_qty,loaded_qty,confirmed)
      VALUES($1,'Return item',$2::numeric,'PC',$2::numeric*2,$3,$4,$5,$6,$7,$8)`,
    [order.id, line.estimate, line.conversion ? line.estimate / line.conversion : 0, line.conversion || 0,
      line.conversion ? line.packed : 0, line.conversion ? 0 : line.packed, line.loaded || 0, line.packed > 0]);
  }
  return { ...order, ref, key: `VRMA:${ref}` };
}
const load = order => delivery.recordDeliveryLoad(order.key, session.operator.id, { photoDataUrls: photos });
async function state(order) {
  return {
    order: (await query("SELECT * FROM scm_vrma_orders WHERE id=$1", [order.id])).rows[0],
    lines: (await query("SELECT * FROM scm_vrma_order_lines WHERE vrma_order_id=$1 ORDER BY id", [order.id])).rows,
    records: (await query("SELECT * FROM operator_load_records WHERE order_family='vrma_order' AND order_id=$1 ORDER BY id", [order.id])).rows
  };
}

test("local VRMA outbound makes actual quantity final, abandons untouched lines and preserves estimates in proof", () => rollback(async () => {
  const order = await fixture();
  const result = await load(order), saved = await state(order);
  assert.deepEqual(saved.lines.map(line => Number(line.quantity)), [80, 0]);
  assert.deepEqual(saved.lines.map(line => Number(line.loaded_qty)), [80, 0]);
  assert.deepEqual(saved.lines.map(line => Number(line.weight_lbs)), [160, 0]);
  assert.equal(saved.order.operator_status, "loaded");
  assert.equal(saved.order.local_yard_order_status, "Loaded");
  assert.equal(saved.order.status, "Queued", "Outbound loading is separate from vendor delivery completion");
  assert.ok(saved.order.loaded_at);
  assert.equal(result.remainingLines, 0);
  assert.equal(result.netSuiteUpdated, false);
  assert.equal(result.inventoryUpdated, false);
  assert.equal(saved.records.length, 1);
  assert.deepEqual(saved.records[0].photo_data_urls, photos);
  const finalized = saved.records[0].response.finalizedLines;
  assert.deepEqual(finalized.map(line => [line.estimatedQty, line.finalQty, line.abandonedQty]), [[100, 80, 20], [40, 0, 40]]);
  assert.deepEqual(saved.records[0].line_snapshot.map(line => [line.quantity, line.loadedQty]), [[100, 80], [40, 0]]);
  const active = await delivery.listVrmaDeliveryPrepOrders({ locationId: 1, status: "active" });
  assert.equal(active.some(row => row.netsuite_id === order.key), false);
  const detail = await getScmVrmaOrder(order.ref);
  const completed = await completeScmVrmaOrderOverride({ vrmaRef: order.ref, actor: session.operator.id,
    note: "Confirmed vendor delivery", expectedUpdatedAt: detail.concurrencyUpdatedAt, confirm: true });
  assert.ok(completed);
}));

test("converted local VRMA uses actual packed units without rounding a shortage up to the estimate", () => rollback(async () => {
  const order = await fixture([{ estimate: 10.05, packed: 10, conversion: 1 }, { estimate: 20, packed: 0, conversion: 2 }]);
  await load(order);
  const saved = await state(order);
  assert.deepEqual(saved.lines.map(line => [Number(line.quantity), Number(line.loaded_qty), Number(line.piece_qty)]), [[10, 10, 10], [0, 0, 0]]);
  assert.equal(saved.records[0].response.finalizedLines[0].abandonedQty, 0.05);
  const detail = await delivery.getDeliveryOrder(order.key);
  assert.equal(detail.lines[1].quantity, 0);
  assert.equal(detail.lines[1].piece_qty, 0);
}));

test("sales-only PLT local VRMA retains its actual pallet count for Dispatch", () => rollback(async () => {
  const order = await fixture([{ estimate: 100, packed: 80 }]);
  await query("UPDATE scm_vrma_order_lines SET unit='PLT',pallet_qty=100 WHERE vrma_order_id=$1", [order.id]);
  await load(order);
  const saved = await state(order);
  assert.equal(Number(saved.lines[0].quantity), 80);
  assert.equal(Number(saved.lines[0].pallet_qty), 80);
}));

test("packing alone preserves local VRMA estimate and estimate remains the maximum", () => rollback(async () => {
  const order = await fixture([{ estimate: 100, packed: 0 }], "open");
  const detail = await delivery.getDeliveryOrder(order.key), lineId = detail.lines[0].id;
  await delivery.confirmDeliveryLine(order.key, lineId, { salesQty: 80 }, session.operator.id);
  assert.equal(Number((await state(order)).lines[0].quantity), 100);
  await assert.rejects(load(order), /VRMA order must be packed before loading/);
  assert.equal(Number((await state(order)).lines[0].quantity), 100);
  await delivery.setDeliveryLinePackedQuantity(order.key, lineId, { salesQty: 120 }, session.operator.id);
  const saved = await state(order);
  assert.equal(Number(saved.lines[0].packed_sales_qty), 100);
  assert.equal(Number(saved.lines[0].quantity), 100);
  assert.equal(saved.order.loaded_at, null);
  assert.equal(saved.records.length, 0);
}));

test("existing partial load is retained in the final cumulative local VRMA quantity", () => rollback(async () => {
  const order = await fixture([{ estimate: 100, loaded: 30, packed: 40, conversion: 1 }]);
  await load(order);
  const saved = await state(order);
  assert.equal(Number(saved.lines[0].quantity), 70);
  assert.equal(Number(saved.lines[0].loaded_qty), 70);
  assert.equal(Number(saved.lines[0].piece_qty), 70);
  assert.equal(saved.records[0].response.finalizedLines[0].abandonedQty, 30);
}));

test("empty local VRMA load is rejected without abandoning any estimate", () => rollback(async () => {
  const order = await fixture([{ estimate: 100, packed: 0 }]), original = await state(order);
  await assert.rejects(load(order), error => error.code === "VRMA_LOAD_EMPTY" && error.status === 409);
  assert.deepEqual(await state(order), original);
}));

test("overpacked local VRMA cannot exceed its estimate or close its balance", () => rollback(async () => {
  const order = await fixture([{ estimate: 100, packed: 120 }]), original = await state(order);
  await assert.rejects(load(order), error => error.code === "DELIVERY_LOAD_VALIDATION_FAILED");
  assert.deepEqual(await state(order), original);
}));

test("local VRMA maximum also rejects a converted overage within ordinary order rounding tolerance", () => rollback(async () => {
  const order = await fixture([{ estimate: 10, packed: 10.05, conversion: 1 }]), original = await state(order);
  await assert.rejects(load(order), error => error.code === "DELIVERY_LOAD_VALIDATION_FAILED");
  assert.deepEqual(await state(order), original);
}));

test("SCM schedule shows the finalized local VRMA actual quantity and weight", () => rollback(async () => {
  const order = await fixture([{ estimate: 100, packed: 80 }]);
  await query(`INSERT INTO scm_transport_schedule(order_kind,source_table,source_id,order_ref,content,weight_lbs)
    VALUES('VRMA','scm_vrma_orders',$1,$2,'Return item 100 PC',200)`, [order.id, order.ref]);
  await load(order);
  const schedule = (await listScmSchedule({ kind: "VRMA", search: order.ref }))[0];
  assert.match(schedule.content, /80 PC/);
  assert.doesNotMatch(schedule.content, /100 PC/);
  assert.equal(Number(schedule.weightLbs), 160);
}));

async function legacyFixture({ packed = 0, proof = true } = {}) {
  const order = await fixture([{ estimate: 400, packed, loaded: 150 }], "partial_loaded");
  if (proof) {
    await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,photo_data_urls,line_snapshot,response)
      VALUES('vrma_local_load','vrma_order',$1,$2,$3::jsonb,'[]','{"remainingLines":1}')`, [order.id, order.ref, JSON.stringify(photos)]);
  }
  return order;
}

test("historical cleanup requires an explicit bounded list of local VRMA references", async () => {
  for (const orderRefs of [undefined, [], Array(501).fill("UNSELECTED")]) {
    await assert.rejects(delivery.finalizeLegacyVrmaShortLoads({ orderRefs, dryRun: false }), /Select the local VRMA references/);
  }
});

test("historical local VRMA dry-run is read-only and applied cleanup is audited and repeatable", () => rollback(async () => {
  const order = await legacyFixture(), original = await state(order);
  const preview = await delivery.finalizeLegacyVrmaShortLoads({ orderRefs: [order.ref] });
  assert.equal(preview.length, 1);
  assert.deepEqual(preview[0].finalizedLines.map(line => [line.estimatedQty, line.finalQty, line.abandonedQty]), [[400, 150, 250]]);
  assert.deepEqual(await state(order), original);
  const result = await delivery.finalizeLegacyVrmaShortLoads({ orderRefs: [order.ref], dryRun: false });
  assert.equal(result.length, 1);
  const saved = await state(order);
  assert.equal(saved.order.operator_status, "loaded");
  assert.equal(Number(saved.lines[0].quantity), 150);
  assert.equal(Number(saved.lines[0].loaded_qty), 150);
  assert.deepEqual(saved.records, original.records, "Historical load proof is retained verbatim");
  const audit = (await query("SELECT details FROM delivery_audit_log WHERE action='delivery.vrma.finalize_legacy_short_load' AND order_id=$1", [order.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(Number(audit[0].details.before.lines[0].quantity), 400);
  assert.equal(audit[0].details.finalizedLines[0].abandonedQty, 250);
  assert.deepEqual(await delivery.finalizeLegacyVrmaShortLoads({ orderRefs: [order.ref], dryRun: false }), []);
  const active = await delivery.listVrmaDeliveryPrepOrders({ locationId: 1 });
  assert.equal(active.some(row => row.netsuite_id === order.key), false);
}));

test("historical cleanup leaves active packing and orders without load proof unchanged", () => rollback(async () => {
  const packing = await legacyFixture({ packed: 20 }), unproven = await legacyFixture({ proof: false });
  const originals = await Promise.all([state(packing), state(unproven)]);
  assert.deepEqual(await delivery.finalizeLegacyVrmaShortLoads({ orderRefs: [packing.ref, unproven.ref], dryRun: false }), []);
  assert.deepEqual(await Promise.all([state(packing), state(unproven)]), originals);
}));

test("historical cleanup rolls back if its audit cannot be retained", () => rollback(async () => {
  const order = await legacyFixture(), original = await state(order);
  await query(`CREATE FUNCTION pg_temp.vrma_reject_repair_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='delivery.vrma.finalize_legacy_short_load' THEN RAISE EXCEPTION 'Injected VRMA audit failure'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER vrma_audit_failure BEFORE INSERT ON delivery_audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.vrma_reject_repair_audit()");
  await assert.rejects(delivery.finalizeLegacyVrmaShortLoads({ orderRefs: [order.ref], dryRun: false }), /Injected VRMA audit failure/);
  assert.deepEqual(await state(order), original);
}));

test("concurrent local VRMA load retries return one final result and one proof record", async () => {
  const order = await fixture();
  const results = await Promise.all([load(order), load(order), load(order)]);
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  const saved = await state(order);
  assert.equal(saved.records.length, 1);
  assert.deepEqual(saved.lines.map(line => Number(line.quantity)), [80, 0]);
  assert.deepEqual(await load(order), results[0]);
});

test("proof storage failure rolls back local VRMA quantities and abandonment", () => rollback(async () => {
  const order = await fixture(), original = await state(order);
  await query(`CREATE FUNCTION pg_temp.vrma_reject_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.load_type='vrma_local_load' THEN RAISE EXCEPTION 'Injected VRMA proof failure'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER vrma_proof_failure BEFORE INSERT ON operator_load_records FOR EACH ROW EXECUTE FUNCTION pg_temp.vrma_reject_proof()");
  await assert.rejects(load(order), /Injected VRMA proof failure/);
  assert.deepEqual(await state(order), original);
}));

test("property: local VRMA actual plus abandoned equals estimate and actual never exceeds it", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 10000 }), fc.integer({ min: 1, max: 10000 }), async (estimate, candidate) => rollback(async () => {
    const packed = 1 + candidate % (estimate - 1), order = await fixture([{ estimate, packed }]);
    await load(order);
    const saved = await state(order), final = saved.records[0].response.finalizedLines[0];
    assert.equal(Number(saved.lines[0].quantity), packed);
    assert.equal(final.finalQty + final.abandonedQty, estimate);
    assert.equal(final.finalQty, packed);
    assert.ok(final.finalQty <= estimate);
  })), { seed: 20261019, numRuns: 25 });
});

test("local VRMA HTTP load finalizes quantities and exposes explicit confirmation semantics", async () => {
  const order = await fixture(), path = `${base}/api/delivery/orders/${encodeURIComponent(order.key)}`;
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  const detail = await (await fetch(path, { headers })).json();
  assert.equal(detail.confirmationSummary.finalizesEstimatedQuantity, true);
  const response = await fetch(`${path}/load`, { method: "POST", headers, body: JSON.stringify({ photoDataUrls: photos }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(Number((await state(order)).lines[0].quantity), 80);
});

test("sales order partial loading still keeps its remaining quantity open", () => rollback(async () => {
  const order = await seedOperatorPickup({ quantity: 100 });
  await query("UPDATE sales_orders SET sales_order_type='Delivery',operator_status='packed' WHERE netsuite_id=$1", [order.orderId]);
  await query("UPDATE sales_order_lines SET packed_piece_qty=80,confirmed=true WHERE id=$1", [order.lineId]);
  const result = await delivery.recordDeliveryLoad(order.orderId, order.operator.id, { photoDataUrls: photos });
  const saved = await delivery.getDeliveryOrder(order.orderId);
  assert.equal(result.remainingLines, 1);
  assert.equal(saved.operator_status, "partial_loaded");
  assert.equal(Number(saved.lines[0].quantity), 100);
  assert.equal(Number(saved.lines[0].loaded_qty), 80);
}));

test("transfer order partial loading still keeps its remaining quantity open", () => rollback(async () => {
  const id = String(9_960_000_000 + crypto.randomInt(10_000_000));
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
    VALUES($1,$2,'B','Pending Fulfillment',1,'3445',28,'2967','packed','Open','not_fulfilled',true)`, [id, `TO-FINAL-REGRESSION-${id}`]);
  await query(`INSERT INTO transfer_order_lines(line_stage,transfer_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,
    location_id,location,piece_qty,to_pcs,packed_piece_qty,loaded_qty,netsuite_active,confirmed)
    VALUES('outbound',$1,1,889201,'Item A','ITEM-A','InvtPart',100,'PC',1,'3445',100,1,80,0,true,true)`, [id]);
  const result = await delivery.recordDeliveryLoad(id, session.operator.id, { photoDataUrls: photos });
  const saved = await delivery.getDeliveryOrder(id);
  assert.equal(result.remainingLines, 1);
  assert.equal(saved.operator_status, "partial_loaded");
  assert.equal(Number(saved.lines[0].quantity), 100);
  assert.equal(Number(saved.lines[0].loaded_qty), 80);
}));
