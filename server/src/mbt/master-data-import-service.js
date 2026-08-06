// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { canonicalSha256 } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { applyCanonicalCustomerAggregates } from "./customer-sync-service.js";
import { MbtError } from "./errors.js";
import { parseBoundedCsv, serializeCsv } from "./bounded-csv.js";
import { normalizeCustomerImportRows } from "./customer-import-normalizer.js";
import { parseCustomerSpreadsheetMl } from "./customer-spreadsheetml.js";
import {
  getLocalMasterImportDefinition,
  parseLocalMasterCsv
} from "./local-master-import-adapter.js";
import { applyLocalMasterDataRows } from "./local-master-data-service.js";

const CUSTOMER_HEADERS = Object.freeze([
  "Internal ID",
  "Name",
  "Primary Contact",
  "Category",
  "Primary Subsidiary",
  "Sales Rep",
  "Partner",
  "Status",
  "Phone",
  "Email"
]);

const CUSTOMER_TEMPLATE_HEADERS = Object.freeze([
  "customer_internal_id",
  "entity_name",
  "legal_name",
  "display_name",
  "active",
  "currency",
  "source_modified_at",
  "source_version",
  "account_id"
]);

const LOCAL_IMPORT_RESOURCES = new Set(["local_items", "materials", "dump_sites"]);

// Canonical apply must participate in the command/import transaction. Passing
// the raw Pool here would acquire an unrelated connection and could commit a
// customer before later import evidence failed.
const transactionDatabase = Object.freeze({ query });

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

/** @param {string} code @param {string} message @param {number} [status] */
function importError(code, message, status = 400) {
  return new MbtError({ status, code, message });
}

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} resource */
function importResource(resource) {
  const normalized = text(resource).toLowerCase().replaceAll("-", "_");
  if (normalized !== "customers" && !LOCAL_IMPORT_RESOURCES.has(normalized)) {
    throw importError("MBT_IMPORT_RESOURCE_INVALID", "This import resource is not supported.");
  }
  return normalized;
}

/** @param {unknown} actor @returns {MbtActor} */
function importActor(actor) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw importError("MBT_IMPORT_ACTOR_REQUIRED", "An authenticated Admin is required.", 403);
  }
  const value = /** @type {{operatorId?: unknown, roles?: unknown}} */ (actor);
  const operatorId = text(value.operatorId);
  const roles = Array.isArray(value.roles)
    ? value.roles.map(text).filter(Boolean)
    : [];
  if (!operatorId || !roles.map((role) => role.toLowerCase()).includes("admin")) {
    throw importError("MBT_IMPORT_ACTOR_REQUIRED", "An authenticated Admin is required.", 403);
  }
  return { operatorId, roles };
}

/** @param {unknown} value @param {string} code @param {string} message */
function requiredText(value, code, message) {
  const normalized = text(value);
  if (!normalized) {
    throw importError(code, message);
  }
  return normalized;
}

/** @param {unknown} value @param {string} code */
function sha256(value, code) {
  const normalized = text(value);
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw importError(code, "A SHA-256 import identity is required.");
  }
  return normalized;
}

/** @param {unknown} content */
function contentBuffer(content) {
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (typeof content === "string") {
    return Buffer.from(content, "utf8");
  }
  throw importError("MBT_IMPORT_CONTENT_REQUIRED", "An import file is required.");
}

/** @param {unknown} defaults */
function defaultsObject(defaults) {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw importError("MBT_IMPORT_DEFAULT_REQUIRED", "Import defaults are required.");
  }
  return /** @type {Record<string, unknown>} */ (defaults);
}

/** @param {Buffer} content */
function fileHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** @param {unknown} sourceKind */
function customerSourceKind(sourceKind) {
  const normalized = text(sourceKind).toLowerCase();
  if (normalized !== "netsuite_spreadsheetml" && normalized !== "customer_csv") {
    throw importError("MBT_IMPORT_SOURCE_INVALID", "The customer import source is not supported.");
  }
  return normalized;
}

/** @param {string} resource @param {unknown} sourceKind */
function normalizedSourceKind(resource, sourceKind) {
  if (resource === "customers") {
    return customerSourceKind(sourceKind);
  }
  if (text(sourceKind).toLowerCase() !== "csv") {
    throw importError("MBT_IMPORT_SOURCE_INVALID", "The local import source is not supported.");
  }
  return "csv";
}

