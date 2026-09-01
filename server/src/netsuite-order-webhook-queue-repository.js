import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";
import {
  compareNetSuiteWebhookVersions,
  normalizeNetSuiteWebhookEnvelope
} from "./netsuite-order-webhook-queue-policy.js";

function text(value) {
  return String(value ?? "").trim();
}

function publicQueueRow(row = {}) {
  if (!row?.id) return null;
  return {
    id: text(row.id),
    entityKey: text(row.entity_key),
    recordType: text(row.record_type),
    netsuiteOrderId: text(row.netsuite_order_id),
    eventType: text(row.event_type),
    sourceModifiedAt: row.source_modified_at ? new Date(row.source_modified_at).toISOString() : null,
    payloadHash: text(row.payload_hash),
    payload: row.payload || {},
    status: text(row.status),
    attemptCount: Number(row.attempt_count || 0),
    leaseOwner: text(row.lease_owner),
    leaseToken: text(row.lease_token),
    leaseExpiresAt: row.lease_expires_at || null,
    receivedAt: row.received_at || null,
    availableAt: row.available_at || null,
    completedAt: row.completed_at || null,
    lastError: text(row.last_error),
    result: row.result || {}
  };
}

function versionOfRow(row = {}) {
  return {
    sourceModifiedAt: row.source_modified_at ? new Date(row.source_modified_at).toISOString() : null,
    payloadHash: text(row.payload_hash)
  };
}

export async function enqueueNetSuiteOrderWebhook({ payload = {}, rawBody = "" } = {}) {
  const envelope = normalizeNetSuiteWebhookEnvelope({ payload, rawBody });
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`netsuite-order-webhook:${envelope.entityKey}`]);
    const duplicate = await query(
      `SELECT *
         FROM netsuite_order_webhook_inbox
        WHERE entity_key = $1 AND payload_hash = $2
        LIMIT 1`,
      [envelope.entityKey, envelope.payloadHash]
    );
    if (duplicate.rows[0]) {
      return { ...publicQueueRow(duplicate.rows[0]), accepted: true, duplicate: true, coalesced: 0 };
    }

    const latest = await query(
      `SELECT *
         FROM netsuite_order_webhook_inbox
        WHERE entity_key = $1
          AND status IN ('queued', 'running', 'succeeded', 'failed')
        ORDER BY COALESCE(source_modified_at, '-infinity'::timestamptz) DESC,
                 payload_hash DESC, received_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [envelope.entityKey]
    );
    const latestRow = latest.rows[0] || null;
    // When NetSuite omits its modification timestamp, receipt order is the
    // only trustworthy ordering signal. Never discard the newly received
    // full snapshot merely because its content hash sorts before an older
    // snapshot's hash; hashes provide identity, not chronology.
    const superseded = latestRow && envelope.sourceModifiedAt
      ? compareNetSuiteWebhookVersions(envelope, versionOfRow(latestRow)) < 0
      : false;
    const inserted = await query(
      `INSERT INTO netsuite_order_webhook_inbox (
         entity_key, record_type, netsuite_order_id, event_type,
         source_modified_at, payload_hash, payload, raw_body, received_bytes,
         status, superseded_by_id, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5::timestamptz, $6, $7::jsonb, $8, $9,
         $10, $11::bigint, CASE WHEN $10 = 'superseded' THEN now() ELSE NULL END
       )
       RETURNING *`,
      [
        envelope.entityKey,
        envelope.recordType,
        envelope.netsuiteOrderId,
        envelope.eventType,
        envelope.sourceModifiedAt,
        envelope.payloadHash,
        JSON.stringify(envelope.payload),
        envelope.rawBody,
        envelope.receivedBytes,
        superseded ? "superseded" : "queued",
        superseded ? latestRow.id : null
      ]
    );
    const row = inserted.rows[0];
    let coalesced = 0;
    if (!superseded) {
      const replaced = await query(
        `UPDATE netsuite_order_webhook_inbox
            SET status = 'superseded',
                superseded_by_id = $2,
                completed_at = now(),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE entity_key = $1
            AND id <> $2
            AND status IN ('queued', 'failed')
            AND (
              $3::timestamptz IS NULL
              OR COALESCE(source_modified_at, '-infinity'::timestamptz) < $3::timestamptz
              OR (
                COALESCE(source_modified_at, '-infinity'::timestamptz) = $3::timestamptz
                AND payload_hash < $4
              )
            )`,
        [envelope.entityKey, row.id, envelope.sourceModifiedAt, envelope.payloadHash]
      );
      coalesced = replaced.rowCount;
    }
    return {
      ...publicQueueRow(row),
      accepted: true,
      duplicate: false,
      superseded,
      coalesced
    };
  });
}

export async function claimNetSuiteOrderWebhook({ workerId, leaseMs = 120_000 } = {}) {
  const owner = text(workerId);
  if (!owner) throw new TypeError("NetSuite order webhook worker ID is required.");
  const duration = Math.min(Math.max(Number(leaseMs) || 120_000, 5_000), 15 * 60_000);
  return withTransaction(async () => {
    const control = await query(
      `SELECT paused
         FROM netsuite_order_webhook_control
        WHERE singleton = true
        FOR UPDATE`
    );
    if (control.rows[0]?.paused === true) return null;

    const expired = await query(
      `UPDATE netsuite_order_webhook_inbox
          SET status = 'queued',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              available_at = now(),
              last_error = CASE WHEN last_error = '' THEN 'Worker lease expired before completion.' ELSE last_error END,
              updated_at = now()
        WHERE status = 'running'
          AND lease_expires_at <= now()
        RETURNING id, attempt_count`
    );
    if (expired.rowCount) {
      await query(
        `UPDATE netsuite_order_webhook_attempts attempt
            SET outcome = 'lease_expired',
                error = CASE WHEN error = '' THEN 'Worker lease expired before completion.' ELSE error END,
                finished_at = now()
           FROM unnest($1::bigint[]) AS expired(expired_id)
          WHERE attempt.inbox_id = expired.expired_id
            AND attempt.outcome = 'running'`,
        [expired.rows.map((row) => row.id)]
      );
    }
    const active = await query(
      `SELECT id
         FROM netsuite_order_webhook_inbox
        WHERE status = 'running'
          AND lease_expires_at > now()
        LIMIT 1`
    );
    if (active.rowCount) return null;

    const selected = await query(
      `SELECT id
         FROM netsuite_order_webhook_inbox
        WHERE status = 'queued'
          AND available_at <= now()
        ORDER BY received_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    );
    if (!selected.rows[0]) return null;
    const leaseToken = crypto.randomUUID();
    const claimed = await query(
      `UPDATE netsuite_order_webhook_inbox
          SET status = 'running',
              attempt_count = attempt_count + 1,
              lease_owner = $2,
              lease_token = $3::uuid,
              lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
              started_at = now(),
              completed_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND status = 'queued'
        RETURNING *`,
      [selected.rows[0].id, owner, leaseToken, duration]
    );
    const row = claimed.rows[0];
    if (!row) return null;
    await query(
      `INSERT INTO netsuite_order_webhook_attempts (
         inbox_id, attempt_number, worker_id, lease_token
       ) VALUES ($1, $2, $3, $4::uuid)`,
      [row.id, row.attempt_count, owner, leaseToken]
    );
    return publicQueueRow(row);
  });
}

