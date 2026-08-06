// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, pool, query, withTransaction } from "../../../src/db.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import {
  markDriverOfflinePhotoDurable,
  persistDriverOfflineDayPlan,
  registerDriverOfflineSync
} from "../../../src/driver-offline-repository.js";
import { processDriverOfflineQueue } from "../../../src/driver-offline-service.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";
import * as binDispatchService from "../../../src/mbt/bin-dispatch-service.js";
import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";
import { applyMbtDriverBinOfflineEvent } from "../../../src/mbt/driver-bin-offline-application.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  acceptFrontdeskQuote,
  convertFrontdeskQuote,
  createFrontdeskQuote,
  issueFrontdeskQuote
} from "../../../src/mbt/frontdesk-service.js";
import {
  applyMasterDataImport,
  previewMasterDataImport
} from "../../../src/mbt/master-data-import-service.js";
import { createPilotReconciliationBatch } from "../../../src/mbt/pilot-reconciliation-service.js";
import {
  approveLocalBillingVersion,
  calculateMbtBillingCase,
  generateMbbsShadowBillingFromSnapshots
} from "../../../src/mbt/shadow-billing-service.js";
import {
  BIN_DISPATCH_BIN_TYPE_ID,
  BIN_DISPATCH_YARD_CODE,
  BIN_DISPATCH_YARD_ID,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";
import {
  billingActor,
  createBillingFixture
} from "../support/billing-fixtures.js";
import {
  createFrontdeskPrerequisites,
  FRONTDESK_PRICING,
  frontdeskCommand,
  frontdeskDistanceResolver,
  frontdeskTaxResolver,
  quoteCommand
} from "../support/frontdesk-fixtures.js";
import {
  buildCustomerSpreadsheetMl,
  CUSTOMER_IMPORT_DEFAULTS,
  syntheticCustomerRow
} from "../support/master-data-import-fixtures.js";
import {
  driverBinEvent
} from "../support/driver-bin-fixtures.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const {
  advanceMbtBinContractLeg,
  assignMbtBinFrontLeg,
  listMbtBinFrontLegs
} = binDispatchService;
const ADMIN = Object.freeze({ operatorId: `p311-admin-${RUN_ID}`, roles: Object.freeze(["admin"]) });
const FRONTDESK = Object.freeze({ operatorId: `p311-frontdesk-${RUN_ID}`, roles: Object.freeze(["mbt_frontdesk"]) });
const DISPATCHER = Object.freeze({ operatorId: `p311-dispatcher-${RUN_ID}`, roles: Object.freeze(["dispatcher"]) });
const CUSTOMER_ID = String(8_800_000_000_000n + (BigInt(`0x${RUN_ID.slice(0, 12)}`) % 999_999_999_999n));
const CUSTOMER_ENTITY = String(100_000 + (Number.parseInt(RUN_ID.slice(0, 8), 16) % 900_000));

/** @param {string} label */
function identity(label) {
  return `p311-${label}-${RUN_ID}-${crypto.randomUUID()}`;
}

/** @param {number} days */
function futureDate(days) {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** @param {number} preferredDays */
async function availableFuturePlanDate(preferredDays) {
  for (let offset = 0; offset < 120; offset += 1) {
    const candidate = futureDate(preferredDays + offset);
    const existing = await query("SELECT 1 FROM dispatch_plans WHERE plan_date = $1::date", [candidate]);
    if (!existing.rowCount) {return candidate;}
  }
  throw new Error("P3.11 could not reserve an unused synthetic Dispatch plan date.");
}

/** @param {string} date @param {number} hour */
function atHour(date, hour) {
  return `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

async function closedGateSnapshot() {
  const result = await query(
    `SELECT flag_key, enabled, revision::int
       FROM mbt_feature_flags
      WHERE flag_key LIKE 'mbt_%'
      ORDER BY flag_key`
  );
  return result.rows;
}

async function isolationSnapshot() {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM sales_orders) AS sales_orders,
       (SELECT count(*)::int FROM purchase_orders) AS purchase_orders,
       (SELECT count(*)::int FROM transfer_orders) AS transfer_orders,
       (SELECT count(*)::int FROM order_dependencies) AS dependencies,
       (SELECT count(*)::int FROM operator_saved_delivery_orders) AS operator_orders,
       (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS netsuite_chains,
       (SELECT count(*)::int FROM mbt_deposit_records) AS deposits,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
       (SELECT count(*)::int FROM mbt_netsuite_outbox_attempts) AS outbox_attempts`
  );
  return result.rows[0];
}

async function importSyntheticCustomer() {
  const content = Buffer.from(buildCustomerSpreadsheetMl([
    syntheticCustomerRow({
      id: CUSTOMER_ID,
      Name: `${CUSTOMER_ENTITY} Synthetic P3.11 Customer ${RUN_ID}`,
      Email: `${RUN_ID}@example.invalid`,
      Phone: "+1-555-0311"
    })
  ]));
  const preview = await previewMasterDataImport({
    actor: ADMIN,
    resource: "customers",
    sourceKind: "netsuite_spreadsheetml",
    fileName: `p311-${RUN_ID}.xls`,
    content,
    defaults: { ...CUSTOMER_IMPORT_DEFAULTS, exportedAt: new Date().toISOString() },
    correlationId: identity("customer-preview-correlation"),
    requestId: identity("customer-preview-request")
  });
  const idempotencyKey = identity("customer-apply");
  const applied = await applyMasterDataImport({
    actor: ADMIN,
    resource: "customers",
    batchId: preview.batchId,
    normalizedHash: preview.normalizedHash,
    targetRevisionToken: preview.targetRevisionToken,
    reason: "Apply the invented P3.11 customer snapshot",
    idempotencyKey,
    correlationId: identity("customer-apply-correlation"),
    requestId: identity("customer-apply-request")
  });
  const replay = await applyMasterDataImport({
    actor: ADMIN,
    resource: "customers",
    batchId: preview.batchId,
    normalizedHash: preview.normalizedHash,
    targetRevisionToken: preview.targetRevisionToken,
    reason: "Apply the invented P3.11 customer snapshot",
    idempotencyKey,
    correlationId: identity("customer-apply-correlation-replay"),
    requestId: identity("customer-apply-request-replay")
  });
  return { preview, applied, replay };
}

