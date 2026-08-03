import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { getDriverDayJobs } from "./driver-repository.js";
import { supersedeDriverOfflineManifests } from "./driver-offline-repository.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const REOPENABLE_STOP_TYPES = new Set(["pickup", "dropoff", "pick", "drop"]);
const ACTIVE_JOB_STATUSES = new Set(["in_progress", "complete"]);
const RESTARTABLE_STOP_STATUSES = new Set(["in_progress", "complete"]);
const NONTERMINAL_OFFLINE_STATUSES = [
  "registered",
  "waiting_photos",
  "pending",
  "applying",
  "review_required",
  "blocked",
  "resolution_pending"
];

function pwaError(message, status = 400, code = "DRIVER_PWA_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function requiredText(value, label, maxLength = 2000) {
  const text = String(value ?? "").trim();
  if (!text) throw pwaError(`${label} is required.`);
  if (text.length > maxLength) throw pwaError(`${label} is too long.`);
  return text;
}

function uuidValue(value, label) {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!UUID_PATTERN.test(text)) throw pwaError(`${label} must be a UUID.`);
  return text;
}

function planDateValue(value) {
  if (!value) return "";
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw pwaError("Plan date must use YYYY-MM-DD.");
  return text;
}

function normalizeForHash(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeForHash(value[key])])
    );
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}

function locationFromJob(job = {}) {
  return String(
    job.location
    || job.pickupLocation
    || job.dropLocation
    || job.toLocation
    || ""
  ).trim();
}

function recordEvidenceSnapshot(row = {}) {
  return {
    id: Number(row.id),
    jobId: row.job_id,
    planId: row.plan_id,
    planDate: planDateValue(row.plan_date),
    driverLogin: row.driver_login,
    truckId: row.truck_id || "",
    truckPlate: row.truck_plate || "",
    loadId: row.load_id || "",
    loadName: row.load_name || "",
    stopId: row.stop_id || "",
    stopType: row.stop_type || "",
    orderRefs: Array.isArray(row.order_refs) ? row.order_refs : [],
    photoDataUrls: Array.isArray(row.photo_data_urls) ? row.photo_data_urls : [],
    status: row.status || "",
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    jobDetails: row.job_details || {},
    sourceOfflineEventId: row.source_offline_event_id || null,
    deviceOccurredAt: row.device_occurred_at || null,
    serverReceivedAt: row.server_received_at || null,
    serverAppliedAt: row.server_applied_at || null,
    locationStatus: row.location_status || "",
    locationDetails: row.location_details || {},
    createdAt: row.created_at || null
  };
}

export function driverPwaStopStateHash(record = {}) {
  const row = record.job_id !== undefined ? recordEvidenceSnapshot(record) : record;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizeForHash(row)))
    .digest("hex");
}

