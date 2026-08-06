// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { compareDriverPwaVersions } from "../driver-client-version.js";
import { recordDriverJobPhotos, startDriverJob } from "../driver-repository.js";
import { recordAssetMovement } from "./asset-service.js";
import {
  hashMbtDriverCanonical,
  MBT_DRIVER_BIN_JOB_SCHEMA,
  normalizeMbtDriverEventDetails
} from "./driver-bin-contract.js";
import { MbtError } from "./errors.js";

const ambientDatabase = /** @type {any} */ ({ query, ambientTransaction: true });
const MAX_DEVICE_CLOCK_AHEAD_MS = 5 * 60 * 1000;

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function failure(status, code, message, details = {}) {
  return new MbtError({ status, code, message, details });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {throw failure(400, "MBT_DRIVER_BIN_INPUT_INVALID", `A ${label} is required.`);}
  return normalized;
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw failure(400, "MBT_DRIVER_BIN_INPUT_INVALID", `The ${label} is invalid.`);
  }
  return date;
}

/** @param {unknown} value */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function nullableString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/** @param {unknown[]} values */
function firstText(...values) {
  for (const value of values) {
    const normalized = nullableString(value);
    if (normalized !== null) {
      return normalized;
    }
  }
  return "";
}

/** @param {unknown} value @param {unknown} fallback */
function valueOrFallback(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

/** @param {unknown} capability */
function assertCapability(capability) {
  const value = objectValue(capability);
  if (value.issuedManifestAuthorized === true) {return;}
  if (value.environmentEnabled === true && value.databaseEnabled === true && value.pilotAuthorized === true) {return;}
  throw failure(409, "MBT_CAPABILITY_DISABLED", "MBT Driver BIN execution is disabled.", {
    capability: "driver_execution"
  });
}

/** @param {unknown} value */
function isBinJob(value) {
  return objectValue(value).schemaVersion === MBT_DRIVER_BIN_JOB_SCHEMA;
}

/** @param {string[]} ids */
async function assetIdentities(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) {return new Map();}
  const result = await query(
    `SELECT asset.asset_id::text, asset.asset_code, asset.qr_code,
            asset.bin_type_id::text, type.type_code AS bin_type_code,
            state.lifecycle_status, state.location_kind,
            state.location_reference, state.revision::int AS state_revision
       FROM mbt_bin_assets asset
       JOIN mbt_bin_types type ON type.bin_type_id = asset.bin_type_id
       JOIN mbt_bin_asset_state state ON state.asset_id = asset.asset_id
      WHERE asset.asset_id = ANY($1::uuid[])
      ORDER BY asset.asset_id`,
    [unique]
  );
  return new Map(result.rows.map((/** @type {Record<string, any>} */ row) => [String(row.asset_id), {
    assetId: String(row.asset_id),
    assetCode: String(row.asset_code),
    qrCode: String(row.qr_code || ""),
    binTypeId: String(row.bin_type_id),
    binTypeCode: String(row.bin_type_code),
    lifecycleStatus: String(row.lifecycle_status),
    locationKind: String(row.location_kind),
    locationReference: String(row.location_reference || ""),
    stateRevision: Number(row.state_revision)
  }]));
}

/** @param {string} visitId @param {boolean} [forUpdate] */
async function visitExecutionRows(visitId, forUpdate = false) {
  const visitResult = await query(
    `SELECT visit.service_visit_id::text, visit.contract_id::text,
            visit.visit_number::int, visit.visit_reference, visit.service_action,
            visit.status, visit.revision::int, visit.customer_site_profile_id::text,
            visit.service_template_version_id::text, template.revision::int AS template_revision,
            visit.bin_type_id::text, type.type_code AS bin_type_code,
            visit.expected_asset_id::text, visit.outgoing_asset_id::text,
            visit.incoming_asset_id::text, visit.dump_site_id::text,
            visit.material_id::text, visit.planned_truck_id::text,
            visit.planned_driver_id::text, visit.dispatch_plan_id,
            visit.dispatch_plan_revision::int, visit.dispatch_load_id,
            visit.dispatch_assignment_snapshot, visit.service_snapshot,
            visit.customer_snapshot, visit.site_snapshot,
            visit.actual_started_at, visit.actual_completed_at,
            contract.contract_number,
            assigned_driver.login AS planned_driver_login,
            assigned_truck.plate AS planned_truck_plate,
            dump.dump_site_code, dump.display_name AS dump_site_name,
            dump.address_line_1 AS dump_address_line_1,
            dump.address_line_2 AS dump_address_line_2,
            dump.city AS dump_city, dump.region AS dump_region,
            dump.postal_code AS dump_postal_code,
            material.material_code, material.display_name AS material_name,
            material.description AS material_description
       FROM mbt_service_visits visit
       JOIN mbt_contracts contract ON contract.contract_id = visit.contract_id
       JOIN mbt_service_template_versions template
         ON template.template_version_id = visit.service_template_version_id
       JOIN mbt_bin_types type ON type.bin_type_id = visit.bin_type_id
       LEFT JOIN dispatch_drivers assigned_driver ON assigned_driver.id = visit.planned_driver_id
       LEFT JOIN dispatch_trucks assigned_truck ON assigned_truck.id = visit.planned_truck_id
       LEFT JOIN mbt_dump_sites dump ON dump.dump_site_id = visit.dump_site_id
       LEFT JOIN mbt_materials material ON material.material_id = visit.material_id
      WHERE visit.service_visit_id = $1
      ${forUpdate ? "FOR UPDATE OF visit" : ""}`,
    [visitId]
  );
  if (!visitResult.rowCount) {
    throw failure(404, "MBT_DRIVER_BIN_VISIT_NOT_FOUND", "The BIN service visit was not found.");
  }
  const steps = await query(
    `SELECT step.visit_step_id::text, step.sequence_number::int, step.action_code,
            step.display_name, step.location_role, step.status,
            step.required, step.completion_blocking, step.expected_asset_id::text,
            step.verified_asset_id::text, step.started_at, step.completed_at,
            template_step.required_asset_status_before,
            template_step.required_asset_status_after
       FROM mbt_visit_steps step
       LEFT JOIN mbt_service_template_steps template_step
         ON template_step.template_step_id = step.template_step_id
      WHERE step.service_visit_id = $1
      ORDER BY step.sequence_number, step.visit_step_id
      ${forUpdate ? "FOR UPDATE OF step" : ""}`,
    [visitId]
  );
  const evidence = await query(
    `SELECT requirement.visit_evidence_requirement_id::text,
            requirement.visit_step_id::text, requirement.evidence_code,
            requirement.evidence_type, requirement.minimum_count::int,
            requirement.required, requirement.status
       FROM mbt_visit_evidence_requirements requirement
      WHERE requirement.service_visit_id = $1
      ORDER BY requirement.visit_step_id, requirement.evidence_code
      ${forUpdate ? "FOR UPDATE OF requirement" : ""}`,
    [visitId]
  );
  return { visit: visitResult.rows[0], steps: steps.rows, evidence: evidence.rows };
}

/** @param {Record<string, any>} visit */
function executionIdentity(visit) {
  return {
    contractId: String(visit.contract_id),
    visitId: String(visit.service_visit_id),
    visitNumber: Number(visit.visit_number),
    visitReference: String(visit.visit_reference),
    serviceAction: String(visit.service_action),
    serviceTemplateVersionId: String(visit.service_template_version_id),
    templateRevision: Number(visit.template_revision),
    binTypeId: String(visit.bin_type_id),
    expectedAssetId: nullableString(visit.expected_asset_id),
    outgoingAssetId: nullableString(visit.outgoing_asset_id),
    incomingAssetId: nullableString(visit.incoming_asset_id),
    dumpSiteId: nullableString(visit.dump_site_id),
    materialId: nullableString(visit.material_id),
    customerSiteProfileId: String(visit.customer_site_profile_id),
    plannedTruckId: nullableString(visit.planned_truck_id),
    plannedDriverId: nullableString(visit.planned_driver_id),
    dispatchPlanId: nullableString(visit.dispatch_plan_id),
    dispatchLoadId: nullableString(visit.dispatch_load_id),
    dispatchAssignmentSnapshot: objectValue(visit.dispatch_assignment_snapshot),
    serviceSnapshot: objectValue(visit.service_snapshot)
  };
}

/** @param {Record<string, any>} visit */
function exactAssetIds(visit) {
  const expected = nullableString(visit.expected_asset_id);
  const outgoing = nullableString(visit.outgoing_asset_id) || expected;
  const incoming = nullableString(visit.incoming_asset_id);
  return { expected, outgoing, incoming };
}

/** @param {Record<string, any>} baseJob @param {Record<string, any>} visit @param {Record<string, any>[]} steps */
function actionForBaseJob(baseJob, visit, steps) {
  const stopId = String(baseJob.stopId || "");
  const stop = arrayValue(objectValue(visit.dispatch_assignment_snapshot).stops)
    .map(objectValue)
    .find((candidate) => String(candidate.id || "") === stopId);
  const actionCode = String(
    objectValue(baseJob.mbtDispatchStop).actionCode
    || stop?.actionCode
    || objectValue(baseJob.mbt).actionCode
    || ""
  );
  const step = steps.find((candidate) => String(candidate.action_code) === actionCode);
  if (!actionCode || !step) {
    throw failure(409, "MBT_DRIVER_BIN_SNAPSHOT_INVALID", "The Driver stop does not match a frozen BIN visit step.");
  }
  return { actionCode, step, stop: stop || objectValue(baseJob.mbtDispatchStop) };
}

