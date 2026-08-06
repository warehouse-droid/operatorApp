// @ts-check

import crypto from "node:crypto";

import { MbtError } from "./errors.js";
import { resolveMbtAssetLocationAddress } from "./asset-location-address.js";

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

/** @typedef {import("pg").Pool} Pool */
/** @typedef {import("pg").PoolClient} PoolClient */
/** @typedef {Pool | PoolClient | (Pick<PoolClient, "query"> & {ambientTransaction: true})} Database */

/**
 * @typedef {object} AssetLocation
 * @property {string} kind
 * @property {string | null} [reference]
 * @property {string | null} [yardId]
 * @property {string | null} [customerSiteProfileId]
 * @property {string | null} [dumpSiteId]
 * @property {string | number | null} [truckId]
 */

/**
 * @typedef {object} NormalizedLocation
 * @property {string} kind
 * @property {string | null} reference
 * @property {string | null} yardId
 * @property {string | null} customerSiteProfileId
 * @property {string | null} dumpSiteId
 * @property {string | null} truckId
 */

/**
 * @typedef {object} MovementInput
 * @property {string} assetId
 * @property {string} movementType
 * @property {string} afterStatus
 * @property {AssetLocation} afterLocation
 * @property {string | null} [contractId]
 * @property {string | null} [visitId]
 * @property {string | number | null} [truckId]
 * @property {string | number | null} [driverId]
 * @property {string[]} [evidenceReferences]
 * @property {string} source
 * @property {string} actorType
 * @property {string | null} [actorId]
 * @property {string | Date} occurredAt
 * @property {string | null} [overrideReason]
 * @property {string | null} [correctionOfMovementId]
 */

/**
 * @typedef {object} NormalizedMovement
 * @property {string} assetId
 * @property {string} movementType
 * @property {string} afterStatus
 * @property {NormalizedLocation} afterLocation
 * @property {string | null} contractId
 * @property {string | null} visitId
 * @property {string | null} truckId
 * @property {string | null} driverId
 * @property {string[]} evidenceReferences
 * @property {string} source
 * @property {string} actorType
 * @property {string | null} actorId
 * @property {Date} occurredAt
 * @property {string | null} overrideReason
 * @property {string | null} correctionOfMovementId
 */

/**
 * @typedef {object} MovementResult
 * @property {string} movementId
 * @property {string} assetId
 * @property {number} assetSequence
 * @property {number} assetRevision
 */

/**
 * @typedef {object} MovementOptions
 * @property {(result: MovementResult, client: PoolClient) => (void | Promise<void>)} [afterMovementInsert]
 */

/**
 * @typedef {object} ReservationInput
 * @property {string} assetId
 * @property {string} contractId
 * @property {string} visitId
 * @property {string} reservationSlot
 * @property {string | Date | null} [reservedFrom]
 * @property {string | Date | null} [reservedUntil]
 * @property {string} reservedBy
 * @property {string} source
 * @property {string} actorType
 * @property {string | null} [actorId]
 * @property {string | Date} occurredAt
 * @property {string[]} [allowedLifecycleStatuses]
 * @property {"state_transition" | "exact_hold"} [reservationMode]
 */

/**
 * @typedef {object} ReleaseInput
 * @property {string} reservationId
 * @property {string} releasedBy
 * @property {string} releaseReason
 * @property {string} source
 * @property {string} actorType
 * @property {string | null} [actorId]
 * @property {string | Date} occurredAt
 */