export function validateDriverPwaStopReopen({
  record,
  routeIndex = -1,
  laterJobs = [],
  nonterminalOfflineCount = 0,
  targetNonterminalOfflineCount = 0,
  activeRestCount = 0,
  attentionTruckSwitchCount = 0,
  executingForegroundCount = 0
} = {}) {
  if (!record?.jobId && !record?.job_id) {
    return { allowed: false, code: "DRIVER_PWA_STOP_NOT_FOUND", reason: "Driver stop was not found." };
  }
  const stopType = String(record.stopType || record.stop_type || "").toLowerCase();
  if (!REOPENABLE_STOP_TYPES.has(stopType)) {
    return { allowed: false, code: "DRIVER_PWA_STOP_TYPE_BLOCKED", reason: "Only pickup and drop-off stops can be reopened." };
  }
  if (!RESTARTABLE_STOP_STATUSES.has(String(record.status || "").toLowerCase())) {
    return { allowed: false, code: "DRIVER_PWA_STOP_NOT_RESTARTABLE", reason: "Only an in-progress or completed driver stop can be restarted." };
  }
  if (routeIndex < 0) {
    return { allowed: false, code: "DRIVER_PWA_STOP_NO_LONGER_ASSIGNED", reason: "This stop is no longer part of the driver's current confirmed route." };
  }
  const laterActive = (laterJobs || []).find((job) => ACTIVE_JOB_STATUSES.has(String(job?.status || "").toLowerCase()));
  if (laterActive) {
    return {
      allowed: false,
      code: "DRIVER_PWA_LATER_STOP_ACTIVE",
      reason: `Undo the newer driver activity first (${laterActive.loadName || laterActive.location || laterActive.jobId || "later stop"}).`
    };
  }
  if (Number(activeRestCount) > 0) {
    return { allowed: false, code: "DRIVER_PWA_ACTIVE_REST", reason: "End the driver's active rest before reopening a stop." };
  }
  if (Number(attentionTruckSwitchCount) > 0) {
    return { allowed: false, code: "DRIVER_PWA_TRUCK_SWITCH_ATTENTION", reason: "Resolve the driver's truck-switch attention before reopening a stop." };
  }
  if (Number(executingForegroundCount) > 0) {
    return { allowed: false, code: "DRIVER_PWA_ACTION_EXECUTING", reason: "A Driver PWA action is still being applied. Wait and refresh." };
  }
  const unrelatedOfflineCount = Math.max(
    0,
    Number(nonterminalOfflineCount || 0) - Number(targetNonterminalOfflineCount || 0)
  );
  if (unrelatedOfflineCount > 0) {
    return { allowed: false, code: "DRIVER_PWA_UNSYNCED_SERVER_EVENTS", reason: "Synchronize or resolve the driver's pending offline records before reopening a stop." };
  }
  return { allowed: true, code: "", reason: "" };
}

function mappedStop(row, currentJob = null, validation = null, correction = null, pendingOfflineRecordCount = 0) {
  const evidence = recordEvidenceSnapshot(row);
  const storedLocation = locationFromJob(evidence.jobDetails);
  const currentLocation = locationFromJob(currentJob || {});
  const stateHash = driverPwaStopStateHash(evidence);
  const recordedJob = {
    jobId: evidence.jobId,
    location: storedLocation,
    address: String(evidence.jobDetails?.address || ""),
    loadName: evidence.loadName,
    stopType: evidence.stopType,
    status: evidence.status
  };
  return {
    id: evidence.id,
    recordId: evidence.id,
    jobId: evidence.jobId,
    planId: evidence.planId,
    planDate: evidence.planDate,
    driverLogin: evidence.driverLogin,
    truckPlate: evidence.truckPlate,
    loadId: evidence.loadId,
    loadName: evidence.loadName,
    stopId: evidence.stopId,
    stopType: evidence.stopType,
    orderRefs: evidence.orderRefs,
    status: evidence.status,
    arrivalTime: evidence.startedAt,
    arrivalAt: evidence.startedAt,
    leaveTime: evidence.completedAt,
    leaveAt: evidence.completedAt,
    photoCount: evidence.photoDataUrls.length,
    driverRemark: String(evidence.jobDetails?.driverRemark || ""),
    locationStatus: evidence.locationStatus,
    storedLocation,
    recordedLocation: storedLocation,
    currentLocation,
    currentAddress: String(currentJob?.address || ""),
    routeChanged: Boolean(currentLocation && storedLocation && currentLocation !== storedLocation),
    recordedJob,
    currentJob: currentJob ? {
      jobId: currentJob.jobId,
      location: currentLocation,
      address: currentJob.address || "",
      loadName: currentJob.loadName || "",
      stopType: currentJob.stopType || "",
      status: currentJob.status || ""
    } : null,
    stateHash,
    expectedStateHash: stateHash,
    canReopen: validation?.allowed === true,
    reopenBlockCode: validation?.code || "",
    reopenBlockReason: validation?.reason || "",
    blockReasons: validation?.allowed === false && validation?.reason ? [validation.reason] : [],
    pendingOfflineRecordCount: Math.max(0, Number(pendingOfflineRecordCount || 0)),
    lastCorrection: correction ? {
      correctionId: correction.correction_id,
      action: correction.action,
      auditNote: correction.audit_note,
      correctedBy: correction.corrected_by,
      createdAt: correction.created_at
    } : null
  };
}