/** @param {Map<string, Record<string, any>>} assets @param {string | null} assetId */
function assetOrNull(assets, assetId) {
  if (!assetId) {return null;}
  const asset = assets.get(assetId);
  if (!asset) {throw failure(409, "MBT_DRIVER_BIN_SNAPSHOT_INVALID", "A frozen BIN asset is unavailable.");}
  return asset;
}

/** @param {unknown[]} parts */
function joinedAddress(parts) {
  return parts.map((part) => String(part ?? "").trim()).filter(Boolean).join(", ");
}

/** @param {Record<string, any>} baseJob @param {Record<string, any>} visit */
function assertAssignedDriverJob(baseJob, visit) {
  const assigned = JSON.stringify([
    firstText(baseJob.driverLogin).toLowerCase(),
    firstText(baseJob.truckId),
    firstText(baseJob.planId),
    firstText(baseJob.loadId)
  ]);
  const current = JSON.stringify([
    firstText(visit.planned_driver_login).toLowerCase(),
    firstText(visit.planned_truck_id),
    firstText(visit.dispatch_plan_id),
    firstText(visit.dispatch_load_id)
  ]);
  if (assigned !== current) {
    throw failure(403, "MBT_DRIVER_BIN_ASSIGNMENT_MISMATCH", "The BIN visit is not assigned to this exact Driver route.");
  }
}

/** @param {{clientVersion: string, minimumClientVersion: string}} versions */
function requiredClientBoundary(versions) {
  const source = objectValue(versions);
  const minimumClientVersion = requiredText(source.minimumClientVersion, "minimum Driver PWA version");
  const clientVersion = requiredText(source.clientVersion, "Driver PWA version");
  const comparison = compareDriverPwaVersions(clientVersion, minimumClientVersion);
  if (comparison === null || comparison < 0) {
    throw failure(426, "DRIVER_PWA_UPDATE_REQUIRED", "Close and reopen the Driver PWA before starting BIN work.", {
      clientVersion,
      minimumClientVersion,
      preserveLocalEvidence: true
    });
  }
  return minimumClientVersion;
}

/** @param {Record<string, any>[]} evidence @param {Record<string, any>} step */
function evidenceRequirementsForStep(evidence, step) {
  return evidence
    .filter((row) => !row.visit_step_id || String(row.visit_step_id) === String(step.visit_step_id))
    .map((row) => ({
      requirementId: String(row.visit_evidence_requirement_id),
      evidenceCode: String(row.evidence_code),
      evidenceType: String(row.evidence_type),
      minimumCount: Number(row.minimum_count),
      required: row.required === true
    }));
}

/** @param {Array<Record<string, any>>} requirements */
function requiredPhotoCount(requirements) {
  return requirements
    .filter((requirement) => (
      requirement.required
      && ["photo", "signature"].includes(requirement.evidenceType)
    ))
    .reduce((sum, requirement) => sum + requirement.minimumCount, 0);
}

/** @param {Record<string, any>} visit */
function dumpAddressForVisit(visit) {
  return joinedAddress([
    visit.dump_address_line_1,
    visit.dump_address_line_2,
    visit.dump_city,
    visit.dump_region,
    visit.dump_postal_code
  ]);
}

/** @param {Record<string, any>} visit */
function siteAddressForVisit(visit) {
  const site = objectValue(visit.site_snapshot);
  return joinedAddress([
    firstText(site.addressLine1, site.address_line_1),
    firstText(site.addressLine2, site.address_line_2),
    site.city,
    firstText(site.province, site.region),
    firstText(site.postalCode, site.postal_code)
  ]);
}

/**
 * @param {Record<string, any>} baseJob
 * @param {Record<string, any>} visit
 * @param {Record<string, any>} step
 * @param {Record<string, any>} stop
 */
function operationalPresentation(baseJob, visit, step, stop) {
  const locationRole = firstText(step.location_role, stop.locationRole);
  let location = firstText(stop.yardCode, baseJob.location);
  let address = firstText(baseJob.address, location);
  if (locationRole === "dump_site") {
    location = firstText(visit.dump_site_name, visit.dump_site_code, baseJob.location);
    address = firstText(dumpAddressForVisit(visit), location);
  }
  if (locationRole === "customer_site") {
    const site = objectValue(visit.site_snapshot);
    location = firstText(site.displayName, site.siteName, baseJob.location);
    address = firstText(siteAddressForVisit(visit), location);
  }
  return { location, address };
}

/** @param {Record<string, any>} baseJob @param {{location: string, address: string}} presentation */
function stopPresentation(baseJob, presentation) {
  const result = { pickupLocation: "", dropLocation: "", dropAddress: "" };
  if (baseJob.stopType === "pickup") {
    result.pickupLocation = presentation.location;
  }
  if (baseJob.stopType === "dropoff") {
    result.dropLocation = presentation.location;
    result.dropAddress = presentation.address;
  }
  return result;
}

/** @param {Record<string, any>} visit @param {string} address */
function dumpSiteSnapshot(visit, address) {
  const dumpSiteId = nullableString(visit.dump_site_id);
  if (dumpSiteId === null) {
    return null;
  }
  return {
    dumpSiteId,
    code: firstText(visit.dump_site_code),
    displayName: firstText(visit.dump_site_name),
    address
  };
}

/** @param {Record<string, any>} visit */
function materialSnapshot(visit) {
  const materialId = nullableString(visit.material_id);
  if (materialId === null) {
    return null;
  }
  return {
    materialId,
    code: firstText(visit.material_code),
    displayName: firstText(visit.material_name),
    description: firstText(visit.material_description)
  };
}

/** @param {Record<string, any>} stop @param {Record<string, any>} baseJob */
function capabilitySnapshot(stop, baseJob) {
  const stopCapability = objectValue(objectValue(stop).mbt).capabilitySnapshot;
  if (stopCapability !== undefined && stopCapability !== null) {
    return stopCapability;
  }
  return objectValue(objectValue(baseJob.mbt).capabilitySnapshot);
}

/**
 * @param {{
 *   baseJob: Record<string, any>,
 *   visit: Record<string, any>,
 *   step: Record<string, any>,
 *   stop: Record<string, any>,
 *   ids: Record<string, any>,
 *   assets: Map<string, Record<string, any>>,
 *   requirements: Array<Record<string, any>>,
 *   actionCode: string,
 *   minimumClientVersion: string
 * }} input
 */
function materializedMbtSnapshot(input) {
  const {
    baseJob,
    visit,
    step,
    stop,
    ids,
    assets,
    requirements,
    actionCode,
    minimumClientVersion
  } = input;
  const baseMbt = objectValue(baseJob.mbt);
  const assignmentSnapshot = objectValue(visit.dispatch_assignment_snapshot);
  return {
    schemaVersion: MBT_DRIVER_BIN_JOB_SCHEMA,
    minimumClientVersion,
    contractId: String(visit.contract_id),
    contractNumber: String(visit.contract_number),
    visitId: String(visit.service_visit_id),
    visitReference: String(visit.visit_reference),
    visitNumber: Number(visit.visit_number),
    issuedVisitRevision: Number(valueOrFallback(assignmentSnapshot.visitRevision, visit.revision)),
    serviceAction: String(visit.service_action),
    actionCode,
    visitStepId: String(step.visit_step_id),
    stepSequence: Number(step.sequence_number),
    stopGroupId: firstText(baseMbt.stopGroupId, visit.service_visit_id),
    stopSequence: Number(valueOrFallback(baseMbt.stopSequence, step.sequence_number)),
    mandatory: true,
    serviceTemplateVersionId: String(visit.service_template_version_id),
    templateRevision: Number(visit.template_revision),
    binTypeId: String(visit.bin_type_id),
    binTypeCode: String(visit.bin_type_code),
    exactAssets: {
      expected: assetOrNull(assets, ids.expected),
      outgoing: assetOrNull(assets, ids.outgoing),
      incoming: assetOrNull(assets, ids.incoming)
    },
    dumpSiteId: nullableString(visit.dump_site_id),
    materialId: nullableString(visit.material_id),
    dumpSite: dumpSiteSnapshot(visit, dumpAddressForVisit(visit)),
    material: materialSnapshot(visit),
    customerSiteProfileId: String(visit.customer_site_profile_id),
    customer: objectValue(visit.customer_snapshot),
    site: objectValue(visit.site_snapshot),
    evidenceRequirements: requirements,
    movementExpectation: {
      beforeStatus: nullableString(step.required_asset_status_before),
      afterStatus: nullableString(step.required_asset_status_after)
    },
    capabilitySnapshot: capabilitySnapshot(stop, baseJob),
    assignment: {
      planId: nullableString(visit.dispatch_plan_id),
      planRevision: Number(valueOrFallback(visit.dispatch_plan_revision, 0)),
      loadId: nullableString(visit.dispatch_load_id),
      truckId: nullableString(visit.planned_truck_id),
      driverId: nullableString(visit.planned_driver_id)
    },
    executionSnapshotHash: hashMbtDriverCanonical(executionIdentity(visit))
  };
}

/**
 * Enrich one persisted mandatory Dispatch stop with the complete immutable BIN
 * data required for local-first Driver execution.
 *
 * @param {Record<string, any>} baseJob
 * @param {{clientVersion: string, minimumClientVersion: string}} versions
 */
