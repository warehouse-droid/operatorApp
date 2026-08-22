import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { getDriverPlanRoutesForDate } from "./driver-repository.js";
import {
  historicalAssistPhotoReferenceMatches,
  historicalAssistStateHash,
  normalizeHistoricalAssistPhotoDescriptors
} from "./driver-historical-assist-evidence.js";
import {
  assertHistoricalAssistPlanDate,
  buildHistoricalAssistPhysicalVisits,
  HISTORICAL_ASSIST_MAX_PHOTOS,
  validateHistoricalAssistChronology
} from "./driver-historical-assist-policy.js";

export {
  historicalAssistPhotoReferenceMatches,
  historicalAssistStateHash,
  normalizeHistoricalAssistPhotoDescriptors
} from "./driver-historical-assist-evidence.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONTERMINAL_OFFLINE_STATUSES = [
  "registered",
  "waiting_photos",
  "pending",
  "applying",
  "review_required",
  "blocked",
  "resolution_pending"
];

function assistError(message, status = 400, code = "HISTORICAL_ASSIST_INVALID", details = {}) {
  return Object.assign(new Error(message), { status, code, ...details });
}

function requiredText(value, label, maxLength = 2000) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw assistError(`${label} is required.`);
  }
  if (text.length > maxLength) {
    throw assistError(`${label} is too long.`);
  }
  return text;
}

function uuidValue(value, label) {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!UUID_PATTERN.test(text)) {
    throw assistError(`${label} must be a UUID.`);
  }
  return text;
}

function jobRecordState(job) {
  return {
    jobId: String(job?.jobId || ""),
    status: String(job?.status || "pending"),
    startedAt: job?.startedAt || null,
    completedAt: job?.completedAt || null
  };
}

function clientSyncCount(value) {
  const count = Number(value);
  if (Number.isFinite(count) && count >= 0) {
    return Math.floor(count);
  }
  return value === undefined || value === null || value === "" ? 0 : 1;
}

function clientSyncIssue(row) {
  const status = row.sync_status && typeof row.sync_status === "object" ? row.sync_status : {};
  return {
    sessionId: row.session_id,
    driverLogin: row.driver_login,
    deviceId: row.device_id,
    state: status.state || "error",
    errorName: status.errorName || "",
    errorCode: status.errorCode || "",
    errorMessage: status.errorMessage || "Driver device reports retained offline work.",
    manifestId: status.manifestId || "",
    planDate: status.planDate || "",
    pendingEventCount: clientSyncCount(status.pendingEventCount),
    reviewRequiredCount: clientSyncCount(status.reviewRequiredCount),
    unsyncedPhotoCount: clientSyncCount(status.unsyncedPhotoCount),
    reportedAt: status.serverReceivedAt || ""
  };
}

async function latestClientSyncSignals(driverLogins, planDate) {
  const result = await query(
    `WITH ranked_sessions AS (
       SELECT session_id,
              lower(driver_login) AS driver_login,
              device_id,
              metadata->'offlineSync' AS sync_status,
              ROW_NUMBER() OVER (
                PARTITION BY lower(driver_login), device_id
                ORDER BY created_at DESC, session_id DESC
              ) AS session_rank
         FROM driver_sessions
        WHERE lower(driver_login) = ANY($1::text[])
          AND device_id <> ''
          AND revoked_at IS NULL
          AND expires_at > now()
     )
     SELECT session_id, driver_login, device_id, sync_status
       FROM ranked_sessions
      WHERE session_rank = 1
        AND jsonb_typeof(sync_status) = 'object'
        AND sync_status->>'planDate' = $2
        AND COALESCE(sync_status->'dispatchDismissal'->>'reportReceivedAt', '')
              <> COALESCE(sync_status->>'serverReceivedAt', '')`,
    [driverLogins, planDate]
  );
  return result.rows
    .map(clientSyncIssue)
    .filter((issue) => issue.pendingEventCount
      || issue.reviewRequiredCount
      || issue.unsyncedPhotoCount);
}

