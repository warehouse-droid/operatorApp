import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { query, pool } from "../../../src/db.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { resplitUnfinishedSalesOrder } from "../../../src/dispatch-sales-resplit-repository.js";
import { persistedDispatchPlan } from "../../../src/dispatch-plan-fence.js";
import { assertDispatchPlanFence } from "../../../src/dispatch-planner-performance.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { seedUnfinishedSplit } from "../support/unfinished-sales-resplit-fixture.js";

let http;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => http?.close());
const path = "/api/dispatch/split-orders/unsplit";
async function setup(date) {
  const fixture = await seedUnfinishedSplit({ date });
  const result = await resplitUnfinishedSalesOrder({ orderRef: fixture.source.id, planId: fixture.current.id,
    planDate: date, expectedItems: fixture.source.items, parts: fixture.parts });
  return { fixture, result, body: { orderRef: result.orders[0].id, orderType: "SO", planId: fixture.current.id, planDate: date } };
}

test("SO Unsplit HTTP requires edit permission, derives every sibling, and acknowledges the saved plan fence", async () => {
  const { fixture, result, body } = await setup("2097-11-15"), sessionId = "unsplit-http";
  const missingLease = await http.request(path, { method: "POST", body: { ...body, audit: { sessionId } } });
  assert.equal(missingLease.response.status, 409);
  const unauthorized = await http.request(path, { method: "POST", token: "", body });
  assert.equal(unauthorized.response.status, 401);
  const lease = await http.acquireLease({ planDate: body.planDate, sessionId });
  const history = await fixture.history();
  const response = await http.request(path, { method: "POST", headers: { "x-dispatch-edit-lease": lease },
    body: { ...body, splitOrderIds: [body.orderRef], originalOrderId: "FORGED-ROOT", audit: { sessionId } } });
  assert.equal(response.response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.restoredOrder.id, fixture.source.id);
  assert.deepEqual(response.payload.deactivated.sort(), result.orders.map(order => order.id).sort());
  assert.deepEqual(await fixture.history(), history);
  const stored = (await query(`SELECT p.id,p.plan_date,p.revision,p.status,p.note,s.saved_at,s.orders,s.trucks,s.summary
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [fixture.current.id])).rows[0];
  const plan = persistedDispatchPlan(stored);
  assert.equal(response.payload.planDigest, plan.digest);
  assert.doesNotThrow(() => assertDispatchPlanFence(plan, { baseRevision: response.payload.planRevision,
    baseDigest: response.payload.planDigest }, { required: true }));
});

test("SO Unsplit HTTP rechecks the edit lease after waiting for the fleet lock", async () => {
  const { fixture, body } = await setup("2097-11-16"), sessionId = "unsplit-http-expiry";
  const lease = await http.acquireLease({ planDate: body.planDate, sessionId }), client = await pool.connect();
  let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    pending = http.request(path, { method: "POST", headers: { "x-dispatch-edit-lease": lease }, body: { ...body, audit: { sessionId } } });
    await client.query("SELECT pg_sleep(0.1)");
    await client.query("UPDATE dispatch_plan_edit_leases SET expires_at=now()-interval '1 second' WHERE plan_date=$1", [body.planDate]);
    await client.query("COMMIT");
    const response = await pending;
    assert.equal(response.response.status, 409, JSON.stringify(response.payload));
    assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [body.orderRef])).rows[0].active, true);
    assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, false);
  } finally {
    await client.query("ROLLBACK"); client.release(); await pending;
  }
});

test("an operator account cannot use the SO Unsplit endpoint", async () => {
  const operator = await createOperator({ username: "unsplit-operator", displayName: "Unsplit Operator", role: "operator", password: "unsplit-test-password" });
  const session = await loginOperator(operator.username, "unsplit-test-password");
  const result = await http.request(path, { method: "POST", token: session.token, body: {} });
  assert.equal(result.response.status, 403);
});