export async function materializeMbtDriverBinJob(baseJob, versions) {
  const visitId = requiredText(objectValue(baseJob.mbt).visitId, "BIN visit ID");
  const minimumClientVersion = requiredClientBoundary(versions);
  const { visit, steps, evidence } = await visitExecutionRows(visitId);
  assertAssignedDriverJob(baseJob, visit);
  const { actionCode, step, stop } = actionForBaseJob(baseJob, visit, steps);
  const ids = exactAssetIds(visit);
  const assets = await assetIdentities(/** @type {string[]} */ (Object.values(ids).filter(Boolean)));
  const requirements = evidenceRequirementsForStep(evidence, step);
  const presentation = operationalPresentation(baseJob, visit, step, stop);
  return {
    ...baseJob,
    location: presentation.location,
    address: presentation.address,
    ...stopPresentation(baseJob, presentation),
    orderRefs: [],
    orderTypes: ["BIN"],
    orders: [],
    requiredPhotos: requiredPhotoCount(requirements),
    mbt: materializedMbtSnapshot({
      baseJob,
      visit,
      step,
      stop,
      ids,
      assets,
      requirements,
      actionCode,
      minimumClientVersion
    })
  };
}

/** @param {Record<string, any>} event @param {Record<string, any>} job */
function normalizedApplication(event, job) {
  const occurredAt = timestamp(event.occurredAt, "device occurrence time");
  const receivedAt = timestamp(event.receivedAt || new Date(), "server receipt time");
  if (occurredAt.getTime() - receivedAt.getTime() > MAX_DEVICE_CLOCK_AHEAD_MS) {
    throw failure(400, "MBT_DRIVER_BIN_INPUT_INVALID", "The device occurrence time is implausibly far ahead of server receipt time.");
  }
  const details = event.eventType === "job_completed"
    ? normalizeMbtDriverEventDetails(objectValue(event.details).mbt)
    : null;
  const immutable = {
    eventId: requiredText(event.eventId, "event ID"),
    eventType: requiredText(event.eventType, "event type"),
    driverLogin: requiredText(event.driverLogin, "driver login").toLowerCase(),
    deviceId: requiredText(event.deviceId, "device ID"),
    manifestId: requiredText(event.manifestId, "manifest ID"),
    clientSequence: Number(event.clientSequence),
    jobId: requiredText(event.jobId || job.jobId, "job ID"),
    occurredAt: occurredAt.toISOString(),
    details,
    photos: arrayValue(event.photos).map((/** @type {Record<string, any>} */ photo) => ({
      photoId: String(photo.photoId || ""),
      ordinal: Number(photo.ordinal),
      objectReference: String(photo.objectReference || ""),
      sha256: String(photo.sha256 || ""),
      byteSize: Number(photo.byteSize || 0),
      mimeType: String(photo.mimeType || "")
    })).sort((left, right) => left.ordinal - right.ordinal)
  };
  if (!Number.isSafeInteger(immutable.clientSequence) || immutable.clientSequence < 1) {
    throw failure(400, "MBT_DRIVER_BIN_INPUT_INVALID", "A positive client sequence is required.");
  }
  return {
    ...immutable,
    occurredAt,
    receivedAt,
    details,
    immutablePayloadHash: hashMbtDriverCanonical(immutable)
  };
}

/** @param {Record<string, any>} application */
function replayResult(application) {
  return {
    replayed: true,
    body: objectValue(application.application_result)
  };
}

/** @param {Record<string, any>} normalized */
async function existingApplication(normalized) {
  const selected = await query(
    `SELECT * FROM mbt_driver_bin_event_applications
      WHERE source_event_id = $1::uuid
         OR (job_id = $2 AND event_type = $3)
      ORDER BY application_id
      FOR UPDATE`,
    [normalized.eventId, normalized.jobId, normalized.eventType]
  );
  if (!selected.rowCount) {return null;}
  const exact = selected.rows.find((/** @type {Record<string, any>} */ row) => String(row.source_event_id) === normalized.eventId);
  if (exact && exact.immutable_payload_hash === normalized.immutablePayloadHash) {return replayResult(exact);}
  if (exact) {
    throw failure(409, "MBT_DRIVER_BIN_EVENT_IDEMPOTENCY_CONFLICT", "The BIN event ID was reused with different evidence.");
  }
  throw failure(409, "MBT_DRIVER_BIN_JOB_ALREADY_APPLIED", "Another event already applied this physical BIN job action.", {
    existingEventId: String(selected.rows[0].source_event_id)
  });
}

/**
 * Serialize attempts for the same physical Driver BIN action before querying
 * its durable idempotency row. PostgreSQL advisory transaction locks avoid the
 * unique-constraint race where two independent offline-sync transactions both
 * observe an empty ledger and then try to persist the same evidence.
 * @param {Record<string, any>} normalized
 */
async function lockApplicationIdentity(normalized) {
  await query(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    [normalized.jobId, normalized.eventType]
  );
}

/** @param {Record<string, any>} job @param {Record<string, any>} visit */
function assertExecutionSnapshot(job, visit) {
  const mbt = objectValue(job.mbt);
  if (!isBinJob(mbt)) {
    throw failure(409, "MBT_DRIVER_BIN_SNAPSHOT_INVALID", "A versioned BIN Driver job is required.");
  }
  const currentHash = hashMbtDriverCanonical(executionIdentity(visit));
  if (String(mbt.executionSnapshotHash || "") !== currentHash) {
    throw failure(409, "MBT_DRIVER_BIN_REVIEW_REQUIRED", "The BIN visit, asset, template, or assignment changed after this route was saved.", {
      eventId: "",
      issuedSnapshotHash: String(mbt.executionSnapshotHash || ""),
      currentSnapshotHash: currentHash
    });
  }
  if (String(mbt.visitId) !== String(visit.service_visit_id)) {
    throw failure(409, "MBT_DRIVER_BIN_REVIEW_REQUIRED", "The saved BIN visit identity no longer matches.");
  }
}

/** @param {Record<string, any>} normalized @param {Record<string, any>} job @param {Record<string, any>} visit @param {Record<string, any>} step @param {Record<string, any>} body */
async function insertApplication(normalized, job, visit, step, body) {
  const appliedAt = new Date(Math.max(Date.now(), normalized.receivedAt.getTime()));
  const inserted = await query(
    `INSERT INTO mbt_driver_bin_event_applications (
       application_id, source_event_id, manifest_id, client_sequence,
       event_type, driver_login, device_id, job_id, service_visit_id,
       visit_step_id, action_code, execution_snapshot_hash,
       immutable_payload_hash, device_occurred_at, server_received_at,
       server_applied_at, application_result
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17::jsonb
     )
     RETURNING application_result`,
    [
      crypto.randomUUID(), normalized.eventId, normalized.manifestId,
      normalized.clientSequence, normalized.eventType, normalized.driverLogin,
      normalized.deviceId, normalized.jobId, visit.service_visit_id,
      step.visit_step_id, step.action_code,
      String(objectValue(job.mbt).executionSnapshotHash),
      normalized.immutablePayloadHash, normalized.occurredAt,
      normalized.receivedAt, appliedAt, JSON.stringify(body)
    ]
  );
  return objectValue(inserted.rows[0]?.application_result);
}

/** @param {Record<string, any>} rows @param {Record<string, any>} job */
function currentStep(rows, job) {
  const stepId = String(objectValue(job.mbt).visitStepId || "");
  const step = rows.steps.find((/** @type {Record<string, any>} */ candidate) => String(candidate.visit_step_id) === stepId);
  if (!step || String(step.action_code) !== String(objectValue(job.mbt).actionCode)) {
    throw failure(409, "MBT_DRIVER_BIN_REVIEW_REQUIRED", "The saved BIN step no longer matches this visit.");
  }
  return step;
}

/**
 * A versioned Driver job represents one physical step, not permission to skip
 * over earlier work from the same visit.  Keep this check inside the locked
 * transaction so two devices cannot race adjacent steps.
 * @param {Record<string, any>} rows
 * @param {Record<string, any>} step
 */
function assertPriorStepsComplete(rows, step) {
  const blocked = rows.steps.find((/** @type {Record<string, any>} */ candidate) => (
    Number(candidate.sequence_number) < Number(step.sequence_number)
    && candidate.required === true
    && candidate.completion_blocking === true
    && !["completed", "skipped"].includes(String(candidate.status))
  ));
  if (blocked) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_STEP_OUT_OF_ORDER",
      "Complete the earlier BIN stop before this action.",
      {
        blockedVisitStepId: String(blocked.visit_step_id),
        blockedActionCode: String(blocked.action_code)
      }
    );
  }
}

/**
 * Only a complete persisted day manifest is authoritative for whole-route and
 * device-time ordering. Deliberately keep partial bootstrap manifests and the
 * established direct-domain boundary outside these additional recovery guards.
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} normalized
 */
function completeManifestContext(manifest, normalized) {
  if (manifest?.complete !== true) {return null;}
  const jobs = arrayValue(manifest.jobs)
    .map((job, index) => ({
      job: objectValue(job),
      sequenceIndex: Number.isSafeInteger(Number(objectValue(job).sequenceIndex))
        ? Number(objectValue(job).sequenceIndex)
        : index
    }))
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  const currentIndex = jobs.findIndex(({ job }) => String(job.jobId || "") === normalized.jobId);
  if (!jobs.length || currentIndex < 0 || !nullableString(manifest.manifestId)) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_MANIFEST_INVALID",
      "The complete offline route does not contain this BIN job. Reopen the Driver PWA."
    );
  }
  let generatedAt;
  try {
    generatedAt = timestamp(manifest.generatedAt, "manifest generation time");
  } catch {
    throw failure(
      409,
      "MBT_DRIVER_BIN_MANIFEST_INVALID",
      "The complete offline route has no valid generation time. Reopen the Driver PWA."
    );
  }
  return { jobs, currentIndex, generatedAt, manifestId: String(manifest.manifestId) };
}

