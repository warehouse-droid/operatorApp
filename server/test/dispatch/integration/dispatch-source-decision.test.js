import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { query, withTransaction } from "../../../src/db.js";
import { readFile } from "node:fs/promises";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { getDispatchExecutedOrderReviews, evaluateDispatchReviewedPrefix } from "../../../src/dispatch-executed-order-review-repository.js";

let fixture;
let sequence = 0;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks(id,plate,active) VALUES(9976900,'BL27129-TEST',true)");
  await query("INSERT INTO dispatch_drivers(id,name,login,active) VALUES(9976901,'Source tester','source-test',true)");
});
after(async () => { await fixture?.close(); });

async function seed({ grouped = false, acknowledged = false, staleRetiredLine = false } = {}) {
  const n = ++sequence;
  const id = 9976000 + n;
  const ref = `TO-SOURCE-DECISION-${n}`;
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,local_yard_order_status,fulfillment_status,receiving_status,netsuite_active,dispatch_address)
    VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',1,'3445',26,'150','open','Open','not_fulfilled','not_received',true,'150 Recorded Road')`, [id, ref]);
  await query(`INSERT INTO transfer_order_lines (transfer_order_id,line_id,line_stage,item_id,item_name,sku,item_type,quantity,unit,pallet_qty,netsuite_active)
    VALUES ($1,1,'outbound',1189,'BWS-PW-REG-GM','BWS-PW-REG-GM','InvtPart',$2,'PC',1,true),
    ($1,2,'outbound',1189,'BWS-PW-REG-GM','BWS-PW-REG-GM','InvtPart',50,'PC',1,true)`, [id, staleRetiredLine ? 110 : 60]);
  const original = JSON.parse(JSON.stringify((await listDispatchOrders({ exactOrderRefs: [ref], includeHiddenScm: true }))[0]));
  const sibling = { id: `SO-SIBLING-${n}`, type: "SO", address: original.address, items: [{ lineId: 3, itemId: 1784, sku: "PALLET", quantity: 16, unit: "EACH", pallets: 0 }], salesQty: 16, pallets: 0 };
  const order = grouped ? { ...original, id: `GTO-SOURCE-${n}`, childOrders: [ref, sibling.id], childOrderDetails: [original, sibling],
    items: [...original.items, ...sibling.items], salesQty: original.salesQty + 16, isGrouped: true } : original;
  const plan = await fixture.seedPlan({ date: `2097-10-${String(n + 1).padStart(2, "0")}`, refs: [order.id] });
  const trucks = [{ id: "source-truck", plate: "BL27129-TEST", loads: [{ id: `source-load-${n}`, name: "Load 2", driverLogin: "source-test", driverName: "Source tester", truckId: "source-truck", truckPlate: "BL27129-TEST", driverSequence: 0,
    stops: [{ id: `source-drop-${n}`, type: "drop", orderId: order.id, timing: { arrival: 600, depart: 630 } }] }] }];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1", [plan.id, JSON.stringify([order]), JSON.stringify(trucks)]);
  await query(`INSERT INTO driver_job_records (job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
    VALUES ($1,$2,$3,'source-test','source-truck','BL27129-TEST',$4,$5,'drop',$6::jsonb,'complete',now(),now(),'{"photoIds":["retained-photo"],"address":"150 Recorded Road"}')`,
  [`source-job-${n}`, plan.id, plan.plan_date, `source-load-${n}`, `source-drop-${n}`, JSON.stringify([ref])]);
  await query("UPDATE transfer_order_lines SET netsuite_active=false WHERE transfer_order_id=$1 AND line_id=2", [id]);
  await query("UPDATE transfer_order_lines SET quantity=110 WHERE transfer_order_id=$1 AND line_id=1", [id]);
  const sessionId = `source-decision-session-${n}`;
  const token = await fixture.acquireLease({ planDate: plan.plan_date, sessionId });
  const reviews = await getDispatchExecutedOrderReviews(plan.id);
  if (acknowledged) {await query("UPDATE dispatch_executed_order_reviews SET acknowledged_at=now(),actor_name='legacy dispatch' WHERE plan_id=$1", [plan.id]);}
  const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [plan.id])).rows;
  return { id, ref, plan: { ...plan, id: plan.id, planDate: plan.plan_date, orders: [order], trucks }, reviews, jobs,
    body: { tokens: [reviews[0].token], confirm: true, baseRevision: plan.revision, sessionId, editLeaseToken: token } };
}

async function decide(f, decision, extra = {}) {
  return fixture.request(`/api/dispatch/plans/${f.plan.id}/executed-order-reviews`, { method: "POST", body: { ...f.body, decision, ...extra } });
}
async function snapshot(f) {
  return (await query("SELECT orders,trucks,summary,plan_digest FROM dispatch_plan_snapshots WHERE plan_id=$1", [f.plan.id])).rows[0];
}