/**
 * @typedef {object} ReversalInput
 * @property {string} assetId
 * @property {string} correctionOfMovementId
 * @property {string} source
 * @property {string} actorType
 * @property {string | null} [actorId]
 * @property {string | Date} occurredAt
 * @property {string} overrideReason
 * @property {string[]} [evidenceReferences]
 */

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function invalid(code, message, details = {}) {
  const error = new MbtError({ status: 400, code, details });
  error.message = message;
  return error;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function conflict(code, message, details = {}) {
  const error = new MbtError({ status: 409, code, details });
  error.message = message;
  return error;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function notFound(code, message, details = {}) {
  const error = new MbtError({ status: 404, code, details });
  error.message = message;
  return error;
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw invalid("MBT_ASSET_INPUT_INVALID", `A ${label} is required.`);
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
function requiredTimestamp(value, label) {
  const timestamp = value instanceof Date ? new Date(value) : new Date(String(value ?? ""));
  if (Number.isNaN(timestamp.getTime())) {
    throw invalid("MBT_ASSET_TIMESTAMP_INVALID", `The ${label} must be a valid timestamp.`);
  }
  return timestamp;
}

/** @param {unknown} value @param {string} label */
function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return requiredTimestamp(value, label);
}

/**
 * @param {Database} database
 * @returns {database is Pool}
 */
function isPool(database) {
  return "connect" in database
    && typeof database.connect === "function"
    && !("release" in database);
}

/**
 * Run an asset command in its own database transaction. Callers that require
 * independent race participants pass separately acquired PoolClients.
 *
 * @template T
 * @param {Database} database
 * @param {(client: PoolClient) => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withAssetTransaction(database, operation) {
  if ("ambientTransaction" in database && database.ambientTransaction === true) {
    return operation(/** @type {PoolClient} */ (/** @type {unknown} */ (database)));
  }
  const ownsClient = isPool(database);
  const client = /** @type {PoolClient} */ (/** @type {unknown} */ (
    ownsClient ? await database.connect() : database
  ));
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

/**
 * @param {unknown} error
 * @returns {error is {code: string, constraint?: string}}
 */
function isDatabaseError(error) {
  return Boolean(error && typeof error === "object" && "code" in error);
}

/** @param {unknown} value */
function normalizedStatus(value) {
  const status = requiredText(value, "movement after status");
  if (!ASSET_STATUSES.has(status)) {
    throw invalid("MBT_ASSET_STATUS_INVALID", "The asset status is not supported.", { status });
  }
  return status;
}

/**
 * @param {AssetLocation} value
 * @returns {NormalizedLocation}
 */
function normalizedLocation(value) {
  if (!value || typeof value !== "object") {
    throw invalid("MBT_ASSET_LOCATION_INVALID", "An asset location is required.");
  }
  const kind = requiredText(value.kind, "location kind");
  if (!LOCATION_KINDS.has(kind)) {
    throw invalid("MBT_ASSET_LOCATION_INVALID", "The asset location kind is not supported.", { kind });
  }
  const location = {
    kind,
    reference: optionalText(value.reference),
    yardId: optionalText(value.yardId),
    customerSiteProfileId: optionalText(value.customerSiteProfileId),
    dumpSiteId: optionalText(value.dumpSiteId),
    truckId: optionalText(value.truckId)
  };
  assertLocationIdentity(location);
  return location;
}

/** @param {NormalizedLocation} location */
function assertLocationIdentity(location) {
  if (location.kind === "yard" && !location.yardId) {
    throw invalid("MBT_ASSET_LOCATION_INVALID", "A yard location requires a yard ID.");
  }
  if (location.kind === "customer_site"
      && !location.customerSiteProfileId
      && !location.reference) {
    throw invalid(
      "MBT_ASSET_LOCATION_INVALID",
      "A customer location requires a site profile or a typed customer-site address."
    );
  }
  if (location.kind === "dump_site" && !location.dumpSiteId) {
    throw invalid("MBT_ASSET_LOCATION_INVALID", "A dump location requires a dump-site ID.");
  }
  if (location.kind === "truck" && !location.truckId) {
    throw invalid("MBT_ASSET_LOCATION_INVALID", "A truck location requires a truck ID.");
  }
}

/**
 * @param {MovementInput} input
 * @returns {NormalizedMovement}
 */
