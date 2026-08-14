// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { canonicalSha256, canonicalize } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { calculateDistanceBandChargeMinor } from "./distance-band-pricing.js";
import { MbtError } from "./errors.js";
import {
  calculateBillingUnitAmount,
  planDriverBillingUnits,
  resolveManualBillingAmount
} from "./mbbs-driver-billing-planner.js";
import { persistCalculatedMbbsCandidateBatch } from "./shadow-billing-service.js";
import { selectRateBand } from "./rate-bands.js";

const MAX_CANDIDATES = 1000;
const MAX_BATCH_CANDIDATES = 100;
const BATCH_DISTANCE_CONCURRENCY = 5;
const TORONTO_TIME_ZONE = "America/Toronto";

/**
 * @typedef {{
 *   rateDistanceBandId: string,
 *   itemCode: string,
 *   serviceCode: string,
 *   sequenceNumber: number,
 *   minimumMetres: number,
 *   maximumMetres: number | null,
 *   amountMinor: number,
 *   pricingBasis: string,
 *   boundaryRule: string,
 *   originYardCodes: string[]
 * }} MbbsRateBand
 */

/** @param {number} status @param {string} code @param {string} message */
function failure(status, code, message) {
  return new MbtError({ status, code, message });
}

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function array(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function billingActor(value) {
  const actor = object(value);
  const roles = array(actor.roles).map((role) => text(role).toLowerCase());
  if ((!roles.includes("admin") && !roles.includes("mbt_billing")) || !text(actor.operatorId)) {
    throw failure(403, "MBT_BILLING_FORBIDDEN", "An MBT Billing or Admin actor is required.");
  }
  return { operatorId: text(actor.operatorId), roles };
}

/** @param {unknown} value */
function candidateLimit(value) {
  const parsed = value === undefined ? 100 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CANDIDATES) {
    throw failure(400, "MBT_BILLING_CANDIDATE_LIMIT_INVALID", `Candidate limit must be between 1 and ${MAX_CANDIDATES}.`);
  }
  return parsed;
}

/** @param {unknown} value @param {{required?: boolean}} [options] */
function completedMonth(value, { required = false } = {}) {
  const normalized = text(value);
  if (!normalized && !required) {
    return null;
  }
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/u.test(normalized)) {
    throw failure(
      400,
      "MBT_BILLING_COMPLETED_MONTH_INVALID",
      "Completed month must use YYYY-MM in the America/Toronto time zone."
    );
  }
  return normalized;
}

/** @param {unknown} value */
function completedDay(value) {
  const normalized = text(value);
  if (!normalized) {
    return null;
  }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u.test(normalized)) {
    throw failure(
      400,
      "MBT_BILLING_COMPLETED_DATE_INVALID",
      "Completed date must use YYYY-MM-DD in the America/Toronto time zone."
    );
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw failure(
      400,
      "MBT_BILLING_COMPLETED_DATE_INVALID",
      "Completed date must be a real calendar date in the America/Toronto time zone."
    );
  }
  return normalized;
}

/** @param {string | null} month @param {string | null} day */
function assertCompatibleCompletionFilters(month, day) {
  if (month && day && !day.startsWith(`${month}-`)) {
    throw failure(
      400,
      "MBT_BILLING_COMPLETED_FILTER_CONFLICT",
      "Completed date must fall inside the selected completion month."
    );
  }
}

/** @param {unknown} value */
function candidateSearch(value) {
  const normalized = text(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length < 2 || normalized.length > 120) {
    throw failure(
      400,
      "MBT_BILLING_CANDIDATE_SEARCH_INVALID",
      "Order search must contain between 2 and 120 characters."
    );
  }
  return normalized;
}

/** @param {unknown} value */
function customerSearch(value) {
  const normalized = text(value);
  if (normalized.length < 2 || normalized.length > 120) {
    throw failure(
      400,
      "MBT_BILLING_CUSTOMER_SEARCH_INVALID",
      "Customer search must contain between 2 and 120 characters."
    );
  }
  return normalized;
}

/** @param {unknown} value */
function customerLimit(value) {
  const parsed = value === undefined ? 25 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw failure(400, "MBT_BILLING_CUSTOMER_LIMIT_INVALID", "Customer search limit must be between 1 and 50.");
  }
  return parsed;
}

/** @param {unknown} value */
function customerNetsuiteId(value) {
  const normalized = text(value);
  if (!/^\d+$/u.test(normalized) || BigInt(normalized) < 1n) {
    throw failure(400, "MBT_CROSS_CHARGE_CUSTOMER_INVALID", "Choose a valid canonical billing customer.");
  }
  return normalized;
}

/** @param {unknown} value */
function rateCardVersionId(value) {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw failure(400, "MBT_MBBS_RATE_SELECTION_INVALID", "Choose a valid active MBBS rate-card version.");
  }
  return normalized;
}

/** @param {unknown} value */
function batchCandidateIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_CANDIDATES) {
    throw failure(
      400,
      "MBT_BILLING_CANDIDATE_BATCH_INVALID",
      `Choose between 1 and ${MAX_BATCH_CANDIDATES} completed MBBS orders.`
    );
  }
  const ids = value.map((raw) => {
    const identity = decodedCandidateId(raw);
    const canonical = candidateId(identity);
    if (canonical !== text(raw)) {
      throw failure(400, "MBT_BILLING_CANDIDATE_ID_INVALID", "The MBBS billing candidate ID is invalid.");
    }
    return canonical;
  });
  if (new Set(ids).size !== ids.length) {
    throw failure(
      400,
      "MBT_BILLING_CANDIDATE_BATCH_DUPLICATE",
      "Each completed MBBS order may appear only once in a calculation batch."
    );
  }
  return ids;
}