/** @param {Buffer} content @param {Record<string, unknown>} defaults */
async function parseCustomerCsv(content, defaults) {
  const hash = fileHash(content);
  const parsed = await parseBoundedCsv(content, { requiredHeaders: CUSTOMER_HEADERS });
  const normalized = normalizeCustomerImportRows(parsed.rows, {
    ...defaults,
    sourceVersion: hash
  });
  return {
    schemaVersion: "mbt-customer-csv-v1",
    sourceKind: "csv_bootstrap",
    fileHash: hash,
    normalizedHash: normalized.normalizedHash,
    headers: parsed.headers,
    ignoredHeaders: ["Primary Contact", "Category", "Sales Rep", "Partner"],
    rows: normalized.rows,
    summary: { ...normalized.summary, repairedDataNodeAmpersands: 0 },
    warnings: []
  };
}

/** @param {string[]} ids @param {string[]} entityNumbers @param {boolean} [forUpdate] */
async function customerTargetRows(ids, entityNumbers, forUpdate = false) {
  const result = await query(
    `SELECT c.netsuite_id::text AS netsuite_id,
            c.entity_number,
            c.source_modified_at,
            c.source_version,
            c.payload_hash,
            c.active,
            p.source_kind,
            p.source_account_id,
            p.last_live_netsuite_observation_at
       FROM netsuite_customers c
       LEFT JOIN mbt_customer_provenance p
         ON p.customer_netsuite_id = c.netsuite_id
      WHERE c.netsuite_id = ANY($1::bigint[])
         OR c.entity_number = ANY($2::text[])
      ORDER BY c.netsuite_id
      ${forUpdate ? "FOR UPDATE OF c" : ""}`,
    [ids, entityNumbers]
  );
  return /** @type {Record<string, unknown>[]} */ (result.rows);
}

/** @param {readonly Record<string, unknown>[]} normalizedRows @param {boolean} [forUpdate] */
async function targetRevision(normalizedRows, forUpdate = false) {
  const requested = normalizedRows.map((row) => ({
    customerInternalId: String(row.customerInternalId),
    entityNumber: String(row.entityNumber)
  })).sort((left, right) => left.customerInternalId.localeCompare(right.customerInternalId));
  const targets = await customerTargetRows(
    requested.map(({ customerInternalId }) => customerInternalId),
    requested.map(({ entityNumber }) => entityNumber),
    forUpdate
  );
  return {
    token: canonicalSha256({
      resource: "customers",
      requested,
      targets: targets.map((row) => ({
        netsuiteId: String(row.netsuite_id),
        entityNumber: String(row.entity_number),
        sourceModifiedAt: new Date(String(row.source_modified_at)).toISOString(),
        sourceVersion: String(row.source_version),
        payloadHash: String(row.payload_hash),
        active: row.active === true,
        sourceKind: row.source_kind === null ? null : String(row.source_kind)
      }))
    }),
    targets
  };
}

/** @param {string} resource @param {readonly Record<string, unknown>[]} rows */
function localNaturalKeys(resource, rows) {
  return rows.map((row) => String(
    row.naturalKey
      || (resource === "local_items" ? row.itemCode : null)
      || (resource === "materials" ? row.materialCode : null)
      || row.dumpSiteCode
      || ""
  ));
}