function normalizeMovement(input) {
  if (!input || typeof input !== "object") {
    throw invalid("MBT_ASSET_INPUT_INVALID", "A movement command is required.");
  }
  if (input.evidenceReferences !== undefined && !Array.isArray(input.evidenceReferences)) {
    throw invalid("MBT_ASSET_EVIDENCE_INVALID", "Movement evidence references must be an array.");
  }
  return {
    assetId: requiredText(input.assetId, "movement asset ID"),
    movementType: requiredText(input.movementType, "movement type"),
    afterStatus: normalizedStatus(input.afterStatus),
    afterLocation: normalizedLocation(input.afterLocation),
    contractId: optionalText(input.contractId),
    visitId: optionalText(input.visitId),
    truckId: optionalText(input.truckId),
    driverId: optionalText(input.driverId),
    evidenceReferences: (input.evidenceReferences || []).map(String),
    source: requiredText(input.source, "movement source"),
    actorType: requiredText(input.actorType, "movement actor type"),
    actorId: optionalText(input.actorId),
    occurredAt: requiredTimestamp(input.occurredAt, "movement occurrence time"),
    overrideReason: optionalText(input.overrideReason),
    correctionOfMovementId: optionalText(input.correctionOfMovementId)
  };
}

/** @param {Record<string, unknown>} state @returns {NormalizedLocation} */
function locationFromState(state) {
  return {
    kind: String(state.location_kind),
    reference: optionalText(state.location_reference),
    yardId: optionalText(state.yard_id),
    customerSiteProfileId: optionalText(state.customer_site_profile_id),
    dumpSiteId: optionalText(state.dump_site_id),
    truckId: optionalText(state.truck_id)
  };
}

/**
 * @param {PoolClient} client
 * @param {string} assetId
 * @returns {Promise<Record<string, unknown>>}
 */
async function lockAssetState(client, assetId) {
  const selected = await client.query(
    `SELECT s.asset_id, s.lifecycle_status, s.location_kind,
            s.location_reference, s.yard_id, s.customer_site_profile_id,
            s.dump_site_id, s.truck_id, s.current_address,
            s.last_movement_id, s.revision,
            a.active, a.under_maintenance, a.bin_type_id
       FROM mbt_bin_asset_state s
       JOIN mbt_bin_assets a ON a.asset_id = s.asset_id
      WHERE s.asset_id = $1
      FOR UPDATE OF s, a`,
    [assetId]
  );
  if (!selected.rowCount) {
    throw notFound("MBT_ASSET_NOT_FOUND", "The bin asset was not found.", { assetId });
  }
  return selected.rows[0];
}

/**
 * @param {PoolClient} client
 * @param {Record<string, unknown>} state
 * @param {NormalizedMovement} input
 * @param {MovementOptions} options
 * @returns {Promise<MovementResult>}
 */