export async function renewNetSuiteOrderWebhookLease({ id, leaseToken, leaseMs = 120_000 } = {}) {
  const duration = Math.min(Math.max(Number(leaseMs) || 120_000, 5_000), 15 * 60_000);
  const result = await query(
    `UPDATE netsuite_order_webhook_inbox
        SET lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND lease_token = $2::uuid
      RETURNING id`,
    [id, leaseToken, duration]
  );
  return result.rowCount === 1;
}

export async function completeNetSuiteOrderWebhook({ id, leaseToken, result = {} } = {}) {
  return withTransaction(async () => {
    const completed = await query(
      `UPDATE netsuite_order_webhook_inbox
          SET status = 'succeeded',
              result = $3::jsonb,
              last_error = '',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1
          AND status = 'running'
          AND lease_token = $2::uuid
        RETURNING *`,
      [id, leaseToken, JSON.stringify(result || {})]
    );
    if (!completed.rows[0]) {
      throw Object.assign(new Error("NetSuite order webhook lease is no longer owned."), {
        status: 409,
        code: "NETSUITE_ORDER_WEBHOOK_LEASE_FENCED"
      });
    }
    await query(
      `UPDATE netsuite_order_webhook_attempts
          SET outcome = 'succeeded', details = $3::jsonb, finished_at = now()
        WHERE inbox_id = $1 AND lease_token = $2::uuid AND outcome = 'running'`,
      [id, leaseToken, JSON.stringify(result || {})]
    );
    return publicQueueRow(completed.rows[0]);
  });
}

export async function failNetSuiteOrderWebhook({ id, leaseToken, error } = {}) {
  const message = text(error?.message || error || "Webhook processing failed.").slice(0, 8_000);
  return withTransaction(async () => {
    const failed = await query(
      `UPDATE netsuite_order_webhook_inbox
          SET status = 'failed',
              last_error = $3,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1
          AND status = 'running'
          AND lease_token = $2::uuid
        RETURNING *`,
      [id, leaseToken, message]
    );
    if (!failed.rows[0]) return null;
    await query(
      `UPDATE netsuite_order_webhook_attempts
          SET outcome = 'failed', error = $3, finished_at = now()
        WHERE inbox_id = $1 AND lease_token = $2::uuid AND outcome = 'running'`,
      [id, leaseToken, message]
    );
    return publicQueueRow(failed.rows[0]);
  });
}