async function createServiceReadyImportedCustomer() {
  const imported = await importSyntheticCustomer();
  const configured = await createFrontdeskPrerequisites({ label: `p311-${RUN_ID}` });
  const addressId = crypto.randomUUID();
  const siteProfileId = crypto.randomUUID();
  const payloadHash = crypto.createHash("sha256").update(`p311-address-${RUN_ID}`).digest("hex");
  await withTransaction(async () => {
    await query(
      `INSERT INTO netsuite_customer_subsidiaries (
         customer_netsuite_id, subsidiary_netsuite_id, relationship_name,
         primary_relationship, currency, terms, tax_status, credit_status,
         active, source_modified_at, source_version, payload_hash
       ) VALUES (
         $1, $2, 'Synthetic configured MBT subsidiary', true, 'CAD', 'NET 30',
         'taxable', 'good', true, now(), $3, $4
       )`,
      [CUSTOMER_ID, configured.subsidiaryNetsuiteId, `p311-${RUN_ID}`, payloadHash]
    );
    await query(
      `INSERT INTO netsuite_customer_addresses (
         address_id, customer_netsuite_id, netsuite_address_id, label,
         shipping_default, addressee, address_line_1, city, region,
         postal_code, country_code, active, source_modified_at,
         source_version, payload_hash
       ) VALUES (
         $1, $2, $3, 'P3.11 invented service site', true, $4,
         '311 Example Route', 'Toronto', 'ON', 'M1M 1M1', 'CA', true,
         now(), $5, $6
       )`,
      [
        addressId,
        CUSTOMER_ID,
        `P311-ADDR-${RUN_ID}`,
        `Synthetic P3.11 Customer ${RUN_ID}`,
        `p311-${RUN_ID}`,
        payloadHash
      ]
    );
    await query(
      `INSERT INTO mbt_customer_site_profiles (
         site_profile_id, customer_netsuite_id, address_id,
         site_instructions, access_restrictions, geocode_latitude,
         geocode_longitude, created_by, updated_by
       ) VALUES (
         $1, $2, $3, 'Use only the invented test entrance', 'No live access',
         43.653226, -79.383184, $4, $4
       )`,
      [siteProfileId, CUSTOMER_ID, addressId, ADMIN.operatorId]
    );
  });
  return {
    ...configured,
    customerNetsuiteId: CUSTOMER_ID,
    addressId,
    siteProfileId,
    imported
  };
}

/** @param {Awaited<ReturnType<typeof createServiceReadyImportedCustomer>>} fixture @param {string} planDate */
async function convertImportedCustomer(fixture, planDate) {
  const created = await createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: FRONTDESK, identity: identity("quote") }),
    proposedDeliveryAt: atHour(planDate, 12),
    proposedReturnAt: atHour(futureDate(45), 12)
  }, {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver
  });
  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand("issue", FRONTDESK, {
    quoteId,
    expectedRevision: 1,
    validUntil: atHour(planDate, 23)
  }));
  await acceptFrontdeskQuote(frontdeskCommand("accept", FRONTDESK, {
    quoteId,
    expectedRevision: 2,
    acceptedAt: atHour(planDate, 10)
  }));
  const converted = await convertFrontdeskQuote(frontdeskCommand("convert", FRONTDESK, {
    quoteId,
    expectedRevision: 3
  }));
  return { created, quoteId, converted };
}

