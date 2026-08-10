// @ts-check

import { query } from "../db.js";
import { calculateDistanceBandChargeMinor } from "./distance-band-pricing.js";
import { MbtError } from "./errors.js";
import { selectRateBand } from "./rate-bands.js";

const MAX_CANDIDATES = 200;

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

async function activeMbbsRateGraph() {
  const selected = await query(
    `SELECT version.rate_card_version_id::text, version.version_number::int,
            card.currency, band.rate_distance_band_id::text,
            band.item_code, band.service_code, band.sequence_number::int,
            band.minimum_metres::int, band.maximum_metres::int,
            band.amount_minor::int, band.pricing_basis, band.boundary_rule,
            band.origin_yard_codes
       FROM mbt_rate_cards card
       JOIN mbt_rate_card_versions version USING (rate_card_id)
       JOIN mbt_rate_distance_bands band USING (rate_card_version_id)
      WHERE card.rate_card_code = 'DELIVERY_CHARGE_MBBS'
        AND version.status = 'active'
        AND band.item_code = 'DELIVERY_CHARGE_MBBS'
        AND band.service_code = 'mbbs_cross_charge'
      ORDER BY version.version_number DESC, band.sequence_number, band.minimum_metres`
  );
  if (!selected.rowCount) {
    throw failure(409, "MBT_MBBS_RATE_UNAVAILABLE", "Activate the DELIVERY_CHARGE_MBBS rate card before calculating completed orders.");
  }
  const rateCardVersionId = text(selected.rows[0].rate_card_version_id);
  const rows = selected.rows.filter(
    (/** @type {Record<string, any>} */ row) => text(row.rate_card_version_id) === rateCardVersionId
  );
  const bands = /** @type {MbbsRateBand[]} */ (rows.map((/** @type {Record<string, any>} */ row) => ({
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
  // selectRateBand performs the complete contiguous/open-band validation.
  selectRateBand(bands, 0);
  const originYardCodes = new Set(bands.flatMap((band) => band.originYardCodes));
  return {
    rateCardVersionId,
    versionNumber: Number(rows[0].version_number),
    currency: text(rows[0].currency),
    bands,
    originYardCodes
  };
}

/** @param {number} limit */
async function driverRows(limit) {
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
      ORDER BY max(completed_at) DESC NULLS LAST, plan_id DESC NULLS LAST, load_id
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** @param {number} limit */
async function reconciliationRows(limit) {
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
      ORDER BY COALESCE(state.completed_at, state.reconciled_at, state.updated_at) DESC, state.id DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** @param {number} limit */
async function completedSalesOrderRows(limit) {
  const result = await query(
    `SELECT netsuite_id::text, tranid, outbound_location_id::text,
            outbound_location, dispatch_address,
            COALESCE(fulfilled_at, status_updated_at, synced_at) AS completed_at,
            COALESCE(dispatch_plan_date::text,
                     COALESCE(fulfilled_at, status_updated_at, synced_at)::date::text) AS plan_date
       FROM sales_orders
      WHERE fulfillment_status = 'fulfilled' OR fulfilled_at IS NOT NULL
      ORDER BY COALESCE(fulfilled_at, status_updated_at, synced_at) DESC NULLS LAST,
               netsuite_id DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows.filter((/** @type {Record<string, any>} */ row) => row.completed_at);
}

/** @param {number} limit */
async function internalCandidates(limit) {
  const [graph, yards, driver, reconciliation, salesOrders] = await Promise.all([
    activeMbbsRateGraph(),
    activeYards(),
    driverRows(limit),
    reconciliationRows(limit),
    completedSalesOrderRows(limit)
  ]);
  const items = [
    ...driver.map((/** @type {Record<string, any>} */ row) => driverCandidate(row, yards, graph.originYardCodes)),
    ...reconciliation.map(
      (/** @type {Record<string, any>} */ row) => reconciliationCandidate(row, yards, graph.originYardCodes)
    ),
    ...salesOrders.map(
      (/** @type {Record<string, any>} */ row) => salesOrderCandidate(row, yards, graph.originYardCodes)
    )
  ].sort((left, right) => right.completedAt.localeCompare(left.completedAt)
    || left.candidateId.localeCompare(right.candidateId));
  return { graph, items: items.slice(0, limit) };
}

/** @param {Record<string, any>} candidate */
function publicCandidate(candidate) {
  const { _routeStops, _identity, ...result } = candidate;
  return result;
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
  const { graph, items } = await internalCandidates(limit);
  return {
    schemaVersion: "mbbs-billing-candidates-v1",
    postingMode: "local_only_preview",
    rateCardVersionId: graph.rateCardVersionId,
    currency: graph.currency,
    items: items.map(publicCandidate)
  };
}

/**
 * Resolve one opaque server-owned candidate and calculate it from the active
 * MBBS graph. No candidate, snapshot, billing, Driver, reconciliation, outbox,
 * or NetSuite row is inserted or updated.
 *
 * @param {unknown} rawInput
 * @param {{resolveDistance: Function}} dependencies
 */
// eslint-disable-next-line complexity
export async function previewMbbsBillingCandidate(rawInput, dependencies) {
  const input = object(rawInput);
  billingActor(input.actor);
  const identity = decodedCandidateId(input.candidateId);
  if (!dependencies || typeof dependencies.resolveDistance !== "function") {
    throw failure(503, "MBT_MBBS_DISTANCE_UNAVAILABLE", "Server distance pricing is not configured.");
  }
  const { graph, items } = await internalCandidates(MAX_CANDIDATES);
  const encoded = candidateId(identity);
  const candidate = items.find((item) => item.candidateId === encoded);
  if (!candidate) {
    throw failure(404, "MBT_BILLING_CANDIDATE_NOT_FOUND", "The completed MBBS billing candidate is unavailable.");
  }
  if (!candidate.chargeable) {
    throw failure(422, "MBT_BILLING_CANDIDATE_INCOMPLETE", candidate.reason || "The completed MBBS candidate is incomplete.");
  }
  if (graph.originYardCodes.size && !graph.originYardCodes.has(candidate.originYardCode)) {
    throw failure(422, "MBT_BILLING_CANDIDATE_ORIGIN_INVALID", "The completed route origin is outside the active MBBS rate scope.");
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
    const raw = object(await dependencies.resolveDistance(index === 1
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
    schemaVersion: "mbbs-billing-candidate-preview-v1",
    postingMode: "local_only_preview",
    externalWork: null,
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
