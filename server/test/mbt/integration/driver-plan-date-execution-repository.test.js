// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { startDriverJob } from "../../../src/driver-repository.js";

const RUN_ID = crypto.randomUUID();
const JOB_IDS = ["future", "invalid", "today", "past"].map((suffix) => `plan-date-${RUN_ID}-${suffix}`);

function job(jobId, planDate) {
  return {
    jobId,
    planId: null,
    planDate,
    driverLogin: `plan-date-driver-${RUN_ID}`,
    truckId: "PLAN-DATE-TRUCK",
    truckPlate: "PLAN-DATE",
    loadId: `plan-date-load-${RUN_ID}`,
    loadName: "Plan date load",
    stopId: `plan-date-stop-${RUN_ID}`,
    stopType: "pickup",
    orderRefs: [],
    orders: []
  };
}

function planDateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
}

async function torontoDates() {
  const result = await query(
    `SELECT (now() AT TIME ZONE 'America/Toronto')::date::text AS today,
            ((now() AT TIME ZONE 'America/Toronto')::date + 1)::text AS tomorrow,
            ((now() AT TIME ZONE 'America/Toronto')::date - 1)::text AS yesterday`
  );
  return result.rows[0];
}

after(async () => {
  await query("DELETE FROM driver_job_records WHERE job_id = ANY($1::text[])", [JOB_IDS]).catch(() => null);
  await closeDb();
});

test("S12: persistence rejects tomorrow and malformed dates without creating progress", async () => {
  const dates = await torontoDates();
  await assert.rejects(
    startDriverJob(`plan-date-driver-${RUN_ID}`, JOB_IDS[0], {
      job: job(JOB_IDS[0], dates.tomorrow)
    }),
    (error) => error?.status === 409 && error?.code === "DRIVER_PLAN_NOT_STARTED"
  );
  await assert.rejects(
    startDriverJob(`plan-date-driver-${RUN_ID}`, JOB_IDS[1], {
      job: job(JOB_IDS[1], "2026-02-30")
    }),
    (error) => error?.status === 409 && error?.code === "DRIVER_PLAN_DATE_INVALID"
  );
  const result = await query(
    "SELECT count(*)::int AS count FROM driver_job_records WHERE job_id = ANY($1::text[])",
    [[JOB_IDS[0], JOB_IDS[1]]]
  );
  assert.equal(result.rows[0].count, 0);
});

test("S13: current work and delayed past-date replay still persist", async () => {
  const dates = await torontoDates();
  const current = await startDriverJob(`plan-date-driver-${RUN_ID}`, JOB_IDS[2], {
    job: job(JOB_IDS[2], dates.today)
  });
  const replay = await startDriverJob(`plan-date-driver-${RUN_ID}`, JOB_IDS[3], {
    job: job(JOB_IDS[3], dates.yesterday),
    occurredAt: `${dates.yesterday}T18:00:00.000Z`
  });
  assert.equal(current.status, "in_progress");
  assert.equal(replay.status, "in_progress");
  assert.equal(planDateValue(current.plan_date), dates.today);
  assert.equal(planDateValue(replay.plan_date), dates.yesterday);
});
