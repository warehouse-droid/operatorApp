// @ts-check

import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION } from "./dispatch-actual-arrival-policy.js";

const RUN_TERMINAL_STATUSES = new Set([
  "preview_ready",
  "applied",
  "failed",
  "needs_review",
  "suppressed_gate_off",
  "stale"
]);

function text(value) {
  return String(value ?? "").trim();
}

function iso(value) {
  if (!value) {return null;}
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function dateOnly(value) {
  const retained = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(retained) ? retained : "";
}

function torontoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function publicResult(row = {}) {
  return {
    id: Number(row.id),
    runId: text(row.run_id),
    visitKey: text(row.visit_key),
    sequence: Number(row.sequence_no),
    planId: row.plan_id === null ? null : text(row.plan_id),
    loadId: text(row.load_id),
    loadName: text(row.load_name),
    stopIds: Array.isArray(row.stop_ids) ? row.stop_ids : [],
    orderRefs: Array.isArray(row.order_refs) ? row.order_refs : [],
    driverJobRecordIds: Array.isArray(row.driver_job_record_ids)
      ? row.driver_job_record_ids.map(Number)
      : [],
    truckPlate: text(row.truck_plate),
    destinationAddress: text(row.destination_address),
    destinationLatitude: row.destination_latitude === null ? null : Number(row.destination_latitude),
    destinationLongitude: row.destination_longitude === null ? null : Number(row.destination_longitude),
    previousCompletedAt: iso(row.previous_completed_at),
    pwaStartedAt: iso(row.pwa_started_at),
    completedAt: iso(row.completed_at),
    existingArrivalAt: iso(row.existing_arrival_at),
    proposedArrivalAt: iso(row.proposed_arrival_at),
    resolutionStatus: text(row.resolution_status),
    source: text(row.source),
    confidence: text(row.confidence),
    stateHash: text(row.state_hash),
    evidence: row.evidence_summary || {},
    error: text(row.error),
    createdAt: iso(row.created_at)
  };
}

function publicRun(row = {}, results = []) {
  const status = text(row.status);
  return {
    runId: text(row.run_id),
    mode: text(row.run_mode),
    status,
    terminal: RUN_TERMINAL_STATUSES.has(status),
    planDate: dateOnly(row.plan_date instanceof Date ? row.plan_date.toISOString() : row.plan_date),
    driverLogin: text(row.driver_login),
    triggerJobRecordId: row.trigger_job_record_id === null ? null : Number(row.trigger_job_record_id),
    requestedBy: text(row.requested_by),
    algorithmVersion: text(row.algorithm_version),
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: iso(row.next_attempt_at),
    resultVersion: Number(row.result_version || 0),
    totalStops: Number(row.total_stops || 0),
    resolvedStops: Number(row.resolved_stops || 0),
    unresolvedStops: Number(row.unresolved_stops || 0),
    skippedStops: Number(row.skipped_stops || 0),
    error: text(row.error),
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    previewReadyAt: iso(row.preview_ready_at),
    appliedAt: iso(row.applied_at),
    updatedAt: iso(row.updated_at),
    results
  };
}

function stableValue(value) {
  if (Array.isArray(value)) {return value.map(stableValue);}
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  if (value instanceof Date) {return value.toISOString();}
  return value;
}

export function actualArrivalStateHash(records = []) {
  const normalized = [...records]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .map((record) => ({
      id: Number(record.id),
      jobId: text(record.job_id),
      status: text(record.status),
      startedAt: iso(record.started_at),
      completedAt: iso(record.completed_at),
      driverLogin: text(record.driver_login).toLowerCase(),
      truckPlate: text(record.truck_plate).replace(/\s+/g, "").toUpperCase(),
      loadId: text(record.load_id),
      stopId: text(record.stop_id),
      stopType: text(record.stop_type).toLowerCase(),
      jobDetails: stableValue(record.job_details || {}),
      actualArrivalAt: iso(record.actual_arrival_at),
      actualArrivalSource: text(record.actual_arrival_source),
      actualArrivalRunId: text(record.actual_arrival_run_id)
    }));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export async function listActualArrivalDrivers({ planDate } = {}) {
  const date = dateOnly(planDate);
  if (!date) {throw Object.assign(new Error("A valid historical plan date is required."), { status: 400 });}
  const result = await query(
    `SELECT lower(btrim(record.driver_login)) AS driver_login,
            COALESCE(NULLIF(btrim(driver.name), ''), btrim(record.driver_login)) AS driver_name,
            COUNT(*)::int AS completed_record_count,
            COUNT(DISTINCT record.load_id)::int AS load_count,
            MIN(record.completed_at) AS first_completed_at,
            MAX(record.completed_at) AS last_completed_at
       FROM driver_job_records record
       LEFT JOIN dispatch_drivers driver
         ON lower(btrim(driver.login)) = lower(btrim(record.driver_login))
      WHERE record.plan_date = $1::date
        AND record.status = 'complete'
        AND lower(COALESCE(record.stop_type, '')) IN ('pickup', 'dropoff')
      GROUP BY lower(btrim(record.driver_login)),
               COALESCE(NULLIF(btrim(driver.name), ''), btrim(record.driver_login))
      ORDER BY driver_name, driver_login`,
    [date]
  );
  return result.rows.map((row) => ({
    driverLogin: text(row.driver_login),
    driverName: text(row.driver_name),
    completedRecordCount: Number(row.completed_record_count || 0),
    loadCount: Number(row.load_count || 0),
    firstCompletedAt: iso(row.first_completed_at),
    lastCompletedAt: iso(row.last_completed_at)
  }));
}

export async function createHistoricalActualArrivalRun({ planDate, driverLogin, requestedBy } = {}) {
  const date = dateOnly(planDate);
  const login = text(driverLogin).toLowerCase();
  const actor = text(requestedBy);
  if (!date || date > torontoDate()) {
    throw Object.assign(new Error("Choose today or an earlier historical plan date."), { status: 400 });
  }
  if (!login) {throw Object.assign(new Error("Choose a driver for the historical route."), { status: 400 });}
  if (!actor) {throw Object.assign(new Error("The calculation requester is required."), { status: 400 });}
  const existing = await query(
    `SELECT *
       FROM dispatch_actual_arrival_runs
      WHERE run_mode = 'historical'
        AND plan_date = $1::date
        AND lower(driver_login) = $2
        AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1`,
    [date, login]
  );
  if (existing.rowCount) {return publicRun(existing.rows[0]);}
  const record = await query(
    `SELECT 1
       FROM driver_job_records
      WHERE plan_date = $1::date
        AND lower(driver_login) = $2
        AND status = 'complete'
        AND lower(COALESCE(stop_type, '')) IN ('pickup', 'dropoff')
      LIMIT 1`,
    [date, login]
  );
  if (!record.rowCount) {
    throw Object.assign(new Error("No completed physical stops were found for this driver and date."), { status: 404 });
  }
  const inserted = await query(
    `INSERT INTO dispatch_actual_arrival_runs (
       run_id, run_mode, status, plan_date, driver_login, requested_by,
       algorithm_version, next_attempt_at
     ) VALUES ($1::uuid, 'historical', 'queued', $2::date, $3, $4, $5, now())
     RETURNING *`,
    [crypto.randomUUID(), date, login, actor, DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION]
  );
  return publicRun(inserted.rows[0]);
}

export async function getActualArrivalRun(runId, { includeResults = true } = {}) {
  const id = text(runId);
  if (!id) {return null;}
  const runResult = await query(
    "SELECT * FROM dispatch_actual_arrival_runs WHERE run_id = $1::uuid",
    [id]
  );
  if (!runResult.rowCount) {return null;}
  let results = [];
  if (includeResults) {
    const stopResult = await query(
      `SELECT *
         FROM dispatch_actual_arrival_run_stops
        WHERE run_id = $1::uuid
        ORDER BY sequence_no, id`,
      [id]
    );
    results = stopResult.rows.map(publicResult);
  }
  return publicRun(runResult.rows[0], results);
}

export async function claimNextActualArrivalRun({ workerId, leaseSeconds = 300 } = {}) {
  const owner = text(workerId);
  if (!owner) {throw new Error("An arrival worker ID is required.");}
  const seconds = Math.min(Math.max(Number(leaseSeconds) || 300, 30), 1800);
  return withTransaction(async () => {
    await query(
      `UPDATE dispatch_actual_arrival_runs
          SET status = CASE WHEN attempt_count >= 2 AND run_mode = 'automatic' THEN 'needs_review' ELSE 'queued' END,
              lease_token = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_attempt_at = now(),
              error = CASE WHEN error = '' THEN 'The previous arrival worker lease expired.' ELSE error END,
              updated_at = now()
        WHERE status = 'running'
          AND lease_expires_at < now()`
    );
    const candidate = await query(
      `SELECT run_id
         FROM dispatch_actual_arrival_runs
        WHERE status IN ('queued', 'retry_wait')
          AND next_attempt_at <= now()
        ORDER BY CASE WHEN run_mode = 'automatic' THEN 0 ELSE 1 END,
                 next_attempt_at,
                 created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    );
    if (!candidate.rowCount) {return null;}
    const leaseToken = crypto.randomUUID();
    const claimed = await query(
      `UPDATE dispatch_actual_arrival_runs
          SET status = 'running',
              attempt_count = attempt_count + 1,
              lease_token = $2::uuid,
              lease_owner = $3,
              lease_expires_at = now() + ($4::text || ' seconds')::interval,
              started_at = COALESCE(started_at, now()),
              error = '',
              updated_at = now()
        WHERE run_id = $1::uuid
        RETURNING *`,
      [candidate.rows[0].run_id, leaseToken, owner, String(seconds)]
    );
    return publicRun(claimed.rows[0]);
  });
}

export async function listActualArrivalRouteRecords({ planDate, driverLogin } = {}) {
  const result = await query(
    `SELECT record.*,
            arrival.actual_arrival_at,
            arrival.source AS actual_arrival_source,
            arrival.confidence AS actual_arrival_confidence,
            arrival.algorithm_version AS actual_arrival_algorithm_version,
            arrival.applied_run_id AS actual_arrival_run_id,
            arrival.evidence_summary AS actual_arrival_evidence
       FROM driver_job_records record
       LEFT JOIN dispatch_actual_stop_arrivals arrival
         ON arrival.driver_job_record_id = record.id
      WHERE record.plan_date = $1::date
        AND lower(btrim(record.driver_login)) = lower(btrim($2))
        AND record.status = 'complete'
        AND lower(COALESCE(record.stop_type, '')) IN ('pickup', 'dropoff')
      ORDER BY record.completed_at, record.started_at, record.id`,
    [dateOnly(planDate), text(driverLogin)]
  );
  return result.rows;
}

export async function localActualArrivalPoints({ truckPlate, startTime, endTime } = {}) {
  const result = await query(
    `SELECT latitude, longitude,
            speed_miles_per_hour AS "speedMilesPerHour",
            location_time AS "locationTime"
       FROM dispatch_truck_location_history
      WHERE upper(regexp_replace(plate, '\\s+', '', 'g')) = upper(regexp_replace($1, '\\s+', '', 'g'))
        AND location_time BETWEEN $2::timestamptz AND $3::timestamptz
      ORDER BY location_time`,
    [text(truckPlate), iso(startTime), iso(endTime)]
  );
  return result.rows;
}

export async function replaceActualArrivalRunResults(runId, results = [], {
  status,
  nextAttemptAt = null,
  error = ""
} = {}) {
  const id = text(runId);
  return withTransaction(async () => {
    const run = await query(
      "SELECT * FROM dispatch_actual_arrival_runs WHERE run_id = $1::uuid FOR UPDATE",
      [id]
    );
    if (!run.rowCount) {throw Object.assign(new Error("Arrival calculation run was not found."), { status: 404 });}
    if (text(run.rows[0].status) !== "running") {
      throw Object.assign(new Error("Arrival calculation run is no longer owned by this worker."), {
        status: 409,
        code: "DISPATCH_ACTUAL_ARRIVAL_LEASE_LOST"
      });
    }
    await query("DELETE FROM dispatch_actual_arrival_run_stops WHERE run_id = $1::uuid", [id]);
    for (const result of results) {
      await query(
        `INSERT INTO dispatch_actual_arrival_run_stops (
           run_id, visit_key, sequence_no, plan_id, load_id, load_name,
           stop_ids, order_refs, driver_job_record_ids, truck_plate,
           destination_address, destination_latitude, destination_longitude,
           previous_completed_at, pwa_started_at, completed_at,
           existing_arrival_at, proposed_arrival_at, resolution_status,
           source, confidence, state_hash, evidence_summary, error
         ) VALUES (
           $1::uuid, $2, $3, $4::bigint, $5, $6,
           $7::text[], $8::text[], $9::bigint[], $10,
           $11, $12, $13,
           $14::timestamptz, $15::timestamptz, $16::timestamptz,
           $17::timestamptz, $18::timestamptz, $19,
           $20, $21, $22, $23::jsonb, $24
         )`,
        [
          id,
          result.visitKey,
          result.sequence,
          result.planId || null,
          result.loadId || "",
          result.loadName || "",
          result.stopIds || [],
          result.orderRefs || [],
          result.driverJobRecordIds || [],
          result.truckPlate || "",
          result.destinationAddress || "",
          result.destinationLatitude ?? null,
          result.destinationLongitude ?? null,
          result.previousCompletedAt || null,
          result.pwaStartedAt || null,
          result.completedAt || null,
          result.existingArrivalAt || null,
          result.proposedArrivalAt || null,
          result.resolutionStatus,
          result.source || "",
          result.confidence || "",
          result.stateHash,
          JSON.stringify(result.evidence || {}),
          result.error || ""
        ]
      );
    }
    const counts = results.reduce((summary, result) => {
      if (["resolved", "same_site"].includes(result.resolutionStatus)) {summary.resolved += 1;}
      else if (result.resolutionStatus === "unresolved") {summary.unresolved += 1;}
      else {summary.skipped += 1;}
      return summary;
    }, { resolved: 0, unresolved: 0, skipped: 0 });
    const updated = await query(
      `UPDATE dispatch_actual_arrival_runs
          SET status = $2,
              next_attempt_at = COALESCE($3::timestamptz, next_attempt_at),
              result_version = result_version + 1,
              total_stops = $4,
              resolved_stops = $5,
              unresolved_stops = $6,
              skipped_stops = $7,
              error = $8,
              preview_ready_at = CASE WHEN $2 = 'preview_ready' THEN now() ELSE preview_ready_at END,
              lease_token = CASE WHEN $2 = 'running' THEN lease_token ELSE NULL END,
              lease_owner = CASE WHEN $2 = 'running' THEN lease_owner ELSE NULL END,
              lease_expires_at = CASE WHEN $2 = 'running' THEN lease_expires_at ELSE NULL END,
              updated_at = now()
        WHERE run_id = $1::uuid
        RETURNING *`,
      [id, status, nextAttemptAt, results.length, counts.resolved, counts.unresolved, counts.skipped, text(error)]
    );
    return publicRun(updated.rows[0]);
  });
}

export async function markActualArrivalRun(runId, status, { error = "", nextAttemptAt = null } = {}) {
  const result = await query(
    `UPDATE dispatch_actual_arrival_runs
        SET status = $2,
            error = $3,
            next_attempt_at = COALESCE($4::timestamptz, next_attempt_at),
            lease_token = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            preview_ready_at = CASE WHEN $2 = 'preview_ready' THEN now() ELSE preview_ready_at END,
            updated_at = now()
      WHERE run_id = $1::uuid
      RETURNING *`,
    [text(runId), text(status), text(error), nextAttemptAt]
  );
  return result.rowCount ? publicRun(result.rows[0]) : null;
}

async function currentRecordsForResult(result = {}) {
  const rows = await query(
    `SELECT record.*,
            arrival.actual_arrival_at,
            arrival.source AS actual_arrival_source,
            arrival.applied_run_id AS actual_arrival_run_id
       FROM driver_job_records record
       LEFT JOIN dispatch_actual_stop_arrivals arrival
         ON arrival.driver_job_record_id = record.id
      WHERE record.id = ANY($1::bigint[])
      ORDER BY record.id
      FOR SHARE OF record`,
    [result.driverJobRecordIds || []]
  );
  return rows.rows;
}

export async function applyActualArrivalRun(runId, {
  expectedResultVersion = null,
  appliedBy,
  automatic = false
} = {}) {
  const id = text(runId);
  const actor = text(appliedBy);
  if (!actor) {throw Object.assign(new Error("The arrival correction actor is required."), { status: 400 });}
  try {
    return await withTransaction(async () => {
      const locked = await query(
        "SELECT * FROM dispatch_actual_arrival_runs WHERE run_id = $1::uuid FOR UPDATE",
        [id]
      );
      if (!locked.rowCount) {throw Object.assign(new Error("Arrival calculation run was not found."), { status: 404 });}
      const row = locked.rows[0];
      if (text(row.status) === "applied") {return getActualArrivalRun(id);}
      const allowedStatus = automatic ? "running" : "preview_ready";
      if (text(row.status) !== allowedStatus) {
        throw Object.assign(new Error("Arrival calculation is not ready to apply."), { status: 409 });
      }
      if (!automatic && Number(expectedResultVersion) !== Number(row.result_version)) {
        throw Object.assign(new Error("The arrival preview changed. Recalculate before applying."), {
          status: 409,
          code: "DISPATCH_ACTUAL_ARRIVAL_PREVIEW_CHANGED"
        });
      }
      const resultRows = await query(
        `SELECT *
           FROM dispatch_actual_arrival_run_stops
          WHERE run_id = $1::uuid
          ORDER BY sequence_no, id`,
        [id]
      );
      const eligible = resultRows.rows.map(publicResult)
        .filter((result) => ["resolved", "same_site"].includes(result.resolutionStatus));
      for (const result of resultRows.rows.map(publicResult)) {
        const current = await currentRecordsForResult(result);
        if (current.length !== result.driverJobRecordIds.length || actualArrivalStateHash(current) !== result.stateHash) {
          throw Object.assign(new Error("Driver evidence changed after this preview. Recalculate before applying."), {
            status: 409,
            code: "DISPATCH_ACTUAL_ARRIVAL_STALE"
          });
        }
      }
      for (const result of eligible) {
        for (const recordId of result.driverJobRecordIds) {
          await query(
            `INSERT INTO dispatch_actual_stop_arrivals (
               driver_job_record_id, visit_key, actual_arrival_at, source,
               confidence, algorithm_version, evidence_summary,
               applied_run_id, applied_by
             ) VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7::jsonb, $8::uuid, $9)
             ON CONFLICT (driver_job_record_id) DO UPDATE SET
               visit_key = EXCLUDED.visit_key,
               actual_arrival_at = EXCLUDED.actual_arrival_at,
               source = EXCLUDED.source,
               confidence = EXCLUDED.confidence,
               algorithm_version = EXCLUDED.algorithm_version,
               evidence_summary = EXCLUDED.evidence_summary,
               applied_run_id = EXCLUDED.applied_run_id,
               applied_by = EXCLUDED.applied_by,
               updated_at = now()`,
            [
              recordId,
              result.visitKey,
              result.proposedArrivalAt,
              result.source,
              result.confidence || "medium",
              text(row.algorithm_version) || DISPATCH_ACTUAL_ARRIVAL_ALGORITHM_VERSION,
              JSON.stringify(result.evidence || {}),
              id,
              actor
            ]
          );
        }
      }
      const updated = await query(
        `UPDATE dispatch_actual_arrival_runs
            SET status = 'applied',
                applied_at = now(),
                lease_token = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                error = '',
                updated_at = now()
          WHERE run_id = $1::uuid
          RETURNING *`,
        [id]
      );
      return publicRun(updated.rows[0], resultRows.rows.map(publicResult));
    });
  } catch (error) {
    if (error?.code === "DISPATCH_ACTUAL_ARRIVAL_STALE") {
      await markActualArrivalRun(id, "stale", { error: error.message }).catch(() => null);
    }
    throw error;
  }
}
