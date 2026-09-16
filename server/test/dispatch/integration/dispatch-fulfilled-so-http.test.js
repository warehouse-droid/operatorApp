import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { query } from "../../../src/db.js";
import { createDispatchPlan, getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { seedSalesOrder, completeDriver } from "../support/fulfilled-so-fixture.js";

let fixture;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks (id,plate,active) VALUES (817158900,'FULFILLED-HTTP',true)");
  await query("INSERT INTO dispatch_drivers (id,name,login,active) VALUES (817158901,'Fulfilled driver','fulfilled-http',true)");
});
after(async () => fixture?.close());

async function board(index, ref) {
  const date = `2096-10-${String(index).padStart(2, "0")}`;
  const plan = await createDispatchPlan({ planDate: date });
  const sessionId = `fulfilled-http-${index}`;
  const lease = await fixture.acquireLease({ planDate: date, sessionId });
  const search = await fixture.request(`/api/dispatch/orders?type=SO&search=${ref}`);
  assert.equal(search.response.status, 200, JSON.stringify(search.payload));
  const orders = Array.isArray(search.payload) ? search.payload : search.payload.orders;
  const order = orders.find(row => row.id === ref);
  assert.ok(order, "HTTP search returns the fulfilled order");
  const trucks = [{ id: "817158900", plate: "FULFILLED-HTTP", driverId: "817158901", driverLogin: "fulfilled-http", loads: [{
    id: `fulfilled-http-load-${index}`, name: "Delivery", driverId: "817158901", driverLogin: "fulfilled-http", truckId: "817158900",
    orders: [ref], stops: [{ id: `pickup-${index}`, type: "pickup", orderId: ref, yard: "3445" },
      { id: `drop-${index}`, type: "drop", orderId: ref, address: "Test Road" }]
  }] }];
  return { plan, lease, sessionId, body: { planDate: date, baseRevision: plan.revision, orders: [order], trucks, sessionId } };
}

test("HTTP billed SO can be saved and confirmed with completion retained", async () => {
  const ref = "SO-FULFILLED-HTTP-G";
  await seedSalesOrder(817158001, ref, { status: "G" });
  const { plan, lease, body } = await board(1, ref);
  const saved = await fixture.request(`/api/dispatch/plans/${plan.id}`, {
    method: "PUT", headers: { "x-dispatch-edit-lease": lease }, body
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const confirmed = await fixture.request(`/api/dispatch/plans/${plan.id}/confirm`, {
    method: "POST", headers: { "x-dispatch-edit-lease": lease }, body: { sessionId: body.sessionId }
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
  const retained = await getDispatchPlan(plan.id);
  assert.ok(retained.orders.some(order => order.id === ref && order.dispatchCompletionStatus === "completed"));
  assert.equal(retained.status, "confirmed");
  const driverDay = await getDriverDayJobs("fulfilled-http", { date: body.planDate });
  const delivery = driverDay.jobs.find(job => ["drop", "dropoff"].includes(job.stopType) && job.orderRefs.includes(ref));
  assert.ok(delivery, "A real Driver delivery job remains after NetSuite completion");
  assert.notEqual(delivery.status, "complete");
});

test("driver completion after search denies stale or forged flags on save, confirm and v2 command", async () => {
  const ref = "SO-FULFILLED-HTTP-STALE";
  await seedSalesOrder(817158002, ref);
  const { plan, lease, body, sessionId } = await board(2, ref);
  assert.equal(body.orders[0].dispatchFulfilledSalesPlanningEligible, true);
  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${plan.id}&date=${body.planDate}`);
  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  await completeDriver(ref);
  const before = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [plan.id])).rows;
  for (const [method, path, payload] of [
    ["PUT", `/api/dispatch/plans/${plan.id}`, body],
    ["POST", `/api/dispatch/plans/${plan.id}/confirm`, body],
    ["POST", `/api/dispatch/v2/plans/${plan.id}/commands`, {
      commandId: "fulfilled-stale-command", baseRevision: bootstrap.payload.plan.revision,
      baseDigest: bootstrap.payload.plan.digest, sessionId, commandType: "replace_plan", payload: body
    }]
  ]) {
    const response = await fixture.request(path, { method, headers: { "x-dispatch-edit-lease": lease }, body: payload });
    if (method === "PUT" || path.endsWith("/commands")) {
      assert.equal(response.response.status, 202, JSON.stringify(response.payload));
      assert.equal(response.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
      assert.equal(response.payload.applied, false);
      assert.equal(response.payload.validationIssues[0].code, "DISPATCH_ORDER_DRIVER_COMPLETED");
    } else {
      assert.equal(response.response.status, 409, JSON.stringify(response.payload));
      assert.equal(response.payload.code, "DISPATCH_ORDER_DRIVER_COMPLETED");
    }
  }
  assert.deepEqual((await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [plan.id])).rows, before);
});

test("v2 replacement can plan an inactive NetSuite-fulfilled SO on a historical date", async () => {
  const ref = "SO-FULFILLED-HTTP-HISTORY";
  await seedSalesOrder(817158003, ref, { status: "G", active: false });
  const plan = await createDispatchPlan({ planDate: "2020-09-15" });
  const sessionId = "fulfilled-http-history";
  const lease = await fixture.acquireLease({ planDate: plan.planDate, sessionId });
  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${plan.id}&date=${plan.planDate}`);
  const search = await fixture.request(`/api/dispatch/orders?type=SO&search=${ref}`);
  const order = search.payload.find(row => row.id === ref);
  assert.equal(order.dispatchFulfilledSalesPlanningEligible, true);
  const response = await fixture.request(`/api/dispatch/v2/plans/${plan.id}/commands`, {
    method: "POST", headers: { "x-dispatch-edit-lease": lease }, body: {
      commandId: "fulfilled-inactive-history", baseRevision: bootstrap.payload.plan.revision, baseDigest: bootstrap.payload.plan.digest,
      sessionId, commandType: "replace_plan", payload: { planDate: plan.planDate, orders: [order], trucks: [{
        id: "817158900", plate: "FULFILLED-HTTP", driverLogin: "fulfilled-http", loads: [{
          id: "fulfilled-history-load", driverLogin: "fulfilled-http", truckId: "817158900", orders: [ref],
          stops: [{ id: "fulfilled-history-drop", type: "drop", orderId: ref, address: "Test Road" }]
        }]
      }] }
    }
  });
  assert.equal(response.response.status, 200, JSON.stringify(response.payload));
  assert.ok((await getDispatchPlan(plan.id)).orders.some(row => row.id === ref));
});