/** @param {string} resource @param {readonly string[]} keys @param {boolean} forUpdate */
async function localStoredTargets(resource, keys, forUpdate) {
  if (resource === "local_items") {
    const result = await query(
      `SELECT setting.item_code AS natural_key, setting.revision::int,
              setting.display_name, setting.description, setting.item_type,
              setting.rental_period_days, setting.category,
              setting.pricing_mode, setting.netsuite_mapping_local_key,
              setting.system_owned, setting.applicable_service_types,
              setting.applicable_legacy_source_types, setting.active,
              bin_type.type_code AS bin_type_code,
              bin_type.nominal_yards::int AS bin_capacity_yards
         FROM mbt_local_item_settings setting
         LEFT JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = setting.bin_type_id
        WHERE setting.item_code = ANY($1::text[])
        ORDER BY setting.item_code
        ${forUpdate ? "FOR UPDATE OF setting" : ""}`,
      [keys]
    );
    return /** @type {Record<string, unknown>[]} */ (result.rows);
  }
  if (resource === "materials") {
    const result = await query(
      `SELECT material_code AS natural_key, revision::int, display_name,
              description, active
         FROM mbt_materials
        WHERE material_code = ANY($1::text[])
        ORDER BY material_code
        ${forUpdate ? "FOR UPDATE" : ""}`,
      [keys]
    );
    return /** @type {Record<string, unknown>[]} */ (result.rows);
  }
  if (forUpdate) {
    await query(
      `SELECT dump_site_code
         FROM mbt_dump_sites
        WHERE dump_site_code = ANY($1::text[])
        ORDER BY dump_site_code
        FOR UPDATE`,
      [keys]
    );
  }
  const result = await query(
    `SELECT site.dump_site_code AS natural_key, site.revision::int,
            site.display_name, site.address_line_1, site.address_line_2,
            site.city, site.region, site.postal_code, site.country_code,
            site.phone, site.operational_notes, site.latitude::text,
            site.longitude::text, site.active,
            COALESCE(jsonb_agg(jsonb_build_object(
              'itemCode', item.item_code,
              'accepted', acceptance.accepted,
              'scaleTicketRequired', acceptance.scale_ticket_required,
              'active', acceptance.active,
              'revision', acceptance.revision
            ) ORDER BY item.item_code)
            FILTER (WHERE item.item_code IS NOT NULL), '[]'::jsonb) AS acceptances
       FROM mbt_dump_sites site
       LEFT JOIN mbt_dump_site_items acceptance
         ON acceptance.dump_site_id = site.dump_site_id
       LEFT JOIN mbt_local_item_settings item
         ON item.item_code = acceptance.item_code
      WHERE site.dump_site_code = ANY($1::text[])
      GROUP BY site.dump_site_id
      ORDER BY site.dump_site_code`,
    [keys]
  );
  return /** @type {Record<string, unknown>[]} */ (result.rows);
}

/** @param {string} resource @param {readonly Record<string, unknown>[]} rows */
async function validateLocalReferences(resource, rows) {
  if (resource === "local_items") {
    const requested = [...new Set(rows
      .filter((row) => row.binCapacityYards === undefined)
      .map((row) => row.binTypeCode)
      .filter(Boolean)
      .map(String))];
    if (requested.length === 0) {
      return;
    }
    const found = await query(
      "SELECT type_code FROM mbt_bin_types WHERE active AND type_code = ANY($1::text[])",
      [requested]
    );
    const available = new Set(found.rows.map(
      (/** @type {Record<string, unknown>} */ row) => String(row.type_code)
    ));
    if (requested.some((code) => !available.has(code))) {
      throw importError("MBT_MASTER_REFERENCE_INVALID", "A local item BIN type is unavailable.");
    }
  }
  if (resource === "dump_sites") {
    const requested = [...new Set(rows.map((row) => String(row.itemCode || row.materialCode || "")))];
    const found = await query(
      `SELECT item_code
         FROM mbt_local_item_settings
        WHERE active AND item_type = 'dump' AND item_code = ANY($1::text[])`,
      [requested]
    );
    const available = new Set(found.rows.map(
      (/** @type {Record<string, unknown>} */ row) => String(row.item_code)
    ));
    if (requested.some((code) => !available.has(code))) {
      throw importError("MBT_MASTER_REFERENCE_INVALID", "A dump-site item is unavailable.");
    }
  }
}

/** @param {string} resource @param {readonly Record<string, unknown>[]} rows @param {boolean} [forUpdate] */
async function localTargetRevision(resource, rows, forUpdate = false) {
  const keys = localNaturalKeys(resource, rows);
  await validateLocalReferences(resource, rows);
  const targets = await localStoredTargets(resource, keys, forUpdate);
  const byKey = new Map(targets.map((target) => [String(target.natural_key), target]));
  const preparedRows = rows.map((row, index) => {
    const target = byKey.get(String(keys[index]));
    const supplied = row.expectedRevision;
    if (target) {
      if (supplied !== undefined && Number(supplied) !== Number(target.revision)) {
        throw importError("MBT_IMPORT_STALE_REVISION", "An import target changed before preview.", 409);
      }
      return { ...row, expectedRevision: Number(target.revision) };
    }
    if (supplied !== undefined) {
      throw importError("MBT_IMPORT_STALE_REVISION", "A new import row cannot name an existing revision.", 409);
    }
    const { expectedRevision: _expectedRevision, ...withoutRevision } = row;
    return withoutRevision;
  });
  return {
    token: canonicalSha256({
      resource,
      requested: keys,
      targets: targets.map((target) => ({ ...target }))
    }),
    targets,
    rows: preparedRows
  };
}

