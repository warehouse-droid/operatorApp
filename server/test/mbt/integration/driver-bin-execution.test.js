import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { ordinaryDispatchSideEffects } from "../support/bin-dispatch-fixtures.js";
import {
  createAssignedDriverBinFixture,
  driverBinDurableState,
  driverBinEvent,
  enabledDriverBinBoundary
} from "../support/driver-bin-fixtures.js";

const execution = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/driver-bin-execution-service.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

/** @param {string} name */
function requiredOperation(name) {
  const operation = execution[name];
  assert.equal(typeof operation, "function", `P3.9 requires driver-bin-execution-service.${name}.`);
  return operation;
}

after(async () => {
  await closeDb();
});

test("P3-F18: an assigned BIN physical-stop group materializes a frozen versioned Driver job without ordinary order identity", async () => {
  const materializeMbtDriverBinJob = requiredOperation("materializeMbtDriverBinJob");
  const fixture = await createAssignedDriverBinFixture("materialized-job");
  const jobs = [];
  for (const baseJob of fixture.jobs) {
    jobs.push(await materializeMbtDriverBinJob(baseJob, {
      clientVersion: "2026.08.03.1",
      minimumClientVersion: "2026.08.03.1"
    }));
  }
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.mbt.actionCode), ["collect_empty_bin", "deliver_bin"]);
  assert.equal(jobs.every((job) => job.mbt.schemaVersion === "mbt-driver-bin-job-v1"), true);
  assert.equal(jobs.every((job) => job.mbt.visitId === fixture.frontVisitId), true);
  assert.equal(jobs.every((job) => job.mbt.contractId === fixture.contractId), true);
  assert.equal(jobs.every((job) => job.mbt.exactAssets.outgoing.assetId === fixture.assetId), true);
  assert.equal(jobs.every((job) => job.orderRefs.length === 0 && job.orderTypes[0] === "BIN"), true);
  assert.equal(jobs[0].requiredPhotos, 0);
  assert.equal(jobs[1].requiredPhotos, 1);
  assert.match(jobs[0].mbt.executionSnapshotHash, /^[0-9a-f]{64}$/u);
  assert.equal(jobs[0].mbt.executionSnapshotHash, jobs[1].mbt.executionSnapshotHash);
});

