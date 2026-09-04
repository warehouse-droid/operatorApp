// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { getDriverDayJobs, recordDriverJobPhotos } from "../../../src/driver-repository.js";
import {
  persistDriverOfflineDayPlan,
  registerDriverOfflineEvents,
  sanitizeDriverOfflineJob
} from "../../../src/driver-offline-repository.js";
import { listDriverPwaStops, reopenDriverPwaStop } from "../../../src/driver-pwa-repository.js";

after(async () => {
  await closeDb();
});

function randomPastDate() {
  const dayOffset = crypto.randomBytes(4).readUInt32BE(0) % 20_000;
  return new Date(Date.UTC(1900, 0, 1 + dayOffset)).toISOString().slice(0, 10);
}

function durablePhoto(label) {
  return `r2://driver/driver-dropoff-photo/2026/08/20/${crypto.randomUUID()}/${label}.jpg`;
}

function basicJob(jobId, planDate, overrides = {}) {
  return {
    jobId,
    planDate,
    driverLogin: "retained-driver",
    truckId: "retained-truck",
    truckPlate: "KEEP-1",
    loadId: "retained-load",
    loadName: "Retained evidence load",
    stopId: "retained-stop",
    stopType: "dropoff",
    location: "12441 Highway 50",
    dropLocation: "12441 Highway 50",
    address: "Bolton, ON",
    orderRefs: [],
    physicalVisitJobIds: [jobId],
    physicalVisitStopIds: ["retained-stop"],
    requiredPhotos: 2,
    ...overrides
  };
}

async function insertInProgressJob(job, photos) {
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
       load_id, load_name, stop_id, stop_type, order_refs, photo_data_urls,
       status, started_at, completed_at, job_details
     ) VALUES (
       $1, $2, $3::date, $4, $5, $6,
       $7, $8, $9, $10, $11::jsonb, $12::jsonb,
       'in_progress', now() - interval '1 minute', NULL, $13::jsonb
     )`,
    [
      job.jobId,
      job.planId || null,
      job.planDate,
      job.driverLogin,
      job.truckId,
      job.truckPlate,
      job.loadId,
      job.loadName,
      job.stopId,
      job.stopType,
      JSON.stringify(job.orderRefs || []),
      JSON.stringify(photos),
      JSON.stringify({
        schemaVersion: 1,
        requiredPhotos: job.requiredPhotos,
        physicalVisitJobIds: job.physicalVisitJobIds,
        physicalVisitStopIds: job.physicalVisitStopIds
      })
    ]
  );
}

test("S39: retained photos satisfy the requirement and are merged with any new completion photos", async () => {
  const planDate = randomPastDate();
  const satisfiedJob = basicJob(`retained-satisfied-${crypto.randomUUID()}`, planDate);
  const satisfiedPhotos = [durablePhoto("old-1"), durablePhoto("old-2")];
  await insertInProgressJob(satisfiedJob, satisfiedPhotos);
  const satisfied = await recordDriverJobPhotos(satisfiedJob.driverLogin, satisfiedJob.jobId, {
    job: satisfiedJob,
    photoDataUrls: []
  });
  assert.equal(satisfied.status, "complete");
  assert.deepEqual(satisfied.photo_data_urls, satisfiedPhotos);

  const partialJob = basicJob(`retained-partial-${crypto.randomUUID()}`, planDate);
  const retained = durablePhoto("retained");
  const newlyCaptured = durablePhoto("new");
  await insertInProgressJob(partialJob, [retained]);
  const partial = await recordDriverJobPhotos(partialJob.driverLogin, partialJob.jobId, {
    job: partialJob,
    photoDataUrls: [newlyCaptured]
  });
  assert.deepEqual(partial.photo_data_urls, [retained, newlyCaptured]);
});

test("S40: offline job sanitization preserves retained evidence and the remaining requirement", () => {
  const job = basicJob("retained-offline-job", "2026-08-20", {
    retainedPhotoReferences: [durablePhoto("offline-retained-1"), durablePhoto("offline-retained-2")],
    retainedPhotoCount: 2,
    remainingRequiredPhotos: 0,
    maxPhotos: 20
  });
  const sanitized = sanitizeDriverOfflineJob(job);
  assert.deepEqual(sanitized.retainedPhotoReferences, job.retainedPhotoReferences);
  assert.equal(sanitized.retainedPhotoCount, 2);
  assert.equal(sanitized.remainingRequiredPhotos, 0);
  assert.equal(sanitized.maxPhotos, 20);
});

test("S40a: an offline manifest uses the remaining requirement and accepts zero new photos", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const driverLogin = `retained-offline-${suffix}`;
  const deviceId = `retained-device-${suffix}`;
  const manifestId = crypto.randomUUID();
  const planDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const job = basicJob(`retained-offline-job-${suffix}`, planDate, {
    driverLogin,
    retainedPhotoReferences: [durablePhoto("offline-retained-1"), durablePhoto("offline-retained-2")],
    retainedPhotoCount: 2,
    remainingRequiredPhotos: 0,
    maxPhotos: 20
  });
  const manifest = await persistDriverOfflineDayPlan({
    manifestId,
    driverLogin,
    deviceId,
    planMetadata: { planId: null, planDate, planRevision: 1 },
    jobs: [job],
    driverProfile: { login: driverLogin, name: "Retained Offline Driver" },
    dayState: { planDate, truckPlate: job.truckPlate, preDvirStatus: "complete" }
  });
  const manifestJob = manifest.jobs[0];
  const stored = await query(
    `SELECT required_photo_count, job_snapshot
       FROM driver_offline_manifest_jobs
      WHERE manifest_id = $1::uuid`,
    [manifestId]
  );
  assert.equal(Number(stored.rows[0].required_photo_count), 0);
  assert.equal(stored.rows[0].job_snapshot.retainedPhotoCount, 2);

  const [registered] = await registerDriverOfflineEvents({
    driverLogin,
    deviceId,
    manifestId,
    events: [{
      eventId: crypto.randomUUID(),
      clientSequence: 1,
      eventType: "job_completed",
      jobId: job.jobId,
      jobFingerprint: manifestJob.fingerprint,
      predecessorFingerprint: manifestJob.predecessorFingerprint,
      occurredAt: new Date().toISOString(),
      locationStatus: "not_checked_offline",
      details: { driverRemark: "Retained photos already satisfy the completion requirement." },
      photos: []
    }]
  });
  assert.equal(registered.status, "pending");
  assert.equal(registered.reviewRequired, false);
  assert.equal(registered.reviewReason, "");
  assert.deepEqual(registered.photos, []);
});

async function seedConsolidatedCompletedVisit() {
  const planDate = randomPastDate();
  const suffix = crypto.randomUUID().slice(0, 8);
  const driverLogin = `retained-group-${suffix}`;
  const orderRefs = [`SO-RETAIN-A-${suffix}`, `SO-RETAIN-B-${suffix}`];
  const planResult = await query(
    `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at, note)
     VALUES ($1::date, 'confirmed', 5, now(), 'Retained grouped-photo reopen fixture')
     RETURNING id`,
    [planDate]
  );
  const planId = Number(planResult.rows[0].id);
  const orders = orderRefs.map((orderRef) => ({
    id: orderRef,
    type: "SO",
    customer: "Retained evidence customer",
    sourceYard: "2967",
    outboundLocation: "2967",
    pickupLocations: ["2967"],
    address: "12441 Highway 50, Bolton, ON"
  }));
  const trucks = [{
    id: `truck-${suffix}`,
    plate: `KEEP-${suffix}`,
    base: "2967",
    driver: "Retained Group Driver",
    driverLogin,
    loads: [{
      id: `load-${suffix}`,
      name: "Retained group load",
      driverLogin,
      driverName: "Retained Group Driver",
      stops: orderRefs.map((orderRef, index) => ({
        id: `drop-${index + 1}-${suffix}`,
        type: "drop",
        orderId: orderRef,
        location: "12441 Highway 50, Bolton, ON"
      }))
    }]
  }];
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
    [planId, JSON.stringify(orders), JSON.stringify(trucks)]
  );
  const route = await getDriverDayJobs(driverLogin, { date: planDate });
  const drops = route.jobs.filter((job) => job.stopType === "dropoff");
  assert.equal(drops.length, 2, JSON.stringify(route.jobs));
  assert.deepEqual(drops[0].physicalVisitJobIds, drops.map((job) => job.jobId));
  const photos = [durablePhoto("group-old-1"), durablePhoto("group-old-2")];
  const recordIds = [];
  for (const job of drops) {
    const inserted = await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
         load_id, load_name, stop_id, stop_type, order_refs, photo_data_urls,
         status, started_at, completed_at, job_details
       ) VALUES (
         $1, $2, $3::date, $4, $5, $6,
         $7, $8, $9, $10, $11::jsonb, $12::jsonb,
         'complete', now() - interval '2 minutes', now() - interval '1 minute', $13::jsonb
       ) RETURNING id`,
      [
        job.jobId,
        planId,
        planDate,
        driverLogin,
        job.truckId,
        job.truckPlate,
        job.loadId,
        job.loadName,
        job.stopId,
        job.stopType,
        JSON.stringify(job.orderRefs || []),
        JSON.stringify(photos),
        JSON.stringify({
          ...job,
          schemaVersion: 1,
          requiredPhotos: 2,
          physicalVisitJobIds: drops.map((candidate) => candidate.jobId)
        })
      ]
    );
    recordIds.push(Number(inserted.rows[0].id));
  }
  return { planId, planDate, driverLogin, drops, photos, recordIds };
}

