// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import { assertExpectedRevision, nextRevision } from "./revisions.js";
import { resolveMbtAssetLocationAddress } from "./asset-location-address.js";

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

const ASSET_STATUSES = new Set([
  "available",
  "reserved",
  "on_truck",
  "at_customer",
  "at_dump",
  "maintenance",
  "lost",
  "retired"
]);
const LOCATION_KINDS = new Set([
  "yard",
  "customer_site",
  "dump_site",
  "truck",
  "unknown"
]);
const STATUS_LOCATION_KINDS = new Map([
  ["available", new Set(["yard"])],
  ["reserved", new Set(["yard", "truck"])],
  ["on_truck", new Set(["truck"])],
  ["at_customer", new Set(["customer_site"])],
  ["at_dump", new Set(["dump_site"])],
  ["maintenance", new Set(["yard", "unknown"])],
  ["lost", new Set(["unknown"])],
  ["retired", new Set(["yard", "unknown"])]
]);
const RESOLUTION_DECISIONS = new Set([
  "accepted_application",
  "accepted_manual",
  "corrected_application",
  "corrected_manual",
  "evidence_only"
]);
const ASSET_SELECT_FIELDS = `
  a.asset_id::text AS asset_id,
  a.asset_code,
  a.qr_code,
  a.barcode,
  a.item_code,
  item.display_name AS item_display_name,
  item.item_type,
  a.bin_type_id::text AS bin_type_id,
  bt.type_code AS bin_type_code,
  bt.display_name AS bin_type_name,
  a.home_yard_id::text AS home_yard_id,
  hy.yard_code AS home_yard_code,
  hy.display_name AS home_yard_name,
  a.tare_weight_kg::text AS tare_weight_kg,
  a.condition_code,
  a.operational_notes,
  a.active,
  a.under_maintenance,
  a.revision::int AS asset_revision,
  a.created_by,
  a.updated_by,
  a.created_at,
  a.updated_at,
  s.lifecycle_status,
  s.location_kind,
  s.location_reference,
  s.current_address,
  s.yard_id::text AS state_yard_id,
  s.customer_site_profile_id::text AS state_customer_site_profile_id,
  s.dump_site_id::text AS state_dump_site_id,
  s.truck_id::text AS state_truck_id,
  s.last_movement_id::text AS last_movement_id,
  s.revision::int AS state_revision,
  s.changed_at AS state_changed_at`;

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function failure(status, code, message, details = {}) {
  return new MbtError({ status, code, message, details });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", `An asset ${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value */
function optionalText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

/** @param {unknown} value @param {string} label */
function strictBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", `Asset ${label} must be true or false.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  const parsed = value instanceof Date ? new Date(value) : new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", `Asset ${label} must be a valid timestamp.`);
  }
  return parsed;
}

/** @param {unknown} value */
function tareWeight(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/u.test(normalized)) {
    throw failure(
      400,
      "MBT_ASSET_INPUT_INVALID",
      "Asset tare weight must be a non-negative decimal with at most three decimal places."
    );
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", `Asset ${label} must be a positive integer.`);
  }
  return numeric;
}

/** @param {unknown} value @param {string} label */
function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", `An asset ${label} object is required.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {{kind: string, reference: string | null, yardId: string | null, customerSiteProfileId: string | null, dumpSiteId: string | null, truckId: string | null}} location */
function assertLocationIdentity(location) {
  if (location.kind === "customer_site") {
    const conflicting = [location.yardId, location.dumpSiteId, location.truckId].some(Boolean);
    if (conflicting || (!location.customerSiteProfileId && !location.reference)) {
      throw failure(
        400,
        "MBT_ASSET_STATE_INVALID",
        "A customer location requires a site profile or a typed customer-site address."
      );
    }
    return;
  }
  const identities = [
    location.yardId,
    location.customerSiteProfileId,
    location.dumpSiteId,
    location.truckId
  ].filter(Boolean);
  const expectedIdentity = {
    yard: location.yardId,
    customer_site: location.customerSiteProfileId,
    dump_site: location.dumpSiteId,
    truck: location.truckId,
    unknown: null
  }[location.kind];
  if (location.kind === "unknown" && identities.length !== 0) {
    throw failure(400, "MBT_ASSET_STATE_INVALID", "An unknown location cannot own a location ID.");
  }
  if (location.kind !== "unknown" && (!expectedIdentity || identities.length !== 1)) {
    throw failure(
      400,
      "MBT_ASSET_STATE_INVALID",
      "A physical asset location requires exactly its matching location ID."
    );
  }
}

/** @param {unknown} value */
function normalizeLocation(value) {
  const location = objectValue(value, "initial location");
  const kind = requiredText(location.kind, "initial location kind");
  if (!LOCATION_KINDS.has(kind)) {
    throw failure(400, "MBT_ASSET_STATE_INVALID", "The initial asset location is not supported.");
  }
  const normalized = {
    kind,
    reference: optionalText(location.reference),
    yardId: optionalText(location.yardId),
    customerSiteProfileId: optionalText(location.customerSiteProfileId),
    dumpSiteId: optionalText(location.dumpSiteId),
    truckId: optionalText(location.truckId)
  };
  assertLocationIdentity(normalized);
  return normalized;
}

/** @param {string} status @param {string} kind */
function assertStatusLocation(status, kind) {
  if (!STATUS_LOCATION_KINDS.get(status)?.has(kind)) {
    throw failure(
      400,
      "MBT_ASSET_STATE_INVALID",
      "The initial asset status and location are incompatible."
    );
  }
}

/**
 * @param {unknown} value
 * @returns {{assetCode: string, itemCode: string | null, legacyBinTypeId: string | null, qrCode: string | null, barcode: string | null, homeYardId: string | null, tareWeightKg: string | null, conditionCode: string | null, operationalNotes: string, active: boolean, underMaintenance: boolean}}
 */