/**
 * Serialize different jobs from one issued route, then prove every earlier job
 * has its durable completion record for this Driver. The outer offline queue
 * already has a driver/day lock; this makes the domain boundary safe when it is
 * invoked independently as well.
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} normalized
 */
async function assertCompleteManifestRoute(manifest, normalized) {
  const context = completeManifestContext(manifest, normalized);
  if (!context) {return null;}
  await query(
    "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))",
    [context.manifestId, normalized.driverLogin]
  );
  const earlier = context.jobs.slice(0, context.currentIndex);
  const jobIds = earlier.map(({ job }) => String(job.jobId || "")).filter(Boolean);
  const completed = new Set();
  if (jobIds.length) {
    const records = await query(
      `SELECT job_id
         FROM driver_job_records
        WHERE job_id = ANY($1::text[])
          AND lower(driver_login) = $2
          AND status = 'complete'
        ORDER BY job_id
        FOR UPDATE`,
      [jobIds, normalized.driverLogin]
    );
    for (const row of records.rows) {completed.add(String(row.job_id));}
  }
  const blocked = earlier.find(({ job }) => !completed.has(String(job.jobId || "")));
  if (blocked) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_ROUTE_OUT_OF_ORDER",
      "Complete the earlier route job before this BIN action.",
      {
        blockedJobId: String(blocked.job.jobId || ""),
        blockedSequenceIndex: blocked.sequenceIndex,
        targetJobId: normalized.jobId
      }
    );
  }
  return context;
}

/** @param {Record<string, any>} job */
function exactJobAssetIds(job) {
  const assets = objectValue(objectValue(job.mbt).exactAssets);
  return [...new Set(["expected", "outgoing", "incoming"]
    .map((role) => nullableString(objectValue(assets[role]).assetId))
    .filter(Boolean))];
}

/**
 * Lock every exact asset in stable UUID order. Asset movements use the same
 * state-row lock, so validation and append cannot be separated by another
 * device or operator transition.
 * @param {Record<string, any>} job
 */
async function lockExactAssetStates(job) {
  const assetIds = exactJobAssetIds(job);
  if (!assetIds.length) {return new Map();}
  const result = await query(
    `SELECT state.asset_id::text, state.lifecycle_status, state.location_kind,
            state.location_reference, state.yard_id::text,
            state.customer_site_profile_id::text, state.dump_site_id::text,
            state.truck_id::text, state.revision::int, state.changed_at
       FROM mbt_bin_asset_state state
      WHERE state.asset_id = ANY($1::uuid[])
      ORDER BY state.asset_id
      FOR UPDATE`,
    [assetIds]
  );
  if (result.rowCount !== assetIds.length) {
    throw failure(409, "MBT_DRIVER_BIN_ASSET_MISMATCH", "A frozen BIN asset is unavailable.");
  }
  return new Map(result.rows.map(
    (/** @type {Record<string, any>} */ row) => [String(row.asset_id), row]
  ));
}

/**
 * A complete manifest is a time boundary. Never append an older occurrence on
 * top of a newer locked asset state because that would regress changed_at while
 * leaving the immutable movement sequence in receipt order.
 * @param {Record<string, any> | null} manifestContext
 * @param {Record<string, any>} normalized
 * @param {Map<string, Record<string, any>>} lockedStates
 */
function assertCompleteManifestChronology(manifestContext, normalized, lockedStates) {
  if (!manifestContext) {return;}
  if (normalized.occurredAt < manifestContext.generatedAt) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_EVENT_BEFORE_MANIFEST",
      "This BIN action predates the downloaded route and requires Dispatch review.",
      {
        occurredAt: normalized.occurredAt.toISOString(),
        manifestGeneratedAt: manifestContext.generatedAt.toISOString()
      }
    );
  }
  const newer = [...lockedStates.values()].find((state) => (
    timestamp(state.changed_at, "asset state change time") > normalized.occurredAt
  ));
  if (newer) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_ASSET_TIME_CONFLICT",
      "The BIN asset changed after this device action and requires Dispatch review.",
      {
        assetId: String(newer.asset_id),
        occurredAt: normalized.occurredAt.toISOString(),
        assetChangedAt: timestamp(newer.changed_at, "asset state change time").toISOString()
      }
    );
  }
}

/**
 * A completion may not manufacture its own started_at. Require both ledgers
 * written by the versioned BIN start application before accepting evidence.
 * @param {Record<string, any> | null} manifestContext
 * @param {Record<string, any>} normalized
 */
async function assertDurableBinStart(manifestContext, normalized) {
  if (!manifestContext) {return;}
  const started = await query(
    `SELECT application.application_id
       FROM mbt_driver_bin_event_applications application
       JOIN driver_job_records driver_record
         ON driver_record.job_id = application.job_id
        AND lower(driver_record.driver_login) = application.driver_login
      WHERE application.job_id = $1
        AND application.event_type = 'job_started'
        AND application.driver_login = $2
        AND driver_record.started_at IS NOT NULL
        AND driver_record.status = 'in_progress'
      ORDER BY application.server_applied_at DESC, application.application_id
      LIMIT 1
      FOR UPDATE OF application, driver_record`,
    [normalized.jobId, normalized.driverLogin]
  );
  if (!started.rowCount) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_START_REQUIRED",
      "Start this BIN stop before completing it."
    );
  }
}

/** @param {unknown} error @param {string} eventId */
function withEventIdentity(error, eventId) {
  if (error instanceof MbtError && error.code === "MBT_DRIVER_BIN_REVIEW_REQUIRED") {
    error.details = { ...objectValue(error.details), eventId };
  }
  return error;
}

/**
 * Production offline application always has a registered source row. Direct
 * domain tests deliberately exercise the orchestrator without fabricating the
 * surrounding queue; in that case the dedicated application ledger remains
 * the timestamp authority and the legacy Driver FK is left unset.
 * @param {Record<string, any>} normalized
 */
async function registeredOfflineTrace(normalized) {
  const registered = await query(
    "SELECT 1 FROM driver_offline_events WHERE event_id = $1::uuid LIMIT 1",
    [normalized.eventId]
  );
  return registered.rowCount ? {
    eventId: normalized.eventId,
    occurredAt: normalized.occurredAt,
    receivedAt: normalized.receivedAt,
    locationStatus: "not_checked_offline",
    locationDetails: { source: "mbt_driver_bin" }
  } : null;
}

/**
 * Apply a BIN job start without invoking Samsara or any ordinary-order path.
 * @param {{event: Record<string, any>, job: Record<string, any>, manifest: Record<string, any>}} input
 * @param {{capability: unknown}} boundary
 */
export async function startMbtDriverBinJob(input, { capability }) {
  assertCapability(capability);
  const normalized = normalizedApplication(input.event, input.job);
  if (normalized.eventType !== "job_started") {
    throw failure(400, "MBT_DRIVER_BIN_INPUT_INVALID", "A BIN job-start event is required.");
  }
  return withTransaction(async () => {
    await lockApplicationIdentity(normalized);
    const replay = await existingApplication(normalized);
    if (replay) {return replay;}
    const manifestContext = await assertCompleteManifestRoute(input.manifest, normalized);
    const rows = await visitExecutionRows(String(objectValue(input.job.mbt).visitId), true);
    try {
      assertExecutionSnapshot(input.job, rows.visit);
    } catch (error) {
      throw withEventIdentity(error, normalized.eventId);
    }
    const step = currentStep(rows, input.job);
    assertPriorStepsComplete(rows, step);
    if (manifestContext) {
      const lockedStates = await lockExactAssetStates(input.job);
      assertCompleteManifestChronology(manifestContext, normalized, lockedStates);
    }
    if (!["planned", "in_progress", "evidence_pending"].includes(String(rows.visit.status))) {
      throw failure(409, "MBT_DRIVER_BIN_REVIEW_REQUIRED", "The BIN visit is no longer startable.", {
        eventId: normalized.eventId
      });
    }
    await startDriverJob(normalized.driverLogin, normalized.jobId, /** @type {any} */ ({
      job: input.job,
      occurredAt: normalized.occurredAt,
      offlineTrace: await registeredOfflineTrace(normalized)
    }));
    await query(
      `UPDATE mbt_visit_steps
          SET status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
              started_at = COALESCE(started_at, $2), revision = revision + 1,
              updated_at = now()
        WHERE visit_step_id = $1`,
      [step.visit_step_id, normalized.occurredAt]
    );
    await query(
      `UPDATE mbt_service_visits
          SET status = CASE WHEN status = 'planned' THEN 'in_progress' ELSE status END,
              actual_started_at = COALESCE(actual_started_at, $2),
              revision = revision + 1, updated_by = $3, updated_at = now()
        WHERE service_visit_id = $1`,
      [rows.visit.service_visit_id, normalized.occurredAt, `driver:${normalized.driverLogin}`]
    );
    const body = {
      schemaVersion: "mbt-driver-bin-application-v1",
      eventId: normalized.eventId,
      eventType: normalized.eventType,
      jobId: normalized.jobId,
      visitId: String(rows.visit.service_visit_id),
      visitStepId: String(step.visit_step_id),
      status: "in_progress",
      occurredAt: normalized.occurredAt.toISOString()
    };
    const persistedBody = await insertApplication(normalized, input.job, rows.visit, step, body);
    return { replayed: false, body: persistedBody };
  });
}

/** @param {Record<string, any>} job @param {string} role */
function assetForRole(job, role) {
  return objectValue(objectValue(job.mbt).exactAssets)[role] || null;
}

