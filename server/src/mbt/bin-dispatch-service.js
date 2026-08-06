// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { confirmValidatedBinDispatchPlan } from "../dispatch-plan-repository.js";
import { reserveAsset, releaseAssetReservation } from "./asset-service.js";
import { canonicalSha256 } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { binDispatchOrders } from "./dispatch-bin-safety.js";
import { MbtError } from "./errors.js";

const TERMINAL_VISIT_STATUSES = new Set(["completed", "cancelled"]);
const STARTED_VISIT_STATUSES = new Set(["in_progress", "evidence_pending"]);
const BIN_COMMAND_SOURCE = "mbt-bin-dispatch";
const ambientDatabase = /** @type {any} */ ({ query, ambientTransaction: true });

/** @param {Parameters<typeof executeMbtCommand>[0]} command */
async function executeBinCommand(command) {
  try {
    return await executeMbtCommand(command);
  } catch (error) {
    if (error instanceof MbtError && error.code === "MBT_IDEMPOTENCY_CONFLICT") {
      throw new MbtError({
        status: 409,
        code: "MBT_IDEMPOTENCY_PAYLOAD_CONFLICT",
        message: error.message,
        details: error.details,
        cause: error
      });
    }
    throw error;
  }
}

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function mbtError(status, code, message, details = {}) {
  return new MbtError({ status, code, message, details });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw mbtError(400, "MBT_BIN_DISPATCH_INPUT_INVALID", `A ${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function positiveRevision(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw mbtError(400, "MBT_BIN_DISPATCH_INPUT_INVALID", `A positive ${label} is required.`);
  }
  return Number(value);
}

/** @param {unknown} value */
function normalizedReason(value) {
  const reason = String(value ?? "").trim();
  if (!reason) {
    throw mbtError(400, "MBT_AUDIT_REASON_REQUIRED", "An audit reason is required.");
  }
  return reason;
}

/** @param {unknown} value @param {number} [fallback] */
function positiveLimit(value, fallback = 100) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

/** @param {unknown} capability */
function assertCapability(capability) {
  const value = capability && typeof capability === "object"
    ? /** @type {Record<string, unknown>} */ (capability)
    : {};
  if (value.environmentEnabled !== true
      || value.databaseEnabled !== true
      || value.pilotAuthorized !== true) {
    throw mbtError(
      409,
      "MBT_CAPABILITY_DISABLED",
      "MBT BIN Dispatch is disabled.",
      { capability: "bin_dispatch" }
    );
  }
}

/** @param {unknown} actor */
function assertDispatcherActor(actor) {
  const value = actor && typeof actor === "object"
    ? /** @type {{operatorId?: unknown, roles?: unknown}} */ (actor)
    : {};
  requiredText(value.operatorId, "command actor");
  const roles = Array.isArray(value.roles)
    ? value.roles.map((role) => String(role).toLowerCase())
    : [];
  if (!roles.some((role) => role === "admin" || role === "dispatcher")) {
    throw mbtError(403, "MBT_FORBIDDEN", "Dispatcher or Admin access is required.");
  }
}

/** @param {unknown} value */
function isoTimestamp(value) {
  if (value instanceof Date) {return value.toISOString();}
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** @param {unknown} value */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {Array<Record<string, any>>} visits */
function timelineFor(visits) {
  const currentIndex = visits.findIndex((visit) => !TERMINAL_VISIT_STATUSES.has(String(visit.status)));
  return visits.map((visit, index) => {
    let relation = "completed";
    if (currentIndex >= 0 && index === currentIndex) {relation = "current";}
    if (currentIndex >= 0 && index > currentIndex) {relation = "future";}
    if (currentIndex < 0 && !TERMINAL_VISIT_STATUSES.has(String(visit.status))) {relation = "current";}
    return {
      visitId: String(visit.service_visit_id),
      serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
      visitNumber: Number(visit.visit_number),
      serviceAction: String(visit.service_action),
      status: String(visit.status),
      relation,
      locked: relation !== "current" || String(visit.status) !== "ready"
    };
  });
}

/**
 * A contract can contain several physical bins. Each bin has its own linear
 * visit chain, so "current" and "future" must be derived per service line.
 * Legacy rows without a service-line identity remain one contract chain.
 * @param {Array<Record<string, any>>} visits
 */
function contractTimelineFor(visits) {
  const groups = new Map();
  for (const visit of visits) {
    const key = visit.service_line_id
      ? String(visit.service_line_id)
      : `legacy:${String(visit.contract_id || "")}`;
    const group = groups.get(key) || [];
    group.push(visit);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => timelineFor(group));
}

/**
 * @param {string} contractId
 * @param {{serviceLineId?: string | null, forUpdate?: boolean}} [options]
 */
async function selectContractVisits(contractId, { serviceLineId = null, forUpdate = false } = {}) {
  const result = await query(
    `SELECT service_visit_id::text, contract_id::text, service_line_id::text,
            predecessor_visit_id::text,
            visit_number::int, visit_reference, service_action, status,
            revision::int, scheduled_start_at, scheduled_end_at,
            actual_started_at, actual_completed_at,
            dispatch_plan_id, dispatch_plan_revision::int, dispatch_load_id,
            dispatch_assignment_snapshot,
            service_template_version_id::text, bin_type_id::text,
            expected_asset_id::text, outgoing_asset_id::text,
            incoming_asset_id::text, dump_site_id::text, material_id::text,
            customer_site_profile_id::text, customer_snapshot, site_snapshot,
            service_snapshot
       FROM mbt_service_visits
      WHERE contract_id = $1
        AND ($2::uuid IS NULL OR service_line_id = $2::uuid)
      ORDER BY visit_number, service_visit_id
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [contractId, serviceLineId]
  );
  return /** @type {Array<Record<string, any>>} */ (result.rows);
}

/** @param {Record<string, any>} visit @param {boolean} [forUpdate] */
async function stopsForVisit(visit, forUpdate = false) {
  const snapshot = objectValue(visit.service_snapshot);
  const mandatory = arrayValue(snapshot.mandatoryStops)
    .map((stop) => objectValue(stop))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  const evidence = await query(
    `SELECT step.action_code, requirement.evidence_code, requirement.evidence_type,
            requirement.minimum_count::int
       FROM mbt_visit_steps step
       JOIN mbt_visit_evidence_requirements requirement
         ON requirement.visit_step_id = step.visit_step_id
      WHERE step.service_visit_id = $1
        AND requirement.required
      ORDER BY step.sequence_number, requirement.evidence_code
      ${forUpdate ? "FOR UPDATE OF step, requirement" : ""}`,
    [visit.service_visit_id]
  );
  const byAction = new Map();
  for (const row of evidence.rows) {
    const key = String(row.action_code);
    const list = byAction.get(key) || [];
    list.push({
      code: String(row.evidence_code),
      type: String(row.evidence_type),
      minimumCount: Number(row.minimum_count)
    });
    byAction.set(key, list);
  }
  return mandatory.map((stop) => ({
    id: String(stop.stopId),
    sequence: Number(stop.sequence),
    type: String(stop.stopKind),
    actionCode: String(stop.actionCode),
    locationRole: String(stop.locationRole),
    yardId: stop.yardId ? String(stop.yardId) : null,
    yardCode: stop.yardCode ? String(stop.yardCode) : null,
    siteProfileId: stop.siteProfileId ? String(stop.siteProfileId) : null,
    evidenceRequirements: byAction.get(String(stop.actionCode)) || []
  }));
}