async function routeSafetyState(driverLogins, planDate) {
  if (!driverLogins.length) {
    return new Map();
  }
  const lowered = driverLogins.map((login) => String(login).toLowerCase());
  // This function is also called while the assist transaction owns one pg
  // client. Keep its reads sequential so concurrent safety checks never issue
  // overlapping queries on that transaction client.
  const offline = await query(
    `SELECT lower(driver_login) AS driver_login, COUNT(*)::int AS count
       FROM driver_offline_events
      WHERE lower(driver_login) = ANY($1::text[])
        AND plan_date = $2::date
        AND status = ANY($3::text[])
      GROUP BY lower(driver_login)`,
    [lowered, planDate, NONTERMINAL_OFFLINE_STATUSES]
  );
  const foreground = await query(
    `SELECT lower(driver_login) AS driver_login, COUNT(*)::int AS count
       FROM driver_foreground_action_receipts
      WHERE lower(driver_login) = ANY($1::text[])
        AND event_context->>'planDate' = $2
        AND status = 'executing'
      GROUP BY lower(driver_login)`,
    [lowered, planDate]
  );
  const rest = await query(
    `SELECT lower(driver_login) AS driver_login, COUNT(*)::int AS count
       FROM driver_rest_records
      WHERE lower(driver_login) = ANY($1::text[])
        AND plan_date = $2::date
        AND status = 'active'
        AND ended_at IS NULL
      GROUP BY lower(driver_login)`,
    [lowered, planDate]
  );
  const truckSwitch = await query(
    `SELECT lower(driver_login) AS driver_login, COUNT(*)::int AS count
       FROM driver_truck_switch_records
      WHERE lower(driver_login) = ANY($1::text[])
        AND plan_date = $2::date
        AND status = 'attention'
      GROUP BY lower(driver_login)`,
    [lowered, planDate]
  );
  const clientIssues = await latestClientSyncSignals(lowered, planDate);
  const countMap = (rows) => new Map(rows.map((row) => [String(row.driver_login), Number(row.count || 0)]));
  const offlineByDriver = countMap(offline.rows);
  const foregroundByDriver = countMap(foreground.rows);
  const restByDriver = countMap(rest.rows);
  const switchByDriver = countMap(truckSwitch.rows);
  const clientByDriver = new Map();
  for (const issue of clientIssues) {
    const login = String(issue.driverLogin || "").toLowerCase();
    if (!clientByDriver.has(login)) {
      clientByDriver.set(login, []);
    }
    clientByDriver.get(login).push(issue);
  }
  return new Map(lowered.map((login) => {
    const blockers = [];
    if (offlineByDriver.get(login)) {
      blockers.push({
        code: "HISTORICAL_ASSIST_UNSYNCED_SERVER_EVENTS",
        message: "Resolve this driver's pending offline records in Sync Review first."
      });
    }
    if (foregroundByDriver.get(login)) {
      blockers.push({
        code: "HISTORICAL_ASSIST_FOREGROUND_EXECUTING",
        message: "A Driver PWA action is still executing. Wait and refresh."
      });
    }
    if (clientByDriver.get(login)?.length) {
      blockers.push({
        code: "HISTORICAL_ASSIST_UNSYNCED_DEVICE_EVIDENCE",
        message: "This driver's device reports unsynchronized events or photos. Open Sync Review first."
      });
    }
    const warnings = [];
    if (restByDriver.get(login)) {
      warnings.push("An old active-rest record exists; Historical completion will not change it.");
    }
    if (switchByDriver.get(login)) {
      warnings.push("Truck-switch attention exists; Historical completion will not change it.");
    }
    return [login, {
      blockers,
      warnings,
      clientSyncIssues: clientByDriver.get(login) || []
    }];
  }));
}

function firstVisitJobValue(job, keys, fallback = "") {
  const key = keys.find((candidate) => {
    const value = job?.[candidate];
    return value !== undefined && value !== null && value !== "";
  });
  return key ? job[key] : fallback;
}

function visitOrderRefs(job) {
  if (Array.isArray(job?.detailOrderRefs) && job.detailOrderRefs.length) {
    return job.detailOrderRefs;
  }
  return Array.isArray(job?.orderRefs) ? job.orderRefs : [];
}

function visitOrders(job) {
  return Array.isArray(job?.orders) ? job.orders : [];
}

