// @ts-check

import crypto from "node:crypto";

import { canonicalSha256 } from "./canonical-json.js";
import { customerDatabase, withCustomerTransaction } from "./customer-database.js";
import { decideCustomerObservation } from "./customer-source-rules.js";
import { MbtError } from "./errors.js";
import { compareCommandPayload, hashCommandPayload } from "./idempotency.js";
import { projectCanonicalCustomerForReturns } from "./return-customer-projection.js";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_SYNC_PAGES = 10_000;

/**
 * @typedef {object} CanonicalAggregate
 * @property {string} netsuiteId
 * @property {string} entityNumber
 * @property {string} legalName
 * @property {string} displayName
 * @property {string} currency
 * @property {string | null} terms
 * @property {string | null} taxStatus
 * @property {string | null} creditStatus
 * @property {string} email
 * @property {string} phone
 * @property {boolean} active
 * @property {"netsuite_read" | "customer_master_event" | "csv_bootstrap"} sourceKind
 * @property {string} sourceAccountId
 * @property {string} sourceModifiedAt
 * @property {string} sourceVersion
 * @property {string} payloadHash
 * @property {Record<string, unknown>[]} subsidiaries
 * @property {Record<string, unknown>[]} addresses
 * @property {Record<string, unknown>[]} contacts
 */

/** @param {string} code @param {string} message @param {number} [status] */
function customerError(code, message, status = 409) {
  return new MbtError({ status, code, message });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value */
function nullableText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

/** @param {unknown} value */
function plainText(value) {
  return value === null || value === undefined ? "" : String(value);
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

/** @param {string} value */
function publicId(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  const parsed = new Date(String(value ?? ""));
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

/** @param {unknown} value */
function sourceKind(value) {
  const normalized = String(value ?? "");
  if (normalized !== "netsuite_read"
      && normalized !== "customer_master_event"
      && normalized !== "csv_bootstrap") {
    throw new TypeError("Customer source kind is not supported.");
  }
  return /** @type {CanonicalAggregate["sourceKind"]} */ (normalized);
}

/** @param {unknown} value @param {string} label */
function sha256(value, label) {
  const normalized = String(value ?? "");
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new TypeError(`${label} must be a SHA-256 hash.`);
  }
  return normalized;
}

/** @param {unknown} value */
function objectArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => (
    !entry || typeof entry !== "object" || Array.isArray(entry)
  ))) {
    throw new TypeError("Customer child aggregates must be object arrays.");
  }
  return /** @type {Record<string, unknown>[]} */ (value);
}

/** @param {unknown} value @param {object} defaults @param {unknown} defaults.sourceKind @param {unknown} defaults.accountId */
function normalizeAggregate(value, defaults) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A canonical customer aggregate is required.");
  }
  const row = /** @type {Record<string, unknown>} */ (value);
  const currency = requiredText(row.currency, "Customer currency").toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new TypeError("Customer currency must be a three-letter ISO code.");
  }
  return /** @type {CanonicalAggregate} */ ({
    netsuiteId: positiveIdText(row.netsuiteId, "Customer NetSuite ID"),
    entityNumber: requiredText(row.entityNumber, "Customer entity number"),
    legalName: requiredText(row.legalName, "Customer legal name"),
    displayName: requiredText(row.displayName, "Customer display name"),
    currency,
    terms: nullableText(row.terms),
    taxStatus: nullableText(row.taxStatus),
    creditStatus: nullableText(row.creditStatus),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    active: row.active !== false,
    sourceKind: sourceKind(row.sourceKind ?? defaults.sourceKind),
    sourceAccountId: requiredText(
      row.sourceAccountId ?? defaults.accountId,
      "Customer source account ID"
    ),
    sourceModifiedAt: timestamp(row.sourceModifiedAt, "Customer source modified time"),
    sourceVersion: requiredText(row.sourceVersion, "Customer source version"),
    payloadHash: sha256(row.payloadHash, "Customer payload hash"),
    subsidiaries: objectArray(row.subsidiaries),
    addresses: objectArray(row.addresses),
    contacts: objectArray(row.contacts)
  });
}