/** @param {string} resource @param {readonly Record<string, unknown>[]} rows @param {readonly Record<string, unknown>[]} targets */
function localCandidateCounts(resource, rows, targets) {
  const existing = new Set(targets.map((target) => String(target.natural_key)));
  const keys = localNaturalKeys(resource, rows);
  return {
    createdCandidates: keys.filter((key) => !existing.has(key)).length,
    updatedCandidates: keys.filter((key) => existing.has(key)).length,
    unchangedCandidates: 0,
    conflictedCandidates: 0
  };
}

/** @param {string} resource @param {readonly Record<string, unknown>[]} rows */
function finalizedLocalRows(resource, rows) {
  return rows.map((row) => {
    const { payloadHash: _payloadHash, ...withoutHash } = row;
    return {
      ...withoutHash,
      payloadHash: canonicalSha256({ resource, row: withoutHash })
    };
  });
}

/** @param {readonly Record<string, unknown>[]} rows @param {readonly Record<string, unknown>[]} targets */
function candidateCounts(rows, targets) {
  const byId = new Map(targets.map((row) => [String(row.netsuite_id), row]));
  const byEntity = new Map(targets.map((row) => [String(row.entity_number), row]));
  const counts = { createdCandidates: 0, updatedCandidates: 0, unchangedCandidates: 0, conflictedCandidates: 0 };
  for (const row of rows) {
    const id = String(row.customerInternalId);
    const current = byId.get(id);
    const entityOwner = byEntity.get(String(row.entityNumber));
    if (!current && entityOwner && String(entityOwner.netsuite_id) !== id) {
      counts.conflictedCandidates += 1;
    } else if (!current) {
      counts.createdCandidates += 1;
    } else if (String(current.payload_hash) === String(row.payloadHash)) {
      counts.unchangedCandidates += 1;
    } else if (String(current.source_kind) === "netsuite_read") {
      counts.conflictedCandidates += 1;
    } else {
      counts.updatedCandidates += 1;
    }
  }
  return counts;
}

/** @param {Record<string, unknown>} row */
function publicBatch(row) {
  return {
    schemaVersion: "mbt-import-preview-v1",
    batchId: String(row.batch_id),
    resource: String(row.resource_kind),
    sourceKind: String(row.source_kind),
    status: String(row.status),
    fileHash: String(row.file_hash),
    normalizedHash: String(row.normalized_hash),
    targetRevisionToken: String(row.target_revision_token),
    summary: row.summary,
    warnings: row.warnings,
    errors: row.safe_errors
  };
}

