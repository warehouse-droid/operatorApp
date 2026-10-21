import assert from "node:assert/strict";
import test, { after } from "node:test";
import express from "express";
import { closeDb } from "../../../src/db.js";
import { createMbtRouter } from "../../../src/mbt/router.js";
import { planningFixture, command, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);

test("authorized HTTP planner commands and legacy BIN writes use the same date lease", async () => {
  const f = await planningFixture(1800); const events = [];
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.operator = { id: f.actor.operatorId,
    roles: req.get("x-test-denied") ? ["sales"] : ["dispatcher"] }; next(); });
  app.use("/api/mbt", createMbtRouter({ authorizePhase3Capability: async () => ({}),
    planningChanged: data => events.push(data) }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const denied = await fetch(`${url}/api/mbt/planning?planDate=${f.planDate}`, { headers: { "x-test-denied": "1" } });
    assert.equal(denied.status, 403);
    const read = await fetch(`${url}/api/mbt/planning?planDate=${f.planDate}&search=${f.contractNumber}`);
    assert.equal(read.status, 200); assert.equal((await read.json()).pool.items.length, 1);
    const input = await command(f, "assign");
    const headers = { "content-type": "application/json", "idempotency-key": input.idempotencyKey };
    const { editLease, ...body } = input;
    for (const path of ["/api/mbt/planning/commands", "/api/mbt/dispatch/assignments"]) {
      const response = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(response.status, 409); assert.equal((await response.json()).code, "DISPATCH_PLAN_EDIT_LEASE_REQUIRED");
    }
    assert.equal((await storedPlan(f.planId)).revision, input.baseRevision); assert.equal(events.length, 0);
    const saved = await fetch(`${url}/api/mbt/planning/commands`, { method: "POST", headers,
      body: JSON.stringify({ ...body, sessionId: editLease.sessionId, editLeaseToken: editLease.token }) });
    assert.equal(saved.status, 201); const result = await saved.json();
    assert.equal(result.plan.revision, input.baseRevision + 1);
    assert.equal(events.length, 1); assert.equal(events[0].planId, f.planId);
    assert.equal(events[0].revision, (await storedPlan(f.planId)).revision);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
