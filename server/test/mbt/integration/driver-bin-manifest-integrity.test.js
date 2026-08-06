import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  completeMbtDriverBinJob,
  materializeMbtDriverBinJob,
  startMbtDriverBinJob
} from "../../../src/mbt/driver-bin-execution-service.js";
import {
  createAssignedDriverBinFixture,
  driverBinDurableState,
  driverBinEvent,
  enabledDriverBinBoundary
} from "../support/driver-bin-fixtures.js";
import { createLoadedDumpDriverBinFixture } from "../support/driver-bin-scenario-fixtures.js";

after(closeDb);

/** @param {Record<string, any>} job */
function materialize(job) {
  return materializeMbtDriverBinJob(job, {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
}

/** @param {Record<string, any>} fixture @param {number} hour @param {number} [offset] */
function fixtureTime(fixture, hour, offset = 0) {
  const date = new Date(`${fixture.planDate}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  date.setMilliseconds(date.getMilliseconds() + offset);
  return date;
}

/**
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>[]} jobs
 * @param {Date} generatedAt
 */
function completeManifest(fixture, jobs, generatedAt) {
  return {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    fingerprintVersion: 2,
    generatedAt: generatedAt.toISOString(),
    expiresAt: fixtureTime(fixture, 23).toISOString(),
    planId: fixture.planId,
    planDate: fixture.planDate,
    planRevision: fixture.assignment.planRevision,
    complete: true,
    jobs: jobs.map((job, sequenceIndex) => ({ ...job, sequenceIndex }))
  };
}

/** @param {Record<string, any>} fixture */
function partialManifest(fixture) {
  return {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    planId: fixture.planId,
    planRevision: fixture.assignment.planRevision
  };
}

/**
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>} job
 * @param {Record<string, any>} manifest
 * @param {number} sequence
 * @param {Date} occurredAt
 */
function startInput(fixture, job, manifest, sequence, occurredAt) {
  const event = driverBinEvent(fixture, job, "job_started", sequence, {}, {
    manifestId: manifest.manifestId,
    occurredAt: occurredAt.toISOString(),
    receivedAt: new Date(occurredAt.getTime() + 1_000).toISOString()
  });
  return { event, job, manifest };
}

/**
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>} job
 * @param {Record<string, any>} manifest
 * @param {number} sequence
 * @param {Date} occurredAt
 * @param {Record<string, any>} mbt
 * @param {Array<{ordinal: number, reference: string, hash?: string}>} [photos]
 */
function completionInput(fixture, job, manifest, sequence, occurredAt, mbt, photos = []) {
  const event = driverBinEvent(fixture, job, "job_completed", sequence, { mbt }, {
    manifestId: manifest.manifestId,
    occurredAt: occurredAt.toISOString(),
    receivedAt: new Date(occurredAt.getTime() + 1_000).toISOString(),
    photos: photos.map((photo) => ({
      photoId: crypto.randomUUID(),
      ordinal: photo.ordinal,
      objectReference: photo.reference,
      sha256: photo.hash || "a".repeat(64),
      mimeType: "image/jpeg",
      byteSize: 2_048,
      durableReceipt: true
    }))
  });
  return {
    event,
    job,
    manifest,
    photoReferences: photos.map((photo) => photo.reference)
  };
}

/** @param {Record<string, any>} fixture @param {string} eventId */
async function noWriteSnapshot(fixture, eventId) {
  const [state, event] = await Promise.all([
    driverBinDurableState(fixture),
    query(
      `SELECT
         (SELECT count(*)::int FROM mbt_evidence WHERE source_driver_event_id = $1::uuid) AS evidence,
         (SELECT count(*)::int FROM mbt_driver_bin_event_applications WHERE source_event_id = $1::uuid) AS applications,
         (SELECT count(*)::int FROM mbt_driver_bin_billing_triggers WHERE source_driver_event_id = $1::uuid) AS billing`,
      [eventId]
    )
  ]);
  return { state, event: event.rows[0] };
}

function collectDetails(fixture, evidenceCode = "outgoing_bin_scan") {
  return {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: evidenceCode === "loaded_bin_scan" ? "pickup_loaded_bin" : "collect_empty_bin",
    scans: [{
      evidenceCode,
      assetRole: "outgoing",
      assetId: fixture.assetId,
      scannedValue: fixture.assetCode
    }]
  };
}

test("P3-F19 manifest integrity: a BIN target cannot skip an incomplete job from another manifest visit", async () => {
  const fixture = await createAssignedDriverBinFixture("manifest-route-target");
  const other = await createAssignedDriverBinFixture("manifest-route-prior");
  const [target, otherVisitJob] = await Promise.all([
    materialize(fixture.jobs[0]),
    materialize(other.jobs[0])
  ]);
  const prior = {
    ...otherVisitJob,
    planId: fixture.planId,
    planDate: fixture.planDate,
    driverLogin: fixture.driverLogin
  };
  const manifest = completeManifest(fixture, [prior, target], fixtureTime(fixture, 11));
  const input = startInput(fixture, target, manifest, 1, fixtureTime(fixture, 13));
  const before = await noWriteSnapshot(fixture, input.event.eventId);

  await assert.rejects(
    startMbtDriverBinJob(input, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_ROUTE_OUT_OF_ORDER"
      && error?.details?.blockedJobId === prior.jobId
  );
  assert.deepEqual(await noWriteSnapshot(fixture, input.event.eventId), before);
});

test("P3-F19 manifest integrity: completion requires its durable start and exact completion retries still replay", async () => {
  const fixture = await createAssignedDriverBinFixture("manifest-start-required");
  const collect = await materialize(fixture.jobs[0]);
  const manifest = completeManifest(fixture, [collect], fixtureTime(fixture, 11));
  const completion = completionInput(
    fixture,
    collect,
    manifest,
    2,
    fixtureTime(fixture, 14),
    collectDetails(fixture)
  );
  const before = await noWriteSnapshot(fixture, completion.event.eventId);

  await assert.rejects(
    completeMbtDriverBinJob(completion, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_START_REQUIRED"
  );
  assert.deepEqual(await noWriteSnapshot(fixture, completion.event.eventId), before);

  await startMbtDriverBinJob(
    startInput(fixture, collect, manifest, 1, fixtureTime(fixture, 13)),
    { capability: enabledDriverBinBoundary }
  );
  const applied = await completeMbtDriverBinJob(completion, {
    capability: enabledDriverBinBoundary
  });
  const replay = await completeMbtDriverBinJob(structuredClone(completion), {
    capability: enabledDriverBinBoundary
  });
  assert.equal(applied.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, applied.body);
});

test("P3-F19 manifest integrity: a pre-manifest BIN event is rejected without writes", async () => {
  const fixture = await createAssignedDriverBinFixture("manifest-clock");
  const collect = await materialize(fixture.jobs[0]);
  const manifest = completeManifest(fixture, [collect], fixtureTime(fixture, 14));
  const input = startInput(fixture, collect, manifest, 1, fixtureTime(fixture, 13));
  const before = await noWriteSnapshot(fixture, input.event.eventId);

  await assert.rejects(
    startMbtDriverBinJob(input, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_EVENT_BEFORE_MANIFEST"
  );
  assert.deepEqual(await noWriteSnapshot(fixture, input.event.eventId), before);
});

test("P3-F19 manifest integrity: an event older than locked asset state cannot regress its timeline", async () => {
  const fixture = await createAssignedDriverBinFixture("asset-clock");
  const collect = await materialize(fixture.jobs[0]);
  const manifest = completeManifest(fixture, [collect], fixtureTime(fixture, 11));
  await query(
    `UPDATE mbt_bin_asset_state
        SET changed_at = $2::timestamptz, updated_at = now()
      WHERE asset_id = $1`,
    [fixture.assetId, fixtureTime(fixture, 14)]
  );
  const input = startInput(fixture, collect, manifest, 1, fixtureTime(fixture, 13));
  const before = await noWriteSnapshot(fixture, input.event.eventId);

  await assert.rejects(
    startMbtDriverBinJob(input, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_ASSET_TIME_CONFLICT"
  );
  assert.deepEqual(await noWriteSnapshot(fixture, input.event.eventId), before);
});

test("P3-F21 manifest integrity: a frozen dump pair must remain actively accepted", async () => {
  const fixture = await createLoadedDumpDriverBinFixture();
  const [pickup, dump] = await Promise.all(fixture.jobs.slice(0, 2).map(materialize));
  const pickupManifest = partialManifest(fixture);
  await startMbtDriverBinJob(
    startInput(fixture, pickup, pickupManifest, 1, fixtureTime(fixture, 13)),
    { capability: enabledDriverBinBoundary }
  );
  const pickupPhoto = `r2://driver-stop-photo/${fixture.suffix}-acceptance-pickup.jpg`;
  await completeMbtDriverBinJob(completionInput(
    fixture,
    pickup,
    pickupManifest,
    2,
    fixtureTime(fixture, 14),
    {
      ...collectDetails(fixture, "loaded_bin_scan"),
      photoEvidence: [{ evidenceCode: "loaded_condition_photo", ordinal: 0 }]
    },
    [{ ordinal: 0, reference: pickupPhoto }]
  ), { capability: enabledDriverBinBoundary });

  const manifest = completeManifest(fixture, [dump], fixtureTime(fixture, 15));
  await startMbtDriverBinJob(
    startInput(fixture, dump, manifest, 3, fixtureTime(fixture, 16)),
    { capability: enabledDriverBinBoundary }
  );
  await query(
    `UPDATE mbt_dump_site_materials
        SET accepted = false, revision = revision + 1, updated_at = now()
      WHERE dump_site_id = $1 AND material_id = $2`,
    [fixture.dumpSiteId, fixture.materialId]
  );
  const receiptPhoto = `r2://driver-stop-photo/${fixture.suffix}-inactive-receipt.jpg`;
  const completion = completionInput(
    fixture,
    dump,
    manifest,
    4,
    fixtureTime(fixture, 17),
    {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "dump_bin",
      photoEvidence: [{ evidenceCode: "dump_receipt_photo", ordinal: 0 }],
      receipt: {
        dumpSiteId: fixture.dumpSiteId,
        materialId: fixture.materialId,
        ticketNumber: `P3-INACTIVE-${fixture.suffix.slice(0, 12)}`,
        weight: "2480.500000",
        quantity: "2.250000",
        unitOfMeasure: "TON",
        subtotalMinor: 31_259,
        taxMinor: 4_064,
        totalMinor: 35_323,
        currency: "CAD",
        receiptPhotoOrdinal: 0
      }
    },
    [{ ordinal: 0, reference: receiptPhoto }]
  );
  const before = await noWriteSnapshot(fixture, completion.event.eventId);

  await assert.rejects(
    completeMbtDriverBinJob(completion, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_DUMP_ACCEPTANCE_REQUIRED"
  );
  assert.deepEqual(await noWriteSnapshot(fixture, completion.event.eventId), before);
});
