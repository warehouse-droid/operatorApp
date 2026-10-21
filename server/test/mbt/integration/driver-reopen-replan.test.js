import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { createOperator } from "../../../src/auth-repository.js";
import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { app, loadDispatchOrdersForResponse } from "../../../src/server.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import { listDriverPwaStops, reopenDriverPwaStop } from "../../../src/driver-pwa-repository.js";
import { listDispatchOrderPool } from "../../../src/dispatch-order-catalog-repository.js";
import { assertNoDriverPwaCompletedDispatchRefs } from "../../../src/dispatch-history-mode.js";

let server;
let baseUrl;
let dispatcherToken;
let salesToken;
const operatorSuffix = crypto.randomUUID().slice(0, 8);

async function request(path, { token = dispatcherToken, method = "GET", body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, payload: await response.json() };
}

before(async () => {
  config.dispatch.plannerOrderPoolMode = "on";
  const password = `reopen-test-${operatorSuffix}`;
  for (const role of ["dispatcher", "sales"]) {
    await createOperator({ username: `reopen-${role}-${operatorSuffix}`, displayName: role, password, role, roles: [role] });
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const role of ["dispatcher", "sales"]) {
    const login = await request("/api/auth/login", { token: "", method: "POST", body: { username: `reopen-${role}-${operatorSuffix}`, password } });
    assert.equal(login.status, 200, JSON.stringify(login.payload));
    if (role === "dispatcher") { dispatcherToken = login.payload.token; }
    else { salesToken = login.payload.token; }
  }
});

after(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});

async function fixture(count = 1) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const driverLogin = `reopen-driver-${suffix}`;
  const planDate = new Date(Date.UTC(1900, 0, 1 + crypto.randomInt(20_000))).toISOString().slice(0, 10);
  const refs = Array.from({ length: count }, (_, index) => `TO-REOPEN-${suffix}-${index}`);
  const plan = await query("INSERT INTO dispatch_plans(plan_date,status,revision,confirmed_at) VALUES ($1,'confirmed',1,now()) RETURNING id", [planDate]);
  const planId = Number(plan.rows[0].id);
  const orders = [];
  for (const ref of refs) {
    const id = Date.now() * 1000 + crypto.randomInt(1_000_000);
    await query(`INSERT INTO transfer_orders(netsuite_id,tranid,trandate,status,status_text,from_location_id,from_location,to_location_id,to_location,netsuite_active,fulfillment_status,outbound_operator_status)
      VALUES ($1,$2,CURRENT_DATE,'B','Transfer Order : Pending Fulfillment',28,'2967',1,'3445',true,'not_fulfilled','open')`, [id, ref]);
    for (const stage of ["outbound", "receiving"]) {
      await query(`INSERT INTO transfer_order_lines(line_stage,transfer_order_id,line_id,item_id,item_name,sku,quantity,unit,pallet_qty,to_plt,item_weight,netsuite_active)
        VALUES ($1,$2,1,987654,'Reopen fixture material','REOPEN-MATERIAL',10,'EA',1,10,10,true)`, [stage, id]);
    }
    await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,status,method) VALUES ('TO',$1,'Queued','MBT')", [ref]);
    orders.push({ id: ref, type: "TO", netsuiteId: id, sourceYard: "2967", outboundLocation: "2967", pickupLocations: ["2967"], address: "3445 Kennedy Road, Toronto, ON", toLocation: "3445", sourceTable: "transfer_orders" });
  }
  const trucks = [{ id: `truck-${suffix}`, plate: `RE-${suffix}`, base: "2967", driverLogin, driver: driverLogin, loads: [{
    id: `load-${suffix}`, name: "Reopen fixture load", driverLogin, driverName: driverLogin,
    stops: refs.map((ref, index) => ({ id: `drop-${suffix}-${index}`, type: "drop", orderId: ref, location: "3445", address: "3445 Kennedy Road, Toronto, ON" }))
  }] }];
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')", [planId, JSON.stringify(orders), JSON.stringify(trucks)]);
  const route = await getDriverDayJobs(driverLogin, { date: planDate });
  const drops = route.jobs.filter(job => job.stopType === "dropoff");
  assert.equal(drops.length, count, JSON.stringify(route.jobs));
  const photos = [`r2://driver/drop/${suffix}/one.jpg`, `r2://driver/drop/${suffix}/two.jpg`];
  const ids = [];
  for (const drop of drops) {
    const inserted = await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,stop_id,stop_type,order_refs,status,started_at,completed_at,photo_data_urls,job_details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'dropoff',$10::jsonb,'complete',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',$11::jsonb,$12::jsonb) RETURNING id`,
      [drop.jobId, planId, planDate, driverLogin, drop.truckId, drop.truckPlate, drop.loadId, drop.loadName, drop.stopId, JSON.stringify(drop.orderRefs), JSON.stringify(photos), JSON.stringify({ ...drop, physicalVisitJobIds: drops.map(job => job.jobId) })]);
    ids.push(Number(inserted.rows[0].id));
  }
  const listing = await listDriverPwaStops({ planDate, driverLogin });
  const target = listing.stops.find(stop => Number(stop.recordId) === ids[0]);
  assert.ok(target, JSON.stringify(listing));
  return { refs, ids, drops, photos, planId, planDate, driverLogin, target };
}

