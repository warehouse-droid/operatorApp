// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { canonicalSha256 } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import { authorizeMbtPhase3Capability } from "./phase3-authorization.js";
import {
  normalizeMbtBinAssetRegistration,
  registerMbtBinAsset
} from "./asset-registry-service.js";
import {
  getMbtBinAssetCsvTemplate,
  parseMbtBinAssetCsv
} from "./asset-csv-import.js";

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

/** @param {string} code @param {string} message @param {number} [status] @param {Record<string, unknown>} [details] @returns {never} */
function importError(code, message, status = 400, details = {}) {
  throw new MbtError({ status, code, message, details });
}

/** @param {unknown} value @param {string} code @param {string} message */
function requiredText(value, code, message) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return importError(code, message);
  }
  return normalized;
}

/** @param {unknown} value @param {string} code */
function sha256(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    return importError(code, "A SHA-256 asset import identity is required.");
  }
  return normalized;
}

/** @param {unknown} value @returns {MbtActor} */
function adminActor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return importError("MBT_ADMIN_REQUIRED", "Admin account required.", 403);
  }
  const actor = /** @type {{operatorId?: unknown, roles?: unknown}} */ (value);
  const operatorId = String(actor.operatorId ?? "").trim();
  const roles = Array.isArray(actor.roles)
    ? actor.roles.map((role) => String(role).trim()).filter(Boolean)
    : [];
  if (!operatorId || !roles.some((role) => role.toLowerCase() === "admin")) {
    return importError("MBT_ADMIN_REQUIRED", "Admin account required.", 403);
  }
  return { operatorId, roles };
}

/** @param {MbtActor} actor */
async function authorizeImport(actor) {
  const authorized = adminActor(actor);
  await authorizeMbtPhase3Capability({ capability: "assetManagement", pilotAuthorized: true });
  return authorized;
}

/** @param {readonly string[]} values */
function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