/** @param {string} batchId */
async function selectBatch(batchId) {
  const result = await query(
    `SELECT batch_id, resource_kind, source_kind, source_account_id,
            schema_version, file_hash, normalized_hash, target_revision_token,
            status, actor_operator_id, summary, warnings, safe_errors,
            revision, expires_at
       FROM mbt_import_batches
      WHERE batch_id = $1`,
    [batchId]
  );
  if (!result.rowCount) {
    throw importError("MBT_IMPORT_BATCH_NOT_FOUND", "The import preview was not found.", 404);
  }
  return /** @type {Record<string, unknown>} */ (result.rows[0]);
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.resource
 * @param {string} input.sourceKind
 * @param {string} input.fileName
 * @param {unknown} input.content
 * @param {unknown} input.defaults
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function previewMasterDataImport(input) {
  const actor = importActor(input.actor);
  const resource = importResource(input.resource);
  const sourceKind = normalizedSourceKind(resource, input.sourceKind);
  const content = contentBuffer(input.content);
  const defaults = defaultsObject(input.defaults);
  const customerImport = resource === "customers";
  const parsed = /** @type {{
    schemaVersion: string,
    fileHash: string,
    normalizedHash: string,
    headers: string[],
    ignoredHeaders?: string[],
    rows: Record<string, unknown>[],
    summary: Record<string, unknown>,
    warnings?: unknown[]
  }} */ (customerImport
    ? sourceKind === "netsuite_spreadsheetml"
      ? await parseCustomerSpreadsheetMl(content, defaults)
      : await parseCustomerCsv(content, defaults)
    : await parseLocalMasterCsv({ resource, content }));
  /** @type {Record<string, unknown>[]} */
  let staged;
  /** @type {Record<string, unknown>[]} */
  let targets;
  let targetToken;
  let normalizedHash;
  if (customerImport) {
    const target = await targetRevision(parsed.rows);
    staged = parsed.rows;
    targets = target.targets;
    targetToken = target.token;
    normalizedHash = parsed.normalizedHash;
  } else {
    const target = await localTargetRevision(resource, parsed.rows);
    staged = finalizedLocalRows(resource, target.rows);
    targets = target.targets;
    targetToken = target.token;
    normalizedHash = canonicalSha256({
      resource,
      schemaVersion: parsed.schemaVersion,
      rows: staged.map(({ rowNumber: _rowNumber, ...row }) => row)
    });
  }
  const candidates = customerImport
    ? candidateCounts(staged, targets)
    : localCandidateCounts(resource, staged, targets);
  const summary = {
    totalRows: Number(parsed.summary.totalRows),
    validRows: staged.length,
    invalidRows: 0,
    skippedRows: Number(parsed.summary.skippedRows),
    ...candidates
  };
  const batchId = crypto.randomUUID();
  const safeMetadata = {
    headers: parsed.headers,
    ignoredHeaders: "ignoredHeaders" in parsed ? parsed.ignoredHeaders : [],
    sourceAccountId: customerImport ? text(defaults.sourceAccountId) : "local",
    approvedSubsidiary: customerImport ? text(defaults.approvedSubsidiary) : "",
    defaultCurrency: customerImport ? text(defaults.defaultCurrency) : "",
    exportedAt: customerImport ? text(defaults.exportedAt) : "",
    correlationId: requiredText(input.correlationId, "MBT_CORRELATION_ID_REQUIRED", "A correlation ID is required."),
    requestId: requiredText(input.requestId, "MBT_REQUEST_ID_REQUIRED", "A request ID is required.")
  };
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_import_batches (
         batch_id, resource_kind, source_kind, source_account_id,
         source_filename, schema_version, file_hash, normalized_hash,
         target_revision_token, status, actor_operator_id, summary, warnings,
         safe_errors, safe_metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'previewed', $10, $11::jsonb, $12::jsonb, '[]'::jsonb, $13::jsonb
       )`,
      [
        batchId,
        resource,
        sourceKind,
        customerImport ? text(defaults.sourceAccountId) : "local",
        text(input.fileName).slice(0, 500),
        String(parsed.schemaVersion),
        parsed.fileHash,
        normalizedHash,
        targetToken,
        actor.operatorId,
        JSON.stringify(summary),
        JSON.stringify(parsed.warnings || []),
        JSON.stringify(safeMetadata)
      ]
    );
    for (const row of staged) {
      await query(
        `INSERT INTO mbt_import_staged_rows (
           batch_id, row_number, natural_key, normalized_payload, payload_hash
         ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          batchId,
          Number(row.rowNumber),
          String(row.customerInternalId || row.naturalKey),
          JSON.stringify(row),
          String(row.payloadHash)
        ]
      );
    }
  });
  return publicBatch({
    batch_id: batchId,
    resource_kind: resource,
    source_kind: sourceKind,
    status: "previewed",
    file_hash: parsed.fileHash,
    normalized_hash: normalizedHash,
    target_revision_token: targetToken,
    summary,
    warnings: parsed.warnings || [],
    safe_errors: []
  });
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.resource
 * @param {string} input.batchId
 */
export async function getMasterDataImportBatch(input) {
  importActor(input.actor);
  const resource = importResource(input.resource);
  const batch = await selectBatch(requiredText(
    input.batchId,
    "MBT_IMPORT_BATCH_REQUIRED",
    "An import batch ID is required."
  ));
  if (String(batch.resource_kind) !== resource) {
    throw importError("MBT_IMPORT_BATCH_NOT_FOUND", "The import preview was not found.", 404);
  }
  return publicBatch(batch);
}