async function driverDayBlockers(driverLogin, planDate) {
  const [offline, rest, truckSwitch, foreground] = await Promise.all([
    query(
      `SELECT event_id, original_job_id, status
         FROM driver_offline_events
        WHERE lower(driver_login) = lower($1)
          AND plan_date = $2::date
          AND status = ANY($3::text[])`,
      [driverLogin, planDate, NONTERMINAL_OFFLINE_STATUSES]
    ),
    query(
      `SELECT COUNT(*)::int AS count
         FROM driver_rest_records
        WHERE lower(driver_login) = lower($1)
          AND plan_date = $2::date
          AND status = 'active'
          AND ended_at IS NULL`,
      [driverLogin, planDate]
    ),
    query(
      `SELECT COUNT(*)::int AS count
         FROM driver_truck_switch_records
        WHERE lower(driver_login) = lower($1)
          AND plan_date = $2::date
          AND status = 'attention'`,
      [driverLogin, planDate]
    ),
    query(
      `SELECT COUNT(*)::int AS count
         FROM driver_foreground_action_receipts
        WHERE lower(driver_login) = lower($1)
          AND event_context->>'planDate' = $2
          AND status = 'executing'`,
      [driverLogin, planDate]
    )
  ]);
  return {
    nonterminalOfflineCount: offline.rows.length,
    nonterminalOfflineEvents: offline.rows.map((row) => ({
      eventId: row.event_id,
      originalJobId: row.original_job_id || "",
      status: row.status
    })),
    activeRestCount: Number(rest.rows[0]?.count || 0),
    attentionTruckSwitchCount: Number(truckSwitch.rows[0]?.count || 0),
    executingForegroundCount: Number(foreground.rows[0]?.count || 0)
  };
}

async function currentDriverDayContext(driverLogin, planDate) {
  const [route, blockers] = await Promise.all([
    getDriverDayJobs(driverLogin, { date: planDate }),
    driverDayBlockers(driverLogin, planDate)
  ]);
  return { route, blockers };
}

export async function listDriverPwaStops({ planDate = "", driverLogin = "", limit = 200 } = {}) {
  const date = planDateValue(planDate);
  const login = String(driverLogin || "").trim().toLowerCase();
  const cleanLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const result = await query(
    `SELECT r.*, c.correction_id, c.action AS correction_action,
            c.audit_note AS correction_audit_note,
            c.corrected_by AS correction_corrected_by,
            c.created_at AS correction_created_at
       FROM driver_job_records r
       LEFT JOIN LATERAL (
         SELECT correction_id, action, audit_note, corrected_by, created_at
           FROM driver_job_corrections
          WHERE driver_job_record_id = r.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) c ON true
      WHERE lower(COALESCE(r.stop_type, '')) IN ('pickup', 'dropoff', 'pick', 'drop')
        AND ($1 = '' OR r.plan_date = NULLIF($1, '')::date)
        AND ($2 = '' OR lower(r.driver_login) = lower($2))
        AND ($1 <> '' OR r.plan_date >= (CURRENT_DATE - INTERVAL '14 days')::date)
      ORDER BY r.plan_date DESC, COALESCE(r.completed_at, r.started_at, r.created_at) DESC, r.id DESC
      LIMIT $3`,
    [date, login, cleanLimit]
  );
  const contexts = new Map();
  const contextFor = async (row) => {
    const key = `${String(row.driver_login).toLowerCase()}::${planDateValue(row.plan_date)}`;
    if (!contexts.has(key)) {
      contexts.set(key, currentDriverDayContext(row.driver_login, planDateValue(row.plan_date)));
    }
    return contexts.get(key);
  };
  const stops = [];
  for (const row of result.rows) {
    const { route, blockers } = await contextFor(row);
    const routeIndex = (route.jobs || []).findIndex((job) => String(job.jobId) === String(row.job_id));
    const currentJob = routeIndex >= 0 ? route.jobs[routeIndex] : null;
    const targetNonterminalOfflineCount = blockers.nonterminalOfflineEvents.filter(
      (event) => String(event.originalJobId) === String(row.job_id)
    ).length;
    const validation = validateDriverPwaStopReopen({
      record: recordEvidenceSnapshot(row),
      routeIndex,
      laterJobs: routeIndex >= 0 ? route.jobs.slice(routeIndex + 1) : [],
      targetNonterminalOfflineCount,
      ...blockers
    });
    stops.push(mappedStop(row, currentJob, validation, row.correction_id ? {
      correction_id: row.correction_id,
      action: row.correction_action,
      audit_note: row.correction_audit_note,
      corrected_by: row.correction_corrected_by,
      created_at: row.correction_created_at
    } : null, targetNonterminalOfflineCount));
  }
  return { stops, count: stops.length };
}