/** @param {unknown} value @param {string[]} selectedIds */
function batchManualAmountEdits(value, selectedIds) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > selectedIds.length) {
    throw failure(400, "MBT_BILLING_MANUAL_AMOUNT_INVALID", "Manual amount edits must match selected billing candidates.");
  }
  const selected = new Set(selectedIds);
  const found = new Set();
  return value.map((rawEdit) => {
    const edit = object(rawEdit);
    const identity = decodedCandidateId(edit.candidateId);
    const id = candidateId(identity);
    if (!selected.has(id) || id !== text(edit.candidateId) || found.has(id)) {
      throw failure(400, "MBT_BILLING_MANUAL_AMOUNT_INVALID", "Each manual amount edit must identify one selected candidate exactly once.");
    }
    found.add(id);
    return {
      candidateId: id,
      calculatedAmountMinor: edit.calculatedAmountMinor,
      adjustmentMinor: edit.adjustmentMinor,
      finalAmountMinor: edit.finalAmountMinor
    };
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

/** @param {unknown} value */
function normalizedLocation(value) {
  return text(value).toLowerCase().replaceAll(/[^a-z0-9]+/gu, " ").trim();
}

/** @param {unknown} value */
function retainedRouteLabel(value) {
  const retained = text(value);
  return ["unmapped", "unknown", "n/a", "na", "none", "null", "tbd"]
    .includes(retained.toLowerCase())
    ? ""
    : retained;
}

/** @param {unknown[]} values */
function address(values) {
  return values.map(text).filter(Boolean).join(", ");
}

/** @param {Record<string, any>} row */
function publicYard(row) {
  return {
    yardCode: text(row.yard_code),
    dispatchLocationId: row.dispatch_location_id === null ? null : Number(row.dispatch_location_id),
    displayName: text(row.display_name),
    addressText: address([
      row.address_line_1, row.address_line_2, row.city, row.region,
      row.postal_code, row.country_code
    ])
  };
}

async function activeYards() {
  const result = await query(
    `SELECT yard_code, dispatch_location_id::int, display_name,
            address_line_1, address_line_2, city, region, postal_code, country_code
       FROM mbt_yards WHERE active ORDER BY yard_code`
  );
  return result.rows.map(publicYard);
}

/** @param {Array<Record<string, any>>} yards @param {unknown[]} values */
function findYard(yards, values) {
  const candidates = values.map(normalizedLocation).filter(Boolean);
  return yards.find((yard) => {
    const yardValues = [yard.yardCode, yard.dispatchLocationId, yard.displayName, yard.addressText]
      .map(normalizedLocation)
      .filter(Boolean);
    return candidates.some((candidate) => yardValues.some((yardValue) =>
      candidate === yardValue
      || candidate === normalizedLocation(yard.yardCode)
      || (yardValue.length > 10 && candidate.includes(yardValue))
      || (candidate.length > 10 && yardValue.includes(candidate))
    ));
  }) || null;
}

/** @param {Record<string, any>} identity */
function candidateId(identity) {
  return Buffer.from(JSON.stringify({ v: 1, ...identity }), "utf8").toString("base64url");
}

/** @param {string} hash */
function deterministicUuid(hash) {
  const value = hash.slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16] || "0", 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {string} scope @param {unknown} identity */
function stableId(scope, identity) {
  return deterministicUuid(canonicalSha256({ scope, identity }));
}

/** @param {unknown} value */
function decodedCandidateId(value) {
  const encoded = text(value);
  if (!encoded || encoded.length > 500 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw failure(400, "MBT_BILLING_CANDIDATE_ID_INVALID", "The MBBS billing candidate ID is invalid.");
  }
  try {
    const decoded = object(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (decoded.v !== 1 || ![
      "driver",
      "direct_dependency",
      "dispatch_completion",
      "reconciliation",
      "sales_order",
      "custom_order"
    ].includes(text(decoded.kind))) {
      throw new Error("unsupported candidate identity");
    }
    return decoded;
  } catch {
    throw failure(400, "MBT_BILLING_CANDIDATE_ID_INVALID", "The MBBS billing candidate ID is invalid.");
  }
}

/** @param {unknown} value */
function sourceType(value) {
  const normalized = text(value).toUpperCase();
  return ["SO", "TO", "PO", "VRMA", "CUSTOM"].includes(normalized) ? normalized : null;
}

/** @param {string} type @param {string} reference */
function rootReference(type, reference) {
  return type === "SO" ? reference.replace(/-S[0-9]+$/iu, "") : reference;
}

/** @param {Record<string, any>} unit @param {Array<Record<string, any>>} yards */
function driverCandidateFromUnit(unit, yards) {
  const identity = {
    kind: "driver",
    planId: text(unit.planId) || null,
    planDate: text(unit.planDate),
    unitKey: text(unit.unitKey)
  };
  const stablePhysicalLoadId = `BILLING-${stableId("mbt.billing.driver.business_unit", {
    unitKey: identity.unitKey
  })}`;
  const stops = array(unit.routeStops).map((stop, index) => ({
    sequenceNumber: index + 1,
    stopType: text(object(stop).stopType),
    addressText: text(object(stop).addressText)
  }));
  const originYard = findYard(yards, [stops[0]?.addressText]);
  return {
    candidateId: candidateId(identity),
    sourceSystem: "driver_pwa",
    sourceRecordId: `${identity.planId || "unplanned"}:${identity.unitKey}`,
    physicalLoadId: stablePhysicalLoadId,
    billingLegId: identity.unitKey,
    billingLegNumber: Number(unit.legNumber),
    driverLoadIds: array(unit.driverLoadIds).map(text),
    driverLoadNumbers: array(unit.driverLoadNumbers).map(text),
    loadNumber: text(unit.loadNumber),
    planDate: identity.planDate,
    completedAt: new Date(unit.completedAt).toISOString(),
    references: array(unit.references),
    memberReferences: array(unit.memberReferences),
    originYardCode: originYard?.yardCode || null,
    originLabel: text(unit.originLabel),
    destinationLabel: text(unit.destinationLabel),
    routeStops: stops,
    routeStopCount: stops.length,
    dropCount: Number(unit.dropCount),
    billingRule: text(unit.billingRule),
    relationship: object(unit.relationship),
    chargeable: unit.chargeable === true,
    reason: unit.reason || null,
    _routeStops: stops,
    _identity: identity
  };
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} yards @param {Record<string, any> | null} [purchaseGroup] */
// eslint-disable-next-line complexity
function reconciliationCandidate(row, yards, purchaseGroup = null) {
  const snapshot = object(row.order_snapshot);
  const type = sourceType(row.order_kind) || "PO";
  const sourceReference = text(row.source_order_ref);
  const reference = purchaseGroup ? text(purchaseGroup.groupReference) : sourceReference;
  const sourceLabel = text(row.header_source_address)
    || text(row.source_location)
    || text(snapshot.sourceLocation);
  const destinationLabel = text(row.header_destination_address)
    || text(row.destination_location)
    || text(snapshot.destinationLocation);
  const sourceYard = findYard(yards, [row.source_location_id, sourceLabel]);
  const destinationYard = findYard(yards, [row.destination_location_id, destinationLabel]);
  const originYard = sourceYard;
  const originAddress = sourceYard?.addressText || sourceLabel;
  const destinationAddress = destinationYard?.addressText || destinationLabel;
  const reason = !reference
    ? "The reconciliation row has no order reference."
    : !originAddress || !destinationAddress
      ? "The completed reconciliation row has no complete route addresses."
      : null;
  const identity = {
    kind: "reconciliation",
    orderKind: type,
    recordId: String(row.id),
    ...(purchaseGroup ? { groupRef: reference } : {})
  };
  const memberReferences = purchaseGroup
    ? array(purchaseGroup.members).map((member) => ({
        sourceType: "PO",
        rootReference: text(object(member).rootReference)
      }))
    : [];
  return {
    candidateId: candidateId(identity),
    sourceSystem: "reconciliation",
    sourceRecordId: String(row.id),
    physicalLoadId: `RECON-${type}-${row.id}`,
    billingLegId: `RECON-${type}-${row.id}`,
    billingLegNumber: 1,
    driverLoadIds: [],
    driverLoadNumbers: [],
    loadNumber: `Reconciliation ${row.id}`,
    planDate: text(row.plan_date) || text(row.completed_at).slice(0, 10),
    completedAt: new Date(row.completed_at).toISOString(),
    references: reference ? [{ sourceType: type, rootReference: reference }] : [],
    memberReferences,
    originYardCode: originYard?.yardCode || null,
    originLabel: originAddress,
    destinationLabel: destinationAddress,
    routeStops: originAddress && destinationAddress
      ? [
          { sequenceNumber: 1, addressText: originAddress, stopType: "pickup" },
          { sequenceNumber: 2, addressText: destinationAddress, stopType: "dropoff" }
        ]
      : [],
    routeStopCount: originAddress && destinationAddress ? 2 : 0,
    dropCount: originAddress && destinationAddress ? 1 : 0,
    billingRule: type === "TO" ? "to_replenishment" : purchaseGroup ? "po_group" : "po_shared_leg",
    relationship: {
      code: type === "TO" ? "to_replenishment" : purchaseGroup ? "po_group" : "po_shared_leg",
      summary: type === "TO"
        ? "Replenishment Transfer Order charged in full, once for the order."
        : purchaseGroup
          ? `${reference} is charged once as one Purchase Order group; ${memberReferences.length} child Purchase Order reference(s) are retained as audit evidence.`
        : "Purchase Order reconciliation supplies one independently retained business leg."
    },
    chargeable: reason === null,
    reason,
    _routeStops: originAddress && destinationAddress
      ? [{ addressText: originAddress, stopType: "pickup" }, { addressText: destinationAddress, stopType: "dropoff" }]
      : [],
    _identity: identity
  };
}

/** @param {Array<Record<string, any>>} rows @param {Array<Record<string, any>>} yards */
async function reconciliationCandidates(rows, yards) {
  const poReferences = rows.filter((row) => text(row.order_kind).toUpperCase() === "PO")
    .map((row) => text(row.source_order_ref))
    .filter(Boolean);
  const groups = await scmPurchaseOrderGroups(poReferences);
  /** @type {Map<string, Array<Record<string, any>>>} */
  const groupedRows = new Map();
  const ungrouped = [];
  for (const row of rows) {
    const group = text(row.order_kind).toUpperCase() === "PO"
      ? selectedPurchaseOrderGroup(groups, text(row.source_order_ref))
      : null;
    if (!group) {
      ungrouped.push(reconciliationCandidate(row, yards));
      continue;
    }
    const retained = groupedRows.get(group.groupReference) || [];
    retained.push(row);
    groupedRows.set(group.groupReference, retained);
  }
  const grouped = [];
  for (const [groupReference, retainedRows] of groupedRows) {
    const group = groups.find((/** @type {Record<string, any>} */ candidate) =>
      candidate.groupReference === groupReference
    );
    const representative = [...retainedRows].sort((left, right) =>
      Number(left.id) - Number(right.id)
    )[0];
    if (!group || !representative) {
      continue;
    }
    grouped.push(reconciliationCandidate(representative, yards, group));
  }
  return [...grouped, ...ungrouped];
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} yards */
// eslint-disable-next-line complexity
function salesOrderCandidate(row, yards) {
  const originYard = findYard(yards, [row.outbound_location_id, row.outbound_location]);
  const origin = originYard?.addressText
    || retainedRouteLabel(row.dispatch_pickup_address)
    || retainedRouteLabel(row.outbound_location);
  const destination = retainedRouteLabel(row.dispatch_address);
  const reason = !text(row.tranid)
    ? "The completed Sales Order has no reference."
    : !destination
      ? "The completed Sales Order has no dispatch address."
      : !origin
        ? "The completed Sales Order has no retained origin address."
        : null;
  const identity = { kind: "sales_order", netsuiteId: String(row.netsuite_id) };
  return {
    candidateId: candidateId(identity),
    sourceSystem: "sales_order",
    sourceRecordId: String(row.netsuite_id),
    physicalLoadId: `SO-${row.netsuite_id}`,
    billingLegId: `SO-${row.netsuite_id}`,
    billingLegNumber: 1,
    driverLoadIds: [],
    driverLoadNumbers: [],
    loadNumber: `SO ${text(row.tranid)}`,
    planDate: text(row.plan_date) || text(row.completed_at).slice(0, 10),
    completedAt: new Date(row.completed_at).toISOString(),
    references: text(row.tranid) ? [{ sourceType: "SO", rootReference: rootReference("SO", text(row.tranid)) }] : [],
    originYardCode: originYard?.yardCode || null,
    originLabel: origin,
    destinationLabel: destination,
    routeStops: destination && origin
      ? [
          { sequenceNumber: 1, addressText: origin, stopType: "pickup" },
          { sequenceNumber: 2, addressText: destination, stopType: "dropoff" }
        ]
      : [],
    routeStopCount: destination && origin ? 2 : 0,
    dropCount: destination && origin ? 1 : 0,
    billingRule: "so_order",
    relationship: {
      code: "so_order",
      summary: "Sales Order charged independently, once for the order."
    },
    chargeable: reason === null,
    reason,
    deliveryMethod: text(row.sales_order_type),
    _routeStops: destination && origin
      ? [{ addressText: origin, stopType: "pickup" }, { addressText: destination, stopType: "dropoff" }]
      : [],
    _identity: identity
  };
}

/** @param {string} origin @param {string} destination @param {boolean} [numbered] */
function twoStopRoute(origin, destination, numbered = false) {
  if (!origin || !destination) {
    return [];
  }
  const route = [
    { addressText: origin, stopType: "pickup" },
    { addressText: destination, stopType: "dropoff" }
  ];
  return numbered
    ? route.map((stop, index) => ({ sequenceNumber: index + 1, ...stop }))
    : route;
}

/** @param {number} missingMemberCount @param {string} origin @param {string} destination */
function salesOrderGroupReason(missingMemberCount, origin, destination) {
  if (missingMemberCount > 0) {
    return "Not every child Sales Order in this group is completed in the selected period.";
  }
  if (!destination) {
    return "The completed Sales Order group has no dispatch address.";
  }
  if (!origin) {
    return "The completed Sales Order group has no retained origin address.";
  }
  return null;
}

/** @param {Record<string, any>} group @param {Array<Record<string, any>>} rows @param {Array<Record<string, any>>} yards */
function salesOrderGroupCandidate(group, rows, yards) {
  const orderedRows = array(group.members).map((member) => rows.find((row) =>
    text(row.tranid).toUpperCase() === text(object(member).rootReference).toUpperCase()
  ));
  const first = object(orderedRows.find(Boolean));
  const originYard = findYard(yards, [first.outbound_location_id, first.outbound_location]);
  const origin = originYard?.addressText
    || retainedRouteLabel(first.dispatch_pickup_address)
    || retainedRouteLabel(first.outbound_location);
  const destination = retainedRouteLabel(first.dispatch_address);
  const missingMembers = array(group.members).filter((member) => !rows.some((row) =>
    text(row.tranid).toUpperCase() === text(object(member).rootReference).toUpperCase()
  ));
  const reason = salesOrderGroupReason(missingMembers.length, origin, destination);
  const completedValues = rows.map((row) => new Date(row.completed_at).toISOString()).sort();
  const memberReferences = array(group.members).map((member) => ({
    sourceType: "SO",
    rootReference: text(object(member).rootReference)
  }));
  const identity = {
    kind: "sales_order",
    netsuiteId: String(first.netsuite_id),
    groupRef: text(group.groupReference),
    planDate: text(group.planDate)
  };
  const stableGroupId = stableId("mbt.billing.sales_order_group", identity);
  const routeStops = twoStopRoute(origin, destination, true);
  const internalRouteStops = twoStopRoute(origin, destination);
  const completedAt = completedValues.at(-1);
  return {
    candidateId: candidateId(identity),
    sourceSystem: "sales_order",
    sourceRecordId: `${group.groupReference}:${group.planDate}`,
    physicalLoadId: `SO-GROUP-${stableGroupId}`,
    billingLegId: `SO_GROUP|${text(group.groupReference).toUpperCase()}`,
    billingLegNumber: 1,
    driverLoadIds: [],
    driverLoadNumbers: [],
    loadNumber: `SO group ${group.groupReference}`,
    planDate: text(group.planDate),
    completedAt: completedAt ?? new Date(first.completed_at).toISOString(),
    references: [{ sourceType: "SO", rootReference: text(group.groupReference) }],
    memberReferences,
    originYardCode: originYard?.yardCode || null,
    originLabel: origin,
    destinationLabel: destination,
    routeStops,
    routeStopCount: routeStops.length,
    dropCount: routeStops.filter((stop) => stop.stopType === "dropoff").length,
    billingRule: "so_group",
    relationship: {
      code: "so_group",
      summary: `${group.groupReference} is charged once as one Sales Order group; ${memberReferences.length} child Sales Order reference(s) are retained as audit evidence.`
    },
    chargeable: reason === null,
    reason,
    deliveryMethod: text(first.sales_order_type),
    _routeStops: internalRouteStops,
    _identity: identity
  };
}

/** @param {Record<string, any>} row */
// eslint-disable-next-line complexity
function customOrderCandidate(row) {
  const origin = text(row.pickup_location);
  const destination = text(row.dropoff_location);
  const reference = text(row.ref_number);
  const reason = !reference
    ? "The completed custom order has no reference."
    : !origin || !destination
      ? "The completed custom order has no complete route addresses."
      : null;
  const identity = { kind: "custom_order", recordId: String(row.id) };
  return {
    candidateId: candidateId(identity),
    sourceSystem: "custom_order",
    sourceRecordId: String(row.id),
    physicalLoadId: `CUSTOM-${row.id}`,
    billingLegId: `CUSTOM-${row.id}`,
    billingLegNumber: 1,
    driverLoadIds: [],
    driverLoadNumbers: [],
    loadNumber: `Custom ${reference}`,
    planDate: torontoCalendarDate(row.completed_at),
    completedAt: new Date(row.completed_at).toISOString(),
    references: reference ? [{ sourceType: "CUSTOM", rootReference: reference }] : [],
    originYardCode: null,
    originLabel: origin,
    destinationLabel: destination,
    routeStops: origin && destination
      ? [
          { sequenceNumber: 1, addressText: origin, stopType: "pickup" },
          { sequenceNumber: 2, addressText: destination, stopType: "dropoff" }
        ]
      : [],
    routeStopCount: origin && destination ? 2 : 0,
    dropCount: origin && destination ? 1 : 0,
    billingRule: "custom_order",
    relationship: {
      code: "custom_order",
      summary: "Custom local order charged independently, once for its retained route."
    },
    chargeable: reason === null,
    reason,
    deliveryMethod: "Delivery",
    _routeStops: origin && destination
      ? [{ addressText: origin, stopType: "pickup" }, { addressText: destination, stopType: "dropoff" }]
      : [],
    _identity: identity
  };
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} yards */
// eslint-disable-next-line complexity
function directDependencyCandidate(row, yards) {
  const transferReference = text(row.transfer_order_ref);
  const salesReference = text(row.sales_order_ref);
  const originYard = findYard(yards, [
    row.source_location_id,
    row.source_location,
    row.from_location_id,
    row.from_location
  ]);
  const origin = originYard?.addressText
    || retainedRouteLabel(row.source_location)
    || retainedRouteLabel(row.from_location);
  const destination = retainedRouteLabel(row.sales_dispatch_address)
    || retainedRouteLabel(row.receipt_drop_address)
    || retainedRouteLabel(row.receipt_address);
  const reason = !transferReference
    ? "The completed direct-pickup Transfer Order has no reference."
    : !origin || !destination
      ? "The completed direct-pickup Transfer Order has no complete retained route."
      : null;
  const identity = { kind: "direct_dependency", recordId: String(row.id) };
  const routeStops = twoStopRoute(origin, destination, true);
  const internalRouteStops = twoStopRoute(origin, destination);
  const completedAt = new Date(row.dispatch_completed_at).toISOString();
  const driverLoadId = text(row.planned_load_id);
  const driverLoadName = text(row.planned_load_name) || driverLoadId;
  return {
    candidateId: candidateId(identity),
    sourceSystem: "direct_dependency",
    sourceRecordId: String(row.id),
    physicalLoadId: `DIRECT-TO-${row.id}`,
    billingLegId: `DIRECT-TO-${row.id}`,
    billingLegNumber: 1,
    driverLoadIds: driverLoadId ? [driverLoadId] : [],
    driverLoadNumbers: driverLoadName ? [driverLoadName] : [],
    loadNumber: driverLoadName || `Direct TO ${transferReference}`,
    planDate: text(row.completion_plan_date)
      || text(row.planned_date)
      || torontoCalendarDate(completedAt),
    completedAt,
    dispatchCompletionStatus: text(row.dispatch_completion_status),
    dispatchCompletedAt: completedAt,
    completionEvidenceType: text(row.completion_evidence_type),
    completionEvidenceId: text(row.completion_evidence_id),
    completionEventId: text(row.completion_event_id),
    references: transferReference
      ? [{ sourceType: "TO", rootReference: transferReference }]
      : [],
    relatedReferences: salesReference
      ? [{ sourceType: "SO", rootReference: salesReference, relationship: "customer_drop" }]
      : [],
    originYardCode: originYard?.yardCode || null,
    originLabel: origin,
    destinationLabel: destination,
    routeStops,
    routeStopCount: routeStops.length,
    dropCount: 1,
    billingRule: "to_direct_additional_drop",
    relationship: {
      code: "to_direct_additional_drop",
      summary: `${transferReference || "Direct-pickup Transfer Order"} is one additional drop linked to completed Sales Order ${salesReference || "evidence"}.`
    },
    chargeable: reason === null,
    reason,
    _routeStops: internalRouteStops,
    _identity: identity
  };
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} yards */
// eslint-disable-next-line complexity
function dispatchCompletionCandidate(row, yards) {
  const type = sourceType(row.order_kind);
  const reference = text(row.order_ref);
  let originYard = null;
  let origin = "";
  let destination = "";
  if (type === "SO") {
    originYard = findYard(yards, [row.so_outbound_location_id, row.so_outbound_location]);
    origin = originYard?.addressText
      || retainedRouteLabel(row.so_dispatch_pickup_address)
      || retainedRouteLabel(row.so_outbound_location);
    destination = retainedRouteLabel(row.so_dispatch_address);
  } else if (type === "TO") {
    originYard = findYard(yards, [row.to_from_location_id, row.to_from_location]);
    const destinationYard = findYard(yards, [row.to_to_location_id, row.to_to_location]);
    origin = originYard?.addressText
      || retainedRouteLabel(row.to_dispatch_pickup_address)
      || retainedRouteLabel(row.to_from_location);
    destination = destinationYard?.addressText
      || retainedRouteLabel(row.to_dispatch_address)
      || retainedRouteLabel(row.to_to_location);
  } else if (type === "PO") {
    const destinationYard = findYard(yards, [row.po_destination_location_id, row.po_destination_location]);
    origin = retainedRouteLabel(row.po_dispatch_pickup_address)
      || retainedRouteLabel(row.po_vendor_address)
      || retainedRouteLabel(row.po_dispatch_address)
      || retainedRouteLabel(row.po_source_location);
    destination = destinationYard?.addressText || retainedRouteLabel(row.po_destination_location);
  } else if (type === "VRMA") {
    originYard = findYard(yards, [row.vrma_pickup_location]);
    origin = originYard?.addressText || retainedRouteLabel(row.vrma_pickup_location);
    destination = retainedRouteLabel(row.vrma_vendor_address)
      || retainedRouteLabel(row.vrma_dropoff_location);
  } else if (type === "CUSTOM") {
    originYard = findYard(yards, [row.custom_pickup_location]);
    origin = originYard?.addressText || retainedRouteLabel(row.custom_pickup_location);
    destination = retainedRouteLabel(row.custom_dropoff_location);
  }
  const directTransfer = type === "TO" && text(row.dependency_mode) === "direct_to_customer";
  const billingRule = directTransfer
    ? "to_direct_additional_drop"
    : /** @type {Record<string, string | undefined>} */ ({
        SO: "so_order",
        TO: "to_replenishment",
        PO: "po_shared_leg",
        VRMA: "po_shared_leg",
        CUSTOM: "custom_order"
      })[type || ""];
  const relationshipSummary = directTransfer
    ? `${reference || "Direct-pickup Transfer Order"} is one additional drop linked to completed Sales Order ${text(row.dependency_sales_order_ref) || "evidence"}.`
    : /** @type {Record<string, string | undefined>} */ ({
        SO: "Sales Order charged independently, once for the order.",
        TO: "Replenishment Transfer Order charged in full, once for the order.",
        PO: "Purchase Order completion supplies one independently retained business leg.",
        VRMA: "Vendor Return completion supplies one independently retained business leg.",
        CUSTOM: "Custom local order charged independently, once for its retained route."
      })[type || ""] || "Completed Dispatch order charged from retained evidence.";
  const reason = !type || !reference
    ? "The completed Dispatch order has no supported reference."
    : !origin || !destination
      ? "The completed Dispatch order has no complete retained route addresses."
      : null;
  const identity = {
    kind: "dispatch_completion",
    completionEventId: text(row.completion_event_id)
  };
  const completedAt = new Date(row.dispatch_completed_at).toISOString();
  const stableCompletionId = stableId("mbt.billing.dispatch_completion", {
    orderKind: type,
    orderRef: reference.toUpperCase()
  });
  const routeStops = twoStopRoute(origin, destination, true);
  const internalRouteStops = twoStopRoute(origin, destination);
  return {
    candidateId: candidateId(identity),
    sourceSystem: "dispatch_completion",
    sourceRecordId: text(row.completion_event_id),
    physicalLoadId: `DISPATCH-${stableCompletionId}`,
    billingLegId: `DISPATCH-${stableCompletionId}`,
    billingLegNumber: 1,
    driverLoadIds: text(row.load_id) ? [text(row.load_id)] : [],
    driverLoadNumbers: text(row.load_id) ? [text(row.load_id)] : [],
    loadNumber: text(row.load_id) || `${type || "Order"} ${reference}`,
    planDate: text(row.plan_date) || torontoCalendarDate(completedAt),
    completedAt,
    dispatchCompletionStatus: text(row.dispatch_completion_status),
    dispatchCompletedAt: completedAt,
    completionEvidenceType: text(row.completion_evidence_type),
    completionEvidenceId: text(row.completion_evidence_id),
    completionEventId: text(row.completion_event_id),
    references: type && reference ? [{ sourceType: type, rootReference: reference }] : [],
    relatedReferences: text(row.dependency_sales_order_ref)
      ? [{ sourceType: "SO", rootReference: text(row.dependency_sales_order_ref), relationship: "customer_drop" }]
      : [],
    originYardCode: originYard?.yardCode || null,
    originLabel: origin,
    destinationLabel: destination,
    routeStops,
    routeStopCount: routeStops.length,
    dropCount: 1,
    billingRule,
    relationship: { code: billingRule, summary: relationshipSummary },
    chargeable: reason === null,
    reason,
    deliveryMethod: type === "SO" ? text(row.so_sales_order_type) : "Delivery",
    _routeStops: internalRouteStops,
    _identity: identity
  };
}

/** @param {unknown} value */
function torontoCalendarDate(value) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw failure(409, "MBT_BILLING_CANDIDATE_INCOMPLETE", "A completed order has an invalid completion time.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TORONTO_TIME_ZONE
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw failure(409, "MBT_BILLING_CANDIDATE_INCOMPLETE", "A completed order has no Toronto completion date.");
  }
  return `${year}-${month}-${day}`;
}

async function activeMbbsRateGraphs() {
  const selected = await query(
    `SELECT card.rate_card_id::text, card.rate_card_code, card.display_name,
            card.customer_netsuite_id::text,
            version.rate_card_version_id::text, version.version_number::int,
            version.effective_from, version.effective_to,
            card.currency, band.currency AS band_currency,
            band.rate_distance_band_id::text,
            band.item_code, band.service_code, band.sequence_number::int,
            band.minimum_metres::int, band.maximum_metres::int,
            band.amount_minor::int, band.pricing_basis, band.boundary_rule,
            band.origin_yard_codes
       FROM mbt_rate_cards card
       JOIN mbt_rate_card_versions version USING (rate_card_id)
       JOIN mbt_rate_distance_bands band USING (rate_card_version_id)
      WHERE card.active
        AND version.status = 'active'
        AND version.effective_from <= now()
        AND (version.effective_to IS NULL OR version.effective_to > now())
        AND band.item_code = 'DELIVERY_CHARGE_MBBS'
        AND band.service_code = 'mbbs_cross_charge'
      ORDER BY lower(card.display_name), card.rate_card_code,
               version.version_number DESC, band.sequence_number, band.minimum_metres`
  );
  /** @type {Map<string, Array<Record<string, any>>>} */
  const grouped = new Map();
  for (const rawRow of selected.rows) {
    const row = object(rawRow);
    const versionId = text(row.rate_card_version_id);
    const rows = grouped.get(versionId);
    if (rows) {
      rows.push(row);
    } else {
      grouped.set(versionId, [row]);
    }
  }
  return [...grouped.values()].map((rows) => {
    const first = /** @type {Record<string, any>} */ (rows[0]);
    const currency = text(first.currency);
    if (rows.some((row) => text(row.band_currency) !== currency)) {
      throw failure(409, "MBT_MBBS_RATE_INVALID", "An active MBBS rate card has inconsistent currency evidence.");
    }
    const bands = /** @type {MbbsRateBand[]} */ (rows.map((row) => ({
      rateDistanceBandId: text(row.rate_distance_band_id),
      itemCode: text(row.item_code),
      serviceCode: text(row.service_code),
      sequenceNumber: Number(row.sequence_number),
      minimumMetres: Number(row.minimum_metres),
      maximumMetres: row.maximum_metres === null ? null : Number(row.maximum_metres),
      amountMinor: Number(row.amount_minor),
      pricingBasis: text(row.pricing_basis),
      boundaryRule: text(row.boundary_rule),
      originYardCodes: array(row.origin_yard_codes).map(text).filter(Boolean)
    })));
    // selectRateBand performs complete contiguous/open-band validation.
    selectRateBand(bands, 0);
    return {
      rateCardId: text(first.rate_card_id),
      rateCardCode: text(first.rate_card_code),
      displayName: text(first.display_name),
      customerNetsuiteId: first.customer_netsuite_id === null
        ? null
        : text(first.customer_netsuite_id),
      rateCardVersionId: text(first.rate_card_version_id),
      versionNumber: Number(first.version_number),
      effectiveFrom: new Date(first.effective_from).toISOString(),
      effectiveTo: first.effective_to === null ? null : new Date(first.effective_to).toISOString(),
      currency,
      bands,
      originYardCodes: new Set(bands.flatMap((band) => band.originYardCodes))
    };
  });
}

/** @param {Array<Record<string, any>>} graphs */
function rateOptions(graphs) {
  return graphs.map((graph) => ({
    rateCardId: graph.rateCardId,
    rateCardCode: graph.rateCardCode,
    displayName: graph.displayName,
    customerNetsuiteId: graph.customerNetsuiteId,
    rateCardVersionId: graph.rateCardVersionId,
    versionNumber: graph.versionNumber,
    effectiveFrom: graph.effectiveFrom,
    effectiveTo: graph.effectiveTo,
    currency: graph.currency
  }));
}

/** @param {Array<Record<string, any>>} graphs @param {unknown} rawVersionId @param {{explicit?: boolean}} [options] */
function selectedRateGraph(graphs, rawVersionId, { explicit = false } = {}) {
  if (graphs.length === 0) {
    throw failure(409, "MBT_MBBS_RATE_UNAVAILABLE", "Activate an MBBS rate card containing DELIVERY_CHARGE_MBBS before calculating completed orders.");
  }
  if (!text(rawVersionId)) {
    if (!explicit && graphs.length === 1) {
      return /** @type {Record<string, any>} */ (graphs[0]);
    }
    throw failure(409, "MBT_MBBS_RATE_SELECTION_REQUIRED", "Choose which active MBBS rate card to apply.");
  }
  const versionId = rateCardVersionId(rawVersionId);
  const graph = graphs.find((candidate) => candidate.rateCardVersionId === versionId);
  if (!graph) {
    throw failure(409, "MBT_MBBS_RATE_SELECTION_UNAVAILABLE", "The selected MBBS rate card is not active or eligible for DELIVERY_CHARGE_MBBS.");
  }
  return /** @type {Record<string, any>} */ (graph);
}

/** @param {number} limit @param {string | null} completedMonthValue @param {string | null} completedDateValue @param {string | null} searchValue @param {Array<Record<string, any>> | null} [identities] */
async function driverRows(limit, completedMonthValue, completedDateValue, searchValue, identities = null) {
  const result = await query(
    `SELECT plan_id::text, plan_date::text, load_id,
            max(NULLIF(btrim(load_name), '')) AS load_name,
            max(NULLIF(btrim(driver_login), '')) AS driver_login,
            max(NULLIF(btrim(truck_plate), '')) AS truck_plate,
            max(completed_at) AS completed_at,
            jsonb_agg(jsonb_build_object(
              'id', id,
              'stopType', stop_type,
              'orderRefs', COALESCE(order_refs, '[]'::jsonb),
              'details', COALESCE(job_details, '{}'::jsonb),
              'startedAt', started_at,
              'completedAt', completed_at
            ) ORDER BY COALESCE(started_at, completed_at, created_at), id) AS records
       FROM driver_job_records
      WHERE NULLIF(btrim(load_id), '') IS NOT NULL
      GROUP BY plan_id, plan_date, load_id
     HAVING bool_and(status = 'complete')
        AND bool_or(jsonb_array_length(COALESCE(order_refs, '[]'::jsonb)) > 0)
        AND ($2::text IS NULL OR (
          (max(completed_at) AT TIME ZONE '${TORONTO_TIME_ZONE}') >= (($2 || '-01')::date)::timestamp
          AND (max(completed_at) AT TIME ZONE '${TORONTO_TIME_ZONE}') < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
        AND ($3::text IS NULL OR (max(completed_at) AT TIME ZONE '${TORONTO_TIME_ZONE}')::date = $3::date)
        AND ($4::text IS NULL OR concat_ws(
          ' ', load_id, plan_id::text,
          jsonb_agg(COALESCE(order_refs, '[]'::jsonb))::text,
          jsonb_agg(COALESCE(job_details, '{}'::jsonb))::text
        ) ILIKE '%' || $4 || '%')
        AND ($5::jsonb IS NULL OR EXISTS (
          SELECT 1
            FROM jsonb_array_elements($5::jsonb) selected_identity
           WHERE (selected_identity->>'planId' IS NULL
                  OR selected_identity->>'planId' = driver_job_records.plan_id::text)
             AND selected_identity->>'planDate' = driver_job_records.plan_date::text
        ))
      ORDER BY max(completed_at) DESC NULLS LAST, plan_id DESC NULLS LAST, load_id
      LIMIT $1`,
    [
      limit,
      completedMonthValue,
      completedDateValue,
      searchValue,
      identities === null ? null : JSON.stringify(identities.map((identity) => ({
        planId: identity.planId === null ? null : text(identity.planId),
        planDate: text(identity.planDate)
      })))
    ]
  );
  return result.rows;
}

/** @param {Array<Record<string, any>>} rows @param {Array<Record<string, any>>} canonicalOrders */
function plannedDriverUnits(rows, canonicalOrders = []) {
  /** @type {Map<string, {planId: string, planDate: string, loads: Array<Record<string, any>>}>} */
  const groups = new Map();
  for (const rawRow of rows) {
    const row = object(rawRow);
    const planId = text(row.plan_id);
    const planDate = text(row.plan_date);
    const groupKey = `${planId || "unplanned"}|${planDate}`;
    const group = groups.get(groupKey) || { planId, planDate, loads: [] };
    group.loads.push({
      loadId: text(row.load_id),
      loadName: text(row.load_name) || text(row.load_id),
      completedAt: new Date(row.completed_at).toISOString(),
      records: array(row.records)
    });
    groups.set(groupKey, group);
  }
  return [...groups.values()].flatMap((group) => planDriverBillingUnits({
    ...group,
    canonicalOrders
  }));
}

/** @param {Array<Record<string, any>>} groups @param {string} reference @param {{planId?: string, planDate?: string, allowActiveFallback?: boolean}} [context] */
function selectedSalesOrderGroup(groups, reference, context = {}) {
  const normalizedReference = text(reference).toUpperCase();
  const exactReferenceGroups = groups.filter((group) =>
    text(group.groupReference).toUpperCase() === normalizedReference
  );
  const candidates = exactReferenceGroups.length
    ? exactReferenceGroups
    : groups.filter((group) => array(group.members).some((member) =>
      text(object(member).rootReference).toUpperCase() === normalizedReference
    ));
  const exactContext = candidates.filter((group) => {
    const planIdMatches = !text(context.planId) || text(group.planId) === text(context.planId);
    const planDateMatches = !text(context.planDate) || text(group.planDate) === text(context.planDate);
    return planIdMatches && planDateMatches;
  });
  const retained = exactContext.length
    ? exactContext
    : context.allowActiveFallback === true
      ? candidates.filter((group) => group.active === true)
      : [];
  return [...retained].sort((left, right) =>
    Number(right.active) - Number(left.active)
      || text(right.updatedAt).localeCompare(text(left.updatedAt))
      || text(left.groupReference).localeCompare(text(right.groupReference))
  )[0] || null;
}

/** @param {string[]} references @param {string[]} planIds @param {string[]} planDates @returns {Promise<Array<Record<string, any>>>} */
async function dispatchSalesOrderGroups(references, planIds = [], planDates = []) {
  if (references.length === 0) {
    return [];
  }
  const result = await query(
    `SELECT group_row.group_ref, group_row.plan_id::text, group_row.plan_date::text,
            group_row.active, group_row.updated_at,
            jsonb_agg(jsonb_build_object(
              'rootReference', member.member_order_ref,
              'position', member.position
            ) ORDER BY member.position, member.member_order_ref) AS members
       FROM dispatch_delivery_groups group_row
       JOIN dispatch_delivery_group_members member
         ON member.group_ref = group_row.group_ref
      WHERE group_row.order_type = 'sales_order'
        AND (
          upper(btrim(group_row.group_ref)) = ANY($1::text[])
          OR EXISTS (
            SELECT 1
              FROM dispatch_delivery_group_members matched
             WHERE matched.group_ref = group_row.group_ref
               AND upper(btrim(matched.member_order_ref)) = ANY($1::text[])
          )
        )
        AND (
          (cardinality($2::text[]) = 0 AND cardinality($3::text[]) = 0)
          OR group_row.plan_id::text = ANY($2::text[])
          OR group_row.plan_date::text = ANY($3::text[])
          OR upper(btrim(group_row.group_ref)) = ANY($1::text[])
        )
      GROUP BY group_row.group_ref, group_row.plan_id, group_row.plan_date,
               group_row.active, group_row.updated_at
      ORDER BY group_row.active DESC, group_row.updated_at DESC, group_row.group_ref`,
    [
      references.map((reference) => text(reference).toUpperCase()),
      planIds.map(text).filter(Boolean),
      planDates.map(text).filter(Boolean)
    ]
  );
  return result.rows.map((/** @type {Record<string, any>} */ rawRow) => {
    const row = object(rawRow);
    return {
      groupReference: text(row.group_ref),
      planId: text(row.plan_id),
      planDate: text(row.plan_date),
      active: row.active === true,
      updatedAt: new Date(row.updated_at).toISOString(),
      members: array(row.members).map((rawMember) => {
        const member = object(rawMember);
        return {
          sourceType: "SO",
          rootReference: text(member.rootReference),
          position: Number(member.position)
        };
      })
    };
  });
}

/** @param {Array<Record<string, any>>} groups @param {string} reference */
function selectedPurchaseOrderGroup(groups, reference) {
  const normalizedReference = text(reference).toUpperCase();
  const exact = groups.find((group) => text(group.groupReference).toUpperCase() === normalizedReference);
  if (exact) {
    return exact;
  }
  return groups.find((group) => group.active === true && array(group.members).some((member) =>
    text(object(member).rootReference).toUpperCase() === normalizedReference
  )) || null;
}

/** @param {string[]} references @returns {Promise<Array<Record<string, any>>>} */
async function scmPurchaseOrderGroups(references) {
  if (references.length === 0) {
    return [];
  }
  const normalized = references.map((reference) => text(reference).toUpperCase());
  const result = await query(
    `SELECT group_row.group_ref, group_row.status, group_row.details,
            jsonb_agg(jsonb_build_object(
              'rootReference', member.order_ref,
              'position', member.id
            ) ORDER BY member.id) AS members
       FROM scm_schedule_groups group_row
       JOIN scm_schedule_group_members member ON member.group_id = group_row.id
      WHERE upper(btrim(group_row.group_ref)) = ANY($1::text[])
         OR (
           lower(btrim(group_row.status)) = 'active'
           AND EXISTS (
             SELECT 1
               FROM scm_schedule_group_members matched
              WHERE matched.group_id = group_row.id
                AND upper(btrim(matched.order_ref)) = ANY($1::text[])
           )
         )
      GROUP BY group_row.id, group_row.group_ref, group_row.status, group_row.details
      ORDER BY CASE WHEN lower(btrim(group_row.status)) = 'active' THEN 0 ELSE 1 END,
               group_row.id DESC`,
    [normalized]
  );
  return result.rows.map((/** @type {Record<string, any>} */ rawRow) => {
    const row = object(rawRow);
    return {
      groupReference: text(row.group_ref),
      active: text(row.status).toLowerCase() === "active",
      details: object(row.details),
      members: array(row.members).map((rawMember) => {
        const member = object(rawMember);
        return {
          sourceType: "PO",
          rootReference: text(member.rootReference),
          position: Number(member.position)
        };
      })
    };
  });
}

/** @param {Array<Record<string, any>>} units @param {Array<Record<string, any>>} yards */
// eslint-disable-next-line complexity
async function canonicalDriverOrders(units, yards) {
  const requestedReferences = [...new Set(units.flatMap((unit) => array(unit.references))
    .map((reference) => text(object(reference).rootReference).toUpperCase())
    .filter(Boolean))];
  if (requestedReferences.length === 0) {
    return [];
  }
  const planIds = [...new Set(units.map((unit) => text(unit.planId)).filter(Boolean))];
  const planDates = [...new Set(units.map((unit) => text(unit.planDate)).filter(Boolean))];
  const salesGroups = await dispatchSalesOrderGroups(requestedReferences, planIds, planDates);
  const purchaseGroups = await scmPurchaseOrderGroups(requestedReferences);
  const references = [...new Set([
    ...requestedReferences,
    ...salesGroups.flatMap((/** @type {Record<string, any>} */ group) => array(group.members).map((member) =>
      text(object(member).rootReference).toUpperCase()
    )),
    ...purchaseGroups.flatMap((/** @type {Record<string, any>} */ group) => array(group.members).map((member) =>
      text(object(member).rootReference).toUpperCase()
    ))
  ].filter(Boolean))];
  const sales = await query(
    `SELECT netsuite_id::text, tranid, outbound_location_id::text,
            outbound_location, dispatch_pickup_address, dispatch_address
       FROM sales_orders
      WHERE upper(btrim(tranid)) = ANY($1::text[])`,
    [references]
  );
  const transfers = await query(
    `SELECT netsuite_id::text, tranid, from_location_id::text, from_location,
            to_location_id::text, to_location, dispatch_address
       FROM transfer_orders
      WHERE upper(btrim(tranid)) = ANY($1::text[])`,
    [references]
  );
  const purchases = await query(
    `SELECT purchase.netsuite_id::text, purchase.tranid, purchase.dispatch_ref,
            purchase.vendor_reference,
            purchase.source_location_id::text, purchase.source_location,
            purchase.destination_location_id::text, purchase.destination_location,
            COALESCE(
              NULLIF(purchase.dispatch_pickup_address, ''),
              NULLIF(vendor_yard.address, ''),
              NULLIF(purchase.dispatch_address, ''),
              NULLIF(purchase.source_location, '')
            ) AS origin_address,
            active_split.source_po_id::text AS split_source_po_id,
            active_split.source_po_ref AS split_source_po_ref,
            active_split.split_po_ref
       FROM purchase_orders purchase
       LEFT JOIN LATERAL (
         SELECT yard.address
           FROM dispatch_vendor_yards yard
          WHERE yard.active
            AND lower(btrim(yard.yard)) = lower(btrim(COALESCE(
              NULLIF(purchase.dispatch_vendor_yard, ''),
              NULLIF(purchase.source_location, '')
            )))
          ORDER BY yard.id
          LIMIT 1
       ) vendor_yard ON true
       LEFT JOIN LATERAL (
         SELECT split.source_po_id, split.source_po_ref, split.split_po_ref
          FROM dispatch_scm_po_splits split
          WHERE split.status = 'active'
            AND (split.source_po_id = purchase.netsuite_id
                 OR split.split_po_id = purchase.netsuite_id)
          ORDER BY CASE
                     WHEN upper(btrim(split.source_po_ref)) = ANY($1::text[])
                       OR upper(btrim(split.split_po_ref)) = ANY($1::text[]) THEN 0
                     ELSE 1
                   END,
                   split.created_at DESC, split.id DESC
          LIMIT 1
       ) active_split ON true
      WHERE upper(btrim(COALESCE(purchase.tranid, ''))) = ANY($1::text[])
         OR upper(btrim(COALESCE(purchase.dispatch_ref, ''))) = ANY($1::text[])
         OR upper(btrim(COALESCE(purchase.vendor_reference, ''))) = ANY($1::text[])
         OR upper(btrim(COALESCE(active_split.source_po_ref, ''))) = ANY($1::text[])
         OR upper(btrim(COALESCE(active_split.split_po_ref, ''))) = ANY($1::text[])`,
    [references]
  );
  /** @type {Array<Record<string, any>>} */
  const canonical = [];
  const unitContextByReference = new Map();
  for (const unit of units) {
    for (const rawReference of array(unit.references)) {
      const reference = object(rawReference);
      unitContextByReference.set(text(reference.rootReference).toUpperCase(), {
        planId: text(unit.planId),
        planDate: text(unit.planDate)
      });
    }
  }
  const salesCanonicalByReference = new Map();
  for (const rawRow of sales.rows) {
    const row = object(rawRow);
    const originYard = findYard(yards, [row.outbound_location_id, row.outbound_location]);
    const retainedReference = rootReference("SO", text(row.tranid));
    const context = unitContextByReference.get(retainedReference.toUpperCase())
      || units.find((unit) => text(unit.planDate))
      || {};
    const group = selectedSalesOrderGroup(salesGroups, retainedReference, context);
    const retained = {
      sourceType: "SO",
      rootReference: retainedReference,
      originAddress: originYard?.addressText
        || retainedRouteLabel(row.dispatch_pickup_address)
        || retainedRouteLabel(row.outbound_location),
      destinationAddress: retainedRouteLabel(row.dispatch_address),
      ...(group ? {
        orderGroupKey: `SO_GROUP:${group.groupReference.toUpperCase()}`,
        orderGroupReference: group.groupReference,
        orderGroupMembers: group.members.map((/** @type {Record<string, any>} */ member) => member.rootReference),
        orderGroupPosition: group.members.find((/** @type {Record<string, any>} */ member) =>
          member.rootReference.toUpperCase() === retainedReference.toUpperCase()
        )?.position
      } : {})
    };
    canonical.push(retained);
    salesCanonicalByReference.set(retainedReference.toUpperCase(), retained);
  }
  for (const requestedReference of requestedReferences) {
    const context = unitContextByReference.get(requestedReference) || {};
    const group = selectedSalesOrderGroup(salesGroups, requestedReference, context);
    if (!group || salesCanonicalByReference.has(requestedReference)) {
      continue;
    }
    const firstMember = group.members
      .map((/** @type {Record<string, any>} */ member) => salesCanonicalByReference.get(member.rootReference.toUpperCase()))
      .find(Boolean);
    if (!firstMember) {
      continue;
    }
    canonical.push({
      ...firstMember,
      rootReference: requestedReference,
      orderGroupKey: `SO_GROUP:${group.groupReference.toUpperCase()}`,
      orderGroupReference: group.groupReference,
      orderGroupMembers: group.members.map((/** @type {Record<string, any>} */ member) => member.rootReference),
      orderGroupPosition: Number.MAX_SAFE_INTEGER
    });
  }
  for (const rawRow of transfers.rows) {
    const row = object(rawRow);
    const originYard = findYard(yards, [row.from_location_id, row.from_location]);
    const destinationYard = findYard(yards, [row.to_location_id, row.to_location]);
    canonical.push({
      sourceType: "TO",
      rootReference: text(row.tranid),
      originAddress: originYard?.addressText || retainedRouteLabel(row.from_location),
      destinationAddress: destinationYard?.addressText
        || retainedRouteLabel(row.dispatch_address)
        || retainedRouteLabel(row.to_location)
    });
  }
  const purchaseUnits = units.flatMap((unit) => array(unit.references))
    .map(object)
    .filter((reference) => ["PO", "VRMA"].includes(text(reference.sourceType)));
  for (const reference of purchaseUnits) {
    const requested = text(reference.rootReference);
    const requestedUpper = requested.toUpperCase();
    const rawRow = purchases.rows.find((/** @type {Record<string, any>} */ candidate) => [
      candidate.tranid,
      candidate.dispatch_ref,
      candidate.vendor_reference,
      candidate.split_source_po_ref,
      candidate.split_po_ref
    ].some((alias) => text(alias).toUpperCase() === requestedUpper));
    if (!rawRow) {
      continue;
    }
    const row = object(rawRow);
    const destinationYard = findYard(yards, [row.destination_location_id, row.destination_location]);
    const splitReference = text(row.split_po_ref).toUpperCase() === requestedUpper
      ? text(row.split_po_ref)
      : "";
    const purchaseGroup = selectedPurchaseOrderGroup(purchaseGroups, requested);
    canonical.push({
      sourceType: text(reference.sourceType),
      rootReference: requested,
      billingReference: splitReference || requested,
      billingGroupKey: text(row.split_source_po_id)
        ? `PO_SOURCE:${text(row.split_source_po_id)}`
        : "",
      originAddress: retainedRouteLabel(row.origin_address),
      destinationAddress: destinationYard?.addressText || retainedRouteLabel(row.destination_location),
      ...(purchaseGroup ? {
        orderGroupKey: `PO_GROUP:${purchaseGroup.groupReference.toUpperCase()}`,
        orderGroupReference: purchaseGroup.groupReference,
        orderGroupMembers: purchaseGroup.members.map((/** @type {Record<string, any>} */ member) => member.rootReference),
        orderGroupPosition: purchaseGroup.members.find((/** @type {Record<string, any>} */ member) =>
          member.rootReference.toUpperCase() === requestedUpper
        )?.position ?? Number.MAX_SAFE_INTEGER
      } : {})
    });
  }
  return canonical;
}

/** @param {Array<Record<string, any>>} rows @param {Array<Record<string, any>>} yards */
async function driverCandidates(rows, yards) {
  const preliminary = plannedDriverUnits(rows);
  const canonicalOrders = await canonicalDriverOrders(preliminary, yards);
  return plannedDriverUnits(rows, canonicalOrders)
    .map((unit) => driverCandidateFromUnit(unit, yards));
}

/**
 * A direct-pickup TO may deliberately have no standalone Driver record. Its
 * terminal evidence is the linked completed SO customer drop retained by the
 * dependency ledger and projected into the universal Dispatch completion
 * status.
 *
 * @param {number} limit
 * @param {string | null} completedMonthValue
 * @param {string | null} completedDateValue
 * @param {string | null} searchValue
 * @param {string[] | null} [recordIds]
 */
async function directDependencyRows(
  limit,
  completedMonthValue,
  completedDateValue,
  searchValue,
  recordIds = null
) {
  const result = await query(
    `SELECT dependency.id::text,
            dependency.sales_order_ref,
            dependency.transfer_order_ref,
            dependency.source_location_id::text,
            dependency.source_location,
            dependency.planned_plan_id::text,
            dependency.planned_date::text,
            dependency.planned_load_id,
            dependency.planned_load_name,
            transfer.from_location_id::text,
            transfer.from_location,
            sales.dispatch_address AS sales_dispatch_address,
            receipt.job_details->>'dropAddress' AS receipt_drop_address,
            receipt.job_details->>'address' AS receipt_address,
            completion.completion_event_id::text,
            completion.dispatch_completion_status,
            completion.dispatch_completed_at,
            completion.completion_evidence_type,
            completion.completion_evidence_id,
            completion.plan_date::text AS completion_plan_date
       FROM order_dependencies dependency
       JOIN dispatch_order_completion_status completion
         ON completion.order_kind = 'TO'
        AND lower(btrim(completion.order_ref)) = lower(btrim(dependency.transfer_order_ref))
        AND completion.dispatch_completion_status = 'completed'
        AND completion.completion_evidence_type = 'direct_dependency'
       JOIN driver_job_records receipt
         ON receipt.job_id = dependency.direct_receipt_job_id
        AND receipt.status = 'complete'
        AND lower(btrim(receipt.stop_type)) = 'dropoff'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(COALESCE(receipt.order_refs, '[]'::jsonb)) retained_ref(value)
           WHERE lower(btrim(retained_ref.value)) = lower(btrim(dependency.sales_order_ref))
        )
       JOIN transfer_orders transfer
         ON transfer.netsuite_id = dependency.transfer_order_id
       JOIN sales_orders sales
         ON sales.netsuite_id = dependency.sales_order_id
      WHERE dependency.dependency_mode = 'direct_to_customer'
        AND dependency.status = 'received_local'
        AND ($2::text IS NULL OR (
          (completion.dispatch_completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}')
            >= (($2 || '-01')::date)::timestamp
          AND (completion.dispatch_completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}')
            < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
        AND ($3::text IS NULL OR (
          completion.dispatch_completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}'
        )::date = $3::date)
        AND ($4::text IS NULL OR concat_ws(
          ' ', dependency.sales_order_ref, dependency.transfer_order_ref,
          dependency.source_location, dependency.planned_load_id,
          dependency.planned_load_name, transfer.from_location,
          sales.dispatch_address, receipt.job_details::text
        ) ILIKE '%' || $4 || '%')
        AND ($5::bigint[] IS NULL OR dependency.id = ANY($5::bigint[]))
      ORDER BY completion.dispatch_completed_at DESC, dependency.id DESC
      LIMIT $1`,
    [limit, completedMonthValue, completedDateValue, searchValue, recordIds]
  );
  return result.rows;
}

/**
 * Universal completion fallback. It admits completed orders whose source
 * status has not (or cannot) be updated, including audited manual recovery.
 * More specific Driver/dependency/reconciliation candidates win during
 * deduplication because they retain richer leg evidence.
 *
 * @param {number} limit
 * @param {string | null} completedMonthValue
 * @param {string | null} completedDateValue
 * @param {string | null} searchValue
 * @param {boolean} includeAllSalesMethods
 * @param {string[] | null} [completionEventIds]
 */
async function dispatchCompletionRows(
  limit,
  completedMonthValue,
  completedDateValue,
  searchValue,
  includeAllSalesMethods,
  completionEventIds = null
) {
  const result = await query(
    `SELECT completion.completion_event_id::text,
            completion.order_kind,
            completion.order_ref,
            completion.dispatch_completion_status,
            completion.dispatch_completed_at,
            completion.completion_evidence_type,
            completion.completion_evidence_id,
            completion.plan_id::text,
            completion.plan_date::text,
            completion.load_id,
            sales.outbound_location_id::text AS so_outbound_location_id,
            sales.outbound_location AS so_outbound_location,
            sales.dispatch_pickup_address AS so_dispatch_pickup_address,
            sales.dispatch_address AS so_dispatch_address,
            sales.sales_order_type AS so_sales_order_type,
            transfer.from_location_id::text AS to_from_location_id,
            transfer.from_location AS to_from_location,
            transfer.to_location_id::text AS to_to_location_id,
            transfer.to_location AS to_to_location,
            transfer.dispatch_pickup_address AS to_dispatch_pickup_address,
            transfer.dispatch_address AS to_dispatch_address,
            purchase.destination_location_id::text AS po_destination_location_id,
            purchase.destination_location AS po_destination_location,
            purchase.source_location AS po_source_location,
            purchase.dispatch_pickup_address AS po_dispatch_pickup_address,
            purchase.vendor_address AS po_vendor_address,
            purchase.dispatch_address AS po_dispatch_address,
            vrma.pickup_location AS vrma_pickup_location,
            vrma.dropoff_location AS vrma_dropoff_location,
            vrma_yard.address AS vrma_vendor_address,
            custom_order.pickup_location AS custom_pickup_location,
            custom_order.dropoff_location AS custom_dropoff_location,
            dependency.dependency_mode,
            dependency.sales_order_ref AS dependency_sales_order_ref
       FROM dispatch_order_completion_status completion
       LEFT JOIN LATERAL (
         SELECT retained.*
           FROM sales_orders retained
          WHERE completion.order_kind = 'SO'
            AND (
              lower(btrim(retained.tranid)) = lower(btrim(completion.order_ref))
              OR lower(regexp_replace(btrim(retained.tranid), '-S[0-9]+$', '', 'i'))
                = lower(btrim(completion.order_ref))
            )
          ORDER BY (lower(btrim(retained.tranid)) = lower(btrim(completion.order_ref))) DESC,
                   retained.netsuite_id DESC
          LIMIT 1
       ) sales ON true
       LEFT JOIN LATERAL (
         SELECT retained.*
           FROM transfer_orders retained
          WHERE completion.order_kind = 'TO'
            AND lower(btrim(retained.tranid)) = lower(btrim(completion.order_ref))
          ORDER BY retained.netsuite_id DESC
          LIMIT 1
       ) transfer ON true
       LEFT JOIN LATERAL (
         SELECT retained.*
           FROM purchase_orders retained
           LEFT JOIN dispatch_scm_po_splits split
             ON split.status = 'active'
            AND split.split_po_id = retained.netsuite_id
          WHERE completion.order_kind = 'PO'
            AND (
              lower(btrim(retained.tranid)) = lower(btrim(completion.order_ref))
              OR lower(btrim(COALESCE(retained.dispatch_ref, ''))) = lower(btrim(completion.order_ref))
              OR lower(btrim(COALESCE(retained.vendor_reference, ''))) = lower(btrim(completion.order_ref))
              OR lower(btrim(COALESCE(split.split_po_ref, ''))) = lower(btrim(completion.order_ref))
            )
          ORDER BY (lower(btrim(retained.tranid)) = lower(btrim(completion.order_ref))) DESC,
                   split.id DESC NULLS LAST,
                   retained.netsuite_id DESC
          LIMIT 1
       ) purchase ON true
       LEFT JOIN LATERAL (
         SELECT retained.*
           FROM scm_vrma_orders retained
          WHERE completion.order_kind = 'VRMA'
            AND lower(btrim(retained.vrma_ref)) = lower(btrim(completion.order_ref))
          ORDER BY retained.id DESC
          LIMIT 1
       ) vrma ON true
       LEFT JOIN LATERAL (
         SELECT yard.address
           FROM dispatch_vendor_yards yard
          WHERE vrma.id IS NOT NULL
            AND yard.active
            AND lower(btrim(yard.vendor)) = lower(btrim(COALESCE(vrma.local_vendor, vrma.vendor, '')))
            AND lower(btrim(yard.yard)) = lower(btrim(COALESCE(vrma.dropoff_location, '')))
          ORDER BY yard.id
          LIMIT 1
       ) vrma_yard ON true
       LEFT JOIN LATERAL (
         SELECT retained.*
           FROM dispatch_custom_orders retained
          WHERE completion.order_kind = 'CUSTOM'
            AND lower(btrim(retained.ref_number)) = lower(btrim(completion.order_ref))
          ORDER BY retained.id DESC
          LIMIT 1
       ) custom_order ON true
       LEFT JOIN LATERAL (
         SELECT retained.dependency_mode, retained.sales_order_ref
           FROM order_dependencies retained
          WHERE completion.order_kind = 'TO'
            AND lower(btrim(retained.transfer_order_ref)) = lower(btrim(completion.order_ref))
            AND retained.status <> 'cancelled'
          ORDER BY (retained.status = 'received_local') DESC, retained.id DESC
          LIMIT 1
       ) dependency ON true
      WHERE completion.dispatch_completion_status = 'completed'
        AND ($2::text IS NULL OR (
          (completion.dispatch_completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}')
            >= (($2 || '-01')::date)::timestamp
          AND (completion.dispatch_completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}')
            < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
        AND ($3::text IS NULL OR (
          completion.dispatch_completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}'
        )::date = $3::date)
        AND ($4::text IS NULL OR concat_ws(
          ' ', completion.order_kind, completion.order_ref,
          completion.load_id, sales.customer, sales.dispatch_address,
          transfer.from_location, transfer.to_location,
          purchase.vendor, purchase.destination_location,
          vrma.vendor, vrma.local_vendor, custom_order.order_details
        ) ILIKE '%' || $4 || '%')
        AND ($5::bigint[] IS NULL OR completion.completion_event_id = ANY($5::bigint[]))
        AND ($6::boolean
          OR completion.order_kind <> 'SO'
          OR lower(btrim(COALESCE(sales.sales_order_type, ''))) = 'delivery')
      ORDER BY completion.dispatch_completed_at DESC,
               completion.completion_event_id DESC
      LIMIT $1`,
    [
      limit,
      completedMonthValue,
      completedDateValue,
      searchValue,
      completionEventIds,
      includeAllSalesMethods
    ]
  );
  return result.rows;
}

/** @param {number} limit @param {string | null} completedMonthValue @param {string | null} completedDateValue @param {string | null} searchValue @param {string[] | null} [recordIds] */
async function reconciliationRows(limit, completedMonthValue, completedDateValue, searchValue, recordIds = null) {
  const result = await query(
    `SELECT state.id::text, state.order_kind, state.source_order_ref,
            state.source_location_id::text, state.source_location,
            state.destination_location_id::text, state.destination_location,
            state.order_snapshot,
            COALESCE(state.completed_at, state.reconciled_at, state.updated_at) AS completed_at,
            COALESCE(state.order_snapshot->>'dispatchPlanDate',
                     state.completed_at::date::text,
                     state.reconciled_at::date::text,
                     state.updated_at::date::text) AS plan_date,
            CASE WHEN state.order_kind = 'PO' THEN COALESCE(
                   NULLIF(purchase.dispatch_pickup_address, ''),
                   NULLIF(vendor_yard.address, ''),
                   NULLIF(purchase.dispatch_address, ''),
                   NULLIF(purchase.source_location, ''),
                   state.source_location
                 )
                 ELSE transfer.from_location END AS header_source_address,
            CASE WHEN state.order_kind = 'PO' THEN purchase.destination_location
                 ELSE transfer.to_location END AS header_destination_address
       FROM scm_reconciliation_order_state state
       LEFT JOIN purchase_orders purchase
         ON state.order_kind = 'PO'
        AND purchase.netsuite_id = state.source_order_netsuite_id
       LEFT JOIN transfer_orders transfer
         ON state.order_kind = 'TO'
        AND transfer.netsuite_id = state.source_order_netsuite_id
       LEFT JOIN LATERAL (
         SELECT yard.address
           FROM dispatch_vendor_yards yard
          WHERE state.order_kind = 'PO'
            AND yard.active
            AND lower(btrim(yard.yard)) = lower(btrim(COALESCE(
              NULLIF(purchase.dispatch_vendor_yard, ''),
              NULLIF(state.source_location, ''),
              purchase.source_location
            )))
          ORDER BY yard.id
          LIMIT 1
       ) vendor_yard ON true
      WHERE state.application_status = 'Completed'
        AND ($2::text IS NULL OR (
          (COALESCE(state.completed_at, state.reconciled_at, state.updated_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') >= (($2 || '-01')::date)::timestamp
          AND (COALESCE(state.completed_at, state.reconciled_at, state.updated_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
        AND ($3::text IS NULL OR (
          COALESCE(state.completed_at, state.reconciled_at, state.updated_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}'
        )::date = $3::date)
        AND ($4::text IS NULL OR concat_ws(
          ' ', state.source_order_ref, state.order_kind, state.source_location,
          state.destination_location, purchase.vendor, purchase.dispatch_vendor_yard,
          purchase.dispatch_address, transfer.from_location, transfer.to_location
        ) ILIKE '%' || $4 || '%')
        AND ($5::bigint[] IS NULL OR state.id = ANY($5::bigint[]))
      ORDER BY COALESCE(state.completed_at, state.reconciled_at, state.updated_at) DESC, state.id DESC
      LIMIT $1`,
    [limit, completedMonthValue, completedDateValue, searchValue, recordIds]
  );
  return result.rows;
}

/** @param {number} limit @param {string | null} completedMonthValue @param {string | null} completedDateValue @param {string | null} searchValue @param {boolean} includeAllMethods @param {string[] | null} [netsuiteIds] */
async function completedSalesOrderRows(
  limit,
  completedMonthValue,
  completedDateValue,
  searchValue,
  includeAllMethods,
  netsuiteIds = null
) {
  const result = await query(
    `SELECT netsuite_id::text, tranid, outbound_location_id::text,
            outbound_location, dispatch_pickup_address, dispatch_address,
            sales_order_type, customer,
            COALESCE(fulfilled_at, status_updated_at, synced_at) AS completed_at,
            COALESCE(dispatch_plan_date::text,
                     COALESCE(fulfilled_at, status_updated_at, synced_at)::date::text) AS plan_date
       FROM sales_orders
      WHERE (fulfillment_status = 'fulfilled' OR fulfilled_at IS NOT NULL)
        AND ($5::boolean OR lower(btrim(COALESCE(sales_order_type, ''))) = 'delivery')
        AND ($2::text IS NULL OR (
          (COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') >= (($2 || '-01')::date)::timestamp
          AND (COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
        AND ($3::text IS NULL OR (
          COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}'
        )::date = $3::date)
        AND ($4::text IS NULL OR concat_ws(
          ' ', tranid, customer, outbound_location, dispatch_pickup_address,
          dispatch_address, sales_order_type
        ) ILIKE '%' || $4 || '%')
        AND ($6::bigint[] IS NULL OR netsuite_id = ANY($6::bigint[]))
      ORDER BY COALESCE(fulfilled_at, status_updated_at, synced_at) DESC NULLS LAST,
               netsuite_id DESC
      LIMIT $1`,
    [limit, completedMonthValue, completedDateValue, searchValue, includeAllMethods, netsuiteIds]
  );
  return result.rows.filter((/** @type {Record<string, any>} */ row) => row.completed_at);
}

/** @param {string[]} references @param {string | null} completedMonthValue @param {string | null} completedDateValue @param {boolean} includeAllMethods */
async function completedSalesOrderGroupRows(
  references,
  completedMonthValue,
  completedDateValue,
  includeAllMethods
) {
  if (references.length === 0) {
    return [];
  }
  const result = await query(
    `SELECT netsuite_id::text, tranid, outbound_location_id::text,
            outbound_location, dispatch_pickup_address, dispatch_address,
            sales_order_type, customer,
            COALESCE(fulfilled_at, status_updated_at, synced_at) AS completed_at,
            COALESCE(dispatch_plan_date::text,
                     COALESCE(fulfilled_at, status_updated_at, synced_at)::date::text) AS plan_date
       FROM sales_orders
      WHERE (fulfillment_status = 'fulfilled' OR fulfilled_at IS NOT NULL)
        AND ($4::boolean OR lower(btrim(COALESCE(sales_order_type, ''))) = 'delivery')
        AND upper(btrim(tranid)) = ANY($1::text[])
        AND ($2::text IS NULL OR (
          (COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') >= (($2 || '-01')::date)::timestamp
          AND (COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
        AND ($3::text IS NULL OR (
          COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}'
        )::date = $3::date)
      ORDER BY COALESCE(fulfilled_at, status_updated_at, synced_at) DESC NULLS LAST,
               netsuite_id DESC`,
    [
      references.map((reference) => text(reference).toUpperCase()),
      completedMonthValue,
      completedDateValue,
      includeAllMethods
    ]
  );
  return result.rows.filter((/** @type {Record<string, any>} */ row) => row.completed_at);
}

/**
 * Collapse only authoritative plan-scoped delivery groups. Equal addresses
 * alone never group Sales Orders.
 *
 * @param {Array<Record<string, any>>} initialRows
 * @param {Array<Record<string, any>>} yards
 * @param {string | null} completedMonthValue
 * @param {string | null} completedDateValue
 * @param {boolean} includeAllMethods
 */
async function completedSalesOrderCandidates(
  initialRows,
  yards,
  completedMonthValue,
  completedDateValue,
  includeAllMethods
) {
  const references = initialRows.map((row) => text(row.tranid)).filter(Boolean);
  const planDates = [...new Set(initialRows.map((row) => text(row.plan_date)).filter(Boolean))];
  const availableGroups = await dispatchSalesOrderGroups(references, [], planDates);
  const selectedGroups = new Map();
  for (const row of initialRows) {
    const group = selectedSalesOrderGroup(availableGroups, text(row.tranid), {
      planDate: text(row.plan_date),
      allowActiveFallback: true
    });
    if (group) {
      selectedGroups.set(group.groupReference, group);
    }
  }
  const siblingReferences = [...selectedGroups.values()].flatMap((/** @type {Record<string, any>} */ group) =>
    group.members.map((/** @type {Record<string, any>} */ member) => member.rootReference)
  );
  const siblingRows = await completedSalesOrderGroupRows(
    siblingReferences,
    completedMonthValue,
    completedDateValue,
    includeAllMethods
  );
  const combinedById = new Map([...initialRows, ...siblingRows].map((row) => [text(row.netsuite_id), row]));
  const combined = [...combinedById.values()];
  const claimedReferences = new Set();
  const groupedCandidates = [];
  for (const group of selectedGroups.values()) {
    const groupRows = combined.filter((row) =>
      text(row.plan_date) === text(group.planDate)
      && group.members.some((/** @type {Record<string, any>} */ member) =>
        member.rootReference.toUpperCase() === text(row.tranid).toUpperCase()
      )
    );
    groupedCandidates.push(salesOrderGroupCandidate(group, groupRows, yards));
    for (const member of group.members) {
      claimedReferences.add(member.rootReference.toUpperCase());
    }
  }
  return [
    ...groupedCandidates,
    ...initialRows
      .filter((row) => !claimedReferences.has(text(row.tranid).toUpperCase()))
      .map((row) => salesOrderCandidate(row, yards))
  ];
}

/** @param {number} limit @param {string | null} completedMonthValue @param {string | null} completedDateValue @param {string | null} searchValue @param {string[] | null} [recordIds] */
async function completedCustomOrderRows(limit, completedMonthValue, completedDateValue, searchValue, recordIds = null) {
  const result = await query(
    `SELECT id::text, ref_number, pickup_location, dropoff_location,
            order_details, completed_at
       FROM dispatch_custom_orders
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND ($2::text IS NULL OR (
          (completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}') >= (($2 || '-01')::date)::timestamp
          AND (completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}') < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
        AND ($3::text IS NULL OR (completed_at AT TIME ZONE '${TORONTO_TIME_ZONE}')::date = $3::date)
        AND ($4::text IS NULL OR concat_ws(
          ' ', ref_number, pickup_location, dropoff_location, order_details
        ) ILIKE '%' || $4 || '%')
        AND ($5::bigint[] IS NULL OR id = ANY($5::bigint[]))
      ORDER BY completed_at DESC, id DESC
      LIMIT $1`,
    [limit, completedMonthValue, completedDateValue, searchValue, recordIds]
  );
  return result.rows;
}

/** @param {string[]} candidateIds */
async function storedAddressOverrides(candidateIds) {
  if (candidateIds.length === 0) {
    return new Map();
  }
  const result = await query(
    `SELECT candidate_id, source_system, source_record_id,
            destination_address_text, revision::int, updated_by, updated_at
       FROM mbt_mbbs_billing_address_overrides
      WHERE candidate_id = ANY($1::text[])`,
    [candidateIds]
  );
  return new Map(result.rows.map((/** @type {Record<string, any>} */ rawRow) => {
    const row = object(rawRow);
    return [text(row.candidate_id), {
      sourceSystem: text(row.source_system),
      sourceRecordId: text(row.source_record_id),
      destinationAddressText: text(row.destination_address_text),
      revision: Number(row.revision),
      updatedBy: text(row.updated_by),
      updatedAt: new Date(row.updated_at).toISOString()
    }];
  }));
}

/** @param {Record<string, any>} candidate @param {Record<string, any> | undefined} override */
function applyAddressOverride(candidate, override) {
  if (!override) {
    return { ...candidate, addressOverride: null };
  }
  if (override.sourceSystem !== candidate.sourceSystem || override.sourceRecordId !== candidate.sourceRecordId) {
    throw failure(409, "MBT_BILLING_ADDRESS_OVERRIDE_INVALID", "A retained billing address override no longer matches its completed order identity.");
  }
  const publicOverride = {
    destinationAddressText: override.destinationAddressText,
    revision: override.revision,
    updatedBy: override.updatedBy,
    updatedAt: override.updatedAt
  };
  if (!candidate.originLabel || array(candidate.references).length === 0) {
    return { ...candidate, addressOverride: publicOverride };
  }
  return {
    ...candidate,
    destinationLabel: override.destinationAddressText,
    routeStopCount: 2,
    dropCount: 1,
    chargeable: true,
    reason: null,
    automaticRateWarning: null,
    addressOverride: publicOverride,
    routeStops: [
      { sequenceNumber: 1, addressText: candidate.originLabel, stopType: "pickup" },
      { sequenceNumber: 2, addressText: override.destinationAddressText, stopType: "dropoff" }
    ],
    _routeStops: [
      { sequenceNumber: 1, addressText: candidate.originLabel, stopType: "pickup" },
      { sequenceNumber: 2, addressText: override.destinationAddressText, stopType: "dropoff" }
    ]
  };
}

/** @param {Record<string, any>} candidate */
function candidateCompletionReferences(candidate) {
  const members = array(candidate.memberReferences).map(object);
  const retained = members.length ? members : array(candidate.references).map(object);
  const found = new Map();
  for (const reference of retained) {
    const kind = sourceType(reference.sourceType);
    const root = text(reference.rootReference);
    if (!kind || !root) {
      continue;
    }
    found.set(`${kind}|${root.toUpperCase()}`, { orderKind: kind, orderRef: root });
  }
  return [...found.values()];
}

/**
 * Billing admission is based only on the universal Dispatch completion
 * projection. Source-specific candidate queries retain route/load detail but
 * cannot independently classify an order as completed.
 *
 * @param {Array<Record<string, any>>} items
 */
// eslint-disable-next-line complexity
async function canonicallyCompletedCandidates(items) {
  const requestedByKey = new Map();
  for (const candidate of items) {
    for (const reference of candidateCompletionReferences(candidate)) {
      requestedByKey.set(
        `${reference.orderKind}|${reference.orderRef.toUpperCase()}`,
        reference
      );
    }
  }
  const requested = [...requestedByKey.values()];
  if (requested.length === 0) {
    return [];
  }
  const result = await query(
    `WITH requested AS (
       SELECT upper(btrim(item->>'orderKind')) AS order_kind,
              upper(btrim(item->>'orderRef')) AS order_ref
         FROM jsonb_array_elements($1::jsonb) item
     )
     SELECT requested.order_kind AS requested_order_kind,
            requested.order_ref AS requested_order_ref,
            completion.completion_event_id::text,
            completion.order_ref AS retained_order_ref,
            completion.dispatch_completion_status,
            completion.dispatch_completed_at,
            completion.completion_evidence_type,
            completion.completion_evidence_id,
            completion.plan_id::text,
            completion.plan_date::text,
            completion.load_id
       FROM requested
       JOIN dispatch_order_completion_status completion
         ON completion.order_kind = requested.order_kind
        AND (
          upper(btrim(completion.order_ref)) = requested.order_ref
          OR (
            requested.order_kind = 'SO'
            AND upper(regexp_replace(btrim(completion.order_ref), '-S[0-9]+$', '', 'i'))
              = requested.order_ref
          )
        )
      WHERE completion.dispatch_completion_status = 'completed'
      ORDER BY requested.order_kind, requested.order_ref,
               completion.dispatch_completed_at DESC,
               completion.completion_event_id DESC`,
    [JSON.stringify(requested)]
  );
  const byKey = new Map();
  for (const rawRow of result.rows) {
    const row = object(rawRow);
    const key = `${text(row.requested_order_kind)}|${text(row.requested_order_ref)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        orderKind: text(row.requested_order_kind),
        orderRef: text(row.retained_order_ref),
        dispatchCompletionStatus: text(row.dispatch_completion_status),
        dispatchCompletedAt: new Date(row.dispatch_completed_at).toISOString(),
        completionEvidenceType: text(row.completion_evidence_type),
        completionEvidenceId: text(row.completion_evidence_id),
        completionEventId: text(row.completion_event_id),
        planId: text(row.plan_id) || null,
        planDate: text(row.plan_date) || null,
        loadId: text(row.load_id) || null
      });
    }
  }
  const completed = [];
  for (const candidate of items) {
    const references = candidateCompletionReferences(candidate);
    const evidence = references.map((reference) => byKey.get(
      `${reference.orderKind}|${reference.orderRef.toUpperCase()}`
    ));
    if (references.length === 0 || evidence.some((entry) => !entry)) {
      continue;
    }
    const retainedEvidence = /** @type {Array<Record<string, any>>} */ (evidence);
    const completedAt = retainedEvidence
      .map((entry) => entry.dispatchCompletedAt)
      .sort()
      .at(-1);
    const evidenceTypes = [...new Set(retainedEvidence.map((entry) => entry.completionEvidenceType))];
    const evidenceIds = [...new Set(retainedEvidence.map((entry) => entry.completionEvidenceId))];
    completed.push({
      ...candidate,
      // Canonical Dispatch completion is the billing-admission decision. A
      // missing retained route disables automatic pricing, not the operator's
      // guarded ability to enter and audit a manual final charge.
      chargeable: true,
      automaticRateWarning: candidate.chargeable === true ? null : candidate.reason || null,
      completedAt,
      dispatchCompletionStatus: "completed",
      dispatchCompletedAt: completedAt,
      completionEvidenceType: evidenceTypes.length === 1 ? evidenceTypes[0] : "multiple",
      completionEvidenceId: evidenceIds.length === 1
        ? evidenceIds[0]
        : stableId("mbt.billing.dispatch_completion_evidence", retainedEvidence),
      completionEventId: retainedEvidence.length === 1
        ? object(retainedEvidence[0]).completionEventId
        : null,
      completionEvidence: retainedEvidence
    });
  }
  return completed;
}

/** @param {Array<Record<string, any>> | null} candidateIdentities */
function selectedIdentityFilters(candidateIdentities) {
  if (!Array.isArray(candidateIdentities)) {
    return {
      targeted: false,
      identities: [],
      driver: null,
      directDependency: null,
      dispatchCompletion: null,
      reconciliation: null,
      salesOrder: null,
      customOrder: null
    };
  }
  /** @param {string} kind @param {string} key */
  const values = (kind, key) => candidateIdentities
    .filter((identity) => text(identity.kind) === kind)
    .map((identity) => text(identity[key]));
  return {
    targeted: true,
    identities: candidateIdentities,
    driver: candidateIdentities.filter((identity) => text(identity.kind) === "driver"),
    directDependency: values("direct_dependency", "recordId"),
    dispatchCompletion: values("dispatch_completion", "completionEventId"),
    reconciliation: values("reconciliation", "recordId"),
    salesOrder: values("sales_order", "netsuiteId"),
    customOrder: values("custom_order", "recordId")
  };
}

/** @param {Array<Record<string, any>>} items @param {boolean} includeOverrides */
async function retainedCandidatesWithOverrides(items, includeOverrides) {
  if (!includeOverrides) {
    return items.map((item) => ({ ...item, addressOverride: null }));
  }
  const overrides = await storedAddressOverrides(items.map((item) => item.candidateId));
  return items.map((item) => applyAddressOverride(item, overrides.get(item.candidateId)));
}

/**
 * @param {number} limit
 * @param {string | null} completedMonthValue
 * @param {{graphs?: Array<Record<string, any>>, includeOverrides?: boolean, truncate?: boolean, completedDateValue?: string | null, searchValue?: string | null, includeAllSalesMethods?: boolean, candidateIdentities?: Array<Record<string, any>> | null}} [options]
 */
async function internalCandidates(
  limit,
  completedMonthValue,
  {
    graphs,
    includeOverrides = true,
    truncate = true,
    completedDateValue = null,
    searchValue = null,
    includeAllSalesMethods = false,
    candidateIdentities = null
  } = {}
) {
  const rateGraphs = graphs || await activeMbbsRateGraphs();
  const selection = selectedIdentityFilters(candidateIdentities);
  const includeSalesMethods = includeAllSalesMethods || Boolean(searchValue);
  // These reads may execute inside an atomic conversion command, where one
  // PostgreSQL client must never receive overlapping queries.
  const yards = await activeYards();
  const driver = await driverRows(
    limit,
    completedMonthValue,
    completedDateValue,
    searchValue,
    selection.driver
  );
  const directDependencies = await directDependencyRows(
    limit,
    completedMonthValue,
    completedDateValue,
    searchValue,
    selection.directDependency
  );
  const dispatchCompletions = await dispatchCompletionRows(
    limit,
    completedMonthValue,
    completedDateValue,
    searchValue,
    includeSalesMethods,
    selection.dispatchCompletion
  );
  const reconciliation = await reconciliationRows(
    limit,
    completedMonthValue,
    completedDateValue,
    searchValue,
    selection.reconciliation
  );
  const salesOrders = await completedSalesOrderRows(
    limit,
    completedMonthValue,
    completedDateValue,
    searchValue,
    includeSalesMethods,
    selection.salesOrder
  );
  const customOrders = await completedCustomOrderRows(
    limit,
    completedMonthValue,
    completedDateValue,
    searchValue,
    selection.customOrder
  );
  const plannedDriverCandidates = await driverCandidates(driver, yards);
  const plannedDirectDependencyCandidates = directDependencies.map((/** @type {Record<string, any>} */ row) =>
    directDependencyCandidate(row, yards)
  );
  const universalDispatchCandidates = dispatchCompletions.map((/** @type {Record<string, any>} */ row) =>
    dispatchCompletionCandidate(row, yards)
  );
  const salesCandidates = await completedSalesOrderCandidates(
    salesOrders,
    yards,
    completedMonthValue,
    completedDateValue,
    includeSalesMethods
  );
  const retainedReconciliationCandidates = await reconciliationCandidates(reconciliation, yards);
  const driverReferenceKeys = new Set(plannedDriverCandidates.flatMap((candidate) =>
    [...array(candidate.references), ...array(candidate.memberReferences)].map((reference) => {
      const retained = object(reference);
      return `${text(retained.sourceType).toUpperCase()}|${text(retained.rootReference).toUpperCase()}`;
    })
  ));
  /** @param {Record<string, any>} candidate */
  const notCoveredByDriver = (candidate) => array(candidate.references).every((reference) => {
    const retained = object(reference);
    return !driverReferenceKeys.has(
      `${text(retained.sourceType).toUpperCase()}|${text(retained.rootReference).toUpperCase()}`
    );
  });
  const retainedDirectDependencyCandidates = plannedDirectDependencyCandidates.filter(notCoveredByDriver);
  const directDependencyReferenceKeys = new Set(retainedDirectDependencyCandidates.flatMap((/** @type {Record<string, any>} */ candidate) =>
    array(candidate.references).map((reference) => {
      const retained = object(reference);
      return `${text(retained.sourceType).toUpperCase()}|${text(retained.rootReference).toUpperCase()}`;
    })
  ));
  /** @param {Record<string, any>} candidate */
  const notCoveredByDirectDependency = (candidate) => array(candidate.references).every((reference) => {
    const retained = object(reference);
    return !directDependencyReferenceKeys.has(
      `${text(retained.sourceType).toUpperCase()}|${text(retained.rootReference).toUpperCase()}`
    );
  });
  const specificItems = [
    ...plannedDriverCandidates,
    ...retainedDirectDependencyCandidates,
    ...retainedReconciliationCandidates.filter(notCoveredByDriver).filter(notCoveredByDirectDependency),
    ...salesCandidates.filter(notCoveredByDriver),
    ...customOrders.map((/** @type {Record<string, any>} */ row) => customOrderCandidate(row))
  ];
  const specificReferenceKeys = new Set(specificItems.flatMap((candidate) =>
    [...array(candidate.references), ...array(candidate.memberReferences)].map((reference) => {
      const retained = object(reference);
      return `${text(retained.sourceType).toUpperCase()}|${text(retained.rootReference).toUpperCase()}`;
    })
  ));
  const uncoveredUniversalItems = universalDispatchCandidates.filter((/** @type {Record<string, any>} */ candidate) =>
    [...array(candidate.references), ...array(candidate.memberReferences)].every((reference) => {
      const retained = object(reference);
      return !specificReferenceKeys.has(
        `${text(retained.sourceType).toUpperCase()}|${text(retained.rootReference).toUpperCase()}`
      );
    })
  );
  let items = [...specificItems, ...uncoveredUniversalItems];
  items = await canonicallyCompletedCandidates(items);
  items = await retainedCandidatesWithOverrides(items, includeOverrides);
  items.sort((left, right) => Number(
    right.chargeable === true && !text(right.automaticRateWarning)
  ) - Number(left.chargeable === true && !text(left.automaticRateWarning))
    || Number(right.chargeable) - Number(left.chargeable)
    || right.completedAt.localeCompare(left.completedAt)
    || left.candidateId.localeCompare(right.candidateId));
  if (selection.targeted) {
    const selectedIds = new Set(selection.identities.map(candidateId));
    items = items.filter((item) => selectedIds.has(item.candidateId));
  }
  return { graphs: rateGraphs, items: truncate ? items.slice(0, limit) : items };
}

/** @param {Record<string, any>} candidate */
function publicCandidate(candidate) {
  const { _routeStops, _identity, ...result } = candidate;
  return { ...result, addressOverride: result.addressOverride || null };
}

/**
 * Resolve opaque selections by their server-owned source identities instead of
 * reusing a paginated candidate list. Completion filters are still enforced.
 *
 * @param {string[]} ids
 * @param {string | null} month
 * @param {{graphs: Array<Record<string, any>>, completedDateValue?: string | null, includeOverrides?: boolean}} options
 */
async function selectedCandidateItems(ids, month, options) {
  const identities = ids.map(decodedCandidateId);
  const { items } = await internalCandidates(MAX_CANDIDATES, month, {
    graphs: options.graphs,
    completedDateValue: options.completedDateValue || null,
    includeAllSalesMethods: true,
    includeOverrides: options.includeOverrides !== false,
    truncate: false,
    candidateIdentities: identities
  });
  return items;
}

/**
 * Read completed operational evidence only. This function performs no
 * mutation and intentionally does not create a completed-load snapshot.
 *
 * @param {unknown} rawInput
 */
export async function listMbbsBillingCandidates(rawInput) {
  const input = object(rawInput);
  billingActor(input.actor);
  const limit = candidateLimit(input.limit);
  const month = completedMonth(input.completedMonth);
  const day = completedDay(input.completedDate);
  const searchValue = candidateSearch(input.search);
  assertCompatibleCompletionFilters(month, day);
  const { graphs, items } = await internalCandidates(limit, month, {
    completedDateValue: day,
    searchValue
  });
  const soleGraph = graphs.length === 1 ? graphs[0] : null;
  return {
    schemaVersion: "mbbs-billing-candidates-v2",
    postingMode: "local_only_preview",
    completedMonth: month,
    completedDate: day,
    search: searchValue,
    searchMode: searchValue ? "database" : "default_delivery",
    rateCardVersionId: soleGraph?.rateCardVersionId || null,
    currency: soleGraph?.currency || null,
    rateOptions: rateOptions(graphs),
    items: items.map(publicCandidate)
  };
}

/**
 * Search the canonical local customer master used by durable billing. The
 * search is intentionally explicit; a rate card may suggest a customer, but
 * conversion never guesses an unrelated customer from order text.
 *
 * @param {unknown} rawInput
 */
export async function searchMbbsBillingCustomers(rawInput) {
  const input = object(rawInput);
  billingActor(input.actor);
  const searchValue = customerSearch(input.search);
  const limit = customerLimit(input.limit);
  const result = await query(
    `SELECT netsuite_id::text, entity_number, legal_name, display_name,
            currency, terms, tax_status
       FROM netsuite_customers
      WHERE active
        AND currency = 'CAD'
        AND concat_ws(' ', netsuite_id::text, entity_number, legal_name, display_name)
            ILIKE '%' || $1 || '%'
      ORDER BY CASE
                 WHEN lower(entity_number) = lower($1) THEN 0
                 WHEN netsuite_id::text = $1 THEN 1
                 WHEN lower(display_name) = lower($1) THEN 2
                 ELSE 3
               END,
               lower(display_name), netsuite_id
      LIMIT $2`,
    [searchValue, limit]
  );
  return {
    schemaVersion: "mbbs-billing-customer-search-v1",
    search: searchValue,
    items: result.rows.map((/** @type {Record<string, any>} */ row) => ({
      netsuiteId: text(row.netsuite_id),
      entityNumber: text(row.entity_number),
      legalName: text(row.legal_name),
      displayName: text(row.display_name),
      currency: text(row.currency),
      terms: row.terms === null ? null : text(row.terms),
      taxStatus: row.tax_status === null ? null : text(row.tax_status)
    }))
  };
}

/** @param {unknown} dependencies */
function distanceResolver(dependencies) {
  const selected = object(dependencies).resolveDistance;
  if (typeof selected !== "function") {
    throw failure(503, "MBT_MBBS_DISTANCE_UNAVAILABLE", "Server distance pricing is not configured.");
  }
  return selected;
}

/** @param {Array<Record<string, any>>} references @param {number} totalMinor */
function equalAllocationPreview(references, totalMinor) {
  if (references.length === 0) {
    return [];
  }
  const ordered = [...references].sort((left, right) =>
    text(left.sourceType).localeCompare(text(right.sourceType))
      || text(left.rootReference).localeCompare(text(right.rootReference))
  );
  const base = Math.floor(totalMinor / ordered.length);
  const remainder = totalMinor - (base * ordered.length);
  return ordered.map((reference, index) => ({
    sourceType: text(reference.sourceType),
    rootReference: text(reference.rootReference),
    amountMinor: index === ordered.length - 1 ? base + remainder : base,
    remainderMinor: index === ordered.length - 1 ? remainder : 0
  }));
}

/** @param {Record<string, any>} candidate @param {Record<string, any>} graph @param {Function} resolveDistance */
// eslint-disable-next-line complexity
async function calculateCandidate(candidate, graph, resolveDistance) {
  if (!candidate.chargeable) {
    throw failure(422, "MBT_BILLING_CANDIDATE_INCOMPLETE", candidate.reason || "The completed MBBS candidate is incomplete.");
  }
  const stops = array(candidate._routeStops).map(object);
  if (stops.length < 2
      || stops.some((stop) => !text(stop.addressText))
      || !stops.some((stop) => text(stop.stopType).toLowerCase() === "dropoff")) {
    throw failure(
      422,
      "MBT_MBBS_DISTANCE_UNAVAILABLE",
      candidate.reason || "The completed order has no complete retained route for automatic pricing."
    );
  }
  let distanceMetres = 0;
  const routeEvidence = [];
  for (let index = 1; index < stops.length; index += 1) {
    const origin = stops[index - 1];
    const destination = stops[index];
    if (!origin || !destination) {
      throw failure(422, "MBT_BILLING_CANDIDATE_INCOMPLETE", "The completed route has a missing stop.");
    }
    const raw = object(await resolveDistance(index === 1 && candidate.originYardCode
      ? { originYardCode: candidate.originYardCode, destinationAddressText: destination.addressText }
      : { originAddressText: origin.addressText, destinationAddressText: destination.addressText }));
    const segmentMetres = Number(raw.providerMetres);
    if (!Number.isSafeInteger(segmentMetres) || segmentMetres < 0) {
      throw failure(422, "MBT_FRONTDESK_DISTANCE_INVALID", "The server distance resolver returned an invalid route segment.");
    }
    const nextDistance = distanceMetres + segmentMetres;
    if (!Number.isSafeInteger(nextDistance)) {
      throw failure(422, "MBT_FRONTDESK_DISTANCE_INVALID", "The completed route distance exceeds the supported range.");
    }
    distanceMetres = nextDistance;
    routeEvidence.push({
      sequenceNumber: index,
      provider: text(raw.provider),
      providerMetres: segmentMetres,
      routeHash: text(raw.routeHash),
      originAddressText: text(origin.addressText),
      destinationAddressText: text(destination.addressText),
      originSnapshot: object(raw.originSnapshot),
      destinationSnapshot: object(raw.destinationSnapshot),
      routeSnapshot: object(raw.routeSnapshot)
    });
  }
  const selected = /** @type {MbbsRateBand | undefined} */ (selectRateBand(graph.bands, distanceMetres));
  if (!selected) {
    throw failure(409, "MBT_MBBS_RATE_UNAVAILABLE", "The active MBBS rate graph does not cover this completed route.");
  }
  const rateAmountMinor = calculateDistanceBandChargeMinor(selected, distanceMetres);
  const amount = calculateBillingUnitAmount({
    billingRule: text(candidate.billingRule) || "reconciliation",
    distanceBandAmountMinor: rateAmountMinor,
    dropCount: Number(candidate.dropCount || stops.filter((stop) => text(stop.stopType) === "dropoff").length)
  });
  const allocationPreview = text(candidate.billingRule) === "po_shared_leg"
    ? equalAllocationPreview(array(candidate.references).map(object), amount.calculatedAmountMinor)
    : array(candidate.references).map((reference) => ({
        sourceType: text(object(reference).sourceType),
        rootReference: text(object(reference).rootReference),
        amountMinor: amount.calculatedAmountMinor,
        remainderMinor: 0
      }));
  const calculationSteps = [
    ...routeEvidence.map((segment) => ({
      code: "route_segment",
      description: `${segment.originAddressText} → ${segment.destinationAddressText}: ${segment.providerMetres} m`,
      distanceMetres: segment.providerMetres,
      amountMinor: null
    })),
    {
      code: "distance_rate",
      description: `Distance-band charge for ${distanceMetres} m`,
      distanceMetres,
      amountMinor: amount.distanceBandAmountMinor
    },
    ...(amount.additionalDropCount > 0 ? [{
      code: "additional_drop",
      description: `${amount.additionalDropCount} additional drop(s) × CAD 100.00`,
      distanceMetres: null,
      amountMinor: amount.additionalDropFeeMinor
    }] : []),
    {
      code: "billing_policy",
      description: text(object(candidate.relationship).summary) || text(candidate.billingRule),
      distanceMetres: null,
      amountMinor: amount.calculatedAmountMinor
    },
    ...allocationPreview.map((allocation) => ({
      code: "allocation",
      description: `${allocation.sourceType} ${allocation.rootReference}: exact-cent allocation`,
      distanceMetres: null,
      amountMinor: allocation.amountMinor
    })),
    {
      code: "final_charge",
      description: "Calculated charge + adjustment = final charge",
      distanceMetres: null,
      amountMinor: amount.calculatedAmountMinor
    }
  ].map((step, index) => ({ stepNumber: index + 1, ...step }));
  return {
    candidate: publicCandidate(candidate),
    rateCardVersionId: graph.rateCardVersionId,
    rateCardVersionNumber: graph.versionNumber,
    distanceMetres,
    routeEvidence,
    selectedBand: {
      rateDistanceBandId: selected.rateDistanceBandId,
      minimumMetres: selected.minimumMetres,
      maximumMetres: selected.maximumMetres,
      pricingBasis: selected.pricingBasis,
      boundaryRule: selected.boundaryRule,
      unitAmountMinor: selected.amountMinor
    },
    calculationBreakdown: {
      billingRule: text(candidate.billingRule),
      distanceBandAmountMinor: amount.distanceBandAmountMinor,
      additionalDropCount: amount.additionalDropCount,
      additionalDropFeeMinor: amount.additionalDropFeeMinor,
      calculatedAmountMinor: amount.calculatedAmountMinor,
      allocationPreview
    },
    calculationSteps,
    charge: {
      itemCode: selected.itemCode,
      calculatedAmountMinor: amount.calculatedAmountMinor,
      adjustmentMinor: 0,
      finalAmountMinor: amount.calculatedAmountMinor,
      amountMinor: amount.calculatedAmountMinor,
      currency: graph.currency,
      estimatedTaxMinor: 0,
      totalMinor: amount.calculatedAmountMinor
    }
  };
}

/** @param {unknown} error */
function manualRateFailure(error) {
  const retained = /** @type {Record<string, any>} */ (error && typeof error === "object" ? error : {});
  const suppliedCode = text(retained.code);
  const message = text(retained.message);
  if (!(error instanceof MbtError) && !suppliedCode
      && !/(?:route|distance|driving|geocod|address|network|fetch|timeout)/iu.test(message)) {
    return null;
  }
  const code = suppliedCode || "MBT_MBBS_DISTANCE_LOOKUP_FAILED";
  if ([
    "MBT_BILLING_CANDIDATE_INCOMPLETE",
    "MBT_FRONTDESK_DISTANCE_INVALID",
    "MBT_BILLING_ROUTE_INVALID"
  ].includes(code)) {
    return null;
  }
  if (error instanceof MbtError && ![
    "MBT_MBBS_RATE_UNAVAILABLE",
    "MBT_MBBS_DISTANCE_UNAVAILABLE",
    "MBT_MBBS_DISTANCE_LOOKUP_FAILED"
  ].includes(code)) {
    return null;
  }
  return {
    available: false,
    code,
    message: message || "No automatic driving route or MBBS rate is available for this completed order."
  };
}

/** @param {Record<string, any>} candidate @param {Record<string, any>} graph @param {Record<string, any>} automaticRate */
function manualRateCalculation(candidate, graph, automaticRate) {
  const allocationPreview = text(candidate.billingRule) === "po_shared_leg"
    ? equalAllocationPreview(array(candidate.references).map(object), 0)
    : array(candidate.references).map((reference) => ({
        sourceType: text(object(reference).sourceType),
        rootReference: text(object(reference).rootReference),
        amountMinor: 0,
        remainderMinor: 0
      }));
  const calculationSteps = [
    {
      code: "automatic_rate_unavailable",
      description: `${automaticRate.code}: ${automaticRate.message}`,
      distanceMetres: null,
      amountMinor: 0
    },
    {
      code: "billing_policy",
      description: text(object(candidate.relationship).summary) || text(candidate.billingRule),
      distanceMetres: null,
      amountMinor: 0
    },
    ...allocationPreview.map((allocation) => ({
      code: "allocation",
      description: `${allocation.sourceType} ${allocation.rootReference}: exact-cent allocation`,
      distanceMetres: null,
      amountMinor: 0
    })),
    {
      code: "final_charge",
      description: "Calculated charge + adjustment = final charge",
      distanceMetres: null,
      amountMinor: 0
    }
  ].map((step, index) => ({ stepNumber: index + 1, ...step }));
  return {
    candidate: publicCandidate(candidate),
    rateCardVersionId: graph.rateCardVersionId,
    rateCardVersionNumber: graph.versionNumber,
    distanceMetres: 0,
    distanceAvailable: false,
    routeEvidence: [],
    selectedBand: null,
    automaticRate,
    calculationBreakdown: {
      billingRule: text(candidate.billingRule),
      distanceBandAmountMinor: 0,
      additionalDropCount: 0,
      additionalDropFeeMinor: 0,
      calculatedAmountMinor: 0,
      allocationPreview,
      automaticRate
    },
    calculationSteps,
    charge: {
      itemCode: "DELIVERY_CHARGE_MBBS",
      calculatedAmountMinor: 0,
      adjustmentMinor: 0,
      finalAmountMinor: 0,
      amountMinor: 0,
      currency: graph.currency,
      estimatedTaxMinor: 0,
      totalMinor: 0
    }
  };
}

/** @param {Record<string, any>} candidate @param {Record<string, any>} graph @param {Function} resolveDistance */
async function calculateCandidateWithManualRate(candidate, graph, resolveDistance) {
  try {
    return {
      ...await calculateCandidate(candidate, graph, resolveDistance),
      automaticRate: { available: true, code: null, message: null },
      distanceAvailable: true
    };
  } catch (error) {
    const automaticRate = manualRateFailure(error);
    if (!automaticRate || candidate.chargeable !== true) {
      throw error;
    }
    return manualRateCalculation(candidate, graph, automaticRate);
  }
}

/** @param {Record<string, any>} calculation @param {Record<string, any> | undefined} edit @param {string} editorId */
function applyManualAmountEdit(calculation, edit, editorId) {
  const charge = object(calculation.charge);
  const serverCalculatedAmountMinor = Number(charge.calculatedAmountMinor);
  if (!Number.isSafeInteger(serverCalculatedAmountMinor) || serverCalculatedAmountMinor < 0) {
    throw failure(409, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", "The server calculation has invalid monetary evidence.");
  }
  if (edit && Number(edit.calculatedAmountMinor) !== serverCalculatedAmountMinor) {
    throw failure(
      409,
      "MBT_BILLING_MANUAL_AMOUNT_STALE",
      "The calculated charge changed after it was edited. Recalculate the batch before creating billing cases."
    );
  }
  if (object(calculation.automaticRate).available === false && !edit) {
    throw failure(
      422,
      "MBT_BILLING_MANUAL_RATE_REQUIRED",
      "Enter and confirm a final charge before converting an order without an automatic rate."
    );
  }
  const manualAmount = resolveManualBillingAmount({
    calculatedAmountMinor: serverCalculatedAmountMinor,
    adjustmentMinor: edit ? edit.adjustmentMinor : 0,
    finalAmountMinor: edit ? edit.finalAmountMinor : serverCalculatedAmountMinor
  });
  const steps = array(calculation.calculationSteps).map(object)
    .filter((step) => !["allocation", "manual_adjustment", "final_charge"].includes(text(step.code)));
  if (manualAmount.adjustmentMinor !== 0) {
    steps.push({
      code: "manual_adjustment",
      description: `Audited signed adjustment by ${editorId}`,
      distanceMetres: null,
      amountMinor: manualAmount.adjustmentMinor
    });
  }
  const candidate = object(calculation.candidate);
  const finalAllocations = text(candidate.billingRule) === "po_shared_leg"
    ? equalAllocationPreview(array(candidate.references).map(object), manualAmount.finalAmountMinor)
    : array(candidate.references).map((reference) => ({
        sourceType: text(object(reference).sourceType),
        rootReference: text(object(reference).rootReference),
        amountMinor: manualAmount.finalAmountMinor,
        remainderMinor: 0
      }));
  for (const allocation of finalAllocations) {
    steps.push({
      code: "allocation",
      description: `${allocation.sourceType} ${allocation.rootReference}: final exact-cent allocation`,
      distanceMetres: null,
      amountMinor: allocation.amountMinor
    });
  }
  steps.push({
    code: "final_charge",
    description: "Calculated charge + adjustment = final charge",
    distanceMetres: null,
    amountMinor: manualAmount.finalAmountMinor
  });
  return {
    ...calculation,
    manualAmount: {
      ...manualAmount,
      edited: manualAmount.adjustmentMinor !== 0,
      editorId
    },
    calculationSteps: steps.map((step, index) => ({ ...step, stepNumber: index + 1 })),
    calculationBreakdown: {
      ...object(calculation.calculationBreakdown),
      ...manualAmount,
      allocationPreview: finalAllocations
    },
    charge: {
      ...charge,
      ...manualAmount,
      amountMinor: manualAmount.finalAmountMinor,
      totalMinor: manualAmount.finalAmountMinor
    }
  };
}

/**
 * Resolve one opaque server-owned candidate and calculate it from the selected
 * active MBBS graph. This preview performs no writes.
 *
 * @param {unknown} rawInput
 * @param {{resolveDistance: Function}} dependencies
 */
export async function previewMbbsBillingCandidate(rawInput, dependencies) {
  const input = object(rawInput);
  billingActor(input.actor);
  const identity = decodedCandidateId(input.candidateId);
  const month = completedMonth(input.completedMonth);
  const day = completedDay(input.completedDate);
  assertCompatibleCompletionFilters(month, day);
  const resolveDistance = distanceResolver(dependencies);
  const graphs = await activeMbbsRateGraphs();
  const graph = selectedRateGraph(graphs, input.rateCardVersionId);
  const encoded = candidateId(identity);
  const items = await selectedCandidateItems([encoded], month, {
    graphs,
    completedDateValue: day
  });
  const candidate = items.find((item) => item.candidateId === encoded);
  if (!candidate) {
    throw failure(404, "MBT_BILLING_CANDIDATE_NOT_FOUND", "The completed MBBS billing candidate is unavailable.");
  }
  return {
    schemaVersion: "mbbs-billing-candidate-preview-v1",
    postingMode: "local_only_preview",
    externalWork: null,
    ...await calculateCandidateWithManualRate(/** @type {Record<string, any>} */ (candidate), graph, resolveDistance)
  };
}

/** @param {unknown} error */
function batchFailure(error) {
  if (error instanceof MbtError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "MBT_MBBS_DISTANCE_LOOKUP_FAILED",
    message: "The retained route could not be resolved for this completed order."
  };
}

/** @param {unknown[]} values @param {number} concurrency @param {(value: any, index: number) => Promise<any>} operation */
async function mapConcurrently(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker()
  ));
  return results;
}

/**
 * Calculate one selected completion-month batch using one explicitly selected
 * active rate version. A failure is retained on its own row and does not hide
 * successful calculations. This preview performs no writes.
 *
 * @param {unknown} rawInput
 * @param {{resolveDistance: Function}} dependencies
 */
export async function previewMbbsBillingCandidatesBatch(rawInput, dependencies) {
  const input = object(rawInput);
  billingActor(input.actor);
  const ids = batchCandidateIds(input.candidateIds);
  const month = completedMonth(input.completedMonth, { required: true });
  const day = completedDay(input.completedDate);
  assertCompatibleCompletionFilters(month, day);
  const resolveDistance = distanceResolver(dependencies);
  const graphs = await activeMbbsRateGraphs();
  const graph = selectedRateGraph(graphs, input.rateCardVersionId, { explicit: true });
  const items = await selectedCandidateItems(ids, month, {
    graphs,
    completedDateValue: day
  });
  const byId = new Map(items.map((candidate) => [candidate.candidateId, candidate]));
  const results = await mapConcurrently(ids, BATCH_DISTANCE_CONCURRENCY, async (id) => {
    try {
      const candidate = byId.get(id);
      if (!candidate) {
        throw failure(404, "MBT_BILLING_CANDIDATE_NOT_FOUND", "The completed MBBS billing candidate is unavailable in the selected month.");
      }
      return {
        candidateId: id,
        ...await calculateCandidateWithManualRate(/** @type {Record<string, any>} */ (candidate), graph, resolveDistance)
      };
    } catch (error) {
      return { candidateId: id, status: "failed", error: batchFailure(error) };
    }
  });
  for (const result of results) {
    if (!result.status) {
      result.status = object(result.automaticRate).available === false ? "manual_required" : "calculated";
    }
  }
  const successCount = results.filter((result) => ["calculated", "manual_required"].includes(result.status)).length;
  const manualRequiredCount = results.filter((result) => result.status === "manual_required").length;
  return {
    schemaVersion: "mbbs-billing-candidate-batch-preview-v1",
    postingMode: "local_only_preview",
    externalWork: null,
    completedMonth: month,
    completedDate: day,
    rateCardVersionId: graph.rateCardVersionId,
    requestedCount: ids.length,
    successCount,
    manualRequiredCount,
    failureCount: ids.length - successCount,
    results
  };
}

/** @param {unknown} value @param {string} code @param {string} message @param {number} maximum @param {number} [minimum] */
function requiredBoundedText(value, code, message, maximum, minimum = 1) {
  const normalized = text(value);
  if (normalized.length < minimum || normalized.length > maximum) {
    throw failure(400, code, message);
  }
  return normalized;
}

/** @param {unknown} value */
function expectedAddressRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw failure(400, "MBT_BILLING_ADDRESS_OVERRIDE_REVISION_INVALID", "The billing address revision must be a non-negative integer.");
  }
  return revision;
}

/** @param {unknown} value @param {string} label */
function nonnegativeSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw failure(422, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", `${label} must be a non-negative safe integer.`);
  }
  return parsed;
}

/** @param {unknown} value @param {string} label */
function signedSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw failure(422, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", `${label} must be a signed safe integer.`);
  }
  return parsed;
}

/** @param {Record<string, any>} candidate */
function candidateSnapshotIdentity(candidate) {
  const addressRevision = Number(object(candidate.addressOverride).revision || 0);
  if (!Number.isSafeInteger(addressRevision) || addressRevision < 0) {
    throw failure(409, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", "The billing address evidence has an invalid revision.");
  }
  const identity = {
    candidateId: text(candidate.candidateId),
    sourceSystem: text(candidate.sourceSystem),
    sourceRecordId: text(candidate.sourceRecordId),
    sourcePlanRevision: addressRevision + 1,
    physicalLoadId: text(candidate.physicalLoadId)
  };
  if (Object.values(identity).includes("")) {
    throw failure(409, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", "The completed order has an incomplete source identity.");
  }
  return identity;
}

/** @param {Record<string, any>} candidate */
function candidateSnapshotReferences(candidate) {
  const references = array(candidate.references).map((rawReference) => {
    const reference = object(rawReference);
    const type = sourceType(reference.sourceType);
    const root = text(reference.rootReference);
    if (!type || !root) {
      throw failure(409, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", "The completed order has an invalid billing reference.");
    }
    return { sourceType: type, rootReference: root };
  });
  if (references.length === 0) {
    throw failure(409, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", "The completed order has no billing references.");
  }
  return references;
}

/** @param {Record<string, any>} calculation */
function candidateSnapshotEvidence(calculation) {
  const candidate = object(calculation.candidate);
  if (text(candidate.dispatchCompletionStatus) !== "completed") {
    throw failure(
      409,
      "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID",
      "The selected order no longer has canonical completed Dispatch status."
    );
  }
  const completedAtDate = new Date(text(candidate.dispatchCompletedAt));
  if (!Number.isFinite(completedAtDate.getTime())) {
    throw failure(409, "MBT_BILLING_CANDIDATE_EVIDENCE_INVALID", "The completed order has an invalid completion time.");
  }
  const completedAt = completedAtDate.toISOString();
  const planDate = completedDay(candidate.planDate) || torontoCalendarDate(completedAt);
  const references = candidateSnapshotReferences(candidate);
  const identity = candidateSnapshotIdentity(candidate);
  const completedLoadSnapshotId = stableId("mbt.billing.candidate.completed_load", identity);
  const calculatedMetres = nonnegativeSafeInteger(calculation.distanceMetres, "Calculated route distance");
  const charge = object(calculation.charge);
  const sharedTotalMinor = nonnegativeSafeInteger(charge.amountMinor, "Calculated MBBS charge");
  if (text(charge.currency).toUpperCase() !== "CAD") {
    throw failure(409, "MBT_BILLING_CURRENCY_MISMATCH", "Durable MBBS candidate billing requires CAD evidence.");
  }
  const sourceSnapshot = canonicalize({
    schemaVersion: "mbbs-billing-candidate-snapshot-v2",
    completed: true,
    completedLoadSnapshotId,
    physicalLoadId: identity.physicalLoadId,
    completedAt,
    planDate,
    candidate: publicCandidate(candidate),
    calculatedMetres,
    distanceAvailable: calculation.distanceAvailable !== false,
    routeEvidence: array(calculation.routeEvidence),
    calculationSteps: array(calculation.calculationSteps),
    calculationBreakdown: object(calculation.calculationBreakdown),
    manualAmount: object(calculation.manualAmount),
    rateCardVersionId: text(calculation.rateCardVersionId),
    selectedBand: object(calculation.selectedBand),
    automaticRate: object(calculation.automaticRate),
    charge: {
      itemCode: text(charge.itemCode),
      calculatedAmountMinor: nonnegativeSafeInteger(charge.calculatedAmountMinor, "Calculated MBBS charge"),
      adjustmentMinor: signedSafeInteger(charge.adjustmentMinor, "Manual MBBS adjustment"),
      finalAmountMinor: sharedTotalMinor,
      amountMinor: sharedTotalMinor,
      currency: "CAD"
    }
  });
  return {
    identity,
    completedLoadSnapshotId,
    completedAt,
    planDate,
    references,
    calculatedMetres,
    sharedTotalMinor,
    sourceSnapshot,
    snapshotHash: canonicalSha256(sourceSnapshot)
  };
}

/** @param {Record<string, any> | null} row @param {ReturnType<typeof candidateSnapshotEvidence>} evidence */
function retainedCandidateSnapshotMatches(row, evidence) {
  if (!row) {
    return false;
  }
  const equalValues = [
    [text(row.completed_load_snapshot_id), evidence.completedLoadSnapshotId],
    [Number(row.calculated_metres), evidence.calculatedMetres],
    [Number(row.shared_total_minor), evidence.sharedTotalMinor],
    [text(row.currency), "CAD"],
    [text(row.source_snapshot_hash), evidence.snapshotHash],
    [canonicalSha256(row.source_references), canonicalSha256(evidence.references)],
    [canonicalSha256(row.source_snapshot), evidence.snapshotHash]
  ];
  return equalValues.every(([actual, expected]) => actual === expected);
}

/** @param {Record<string, any>} calculation @param {{operatorId: string}} actor */
async function freezeCandidateCalculation(calculation, actor) {
  const evidence = candidateSnapshotEvidence(calculation);
  await query(
    `INSERT INTO mbt_mbbs_completed_load_snapshots (
       completed_load_snapshot_id, source_system, source_plan_id,
       source_plan_revision, plan_date, physical_load_id, completed_at,
       truck_id, driver_id, calculated_metres, shared_total_minor, currency,
       source_references, source_snapshot, source_snapshot_hash, created_by
     ) VALUES (
       $1, 'billing_candidate', $2, $3, $4::date, $5, $6::timestamptz,
       NULL, NULL, $7, $8, 'CAD', $9::jsonb, $10::jsonb, $11, $12
     ) ON CONFLICT DO NOTHING`,
    [
      evidence.completedLoadSnapshotId,
      evidence.identity.candidateId,
      evidence.identity.sourcePlanRevision,
      evidence.planDate,
      evidence.identity.physicalLoadId,
      evidence.completedAt,
      evidence.calculatedMetres,
      evidence.sharedTotalMinor,
      JSON.stringify(evidence.references),
      JSON.stringify(evidence.sourceSnapshot),
      evidence.snapshotHash,
      actor.operatorId
    ]
  );
  const retained = await query(
    `SELECT completed_load_snapshot_id::text, calculated_metres::text,
            shared_total_minor::text, currency, source_references,
            source_snapshot, source_snapshot_hash
       FROM mbt_mbbs_completed_load_snapshots
      WHERE source_system = 'billing_candidate'
        AND source_plan_id = $1
        AND source_plan_revision = $2
        AND physical_load_id = $3
      FOR SHARE`,
    [
      evidence.identity.candidateId,
      evidence.identity.sourcePlanRevision,
      evidence.identity.physicalLoadId
    ]
  );
  const row = retained.rowCount ? object(retained.rows[0]) : null;
  if (!retainedCandidateSnapshotMatches(row, evidence)) {
    throw failure(
      409,
      "MBT_CROSS_CHARGE_SOURCE_CONFLICT",
      "This completed order identity is already bound to different immutable billing evidence."
    );
  }
  return evidence.completedLoadSnapshotId;
}

/**
 * Recalculate and atomically convert a selected completed-order batch into
 * durable local-only MBBS billing cases. Caller-authored preview money is
 * intentionally not accepted.
 *
 * @param {unknown} rawInput
 * @param {{resolveDistance: Function, hooks?: Record<string, Function>}} dependencies
 */
export async function createMbbsBillingCasesFromCandidates(rawInput, dependencies) {
  const input = object(rawInput);
  const actor = billingActor(input.actor);
  const ids = batchCandidateIds(input.candidateIds);
  const month = completedMonth(input.completedMonth, { required: true });
  const day = completedDay(input.completedDate);
  assertCompatibleCompletionFilters(month, day);
  const selectedVersionId = rateCardVersionId(input.rateCardVersionId);
  const selectedCustomerId = customerNetsuiteId(input.customerNetsuiteId);
  const manualAmountEdits = batchManualAmountEdits(input.manualAmountEdits, ids);
  const manualAmountEditByCandidate = new Map(
    manualAmountEdits.map((edit) => [edit.candidateId, edit])
  );
  const reason = requiredBoundedText(
    input.reason,
    "MBT_BILLING_CONVERSION_REASON_INVALID",
    "Enter a billing conversion audit reason of at most 2,000 characters.",
    2000,
    3
  );
  const resolveDistance = distanceResolver(dependencies);
  const hooks = object(dependencies).hooks;
  const payload = {
    candidateIds: ids,
    completedMonth: month,
    completedDate: day,
    rateCardVersionId: selectedVersionId,
    customerNetsuiteId: selectedCustomerId,
    manualAmountEdits,
    reason
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.billing.mbbs_candidates.batch_create",
    idempotencyKey: input.idempotencyKey,
    payload,
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      await query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mbt.billing.mbbs_candidates.batch_create', 0))"
      );
      const graphs = await activeMbbsRateGraphs();
      const graph = selectedRateGraph(graphs, selectedVersionId, { explicit: true });
      const items = await selectedCandidateItems(ids, month, {
        graphs,
        completedDateValue: day
      });
      const byId = new Map(items.map((candidate) => [candidate.candidateId, candidate]));
      /** @type {Array<Record<string, any>>} */
      const calculations = [];
      for (const id of ids) {
        const candidate = byId.get(id);
        if (!candidate) {
          throw failure(
            404,
            "MBT_BILLING_CANDIDATE_NOT_FOUND",
            "The completed MBBS billing candidate is unavailable in the selected completion period."
          );
        }
        // The command owns one transaction client. Sequential resolution keeps
        // any database-backed distance adapter from issuing overlapping queries.
        const calculated = await calculateCandidateWithManualRate(candidate, graph, resolveDistance);
        calculations.push(applyManualAmountEdit(
          calculated,
          manualAmountEditByCandidate.get(id),
          actor.operatorId
        ));
      }
      /** @type {Record<string, string>} */
      const completedLoadSnapshotIdsByPhysicalLoad = {};
      const completedLoadSnapshotIds = [];
      for (const calculation of calculations) {
        const snapshotId = await freezeCandidateCalculation(calculation, actor);
        const physicalLoadId = text(object(calculation.candidate).physicalLoadId);
        completedLoadSnapshotIdsByPhysicalLoad[physicalLoadId] = snapshotId;
        completedLoadSnapshotIds.push(snapshotId);
        if (typeof hooks?.afterSnapshotInsert === "function") {
          await hooks.afterSnapshotInsert({ calculation, snapshotId });
        }
      }
      const durable = await persistCalculatedMbbsCandidateBatch({
        actor,
        customerNetsuiteId: selectedCustomerId,
        calculations,
        reason,
        correlationId: input.correlationId,
        completedLoadSnapshotIdsByPhysicalLoad
      }, { hooks });
      const body = {
        schemaVersion: "mbbs-billing-candidate-batch-create-v1",
        generationId: durable.generationId,
        completedMonth: month,
        completedDate: day,
        customerNetsuiteId: selectedCustomerId,
        rateCardVersionId: selectedVersionId,
        requestedCandidateCount: ids.length,
        durableCaseCount: durable.cases.length,
        completedLoadSnapshotIds,
        currency: durable.currency,
        manualAmountEdits: calculations.map((calculation) => ({
          candidateId: text(object(calculation.candidate).candidateId),
          ...object(calculation.manualAmount)
        })),
        cases: durable.cases,
        allocationGroups: durable.allocationGroups,
        postingMode: "local_only",
        externalWork: null
      };
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.billing.mbbs_candidates.created",
          entityType: "mbt_cross_charge_generation",
          entityId: durable.generationId,
          beforeState: {
            candidateIds: ids,
            conversionStatus: "not_started"
          },
          afterState: {
            candidateIds: ids,
            manualAmountEdits: calculations.map((calculation) => object(calculation.manualAmount)),
            completedLoadSnapshotIds,
            durableCaseCount: durable.cases.length,
            postingMode: "local_only"
          },
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "mbt_billing_candidate_conversion"
        }
      };
    }
  });
}

/** @param {Record<string, any>} candidate @param {Record<string, any> | null} existing */
function assertAddressOverrideAllowed(candidate, existing) {
  if (existing) {
    return;
  }
  if (array(candidate.references).length === 0 || !candidate.originLabel) {
    throw failure(422, "MBT_BILLING_ADDRESS_OVERRIDE_INSUFFICIENT", "A destination address alone cannot complete this order's retained billing route.");
  }
  if (candidate.routeStopCount >= 2 && candidate.destinationLabel) {
    throw failure(409, "MBT_BILLING_ADDRESS_OVERRIDE_NOT_ALLOWED", "This completed order already has a retained destination address.");
  }
}

/**
 * Retain one billing-only destination override under the standard atomic
 * command receipt and append-only audit boundary. Operational source rows are
 * intentionally never changed.
 *
 * @param {unknown} rawInput
 */
export async function setMbbsBillingCandidateAddressOverride(rawInput) {
  const input = object(rawInput);
  const actor = billingActor(input.actor);
  const identity = decodedCandidateId(input.candidateId);
  const encoded = candidateId(identity);
  if (encoded !== text(input.candidateId)) {
    throw failure(400, "MBT_BILLING_CANDIDATE_ID_INVALID", "The MBBS billing candidate ID is invalid.");
  }
  const month = completedMonth(input.completedMonth, { required: true });
  const destinationAddressText = requiredBoundedText(
    input.destinationAddressText,
    "MBT_BILLING_ADDRESS_OVERRIDE_INVALID",
    "Enter one complete billing destination address of at most 1,000 characters.",
    1000,
    5
  );
  const reason = requiredBoundedText(
    input.reason,
    "MBT_BILLING_ADDRESS_OVERRIDE_REASON_INVALID",
    "Enter an audit reason of at most 2,000 characters.",
    2000,
    3
  );
  const expectedRevision = expectedAddressRevision(input.expectedRevision);
  const payload = {
    candidateId: encoded,
    completedMonth: month,
    destinationAddressText,
    expectedRevision,
    reason
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.billing.mbbs_candidate_address.override",
    idempotencyKey: input.idempotencyKey,
    payload,
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mbt-billing-address:${encoded}`]);
      const graphs = await activeMbbsRateGraphs();
      const items = await selectedCandidateItems([encoded], month, {
        graphs,
        includeOverrides: false
      });
      const candidate = items.find((item) => item.candidateId === encoded);
      if (!candidate) {
        throw failure(404, "MBT_BILLING_CANDIDATE_NOT_FOUND", "The completed MBBS billing candidate is unavailable in the selected month.");
      }
      const current = await query(
        `SELECT address_override_id::text, source_system, source_record_id,
                destination_address_text, revision::text, updated_by, updated_at
           FROM mbt_mbbs_billing_address_overrides
          WHERE candidate_id = $1
          FOR UPDATE`,
        [encoded]
      );
      const existing = current.rowCount ? object(current.rows[0]) : null;
      if (existing && (
        text(existing.source_system) !== candidate.sourceSystem
        || text(existing.source_record_id) !== candidate.sourceRecordId
      )) {
        throw failure(409, "MBT_BILLING_ADDRESS_OVERRIDE_INVALID", "The retained override no longer matches its completed order identity.");
      }
      assertAddressOverrideAllowed(candidate, existing);
      const currentRevision = existing ? Number(existing.revision) : 0;
      if (currentRevision !== expectedRevision) {
        throw failure(409, "MBT_BILLING_ADDRESS_OVERRIDE_REVISION_CONFLICT", "The billing address changed after it was loaded. Refresh the candidate and try again.");
      }
      const beforeRevision = Math.max(1, currentRevision);
      const saved = await query(
        `INSERT INTO mbt_mbbs_billing_address_overrides (
           address_override_id, candidate_id, source_system, source_record_id,
           destination_address_text, revision, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
         ON CONFLICT (candidate_id) DO UPDATE
           SET destination_address_text = EXCLUDED.destination_address_text,
               revision = mbt_mbbs_billing_address_overrides.revision + 1,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
         RETURNING address_override_id::text, destination_address_text,
                   revision::text, updated_by, updated_at`,
        [
          crypto.randomUUID(), encoded, candidate.sourceSystem, candidate.sourceRecordId,
          destinationAddressText, actor.operatorId
        ]
      );
      const row = object(saved.rows[0]);
      const revision = Number(row.revision);
      const body = {
        schemaVersion: "mbbs-billing-address-override-v1",
        postingMode: "local_only",
        candidateId: encoded,
        destinationAddressText: text(row.destination_address_text),
        revision,
        updatedBy: text(row.updated_by),
        updatedAt: new Date(row.updated_at).toISOString()
      };
      return {
        status: 200,
        body,
        audit: {
          action: "mbt.billing.mbbs_candidate_address.overridden",
          entityType: "mbt_mbbs_billing_address_override",
          entityId: encoded,
          beforeState: existing ? {
            exists: true,
            destinationAddressText: text(existing.destination_address_text),
            revision: beforeRevision
          } : { exists: false, candidateId: encoded },
          afterState: body,
          reason,
          revisionBefore: beforeRevision,
          revisionAfter: revision,
          source: "mbt_billing"
        }
      };
    }
  });
}
