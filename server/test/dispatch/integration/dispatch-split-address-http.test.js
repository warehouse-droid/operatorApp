import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { pool, query } from "../../../src/db.js";
import { updateDispatchOrderDetails } from "../../../src/dispatch-repository.js";
import { getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { getDriverPlanRoutesForDate } from "../../../src/driver-repository.js";
import { getDispatchOrderCatalogOrder, upsertDispatchOrderCatalog } from "../../../src/dispatch-order-catalog-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { seedSplitAddress, mossbrook, heatherside } from "../support/split-address-fixture.js";

let fixture;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks(id,plate,active) VALUES(819874800,'SPLIT-ADDRESS',true)");
  await query("INSERT INTO dispatch_drivers(id,name,login,active) VALUES(819874801,'Address driver','split-address',true)");
});
after(async () => fixture?.close());

test("real details HTTP save is audited, lease-protected, and survives a stale plan save and reload", async () => {
  const { parent, plan, splits } = await seedSplitAddress();
  const sessionId = "split-address-http";
  const lease = await fixture.acquireLease({ planDate: plan.planDate, sessionId });
  const headers = { "x-dispatch-edit-lease": lease };
  const trucks = [{ ...plan.trucks[0], id: "819874800", plate: "SPLIT-ADDRESS", driverLogin: "split-address",
    loads: plan.trucks[0].loads.map(load => ({ ...load, truckId: "819874800", driverLogin: "split-address" })) }];
  const saved = await fixture.request(`/api/dispatch/plans/${plan.id}`, { method: "PUT", headers,
    body: { planDate: plan.planDate, sessionId, baseRevision: 1, orders: splits, trucks } });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const stale = await getDispatchPlan(plan.id);
  const path = `/api/dispatch/orders/${splits[1].id}/details?response=ack`;
  const body = { planId: plan.id, planDate: plan.planDate, sessionId, type: "SO", sourceTable: "sales_orders",
    address: heatherside, pickupAddress: "", windowStart: "", windowEnd: "", expectedDeliveryDate: "",
    audit: { sessionId, before: splits[1] } };
  const denied = await fixture.request(path, { method: "PUT", body: { ...body, sessionId: "no-lease" } });
  assert.equal(denied.response.status, 409);
  assert.equal((await getDispatchOrderCatalogOrder(splits[1].id)).address, mossbrook);
  const edited = await fixture.request(path, { method: "PUT", headers, body });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.updated.dispatch_address, heatherside);
  const audit = (await query("SELECT details,after_state FROM dispatch_audit_log WHERE action='dispatch_info_updated' AND order_id=$1", [splits[1].id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.address, heatherside);
  await upsertDispatchOrderCatalog({ orders: [parent], source: "split-address-http-refresh" });
  const staleSave = await fixture.request(`/api/dispatch/plans/${plan.id}`, { method: "PUT", headers,
    body: { ...stale, planDate: plan.planDate, sessionId, baseRevision: stale.revision } });
  assert.equal(staleSave.response.status, 200, JSON.stringify(staleSave.payload));
  const reloaded = await getDispatchPlan(plan.id);
  assert.equal(reloaded.orders.find(order => order.id === splits[1].id).destinationAddress, heatherside);
  assert.equal(reloaded.orders.find(order => order.id === splits[0].id).destinationAddress, mossbrook);
  assert.deepEqual(reloaded.trucks.flatMap(truck => truck.loads.flatMap(load => load.stops.map(stop => stop.id))),
    stale.trucks.flatMap(truck => truck.loads.flatMap(load => load.stops.map(stop => stop.id))));
  const search = await fixture.request(`/api/dispatch/orders?type=SO&search=${splits[1].id}`);
  assert.equal(search.response.status, 200, JSON.stringify(search.payload));
  const orders = Array.isArray(search.payload) ? search.payload : search.payload.orders;
  assert.equal(orders.find(order => order.id === splits[1].id).destinationAddress, heatherside);
  const persisted = (await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id=$1", [plan.id])).rows[0].orders;
  assert.equal(persisted.find(order => order.id === splits[1].id).destinationAddress, heatherside);
  const confirmed = await fixture.request(`/api/dispatch/plans/${plan.id}/confirm`, {
    method: "POST", headers, body: { sessionId }
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
  const driverDay = await getDriverPlanRoutesForDate(plan.planDate);
  const jobs = driverDay.routes.flatMap(route => route.jobs).filter(job => job.stopType === "dropoff");
  assert.equal(jobs.find(job => job.orderRefs.includes(splits[1].id))?.address, heatherside);
  assert.equal(jobs.find(job => job.orderRefs.includes(splits[0].id))?.address, mossbrook);
});

test("an in-flight plan save cannot race past the explicit split edit", async () => {
  const { splits } = await seedSplitAddress({ planDate: "2096-11-14" });
  const client = await pool.connect();
  let pending;
  let finished = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    pending = updateDispatchOrderDetails(splits[1].id, { type: "SO", address: heatherside }).then(value => { finished = true; return value; });
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) {
      blocked = (await query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid <> pg_backend_pid() LIMIT 1")).rowCount > 0;
      if (blocked) {break;}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(finished, false, "The details write must wait for the prior plan save.");
    assert.equal(blocked, true, "Observe the real PostgreSQL advisory-lock wait.");
    await client.query("UPDATE dispatch_global_order_splits SET full_order=$2::jsonb WHERE split_ref=$1", [splits[1].id, JSON.stringify(splits[1])]);
    await client.query("COMMIT");
    assert.equal((await pending).dispatch_address, heatherside);
    assert.equal((await getDispatchOrderCatalogOrder(splits[1].id)).address, heatherside);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pending;
  }
});
