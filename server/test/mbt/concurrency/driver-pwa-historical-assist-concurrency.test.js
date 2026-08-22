// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  applyHistoricalDriverAssist,
  listHistoricalDriverAssists
} from "../../../src/driver-historical-assist-repository.js";
import { torontoOffsetChoices } from "../../../src/driver-historical-assist-policy.js";
import { recordDriverJobPhotos } from "../../../src/driver-repository.js";

after(async () => {
  await closeDb();
});

function randomPastDate() {
  const bytes = crypto.randomBytes(3);
  const year = 1990 + (bytes[0] % 10);
  const month = 1 + (bytes[1] % 12);
  const day = 1 + (bytes[2] % 25);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function photoDescriptors(requestId, recordType = "driver-pickup-photo") {
  return [1, 2].map((ordinal) => {
    const photoId = crypto.randomUUID();
    return {
      photoId,
      ordinal,
      byteSize: 128 + ordinal,
      sha256: String(ordinal).repeat(64),
      mimeType: "image/jpeg",
      objectReference: `r2://dispatch-assist/${recordType}/2026/08/20/${requestId}-${photoId}/evidence-${ordinal}.jpg`
    };
  });
}

async function seedHistoricalVisit(label) {
  const planDate = randomPastDate();
  const driverLogin = `assist-race-${label}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
  const orderRef = `SO-ASSIST-RACE-${label}-${crypto.randomUUID().slice(0, 8)}`;
  const truckId = `truck-${crypto.randomUUID().slice(0, 8)}`;
  const loadId = `load-${crypto.randomUUID().slice(0, 8)}`;
  const pickupStopId = `pickup-${crypto.randomUUID().slice(0, 8)}`;
  const dropStopId = `drop-${crypto.randomUUID().slice(0, 8)}`;
  const planResult = await query(
    `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at, note)
     VALUES ($1::date, 'confirmed', 4, now(), $2)
     RETURNING id`,
    [planDate, `Historical assist concurrency ${label}`]
  );
  const planId = Number(planResult.rows[0].id);
  const orders = [{
    id: orderRef,
    type: "SO",
    customer: "Historical assist concurrency fixture",
    sourceYard: "2967",
    outboundLocation: "2967",
    pickupLocations: ["2967"],
    address: "12441 Highway 50, Bolton, ON"
  }];
  const trucks = [{
    id: truckId,
    plate: `RACE-${String(planId).slice(-6)}`,
    base: "2967",
    driver: `Historical Race ${label}`,
    driverLogin,
    loads: [{
      id: loadId,
      name: `Race load ${label}`,
      driverLogin,
      driverName: `Historical Race ${label}`,
      stops: [{
        id: pickupStopId,
        type: "pick",
        orderId: orderRef,
        location: "2967"
      }, {
        id: dropStopId,
        type: "drop",
        orderId: orderRef,
        location: "12441 Highway 50, Bolton, ON"
      }]
    }]
  }];
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
    [planId, JSON.stringify(orders), JSON.stringify(trucks)]
  );
  const listing = await listHistoricalDriverAssists({
    planDate,
    now: new Date("2026-08-20T16:00:00.000Z")
  });
  const visit = listing.routes[0]?.visits[0];
  assert.ok(visit?.actionable, JSON.stringify(listing));
  const offset = torontoOffsetChoices(planDate, "10:00:00")[0]?.offset;
  assert.ok(offset);
  return {
    planId,
    planDate,
    driverLogin,
    jobId: visit.jobId,
    stateHash: visit.stateHash,
    offset
  };
}

async function insertCompletedRecord({ driverLogin, job, completedAt, photoReferences, completionContext = null }) {
  return recordDriverJobPhotos(driverLogin, job.jobId, {
    job,
    photoDataUrls: photoReferences,
    occurredAt: completedAt,
    completionContext,
    driverRemark: completionContext ? undefined : "Completed by the assigned Driver during the race."
  });
}

function assistInput(fixture, overrides = {}) {
  const requestId = overrides.requestId || crypto.randomUUID();
  return {
    planDate: fixture.planDate,
    jobId: fixture.jobId,
    expectedStateHash: fixture.stateHash,
    requestId,
    assistEventId: crypto.randomUUID(),
    actorId: overrides.actorId || "dispatcher-race-1",
    actorName: overrides.actorName || "Dispatcher Race One",
    reason: "Driver device could not submit retained evidence.",
    arrival: { localTime: "10:00:00", offset: fixture.offset },
    completion: { localTime: "10:05:00", offset: fixture.offset },
    photos: photoDescriptors(requestId),
    now: new Date("2026-08-20T16:00:00.000Z")
  };
}

test("S20: duplicate concurrent requests serialize to one execution and one immutable ledger event", async () => {
  const fixture = await seedHistoricalVisit("idempotent");
  const requestId = crypto.randomUUID();
  let executions = 0;
  const execute = async (context) => {
    executions += 1;
    await delay(80);
    await insertCompletedRecord({
      driverLogin: context.driverLogin,
      job: context.job,
      completedAt: context.completedAt,
      photoReferences: context.photoReferences,
      completionContext: context.completionContext
    });
    return { dependencyWarnings: [] };
  };
  const first = assistInput(fixture, { requestId });
  const second = { ...assistInput(fixture, { requestId }), assistEventId: crypto.randomUUID() };
  const results = await Promise.all([
    applyHistoricalDriverAssist({ ...first, execute }),
    applyHistoricalDriverAssist({ ...second, execute })
  ]);

  assert.equal(executions, 1);
  assert.deepEqual(results.map((result) => result.exactReplay === true).sort(), [false, true]);
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM driver_job_assist_events WHERE request_id = $1::uuid",
    [requestId]
  )).rows[0].count, 1);
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM driver_job_records WHERE job_id = $1 AND status = 'complete'",
    [fixture.jobId]
  )).rows[0].count, 1);
});

test("S21: two dispatchers racing on the same visit produce exactly one winner", async () => {
  const fixture = await seedHistoricalVisit("two-dispatchers");
  let executions = 0;
  const execute = async (context) => {
    executions += 1;
    await delay(80);
    await insertCompletedRecord({
      driverLogin: context.driverLogin,
      job: context.job,
      completedAt: context.completedAt,
      photoReferences: context.photoReferences,
      completionContext: context.completionContext
    });
    return { dependencyWarnings: [] };
  };
  const outcomes = await Promise.allSettled([
    applyHistoricalDriverAssist({ ...assistInput(fixture, { actorId: "dispatcher-a" }), execute }),
    applyHistoricalDriverAssist({ ...assistInput(fixture, { actorId: "dispatcher-b" }), execute })
  ]);
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = outcomes.filter((outcome) => outcome.status === "rejected");

  assert.equal(executions, 1);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 1, JSON.stringify(outcomes));
  assert.match(String(losers[0].reason?.code || ""), /^HISTORICAL_ASSIST_(VISIT_NOT_FOUND|ALREADY_COMPLETED)$/u);
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM driver_job_assist_events WHERE primary_job_id = $1",
    [fixture.jobId]
  )).rows[0].count, 1);
});

test("S22: a Driver completion winning the insert race preserves Driver evidence and rolls back the assist", async () => {
  const fixture = await seedHistoricalVisit("driver-wins");
  let releaseAssist;
  const assistMayContinue = new Promise((resolve) => {
    releaseAssist = resolve;
  });
  let signalExecute;
  const executeReached = new Promise((resolve) => {
    signalExecute = resolve;
  });
  let capturedContext;
  const input = assistInput(fixture);
  const assistPromise = applyHistoricalDriverAssist({
    ...input,
    execute: async (context) => {
      capturedContext = context;
      signalExecute();
      await assistMayContinue;
      const record = await insertCompletedRecord({
        driverLogin: context.driverLogin,
        job: context.job,
        completedAt: context.completedAt,
        photoReferences: context.photoReferences,
        completionContext: context.completionContext
      });
      if (record.job_details?.completionRequestId !== context.completionContext.requestId) {
        throw Object.assign(new Error("Driver completion won the race."), {
          status: 409,
          code: "HISTORICAL_ASSIST_COMPLETION_RACE"
        });
      }
      return { dependencyWarnings: [] };
    }
  });

  await executeReached;
  assert.ok(capturedContext);
  const driverPhotos = [
    `r2://driver/driver-pickup-photo/2026/08/20/${crypto.randomUUID()}/driver-1.jpg`,
    `r2://driver/driver-pickup-photo/2026/08/20/${crypto.randomUUID()}/driver-2.jpg`
  ];
  await insertCompletedRecord({
    driverLogin: capturedContext.driverLogin,
    job: capturedContext.job,
    completedAt: capturedContext.completedAt,
    photoReferences: driverPhotos
  });
  releaseAssist();

  await assert.rejects(assistPromise, (error) => error?.code === "HISTORICAL_ASSIST_COMPLETION_RACE");
  const record = (await query(
    "SELECT photo_data_urls, job_details FROM driver_job_records WHERE job_id = $1",
    [fixture.jobId]
  )).rows[0];
  assert.deepEqual(record.photo_data_urls, driverPhotos);
  assert.equal(record.job_details.completionSource, undefined);
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM driver_job_assist_events WHERE request_id = $1::uuid",
    [input.requestId]
  )).rows[0].count, 0);
});

