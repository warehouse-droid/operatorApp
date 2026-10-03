import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { query, withTransaction } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { applyDispatchV2Command } from "../../../src/dispatch-planner-v2-repository.js";
import { restoreDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { listDispatchOrders, updateDispatchOrderDetails } from "../../../src/dispatch-repository.js";
import { getDispatchExecutedOrderReviews, acknowledgeDispatchExecutedOrderReviews, evaluateDispatchReviewedPrefix } from "../../../src/dispatch-executed-order-review-repository.js";

let fixture; let counter = 0;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks(id,plate,active) VALUES(9918900,'CC46868',true)");
  await query("INSERT INTO dispatch_drivers(id,name,login,active) VALUES(9918901,'Li','li',true)");
});
after(async () => { await fixture?.close(); });
async function seed() {
  const n = ++counter; const id = 9918000 + n; const ref = `TO-REVIEW-${n}`;
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,local_yard_order_status,fulfillment_status,receiving_status,netsuite_active,dispatch_address)
    VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',1,'3445',26,'150','open','Open','not_fulfilled','not_received',true,'150 Test Road')`, [id, ref]);
  await query(`INSERT INTO transfer_order_lines (transfer_order_id,line_id,line_stage,item_id,item_name,sku,item_type,quantity,unit,pallet_qty,netsuite_active)
    VALUES ($1,4977214,'outbound',4773,'PER-MM80S-2237-SCG','PER-MM80S-2237-SCG','InvtPart',326.48,'SQFT',4,true),
    ($1,4977427,'outbound',1784,'PALLET','PALLET','InvtPart',29,'EACH',0,true)`, [id]);
  const source = (await listDispatchOrders({ exactOrderRefs: [ref], includeHiddenScm: true, includeFulfilledSalesDeliveries: true }))[0];
  assert.ok(source, "canonical mirror order is visible");
  const plan = await fixture.seedPlan({ date: `2097-09-${String(n + 1).padStart(2, "0")}`, refs: [ref] });
  const trucks = [{ id: "T5", plate: "CC46868", loads: [{ id: `l-${n}`, name: "Load 2", driverLogin: "li", driverName: "Li", truckId: "T5", truckPlate: "CC46868", driverSequence: 0,
    stops: [{ id: `drop-${n}`, type: "drop", orderId: ref }] }] }];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1", [plan.id, JSON.stringify([source]), JSON.stringify(trucks)]);
  await query(`INSERT INTO driver_job_records (job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
    VALUES ($1,$2,$3,'li','T5','CC46868',$4,$5,'drop',$6::jsonb,'complete',now(),now(),$7::jsonb)`,
  [`review-${n}`, plan.id, plan.plan_date, `l-${n}`, `drop-${n}`, JSON.stringify([ref]), JSON.stringify({ photoIds: ["historical-photo"], address: source.address })]);
  await query("UPDATE transfer_order_lines SET netsuite_active=false WHERE transfer_order_id=$1 AND line_id=4977214", [id]);
  await query("UPDATE transfer_order_lines SET quantity=25 WHERE transfer_order_id=$1 AND line_id=4977427", [id]);
  const sessionId = `review-session-${n}`;
  const token = await fixture.acquireLease({ planDate: plan.plan_date, sessionId });
  return { id, ref, plan: { ...plan, orders: [source], trucks }, editLease: { planDate: plan.plan_date, operatorId: fixture.operator.id, sessionId, token },
    bodyLease: { planDate: plan.plan_date, sessionId, editLeaseToken: token } };
}

