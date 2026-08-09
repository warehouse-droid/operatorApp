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

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function confirmedActiveState(planId) {
  const result = await query(
    `SELECT p.status, p.revision::int AS revision, p.confirmed_at,
            s.orders, s.trucks, s.summary, s.saved_at, s.plan_digest,
            s.order_count, s.truck_count, s.load_count, s.stop_count
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [planId]
  );
  assert.ok(result.rows[0], "The confirmed-plan recovery fixture must have an active snapshot.");
  return jsonClone(result.rows[0]);
}

async function markConfirmed(planId) {
  await query(
    `UPDATE dispatch_plans
        SET status = 'confirmed', confirmed_at = now(), revision = revision + 1
      WHERE id = $1`,
    [planId]
  );
}

async function activeDerivedState(planId) {
  const [loads, orders, groups] = await Promise.all([
    query("SELECT count(*)::int AS count FROM dispatch_plan_load_assignments WHERE plan_id = $1", [planId]),
    query("SELECT count(*)::int AS count FROM dispatch_plan_order_assignments WHERE plan_id = $1", [planId]),
    query("SELECT count(*)::int AS count FROM dispatch_delivery_groups WHERE plan_id = $1", [planId])
  ]);
  return {
    loadAssignments: loads.rows[0].count,
    orderAssignments: orders.rows[0].count,
    deliveryGroups: groups.rows[0].count
  };
}

test("failed Save Now retains a separate recovery draft and leaves the confirmed plan byte-for-byte unchanged", async () => {
  const seeded = await fixture.seedPlan({
    date: "2025-03-01",
    refs: ["RECOVERY-SO-A", "RECOVERY-SO-B"]
  });
  await query(
    `INSERT INTO dispatch_drivers (name, login, active)
     VALUES ('Recovery Driver 1', 'recovery-driver', true),
            ('Recovery Driver 2', 'recovery-driver-2', true)`
  );
  await query(
    `INSERT INTO dispatch_trucks (plate, active)
     VALUES ('DP-V2-TEST', true),
            ('RECOVERY-TRUCK-2', true)`
  );
  await markConfirmed(seeded.id);
  const activeBefore = await confirmedActiveState(seeded.id);
  const derivedBefore = await activeDerivedState(seeded.id);
  const lease = await fixture.acquireLease({
    planDate: seeded.plan_date,
    sessionId: "dispatch-save-recovery"
  });
  const active = await fixture.request(`/api/dispatch/plans/${seeded.id}`);
  assert.equal(active.response.status, 200, JSON.stringify(active.payload));

  const firstTruck = structuredClone(active.payload.trucks[0]);
  firstTruck.driverLogin = "recovery-driver";
  firstTruck.loads = (firstTruck.loads || []).map((load) => ({
    ...load,
    driverLogin: "recovery-driver"
  }));
  const failedDraftTrucks = [
    firstTruck,
    {
      id: "RECOVERY-TRUCK-2",
      plate: "RECOVERY-TRUCK-2",
      driverLogin: "recovery-driver",
      loads: [{
        id: "recovery-load-2",
        name: "Recovery Load 2",
        driverLogin: "recovery-driver",
        stops: []
      }]
    }
  ];
  const requestBody = {
    planDate: seeded.plan_date,
    baseRevision: activeBefore.revision,
    forceSave: true,
    editLeaseToken: lease,
    orders: active.payload.orders,
    trucks: failedDraftTrucks,
    summary: { ...active.payload.summary, recoveryTest: true },
    audit: { sessionId: "dispatch-save-recovery", action: "dispatch_plan_force_saved" }
  };

  const first = await fixture.request(`/api/dispatch/plans/${seeded.id}`, {
    method: "PUT",
    body: requestBody
  });
  assert.equal(first.response.status, 202, JSON.stringify(first.payload));
  assert.equal(first.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
  assert.equal(first.payload.saved, true);
  assert.equal(first.payload.applied, false);
  assert.equal(first.payload.recoveryDraft?.activeStatus, "confirmed");
  assert.equal(Number(first.payload.recoveryDraft?.activeRevision), activeBefore.revision);
  assert.ok(first.payload.recoveryDraft?.id, "The rejected edit must return its durable recovery snapshot ID.");
  assert.ok(
    (first.payload.validationIssues || []).some((issue) => issue.code === "DISPATCH_DRIVER_DUPLICATE"),
    "The recovery response must explain why the candidate was not applied."
  );

  assert.deepEqual(
    await confirmedActiveState(seeded.id),
    activeBefore,
    "Saving a failed post-confirm edit must not alter any active confirmed-plan field."
  );
  assert.deepEqual(
    await activeDerivedState(seeded.id),
    derivedBefore,
    "A recovery write must not materialize assignment indexes or delivery groups."
  );

  const recovery = await query(
    `SELECT id::text, revision::int AS revision, orders, trucks, summary,
            archive_reason, session_id, plan_digest
       FROM dispatch_plan_snapshot_history
      WHERE id = $1`,
    [first.payload.recoveryDraft.id]
  );
  assert.equal(recovery.rows[0]?.archive_reason, "save_recovery");
  assert.equal(recovery.rows[0]?.session_id, "dispatch-save-recovery");
  assert.equal(Number(recovery.rows[0]?.revision), activeBefore.revision);
  assert.equal(recovery.rows[0]?.summary?.saveRecovery?.activeStatus, "confirmed");
  assert.equal(recovery.rows[0]?.summary?.saveRecovery?.applied, false);
  assert.ok(
    (recovery.rows[0]?.summary?.saveRecovery?.validationIssues || [])
      .some((issue) => issue.code === "DISPATCH_DRIVER_DUPLICATE")
  );
  assert.equal(recovery.rows[0]?.trucks?.length, 2);
  assert.equal(recovery.rows[0]?.trucks?.[1]?.driverLogin, "recovery-driver");
  const recoveryList = await fixture.request(
    `/api/dispatch/plan-snapshots?date=${encodeURIComponent(seeded.plan_date)}`
  );
  assert.equal(recoveryList.response.status, 200, JSON.stringify(recoveryList.payload));
  assert.ok(
    (recoveryList.payload.snapshots || []).some((snapshot) =>
      snapshot.id === first.payload.recoveryDraft.id
      && snapshot.archiveReason === "save_recovery"
    ),
    "The separately retained draft must be discoverable from Snapshot Recovery."
  );

  const replay = await fixture.request(`/api/dispatch/plans/${seeded.id}`, {
    method: "PUT",
    body: requestBody
  });
  assert.equal(replay.response.status, 202, JSON.stringify(replay.payload));
  assert.equal(replay.payload.recoveryDraft?.id, first.payload.recoveryDraft.id);
  assert.equal(replay.payload.recoveryDraft?.deduplicated, true);
  assert.equal(
    (await query(
      `SELECT count(*)::int AS count
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
          AND archive_reason = 'save_recovery'
          AND session_id = 'dispatch-save-recovery'`,
      [seeded.id]
    )).rows[0].count,
    1,
    "An exact autosave retry must reuse the same recovery draft instead of growing history without bound."
  );
  assert.deepEqual(await confirmedActiveState(seeded.id), activeBefore);
  assert.deepEqual(await activeDerivedState(seeded.id), derivedBefore);

  const correctedTrucks = structuredClone(failedDraftTrucks);
  correctedTrucks[1].driverLogin = "recovery-driver-2";
  correctedTrucks[1].loads = correctedTrucks[1].loads.map((load) => ({
    ...load,
    driverLogin: "recovery-driver-2"
  }));
  const corrected = await fixture.request(`/api/dispatch/plans/${seeded.id}`, {
    method: "PUT",
    body: {
      ...requestBody,
      trucks: correctedTrucks,
      summary: { ...requestBody.summary, recoveryTestCorrected: true }
    }
  });
  assert.equal(corrected.response.status, 200, JSON.stringify(corrected.payload));
  assert.equal(corrected.payload.status, "confirmed");
  assert.equal(Number(corrected.payload.revision), activeBefore.revision + 1);
  assert.equal(corrected.payload.trucks.length, 2);
  assert.equal(corrected.payload.trucks[1].driverLogin, "recovery-driver-2");
  assert.equal(
    (await query(
      `SELECT count(*)::int AS count
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
          AND archive_reason = 'save_recovery'`,
      [seeded.id]
    )).rows[0].count,
    1,
    "A corrected retry must apply normally without deleting its recovery evidence."
  );
});