async function appendMovement(client, state, input, options) {
  const before = locationFromState(state);
  const beforeAddress = optionalText(state.current_address) || before.reference || "Unknown";
  const afterAddress = await resolveMbtAssetLocationAddress(client, input.afterLocation);
  const movementId = crypto.randomUUID();
  const sequenceResult = await client.query(
    `SELECT (COALESCE(max(asset_sequence), 0) + 1)::int AS next_sequence
       FROM mbt_bin_movements
      WHERE asset_id = $1`,
    [input.assetId]
  );
  const assetSequence = Number(sequenceResult.rows[0].next_sequence);
  const movementTruckId = input.truckId || input.afterLocation.truckId || before.truckId;
  await client.query(
    `INSERT INTO mbt_bin_movements (
       movement_id, asset_id, asset_sequence, movement_type,
       before_status, after_status, before_location_kind,
       before_location_reference, after_location_kind,
       after_location_reference, before_address, after_address,
       from_yard_id, to_yard_id,
       from_customer_site_profile_id, to_customer_site_profile_id,
       from_dump_site_id, to_dump_site_id, contract_id, service_visit_id,
       truck_id, driver_id, evidence_references, source, actor_type, actor_id,
       override_reason, correction_of_movement_id, occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23::uuid[], $24, $25, $26, $27, $28, $29
     )`,
    [
      movementId,
      input.assetId,
      assetSequence,
      input.movementType,
      String(state.lifecycle_status),
      input.afterStatus,
      before.kind,
      before.reference,
      input.afterLocation.kind,
      input.afterLocation.reference,
      beforeAddress,
      afterAddress,
      before.yardId,
      input.afterLocation.yardId,
      before.customerSiteProfileId,
      input.afterLocation.customerSiteProfileId,
      before.dumpSiteId,
      input.afterLocation.dumpSiteId,
      input.contractId,
      input.visitId,
      movementTruckId,
      input.driverId,
      input.evidenceReferences,
      input.source,
      input.actorType,
      input.actorId,
      input.overrideReason,
      input.correctionOfMovementId,
      input.occurredAt
    ]
  );
  const expectedRevision = Number(state.revision) + 1;
  const provisional = {
    movementId,
    assetId: input.assetId,
    assetSequence,
    assetRevision: expectedRevision
  };
  if (options.afterMovementInsert) {
    await options.afterMovementInsert(provisional, client);
  }
  const updated = await client.query(
    `UPDATE mbt_bin_asset_state
        SET lifecycle_status = $2,
            location_kind = $3,
            location_reference = $4,
            current_address = $5,
            yard_id = $6,
            customer_site_profile_id = $7,
            dump_site_id = $8,
            truck_id = $9,
            last_movement_id = $10,
            revision = revision + 1,
            changed_at = $11,
            updated_at = now()
      WHERE asset_id = $1
      RETURNING revision::int AS revision`,
    [
      input.assetId,
      input.afterStatus,
      input.afterLocation.kind,
      input.afterLocation.reference,
      afterAddress,
      input.afterLocation.yardId,
      input.afterLocation.customerSiteProfileId,
      input.afterLocation.dumpSiteId,
      input.afterLocation.truckId,
      movementId,
      input.occurredAt
    ]
  );
  return { ...provisional, assetRevision: Number(updated.rows[0].revision) };
}

/**
 * Atomically append an asset movement and update its materialized current state.
 *
 * @param {Database} database
 * @param {MovementInput} input
 * @param {MovementOptions} [options]
 * @returns {Promise<MovementResult>}
 */
export async function recordAssetMovement(database, input, options = {}) {
  const movement = normalizeMovement(input);
  return withAssetTransaction(database, async (client) => {
    const state = await lockAssetState(client, movement.assetId);
    return appendMovement(client, state, movement, options);
  });
}

/**
 * @param {Record<string, unknown>} target
 * @returns {NormalizedLocation}
 */
function locationBeforeMovement(target) {
  const kind = optionalText(target.before_location_kind);
  if (!kind) {
    throw conflict(
      "MBT_MOVEMENT_NOT_REVERSIBLE",
      "The selected movement has no prior location to restore."
    );
  }
  return normalizedLocation({
    kind,
    reference: optionalText(target.before_location_reference),
    yardId: optionalText(target.from_yard_id),
    customerSiteProfileId: optionalText(target.from_customer_site_profile_id),
    dumpSiteId: optionalText(target.from_dump_site_id),
    truckId: kind === "truck" ? optionalText(target.truck_id) : null
  });
}

/** @param {Record<string, unknown>} target */
function statusBeforeMovement(target) {
  const status = optionalText(target.before_status);
  if (!status) {
    throw conflict(
      "MBT_MOVEMENT_NOT_REVERSIBLE",
      "The selected movement has no prior status to restore."
    );
  }
  return status;
}

/**
 * Append a correction movement that restores the immediately preceding state.
 * Historical movement rows are never changed.
 *
 * @param {Database} database
 * @param {ReversalInput} input
 * @returns {Promise<MovementResult>}
 */