/** @param {Record<string, any>} scan @param {Record<string, any>} expected */
function assertScanMatches(scan, expected) {
  const value = String(scan.scannedValue || "").trim().toUpperCase();
  const accepted = new Set([
    String(expected.assetCode || "").trim().toUpperCase(),
    String(expected.qrCode || "").trim().toUpperCase()
  ].filter(Boolean));
  if (String(scan.assetId) !== String(expected.assetId) || !accepted.has(value)) {
    throw failure(409, "MBT_DRIVER_BIN_ASSET_MISMATCH", "The scanned BIN does not match the frozen visit asset.", {
      assetRole: scan.assetRole,
      expectedAssetId: expected.assetId
    });
  }
}

/** @param {Record<string, any>} requirement */
function roleForRequirement(requirement) {
  const code = String(requirement.evidence_code || "");
  if (code.includes("incoming")) {return "incoming";}
  if (code.includes("outgoing")) {return "outgoing";}
  return "expected";
}

/** @param {Record<string, any>} normalized @param {number} ordinal */
function photoAt(normalized, ordinal) {
  return normalized.photos.find((/** @type {Record<string, any>} */ photo) => Number(photo.ordinal) === Number(ordinal));
}

/** @param {Record<string, any>} normalized @param {string[]} photoReferences */
function durablePhotoSet(normalized, photoReferences) {
  const references = new Set(photoReferences.map(String));
  return new Map(normalized.photos
    .filter((/** @type {Record<string, any>} */ photo) => photo.objectReference && references.has(photo.objectReference))
    .map((/** @type {Record<string, any>} */ photo) => [Number(photo.ordinal), photo]));
}

/** @param {Record<string, any>[]} rows @param {Record<string, any>} step */
function requiredEvidenceRows(rows, step) {
  return rows.filter((row) =>
    row.required === true
    && (!row.visit_step_id || String(row.visit_step_id) === String(step.visit_step_id))
  );
}

/** @param {unknown[]} rows @param {string} code @returns {Record<string, any>[]} */
function rowsForEvidenceCode(rows, code) {
  return rows.map(objectValue).filter((row) => row.evidenceCode === code);
}

/** @param {unknown[]} rows @param {number} minimum @param {string} message */
function assertMinimumEvidence(rows, minimum, message) {
  if (rows.length < minimum) {
    throw failure(409, "MBT_DRIVER_BIN_EVIDENCE_MISSING", message);
  }
}

/**
 * @param {Record<string, any>} requirement
 * @param {Record<string, any>} details
 * @param {Record<string, any>} job
 */
function validateScanRequirement(requirement, details, job) {
  const code = String(requirement.evidence_code);
  const matches = rowsForEvidenceCode(details.scans, code);
  assertMinimumEvidence(matches, Number(requirement.minimum_count), `Required BIN scan ${code} is missing.`);
  for (const scan of matches) {
    const role = firstText(scan.assetRole, roleForRequirement(requirement));
    const expected = assetForRole(job, role) || assetForRole(job, "outgoing");
    if (!expected) {
      throw failure(409, "MBT_DRIVER_BIN_ASSET_MISMATCH", "The frozen scan asset is unavailable.");
    }
    assertScanMatches(scan, expected);
  }
}

/**
 * @param {Record<string, any>} requirement
 * @param {Record<string, any>} details
 * @param {Map<number, Record<string, any>>} durablePhotos
 */
function validatePhotoRequirement(requirement, details, durablePhotos) {
  const code = String(requirement.evidence_code);
  const mappings = rowsForEvidenceCode(details.photoEvidence, code);
  const matched = mappings.filter((mapping) => durablePhotos.has(mapping.ordinal));
  assertMinimumEvidence(matched, Number(requirement.minimum_count), `Required durable photo ${code} is missing.`);
}

/** @param {Record<string, any>} requirement @param {Record<string, any>} details */
function validateNoteRequirement(requirement, details) {
  const code = String(requirement.evidence_code);
  const matches = rowsForEvidenceCode(details.notes, code);
  assertMinimumEvidence(matches, Number(requirement.minimum_count), `Required note ${code} is missing.`);
}

/**
 * @param {Record<string, any>} requirement
 * @param {Record<string, any>} details
 * @param {Map<number, Record<string, any>>} durablePhotos
 */
function validateSignatureRequirement(requirement, details, durablePhotos) {
  const code = String(requirement.evidence_code);
  const signatures = rowsForEvidenceCode(details.signatures, code);
  const durableSignatures = signatures.filter((signature) => durablePhotos.has(signature.signaturePhotoOrdinal));
  if (durableSignatures.length !== signatures.length) {
    throw failure(409, "MBT_DRIVER_BIN_EVIDENCE_MISSING", `Required signature ${code} is missing.`);
  }
  assertMinimumEvidence(
    durableSignatures,
    Number(requirement.minimum_count),
    `Required signature ${code} is missing.`
  );
}

/** @param {Record<string, any>} requirement @param {Record<string, any>} details */
function validateReceiptRequirement(requirement, details) {
  const receiptTypes = ["receipt", "weight", "quantity"];
  if (receiptTypes.includes(String(requirement.evidence_type)) && !details.receipt) {
    throw failure(409, "MBT_DRIVER_BIN_EVIDENCE_MISSING", "A complete dump receipt is required.");
  }
}

/**
 * @param {Record<string, any>} requirement
 * @param {Record<string, any>} details
 * @param {Record<string, any>} job
 * @param {Map<number, Record<string, any>>} durablePhotos
 */
function validateRequirement(requirement, details, job, durablePhotos) {
  const type = String(requirement.evidence_type);
  if (type === "bin_scan") {
    validateScanRequirement(requirement, details, job);
  }
  if (type === "photo") {
    validatePhotoRequirement(requirement, details, durablePhotos);
  }
  if (type === "note") {
    validateNoteRequirement(requirement, details);
  }
  if (type === "signature") {
    validateSignatureRequirement(requirement, details, durablePhotos);
  }
  validateReceiptRequirement(requirement, details);
}

/**
 * @param {Record<string, any>} details
 * @param {Record<string, any>} job
 * @param {Map<number, Record<string, any>>} durablePhotos
 */
function validateReceiptDetails(details, job, durablePhotos) {
  if (!details.receipt) {
    return;
  }
  const mbt = objectValue(job.mbt);
  const receiptIdentity = JSON.stringify([
    String(details.receipt.dumpSiteId),
    String(details.receipt.materialId)
  ]);
  const jobIdentity = JSON.stringify([
    firstText(mbt.dumpSiteId),
    firstText(mbt.materialId)
  ]);
  if (receiptIdentity !== jobIdentity) {
    throw failure(409, "MBT_DRIVER_BIN_RECEIPT_MISMATCH", "The dump receipt site or material does not match the frozen visit.");
  }
  if (!durablePhotos.has(details.receipt.receiptPhotoOrdinal)) {
    throw failure(409, "MBT_DRIVER_BIN_EVIDENCE_MISSING", "The dump receipt photo is not durably available.");
  }
}

/** @param {Record<string, any>} context */
function validateRequirements(context) {
  const { rows, step, normalized, job, photoReferences } = context;
  const details = normalized.details;
  const requirements = requiredEvidenceRows(rows.evidence, step);
  const durablePhotos = durablePhotoSet(normalized, photoReferences);
  for (const requirement of requirements) {
    validateRequirement(requirement, details, job, durablePhotos);
  }
  validateReceiptDetails(details, job, durablePhotos);
  return { requirements, durablePhotos };
}

/** @param {Map<string, Record<string, any>>} requirements @param {unknown} code */
function evidenceRequirementId(requirements, code) {
  return nullableString(objectValue(requirements.get(String(code))).visit_evidence_requirement_id);
}

/** @param {Record<string, any>} input @param {Map<string, Record<string, any>>} requirements */
async function insertScanEvidence(input, requirements) {
  const { normalized, rows, step } = input;
  /** @type {string[]} */
  const evidenceIds = [];
  for (const [index, scan] of normalized.details.scans.entries()) {
    const evidenceId = crypto.randomUUID();
    const content = JSON.stringify(scan);
    await query(
      `INSERT INTO mbt_evidence (
         evidence_id, service_visit_id, visit_step_id,
         visit_evidence_requirement_id, evidence_type, storage_provider,
         storage_key, content_sha256, mime_type, size_bytes, captured_at,
         captured_by_type, captured_by_id, source, metadata,
         source_driver_event_id, evidence_code, asset_role, source_ordinal
       ) VALUES (
         $1, $2, $3, $4, 'bin_scan', 'driver-bin-scan', $5, $6,
         'application/vnd.mbbs-bin-scan+json', $7, $8, 'driver', $9,
         'driver_bin_execution', $10::jsonb, $11::uuid, $12, $13, $14
       )`,
      [
        evidenceId, rows.visit.service_visit_id, step.visit_step_id,
        evidenceRequirementId(requirements, scan.evidenceCode),
        `driver-bin-scan/${normalized.eventId}/${scan.evidenceCode}/${index}`,
        hashMbtDriverCanonical(scan), Buffer.byteLength(content), normalized.occurredAt,
        normalized.driverLogin, JSON.stringify({ assetId: scan.assetId, scannedValue: scan.scannedValue }),
        normalized.eventId, scan.evidenceCode, scan.assetRole, index
      ]
    );
    evidenceIds.push(evidenceId);
  }
  return evidenceIds;
}