test("S41: reopening one grouped stop atomically reopens every member without deleting canonical photos", async () => {
  const fixture = await seedConsolidatedCompletedVisit();
  const listing = await listDriverPwaStops({
    planDate: fixture.planDate,
    driverLogin: fixture.driverLogin
  });
  const target = listing.stops.find((stop) => Number(stop.recordId) === fixture.recordIds[0]);
  assert.ok(target, JSON.stringify(listing));

  const result = await reopenDriverPwaStop({
    recordId: target.recordId,
    expectedStateHash: target.stateHash,
    auditNote: "Driver must repeat this consolidated physical visit.",
    idempotencyId: crypto.randomUUID(),
    reopenedBy: "Dispatcher Retained"
  });
  const rows = await query(
    `SELECT id, status, photo_data_urls, job_details
       FROM driver_job_records
      WHERE id = ANY($1::bigint[])
      ORDER BY id`,
    [fixture.recordIds]
  );

  assert.deepEqual(result.physicalVisitJobIds, fixture.drops.map((job) => job.jobId));
  assert.deepEqual(result.recordIds, fixture.recordIds);
  assert.deepEqual(rows.rows.map((row) => row.status), ["pending", "pending"]);
  assert.deepEqual(rows.rows.map((row) => row.photo_data_urls), [fixture.photos, fixture.photos]);
  assert.ok(rows.rows.every((row) => row.job_details.retainedPhotoReferences.length === 2));

  const projected = await getDriverDayJobs(fixture.driverLogin, { date: fixture.planDate });
  const projectedDrops = projected.jobs.filter((job) => job.stopType === "dropoff");
  assert.ok(projectedDrops.every((job) => job.retainedPhotoCount === 2));
  assert.ok(projectedDrops.every((job) => job.remainingRequiredPhotos === 0));
});
