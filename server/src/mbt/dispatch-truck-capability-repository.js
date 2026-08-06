// @ts-check

import crypto from "node:crypto";

import { config } from "../config.js";
import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import { evaluateMbtPhase3Capability } from "./phase3-capabilities.js";

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: `A truck ${label} is required.`
    });
  }
  return normalized;
}

/** @param {unknown} value @param {string} label @param {boolean} allowZero */
function boundedNumber(value, label, allowZero) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: `Truck ${label} is invalid.`
    });
  }
  return number;
}

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "A positive BIN slot capacity is required."
    });
  }
  return number;
}

/** @param {unknown} value */
function truckId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "A positive truck ID is required."
    });
  }
  return normalized;
}

/** @param {unknown} value */
function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_REVISION_REQUIRED",
      message: "A positive expected truck revision is required."
    });
  }
  return Number(value);
}

/** @param {unknown} value */
function normalizedCodes(value) {
  if (!Array.isArray(value)) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "Supported BIN sizes must be an array."
    });
  }
  const codes = [...new Set(value.map((code) => String(code ?? "").trim().toUpperCase()))];
  if (codes.some((code) => !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code))) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "A supported BIN size is invalid."
    });
  }
  return codes.sort();
}

/** @param {unknown} value */
function normalizedTruckType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  if (type !== "flatbed" && type !== "bin") {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "Truck type must be Flatbed or Bin."
    });
  }
  return type;
}

/** @param {string} type @param {string} baseYard @param {string[]} supportedBinTypeCodes */
function assertCapabilityRelationship(type, baseYard, supportedBinTypeCodes) {
  if (type === "bin" && (!baseYard || supportedBinTypeCodes.length === 0)) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "A Bin truck requires a base yard and at least one supported BIN size."
    });
  }
  if (type === "flatbed" && supportedBinTypeCodes.length !== 0) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "A Flatbed truck cannot have supported BIN sizes."
    });
  }
}

/** @param {unknown} value */
function normalizedCapability(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "A truck capability object is required."
    });
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  const accepted = new Set([
    "truckType", "capacityLbs", "travelTimePercent", "baseYard",
    "binSlotCapacity", "supportedBinTypeCodes"
  ]);
  if (Object.keys(input).some((key) => !accepted.has(key))) {
    throw new MbtError({
      status: 400,
      code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
      message: "Truck capabilities contain an unsupported field."
    });
  }
  const type = normalizedTruckType(input.truckType);
  const supportedBinTypeCodes = normalizedCodes(input.supportedBinTypeCodes);
  const baseYard = String(input.baseYard ?? "").trim();
  const binSlotCapacity = type === "bin" ? positiveInteger(input.binSlotCapacity) : 0;
  assertCapabilityRelationship(type, baseYard, supportedBinTypeCodes);
  return {
    truckType: type,
    capacityLbs: boundedNumber(input.capacityLbs, "weight capacity", false),
    travelTimePercent: boundedNumber(input.travelTimePercent, "travel-time adjustment", true),
    baseYard,
    binSlotCapacity,
    supportedBinTypeCodes
  };
}

/** @param {Record<string, unknown>} row */
function publicTruck(row) {
  return {
    id: String(row.id),
    plate: String(row.plate),
    active: row.active !== false,
    capacityLbs: Number(row.capacity_lbs),
    travelTimePercent: Number(row.travel_time_percent),
    baseYard: String(row.base_yard || ""),
    displayOrder: Number(row.display_order || 0),
    truckType: row.truck_type === "bin" ? "bin" : "flatbed",
    revision: Number(row.revision),
    binServiceEnabled: row.truck_type === "bin" && row.bin_service_enabled === true,
    binSlotCapacity: Number(row.bin_slot_capacity),
    supportedBinTypeCodes: Array.isArray(row.supported_bin_type_codes)
      ? row.supported_bin_type_codes.map(String)
      : []
  };
}