/** @param {Record<string, any>} visit @param {boolean} [forUpdate] */
async function templateForVisit(visit, forUpdate = false) {
  const selected = await query(
    `SELECT template_version_id::text, revision::int, required_bin_service,
            dump_site_required
       FROM mbt_service_template_versions
      WHERE template_version_id = $1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [visit.service_template_version_id]
  );
  if (selected.rowCount !== 1 || selected.rows[0].required_bin_service !== true) {
    throw confirmationInvalid("visit_template_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  return /** @type {Record<string, any>} */ (selected.rows[0]);
}

/** @param {Record<string, any>} visit */
function exactVisitAssetRequirements(visit) {
  const outgoingAssetId = String(visit.expected_asset_id || visit.outgoing_asset_id || "");
  const incomingAssetId = String(visit.incoming_asset_id || "");
  const requirements = outgoingAssetId
    ? [{ reservationSlot: "outgoing", assetId: outgoingAssetId }]
    : [];
  if (incomingAssetId && incomingAssetId !== outgoingAssetId) {
    requirements.push({ reservationSlot: "incoming", assetId: incomingAssetId });
  }
  return requirements;
}

/** @param {Record<string, any>} visit */
async function eligibleDeliveryAssets(visit) {
  if (String(visit.service_action) !== "delivery" || exactVisitAssetRequirements(visit).length) {
    return [];
  }
  const yardId = requiredYardFromVisit(visit);
  if (!yardId) {return [];}
  const result = await query(
    `SELECT asset.asset_id::text, asset.asset_code,
            state.revision::int AS state_revision
       FROM mbt_bin_assets asset
       JOIN mbt_bin_asset_state state ON state.asset_id = asset.asset_id
      WHERE asset.bin_type_id = $1
        AND asset.active
        AND NOT asset.under_maintenance
        AND state.lifecycle_status = 'available'
        AND state.location_kind = 'yard'
        AND state.yard_id = $2
        AND NOT EXISTS (
          SELECT 1
            FROM mbt_bin_asset_reservations reservation
           WHERE reservation.asset_id = asset.asset_id
             AND reservation.released_at IS NULL
        )
      ORDER BY lower(asset.asset_code), asset.asset_code, asset.asset_id
      LIMIT 100`,
    [visit.bin_type_id, yardId]
  );
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    assetId: String(row.asset_id),
    assetCode: String(row.asset_code),
    stateRevision: Number(row.state_revision)
  }));
}

/** @param {Record<string, any>} visit @param {Array<Record<string, any>>} timelineVisits */
// Projection keeps every field in one server-owned snapshot boundary.
// eslint-disable-next-line complexity
async function projectFrontLeg(visit, timelineVisits) {
  const exactAssets = exactVisitAssetRequirements(visit);
  const [contract, binType, template, asset, stops, eligibleAssets] = await Promise.all([
    query(
      `SELECT contract_number, customer_snapshot, site_snapshot
         FROM mbt_contracts WHERE contract_id = $1`,
      [visit.contract_id]
    ),
    query(
      `SELECT type_code FROM mbt_bin_types WHERE bin_type_id = $1`,
      [visit.bin_type_id]
    ),
    query(
      `SELECT revision::int FROM mbt_service_template_versions
        WHERE template_version_id = $1`,
      [visit.service_template_version_id]
    ),
    query(
      `SELECT asset.asset_id::text, asset.asset_code,
              state.revision::int AS state_revision
         FROM mbt_bin_assets asset
         JOIN mbt_bin_asset_state state ON state.asset_id = asset.asset_id
        WHERE asset.asset_id = ANY($1::uuid[])
        ORDER BY asset.asset_id`,
      [exactAssets.map((entry) => entry.assetId)]
    ),
    stopsForVisit(visit),
    eligibleDeliveryAssets(visit)
  ]);
  if (
    !contract.rowCount
    || !binType.rowCount
    || !template.rowCount
    || asset.rowCount !== exactAssets.length
    || (!exactAssets.length && !eligibleAssets.length)
  ) {
    throw mbtError(409, "MBT_BIN_FRONT_LEG_INCOMPLETE", "The BIN front leg is missing required dispatch data.");
  }
  const contractRow = contract.rows[0];
  const customerSnapshot = objectValue(visit.customer_snapshot || contractRow.customer_snapshot);
  const siteSnapshot = objectValue(visit.site_snapshot || contractRow.site_snapshot);
  const customer = String(customerSnapshot.displayName || customerSnapshot.companyName || "BIN customer");
  const address = [siteSnapshot.addressLine1, siteSnapshot.city, siteSnapshot.region]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ") || "Service site";
  const yardIds = [...new Set(stops.map((stop) => stop.yardId).filter(Boolean))];
  const yards = yardIds.length
    ? await query(
        `SELECT yard_id::text, yard_code, dispatch_location_id::int
           FROM mbt_yards
          WHERE yard_id = ANY($1::uuid[])
            AND active
          ORDER BY yard_code`,
        [yardIds]
      )
    : { rows: [] };
  const rolesByYard = new Map();
  for (const stop of stops) {
    if (!stop.yardId) {continue;}
    const role = String(stop.locationRole).includes("return") ? "return"
      : String(stop.locationRole).includes("origin") ? "origin"
        : "service";
    if (!rolesByYard.has(stop.yardId)) {rolesByYard.set(stop.yardId, role);}
  }
  const assetsById = new Map(asset.rows.map(
    (/** @type {Record<string, any>} */ row) => [String(row.asset_id), row]
  ));
  return {
    id: String(visit.visit_reference),
    type: "BIN",
    serviceAction: String(visit.service_action),
    customer,
    address,
    scheduledWindow: {
      startAt: isoTimestamp(visit.scheduled_start_at),
      endAt: isoTimestamp(visit.scheduled_end_at)
    },
    stops,
    mbt: {
      snapshotVersion: 1,
      contractId: String(visit.contract_id),
      serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
      contractNumber: String(contractRow.contract_number),
      visitId: String(visit.service_visit_id),
      visitReference: String(visit.visit_reference),
      visitNumber: Number(visit.visit_number),
      visitRevision: Number(visit.revision),
      status: "ready",
      frontLeg: {
        predecessorVisitId: visit.predecessor_visit_id ? String(visit.predecessor_visit_id) : null,
        predecessorTerminal: true,
        dispatchable: true
      },
      templateVersionId: String(visit.service_template_version_id),
      templateRevision: Number(template.rows[0].revision),
      binTypeId: String(visit.bin_type_id),
      binTypeCode: String(binType.rows[0].type_code),
      assetRequirements: exactAssets.map((entry) => ({
        reservationSlot: entry.reservationSlot,
        exactAssetId: entry.assetId,
        exactAssetCode: String(assetsById.get(entry.assetId)?.asset_code || ""),
        expectedStateRevision: Number(assetsById.get(entry.assetId)?.state_revision)
      })),
      ...(!exactAssets.length ? {
        assetChoices: [{ reservationSlot: "outgoing", eligibleAssets }]
      } : {}),
      truckRequirements: {
        truckType: "bin",
        minimumSlots: 1,
        supportedBinTypeCode: String(binType.rows[0].type_code)
      },
      sharedYards: yards.rows.map((/** @type {Record<string, any>} */ yard) => ({
        role: rolesByYard.get(String(yard.yard_id)) || "service",
        yardId: String(yard.yard_id),
        yardCode: String(yard.yard_code),
        dispatchLocationId: Number(yard.dispatch_location_id)
      })),
      timeline: timelineFor(timelineVisits)
    }
  };
}

/**
 * Return only the server-derived current, ready, unassigned visit for the
 * selected date. Future visits remain represented solely in the timeline.
 * @param {{planDate: unknown, search?: unknown, limit?: unknown}} input
 * @param {{capability: unknown}} boundary
 */
export async function listMbtBinFrontLegs(input, { capability }) {
  assertCapability(capability);
  const planDate = requiredText(input?.planDate, "plan date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
    throw mbtError(400, "MBT_BIN_DISPATCH_INPUT_INVALID", "The plan date is invalid.");
  }
  const candidates = await query(
    `SELECT visit.service_visit_id::text, visit.contract_id::text,
            visit.service_line_id::text
       FROM mbt_service_visits visit
       LEFT JOIN mbt_service_visits predecessor
         ON predecessor.service_visit_id = visit.predecessor_visit_id
      WHERE visit.status = 'ready'
        AND visit.scheduled_start_at::date = $1::date
        AND visit.dispatch_plan_id IS NULL
        AND (
          visit.predecessor_visit_id IS NULL
          OR predecessor.status IN ('completed', 'cancelled')
        )
      ORDER BY visit.scheduled_start_at, visit.visit_number, visit.service_visit_id
      LIMIT $2`,
    [planDate, positiveLimit(input?.limit)]
  );
  const search = String(input?.search ?? "").trim().toLowerCase();
  const items = [];
  for (const candidate of candidates.rows) {
    const visits = await selectContractVisits(String(candidate.contract_id), {
      serviceLineId: candidate.service_line_id
    });
    const current = visits.find((visit) => String(visit.service_visit_id) === String(candidate.service_visit_id));
    if (!current) {continue;}
    const card = await projectFrontLeg(current, visits);
    const searchable = [
      card.mbt.contractNumber,
      card.customer,
      card.address,
      card.serviceAction,
      card.mbt.visitReference,
      ...card.stops.map((stop) => stop.actionCode),
      ...card.mbt.assetRequirements.map((assetRequirement) => assetRequirement.exactAssetCode),
      ...arrayValue(card.mbt.assetChoices)
        .flatMap((choice) => arrayValue(objectValue(choice).eligibleAssets))
        .map((assetChoice) => String(objectValue(assetChoice).assetCode || ""))
    ].join(" ").toLowerCase();
    if (!search || searchable.includes(search)) {items.push(card);}
  }
  return { schemaVersion: "mbt-bin-dispatch-feed-v1", planDate, items };
}

/** @param {{contractId: unknown}} input @param {{capability: unknown}} boundary */
export async function getMbtBinContractTimeline(input, { capability }) {
  assertCapability(capability);
  const contractId = requiredText(input?.contractId, "contract ID");
  const visits = await selectContractVisits(contractId);
  if (visits.length === 0) {
    throw mbtError(404, "MBT_BIN_CONTRACT_NOT_FOUND", "The BIN contract was not found.");
  }
  return {
    schemaVersion: "mbt-bin-contract-timeline-v1",
    contractId,
    items: contractTimelineFor(visits)
  };
}

/** @param {unknown} value */
function clonePlanJson(value) {
  return structuredClone(Array.isArray(value) ? value : []);
}

/** @param {Array<Record<string, any>>} trucks @param {string} loadId */
function locateLoad(trucks, loadId) {
  for (const truck of trucks) {
    const loads = Array.isArray(truck.loads) ? truck.loads : [];
    const load = loads.find((candidate) => String(candidate?.id) === loadId);
    if (load) {return { truck, load };}
  }
  return null;
}

/** @param {{truck: Record<string, any>, load: Record<string, any>}} located */
function requiredLoadDriverId(located) {
  const driverId = String(located.load.driverId || located.truck.driverId || "").trim();
  if (!driverId) {
    throw mbtError(
      409,
      "MBT_BIN_DRIVER_REQUIRED",
      "Assign a driver to the target load before adding a BIN service leg."
    );
  }
  return driverId;
}

/** @param {string} planId */
async function lockPlan(planId) {
  const result = await query(
    `SELECT plan.id::text, plan.plan_date::text, plan.status,
            plan.revision::int, snapshot.trucks
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
      WHERE plan.id = $1
      FOR UPDATE OF plan, snapshot`,
    [planId]
  );
  if (!result.rowCount) {
    throw mbtError(404, "MBT_BIN_DISPATCH_PLAN_NOT_FOUND", "The Dispatch plan was not found.");
  }
  return /** @type {Record<string, any>} */ (result.rows[0]);
}

/** @param {string} truckId @param {Record<string, any>} projectedTruck @param {string} requiredBinTypeCode @param {string | null} requiredYardId */
async function assertBinTruck(truckId, projectedTruck, requiredBinTypeCode, requiredYardId) {
  const locked = await query(
    `SELECT id::text
       FROM dispatch_trucks
      WHERE id = $1
      FOR UPDATE`,
    [truckId]
  );
  if (!locked.rowCount) {
    throw mbtError(409, "MBT_BIN_TRUCK_REQUIRED", "This leg requires a compatible BIN truck.");
  }
  const result = await query(
    `SELECT truck.id::text, truck.truck_type, truck.bin_service_enabled,
            truck.bin_slot_capacity::int, truck.base_yard_id::text,
            COALESCE(array_agg(bin_type.type_code ORDER BY bin_type.type_code)
              FILTER (WHERE capability.active), ARRAY[]::text[]) AS supported_codes
       FROM dispatch_trucks truck
       LEFT JOIN dispatch_truck_bin_types capability ON capability.truck_id = truck.id
       LEFT JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = capability.bin_type_id
      WHERE truck.id = $1
      GROUP BY truck.id`,
    [truckId]
  );
  const row = result.rows[0];
  const projectedCodes = arrayValue(projectedTruck.supportedBinTypeCodes).map(String);
  if (!row
      || String(row.truck_type) !== "bin"
      || row.bin_service_enabled !== true
      || Number(row.bin_slot_capacity) < 1
      || String(projectedTruck.truckType).toLowerCase() !== "bin"
      || Number(projectedTruck.binSlotCapacity) < 1
      || !arrayValue(row.supported_codes).map(String).includes(requiredBinTypeCode)
      || !projectedCodes.includes(requiredBinTypeCode)
      || (requiredYardId && String(row.base_yard_id) !== requiredYardId)) {
    throw mbtError(409, "MBT_BIN_TRUCK_REQUIRED", "This leg requires a compatible BIN truck.");
  }
  return row;
}

/** @param {Record<string, any>} visit @param {Record<string, any>} truckCapability @param {boolean} [forUpdate] */
async function materializedStops(visit, truckCapability, forUpdate = false) {
  const stops = await stopsForVisit(visit, forUpdate);
  const names = await query(
    `SELECT action_code, display_name
       FROM mbt_visit_steps
      WHERE service_visit_id = $1
      ORDER BY sequence_number
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [visit.service_visit_id]
  );
  const displayNames = new Map(names.rows.map(
    (/** @type {Record<string, unknown>} */ row) => [String(row.action_code), String(row.display_name)]
  ));
  return stops.map((stop) => ({
    ...stop,
    displayName: displayNames.get(stop.actionCode) || stop.actionCode.replaceAll("_", " "),
    mbt: {
      visitId: String(visit.service_visit_id),
      serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
      stopGroupId: String(visit.service_visit_id),
      stopSequence: stop.sequence,
      mandatory: true,
      capabilitySnapshot: {
        truckType: "bin",
        binTypeCode: String(truckCapability.binTypeCode),
        baseYardId: String(truckCapability.baseYardId),
        baseYardCode: String(truckCapability.baseYardCode)
      }
    }
  }));
}

