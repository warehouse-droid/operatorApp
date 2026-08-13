// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { digestDispatchPlan } from "../../../src/dispatch-planner-performance.js";
import { repairDispatchV2SummaryMarkers } from "../../../src/dispatch-planner-v2-repository.js";
import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;
const testDateOffset = crypto.randomInt(0, 100_000);
const testDates = Object.freeze([0, 1, 2, 3].map((offset) => new Date(
  Date.UTC(2200, 0, 1) + ((testDateOffset + offset) * 24 * 60 * 60 * 1000)
).toISOString().slice(0, 10)));
const companyDateParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).formatToParts(new Date()).map((part) => [part.type, part.value]));
const companyDate = `${companyDateParts.year}-${companyDateParts.month}-${companyDateParts.day}`;

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

test("new schema-v2 snapshots persist the summary format marker and matching digest", async () => {
  const created = await createDispatchPlan({
    planDate: testDates[0],
    note: "v2 summary marker creation regression"
  });
  const persisted = await query(
    `SELECT schema_version, plan_digest, summary
       FROM dispatch_plan_snapshots
      WHERE plan_id = $1`,
    [created.id]
  );
  const snapshot = persisted.rows[0];

  assert.equal(Number(snapshot?.schema_version), 2);
  assert.equal(snapshot?.summary?.dispatchPlanFormat?.version, 2);
  assert.equal(snapshot?.plan_digest, digestDispatchPlan(created));
});