async function correctionByIdempotency(idempotencyId) {
  const result = await query(
    `SELECT * FROM driver_job_corrections WHERE idempotency_id = $1::uuid LIMIT 1`,
    [idempotencyId]
  );
  return result.rows[0] || null;
}

function exactRetry(existing, action, recordId) {
  if (!existing) return null;
  if (existing.action !== action || Number(existing.driver_job_record_id) !== Number(recordId)) {
    throw pwaError(
      "This idempotency ID was already used for a different Driver PWA correction.",
      409,
      "DRIVER_PWA_IDEMPOTENCY_CONFLICT"
    );
  }
  return { ...(existing.result || {}), exactRetry: true };
}

async function lockedDriverJobRecord(recordId) {
  const result = await query(
    `SELECT * FROM driver_job_records WHERE id = $1 FOR UPDATE`,
    [recordId]
  );
  if (!result.rowCount) throw pwaError("Driver stop was not found.", 404, "DRIVER_PWA_STOP_NOT_FOUND");
  return result.rows[0];
}

function assertExpectedState(row, expectedStateHash) {
  const expected = requiredText(expectedStateHash, "Expected state hash", 64).toLowerCase();
  if (!SHA256_PATTERN.test(expected)) throw pwaError("Expected state hash is invalid.");
  const current = driverPwaStopStateHash(row);
  if (current !== expected) {
    throw pwaError(
      "This driver stop changed after it was loaded. Refresh Driver PWA and review it again.",
      409,
      "DRIVER_PWA_STALE_STOP"
    );
  }
  return current;
}

async function insertCorrection({
  correctionId,
  idempotencyId,
  action,
  row,
  targetJobId = "",
  targetLocation = "",
  expectedStateHash,
  auditNote,
  correctedBy,
  before,
  after,
  result
}) {
  await query(
    `INSERT INTO driver_job_corrections (
       correction_id, idempotency_id, action, driver_job_record_id,
       job_id, plan_id, plan_date, driver_login, load_id, stop_id, stop_type,
       target_job_id, target_location, expected_state_hash, audit_note,
       corrected_by, before_state, after_state, result
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4,
       $5, $6, $7::date, $8, $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17::jsonb, $18::jsonb, $19::jsonb
     )`,
    [
      correctionId,
      idempotencyId,
      action,
      row.id,
      row.job_id,
      row.plan_id,
      row.plan_date,
      row.driver_login,
      row.load_id || "",
      row.stop_id || "",
      row.stop_type || "",
      targetJobId,
      targetLocation,
      expectedStateHash,
      auditNote,
      correctedBy,
      JSON.stringify(before),
      JSON.stringify(after),
      JSON.stringify(result)
    ]
  );
}

async function refreshLoadExecution(route, row) {
  const expected = (route.jobs || []).filter((job) => String(job.loadId) === String(row.load_id));
  if (!expected.length) return;
  const statuses = await query(
    `SELECT job_id, status
       FROM driver_job_records
      WHERE job_id = ANY($1::text[])`,
    [expected.map((job) => job.jobId)]
  );
  const statusById = new Map(statuses.rows.map((item) => [String(item.job_id), String(item.status)]));
  const started = expected.some((job) => ACTIVE_JOB_STATUSES.has(statusById.get(String(job.jobId))));
  const completed = expected.every((job) => statusById.get(String(job.jobId)) === "complete");
  await query(
    `UPDATE dispatch_plan_load_assignments
        SET started = $3, completed = $4, updated_at = now()
      WHERE plan_id = $1 AND load_id = $2`,
    [row.plan_id, row.load_id || "", started, completed]
  );
}

