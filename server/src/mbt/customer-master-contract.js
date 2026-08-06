// @ts-check

import crypto from "node:crypto";

import { canonicalJson, canonicalSha256 } from "./canonical-json.js";
import { customerDatabase, withCustomerTransaction } from "./customer-database.js";
import { MbtError } from "./errors.js";
import { applyCanonicalCustomerAggregatesInTransaction } from "./customer-sync-service.js";

export const CUSTOMER_MASTER_CONTRACT = "customer-master/v1";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_EVENT_RECORDS = 1_000;
const MAX_SNAPSHOT_RECORDS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * @typedef {object} CustomerMasterEvent
 * @property {number | string} sequence
 * @property {string} eventId
 * @property {string} changeType
 * @property {number | string} customerNetSuiteId
 * @property {Record<string, unknown>} aggregate
 * @property {string} committedAt
 */

/** @param {string} code @param {string} message @param {number} [status] */
function contractError(code, message, status = 409) {
  return new MbtError({ code, message, status });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function positiveIdText(value, label) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  const normalized = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  const canonical = BigInt(normalized).toString();
  if (BigInt(canonical) > POSTGRES_BIGINT_MAX) {
    throw new TypeError(`${label} exceeds the PostgreSQL bigint range.`);
  }
  return canonical;
}