test("review persists exact acknowledgement, detects a second source update and cannot override manual edits", async () => {
  const f = await seed();
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].acknowledged, false);
  const next = structuredClone(f.plan);
  assert.equal((await evaluateDispatchReviewedPrefix({ previousPlan: f.plan, nextPlan: next })).allowed, true, "pending source review must never block saving later work");
  await acknowledgeDispatchExecutedOrderReviews({ planId: f.plan.id, tokens: [reviews[0].token], actorId: fixture.operator.id, actorName: "Dispatcher", editLease: f.editLease });
  const again = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(again[0].acknowledged, true);
  const row = (await query("SELECT actor_id,changes FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rows[0];
  assert.equal(String(row.actor_id), String(fixture.operator.id));
  assert.ok(row.changes.some(change => change.field === "item_removed"));
  next.orders = await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true });
  assert.equal((await evaluateDispatchReviewedPrefix({ previousPlan: f.plan, nextPlan: next })).allowed, true);
  next.orders[0].items[0].quantity = 900;
  assert.equal((await evaluateDispatchReviewedPrefix({ previousPlan: f.plan, nextPlan: next })).allowed, false);
  await query("UPDATE transfer_order_lines SET quantity=24 WHERE transfer_order_id=$1 AND line_id=4977427", [f.id]);
  const changed = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(changed[0].acknowledged, false);
  await assert.rejects(acknowledgeDispatchExecutedOrderReviews({ planId: f.plan.id, tokens: [reviews[0].token], actorId: fixture.operator.id, editLease: f.editLease }), error => error.code === "DISPATCH_EXECUTED_SOURCE_REVIEW_STALE");
  assert.equal((await query("SELECT job_details FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows[0].job_details.photoIds[0], "historical-photo");
});

test("review HTTP requires authentication, lease and explicit confirmation", async () => {
  const f = await seed(); const path = `/api/dispatch/plans/${f.plan.id}/executed-order-reviews`;
  assert.equal((await fixture.request(path, { token: "" })).response.status, 401);
  const read = await fixture.request(path);
  assert.equal(read.response.status, 200);
  assert.ok(read.payload.reviews[0].changes.some(change => change.field === "quantity"));
  assert.equal(read.payload.reviews[0].sourceOrder, undefined);
  const body = { tokens: [read.payload.reviews[0].token], confirm: true };
  assert.equal((await fixture.request(path, { method: "POST", body })).response.status, 409);
  assert.equal((await fixture.request(path, { method: "POST", body: { ...body, ...f.bodyLease, confirm: false } })).response.status, 400);
  const ack = await fixture.request(path, { method: "POST", body: { ...body, ...f.bodyLease } });
  assert.equal(ack.response.status, 200, JSON.stringify(ack.payload));
  assert.equal(ack.payload.reviews[0].acknowledged, true);
});

test("backend refuses explicit blank address and preserves address on partial details update", async () => {
  const f = await seed();
  await assert.rejects(updateDispatchOrderDetails(f.ref, { type: "TO", address: "  " }), error => error.code === "DISPATCH_ADDRESS_REQUIRED");
  await updateDispatchOrderDetails(f.ref, { type: "TO", windowStart: "08:00", windowEnd: "10:00" });
  assert.equal((await query("SELECT dispatch_address FROM transfer_orders WHERE netsuite_id=$1", [f.id])).rows[0].dispatch_address, "150 Test Road");
});

test("a successful plan refresh cannot dismiss a warning that has not been confirmed", async () => {
  const f = await seed();
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  const fresh = await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true });
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1", [f.plan.id, JSON.stringify(fresh)]);
  const pending = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].token, reviews[0].token);
  assert.equal(pending[0].acknowledged, false);
  const attempts = await Promise.all([1, 2].map(() => acknowledgeDispatchExecutedOrderReviews({ planId: f.plan.id,
    tokens: [pending[0].token], actorId: fixture.operator.id, actorName: "Dispatcher", editLease: f.editLease })));
  assert.ok(attempts.every(result => result[0].acknowledged));
  assert.equal(Number((await query("SELECT count(*) AS count FROM dispatch_audit_log WHERE plan_id=$1 AND action='dispatch_executed_source_update_acknowledged'", [f.plan.id])).rows[0].count), 1);
});

test("the real plan save accepts a refreshed executed TO and later work before warning confirmation", async () => {
  const f = await seed();
  const nextId = f.id + 100000; const nextRef = `${f.ref}-NEXT`;
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,local_yard_order_status,fulfillment_status,receiving_status,netsuite_active,dispatch_address)
    VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',1,'3445',26,'150','open','Open','not_fulfilled','not_received',true,'150 Next Road')`, [nextId, nextRef]);
  await query(`INSERT INTO transfer_order_lines (transfer_order_id,line_id,line_stage,item_id,item_name,sku,item_type,quantity,unit,pallet_qty,netsuite_active)
    VALUES ($1,1,'outbound',1784,'PALLET','PALLET','InvtPart',1,'EACH',1,true)`, [nextId]);
  const next = structuredClone(f.plan);
  next.orders = await listDispatchOrders({ exactOrderRefs: [f.ref, nextRef], includeHiddenScm: true });
  next.trucks[0].loads.push({ id: `next-${f.id}`, name: "Load 3", driverLogin: "li", driverName: "Li", truckId: "T5", truckPlate: "CC46868", driverSequence: 1,
    stops: [{ id: `next-p-${f.id}`, type: "pick", orderId: nextRef, location: "3445" }, { id: `next-d-${f.id}`, type: "drop", orderId: nextRef }] });
  const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows;
  const loaded = await fixture.request(`/api/dispatch/plans/${f.plan.id}`);
  const saved = await fixture.request(`/api/dispatch/plans/${f.plan.id}`, { method: "PUT", body: {
    ...f.bodyLease, orders: next.orders, trucks: next.trucks, baseRevision: f.plan.revision, baseDigest: loaded.payload.digest, summary: {} } });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.trucks[0].loads.length, 2);
  assert.deepEqual(saved.payload.trucks[0].loads[0].stops, f.plan.trucks[0].loads[0].stops);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, jobs);
  assert.equal((await getDispatchExecutedOrderReviews(f.plan.id))[0].acknowledged, false);
});

