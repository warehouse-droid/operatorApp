import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";
import {
  completeMbtDriverBinJob,
  materializeMbtDriverBinJob,
  startMbtDriverBinJob
} from "../../../src/mbt/driver-bin-execution-service.js";
import { createFrontdeskPrerequisites } from "../support/frontdesk-fixtures.js";
import {
  createAssignedDriverBinFixture,
  driverBinDurableState,
  driverBinEvent,
  enabledDriverBinBoundary
} from "../support/driver-bin-fixtures.js";
import { createExchangeDriverBinFixture } from "../support/driver-bin-scenario-fixtures.js";

after(closeDb);

const ambientDatabase = { query, ambientTransaction: true };

/** @param {Record<string, any>} job */
function materialize(job) {
  return materializeMbtDriverBinJob(job, {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
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

/** @param {Record<string, any>} fixture @param {Record<string, any>} job @param {Record<string, any>} manifest @param {number} sequence */
async function start(fixture, job, manifest, sequence) {
  const event = driverBinEvent(fixture, job, "job_started", sequence, {}, {
    manifestId: manifest.manifestId
  });
  return startMbtDriverBinJob(
    { event, job, manifest },
    { capability: enabledDriverBinBoundary }
  );
}

/**
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>} job
 * @param {Record<string, any>} manifest
 * @param {number} sequence
 * @param {Record<string, any>} mbt
 * @param {Array<{ordinal: number, reference: string, hash?: string}>} [photos]
 */
function completionInput(fixture, job, manifest, sequence, mbt, photos = []) {
  const event = driverBinEvent(fixture, job, "job_completed", sequence, { mbt }, {
    manifestId: manifest.manifestId,
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

/** @param {string} visitId @param {string} visitAction */
async function linkVisitStepToDeliveryTemplate(visitId, visitAction) {
  const linked = await query(
    `UPDATE mbt_visit_steps step
        SET template_step_id = template_step.template_step_id
       FROM mbt_service_visits visit
       JOIN mbt_service_template_steps template_step
         ON template_step.template_version_id = visit.service_template_version_id
        AND template_step.action_code = 'deliver_bin'
      WHERE step.service_visit_id = $1
        AND visit.service_visit_id = step.service_visit_id
        AND step.action_code = $2
      RETURNING step.visit_step_id::text`,
    [visitId, visitAction]
  );
  assert.equal(linked.rowCount, 1);
}

/** @param {Record<string, any>} fixture */
async function completeInitialCollect(fixture, collect, manifest, sequence = 2) {
  const input = completionInput(fixture, collect, manifest, sequence, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "collect_empty_bin",
    scans: [{
      evidenceCode: "outgoing_bin_scan",
      assetRole: "outgoing",
      assetId: fixture.assetId,
      scannedValue: fixture.assetCode
    }]
  });
  return completeMbtDriverBinJob(input, { capability: enabledDriverBinBoundary });
}

/**
 * Create a real immutable movement so the intentionally wrong locked state is
 * itself internally consistent and only the Driver/template guard can reject it.
 * @param {Record<string, any>} fixture
 * @param {string} assetId
 * @param {string} movementType
 * @param {string} afterStatus
 * @param {Record<string, any>} afterLocation
 */
function moveAsset(fixture, assetId, movementType, afterStatus, afterLocation) {
  return withTransaction(() => recordAssetMovement(ambientDatabase, {
    assetId,
    movementType,
    afterStatus,
    afterLocation,
    contractId: fixture.contractId,
    visitId: fixture.frontVisitId,
    truckId: fixture.binTruckId,
    driverId: fixture.driverId,
    evidenceReferences: [],
    source: "p3_driver_integrity_detector",
    actorType: "system",
    actorId: "p3-driver-integrity-test",
    occurredAt: new Date()
  }));
}

test("P3-F19 integrity: a locked template pre-state mismatch rolls back every completion side effect", async () => {
  const fixture = await createAssignedDriverBinFixture("template-pre-state");
  await linkVisitStepToDeliveryTemplate(fixture.frontVisitId, "deliver_bin");
  const [collect, deliver] = await Promise.all(fixture.jobs.map(materialize));
  const manifest = partialManifest(fixture);

  await start(fixture, collect, manifest, 1);
  await completeInitialCollect(fixture, collect, manifest, 2);
  await start(fixture, deliver, manifest, 3);
  await moveAsset(fixture, fixture.assetId, "synthetic_wrong_pre_state", "at_customer", {
    kind: "customer_site",
    reference: fixture.siteProfileId,
    customerSiteProfileId: fixture.siteProfileId
  });
  const before = await driverBinDurableState(fixture);
  const photo = `r2://driver-stop-photo/${fixture.suffix}-pre-state.jpg`;
  const input = completionInput(fixture, deliver, manifest, 4, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "deliver_bin",
    photoEvidence: [{ evidenceCode: "placement_photo", ordinal: 0 }]
  }, [{ ordinal: 0, reference: photo }]);

  await assert.rejects(
    completeMbtDriverBinJob(input, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_ASSET_STATE_MISMATCH"
  );
  assert.deepEqual(await driverBinDurableState(fixture), before);
  const eventRows = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_evidence WHERE source_driver_event_id = $1::uuid) AS evidence,
       (SELECT count(*)::int FROM mbt_driver_bin_event_applications WHERE source_event_id = $1::uuid) AS applications,
       (SELECT count(*)::int FROM mbt_driver_bin_billing_triggers WHERE source_driver_event_id = $1::uuid) AS billing`,
    [input.event.eventId]
  );
  assert.deepEqual(eventRows.rows[0], { evidence: 0, applications: 0, billing: 0 });
});

test("P3-F19 integrity: an action-derived after-state cannot contradict the frozen template", async () => {
  const fixture = await createAssignedDriverBinFixture("template-after-state");
  await linkVisitStepToDeliveryTemplate(fixture.frontVisitId, "collect_empty_bin");
  await moveAsset(fixture, fixture.assetId, "synthetic_template_pre_state", "on_truck", {
    kind: "truck",
    reference: fixture.jobs[0].truckPlate,
    truckId: fixture.binTruckId
  });
  const collect = await materialize(fixture.jobs[0]);
  const manifest = partialManifest(fixture);
  await start(fixture, collect, manifest, 1);
  const before = await driverBinDurableState(fixture);
  const input = completionInput(fixture, collect, manifest, 2, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "collect_empty_bin",
    scans: [{
      evidenceCode: "outgoing_bin_scan",
      assetRole: "outgoing",
      assetId: fixture.assetId,
      scannedValue: fixture.assetCode
    }]
  });

  await assert.rejects(
    completeMbtDriverBinJob(input, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_TEMPLATE_STATE_MISMATCH"
  );
  assert.deepEqual(await driverBinDurableState(fixture), before);
});

test("P3-F22 integrity: exchange incoming identity must still be at the exact frozen customer site", async () => {
  const fixture = await createExchangeDriverBinFixture();
  const [collect, exchange] = await Promise.all(fixture.jobs.map(materialize));
  const manifest = partialManifest(fixture);
  await start(fixture, collect, manifest, 1);
  await completeMbtDriverBinJob(completionInput(fixture, collect, manifest, 2, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "collect_empty_bin",
    scans: [{
      evidenceCode: "collect_outgoing_scan",
      assetRole: "outgoing",
      assetId: fixture.assetId,
      scannedValue: fixture.assetCode
    }]
  }), { capability: enabledDriverBinBoundary });
  await start(fixture, exchange, manifest, 3);

  const otherSite = await createFrontdeskPrerequisites({ label: "exchange-wrong-site" });
  await moveAsset(fixture, fixture.incomingAssetId, "synthetic_wrong_exchange_site", "at_customer", {
    kind: "customer_site",
    reference: otherSite.siteProfileId,
    customerSiteProfileId: otherSite.siteProfileId
  });
  const before = await driverBinDurableState(fixture);
  const input = completionInput(fixture, exchange, manifest, 4, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "exchange_bin",
    scans: [
      {
        evidenceCode: "exchange_outgoing_scan",
        assetRole: "outgoing",
        assetId: fixture.assetId,
        scannedValue: fixture.assetCode
      },
      {
        evidenceCode: "exchange_incoming_scan",
        assetRole: "incoming",
        assetId: fixture.incomingAssetId,
        scannedValue: fixture.incomingAssetCode
      }
    ],
    photoEvidence: [
      { evidenceCode: "exchange_outgoing_photo", ordinal: 0 },
      { evidenceCode: "exchange_incoming_photo", ordinal: 1 }
    ]
  }, [
    { ordinal: 0, reference: `r2://driver-stop-photo/${fixture.suffix}-site-out.jpg` },
    { ordinal: 1, reference: `r2://driver-stop-photo/${fixture.suffix}-site-in.jpg` }
  ]);

  await assert.rejects(
    completeMbtDriverBinJob(input, { capability: enabledDriverBinBoundary }),
    (error) => error?.code === "MBT_DRIVER_BIN_ASSET_LOCATION_MISMATCH"
  );
  assert.deepEqual(await driverBinDurableState(fixture), before);
  const incoming = await query(
    `SELECT lifecycle_status, location_kind, customer_site_profile_id::text
       FROM mbt_bin_asset_state WHERE asset_id = $1`,
    [fixture.incomingAssetId]
  );
  assert.deepEqual(incoming.rows[0], {
    lifecycle_status: "at_customer",
    location_kind: "customer_site",
    customer_site_profile_id: otherSite.siteProfileId
  });
});