function normalizeAsset(value) {
  const asset = objectValue(value, "registration");
  const itemCode = optionalText(asset.itemCode);
  const legacyBinTypeId = optionalText(asset.binTypeId ?? asset.legacyBinTypeId);
  const homeYardId = optionalText(asset.homeYardId);
  if (!itemCode && (!legacyBinTypeId || !homeYardId)) {
    throw failure(
      400,
      "MBT_ASSET_INPUT_INVALID",
      "A legacy asset registration requires its bin type and opening yard."
    );
  }
  return {
    assetCode: requiredText(asset.assetCode, "code"),
    itemCode,
    legacyBinTypeId,
    qrCode: optionalText(asset.qrCode),
    barcode: optionalText(asset.barcode),
    homeYardId,
    tareWeightKg: tareWeight(asset.tareWeightKg),
    conditionCode: optionalText(asset.conditionCode),
    operationalNotes: String(asset.operationalNotes ?? "").trim(),
    active: asset.active === undefined ? true : strictBoolean(asset.active, "active state"),
    underMaintenance: asset.underMaintenance === undefined
      ? false
      : strictBoolean(asset.underMaintenance, "maintenance state")
  };
}

/** @param {unknown} value */
function normalizeInitialState(value) {
  const state = objectValue(value, "initial state");
  const lifecycleStatus = requiredText(state.lifecycleStatus, "initial status");
  if (!ASSET_STATUSES.has(lifecycleStatus)) {
    throw failure(400, "MBT_ASSET_STATE_INVALID", "The initial asset status is not supported.");
  }
  const location = normalizeLocation(state.location);
  assertStatusLocation(lifecycleStatus, location.kind);
  return {
    lifecycleStatus,
    location,
    occurredAt: timestamp(state.occurredAt, "registration occurrence time")
  };
}

/**
 * The single registration validator used by manual and CSV registration.
 * Database reference existence is deliberately checked inside the mutation.
 *
 * @param {{asset: unknown, initialState: unknown}} input
 */
export function normalizeMbtBinAssetRegistration(input) {
  return {
    asset: normalizeAsset(input?.asset),
    initialState: normalizeInitialState(input?.initialState)
  };
}