/** @param {readonly Record<string, any>[]} rows */
async function liveReferences(rows) {
  const itemCodes = unique(rows.map((row) => String(row.itemCode || "")));
  const binTypeCodes = unique(rows.map((row) => String(row.binTypeCode || "")));
  const yardCodes = unique([
    ...rows.map((row) => String(row.homeYardCode || "")),
    ...rows.filter((row) => row.initialState?.locationKind === "yard")
      .map((row) => String(row.initialState.locationIdentity))
  ]);
  const conditionCodes = unique(rows.map((row) => String(row.conditionCode || "")));
  const dumpSiteCodes = unique(rows.filter((row) => row.initialState?.locationKind === "dump_site")
    .map((row) => String(row.initialState.locationIdentity)));
  const customerSiteIds = unique(rows.filter((row) => row.initialState?.locationKind === "customer_site")
    .map((row) => String(row.initialState.locationIdentity)));
  const truckIds = unique(rows.filter((row) => row.initialState?.locationKind === "truck")
    .map((row) => String(row.initialState.locationIdentity)));

  for (const identity of customerSiteIds) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identity)) {
      return importError("MBT_ASSET_REFERENCE_INVALID", "The asset customer site is invalid.");
    }
  }
  for (const identity of truckIds) {
    if (!/^[1-9]\d{0,18}$/u.test(identity)) {
      return importError("MBT_ASSET_REFERENCE_INVALID", "The asset truck is invalid.");
    }
  }

  const binItems = await query(
      `SELECT setting.item_code AS code, setting.item_code AS id,
              setting.bin_type_id::text AS bin_type_id,
              bin_type.type_code AS bin_type_code,
              setting.active AND bin_type.active AS active,
              setting.revision::int
         FROM mbt_local_item_settings setting
         JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = setting.bin_type_id
        WHERE setting.item_code = ANY($1::text[])
          AND setting.item_type = 'bin'
        ORDER BY setting.item_code
        FOR KEY SHARE OF setting, bin_type`,
      [itemCodes]
    );
  const binTypes = await query(
      `SELECT bin_type_id::text AS id, type_code AS code, active, revision::int
         FROM mbt_bin_types WHERE type_code = ANY($1::text[]) ORDER BY type_code FOR KEY SHARE`,
      [binTypeCodes]
    );
  const yards = await query(
      `SELECT yard_id::text AS id, yard_code AS code, display_name,
              address_line_1, address_line_2, city, region, postal_code,
              active, revision::int
         FROM mbt_yards
        WHERE yard_code = ANY($1::text[]) OR $2::boolean
        ORDER BY yard_code FOR KEY SHARE`,
      [yardCodes, rows.some((row) => Boolean(row.currentAddress))]
    );
  const conditions = await query(
      `SELECT condition_code AS id, condition_code AS code, active, revision::int
         FROM mbt_bin_condition_codes WHERE condition_code = ANY($1::text[])
         ORDER BY condition_code FOR KEY SHARE`,
      [conditionCodes]
    );
  const dumpSites = await query(
      `SELECT dump_site_id::text AS id, dump_site_code AS code, active, revision::int
         FROM mbt_dump_sites WHERE dump_site_code = ANY($1::text[])
         ORDER BY dump_site_code FOR KEY SHARE`,
      [dumpSiteCodes]
    );
  const customerSites = await query(
      `SELECT site_profile_id::text AS id, site_profile_id::text AS code, active, revision::int
         FROM mbt_customer_site_profiles WHERE site_profile_id = ANY($1::uuid[])
         ORDER BY site_profile_id FOR KEY SHARE`,
      [customerSiteIds]
    );
  const trucks = await query(
      `SELECT id::text AS id, id::text AS code, active, revision::int
         FROM dispatch_trucks WHERE id::text = ANY($1::text[]) ORDER BY id FOR KEY SHARE`,
      [truckIds]
    );
  /** @param {{rows: Record<string, unknown>[]}} result */
  const toMap = (result) => new Map(result.rows.map((row) => [String(row.code), {
    id: String(row.id),
    code: String(row.code),
    active: row.active === true,
    revision: Number(row.revision)
  }]));
  const itemMap = new Map(binItems.rows.map((/** @type {Record<string, unknown>} */ row) => [String(row.code), {
    id: String(row.id),
    code: String(row.code),
    binTypeId: String(row.bin_type_id),
    binTypeCode: String(row.bin_type_code),
    active: row.active === true,
    revision: Number(row.revision)
  }]));
  /** @param {unknown} value */
  const addressKey = (value) => String(value || "").trim().toLocaleLowerCase("en-CA");
  const yardAddresses = new Map();
  for (const row of yards.rows) {
    const formatted = [
      row.address_line_1, row.address_line_2, row.city, row.region, row.postal_code
    ].map((part) => String(part || "").trim()).filter(Boolean).join(", ");
    const reference = {
      id: String(row.id), code: String(row.code), active: row.active === true,
      revision: Number(row.revision), address: formatted || String(row.code)
    };
    for (const alias of [row.code, row.display_name, formatted]) {
      if (addressKey(alias)) {
        yardAddresses.set(addressKey(alias), reference);
      }
    }
  }
  return {
    binItems: itemMap,
    binTypes: toMap(binTypes),
    yards: toMap(yards),
    yardAddresses,
    conditions: toMap(conditions),
    dumpSites: toMap(dumpSites),
    customerSites: toMap(customerSites),
    trucks: toMap(trucks)
  };
}

/** @param {Map<string, any>} map @param {string} identity @param {string} label */
function activeReference(map, identity, label) {
  const reference = map.get(identity);
  if (!reference?.active) {
    return importError(
      "MBT_ASSET_REFERENCE_INVALID",
      `The asset ${label} is missing or inactive.`,
      400,
      { reference: identity }
    );
  }
  return reference;
}

