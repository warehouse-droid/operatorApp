import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { after, before, test } from "node:test";
import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

const date = "2026-01-01";
const sessionId = "dispatch-search-http-session";
const source = await readFile(process.env.DISPATCH_SEARCH_SOURCE || new URL("../../../public/dispatch.js", import.meta.url), "utf8");
const start = source.indexOf("function dispatchOrderFeedRequest(");
const end = source.indexOf("\nfunction timeText(", start);
let fixture, lease;

before(async () => {
  fixture = await createDispatchV2Fixture();
  lease = await fixture.acquireLease({ planDate: date, sessionId });
});
after(async () => {
  await query("DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1 AND session_id=$2", [date, sessionId]);
  await fixture?.close();
});

for (const versioned of [false, true]) {
  test(`${versioned ? "v2" : "legacy"}: production browser request succeeds against the actual historical search API`, async () => {
    const context = vm.createContext({ URLSearchParams, currentPlanDate: date, dispatchSessionId: sessionId,
      planEditLeaseToken: lease, isDispatchHistoryEditMode: () => true });
    vm.runInContext(source.slice(start, end), context);
    for (const search of ["TOB01164", "TOB01163"]) {
      const request = context.dispatchOrderFeedRequest({ versioned, search });
      assert.equal(new URL(request.url, fixture.baseUrl).pathname,
        versioned ? "/api/dispatch/v2/order-pool" : "/api/dispatch/orders");
      const result = await fixture.request(request.url, { headers: request.headers });
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      assert.ok(Array.isArray(versioned ? result.payload.orders : result.payload));
    }
  });
}

for (const path of ["/api/dispatch/orders", "/api/dispatch/v2/order-pool", "/api/dispatch/sync"]) {
  test(`${path}: historical reads reject missing, wrong and cross-date lease credentials`, async () => {
    const options = { headers: { "x-dispatch-edit-lease": lease }, method: path.endsWith("sync") ? "POST" : "GET" };
    const params = new URLSearchParams({ historyPlanDate: date, search: "TOB01164" });
    let result = await fixture.request(`${path}?${params}`, options);
    assert.equal(result.response.status, 400, JSON.stringify(result.payload));
    assert.equal(result.payload.error, "A dispatch browser session is required.");
    params.set("sessionId", "another-tab");
    result = await fixture.request(`${path}?${params}`, options);
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.match(result.payload.code, /DISPATCH_PLAN_EDIT_LEASE/);
    params.set("sessionId", sessionId);
    result = await fixture.request(`${path}?${params}`, { ...options, headers: { "x-dispatch-edit-lease": "invalid" } });
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    result = await fixture.request(`${path}?${params}`, options);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    params.set("historyPlanDate", "2025-12-31");
    result = await fixture.request(`${path}?${params}`, options);
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    result = await fixture.request(`${path}?${params}`, { ...options, token: "" });
    assert.equal(result.response.status, 401, JSON.stringify(result.payload));
  });
}

test("expired historical leases remain rejected by both search APIs", async () => {
  await query("UPDATE dispatch_plan_edit_leases SET expires_at=now()-interval '1 second' WHERE plan_date=$1 AND session_id=$2", [date, sessionId]);
  const params = new URLSearchParams({ historyPlanDate: date, sessionId, search: "TOB01163" });
  for (const path of ["/api/dispatch/orders", "/api/dispatch/v2/order-pool"]) {
    const result = await fixture.request(`${path}?${params}`, { headers: { "x-dispatch-edit-lease": lease } });
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.match(result.payload.code, /DISPATCH_PLAN_EDIT_LEASE/);
  }
});