/** @param {string} batchId */
async function stagedRows(batchId) {
  const result = await query(
    `SELECT row_number, natural_key, normalized_payload, payload_hash
       FROM mbt_import_staged_rows
      WHERE batch_id = $1
      ORDER BY row_number`,
    [batchId]
  );
  return /** @type {Record<string, unknown>[]} */ (result.rows.map(
    (/** @type {Record<string, unknown>} */ row) => ({
    .../** @type {Record<string, unknown>} */ (row.normalized_payload),
    rowNumber: Number(row.row_number),
    naturalKey: String(row.natural_key),
    payloadHash: String(row.payload_hash)
    })
  ));
}

/** @param {readonly Record<string, unknown>[]} rows */
function customerAggregates(rows) {
  return rows.map((row) => ({
    netsuiteId: String(row.customerInternalId),
    entityNumber: String(row.entityNumber),
    legalName: String(row.legalName),
    displayName: String(row.displayName),
    currency: String(row.currency),
    terms: null,
    taxStatus: null,
    creditStatus: null,
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    active: row.active === true,
    sourceKind: "csv_bootstrap",
    sourceAccountId: String(row.sourceAccountId),
    sourceModifiedAt: String(row.sourceModifiedAt),
    sourceVersion: String(row.sourceVersion),
    payloadHash: String(row.payloadHash),
    subsidiaries: [],
    addresses: [],
    contacts: []
  }));
}

/** @param {unknown} error @returns {never} */
function translateApplyError(error) {
  const code = error && typeof error === "object"
    ? String(/** @type {{code?: unknown}} */ (error).code || "")
    : "";
  if (code === "23505" || code === "23503" || code === "23514") {
    throw importError("MBT_IMPORT_TARGET_CONFLICT", "An import target changed after preview.", 409);
  }
  throw error;
}