/** @param {Array<Record<string, any>>} trucks @param {string} visitId */
function assignedStops(trucks, visitId) {
  const found = [];
  for (const truck of trucks) {
    for (const load of arrayValue(truck.loads)) {
      for (const stop of arrayValue(objectValue(load).stops)) {
        if (String(objectValue(objectValue(stop).mbt).visitId || "") === visitId) {
          found.push({ truck, load, stop });
        }
      }
    }
  }
  return found;
}

/** @param {Array<Record<string, any>>} trucks @param {string} visitId */
function removeAssignedStops(trucks, visitId) {
  for (const truck of trucks) {
    for (const rawLoad of arrayValue(truck.loads)) {
      const load = objectValue(rawLoad);
      load.stops = arrayValue(load.stops).filter(
        (stop) => String(objectValue(objectValue(stop).mbt).visitId || "") !== visitId
      );
    }
  }
}

/** @param {string} binTypeId */
async function binTypeCode(binTypeId) {
  const result = await query("SELECT type_code FROM mbt_bin_types WHERE bin_type_id = $1", [binTypeId]);
  if (!result.rowCount) {
    throw mbtError(409, "MBT_BIN_FRONT_LEG_INCOMPLETE", "The BIN type is unavailable.");
  }
  return String(result.rows[0].type_code);
}

/** @param {Record<string, any>} visit */
function requiredYardFromVisit(visit) {
  const stops = arrayValue(objectValue(visit.service_snapshot).mandatoryStops).map(objectValue);
  const stop = stops.find((candidate) => candidate.yardId);
  return stop ? String(stop.yardId) : null;
}