/** @param {Record<string, unknown>} row */
function publicAsset(row) {
  return {
    assetId: String(row.asset_id),
    assetCode: String(row.asset_code),
    itemCode: optionalText(row.item_code),
    itemDisplayName: optionalText(row.item_display_name),
    itemType: optionalText(row.item_type),
    qrCode: optionalText(row.qr_code),
    barcode: optionalText(row.barcode),
    binTypeId: String(row.bin_type_id),
    binTypeCode: String(row.bin_type_code),
    binTypeName: String(row.bin_type_name),
    homeYardId: optionalText(row.home_yard_id),
    homeYardCode: optionalText(row.home_yard_code),
    homeYardName: optionalText(row.home_yard_name),
    tareWeightKg: optionalText(row.tare_weight_kg),
    conditionCode: optionalText(row.condition_code),
    operationalNotes: String(row.operational_notes || ""),
    active: row.active === true,
    underMaintenance: row.under_maintenance === true,
    revision: Number(row.asset_revision),
    createdBy: optionalText(row.created_by),
    updatedBy: optionalText(row.updated_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    currentState: {
      lifecycleStatus: String(row.lifecycle_status),
      locationKind: String(row.location_kind),
      locationReference: optionalText(row.location_reference),
      currentAddress: String(row.current_address || row.location_reference || "Unknown"),
      yardId: optionalText(row.state_yard_id),
      customerSiteProfileId: optionalText(row.state_customer_site_profile_id),
      dumpSiteId: optionalText(row.state_dump_site_id),
      truckId: optionalText(row.state_truck_id),
      lastMovementId: String(row.last_movement_id),
      revision: Number(row.state_revision),
      changedAt: new Date(String(row.state_changed_at)).toISOString()
    }
  };
}

/** @param {{assetId?: string, assetCode?: string, forUpdate?: boolean}} input */
async function selectAssets({ assetId, assetCode, forUpdate = false } = {}) {
  const clauses = [];
  const params = [];
  if (assetId) {
    params.push(assetId);
    clauses.push(`a.asset_id = $${params.length}`);
  }
  if (assetCode) {
    params.push(assetCode);
    clauses.push(`a.asset_code = $${params.length}`);
  }
  const result = await query(
    `SELECT ${ASSET_SELECT_FIELDS}
       FROM mbt_bin_assets a
       JOIN mbt_bin_types bt ON bt.bin_type_id = a.bin_type_id
       LEFT JOIN mbt_local_item_settings item ON item.item_code = a.item_code
       LEFT JOIN mbt_yards hy ON hy.yard_id = a.home_yard_id
       JOIN mbt_bin_asset_state s ON s.asset_id = a.asset_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY a.asset_code, a.asset_id
      ${forUpdate ? "FOR UPDATE OF a, s" : ""}`,
    params
  );
  return result.rows.map(publicAsset);
}

/** @param {string} table @param {string} idColumn @param {string} id @param {string} label */
async function requireActiveReference(table, idColumn, id, label) {
  const result = await query(
    `SELECT 1 FROM ${table} WHERE ${idColumn} = $1 AND active FOR KEY SHARE`,
    [id]
  );
  if (!result.rowCount) {
    throw failure(
      400,
      "MBT_ASSET_REFERENCE_INVALID",
      `The asset ${label} is missing or inactive.`,
      { reference: id }
    );
  }
}

/**
 * New clients bind assets to a Bin item. Cached clients may still submit the
 * old binTypeId, which is mapped to the single preferred active Bin item.
 * @param {{itemCode: string | null, legacyBinTypeId: string | null}} asset
 */
async function requireActiveBinItem(asset) {
  if (!asset.itemCode && !asset.legacyBinTypeId) {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", "An asset Bin item is required.");
  }
  const selected = await query(
    `SELECT setting.item_code, setting.display_name,
            setting.bin_type_id::text AS bin_type_id,
            bin_type.type_code AS bin_type_code
       FROM mbt_local_item_settings setting
       JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = setting.bin_type_id
      WHERE setting.item_type = 'bin'
        AND setting.active
        AND bin_type.active
        AND (
          ($1::text IS NOT NULL AND setting.item_code = $1)
          OR ($1::text IS NULL AND setting.bin_type_id = $2::uuid)
        )
      ORDER BY setting.system_owned DESC, setting.item_code
      LIMIT 1
      FOR KEY SHARE OF setting, bin_type`,
    [asset.itemCode, asset.legacyBinTypeId]
  );
  if (!selected.rowCount) {
    throw failure(
      400,
      "MBT_ASSET_REFERENCE_INVALID",
      "The asset Bin item is missing, inactive, or is not a Bin item.",
      { reference: asset.itemCode || asset.legacyBinTypeId }
    );
  }
  return {
    itemCode: String(selected.rows[0].item_code),
    displayName: String(selected.rows[0].display_name),
    binTypeId: String(selected.rows[0].bin_type_id),
    binTypeCode: String(selected.rows[0].bin_type_code)
  };
}

/** @param {string | null} conditionCode */
async function requireCondition(conditionCode) {
  if (!conditionCode) {
    return;
  }
  const result = await query(
    `SELECT 1 FROM mbt_bin_condition_codes
      WHERE condition_code = $1 AND active
      FOR KEY SHARE`,
    [conditionCode]
  );
  if (!result.rowCount) {
    throw failure(
      400,
      "MBT_ASSET_REFERENCE_INVALID",
      "The asset condition is missing or inactive.",
      { conditionCode }
    );
  }
}

/** @param {ReturnType<typeof normalizeLocation>} location */
async function requireLocationReference(location) {
  if (location.kind === "yard") {
    return requireActiveReference("mbt_yards", "yard_id", String(location.yardId), "yard");
  }
  if (location.kind === "customer_site") {
    if (!location.customerSiteProfileId) {
      return;
    }
    const result = await query(
      "SELECT 1 FROM mbt_customer_site_profiles WHERE site_profile_id = $1 FOR KEY SHARE",
      [location.customerSiteProfileId]
    );
    if (!result.rowCount) {
      throw failure(400, "MBT_ASSET_REFERENCE_INVALID", "The asset customer site is missing.");
    }
  }
  if (location.kind === "dump_site") {
    return requireActiveReference("mbt_dump_sites", "dump_site_id", String(location.dumpSiteId), "dump site");
  }
  if (location.kind === "truck") {
    const result = await query(
      "SELECT 1 FROM dispatch_trucks WHERE id = $1 AND active FOR KEY SHARE",
      [location.truckId]
    );
    if (!result.rowCount) {
      throw failure(400, "MBT_ASSET_REFERENCE_INVALID", "The asset truck is missing or inactive.");
    }
  }
}

/** @param {unknown} error */
function duplicateAssetFailure(error) {
  if (!error || typeof error !== "object" || !("code" in error)
      || /** @type {{code?: unknown}} */ (error).code !== "23505") {
    return null;
  }
  const constraint = String(/** @type {{constraint?: unknown}} */ (error).constraint || "");
  const field = constraint.includes("qr")
    ? "qrCode"
    : constraint.includes("barcode")
      ? "barcode"
      : "assetCode";
  return failure(409, "MBT_ASSET_DUPLICATE", "This asset identity is already registered.", {
    field
  });
}

/**
 * Atomically register an asset with its mandatory sequence-1 ledger and state.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {unknown} input.asset
 * @param {unknown} input.initialState
 * @param {string} [input.reason]
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {{afterAssetInsert?: () => void | Promise<void>, registrationSource?: "asset_registry" | "asset_csv_import"}} [options]
 */
export async function registerMbtBinAsset(input, options = {}) {
  const normalized = normalizeMbtBinAssetRegistration(input);
  const { asset, initialState } = normalized;
  const registrationSource = options.registrationSource || "asset_registry";
  if (registrationSource !== "asset_registry" && registrationSource !== "asset_csv_import") {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", "The asset registration source is not supported.");
  }
  const reason = String(input?.reason || "").trim()
    || `Created asset ${asset.assetCode} from the MBT Asset Registry`;
  const payload = {
    asset,
    initialState: {
      ...initialState,
      occurredAt: initialState.occurredAt.toISOString()
    },
    reason
  };
  try {
    return await executeMbtCommand({
      actor: input.actor,
      commandName: "mbt.asset.register",
      idempotencyKey: input.idempotencyKey,
      payload,
      correlationId: input.correlationId,
      requestId: input.requestId,
      mutation: async () => {
        const item = await requireActiveBinItem(asset);
        if (asset.homeYardId) {
          await requireActiveReference("mbt_yards", "yard_id", asset.homeYardId, "home yard");
        }
        await requireCondition(asset.conditionCode);
        await requireLocationReference(initialState.location);
        const currentAddress = await resolveMbtAssetLocationAddress(
          { query },
          initialState.location
        );

        const assetId = crypto.randomUUID();
        const movementId = crypto.randomUUID();
        await query(
          `INSERT INTO mbt_bin_assets (
             asset_id, asset_code, qr_code, barcode, item_code, bin_type_id,
             home_yard_id, tare_weight_kg, condition_code, operational_notes,
             active, under_maintenance, revision, created_by, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, 1, $13, $13
           )`,
          [
            assetId,
            asset.assetCode,
            asset.qrCode,
            asset.barcode,
            item.itemCode,
            item.binTypeId,
            asset.homeYardId,
            asset.tareWeightKg,
            asset.conditionCode,
            asset.operationalNotes,
            asset.active,
            asset.underMaintenance,
            input.actor.operatorId
          ]
        );
        if (options.afterAssetInsert) {
          await options.afterAssetInsert();
        }
        const location = initialState.location;
        await query(
          `INSERT INTO mbt_bin_movements (
             movement_id, asset_id, asset_sequence, movement_type,
             before_status, after_status, before_location_kind,
             after_location_kind, after_location_reference, after_address, to_yard_id,
             to_customer_site_profile_id, to_dump_site_id, truck_id,
             source, actor_type, actor_id, occurred_at
           ) VALUES (
             $1, $2, 1, 'asset_registered', NULL, $3, NULL,
             $4, $5, $6, $7, $8, $9, $10,
             $11, 'operator', $12, $13
           )`,
          [
            movementId,
            assetId,
            initialState.lifecycleStatus,
            location.kind,
            location.reference,
            currentAddress,
            location.yardId,
            location.customerSiteProfileId,
            location.dumpSiteId,
            location.truckId,
            registrationSource,
            input.actor.operatorId,
            initialState.occurredAt
          ]
        );
        await query(
          `INSERT INTO mbt_bin_asset_state (
             asset_id, lifecycle_status, location_kind, location_reference,
             current_address,
             yard_id, customer_site_profile_id, dump_site_id, truck_id,
             last_movement_id, revision, changed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11)`,
          [
            assetId,
            initialState.lifecycleStatus,
            location.kind,
            location.reference,
            currentAddress,
            location.yardId,
            location.customerSiteProfileId,
            location.dumpSiteId,
            location.truckId,
            movementId,
            initialState.occurredAt
          ]
        );
        const selected = await selectAssets({ assetId });
        const created = selected[0];
        return {
          status: 201,
          body: { schemaVersion: "mbt-asset-v1", asset: created },
          audit: {
            action: "mbt.asset.registered",
            entityType: "mbt_bin_asset",
            entityId: assetId,
            beforeState: { exists: false },
            afterState: created,
            reason,
            revisionBefore: 1,
            revisionAfter: 1,
            source: registrationSource
          }
        };
      }
    });
  } catch (error) {
    throw duplicateAssetFailure(error) || error;
  }
}

/** @param {unknown} value */
function boundedListLimit(value) {
  if (value === undefined || value === null || value === "") {
    return 50;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", "Asset list limit must be from 1 to 100.");
  }
  return limit;
}

/** @param {unknown} value */
function decodeCursor(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => !String(part))) {
      throw new Error("invalid cursor");
    }
    return parsed.map(String);
  } catch {
    throw failure(400, "MBT_ASSET_CURSOR_INVALID", "The asset list cursor is invalid.");
  }
}

