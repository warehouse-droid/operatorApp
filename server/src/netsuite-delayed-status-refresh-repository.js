import { query, withTransaction } from "./db.js";
import {
  DELAYED_STATUS_REFRESH_MAX_ATTEMPTS,
  normalizeDelayedStatusRefreshIdentity
} from "./netsuite-delayed-status-refresh-policy.js";

const ACTIVE_JOB_STATUSES = Object.freeze(["pending", "running", "retry"]);
const FINISH_OUTCOMES = new Set(["succeeded", "retry", "failed"]);

function requiredDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid date.`);
  }
  return date;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return number;
}

function leaseIdentity(input = {}) {
  return {
    jobId: positiveInteger(input.jobId, "Delayed status refresh job ID"),
    leaseToken: String(input.leaseToken || "").trim()
  };
}

function jobFromRow(row = {}) {
  return {
    jobId: Number(row.job_id ?? row.id),
    orderType: row.order_type,
    netsuiteOrderId: Number(row.netsuite_order_id),
    tranid: row.tranid || "",
    status: row.status,
    attemptNumber: Number((row.attempt_number ?? row.attempt_count) || 0),
    availableAt: row.available_at,
    leaseOwner: row.lease_owner || "",
    leaseToken: row.lease_token || "",
    leaseExpiresAt: row.lease_expires_at || null,
    created: row.created === true
  };
}

export async function enqueueDelayedStatusRefresh(input = {}) {
  const identity = normalizeDelayedStatusRefreshIdentity(input);
  const availableAt = requiredDate(input.availableAt, "Delayed status refresh availability");
  const advisoryIdentity = `${identity.orderType}:${identity.netsuiteOrderId}`;
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [advisoryIdentity]);
    const existing = await query(
      `SELECT id AS job_id, order_type, netsuite_order_id, tranid, status,
              attempt_count, available_at, lease_owner, lease_token, lease_expires_at
         FROM netsuite_delayed_status_refresh_jobs
        WHERE order_type = $1
          AND netsuite_order_id = $2
          AND status = ANY($3::text[])
        FOR UPDATE`,
      [identity.orderType, identity.netsuiteOrderId, ACTIVE_JOB_STATUSES]
    );
    if (existing.rows[0]) {
      const refreshed = await query(
        `UPDATE netsuite_delayed_status_refresh_jobs
            SET tranid = COALESCE(NULLIF($2, ''), tranid),
                available_at = CASE
                  WHEN status IN ('pending', 'retry') THEN LEAST(available_at, $3::timestamptz)
                  ELSE available_at
                END,
                updated_at = now()
          WHERE id = $1
          RETURNING id AS job_id, order_type, netsuite_order_id, tranid, status,
                    attempt_count, available_at, lease_owner, lease_token, lease_expires_at,
                    false AS created`,
        [existing.rows[0].job_id, identity.tranid, availableAt]
      );
      return jobFromRow(refreshed.rows[0]);
    }
    const inserted = await query(
      `INSERT INTO netsuite_delayed_status_refresh_jobs (
         order_type, netsuite_order_id, tranid, status, available_at
       ) VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id AS job_id, order_type, netsuite_order_id, tranid, status,
                 attempt_count, available_at, lease_owner, lease_token, lease_expires_at,
                 true AS created`,
      [identity.orderType, identity.netsuiteOrderId, identity.tranid, availableAt]
    );
    return jobFromRow(inserted.rows[0]);
  });
}

async function recoverExpiredLeases(now) {
  await query(
    `WITH expired AS MATERIALIZED (
       SELECT id, lease_token
         FROM netsuite_delayed_status_refresh_jobs
        WHERE status = 'running'
          AND lease_expires_at <= $1
        FOR UPDATE SKIP LOCKED
     ), finished_attempts AS (
       UPDATE netsuite_delayed_status_refresh_attempts attempt
          SET outcome = 'lease_expired',
              error = COALESCE(error, 'Worker lease expired before the attempt was finalized.'),
              finished_at = $1
         FROM expired
        WHERE attempt.job_id = expired.id
          AND attempt.lease_token = expired.lease_token
          AND attempt.outcome = 'running'
       RETURNING attempt.id
     )
     UPDATE netsuite_delayed_status_refresh_jobs job
        SET status = CASE WHEN job.attempt_count >= $2 THEN 'failed' ELSE 'retry' END,
            available_at = $1,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error = 'Worker lease expired before the attempt was finalized.',
            updated_at = $1,
            completed_at = CASE WHEN job.attempt_count >= $2 THEN $1 ELSE NULL END
       FROM expired
      WHERE job.id = expired.id`,
    [now, DELAYED_STATUS_REFRESH_MAX_ATTEMPTS]
  );
}

export async function claimDueDelayedStatusRefreshJobs({
  workerId,
  limit = 10,
  leaseMs = 120_000,
  now = new Date()
} = {}) {
  const normalizedWorkerId = String(workerId || "").trim();
  if (!normalizedWorkerId) {
    throw new TypeError("Delayed status refresh worker ID is required.");
  }
  const boundedLimit = positiveInteger(limit, "Delayed status refresh claim limit", 100);
  const boundedLeaseMs = positiveInteger(leaseMs, "Delayed status refresh lease duration", 3_600_000);
  const claimAt = requiredDate(now, "Delayed status refresh claim time");
  return withTransaction(async () => {
    await recoverExpiredLeases(claimAt);
    const claimed = await query(
      `WITH due AS MATERIALIZED (
         SELECT id
           FROM netsuite_delayed_status_refresh_jobs
          WHERE status IN ('pending', 'retry')
            AND available_at <= $1
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       ), claimed_jobs AS (
         UPDATE netsuite_delayed_status_refresh_jobs job
            SET status = 'running',
                attempt_count = job.attempt_count + 1,
                lease_owner = $3,
                lease_token = gen_random_uuid(),
                lease_expires_at = $1 + ($4::double precision * interval '1 millisecond'),
                last_error = NULL,
                updated_at = $1,
                completed_at = NULL
           FROM due
          WHERE job.id = due.id
         RETURNING job.id AS job_id, job.order_type, job.netsuite_order_id,
                   job.tranid, job.status, job.attempt_count AS attempt_number,
                   job.available_at, job.lease_owner, job.lease_token,
                   job.lease_expires_at
       ), inserted_attempts AS (
         INSERT INTO netsuite_delayed_status_refresh_attempts (
           job_id, attempt_number, worker_id, lease_token, outcome, started_at
         )
         SELECT job_id, attempt_number, lease_owner, lease_token, 'running', $1
           FROM claimed_jobs
         RETURNING job_id
       )
       SELECT claimed_jobs.*
         FROM claimed_jobs
         JOIN inserted_attempts USING (job_id)
        ORDER BY available_at, job_id`,
      [claimAt, boundedLimit, normalizedWorkerId.slice(0, 200), boundedLeaseMs]
    );
    return claimed.rows.map(jobFromRow);
  });
}

export async function lockDelayedStatusRefreshLease(input = {}) {
  const identity = leaseIdentity(input);
  if (!identity.leaseToken) {
    throw new TypeError("Delayed status refresh lease token is required.");
  }
  const result = await query(
    `SELECT id
       FROM netsuite_delayed_status_refresh_jobs
      WHERE id = $1
        AND status = 'running'
        AND lease_token = $2::uuid
      FOR UPDATE`,
    [identity.jobId, identity.leaseToken]
  );
  return result.rowCount === 1;
}

export async function renewDelayedStatusRefreshLease({
  jobId,
  leaseToken,
  leaseMs = 120_000,
  now = new Date()
} = {}) {
  const identity = leaseIdentity({ jobId, leaseToken });
  if (!identity.leaseToken) {
    throw new TypeError("Delayed status refresh lease token is required.");
  }
  const boundedLeaseMs = positiveInteger(
    leaseMs,
    "Delayed status refresh lease duration",
    3_600_000
  );
  const renewedAt = requiredDate(now, "Delayed status refresh lease renewal time");
  const result = await query(
    `UPDATE netsuite_delayed_status_refresh_jobs
        SET lease_expires_at = $3 + ($4::double precision * interval '1 millisecond'),
            updated_at = $3
      WHERE id = $1
        AND status = 'running'
        AND lease_token = $2::uuid
        AND lease_expires_at > $3
      RETURNING id`,
    [identity.jobId, identity.leaseToken, renewedAt, boundedLeaseMs]
  );
  return result.rowCount === 1;
}

export async function finishDelayedStatusRefreshAttempt(input = {}) {
  const identity = leaseIdentity(input);
  const outcome = String(input.outcome || "").trim();
  if (!FINISH_OUTCOMES.has(outcome)) {
    throw new TypeError("Delayed status refresh outcome must be succeeded, retry, or failed.");
  }
  if (!identity.leaseToken) {
    throw new TypeError("Delayed status refresh lease token is required.");
  }
  const finishedAt = requiredDate(input.finishedAt || new Date(), "Delayed status refresh finish time");
  const nextAvailableAt = outcome === "retry"
    ? requiredDate(input.nextAvailableAt, "Delayed status refresh next availability")
    : null;
  const error = String(input.error || "").slice(0, 8_000) || null;
  const details = JSON.stringify(input.details || {});
  const result = await query(
    `WITH owned AS MATERIALIZED (
       SELECT id, lease_token
         FROM netsuite_delayed_status_refresh_jobs
        WHERE id = $1
          AND status = 'running'
          AND lease_token = $2::uuid
        FOR UPDATE
     ), finished_attempt AS (
       UPDATE netsuite_delayed_status_refresh_attempts attempt
          SET outcome = $3,
              details = $4::jsonb,
              error = $5,
              finished_at = $6
         FROM owned
        WHERE attempt.job_id = owned.id
          AND attempt.lease_token = owned.lease_token
          AND attempt.outcome = 'running'
       RETURNING attempt.id
     ), finished_job AS (
       UPDATE netsuite_delayed_status_refresh_jobs job
          SET status = $3,
              available_at = CASE WHEN $3 = 'retry' THEN $7::timestamptz ELSE job.available_at END,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = $5,
              last_result = $4::jsonb,
              updated_at = $6,
              completed_at = CASE WHEN $3 IN ('succeeded', 'failed') THEN $6 ELSE NULL END
         FROM owned
        WHERE job.id = owned.id
          AND EXISTS (SELECT 1 FROM finished_attempt)
       RETURNING job.id
     )
     SELECT id FROM finished_job`,
    [
      identity.jobId,
      identity.leaseToken,
      outcome,
      details,
      error,
      finishedAt,
      nextAvailableAt
    ]
  );
  return result.rowCount === 1;
}