test("P3-F18/P3-F19: offline occurrence time applies one exact delivery movement/evidence set and exact retry is quiet", async () => {
  const materializeMbtDriverBinJob = requiredOperation("materializeMbtDriverBinJob");
  const startMbtDriverBinJob = requiredOperation("startMbtDriverBinJob");
  const completeMbtDriverBinJob = requiredOperation("completeMbtDriverBinJob");
  const fixture = await createAssignedDriverBinFixture("offline-delivery");
  const ordinaryBefore = await ordinaryDispatchSideEffects();
  const [collect, deliver] = await Promise.all(fixture.jobs.map((job) =>
    materializeMbtDriverBinJob(job, {
      clientVersion: "2026.08.03.1",
      minimumClientVersion: "2026.08.03.1"
    })
  ));
  const manifestId = crypto.randomUUID();
  const manifest = { manifestId, schemaVersion: 2, planId: fixture.planId, planRevision: fixture.assignment.planRevision };

  const startCollect = driverBinEvent(fixture, collect, "job_started", 1, {}, { manifestId });
  await startMbtDriverBinJob({ event: startCollect, job: collect, manifest }, { capability: enabledDriverBinBoundary });
  const collectEvent = driverBinEvent(fixture, collect, "job_completed", 2, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "collect_empty_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: fixture.assetId,
        scannedValue: fixture.assetCode
      }]
    }
  }, { manifestId });
  await completeMbtDriverBinJob({
    event: collectEvent,
    job: collect,
    manifest,
    photoReferences: []
  }, { capability: enabledDriverBinBoundary });

  const startDeliver = driverBinEvent(fixture, deliver, "job_started", 3, {}, { manifestId });
  await startMbtDriverBinJob({ event: startDeliver, job: deliver, manifest }, { capability: enabledDriverBinBoundary });
  const photoReference = `r2://driver-stop-photo/p3-placement-${fixture.suffix}.jpg`;
  const deliverEvent = driverBinEvent(fixture, deliver, "job_completed", 4, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "deliver_bin",
      scans: [],
      photoEvidence: [{ evidenceCode: "placement_photo", ordinal: 0 }]
    }
  }, {
    manifestId,
    photos: [{
      photoId: crypto.randomUUID(),
      ordinal: 0,
      objectReference: photoReference,
      sha256: "a".repeat(64),
      mimeType: "image/jpeg",
      byteSize: 1_024,
      durableReceipt: true
    }]
  });
  const completed = await completeMbtDriverBinJob({
    event: deliverEvent,
    job: deliver,
    manifest,
    photoReferences: [photoReference]
  }, { capability: enabledDriverBinBoundary });
  const replay = await completeMbtDriverBinJob({
    event: structuredClone(deliverEvent),
    job: structuredClone(deliver),
    manifest: structuredClone(manifest),
    photoReferences: [photoReference]
  }, { capability: enabledDriverBinBoundary });

  assert.equal(completed.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, completed.body);
  const state = await driverBinDurableState(fixture);
  assert.deepEqual({
    visitStatus: state.visit_status,
    assetStatus: state.asset_status,
    assetLocation: state.asset_location_kind,
    movementCount: state.movement_count,
    evidenceCount: state.evidence_count,
    applicationCount: state.application_count,
    driverRecords: state.driver_record_count,
    completedDriverRecords: state.completed_driver_record_count,
    activeReservations: state.active_reservation_count
  }, {
    visitStatus: "completed",
    assetStatus: "at_customer",
    assetLocation: "customer_site",
    movementCount: 3,
    evidenceCount: 2,
    applicationCount: 4,
    driverRecords: 2,
    completedDriverRecords: 2,
    activeReservations: 0
  });
  const applications = await query(
    `SELECT event_type, device_occurred_at, server_received_at, server_applied_at
       FROM mbt_driver_bin_event_applications
      WHERE service_visit_id = $1
      ORDER BY client_sequence`,
    [fixture.frontVisitId]
  );
  assert.equal(applications.rowCount, 4);
  for (const [index, row] of applications.rows.entries()) {
    assert.equal(new Date(row.device_occurred_at).toISOString(), [startCollect, collectEvent, startDeliver, deliverEvent][index].occurredAt);
    assert.equal(new Date(row.server_received_at).toISOString(), [startCollect, collectEvent, startDeliver, deliverEvent][index].receivedAt);
    assert.ok(new Date(row.server_applied_at).getTime() >= new Date(row.server_received_at).getTime());
  }
  const ordinaryAfter = await ordinaryDispatchSideEffects();
  const { driver_jobs: _driverJobsBefore, ...ordinaryBeforeWithoutDriverJobs } = ordinaryBefore;
  const { driver_jobs: _driverJobsAfter, ...ordinaryAfterWithoutDriverJobs } = ordinaryAfter;
  assert.deepEqual(ordinaryAfterWithoutDriverJobs, ordinaryBeforeWithoutDriverJobs);
  // Driver job rows are intentionally created for the two BIN physical stops.
  // Their exact scoped count is asserted above; a process-global count is not
  // stable while Node executes the independent concurrency fixture in parallel.
  assert.equal(state.netsuite_outbox_count, 0);
});