/** @param {string} code @param {string} id */
function encodeCursor(code, id) {
  return Buffer.from(JSON.stringify([code, id]), "utf8").toString("base64url");
}

/** @param {{query?: unknown, limit?: unknown, cursor?: unknown}} [input] */
export async function listMbtBinAssets(input = {}) {
  const search = String(input.query ?? "").trim();
  const limit = boundedListLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const result = await query(
    `SELECT ${ASSET_SELECT_FIELDS}
       FROM mbt_bin_assets a
       JOIN mbt_bin_types bt ON bt.bin_type_id = a.bin_type_id
       LEFT JOIN mbt_local_item_settings item ON item.item_code = a.item_code
       LEFT JOIN mbt_yards hy ON hy.yard_id = a.home_yard_id
       JOIN mbt_bin_asset_state s ON s.asset_id = a.asset_id
      WHERE (
        $1 = ''
        OR a.asset_code ILIKE $1 || '%'
        OR COALESCE(item.item_code, '') ILIKE $1 || '%'
        OR COALESCE(item.display_name, '') ILIKE '%' || $1 || '%'
        OR bt.type_code ILIKE $1 || '%'
        OR s.current_address ILIKE '%' || $1 || '%'
        OR s.lifecycle_status ILIKE $1 || '%'
      )
        AND (
          $2::text IS NULL
          OR (a.asset_code, a.asset_id) > ($2::text, $3::uuid)
        )
      ORDER BY a.asset_code, a.asset_id
      LIMIT $4`,
    [search, cursor?.[0] || null, cursor?.[1] || null, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items = rows.map(publicAsset);
  const last = rows.at(-1);
  return {
    schemaVersion: "mbt-assets-v1",
    items,
    nextCursor: hasMore && last
      ? encodeCursor(String(last.asset_code), String(last.asset_id))
      : null
  };
}

/**
 * Return the small, local-only reference set required to register an asset.
 * IDs remain server-owned while the UI can present stable names instead of
 * asking an operator to copy UUID values.
 */
export async function getMbtAssetOpeningOptions() {
  const [binItems, locations] = await Promise.all([
    query(
      `SELECT item.item_code, item.display_name,
              item.bin_type_id::text, bin_type.type_code AS bin_type_code,
              bin_type.nominal_yards::int AS bin_capacity_yards
         FROM mbt_local_item_settings item
         JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = item.bin_type_id
        WHERE item.item_type = 'bin'
          AND item.active
          AND bin_type.active
        ORDER BY lower(item.display_name), item.display_name, item.item_code`
    ),
    query(
      `SELECT yard_id::text, yard_code, display_name,
              address_line_1, address_line_2, city, region, postal_code
         FROM mbt_yards
        WHERE active
        ORDER BY lower(display_name), display_name, yard_code, yard_id`
    )
  ]);
  return {
    schemaVersion: "mbt-asset-opening-options-v2",
    binItems: (/** @type {Array<Record<string, unknown>>} */ (binItems.rows)).map((row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      binTypeId: String(row.bin_type_id),
      binTypeCode: String(row.bin_type_code),
      binCapacityYards: Number(row.bin_capacity_yards)
    })).sort((left, right) => (
      left.displayName.localeCompare(right.displayName)
      || left.itemCode.localeCompare(right.itemCode)
    )),
    currentLocations: (/** @type {Array<Record<string, unknown>>} */ (locations.rows)).map((row) => ({
      locationKind: "yard",
      locationId: String(row.yard_id),
      locationCode: String(row.yard_code),
      displayName: String(row.display_name),
      address: [
        row.address_line_1, row.address_line_2, row.city, row.region, row.postal_code
      ].map((part) => String(part || "").trim()).filter(Boolean).join(", ")
    })).sort((left, right) => (
      left.displayName.localeCompare(right.displayName)
      || left.locationCode.localeCompare(right.locationCode)
    ))
  };
}

/** @param {Record<string, unknown>} row */
function publicMovement(row) {
  return {
    movementId: String(row.movement_id),
    assetId: String(row.asset_id),
    assetSequence: Number(row.asset_sequence),
    movementType: String(row.movement_type),
    beforeStatus: optionalText(row.before_status),
    afterStatus: String(row.after_status),
    beforeLocationKind: optionalText(row.before_location_kind),
    beforeLocationReference: optionalText(row.before_location_reference),
    afterLocationKind: String(row.after_location_kind),
    afterLocationReference: optionalText(row.after_location_reference),
    beforeAddress: optionalText(row.before_address),
    afterAddress: optionalText(row.after_address),
    fromYardId: optionalText(row.from_yard_id),
    toYardId: optionalText(row.to_yard_id),
    fromCustomerSiteProfileId: optionalText(row.from_customer_site_profile_id),
    toCustomerSiteProfileId: optionalText(row.to_customer_site_profile_id),
    fromDumpSiteId: optionalText(row.from_dump_site_id),
    toDumpSiteId: optionalText(row.to_dump_site_id),
    contractId: optionalText(row.contract_id),
    visitId: optionalText(row.service_visit_id),
    truckId: optionalText(row.truck_id),
    driverId: optionalText(row.driver_id),
    evidenceReferences: Array.isArray(row.evidence_references)
      ? row.evidence_references.map(String)
      : [],
    source: String(row.source),
    actorType: String(row.actor_type),
    actorId: optionalText(row.actor_id),
    overrideReason: optionalText(row.override_reason),
    correctionOfMovementId: optionalText(row.correction_of_movement_id),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    recordedAt: new Date(String(row.recorded_at)).toISOString()
  };
}

/** @param {string} assetId */
export async function getMbtBinAssetTimeline(assetId) {
  const id = requiredText(assetId, "ID");
  const assets = await selectAssets({ assetId: id });
  if (!assets.length) {
    throw failure(404, "MBT_ASSET_NOT_FOUND", "The bin asset was not found.", { assetId: id });
  }
  const result = await query(
    `SELECT
       movement_id::text, asset_id::text, asset_sequence::int,
       movement_type, before_status, after_status, before_location_kind,
       before_location_reference, after_location_kind, after_location_reference,
       before_address, after_address,
       from_yard_id::text, to_yard_id::text,
       from_customer_site_profile_id::text, to_customer_site_profile_id::text,
       from_dump_site_id::text, to_dump_site_id::text,
       contract_id::text, service_visit_id::text, truck_id::text, driver_id::text,
       evidence_references, source, actor_type, actor_id, override_reason,
       correction_of_movement_id::text, occurred_at, recorded_at
     FROM mbt_bin_movements
     WHERE asset_id = $1
     ORDER BY asset_sequence, movement_id`,
    [id]
  );
  return {
    schemaVersion: "mbt-asset-timeline-v1",
    asset: assets[0],
    assetId: id,
    movements: result.rows.map(publicMovement)
  };
}

/** @param {Record<string, unknown>} before @param {unknown} value */
function normalizeAttributeUpdate(before, value) {
  const attributes = objectValue(value, "attribute update");
  const allowed = new Set([
    "qrCode",
    "barcode",
    "tareWeightKg",
    "conditionCode",
    "operationalNotes",
    "active",
    "underMaintenance"
  ]);
  if (Object.keys(attributes).some((key) => !allowed.has(key))) {
    throw failure(400, "MBT_ASSET_INPUT_INVALID", "Asset identity/location fields cannot be updated here.");
  }
  return {
    qrCode: Object.hasOwn(attributes, "qrCode")
      ? optionalText(attributes.qrCode)
      : optionalText(before.qrCode),
    barcode: Object.hasOwn(attributes, "barcode")
      ? optionalText(attributes.barcode)
      : optionalText(before.barcode),
    tareWeightKg: Object.hasOwn(attributes, "tareWeightKg")
      ? tareWeight(attributes.tareWeightKg)
      : optionalText(before.tareWeightKg),
    conditionCode: Object.hasOwn(attributes, "conditionCode")
      ? optionalText(attributes.conditionCode)
      : optionalText(before.conditionCode),
    operationalNotes: Object.hasOwn(attributes, "operationalNotes")
      ? String(attributes.operationalNotes ?? "").trim()
      : String(before.operationalNotes || ""),
    active: Object.hasOwn(attributes, "active")
      ? strictBoolean(attributes.active, "active state")
      : before.active === true,
    underMaintenance: Object.hasOwn(attributes, "underMaintenance")
      ? strictBoolean(attributes.underMaintenance, "maintenance state")
      : before.underMaintenance === true
  };
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.assetId
 * @param {unknown} input.attributes
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function updateMbtBinAssetAttributes(input) {
  const assetId = requiredText(input?.assetId, "ID");
  const reason = requiredText(input?.reason, "update reason");
  try {
    return await executeMbtCommand({
      actor: input.actor,
      commandName: "mbt.asset.update",
      idempotencyKey: input.idempotencyKey,
      payload: {
        assetId,
        attributes: input.attributes,
        expectedRevision: input.expectedRevision,
        reason
      },
      correlationId: input.correlationId,
      requestId: input.requestId,
      mutation: async () => {
        const selected = await selectAssets({ assetId, forUpdate: true });
        if (!selected.length) {
          throw failure(404, "MBT_ASSET_NOT_FOUND", "The bin asset was not found.", { assetId });
        }
        const before = selected[0];
        assertExpectedRevision(Number(before.revision), input.expectedRevision);
        const attributes = normalizeAttributeUpdate(before, input.attributes);
        await requireCondition(attributes.conditionCode);
        const revision = nextRevision(Number(before.revision));
        await query(
          `UPDATE mbt_bin_assets
              SET qr_code = $2,
                  barcode = $3,
                  tare_weight_kg = $4,
                  condition_code = $5,
                  operational_notes = $6,
                  active = $7,
                  under_maintenance = $8,
                  revision = $9,
                  updated_by = $10,
                  updated_at = now()
            WHERE asset_id = $1`,
          [
            assetId,
            attributes.qrCode,
            attributes.barcode,
            attributes.tareWeightKg,
            attributes.conditionCode,
            attributes.operationalNotes,
            attributes.active,
            attributes.underMaintenance,
            revision,
            input.actor.operatorId
          ]
        );
        const after = (await selectAssets({ assetId }))[0];
        return {
          status: 200,
          body: { schemaVersion: "mbt-asset-v1", asset: after },
          audit: {
            action: "mbt.asset.updated",
            entityType: "mbt_bin_asset",
            entityId: assetId,
            beforeState: before,
            afterState: after,
            reason,
            revisionBefore: Number(before.revision),
            revisionAfter: Number(after.revision),
            source: "asset_registry"
          }
        };
      }
    });
  } catch (error) {
    throw duplicateAssetFailure(error) || error;
  }
}

/**
 * Remove only an accidental, never-operated asset registration. Its initial
 * state and asset_registered movement are owned by the registration command;
 * any reservation, visit, reconciliation row, later movement, or other link
 * causes the database transaction to fail closed.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.assetId
 * @param {number} input.expectedRevision
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function deleteMbtBinAsset(input) {
  const assetId = requiredText(input?.assetId, "ID");
  const reason = "Deleted unused asset registration from MBT asset management";
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.asset.delete",
    idempotencyKey: input.idempotencyKey,
    payload: { assetId, expectedRevision: input.expectedRevision },
    correlationId: input.correlationId,
    requestId: input.requestId,
    // eslint-disable-next-line complexity -- Deletion is intentionally a single fail-closed ledger transaction.
    mutation: async () => {
      try {
        const selected = await selectAssets({ assetId, forUpdate: true });
        if (!selected.length) {
          throw failure(404, "MBT_ASSET_NOT_FOUND", "The bin asset was not found.", { assetId });
        }
        const before = selected[0];
        assertExpectedRevision(Number(before.revision), input.expectedRevision);
        const movements = await query(
          `SELECT movement_id::text, asset_sequence::int, movement_type
             FROM mbt_bin_movements
            WHERE asset_id = $1
            ORDER BY asset_sequence, movement_id
            FOR UPDATE`,
          [assetId]
        );
        const opening = movements.rows[0];
        if (movements.rowCount !== 1 || Number(opening?.asset_sequence) !== 1
            || String(opening?.movement_type) !== "asset_registered") {
          throw failure(
            409,
            "MBT_ENTITY_IN_USE",
            "This asset has movement history. Make it inactive to preserve the ledger."
          );
        }
        await query("SELECT set_config('mbt.delete_bin_asset', $1, true)", [assetId]);
        await query("DELETE FROM mbt_bin_asset_state WHERE asset_id = $1", [assetId]);
        await query("DELETE FROM mbt_bin_movements WHERE asset_id = $1", [assetId]);
        await query("DELETE FROM mbt_bin_assets WHERE asset_id = $1", [assetId]);
        return {
          status: 200,
          body: { assetId, deleted: true },
          audit: {
            action: "mbt.asset.deleted",
            entityType: "mbt_bin_asset",
            entityId: assetId,
            beforeState: before,
            afterState: { exists: false },
            reason,
            revisionBefore: Number(before.revision),
            revisionAfter: Number(before.revision),
            source: "asset_registry"
          }
        };
      } catch (error) {
        if (error instanceof MbtError) {
          throw error;
        }
        const code = String(error && typeof error === "object" && "code" in error ? error.code : "");
        if (["23503", "23514", "55000"].includes(code)) {
          throw failure(
            409,
            "MBT_ENTITY_IN_USE",
            "This asset is linked to operational or historical data. Make it inactive instead of deleting it."
          );
        }
        throw error;
      }
    }
  });
}

/** @param {unknown} value @param {string} label */
function nullableSnapshotText(value, label) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return requiredText(value, label);
}

/** @param {unknown} value @param {number} index */
function normalizeManualMovement(value, index) {
  const row = objectValue(value, `manual movement row ${index + 1}`);
  const beforeStatus = nullableSnapshotText(row.beforeStatus, "manual before status");
  const afterStatus = requiredText(row.afterStatus, "manual after status");
  const beforeLocationKind = nullableSnapshotText(
    row.beforeLocationKind,
    "manual before location kind"
  );
  const afterLocationKind = requiredText(row.afterLocationKind, "manual after location kind");
  if ((beforeStatus && !ASSET_STATUSES.has(beforeStatus)) || !ASSET_STATUSES.has(afterStatus)) {
    throw failure(400, "MBT_RECONCILIATION_INPUT_INVALID", "A manual asset status is invalid.");
  }
  if ((beforeLocationKind && !LOCATION_KINDS.has(beforeLocationKind))
      || !LOCATION_KINDS.has(afterLocationKind)) {
    throw failure(400, "MBT_RECONCILIATION_INPUT_INVALID", "A manual asset location is invalid.");
  }
  return {
    manualRowId: requiredText(row.manualRowId, "manual row ID"),
    assetCode: requiredText(row.assetCode, "manual asset code"),
    assetSequence: positiveInteger(row.assetSequence, "manual movement sequence"),
    beforeStatus,
    afterStatus,
    beforeLocationKind,
    afterLocationKind,
    afterLocationReference: nullableSnapshotText(
      row.afterLocationReference,
      "manual after location reference"
    ),
    truckId: nullableSnapshotText(row.truckId, "manual truck ID"),
    driverId: nullableSnapshotText(row.driverId, "manual driver ID"),
    visitId: nullableSnapshotText(row.visitId, "manual visit ID"),
    occurredAt: timestamp(row.occurredAt, "manual occurrence time").toISOString()
  };
}

/** @param {Record<string, unknown>} row */
function movementSnapshot(row) {
  return {
    assetId: String(row.asset_id),
    assetCode: String(row.asset_code),
    assetSequence: Number(row.asset_sequence),
    beforeStatus: optionalText(row.before_status),
    afterStatus: String(row.after_status),
    beforeLocationKind: optionalText(row.before_location_kind),
    afterLocationKind: String(row.after_location_kind),
    afterLocationReference: optionalText(row.after_location_reference),
    truckId: optionalText(row.truck_id),
    driverId: optionalText(row.driver_id),
    visitId: optionalText(row.service_visit_id),
    occurredAt: new Date(String(row.occurred_at)).toISOString()
  };
}

const COMPARISON_FIELDS = Object.freeze([
  "assetCode",
  "assetSequence",
  "beforeStatus",
  "afterStatus",
  "beforeLocationKind",
  "afterLocationKind",
  "afterLocationReference",
  "truckId",
  "driverId",
  "visitId",
  "occurredAt"
]);

/** @param {Record<string, unknown>} application @param {Record<string, unknown>} manual */
function mismatchFields(application, manual) {
  return COMPARISON_FIELDS.filter((field) => application[field] !== manual[field]);
}

/** @param {unknown} rows */
function normalizeComparisonRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50_000) {
    throw failure(
      400,
      "MBT_RECONCILIATION_INPUT_INVALID",
      "Provide from 1 to 50,000 manual movement rows."
    );
  }
  const normalized = rows.map(normalizeManualMovement);
  const manualIds = new Set();
  const movements = new Set();
  for (const row of normalized) {
    const movement = `${row.assetCode}\u0000${row.assetSequence}`;
    if (manualIds.has(row.manualRowId) || movements.has(movement)) {
      throw failure(
        400,
        "MBT_RECONCILIATION_INPUT_INVALID",
        "Manual movement rows must have unique row and asset-sequence identities."
      );
    }
    manualIds.add(row.manualRowId);
    movements.add(movement);
  }
  return normalized;
}

