import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { pool, query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { seedUnfinishedSplit } from "../support/unfinished-sales-resplit-fixture.js";

let http;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => http?.close());

test("real resplit HTTP requires an edit lease then replaces only open S2, and retries safely", async () => {
  const fixture = await seedUnfinishedSplit(), priorHistory = await fixture.history();
  const sessionId = "unfinished-resplit-http";
  const body = { orderRef: fixture.source.id, planId: fixture.current.id, planDate: fixture.current.planDate,
    expectedItems: fixture.source.items, parts: fixture.parts, audit: { sessionId } };
  const path = "/api/dispatch/split-orders/resplit";
  const missing = await http.request(path, { method: "POST", body });
  assert.equal(missing.response.status, 409, JSON.stringify(missing.payload));
  const lease = await http.acquireLease({ planDate: fixture.current.planDate, sessionId });
  const headers = { "x-dispatch-edit-lease": lease };
  const result = await http.request(path, { method: "POST", body, headers });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.orders.map(order => order.id), [3, 4, 5].map(number => `${fixture.parent}-S${number}`));
  assert.deepEqual(await fixture.history(), priorHistory);
  const replay = await http.request(path, { method: "POST", body, headers });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.deepEqual(replay.payload.orders.map(order => order.id), result.payload.orders.map(order => order.id));
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE action='order_resplit' AND order_id=$1", [fixture.source.id])).rows[0].n, 1);
  const unauthorized = await http.request(path, { method: "POST", token: "", body });
  assert.equal(unauthorized.response.status, 401);
});

test("resplit HTTP rejects a date from a different plan without retiring source", async () => {
  const fixture = await seedUnfinishedSplit({ date: "2097-10-15" });
  const sessionId = "unfinished-resplit-wrong-date";
  const lease = await http.acquireLease({ planDate: "2097-10-16", sessionId });
  const result = await http.request("/api/dispatch/split-orders/resplit", { method: "POST",
    headers: { "x-dispatch-edit-lease": lease }, body: { orderRef: fixture.source.id, planId: fixture.current.id,
      planDate: "2097-10-16", expectedItems: fixture.source.items, parts: fixture.parts, audit: { sessionId } } });
  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "DISPATCH_SPLIT_PLAN_MISMATCH");
  assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
});


test("an operator account cannot resplit orders", async () => {
  const operator = await createOperator({ username: 'resplit-operator', displayName: 'Resplit Operator', role: 'operator', password: 'resplit-test-password' });
  const session = await loginOperator(operator.username, 'resplit-test-password');
  const result = await http.request('/api/dispatch/split-orders/resplit', { method: 'POST', token: session.token, body: {} });
  assert.equal(result.response.status, 403);
});

test("HTTP resplit rechecks the edit lease after waiting for the fleet lock", async () => {
  const fixture = await seedUnfinishedSplit({ date: "2097-10-17" }), sessionId = "resplit-expired-lease";
  const lease = await http.acquireLease({ planDate: fixture.current.planDate, sessionId });
  const client = await pool.connect(); let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    pending = http.request('/api/dispatch/split-orders/resplit', { method: 'POST', headers: { 'x-dispatch-edit-lease': lease },
      body: { orderRef: fixture.source.id, planId: fixture.current.id, planDate: fixture.current.planDate,
        expectedItems: fixture.source.items, parts: fixture.parts, audit: { sessionId } } });
    await client.query('SELECT pg_sleep(0.1)');
    assert.ok((await query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND datname=current_database()")).rowCount > 0);
    await client.query("UPDATE dispatch_plan_edit_leases SET expires_at=now()-interval '1 second' WHERE plan_date=$1", [fixture.current.planDate]);
    await client.query('COMMIT');
    const result = await pending;
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
  } finally { await client.query('ROLLBACK'); client.release(); await pending; }
});