/** @param {Record<string, any>} input @param {Map<string, Record<string, any>>} requirements */
async function insertPhotoEvidence(input, requirements) {
  const { normalized, rows, step, durablePhotos } = input;
  /** @type {string[]} */
  const evidenceIds = [];
  for (const mapping of normalized.details.photoEvidence) {
    const photo = durablePhotos.get(mapping.ordinal);
    if (!photo) {
      continue;
    }
    const evidenceId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_evidence (
         evidence_id, service_visit_id, visit_step_id,
         visit_evidence_requirement_id, evidence_type, storage_provider,
         storage_key, content_sha256, mime_type, size_bytes, captured_at,
         captured_by_type, captured_by_id, source, metadata,
         source_driver_event_id, evidence_code, source_ordinal
       ) VALUES (
         $1, $2, $3, $4, 'photo', 'driver-offline', $5, $6, $7, $8,
         $9, 'driver', $10, 'driver_bin_execution', $11::jsonb,
         $12::uuid, $13, $14
       )`,
      [
        evidenceId, rows.visit.service_visit_id, step.visit_step_id,
        evidenceRequirementId(requirements, mapping.evidenceCode),
        photo.objectReference, photo.sha256, photo.mimeType, photo.byteSize,
        normalized.occurredAt, normalized.driverLogin,
        JSON.stringify({ photoId: photo.photoId, ordinal: photo.ordinal }),
        normalized.eventId, mapping.evidenceCode, mapping.ordinal
      ]
    );
    evidenceIds.push(evidenceId);
  }
  return evidenceIds;
}

/** @param {Record<string, any>} input @param {Map<string, Record<string, any>>} requirements */
async function insertNoteEvidence(input, requirements) {
  const { normalized, rows, step } = input;
  /** @type {string[]} */
  const evidenceIds = [];
  for (const [index, note] of normalized.details.notes.entries()) {
    const evidenceId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_evidence (
         evidence_id, service_visit_id, visit_step_id,
         visit_evidence_requirement_id, evidence_type, storage_provider,
         storage_key, content_sha256, mime_type, size_bytes, captured_at,
         captured_by_type, captured_by_id, source, metadata,
         source_driver_event_id, evidence_code, source_ordinal
       ) VALUES (
         $1, $2, $3, $4, 'note', 'driver-bin-inline', $5, $6,
         'text/plain', $7, $8, 'driver', $9, 'driver_bin_execution',
         $10::jsonb, $11::uuid, $12, $13
       )`,
      [
        evidenceId, rows.visit.service_visit_id, step.visit_step_id,
        evidenceRequirementId(requirements, note.evidenceCode),
        `driver-bin-note/${normalized.eventId}/${note.evidenceCode}`,
        hashMbtDriverCanonical(note), Buffer.byteLength(note.text), normalized.occurredAt,
        normalized.driverLogin, JSON.stringify({ text: note.text }), normalized.eventId,
        note.evidenceCode, index
      ]
    );
    evidenceIds.push(evidenceId);
  }
  return evidenceIds;
}

/** @param {Record<string, any> | undefined} photo @param {Record<string, any>} signature @param {Record<string, any>} normalized @param {number} index */
function signatureStorage(photo, signature, normalized, index) {
  if (photo) {
    return {
      storageKey: photo.objectReference,
      sha256: photo.sha256,
      mimeType: photo.mimeType,
      byteSize: photo.byteSize
    };
  }
  return {
    storageKey: `driver-bin-signature/${normalized.eventId}/${index}`,
    sha256: hashMbtDriverCanonical(signature),
    mimeType: "application/vnd.mbbs-signature+json",
    byteSize: Buffer.byteLength(signature.signedBy)
  };
}

/** @param {Record<string, any>} input @param {Map<string, Record<string, any>>} requirements */
async function insertSignatureEvidence(input, requirements) {
  const { normalized, rows, step } = input;
  /** @type {string[]} */
  const evidenceIds = [];
  for (const [index, signature] of normalized.details.signatures.entries()) {
    const storage = signatureStorage(photoAt(normalized, signature.signaturePhotoOrdinal), signature, normalized, index);
    const evidenceId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_evidence (
         evidence_id, service_visit_id, visit_step_id,
         visit_evidence_requirement_id, evidence_type, storage_provider,
         storage_key, content_sha256, mime_type, size_bytes, captured_at,
         captured_by_type, captured_by_id, source, metadata,
         source_driver_event_id, evidence_code, source_ordinal
       ) VALUES (
         $1, $2, $3, $4, 'signature', 'driver-offline', $5, $6, $7, $8,
         $9, 'driver', $10, 'driver_bin_execution', $11::jsonb,
         $12::uuid, $13, $14
       )`,
      [
        evidenceId, rows.visit.service_visit_id, step.visit_step_id,
        evidenceRequirementId(requirements, signature.evidenceCode),
        storage.storageKey, storage.sha256, storage.mimeType, storage.byteSize,
        normalized.occurredAt, normalized.driverLogin,
        JSON.stringify({ signedBy: signature.signedBy }), normalized.eventId,
        signature.evidenceCode, index
      ]
    );
    evidenceIds.push(evidenceId);
  }
  return evidenceIds;
}

/** @param {Record<string, any>} input */
async function insertEvidence(input) {
  const requirements = new Map(input.rows.evidence.map((/** @type {Record<string, any>} */ row) => [String(row.evidence_code), row]));
  const scans = await insertScanEvidence(input, requirements);
  const photos = await insertPhotoEvidence(input, requirements);
  const notes = await insertNoteEvidence(input, requirements);
  const signatures = await insertSignatureEvidence(input, requirements);
  return [...scans, ...photos, ...notes, ...signatures];
}

/** @param {Record<string, any>} context */
async function insertDumpReceipt(context) {
  const receipt = context.normalized.details.receipt;
  if (!receipt) {return null;}
  const photo = context.durablePhotos.get(receipt.receiptPhotoOrdinal);
  const storedPhoto = await query(
    `SELECT evidence_id::text
       FROM mbt_evidence
      WHERE source_driver_event_id = $1::uuid
        AND source_ordinal = $2
        AND evidence_type = 'photo'
      ORDER BY evidence_id
      LIMIT 1`,
    [context.normalized.eventId, receipt.receiptPhotoOrdinal]
  );
  if (!storedPhoto.rowCount) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_EVIDENCE_MISSING",
      "The durable dump receipt photo evidence is unavailable."
    );
  }
  const receiptPhotoEvidenceId = String(storedPhoto.rows[0].evidence_id);
  const receiptEvidenceId = crypto.randomUUID();
  const receiptContent = JSON.stringify(receipt);
  await query(
    `INSERT INTO mbt_evidence (
       evidence_id, service_visit_id, visit_step_id, evidence_type,
       storage_provider, storage_key, content_sha256, mime_type, size_bytes,
       amount_minor, currency, captured_at, captured_by_type, captured_by_id,
       source, metadata, source_driver_event_id, evidence_code, source_ordinal
     ) VALUES (
       $1, $2, $3, 'receipt', 'driver-bin-inline', $4, $5, $6, $7,
       $8, $9, $10, 'driver', $11, 'driver_bin_execution', $12::jsonb,
       $13::uuid, 'dump_receipt', $14
     )`,
    [
      receiptEvidenceId, context.rows.visit.service_visit_id, context.step.visit_step_id,
      `driver-bin-receipt/${context.normalized.eventId}`,
      hashMbtDriverCanonical(receipt), "application/vnd.mbbs-dump-receipt+json",
      Buffer.byteLength(receiptContent),
      receipt.totalMinor, receipt.currency, context.normalized.occurredAt,
      context.normalized.driverLogin,
      JSON.stringify({ ...receipt, receiptPhotoEvidenceId, photoReference: photo.objectReference }),
      context.normalized.eventId,
      receipt.receiptPhotoOrdinal
    ]
  );
  const receiptId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_dump_receipts (
       dump_receipt_id, source_driver_event_id, service_visit_id,
       visit_step_id, dump_site_id, material_id, ticket_number, weight,
       quantity, unit_of_measure, subtotal_minor, tax_minor, total_minor,
       currency, receipt_photo_evidence_id, captured_at, server_received_at,
       recorded_by_driver_login, receipt_snapshot
     ) VALUES (
       $1, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb
     )`,
    [
      receiptId, context.normalized.eventId, context.rows.visit.service_visit_id,
      context.step.visit_step_id, receipt.dumpSiteId, receipt.materialId,
      receipt.ticketNumber, receipt.weight, receipt.quantity,
      receipt.unitOfMeasure, receipt.subtotalMinor, receipt.taxMinor,
      receipt.totalMinor, receipt.currency, receiptPhotoEvidenceId,
      context.normalized.occurredAt, context.normalized.receivedAt,
      context.normalized.driverLogin, JSON.stringify(receipt)
    ]
  );
  return { receiptId, receiptEvidenceId, receiptPhotoEvidenceId };
}

/** @param {string} actionCode */
function movementKind(actionCode) {
  if (["collect_empty_bin", "pickup_bin", "pickup_loaded_bin", "load_bin"].includes(actionCode)) {return "to_truck";}
  if (["deliver_bin", "place_bin"].includes(actionCode)) {return "to_customer";}
  if (["dump_bin", "dump_load"].includes(actionCode)) {return "to_dump";}
  if (["return_bin", "return_empty_bin", "unload_bin"].includes(actionCode)) {return "to_yard";}
  if (actionCode.includes("exchange")) {return "exchange";}
  return "none";
}