async function sourceEvent(f, { afterWork = false } = {}) {
  const source = (await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true }))[0];
  await query(`INSERT INTO netsuite_order_webhook_inbox
    (entity_key,record_type,netsuite_order_id,event_type,payload_hash,payload,raw_body,status,source_modified_at,received_at,completed_at)
    VALUES ($1,'transfer_order',$2,'edit',$3,$5::jsonb,'{}','succeeded',now()+$4::interval,now()+$4::interval,now()+$4::interval)`,
  [`transfer_order:${f.id}`, String(f.id), `source-decision-${f.id}`, afterWork ? "1 day" : "-1 day", JSON.stringify({ lines: source.items })]);
}

test("a stale pre-work webhook cannot approve a different later mirror edit", async () => {
  const f = await seed();
  await sourceEvent(f);
  await query("UPDATE transfer_order_lines SET quantity=111 WHERE transfer_order_id=$1 AND line_id=1", [f.id]);
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews[0].decisionRequired, true);
  assert.equal(reviews[0].sourceReceiptVerified, false);
  assert.deepEqual((await snapshot(f)).orders, f.plan.orders);
});

test("a change applied before driver work is accepted first and still requires dispatch acknowledgement", async () => {
  const f = await seed({ grouped: true, acknowledged: true });
  await sourceEvent(f);
  const read = await fixture.request(`/api/dispatch/plans/${f.plan.id}/executed-order-reviews`);
  assert.equal(read.response.status, 200, JSON.stringify(read.payload));
  assert.equal(read.payload.reviews[0].decision, "accept_netsuite_change");
  assert.equal(read.payload.reviews[0].acknowledged, false);
  assert.equal(read.payload.reviews[0].decisionRequired, false);
  assert.equal(read.payload.orders[0].childOrderDetails[0].items.length, 1);
  assert.ok(read.payload.reviews[0].sourceAppliedAt);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.jobs);
  const ack = await fixture.request(`/api/dispatch/plans/${f.plan.id}/executed-order-reviews`, { method: "POST", body: { ...f.body, tokens: [read.payload.reviews[0].token] } });
  assert.equal(ack.response.status, 200, JSON.stringify(ack.payload));
  assert.equal(ack.payload.reviews[0].acknowledged, true);
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_audit_log WHERE plan_id=$1 AND action='dispatch_source_change_auto_accepted'", [f.plan.id])).rows[0].count), 1);
});

test("accepting a pre-work change unblocks a same-day adjustment without waiting for acknowledgement", async () => {
  const f = await seed({ grouped: true });
  await sourceEvent(f);
  const read = await fixture.request(`/api/dispatch/plans/${f.plan.id}/executed-order-reviews`);
  const trucks = structuredClone(f.plan.trucks);
  trucks[0].loads.push({ id: `later-${f.id}`, name: "Later same-day work", driverLogin: "source-test", driverName: "Source tester", truckId: "source-truck", truckPlate: "BL27129-TEST", driverSequence: 1, stops: [] });
  const saved = await fixture.request(`/api/dispatch/plans/${f.plan.id}`, { method: "PUT", body: { ...f.body,
    planDate: f.plan.planDate, orders: read.payload.orders, trucks, summary: { sameDayAdjustment: true },
    baseRevision: read.payload.plan.revision, baseDigest: read.payload.plan.digest } });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.trucks[0].loads.length, 2);
  assert.deepEqual(saved.payload.trucks[0].loads[0].stops, f.plan.trucks[0].loads[0].stops);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.jobs);
  assert.equal((await getDispatchExecutedOrderReviews(f.plan.id))[0].acknowledged, false);
});

test("a change applied after driver work starts requires a dispatcher decision", async () => {
  const f = await seed();
  await sourceEvent(f, { afterWork: true });
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews[0].decision, null);
  assert.equal(reviews[0].decisionRequired, true);
  assert.deepEqual((await snapshot(f)).orders, f.plan.orders);
});

test("GOA incident: stale extra 50-PC cargo is corrected without losing the protected driver route", async () => {
  const f = await seed({ grouped: true, staleRetiredLine: true });
  assert.equal(f.plan.orders[0].salesQty, 176);
  await sourceEvent(f);
  const read = await fixture.request(`/api/dispatch/plans/${f.plan.id}/executed-order-reviews?baseRevision=${f.plan.revision}`);
  assert.equal(read.response.status, 200, JSON.stringify(read.payload));
  assert.equal(read.payload.orders[0].salesQty, 126);
  assert.equal(read.payload.plan.safeToAdvanceRevision, true);
  const recorded = (await snapshot(f)).orders;
  assert.equal(recorded[0].items.length, 2);
  assert.equal(recorded[0].childOrderDetails[0].items[0].quantity, 110);
  assert.deepEqual((await snapshot(f)).trucks, f.plan.trucks);
  assert.equal((await evaluateDispatchReviewedPrefix({ previousPlan: { ...f.plan, orders: recorded }, nextPlan: { ...f.plan, orders: structuredClone(recorded) } })).allowed, true);
  assert.equal(read.payload.reviews[0].acknowledged, false);
});

