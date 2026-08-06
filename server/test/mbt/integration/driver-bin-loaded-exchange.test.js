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
  driverBinEvent,
  enabledDriverBinBoundary
} from "../support/driver-bin-fixtures.js";
import {
  createExchangeDriverBinFixture,
  createLoadedDumpDriverBinFixture
} from "../support/driver-bin-scenario-fixtures.js";

after(async () => closeDb());

/** @param {Record<string, any>} job */
async function materialize(job) {
  return materializeMbtDriverBinJob(job, {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
}

/**
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>} job
 * @param {Record<string, any>} manifest
 * @param {number} sequence
 */
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
 * @param {Record<string, any>} details
 * @param {Array<{ordinal: number, reference: string, hash?: string}>} [photos]
 */
function completionInput(fixture, job, manifest, sequence, details, photos = []) {
  const event = driverBinEvent(fixture, job, "job_completed", sequence, { mbt: details }, {
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

test("P3-F21: loaded pickup, durable dump receipt, and yard return apply once from offline evidence", async () => {
  const fixture = await createLoadedDumpDriverBinFixture();
  const [pickup, dump, returned] = await Promise.all(fixture.jobs.map(materialize));
  const manifest = {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    planId: fixture.planId,
    planRevision: fixture.assignment.planRevision
  };

  await start(fixture, pickup, manifest, 1);
  const pickupPhoto = `r2://driver-stop-photo/${fixture.suffix}-loaded.jpg`;
  await completeMbtDriverBinJob(completionInput(fixture, pickup, manifest, 2, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "pickup_loaded_bin",
    scans: [{
      evidenceCode: "loaded_bin_scan",
      assetRole: "outgoing",
      assetId: fixture.assetId,
      scannedValue: fixture.assetCode
    }],
    photoEvidence: [{ evidenceCode: "loaded_condition_photo", ordinal: 0 }]
  }, [{ ordinal: 0, reference: pickupPhoto }]), {
    capability: enabledDriverBinBoundary
  });

  await start(fixture, dump, manifest, 3);
  const receiptPhoto = `r2://driver-stop-photo/${fixture.suffix}-receipt.jpg`;
  const dumpInput = completionInput(fixture, dump, manifest, 4, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "dump_bin",
    photoEvidence: [{ evidenceCode: "dump_receipt_photo", ordinal: 0 }],
    receipt: {
      dumpSiteId: fixture.dumpSiteId,
      materialId: fixture.materialId,
      ticketNumber: `P3-TICKET-${fixture.suffix.slice(0, 12)}`,
      weight: "2480.500000",
      quantity: "2.250000",
      unitOfMeasure: "TON",
      subtotalMinor: 31_259,
      taxMinor: 4_064,
      totalMinor: 35_323,
      currency: "CAD",
      receiptPhotoOrdinal: 0
    }
  }, [{ ordinal: 0, reference: receiptPhoto, hash: "b".repeat(64) }]);
  await assert.rejects(
    completeMbtDriverBinJob(
      { ...dumpInput, photoReferences: [] },
      { capability: enabledDriverBinBoundary }
    ),
    (error) => error?.code === "MBT_DRIVER_BIN_EVIDENCE_MISSING"
  );
  const dumpResult = await completeMbtDriverBinJob(
    dumpInput,
    { capability: enabledDriverBinBoundary }
  );
  const dumpReplay = await completeMbtDriverBinJob(
    structuredClone(dumpInput),
    { capability: enabledDriverBinBoundary }
  );
  assert.equal(dumpResult.replayed, false);
  assert.equal(dumpReplay.replayed, true);
  assert.deepEqual(dumpReplay.body, dumpResult.body);

  await start(fixture, returned, manifest, 5);
  const returnPhoto = `r2://driver-stop-photo/${fixture.suffix}-return.jpg`;
  await completeMbtDriverBinJob(completionInput(fixture, returned, manifest, 6, {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "return_bin",
    photoEvidence: [{ evidenceCode: "return_condition_photo", ordinal: 0 }]
  }, [{ ordinal: 0, reference: returnPhoto, hash: "c".repeat(64) }]), {
    capability: enabledDriverBinBoundary
  });

  const state = await query(
    `SELECT visit.status,
            asset.lifecycle_status, asset.location_kind, asset.yard_id::text,
            (SELECT count(*)::int FROM mbt_bin_movements movement
              WHERE movement.service_visit_id = visit.service_visit_id) AS movements,
            (SELECT count(*)::int FROM mbt_evidence evidence
              WHERE evidence.service_visit_id = visit.service_visit_id) AS evidence,
            (SELECT count(*)::int FROM mbt_driver_bin_event_applications application
              WHERE application.service_visit_id = visit.service_visit_id) AS applications,
            (SELECT count(*)::int FROM mbt_bin_asset_reservations reservation
              WHERE reservation.visit_id = visit.service_visit_id
                AND reservation.released_at IS NULL) AS active_reservations
       FROM mbt_service_visits visit
       JOIN mbt_bin_asset_state asset ON asset.asset_id = $2
      WHERE visit.service_visit_id = $1`,
    [fixture.frontVisitId, fixture.assetId]
  );
  assert.deepEqual({
    status: state.rows[0].status,
    lifecycle: state.rows[0].lifecycle_status,
    location: state.rows[0].location_kind,
    yardId: state.rows[0].yard_id,
    movements: state.rows[0].movements,
    evidence: state.rows[0].evidence,
    applications: state.rows[0].applications,
    activeReservations: state.rows[0].active_reservations
  }, {
    status: "completed",
    lifecycle: "available",
    location: "yard",
    yardId: "00000000-0000-4000-8000-000000012441",
    movements: 4,
    evidence: 5,
    applications: 6,
    activeReservations: 0
  });
  const receipt = await query(
    `SELECT ticket_number, weight::text, quantity::text, unit_of_measure,
            subtotal_minor::int, tax_minor::int, total_minor::int, currency,
            receipt_snapshot
       FROM mbt_dump_receipts
      WHERE source_driver_event_id = $1::uuid`,
    [dumpInput.event.eventId]
  );
  assert.equal(receipt.rowCount, 1);
  assert.deepEqual({
    ticket: receipt.rows[0].ticket_number,
    weight: receipt.rows[0].weight,
    quantity: receipt.rows[0].quantity,
    uom: receipt.rows[0].unit_of_measure,
    subtotal: receipt.rows[0].subtotal_minor,
    tax: receipt.rows[0].tax_minor,
    total: receipt.rows[0].total_minor,
    currency: receipt.rows[0].currency
  }, {
    ticket: dumpInput.event.details.mbt.receipt.ticketNumber,
    weight: "2480.500000",
    quantity: "2.250000",
    uom: "TON",
    subtotal: 31_259,
    tax: 4_064,
    total: 35_323,
    currency: "CAD"
  });
});

test("P3-F22: exchange reserves, scans, evidences, and moves outgoing/incoming BIN identities independently", async () => {
  const fixture = await createExchangeDriverBinFixture();
  assert.equal(fixture.assignment.assetReservations.length, 2);
  assert.deepEqual(
    fixture.assignment.assetReservations.map(
      (/** @type {Record<string, any>} */ reservation) => reservation.reservationSlot
    ).sort(),
    ["incoming", "outgoing"]
  );
  const [collect, exchange] = await Promise.all(fixture.jobs.map(materialize));
  assert.notEqual(exchange.mbt.exactAssets.outgoing.assetId, exchange.mbt.exactAssets.incoming.assetId);
  const manifest = {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    planId: fixture.planId,
    planRevision: fixture.assignment.planRevision
  };

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
  const outgoingPhoto = `r2://driver-stop-photo/${fixture.suffix}-exchange-out.jpg`;
  const incomingPhoto = `r2://driver-stop-photo/${fixture.suffix}-exchange-in.jpg`;
  const exchangeInput = completionInput(fixture, exchange, manifest, 4, {
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
    { ordinal: 0, reference: outgoingPhoto },
    { ordinal: 1, reference: incomingPhoto, hash: "b".repeat(64) }
  ]);
  const completed = await completeMbtDriverBinJob(
    exchangeInput,
    { capability: enabledDriverBinBoundary }
  );
  const replay = await completeMbtDriverBinJob(
    structuredClone(exchangeInput),
    { capability: enabledDriverBinBoundary }
  );
  assert.equal(completed.replayed, false);
  assert.equal(replay.replayed, true);

  const assets = await query(
    `SELECT state.asset_id::text, state.lifecycle_status, state.location_kind,
            state.customer_site_profile_id::text, state.truck_id::text,
            (SELECT count(*)::int FROM mbt_bin_movements movement
              WHERE movement.service_visit_id = $1
                AND movement.asset_id = state.asset_id) AS movement_count
       FROM mbt_bin_asset_state state
      WHERE state.asset_id = ANY($2::uuid[])
      ORDER BY state.asset_id`,
    [fixture.frontVisitId, [fixture.assetId, fixture.incomingAssetId]]
  );
  const byId = new Map(assets.rows.map(
    (/** @type {Record<string, any>} */ row) => [String(row.asset_id), row]
  ));
  assert.deepEqual({
    lifecycle: byId.get(fixture.assetId).lifecycle_status,
    location: byId.get(fixture.assetId).location_kind,
    site: byId.get(fixture.assetId).customer_site_profile_id,
    movements: byId.get(fixture.assetId).movement_count
  }, {
    lifecycle: "at_customer",
    location: "customer_site",
    site: fixture.siteProfileId,
    movements: 3
  });
  assert.deepEqual({
    lifecycle: byId.get(fixture.incomingAssetId).lifecycle_status,
    location: byId.get(fixture.incomingAssetId).location_kind,
    truckId: byId.get(fixture.incomingAssetId).truck_id,
    movements: byId.get(fixture.incomingAssetId).movement_count
  }, {
    lifecycle: "on_truck",
    location: "truck",
    truckId: fixture.binTruckId,
    movements: 2
  });
  const durable = await query(
    `SELECT
       (SELECT status FROM mbt_service_visits WHERE service_visit_id = $1) AS visit_status,
       (SELECT count(*)::int FROM mbt_bin_asset_reservations
         WHERE visit_id = $1 AND released_at IS NULL) AS active_reservations,
       (SELECT count(*)::int FROM mbt_evidence WHERE service_visit_id = $1) AS evidence,
       (SELECT count(*)::int FROM mbt_driver_bin_event_applications
         WHERE service_visit_id = $1) AS applications`,
    [fixture.frontVisitId]
  );
  assert.deepEqual(durable.rows[0], {
    visit_status: "completed",
    active_reservations: 0,
    evidence: 5,
    applications: 4
  });
});

test("P3-F22: an exchange cannot skip its prior physical stop or collapse both asset roles onto one BIN", async () => {
  const fixture = await createExchangeDriverBinFixture();
  const [collect, exchange] = await Promise.all(fixture.jobs.map(materialize));
  const manifest = {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    planId: fixture.planId,
    planRevision: fixture.assignment.planRevision
  };
  const exchangeDetails = {
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
  };
  const photos = [
    { ordinal: 0, reference: `r2://driver-stop-photo/${fixture.suffix}-ordered-out.jpg` },
    { ordinal: 1, reference: `r2://driver-stop-photo/${fixture.suffix}-ordered-in.jpg` }
  ];
  await assert.rejects(
    completeMbtDriverBinJob(
      completionInput(fixture, exchange, manifest, 1, exchangeDetails, photos),
      { capability: enabledDriverBinBoundary }
    ),
    (error) => error?.code === "MBT_DRIVER_BIN_STEP_OUT_OF_ORDER"
  );

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

  const collapsed = structuredClone(exchange);
  collapsed.mbt.exactAssets.incoming = structuredClone(collapsed.mbt.exactAssets.outgoing);
  const collapsedDetails = structuredClone(exchangeDetails);
  collapsedDetails.scans[1].assetId = fixture.assetId;
  collapsedDetails.scans[1].scannedValue = fixture.assetCode;
  await assert.rejects(
    completeMbtDriverBinJob(
      completionInput(fixture, collapsed, manifest, 3, collapsedDetails, photos),
      { capability: enabledDriverBinBoundary }
    ),
    (error) => error?.code === "MBT_DRIVER_BIN_ASSET_MISMATCH"
  );
  const durable = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_driver_bin_event_applications
         WHERE service_visit_id = $1 AND visit_step_id = $2) AS exchange_applications,
       (SELECT count(*)::int FROM mbt_bin_movements
         WHERE service_visit_id = $1 AND movement_type LIKE 'exchange_bin_%') AS exchange_movements`,
    [fixture.frontVisitId, exchange.mbt.visitStepId]
  );
  assert.deepEqual(durable.rows[0], {
    exchange_applications: 0,
    exchange_movements: 0
  });
});