test("S23: reported client queue counts block assistance even when the device labels its state ok", async () => {
  const fixture = await seedHistoricalVisit("client-queue");
  const sessionId = crypto.randomUUID();
  await query(
    `INSERT INTO driver_sessions (
       session_id, token_hash, driver_login, device_id, metadata, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::jsonb, now() + interval '1 day'
     )`,
    [
      sessionId,
      crypto.createHash("sha256").update(sessionId).digest("hex"),
      fixture.driverLogin,
      `device-${sessionId}`,
      JSON.stringify({
        offlineSync: {
          state: "ok",
          planDate: fixture.planDate,
          pendingEventCount: 1,
          reviewRequiredCount: 0,
          unsyncedPhotoCount: 0,
          serverReceivedAt: new Date().toISOString()
        }
      })
    ]
  );

  const listing = await listHistoricalDriverAssists({
    planDate: fixture.planDate,
    now: new Date("2026-08-20T16:00:00.000Z")
  });
  const visit = listing.routes[0]?.visits[0];
  assert.equal(visit?.actionable, false, JSON.stringify(listing));
  assert.ok(visit?.blockers.some(({ code }) => code === "HISTORICAL_ASSIST_UNSYNCED_DEVICE_EVIDENCE"));
  assert.equal(listing.routes[0]?.clientSyncIssues[0]?.pendingEventCount, 1);
});