export async function retryNetSuiteOrderWebhook({ id, actor = "" } = {}) {
  const result = await query(
    `UPDATE netsuite_order_webhook_inbox
        SET status = 'queued',
            available_at = now(),
            completed_at = NULL,
            last_error = CASE
              WHEN $2 = '' THEN last_error
              ELSE left(last_error || CASE WHEN last_error = '' THEN '' ELSE E'\n' END || 'Retried by ' || $2, 8000)
            END,
            updated_at = now()
      WHERE id = $1
        AND status = 'failed'
      RETURNING *`,
    [id, text(actor)]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("Only a failed NetSuite order webhook can be retried."), {
      status: 409,
      code: "NETSUITE_ORDER_WEBHOOK_NOT_RETRYABLE"
    });
  }
  return publicQueueRow(result.rows[0]);
}

export async function setNetSuiteOrderWebhookQueuePaused({ paused, reason = "", actor = "" } = {}) {
  const result = await query(
    `UPDATE netsuite_order_webhook_control
        SET paused = $1,
            pause_reason = CASE WHEN $1 THEN $2 ELSE '' END,
            updated_by = $3,
            updated_at = now()
      WHERE singleton = true
      RETURNING paused, pause_reason, updated_by, updated_at`,
    [paused === true, text(reason), text(actor)]
  );
  return {
    paused: result.rows[0]?.paused === true,
    reason: text(result.rows[0]?.pause_reason),
    updatedBy: text(result.rows[0]?.updated_by),
    updatedAt: result.rows[0]?.updated_at || null
  };
}

export async function getNetSuiteOrderWebhookQueueStatus({ recentLimit = 25 } = {}) {
  const limit = Math.min(Math.max(Number(recentLimit) || 25, 1), 100);
  const [control, counts, recent] = await Promise.all([
    query("SELECT paused, pause_reason, updated_by, updated_at FROM netsuite_order_webhook_control WHERE singleton = true"),
    query(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'running')::int AS running,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
              min(received_at) FILTER (WHERE status = 'queued') AS oldest_queued_at
         FROM netsuite_order_webhook_inbox`
    ),
    query(
      `SELECT id::text, entity_key, record_type, event_type, status, attempt_count,
              source_modified_at, received_at, started_at, completed_at, last_error
         FROM netsuite_order_webhook_inbox
        ORDER BY updated_at DESC, id DESC
        LIMIT $1`,
      [limit]
    )
  ]);
  const state = counts.rows[0] || {};
  return {
    paused: control.rows[0]?.paused === true,
    pauseReason: text(control.rows[0]?.pause_reason),
    updatedBy: text(control.rows[0]?.updated_by),
    updatedAt: control.rows[0]?.updated_at || null,
    queued: Number(state.queued || 0),
    running: Number(state.running || 0),
    failed: Number(state.failed || 0),
    succeeded: Number(state.succeeded || 0),
    superseded: Number(state.superseded || 0),
    oldestQueuedAt: state.oldest_queued_at || null,
    workerConcurrency: 1,
    recent: recent.rows.map((row) => ({
      id: row.id,
      entityKey: row.entity_key,
      recordType: row.record_type,
      eventType: row.event_type,
      status: row.status,
      attemptCount: Number(row.attempt_count || 0),
      sourceModifiedAt: row.source_modified_at || null,
      receivedAt: row.received_at,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      lastError: row.last_error || ""
    }))
  };
}

export async function claimNetSuiteOrderWebhookNotifications({ limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return withTransaction(async () => {
    const result = await query(
      `WITH candidates AS (
         SELECT id
           FROM netsuite_order_webhook_inbox
          WHERE status = 'succeeded'
            AND app_notified_at IS NULL
          ORDER BY completed_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE netsuite_order_webhook_inbox inbox
          SET app_notified_at = now(), updated_at = now()
         FROM candidates
        WHERE inbox.id = candidates.id
       RETURNING inbox.id::text, inbox.record_type, inbox.netsuite_order_id,
                 inbox.event_type, inbox.payload, inbox.result`,
      [safeLimit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      recordType: row.record_type,
      netsuiteOrderId: row.netsuite_order_id,
      eventType: row.event_type || "",
      tranid: text(row.payload?.tranid),
      poHistoryEvent: text(row.result?.poHistoryEvent)
    }));
  });
}
