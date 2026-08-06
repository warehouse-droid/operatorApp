import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import {
  markDriverOfflinePhotoDurable,
  persistDriverOfflineDayPlan,
  registerDriverOfflineSync
} from "../../../src/driver-offline-repository.js";
import { processDriverOfflineQueue } from "../../../src/driver-offline-service.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";
import { applyMbtDriverBinOfflineEvent } from "../../../src/mbt/driver-bin-offline-application.js";
import {
  BIN_DISPATCH_YARD_CODE,
  BIN_DISPATCH_YARD_ID
} from "../support/bin-dispatch-fixtures.js";
import {
  createAssignedDriverBinFixture,
  driverBinEvent
} from "../support/driver-bin-fixtures.js";

after(closeDb);

test("P3-F19: the established manifest/event queue applies a BIN start and completion once with device occurrence time", async () => {
  const fixture = await createAssignedDriverBinFixture("offline-queue");
  // The synthetic Dispatch fixture schedules work many years ahead to avoid
  // collisions. Normalize only its current-state clock before issuing this
  // real-time offline manifest; production reservations are created before a
  // Driver downloads the route and therefore already satisfy this invariant.
  await withTransaction(() => recordAssetMovement({ query, ambientTransaction: true }, {
    assetId: fixture.assetId,
    movementType: "synthetic_offline_manifest_clock_baseline",
    afterStatus: "reserved",
    afterLocation: {
      kind: "yard",
      reference: BIN_DISPATCH_YARD_CODE,
      yardId: BIN_DISPATCH_YARD_ID
    },
    contractId: fixture.contractId,
    visitId: fixture.frontVisitId,
    truckId: fixture.binTruckId,
    driverId: fixture.driverId,
    evidenceReferences: [],
    source: "p3_driver_offline_queue_fixture",
    actorType: "system",
    actorId: "p3-driver-offline-queue-test",
    occurredAt: new Date(Date.now() - 1_000)
  }));
  const dayPlan = await getDriverDayJobs(fixture.driverLogin, {
    date: fixture.planDate,
    allowBin: true,
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  const jobs = dayPlan.jobs;
  const manifestId = crypto.randomUUID();
  const deviceId = `p3-driver-device-${fixture.suffix}`;
  const manifest = await persistDriverOfflineDayPlan({
    manifestId,
    driverLogin: fixture.driverLogin,
    deviceId,
    plan: fixture.plan,
    planMetadata: {
      planId: fixture.planId,
      planDate: fixture.planDate,
      planRevision: fixture.assignment.planRevision
    },
    jobs,
    driverProfile: { login: fixture.driverLogin, displayName: "Synthetic BIN driver" },
    dayState: { truckId: fixture.binTruckId, truckPlate: jobs[0].truckPlate }
  });
  const collect = manifest.jobs[0];
  const startEvent = driverBinEvent(fixture, collect, "job_started", 1, {}, {
    manifestId,
    deviceId,
    jobFingerprint: collect.fingerprint,
    predecessorFingerprint: collect.predecessorFingerprint,
    locationStatus: "not_checked_offline"
  });
  const completionEvent = driverBinEvent(fixture, collect, "job_completed", 2, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "collect_empty_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: fixture.assetId,
        scannedValue: fixture.assetCode
      }],
      photoEvidence: [],
      notes: [],
      signatures: [],
      receipt: null
    }
  }, {
    manifestId,
    deviceId,
    jobFingerprint: collect.fingerprint,
    predecessorFingerprint: collect.predecessorFingerprint,
    locationStatus: "not_checked_offline"
  });
  const deliver = manifest.jobs[1];
  const startDeliverEvent = driverBinEvent(fixture, deliver, "job_started", 3, {}, {
    manifestId,
    deviceId,
    jobFingerprint: deliver.fingerprint,
    predecessorFingerprint: deliver.predecessorFingerprint,
    locationStatus: "not_checked_offline"
  });
  const photoId = crypto.randomUUID();
  const photoHash = "d".repeat(64);
  const photoReference = `r2://driver/driver-stop-photo/2026/08/03/${photoId}/placement.jpg`;
  const deliverCompletionEvent = driverBinEvent(fixture, deliver, "job_completed", 4, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "deliver_bin",
      scans: [],
      photoEvidence: [{ evidenceCode: "placement_photo", ordinal: 0 }],
      notes: [],
      signatures: [],
      receipt: null
    }
  }, {
    manifestId,
    deviceId,
    jobFingerprint: deliver.fingerprint,
    predecessorFingerprint: deliver.predecessorFingerprint,
    locationStatus: "not_checked_offline",
    photos: [{
      photoId,
      ordinal: 0,
      recordType: "driver-stop-photo",
      mimeType: "image/jpeg",
      byteSize: 1_024,
      sha256: photoHash
    }]
  });

  const registered = await registerDriverOfflineSync({
    driverLogin: fixture.driverLogin,
    deviceId,
    manifestId,
    events: [startEvent, completionEvent, startDeliverEvent, deliverCompletionEvent],
    photoReceipts: [{
      photoId,
      objectReference: photoReference,
      byteSize: 1_024,
      sha256: photoHash
    }]
  });
  assert.deepEqual(registered.events.map(({ status }) => status), [
    "pending", "pending", "pending", "waiting_photos"
  ]);
  await markDriverOfflinePhotoDurable(photoId, {
    objectReference: photoReference,
    verifiedByteSize: 1_024,
    verifiedSha256: photoHash,
    receipt: { provider: "synthetic-p3-test" }
  });

  const applied = await processDriverOfflineQueue({
    driverLogin: fixture.driverLogin,
    planDate: fixture.planDate,
    deviceId,
    applyEvent: applyMbtDriverBinOfflineEvent
  });
  assert.deepEqual(applied.map(({ status }) => status), ["applied", "applied", "applied", "applied"]);
  assert.deepEqual(applied.map(({ occurredAt }) => new Date(occurredAt).toISOString()), [
    startEvent.occurredAt,
    completionEvent.occurredAt,
    startDeliverEvent.occurredAt,
    deliverCompletionEvent.occurredAt
  ]);
  assert.equal(applied[3].result.replayed, false);

  const replay = await processDriverOfflineQueue({
    driverLogin: fixture.driverLogin,
    planDate: fixture.planDate,
    deviceId,
    applyEvent: applyMbtDriverBinOfflineEvent
  });
  assert.deepEqual(replay.map(({ status }) => status), ["applied", "applied", "applied", "applied"]);
  const durable = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_driver_bin_event_applications
         WHERE source_event_id = ANY($1::uuid[])) AS applications,
       (SELECT count(*)::int FROM driver_job_records
         WHERE source_offline_event_id = ANY($1::uuid[])) AS driver_records,
       (SELECT count(*)::int FROM mbt_evidence
         WHERE source_driver_event_id = $2::uuid) AS completion_evidence,
       (SELECT count(*)::int FROM mbt_bin_movements
         WHERE service_visit_id = $3 AND source = 'driver_bin_execution') AS driver_movements,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS netsuite_outbox`,
    [
      [startEvent.eventId, completionEvent.eventId, startDeliverEvent.eventId, deliverCompletionEvent.eventId],
      deliverCompletionEvent.eventId,
      fixture.frontVisitId
    ]
  );
  assert.deepEqual(durable.rows[0], {
    applications: 4,
    driver_records: 2,
    completion_evidence: 1,
    driver_movements: 2,
    netsuite_outbox: 0
  });
  const timing = await query(
    `SELECT source_event_id::text, device_occurred_at, server_received_at, server_applied_at
       FROM mbt_driver_bin_event_applications
      WHERE source_event_id = ANY($1::uuid[])
      ORDER BY client_sequence`,
    [[startEvent.eventId, completionEvent.eventId, startDeliverEvent.eventId, deliverCompletionEvent.eventId]]
  );
  assert.deepEqual(timing.rows.map((row) => ({
    eventId: row.source_event_id,
    occurredAt: new Date(row.device_occurred_at).toISOString(),
    receiptWithinAcceptedSkew:
      new Date(row.device_occurred_at).getTime() - new Date(row.server_received_at).getTime()
        <= 5 * 60 * 1000,
    applicationAfterReceipt: new Date(row.server_applied_at) >= new Date(row.server_received_at)
  })), [
    {
      eventId: startEvent.eventId,
      occurredAt: startEvent.occurredAt,
      receiptWithinAcceptedSkew: true,
      applicationAfterReceipt: true
    },
    {
      eventId: completionEvent.eventId,
      occurredAt: completionEvent.occurredAt,
      receiptWithinAcceptedSkew: true,
      applicationAfterReceipt: true
    },
    {
      eventId: startDeliverEvent.eventId,
      occurredAt: startDeliverEvent.occurredAt,
      receiptWithinAcceptedSkew: true,
      applicationAfterReceipt: true
    },
    {
      eventId: deliverCompletionEvent.eventId,
      occurredAt: deliverCompletionEvent.occurredAt,
      receiptWithinAcceptedSkew: true,
      applicationAfterReceipt: true
    }
  ]);
});
