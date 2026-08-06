// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { recordDispatchPerformance, summarizeDispatchPerformance } from "../support/dispatch-performance-recorder.js";
import { createDispatchV2Fixture, dispatchOrder, dispatchTrucks } from "../support/dispatch-v2-fixture.js";
import { query } from "../../../src/db.js";

let fixture;

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

test("DP-13 and DP-16: checkpoint list is metadata-only and compact reads/commands record bounded timings", { timeout: 60_000 }, async () => {
  const refs = Array.from({ length: 609 }, (_, index) => `DP-PERF-${index + 1}`);
  const seeded = await fixture.seedPlan({ date: "2025-04-15", refs });
  const orders = refs.map(dispatchOrder);
  const trucks = dispatchTrucks(refs);
  // Large historical rows reproduce the expensive list path without using any
  // shared data.  The v2 metadata list must not serialize these documents.
  for (let index = 0; index < 100; index += 1) {
    await query(
      `INSERT INTO dispatch_plan_snapshot_history (
         plan_id, plan_date, revision, orders, trucks, summary, archive_reason, session_id
       ) VALUES ($1, $2::date, $3, $4::jsonb, $5::jsonb, $6::jsonb, 'isolated_performance_fixture', 'dispatch-v2-performance')`,
      [seeded.id, seeded.plan_date, index + 1, JSON.stringify(orders), JSON.stringify(trucks), JSON.stringify({ index })]
    );
  }

  const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-performance" });
  /** @type {{name: string, durationMs: number, responseBytes: number}[]} */
  const samples = [];
  let boot;
  for (let index = 0; index < 5; index += 1) {
    const result = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}&date=${seeded.plan_date}`);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.ok(result.responseBytes < 250_000, `compact bootstrap must be below 250 KB, got ${result.responseBytes}`);
    samples.push({ name: "bootstrap", durationMs: result.durationMs, responseBytes: result.responseBytes });
    boot = result.payload;
  }

  for (let index = 0; index < 5; index += 1) {
    const result = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/checkpoints?date=${seeded.plan_date}`);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.checkpoints.length, 100);
    assert.ok(result.responseBytes < 100_000, `metadata list must be below 100 KB, got ${result.responseBytes}`);
    assert.equal(Object.hasOwn(result.payload.checkpoints[0], "orders"), false);
    assert.equal(Object.hasOwn(result.payload.checkpoints[0], "trucks"), false);
    samples.push({ name: "checkpoint_list", durationMs: result.durationMs, responseBytes: result.responseBytes });
  }

  let current = boot;
  const replacementTrucks = structuredClone(current.plan.trucks);
  replacementTrucks[0].loads[0].stops.splice(
    0,
    2,
    replacementTrucks[0].loads[0].stops[1],
    replacementTrucks[0].loads[0].stops[0]
  );
  const replacement = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId: "dp16-browser-replace",
      baseRevision: current.plan.revision,
      baseDigest: current.plan.digest,
      sessionId: "dispatch-v2-performance",
      commandType: "replace_plan",
      payload: {
        planDate: seeded.plan_date,
        orders: current.plan.assignedOrderSnapshots,
        trucks: replacementTrucks,
        summary: current.plan.summary,
        actionName: "move_stop",
        affectedOrderRefs: ["DP-PERF-1", "DP-PERF-2"]
      }
    }
  });
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.payload));
  assert.ok(replacement.responseBytes < 250_000);
  assert.ok(replacement.durationMs < 1_000, `browser replace acknowledgement took ${replacement.durationMs}ms`);
  samples.push({ name: "replace_plan_ui_autosave", durationMs: replacement.durationMs, responseBytes: replacement.responseBytes });
  current = replacement.payload;
  const sequenceStarted = performance.now();
  let targetedPopupRef = "";
  for (const [index, commandType, payload] of [
    [0, "remove_order", { orderRef: "DP-PERF-1" }],
    [1, "assign_order", { orderRef: "DP-PERF-1", truckId: "DP-V2-TEST", loadId: "dp-v2-load-1" }],
    [2, "group_orders", { orderRefs: ["DP-PERF-2", "DP-PERF-3"] }]
  ]) {
    const result = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
      method: "POST",
      headers: { "x-dispatch-edit-lease": lease },
      body: {
        commandId: `dp16-${index}`,
        baseRevision: current.plan.revision,
        baseDigest: current.plan.digest,
        sessionId: "dispatch-v2-performance",
        commandType,
        payload
      }
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.ok(result.responseBytes < 250_000);
    samples.push({ name: commandType, durationMs: result.durationMs, responseBytes: result.responseBytes });
    current = result.payload;
    if (commandType === "group_orders") {targetedPopupRef = String(result.payload.patch?.group?.ref || "");}
  }
  const sequenceMs = performance.now() - sequenceStarted;
  samples.push({ name: "continuous_sequence", durationMs: sequenceMs, responseBytes: 0 });
  assert.ok(targetedPopupRef, "The continuous action sequence must create a targeted group order.");
  for (let index = 0; index < 3; index += 1) {
    const result = await fixture.request(`/api/dispatch/v2/order-feed/${encodeURIComponent(targetedPopupRef)}`);
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.order?.id, targetedPopupRef);
    assert.match(result.response.headers.get("cache-control") || "", /private, no-store/i);
    assert.ok(result.responseBytes < 50_000, `targeted popup refresh must stay below 50 KB, got ${result.responseBytes}`);
    samples.push({ name: "targeted_popup_order_refresh", durationMs: result.durationMs, responseBytes: result.responseBytes });
  }
  const summary = summarizeDispatchPerformance(samples);
  await recordDispatchPerformance(samples);
  assert.ok(summary.p95Ms < 1_000, `P95 command/read time must remain below 1,000ms; got ${summary.p95Ms}`);
  assert.ok(sequenceMs < 4_000, `continuous sequence must remain below 4,000ms; got ${sequenceMs}`);
});
