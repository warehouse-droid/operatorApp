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

test("DP-17: compact bootstrap preserves assigned Custom Order identity and operational fields through save", { timeout: 30_000 }, async () => {
  const customRef = "DP-CO-COMPACT-IDENTITY";
  const inserted = await query(
    `INSERT INTO dispatch_custom_orders (
       ref_number, pickup_location, dropoff_location, order_details,
       weight_lbs, stop_minutes, status, created_by, updated_by
     ) VALUES ($1, '3445', '88 Compact Test Road', 'Compact identity evidence',
       2300, 47, 'open', 'dispatch-v2-test', 'dispatch-v2-test')
     RETURNING id::text AS id`,
    [customRef]
  );
  const customOrderId = inserted.rows[0].id;
  const seeded = await fixture.seedPlan({ date: "2038-11-15", refs: [customRef] });
  const customOrder = {
    ...dispatchOrder(customRef, 1),
    customOrderId,
    customOrder: true,
    type: "CUSTOM",
    sourceTable: "dispatch_custom_orders",
    dispatchRef: customRef,
    address: "88 Compact Test Road",
    destinationAddress: "88 Compact Test Road",
    sourceAddress: "3445",
    defaultSourceAddress: "3445",
    stopMinutes: 47,
    instructions: "Compact identity evidence",
    salesQuantities: [{ unit: "LOAD", quantity: 1 }],
    packed: { pallets: 0, layers: 0, sections: 0, pieces: 0 },
    raw: { custom_order_id: customOrderId, stop_minutes: 47 }
  };
  const trucks = [{
    id: "DP-CO-TRUCK",
    plate: "DP-CO-TRUCK",
    loads: [{
      id: "dp-co-load-1",
      name: "Load 1",
      stops: [
        { id: "dp-co-pick", type: "pick", orderId: customRef, location: "3445" },
        { id: "dp-co-drop", type: "drop", orderId: customRef, location: "88 Compact Test Road" }
      ]
    }]
  }];
  await query(
    `UPDATE dispatch_plan_snapshots
        SET orders = $2::jsonb, trucks = $3::jsonb, saved_at = now()
      WHERE plan_id = $1`,
    [seeded.id, JSON.stringify([customOrder]), JSON.stringify(trucks)]
  );

  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}&date=${seeded.plan_date}`);
  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  const compact = bootstrap.payload.plan.assignedOrderSnapshots[0];
  assert.equal(compact.customOrderId, customOrderId, "stable Custom Order ID must survive compact startup");
  assert.equal(compact.customOrder, true);
  assert.equal(compact.destinationAddress, "88 Compact Test Road");
  assert.equal(compact.stopMinutes, 47);
  assert.equal(compact.instructions, "Compact identity evidence");
  assert.deepEqual(compact.salesQuantities, [{ unit: "LOAD", quantity: 1 }]);

  const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId: "dispatch-v2-co-identity" });
  const saved = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId: "dp17-compact-co-round-trip",
      baseRevision: bootstrap.payload.plan.revision,
      baseDigest: bootstrap.payload.plan.digest,
      sessionId: "dispatch-v2-co-identity",
      commandType: "replace_plan",
      payload: {
        planDate: seeded.plan_date,
        orders: bootstrap.payload.plan.assignedOrderSnapshots,
        trucks: bootstrap.payload.plan.trucks,
        summary: bootstrap.payload.plan.summary,
        actionName: "compact_co_round_trip",
        affectedOrderRefs: [customRef]
      }
    }
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
});

test("DP-18: CO detail persistence acknowledgement is bounded and skips global order hydration", { timeout: 30_000 }, async () => {
  const orderRef = "DP-CO-ACK-FAST";
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       fulfillment_status, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active
     ) VALUES (998060001, $1, '2038-11-16'::date, 'CO acknowledgement test', 'B',
       'Pending Fulfillment', 15, '12441', 'Delivery', 'open', 'open', 'Open',
       '1 Old Test Road', true)`,
    [orderRef]
  );
  const lease = await fixture.acquireLease({ planDate: "2038-11-16", sessionId: "dispatch-v2-co-ack" });
  const result = await fixture.request(`/api/dispatch/orders/${orderRef}/details?response=ack`, {
    method: "PUT",
    body: {
      planDate: "2038-11-16",
      sessionId: "dispatch-v2-co-ack",
      editLeaseToken: lease,
      type: "SO",
      sourceTable: "sales_orders",
      address: "2 New Test Road",
      pickupAddress: "3445",
      expectedDeliveryDate: "2038-11-16",
      windowStart: "0730",
      windowEnd: "0930",
      audit: { sessionId: "dispatch-v2-co-ack" }
    }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(Object.keys(result.payload).sort(), ["updated"]);
  assert.equal(result.payload.updated?.dispatch_address, "2 New Test Road");
  assert.ok(result.responseBytes < 25_000, `CO acknowledgement must stay below 25 KB, got ${result.responseBytes}`);
  assert.ok(result.durationMs < 500, `CO acknowledgement took ${result.durationMs.toFixed(1)}ms`);
  await recordDispatchPerformance([{
    name: "co_details_ack",
    durationMs: result.durationMs,
    responseBytes: result.responseBytes
  }]);
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
