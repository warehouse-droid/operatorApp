// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { config } from "../../../src/config.js";
import { query } from "../../../src/db.js";
import {
  getDispatchPlan,
  restoreDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";
import {
  applyDispatchV2Command,
  createDueDispatchV2Checkpoints,
  syncDispatchPlanOrderAssignments
} from "../../../src/dispatch-planner-v2-repository.js";
import {
  createDispatchV2Fixture,
  dispatchOrder
} from "../support/dispatch-v2-fixture.js";

let fixture;
let originalCommandMode;
const runDateBase = Date.UTC(
  2300 + crypto.randomInt(0, 300),
  crypto.randomInt(0, 12),
  1
);

function runDate(offset) {
  return new Date(runDateBase + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

before(async () => {
  originalCommandMode = config.dispatch.plannerCommandMode;
  config.dispatch.plannerCommandMode = "on";
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  config.dispatch.plannerCommandMode = originalCommandMode;
  await fixture?.close();
});

async function bootstrap(planId, date) {
  const result = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${planId}&date=${date}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.plan;
}

async function compactCommand({ plan, lease, commandId, commandType = "update_load", planDelta }) {
  return fixture.request(`/api/dispatch/v2/plans/${plan.id}/commands`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: {
      commandId,
      baseRevision: plan.revision,
      baseDigest: plan.digest,
      sessionId: "dispatch-planner-compact-test",
      commandType,
      payload: { planDelta, actionName: "dispatch_plan_compact_test" }
    }
  });
}

test("DPO-08 compact commands persist acknowledgements, checkpoint by cadence, and replay idempotently", async () => {
  const seeded = await fixture.seedPlan({ date: runDate(0), refs: ["DPO-COMPACT-A"] });
  const lease = await fixture.acquireLease({
    planDate: seeded.plan_date,
    sessionId: "dispatch-planner-compact-test"
  });
  const plan = await bootstrap(seeded.id, seeded.plan_date);
  const commandId = `dpo-compact-${crypto.randomUUID()}`;
  const request = {
    plan,
    lease,
    commandId,
    planDelta: { s: { ...(plan.summary || {}), compactCommandTest: true } }
  };

  const first = await compactCommand(request);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.plan.revision, plan.revision + 1);
  assert.equal(first.payload.plan.summary.compactCommandTest, true);
  assert.equal(first.payload.acknowledgement.revision, plan.revision + 1);

  const stored = await query(
    `SELECT command_type, result
       FROM dispatch_plan_commands
      WHERE command_id = $1`,
    [commandId]
  );
  assert.equal(stored.rows[0].command_type, "update_load");
  assert.equal(stored.rows[0].result.receipt.compact, true);
  assert.equal(Object.hasOwn(stored.rows[0].result, "plan"), false);
  assert.ok(stored.rows[0].result.acknowledgement.digest);
  assert.equal(
    (await query(
      `SELECT count(*)::int AS count
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1 AND archive_reason = 'before_incremental_command'`,
      [plan.id]
    )).rows[0].count,
    0,
    "A compact command must not clone the full plan into history for every click."
  );
  assert.deepEqual(
    (await query(
      `SELECT commands_since_checkpoint::int, checkpoint_due
         FROM dispatch_plan_checkpoint_state
        WHERE plan_id = $1`,
      [plan.id]
    )).rows[0],
    { commands_since_checkpoint: 1, checkpoint_due: false }
  );

  const replay = await compactCommand(request);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("x-dispatch-idempotent-replay"), "true");
  assert.equal(replay.payload.plan.revision, first.payload.plan.revision);
  assert.equal(
    (await query("SELECT count(*)::int AS count FROM dispatch_plan_commands WHERE command_id = $1", [commandId])).rows[0].count,
    1
  );

  await query(
    `UPDATE dispatch_plan_checkpoint_state
        SET last_checkpoint_at = now() - interval '6 minutes'
      WHERE plan_id = $1`,
    [plan.id]
  );
  const periodic = await createDueDispatchV2Checkpoints({ limit: 25 });
  const periodicCheckpoint = periodic.checkpoints.find((entry) => entry.planId === String(plan.id));
  assert.ok(periodicCheckpoint, "The five-minute cadence must produce a durable full checkpoint.");
  assert.equal(periodicCheckpoint.checkpointKind, "periodic");
  assert.ok(new Date(periodicCheckpoint.retentionUntil).getTime() > Date.now() + 6 * 24 * 60 * 60 * 1000);
  assert.ok(new Date(periodicCheckpoint.retentionUntil).getTime() < Date.now() + 8 * 24 * 60 * 60 * 1000);

  const current = first.payload.plan;
  const checkpointBody = {
    kind: "manual",
    reason: "save_now",
    sessionId: "dispatch-planner-compact-test",
    idempotencyKey: `manual:${plan.id}:${current.revision}`,
    expectedRevision: current.revision,
    expectedDigest: current.digest
  };
  const manual = await fixture.request(`/api/dispatch/v2/plans/${plan.id}/checkpoints`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: checkpointBody
  });
  assert.equal(manual.response.status, 200, JSON.stringify(manual.payload));
  assert.equal(manual.payload.checkpoint.checkpointKind, "manual");
  assert.ok(new Date(manual.payload.checkpoint.retentionUntil).getTime() > Date.now() + 89 * 24 * 60 * 60 * 1000);
  const manualReplay = await fixture.request(`/api/dispatch/v2/plans/${plan.id}/checkpoints`, {
    method: "POST",
    headers: { "x-dispatch-edit-lease": lease },
    body: checkpointBody
  });
  assert.equal(manualReplay.response.status, 200, JSON.stringify(manualReplay.payload));
  assert.equal(manualReplay.payload.checkpoint.id, manual.payload.checkpoint.id);
  assert.equal(manualReplay.payload.checkpoint.replay, true);
});

