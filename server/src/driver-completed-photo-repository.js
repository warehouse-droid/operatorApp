import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";
import {
  driverCompletedPhotoReferenceMatches,
  driverCompletedVisitSource,
  driverCompletedVisitStateHash,
  DRIVER_COMPLETED_VISIT_MAX_PHOTOS,
  mergeDriverCompletedVisitPhotos,
  normalizeDriverCompletedPhotoDescriptors,
  normalizeDriverCompletedVisitFilters,
  physicalVisitMemberJobIds,
  uniqueDriverPhotoReferences
} from "./driver-completed-photo-evidence.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const PHYSICAL_STOP_TYPES = new Set(["pickup", "dropoff", "pick", "drop"]);

function repositoryError(message, status = 400, code = "DRIVER_COMPLETED_PHOTO_INVALID", details = {}) {
  return Object.assign(new Error(message), { status, code, ...details });
}

function requiredText(value, label, maxLength = 2000) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw repositoryError(`${label} is required.`);
  }
  if (text.length > maxLength) {
    throw repositoryError(`${label} is too long.`);
  }
  return text;
}

function uuidValue(value, label) {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!UUID_PATTERN.test(text)) {
    throw repositoryError(`${label} must be a UUID.`);
  }
  return text;
}

function recordIdValue(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw repositoryError("Driver stop ID is invalid.", 400, "DRIVER_COMPLETED_VISIT_ID_INVALID");
  }
  return id;
}

function planDateValue(value) {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw repositoryError(
      "Plan date must use YYYY-MM-DD.",
      400,
      "DRIVER_COMPLETED_VISIT_DATE_INVALID"
    );
  }
  return date;
}

function dateTimeValue(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stopTypeValue(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "pick") {
    return "pickup";
  }
  if (type === "drop") {
    return "dropoff";
  }
  return type;
}

function stringValue(value) {
  return String(value ?? "");
}

function nullableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

function arrayStrings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(String);
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function jobDetails(row) {
  return objectValue(row?.job_details);
}

