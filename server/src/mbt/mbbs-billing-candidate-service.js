// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { calculateDistanceBandChargeMinor } from "./distance-band-pricing.js";
import { MbtError } from "./errors.js";
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

/** @param {unknown} value */
function normalizedLocation(value) {
  return text(value).toLowerCase().replaceAll(/[^a-z0-9]+/gu, " ").trim();
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

/** @param {unknown} value */
function decodedCandidateId(value) {
  const encoded = text(value);
  if (!encoded || encoded.length > 500 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw failure(400, "MBT_BILLING_CANDIDATE_ID_INVALID", "The MBBS billing candidate ID is invalid.");
  }
  try {
    const decoded = object(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (decoded.v !== 1 || !["driver", "reconciliation", "sales_order"].includes(text(decoded.kind))) {
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
  return ["SO", "TO", "PO", "VRMA"].includes(normalized) ? normalized : null;
}

/** @param {string} reference */
function inferredSourceType(reference) {
  const normalized = reference.toUpperCase();
  if (normalized.startsWith("VRMA")) {
    return "VRMA";
  }
  if (normalized.startsWith("TO")) {
    return "TO";
  }
  if (normalized.startsWith("PO")) {
    return "PO";
  }
  if (normalized.startsWith("SO")) {
    return "SO";
  }
  return null;
}

/** @param {string} type @param {string} reference */
function rootReference(type, reference) {
  return type === "SO" ? reference.replace(/-S[0-9]+$/iu, "") : reference;
}

/** @param {Array<Record<string, any>>} records */
function driverReferences(records) {
  const found = new Map();
  for (const record of records) {
    const details = object(record.details);
    const declaredTypes = array(details.orderTypes).map(sourceType).filter(Boolean);
    for (const rawReference of array(record.orderRefs)) {
      const reference = text(rawReference);
      if (!reference) {
        continue;
      }
      const type = declaredTypes.length === 1 ? declaredTypes[0] : inferredSourceType(reference);
      if (!type) {
        continue;
      }
      const root = rootReference(type, reference);
      found.set(`${type}|${root.toUpperCase()}`, { sourceType: type, rootReference: root });
    }
  }
  return [...found.values()].sort((left, right) =>
    left.sourceType.localeCompare(right.sourceType)
      || left.rootReference.localeCompare(right.rootReference)
  );
}

/** @param {Record<string, any>} record */
function driverStopAddress(record) {
  const details = object(record.details);
  return text(details.address)
    || text(record.stopType === "dropoff" ? details.dropAddress : details.pickupLocation)
    || text(details.location);
}

/** @param {Array<Record<string, any>>} records */
function routeStops(records) {
  const stops = [];
  for (const record of records) {
    if (!["pickup", "dropoff"].includes(text(record.stopType).toLowerCase())) {
      continue;
    }
    const addressText = driverStopAddress(record);
    if (!addressText || normalizedLocation(stops.at(-1)?.addressText) === normalizedLocation(addressText)) {
      continue;
    }
    stops.push({ addressText, stopType: text(record.stopType).toLowerCase() });
  }
  return stops;
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} yards @param {Set<string>} allowedOrigins */
// eslint-disable-next-line complexity
function driverCandidate(row, yards, allowedOrigins) {
  const records = array(row.records).map(object);
  const references = driverReferences(records);
  const stops = routeStops(records);
  const firstDetails = object(records[0]?.details);
  const originYard = findYard(yards, [
    firstDetails.pickupLocation,
    firstDetails.location,
    stops[0]?.addressText
  ]);
  const originAllowed = Boolean(originYard && (allowedOrigins.size === 0 || allowedOrigins.has(originYard.yardCode)));
  const reason = references.length === 0
    ? "No SO, TO, PO, or VRMA reference is retained on this load."
    : stops.length < 2
      ? "At least two retained pickup/drop addresses are required."
      : !originYard
        ? "The retained pickup does not match an active MBT yard."
        : !originAllowed
          ? "The retained pickup yard is outside the active MBBS rate scope."
          : null;
  const identity = {
    kind: "driver",
    planId: row.plan_id === null ? null : String(row.plan_id),
    loadId: text(row.load_id)
  };
  return {
    candidateId: candidateId(identity),
    sourceSystem: "driver_pwa",
    sourceRecordId: `${identity.planId || "unplanned"}:${identity.loadId}`,
    physicalLoadId: identity.loadId,
    planDate: text(row.plan_date),
    completedAt: new Date(row.completed_at).toISOString(),
    references,
    originYardCode: originYard?.yardCode || null,
    originLabel: stops[0]?.addressText || "",
    destinationLabel: stops.at(-1)?.addressText || "",
    routeStopCount: stops.length,
    chargeable: reason === null,
    reason,
    _routeStops: stops,
    _identity: identity
  };
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} yards @param {Set<string>} allowedOrigins */
// eslint-disable-next-line complexity
function reconciliationCandidate(row, yards, allowedOrigins) {
  const snapshot = object(row.order_snapshot);
  const type = sourceType(row.order_kind) || "PO";
  const reference = text(row.source_order_ref);
  const sourceLabel = text(row.header_source_address)
    || text(row.source_location)
    || text(snapshot.sourceLocation);
  const destinationLabel = text(row.header_destination_address)
    || text(row.destination_location)
    || text(snapshot.destinationLocation);
  const sourceYard = findYard(yards, [row.source_location_id, sourceLabel]);
  const destinationYard = findYard(yards, [row.destination_location_id, destinationLabel]);
  let originYard = sourceYard;
  let originAddress = sourceYard?.addressText || sourceLabel;
  let destinationAddress = destinationYard?.addressText || destinationLabel;
  if ((!originYard || (allowedOrigins.size && !allowedOrigins.has(originYard.yardCode)))
      && destinationYard && (!allowedOrigins.size || allowedOrigins.has(destinationYard.yardCode))) {
    originYard = destinationYard;
    originAddress = destinationYard.addressText;
    destinationAddress = sourceYard?.addressText || sourceLabel;
  }
  const originAllowed = Boolean(originYard && (allowedOrigins.size === 0 || allowedOrigins.has(originYard.yardCode)));
  const reason = !reference
    ? "The reconciliation row has no order reference."
    : !originAddress || !destinationAddress
      ? "The completed reconciliation row has no complete route addresses."
      : !originYard
        ? "Neither reconciliation endpoint matches an active MBT yard."
        : !originAllowed
          ? "The reconciliation route is outside the active MBBS rate scope."
          : null;
  const identity = { kind: "reconciliation", orderKind: type, recordId: String(row.id) };
  return {
    candidateId: candidateId(identity),
    sourceSystem: "reconciliation",
    sourceRecordId: String(row.id),
    physicalLoadId: `RECON-${type}-${row.id}`,
    planDate: text(row.plan_date) || text(row.completed_at).slice(0, 10),
    completedAt: new Date(row.completed_at).toISOString(),
    references: reference ? [{ sourceType: type, rootReference: reference }] : [],
    originYardCode: originYard?.yardCode || null,
    originLabel: originAddress,
    destinationLabel: destinationAddress,
    routeStopCount: originAddress && destinationAddress ? 2 : 0,
    chargeable: reason === null,
    reason,
    _routeStops: originAddress && destinationAddress
      ? [{ addressText: originAddress, stopType: "pickup" }, { addressText: destinationAddress, stopType: "dropoff" }]
      : [],
    _identity: identity
  };
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} yards @param {Set<string>} allowedOrigins */
// eslint-disable-next-line complexity
function salesOrderCandidate(row, yards, allowedOrigins) {
  const originYard = findYard(yards, [row.outbound_location_id, row.outbound_location]);
  const originAllowed = Boolean(originYard && (allowedOrigins.size === 0 || allowedOrigins.has(originYard.yardCode)));
  const destination = text(row.dispatch_address);
  const reason = !text(row.tranid)
    ? "The completed Sales Order has no reference."
    : !destination
      ? "The completed Sales Order has no dispatch address."
      : !originYard
        ? "The Sales Order origin does not match an active MBT yard."
        : !originAllowed
          ? "The Sales Order origin is outside the active MBBS rate scope."
          : null;
  const identity = { kind: "sales_order", netsuiteId: String(row.netsuite_id) };
  return {
    candidateId: candidateId(identity),
    sourceSystem: "sales_order",
    sourceRecordId: String(row.netsuite_id),
    physicalLoadId: `SO-${row.netsuite_id}`,
    planDate: text(row.plan_date) || text(row.completed_at).slice(0, 10),
    completedAt: new Date(row.completed_at).toISOString(),
    references: text(row.tranid) ? [{ sourceType: "SO", rootReference: rootReference("SO", text(row.tranid)) }] : [],
    originYardCode: originYard?.yardCode || null,
    originLabel: originYard?.addressText || text(row.outbound_location),
    destinationLabel: destination,
    routeStopCount: destination && originYard ? 2 : 0,
    chargeable: reason === null,
    reason,
    _routeStops: destination && originYard
      ? [{ addressText: originYard.addressText, stopType: "pickup" }, { addressText: destination, stopType: "dropoff" }]
      : [],
    _identity: identity
  };
}

async function activeMbbsRateGraphs() {
  const selected = await query(
    `SELECT card.rate_card_id::text, card.rate_card_code, card.display_name,
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

/** @param {number} limit @param {string | null} completedMonthValue */
async function driverRows(limit, completedMonthValue) {
  const result = await query(
    `SELECT plan_id::text, plan_date::text, load_id,
            max(completed_at) AS completed_at,
            jsonb_agg(jsonb_build_object(
              'id', id,
              'stopType', stop_type,
              'orderRefs', COALESCE(order_refs, '[]'::jsonb),
              'details', COALESCE(job_details, '{}'::jsonb)
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
      ORDER BY max(completed_at) DESC NULLS LAST, plan_id DESC NULLS LAST, load_id
      LIMIT $1`,
    [limit, completedMonthValue]
  );
  return result.rows;
}

/** @param {number} limit @param {string | null} completedMonthValue */
async function reconciliationRows(limit, completedMonthValue) {
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
            CASE WHEN state.order_kind = 'PO' THEN purchase.dispatch_address
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
      WHERE state.application_status = 'Completed'
        AND ($2::text IS NULL OR (
          (COALESCE(state.completed_at, state.reconciled_at, state.updated_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') >= (($2 || '-01')::date)::timestamp
          AND (COALESCE(state.completed_at, state.reconciled_at, state.updated_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
      ORDER BY COALESCE(state.completed_at, state.reconciled_at, state.updated_at) DESC, state.id DESC
      LIMIT $1`,
    [limit, completedMonthValue]
  );
  return result.rows;
}

/** @param {number} limit @param {string | null} completedMonthValue */
async function completedSalesOrderRows(limit, completedMonthValue) {
  const result = await query(
    `SELECT netsuite_id::text, tranid, outbound_location_id::text,
            outbound_location, dispatch_address,
            COALESCE(fulfilled_at, status_updated_at, synced_at) AS completed_at,
            COALESCE(dispatch_plan_date::text,
                     COALESCE(fulfilled_at, status_updated_at, synced_at)::date::text) AS plan_date
       FROM sales_orders
      WHERE (fulfillment_status = 'fulfilled' OR fulfilled_at IS NOT NULL)
        AND ($2::text IS NULL OR (
          (COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') >= (($2 || '-01')::date)::timestamp
          AND (COALESCE(fulfilled_at, status_updated_at, synced_at)
            AT TIME ZONE '${TORONTO_TIME_ZONE}') < ((($2 || '-01')::date + interval '1 month')::timestamp)
        ))
      ORDER BY COALESCE(fulfilled_at, status_updated_at, synced_at) DESC NULLS LAST,
               netsuite_id DESC
      LIMIT $1`,
    [limit, completedMonthValue]
  );
  return result.rows.filter((/** @type {Record<string, any>} */ row) => row.completed_at);
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

/** @param {Record<string, any>} candidate @param {Record<string, any> | undefined} override @param {Set<string>} allowedOrigins */
function applyAddressOverride(candidate, override, allowedOrigins) {
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
  const originAllowed = Boolean(
    candidate.originYardCode
    && candidate.originLabel
    && (allowedOrigins.size === 0 || allowedOrigins.has(candidate.originYardCode))
  );
  if (!originAllowed || array(candidate.references).length === 0) {
    return { ...candidate, addressOverride: publicOverride };
  }
  return {
    ...candidate,
    destinationLabel: override.destinationAddressText,
    routeStopCount: 2,
    chargeable: true,
    reason: null,
    addressOverride: publicOverride,
    _routeStops: [
      { addressText: candidate.originLabel, stopType: "pickup" },
      { addressText: override.destinationAddressText, stopType: "dropoff" }
    ]
  };
}

/**
 * @param {number} limit
 * @param {string | null} completedMonthValue
 * @param {{graphs?: Array<Record<string, any>>, includeOverrides?: boolean, truncate?: boolean}} [options]
 */
async function internalCandidates(
  limit,
  completedMonthValue,
  { graphs, includeOverrides = true, truncate = true } = {}
) {
  const rateGraphs = graphs || await activeMbbsRateGraphs();
  const hasUnrestrictedGraph = rateGraphs.some((graph) => graph.originYardCodes.size === 0);
  const allowedOrigins = hasUnrestrictedGraph
    ? new Set()
    : new Set(rateGraphs.flatMap((graph) => [...graph.originYardCodes]));
  const [yards, driver, reconciliation, salesOrders] = await Promise.all([
    activeYards(),
    driverRows(limit, completedMonthValue),
    reconciliationRows(limit, completedMonthValue),
    completedSalesOrderRows(limit, completedMonthValue)
  ]);
  let items = [
    ...driver.map((/** @type {Record<string, any>} */ row) => driverCandidate(row, yards, allowedOrigins)),
    ...reconciliation.map(
      (/** @type {Record<string, any>} */ row) => reconciliationCandidate(row, yards, allowedOrigins)
    ),
    ...salesOrders.map(
      (/** @type {Record<string, any>} */ row) => salesOrderCandidate(row, yards, allowedOrigins)
    )
  ];
  if (includeOverrides) {
    const overrides = await storedAddressOverrides(items.map((item) => item.candidateId));
    items = items.map((item) => applyAddressOverride(item, overrides.get(item.candidateId), allowedOrigins));
  } else {
    items = items.map((item) => ({ ...item, addressOverride: null }));
  }
  items.sort((left, right) => Number(right.chargeable) - Number(left.chargeable)
    || right.completedAt.localeCompare(left.completedAt)
    || left.candidateId.localeCompare(right.candidateId));
  return { graphs: rateGraphs, items: truncate ? items.slice(0, limit) : items };
}

/** @param {Record<string, any>} candidate */
function publicCandidate(candidate) {
  const { _routeStops, _identity, ...result } = candidate;
  return { ...result, addressOverride: result.addressOverride || null };
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
  const { graphs, items } = await internalCandidates(limit, month);
  const soleGraph = graphs.length === 1 ? graphs[0] : null;
  return {
    schemaVersion: "mbbs-billing-candidates-v2",
    postingMode: "local_only_preview",
    completedMonth: month,
    rateCardVersionId: soleGraph?.rateCardVersionId || null,
    currency: soleGraph?.currency || null,
    rateOptions: rateOptions(graphs),
    items: items.map(publicCandidate)
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

/** @param {Record<string, any>} candidate @param {Record<string, any>} graph @param {Function} resolveDistance */
// eslint-disable-next-line complexity
async function calculateCandidate(candidate, graph, resolveDistance) {
  if (!candidate.chargeable) {
    throw failure(422, "MBT_BILLING_CANDIDATE_INCOMPLETE", candidate.reason || "The completed MBBS candidate is incomplete.");
  }
  if (graph.originYardCodes.size && !graph.originYardCodes.has(candidate.originYardCode)) {
    throw failure(
      422,
      "MBT_MBBS_RATE_ORIGIN_UNAVAILABLE",
      "The selected MBBS rate card does not apply to this order's origin yard."
    );
  }
  const stops = array(candidate._routeStops).map(object);
  let distanceMetres = 0;
  const routeEvidence = [];
  for (let index = 1; index < stops.length; index += 1) {
    const origin = stops[index - 1];
    const destination = stops[index];
    if (!origin || !destination) {
      throw failure(422, "MBT_BILLING_CANDIDATE_INCOMPLETE", "The completed route has a missing stop.");
    }
    const raw = object(await resolveDistance(index === 1
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
      provider: text(raw.provider),
      providerMetres: segmentMetres,
      routeHash: text(raw.routeHash),
      originSnapshot: object(raw.originSnapshot),
      destinationSnapshot: object(raw.destinationSnapshot),
      routeSnapshot: object(raw.routeSnapshot)
    });
  }
  const selected = /** @type {MbbsRateBand | undefined} */ (selectRateBand(graph.bands, distanceMetres));
  if (!selected) {
    throw failure(409, "MBT_MBBS_RATE_UNAVAILABLE", "The active MBBS rate graph does not cover this completed route.");
  }
  const amountMinor = calculateDistanceBandChargeMinor(selected, distanceMetres);
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
    charge: {
      itemCode: selected.itemCode,
      amountMinor,
      currency: graph.currency,
      estimatedTaxMinor: 0,
      totalMinor: amountMinor
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
  const resolveDistance = distanceResolver(dependencies);
  const graphs = await activeMbbsRateGraphs();
  const graph = selectedRateGraph(graphs, input.rateCardVersionId);
  const { items } = await internalCandidates(MAX_CANDIDATES, month, { graphs });
  const encoded = candidateId(identity);
  const candidate = items.find((item) => item.candidateId === encoded);
  if (!candidate) {
    throw failure(404, "MBT_BILLING_CANDIDATE_NOT_FOUND", "The completed MBBS billing candidate is unavailable.");
  }
  return {
    schemaVersion: "mbbs-billing-candidate-preview-v1",
    postingMode: "local_only_preview",
    externalWork: null,
    ...await calculateCandidate(/** @type {Record<string, any>} */ (candidate), graph, resolveDistance)
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
  const resolveDistance = distanceResolver(dependencies);
  const graphs = await activeMbbsRateGraphs();
  const graph = selectedRateGraph(graphs, input.rateCardVersionId, { explicit: true });
  const { items } = await internalCandidates(MAX_CANDIDATES, month, { graphs });
  const byId = new Map(items.map((candidate) => [candidate.candidateId, candidate]));
  const results = await mapConcurrently(ids, BATCH_DISTANCE_CONCURRENCY, async (id) => {
    try {
      const candidate = byId.get(id);
      if (!candidate) {
        throw failure(404, "MBT_BILLING_CANDIDATE_NOT_FOUND", "The completed MBBS billing candidate is unavailable in the selected month.");
      }
      return {
        candidateId: id,
        status: "calculated",
        ...await calculateCandidate(/** @type {Record<string, any>} */ (candidate), graph, resolveDistance)
      };
    } catch (error) {
      return { candidateId: id, status: "failed", error: batchFailure(error) };
    }
  });
  const successCount = results.filter((result) => result.status === "calculated").length;
  return {
    schemaVersion: "mbbs-billing-candidate-batch-preview-v1",
    postingMode: "local_only_preview",
    externalWork: null,
    completedMonth: month,
    rateCardVersionId: graph.rateCardVersionId,
    requestedCount: ids.length,
    successCount,
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

/** @param {Record<string, any>} candidate @param {Record<string, any> | null} existing */
function assertAddressOverrideAllowed(candidate, existing) {
  if (existing) {
    return;
  }
  if (array(candidate.references).length === 0 || !candidate.originYardCode || !candidate.originLabel) {
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
      const { items } = await internalCandidates(MAX_CANDIDATES, month, {
        graphs,
        includeOverrides: false,
        truncate: false
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