export async function reverseAssetMovement(database, input) {
  const assetId = requiredText(input?.assetId, "correction asset ID");
  const correctionId = requiredText(
    input?.correctionOfMovementId,
    "movement ID to correct"
  );
  const overrideReason = requiredText(input?.overrideReason, "correction reason");
  return withAssetTransaction(database, async (client) => {
    const state = await lockAssetState(client, assetId);
    const selected = await client.query(
      `SELECT movement_id, asset_id, before_status, before_location_kind,
              before_location_reference, from_yard_id,
              from_customer_site_profile_id, from_dump_site_id,
              contract_id, service_visit_id, truck_id, driver_id
         FROM mbt_bin_movements
        WHERE movement_id = $1`,
      [correctionId]
    );
    if (!selected.rowCount) {
      throw notFound("MBT_MOVEMENT_NOT_FOUND", "The movement to correct was not found.");
    }
    const target = selected.rows[0];
    assertCorrectionTarget(state, target, assetId, correctionId);
    const priorStatus = statusBeforeMovement(target);
    const priorLocation = locationBeforeMovement(target);
    const movement = normalizeMovement({
      assetId,
      movementType: "correction_reversal",
      afterStatus: priorStatus,
      afterLocation: priorLocation,
      contractId: optionalText(target.contract_id),
      visitId: optionalText(target.service_visit_id),
      truckId: optionalText(target.truck_id),
      driverId: optionalText(target.driver_id),
      evidenceReferences: input.evidenceReferences || [],
      source: input.source,
      actorType: input.actorType,
      actorId: optionalText(input.actorId),
      occurredAt: input.occurredAt,
      overrideReason,
      correctionOfMovementId: correctionId
    });
    return appendMovement(client, state, movement, {});
  });
}

/**
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} target
 * @param {string} assetId
 * @param {string} correctionId
 */
function assertCorrectionTarget(state, target, assetId, correctionId) {
  if (String(target.asset_id) !== assetId) {
    throw conflict(
      "MBT_MOVEMENT_ASSET_MISMATCH",
      "The correction movement belongs to another asset.",
      { assetId, correctionId }
    );
  }
  if (String(state.last_movement_id) !== correctionId) {
    throw conflict(
      "MBT_MOVEMENT_CORRECTION_CONFLICT",
      "Only the asset's latest movement can be reversed.",
      { assetId, correctionId, lastMovementId: state.last_movement_id }
    );
  }
}

/**
 * @param {Date | null} reservedFrom
 * @param {Date | null} reservedUntil
 */
function assertReservationWindow(reservedFrom, reservedUntil) {
  if (reservedFrom && reservedUntil && reservedUntil <= reservedFrom) {
    throw invalid(
      "MBT_RESERVATION_WINDOW_INVALID",
      "The reservation end must be after its start."
    );
  }
}

/** @param {ReservationInput} input */
function normalizeReservation(input) {
  if (!input || typeof input !== "object") {
    throw invalid("MBT_ASSET_INPUT_INVALID", "A reservation command is required.");
  }
  const reservedFrom = optionalTimestamp(input.reservedFrom, "reservation start");
  const reservedUntil = optionalTimestamp(input.reservedUntil, "reservation end");
  assertReservationWindow(reservedFrom, reservedUntil);
  const allowedLifecycleStatuses = input.allowedLifecycleStatuses === undefined
    ? ["available"]
    : Array.isArray(input.allowedLifecycleStatuses)
      ? [...new Set(input.allowedLifecycleStatuses.map(normalizedStatus))]
      : [];
  if (!allowedLifecycleStatuses.length) {
    throw invalid(
      "MBT_ASSET_RESERVATION_STATUS_INVALID",
      "At least one allowed reservation asset status is required."
    );
  }
  const reservationMode = input.reservationMode === undefined
    ? "state_transition"
    : requiredText(input.reservationMode, "reservation mode");
  if (!["state_transition", "exact_hold"].includes(reservationMode)) {
    throw invalid(
      "MBT_ASSET_RESERVATION_MODE_INVALID",
      "The asset reservation mode is not supported."
    );
  }
  return {
    assetId: requiredText(input.assetId, "reservation asset ID"),
    contractId: requiredText(input.contractId, "reservation contract ID"),
    visitId: requiredText(input.visitId, "reservation visit ID"),
    reservationSlot: requiredText(input.reservationSlot, "reservation slot"),
    reservedFrom,
    reservedUntil,
    reservedBy: requiredText(input.reservedBy, "reserving actor"),
    source: requiredText(input.source, "reservation source"),
    actorType: requiredText(input.actorType, "reservation actor type"),
    actorId: optionalText(input.actorId),
    occurredAt: requiredTimestamp(input.occurredAt, "reservation occurrence time"),
    allowedLifecycleStatuses,
    reservationMode
  };
}