test("v2 bootstrap and replace command restore a missing persisted summary marker", async () => {
  const seeded = await fixture.seedPlan({ date: testDates[1], refs: ["DP-V2-MARKER-1"] });
  const missing = await query(
    `SELECT schema_version, summary
       FROM dispatch_plan_snapshots
      WHERE plan_id = $1`,
    [seeded.id]
  );
  assert.equal(Number(missing.rows[0]?.schema_version), 2);
  assert.equal(missing.rows[0]?.summary?.dispatchPlanFormat, undefined);

  const bootstrapResult = await fixture.request(
    `/api/dispatch/v2/bootstrap?planId=${encodeURIComponent(seeded.id)}&date=${encodeURIComponent(seeded.plan_date)}`
  );
  assert.equal(bootstrapResult.response.status, 200, JSON.stringify(bootstrapResult.payload));
  assert.equal(bootstrapResult.payload.plan?.summary?.dispatchPlanFormat?.version, 2);

  const lease = await fixture.acquireLease({
    planDate: seeded.plan_date,
    sessionId: "dispatch-v2-summary-marker"
  });
  const commandResult = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId: crypto.randomUUID(),
      baseRevision: bootstrapResult.payload.plan.revision,
      baseDigest: bootstrapResult.payload.plan.digest,
      sessionId: "dispatch-v2-summary-marker",
      commandType: "replace_plan",
      payload: {
        planDate: seeded.plan_date,
        orders: bootstrapResult.payload.plan.assignedOrderSnapshots,
        trucks: bootstrapResult.payload.plan.trucks,
        summary: { testOnly: true, markerRegression: true }
      }
    }
  });
  assert.equal(commandResult.response.status, 200, JSON.stringify(commandResult.payload));
  assert.equal(commandResult.payload.plan?.summary?.dispatchPlanFormat?.version, 2);

  const persisted = await query(
    `SELECT p.id::text, p.plan_date::text AS plan_date, p.status, p.note,
            s.orders, s.trucks, s.summary, s.schema_version, s.plan_digest
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [seeded.id]
  );
  const snapshot = persisted.rows[0];
  assert.equal(Number(snapshot?.schema_version), 2);
  assert.equal(snapshot?.summary?.dispatchPlanFormat?.version, 2);
  assert.equal(snapshot?.plan_digest, digestDispatchPlan({
    id: snapshot.id,
    planDate: snapshot.plan_date,
    status: snapshot.status,
    note: snapshot.note,
    orders: snapshot.orders,
    trucks: snapshot.trucks,
    summary: snapshot.summary
  }));
});

test("startup repair adds the marker and recalculates metadata for an affected v2 snapshot", async () => {
  const historical = await fixture.seedPlan({ date: testDates[2], refs: ["DP-V2-MARKER-HISTORY"] });
  const seeded = await fixture.seedPlan({ date: companyDate, refs: ["DP-V2-MARKER-REPAIR"] });
  const beforeRepair = await query(
    `SELECT p.revision, s.orders, s.trucks, s.summary, s.saved_at
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [seeded.id]
  );
  const beforeSnapshot = beforeRepair.rows[0];
  assert.equal(beforeSnapshot?.summary?.dispatchPlanFormat, undefined);

  const repaired = await repairDispatchV2SummaryMarkers();
  assert.equal(repaired.date, companyDate);
  assert.equal(repaired.scanned, 1);
  assert.equal(repaired.repaired, 1);
  assert.deepEqual(repaired.planIds, [String(seeded.id)]);

  const persisted = await query(
    `SELECT p.id::text, p.plan_date::text AS plan_date, p.status, p.note, p.revision,
            s.orders, s.trucks, s.summary, s.saved_at, s.schema_version, s.plan_digest,
            s.order_count, s.truck_count, s.load_count, s.stop_count
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [seeded.id]
  );
  const snapshot = persisted.rows[0];
  assert.equal(snapshot?.summary?.dispatchPlanFormat?.version, 2);
  assert.equal(snapshot?.summary?.dispatchPlanFormat?.source, "dispatchV2-schema-repair");
  assert.equal(snapshot?.summary?.testOnly, true);
  assert.equal(Number(snapshot?.revision), Number(beforeSnapshot?.revision));
  assert.deepEqual(snapshot?.orders, beforeSnapshot?.orders);
  assert.deepEqual(snapshot?.trucks, beforeSnapshot?.trucks);
  assert.equal(new Date(snapshot?.saved_at).toISOString(), new Date(beforeSnapshot?.saved_at).toISOString());
  assert.equal(snapshot?.plan_digest, digestDispatchPlan({
    id: snapshot.id,
    planDate: snapshot.plan_date,
    status: snapshot.status,
    note: snapshot.note,
    orders: snapshot.orders,
    trucks: snapshot.trucks,
    summary: snapshot.summary
  }));
  assert.equal(Number(snapshot?.order_count), 1);
  assert.equal(Number(snapshot?.truck_count), 1);
  assert.equal(Number(snapshot?.load_count), 1);
  assert.equal(Number(snapshot?.stop_count), 1);

  const historicalAfter = await query(
    `SELECT summary
       FROM dispatch_plan_snapshots
      WHERE plan_id = $1`,
    [historical.id]
  );
  assert.equal(historicalAfter.rows[0]?.summary?.dispatchPlanFormat, undefined);

  const repeated = await repairDispatchV2SummaryMarkers();
  assert.equal(repeated.scanned, 0);
  assert.equal(repeated.repaired, 0);
});

test("concurrent marker repairs serialize to one durable update", async () => {
  const seeded = await fixture.seedPlan({ date: testDates[3], refs: ["DP-V2-MARKER-RACE"] });
  const results = await Promise.all([
    repairDispatchV2SummaryMarkers({ date: seeded.plan_date }),
    repairDispatchV2SummaryMarkers({ date: seeded.plan_date })
  ]);
  assert.equal(results.reduce((total, result) => total + result.scanned, 0), 1);
  assert.equal(results.reduce((total, result) => total + result.repaired, 0), 1);

  const persisted = await query(
    `SELECT summary
       FROM dispatch_plan_snapshots
      WHERE plan_id = $1`,
    [seeded.id]
  );
  assert.equal(persisted.rows[0]?.summary?.dispatchPlanFormat?.version, 2);
});