export async function reopenDriverPwaStop({
  recordId,
  expectedStateHash,
  auditNote,
  idempotencyId,
  reopenedBy
} = {}) {
  const id = Number(recordId);
  if (!Number.isSafeInteger(id) || id < 1) throw pwaError("Driver stop ID is invalid.");
  const idem = uuidValue(idempotencyId, "Idempotency ID");
  const note = requiredText(auditNote, "Audit note");
  const actor = requiredText(reopenedBy, "Dispatcher name", 240);
  return withTransaction(async () => {
    const prior = exactRetry(await correctionByIdempotency(idem), "reopen", id);
    if (prior) return prior;
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const serializedPrior = exactRetry(await correctionByIdempotency(idem), "reopen", id);
    if (serializedPrior) return serializedPrior;
    const row = await lockedDriverJobRecord(id);
    await query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      String(row.driver_login).toLowerCase(),
      planDateValue(row.plan_date)
    ]);
    const stateHash = assertExpectedState(row, expectedStateHash);
    const { route, blockers } = await currentDriverDayContext(row.driver_login, planDateValue(row.plan_date));
    const routeIndex = (route.jobs || []).findIndex((job) => String(job.jobId) === String(row.job_id));
    const currentJob = routeIndex >= 0 ? route.jobs[routeIndex] : null;
    const validation = validateDriverPwaStopReopen({
      record: recordEvidenceSnapshot(row),
      routeIndex,
      laterJobs: routeIndex >= 0 ? route.jobs.slice(routeIndex + 1) : [],
      targetNonterminalOfflineCount: blockers.nonterminalOfflineEvents.filter(
        (event) => String(event.originalJobId) === String(row.job_id)
      ).length,
      ...blockers
    });
    if (!validation.allowed) throw pwaError(validation.reason, 409, validation.code);

    const correctionId = crypto.randomUUID();
    const wasInProgress = String(row.status || "").toLowerCase() === "in_progress";
    const before = recordEvidenceSnapshot(row);
    const replacementDetails = {
      ...(currentJob || {}),
      reopenedByCorrectionId: correctionId,
      reopenedAt: new Date().toISOString()
    };
    const updated = await query(
      `UPDATE driver_job_records
          SET status = 'pending',
              started_at = NULL,
              completed_at = NULL,
              photo_data_urls = '[]'::jsonb,
              job_details = $2::jsonb,
              source_offline_event_id = NULL,
              device_occurred_at = NULL,
              server_received_at = NULL,
              server_applied_at = NULL,
              location_status = NULL,
              location_details = '{}'::jsonb
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(replacementDetails)]
    );
    const after = recordEvidenceSnapshot(updated.rows[0]);
    await refreshLoadExecution(route, row);
    await supersedeDriverOfflineManifests({
      driverLogin: row.driver_login,
      planDate: planDateValue(row.plan_date)
    });
    const suppressed = await query(
      `UPDATE driver_offline_events
          SET status = 'evidence_only',
              review_reason = '',
              application_result = COALESCE(application_result, '{}'::jsonb) || $4::jsonb,
              server_applied_at = COALESCE(server_applied_at, now()),
              case_version = case_version + 1,
              updated_at = now()
        WHERE lower(driver_login) = lower($1)
          AND plan_date = $2::date
          AND original_job_id = $3
          AND status = ANY($5::text[])
        RETURNING event_id`,
      [
        row.driver_login,
        planDateValue(row.plan_date),
        row.job_id,
        JSON.stringify({
          supersededByDriverPwaCorrectionId: correctionId,
          disposition: "evidence_only",
          reason: "Dispatcher restarted this stop after the saved event was captured."
        }),
        NONTERMINAL_OFFLINE_STATUSES
      ]
    );
    const response = {
      correctionId,
      action: "reopen",
      recordId: id,
      jobId: row.job_id,
      driverLogin: row.driver_login,
      planDate: planDateValue(row.plan_date),
      status: "pending",
      previousStatus: row.status,
      suppressedOfflineRecordCount: suppressed.rowCount,
      message: wasInProgress
        ? "In-progress driver stop restarted. Ask the driver to synchronize and refresh the saved route before performing it again."
        : "Driver stop reopened. Ask the driver to synchronize and refresh the saved route before repeating it."
    };
    await insertCorrection({
      correctionId,
      idempotencyId: idem,
      action: "reopen",
      row,
      targetJobId: currentJob?.jobId || row.job_id,
      targetLocation: locationFromJob(currentJob || {}),
      expectedStateHash: stateHash,
      auditNote: note,
      correctedBy: actor,
      before,
      after,
      result: response
    });
    await writeDispatchAudit({
      action: "driver_pwa_stop_reopened",
      entityType: "driver_job",
      entityId: row.job_id,
      loadId: row.load_id,
      truckId: row.truck_id,
      planId: row.plan_id,
      planDate: planDateValue(row.plan_date),
      operatorName: actor,
      source: "driver_pwa",
      before,
      after,
      details: {
        correctionId,
        idempotencyId: idem,
        auditNote: note,
        previousStatus: row.status,
        suppressedOfflineRecordCount: suppressed.rowCount
      }
    });
    return response;
  });
}

export async function mapDriverPwaStopRecord({
  recordId,
  targetLocation,
  targetAddress = "",
  expectedStateHash,
  auditNote,
  idempotencyId,
  correctedBy
} = {}) {
  const id = Number(recordId);
  if (!Number.isSafeInteger(id) || id < 1) throw pwaError("Driver stop ID is invalid.");
  const idem = uuidValue(idempotencyId, "Idempotency ID");
  const location = requiredText(targetLocation, "Target location", 240);
  const address = String(targetAddress || "").trim().slice(0, 1000);
  const note = requiredText(auditNote, "Audit note");
  const actor = requiredText(correctedBy, "Corrector name", 240);
  return withTransaction(async () => {
    const prior = exactRetry(await correctionByIdempotency(idem), "map_location", id);
    if (prior) return prior;
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const serializedPrior = exactRetry(await correctionByIdempotency(idem), "map_location", id);
    if (serializedPrior) return serializedPrior;
    const row = await lockedDriverJobRecord(id);
    await query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      String(row.driver_login).toLowerCase(),
      planDateValue(row.plan_date)
    ]);
    const stateHash = assertExpectedState(row, expectedStateHash);
    const before = recordEvidenceSnapshot(row);
    const details = { ...(row.job_details || {}), location };
    if (["pickup", "pick"].includes(String(row.stop_type).toLowerCase())) {
      details.pickupLocation = location;
    } else if (["dropoff", "drop"].includes(String(row.stop_type).toLowerCase())) {
      details.dropLocation = location;
    }
    if (address) details.address = address;
    const updated = await query(
      `UPDATE driver_job_records
          SET job_details = $2::jsonb
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(details)]
    );
    const after = recordEvidenceSnapshot(updated.rows[0]);
    await supersedeDriverOfflineManifests({
      driverLogin: row.driver_login,
      planDate: planDateValue(row.plan_date)
    });
    const correctionId = crypto.randomUUID();
    const response = {
      correctionId,
      action: "map_location",
      recordId: id,
      jobId: row.job_id,
      driverLogin: row.driver_login,
      planDate: planDateValue(row.plan_date),
      targetLocation: location,
      arrivalTime: row.started_at,
      leaveTime: row.completed_at,
      photoCount: before.photoDataUrls.length,
      message: `Existing arrival, leave, location evidence, and photos were mapped to ${location}.`
    };
    await insertCorrection({
      correctionId,
      idempotencyId: idem,
      action: "map_location",
      row,
      targetJobId: row.job_id,
      targetLocation: location,
      expectedStateHash: stateHash,
      auditNote: note,
      correctedBy: actor,
      before,
      after,
      result: response
    });
    await writeDispatchAudit({
      action: "driver_pwa_stop_location_mapped",
      entityType: "driver_job",
      entityId: row.job_id,
      orderId: (Array.isArray(row.order_refs) ? row.order_refs : [])[0] || null,
      loadId: row.load_id,
      truckId: row.truck_id,
      planId: row.plan_id,
      planDate: planDateValue(row.plan_date),
      operatorName: actor,
      source: "driver_pwa_repair",
      before,
      after,
      details: { correctionId, idempotencyId: idem, targetLocation: location, auditNote: note }
    });
    return response;
  });
}