/** @param {Record<string, any>} row @param {Awaited<ReturnType<typeof liveReferences>>} references */
function resolveRow(row, references) {
  if (row.itemCode) {
    const item = activeReference(references.binItems, row.itemCode, "Bin item");
    const currentLocation = activeReference(
      references.yardAddresses,
      String(row.currentAddress).trim().toLocaleLowerCase("en-CA"),
      "current address"
    );
    const normalized = normalizeMbtBinAssetRegistration({
      asset: {
        assetCode: row.assetCode,
        itemCode: item.code,
        active: row.active,
        underMaintenance: row.underMaintenance
      },
      initialState: {
        lifecycleStatus: row.underMaintenance ? "maintenance" : "available",
        location: {
          kind: "yard",
          reference: currentLocation.code,
          yardId: currentLocation.id
        },
        occurredAt: row.occurredAt
      }
    });
    return {
      source: row,
      asset: normalized.asset,
      initialState: {
        ...normalized.initialState,
        occurredAt: normalized.initialState.occurredAt.toISOString()
      },
      referenceSnapshot: { item, currentLocation }
    };
  }
  const binType = activeReference(references.binTypes, row.binTypeCode, "bin type");
  const homeYard = activeReference(references.yards, row.homeYardCode, "home yard");
  const condition = row.conditionCode
    ? activeReference(references.conditions, row.conditionCode, "condition")
    : null;
  const locationKind = row.initialState.locationKind;
  const locationIdentity = row.initialState.locationIdentity;
  const locationMaps = /** @type {Record<string, Map<string, any>>} */ ({
    yard: references.yards,
    customer_site: references.customerSites,
    dump_site: references.dumpSites,
    truck: references.trucks
  });
  const locationReference = locationKind === "unknown"
    ? null
    : activeReference(
        /** @type {Map<string, any>} */ (locationMaps[locationKind]),
        String(locationIdentity),
        "initial location"
      );
  const location = {
    kind: locationKind,
    reference: row.initialState.locationReference,
    yardId: locationKind === "yard" ? locationReference.id : null,
    customerSiteProfileId: locationKind === "customer_site" ? locationReference.id : null,
    dumpSiteId: locationKind === "dump_site" ? locationReference.id : null,
    truckId: locationKind === "truck" ? locationReference.id : null
  };
  const normalized = normalizeMbtBinAssetRegistration({
    asset: {
      assetCode: row.assetCode,
      qrCode: row.qrCode,
      barcode: row.barcode,
      binTypeId: binType.id,
      homeYardId: homeYard.id,
      tareWeightKg: row.tareWeightKg,
      conditionCode: condition?.code || null,
      operationalNotes: row.operationalNotes,
      active: row.active,
      underMaintenance: row.underMaintenance
    },
    initialState: {
      lifecycleStatus: row.initialState.lifecycleStatus,
      location,
      occurredAt: row.initialState.occurredAt
    }
  });
  return {
    source: row,
    asset: normalized.asset,
    initialState: {
      ...normalized.initialState,
      occurredAt: normalized.initialState.occurredAt.toISOString()
    },
    referenceSnapshot: { binType, homeYard, condition, location: locationReference }
  };
}

/** @param {readonly Record<string, any>[]} rows */
async function existingTargets(rows) {
  const assetCodes = unique(rows.map((row) => String(row.assetCode)));
  const qrCodes = unique(rows.map((row) => String(row.qrCode || "")));
  const barcodes = unique(rows.map((row) => String(row.barcode || "")));
  const result = await query(
    `SELECT asset_id::text, asset_code, qr_code, barcode, revision::int
       FROM mbt_bin_assets
      WHERE asset_code = ANY($1::text[])
         OR qr_code = ANY($2::text[])
         OR barcode = ANY($3::text[])
      ORDER BY asset_code, asset_id
      FOR KEY SHARE`,
    [assetCodes, qrCodes, barcodes]
  );
  return result.rows.map((/** @type {Record<string, unknown>} */ row) => ({
    assetId: String(row.asset_id),
    assetCode: String(row.asset_code),
    qrCode: row.qr_code === null ? null : String(row.qr_code),
    barcode: row.barcode === null ? null : String(row.barcode),
    revision: Number(row.revision)
  }));
}