test("legacy acknowledgement still requires an explicit source decision", async () => {
  const f = await seed({ acknowledged: true });
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews[0].decisionRequired, true);
  assert.equal(reviews[0].decision, null);
});

test("protect driver work records the choice and preserves the snapshot, revision and full evidence", async () => {
  const f = await seed({ grouped: true });
  const previous = await snapshot(f);
  const result = await decide(f, "protect_driver_work");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.reviews[0].decision, "protect_driver_work");
  assert.deepEqual(await snapshot(f), previous);
  assert.equal(Number((await query("SELECT revision FROM dispatch_plans WHERE id=$1", [f.plan.id])).rows[0].revision), f.plan.revision);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.jobs);
  const next = structuredClone(f.plan);
  next.orders[0].childOrderDetails[0] = JSON.parse(JSON.stringify((await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true }))[0]));
  next.orders[0].items = next.orders[0].childOrderDetails.flatMap(child => child.items);
  assert.equal((await evaluateDispatchReviewedPrefix({ previousPlan: f.plan, nextPlan: next })).allowed, true);
  assert.deepEqual(next.orders[0], f.plan.orders[0]);
});

test("accept NetSuite consolidates grouped lines without changing route or driver evidence", async () => {
  const f = await seed({ grouped: true });
  const result = await decide(f, "accept_netsuite_change");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.reviews[0].decision, "accept_netsuite_change");
  const saved = await snapshot(f);
  assert.equal(saved.orders[0].childOrderDetails[0].items.length, 1);
  assert.equal(saved.orders[0].childOrderDetails[0].items[0].quantity, 110);
  assert.equal(saved.orders[0].items.length, 2);
  assert.equal(saved.orders[0].salesQty, 126);
  assert.deepEqual(saved.orders[0].childOrderDetails[1], f.plan.orders[0].childOrderDetails[1]);
  assert.deepEqual(saved.trucks, f.plan.trucks);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.jobs);
  assert.equal(Number((await query("SELECT revision FROM dispatch_plans WHERE id=$1", [f.plan.id])).rows[0].revision), f.plan.revision + 1);
  const history = (await query("SELECT orders FROM dispatch_plan_snapshot_history WHERE plan_id=$1 AND archive_reason='before_netsuite_source_acceptance'", [f.plan.id])).rows;
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].orders, f.plan.orders);
  assert.notEqual(saved.plan_digest, "");
  const loaded = await fixture.request(`/api/dispatch/plans/${f.plan.id}`);
  assert.equal(loaded.response.status, 200);
  const cargo = items => items.map(item => ({ lineId: item.lineId, quantity: item.quantity, unit: item.unit, pallets: item.pallets }));
  assert.deepEqual(cargo(loaded.payload.orders[0].items), cargo(saved.orders[0].items));
});

test("a later NetSuite edit cannot reuse a previous decision or token", async () => {
  const f = await seed();
  await decide(f, "protect_driver_work");
  await query("UPDATE transfer_order_lines SET quantity=111 WHERE transfer_order_id=$1 AND line_id=1", [f.id]);
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews[0].decisionRequired, true);
  assert.notEqual(reviews[0].token, f.reviews[0].token);
  const result = await decide(f, "accept_netsuite_change");
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, "DISPATCH_EXECUTED_SOURCE_REVIEW_STALE");
  assert.deepEqual((await snapshot(f)).orders, f.plan.orders);
});

test("invalid choices, forged values, stale revisions, missing confirmation and missing leases do not mutate the snapshot", async () => {
  const f = await seed();
  const previous = await snapshot(f);
  for (const decision of ["force", "", null, {}, ["accept_netsuite_change"]]) {
    const response = await decide(f, decision);
    assert.equal(response.response.status, 400, JSON.stringify(response.payload));
  }
  for (const tokens of [null, [], ["invalid"], Array(201).fill(f.body.tokens[0])]) {
    assert.equal((await decide(f, "accept_netsuite_change", { tokens })).response.status, 400);
  }
  assert.equal((await decide(f, "accept_netsuite_change", { confirm: false })).response.status, 400);
  assert.equal((await decide(f, "accept_netsuite_change", { editLeaseToken: "" })).response.status, 409);
  assert.equal((await decide(f, "accept_netsuite_change", { baseRevision: f.plan.revision + 10 })).response.status, 409);
  assert.deepEqual(await snapshot(f), previous);
  const accepted = await decide(f, "accept_netsuite_change", { orders: [{ id: f.ref, items: [{ quantity: 999999 }] }], force: true });
  assert.equal(accepted.response.status, 200);
  assert.equal((await snapshot(f)).orders[0].items[0].quantity, 110);
});