function reopenInput(f, idempotencyId = crypto.randomUUID()) {
  return { recordId: f.target.recordId, expectedStateHash: f.target.stateHash, auditNote: "Reopen the visit to replan the transfer.", idempotencyId, reopenedBy: "Reopen test Dispatcher" };
}

async function completions(refs, table = "dispatch_order_completion_status") {
  return (await query(`SELECT * FROM ${table} WHERE order_ref=ANY($1::text[]) ORDER BY order_ref,id`, [refs])).rows;
}

async function effective(refs) {
  return (await query("SELECT * FROM dispatch_order_completion_status WHERE order_ref=ANY($1::text[]) ORDER BY order_ref", [refs])).rows;
}

test("reopened TO releases its completion and planning block while retaining immutable evidence and photos", async () => {
  const f = await fixture();
  const original = await completions(f.refs, "dispatch_order_completion_events");
  assert.equal(original.length, 1);
  assert.equal((await effective(f.refs)).length, 1);
  await reopenDriverPwaStop(reopenInput(f));
  assert.equal((await effective(f.refs)).length, 0, "the audited reopen must supersede the earlier driver completion");
  assert.deepEqual(await completions(f.refs, "dispatch_order_completion_events"), original);
  const job = (await query("SELECT status,photo_data_urls FROM driver_job_records WHERE id=$1", [f.ids[0]])).rows[0];
  assert.equal(job.status, "pending");
  assert.deepEqual(job.photo_data_urls, f.photos);
  const order = (await loadDispatchOrdersForResponse({ type: "TO", search: f.refs[0], exactOrderRefs: f.refs, includeCompletedScmSearch: true })).find(row => row.id === f.refs[0]);
  assert.ok(order, "the source order must be searchable after reopen");
  assert.notEqual(order.dispatchCompletionStatus, "completed");
  assert.notEqual(order.dispatchPlanningRestricted, true);
  await assert.doesNotReject(() => assertNoDriverPwaCompletedDispatchRefs(f.refs, "replan"));
});

test("HTTP reopen enforces auth and stale-state guards then durably refreshes exact order references", async () => {
  const f = await fixture();
  const path = `/api/dispatch/driver-pwa/stops/${f.target.recordId}/reopen`;
  const body = reopenInput(f);
  assert.equal((await request(path, { token: "", method: "POST", body })).status, 401);
  assert.equal((await request(path, { token: salesToken, method: "POST", body })).status, 403);
  assert.equal((await request(path, { method: "POST", body: { ...body, expectedStateHash: "0".repeat(64) } })).status, 409);
  assert.equal((await effective(f.refs)).length, 1, "rejected requests must keep completion active");
  const result = await request(path, { method: "POST", body });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.orderRefs, f.refs);
  const queued = await query("SELECT order_ref FROM dispatch_order_catalog_refresh_outbox WHERE order_ref=ANY($1::text[])", [f.refs]);
  assert.deepEqual(queued.rows.map(row => row.order_ref), f.refs);
  const pool = await listDispatchOrderPool({ type: "TO", search: f.refs[0] });
  const order = pool.orders.find(row => row.id === f.refs[0]);
  assert.ok(order, "the indexed search pool must be refreshed before reopen returns");
  assert.notEqual(order.dispatchCompletionStatus, "completed");
  assert.notEqual(order.dispatchPlanningRestricted, true);
  const repeated = await request(path, { method: "POST", body });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.payload.correctionId, result.payload.correctionId);
});

test("one grouped-visit reopen releases all members and keeps unrelated completions active", async () => {
  const group = await fixture(2);
  const other = await fixture();
  assert.equal((await effective(group.refs)).length, 2);
  const result = await reopenDriverPwaStop(reopenInput(group));
  assert.deepEqual(new Set(result.orderRefs), new Set(group.refs));
  assert.equal((await effective(group.refs)).length, 0, "every physical-visit member must be superseded");
  assert.equal((await effective(other.refs)).length, 1);
  assert.equal((await completions(group.refs, "dispatch_order_completion_events")).length, 2);
});