/** @param {readonly Record<string, any>[]} rows @param {{rejectExisting?: boolean}} [options] */
async function resolveRows(rows, { rejectExisting = true } = {}) {
  const references = await liveReferences(rows);
  const staged = rows.map((row) => resolveRow(row, references));
  const existing = await existingTargets(rows);
  if (rejectExisting && existing.length) {
    return importError(
      "MBT_ASSET_DUPLICATE",
      "An asset identity in this CSV is already registered.",
      409,
      { assetCode: existing[0].assetCode }
    );
  }
  const targetRevisionToken = canonicalSha256({
    rows: staged.map(({ source, referenceSnapshot }) => ({
      assetCode: source.assetCode,
      qrCode: source.qrCode,
      barcode: source.barcode,
      referenceSnapshot
    })),
    existing
  });
  return { staged, existing, targetRevisionToken };
}

/** @param {Record<string, any>} row */
// eslint-disable-next-line complexity
function publicRow(row) {
  return {
    rowNumber: row.rowNumber,
    assetCode: row.assetCode,
    itemCode: row.itemCode || row.binTypeCode,
    currentAddress: row.currentAddress || row.homeYardCode || row.initialState?.locationReference,
    qrCode: row.qrCode,
    barcode: row.barcode,
    binTypeCode: row.binTypeCode,
    homeYardCode: row.homeYardCode,
    tareWeightKg: row.tareWeightKg,
    conditionCode: row.conditionCode,
    operationalNotes: row.operationalNotes,
    active: row.active,
    underMaintenance: row.underMaintenance,
    initialLifecycleStatus: row.initialState?.lifecycleStatus
      || (row.underMaintenance ? "maintenance" : "available"),
    initialLocationKind: row.initialState?.locationKind || "yard",
    initialLocationIdentity: row.initialState?.locationIdentity || null,
    initialLocationReference: row.initialState?.locationReference || row.currentAddress,
    occurredAt: row.initialState?.occurredAt || row.occurredAt
  };
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {unknown} input.content
 * @param {string} input.fileName
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function previewMbtBinAssetCsvImport(input) {
  const actor = await authorizeImport(input.actor);
  const correlationId = requiredText(input.correlationId, "MBT_CORRELATION_ID_REQUIRED", "A correlation ID is required.");
  const requestId = requiredText(input.requestId, "MBT_REQUEST_ID_REQUIRED", "A request ID is required.");
  const parsed = await parseMbtBinAssetCsv(input.content, { fileName: input.fileName });
  if (!parsed.rows.length) {
    return importError("MBT_ASSET_CSV_EMPTY", "The asset CSV must contain at least one row.");
  }
  return withTransaction(async () => {
    const resolved = await resolveRows(parsed.rows);
    const normalizedHash = canonicalSha256(resolved.staged);
    const batchId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_import_batches (
         batch_id, resource_kind, source_kind, source_account_id,
         source_filename, schema_version, file_hash, normalized_hash,
         target_revision_token, status, actor_operator_id, summary,
         warnings, safe_errors, safe_metadata
       ) VALUES (
         $1, 'bin_assets', 'csv', 'local', $2, $3, $4, $5,
         $6, 'previewed', $7, $8::jsonb, '[]'::jsonb, '[]'::jsonb, $9::jsonb
       )`,
      [
        batchId,
        parsed.fileName,
        parsed.schemaVersion,
        parsed.fileHash,
        normalizedHash,
        resolved.targetRevisionToken,
        actor.operatorId,
        JSON.stringify(parsed.summary),
        JSON.stringify({ correlationId, requestId, parserNormalizedHash: parsed.normalizedHash })
      ]
    );
    for (const payload of resolved.staged) {
      await query(
        `INSERT INTO mbt_import_staged_rows (
           batch_id, row_number, natural_key, normalized_payload, payload_hash
         ) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          batchId,
          payload.source.rowNumber,
          payload.asset.assetCode,
          JSON.stringify(payload),
          canonicalSha256(payload)
        ]
      );
    }
    return {
      schemaVersion: "mbt-bin-assets-import-preview-v1",
      batchId,
      status: "previewed",
      fileHash: parsed.fileHash,
      normalizedHash,
      targetRevisionToken: resolved.targetRevisionToken,
      summary: parsed.summary,
      rows: parsed.rows.map(publicRow)
    };
  });
}

