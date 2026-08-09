// @ts-check

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

async function activeState(planId) {
  const result = await query(
    `SELECT p.status, p.revision::int AS revision, p.confirmed_at,
            s.orders, s.trucks, s.summary, s.saved_at, s.plan_digest
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [planId]
  );
  return JSON.parse(JSON.stringify(result.rows[0]));
}

test("simultaneous failed saves deduplicate one recovery draft without touching the confirmed plan", async () => {
  const seeded = await fixture.seedPlan({ date: "2025-03-02", refs: ["RECOVERY-RACE-SO"] });
  await query(
    `UPDATE dispatch_plans
        SET status = 'confirmed', confirmed_at = now(), revision = revision + 1
      WHERE id = $1`,
    [seeded.id]
  );
  const beforeState = await activeState(seeded.id);
  const lease = await fixture.acquireLease({
    planDate: seeded.plan_date,
    sessionId: "dispatch-save-recovery-race"
  });
  const active = await fixture.request(`/api/dispatch/plans/${seeded.id}`);
  assert.equal(active.response.status, 200, JSON.stringify(active.payload));
  const firstTruck = structuredClone(active.payload.trucks[0]);
  firstTruck.driverLogin = "recovery-race-driver";
  const body = {
    planDate: seeded.plan_date,
    forceSave: true,
    editLeaseToken: lease,
    orders: active.payload.orders,
    trucks: [
      firstTruck,
      {
        id: "RECOVERY-RACE-TRUCK-2",
        plate: "RECOVERY-RACE-TRUCK-2",
        driverLogin: "recovery-race-driver",
        loads: []
      }
    ],
    summary: { ...active.payload.summary, recoveryRaceTest: true },
    audit: { sessionId: "dispatch-save-recovery-race" }
  };

  const responses = await Promise.all([
    fixture.request(`/api/dispatch/plans/${seeded.id}`, { method: "PUT", body }),
    fixture.request(`/api/dispatch/plans/${seeded.id}`, { method: "PUT", body })
  ]);
  responses.forEach((result) => {
    assert.equal(result.response.status, 202, JSON.stringify(result.payload));
    assert.equal(result.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
    assert.equal(result.payload.applied, false);
  });
  assert.equal(responses[0].payload.recoveryDraft.id, responses[1].payload.recoveryDraft.id);
  assert.deepEqual(
    responses.map((result) => result.payload.recoveryDraft.deduplicated).sort(),
    [false, true]
  );
  assert.equal(
    (await query(
      `SELECT count(*)::int AS count
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
          AND archive_reason = 'save_recovery'
          AND session_id = 'dispatch-save-recovery-race'`,
      [seeded.id]
    )).rows[0].count,
    1
  );
  assert.deepEqual(await activeState(seeded.id), beforeState);
});