test("DPO-09 a rejected compact command retains the complete candidate without changing active or projected state", async () => {
  const seeded = await fixture.seedPlan({ date: runDate(1), refs: ["DPO-RECOVERY-A"] });
  const lease = await fixture.acquireLease({
    planDate: seeded.plan_date,
    sessionId: "dispatch-planner-recovery-test"
  });
  const plan = await bootstrap(seeded.id, seeded.plan_date);
  const activeBefore = (await query(
    `SELECT plan.revision::int, snapshot.orders, snapshot.trucks, snapshot.summary,
            snapshot.plan_digest
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
      WHERE plan.id = $1`,
    [plan.id]
  )).rows[0];
  const firstTruck = { ...structuredClone(plan.trucks[0]), driverLogin: "duplicate-driver" };
  const duplicateTruck = {
    id: "DPO-DUPLICATE-TRUCK",
    plate: "DPO-DUPLICATE-TRUCK",
    driverLogin: "duplicate-driver",
    loads: [{ id: "dpo-duplicate-load", name: "Load 2", stops: [] }]
  };
  const commandId = `dpo-recovery-${crypto.randomUUID()}`;
  const failed = await compactCommand({
    plan,
    lease,
    commandId,
    commandType: "update_load",
    planDelta: { t: [firstTruck, duplicateTruck], to: [firstTruck.id, duplicateTruck.id] }
  });
  assert.equal(failed.response.status, 202, JSON.stringify(failed.payload));
  assert.equal(failed.payload.code, "DISPATCH_PLAN_RECOVERY_SAVED");
  assert.equal(failed.payload.applied, false);
  assert.ok(failed.payload.validationIssues.some((issue) => issue.code === "DISPATCH_DRIVER_DUPLICATE"));

  const activeAfter = (await query(
    `SELECT plan.revision::int, snapshot.orders, snapshot.trucks, snapshot.summary,
            snapshot.plan_digest
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
      WHERE plan.id = $1`,
    [plan.id]
  )).rows[0];
  assert.deepEqual(activeAfter, activeBefore);
  assert.equal(
    (await query("SELECT count(*)::int AS count FROM dispatch_plan_commands WHERE command_id = $1", [commandId])).rows[0].count,
    0
  );
  assert.equal(
    (await query("SELECT count(*)::int AS count FROM dispatch_plan_order_assignments WHERE plan_id = $1", [plan.id])).rows[0].count,
    0
  );

  const recovery = (await query(
    `SELECT orders, trucks, summary, archive_reason, checkpoint_kind,
            retention_until, resolved_at
       FROM dispatch_plan_snapshot_history
      WHERE id = $1`,
    [failed.payload.recoveryDraft.id]
  )).rows[0];
  assert.equal(recovery.archive_reason, "save_recovery");
  assert.equal(recovery.checkpoint_kind, "recovery");
  assert.equal(recovery.retention_until, null);
  assert.equal(recovery.resolved_at, null);
  assert.equal(recovery.trucks.length, 2);
  assert.equal(recovery.trucks[1].id, duplicateTruck.id);
  assert.deepEqual(
    recovery.orders.map((order) => order.id),
    plan.assignedOrderSnapshots.map((order) => order.id)
  );
  assert.equal(recovery.summary.saveRecovery.applied, false);
});

