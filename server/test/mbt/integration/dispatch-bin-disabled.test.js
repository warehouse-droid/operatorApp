import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, beforeEach } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  confirmDispatchPlan,
  restoreDispatchPlanSnapshot,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";

const PLAN_DATE = "2098-04-17";
const BIN_ORDER = Object.freeze({
  id: "00000000-0000-4000-8000-000000000201",
  type: "BIN",
  customer: "Phase 1 disabled dispatch fixture",
  mbt: {
    visitId: "00000000-0000-4000-8000-000000000202",
    reservation: {
      assetId: "00000000-0000-4000-8000-000000000203",
      reservationSlot: 1
    }
  }
});
const BIN_TRUCKS = Object.freeze([
  {
    id: "phase1-nested-bin-truck",
    loads: [
      {
        id: "phase1-nested-bin-load",
        stops: [
          {
            id: "phase1-nested-bin-stop",
            type: "drop",
            mbt: { visitId: "00000000-0000-4000-8000-000000000204" }
          }
        ]
      }
    ]
  }
]);

let planId;
let historyId;

async function resetFixture() {
  await query("DELETE FROM dispatch_plans WHERE plan_date = $1::date", [PLAN_DATE]);
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ($1::date, 'draft', 'MBT Phase 1 BIN guard', 7)
     RETURNING id`,
    [PLAN_DATE]
  );
  planId = String(plan.rows[0].id);
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [planId]
  );
  const history = await query(
    `INSERT INTO dispatch_plan_snapshot_history (
       plan_id, plan_date, revision, orders, trucks, summary, archive_reason, session_id
     )
     VALUES ($1, $2::date, 6, $3::jsonb, '[]'::jsonb, '{}'::jsonb, 'phase1_fixture', $4)
     RETURNING id`,
    [planId, PLAN_DATE, JSON.stringify([BIN_ORDER]), `mbt-${crypto.randomUUID()}`]
  );
  historyId = String(history.rows[0].id);
}

async function persistedState() {
  const result = await query(
    `SELECT p.status, p.revision, s.orders, s.trucks, s.summary,
            (SELECT count(*)::integer
               FROM dispatch_plan_snapshot_history h
              WHERE h.plan_id = p.id) AS history_count
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [planId]
  );
  return result.rows[0];
}

function isDisabledOperation(operation) {
  return (error) => error?.status === 409
    && error?.code === "MBT_CAPABILITY_DISABLED"
    && error?.message === "BIN dispatch is disabled."
    && error?.details?.capability === "bin_dispatch"
    && error?.details?.operation === operation;
}

beforeEach(resetFixture);

after(async () => {
  await query("DELETE FROM dispatch_plans WHERE plan_date = $1::date", [PLAN_DATE]).catch(() => null);
  await closeDb();
});

test("F14: a disabled BIN save is rejected before revision, snapshot, or history writes", async () => {
  const beforeState = await persistedState();

  await assert.rejects(
    () => saveDispatchPlanSnapshot(planId, {
      planDate: PLAN_DATE,
      baseRevision: beforeState.revision,
      orders: [structuredClone(BIN_ORDER)],
      trucks: [],
      summary: {}
    }),
    isDisabledOperation("save")
  );

  assert.deepEqual(await persistedState(), beforeState);
});

test("F14: restoring a BIN snapshot is rejected before archiving or replacing the current plan", async () => {
  const beforeState = await persistedState();

  await assert.rejects(
    () => restoreDispatchPlanSnapshot(historyId, { sessionId: "phase1-disabled-restore" }),
    isDisabledOperation("restore")
  );

  assert.deepEqual(await persistedState(), beforeState);
});

test("F14: confirming a persisted BIN snapshot is rejected without status or revision changes", async () => {
  await query(
    "UPDATE dispatch_plan_snapshots SET orders = $2::jsonb WHERE plan_id = $1",
    [planId, JSON.stringify([BIN_ORDER])]
  );
  const beforeState = await persistedState();

  await assert.rejects(
    () => confirmDispatchPlan(planId, { note: "must not be written" }),
    isDisabledOperation("confirm")
  );

  assert.deepEqual(await persistedState(), beforeState);
});

test("F14: a nested stop-level BIN identity is rejected at the save repository seam", async () => {
  const beforeState = await persistedState();

  await assert.rejects(
    () => saveDispatchPlanSnapshot(planId, {
      planDate: PLAN_DATE,
      baseRevision: beforeState.revision,
      orders: [],
      trucks: structuredClone(BIN_TRUCKS),
      summary: {}
    }),
    isDisabledOperation("save")
  );

  assert.deepEqual(await persistedState(), beforeState);
});

test("F14: a nested stop-level BIN identity is rejected at the restore repository seam", async () => {
  await query(
    "UPDATE dispatch_plan_snapshot_history SET orders = '[]'::jsonb, trucks = $2::jsonb WHERE id = $1",
    [historyId, JSON.stringify(BIN_TRUCKS)]
  );
  const beforeState = await persistedState();

  await assert.rejects(
    () => restoreDispatchPlanSnapshot(historyId, { sessionId: "phase1-disabled-nested-restore" }),
    isDisabledOperation("restore")
  );

  assert.deepEqual(await persistedState(), beforeState);
});

test("F14: an ordinary historical snapshot cannot restore over a current BIN assignment", async () => {
  await query(
    "UPDATE dispatch_plan_snapshot_history SET orders = '[]'::jsonb, trucks = '[]'::jsonb WHERE id = $1",
    [historyId]
  );
  await query(
    "UPDATE dispatch_plan_snapshots SET orders = $2::jsonb, trucks = '[]'::jsonb WHERE plan_id = $1",
    [planId, JSON.stringify([BIN_ORDER])]
  );
  const beforeState = await persistedState();

  await assert.rejects(
    () => restoreDispatchPlanSnapshot(historyId, { sessionId: "phase1-current-bin-restore" }),
    isDisabledOperation("restore")
  );

  assert.deepEqual(await persistedState(), beforeState);
});

test("F14: a nested stop-level BIN identity is rejected at the confirm repository seam", async () => {
  await query(
    "UPDATE dispatch_plan_snapshots SET orders = '[]'::jsonb, trucks = $2::jsonb WHERE plan_id = $1",
    [planId, JSON.stringify(BIN_TRUCKS)]
  );
  const beforeState = await persistedState();

  await assert.rejects(
    () => confirmDispatchPlan(planId, { note: "nested BIN must not be written" }),
    isDisabledOperation("confirm")
  );

  assert.deepEqual(await persistedState(), beforeState);
});