/** @param {unknown} value @param {object} defaults @param {unknown} defaults.sourceKind @param {unknown} defaults.accountId */
function normalizeAggregates(value, defaults) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("At least one canonical customer aggregate is required.");
  }
  const normalized = value.map((row) => normalizeAggregate(row, defaults));
  normalized.sort((left, right) => {
    const leftId = BigInt(left.netsuiteId);
    const rightId = BigInt(right.netsuiteId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const identities = new Set(normalized.map(({ netsuiteId }) => netsuiteId));
  if (identities.size !== normalized.length) {
    throw customerError(
      "MBT_CUSTOMER_SOURCE_INVALID",
      "A customer batch cannot contain duplicate NetSuite internal IDs.",
      400
    );
  }
  return normalized;
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {string} customerId */
async function currentCustomer(database, customerId) {
  const result = await database.query(
    `SELECT c.netsuite_id::text AS netsuite_id, c.entity_number, c.legal_name,
            c.display_name, c.currency, c.terms, c.tax_status, c.credit_status,
            c.email, c.phone, c.active, c.source_modified_at,
            c.source_version, c.payload_hash, c.last_seen_run_id,
            p.source_kind, p.source_account_id,
            p.last_live_netsuite_observation_at
       FROM netsuite_customers c
       LEFT JOIN mbt_customer_provenance p
         ON p.customer_netsuite_id = c.netsuite_id
      WHERE c.netsuite_id = $1
      FOR UPDATE OF c`,
    [customerId]
  );
  return result.rows[0] || null;
}

/** @param {Record<string, unknown>} row */
function currentObservation(row) {
  return {
    netsuiteId: String(row.netsuite_id),
    sourceKind: row.source_kind ? String(row.source_kind) : "netsuite_read",
    sourceModifiedAt: new Date(String(row.source_modified_at)).toISOString(),
    sourceVersion: String(row.source_version),
    payloadHash: String(row.payload_hash)
  };
}

/** @param {CanonicalAggregate} aggregate */
function incomingObservation(aggregate) {
  return {
    netsuiteId: aggregate.netsuiteId,
    sourceKind: aggregate.sourceKind,
    sourceModifiedAt: aggregate.sourceModifiedAt,
    sourceVersion: aggregate.sourceVersion,
    payloadHash: aggregate.payloadHash
  };
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate @param {string} runId */
async function upsertCustomerCore(database, aggregate, runId) {
  await database.query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency, terms,
       tax_status, credit_status, email, phone, active, source_modified_at,
       source_version, payload_hash, last_seen_run_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12::timestamptz, $13, $14, $15::uuid
     )
     ON CONFLICT (netsuite_id) DO UPDATE
     SET entity_number = EXCLUDED.entity_number,
         legal_name = EXCLUDED.legal_name,
         display_name = EXCLUDED.display_name,
         currency = EXCLUDED.currency,
         terms = EXCLUDED.terms,
         tax_status = EXCLUDED.tax_status,
         credit_status = EXCLUDED.credit_status,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         active = EXCLUDED.active,
         source_modified_at = EXCLUDED.source_modified_at,
         source_version = EXCLUDED.source_version,
         payload_hash = EXCLUDED.payload_hash,
         last_seen_run_id = EXCLUDED.last_seen_run_id,
         updated_at = now()`,
    [
      aggregate.netsuiteId,
      aggregate.entityNumber,
      aggregate.legalName,
      aggregate.displayName,
      aggregate.currency,
      aggregate.terms,
      aggregate.taxStatus,
      aggregate.creditStatus,
      aggregate.email,
      aggregate.phone,
      aggregate.active,
      aggregate.sourceModifiedAt,
      aggregate.sourceVersion,
      aggregate.payloadHash,
      runId
    ]
  );
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate */
async function upsertProvenance(database, aggregate) {
  const liveObservedAt = aggregate.sourceKind === "netsuite_read"
    ? aggregate.sourceModifiedAt
    : null;
  await database.query(
    `INSERT INTO mbt_customer_provenance (
       customer_netsuite_id, source_kind, source_account_id, source_version,
       payload_hash, last_live_netsuite_observation_at
     ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
     ON CONFLICT (customer_netsuite_id) DO UPDATE
     SET source_kind = EXCLUDED.source_kind,
         source_account_id = EXCLUDED.source_account_id,
         source_version = EXCLUDED.source_version,
         payload_hash = EXCLUDED.payload_hash,
         last_live_netsuite_observation_at = COALESCE(
           EXCLUDED.last_live_netsuite_observation_at,
           mbt_customer_provenance.last_live_netsuite_observation_at
         ),
         updated_at = now()`,
    [
      aggregate.netsuiteId,
      aggregate.sourceKind,
      aggregate.sourceAccountId,
      aggregate.sourceVersion,
      aggregate.payloadHash,
      liveObservedAt
    ]
  );
}

/** @param {Record<string, unknown>} row @param {CanonicalAggregate} aggregate */
function childSource(row, aggregate) {
  return {
    modifiedAt: timestamp(
      row.sourceModifiedAt ?? aggregate.sourceModifiedAt,
      "Customer child source modified time"
    ),
    version: requiredText(
      row.sourceVersion ?? aggregate.sourceVersion,
      "Customer child source version"
    ),
    hash: canonicalSha256(row)
  };
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate @param {string} runId */
async function upsertSubsidiaries(database, aggregate, runId) {
  for (const row of aggregate.subsidiaries) {
    const source = childSource(row, aggregate);
    await database.query(
      `INSERT INTO netsuite_customer_subsidiaries (
         customer_netsuite_id, subsidiary_netsuite_id, relationship_name,
         primary_relationship, currency, terms, tax_status, credit_status,
         active, source_modified_at, source_version, payload_hash,
         last_seen_run_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::timestamptz, $11, $12, $13::uuid
       )
       ON CONFLICT (customer_netsuite_id, subsidiary_netsuite_id) DO UPDATE
       SET relationship_name = EXCLUDED.relationship_name,
           primary_relationship = EXCLUDED.primary_relationship,
           currency = EXCLUDED.currency,
           terms = EXCLUDED.terms,
           tax_status = EXCLUDED.tax_status,
           credit_status = EXCLUDED.credit_status,
           active = EXCLUDED.active,
           source_modified_at = EXCLUDED.source_modified_at,
           source_version = EXCLUDED.source_version,
           payload_hash = EXCLUDED.payload_hash,
           last_seen_run_id = EXCLUDED.last_seen_run_id,
           updated_at = now()`,
      [
        aggregate.netsuiteId,
        positiveIdText(row.netsuiteId, "Customer subsidiary NetSuite ID"),
        String(row.relationshipName ?? ""),
        row.primary === true,
        nullableText(row.currency),
        nullableText(row.terms),
        nullableText(row.taxStatus),
        nullableText(row.creditStatus),
        row.active !== false,
        source.modifiedAt,
        source.version,
        source.hash,
        runId
      ]
    );
  }
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate @param {string} runId */
async function upsertAddresses(database, aggregate, runId) {
  for (const row of aggregate.addresses) {
    const source = childSource(row, aggregate);
    await database.query(
      `INSERT INTO netsuite_customer_addresses (
         address_id, customer_netsuite_id, netsuite_address_id, label,
         billing_default, shipping_default, addressee, attention,
         address_line_1, address_line_2, address_line_3, city, region,
         postal_code, country_code, phone, active, source_modified_at,
         source_version, payload_hash, last_seen_run_id
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18::timestamptz, $19, $20, $21::uuid
       )
       ON CONFLICT (customer_netsuite_id, netsuite_address_id) DO UPDATE
       SET label = EXCLUDED.label,
           billing_default = EXCLUDED.billing_default,
           shipping_default = EXCLUDED.shipping_default,
           addressee = EXCLUDED.addressee,
           attention = EXCLUDED.attention,
           address_line_1 = EXCLUDED.address_line_1,
           address_line_2 = EXCLUDED.address_line_2,
           address_line_3 = EXCLUDED.address_line_3,
           city = EXCLUDED.city,
           region = EXCLUDED.region,
           postal_code = EXCLUDED.postal_code,
           country_code = EXCLUDED.country_code,
           phone = EXCLUDED.phone,
           active = EXCLUDED.active,
           source_modified_at = EXCLUDED.source_modified_at,
           source_version = EXCLUDED.source_version,
           payload_hash = EXCLUDED.payload_hash,
           last_seen_run_id = EXCLUDED.last_seen_run_id,
           updated_at = now()`,
      [
        crypto.randomUUID(),
        aggregate.netsuiteId,
        requiredText(row.netsuiteAddressId, "Customer address NetSuite ID"),
        plainText(row.label),
        row.billingDefault === true,
        row.shippingDefault === true,
        plainText(row.addressee),
        plainText(row.attention),
        plainText(row.addressLine1),
        plainText(row.addressLine2),
        plainText(row.addressLine3),
        plainText(row.city),
        plainText(row.region),
        plainText(row.postalCode),
        plainText(row.countryCode).toUpperCase(),
        plainText(row.phone),
        row.active !== false,
        source.modifiedAt,
        source.version,
        source.hash,
        runId
      ]
    );
  }
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate @param {string} runId */
async function upsertContacts(database, aggregate, runId) {
  for (const row of aggregate.contacts) {
    const source = childSource(row, aggregate);
    await database.query(
      `INSERT INTO netsuite_customer_contacts (
         contact_id, customer_netsuite_id, netsuite_contact_id, display_name,
         first_name, last_name, job_title, email, phone, mobile_phone,
         primary_contact, active, source_modified_at, source_version,
         payload_hash, last_seen_run_id
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13::timestamptz, $14, $15, $16::uuid
       )
       ON CONFLICT (customer_netsuite_id, netsuite_contact_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           job_title = EXCLUDED.job_title,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           mobile_phone = EXCLUDED.mobile_phone,
           primary_contact = EXCLUDED.primary_contact,
           active = EXCLUDED.active,
           source_modified_at = EXCLUDED.source_modified_at,
           source_version = EXCLUDED.source_version,
           payload_hash = EXCLUDED.payload_hash,
           last_seen_run_id = EXCLUDED.last_seen_run_id,
           updated_at = now()`,
      [
        crypto.randomUUID(),
        aggregate.netsuiteId,
        requiredText(row.netsuiteContactId, "Customer contact NetSuite ID"),
        requiredText(row.displayName, "Customer contact display name"),
        String(row.firstName ?? ""),
        String(row.lastName ?? ""),
        String(row.jobTitle ?? ""),
        String(row.email ?? ""),
        String(row.phone ?? ""),
        String(row.mobilePhone ?? ""),
        row.primary === true,
        row.active !== false,
        source.modifiedAt,
        source.version,
        source.hash,
        runId
      ]
    );
  }
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate @param {string} runId */
async function upsertAggregate(database, aggregate, runId) {
  await upsertCustomerCore(database, aggregate, runId);
  await upsertProvenance(database, aggregate);
  await upsertSubsidiaries(database, aggregate, runId);
  await upsertAddresses(database, aggregate, runId);
  await upsertContacts(database, aggregate, runId);
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {string} customerId @param {string} runId */
async function markSeen(database, customerId, runId) {
  await database.query(
    "UPDATE netsuite_customers SET last_seen_run_id = $2::uuid WHERE netsuite_id = $1",
    [customerId, runId]
  );
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate */
async function upsertReturnProjection(database, aggregate) {
  const projected = projectCanonicalCustomerForReturns(
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (aggregate))
  );
  if (!projected) {
    await database.query(
      "DELETE FROM return_customer_directory WHERE netsuite_customer_id = $1",
      [aggregate.netsuiteId]
    );
    return;
  }
  await database.query(
    `INSERT INTO return_customer_directory (
       netsuite_customer_id, entity_code, company_name, display_name,
       phone, phone_digits, address, synced_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (netsuite_customer_id) DO UPDATE
     SET entity_code = EXCLUDED.entity_code,
         company_name = EXCLUDED.company_name,
         display_name = EXCLUDED.display_name,
         phone = EXCLUDED.phone,
         phone_digits = EXCLUDED.phone_digits,
         address = EXCLUDED.address,
         synced_at = now()`,
    [
      aggregate.netsuiteId,
      projected.entityId,
      projected.companyName,
      projected.name,
      projected.phone,
      projected.phone.replace(/\D/g, ""),
      projected.address
    ]
  );
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate @param {string | null | undefined} runId */
async function insertConflict(database, aggregate, runId) {
  if (!runId) {
    throw new TypeError("A customer conflict requires a durable sync/apply run.");
  }
  const current = await currentCustomer(database, aggregate.netsuiteId);
  await database.query(
    `INSERT INTO netsuite_customer_sync_conflicts (
       conflict_id, run_id, entity_type, customer_netsuite_id, external_id,
       current_source_modified_at, incoming_source_modified_at,
       current_payload_hash, incoming_payload_hash, current_snapshot,
       incoming_snapshot, status
     ) VALUES (
       $1::uuid, $2::uuid, 'customer', $3::bigint, $3::bigint::text,
       $4::timestamptz, $5::timestamptz, $6, $7, $8::jsonb, $9::jsonb, 'open'
     )
     ON CONFLICT DO NOTHING`,
    [
      crypto.randomUUID(),
      runId,
      aggregate.netsuiteId,
      current?.source_modified_at || null,
      aggregate.sourceModifiedAt,
      current?.payload_hash || null,
      aggregate.payloadHash,
      current ? JSON.stringify(current) : null,
      JSON.stringify(aggregate)
    ]
  );
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {CanonicalAggregate} aggregate @param {string} runId */
async function appendCustomerEvent(database, aggregate, runId) {
  await database.query(
    `INSERT INTO mbt_customer_master_events (
       event_uuid, account_id, subsidiary_id, customer_netsuite_id,
       change_type, source_kind, source_version, payload_hash,
       aggregate_payload
     )
     SELECT $1::uuid, r.account_id, r.subsidiary_id, $2,
            $3, $4, $5, $6, $7::jsonb
       FROM netsuite_customer_sync_runs r
      WHERE r.run_id = $8::uuid
     ON CONFLICT (customer_netsuite_id, source_kind, source_version, payload_hash)
     DO NOTHING`,
    [
      crypto.randomUUID(),
      aggregate.netsuiteId,
      aggregate.active ? "upsert" : "inactivate",
      aggregate.sourceKind,
      aggregate.sourceVersion,
      aggregate.payloadHash,
      JSON.stringify(aggregate),
      runId
    ]
  );
}

/** @param {Record<string, number>} counts @param {string} action */
function incrementCount(counts, action) {
  counts[action] = (counts[action] || 0) + 1;
}

/**
 * Internal transaction-aware apply used by direct commands, sync pages, and
 * customer-master consumers. It never opens or commits a transaction itself.
 *
 * @param {unknown} database
 * @param {Record<string, unknown>} input
 * @param {{runId: string, publishEvents?: boolean, hooks?: {afterCanonicalApply?: () => Promise<void> | void}}} options
 */
export async function applyCanonicalCustomerAggregatesInTransaction(database, input, options) {
  const db = customerDatabase(database);
  const aggregates = normalizeAggregates(input.aggregates, {
    sourceKind: input.sourceKind,
    accountId: input.accountId
  });
  const counts = { created: 0, updated: 0, unchanged: 0, conflicted: 0, ignored: 0 };
  /** @type {Array<{customerNetSuiteId: number | string, action: string}>} */
  const outcomes = [];
  /** @type {CanonicalAggregate[]} */
  const applied = [];
  for (const aggregate of aggregates) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `mbt:customer:${aggregate.netsuiteId}`
    ]);
    const current = await currentCustomer(db, aggregate.netsuiteId);
    const decision = decideCustomerObservation(
      current ? currentObservation(current) : null,
      incomingObservation(aggregate)
    );
    /** @type {string} */
    let action = decision.action;
    if (decision.action === "apply") {
      action = current ? "updated" : "created";
      await upsertAggregate(db, aggregate, options.runId);
      applied.push(aggregate);
    } else if (decision.action === "conflict") {
      action = "conflicted";
      await insertConflict(db, aggregate, options.runId);
    } else {
      action = decision.action === "ignore" ? "ignored" : "unchanged";
      await markSeen(db, aggregate.netsuiteId, options.runId);
    }
    incrementCount(counts, action);
    outcomes.push({ customerNetSuiteId: publicId(aggregate.netsuiteId), action });
  }
  await options.hooks?.afterCanonicalApply?.();
  for (const aggregate of applied) {
    await upsertReturnProjection(db, aggregate);
    if (options.publishEvents !== false) {
      await appendCustomerEvent(db, aggregate, options.runId);
    }
  }
  return { ...counts, outcomes };
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {Record<string, unknown>} input @param {string} runId */
async function insertApplyRun(database, input, runId) {
  await database.query(
    `INSERT INTO netsuite_customer_sync_runs (
       run_id, sync_kind, status, account_id, subsidiary_id, requested_by,
       correlation_id, pages_expected, pages_applied, records_seen,
       records_applied, records_conflicted, started_at, completed_at, metadata
     ) VALUES (
       $1::uuid, 'incremental', 'completed', $2, $3, $4, $5,
       1, 1, $6, 0, 0, now(), now(), $7::jsonb
     )`,
    [
      runId,
      requiredText(input.accountId, "Customer apply account ID"),
      input.subsidiaryId ?? null,
      requiredText(input.actorId, "Customer apply actor ID"),
      requiredText(input.correlationId, "Customer apply correlation ID"),
      Array.isArray(input.aggregates) ? input.aggregates.length : 0,
      JSON.stringify({ sourceKind: sourceKind(input.sourceKind), applyOnly: true })
    ]
  );
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {Record<string, unknown>} input @param {string} runId @param {Record<string, unknown>} result */
async function finalizeApplyEvidence(database, input, runId, result) {
  await database.query(
    `UPDATE netsuite_customer_sync_runs
        SET records_applied = $2,
            records_conflicted = $3,
            metadata = metadata || $4::jsonb
      WHERE run_id = $1::uuid`,
    [
      runId,
      Number(result.created || 0) + Number(result.updated || 0),
      Number(result.conflicted || 0),
      JSON.stringify({ outcomes: result.outcomes })
    ]
  );
  const actorId = requiredText(input.actorId, "Customer apply actor ID");
  const correlationId = requiredText(input.correlationId, "Customer apply correlation ID");
  const idempotencyKey = requiredText(input.idempotencyKey, "Customer apply idempotency key");
  const requestId = String(input.requestId || correlationId);
  const entityId = String(
    Array.isArray(result.outcomes) && result.outcomes[0]
      ? /** @type {Record<string, unknown>} */ (result.outcomes[0]).customerNetSuiteId
      : runId
  );
  await database.query(
    `INSERT INTO mbt_audit_events (
       audit_event_id, actor_type, actor_operator_id, actor_roles, action,
       entity_type, entity_id, before_state, after_state, reason,
       revision_before, revision_after, correlation_id, request_id,
       idempotency_key, source
     ) VALUES (
       $1::uuid, 'operator', $2, ARRAY['admin']::text[],
       'mbt.customer.canonical_applied', 'customer', $3,
       '{}'::jsonb, $4::jsonb, $5, 1, 1, $6, $7, $8, 'customer_sync'
     )`,
    [
      crypto.randomUUID(),
      actorId,
      entityId,
      JSON.stringify(result),
      String(input.reason || "Apply canonical customer observations."),
      correlationId,
      requestId,
      idempotencyKey
    ]
  );
}

/** @param {Record<string, unknown>} input */
function canonicalCommandPayload(input) {
  return {
    accountId: input.accountId,
    subsidiaryId: input.subsidiaryId ?? null,
    sourceKind: input.sourceKind,
    sourceAsOf: input.sourceAsOf,
    sourceVersion: input.sourceVersion,
    aggregates: input.aggregates,
    reason: input.reason || "Apply canonical customer observations."
  };
}

/**
 * @param {unknown} database
 * @param {Record<string, unknown>} input
 */
export async function applyCanonicalCustomerAggregates(database, input) {
  const commandName = "mbt.customer.canonical.apply";
  const actorId = requiredText(input.actorId, "Customer apply actor ID");
  const idempotencyKey = requiredText(input.idempotencyKey, "Customer apply idempotency key");
  const payload = canonicalCommandPayload(input);
  const payloadHash = hashCommandPayload(payload);
  const command = await withCustomerTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify([actorId, commandName, idempotencyKey])
    ]);
    const existing = await client.query(
      `SELECT canonical_payload_hash, response_body
         FROM mbt_command_receipts
        WHERE actor_operator_id = $1
          AND command_name = $2
          AND idempotency_key = $3`,
      [actorId, commandName, idempotencyKey]
    );
    const existingReceipt = existing.rows[0];
    if (existingReceipt) {
      compareCommandPayload(existingReceipt.canonical_payload_hash, payload);
      return {
        replayed: true,
        body: /** @type {{result: Record<string, unknown>}} */ (existingReceipt.response_body)
      };
    }
    const runId = crypto.randomUUID();
    await insertApplyRun(client, input, runId);
    const hooks = /** @type {{afterCanonicalApply?: () => Promise<void> | void} | undefined} */ (
      input.hooks
    );
    const result = await applyCanonicalCustomerAggregatesInTransaction(
      client,
      input,
      hooks ? { runId, publishEvents: true, hooks } : { runId, publishEvents: true }
    );
    await finalizeApplyEvidence(client, input, runId, result);
    const body = { result };
    await client.query(
      `INSERT INTO mbt_command_receipts (
         receipt_id, actor_operator_id, actor_roles, command_name,
         idempotency_key, canonical_payload_hash, http_status, response_body,
         entity_type, entity_id, correlation_id, request_id
       ) VALUES (
         $1::uuid, $2, ARRAY['admin']::text[], $3, $4, $5,
         200, $6::jsonb, 'customer', $7, $8, $9
       )`,
      [
        crypto.randomUUID(),
        actorId,
        commandName,
        idempotencyKey,
        payloadHash,
        JSON.stringify(body),
        String(result.outcomes[0]?.customerNetSuiteId || runId),
        requiredText(input.correlationId, "Customer apply correlation ID"),
        String(input.requestId || input.correlationId)
      ]
    );
    return { replayed: false, body };
  });
  const result = command.body.result;
  return { ...result, result, replayed: command.replayed };
}

/** @param {unknown} database @param {unknown} customerNetSuiteId */
export async function readCustomerProvenance(database, customerNetSuiteId) {
  const id = positiveIdText(customerNetSuiteId, "Customer NetSuite ID");
  const result = await customerDatabase(database).query(
    `SELECT customer_netsuite_id::text AS customer_netsuite_id,
            source_kind, source_account_id, source_version,
            last_live_netsuite_observation_at
       FROM mbt_customer_provenance
      WHERE customer_netsuite_id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    customerNetSuiteId: publicId(String(row.customer_netsuite_id)),
    sourceKind: String(row.source_kind),
    sourceAccountId: String(row.source_account_id),
    sourceVersion: String(row.source_version),
    lastLiveNetSuiteObservationAt: row.last_live_netsuite_observation_at || null
  };
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? String(/** @type {{code?: unknown}} */ (error).code || "")
    : "";
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {Record<string, unknown>} input @param {string} runId */
async function claimSyncRun(database, input, runId) {
  try {
    await database.query(
      `INSERT INTO netsuite_customer_sync_runs (
         run_id, sync_kind, status, account_id, subsidiary_id, requested_by,
         correlation_id, started_at, metadata
       ) VALUES ($1::uuid, $2, 'running', $3, $4, $5, $6, now(), $7::jsonb)`,
      [
        runId,
        input.syncKind,
        input.accountId,
        input.subsidiaryId ?? null,
        input.requestedBy,
        input.correlationId,
        JSON.stringify({ sourceKind: input.sourceKind })
      ]
    );
    return true;
  } catch (error) {
    if (errorCode(error) === "23505") {
      return false;
    }
    throw error;
  }
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {string} syncKey */
async function readSyncCursor(database, syncKey) {
  const result = await database.query(
    `SELECT incremental_cursor_modified_at, incremental_cursor_external_id
       FROM netsuite_customer_sync_state WHERE sync_key = $1`,
    [syncKey]
  );
  const row = result.rows[0];
  if (!row?.incremental_cursor_modified_at) {
    return null;
  }
  return {
    modifiedAt: new Date(String(row.incremental_cursor_modified_at)).toISOString(),
    internalId: publicId(String(row.incremental_cursor_external_id))
  };
}

/** @param {unknown} value */
function sourcePage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw customerError("MBT_CUSTOMER_SOURCE_INVALID", "Customer source returned an invalid page.", 502);
  }
  const page = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(page.records)) {
    throw customerError("MBT_CUSTOMER_SOURCE_INVALID", "Customer source page records must be an array.", 502);
  }
  return {
    records: page.records,
    nextCursor: page.nextCursor ?? null,
    complete: page.complete === true,
    snapshotComplete: page.snapshotComplete === true
  };
}

/** @param {CanonicalAggregate[]} records */
function finalRecordCursor(records) {
  const final = records[records.length - 1];
  return final ? { modifiedAt: final.sourceModifiedAt, internalId: publicId(final.netsuiteId) } : null;
}

/** @param {unknown} cursorValue */
function normalizeCursor(cursorValue) {
  if (!cursorValue || typeof cursorValue !== "object" || Array.isArray(cursorValue)) {
    return null;
  }
  const cursor = /** @type {Record<string, unknown>} */ (cursorValue);
  return {
    modifiedAt: timestamp(cursor.modifiedAt, "Customer sync cursor modified time"),
    internalId: publicId(positiveIdText(cursor.internalId, "Customer sync cursor internal ID"))
  };
}

/** @param {Record<string, unknown>} input @param {unknown} initialCursor */
async function fetchSyncSnapshot(input, initialCursor) {
  const source = input.source && typeof input.source === "object"
    ? /** @type {{fetchPage?: unknown}} */ (input.source)
    : {};
  if (typeof source.fetchPage !== "function") {
    throw new TypeError("A customer source page reader is required.");
  }
  /** @type {unknown[]} */
  const records = [];
  let cursor = normalizeCursor(initialCursor);
  let pagesApplied = 0;
  let finalSnapshotComplete = false;
  let complete = false;
  while (pagesApplied < MAX_SYNC_PAGES) {
    const page = sourcePage(await source.fetchPage({
      cursor,
      limit: input.pageSize,
      syncKind: input.syncKind
    }));
    records.push(...page.records);
    pagesApplied += 1;
    finalSnapshotComplete = page.snapshotComplete;
    const next = normalizeCursor(page.nextCursor);
    if (page.complete) {
      cursor = next;
      complete = true;
      break;
    }
    if (!next) {
      throw customerError(
        "MBT_CUSTOMER_SNAPSHOT_INCOMPLETE",
        "Customer source stopped before completing its snapshot.",
        502
      );
    }
    cursor = next;
  }
  if (!complete) {
    throw customerError("MBT_CUSTOMER_SOURCE_INVALID", "Customer source exceeded its page bound.", 502);
  }
  const normalized = records.length
    ? normalizeAggregates(records, { sourceKind: input.sourceKind, accountId: input.accountId })
    : [];
  return {
    records: normalized,
    pagesApplied,
    cursor: cursor || finalRecordCursor(normalized),
    snapshotComplete: finalSnapshotComplete
  };
}

/** @param {Record<string, unknown>} input @param {{records: CanonicalAggregate[], snapshotComplete: boolean}} snapshot */
function validateCompleteSnapshot(input, snapshot) {
  if (input.syncKind !== "full_reconciliation") {
    return;
  }
  if (snapshot.records.length === 0) {
    throw customerError(
      "MBT_CUSTOMER_SNAPSHOT_EMPTY",
      "An empty full customer snapshot cannot replace canonical state.",
      409
    );
  }
  if (!snapshot.snapshotComplete) {
    throw customerError(
      "MBT_CUSTOMER_SNAPSHOT_INCOMPLETE",
      "An incomplete customer snapshot cannot replace canonical state.",
      409
    );
  }
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {Record<string, unknown>} input @param {string} runId @param {CanonicalAggregate[]} seen */
async function inactivateMissingFullCustomers(database, input, runId, seen) {
  if (input.syncKind !== "full_reconciliation") {
    return 0;
  }
  const ids = seen.map(({ netsuiteId }) => netsuiteId);
  const missing = await database.query(
    `SELECT c.netsuite_id::text AS netsuite_id, c.entity_number, c.legal_name,
            c.display_name, c.currency, c.terms, c.tax_status, c.credit_status,
            c.email, c.phone, c.source_modified_at, c.source_version,
            c.payload_hash, p.source_kind, p.source_account_id
       FROM netsuite_customers c
       JOIN mbt_customer_provenance p ON p.customer_netsuite_id = c.netsuite_id
      WHERE p.source_account_id = $1
        AND c.active
        AND NOT (c.netsuite_id = ANY($2::bigint[]))
        AND ($3::bigint IS NULL OR EXISTS (
          SELECT 1 FROM netsuite_customer_subsidiaries s
           WHERE s.customer_netsuite_id = c.netsuite_id
             AND s.subsidiary_netsuite_id = $3
        ))
      FOR UPDATE OF c`,
    [input.accountId, ids, input.subsidiaryId ?? null]
  );
  for (const row of missing.rows) {
    const version = `full-inactive:${runId}`;
    const aggregate = /** @type {CanonicalAggregate} */ ({
      netsuiteId: String(row.netsuite_id),
      entityNumber: String(row.entity_number),
      legalName: String(row.legal_name),
      displayName: String(row.display_name),
      currency: String(row.currency),
      terms: nullableText(row.terms),
      taxStatus: nullableText(row.tax_status),
      creditStatus: nullableText(row.credit_status),
      email: String(row.email || ""),
      phone: String(row.phone || ""),
      active: false,
      sourceKind: sourceKind(row.source_kind || "netsuite_read"),
      sourceAccountId: String(row.source_account_id),
      sourceModifiedAt: new Date().toISOString(),
      sourceVersion: version,
      payloadHash: canonicalSha256({ netsuiteId: String(row.netsuite_id), active: false, version }),
      subsidiaries: [],
      addresses: [],
      contacts: []
    });
    await upsertAggregate(database, aggregate, runId);
    await upsertReturnProjection(database, aggregate);
    await appendCustomerEvent(database, aggregate, runId);
  }
  return missing.rows.length;
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {Record<string, unknown>} input @param {string} runId @param {Record<string, unknown>} cursorValue */
async function updateSyncState(database, input, runId, cursorValue) {
  await database.query(
    `INSERT INTO netsuite_customer_sync_state (
       sync_key, account_id, subsidiary_id, incremental_cursor_modified_at,
       incremental_cursor_external_id, last_incremental_run_id,
       last_complete_full_run_id, last_success_at, revision
     ) VALUES (
       $1, $2, $3, $4::timestamptz, $5,
       CASE WHEN $6 = 'incremental' THEN $7::uuid ELSE NULL END,
       CASE WHEN $6 = 'full_reconciliation' THEN $7::uuid ELSE NULL END,
       now(), 1
     )
     ON CONFLICT (sync_key) DO UPDATE
     SET account_id = EXCLUDED.account_id,
         subsidiary_id = EXCLUDED.subsidiary_id,
         incremental_cursor_modified_at = EXCLUDED.incremental_cursor_modified_at,
         incremental_cursor_external_id = EXCLUDED.incremental_cursor_external_id,
         last_incremental_run_id = CASE
           WHEN $6 = 'incremental' THEN $7::uuid
           ELSE netsuite_customer_sync_state.last_incremental_run_id
         END,
         last_complete_full_run_id = CASE
           WHEN $6 = 'full_reconciliation' THEN $7::uuid
           ELSE netsuite_customer_sync_state.last_complete_full_run_id
         END,
         last_success_at = now(),
         revision = netsuite_customer_sync_state.revision + 1,
         updated_at = now()`,
    [
      input.syncKey,
      input.accountId,
      input.subsidiaryId ?? null,
      cursorValue.modifiedAt,
      String(cursorValue.internalId),
      input.syncKind,
      runId
    ]
  );
}

/** @param {import("./customer-database.js").CustomerDatabase} database @param {string} runId @param {unknown} error */
async function failSyncRun(database, runId, error) {
  await database.query(
    `UPDATE netsuite_customer_sync_runs
        SET status = 'failed', error_code = $2, error_message = $3,
            completed_at = now()
      WHERE run_id = $1::uuid AND status = 'running'`,
    [runId, errorCode(error) || "MBT_CUSTOMER_SYNC_FAILED", String(/** @type {any} */ (error)?.message || error)]
  );
}

/**
 * @param {unknown} database
 * @param {Record<string, unknown>} rawInput
 */
export async function runCustomerSync(database, rawInput) {
  const db = customerDatabase(database);
  const input = {
    ...rawInput,
    syncKey: requiredText(rawInput.syncKey, "Customer sync key"),
    accountId: requiredText(rawInput.accountId, "Customer sync account ID"),
    subsidiaryId: rawInput.subsidiaryId === null || rawInput.subsidiaryId === undefined
      ? null
      : positiveIdText(rawInput.subsidiaryId, "Customer sync subsidiary ID"),
    syncKind: String(rawInput.syncKind),
    sourceKind: sourceKind(rawInput.sourceKind),
    correlationId: requiredText(rawInput.correlationId, "Customer sync correlation ID"),
    requestedBy: requiredText(rawInput.requestedBy, "Customer sync requester"),
    pageSize: Number(rawInput.pageSize || 500)
  };
  if (input.syncKind !== "incremental" && input.syncKind !== "full_reconciliation") {
    throw new TypeError("Customer sync kind is not supported.");
  }
  const runId = crypto.randomUUID();
  if (!await claimSyncRun(db, input, runId)) {
    return { skipped: true, reason: "customer_sync_already_running" };
  }
  try {
    const initialCursor = input.syncKind === "incremental"
      ? await readSyncCursor(db, input.syncKey)
      : null;
    const snapshot = await fetchSyncSnapshot(input, initialCursor);
    validateCompleteSnapshot(input, snapshot);
    if (!snapshot.cursor) {
      throw customerError("MBT_CUSTOMER_SOURCE_INVALID", "Customer source did not provide a cursor.", 502);
    }
    const snapshotCursor = snapshot.cursor;
    return await withCustomerTransaction(database, async (client) => {
      const lease = await client.query(
        `SELECT status FROM netsuite_customer_sync_runs
          WHERE run_id = $1::uuid FOR UPDATE`,
        [runId]
      );
      if (lease.rows[0]?.status !== "running") {
        throw customerError("MBT_CUSTOMER_SYNC_LEASE_LOST", "Customer sync lease was lost.", 409);
      }
      const applied = snapshot.records.length > 0
        ? await applyCanonicalCustomerAggregatesInTransaction(client, {
          ...input,
          aggregates: snapshot.records
        }, { runId, publishEvents: true })
        : {
          created: 0,
          updated: 0,
          unchanged: 0,
          conflicted: 0,
          ignored: 0,
          outcomes: []
        };
      const inactivated = await inactivateMissingFullCustomers(
        client,
        input,
        runId,
        snapshot.records
      );
      await updateSyncState(client, input, runId, snapshotCursor);
      await client.query(
        `UPDATE netsuite_customer_sync_runs
            SET status = 'completed', pages_expected = $2, pages_applied = $2,
                records_seen = $3, records_applied = $4,
                records_conflicted = $5, source_high_watermark = $6::timestamptz,
                completed_at = now()
          WHERE run_id = $1::uuid`,
        [
          runId,
          snapshot.pagesApplied,
          snapshot.records.length,
          Number(applied.created) + Number(applied.updated) + inactivated,
          applied.conflicted,
          snapshotCursor.modifiedAt
        ]
      );
      return {
        status: "completed",
        pagesApplied: snapshot.pagesApplied,
        recordsSeen: snapshot.records.length,
        ...applied,
        inactivated
      };
    });
  } catch (error) {
    await failSyncRun(db, runId, error).catch(() => undefined);
    throw error;
  }
}