/** @param {string} id @param {boolean} forUpdate */
async function selectTruck(id, forUpdate = false) {
  const result = await query(
    `SELECT truck.*,
            COALESCE(supported.codes, ARRAY[]::text[]) AS supported_bin_type_codes
       FROM dispatch_trucks truck
       LEFT JOIN LATERAL (
         SELECT array_agg(bin_type.type_code ORDER BY bin_type.type_code) AS codes
           FROM dispatch_truck_bin_types capability
           JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = capability.bin_type_id
          WHERE capability.truck_id = truck.id
            AND capability.active
       ) supported ON true
      WHERE truck.id = $1
      ${forUpdate ? "FOR UPDATE OF truck" : ""}`,
    [id]
  );
  return result.rows[0] || null;
}

/** @param {MbtActor} actor */
async function assertMasterDataCapability(actor) {
  const flags = await query(
    `SELECT flag_key, enabled
       FROM mbt_feature_flags
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"]]
  );
  const databaseFlags = Object.fromEntries(flags.rows.map(
    (/** @type {Record<string, unknown>} */ row) => [String(row.flag_key), row.enabled === true]
  ));
  const decision = evaluateMbtPhase3Capability({
    capability: "masterData",
    environment: {
      enabled: config.mbt.enabled,
      masterDataEnabled: config.mbtPhase3.masterDataEnabled
    },
    databaseFlags,
    pilotAuthorized: actor?.roles?.some((role) => ["admin", "dispatcher"].includes(String(role).toLowerCase())) === true
  });
  if (!decision.enabled) {
    throw new MbtError({
      status: 409,
      code: String(decision.code || "MBT_CAPABILITY_DISABLED"),
      message: "MBT master data is disabled.",
      details: { capability: "master_data", reason: decision.reason }
    });
  }
}

/** @param {Record<string, unknown>} before @param {ReturnType<typeof normalizedCapability>} after */
function removesRequiredBinCapability(before, after) {
  if (before.truckType !== "bin") {return false;}
  if (after.truckType !== "bin") {return true;}
  if (Number(after.binSlotCapacity) < Number(before.binSlotCapacity || 0)) {return true;}
  if (String(after.baseYard) !== String(before.baseYard || "")) {return true;}
  const nextCodes = new Set(after.supportedBinTypeCodes);
  return /** @type {string[]} */ (before.supportedBinTypeCodes || [])
    .some((code) => !nextCodes.has(String(code)));
}

/** @param {string} id */
async function assertCapabilityNotInUse(id) {
  const plans = await query(
    `SELECT plan.id::text, snapshot.trucks
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
      WHERE plan.status IN ('draft', 'confirmed')
      ORDER BY plan.id
      FOR SHARE OF plan, snapshot`
  );
  const referenced = plans.rows.some((/** @type {Record<string, any>} */ row) => {
    const trucks = Array.isArray(row.trucks) ? row.trucks : [];
    return trucks.some((/** @type {Record<string, any>} */ truck) => {
      if (String(truck?.id ?? "") !== id) {return false;}
      return (Array.isArray(truck?.loads) ? truck.loads : []).some((/** @type {Record<string, any>} */ load) =>
        (Array.isArray(load?.stops) ? load.stops : []).some((/** @type {Record<string, any>} */ stop) =>
          Boolean(stop?.mbt?.visitId)
        )
      );
    });
  });
  if (referenced) {
    throw new MbtError({
      status: 409,
      code: "MBT_TRUCK_CAPABILITY_IN_USE",
      message: "This BIN truck capability is used by an active or future Dispatch leg."
    });
  }
  const reservation = await query(
    `SELECT 1
       FROM mbt_bin_asset_reservations reservation
       JOIN mbt_service_visits visit ON visit.service_visit_id = reservation.visit_id
      WHERE reservation.released_at IS NULL
        AND visit.planned_truck_id = $1
      LIMIT 1
      FOR SHARE OF reservation, visit`,
    [id]
  );
  if (reservation.rowCount) {
    throw new MbtError({
      status: 409,
      code: "MBT_TRUCK_CAPABILITY_IN_USE",
      message: "This BIN truck capability is required by an active asset reservation."
    });
  }
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.truckId
 * @param {number} input.expectedRevision
 * @param {unknown} input.capability
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function updateDispatchTruckCapabilities({
  actor,
  truckId: rawTruckId,
  expectedRevision: rawExpectedRevision,
  capability: rawCapability,
  reason,
  idempotencyKey,
  correlationId,
  requestId
}) {
  const id = truckId(rawTruckId);
  const revision = expectedRevision(rawExpectedRevision);
  const capability = normalizedCapability(rawCapability);
  const normalizedReason = requiredText(reason, "capability-change reason");
  await assertMasterDataCapability(actor);
  const payload = { truckId: id, expectedRevision: revision, capability, reason: normalizedReason };
  return executeMbtCommand({
    actor,
    commandName: "dispatch.truck.capabilities.update",
    idempotencyKey,
    payload,
    correlationId,
    requestId,
    mutation: async () => {
      const selected = await selectTruck(id, true);
      if (!selected) {
        throw new MbtError({
          status: 404,
          code: "DISPATCH_TRUCK_NOT_FOUND",
          message: "The Dispatch truck was not found."
        });
      }
      const before = publicTruck(selected);
      if (before.revision !== revision) {
        throw new MbtError({
          status: 409,
          code: "DISPATCH_TRUCK_STALE_REVISION",
          message: "This truck changed. Refresh it before saving again."
        });
      }
      if (removesRequiredBinCapability(before, capability)) {
        await assertCapabilityNotInUse(id);
      }
      const yard = capability.truckType === "bin"
        ? await query(
            `SELECT yard_id::text AS yard_id
               FROM mbt_yards
              WHERE yard_code = $1
                AND active
              FOR UPDATE`,
            [capability.baseYard]
          )
        : { rows: [{ yard_id: null }], rowCount: 1 };
      if (!yard.rowCount) {
        throw new MbtError({
          status: 400,
          code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
          message: "The selected shared base yard is unavailable."
        });
      }
      const binTypes = capability.supportedBinTypeCodes.length
        ? await query(
            `SELECT bin_type_id::text AS bin_type_id, type_code
               FROM mbt_bin_types
              WHERE type_code = ANY($1::text[])
                AND active
              ORDER BY type_code
              FOR UPDATE`,
            [capability.supportedBinTypeCodes]
          )
        : { rows: [], rowCount: 0 };
      if (binTypes.rowCount !== capability.supportedBinTypeCodes.length) {
        throw new MbtError({
          status: 400,
          code: "DISPATCH_TRUCK_CAPABILITY_INVALID",
          message: "A selected BIN size is unavailable."
        });
      }
      const nextRevision = before.revision + 1;
      await query(
        `UPDATE dispatch_trucks
            SET capacity_lbs = $2,
                travel_time_percent = $3,
                base_yard = $4,
                truck_type = $5,
                bin_service_enabled = ($5 = 'bin'),
                bin_slot_capacity = $6,
                base_yard_id = $7,
                revision = $8,
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          capability.capacityLbs,
          capability.travelTimePercent,
          capability.baseYard,
          capability.truckType,
          capability.binSlotCapacity,
          yard.rows[0].yard_id,
          nextRevision
        ]
      );
      await query(
        `UPDATE dispatch_truck_bin_types
            SET active = false,
                updated_at = now()
          WHERE truck_id = $1
            AND active`,
        [id]
      );
      for (const binType of binTypes.rows) {
        await query(
          `INSERT INTO dispatch_truck_bin_types (
             truck_id, bin_type_id, active, created_by, created_at, updated_at
           ) VALUES ($1, $2, true, $3, now(), now())
           ON CONFLICT (truck_id, bin_type_id) DO UPDATE
             SET active = true,
                 updated_at = now()`,
          [id, binType.bin_type_id, actor.operatorId]
        );
      }
      const after = publicTruck(await selectTruck(id));
      await query(
        `INSERT INTO dispatch_truck_capability_history (
           capability_history_id, truck_id, revision, capability_snapshot,
           actor_operator_id, reason, idempotency_key
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          id,
          after.revision,
          JSON.stringify(after),
          actor.operatorId,
          normalizedReason,
          idempotencyKey
        ]
      );
      return {
        status: 200,
        body: { truck: after },
        audit: {
          action: "dispatch.truck.capabilities.updated",
          entityType: "dispatch_truck",
          entityId: id,
          beforeState: before,
          afterState: after,
          reason: normalizedReason,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          source: "dispatch-setup"
        }
      };
    }
  });
}