/** @param {string} batchId */
async function materializeComparisonBatch(batchId) {
  const batch = await query(
    `SELECT batch_id::text, schema_version, summary
       FROM mbt_asset_reconciliation_batches
      WHERE batch_id = $1`,
    [batchId]
  );
  if (!batch.rowCount) {
    throw failure(
      404,
      "MBT_RECONCILIATION_NOT_FOUND",
      "The asset reconciliation batch was not found.",
      { batchId }
    );
  }
  const rows = await query(
    `SELECT
       r.comparison_row_id::text,
       r.manual_row_id,
       r.initial_status,
       r.application_snapshot,
       r.manual_snapshot,
       r.mismatch_fields,
       x.decision
     FROM mbt_asset_reconciliation_rows r
     LEFT JOIN mbt_asset_reconciliation_resolutions x
       ON x.comparison_row_id = r.comparison_row_id
     WHERE r.batch_id = $1
     ORDER BY r.row_number, r.comparison_row_id`,
    [batchId]
  );
  return {
    schemaVersion: String(batch.rows[0].schema_version),
    batchId: String(batch.rows[0].batch_id),
    summary: batch.rows[0].summary,
    rows: rows.rows.map((/** @type {Record<string, unknown>} */ row) => ({
      comparisonRowId: String(row.comparison_row_id),
      manualRowId: String(row.manual_row_id),
      status: String(row.decision || row.initial_status),
      applicationSnapshot: row.application_snapshot,
      manualSnapshot: row.manual_snapshot,
      mismatchFields: Array.isArray(row.mismatch_fields) ? row.mismatch_fields.map(String) : []
    }))
  };
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {unknown} input.rows
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function compareMbtAssetMovements(input) {
  const rows = normalizeComparisonRows(input?.rows);
  const reason = requiredText(input?.reason, "comparison reason");
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.asset_reconciliation.compare",
    idempotencyKey: input.idempotencyKey,
    payload: { rows, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const compared = [];
      for (const [index, manual] of rows.entries()) {
        const selected = await query(
          `SELECT
             a.asset_id::text, a.asset_code,
             m.movement_id::text, m.asset_sequence::int,
             m.before_status, m.after_status,
             m.before_location_kind, m.after_location_kind,
             m.after_location_reference,
             m.truck_id::text, m.driver_id::text, m.service_visit_id::text,
             m.occurred_at
           FROM mbt_bin_assets a
           JOIN mbt_bin_movements m ON m.asset_id = a.asset_id
          WHERE a.asset_code = $1 AND m.asset_sequence = $2
          FOR KEY SHARE OF a, m`,
          [manual.assetCode, manual.assetSequence]
        );
        if (!selected.rowCount) {
          throw failure(
            400,
            "MBT_RECONCILIATION_REFERENCE_INVALID",
            "A manual movement does not match an application asset sequence.",
            { rowNumber: index + 1, assetCode: manual.assetCode }
          );
        }
        const application = movementSnapshot(selected.rows[0]);
        const mismatch = mismatchFields(application, manual);
        compared.push({
          comparisonRowId: crypto.randomUUID(),
          rowNumber: index + 1,
          manualRowId: manual.manualRowId,
          assetId: application.assetId,
          movementId: String(selected.rows[0].movement_id),
          assetSequence: manual.assetSequence,
          status: mismatch.length ? "open_variance" : "matched",
          applicationSnapshot: application,
          manualSnapshot: manual,
          mismatchFields: mismatch
        });
      }
      const summary = {
        totalRows: compared.length,
        matched: compared.filter(({ status }) => status === "matched").length,
        openVariance: compared.filter(({ status }) => status === "open_variance").length
      };
      const batchId = crypto.randomUUID();
      await query(
        `INSERT INTO mbt_asset_reconciliation_batches (
           batch_id, summary, actor_operator_id, reason, idempotency_key
         ) VALUES ($1, $2::jsonb, $3, $4, $5)`,
        [batchId, JSON.stringify(summary), input.actor.operatorId, reason, input.idempotencyKey]
      );
      for (const row of compared) {
        await query(
          `INSERT INTO mbt_asset_reconciliation_rows (
             comparison_row_id, batch_id, row_number, manual_row_id,
             asset_id, movement_id, asset_sequence, initial_status,
             application_snapshot, manual_snapshot, mismatch_fields
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9::jsonb, $10::jsonb, $11::text[]
           )`,
          [
            row.comparisonRowId,
            batchId,
            row.rowNumber,
            row.manualRowId,
            row.assetId,
            row.movementId,
            row.assetSequence,
            row.status,
            JSON.stringify(row.applicationSnapshot),
            JSON.stringify(row.manualSnapshot),
            row.mismatchFields
          ]
        );
      }
      const body = await materializeComparisonBatch(batchId);
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.asset_reconciliation.compared",
          entityType: "mbt_asset_reconciliation_batch",
          entityId: batchId,
          beforeState: { exists: false },
          afterState: body,
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "asset_registry"
        }
      };
    }
  });
}