function publicVisitBlockers(visit, safety) {
  const blockers = [...safety.blockers];
  if (!visit.actionable) {
    blockers.unshift({
      code: "HISTORICAL_ASSIST_EARLIER_VISIT_REQUIRED",
      message: "Complete the earlier incomplete physical visit first."
    });
  }
  return blockers;
}

function publicVisit(plan, route, visit, safety) {
  const records = visit.jobIds.map((jobId) => {
    const job = route.jobs.find((candidate) => String(candidate.jobId) === String(jobId));
    return jobRecordState(job);
  });
  const stateHash = historicalAssistStateHash({
    planId: plan.planId,
    planDate: plan.planDate,
    planRevision: plan.revision,
    driverLogin: route.driverLogin,
    jobIds: visit.jobIds,
    records
  });
  const routeBlocked = safety.blockers.length > 0;
  const job = visit.job || {};
  return {
    jobId: visit.jobIds[0],
    jobIds: visit.jobIds,
    stopId: firstVisitJobValue(job, ["stopId"]),
    stopType: firstVisitJobValue(job, ["stopType"]),
    driverLogin: route.driverLogin,
    driverName: firstVisitJobValue(route, ["driverName"], route.driverLogin),
    truckId: firstVisitJobValue(job, ["truckId"]),
    truckPlate: firstVisitJobValue(job, ["truckPlate"]),
    loadId: firstVisitJobValue(job, ["loadId"]),
    loadName: firstVisitJobValue(job, ["loadName"]),
    location: firstVisitJobValue(job, ["location", "dropLocation", "pickupLocation"]),
    address: firstVisitJobValue(job, ["address", "dropAddress"]),
    orderRefs: visitOrderRefs(job),
    orders: visitOrders(job),
    consolidatedPhysicalVisit: visit.jobIds.length > 1 || job.consolidatedPhysicalVisit === true,
    status: visit.startedAt ? "in_progress" : "pending",
    startedAt: visit.startedAt,
    previousCompletedAt: visit.previousCompletedAt,
    nextStartedAt: visit.nextStartedAt,
    nextCompletedAt: visit.nextCompletedAt,
    requiredPhotos: visit.requiredPhotos,
    maxPhotos: HISTORICAL_ASSIST_MAX_PHOTOS,
    actionable: visit.actionable && !routeBlocked,
    blockedByJobId: firstVisitJobValue(visit, ["blockedByJobId"]),
    blockers: publicVisitBlockers(visit, safety),
    warnings: safety.warnings,
    stateHash
  };
}

export async function listHistoricalDriverAssists({ planDate, now = new Date() } = {}) {
  const dateDecision = assertHistoricalAssistPlanDate(planDate, { now });
  const plan = await getDriverPlanRoutesForDate(dateDecision.planDate);
  if (!plan.planId) {
    return { ...plan, timeZone: dateDecision.timeZone, routes: [], count: 0 };
  }
  const safetyByDriver = await routeSafetyState(plan.routes.map((route) => route.driverLogin), plan.planDate);
  const routes = plan.routes.map((route) => {
    const records = Object.fromEntries(route.jobs.map((job) => [String(job.jobId), jobRecordState(job)]));
    const visits = buildHistoricalAssistPhysicalVisits(route.jobs, records);
    const safety = safetyByDriver.get(String(route.driverLogin).toLowerCase()) || {
      blockers: [], warnings: [], clientSyncIssues: []
    };
    return {
      driverLogin: route.driverLogin,
      driverName: route.driverName,
      blockers: safety.blockers,
      warnings: safety.warnings,
      clientSyncIssues: safety.clientSyncIssues,
      visits: visits.map((visit) => publicVisit(plan, route, visit, safety))
    };
  }).filter((route) => route.visits.length);
  return {
    planId: plan.planId,
    planDate: plan.planDate,
    revision: plan.revision,
    timeZone: dateDecision.timeZone,
    routes,
    count: routes.reduce((sum, route) => sum + route.visits.length, 0)
  };
}