/** @param {Record<string, any>} context @param {string} kind */
function movementLocation(context, kind) {
  const visit = context.rows.visit;
  const jobMbt = objectValue(context.job.mbt);
  const capability = objectValue(jobMbt.capabilitySnapshot);
  if (kind === "to_truck") {
    return {
      kind: "truck",
      reference: firstText(context.job.truckPlate),
      truckId: firstText(context.job.truckId, visit.planned_truck_id)
    };
  }
  if (kind === "to_customer") {
    return {
      kind: "customer_site",
      reference: firstText(jobMbt.visitReference),
      customerSiteProfileId: String(visit.customer_site_profile_id)
    };
  }
  if (kind === "to_dump") {
    return {
      kind: "dump_site",
      reference: firstText(jobMbt.dumpSiteId),
      dumpSiteId: firstText(jobMbt.dumpSiteId)
    };
  }
  return {
    kind: "yard",
    reference: firstText(capability.baseYardCode, context.job.location),
    yardId: firstText(capability.baseYardId)
  };
}

/** @param {string} kind */
function movementStatus(kind) {
  return {
    to_truck: "on_truck",
    to_customer: "at_customer",
    to_dump: "at_dump",
    to_yard: "available"
  }[kind] || "available";
}

/** @param {Record<string, any>} context @param {string} status */
function expectedLocationForStatus(context, status) {
  const visit = context.rows.visit;
  const capability = objectValue(objectValue(context.job.mbt).capabilitySnapshot);
  if (status === "on_truck") {
    return {
      kind: "truck",
      identityField: "truck_id",
      identity: firstText(context.job.truckId, visit.planned_truck_id)
    };
  }
  if (status === "at_customer") {
    return {
      kind: "customer_site",
      identityField: "customer_site_profile_id",
      identity: firstText(visit.customer_site_profile_id)
    };
  }
  if (status === "at_dump") {
    return {
      kind: "dump_site",
      identityField: "dump_site_id",
      identity: firstText(visit.dump_site_id)
    };
  }
  if (["available", "reserved"].includes(status)) {
    return {
      kind: "yard",
      identityField: "yard_id",
      identity: firstText(capability.baseYardId)
    };
  }
  return null;
}

/** @param {string} actionCode */
function defaultBeforeStatuses(actionCode) {
  if (["collect_empty_bin", "load_bin"].includes(actionCode)) {return ["reserved", "available"];}
  if (["pickup_bin", "pickup_loaded_bin"].includes(actionCode)) {return ["at_customer"];}
  if (["return_bin", "return_empty_bin"].includes(actionCode)) {return ["on_truck", "at_dump"];}
  if (["deliver_bin", "place_bin", "dump_bin", "dump_load", "unload_bin"].includes(actionCode)) {
    return ["on_truck"];
  }
  return [];
}

/** @param {string} actionCode @param {string | null} templateAfter @param {string} derivedAfter @param {string} message */
function assertTemplateAfterStatus(actionCode, templateAfter, derivedAfter, message) {
  if (!templateAfter || templateAfter === derivedAfter) {return;}
  throw failure(
    409,
    "MBT_DRIVER_BIN_TEMPLATE_STATE_MISMATCH",
    message,
    { actionCode, templateAfterStatus: templateAfter, derivedAfterStatus: derivedAfter }
  );
}

/** @param {Record<string, any>} context @param {string} actionCode @param {string | null} templateBefore @param {string | null} templateAfter */
function exchangeMovementPlans(context, actionCode, templateBefore, templateAfter) {
  const outgoing = assetForRole(context.job, "outgoing");
  const incoming = assetForRole(context.job, "incoming");
  if (!outgoing || !incoming || String(outgoing.assetId) === String(incoming.assetId)) {
    throw failure(409, "MBT_DRIVER_BIN_ASSET_MISMATCH", "An exchange requires distinct outgoing and incoming BIN assets.");
  }
  const outgoingAfter = movementStatus("to_customer");
  assertTemplateAfterStatus(
    actionCode,
    templateAfter,
    outgoingAfter,
    "The BIN exchange action contradicts its frozen template after-state."
  );
  return [
    {
      asset: outgoing,
      kind: "to_customer",
      role: "outgoing",
      beforeStatuses: [templateBefore || "on_truck"],
      afterStatus: outgoingAfter
    },
    {
      asset: incoming,
      kind: "to_truck",
      role: "incoming",
      beforeStatuses: ["at_customer"],
      afterStatus: "on_truck"
    }
  ];
}

/** @param {Record<string, any>} context @param {string} actionCode @param {string} kind @param {string | null} templateBefore @param {string | null} templateAfter */
function singleMovementPlan(context, actionCode, kind, templateBefore, templateAfter) {
  const asset = assetForRole(context.job, "expected") || assetForRole(context.job, "outgoing");
  if (!asset) {throw failure(409, "MBT_DRIVER_BIN_ASSET_MISMATCH", "The movement asset is unavailable.");}
  const derivedAfter = movementStatus(kind);
  assertTemplateAfterStatus(
    actionCode,
    templateAfter,
    derivedAfter,
    "The BIN action contradicts its frozen template after-state."
  );
  return [{
    asset,
    kind,
    role: "expected",
    beforeStatuses: templateBefore ? [templateBefore] : defaultBeforeStatuses(actionCode),
    afterStatus: derivedAfter
  }];
}

/**
 * Derive the only movement allowed by the action, then prove the template does
 * not request a different after-state. Exchange's outgoing asset follows the
 * step template; the incoming asset follows its complementary customer→truck
 * transition.
 * @param {Record<string, any>} context
 */
function movementPlans(context) {
  const actionCode = String(context.step.action_code);
  const kind = movementKind(actionCode);
  if (kind === "none") {return [];}
  const templateBefore = nullableString(context.step.required_asset_status_before);
  const templateAfter = nullableString(context.step.required_asset_status_after);
  return kind === "exchange"
    ? exchangeMovementPlans(context, actionCode, templateBefore, templateAfter)
    : singleMovementPlan(context, actionCode, kind, templateBefore, templateAfter);
}

/**
 * Validate the current materialized state while its rows remain locked.
 * @param {Record<string, any>} context
 * @param {Array<Record<string, any>>} plans
 * @param {Map<string, Record<string, any>>} lockedStates
 */
function assertMovementPreconditions(context, plans, lockedStates) {
  for (const plan of plans) {
    const assetId = String(plan.asset.assetId || "");
    const state = lockedStates.get(assetId);
    if (!state) {
      throw failure(409, "MBT_DRIVER_BIN_ASSET_MISMATCH", "The movement asset is unavailable.", {
        assetId,
        assetRole: plan.role
      });
    }
    const actualStatus = String(state.lifecycle_status);
    if (plan.beforeStatuses.length && !plan.beforeStatuses.includes(actualStatus)) {
      throw failure(
        409,
        "MBT_DRIVER_BIN_ASSET_STATE_MISMATCH",
        "The BIN asset is no longer in the state required by this stop.",
        {
          assetId,
          assetRole: plan.role,
          expectedStatuses: plan.beforeStatuses,
          actualStatus
        }
      );
    }
    const expectedLocation = expectedLocationForStatus(context, actualStatus);
    if (!expectedLocation) {continue;}
    const actualKind = String(state.location_kind || "");
    const actualIdentity = nullableString(state[expectedLocation.identityField]);
    const wrongIdentity = Boolean(expectedLocation.identity)
      && actualIdentity !== String(expectedLocation.identity);
    if (actualKind !== expectedLocation.kind || wrongIdentity) {
      throw failure(
        409,
        "MBT_DRIVER_BIN_ASSET_LOCATION_MISMATCH",
        "The BIN asset is no longer at the exact location required by this stop.",
        {
          assetId,
          assetRole: plan.role,
          expectedLocationKind: expectedLocation.kind,
          expectedLocationIdentity: expectedLocation.identity,
          actualLocationKind: actualKind,
          actualLocationIdentity: actualIdentity
        }
      );
    }
  }
}

/**
 * A manifest freezes the dump/material pair, but acceptance is an operational
 * safety property and must still be active at application time.
 * @param {Record<string, any>} context
 * @param {Record<string, any> | null} manifestContext
 */
async function assertActiveDumpAcceptance(context, manifestContext) {
  if (!manifestContext || movementKind(String(context.step.action_code)) !== "to_dump") {return;}
  const dumpSiteId = nullableString(context.rows.visit.dump_site_id);
  const materialId = nullableString(context.rows.visit.material_id);
  if (!dumpSiteId || !materialId) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_DUMP_ACCEPTANCE_REQUIRED",
      "The frozen dump site and material acceptance is unavailable."
    );
  }
  const acceptance = await query(
    `SELECT acceptance.dump_site_material_id
       FROM mbt_dump_site_materials acceptance
       JOIN mbt_dump_sites dump_site ON dump_site.dump_site_id = acceptance.dump_site_id
       JOIN mbt_materials material ON material.material_id = acceptance.material_id
      WHERE acceptance.dump_site_id = $1
        AND acceptance.material_id = $2
        AND acceptance.accepted = true
        AND acceptance.active = true
        AND dump_site.active = true
        AND material.active = true
      FOR SHARE OF acceptance, dump_site, material`,
    [dumpSiteId, materialId]
  );
  if (!acceptance.rowCount) {
    throw failure(
      409,
      "MBT_DRIVER_BIN_DUMP_ACCEPTANCE_REQUIRED",
      "This dump site no longer actively accepts the frozen material.",
      { dumpSiteId, materialId }
    );
  }
}