/**
 * @param {PoolClient} client
 * @param {{assetId: string, contractId: string, visitId: string, reservationSlot: string, allowedLifecycleStatuses: string[]}} input
 * @param {Record<string, unknown>} state
 */
async function assertReservationAvailable(client, input, state) {
  const existingAsset = await client.query(
    `SELECT reservation_id
       FROM mbt_bin_asset_reservations
      WHERE asset_id = $1 AND released_at IS NULL
      LIMIT 1`,
    [input.assetId]
  );
  if (existingAsset.rowCount) {
    throw assetReservationConflict(input.assetId);
  }
  const existingSlot = await client.query(
    `SELECT reservation_id
       FROM mbt_bin_asset_reservations
      WHERE visit_id = $1 AND reservation_slot = $2 AND released_at IS NULL
      LIMIT 1`,
    [input.visitId, input.reservationSlot]
  );
  if (existingSlot.rowCount) {
    throw visitReservationConflict(input.visitId, input.reservationSlot);
  }
  if (!input.allowedLifecycleStatuses.includes(String(state.lifecycle_status)) || !state.active || state.under_maintenance) {
    throw conflict(
      "MBT_ASSET_NOT_AVAILABLE",
      "The bin asset is not available for reservation.",
      {
        assetId: input.assetId,
        lifecycleStatus: state.lifecycle_status,
        allowedLifecycleStatuses: input.allowedLifecycleStatuses
      }
    );
  }
}

/** @param {string} assetId */
function assetReservationConflict(assetId) {
  return conflict(
    "MBT_ASSET_RESERVATION_CONFLICT",
    "The bin asset already has an active reservation.",
    { assetId }
  );
}

/** @param {string} visitId @param {string} reservationSlot */
function visitReservationConflict(visitId, reservationSlot) {
  return conflict(
    "MBT_VISIT_RESERVATION_CONFLICT",
    "The service-visit reservation slot is already occupied.",
    { visitId, reservationSlot }
  );
}

/**
 * @param {PoolClient} client
 * @param {{contractId: string, visitId: string}} input
 * @param {Record<string, unknown>} state
 */
async function assertReservationVisit(client, input, state) {
  const visit = await client.query(
    `SELECT contract_id, bin_type_id, status,
            customer_site_profile_id::text, expected_asset_id::text,
            outgoing_asset_id::text, incoming_asset_id::text
       FROM mbt_service_visits
      WHERE service_visit_id = $1`,
    [input.visitId]
  );
  if (!visit.rowCount || String(visit.rows[0].contract_id) !== input.contractId) {
    throw invalid(
      "MBT_RESERVATION_VISIT_INVALID",
      "The reservation visit does not belong to the supplied contract."
    );
  }
  if (visit.rows[0].status === "cancelled") {
    throw conflict("MBT_RESERVATION_VISIT_CANCELLED", "A cancelled visit cannot reserve an asset.");
  }
  if (visit.rows[0].status === "completed") {
    throw conflict("MBT_RESERVATION_VISIT_COMPLETED", "A completed visit cannot reserve an asset.");
  }
  if (String(visit.rows[0].bin_type_id) !== String(state.bin_type_id)) {
    throw conflict(
      "MBT_RESERVATION_BIN_TYPE_CONFLICT",
      "The asset bin type does not match the service visit."
    );
  }
  return visit.rows[0];
}

/** @param {Record<string, unknown>} visit @param {string} slot */
function visitAssetForSlot(visit, slot) {
  if (slot === "incoming") {
    return optionalText(visit.incoming_asset_id);
  }
  if (slot === "outgoing") {
    return optionalText(visit.outgoing_asset_id) || optionalText(visit.expected_asset_id);
  }
  return null;
}