function firstText(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function rowSnapshot(row) {
  return {
    id: Number(row.id),
    jobId: stringValue(row.job_id),
    planId: nullableNumber(row.plan_id),
    planDate: planDateValue(row.plan_date),
    driverLogin: stringValue(row.driver_login).toLowerCase(),
    truckId: stringValue(row.truck_id),
    truckPlate: stringValue(row.truck_plate),
    loadId: stringValue(row.load_id),
    loadName: stringValue(row.load_name),
    stopId: stringValue(row.stop_id),
    stopType: stopTypeValue(row.stop_type),
    orderRefs: arrayStrings(row.order_refs),
    photoDataUrls: uniqueDriverPhotoReferences(row.photo_data_urls),
    status: stringValue(row.status),
    startedAt: dateTimeValue(row.started_at),
    completedAt: dateTimeValue(row.completed_at),
    jobDetails: jobDetails(row),
    sourceOfflineEventId: row.source_offline_event_id ?? null,
    deviceOccurredAt: dateTimeValue(row.device_occurred_at),
    serverReceivedAt: dateTimeValue(row.server_received_at),
    serverAppliedAt: dateTimeValue(row.server_applied_at),
    locationStatus: stringValue(row.location_status),
    locationDetails: objectValue(row.location_details)
  };
}

function physicalVisitDeclaration(row) {
  const ownJobId = String(row?.job_id || "");
  try {
    return { valid: true, jobIds: physicalVisitMemberJobIds(row), message: "" };
  } catch (error) {
    return {
      valid: false,
      jobIds: ownJobId ? [ownJobId] : [],
      message: String(error?.message || "The physical-visit declaration is invalid.")
    };
  }
}

function unionFindRows(rows) {
  const byJobId = new Map(rows.map((row) => [String(row.job_id), row]));
  const parent = new Map([...byJobId.keys()].map((jobId) => [jobId, jobId]));
  const find = (value) => {
    const current = parent.get(value);
    if (current === value) {
      return value;
    }
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  };
  for (const row of rows) {
    const ownJobId = String(row.job_id);
    const declaration = physicalVisitDeclaration(row);
    if (!declaration.valid) {
      continue;
    }
    for (const declaredJobId of declaration.jobIds) {
      if (byJobId.has(declaredJobId)) {
        union(ownJobId, declaredJobId);
      }
    }
  }
  const components = new Map();
  for (const row of rows) {
    const root = find(String(row.job_id));
    if (!components.has(root)) {
      components.set(root, []);
    }
    components.get(root).push(row);
  }
  return [...components.values()];
}

function sameSet(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function orderComponentRows(rows) {
  const byJobId = new Map(rows.map((row) => [String(row.job_id), row]));
  const lead = [...rows].sort((left, right) => Number(left.id) - Number(right.id))[0];
  const declaration = physicalVisitDeclaration(lead).jobIds;
  const declaredRows = declaration.map((jobId) => byJobId.get(jobId)).filter(Boolean);
  const remaining = rows
    .filter((row) => !declaration.includes(String(row.job_id)))
    .sort((left, right) => Number(left.id) - Number(right.id));
  return [...declaredRows, ...remaining];
}

function declarationDecision(rows, allRowsByJobId) {
  const actualJobIds = rows.map((row) => String(row.job_id));
  const declarations = rows.map(physicalVisitDeclaration);
  const missingJobIds = [...new Set(
    declarations.flatMap((declaration) => declaration.jobIds)
      .filter((jobId) => !allRowsByJobId.has(jobId))
  )];
  const sameDeclarations = declarations.every(
    (declaration) => declaration.valid && sameSet(declaration.jobIds, actualJobIds)
  );
  const first = rows[0];
  const sameContext = rows.every((row) =>
    String(row.driver_login).toLowerCase() === String(first.driver_login).toLowerCase()
    && planDateValue(row.plan_date) === planDateValue(first.plan_date)
    && Number(row.plan_id || 0) === Number(first.plan_id || 0)
    && stopTypeValue(row.stop_type) === stopTypeValue(first.stop_type)
  );
  const sameLifecycle = rows.every(
    (row) => String(row.status || "").toLowerCase() === String(first.status || "").toLowerCase()
  );
  if (!missingJobIds.length && sameDeclarations && sameContext && sameLifecycle) {
    return { valid: true, code: "", message: "", missingJobIds: [] };
  }
  const invalidMessage = declarations.find((declaration) => !declaration.valid)?.message;
  return {
    valid: false,
    code: "DRIVER_COMPLETED_VISIT_DECLARATION_INVALID",
    message: invalidMessage || (sameLifecycle
      ? "This physical visit has inconsistent member records. Refresh or repair it before adding photos."
      : "This physical visit has mixed lifecycle states. Repair the member records before adding photos."),
    missingJobIds
  };
}

function photoProvenance(events = []) {
  const byReference = new Map();
  for (const event of events) {
    for (const reference of uniqueDriverPhotoReferences(event.photo_references)) {
      if (!byReference.has(reference)) {
        byReference.set(reference, event);
      }
    }
  }
  return byReference;
}

function publicPhotos(references, source, provenanceByReference) {
  return references.map((objectReference, index) => {
    const event = provenanceByReference.get(objectReference);
    return {
      ordinal: index + 1,
      objectReference,
      previewUrl: `/api/photo-upload/preview?ref=${encodeURIComponent(objectReference)}`,
      source: event ? "dispatch_stop_evidence" : source,
      addedAt: event ? dateTimeValue(event.created_at) : null,
      addedBy: event ? String(event.actor_name || "") : "",
      additionReason: event ? String(event.reason || "") : "",
      additionEventId: event ? String(event.addition_event_id || "") : ""
    };
  });
}

function rowOrderRefs(row) {
  return arrayStrings(row.order_refs);
}

function detailRequiredPhotos(details) {
  return Number(details.requiredPhotos ?? 0);
}

function firstOrNull(values) {
  return values[0] ?? null;
}

function lastOrNull(values) {
  return values.at(-1) ?? null;
}

function visitCanAppend(declaration, status, photoCount) {
  return declaration.valid
    && status === "complete"
    && photoCount < DRIVER_COMPLETED_VISIT_MAX_PHOTOS;
}

function buildVisit(componentRows, allRowsByJobId, provenanceByReference = new Map()) {
  const rows = orderComponentRows(componentRows);
  const lead = rows[0];
  const details = rows.map(jobDetails);
  const declaration = declarationDecision(rows, allRowsByJobId);
  const recordIds = rows.map((row) => Number(row.id));
  const jobIds = rows.map((row) => String(row.job_id));
  const orderRefs = [...new Set(rows.flatMap(rowOrderRefs))];
  const photos = uniqueDriverPhotoReferences(rows.flatMap((row) => row.photo_data_urls ?? []));
  const statuses = [...new Set(rows.map((row) => stringValue(row.status).toLowerCase()))];
  const status = statuses.length === 1 ? statuses[0] : "mixed";
  const completionSource = driverCompletedVisitSource(rows);
  const requiredPhotos = Math.max(0, ...details.map(detailRequiredPhotos));
  const location = firstText(details.flatMap((value) => [value.location, value.dropLocation, value.pickupLocation]));
  const address = firstText(details.flatMap((value) => [value.address, value.dropAddress]));
  const completedValues = rows.map((row) => dateTimeValue(row.completed_at)).filter(Boolean).sort();
  const startedValues = rows.map((row) => dateTimeValue(row.started_at)).filter(Boolean).sort();
  const memberRecords = rows.map(rowSnapshot);
  const stateHash = driverCompletedVisitStateHash({
    planId: nullableNumber(lead.plan_id),
    planDate: planDateValue(lead.plan_date),
    driverLogin: stringValue(lead.driver_login).toLowerCase(),
    recordIds,
    jobIds,
    stopType: stopTypeValue(lead.stop_type),
    declarationValid: declaration.valid,
    memberRecords,
    photos
  });
  return {
    recordId: recordIds[0],
    recordIds,
    jobId: jobIds[0],
    jobIds,
    planId: nullableNumber(lead.plan_id),
    planDate: planDateValue(lead.plan_date),
    driverLogin: stringValue(lead.driver_login).toLowerCase(),
    driverName: firstText(details.map((value) => value.driverName)),
    truckId: stringValue(lead.truck_id),
    truckPlate: stringValue(lead.truck_plate),
    loadId: stringValue(lead.load_id),
    loadName: stringValue(lead.load_name),
    stopIds: rows.map((row) => stringValue(row.stop_id)),
    stopType: stopTypeValue(lead.stop_type),
    orderRefs,
    location,
    address,
    status,
    startedAt: firstOrNull(startedValues),
    completedAt: lastOrNull(completedValues),
    completionSource,
    requiredPhotos,
    photoCount: photos.length,
    maxPhotos: DRIVER_COMPLETED_VISIT_MAX_PHOTOS,
    remainingPhotoSlots: Math.max(0, DRIVER_COMPLETED_VISIT_MAX_PHOTOS - photos.length),
    photos: publicPhotos(photos, completionSource, provenanceByReference),
    photoReferences: photos,
    consolidatedPhysicalVisit: rows.length > 1,
    declarationValid: declaration.valid,
    blockCode: declaration.code,
    blockReason: declaration.message,
    missingJobIds: declaration.missingJobIds,
    appendable: visitCanAppend(declaration, status, photos.length),
    stateHash,
    expectedStateHash: stateHash,
    _memberRecords: memberRecords
  };
}

async function rowsForPlanDate(planDate) {
  return (await query(
    `SELECT *
       FROM driver_job_records
      WHERE plan_date = $1::date
        AND lower(COALESCE(stop_type, '')) = ANY($2::text[])
      ORDER BY id`,
    [planDate, [...PHYSICAL_STOP_TYPES]]
  )).rows;
}

async function additionsForPlanDate(planDate) {
  return (await query(
    `SELECT addition_event_id, actor_name, reason, photo_references, created_at
       FROM driver_job_photo_addition_events
      WHERE plan_date = $1::date
      ORDER BY created_at DESC, id DESC`,
    [planDate]
  )).rows;
}

function buildVisits(rows, events = []) {
  const allRowsByJobId = new Map(rows.map((row) => [String(row.job_id), row]));
  const provenance = photoProvenance(events);
  return unionFindRows(rows).map((component) => buildVisit(component, allRowsByJobId, provenance));
}

function photoStateMatches(visit, photoState) {
  if (photoState === "none") {
    return visit.photoCount === 0;
  }
  if (photoState === "below_required") {
    return visit.photoCount < visit.requiredPhotos;
  }
  if (photoState === "has_photos") {
    return visit.photoCount > 0;
  }
  if (photoState === "at_limit") {
    return visit.photoCount >= DRIVER_COMPLETED_VISIT_MAX_PHOTOS;
  }
  return true;
}

function queryMatches(visit, q) {
  if (!q) {
    return true;
  }
  const haystack = [
    visit.driverLogin, visit.driverName, visit.truckId, visit.truckPlate,
    visit.loadId, visit.loadName, visit.location, visit.address,
    ...visit.jobIds, ...visit.stopIds, ...visit.orderRefs
  ].join("\n").toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function visitSort(left, right) {
  const leftTime = left.completedAt || left.startedAt || "";
  const rightTime = right.completedAt || right.startedAt || "";
  return rightTime.localeCompare(leftTime) || Number(right.recordId) - Number(left.recordId);
}

function countFacet(visits, valueFor, key) {
  const counts = new Map();
  for (const visit of visits) {
    const value = valueFor(visit);
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([value, count]) => ({ [key]: value, count }));
}

function visitFacets(visits) {
  const driverNames = new Map(visits.map((visit) => [visit.driverLogin, visit.driverName]));
  return {
    drivers: countFacet(visits, (visit) => visit.driverLogin, "driverLogin")
      .map((entry) => ({ ...entry, driverName: driverNames.get(entry.driverLogin) || "" })),
    statuses: countFacet(visits, (visit) => visit.status, "status"),
    stopTypes: countFacet(visits, (visit) => visit.stopType, "stopType"),
    completionSources: countFacet(visits, (visit) => visit.completionSource, "completionSource")
  };
}

function publicVisit(visit) {
  const { _memberRecords, ...result } = visit;
  return result;
}

export async function listDriverCompletedVisits({ planDate, ...filterInput } = {}) {
  const date = planDateValue(planDate);
  const filters = normalizeDriverCompletedVisitFilters(filterInput);
  const [rows, events] = await Promise.all([rowsForPlanDate(date), additionsForPlanDate(date)]);
  const allVisits = buildVisits(rows, events).sort(visitSort);
  const filtered = allVisits.filter((visit) =>
    (filters.status === "all" || visit.status === filters.status)
    && (!filters.driverLogin || visit.driverLogin === filters.driverLogin)
    && (filters.stopType === "all" || visit.stopType === filters.stopType)
    && photoStateMatches(visit, filters.photoState)
    && (filters.completionSource === "all" || visit.completionSource === filters.completionSource)
    && queryMatches(visit, filters.q)
  );
  const page = filtered.slice(filters.cursor, filters.cursor + filters.limit).map(publicVisit);
  const nextOffset = filters.cursor + page.length;
  return {
    planDate: date,
    filters,
    visits: page,
    count: filtered.length,
    nextCursor: nextOffset < filtered.length ? nextOffset : null,
    facets: visitFacets(allVisits)
  };
}

async function rawVisitByRecordId(recordId) {
  const record = (await query(
    `SELECT * FROM driver_job_records WHERE id = $1`,
    [recordId]
  )).rows[0];
  if (!record || !PHYSICAL_STOP_TYPES.has(String(record.stop_type || "").toLowerCase())) {
    throw repositoryError("The Driver physical visit was not found.", 404, "DRIVER_COMPLETED_VISIT_NOT_FOUND");
  }
  const date = planDateValue(record.plan_date);
  // This helper is also used inside append transactions. Keep these reads
  // sequential so one transaction-bound pg client never receives overlapping
  // queries.
  const rows = await rowsForPlanDate(date);
  const events = await additionsForPlanDate(date);
  const visit = buildVisits(rows, events).find((candidate) => candidate.recordIds.includes(recordId));
  if (!visit) {
    throw repositoryError("The Driver physical visit was not found.", 404, "DRIVER_COMPLETED_VISIT_NOT_FOUND");
  }
  return visit;
}

function assertStateHash(visit, expectedStateHash) {
  const expected = requiredText(expectedStateHash, "Expected state hash", 64).toLowerCase();
  if (!SHA256_PATTERN.test(expected)) {
    throw repositoryError("Expected state hash is invalid.", 400, "DRIVER_COMPLETED_VISIT_STATE_HASH_INVALID");
  }
  if (visit.stateHash !== expected) {
    throw repositoryError(
      "This completed visit changed after it was loaded. Refresh and review the current photos.",
      409,
      "DRIVER_COMPLETED_VISIT_STALE"
    );
  }
}

export async function getDriverCompletedVisit({ recordId, expectedStateHash = "" } = {}) {
  const id = recordIdValue(recordId);
  const visit = await rawVisitByRecordId(id);
  if (expectedStateHash) {
    assertStateHash(visit, expectedStateHash);
  }
  return publicVisit(visit);
}

async function additionReplay(requestId) {
  return (await query(
    `SELECT * FROM driver_job_photo_addition_events WHERE request_id = $1::uuid LIMIT 1`,
    [requestId]
  )).rows[0] || null;
}

function replayScalarMatches(expected, actual) {
  return expected === null || String(actual) === String(expected);
}

function replayPhotosMatch(expected, actual) {
  return expected === null || JSON.stringify(actual) === JSON.stringify(expected);
}

function replayPayloadMatches(row, {
  reason = null,
  expectedStateHash = null,
  photoReferences = null
}) {
  return replayScalarMatches(reason, row.reason)
    && replayScalarMatches(expectedStateHash, row.expected_state_hash)
    && replayPhotosMatch(photoReferences, row.photo_references);
}

function replayResult(row, input) {
  if (!row) {
    return null;
  }
  const { recordId, actorId } = input;
  const recordIds = Array.isArray(row.physical_visit_record_ids)
    ? row.physical_visit_record_ids.map(Number)
    : [];
  const sameRecord = recordIds.includes(Number(recordId));
  const sameActor = String(row.actor_operator_id) === String(actorId);
  if (!sameRecord || !sameActor || !replayPayloadMatches(row, input)) {
    throw repositoryError(
      "This request ID was already used for different completed-stop evidence.",
      409,
      "DRIVER_COMPLETED_PHOTO_REQUEST_CONFLICT"
    );
  }
  return { ...(row.result || {}), exactReplay: true };
}

export async function getDriverCompletedPhotoReplay({
  requestId,
  recordId,
  actorId,
  reason = null,
  expectedStateHash = null,
  photoReferences = null
} = {}) {
  const requestUuid = uuidValue(requestId, "Request ID");
  const id = recordIdValue(recordId);
  const operatorId = requiredText(actorId, "Dispatcher ID", 240);
  return replayResult(await additionReplay(requestUuid), {
    recordId: id,
    actorId: operatorId,
    reason,
    expectedStateHash,
    photoReferences
  });
}

function assertAppendable(visit) {
  if (!visit.declarationValid) {
    throw repositoryError(visit.blockReason, 409, visit.blockCode, { missingJobIds: visit.missingJobIds });
  }
  if (visit.status !== "complete") {
    throw repositoryError(
      "Photos can be appended only after every member of the physical visit is complete.",
      409,
      "DRIVER_COMPLETED_VISIT_NOT_COMPLETE"
    );
  }
}

export async function appendDriverCompletedVisitPhotos({
  recordId,
  expectedStateHash,
  requestId,
  additionEventId = crypto.randomUUID(),
  actorId,
  actorName,
  reason,
  photos = []
} = {}) {
  const id = recordIdValue(recordId);
  const requestUuid = uuidValue(requestId, "Request ID");
  const eventUuid = uuidValue(additionEventId, "Addition event ID");
  const operatorId = requiredText(actorId, "Dispatcher ID", 240);
  const operatorName = requiredText(actorName || actorId, "Dispatcher name", 240);
  const auditReason = requiredText(reason, "Reason", 2000);
  const stateHash = requiredText(expectedStateHash, "Expected state hash", 64).toLowerCase();
  if (!SHA256_PATTERN.test(stateHash)) {
    throw repositoryError("Expected state hash is invalid.", 400, "DRIVER_COMPLETED_VISIT_STATE_HASH_INVALID");
  }
  const descriptors = normalizeDriverCompletedPhotoDescriptors(photos, { requireReferences: true });
  if (!descriptors.length) {
    throw repositoryError("Select at least one photo to append.", 400, "DRIVER_COMPLETED_PHOTO_REQUIRED");
  }
  const addedReferences = uniqueDriverPhotoReferences(descriptors.map((photo) => photo.objectReference));
  if (addedReferences.length !== descriptors.length) {
    throw repositoryError(
      "Every appended photo must have one distinct durable reference.",
      400,
      "DRIVER_COMPLETED_PHOTO_REFERENCE_INVALID"
    );
  }
  const replayInput = {
    recordId: id,
    actorId: operatorId,
    reason: auditReason,
    expectedStateHash: stateHash,
    photoReferences: addedReferences
  };

  return withTransaction(async () => {
    const firstReplay = replayResult(await additionReplay(requestUuid), replayInput);
    if (firstReplay) {
      return firstReplay;
    }
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const serializedReplay = replayResult(await additionReplay(requestUuid), replayInput);
    if (serializedReplay) {
      return serializedReplay;
    }

    let visit = await rawVisitByRecordId(id);
    await query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      visit.driverLogin,
      visit.planDate
    ]);
    await query(
      `SELECT id
         FROM driver_job_records
        WHERE id = ANY($1::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [visit.recordIds]
    );
    visit = await rawVisitByRecordId(id);
    assertStateHash(visit, stateHash);
    assertAppendable(visit);
    const recordType = visit.stopType === "pickup" ? "driver-pickup-photo" : "driver-dropoff-photo";
    for (const photo of descriptors) {
      if (!driverCompletedPhotoReferenceMatches(photo.objectReference, {
        requestId: requestUuid,
        photoId: photo.photoId,
        recordType
      })) {
        throw repositoryError(
          "An uploaded photo does not belong to this completed-stop request.",
          409,
          "DRIVER_COMPLETED_PHOTO_REFERENCE_INVALID"
        );
      }
      if (visit.photoReferences.includes(photo.objectReference)) {
        throw repositoryError(
          "This photo is already attached to the physical visit.",
          409,
          "DRIVER_COMPLETED_PHOTO_ALREADY_ATTACHED"
        );
      }
    }
    const merged = mergeDriverCompletedVisitPhotos({
      existing: visit.photoReferences,
      added: addedReferences
    });
    const updated = await query(
      `UPDATE driver_job_records
          SET photo_data_urls = $2::jsonb
        WHERE id = ANY($1::bigint[])
        RETURNING *`,
      [visit.recordIds, JSON.stringify(merged)]
    );
    if (updated.rowCount !== visit.recordIds.length) {
      throw repositoryError(
        "The physical visit changed while its photos were being saved.",
        409,
        "DRIVER_COMPLETED_VISIT_STALE"
      );
    }
    const allRowsByJobId = new Map(updated.rows.map((row) => [String(row.job_id), row]));
    const afterVisit = buildVisit(updated.rows, allRowsByJobId);
    const result = {
      additionEventId: eventUuid,
      requestId: requestUuid,
      recordId: visit.recordId,
      recordIds: visit.recordIds,
      jobId: visit.jobId,
      jobIds: visit.jobIds,
      driverLogin: visit.driverLogin,
      planId: visit.planId,
      planDate: visit.planDate,
      stopType: visit.stopType,
      beforePhotoCount: visit.photoCount,
      addedPhotoCount: addedReferences.length,
      photoCount: merged.length,
      photos: merged,
      stateHash: afterVisit.stateHash,
      completed: true
    };
    await query(
      `INSERT INTO driver_job_photo_addition_events (
         addition_event_id, request_id, actor_operator_id, actor_name,
         driver_login, plan_id, plan_date,
         primary_driver_job_record_id, primary_job_id,
         physical_visit_record_ids, physical_visit_job_ids, stop_type,
         photo_references, photo_descriptors, reason,
         before_photo_count, after_photo_count, expected_state_hash, result
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         $5, $6, $7::date,
         $8, $9,
         $10::jsonb, $11::jsonb, $12,
         $13::jsonb, $14::jsonb, $15,
         $16, $17, $18, $19::jsonb
       )`,
      [
        eventUuid,
        requestUuid,
        operatorId,
        operatorName,
        visit.driverLogin,
        visit.planId,
        visit.planDate,
        visit.recordId,
        visit.jobId,
        JSON.stringify(visit.recordIds),
        JSON.stringify(visit.jobIds),
        visit.stopType,
        JSON.stringify(addedReferences),
        JSON.stringify(descriptors),
        auditReason,
        visit.photoCount,
        merged.length,
        stateHash,
        JSON.stringify(result)
      ]
    );
    await writeDispatchAudit({
      action: "driver_pwa_completed_stop_photos_added",
      entityType: "driver_job",
      entityId: visit.jobId,
      loadId: visit.loadId,
      truckId: visit.truckId,
      planId: visit.planId,
      planDate: visit.planDate,
      operatorId,
      operatorName,
      source: "dispatch_stop_evidence",
      before: {
        stateHash: visit.stateHash,
        photoReferences: visit.photoReferences
      },
      after: {
        stateHash: afterVisit.stateHash,
        photoReferences: merged
      },
      details: {
        additionEventId: eventUuid,
        requestId: requestUuid,
        reason: auditReason,
        driverLogin: visit.driverLogin,
        physicalVisitRecordIds: visit.recordIds,
        physicalVisitJobIds: visit.jobIds,
        addedPhotoCount: addedReferences.length,
        beforePhotoCount: visit.photoCount,
        afterPhotoCount: merged.length
      }
    });
    return result;
  });
}