test("DPO-08 compact commands recheck cross-date ownership inside the apply transaction", async () => {
  const source = await fixture.seedPlan({ date: runDate(2), refs: ["DPO-RACE-SOURCE"] });
  const owner = await fixture.seedPlan({ date: runDate(3), refs: ["DPO-RACE-ORDER"] });
  const ownerPlan = await getDispatchPlan(owner.id);
  await syncDispatchPlanOrderAssignments(ownerPlan);

  const plan = await bootstrap(source.id, source.plan_date);
  const truck = structuredClone(plan.trucks[0]);
  truck.loads[0].stops.push({
    id: "dpo-race-stop",
    type: "delivery",
    orderRefs: ["DPO-RACE-ORDER"],
    location: "Cross-date isolated test road"
  });
  await assert.rejects(
    applyDispatchV2Command({
      planId: plan.id,
      command: {
        commandId: `dpo-race-${crypto.randomUUID()}`,
        baseRevision: plan.revision,
        baseDigest: plan.digest,
        sessionId: "dispatch-planner-race-test",
        commandType: "update_load",
        compactReceipt: true,
        payload: {
          planDelta: {
            o: [dispatchOrder("DPO-RACE-ORDER", 2)],
            t: [truck]
          },
          actionName: "dispatch_plan_race_test"
        }
      },
      actorId: fixture.operator.id
    }),
    (error) => error?.code === "DISPATCH_ORDER_ALREADY_PLANNED"
  );
  assert.equal((await getDispatchPlan(source.id)).revision, plan.revision);
});

test("DPO-11 restore rechecks the executed Driver prefix inside its transaction", async () => {
  const seeded = await fixture.seedPlan({ date: runDate(4), refs: ["DPO-RESTORE-EXECUTED"] });
  const current = await getDispatchPlan(seeded.id);
  const archive = await query(
    `INSERT INTO dispatch_plan_snapshot_history (
       plan_id, plan_date, revision, orders, trucks, summary,
       original_saved_at, archive_reason, session_id
     ) VALUES (
       $1, $2::date, $3, $4::jsonb, '[]'::jsonb, $5::jsonb,
       now(), 'dpo_restore_executed_test', 'dispatch-planner-restore-test'
     )
     RETURNING id::text`,
    [current.id, current.planDate, current.revision, JSON.stringify(current.orders), JSON.stringify(current.summary || {})]
  );
  const load = current.trucks[0].loads[0];
  const stop = load.stops[0];
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
       load_id, load_name, stop_id, stop_type, order_refs,
       status, started_at, completed_at
     ) VALUES (
       $1, $2, $3::date, 'dpo-restore-driver', $4, $5,
       $6, $7, $8, $9, $10::jsonb,
       'complete', now(), now()
     )`,
    [
      `dpo-restore-job-${crypto.randomUUID()}`,
      current.id,
      current.planDate,
      current.trucks[0].id,
      current.trucks[0].plate,
      load.id,
      load.name,
      stop.id,
      stop.type,
      JSON.stringify(stop.orderRefs || [])
    ]
  );
  await assert.rejects(
    restoreDispatchPlanSnapshot(archive.rows[0].id, { sessionId: "dispatch-planner-restore-test" }),
    (error) => error?.code === "DISPATCH_ACTIVE_LOAD_LOCKED"
  );
  const afterRestoreAttempt = await getDispatchPlan(current.id);
  assert.equal(afterRestoreAttempt.revision, current.revision);
  assert.deepEqual(afterRestoreAttempt.trucks, current.trucks);
});