/** @param {string} batchId */
export async function getMbtAssetReconciliationBatch(batchId) {
  return materializeComparisonBatch(requiredText(batchId, "reconciliation batch ID"));
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.comparisonRowId
 * @param {string} input.decision
 * @param {string} input.auditNote
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function resolveMbtAssetMovementVariance(input) {
  const comparisonRowId = requiredText(input?.comparisonRowId, "comparison row ID");
  const decision = requiredText(input?.decision, "comparison decision");
  const auditNote = requiredText(input?.auditNote, "comparison audit note");
  if (!RESOLUTION_DECISIONS.has(decision)) {
    throw failure(
      400,
      "MBT_RECONCILIATION_INPUT_INVALID",
      "The asset reconciliation decision is not supported."
    );
  }
  try {
    return await executeMbtCommand({
      actor: input.actor,
      commandName: "mbt.asset_reconciliation.resolve",
      idempotencyKey: input.idempotencyKey,
      payload: { comparisonRowId, decision, auditNote },
      correlationId: input.correlationId,
      requestId: input.requestId,
      mutation: async () => {
        const selected = await query(
          `SELECT r.comparison_row_id::text, r.batch_id::text, r.initial_status,
                  x.decision AS resolved_decision
             FROM mbt_asset_reconciliation_rows r
             LEFT JOIN mbt_asset_reconciliation_resolutions x
               ON x.comparison_row_id = r.comparison_row_id
            WHERE r.comparison_row_id = $1
            FOR UPDATE OF r`,
          [comparisonRowId]
        );
        if (!selected.rowCount) {
          throw failure(
            404,
            "MBT_RECONCILIATION_NOT_FOUND",
            "The asset reconciliation row was not found."
          );
        }
        const row = selected.rows[0];
        if (row.initial_status !== "open_variance") {
          throw failure(
            409,
            "MBT_RECONCILIATION_NOT_OPEN",
            "A matched asset movement does not require resolution."
          );
        }
        if (row.resolved_decision) {
          throw failure(
            409,
            "MBT_RECONCILIATION_ALREADY_RESOLVED",
            "This asset variance has already been resolved."
          );
        }
        const resolutionId = crypto.randomUUID();
        await query(
          `INSERT INTO mbt_asset_reconciliation_resolutions (
             resolution_id, comparison_row_id, decision, audit_note,
             actor_operator_id, idempotency_key
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            resolutionId,
            comparisonRowId,
            decision,
            auditNote,
            input.actor.operatorId,
            input.idempotencyKey
          ]
        );
        const body = {
          schemaVersion: "mbt-asset-reconciliation-resolution-v1",
          resolutionId,
          comparisonRowId,
          batchId: String(row.batch_id),
          status: decision,
          auditNote
        };
        return {
          status: 200,
          body,
          audit: {
            action: "mbt.asset_reconciliation.resolved",
            entityType: "mbt_asset_reconciliation_row",
            entityId: comparisonRowId,
            beforeState: { status: "open_variance" },
            afterState: body,
            reason: auditNote,
            revisionBefore: 1,
            revisionAfter: 1,
            source: "asset_registry"
          }
        };
      }
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
        && /** @type {{code?: unknown}} */ (error).code === "23505") {
      throw failure(
        409,
        "MBT_RECONCILIATION_ALREADY_RESOLVED",
        "This asset variance has already been resolved."
      );
    }
    throw error;
  }
}

export const assetRegistryService = Object.freeze({
  registerMbtBinAsset,
  listMbtBinAssets,
  getMbtBinAssetTimeline,
  updateMbtBinAssetAttributes,
  deleteMbtBinAsset,
  compareMbtAssetMovements,
  getMbtAssetReconciliationBatch,
  resolveMbtAssetMovementVariance
});