/** @param {Awaited<ReturnType<typeof createServiceReadyImportedCustomer>>} customer @param {Awaited<ReturnType<typeof convertImportedCustomer>>} contract @param {string} planDate */
async function prepareDispatch(customer, contract, planDate) {
  const suffix = RUN_ID.slice(0, 12);
  const deliveryVisitId = contract.converted.body.visits[0].visitId;
  const returnVisitId = contract.converted.body.visits[1].visitId;
  const contractId = contract.converted.body.contract.contractId;
  const assetId = crypto.randomUUID();
  const initialMovementId = crypto.randomUUID();
  const assetCode = `P311-BIN-${suffix}`;
  const driverLogin = `p311_driver_${suffix}`;
  const driver = await query(
    "INSERT INTO dispatch_drivers (name, login, active) VALUES ($1, $2, true) RETURNING id::text",
    [`P3.11 Synthetic Driver ${suffix}`, driverLogin]
  );
  const driverId = String(driver.rows[0].id);
  const fleet = await withTransaction(async () => {
    const binTruck = await query(
      `INSERT INTO dispatch_trucks (
         plate, capacity_lbs, active, truck_type, base_yard_id,
         bin_service_enabled, bin_slot_capacity
       ) VALUES ($1, 48000, true, 'bin', $2, true, 1)
       RETURNING id::text`,
      [`P311B${suffix.slice(0, 8)}`, BIN_DISPATCH_YARD_ID]
    );
    await query(
      `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active, created_by)
       VALUES ($1, $2, true, $3)`,
      [binTruck.rows[0].id, BIN_DISPATCH_BIN_TYPE_ID, DISPATCHER.operatorId]
    );
    const flatbed = await query(
      `INSERT INTO dispatch_trucks (plate, capacity_lbs, active)
       VALUES ($1, 48000, true) RETURNING id::text`,
      [`P311F${suffix.slice(0, 8)}`]
    );
    return {
      binTruckId: String(binTruck.rows[0].id),
      flatbedTruckId: String(flatbed.rows[0].id)
    };
  });
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_bin_assets (
         asset_id, asset_code, qr_code, bin_type_id, home_yard_id,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [assetId, assetCode, `QR-${assetCode}`, BIN_DISPATCH_BIN_TYPE_ID, BIN_DISPATCH_YARD_ID, ADMIN.operatorId]
    );
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind,
         after_location_kind, after_location_reference, to_yard_id,
         source, actor_type, actor_id, occurred_at
       ) VALUES (
         $1, $2, 1, 'asset_registered', NULL, 'available', NULL,
         'yard', $3, $4, 'p311_synthetic_registration', 'system', $5,
         $6::timestamptz
       )`,
      [initialMovementId, assetId, BIN_DISPATCH_YARD_CODE, BIN_DISPATCH_YARD_ID, ADMIN.operatorId, new Date(Date.now() - 60_000).toISOString()]
    );
    await query(
      `INSERT INTO mbt_bin_asset_state (
         asset_id, lifecycle_status, location_kind, location_reference,
         yard_id, last_movement_id, revision, changed_at
       ) VALUES ($1, 'available', 'yard', $2, $3, $4, 1, $5::timestamptz)`,
      [assetId, BIN_DISPATCH_YARD_CODE, BIN_DISPATCH_YARD_ID, initialMovementId, new Date(Date.now() - 60_000).toISOString()]
    );
  });
  const binLoadId = `P311-BIN-LOAD-${suffix}`;
  const flatbedLoadId = `P311-FLATBED-LOAD-${suffix}`;
  const trucks = [{
    id: fleet.binTruckId,
    plate: `P311B${suffix.slice(0, 8)}`,
    truckType: "bin",
    binSlotCapacity: 1,
    supportedBinTypeCodes: ["14YD"],
    driverId,
    driverLogin,
    loads: [{ id: binLoadId, name: "P3.11 BIN load", driverId, truckId: fleet.binTruckId, stops: [] }]
  }, {
    id: fleet.flatbedTruckId,
    plate: `P311F${suffix.slice(0, 8)}`,
    truckType: "flatbed",
    binSlotCapacity: 0,
    supportedBinTypeCodes: [],
    driverId,
    driverLogin: `p311_flatbed_control_${suffix}`,
    loads: [{ id: flatbedLoadId, name: "P3.11 Flatbed control", driverId, truckId: fleet.flatbedTruckId, stops: [] }]
  }];
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ($1::date, 'draft', 'P3.11 synthetic local-pilot plan', 1)
     RETURNING id::text`,
    [planDate]
  );
  const planId = String(plan.rows[0].id);
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, $2::jsonb, $3::jsonb)`,
    [
      planId,
      JSON.stringify(trucks),
      JSON.stringify({ dispatchPlanFormat: { version: 2, source: "p311-local-pilot" }, ownYardCodes: [BIN_DISPATCH_YARD_CODE] })
    ]
  );
  const pilotExpiresAt = new Date(`${planDate}T12:00:00.000Z`);
  pilotExpiresAt.setUTCDate(pilotExpiresAt.getUTCDate() + 2);
  await query(
    `INSERT INTO mbt_driver_pilot_scope (
       pilot_scope_id, plan_date, driver_login, truck_id, contract_id,
       service_visit_id, active, authorized_by, authorized_at, expires_at
     ) VALUES ($1, $2::date, $3, $4, $5, $6, true, $7, now(), $8::timestamptz)`,
    [
      crypto.randomUUID(), planDate, driverLogin, fleet.binTruckId,
      contractId, deliveryVisitId, ADMIN.operatorId, pilotExpiresAt.toISOString()
    ]
  );
  return {
    ...customer,
    planId,
    planDate,
    contractId,
    deliveryVisitId,
    returnVisitId,
    assetId,
    assetCode,
    initialMovementId,
    driverId,
    driverLogin,
    suffix,
    binTruckId: fleet.binTruckId,
    flatbedTruckId: fleet.flatbedTruckId,
    binLoadId,
    flatbedLoadId
  };
}

/** @param {Awaited<ReturnType<typeof prepareDispatch>>} fixture @param {string} loadId @param {string} label */
function assignmentCommand(fixture, loadId, label) {
  return {
    actor: DISPATCHER,
    planId: fixture.planId,
    planDate: fixture.planDate,
    loadId,
    visitId: fixture.deliveryVisitId,
    expectedVisitRevision: 1,
    expectedPlanRevision: 1,
    assetAssignments: [{
      reservationSlot: "outgoing",
      assetId: fixture.assetId,
      expectedStateRevision: 1
    }],
    reason: `P3.11 synthetic assignment ${label}`,
    idempotencyKey: identity(`assign-${label}`),
    correlationId: identity(`assign-${label}-correlation`),
    requestId: identity(`assign-${label}-request`)
  };
}

/** @param {Awaited<ReturnType<typeof prepareDispatch>>} fixture @param {Record<string, any>[]} jobs */
async function persistCompleteManifest(fixture, jobs) {
  const plan = await query(
    `SELECT p.id::text, p.plan_date::text, p.revision::int, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [fixture.planId]
  );
  const deviceId = `p311-device-${fixture.suffix}`;
  const manifestId = crypto.randomUUID();
  const manifest = await persistDriverOfflineDayPlan({
    manifestId,
    driverLogin: fixture.driverLogin,
    deviceId,
    plan: plan.rows[0],
    planMetadata: {
      planId: fixture.planId,
      planDate: fixture.planDate,
      planRevision: Number(plan.rows[0].revision)
    },
    jobs,
    driverProfile: { login: fixture.driverLogin, displayName: "P3.11 Synthetic Driver" },
    dayState: { truckId: fixture.binTruckId, truckPlate: jobs[0].truckPlate }
  });
  return { manifest, manifestId, deviceId, plan: plan.rows[0] };
}