export async function getHistoricalDriverAssistVisit({
  planDate,
  jobId,
  expectedStateHash = "",
  now = new Date()
} = {}) {
  const requestedJobId = requiredText(jobId, "Driver job ID", 1000);
  const listing = await listHistoricalDriverAssists({ planDate, now });
  for (const route of listing.routes) {
    const visit = route.visits.find((candidate) => candidate.jobId === requestedJobId);
    if (!visit) {
      continue;
    }
    if (expectedStateHash && visit.stateHash !== String(expectedStateHash).trim().toLowerCase()) {
      throw assistError(
        "This historical stop changed after it was loaded. Refresh and review it again.",
        409,
        "HISTORICAL_ASSIST_STALE_VISIT"
      );
    }
    if (!visit.actionable) {
      const block = visit.blockers[0] || { code: "HISTORICAL_ASSIST_BLOCKED", message: "This visit is blocked." };
      throw assistError(block.message, 409, block.code, { blockers: visit.blockers });
    }
    const planRoute = (await getDriverPlanRoutesForDate(listing.planDate)).routes
      .find((candidate) => candidate.driverLogin === route.driverLogin);
    const job = planRoute?.jobs.find((candidate) => String(candidate.jobId) === requestedJobId);
    if (!job) {
      throw assistError("The physical visit is no longer in the confirmed route.", 409, "HISTORICAL_ASSIST_VISIT_REMOVED");
    }
    return { listing, route, visit, planRoute, job };
  }
  throw assistError("The incomplete physical visit was not found in the confirmed plan.", 404, "HISTORICAL_ASSIST_VISIT_NOT_FOUND");
}

async function assistReplay(requestId) {
  const result = await query(
    `SELECT * FROM driver_job_assist_events WHERE request_id = $1::uuid LIMIT 1`,
    [requestId]
  );
  return result.rows[0] || null;
}

function replayResult(row, { jobId, actorId }) {
  if (!row) {
    return null;
  }
  if (String(row.primary_job_id) !== String(jobId) || String(row.actor_operator_id) !== String(actorId)) {
    throw assistError(
      "This request ID was already used for a different historical completion.",
      409,
      "HISTORICAL_ASSIST_REQUEST_CONFLICT"
    );
  }
  return { ...(row.result || {}), exactReplay: true };
}

export async function getHistoricalDriverAssistReplay({ requestId, jobId, actorId } = {}) {
  const requestUuid = uuidValue(requestId, "Request ID");
  const requestedJobId = requiredText(jobId, "Driver job ID", 1000);
  const operatorId = requiredText(actorId, "Dispatcher ID", 240);
  return replayResult(await assistReplay(requestUuid), {
    jobId: requestedJobId,
    actorId: operatorId
  });
}