/** @param {Record<string, unknown>} row */
function localDomainRow(row) {
  const {
    rowNumber: _rowNumber,
    naturalKey: _naturalKey,
    payloadHash: _payloadHash,
    ...domainRow
  } = row;
  return domainRow;
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {Record<string, unknown>} input.batch
 * @param {readonly Record<string, unknown>[]} input.rows
 * @param {string} input.normalizedHash
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {{afterCanonicalApply?: () => Promise<void> | void}} [input.hooks]
 */
async function applyCustomerImportRows(input) {
  const { actor, batch, rows, normalizedHash } = input;
  let canonical;
  try {
    canonical = /** @type {Record<string, unknown>} */ (await applyCanonicalCustomerAggregates(transactionDatabase, {
      accountId: String(batch.source_account_id),
      subsidiaryId: null,
      sourceKind: "csv_bootstrap",
      sourceAsOf: String(rows[0]?.sourceModifiedAt || batch.previewed_at),
      sourceVersion: normalizedHash,
      aggregates: customerAggregates(rows),
      correlationId: input.correlationId,
      idempotencyKey: `import-batch:${String(batch.batch_id)}`,
      actorId: actor.operatorId,
      ...(input.hooks ? { hooks: input.hooks } : {})
    }));
  } catch (error) {
    translateApplyError(error);
  }
  const outcomes = /** @type {Record<string, unknown>[]} */ (
    Array.isArray(canonical.outcomes) ? canonical.outcomes : []
  );
  const outcomeById = new Map(outcomes
    .map((outcome) => [String(outcome.customerNetSuiteId), String(outcome.action)]));
  return rows.map((row) => {
    const rawAction = outcomeById.get(String(row.customerInternalId)) || "unchanged";
    return {
      row,
      entityId: String(row.customerInternalId),
      action: rawAction === "ignored" ? "unchanged" : rawAction,
      entityType: "customer",
      sourceKind: "csv_bootstrap",
      sourceAccountId: String(row.sourceAccountId),
      sourceVersion: String(row.sourceVersion),
      entityRevision: null
    };
  });
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.resource
 * @param {Record<string, unknown>} input.batch
 * @param {readonly Record<string, unknown>[]} input.rows
 * @param {string} input.normalizedHash
 * @param {string} input.reason
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
async function applyLocalImportRows(input) {
  const before = await localTargetRevision(input.resource, input.rows, true);
  if (before.token !== String(input.batch.target_revision_token)) {
    throw importError("MBT_IMPORT_STALE_REVISION", "The import target changed after preview.", 409);
  }
  const nested = await applyLocalMasterDataRows({
    actor: input.actor,
    resource: input.resource,
    sourceKind: "csv",
    rows: input.rows.map(localDomainRow),
    reason: input.reason,
    idempotencyKey: `import-batch:${String(input.batch.batch_id)}`,
    correlationId: input.correlationId,
    requestId: input.requestId
  });
  const entities = Array.isArray(nested.body.entities)
    ? /** @type {Record<string, unknown>[]} */ (nested.body.entities)
    : [];
  const entityById = new Map(entities.map((entity) => [String(
    entity.itemCode || entity.material_code || entity.materialCode
      || entity.dump_site_code || entity.dumpSiteCode || ""
  ), entity]));
  const existed = new Set(before.targets.map((target) => String(target.natural_key)));
  return input.rows.map((row) => {
    const entityId = String(row.naturalKey);
    const entity = entityById.get(entityId);
    return {
      row,
      entityId,
      action: existed.has(entityId) ? "updated" : "created",
      entityType: input.resource.replace(/s$/u, ""),
      sourceKind: "csv",
      sourceAccountId: "local",
      sourceVersion: input.normalizedHash,
      entityRevision: entity && Number.isSafeInteger(Number(entity.revision))
        ? Number(entity.revision)
        : null
    };
  });
}

/** @param {readonly {action: string}[]} outcomes */
function appliedCounts(outcomes) {
  const counts = { created: 0, updated: 0, unchanged: 0, conflicted: 0 };
  for (const { action } of outcomes) {
    if (!Object.hasOwn(counts, action)) {
      throw new TypeError(`Unsupported canonical import outcome: ${action}.`);
    }
    counts[/** @type {keyof typeof counts} */ (action)] += 1;
  }
  return counts;
}

/** @param {string} batchId @param {readonly Record<string, any>[]} outcomes */
async function insertApplyResults(batchId, outcomes) {
  for (const outcome of outcomes) {
    await query(
      `INSERT INTO mbt_import_apply_results (
         apply_result_id, batch_id, row_number, entity_type, entity_id,
         action, source_kind, source_account_id, source_version,
         entity_revision, payload_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        crypto.randomUUID(),
        batchId,
        Number(outcome.row.rowNumber),
        outcome.entityType,
        outcome.entityId,
        outcome.action,
        outcome.sourceKind,
        outcome.sourceAccountId,
        outcome.sourceVersion,
        outcome.entityRevision,
        String(outcome.row.payloadHash)
      ]
    );
  }
}

/** @param {Record<string, unknown>} batch @param {string} normalizedHash @param {string} targetRevisionToken */
function assertApplicableBatch(batch, normalizedHash, targetRevisionToken) {
  if (String(batch.normalized_hash) !== normalizedHash) {
    throw importError("MBT_IMPORT_HASH_MISMATCH", "The import content does not match its preview.", 409);
  }
  if (String(batch.target_revision_token) !== targetRevisionToken) {
    throw importError("MBT_IMPORT_STALE_REVISION", "The import target changed after preview.", 409);
  }
  if (String(batch.status) !== "previewed") {
    throw importError("MBT_IMPORT_BATCH_NOT_APPLICABLE", "The import preview cannot be applied.", 409);
  }
  if (new Date(String(batch.expires_at)).getTime() <= Date.now()) {
    throw importError("MBT_IMPORT_BATCH_EXPIRED", "The import preview expired.", 409);
  }
}

/** @param {string} resource @param {readonly Record<string, unknown>[]} rows */
async function lockImportRows(resource, rows) {
  const identities = rows.map((row) => String(row.customerInternalId || row.naturalKey)).sort();
  for (const identity of identities) {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `mbt:import:${resource}:${identity}`
    ]);
  }
}

/** @param {readonly Record<string, unknown>[]} rows @param {string} targetRevisionToken */
async function assertCustomerTargetCurrent(rows, targetRevisionToken) {
  const currentTarget = await targetRevision(rows, true);
  if (currentTarget.token !== targetRevisionToken) {
    throw importError("MBT_IMPORT_STALE_REVISION", "The import target changed after preview.", 409);
  }
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.resource
 * @param {string} input.batchId
 * @param {string} input.normalizedHash
 * @param {string} input.targetRevisionToken
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {{afterCanonicalApply?: () => Promise<void> | void}} [input.hooks]
 */
export async function applyMasterDataImport(input) {
  const actor = importActor(input.actor);
  const resource = importResource(input.resource);
  const batchId = requiredText(input.batchId, "MBT_IMPORT_BATCH_REQUIRED", "An import batch ID is required.");
  const normalizedHash = sha256(input.normalizedHash, "MBT_IMPORT_HASH_MISMATCH");
  const targetRevisionToken = sha256(input.targetRevisionToken, "MBT_IMPORT_STALE_REVISION");
  const reason = String(input.reason || "").trim()
    || `Applied approved ${resource.replaceAll("_", " ")} import`;
  const commandPayload = { resource, batchId, normalizedHash, targetRevisionToken, reason };
  return executeMbtCommand({
    actor,
    commandName: `mbt.import.${resource}.apply`,
    idempotencyKey: input.idempotencyKey,
    payload: commandPayload,
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const selected = await query(
        `SELECT * FROM mbt_import_batches WHERE batch_id = $1 FOR UPDATE`,
        [batchId]
      );
      if (!selected.rowCount || String(selected.rows[0].resource_kind) !== resource) {
        throw importError("MBT_IMPORT_BATCH_NOT_FOUND", "The import preview was not found.", 404);
      }
      const batch = /** @type {Record<string, unknown>} */ (selected.rows[0]);
      assertApplicableBatch(batch, normalizedHash, targetRevisionToken);
      const rows = await stagedRows(batchId);
      const customerImport = resource === "customers";
      await lockImportRows(resource, rows);
      if (customerImport) {
        await assertCustomerTargetCurrent(rows, targetRevisionToken);
      }
      const outcomes = customerImport
        ? await applyCustomerImportRows({
            actor,
            batch,
            rows,
            normalizedHash,
            correlationId: input.correlationId,
            requestId: input.requestId,
            ...(input.hooks ? { hooks: input.hooks } : {})
          })
        : await applyLocalImportRows({
            actor,
            resource,
            batch,
            rows,
            normalizedHash,
            reason,
            correlationId: input.correlationId,
            requestId: input.requestId
          });
      const counts = appliedCounts(outcomes);
      await insertApplyResults(batchId, outcomes);
      const body = {
        schemaVersion: "mbt-import-apply-v1",
        batchId,
        resource,
        normalizedHash,
        status: "applied",
        counts,
        entityIds: outcomes.map(({ entityId }) => entityId)
      };
      await query(
        `UPDATE mbt_import_batches
            SET status = 'applied',
                applied_idempotency_key = $2,
                apply_reason = $3,
                applied_at = clock_timestamp(),
                revision = revision + 1,
                updated_at = now()
          WHERE batch_id = $1`,
        [batchId, input.idempotencyKey, reason]
      );
      return {
        status: 201,
        body,
        audit: {
          action: `mbt.import.${resource}.applied`,
          entityType: "mbt_import_batch",
          entityId: batchId,
          beforeState: { status: "previewed", normalizedHash, targetRevisionToken },
          afterState: { status: "applied", normalizedHash, counts },
          reason,
          revisionBefore: Number(batch.revision),
          revisionAfter: Number(batch.revision) + 1
        }
      };
    }
  });
}

/** @param {{resource?: unknown}} input */
export async function getTemplate(input = {}) {
  const resource = importResource(input.resource);
  const definition = resource === "customers"
    ? null
    : getLocalMasterImportDefinition(resource);
  const headers = definition === null
    ? CUSTOMER_TEMPLATE_HEADERS
    : "templateHeaders" in definition
      ? definition.templateHeaders
      : definition.headers;
  return {
    status: 200,
    body: serializeCsv({ headers, rows: [] }),
    contentType: "text/csv; charset=utf-8",
    filename: `${resource}-v1.csv`
  };
}

export const masterDataImportService = Object.freeze({
  getTemplate,
  previewMasterDataImport,
  applyMasterDataImport,
  getMasterDataImportBatch
});
