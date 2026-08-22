// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { query, withTransaction } from "../../../src/db.js";

function randomPastPlanDate() {
  const dayOffset = crypto.randomBytes(4).readUInt32BE(0) % 25_000;
  return new Date(Date.UTC(1900, 0, 1 + dayOffset)).toISOString().slice(0, 10);
}

test("S18: assist ledger is immutable and canonical completion attributes the operator", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const planDate = randomPastPlanDate();
  const arrivedAt = `${planDate}T14:00:00.000Z`;
  const completedAt = `${planDate}T14:05:00.000Z`;
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, revision)
     VALUES ($1::date, 'confirmed', 7)
     RETURNING id`,
    [planDate]
  );
  const planId = plan.rows[0].id;
  const requestId = crypto.randomUUID();
  const assistEventId = crypto.randomUUID();
  const assistedJobId = `assist-drop-${suffix}`;
  const assistedOrder = `SO-ASSIST-${suffix}`;
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, load_id, stop_id, stop_type,
       order_refs, photo_data_urls, status, started_at, completed_at, job_details
     ) VALUES (
       $1, $2, $3::date, 'li', 'load-1', 'drop-1', 'dropoff',
       $4::jsonb, '[]'::jsonb, 'complete',
       $6::timestamptz, $7::timestamptz, $5::jsonb
     )`,
    [
      assistedJobId,
      planId,
      planDate,
      JSON.stringify([assistedOrder]),
      JSON.stringify({
        orders: [{ orderRef: assistedOrder, orderType: "SO" }],
        completionSource: "dispatch_historical_assist",
        completionActorType: "operator",
        completionActorId: "42",
        completionActorName: "Dispatcher One",
        completionReason: "Driver phone failed after delivery.",
        completionRequestId: requestId,
        completionAssistEventId: assistEventId
      }),
      arrivedAt,
      completedAt
    ]
  );
  const canonical = await query(
    `SELECT actor_type, actor_id, reason, metadata
       FROM dispatch_order_completion_events
      WHERE completion_evidence_type = 'driver_job'
        AND completion_evidence_id = $1`,
    [assistedJobId]
  );
  assert.equal(canonical.rowCount, 1);
  assert.equal(canonical.rows[0].actor_type, "operator");
  assert.equal(canonical.rows[0].actor_id, "42");
  assert.equal(canonical.rows[0].reason, "Driver phone failed after delivery.");
  assert.equal(canonical.rows[0].metadata.assisted, true);
  assert.equal(canonical.rows[0].metadata.completionRequestId, requestId);

  await query(
    `INSERT INTO driver_job_assist_events (
       assist_event_id, request_id, actor_operator_id, actor_name,
       driver_login, plan_id, plan_date, plan_revision,
       primary_job_id, physical_visit_job_ids, stop_type,
       arrived_at, completed_at, photo_references, reason, outcome, result
     ) VALUES (
       $1::uuid, $2::uuid, '42', 'Dispatcher One',
       'li', $3, $4::date, 7,
       $5, $6::jsonb, 'dropoff',
       $7::timestamptz, $8::timestamptz, '[]'::jsonb,
       'Driver phone failed after delivery.', 'completed', $9::jsonb
     )`,
    [
      assistEventId,
      requestId,
      planId,
      planDate,
      assistedJobId,
      JSON.stringify([assistedJobId]),
      arrivedAt,
      completedAt,
      JSON.stringify({ completed: true })
    ]
  );
  await assert.rejects(
    query(`UPDATE driver_job_assist_events SET actor_name = 'Changed' WHERE request_id = $1::uuid`, [requestId]),
    /immutable|append-only|cannot be modified|mutation/iu
  );
  await assert.rejects(
    query(`DELETE FROM driver_job_assist_events WHERE request_id = $1::uuid`, [requestId]),
    /immutable|append-only|cannot be modified|mutation/iu
  );
});

test("S19: ordinary Driver attribution stays unchanged and trigger writes roll back atomically", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ordinaryJobId = `ordinary-drop-${suffix}`;
  const ordinaryOrder = `SO-DRIVER-${suffix}`;
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_date, driver_login, stop_id, stop_type,
       order_refs, photo_data_urls, status, started_at, completed_at, job_details
     ) VALUES (
       $1, '2026-08-19', 'cheng', 'drop-driver', 'dropoff',
       $2::jsonb, '[]'::jsonb, 'complete',
       '2026-08-19T15:00:00Z', '2026-08-19T15:05:00Z', $3::jsonb
     )`,
    [ordinaryJobId, JSON.stringify([ordinaryOrder]), JSON.stringify({ orders: [{ orderRef: ordinaryOrder, orderType: "SO" }] })]
  );
  const ordinary = await query(
    `SELECT actor_type, actor_id, reason
       FROM dispatch_order_completion_events
      WHERE completion_evidence_id = $1`,
    [ordinaryJobId]
  );
  assert.deepEqual(ordinary.rows[0], { actor_type: "driver", actor_id: "cheng", reason: "" });

  const rollbackJobId = `rollback-drop-${suffix}`;
  await assert.rejects(
    withTransaction(async () => {
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, stop_id, stop_type,
           order_refs, photo_data_urls, status, started_at, completed_at, job_details
         ) VALUES (
           $1, '2026-08-19', 'cheng', 'drop-rollback', 'dropoff',
           $2::jsonb, '[]'::jsonb, 'complete',
           '2026-08-19T16:00:00Z', '2026-08-19T16:05:00Z', $3::jsonb
         )`,
        [rollbackJobId, JSON.stringify([`SO-ROLLBACK-${suffix}`]), JSON.stringify({ orderTypes: ["SO"] })]
      );
      throw new Error("forced downstream failure");
    }),
    /forced downstream failure/u
  );
  assert.equal((await query(`SELECT 1 FROM driver_job_records WHERE job_id = $1`, [rollbackJobId])).rowCount, 0);
  assert.equal((await query(`SELECT 1 FROM dispatch_order_completion_events WHERE completion_evidence_id = $1`, [rollbackJobId])).rowCount, 0);
});