export async function applyHistoricalDriverAssist({
  planDate,
  jobId,
  expectedStateHash,
  requestId,
  assistEventId = crypto.randomUUID(),
  actorId,
  actorName,
  reason,
  arrival = null,
  completion,
  photos = [],
  now = new Date(),
  execute
} = {}) {
  const requestedJobId = requiredText(jobId, "Driver job ID", 1000);
  const requestUuid = uuidValue(requestId, "Request ID");
  const eventUuid = uuidValue(assistEventId, "Assist event ID");
  const operatorId = requiredText(actorId, "Dispatcher ID", 240);
  const operatorName = requiredText(actorName || actorId, "Dispatcher name", 240);
  const auditReason = requiredText(reason, "Reason", 2000);
  const descriptors = normalizeHistoricalAssistPhotoDescriptors(photos, { requireReferences: true });
  if (typeof execute !== "function") {
    throw new TypeError("Historical completion executor is required.");
  }

  return withTransaction(async () => {
    const firstReplay = replayResult(await assistReplay(requestUuid), {
      jobId: requestedJobId,
      actorId: operatorId
    });
    if (firstReplay) {
      return firstReplay;
    }
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const serializedReplay = replayResult(await assistReplay(requestUuid), {
      jobId: requestedJobId,
      actorId: operatorId
    });
    if (serializedReplay) {
      return serializedReplay;
    }

    let context = await getHistoricalDriverAssistVisit({
      planDate,
      jobId: requestedJobId,
      expectedStateHash,
      now
    });
    await query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      String(context.route.driverLogin).toLowerCase(),
      context.listing.planDate
    ]);
    await query(
      `SELECT job_id
         FROM driver_job_records
        WHERE job_id = ANY($1::text[])
        ORDER BY job_id
        FOR UPDATE`,
      [context.visit.jobIds]
    );
    context = await getHistoricalDriverAssistVisit({
      planDate,
      jobId: requestedJobId,
      expectedStateHash,
      now
    });
    if (descriptors.length < Number(context.visit.requiredPhotos || 0)) {
      throw assistError(
        `${context.visit.requiredPhotos} photo${context.visit.requiredPhotos === 1 ? " is" : "s are"} required.`,
        409,
        "HISTORICAL_ASSIST_PHOTOS_REQUIRED"
      );
    }
    const recordType = context.visit.stopType === "pickup"
      ? "driver-pickup-photo"
      : "driver-dropoff-photo";
    for (const photo of descriptors) {
      if (!historicalAssistPhotoReferenceMatches(photo.objectReference, {
        requestId: requestUuid,
        photoId: photo.photoId,
        recordType
      })) {
        throw assistError(
          "An uploaded photo does not belong to this historical completion request.",
          409,
          "HISTORICAL_ASSIST_PHOTO_REFERENCE_INVALID"
        );
      }
    }
    const chronology = validateHistoricalAssistChronology({
      planDate: context.listing.planDate,
      arrival,
      completion,
      storedStartedAt: context.visit.startedAt,
      previousCompletedAt: context.visit.previousCompletedAt,
      nextStartedAt: context.visit.nextStartedAt,
      nextCompletedAt: context.visit.nextCompletedAt
    });
    const completionContext = {
      source: "dispatch_historical_assist",
      actorId: operatorId,
      actorName: operatorName,
      reason: auditReason,
      requestId: requestUuid,
      assistEventId: eventUuid
    };
    const execution = await execute({
      driverLogin: context.route.driverLogin,
      job: { ...context.job, requiredPhotos: context.visit.requiredPhotos },
      routeJobs: context.planRoute.jobs,
      startedAt: chronology.startedAt,
      completedAt: chronology.completedAt,
      wasStarted: chronology.usedStoredStart,
      photoReferences: descriptors.map((photo) => photo.objectReference),
      completionContext
    });
    const result = {
      assistEventId: eventUuid,
      requestId: requestUuid,
      planId: context.listing.planId,
      planDate: context.listing.planDate,
      planRevision: context.listing.revision,
      driverLogin: context.route.driverLogin,
      jobId: context.visit.jobId,
      jobIds: context.visit.jobIds,
      startedAt: chronology.startedAt,
      completedAt: chronology.completedAt,
      photoCount: descriptors.length,
      dependencyWarnings: execution?.dependencyWarnings || [],
      completed: true
    };
    await query(
      `INSERT INTO driver_job_assist_events (
         assist_event_id, request_id, actor_operator_id, actor_name,
         driver_login, plan_id, plan_date, plan_revision,
         primary_job_id, physical_visit_job_ids, stop_type,
         arrived_at, completed_at, photo_references, reason, outcome, result
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         $5, $6, $7::date, $8,
         $9, $10::jsonb, $11,
         $12::timestamptz, $13::timestamptz, $14::jsonb, $15, 'completed', $16::jsonb
       )`,
      [
        eventUuid,
        requestUuid,
        operatorId,
        operatorName,
        context.route.driverLogin,
        context.listing.planId,
        context.listing.planDate,
        context.listing.revision,
        context.visit.jobId,
        JSON.stringify(context.visit.jobIds),
        context.visit.stopType,
        chronology.startedAt,
        chronology.completedAt,
        JSON.stringify(descriptors.map((photo) => photo.objectReference)),
        auditReason,
        JSON.stringify(result)
      ]
    );
    await writeDispatchAudit({
      action: "driver_pwa_historical_stop_completed",
      entityType: "driver_job",
      entityId: context.visit.jobId,
      loadId: context.visit.loadId,
      truckId: context.visit.truckId,
      planId: context.listing.planId,
      planDate: context.listing.planDate,
      actorType: "operator",
      actorId: operatorId,
      operatorName,
      source: "dispatch_historical_assist",
      details: {
        assistEventId: eventUuid,
        requestId: requestUuid,
        reason: auditReason,
        driverLogin: context.route.driverLogin,
        physicalVisitJobIds: context.visit.jobIds,
        arrivedAt: chronology.startedAt,
        completedAt: chronology.completedAt,
        photoCount: descriptors.length
      }
    });
    return result;
  });
}