/** @param {Awaited<ReturnType<typeof prepareDispatch>>} fixture @param {Awaited<ReturnType<typeof persistCompleteManifest>>} offline */
async function executeOfflineDelivery(fixture, offline) {
  const [collect, deliver] = offline.manifest.jobs;
  const common = (job) => ({
    manifestId: offline.manifestId,
    deviceId: offline.deviceId,
    jobFingerprint: job.fingerprint,
    predecessorFingerprint: job.predecessorFingerprint,
    locationStatus: "not_checked_offline"
  });
  const startedCollect = driverBinEvent(fixture, collect, "job_started", 1, {}, common(collect));
  const completedCollect = driverBinEvent(fixture, collect, "job_completed", 2, {
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
  }, common(collect));
  const startedDeliver = driverBinEvent(fixture, deliver, "job_started", 3, {}, common(deliver));
  const photoId = crypto.randomUUID();
  const photoHash = "3".repeat(64);
  const [photoYear, photoMonth, photoDay] = fixture.planDate.split("-");
  const photoReference = `r2://driver/driver-stop-photo/${photoYear}/${photoMonth}/${photoDay}/${photoId}/placement.jpg`;
  const completedDeliver = driverBinEvent(fixture, deliver, "job_completed", 4, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "deliver_bin",
      scans: [],
      photoEvidence: [{ evidenceCode: "delivery_photo", ordinal: 0 }],
      notes: [{ evidenceCode: "driver_note", text: "Invented P3.11 offline note" }],
      signatures: [],
      receipt: null
    }
  }, {
    ...common(deliver),
    photos: [{
      photoId,
      ordinal: 0,
      recordType: "driver-stop-photo",
      mimeType: "image/jpeg",
      byteSize: 1_024,
      sha256: photoHash
    }]
  });
  const events = [startedCollect, completedCollect, startedDeliver, completedDeliver];
  const registered = await registerDriverOfflineSync({
    driverLogin: fixture.driverLogin,
    deviceId: offline.deviceId,
    manifestId: offline.manifestId,
    events,
    photoReceipts: [{
      photoId,
      objectReference: photoReference,
      byteSize: 1_024,
      sha256: photoHash
    }]
  });
  await markDriverOfflinePhotoDurable(photoId, {
    objectReference: photoReference,
    verifiedByteSize: 1_024,
    verifiedSha256: photoHash,
    receipt: { provider: "p311-synthetic" }
  });
  const applied = await processDriverOfflineQueue({
    driverLogin: fixture.driverLogin,
    planDate: fixture.planDate,
    deviceId: offline.deviceId,
    applyEvent: applyMbtDriverBinOfflineEvent
  });
  const replay = await processDriverOfflineQueue({
    driverLogin: fixture.driverLogin,
    planDate: fixture.planDate,
    deviceId: offline.deviceId,
    applyEvent: applyMbtDriverBinOfflineEvent
  });
  return { collect, deliver, events, registered, applied, replay, photoId, photoReference };
}

/** @param {Awaited<ReturnType<typeof prepareDispatch>>} fixture */
async function exactMovementAndDistanceComparisons(fixture) {
  const movement = await query(
    `SELECT movement_id::text AS "movementId", asset_id::text AS "assetId",
            asset_sequence::int AS "assetSequence", before_status AS "beforeStatus",
            after_status AS "afterStatus", before_location_kind AS "beforeLocationKind",
            before_location_reference AS "beforeLocationReference",
            after_location_kind AS "afterLocationKind",
            after_location_reference AS "afterLocationReference",
            truck_id::text AS "truckId", driver_id::text AS "driverId",
            service_visit_id::text AS "visitId", occurred_at AS "occurredAt"
       FROM mbt_bin_movements
      WHERE service_visit_id = $1
        AND source = 'driver_bin_execution'
        AND after_status = 'at_customer'
      ORDER BY asset_sequence DESC
      LIMIT 1`,
    [fixture.deliveryVisitId]
  );
  const distance = await query(
    `SELECT distance_snapshot_id::text AS "distanceSnapshotId",
            origin_snapshot AS origin, destination_snapshot AS destination,
            provider, provider_metres::int AS "rawMetres",
            rate_distance_band_id::text AS "selectedBandId",
            calculated_amount_minor::int AS "amountMinor", currency
       FROM mbt_distance_snapshots
      WHERE subject_type = 'visit' AND subject_id = $1`,
    [fixture.deliveryVisitId]
  );
  assert.equal(movement.rowCount, 1);
  assert.equal(distance.rowCount, 1);
  const movementManual = {
    assetId: movement.rows[0].assetId,
    assetSequence: movement.rows[0].assetSequence,
    beforeStatus: movement.rows[0].beforeStatus,
    afterStatus: movement.rows[0].afterStatus,
    beforeLocationKind: movement.rows[0].beforeLocationKind,
    beforeLocationReference: movement.rows[0].beforeLocationReference,
    afterLocationKind: movement.rows[0].afterLocationKind,
    afterLocationReference: movement.rows[0].afterLocationReference,
    truckId: movement.rows[0].truckId,
    driverId: movement.rows[0].driverId,
    visitId: movement.rows[0].visitId,
    occurredAt: new Date(movement.rows[0].occurredAt).toISOString()
  };
  const distanceManual = {
    origin: structuredClone(distance.rows[0].origin),
    destination: structuredClone(distance.rows[0].destination),
    provider: distance.rows[0].provider,
    rawMetres: distance.rows[0].rawMetres,
    selectedBandId: distance.rows[0].selectedBandId,
    amountMinor: distance.rows[0].amountMinor,
    currency: distance.rows[0].currency
  };
  return {
    movement: movement.rows[0],
    distance: distance.rows[0],
    comparisons: [{
      comparisonKind: "movement",
      applicationEvidenceId: movement.rows[0].movementId,
      manualReference: `P311-MANUAL-MOVEMENT-${RUN_ID}`,
      manualSnapshot: movementManual
    }, {
      comparisonKind: "distance",
      applicationEvidenceId: distance.rows[0].distanceSnapshotId,
      manualReference: `P311-MANUAL-DISTANCE-${RUN_ID}`,
      manualSnapshot: distanceManual
    }]
  };
}