/** @param {string} batchId @param {string} actorOperatorId */
async function lockedBatch(batchId, actorOperatorId) {
  const selected = await query(
    `SELECT * FROM mbt_import_batches
      WHERE batch_id = $1 AND resource_kind = 'bin_assets'
        AND actor_operator_id = $2
      FOR UPDATE`,
    [batchId, actorOperatorId]
  );
  if (!selected.rowCount) {
    return importError("MBT_IMPORT_BATCH_NOT_FOUND", "The asset import preview was not found.", 404);
  }
  return selected.rows[0];
}

/** @param {string} batchId @returns {Promise<Record<string, any>[]>} */
async function stagedRows(batchId) {
  const selected = await query(
    `SELECT row_number, normalized_payload, payload_hash
       FROM mbt_import_staged_rows WHERE batch_id = $1 ORDER BY row_number`,
    [batchId]
  );
  if (!selected.rowCount) {
    return importError("MBT_IMPORT_BATCH_NOT_APPLICABLE", "The asset preview evidence is incomplete.", 409);
  }
  const rows = selected.rows.map((/** @type {Record<string, unknown>} */ row) => {
    const payload = /** @type {Record<string, any>} */ (row.normalized_payload);
    if (canonicalSha256(payload) !== String(row.payload_hash)) {
      return importError("MBT_IMPORT_HASH_MISMATCH", "The staged asset evidence changed after preview.", 409);
    }
    return payload;
  });
  return rows;
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.batchId
 * @param {string} input.normalizedHash
 * @param {string} input.targetRevisionToken
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {{afterAssetRegistration?: (input: {rowNumber: number, assetId: string}) => void | Promise<void>}} [input.hooks]
 */
export async function applyMbtBinAssetCsvImport(input) {
  const actor = await authorizeImport(input.actor);
  const batchId = requiredText(input.batchId, "MBT_IMPORT_BATCH_REQUIRED", "A preview batch ID is required.");
  const normalizedHash = sha256(input.normalizedHash, "MBT_IMPORT_HASH_MISMATCH");
  const targetRevisionToken = sha256(input.targetRevisionToken, "MBT_ASSET_IMPORT_STALE_REVISION");
  const reason = String(input.reason || "").trim()
    || "Created assets from approved opening-inventory import";
  const result = await executeMbtCommand({
    actor,
    commandName: "mbt.import.bin_assets.apply",
    idempotencyKey: input.idempotencyKey,
    payload: { batchId, normalizedHash, targetRevisionToken, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const batch = await lockedBatch(batchId, actor.operatorId);
      if (String(batch.normalized_hash) !== normalizedHash) {
        return importError("MBT_IMPORT_HASH_MISMATCH", "The import content does not match its preview.", 409);
      }
      if (String(batch.target_revision_token) !== targetRevisionToken) {
        return importError("MBT_ASSET_IMPORT_STALE_REVISION", "The import target does not match its preview.", 409);
      }
      if (String(batch.status) !== "previewed") {
        return importError("MBT_IMPORT_BATCH_NOT_APPLICABLE", "The asset preview cannot be applied.", 409);
      }
      if (new Date(String(batch.expires_at)).getTime() <= Date.now()) {
        return importError("MBT_IMPORT_BATCH_EXPIRED", "The asset preview expired.", 409);
      }
      const staged = await stagedRows(batchId);
      if (canonicalSha256(staged) !== normalizedHash) {
        return importError("MBT_IMPORT_HASH_MISMATCH", "The staged asset rows no longer match their preview.", 409);
      }
      const lockIdentities = unique(staged.flatMap((payload) => [
        `asset:${payload.asset.assetCode}`,
        payload.asset.qrCode ? `qr:${payload.asset.qrCode}` : "",
        payload.asset.barcode ? `barcode:${payload.asset.barcode}` : ""
      ]));
      for (const identity of lockIdentities) {
        await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mbt:asset-import:${identity}`]);
      }
      const fresh = await resolveRows(staged.map((payload) => payload.source), { rejectExisting: false });
      if (fresh.targetRevisionToken !== targetRevisionToken
          || canonicalSha256(fresh.staged) !== normalizedHash) {
        return importError(
          "MBT_ASSET_IMPORT_STALE_REVISION",
          "An asset identity or reference changed after preview.",
          409
        );
      }
      const items = [];
      for (const payload of fresh.staged) {
        const registrationResult = await registerMbtBinAsset({
          actor,
          asset: payload.asset,
          initialState: payload.initialState,
          reason,
          idempotencyKey: `asset-csv:${batchId}:${payload.source.rowNumber}`,
          correlationId: input.correlationId,
          requestId: input.requestId
        }, { registrationSource: "asset_csv_import" });
        const asset = /** @type {Record<string, any>} */ (registrationResult.body.asset);
        await input.hooks?.afterAssetRegistration?.({
          rowNumber: payload.source.rowNumber,
          assetId: String(asset.assetId)
        });
        await query(
          `INSERT INTO mbt_import_apply_results (
             apply_result_id, batch_id, row_number, entity_type, entity_id,
             action, source_kind, source_account_id, source_version,
             entity_revision, payload_hash
           ) VALUES ($1, $2, $3, 'mbt_bin_asset', $4, 'created', 'csv',
                     'local', $5, $6, $7)`,
          [
            crypto.randomUUID(),
            batchId,
            payload.source.rowNumber,
            asset.assetId,
            String(batch.schema_version),
            asset.revision,
            canonicalSha256(payload)
          ]
        );
        items.push({
          rowNumber: payload.source.rowNumber,
          assetId: asset.assetId,
          assetCode: asset.assetCode,
          revision: asset.revision
        });
      }
      const body = {
        schemaVersion: "mbt-bin-assets-import-apply-v1",
        batchId,
        status: "applied",
        normalizedHash,
        summary: { created: items.length },
        items
      };
      await query(
        `UPDATE mbt_import_batches
            SET status = 'applied', applied_idempotency_key = $2,
                apply_reason = $3, applied_at = clock_timestamp(),
                revision = revision + 1, updated_at = now()
          WHERE batch_id = $1`,
        [batchId, input.idempotencyKey, reason]
      );
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.import.bin_assets.applied",
          entityType: "mbt_import_batch",
          entityId: batchId,
          beforeState: { status: "previewed", normalizedHash, targetRevisionToken },
          afterState: { status: "applied", normalizedHash, created: items.length },
          reason,
          revisionBefore: Number(batch.revision),
          revisionAfter: Number(batch.revision) + 1,
          source: "csv"
        }
      };
    }
  });
  if (result.replayed) {
    return result;
  }
  const durable = await query(
    `SELECT response_body
       FROM mbt_command_receipts
      WHERE actor_operator_id = $1
        AND command_name = 'mbt.import.bin_assets.apply'
        AND idempotency_key = $2`,
    [actor.operatorId, input.idempotencyKey]
  );
  if (durable.rowCount !== 1) {
    return importError(
      "MBT_IMPORT_RECEIPT_MISSING",
      "The durable asset import receipt is missing.",
      500
    );
  }
  return { ...result, body: durable.rows[0].response_body };
}

export const assetCsvImportService = Object.freeze({
  getMbtBinAssetCsvTemplate,
  previewMbtBinAssetCsvImport,
  applyMbtBinAssetCsvImport
});