/** @param {Record<string, any>} context @param {Record<string, any>} plan @param {string[]} evidenceIds */
async function appendMovement(context, plan, evidenceIds) {
  const visit = context.rows.visit;
  return recordAssetMovement(ambientDatabase, {
    assetId: String(plan.asset.assetId),
    movementType: `${context.step.action_code}_${plan.role}`,
    afterStatus: plan.afterStatus,
    afterLocation: movementLocation(context, plan.kind),
    contractId: String(visit.contract_id),
    visitId: String(visit.service_visit_id),
    truckId: firstText(context.job.truckId, visit.planned_truck_id),
    driverId: firstText(visit.planned_driver_id),
    evidenceReferences: evidenceIds,
    source: "driver_bin_execution",
    actorType: "driver",
    actorId: context.normalized.driverLogin,
    occurredAt: context.normalized.occurredAt
  });
}

/** @param {Record<string, any>} context @param {string[]} evidenceIds */
async function applyMovements(context, evidenceIds) {
  const plans = arrayValue(context.movementPlans);
  const movements = [];
  for (const plan of plans) {
    movements.push(await appendMovement(context, objectValue(plan), evidenceIds));
  }
  return movements;
}

/** @param {Record<string, any>} context */
async function satisfyRequirements(context) {
  const requirementIds = context.requirements.map((/** @type {Record<string, any>} */ requirement) => String(requirement.visit_evidence_requirement_id));
  if (requirementIds.length) {
    await query(
      `UPDATE mbt_visit_evidence_requirements
          SET status = 'satisfied', revision = revision + 1, updated_at = now()
        WHERE visit_evidence_requirement_id = ANY($1::uuid[])`,
      [requirementIds]
    );
  }
}

/** @param {Record<string, any>} context */
async function finishStepAndVisit(context) {
  await query(
    `UPDATE mbt_visit_steps
        SET status = 'completed', started_at = COALESCE(started_at, $2),
            completed_at = COALESCE(completed_at, $2), revision = revision + 1,
            updated_at = now()
      WHERE visit_step_id = $1`,
    [context.step.visit_step_id, context.normalized.occurredAt]
  );
  const blockers = await query(
    `SELECT
       count(*) FILTER (WHERE step.required AND step.completion_blocking
                         AND step.status NOT IN ('completed', 'skipped'))::int AS pending_steps,
       count(*) FILTER (WHERE requirement.required
                         AND requirement.status NOT IN ('satisfied', 'waived'))::int AS pending_evidence
       FROM mbt_service_visits visit
       LEFT JOIN mbt_visit_steps step ON step.service_visit_id = visit.service_visit_id
       LEFT JOIN mbt_visit_evidence_requirements requirement
         ON requirement.service_visit_id = visit.service_visit_id
      WHERE visit.service_visit_id = $1`,
    [context.rows.visit.service_visit_id]
  );
  const visitCompleted = Number(blockers.rows[0].pending_steps) === 0
    && Number(blockers.rows[0].pending_evidence) === 0;
  await query(
    `UPDATE mbt_service_visits
        SET status = $2,
            actual_started_at = COALESCE(actual_started_at, $3),
            actual_completed_at = CASE WHEN $2 = 'completed'
              THEN COALESCE(actual_completed_at, $3) ELSE actual_completed_at END,
            revision = revision + 1, updated_by = $4, updated_at = now()
      WHERE service_visit_id = $1`,
    [
      context.rows.visit.service_visit_id,
      visitCompleted ? "completed" : "in_progress",
      context.normalized.occurredAt,
      `driver:${context.normalized.driverLogin}`
    ]
  );
  if (visitCompleted) {
    await query(
      `UPDATE mbt_bin_asset_reservations
          SET released_at = COALESCE(released_at, $2),
              released_by = COALESCE(released_by, $3),
              release_reason = COALESCE(release_reason, 'Driver completed the planned BIN visit'),
              revision = CASE WHEN released_at IS NULL THEN revision + 1 ELSE revision END,
              updated_at = now()
        WHERE visit_id = $1 AND released_at IS NULL`,
      [context.rows.visit.service_visit_id, context.normalized.occurredAt, context.normalized.driverLogin]
    );
  }
  return visitCompleted;
}

/** @param {Record<string, any>} context @param {boolean} visitCompleted @param {Record<string, any> | null} receipt */
async function insertBillingTrigger(context, visitCompleted, receipt) {
  const kind = receipt ? "dump_receipt_recorded" : visitCompleted ? "visit_completed" : "step_completed";
  await query(
    `INSERT INTO mbt_driver_bin_billing_triggers (
       billing_trigger_id, source_driver_event_id, contract_id,
       service_visit_id, trigger_kind, posting_mode, trigger_snapshot
     ) VALUES ($1, $2::uuid, $3, $4, $5, 'local_only', $6::jsonb)`,
    [
      crypto.randomUUID(), context.normalized.eventId, context.rows.visit.contract_id,
      context.rows.visit.service_visit_id, kind,
      JSON.stringify({
        jobId: context.normalized.jobId,
        actionCode: context.step.action_code,
        visitCompleted,
        receiptId: receipt?.receiptId || null
      })
    ]
  );
}

/** @param {Record<string, Function>} hooks @param {string} name @param {unknown} value */
async function invokeCompletionHook(hooks, name, value) {
  const hook = hooks[name];
  if (typeof hook === "function") {
    await hook(value);
  }
}

/**
 * Apply one locally recorded BIN physical-stop completion atomically.
 * @param {{event: Record<string, any>, job: Record<string, any>, manifest: Record<string, any>, photoReferences?: string[]}} input
 * @param {{capability: unknown, hooks?: Record<string, Function>}} boundary
 */
export async function completeMbtDriverBinJob(input, { capability, hooks = {} }) {
  assertCapability(capability);
  const normalized = /** @type {Record<string, any>} */ (normalizedApplication(input.event, input.job));
  if (normalized.eventType !== "job_completed") {
    throw failure(400, "MBT_DRIVER_BIN_INPUT_INVALID", "A BIN job-completion event is required.");
  }
  return withTransaction(async () => {
    await lockApplicationIdentity(normalized);
    const replay = await existingApplication(normalized);
    if (replay) {return replay;}
    const manifestContext = await assertCompleteManifestRoute(input.manifest, normalized);
    const rows = await visitExecutionRows(String(objectValue(input.job.mbt).visitId), true);
    try {
      assertExecutionSnapshot(input.job, rows.visit);
    } catch (error) {
      throw withEventIdentity(error, normalized.eventId);
    }
    const step = currentStep(rows, input.job);
    assertPriorStepsComplete(rows, step);
    if (normalized.details.actionCode !== String(step.action_code)) {
      throw failure(409, "MBT_DRIVER_BIN_REVIEW_REQUIRED", "The saved BIN action no longer matches its visit step.", {
        eventId: normalized.eventId
      });
    }
    if (!["planned", "in_progress", "evidence_pending"].includes(String(rows.visit.status))) {
      throw failure(409, "MBT_DRIVER_BIN_REVIEW_REQUIRED", "The BIN visit is no longer completable.", {
        eventId: normalized.eventId
      });
    }
    const lockedStates = await lockExactAssetStates(input.job);
    assertCompleteManifestChronology(manifestContext, normalized, lockedStates);
    await assertDurableBinStart(manifestContext, normalized);
    const context = /** @type {Record<string, any>} */ ({
      normalized,
      rows,
      step,
      job: input.job,
      photoReferences: arrayValue(input.photoReferences).map(String)
    });
    const plans = movementPlans(context);
    assertMovementPreconditions(context, plans, lockedStates);
    await assertActiveDumpAcceptance(context, manifestContext);
    const validated = validateRequirements(context);
    const executionContext = { ...context, ...validated, movementPlans: plans };
    const evidenceIds = await insertEvidence(executionContext);
    await invokeCompletionHook(hooks, "afterEvidence", { executionContext, evidenceIds });
    const receipt = await insertDumpReceipt(executionContext);
    if (receipt) {evidenceIds.push(receipt.receiptEvidenceId);}
    await invokeCompletionHook(hooks, "afterReceipt", { executionContext, evidenceIds, receipt });
    const movements = await applyMovements(executionContext, evidenceIds);
    await invokeCompletionHook(hooks, "afterMovements", { executionContext, evidenceIds, receipt, movements });
    await satisfyRequirements(executionContext);
    await invokeCompletionHook(hooks, "afterRequirements", executionContext);
    const visitCompleted = await finishStepAndVisit(executionContext);
    await invokeCompletionHook(hooks, "afterVisit", { executionContext, visitCompleted });
    const record = await recordDriverJobPhotos(normalized.driverLogin, normalized.jobId, /** @type {any} */ ({
      photoDataUrls: context.photoReferences,
      job: input.job,
      occurredAt: normalized.occurredAt,
      offlineTrace: await registeredOfflineTrace(normalized),
      driverRemark: objectValue(input.event.details).driverRemark
    }));
    await invokeCompletionHook(hooks, "afterDriverRecord", { executionContext, record });
    await insertBillingTrigger(executionContext, visitCompleted, receipt);
    await invokeCompletionHook(hooks, "afterBillingTrigger", { executionContext, receipt, visitCompleted });
    const body = {
      schemaVersion: "mbt-driver-bin-application-v1",
      eventId: normalized.eventId,
      eventType: normalized.eventType,
      jobId: normalized.jobId,
      visitId: String(rows.visit.service_visit_id),
      visitStepId: String(step.visit_step_id),
      status: visitCompleted ? "completed" : "in_progress",
      occurredAt: normalized.occurredAt.toISOString(),
      driverRecordId: record?.id || null,
      evidenceIds,
      movementIds: movements.map((movement) => movement.movementId),
      receiptId: receipt?.receiptId || null,
      billingTrigger: { postingMode: "local_only" }
    };
    const persistedBody = await insertApplication(normalized, input.job, rows.visit, step, body);
    return { replayed: false, body: persistedBody };
  });
}
