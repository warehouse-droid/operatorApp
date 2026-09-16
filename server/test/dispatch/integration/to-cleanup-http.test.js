import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { query } from "../../../src/db.js";
import { createDispatchPlan, getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { getDriverDayJobs, startDriverJob, recordDriverJobPhotos } from "../../../src/driver-repository.js";
import { driverCompanyDate } from "../../../src/driver-plan-date-policy.js";
import { assertTransferPlanningAllowed } from "../../../src/dispatch-fulfilled-to-repository.js";
import { readTransferCleanupState, createTransferCleanupManifest, applyTransferCleanupManifest } from "../../../tools/to-cleanup-repository.mjs";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { completeDriver } from "../support/fulfilled-so-fixture.js";
import { seedTransfer } from "../support/fulfilled-to-fixture.js";

let fixture;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks (id,plate,active) VALUES (827158900,'TO-FULFILLED-HTTP',true)");
  await query("INSERT INTO dispatch_drivers (id,name,login,active) VALUES (827158901,'Fulfilled driver','to-fulfilled-http',true)");
});
after(async () => fixture?.close());

async function board(index, ref) {
  const date = index === 1 ? driverCompanyDate() : `2096-11-${String(index).padStart(2, "0")}`;
  const plan = await createDispatchPlan({ planDate: date });
  const sessionId = `to-fulfilled-http-${index}`;
  const lease = await fixture.acquireLease({ planDate: date, sessionId });
  const search = await fixture.request(`/api/dispatch/orders?type=TO&search=${ref}`);
  assert.equal(search.response.status, 200, JSON.stringify(search.payload));
  const orders = Array.isArray(search.payload) ? search.payload : search.payload.orders;
  const order = orders.find(row => row.id === ref);
  assert.ok(order, "HTTP search returns the fulfilled order");
  const trucks = [{ id: "827158900", plate: "TO-FULFILLED-HTTP", driverId: "827158901", driverLogin: "to-fulfilled-http", loads: [{
    id: `to-fulfilled-http-load-${index}`, name: "Delivery", driverId: "827158901", driverLogin: "to-fulfilled-http", truckId: "827158900",
    orders: [ref], stops: [{ id: `pickup-${index}`, type: "pickup", orderId: ref, yard: "3445" },
      { id: `drop-${index}`, type: "drop", orderId: ref, address: "Test Road" }]
  }] }];
  return { plan, lease, sessionId, body: { planDate: date, baseRevision: plan.revision, orders: [order], trucks, sessionId } };
}

test("cleaned TO can be planned, confirmed and completed by Driver while receipt evidence stays unchanged", async () => {
  const ref = "TO-TO-FULFILLED-HTTP-G";
  await seedTransfer(827158001, ref, { status: "G" });
  const manifest = createTransferCleanupManifest(await readTransferCleanupState(), { mode: "netsuite-read-only-select", transactionType: "TrnfrOrd",
    completedAt: new Date().toISOString(), rows: [{ id: "827158001", tranid: ref, status: "G", status_text: "Transfer Order : Received" }] });
  await applyTransferCleanupManifest(manifest);
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
  const driverDay = await getDriverDayJobs("to-fulfilled-http", { date: body.planDate });
  const delivery = driverDay.jobs.find(job => ["drop", "dropoff"].includes(job.stopType) && job.orderRefs.includes(ref));
  assert.ok(delivery, "A real Driver delivery job remains after NetSuite completion");
  assert.notEqual(delivery.status, "complete");
  const receiptsBefore = (await query("SELECT * FROM receiving_receipt_records ORDER BY id")).rows;
  const physical = driverDay.jobs.filter(job => ["pickup", "drop", "dropoff"].includes(job.stopType) && job.orderRefs.includes(ref));
  for (const job of physical) {
    assert.equal((await startDriverJob("to-fulfilled-http", job.jobId, { job })).status, "in_progress");
    const photoDataUrls = Array.from({ length: Math.max(2, Number(job.requiredPhotos || 2)) }, (_, i) =>
      `r2://driver/driver-dropoff-photo/2026/09/15/to-cleanup/${job.stopType}-${i}.jpg`);
    assert.equal((await recordDriverJobPhotos("to-fulfilled-http", job.jobId, { job, photoDataUrls })).status, "complete");
    if (job.stopType === "pickup") await assertTransferPlanningAllowed([ref]);
  }
  await assert.rejects(assertTransferPlanningAllowed([ref]), { code: "DISPATCH_TRANSFER_DELIVERY_RESTRICTED" });
  assert.deepEqual((await query("SELECT * FROM receiving_receipt_records ORDER BY id")).rows, receiptsBefore);
});

test("driver completion after search denies stale or forged flags on save, confirm and v2 command", async () => {
  const ref = "TO-TO-FULFILLED-HTTP-STALE";
  await seedTransfer(827158002, ref);
  const { plan, lease, body, sessionId } = await board(2, ref);
  assert.equal(body.orders[0].dispatchFulfilledTransferPlanningEligible, true);
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

test("v2 replacement can plan a NetSuite-received TO on a historical date", async () => {
  const ref = "TO-TO-FULFILLED-HTTP-HISTORY";
  await seedTransfer(827158003, ref, { status: "G" });
  const plan = await createDispatchPlan({ planDate: "2021-09-15" });
  const sessionId = "to-fulfilled-http-history";
  const lease = await fixture.acquireLease({ planDate: plan.planDate, sessionId });
  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${plan.id}&date=${plan.planDate}`);
  const search = await fixture.request(`/api/dispatch/orders?type=TO&search=${ref}`);
  const order = search.payload.find(row => row.id === ref);
  assert.equal(order.dispatchFulfilledTransferPlanningEligible, true);
  const response = await fixture.request(`/api/dispatch/v2/plans/${plan.id}/commands`, {
    method: "POST", headers: { "x-dispatch-edit-lease": lease }, body: {
      commandId: "to-cleanup-received-history", baseRevision: bootstrap.payload.plan.revision, baseDigest: bootstrap.payload.plan.digest,
      sessionId, commandType: "replace_plan", payload: { planDate: plan.planDate, orders: [order], trucks: [{
        id: "827158900", plate: "TO-FULFILLED-HTTP", driverLogin: "to-fulfilled-http", loads: [{
          id: "fulfilled-history-load", driverLogin: "to-fulfilled-http", truckId: "827158900", orders: [ref],
          stops: [{ id: "fulfilled-history-drop", type: "drop", orderId: ref, address: "Test Road" }]
        }]
      }] }
    }
  });
  assert.equal(response.response.status, 200, JSON.stringify(response.payload));
  assert.ok((await getDispatchPlan(plan.id)).orders.some(row => row.id === ref));
});