/** @param {unknown} value @param {string} label */
function nonnegativeIdText(value, label) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a nonnegative integer.`);
  }
  const normalized = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new TypeError(`${label} must be a nonnegative integer.`);
  }
  const canonical = BigInt(normalized).toString();
  if (BigInt(canonical) > POSTGRES_BIGINT_MAX) {
    throw new TypeError(`${label} exceeds the PostgreSQL bigint range.`);
  }
  return canonical;
}

/** @param {string} value */
function publicId(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  const normalized = String(value ?? "").trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function isoTimestamp(value, label) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return date.toISOString();
}

/** @param {unknown} value @param {number} maximum @param {string} label */
function boundedCount(value, maximum, label) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return Math.min(count, maximum);
}

/** @param {unknown} value @param {string} label */
function aggregate(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label */
function subsidiaryId(value, label) {
  return value === null || value === undefined ? null : positiveIdText(value, label);
}

/** @param {unknown} value @param {string} label @returns {CustomerMasterEvent[]} */
function eventCollection(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const row = aggregate(entry, `${label} entry`);
    const changeType = String(row.changeType ?? "");
    if (changeType !== "upsert" && changeType !== "inactivate") {
      throw new TypeError("Customer master event change type is not supported.");
    }
    return {
      sequence: publicId(positiveIdText(row.sequence, "Customer master event sequence")),
      eventId: uuid(row.eventId, "Customer master event ID"),
      changeType,
      customerNetSuiteId: publicId(positiveIdText(
        row.customerNetSuiteId,
        "Customer master event customer ID"
      )),
      aggregate: aggregate(row.aggregate, `Customer master event aggregate ${index + 1}`),
      committedAt: isoTimestamp(row.committedAt, "Customer master event committed time")
    };
  });
}

/** @param {CustomerMasterEvent[]} events @returns {CustomerMasterEvent[]} */
function sortedEvents(events) {
  return [...events].sort((left, right) => {
    const leftSequence = BigInt(String(left.sequence));
    const rightSequence = BigInt(String(right.sequence));
    return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
  });
}

/** @param {unknown} database @param {{customerNetSuiteIds?: unknown, afterSequence?: unknown, limit?: unknown}} [input] */
export async function readCustomerMasterEvents(database, input = {}) {
  const ids = Array.isArray(input.customerNetSuiteIds)
    ? [...new Set(input.customerNetSuiteIds.map((id) => positiveIdText(
      id,
      "Customer master event customer ID"
    )))]
    : [];
  if (ids.length === 0) {
    return { contract: CUSTOMER_MASTER_CONTRACT, events: [] };
  }
  const afterSequence = nonnegativeIdText(input.afterSequence ?? 0, "Customer master event cursor");
  const limit = boundedCount(input.limit ?? 100, MAX_EVENT_RECORDS, "Customer master event limit");
  const result = await customerDatabase(database).query(
    `SELECT sequence_id::text AS sequence_id, event_uuid::text AS event_uuid,
            change_type, customer_netsuite_id::text AS customer_netsuite_id,
            aggregate_payload, committed_at
       FROM mbt_customer_master_events
      WHERE customer_netsuite_id = ANY($1::bigint[])
        AND sequence_id > $2::bigint
      ORDER BY sequence_id
      LIMIT $3`,
    [ids, afterSequence, limit]
  );
  return {
    contract: CUSTOMER_MASTER_CONTRACT,
    events: result.rows.map((row) => ({
      sequence: publicId(String(row.sequence_id)),
      eventId: String(row.event_uuid),
      changeType: String(row.change_type),
      customerNetSuiteId: publicId(String(row.customer_netsuite_id)),
      aggregate: row.aggregate_payload,
      committedAt: new Date(String(row.committed_at)).toISOString()
    }))
  };
}

/** @param {{secret?: unknown, envelope?: unknown}} input */
export function signCustomerMasterEnvelope(input) {
  const secret = requiredText(input?.secret, "Customer master shared secret");
  return crypto.createHmac("sha256", secret)
    .update(canonicalJson(input?.envelope), "utf8")
    .digest("hex");
}

/** @param {unknown} envelope @param {unknown} signature @param {unknown} secret */
function verifySignature(envelope, signature, secret) {
  const candidate = String(signature ?? "").toLowerCase();
  const expected = signCustomerMasterEnvelope({ envelope, secret });
  if (!/^[0-9a-f]{64}$/u.test(candidate)) {
    throw contractError("MBT_CUSTOMER_MASTER_SIGNATURE_INVALID", "Customer master signature is invalid.", 401);
  }
  const candidateBuffer = Buffer.from(candidate, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (candidateBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(candidateBuffer, expectedBuffer)) {
    throw contractError("MBT_CUSTOMER_MASTER_SIGNATURE_INVALID", "Customer master signature is invalid.", 401);
  }
}

/** @param {Record<string, unknown>} input */
export function createCustomerMasterEventEnvelope(input) {
  const afterSequence = nonnegativeIdText(
    input.afterSequence ?? 0,
    "Customer master event cursor"
  );
  const maxEvents = boundedCount(
    input.maxEvents ?? 100,
    MAX_EVENT_RECORDS,
    "Customer master event bound"
  );
  const events = sortedEvents(eventCollection(input.events, "Customer master events"))
    .filter((event) => BigInt(String(event.sequence)) > BigInt(afterSequence))
    .slice(0, maxEvents);
  const nextSequence = events.at(-1)?.sequence ?? publicId(afterSequence);
  return {
    contract: CUSTOMER_MASTER_CONTRACT,
    accountId: requiredText(input.accountId, "Customer master account ID"),
    subsidiaryId: subsidiaryId(input.subsidiaryId, "Customer master subsidiary ID"),
    afterSequence: publicId(afterSequence),
    nextSequence,
    events
  };
}

/** @param {unknown} value */
function eventEnvelope(value) {
  const envelope = aggregate(value, "Customer master event envelope");
  if (envelope.contract !== CUSTOMER_MASTER_CONTRACT) {
    throw contractError("MBT_CUSTOMER_MASTER_CONTRACT_UNSUPPORTED", "Customer master contract is not supported.", 400);
  }
  return {
    contract: CUSTOMER_MASTER_CONTRACT,
    accountId: requiredText(envelope.accountId, "Customer master account ID"),
    subsidiaryId: subsidiaryId(envelope.subsidiaryId, "Customer master subsidiary ID"),
    events: sortedEvents(eventCollection(envelope.events, "Customer master events"))
  };
}

/**
 * A completed apply-only run supplies immutable FK evidence for consumer-side
 * canonical writes without claiming a live NetSuite sync lease.
 *
 * @param {import("./customer-database.js").CustomerDatabase} database
 * @param {{accountId: string, subsidiaryId: string | null}} envelope
 * @param {string} consumerId
 * @param {number} recordCount
 */
async function insertConsumerApplyRun(database, envelope, consumerId, recordCount) {
  const runId = crypto.randomUUID();
  await database.query(
    `INSERT INTO netsuite_customer_sync_runs (
       run_id, sync_kind, status, account_id, subsidiary_id, requested_by,
       correlation_id, pages_expected, pages_applied, records_seen,
       records_applied, started_at, completed_at, metadata
     ) VALUES (
       $1::uuid, 'incremental', 'completed', $2, $3, $4, $5,
       1, 1, $6, 0, now(), now(), $7::jsonb
     )`,
    [
      runId,
      envelope.accountId,
      envelope.subsidiaryId,
      consumerId,
      `customer-master-event:${consumerId}:${runId}`,
      recordCount,
      JSON.stringify({ contract: CUSTOMER_MASTER_CONTRACT, consumerApply: true })
    ]
  );
  return runId;
}

/**
 * @param {import("./customer-database.js").CustomerDatabase} database
 * @param {string} consumerId
 * @param {ReturnType<typeof eventEnvelope>["events"]} events
 */
async function readAcceptedEventRows(database, consumerId, events) {
  const eventIds = events.map(({ eventId }) => eventId);
  if (eventIds.length === 0) {
    return [];
  }
  const existing = await database.query(
    `SELECT event_uuid::text AS event_uuid, source_sequence::text AS source_sequence,
            account_id, subsidiary_id::text AS subsidiary_id
       FROM mbt_customer_master_inbox
      WHERE consumer_id = $1 AND event_uuid = ANY($2::uuid[])`,
    [consumerId, eventIds]
  );
  return existing.rows;
}

/**
 * @param {ReturnType<typeof eventEnvelope>} envelope
 * @param {Record<string, unknown>[]} rows
 */
function validateAcceptedEventRows(envelope, rows) {
  for (const row of rows) {
    const event = envelope.events.find(({ eventId }) => eventId === String(row.event_uuid));
    const sameSubsidiary = String(envelope.subsidiaryId ?? "")
      === String(row.subsidiary_id ?? "");
    if (!event
        || String(event.sequence) !== String(row.source_sequence)
        || envelope.accountId !== String(row.account_id)
        || !sameSubsidiary) {
      throw contractError(
        "MBT_CUSTOMER_MASTER_EVENT_REUSE",
        "Customer master event identity was reused with different content."
      );
    }
  }
}

/**
 * @param {import("./customer-database.js").CustomerDatabase} database
 * @param {ReturnType<typeof eventEnvelope>} envelope
 * @param {ReturnType<typeof eventEnvelope>["events"]} events
 * @param {string} consumerId
 * @param {string} envelopeHash
 * @param {string} runId
 */
async function applyConsumerEvents(database, envelope, events, consumerId, envelopeHash, runId) {
  let appliedCount = 0;
  let conflictedCount = 0;
  for (const event of events) {
    const eventAggregate = event.aggregate;
    if (String(eventAggregate.netsuiteId ?? "") !== String(event.customerNetSuiteId)) {
      throw contractError(
        "MBT_CUSTOMER_MASTER_EVENT_INVALID",
        "Customer master event identity does not match its aggregate.",
        400
      );
    }
    const result = await applyCanonicalCustomerAggregatesInTransaction(database, {
      accountId: envelope.accountId,
      sourceKind: eventAggregate.sourceKind ?? "customer_master_event",
      aggregates: [eventAggregate]
    }, { runId, publishEvents: false });
    appliedCount += Number(result.created) + Number(result.updated);
    conflictedCount += Number(result.conflicted);
    await database.query(
      `INSERT INTO mbt_customer_master_inbox (
         consumer_id, event_uuid, source_sequence, account_id,
         subsidiary_id, envelope_hash
       ) VALUES ($1, $2::uuid, $3, $4, $5, $6)`,
      [
        consumerId,
        event.eventId,
        String(event.sequence),
        envelope.accountId,
        envelope.subsidiaryId,
        envelopeHash
      ]
    );
  }
  return { appliedCount, conflictedCount };
}

/** @param {ReturnType<typeof eventEnvelope>["events"]} events */
function eventHighWater(events) {
  return events.reduce(
    (current, event) => BigInt(String(event.sequence)) > current
      ? BigInt(String(event.sequence))
      : current,
    0n
  ).toString();
}

/**
 * @param {import("./customer-database.js").CustomerDatabase} database
 * @param {ReturnType<typeof eventEnvelope>} envelope
 * @param {string} consumerId
 * @param {string} highWater
 */
async function updateConsumerHighWater(database, envelope, consumerId, highWater) {
  await database.query(
    `INSERT INTO mbt_customer_master_consumer_state (
       consumer_id, account_id, subsidiary_key, high_water_sequence,
       last_success_at
     ) VALUES ($1, $2, COALESCE($3::bigint, 0), $4, now())
     ON CONFLICT (consumer_id, account_id, subsidiary_key) DO UPDATE
     SET high_water_sequence = GREATEST(
           mbt_customer_master_consumer_state.high_water_sequence,
           EXCLUDED.high_water_sequence
         ),
         revision = mbt_customer_master_consumer_state.revision + 1,
         last_success_at = now(),
         updated_at = now()`,
    [consumerId, envelope.accountId, envelope.subsidiaryId, highWater]
  );
}

/**
 * @param {import("./customer-database.js").CustomerDatabase} client
 * @param {ReturnType<typeof eventEnvelope>} envelope
 * @param {string} consumerId
 * @param {string} envelopeHash
 */
async function acceptEventEnvelopeInTransaction(client, envelope, consumerId, envelopeHash) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `customer-master:${consumerId}:${envelope.accountId}:${envelope.subsidiaryId ?? 0}`
  ]);
  const existing = await readAcceptedEventRows(client, consumerId, envelope.events);
  validateAcceptedEventRows(envelope, existing);
  const acceptedIds = new Set(existing.map((row) => String(row.event_uuid)));
  const missing = envelope.events.filter(({ eventId }) => !acceptedIds.has(eventId));
  if (missing.length === 0) {
    return { accepted: 0, replayed: true };
  }
  const runId = await insertConsumerApplyRun(client, envelope, consumerId, missing.length);
  const counts = await applyConsumerEvents(
    client,
    envelope,
    missing,
    consumerId,
    envelopeHash,
    runId
  );
  await updateConsumerHighWater(client, envelope, consumerId, eventHighWater(missing));
  await client.query(
    `UPDATE netsuite_customer_sync_runs
        SET records_applied = $2, records_conflicted = $3
      WHERE run_id = $1::uuid`,
    [runId, counts.appliedCount, counts.conflictedCount]
  );
  return { accepted: missing.length, replayed: false };
}

/** @param {unknown} database @param {Record<string, unknown>} input */
export async function acceptCustomerMasterEventEnvelope(database, input) {
  verifySignature(input.envelope, input.signature, input.secret);
  const envelope = eventEnvelope(input.envelope);
  const consumerId = requiredText(input.consumerId, "Customer master consumer ID");
  const envelopeHash = canonicalSha256(input.envelope);
  return withCustomerTransaction(database, (client) => acceptEventEnvelopeInTransaction(
    client,
    envelope,
    consumerId,
    envelopeHash
  ));
}

/** @param {string} snapshotId @param {number} offset */
function encodeSnapshotCursor(snapshotId, offset) {
  return Buffer.from(canonicalJson({ snapshotId, offset }), "utf8").toString("base64url");
}

/** @param {unknown} cursor @param {string} snapshotId */
function snapshotOffset(cursor, snapshotId) {
  if (cursor === null || cursor === undefined || cursor === "") {
    return 0;
  }
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!parsed || parsed.snapshotId !== snapshotId
        || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error("invalid");
    }
    return parsed.offset;
  } catch {
    throw contractError(
      "MBT_CUSTOMER_MASTER_CURSOR_INVALID",
      "Customer master snapshot cursor is invalid.",
      400
    );
  }
}

/** @param {Record<string, unknown>} input */
export function createCustomerMasterSnapshotEnvelope(input) {
  const snapshotId = uuid(input.snapshotId, "Customer master snapshot ID");
  if (!Array.isArray(input.customers)) {
    throw new TypeError("Customer master snapshot customers must be an array.");
  }
  const customers = input.customers.map((customer) => {
    const normalized = aggregate(customer, "Customer master snapshot customer");
    positiveIdText(normalized.netsuiteId, "Snapshot customer ID");
    return normalized;
  }).sort((left, right) => {
    const leftId = BigInt(positiveIdText(left.netsuiteId, "Snapshot customer ID"));
    const rightId = BigInt(positiveIdText(right.netsuiteId, "Snapshot customer ID"));
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const pageCursor = input.cursor === null || input.cursor === undefined
    ? null
    : requiredText(input.cursor, "Customer master snapshot cursor");
  const offset = snapshotOffset(pageCursor, snapshotId);
  const maxRecords = boundedCount(
    input.maxRecords ?? 100,
    MAX_SNAPSHOT_RECORDS,
    "Customer master snapshot bound"
  );
  const page = customers.slice(offset, offset + maxRecords);
  const end = offset + page.length;
  const complete = end >= customers.length;
  return {
    contract: CUSTOMER_MASTER_CONTRACT,
    snapshotId,
    accountId: requiredText(input.accountId, "Customer master account ID"),
    subsidiaryId: subsidiaryId(input.subsidiaryId, "Customer master subsidiary ID"),
    pageCursor: pageCursor ?? "START",
    nextCursor: complete ? null : encodeSnapshotCursor(snapshotId, end),
    complete,
    customers: page
  };
}

/** @param {unknown} value */
function snapshotEnvelope(value) {
  const envelope = aggregate(value, "Customer master snapshot envelope");
  if (envelope.contract !== CUSTOMER_MASTER_CONTRACT) {
    throw contractError("MBT_CUSTOMER_MASTER_CONTRACT_UNSUPPORTED", "Customer master contract is not supported.", 400);
  }
  if (!Array.isArray(envelope.customers)) {
    throw new TypeError("Customer master snapshot customers must be an array.");
  }
  return {
    contract: CUSTOMER_MASTER_CONTRACT,
    snapshotId: uuid(envelope.snapshotId, "Customer master snapshot ID"),
    accountId: requiredText(envelope.accountId, "Customer master account ID"),
    subsidiaryId: subsidiaryId(envelope.subsidiaryId, "Customer master subsidiary ID"),
    pageCursor: requiredText(envelope.pageCursor, "Customer master snapshot page cursor"),
    complete: envelope.complete === true,
    customers: envelope.customers.map((customer) => aggregate(
      customer,
      "Customer master snapshot customer"
    ))
  };
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {ReturnType<typeof snapshotEnvelope>} envelope @param {string} consumerId */
async function ensureSnapshotRun(database, envelope, consumerId) {
  await database.query(
    `INSERT INTO netsuite_customer_sync_runs (
       run_id, sync_kind, status, account_id, subsidiary_id, requested_by,
       correlation_id, started_at, metadata
     ) VALUES (
       $1::uuid, 'full_reconciliation', 'running', $2, $3, $4, $5,
       now(), $6::jsonb
     )
     ON CONFLICT (run_id) DO NOTHING`,
    [
      envelope.snapshotId,
      envelope.accountId,
      envelope.subsidiaryId,
      consumerId,
      `customer-master-snapshot:${consumerId}:${envelope.snapshotId}`,
      JSON.stringify({ contract: CUSTOMER_MASTER_CONTRACT, consumerSnapshot: true })
    ]
  );
  const run = await database.query(
    `SELECT status, account_id, subsidiary_id::text AS subsidiary_id
       FROM netsuite_customer_sync_runs
      WHERE run_id = $1::uuid
      FOR UPDATE`,
    [envelope.snapshotId]
  );
  const runRow = run.rows[0];
  if (!runRow
      || String(runRow.account_id) !== envelope.accountId
      || String(runRow.subsidiary_id ?? "") !== String(envelope.subsidiaryId ?? "")) {
    throw contractError(
      "MBT_CUSTOMER_MASTER_SNAPSHOT_REUSE",
      "Customer master snapshot identity was reused with different scope."
    );
  }
  return String(runRow.status);
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {ReturnType<typeof snapshotEnvelope>} envelope */
async function inactivateMissingSnapshotCustomers(database, envelope) {
  const missing = await database.query(
    `UPDATE netsuite_customers c
        SET active = false, updated_at = now()
       FROM mbt_customer_provenance p
      WHERE p.customer_netsuite_id = c.netsuite_id
        AND p.source_account_id = $1
        AND c.active
        AND c.last_seen_run_id IS DISTINCT FROM $2::uuid
        AND ($3::bigint IS NULL OR EXISTS (
          SELECT 1
            FROM netsuite_customer_subsidiaries s
           WHERE s.customer_netsuite_id = c.netsuite_id
             AND s.subsidiary_netsuite_id = $3
        ))
      RETURNING c.netsuite_id::text AS netsuite_id`,
    [envelope.accountId, envelope.snapshotId, envelope.subsidiaryId]
  );
  if (missing.rows.length > 0) {
    await database.query(
      "DELETE FROM return_customer_directory WHERE netsuite_customer_id = ANY($1::bigint[])",
      [missing.rows.map((row) => String(row.netsuite_id))]
    );
  }
  return missing.rows.length;
}

/** @param {unknown} database @param {Record<string, unknown>} input */
export async function acceptCustomerMasterSnapshotEnvelope(database, input) {
  verifySignature(input.envelope, input.signature, input.secret);
  const envelope = snapshotEnvelope(input.envelope);
  const consumerId = requiredText(input.consumerId, "Customer master consumer ID");
  const pageHash = canonicalSha256(input.envelope);
  return withCustomerTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `customer-master:${consumerId}:${envelope.snapshotId}`
    ]);
    const existing = await client.query(
      `SELECT page_hash
         FROM mbt_customer_master_snapshot_pages
        WHERE consumer_id = $1 AND snapshot_id = $2::uuid AND page_cursor = $3`,
      [consumerId, envelope.snapshotId, envelope.pageCursor]
    );
    const existingPage = existing.rows[0];
    if (existingPage) {
      if (String(existingPage.page_hash) !== pageHash) {
        throw contractError(
          "MBT_CUSTOMER_MASTER_SNAPSHOT_PAGE_REUSE",
          "Customer master snapshot page was reused with different content."
        );
      }
      return { accepted: 0, replayed: true, complete: envelope.complete };
    }
    const status = await ensureSnapshotRun(client, envelope, consumerId);
    if (status !== "running") {
      throw contractError(
        "MBT_CUSTOMER_MASTER_SNAPSHOT_COMPLETE",
        "Customer master snapshot is already complete."
      );
    }
    let applied = { created: 0, updated: 0, conflicted: 0 };
    const firstCustomer = envelope.customers[0];
    if (firstCustomer) {
      applied = await applyCanonicalCustomerAggregatesInTransaction(client, {
        accountId: envelope.accountId,
        sourceKind: firstCustomer.sourceKind ?? "customer_master_event",
        aggregates: envelope.customers
      }, { runId: envelope.snapshotId, publishEvents: false });
    }
    await client.query(
      `INSERT INTO mbt_customer_master_snapshot_pages (
         consumer_id, snapshot_id, page_cursor, account_id, subsidiary_id,
         page_hash, record_count, complete
       ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8)`,
      [
        consumerId,
        envelope.snapshotId,
        envelope.pageCursor,
        envelope.accountId,
        envelope.subsidiaryId,
        pageHash,
        envelope.customers.length,
        envelope.complete
      ]
    );
    await client.query(
      `UPDATE netsuite_customer_sync_runs
          SET pages_applied = pages_applied + 1,
              records_seen = records_seen + $2,
              records_applied = records_applied + $3,
              records_conflicted = records_conflicted + $4
        WHERE run_id = $1::uuid`,
      [
        envelope.snapshotId,
        envelope.customers.length,
        Number(applied.created) + Number(applied.updated),
        Number(applied.conflicted)
      ]
    );
    let inactivated = 0;
    if (envelope.complete) {
      inactivated = await inactivateMissingSnapshotCustomers(client, envelope);
      await client.query(
        `UPDATE netsuite_customer_sync_runs
            SET status = 'completed', completed_at = now(),
                records_applied = records_applied + $2
          WHERE run_id = $1::uuid`,
        [envelope.snapshotId, inactivated]
      );
      await client.query(
        `INSERT INTO mbt_customer_master_consumer_state (
           consumer_id, account_id, subsidiary_key, high_water_sequence,
           last_complete_snapshot_id, last_success_at
         ) VALUES ($1, $2, COALESCE($3::bigint, 0), 0, $4::uuid, now())
         ON CONFLICT (consumer_id, account_id, subsidiary_key) DO UPDATE
         SET last_complete_snapshot_id = EXCLUDED.last_complete_snapshot_id,
             revision = mbt_customer_master_consumer_state.revision + 1,
             last_success_at = now(),
             updated_at = now()`,
        [consumerId, envelope.accountId, envelope.subsidiaryId, envelope.snapshotId]
      );
    }
    return {
      accepted: envelope.customers.length,
      replayed: false,
      complete: envelope.complete,
      inactivated
    };
  });
}

/** @param {unknown} database @param {Record<string, unknown>} input */
export async function readCustomerMasterConsumerState(database, input) {
  const consumerId = requiredText(input.consumerId, "Customer master consumer ID");
  const accountId = requiredText(input.accountId, "Customer master account ID");
  const subsidiary = subsidiaryId(input.subsidiaryId, "Customer master subsidiary ID");
  const result = await customerDatabase(database).query(
    `SELECT high_water_sequence::text AS high_water_sequence,
            last_complete_snapshot_id::text AS last_complete_snapshot_id,
            revision::text AS revision, last_success_at
       FROM mbt_customer_master_consumer_state
      WHERE consumer_id = $1 AND account_id = $2
        AND subsidiary_key = COALESCE($3::bigint, 0)`,
    [consumerId, accountId, subsidiary]
  );
  const row = result.rows[0];
  return {
    contract: CUSTOMER_MASTER_CONTRACT,
    consumerId,
    accountId,
    subsidiaryId: subsidiary === null ? null : publicId(subsidiary),
    highWaterSequence: row ? publicId(String(row.high_water_sequence)) : 0,
    lastCompleteSnapshotId: row?.last_complete_snapshot_id || null,
    revision: row ? publicId(String(row.revision)) : 0,
    lastSuccessAt: row?.last_success_at
      ? new Date(String(row.last_success_at)).toISOString()
      : null
  };
}