test("a pre-work source update already present in the saved snapshot needs acknowledgement without another revision", async () => {
  const f = await seed();
  await sourceEvent(f);
  const fresh = JSON.parse(JSON.stringify(await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true })));
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1", [f.plan.id, JSON.stringify(fresh)]);
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews[0].decision, "accept_netsuite_change");
  assert.equal(reviews[0].acknowledged, false);
  assert.equal(Number((await query("SELECT revision FROM dispatch_plans WHERE id=$1", [f.plan.id])).rows[0].revision), f.plan.revision);
  assert.deepEqual((await snapshot(f)).orders, fresh);
});

test("identical decisions are idempotent; contradictory decisions cannot overwrite the audit", async () => {
  const f = await seed();
  const first = await decide(f, "accept_netsuite_change");
  assert.equal(first.response.status, 200);
  const revision = Number((await query("SELECT revision FROM dispatch_plans WHERE id=$1", [f.plan.id])).rows[0].revision);
  assert.equal((await decide(f, "accept_netsuite_change")).response.status, 200);
  assert.equal(Number((await query("SELECT revision FROM dispatch_plans WHERE id=$1", [f.plan.id])).rows[0].revision), revision);
  assert.equal((await decide(f, "protect_driver_work")).response.status, 409);
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_audit_log WHERE plan_id=$1 AND action='dispatch_source_change_resolved'", [f.plan.id])).rows[0].count), 1);
});

test("concurrent opposite decisions produce one winner and no partial evidence changes", async () => {
  const f = await seed();
  const results = await Promise.all([decide(f, "accept_netsuite_change"), decide(f, "protect_driver_work")]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const winner = results.find(result => result.response.status === 200).payload.reviews[0].decision;
  assert.ok(["accept_netsuite_change", "protect_driver_work"].includes(winner));
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.jobs);
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_audit_log WHERE plan_id=$1 AND action='dispatch_source_change_resolved'", [f.plan.id])).rows[0].count), 1);
});

test("a transaction rollback undoes the decision, revision, snapshot and audit together", async () => {
  const f = await seed();
  const previous = await snapshot(f);
  // Import at execution time so the old implementation can run the other RED cases.
  const { resolveDispatchSourceOrderReviews } = await import("../../../src/dispatch-executed-order-review-repository.js");
  await assert.rejects(withTransaction(async () => {
    await resolveDispatchSourceOrderReviews({ planId: f.plan.id, tokens: f.body.tokens, decision: "accept_netsuite_change",
      actorId: fixture.operator.id, actorName: "Tester", baseRevision: f.plan.revision,
      editLease: { token: f.body.editLeaseToken, sessionId: f.body.sessionId } });
    throw new Error("rollback-probe");
  }), /rollback-probe/);
  assert.deepEqual(await snapshot(f), previous);
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_audit_log WHERE plan_id=$1 AND action='dispatch_source_change_resolved'", [f.plan.id])).rows[0].count), 0);
  assert.equal((await getDispatchExecutedOrderReviews(f.plan.id))[0].decisionRequired, true);
});

test("the additive migration can be rolled back and reapplied while preserving existing reviews and driver evidence", async () => {
  const f = await seed();
  await decide(f, "protect_driver_work");
  const priorRows = (await query("SELECT * FROM dispatch_executed_order_reviews ORDER BY plan_id,token")).rows;
  const migration = await readFile(new URL("../../../migrations/271_dispatch_source_decisions.sql", import.meta.url), "utf8");
  await withTransaction(async () => {
    await query("ALTER TABLE dispatch_executed_order_reviews DROP CONSTRAINT dispatch_source_decision_timestamp, DROP COLUMN decision, DROP COLUMN decided_at");
    assert.equal(Number((await query("SELECT count(*) FROM dispatch_executed_order_reviews")).rows[0].count), priorRows.length);
    await query(migration);
    assert.equal(Number((await query("SELECT count(*) FROM dispatch_executed_order_reviews")).rows[0].count), priorRows.length);
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.jobs);
  }, { rollback: true });
  assert.deepEqual((await query("SELECT * FROM dispatch_executed_order_reviews ORDER BY plan_id,token")).rows, priorRows);
});