/** @param {string | null} yardId @param {boolean} [forUpdate] */
async function yardIdentity(yardId, forUpdate = false) {
  if (!yardId) {return { yardId: "", yardCode: "" };}
  const result = await query(
    `SELECT yard_id::text, yard_code FROM mbt_yards
      WHERE yard_id = $1 AND active
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [yardId]
  );
  if (!result.rowCount) {
    throw mbtError(409, "MBT_BIN_FRONT_LEG_INCOMPLETE", "The shared yard is unavailable.");
  }
  return { yardId: String(result.rows[0].yard_id), yardCode: String(result.rows[0].yard_code) };
}

/** @param {string} visitId */
async function lockVisit(visitId) {
  const result = await query(
    `SELECT service_visit_id::text, contract_id::text, service_line_id::text,
            predecessor_visit_id::text,
            visit_number::int, visit_reference, service_action, status,
            revision::int, scheduled_start_at, scheduled_end_at,
            actual_started_at, actual_completed_at,
            dispatch_plan_id, dispatch_plan_revision::int, dispatch_load_id,
            dispatch_assignment_snapshot, service_template_version_id::text,
            bin_type_id::text, expected_asset_id::text, outgoing_asset_id::text,
            incoming_asset_id::text, dump_site_id::text, material_id::text,
            customer_site_profile_id::text, customer_snapshot, site_snapshot,
            service_snapshot
       FROM mbt_service_visits
      WHERE service_visit_id = $1
      FOR UPDATE`,
    [visitId]
  );
  if (!result.rowCount) {
    throw mbtError(404, "MBT_BIN_VISIT_NOT_FOUND", "The BIN service visit was not found.");
  }
  return /** @type {Record<string, any>} */ (result.rows[0]);
}

/** @param {Record<string, any>} visit @param {Array<Record<string, any>>} assignments */
async function assertExactAssetAssignments(visit, assignments) {
  const exact = exactVisitAssetRequirements(visit);
  if (assignments.length !== exact.length) {
    throw mbtError(409, "MBT_BIN_ASSET_MISMATCH", "The exact BIN asset assignment is required.");
  }
  const normalized = assignments.map(objectValue);
  const identities = normalized.map((assignment) =>
    `${String(assignment.reservationSlot || "")}:${String(assignment.assetId || "")}`
  );
  if (new Set(identities).size !== identities.length) {
    throw mbtError(409, "MBT_BIN_ASSET_MISMATCH", "The selected asset does not match the current BIN leg snapshot.");
  }
  const state = await query(
    `SELECT asset_id::text, revision::int
       FROM mbt_bin_asset_state
      WHERE asset_id = ANY($1::uuid[])
      ORDER BY asset_id
      FOR UPDATE`,
    [exact.map((entry) => entry.assetId)]
  );
  const revisions = new Map(state.rows.map(
    (/** @type {Record<string, any>} */ row) => [String(row.asset_id), Number(row.revision)]
  ));
  const matches = exact.every((required) => normalized.some((assignment) =>
    String(assignment.assetId || "") === required.assetId
    && String(assignment.reservationSlot || "") === required.reservationSlot
    && Number(assignment.expectedStateRevision) === revisions.get(required.assetId)
  ));
  if (!matches || revisions.size !== exact.length) {
    throw mbtError(409, "MBT_BIN_ASSET_MISMATCH", "The selected asset does not match the current BIN leg snapshot.");
  }
  return exact;
}

/** @param {unknown} snapshot @param {string} assetId */
function snapshotWithAsset(snapshot, assetId) {
  const next = structuredClone(objectValue(snapshot));
  next.mandatoryStops = arrayValue(next.mandatoryStops).map((rawStop) => ({
    ...objectValue(rawStop),
    assetId
  }));
  return next;
}

/** @param {Record<string, any>} visit @param {Array<Record<string, any>>} assignments */
function selectedUnboundAssignment(visit, assignments) {
  const normalized = assignments.map(objectValue);
  const selected = normalized[0] || {};
  const expectedStateRevision = Number(selected.expectedStateRevision);
  if (normalized.length !== 1
      || String(visit.service_action) !== "delivery"
      || String(selected.reservationSlot || "") !== "outgoing"
      || !String(selected.assetId || "")
      || !Number.isSafeInteger(expectedStateRevision)
      || expectedStateRevision < 1) {
    throw mbtError(409, "MBT_BIN_ASSET_MISMATCH", "The selected asset does not match the current BIN leg snapshot.");
  }
  return { assetId: String(selected.assetId), expectedStateRevision };
}

/** @param {Record<string, any>} asset @param {Record<string, any>} visit @param {string} yardId @param {number} revision */
function isEligibleSelectedAsset(asset, visit, yardId, revision) {
  return Boolean(asset)
    && String(asset.bin_type_id) === String(visit.bin_type_id)
    && asset.active === true
    && asset.under_maintenance !== true
    && String(asset.lifecycle_status) === "available"
    && String(asset.location_kind) === "yard"
    && String(asset.yard_id || "") === yardId
    && Number(asset.state_revision) === revision;
}

/** @param {Record<string, any>} dependent @param {Record<string, any>} delivery @param {number} revision */
function isUnchangedDependentReturn(dependent, delivery, revision) {
  return String(dependent.contract_id) === String(delivery.contract_id)
    && String(dependent.predecessor_visit_id || "") === String(delivery.service_visit_id)
    && String(dependent.service_action) === "return_bin"
    && String(dependent.status) === "tentative"
    && Number(dependent.revision) === revision
    && !dependent.dispatch_plan_id
    && !dependent.actual_started_at
    && !dependent.actual_completed_at
    && !dependent.expected_asset_id
    && !dependent.outgoing_asset_id
    && !dependent.incoming_asset_id;
}

/**
 * Bind an eligible exact asset at the dispatch decision point. Both the
 * delivery and its still-tentative dependent return are locked and updated in
 * the same command transaction before the reservation is created.
 * @param {Record<string, any>} visit
 * @param {Array<Record<string, any>>} assignments
 * @param {string} actorId
 */
async function bindUnboundDeliveryAsset(visit, assignments, actorId) {
  const selected = selectedUnboundAssignment(visit, assignments);
  const assetId = selected.assetId;
  const requiredYardId = requiredYardFromVisit(visit);
  if (!requiredYardId) {
    throw mbtError(409, "MBT_BIN_FRONT_LEG_INCOMPLETE", "The BIN delivery origin yard is unavailable.");
  }
  const asset = await query(
    `SELECT asset.asset_id::text, asset.bin_type_id::text, asset.active,
            asset.under_maintenance, state.lifecycle_status,
            state.location_kind, state.yard_id::text,
            state.revision::int AS state_revision
       FROM mbt_bin_assets asset
       JOIN mbt_bin_asset_state state ON state.asset_id = asset.asset_id
      WHERE asset.asset_id = $1
      FOR UPDATE OF asset, state`,
    [assetId]
  );
  const current = asset.rows[0];
  if (!isEligibleSelectedAsset(current, visit, requiredYardId, selected.expectedStateRevision)) {
    throw mbtError(409, "MBT_BIN_ASSET_MISMATCH", "The selected asset is no longer eligible for this BIN leg.");
  }
  const reservation = await query(
    `SELECT reservation_id
       FROM mbt_bin_asset_reservations
      WHERE asset_id = $1 AND released_at IS NULL
      LIMIT 1`,
    [assetId]
  );
  if (reservation.rowCount) {
    throw mbtError(409, "MBT_BIN_ASSET_MISMATCH", "The selected asset is no longer eligible for this BIN leg.");
  }

  const deliverySnapshot = objectValue(visit.service_snapshot);
  const dependentVisitId = String(deliverySnapshot.dependentReturnVisitId || "");
  const expectedDependentRevision = Number(deliverySnapshot.dependentReturnVisitRevision);
  if (!dependentVisitId || !Number.isSafeInteger(expectedDependentRevision) || expectedDependentRevision < 1) {
    throw mbtError(409, "MBT_BIN_DEPENDENT_VISIT_CHANGED", "The dependent BIN return leg is unavailable. Refresh before assigning.");
  }
  const dependent = await lockVisit(dependentVisitId);
  if (!isUnchangedDependentReturn(dependent, visit, expectedDependentRevision)) {
    throw mbtError(409, "MBT_BIN_DEPENDENT_VISIT_CHANGED", "The dependent BIN return leg changed. Refresh before assigning.");
  }

  const nextDependentRevision = Number(dependent.revision) + 1;
  const nextDeliverySnapshot = {
    ...snapshotWithAsset(deliverySnapshot, assetId),
    dependentReturnVisitRevision: nextDependentRevision
  };
  const nextDependentSnapshot = snapshotWithAsset(dependent.service_snapshot, assetId);
  await query(
    `UPDATE mbt_service_visits
        SET expected_asset_id = $2, outgoing_asset_id = $2,
            service_snapshot = $3::jsonb, updated_by = $4,
            updated_at = now()
      WHERE service_visit_id = $1`,
    [visit.service_visit_id, assetId, JSON.stringify(nextDeliverySnapshot), actorId]
  );
  await query(
    `UPDATE mbt_visit_steps
        SET expected_asset_id = $2, updated_at = now()
      WHERE service_visit_id = $1`,
    [visit.service_visit_id, assetId]
  );
  await query(
    `UPDATE mbt_service_visits
        SET expected_asset_id = $2, service_snapshot = $3::jsonb,
            revision = $4, updated_by = $5, updated_at = now()
      WHERE service_visit_id = $1`,
    [dependentVisitId, assetId, JSON.stringify(nextDependentSnapshot), nextDependentRevision, actorId]
  );
  await query(
    `UPDATE mbt_visit_steps
        SET expected_asset_id = $2, updated_at = now()
      WHERE service_visit_id = $1`,
    [dependentVisitId, assetId]
  );

  visit.expected_asset_id = assetId;
  visit.outgoing_asset_id = assetId;
  visit.service_snapshot = nextDeliverySnapshot;
  return [{ reservationSlot: "outgoing", assetId }];
}

/** @param {Record<string, any>} visit @param {Array<Record<string, any>>} assignments @param {string} actorId */
async function exactOrSelectedAssetAssignments(visit, assignments, actorId) {
  return exactVisitAssetRequirements(visit).length
    ? assertExactAssetAssignments(visit, assignments)
    : bindUnboundDeliveryAsset(visit, assignments, actorId);
}

/** @param {Record<string, any>} visit @param {{reservationSlot: string}} assignment */
function allowedReservationStatuses(visit, assignment) {
  if (assignment.reservationSlot === "incoming") {
    return ["at_customer"];
  }
  const firstAction = String(
    arrayValue(objectValue(visit.service_snapshot).mandatoryStops)[0]?.actionCode || ""
  );
  if (["pickup_bin", "pickup_loaded_bin", "pickup_loaded"].includes(firstAction)) {
    return ["at_customer"];
  }
  return ["available"];
}

/**
 * A customer asset or either side of a distinct exchange must retain its real
 * location/status until the Driver performs the physical movement. The asset
 * service revalidates the exact visit slot and customer site before accepting
 * this hold; the historical one-outgoing delivery path remains unchanged.
 * @param {Record<string, any>} visit
 * @param {Array<Record<string, any>>} assignments
 * @param {{reservationSlot: string}} assignment
 */
function reservationMode(visit, assignments, assignment) {
  const customerLocated = allowedReservationStatuses(visit, assignment).includes("at_customer");
  return assignments.length > 1 || customerLocated ? "exact_hold" : "state_transition";
}

/** @param {string} planId @param {number} planRevision @param {Array<Record<string, any>>} trucks */
async function persistPlan(planId, planRevision, trucks) {
  await query(
    "UPDATE dispatch_plan_snapshots SET trucks = $2::jsonb, saved_at = now() WHERE plan_id = $1",
    [planId, JSON.stringify(trucks)]
  );
  await query(
    "UPDATE dispatch_plans SET revision = $2, updated_at = now() WHERE id = $1",
    [planId, planRevision]
  );
}

/**
 * @param {object} input
 * @param {string} input.visitId
 * @param {string} input.contractId
 * @param {string} input.planId
 * @param {"assigned" | "moved" | "recovered" | "advanced"} input.action
 * @param {Record<string, any> | null} input.priorAssignment
 * @param {Record<string, any> | null} input.assignment
 * @param {number} input.visitRevision
 * @param {number} input.planRevision
 * @param {string} input.actorOperatorId
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 */
async function insertAssignmentHistory(input) {
  await query(
    `INSERT INTO mbt_bin_dispatch_assignment_history (
       assignment_history_id, service_visit_id, contract_id, dispatch_plan_id,
       action, prior_assignment, assignment, visit_revision, plan_revision,
       actor_operator_id, reason, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)`,
    [
      crypto.randomUUID(), input.visitId, input.contractId, input.planId,
      input.action, input.priorAssignment ? JSON.stringify(input.priorAssignment) : null,
      input.assignment ? JSON.stringify(input.assignment) : null,
      input.visitRevision, input.planRevision, input.actorOperatorId,
      input.reason, input.idempotencyKey
    ]
  );
}

/** @param {string} reason @param {Record<string, unknown>} [details] */
function confirmationInvalid(reason, details = {}) {
  return mbtError(
    409,
    "MBT_BIN_CONFIRMATION_INVALID",
    "The persisted BIN assignment no longer matches its server-owned evidence.",
    { reason, ...details }
  );
}

/** @param {unknown} left @param {unknown} right */
function sameCanonicalValue(left, right) {
  return canonicalSha256(left) === canonicalSha256(right);
}

/** @param {Record<string, any>} plan */
// Exhaustive shape rejection is intentionally kept in one fail-closed predicate.
// eslint-disable-next-line complexity
function lockedPlanBinGroups(plan) {
  const groups = new Map();
  const projectedBinStops = new Set();
  for (const rawTruck of arrayValue(plan.trucks)) {
    const truck = objectValue(rawTruck);
    for (const rawLoad of arrayValue(truck.loads)) {
      const load = objectValue(rawLoad);
      for (const rawStop of arrayValue(load.stops)) {
        const stop = objectValue(rawStop);
        const marker = objectValue(stop.mbt);
        if (!Object.keys(marker).length) {continue;}
        projectedBinStops.add(stop);
        const visitId = String(marker.visitId || "");
        if (!visitId) {throw confirmationInvalid("bin_stop_visit_missing");}
        const existing = groups.get(visitId);
        if (existing
            && (String(existing.load.id || "") !== String(load.id || "")
              || String(existing.truck.id || "") !== String(truck.id || ""))) {
          throw confirmationInvalid("mandatory_group_split", { visitId });
        }
        const group = existing || { visitId, truck, load, stops: [] };
        group.stops.push(stop);
        groups.set(visitId, group);
      }
    }
  }
  const detected = binDispatchOrders(plan);
  if (!detected.length || !groups.size) {
    throw confirmationInvalid("bin_assignment_missing");
  }
  if (detected.some((candidate) => !projectedBinStops.has(candidate))) {
    throw confirmationInvalid("unsupported_bin_snapshot_shape");
  }
  return groups;
}

/** @param {Record<string, any>} visit @param {Record<string, any>} group @param {Record<string, any>} plan */
// Every stored assignment identity is checked together so omissions fail closed.
// eslint-disable-next-line complexity
function assertLockedVisitProjection(visit, group, plan) {
  const assignment = objectValue(visit.dispatch_assignment_snapshot);
  const latestAssignmentRevision = String(plan.status) === "confirmed"
    ? Number(plan.revision) - 1
    : Number(plan.revision);
  const assignmentPlanRevision = Number(assignment.planRevision);
  const groupStops = /** @type {Array<Record<string, any>>} */ (arrayValue(group.stops));
  const markerIdentityMatches = groupStops.every((stop, index) => {
    const marker = objectValue(stop.mbt);
    return String(marker.visitId || "") === String(visit.service_visit_id)
      && String(marker.stopGroupId || "") === String(visit.service_visit_id)
      && marker.mandatory === true
      && Number(marker.stopSequence) === index + 1;
  });
  if (String(visit.status) !== "planned"
      || String(visit.dispatch_plan_id || "") !== String(plan.id)
      || String(assignment.planId || "") !== String(plan.id)
      || String(assignment.planDate || "") !== String(plan.planDate)
      || !Number.isSafeInteger(assignmentPlanRevision)
      || assignmentPlanRevision < 1
      || assignmentPlanRevision > latestAssignmentRevision
      || Number(visit.dispatch_plan_revision) !== assignmentPlanRevision
      || String(visit.dispatch_load_id || "") !== String(group.load.id || "")
      || Number(assignment.visitRevision) !== Number(visit.revision)
      || String(assignment.loadId || "") !== String(group.load.id || "")
      || String(assignment.predecessorVisitId || "") !== String(visit.predecessor_visit_id || "")
      || String(assignment.scheduledStartAt || "") !== isoTimestamp(visit.scheduled_start_at)
      || String(assignment.scheduledEndAt || "") !== isoTimestamp(visit.scheduled_end_at)
      || String(assignment.templateVersionId || "") !== String(visit.service_template_version_id || "")
      || String(assignment.binTypeId || "") !== String(visit.bin_type_id || "")
      || String(assignment.customerSiteProfileId || "") !== String(visit.customer_site_profile_id || "")
      || String(assignment.dumpSiteId || "") !== String(visit.dump_site_id || "")
      || String(assignment.materialId || "") !== String(visit.material_id || "")
      || String(assignment.serviceSnapshotHash || "") !== canonicalSha256(visit.service_snapshot)
      || !markerIdentityMatches
      || !sameCanonicalValue(arrayValue(assignment.stops), group.stops)) {
    throw confirmationInvalid("visit_assignment_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  return assignment;
}

/** @param {Record<string, any>} visit @param {number} assignmentCount @param {Record<string, any>} row */
function reservationStateMatches(visit, assignmentCount, row) {
  const customerHold = allowedReservationStatuses(visit, {
    reservationSlot: String(row.reservation_slot)
  }).includes("at_customer");
  if (customerHold) {
    return String(row.lifecycle_status) === "at_customer"
      && String(row.location_kind) === "customer_site"
      && String(row.customer_site_profile_id || "") === String(visit.customer_site_profile_id || "");
  }
  const expectedYard = requiredYardFromVisit(visit);
  const expectedStatus = assignmentCount > 1 ? "available" : "reserved";
  return Boolean(expectedYard)
    && String(row.lifecycle_status) === expectedStatus
    && String(row.location_kind) === "yard"
    && String(row.yard_id || "") === String(expectedYard);
}

/** @param {Record<string, any>} visit @param {Record<string, any>} assignment */
async function assertLockedReservations(visit, assignment) {
  const assigned = arrayValue(assignment.assetReservations).map((raw) => {
    const reservation = objectValue(raw);
    return {
      reservationId: String(reservation.reservationId || ""),
      reservationSlot: String(reservation.reservationSlot || ""),
      assetId: String(reservation.assetId || "")
    };
  }).sort((left, right) => left.reservationSlot.localeCompare(right.reservationSlot));
  const required = exactVisitAssetRequirements(visit)
    .map(({ reservationSlot, assetId }) => ({ reservationSlot, assetId }))
    .sort((left, right) => left.reservationSlot.localeCompare(right.reservationSlot));
  const assignedAssets = assigned.map(({ reservationSlot, assetId }) => ({ reservationSlot, assetId }));
  if (!assigned.length
      || assigned.some(({ reservationId, reservationSlot, assetId }) => !reservationId || !reservationSlot || !assetId)
      || !sameCanonicalValue(assignedAssets, required)) {
    throw confirmationInvalid("required_reservation_snapshot_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  const selected = await query(
    `SELECT reservation.reservation_id::text, reservation.asset_id::text,
            reservation.contract_id::text, reservation.visit_id::text,
            reservation.reservation_slot, asset.bin_type_id::text,
            asset.active AS asset_active, asset.under_maintenance,
            asset.tare_weight_kg, state.lifecycle_status,
            state.location_kind, state.yard_id::text,
            state.customer_site_profile_id::text, state.dump_site_id::text,
            state.truck_id::text, bin_type.maximum_payload_kg
       FROM mbt_bin_asset_reservations reservation
       JOIN mbt_bin_assets asset ON asset.asset_id = reservation.asset_id
       JOIN mbt_bin_asset_state state ON state.asset_id = reservation.asset_id
       JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = asset.bin_type_id
      WHERE reservation.visit_id = $1 AND reservation.released_at IS NULL
      ORDER BY reservation.reservation_slot, reservation.reservation_id
      FOR UPDATE OF reservation, asset, state`,
    [visit.service_visit_id]
  );
  const active = /** @type {Array<{reservationId: string, reservationSlot: string, assetId: string}>} */ (selected.rows.map((/** @type {Record<string, any>} */ row) => ({
    reservationId: String(row.reservation_id),
    reservationSlot: String(row.reservation_slot),
    assetId: String(row.asset_id)
  }))).sort((left, right) => left.reservationSlot.localeCompare(right.reservationSlot));
  const contractMatches = selected.rows.every(
    (/** @type {Record<string, any>} */ row) => String(row.contract_id) === String(visit.contract_id)
      && String(row.visit_id) === String(visit.service_visit_id)
  );
  if (!contractMatches || !sameCanonicalValue(active, assigned)) {
    throw confirmationInvalid("active_reservation_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  const assetsMatch = selected.rows.every((/** @type {Record<string, any>} */ row) =>
    row.asset_active === true
      && row.under_maintenance !== true
      && String(row.bin_type_id) === String(visit.bin_type_id)
      && reservationStateMatches(visit, assigned.length, row)
  );
  if (!assetsMatch) {
    throw confirmationInvalid("asset_state_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  const requiredWeightKg = selected.rows.reduce((/** @type {number} */ total, /** @type {Record<string, any>} */ row) => {
    const customerHold = String(row.location_kind) === "customer_site";
    return total + Math.max(0, Number(row.tare_weight_kg || 0))
      + (customerHold ? Math.max(0, Number(row.maximum_payload_kg || 0)) : 0);
  }, 0);
  return { requiredWeightLbs: requiredWeightKg * 2.2046226218 };
}

/** @param {Record<string, any>} visit @param {Record<string, any>} group */
// Current fleet and immutable plan capability fields form one atomic predicate.
// eslint-disable-next-line complexity
async function assertCurrentTruckCapability(visit, group) {
  const truckId = String(visit.planned_truck_id || "");
  const driverId = String(visit.planned_driver_id || "");
  const projectedTruckId = String(group.truck.id || group.load.truckId || "");
  const projectedDriverId = String(group.load.driverId || group.truck.driverId || "");
  if (!truckId || !driverId || projectedTruckId !== truckId || projectedDriverId !== driverId
      || String(group.load.truckId || truckId) !== truckId) {
    throw confirmationInvalid("truck_driver_assignment_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  const fleet = await query(
    `SELECT truck.id::text, truck.plate, truck.active, truck.truck_type,
            truck.bin_service_enabled, truck.bin_slot_capacity::int,
            truck.capacity_lbs::numeric,
            truck.base_yard_id::text, driver.id::text AS driver_id,
            driver.login AS driver_login, driver.active AS driver_active,
            bin_type.type_code, bin_type.active AS bin_type_active
       FROM dispatch_trucks truck
       JOIN dispatch_drivers driver ON driver.id = $2
      JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = $3
      WHERE truck.id = $1
      FOR UPDATE OF truck, driver
      FOR SHARE OF bin_type`,
    [truckId, driverId, visit.bin_type_id]
  );
  const current = fleet.rows[0];
  const requiredYardId = requiredYardFromVisit(visit);
  const yard = requiredYardId ? await yardIdentity(requiredYardId, true) : { yardId: "", yardCode: "" };
  const supported = await query(
    `SELECT truck_id::text
       FROM dispatch_truck_bin_types
      WHERE truck_id = $1 AND bin_type_id = $2 AND active
      FOR UPDATE`,
    [truckId, visit.bin_type_id]
  );
  const projectedCodes = arrayValue(group.truck.supportedBinTypeCodes).map(String);
  const projectedLogin = String(group.load.driverLogin || group.truck.driverLogin || "").toLowerCase();
  const groupStops = /** @type {Array<Record<string, any>>} */ (arrayValue(group.stops));
  const markerCapabilitiesMatch = groupStops.every((stop) => {
    const snapshot = objectValue(objectValue(stop.mbt).capabilitySnapshot);
    return String(snapshot.truckType || "").toLowerCase() === "bin"
      && String(snapshot.binTypeCode || "") === String(current?.type_code || "")
      && String(snapshot.baseYardId || "") === yard.yardId
      && String(snapshot.baseYardCode || "") === yard.yardCode;
  });
  if (!current
      || current.active !== true
      || current.driver_active !== true
      || current.bin_type_active !== true
      || String(current.truck_type) !== "bin"
      || current.bin_service_enabled !== true
      || Number(current.bin_slot_capacity) < 1
      || Number(current.capacity_lbs) <= 0
      || String(current.base_yard_id || "") !== yard.yardId
      || supported.rowCount !== 1
      || String(group.truck.truckType || "").toLowerCase() !== "bin"
      || Number(group.truck.binSlotCapacity) !== Number(current.bin_slot_capacity)
      || (group.truck.capacityLbs !== undefined
        && Number(group.truck.capacityLbs) !== Number(current.capacity_lbs))
      || !projectedCodes.includes(String(current.type_code))
      || String(group.truck.plate || "").toUpperCase() !== String(current.plate || "").toUpperCase()
      || projectedLogin !== String(current.driver_login || "").toLowerCase()
      || !markerCapabilitiesMatch) {
    throw confirmationInvalid("truck_capability_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  return {
    truckId,
    driverId,
    driverLogin: String(current.driver_login || "").toLowerCase(),
    slotCapacity: Number(current.bin_slot_capacity),
    capacityLbs: Number(current.capacity_lbs),
    binTypeCode: String(current.type_code),
    yard
  };
}

/** @param {Record<string, any>} visit @param {Record<string, any>} assignment */
// Linear-chain/front-leg eligibility is deliberately evaluated as one invariant.
// eslint-disable-next-line complexity
async function assertCurrentFrontLeg(visit, assignment) {
  const visits = await selectContractVisits(String(visit.contract_id), {
    serviceLineId: visit.service_line_id,
    forUpdate: true
  });
  const targetIndex = visits.findIndex(
    (candidate) => String(candidate.service_visit_id) === String(visit.service_visit_id)
  );
  const firstNonterminalIndex = visits.findIndex(
    (candidate) => !TERMINAL_VISIT_STATUSES.has(String(candidate.status))
  );
  const activePeers = visits.filter((candidate) =>
    String(candidate.service_visit_id) !== String(visit.service_visit_id)
      && new Set(["ready", "planned", "in_progress", "evidence_pending"]).has(String(candidate.status))
  );
  const predecessorId = String(visit.predecessor_visit_id || "");
  const predecessorIndex = predecessorId
    ? visits.findIndex((candidate) => String(candidate.service_visit_id) === predecessorId)
    : -1;
  const predecessorValid = predecessorId
    ? predecessorIndex >= 0
      && predecessorIndex < targetIndex
      && TERMINAL_VISIT_STATUSES.has(String(visits[predecessorIndex]?.status))
    : targetIndex === 0;
  const priorVisitsTerminal = targetIndex >= 0
    && visits.slice(0, targetIndex).every((candidate) => TERMINAL_VISIT_STATUSES.has(String(candidate.status)));
  if (targetIndex < 0
      || firstNonterminalIndex !== targetIndex
      || activePeers.length
      || !predecessorValid
      || !priorVisitsTerminal
      || String(assignment.predecessorVisitId || "") !== predecessorId) {
    throw confirmationInvalid("front_leg_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
}

/** @param {Record<string, any>} visit @param {Record<string, any>} assignment @param {Record<string, any>} truck */
async function assertLockedTemplateAndStops(visit, assignment, truck) {
  const template = await templateForVisit(visit, true);
  if (String(assignment.templateVersionId || "") !== String(template.template_version_id)
      || Number(assignment.templateRevision) !== Number(template.revision)) {
    throw confirmationInvalid("visit_template_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  const currentStops = (await materializedStops(visit, {
    binTypeCode: truck.binTypeCode,
    baseYardId: truck.yard.yardId,
    baseYardCode: truck.yard.yardCode
  }, true)).map((stop) => ({ ...stop, loadId: String(assignment.loadId || "") }));
  if (!sameCanonicalValue(currentStops, arrayValue(assignment.stops))) {
    throw confirmationInvalid("visit_assignment_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  return template;
}

/** @param {Record<string, any>} visit @param {Record<string, any>} plan @param {Record<string, any>} truck */
async function assertLockedPilotScope(visit, plan, truck) {
  const selected = await query(
    `SELECT pilot_scope_id::text, plan_date::text, lower(driver_login) AS driver_login,
            truck_id::text, contract_id::text, service_visit_id::text,
            active, authorized_at, expires_at, revoked_at
       FROM mbt_driver_pilot_scope
      WHERE service_visit_id = $1
      ORDER BY pilot_scope_id
      FOR UPDATE`,
    [visit.service_visit_id]
  );
  const now = Date.now();
  const matching = selected.rows.filter((/** @type {Record<string, any>} */ row) =>
    row.active === true
      && !row.revoked_at
      && new Date(row.authorized_at).getTime() <= now
      && new Date(row.expires_at).getTime() > now
      && String(row.plan_date) === String(plan.planDate)
      && String(row.driver_login || "").toLowerCase() === truck.driverLogin
      && String(row.truck_id) === truck.truckId
      && String(row.contract_id) === String(visit.contract_id)
      && String(row.service_visit_id) === String(visit.service_visit_id)
  );
  if (matching.length !== 1 || String(visit.planned_driver_id || "") !== truck.driverId) {
    throw confirmationInvalid("pilot_scope_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
}

/** @param {Record<string, any>} visit @param {Record<string, any>} assignment @param {Record<string, any>} template */
// Optional dump data has several coupled completeness and currentness checks.
// eslint-disable-next-line complexity
async function assertLockedDumpMaterial(visit, assignment, template) {
  const dumpSiteId = String(visit.dump_site_id || "");
  const materialId = String(visit.material_id || "");
  const hasDumpStop = arrayValue(objectValue(visit.service_snapshot).mandatoryStops).some((rawStop) => {
    const stop = objectValue(rawStop);
    return String(stop.locationRole || "").includes("dump")
      || String(stop.actionCode || "").includes("dump");
  });
  const required = template.dump_site_required === true || hasDumpStop;
  if (String(assignment.dumpSiteId || "") !== dumpSiteId
      || String(assignment.materialId || "") !== materialId
      || ((required || dumpSiteId || materialId) && (!dumpSiteId || !materialId))) {
    throw confirmationInvalid("dump_material_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
  if (!dumpSiteId && !materialId) {return;}
  const selected = await query(
    `SELECT dump.active AS dump_active, material.active AS material_active,
            acceptance.active AS acceptance_active, acceptance.accepted
       FROM mbt_dump_sites dump
       JOIN mbt_materials material ON material.material_id = $2
       JOIN mbt_dump_site_materials acceptance
         ON acceptance.dump_site_id = dump.dump_site_id
        AND acceptance.material_id = material.material_id
      WHERE dump.dump_site_id = $1
      FOR UPDATE OF dump, material, acceptance`,
    [dumpSiteId, materialId]
  );
  const current = selected.rows[0];
  if (selected.rowCount !== 1
      || current.dump_active !== true
      || current.material_active !== true
      || current.acceptance_active !== true
      || current.accepted !== true) {
    throw confirmationInvalid("dump_material_mismatch", {
      visitId: String(visit.service_visit_id)
    });
  }
}

/** @param {Array<{truck: Record<string, any>, requiredWeightLbs: number}>} validations */
function assertAggregateTruckCapacity(validations) {
  const byTruck = new Map();
  for (const validation of validations) {
    const truckId = String(validation.truck.truckId);
    const aggregate = byTruck.get(truckId) || {
      groups: 0,
      requiredWeightLbs: 0,
      slotCapacity: Number(validation.truck.slotCapacity),
      capacityLbs: Number(validation.truck.capacityLbs)
    };
    aggregate.groups += 1;
    aggregate.requiredWeightLbs += Number(validation.requiredWeightLbs || 0);
    byTruck.set(truckId, aggregate);
  }
  for (const [truckId, aggregate] of byTruck) {
    if (aggregate.groups > aggregate.slotCapacity
        || aggregate.requiredWeightLbs > aggregate.capacityLbs) {
      throw confirmationInvalid("truck_capacity_mismatch", {
        truckId,
        requiredSlots: aggregate.groups,
        slotCapacity: aggregate.slotCapacity
      });
    }
  }
}

/** @param {{plan: Record<string, any>, status: string, revision: number}} locked */
async function validateLockedBinConfirmation(locked) {
  const plan = locked.plan;
  if (!new Set(["draft", "confirmed"]).has(String(locked.status))) {
    throw confirmationInvalid("plan_status_invalid", { status: String(locked.status) });
  }
  const groups = lockedPlanBinGroups(plan);
  const selected = await query(
    `SELECT service_visit_id::text, contract_id::text, service_line_id::text,
            predecessor_visit_id::text, service_action, status,
            revision::int, dispatch_plan_id, dispatch_plan_revision::int,
            dispatch_load_id, dispatch_assignment_snapshot,
            planned_truck_id::text, planned_driver_id::text,
            scheduled_start_at, scheduled_end_at,
            (scheduled_start_at AT TIME ZONE 'America/Toronto')::date::text
              AS scheduled_plan_date,
            service_template_version_id::text,
            bin_type_id::text, expected_asset_id::text,
            outgoing_asset_id::text, incoming_asset_id::text,
            customer_site_profile_id::text, dump_site_id::text,
            material_id::text,
            service_snapshot
       FROM mbt_service_visits
      WHERE dispatch_plan_id = $1
      ORDER BY service_visit_id
      FOR UPDATE`,
    [String(plan.id)]
  );
  if (selected.rowCount !== groups.size) {
    throw confirmationInvalid("visit_group_set_mismatch");
  }
  const expectedLatestAssignmentRevision = String(locked.status) === "confirmed"
    ? Number(locked.revision) - 1
    : Number(locked.revision);
  const latestAssignmentRevision = Math.max(...selected.rows.map(
    (/** @type {Record<string, any>} */ visit) => Number(objectValue(visit.dispatch_assignment_snapshot).planRevision)
  ));
  if (latestAssignmentRevision !== expectedLatestAssignmentRevision) {
    throw confirmationInvalid("visit_assignment_mismatch");
  }
  const validations = [];
  for (const visit of selected.rows) {
    const group = groups.get(String(visit.service_visit_id));
    if (!group) {throw confirmationInvalid("visit_group_set_mismatch");}
    const assignmentSnapshot = objectValue(visit.dispatch_assignment_snapshot);
    if (String(visit.scheduled_plan_date || "") !== String(plan.planDate)) {
      throw confirmationInvalid("visit_plan_date_mismatch", {
        visitId: String(visit.service_visit_id)
      });
    }
    await assertCurrentFrontLeg(visit, assignmentSnapshot);
    if (String(assignmentSnapshot.templateVersionId || "")
        !== String(visit.service_template_version_id || "")) {
      throw confirmationInvalid("visit_template_mismatch", {
        visitId: String(visit.service_visit_id)
      });
    }
    const assignment = assertLockedVisitProjection(visit, group, plan);
    const truck = await assertCurrentTruckCapability(visit, group);
    const reservation = await assertLockedReservations(visit, assignment);
    const template = await assertLockedTemplateAndStops(visit, assignment, truck);
    await assertLockedDumpMaterial(visit, assignment, template);
    await assertLockedPilotScope(visit, plan, truck);
    validations.push({ truck, requiredWeightLbs: reservation.requiredWeightLbs });
  }
  assertAggregateTruckCapacity(validations);
  return true;
}

/**
 * Confirm an unchanged, dedicated BIN assignment after the caller has derived
 * the real Phase 3 environment/database/pilot capability. The repository runs
 * this validator under its existing plan lock and transaction.
 *
 * @param {Record<string, any>} input
 * @param {{capability: unknown, hooks?: Record<string, Function>}} boundary
 */
export async function confirmMbtBinDispatchPlan(input, { capability, hooks = {} }) {
  assertCapability(capability);
  assertDispatcherActor(input?.actor);
  const planId = requiredText(input?.planId, "plan ID");
  const note = String(input?.note || "").trim();
  return confirmValidatedBinDispatchPlan(planId, {
    note,
    validate: validateLockedBinConfirmation,
    hooks
  });
}

/** @param {Record<string, any>} input @param {{capability: unknown, hooks?: {afterReservation?: Function}}} boundary */
export async function assignMbtBinFrontLeg(input, { capability, hooks = {} }) {
  assertCapability(capability);
  assertDispatcherActor(input?.actor);
  const normalized = {
    planId: requiredText(input?.planId, "plan ID"),
    planDate: requiredText(input?.planDate, "plan date"),
    loadId: requiredText(input?.loadId, "load ID"),
    visitId: requiredText(input?.visitId, "visit ID"),
    expectedVisitRevision: positiveRevision(input?.expectedVisitRevision, "visit revision"),
    expectedPlanRevision: positiveRevision(input?.expectedPlanRevision, "plan revision"),
    assetAssignments: arrayValue(input?.assetAssignments).map(objectValue),
    reason: normalizedReason(input?.reason)
  };
  return executeBinCommand({
    actor: input.actor,
    commandName: "mbt.bin_dispatch.assign",
    idempotencyKey: requiredText(input.idempotencyKey, "idempotency key"),
    payload: normalized,
    correlationId: requiredText(input.correlationId, "correlation ID"),
    requestId: requiredText(input.requestId, "request ID"),
    // Atomic eligibility checks stay beside the writes they protect.
    // eslint-disable-next-line complexity
    mutation: async () => {
      const visit = await lockVisit(normalized.visitId);
      if (String(visit.status) !== "ready" || visit.dispatch_plan_id) {
        const isDirectRaceLoser = Number(visit.revision) === normalized.expectedVisitRevision + 1
          && Number(visit.dispatch_plan_revision) === normalized.expectedPlanRevision + 1;
        if (isDirectRaceLoser) {
          throw mbtError(409, "MBT_BIN_LEG_ALREADY_ASSIGNED", "This BIN leg is already assigned.");
        }
        throw mbtError(409, "MBT_BIN_DISPATCH_STALE_REVISION", "The BIN leg or plan changed. Refresh before retrying.");
      }
      const plan = await lockPlan(normalized.planId);
      if (Number(visit.revision) !== normalized.expectedVisitRevision
          || Number(plan.revision) !== normalized.expectedPlanRevision
          || String(plan.plan_date) !== normalized.planDate) {
        throw mbtError(409, "MBT_BIN_DISPATCH_STALE_REVISION", "The BIN leg or plan changed. Refresh before retrying.");
      }
      const trucks = clonePlanJson(plan.trucks);
      const located = locateLoad(trucks, normalized.loadId);
      if (!located) {
        throw mbtError(404, "MBT_BIN_DISPATCH_LOAD_NOT_FOUND", "The target Dispatch load was not found.");
      }
      const typeCode = await binTypeCode(String(visit.bin_type_id));
      const requiredYardId = requiredYardFromVisit(visit);
      const yard = await yardIdentity(requiredYardId);
      const truckId = String(located.truck.id || located.load.truckId || "");
      const driverId = requiredLoadDriverId(located);
      await assertBinTruck(truckId, located.truck, typeCode, requiredYardId);
      const assetAssignments = await exactOrSelectedAssetAssignments(
        visit,
        normalized.assetAssignments,
        String(input.actor.operatorId)
      );
      const assetReservations = [];
      for (const assetAssignment of assetAssignments) {
        const reservation = await reserveAsset(ambientDatabase, {
          assetId: assetAssignment.assetId,
          contractId: String(visit.contract_id),
          visitId: normalized.visitId,
          reservationSlot: assetAssignment.reservationSlot,
          reservedFrom: visit.scheduled_start_at,
          reservedUntil: visit.scheduled_end_at,
          reservedBy: String(input.actor.operatorId),
          source: BIN_COMMAND_SOURCE,
          actorType: "operator",
          actorId: String(input.actor.operatorId),
          occurredAt: visit.scheduled_start_at,
          allowedLifecycleStatuses: allowedReservationStatuses(visit, assetAssignment),
          reservationMode: reservationMode(visit, assetAssignments, assetAssignment)
        });
        assetReservations.push({
          reservationSlot: assetAssignment.reservationSlot,
          assetId: assetAssignment.assetId,
          reservationId: reservation.reservationId
        });
      }
      if (typeof hooks.afterReservation === "function") {await hooks.afterReservation();}
      const template = await templateForVisit(visit, true);
      const stops = (await materializedStops(visit, {
        binTypeCode: typeCode,
        baseYardId: yard.yardId,
        baseYardCode: yard.yardCode
      }, true)).map((stop) => ({ ...stop, loadId: normalized.loadId }));
      if (assignedStops(trucks, normalized.visitId).length) {
        throw mbtError(409, "MBT_BIN_LEG_ALREADY_ASSIGNED", "This BIN leg is already present in a Dispatch load.");
      }
      located.load.stops = [...arrayValue(located.load.stops), ...stops];
      const nextPlanRevision = Number(plan.revision) + 1;
      const nextVisitRevision = Number(visit.revision) + 1;
      const assignment = {
        planId: normalized.planId,
        planDate: normalized.planDate,
        planRevision: nextPlanRevision,
        loadId: normalized.loadId,
        serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
        visitRevision: nextVisitRevision,
        predecessorVisitId: visit.predecessor_visit_id ? String(visit.predecessor_visit_id) : null,
        scheduledStartAt: isoTimestamp(visit.scheduled_start_at),
        scheduledEndAt: isoTimestamp(visit.scheduled_end_at),
        templateVersionId: String(visit.service_template_version_id),
        templateRevision: Number(template.revision),
        binTypeId: String(visit.bin_type_id),
        customerSiteProfileId: String(visit.customer_site_profile_id),
        dumpSiteId: visit.dump_site_id ? String(visit.dump_site_id) : null,
        materialId: visit.material_id ? String(visit.material_id) : null,
        serviceSnapshotHash: canonicalSha256(visit.service_snapshot),
        assetReservations,
        stops
      };
      await persistPlan(normalized.planId, nextPlanRevision, trucks);
      await query(
        `UPDATE mbt_service_visits
            SET status = 'planned', planned_truck_id = $2,
                planned_driver_id = $3, dispatch_plan_id = $4,
                dispatch_plan_revision = $5, dispatch_load_id = $6,
                dispatch_assignment_snapshot = $7::jsonb,
                revision = $8, updated_by = $9, updated_at = now()
          WHERE service_visit_id = $1`,
        [
          normalized.visitId, truckId, driverId,
          normalized.planId, nextPlanRevision, normalized.loadId,
          JSON.stringify(assignment), nextVisitRevision, String(input.actor.operatorId)
        ]
      );
      await insertAssignmentHistory({
        visitId: normalized.visitId,
        contractId: String(visit.contract_id),
        planId: normalized.planId,
        action: "assigned",
        priorAssignment: null,
        assignment,
        visitRevision: nextVisitRevision,
        planRevision: nextPlanRevision,
        actorOperatorId: String(input.actor.operatorId),
        reason: normalized.reason,
        idempotencyKey: String(input.idempotencyKey)
      });
      const body = {
        schemaVersion: "mbt-bin-dispatch-assignment-v1",
        planId: normalized.planId,
        planDate: normalized.planDate,
        planRevision: nextPlanRevision,
        loadId: normalized.loadId,
        visitId: normalized.visitId,
        visitRevision: nextVisitRevision,
        contractId: String(visit.contract_id),
        serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
        assetReservations,
        stops
      };
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.bin_dispatch.front_leg_assigned",
          entityType: "mbt_service_visit",
          entityId: normalized.visitId,
          beforeState: { status: visit.status, revision: Number(visit.revision), assignment: null },
          afterState: { status: "planned", revision: nextVisitRevision, assignment },
          reason: normalized.reason,
          revisionBefore: Number(visit.revision),
          revisionAfter: nextVisitRevision,
          source: BIN_COMMAND_SOURCE
        }
      };
    }
  });
}

/** @param {Record<string, any>} input @param {{capability: unknown}} boundary */
export async function moveMbtBinFrontLegAssignment(input, { capability }) {
  assertCapability(capability);
  assertDispatcherActor(input?.actor);
  const normalized = {
    planId: requiredText(input?.planId, "plan ID"),
    planDate: requiredText(input?.planDate, "plan date"),
    visitId: requiredText(input?.visitId, "visit ID"),
    fromLoadId: requiredText(input?.fromLoadId, "source load ID"),
    toLoadId: requiredText(input?.toLoadId, "destination load ID"),
    expectedVisitRevision: positiveRevision(input?.expectedVisitRevision, "visit revision"),
    expectedPlanRevision: positiveRevision(input?.expectedPlanRevision, "plan revision"),
    stopIds: input?.stopIds === undefined ? null : arrayValue(input.stopIds).map(String),
    reason: normalizedReason(input?.reason)
  };
  return executeBinCommand({
    actor: input.actor,
    commandName: "mbt.bin_dispatch.move",
    idempotencyKey: requiredText(input.idempotencyKey, "idempotency key"),
    payload: normalized,
    correlationId: requiredText(input.correlationId, "correlation ID"),
    requestId: requiredText(input.requestId, "request ID"),
    mutation: () => transferAssignment(input, normalized, false)
  });
}

/** @param {Record<string, any>} input @param {Record<string, any>} normalized @param {boolean} recovery */
// Move and recovery intentionally share one whole-leg invariant boundary.
// eslint-disable-next-line complexity
async function transferAssignment(input, normalized, recovery) {
  const visit = await lockVisit(normalized.visitId);
  if (!recovery && STARTED_VISIT_STATUSES.has(String(visit.status))) {
    throw mbtError(409, "MBT_BIN_LEG_STARTED", "A started BIN leg requires audited recovery.");
  }
  if (recovery && !STARTED_VISIT_STATUSES.has(String(visit.status))) {
    throw mbtError(409, "MBT_BIN_RECOVERY_NOT_REQUIRED", "Only a started BIN leg can use recovery.");
  }
  const plan = await lockPlan(normalized.planId);
  if (Number(visit.revision) !== normalized.expectedVisitRevision
      || Number(plan.revision) !== normalized.expectedPlanRevision
      || String(plan.plan_date) !== normalized.planDate) {
    throw mbtError(409, "MBT_BIN_DISPATCH_STALE_REVISION", "The BIN leg or plan changed. Refresh before retrying.");
  }
  if (String(visit.dispatch_plan_id || "") !== normalized.planId
      || String(visit.dispatch_load_id || "") !== normalized.fromLoadId) {
    throw mbtError(409, "MBT_BIN_DISPATCH_STALE_REVISION", "The BIN assignment changed. Refresh before retrying.");
  }
  const trucks = clonePlanJson(plan.trucks);
  const source = locateLoad(trucks, normalized.fromLoadId);
  const target = locateLoad(trucks, normalized.toLoadId);
  if (!source || !target) {
    throw mbtError(404, "MBT_BIN_DISPATCH_LOAD_NOT_FOUND", "A Dispatch load was not found.");
  }
  const group = assignedStops(trucks, normalized.visitId);
  const expectedIds = arrayValue(objectValue(visit.dispatch_assignment_snapshot).stops)
    .map((stop) => String(objectValue(stop).id));
  const actualIds = group.map(({ stop }) => String(objectValue(stop).id));
  const sourceOnly = group.every(({ load }) => String(objectValue(load).id) === normalized.fromLoadId);
  if (!sourceOnly
      || expectedIds.length === 0
      || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
      || (normalized.stopIds && JSON.stringify(normalized.stopIds) !== JSON.stringify(expectedIds))) {
    throw mbtError(409, "MBT_BIN_LEG_SPLIT_FORBIDDEN", "Every mandatory stop must move as one BIN leg.");
  }
  const typeCode = await binTypeCode(String(visit.bin_type_id));
  const requiredYardId = requiredYardFromVisit(visit);
  const targetTruckId = String(target.truck.id || target.load.truckId || "");
  const targetDriverId = requiredLoadDriverId(target);
  await assertBinTruck(targetTruckId, target.truck, typeCode, requiredYardId);
  const priorAssignment = objectValue(visit.dispatch_assignment_snapshot);
  removeAssignedStops(trucks, normalized.visitId);
  target.load.stops = [...arrayValue(target.load.stops), ...group.map(({ stop }) => stop)];
  const nextPlanRevision = Number(plan.revision) + 1;
  const nextVisitRevision = Number(visit.revision) + 1;
  const assignment = {
    ...priorAssignment,
    planId: normalized.planId,
    planDate: normalized.planDate,
    planRevision: nextPlanRevision,
    loadId: normalized.toLoadId,
    serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
    visitRevision: nextVisitRevision,
    stops: group.map(({ stop }) => stop)
  };
  await persistPlan(normalized.planId, nextPlanRevision, trucks);
  await query(
    `UPDATE mbt_service_visits
        SET planned_truck_id = $2, planned_driver_id = $3,
            dispatch_plan_revision = $4, dispatch_load_id = $5,
            dispatch_assignment_snapshot = $6::jsonb,
            revision = $7, updated_by = $8, updated_at = now()
      WHERE service_visit_id = $1`,
    [
      normalized.visitId, targetTruckId, targetDriverId,
      nextPlanRevision, normalized.toLoadId, JSON.stringify(assignment),
      nextVisitRevision, String(input.actor.operatorId)
    ]
  );
  await insertAssignmentHistory({
    visitId: normalized.visitId,
    contractId: String(visit.contract_id),
    planId: normalized.planId,
    action: recovery ? "recovered" : "moved",
    priorAssignment,
    assignment,
    visitRevision: nextVisitRevision,
    planRevision: nextPlanRevision,
    actorOperatorId: String(input.actor.operatorId),
    reason: normalized.reason,
    idempotencyKey: String(input.idempotencyKey)
  });
  const assignmentBody = {
    schemaVersion: "mbt-bin-dispatch-assignment-v1",
    planId: normalized.planId,
    planDate: normalized.planDate,
    planRevision: nextPlanRevision,
    loadId: normalized.toLoadId,
    visitId: normalized.visitId,
    visitRevision: nextVisitRevision,
    contractId: String(visit.contract_id),
    serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
    assetReservations: [],
    stops: assignment.stops
  };
  const body = recovery ? {
    schemaVersion: "mbt-bin-dispatch-recovery-v1",
    planId: normalized.planId,
    planDate: normalized.planDate,
    planRevision: nextPlanRevision,
    visitId: normalized.visitId,
    visitRevision: nextVisitRevision,
    contractId: String(visit.contract_id),
    serviceLineId: visit.service_line_id ? String(visit.service_line_id) : null,
    priorAssignment,
    assignment: assignmentBody
  } : assignmentBody;
  return {
    status: 200,
    body,
    audit: {
      action: recovery
        ? "mbt.bin_dispatch.front_leg_recovered"
        : "mbt.bin_dispatch.front_leg_moved",
      entityType: "mbt_service_visit",
      entityId: normalized.visitId,
      beforeState: { status: visit.status, revision: Number(visit.revision), assignment: priorAssignment },
      afterState: { status: visit.status, revision: nextVisitRevision, assignment },
      reason: normalized.reason,
      revisionBefore: Number(visit.revision),
      revisionAfter: nextVisitRevision,
      source: BIN_COMMAND_SOURCE
    }
  };
}

/** @param {Record<string, any>} input @param {{capability: unknown}} boundary */
export async function recoverMbtBinFrontLegAssignment(input, { capability }) {
  assertCapability(capability);
  assertDispatcherActor(input?.actor);
  const normalized = {
    planId: requiredText(input?.planId, "plan ID"),
    planDate: requiredText(input?.planDate, "plan date"),
    visitId: requiredText(input?.visitId, "visit ID"),
    fromLoadId: requiredText(input?.fromLoadId, "source load ID"),
    toLoadId: requiredText(input?.toLoadId, "destination load ID"),
    expectedVisitRevision: positiveRevision(input?.expectedVisitRevision, "visit revision"),
    expectedPlanRevision: positiveRevision(input?.expectedPlanRevision, "plan revision"),
    stopIds: input?.stopIds === undefined ? null : arrayValue(input.stopIds).map(String),
    reason: normalizedReason(input?.reason)
  };
  return executeBinCommand({
    actor: input.actor,
    commandName: "mbt.bin_dispatch.recover",
    idempotencyKey: requiredText(input.idempotencyKey, "idempotency key"),
    payload: normalized,
    correlationId: requiredText(input.correlationId, "correlation ID"),
    requestId: requiredText(input.requestId, "request ID"),
    mutation: () => transferAssignment(input, normalized, true)
  });
}

/** @param {Record<string, any> | undefined} completed @param {Record<string, any> | undefined} next @param {string} completedVisitId */
function assertAdvancementPair(completed, next, completedVisitId) {
  if (!completed || !next
      || String(next.predecessor_visit_id || "") !== completedVisitId
      || String(completed.status) !== "completed"
      || String(next.status) !== "tentative") {
    throw mbtError(409, "MBT_BIN_LEG_ADVANCEMENT_CONFLICT", "The contract leg has already advanced or is not eligible.");
  }
  return { completed, next };
}

/** @param {Record<string, any>} completed @param {Record<string, any>} next @param {Record<string, any>} plan @param {Record<string, any>} normalized */
function assertAdvancementRevisions(completed, next, plan, normalized) {
  if (Number(completed.revision) !== normalized.expectedCompletedVisitRevision
      || Number(next.revision) !== normalized.expectedNextVisitRevision
      || Number(plan.revision) !== normalized.expectedPlanRevision) {
    throw mbtError(409, "MBT_BIN_LEG_ADVANCEMENT_CONFLICT", "The contract leg changed before advancement.");
  }
}

/** @param {Record<string, any>} contract @param {Record<string, any>} completed @param {Record<string, any>} next */
function rebasedReturnWindow(contract, completed, next) {
  const priorStart = new Date(next.scheduled_start_at);
  const priorEnd = new Date(next.scheduled_end_at);
  const priorDurationMs = priorEnd.getTime() - priorStart.getTime();
  if (!next.scheduled_start_at
      || !next.scheduled_end_at
      || !Number.isFinite(priorStart.getTime())
      || !Number.isFinite(priorEnd.getTime())
      || priorDurationMs <= 0) {
    throw mbtError(409, "MBT_BIN_LEG_ADVANCEMENT_CONFLICT", "The dependent BIN return schedule cannot be rebased safely.");
  }
  if (!completed.actual_completed_at) {return { start: priorStart, end: priorEnd };}
  const completedAt = new Date(completed.actual_completed_at);
  const rentalCalendarDays = Number(contract.rental_calendar_days);
  if (!Number.isFinite(completedAt.getTime())
      || !Number.isSafeInteger(rentalCalendarDays)
      || rentalCalendarDays < 1) {
    throw mbtError(409, "MBT_BIN_LEG_ADVANCEMENT_CONFLICT", "The dependent BIN return schedule cannot be rebased safely.");
  }
  const start = new Date(completedAt.getTime() + rentalCalendarDays * 24 * 60 * 60 * 1000);
  return { start, end: new Date(start.getTime() + priorDurationMs) };
}

/** @param {Record<string, any>} input @param {{capability: unknown}} boundary */
export async function advanceMbtBinContractLeg(input, { capability }) {
  assertCapability(capability);
  assertDispatcherActor(input?.actor);
  const normalized = {
    contractId: requiredText(input?.contractId, "contract ID"),
    completedVisitId: requiredText(input?.completedVisitId, "completed visit ID"),
    expectedCompletedVisitRevision: positiveRevision(input?.expectedCompletedVisitRevision, "completed visit revision"),
    nextVisitId: requiredText(input?.nextVisitId, "next visit ID"),
    expectedNextVisitRevision: positiveRevision(input?.expectedNextVisitRevision, "next visit revision"),
    planId: requiredText(input?.planId, "plan ID"),
    expectedPlanRevision: positiveRevision(input?.expectedPlanRevision, "plan revision"),
    reason: normalizedReason(input?.reason)
  };
  return executeBinCommand({
    actor: input.actor,
    commandName: "mbt.bin_dispatch.advance",
    idempotencyKey: requiredText(input.idempotencyKey, "idempotency key"),
    payload: normalized,
    correlationId: requiredText(input.correlationId, "correlation ID"),
    requestId: requiredText(input.requestId, "request ID"),
    mutation: async () => {
      const contract = await query(
        `SELECT contract_id, rental_calendar_days::int
           FROM mbt_contracts
          WHERE contract_id = $1
          FOR UPDATE`,
        [normalized.contractId]
      );
      if (!contract.rowCount) {
        throw mbtError(404, "MBT_BIN_CONTRACT_NOT_FOUND", "The BIN contract was not found.");
      }
      const completedVisit = await lockVisit(normalized.completedVisitId);
      if (String(completedVisit.contract_id) !== normalized.contractId) {
        throw mbtError(
          409,
          "MBT_BIN_LEG_ADVANCEMENT_CONFLICT",
          "The completed BIN leg does not belong to this contract."
        );
      }
      const visits = await selectContractVisits(normalized.contractId, {
        serviceLineId: completedVisit.service_line_id,
        forUpdate: true
      });
      const completedCandidate = visits.find((visit) => String(visit.service_visit_id) === normalized.completedVisitId);
      const nextCandidate = visits.find((visit) => String(visit.service_visit_id) === normalized.nextVisitId);
      const { completed, next } = assertAdvancementPair(
        completedCandidate,
        nextCandidate,
        normalized.completedVisitId
      );
      const plan = await lockPlan(normalized.planId);
      assertAdvancementRevisions(completed, next, plan, normalized);
      const { start: rebasedStart, end: rebasedEnd } = rebasedReturnWindow(
        contract.rows[0],
        completed,
        next
      );
      const trucks = clonePlanJson(plan.trucks);
      removeAssignedStops(trucks, normalized.completedVisitId);
      const nextPlanRevision = Number(plan.revision) + 1;
      await persistPlan(normalized.planId, nextPlanRevision, trucks);
      const activeReservations = await query(
        `SELECT reservation_id::text
           FROM mbt_bin_asset_reservations
          WHERE visit_id = $1 AND released_at IS NULL
          ORDER BY reservation_slot
          FOR UPDATE`,
        [normalized.completedVisitId]
      );
      for (const reservation of activeReservations.rows) {
        await releaseAssetReservation(ambientDatabase, {
          reservationId: String(reservation.reservation_id),
          releasedBy: String(input.actor.operatorId),
          releaseReason: normalized.reason,
          source: BIN_COMMAND_SOURCE,
          actorType: "operator",
          actorId: String(input.actor.operatorId),
          occurredAt: completed.actual_completed_at || completed.scheduled_end_at
        });
      }
      const nextRevision = Number(next.revision) + 1;
      await query(
        `UPDATE mbt_service_visits
            SET status = 'ready', scheduled_start_at = $2,
                scheduled_end_at = $3, revision = $4,
                updated_by = $5, updated_at = now()
          WHERE service_visit_id = $1`,
        [
          normalized.nextVisitId,
          rebasedStart.toISOString(),
          rebasedEnd.toISOString(),
          nextRevision,
          String(input.actor.operatorId)
        ]
      );
      await insertAssignmentHistory({
        visitId: normalized.completedVisitId,
        contractId: normalized.contractId,
        planId: normalized.planId,
        action: "advanced",
        priorAssignment: objectValue(completed.dispatch_assignment_snapshot),
        assignment: null,
        visitRevision: Number(completed.revision),
        planRevision: nextPlanRevision,
        actorOperatorId: String(input.actor.operatorId),
        reason: normalized.reason,
        idempotencyKey: String(input.idempotencyKey)
      });
      const body = {
        schemaVersion: "mbt-bin-contract-advancement-v1",
        contractId: normalized.contractId,
        completedVisitId: normalized.completedVisitId,
        nextVisitId: normalized.nextVisitId,
        nextStatus: "ready",
        poolRefresh: { count: 1 }
      };
      return {
        status: 200,
        body,
        audit: {
          action: "mbt.bin_dispatch.front_leg_advanced",
          entityType: "mbt_service_visit",
          entityId: normalized.completedVisitId,
          beforeState: {
            completedStatus: completed.status,
            nextStatus: next.status,
            assignment: objectValue(completed.dispatch_assignment_snapshot)
          },
          afterState: {
            completedStatus: "completed",
            nextStatus: "ready",
            nextScheduledStartAt: rebasedStart.toISOString(),
            nextScheduledEndAt: rebasedEnd.toISOString(),
            assignment: null
          },
          reason: normalized.reason,
          revisionBefore: Number(completed.revision),
          revisionAfter: Number(completed.revision),
          source: BIN_COMMAND_SOURCE
        }
      };
    }
  });
}