test("recompletion appends a new idempotent cycle and stale pre-reopen completion cannot close the order", async () => {
  const f = await fixture();
  const original = (await completions(f.refs, "dispatch_order_completion_events"))[0];
  await reopenDriverPwaStop(reopenInput(f));
  await query("SELECT dispatch_record_order_completion('TO',$1,$2,'driver_job',$3)", [f.refs[0], original.dispatch_completed_at, f.drops[0].jobId]);
  assert.equal((await effective(f.refs)).length, 0, "stale completion replay must remain superseded");
  await query("UPDATE driver_job_records SET status='complete',completed_at=clock_timestamp() WHERE id=$1", [f.ids[0]]);
  const events = await completions(f.refs, "dispatch_order_completion_events");
  assert.equal(events.length, 2, "a completed reopened visit needs a new immutable completion cycle");
  const current = (await effective(f.refs))[0];
  assert.notEqual(current.completion_event_id, original.id);
  assert.ok(new Date(current.dispatch_completed_at) > new Date(original.dispatch_completed_at));
  const submitted = await Promise.all(Array.from({ length: 12 }, () => query("SELECT dispatch_record_order_completion('TO',$1,$2,'driver_job',$3) AS id", [f.refs[0], current.dispatch_completed_at, f.drops[0].jobId])));
  assert.equal(new Set(submitted.map(row => row.rows[0].id)).size, 1);
  assert.equal((await completions(f.refs, "dispatch_order_completion_events")).length, 2);
  await assert.rejects(query("UPDATE dispatch_order_completion_events SET reason='changed' WHERE id=$1", [original.id]), error => error.code === "55000");
  await assert.rejects(query("DELETE FROM dispatch_order_completion_events WHERE id=$1", [original.id]), error => error.code === "55000");
});

test("concurrent reopen retries converge on one correction and exact refresh request", async () => {
  const f = await fixture();
  const input = reopenInput(f);
  const results = await Promise.all(Array.from({ length: 8 }, () => reopenDriverPwaStop(input)));
  assert.equal(new Set(results.map(result => result.correctionId)).size, 1);
  assert.ok(results.every(result => result.orderRefs[0] === f.refs[0]));
  assert.equal((await effective(f.refs)).length, 0);
  const corrections = await query("SELECT id FROM driver_job_corrections WHERE idempotency_id=$1", [input.idempotencyId]);
  assert.equal(corrections.rowCount, 1);
  const refreshes = await query("SELECT id FROM dispatch_order_catalog_refresh_outbox WHERE order_ref=$1", [f.refs[0]]);
  assert.equal(refreshes.rowCount, 1);
});

test("reopen preserves independent manual completion and NetSuite terminal guards", async () => {
  const manual = await fixture();
  await query("SELECT dispatch_record_order_completion('TO',$1,clock_timestamp(),'manual_dispatch',$2,NULL,NULL,NULL,'operator','dispatcher','Independent confirmed completion')", [manual.refs[0], crypto.randomUUID()]);
  await reopenDriverPwaStop(reopenInput(manual));
  const retained = await effective(manual.refs);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].completion_evidence_type, "manual_dispatch");
  const closed = await fixture();
  await query("UPDATE transfer_orders SET status='H',status_text='Transfer Order : Closed' WHERE tranid=$1", [closed.refs[0]]);
  await assert.rejects(() => reopenDriverPwaStop(reopenInput(closed)), error => error.code === "DRIVER_PWA_STOP_NO_LONGER_ASSIGNED");
  const feed = await loadDispatchOrdersForResponse({ type: "TO", search: closed.refs[0], exactOrderRefs: closed.refs });
  assert.equal(feed.some(order => order.id === closed.refs[0]), false, "reopen must not override a NetSuite closed order");
  const closesLater = await fixture();
  await reopenDriverPwaStop(reopenInput(closesLater));
  await query("UPDATE transfer_orders SET status='H',status_text='Transfer Order : Closed' WHERE tranid=$1", [closesLater.refs[0]]);
  const laterFeed = await loadDispatchOrdersForResponse({ type: "TO", search: closesLater.refs[0], exactOrderRefs: closesLater.refs });
  assert.equal(laterFeed.some(order => order.id === closesLater.refs[0]), false, "later NetSuite closure must also remain authoritative");
});

test("multiple reopen cycles release every member and select only the most recent completion", async () => {
  const f = await fixture(2);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const listing = await listDriverPwaStops({ planDate: f.planDate, driverLogin: f.driverLogin });
    f.target = listing.stops.find(stop => Number(stop.recordId) === f.ids[0]);
    await reopenDriverPwaStop(reopenInput(f));
    assert.equal((await effective(f.refs)).length, 0);
    await query("UPDATE driver_job_records SET status='complete',completed_at=clock_timestamp() WHERE id=ANY($1::bigint[])", [f.ids]);
    const current = await effective(f.refs);
    assert.equal(current.length, 2);
    const events = await completions(f.refs, "dispatch_order_completion_events");
    assert.equal(events.length, (cycle + 2) * 2);
    for (const row of current) {
      const latest = events.filter(event => event.order_ref === row.order_ref).at(-1);
      assert.equal(row.completion_event_id, latest.id);
    }
  }
});