after(async () => {
  await closeDb();
});

test("P3.11 E2E-A: imported customer -> Front Desk -> BIN Dispatch -> offline Driver -> reconciliation -> next leg -> local billing", {
  timeout: 120_000
}, async () => {
  const gatesBefore = await closedGateSnapshot();
  assert.ok(gatesBefore.length >= 8);
  assert.equal(gatesBefore.every(({ enabled }) => enabled === false), true);
  assert.equal(gatesBefore.find(({ flag_key: key }) => key === "mbt_netsuite_writes")?.enabled, false);
  const isolatedBefore = await isolationSnapshot();
  const planDate = await availableFuturePlanDate(30 + (Number.parseInt(RUN_ID.slice(0, 4), 16) % 15));

  const customer = await createServiceReadyImportedCustomer();
  assert.deepEqual(customer.imported.preview.summary, {
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    skippedRows: 0,
    createdCandidates: 1,
    updatedCandidates: 0,
    unchangedCandidates: 0,
    conflictedCandidates: 0
  });
  assert.equal(customer.imported.applied.replayed, false);
  assert.equal(customer.imported.replay.replayed, true);
  assert.deepEqual(customer.imported.replay.body, customer.imported.applied.body);
  assert.deepEqual(customer.imported.applied.body.entityIds, [CUSTOMER_ID]);

  const contract = await convertImportedCustomer(customer, planDate);
  assert.equal(contract.converted.body.contract.customer.netsuiteId, CUSTOMER_ID);
  assert.deepEqual(contract.converted.body.visits.map(({ visitNumber, serviceAction, status }) => ({
    visitNumber,
    serviceAction,
    status
  })), [
    { visitNumber: 1, serviceAction: "delivery", status: "ready" },
    { visitNumber: 2, serviceAction: "return_bin", status: "tentative" }
  ]);
  assert.equal(contract.converted.body.billingCase.status, "open");

  const fixture = await prepareDispatch(customer, contract, planDate);
  const initialFeed = await listMbtBinFrontLegs({ planDate, search: "", limit: 100 }, {
    capability: enabledBinDispatchBoundary
  });
  const deliveryCard = initialFeed.items.find(({ mbt }) => mbt.visitId === fixture.deliveryVisitId);
  assert.ok(deliveryCard, "the invented delivery front leg must be present in the BIN feed");
  assert.deepEqual(deliveryCard.mbt.timeline.map(({ relation, locked }) => ({ relation, locked })), [
    { relation: "current", locked: false },
    { relation: "future", locked: true }
  ]);
  await assert.rejects(
    () => assignMbtBinFrontLeg(assignmentCommand(fixture, fixture.flatbedLoadId, "flatbed-control"), {
      capability: enabledBinDispatchBoundary
    }),
    (error) => error instanceof MbtError && error.code === "MBT_BIN_TRUCK_REQUIRED"
  );
  const assigned = await assignMbtBinFrontLeg(
    assignmentCommand(fixture, fixture.binLoadId, "type-bin"),
    { capability: enabledBinDispatchBoundary }
  );
  assert.equal(assigned.body.visitId, fixture.deliveryVisitId);
  assert.deepEqual(assigned.body.assetReservations.map(({ assetId }) => assetId), [fixture.assetId]);
  assert.deepEqual(assigned.body.stops.map(({ actionCode }) => actionCode), ["collect_empty_bin", "deliver_bin"]);
  const confirmMbtBinDispatchPlan = binDispatchService.confirmMbtBinDispatchPlan;
  assert.equal(typeof confirmMbtBinDispatchPlan, "function");
  const confirmedPlan = await confirmMbtBinDispatchPlan({
    actor: DISPATCHER,
    planId: fixture.planId,
    note: "P3.11 confirm the exact synthetic BIN assignment"
  }, { capability: enabledBinDispatchBoundary });
  assert.equal(confirmedPlan.status, "confirmed");
  assert.equal(Number(confirmedPlan.revision), 3);
  await withTransaction(() => recordAssetMovement({ query, ambientTransaction: true }, {
    assetId: fixture.assetId,
    movementType: "p311_manifest_clock_baseline",
    afterStatus: "reserved",
    afterLocation: { kind: "yard", reference: BIN_DISPATCH_YARD_CODE, yardId: BIN_DISPATCH_YARD_ID },
    contractId: fixture.contractId,
    visitId: fixture.deliveryVisitId,
    truckId: fixture.binTruckId,
    driverId: fixture.driverId,
    evidenceReferences: [],
    source: "p311_manifest_clock_baseline",
    actorType: "system",
    actorId: ADMIN.operatorId,
    occurredAt: new Date(Date.now() - 1_000)
  }));

  const day = await getDriverDayJobs(fixture.driverLogin, {
    date: fixture.planDate,
    allowBin: true,
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  assert.deepEqual(day.jobs.map(({ mbt }) => mbt.actionCode), ["collect_empty_bin", "deliver_bin"]);
  const offline = await persistCompleteManifest(fixture, day.jobs);
  assert.equal(offline.manifest.complete, true);
  assert.equal(offline.manifest.jobs.length, 2);
  const executed = await executeOfflineDelivery(fixture, offline);
  assert.deepEqual(executed.registered.events.map(({ status }) => status), [
    "pending", "pending", "pending", "waiting_photos"
  ]);
  assert.deepEqual(executed.applied.map(({ status }) => status), ["applied", "applied", "applied", "applied"]);
  assert.deepEqual(executed.replay.map(({ status }) => status), ["applied", "applied", "applied", "applied"]);
  assert.deepEqual(executed.applied.map(({ occurredAt }) => new Date(occurredAt).toISOString()),
    executed.events.map(({ occurredAt }) => occurredAt));
  assert.equal(executed.applied.every(({ locationStatus }) => locationStatus === "not_checked_offline"), true);

  const completedState = await query(
    `SELECT visit.status, visit.revision::int AS visit_revision,
            visit.actual_completed_at, successor.status AS successor_status,
            successor.revision::int AS successor_revision,
            successor.scheduled_start_at AS successor_start,
            successor.scheduled_end_at AS successor_end,
            contract.rental_calendar_days::int,
            asset.lifecycle_status, asset.location_kind,
            asset.customer_site_profile_id::text,
            (SELECT count(*)::int FROM mbt_driver_bin_event_applications application
              WHERE application.service_visit_id = visit.service_visit_id) AS applications,
            (SELECT count(*)::int FROM driver_job_records record
              WHERE record.job_id = ANY($3::text[]) AND record.status = 'complete') AS completed_jobs,
            (SELECT count(*)::int FROM mbt_evidence evidence
              WHERE evidence.source_driver_event_id = ANY($4::uuid[])) AS event_evidence,
            (SELECT count(*)::int FROM mbt_bin_asset_reservations reservation
              WHERE reservation.visit_id = visit.service_visit_id AND reservation.released_at IS NULL) AS reservations
       FROM mbt_service_visits visit
       JOIN mbt_service_visits successor ON successor.service_visit_id = $2
       JOIN mbt_contracts contract ON contract.contract_id = visit.contract_id
       JOIN mbt_bin_asset_state asset ON asset.asset_id = $5
      WHERE visit.service_visit_id = $1`,
    [
      fixture.deliveryVisitId,
      fixture.returnVisitId,
      offline.manifest.jobs.map(({ jobId }) => jobId),
      executed.events.map(({ eventId }) => eventId),
      fixture.assetId
    ]
  );
  assert.deepEqual({
    visitStatus: completedState.rows[0].status,
    successorStatus: completedState.rows[0].successor_status,
    lifecycle: completedState.rows[0].lifecycle_status,
    location: completedState.rows[0].location_kind,
    site: completedState.rows[0].customer_site_profile_id,
    applications: completedState.rows[0].applications,
    jobs: completedState.rows[0].completed_jobs,
    evidence: completedState.rows[0].event_evidence,
    reservations: completedState.rows[0].reservations
  }, {
    visitStatus: "completed",
    successorStatus: "tentative",
    lifecycle: "at_customer",
    location: "customer_site",
    site: fixture.siteProfileId,
    applications: 4,
    jobs: 2,
    evidence: 3,
    reservations: 0
  });

  const originalWindowMs = new Date(completedState.rows[0].successor_end).getTime()
    - new Date(completedState.rows[0].successor_start).getTime();
  assert.equal(originalWindowMs, 4 * 60 * 60 * 1_000);
  const expectedSuccessorStart = new Date(completedState.rows[0].actual_completed_at);
  expectedSuccessorStart.setUTCDate(
    expectedSuccessorStart.getUTCDate() + completedState.rows[0].rental_calendar_days
  );
  const expectedSuccessorEnd = new Date(expectedSuccessorStart.getTime() + originalWindowMs);
  const planRevision = await query("SELECT revision::int FROM dispatch_plans WHERE id = $1", [fixture.planId]);
  const advanceInput = {
    actor: DISPATCHER,
    contractId: fixture.contractId,
    completedVisitId: fixture.deliveryVisitId,
    expectedCompletedVisitRevision: completedState.rows[0].visit_revision,
    nextVisitId: fixture.returnVisitId,
    expectedNextVisitRevision: completedState.rows[0].successor_revision,
    planId: fixture.planId,
    expectedPlanRevision: planRevision.rows[0].revision,
    reason: "Advance the P3.11 successor from retained actual completion evidence",
    idempotencyKey: identity("advance"),
    correlationId: identity("advance-correlation"),
    requestId: identity("advance-request")
  };
  const advanced = await advanceMbtBinContractLeg(advanceInput, { capability: enabledBinDispatchBoundary });
  const advanceReplay = await advanceMbtBinContractLeg(structuredClone(advanceInput), { capability: enabledBinDispatchBoundary });
  assert.equal(advanced.replayed, false);
  assert.equal(advanceReplay.replayed, true);
  assert.deepEqual(advanceReplay.body, advanced.body);
  const successor = await query(
    `SELECT status, scheduled_start_at, scheduled_end_at
       FROM mbt_service_visits WHERE service_visit_id = $1`,
    [fixture.returnVisitId]
  );
  assert.equal(successor.rows[0].status, "ready");
  assert.equal(new Date(successor.rows[0].scheduled_start_at).toISOString(), expectedSuccessorStart.toISOString());
  assert.equal(new Date(successor.rows[0].scheduled_end_at).toISOString(), expectedSuccessorEnd.toISOString());
  const rebasedPlanDate = expectedSuccessorStart.toISOString().slice(0, 10);
  const nextFeed = await listMbtBinFrontLegs({ planDate: rebasedPlanDate, search: "", limit: 100 }, {
    capability: enabledBinDispatchBoundary
  });
  assert.ok(
    nextFeed.items.some(({ mbt }) => mbt.visitId === fixture.returnVisitId),
    "the rebased return leg must be present on its new plan date"
  );
  assert.equal(nextFeed.items.some(({ mbt }) => mbt.visitId === fixture.deliveryVisitId), false);

  const comparisonInputs = await exactMovementAndDistanceComparisons(fixture);
  const reconciliation = await createPilotReconciliationBatch({
    actor: billingActor(`p311-reconcile-${RUN_ID}`),
    batchReference: `P311-EXACT-${RUN_ID}`,
    manualSource: "synthetic_independent_manual_ledger",
    comparisons: comparisonInputs.comparisons,
    reason: "Compare independent invented movement and distance records",
    idempotencyKey: identity("reconcile"),
    correlationId: identity("reconcile-correlation"),
    requestId: identity("reconcile-request")
  });
  assert.deepEqual(reconciliation.body.rows.map(({ comparisonKind, comparisonResult, blocking }) => ({
    comparisonKind,
    comparisonResult,
    blocking
  })), [
    { comparisonKind: "distance", comparisonResult: "matched", blocking: false },
    { comparisonKind: "movement", comparisonResult: "matched", blocking: false }
  ]);

  const billingSource = await query(
    `SELECT billing_case.billing_case_id::text,
            distance.distance_snapshot_id::text
       FROM mbt_billing_cases billing_case
       JOIN mbt_distance_snapshots distance
         ON distance.subject_type = 'visit'
        AND distance.subject_id = billing_case.service_visit_id
      WHERE billing_case.contract_id = $1
        AND billing_case.case_type = 'mbt_contract'`,
    [fixture.contractId]
  );
  assert.equal(billingSource.rowCount, 1);
  let transportCalls = 0;
  const transport = async () => {
    transportCalls += 1;
    throw new Error("P3.11 local-only billing must never invoke transport");
  };
  const calculated = await calculateMbtBillingCase({
    actor: billingActor(`p311-calculate-${RUN_ID}`),
    billingCaseId: billingSource.rows[0].billing_case_id,
    expectedRevision: 1,
    serviceVisitId: fixture.deliveryVisitId,
    distanceSnapshotId: billingSource.rows[0].distance_snapshot_id,
    componentQuantities: {},
    customPrices: [],
    reason: "Calculate the synthetic P3.11 local contract",
    idempotencyKey: identity("calculate"),
    correlationId: identity("calculate-correlation"),
    requestId: identity("calculate-request")
  }, { transport });
  assert.deepEqual(calculated.body.lines.map(({ lineType, netAmountMinor }) => ({ lineType, netAmountMinor })), [
    { lineType: "transport", netAmountMinor: FRONTDESK_PRICING.transportMinor },
    { lineType: "rental", netAmountMinor: FRONTDESK_PRICING.rentalMinor }
  ]);
  assert.deepEqual({
    subtotal: calculated.body.subtotalMinor,
    tax: calculated.body.estimatedTaxMinor,
    total: calculated.body.totalMinor,
    postingMode: calculated.body.postingMode
  }, {
    subtotal: FRONTDESK_PRICING.subtotalMinor,
    tax: FRONTDESK_PRICING.taxMinor,
    total: FRONTDESK_PRICING.totalMinor,
    postingMode: "local_only"
  });
  const approved = await approveLocalBillingVersion({
    actor: billingActor(`p311-approve-${RUN_ID}`),
    billingCaseId: billingSource.rows[0].billing_case_id,
    billingVersionId: calculated.body.billingVersionId,
    expectedRevision: 2,
    reason: "Approve the synthetic P3.11 local-only case",
    idempotencyKey: identity("approve"),
    correlationId: identity("approve-correlation"),
    requestId: identity("approve-request")
  }, { transport });
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.postingMode, "local_only");
  assert.equal(approved.body.externalWork, null);
  assert.equal(transportCalls, 0);

  assert.deepEqual(await isolationSnapshot(), isolatedBefore);
  assert.deepEqual(await closedGateSnapshot(), gatesBefore);
});

test("P3.11 E2E-D: immutable completed physical loads dedupe split SO/repeated TO and conserve PO/VRMA allocation without posting", {
  timeout: 120_000
}, async () => {
  const client = await pool.connect();
  let fixture;
  try {
    fixture = await createBillingFixture(client);
  } finally {
    client.release();
  }
  const gatesBefore = await closedGateSnapshot();
  const isolatedBefore = await isolationSnapshot();
  const loadAId = `P311-MBBS-A-${RUN_ID}`;
  const loadBId = `P311-MBBS-B-${RUN_ID}`;
  const snapshots = [{
    snapshotId: crypto.randomUUID(),
    planId: `P311-MBBS-PLAN-A-${RUN_ID}`,
    planDate: "2038-06-01",
    physicalLoadId: loadAId,
    completedAt: "2038-06-01T12:00:00.000Z",
    calculatedMetres: 12_500,
    sharedTotalMinor: 1_001,
    references: [
      { sourceType: "SO", rootReference: `SO-P311-${RUN_ID}`, childReference: `SO-P311-${RUN_ID}-A` },
      { sourceType: "SO", rootReference: `SO-P311-${RUN_ID}`, childReference: `SO-P311-${RUN_ID}-B` },
      { sourceType: "TO", rootReference: `TO-P311-${RUN_ID}` },
      { sourceType: "PO", rootReference: `PO-P311-${RUN_ID}` },
      { sourceType: "VRMA", rootReference: `VRMA-P311-${RUN_ID}` }
    ]
  }, {
    snapshotId: crypto.randomUUID(),
    planId: `P311-MBBS-PLAN-B-${RUN_ID}`,
    planDate: "2038-06-02",
    physicalLoadId: loadBId,
    completedAt: "2038-06-02T12:00:00.000Z",
    calculatedMetres: 10_000,
    sharedTotalMinor: 501,
    references: [{ sourceType: "TO", rootReference: `TO-P311-${RUN_ID}` }]
  }];
  for (const item of snapshots) {
    const sourceSnapshot = {
      schemaVersion: "mbbs-completed-load-snapshot-v1",
      completed: true,
      physicalLoadId: item.physicalLoadId,
      completedAt: item.completedAt,
      evidenceIdentity: item.snapshotId
    };
    await query(
      `INSERT INTO mbt_mbbs_completed_load_snapshots (
         completed_load_snapshot_id, source_system, source_plan_id,
         source_plan_revision, plan_date, physical_load_id, completed_at,
         truck_id, driver_id, calculated_metres, shared_total_minor, currency,
         source_references, source_snapshot, source_snapshot_hash, created_by
       ) VALUES (
         $1, 'dispatch', $2, 1, $3::date, $4, $5::timestamptz,
         $6, $7, $8, $9, 'CAD', $10::jsonb, $11::jsonb, $12, $13
       )`,
      [
        item.snapshotId,
        item.planId,
        item.planDate,
        item.physicalLoadId,
        item.completedAt,
        fixture.truckId,
        fixture.driverId,
        item.calculatedMetres,
        item.sharedTotalMinor,
        JSON.stringify(item.references),
        JSON.stringify(sourceSnapshot),
        canonicalSha256(sourceSnapshot),
        ADMIN.operatorId
      ]
    );
  }
  const idempotencyKey = identity("mbbs-generate");
  const command = {
    actor: billingActor(`p311-mbbs-${RUN_ID}`),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    completedLoadSnapshotIds: snapshots.map(({ snapshotId }) => snapshotId),
    currency: "CAD",
    reason: "Generate the P3.11 immutable MBBS local shadow",
    idempotencyKey,
    correlationId: identity("mbbs-correlation"),
    requestId: identity("mbbs-request")
  };
  let transportCalls = 0;
  const dependencies = {
    transport: async () => {
      transportCalls += 1;
      throw new Error("P3.11 MBBS local shadow must never invoke transport");
    }
  };
  const generated = await generateMbbsShadowBillingFromSnapshots(command, dependencies);
  const replay = await generateMbbsShadowBillingFromSnapshots(structuredClone(command), dependencies);
  const independent = await generateMbbsShadowBillingFromSnapshots({
    ...structuredClone(command),
    idempotencyKey: identity("mbbs-generate-independent"),
    correlationId: identity("mbbs-correlation-independent"),
    requestId: identity("mbbs-request-independent")
  }, dependencies);
  assert.equal(generated.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(independent.replayed, false);
  assert.deepEqual(replay.body, generated.body);
  assert.deepEqual(independent.body, generated.body);
  const keys = generated.body.cases.map(({ deduplicationKey, allocatedAmountMinor, postingMode }) => ({
    deduplicationKey,
    allocatedAmountMinor,
    postingMode
  }));
  assert.deepEqual(keys, [
    { deduplicationKey: `SO|SO-P311-${RUN_ID}|${loadAId}`, allocatedAmountMinor: 1_001, postingMode: "local_only" },
    { deduplicationKey: `TO|TO-P311-${RUN_ID}`, allocatedAmountMinor: 1_001, postingMode: "local_only" },
    { deduplicationKey: `PO|PO-P311-${RUN_ID}|${loadAId}`, allocatedAmountMinor: 500, postingMode: "local_only" },
    { deduplicationKey: `VRMA|VRMA-P311-${RUN_ID}|${loadAId}`, allocatedAmountMinor: 501, postingMode: "local_only" }
  ]);
  assert.equal(generated.body.cases.some(({ physicalLoadId }) => physicalLoadId === loadBId), false);
  assert.equal(generated.body.allocationGroups[0].sharedTotalMinor, 1_001);
  assert.equal(generated.body.allocationGroups[0].allocations.reduce(
    (sum, { allocatedAmountMinor }) => sum + allocatedAmountMinor,
    0
  ), 1_001);
  const durable = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_cross_charge_cases
         WHERE physical_load_id = ANY($1::text[])) AS cases,
       (SELECT count(*)::int FROM mbt_billing_versions version
         JOIN mbt_billing_cases billing_case USING (billing_case_id)
        WHERE billing_case.case_type = 'mbbs_cross_charge'
          AND version.status = 'draft'
          AND version.posting_mode = 'local_only'
          AND version.billing_version_id = ANY($2::uuid[])) AS versions,
       (SELECT count(*)::int FROM mbt_billing_lines line
        WHERE line.billing_version_id = ANY($2::uuid[])) AS lines`,
    [snapshots.map(({ physicalLoadId }) => physicalLoadId), generated.body.cases.map(({ billingVersionId }) => billingVersionId)]
  );
  assert.deepEqual(durable.rows[0], { cases: 4, versions: 4, lines: 4 });
  assert.equal(transportCalls, 0);
  assert.deepEqual(await isolationSnapshot(), isolatedBefore);
  assert.deepEqual(await closedGateSnapshot(), gatesBefore);
});