test("malformed or cross-plan acknowledgements cannot change the ledger", async () => {
  const f = await seed();
  const current = await getDispatchExecutedOrderReviews(f.plan.id);
  for (const tokens of [null, [], "not-an-array", ["not-a-token"], Array(201).fill(current[0].token)]) {
    await assert.rejects(acknowledgeDispatchExecutedOrderReviews({ planId: f.plan.id, tokens,
      actorId: fixture.operator.id, editLease: f.editLease }), error => error.code === "DISPATCH_EXECUTED_SOURCE_REVIEW_INVALID");
  }
  await assert.rejects(acknowledgeDispatchExecutedOrderReviews({ planId: f.plan.id, tokens: ["f".repeat(64)],
    actorId: fixture.operator.id, editLease: f.editLease }), error => error.code === "DISPATCH_EXECUTED_SOURCE_REVIEW_STALE");
  assert.equal((await getDispatchExecutedOrderReviews(f.plan.id))[0].acknowledged, false);
});

test("command saves and snapshot restores accept source stop addresses with reviews still pending", async () => {
  for (const method of ["command", "restore"]) {
    const f = await seed();
    await query("UPDATE transfer_orders SET to_location_id=28,to_location='2967' WHERE netsuite_id=$1", [f.id]);
    const orders = await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true });
    const updatedAddress = orders[0].address;
    assert.notEqual(updatedAddress, f.plan.orders[0].address, "the mirror update must change the canonical source destination");
    const trucks = structuredClone(f.plan.trucks);
    trucks[0].loads[0].stops[0].dropAddress = updatedAddress;
    const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows;
    if (method === "command") {
      const loaded = await fixture.request(`/api/dispatch/plans/${f.plan.id}`);
      await applyDispatchV2Command({ planId: f.plan.id, actorId: fixture.operator.id, editLease: f.editLease, command: {
        commandId: `review-command-${f.id}`, commandType: "replace_plan", baseRevision: f.plan.revision,
        baseDigest: loaded.payload.digest, sessionId: f.editLease.sessionId,
        payload: { planDate: f.plan.plan_date, orders, trucks, summary: {} }
      } });
    } else {
      const snapshot = (await query(`INSERT INTO dispatch_plan_snapshot_history
        (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason)
        VALUES ($1,$2,0,$3::jsonb,$4::jsonb,'{}',now(),'source-review-test') RETURNING id`,
      [f.plan.id, f.plan.plan_date, JSON.stringify(orders), JSON.stringify(trucks)])).rows[0];
      await restoreDispatchPlanSnapshot(snapshot.id, { sessionId: f.editLease.sessionId });
    }
    const saved = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [f.plan.id])).rows[0];
    assert.deepEqual(saved.trucks[0].loads[0].stops, f.plan.trucks[0].loads[0].stops, method);
    assert.equal(saved.orders[0].address, f.plan.orders[0].address, method);
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, jobs, method);
    assert.equal((await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true }))[0].address, updatedAddress);
    assert.equal((await getDispatchExecutedOrderReviews(f.plan.id))[0].acknowledged, false, method);
  }
});

test("review migration can be applied and rolled back without losing existing observations", async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const f = await seed();
  await getDispatchExecutedOrderReviews(f.plan.id);
  const beforeRows = (await query("SELECT * FROM dispatch_executed_order_reviews ORDER BY plan_id,token")).rows;
  const sql = await readFile(new URL("../../../migrations/212_dispatch_executed_order_reviews.sql", import.meta.url), "utf8");
  await withTransaction(async () => {
    await query("DROP TABLE dispatch_executed_order_reviews");
    await query(sql);
    assert.equal((await query("SELECT count(*) AS count FROM dispatch_executed_order_reviews")).rows[0].count, "0");
    await getDispatchExecutedOrderReviews(f.plan.id);
    assert.equal((await query("SELECT count(*) AS count FROM dispatch_executed_order_reviews")).rows[0].count, "1");
  }, { rollback: true });
  assert.deepEqual((await query("SELECT * FROM dispatch_executed_order_reviews ORDER BY plan_id,token")).rows, beforeRows);
});