/**
 * Exact holds protect assets that must retain their real operational state
 * until the Driver performs the physical movement. They are deliberately
 * limited to a server-owned loaded pickup or a distinct two-asset exchange;
 * ordinary one-outgoing reservations continue to use the historical
 * available -> reserved movement.
 *
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} visit
 */
function assertExactHold(input, state, visit) {
  const expectedAssetId = visitAssetForSlot(visit, String(input.reservationSlot));
  if (!expectedAssetId || expectedAssetId !== String(input.assetId)) {
    throw conflict(
      "MBT_RESERVATION_ASSET_CONFLICT",
      "The reservation asset does not match the server-owned visit slot.",
      { assetId: input.assetId, reservationSlot: input.reservationSlot }
    );
  }
  const outgoingAssetId = optionalText(visit.outgoing_asset_id);
  const incomingAssetId = optionalText(visit.incoming_asset_id);
  const distinctExchange = Boolean(
    outgoingAssetId && incomingAssetId && outgoingAssetId !== incomingAssetId
  );
  const customerLocated = String(state.lifecycle_status) === "at_customer"
    && String(state.location_kind) === "customer_site";
  if (!distinctExchange && !customerLocated) {
    throw conflict(
      "MBT_RESERVATION_MODE_CONFLICT",
      "This visit requires the standard asset reservation transition."
    );
  }
  if (customerLocated
      && String(state.customer_site_profile_id || "")
        !== String(visit.customer_site_profile_id || "")) {
    throw conflict(
      "MBT_RESERVATION_SITE_CONFLICT",
      "The customer-located bin does not belong to this service visit site.",
      {
        assetId: input.assetId,
        assetSiteProfileId: state.customer_site_profile_id,
        visitSiteProfileId: visit.customer_site_profile_id
      }
    );
  }
}

/**
 * @param {unknown} error
 * @param {{assetId: string, visitId: string, reservationSlot: string}} input
 * @returns {never}
 */
function mapReservationConstraint(error, input) {
  if (!isDatabaseError(error) || error.code !== "23505") {
    throw error;
  }
  if (error.constraint === "idx_mbt_bin_asset_reservations_active_asset") {
    throw assetReservationConflict(input.assetId);
  }
  if (error.constraint === "idx_mbt_bin_asset_reservations_active_visit_slot") {
    throw visitReservationConflict(input.visitId, input.reservationSlot);
  }
  throw error;
}

/**
 * Reserve exactly one available asset and pair the reservation with its
 * append-only movement and materialized current state.
 *
 * @param {Database} database
 * @param {ReservationInput} input
 * @returns {Promise<MovementResult & {reservationId: string}>}
 */
export async function reserveAsset(database, input) {
  const reservation = normalizeReservation(input);
  try {
    return await withAssetTransaction(database, async (client) => {
      const state = await lockAssetState(client, reservation.assetId);
      await assertReservationAvailable(client, reservation, state);
      const visit = await assertReservationVisit(client, reservation, state);
      if (reservation.reservationMode === "exact_hold") {
        assertExactHold(reservation, state, visit);
      }
      const reservationId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mbt_bin_asset_reservations (
           reservation_id, asset_id, contract_id, visit_id, reservation_slot,
           reserved_from, reserved_until, reserved_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          reservationId,
          reservation.assetId,
          reservation.contractId,
          reservation.visitId,
          reservation.reservationSlot,
          reservation.reservedFrom,
          reservation.reservedUntil,
          reservation.reservedBy
        ]
      );
      const preserveState = reservation.reservationMode === "exact_hold";
      const movement = normalizeMovement({
        assetId: reservation.assetId,
        movementType: "reservation_created",
        afterStatus: preserveState ? String(state.lifecycle_status) : "reserved",
        afterLocation: locationFromState(state),
        contractId: reservation.contractId,
        visitId: reservation.visitId,
        truckId: optionalText(state.truck_id),
        source: reservation.source,
        actorType: reservation.actorType,
        actorId: reservation.actorId,
        occurredAt: reservation.occurredAt
      });
      return { ...(await appendMovement(client, state, movement, {})), reservationId };
    });
  } catch (error) {
    return mapReservationConstraint(error, reservation);
  }
}