test("P3-F18: wrong asset and missing durable requirement evidence block every operational boundary", async () => {
  const materializeMbtDriverBinJob = requiredOperation("materializeMbtDriverBinJob");
  const startMbtDriverBinJob = requiredOperation("startMbtDriverBinJob");
  const completeMbtDriverBinJob = requiredOperation("completeMbtDriverBinJob");
  const fixture = await createAssignedDriverBinFixture("wrong-evidence");
  const collect = await materializeMbtDriverBinJob(fixture.jobs[0], {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  const manifest = { manifestId: crypto.randomUUID(), schemaVersion: 2, planId: fixture.planId };
  await startMbtDriverBinJob({
    event: driverBinEvent(fixture, collect, "job_started", 1, {}, { manifestId: manifest.manifestId }),
    job: collect,
    manifest
  }, { capability: enabledDriverBinBoundary });
  const before = await driverBinDurableState(fixture);
  const wrong = driverBinEvent(fixture, collect, "job_completed", 2, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "collect_empty_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: crypto.randomUUID(),
        scannedValue: "WRONG-ASSET"
      }]
    }
  }, { manifestId: manifest.manifestId });
  await assert.rejects(
    () => completeMbtDriverBinJob({ event: wrong, job: collect, manifest, photoReferences: [] }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => error?.status === 409 && error?.code === "MBT_DRIVER_BIN_ASSET_MISMATCH"
  );
  const stateAfterRejection = await driverBinDurableState(fixture);
  assert.deepEqual(stateAfterRejection, before);
});

test("P3-F20: an unsafe frozen visit/template/asset change is a review boundary and retains the source event identity", async () => {
  const materializeMbtDriverBinJob = requiredOperation("materializeMbtDriverBinJob");
  const completeMbtDriverBinJob = requiredOperation("completeMbtDriverBinJob");
  const fixture = await createAssignedDriverBinFixture("unsafe-change");
  const collect = await materializeMbtDriverBinJob(fixture.jobs[0], {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  await query(
    `UPDATE mbt_service_visits
        SET service_snapshot = service_snapshot || '{"dispatchChanged":true}'::jsonb,
            revision = revision + 1,
            updated_at = now()
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId]
  );
  const event = driverBinEvent(fixture, collect, "job_completed", 1, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "collect_empty_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: fixture.assetId,
        scannedValue: fixture.assetCode
      }]
    }
  });
  await assert.rejects(
    () => completeMbtDriverBinJob({ event, job: collect, manifest: { manifestId: event.manifestId }, photoReferences: [] }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => error?.status === 409
      && error?.code === "MBT_DRIVER_BIN_REVIEW_REQUIRED"
      && error?.details?.eventId === event.eventId
  );
  const state = await driverBinDurableState(fixture);
  assert.equal(state.movement_count, 1);
  assert.equal(state.evidence_count, 0);
  assert.equal(state.completed_driver_record_count, 0);
});

test("P3-F19: failure after operational writes rolls back evidence, movement, job, visit, and acknowledgement together", async () => {
  const materializeMbtDriverBinJob = requiredOperation("materializeMbtDriverBinJob");
  const completeMbtDriverBinJob = requiredOperation("completeMbtDriverBinJob");
  const fixture = await createAssignedDriverBinFixture("rollback-after-movement");
  const collect = await materializeMbtDriverBinJob(fixture.jobs[0], {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  const manifest = {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    planId: fixture.planId,
    planRevision: fixture.assignment.planRevision
  };
  const event = driverBinEvent(fixture, collect, "job_completed", 1, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "collect_empty_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: fixture.assetId,
        scannedValue: fixture.assetCode
      }]
    }
  }, { manifestId: manifest.manifestId });
  const before = await driverBinDurableState(fixture);
  await assert.rejects(
    completeMbtDriverBinJob(
      { event, job: collect, manifest, photoReferences: [] },
      {
        capability: enabledDriverBinBoundary,
        hooks: {
          afterMovements: () => {
            throw new Error("synthetic failure after BIN movements");
          }
        }
      }
    ),
    /synthetic failure after BIN movements/
  );
  const afterFailure = await driverBinDurableState(fixture);
  assert.deepEqual(afterFailure, before);

  const applied = await completeMbtDriverBinJob(
    { event, job: collect, manifest, photoReferences: [] },
    { capability: enabledDriverBinBoundary }
  );
  assert.equal(applied.replayed, false);
  const afterRetry = await driverBinDurableState(fixture);
  assert.equal(afterRetry.application_count, before.application_count + 1);
  assert.equal(afterRetry.evidence_count, before.evidence_count + 1);
  assert.equal(afterRetry.movement_count, before.movement_count + 1);
  assert.equal(afterRetry.completed_driver_record_count, before.completed_driver_record_count + 1);
});