/** @param {ReleaseInput} input */
function normalizeRelease(input) {
  return {
    reservationId: requiredText(input?.reservationId, "reservation ID"),
    releasedBy: requiredText(input?.releasedBy, "releasing actor"),
    releaseReason: requiredText(input?.releaseReason, "reservation release reason"),
    source: requiredText(input?.source, "release source"),
    actorType: requiredText(input?.actorType, "release actor type"),
    actorId: optionalText(input?.actorId),
    occurredAt: requiredTimestamp(input?.occurredAt, "release occurrence time")
  };
}

/**
 * Release an active reservation, append the release movement, and make the
 * yard asset available for a later reservation.
 *
 * @param {Database} database
 * @param {ReleaseInput} input
 * @returns {Promise<MovementResult & {reservationId: string, releasedAt: string}>}
 */
export async function releaseAssetReservation(database, input) {
  const release = normalizeRelease(input);
  return withAssetTransaction(database, async (client) => {
    const identity = await client.query(
      `SELECT asset_id
         FROM mbt_bin_asset_reservations
        WHERE reservation_id = $1`,
      [release.reservationId]
    );
    if (!identity.rowCount) {
      throw notFound("MBT_RESERVATION_NOT_FOUND", "The asset reservation was not found.");
    }
    const assetId = String(identity.rows[0].asset_id);
    const state = await lockAssetState(client, assetId);
    const selected = await client.query(
      `SELECT reservation_id, asset_id, contract_id, visit_id, reserved_at,
              released_at
         FROM mbt_bin_asset_reservations
        WHERE reservation_id = $1
        FOR UPDATE`,
      [release.reservationId]
    );
    const reservation = selected.rows[0];
    assertReservationReleasable(reservation, state, release.occurredAt);
    await client.query(
      `UPDATE mbt_bin_asset_reservations
          SET released_at = $2,
              released_by = $3,
              release_reason = $4,
              revision = revision + 1,
              updated_at = now()
        WHERE reservation_id = $1`,
      [release.reservationId, release.occurredAt, release.releasedBy, release.releaseReason]
    );
    const movement = normalizeMovement({
      assetId,
      movementType: "reservation_released",
      afterStatus: "available",
      afterLocation: locationFromState(state),
      contractId: optionalText(reservation.contract_id),
      visitId: optionalText(reservation.visit_id),
      truckId: optionalText(state.truck_id),
      source: release.source,
      actorType: release.actorType,
      actorId: release.actorId,
      occurredAt: release.occurredAt,
      overrideReason: release.releaseReason
    });
    const appended = await appendMovement(client, state, movement, {});
    return {
      ...appended,
      reservationId: release.reservationId,
      releasedAt: release.occurredAt.toISOString()
    };
  });
}

/**
 * @param {Record<string, unknown>} reservation
 * @param {Record<string, unknown>} state
 * @param {Date} releasedAt
 */
function assertReservationReleasable(reservation, state, releasedAt) {
  if (reservation.released_at) {
    throw conflict(
      "MBT_RESERVATION_ALREADY_RELEASED",
      "The asset reservation has already been released."
    );
  }
  if (state.lifecycle_status !== "reserved" || state.location_kind !== "yard") {
    throw conflict(
      "MBT_RESERVATION_RELEASE_CONFLICT",
      "Only a reserved asset at a yard can be released to available status."
    );
  }
  const reservedAt = requiredTimestamp(reservation.reserved_at, "stored reservation time");
  if (releasedAt < reservedAt) {
    throw invalid(
      "MBT_RESERVATION_RELEASE_TIME_INVALID",
      "The release time cannot precede the reservation time."
    );
  }
}
