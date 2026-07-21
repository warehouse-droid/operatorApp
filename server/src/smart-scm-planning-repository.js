import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { latestSmartScmForecastRunId, smartScmForecastMap } from "./smart-scm-forecast-repository.js";
import { smartScmBuiltInRouteRule, smartScmRouteRuleKey, smartScmRouteRuleMap } from "./smart-scm-route-repository.js";

const EPSILON = 0.000001;
const YARDS = Object.freeze([
  { code: "3445", locationId: 1, priority: 2 },
  { code: "2967", locationId: 28, priority: 3 },
  { code: "12441", locationId: 15, priority: 1 },
  { code: "150", locationId: 26, priority: 4 }
]);
const YARD_BY_ID = new Map(YARDS.map((yard) => [String(yard.locationId), yard]));
const PO_STOP_PRIORITY = new Map([[26, 0], [15, 1], [1, 2], [28, 3]]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

export function smartScmSourceTransferLimit({ availablePallets = 0, safetyStockPallets = 0, reorderPointPallets = 0 } = {}) {
  const available = positive(availablePallets);
  const safety = positive(safetyStockPallets);
  const reorderPoint = positive(reorderPointPallets);
  const protectedFloorPallets = Math.max(safety, reorderPoint);
  const maximumTransferablePallets = Math.floor(Math.max(0, available - protectedFloorPallets) + EPSILON);
  return { availablePallets: available, safetyStockPallets: safety, reorderPointPallets: reorderPoint, protectedFloorPallets, maximumTransferablePallets };
}

function text(value) {
  return String(value ?? "").trim();
}

function percentile(values = [], ratio = 0.75) {
  const sorted = values.map(number).filter((value) => value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function robustMinimumOrder(values = []) {
  const clean = values.map(positive).filter((value) => value > EPSILON);
  if (!clean.length) return 1;
  return Math.max(1, Math.round(percentile(clean, 0.75)));
}

function normalizedDeliveryMethod(value) {
  return text(value).toLowerCase().replace(/[^a-z]/g, "");
}

function serviceFactor(policy, settings = {}) {
  return String(policy.yard_code) === "12441"
    ? positive(settings.delivery_safety_factor, 1.645)
    : positive(settings.pickup_safety_factor, 1.3);
}

function forecastQuantileForPolicy(forecast, policy) {
  const target = number(policy.service_quantile, String(policy.yard_code) === "12441" ? 0.95 : 0.90);
  if (target >= 0.95) return number(forecast?.lead_time_p95);
  if (target >= 0.90) return number(forecast?.lead_time_p90);
  return number(forecast?.lead_time_p75);
}

async function settingsRow() {
  const result = await query("SELECT * FROM scm_smart_settings WHERE id = 1");
  if (!result.rowCount) throw new Error("Smart SCM settings are missing. Run migrations first.");
  return result.rows[0];
}

async function planningPolicies() {
  const result = await query(
    `SELECT p.*,
            COALESCE(i.item_name, p.item_name) AS item_name,
            COALESCE(i.item_description, p.item_description) AS item_description,
            COALESCE(i.vendor, p.vendor) AS vendor,
            COALESCE(i.series, p.series) AS series,
            COALESCE(i.stock_unit, p.stock_unit) AS stock_unit,
            COALESCE(i.to_plt, p.to_plt) AS to_plt,
            COALESCE(i.to_lyr, p.to_lyr) AS to_lyr,
            COALESCE(i.to_sec, p.to_sec) AS to_sec,
            COALESCE(i.to_pcs, p.to_pcs) AS to_pcs,
            COALESCE(p.lead_time_days, i.netsuite_lead_time_days, p.purchase_lead_time_days, 7) AS effective_lead_time_days,
            COALESCE(NULLIF(p.vendor_yard, ''), NULLIF(p.plant, ''), i.vendor, p.vendor) AS plant,
            CASE WHEN COALESCE(i.item_weight, 0) > 0 AND COALESCE(i.to_plt, 0) > 0
                 THEN i.item_weight * i.to_plt ELSE p.pallet_weight_lbs END AS pallet_weight_lbs,
            y.location_id, y.yard_code, y.eligible, y.capacity_pallets,
            y.service_quantile, y.minimum_safety_pallets
       FROM scm_smart_item_policies p
       JOIN scm_smart_item_yard_policies y ON y.item_id = p.item_id
       LEFT JOIN inventory_items i ON i.item_id = p.item_id
      WHERE y.eligible = true
        AND p.planning_enabled = true
        AND p.inactive = false
        AND p.discontinued = false
      ORDER BY p.item_id, y.location_id`
  );
  return result.rows;
}

async function inventoryState() {
  const [balances, inbound, backorders, reservations] = await Promise.all([
    query(`SELECT item_id, location_id, quantity_on_hand, quantity_available, synced_at FROM inventory_balances`),
    query(
      `WITH open_po AS (
         SELECT l.item_id,
                COALESCE(l.location_id, o.destination_location_id) AS location_id,
                SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0), 0)) AS quantity
           FROM purchase_order_lines l
           JOIN purchase_orders o ON o.netsuite_id = l.purchase_order_id
          WHERE l.netsuite_active = true
            AND o.netsuite_active = true
            AND l.item_id IS NOT NULL
            AND COALESCE(l.location_id, o.destination_location_id) IS NOT NULL
          GROUP BY l.item_id, COALESCE(l.location_id, o.destination_location_id)
       ), open_to AS (
         SELECT l.item_id,
                o.to_location_id AS location_id,
                SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0), 0)) AS quantity
           FROM transfer_order_lines l
           JOIN transfer_orders o ON o.netsuite_id = l.transfer_order_id
          WHERE l.line_stage = 'receiving'
            AND l.netsuite_active = true
            AND o.netsuite_active = true
            AND l.item_id IS NOT NULL
            AND o.to_location_id IS NOT NULL
          GROUP BY l.item_id, o.to_location_id
       )
       SELECT item_id, location_id, SUM(quantity) AS quantity
         FROM (SELECT * FROM open_po UNION ALL SELECT * FROM open_to) inbound
        GROUP BY item_id, location_id`
    ),
    query(
      `SELECT l.item_id, COALESCE(l.location_id, o.outbound_location_id, o.order_location_id) AS location_id,
              SUM(GREATEST(COALESCE(l.netsuite_backordered_qty, 0), 0)) AS quantity
         FROM sales_order_lines l
         JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
        WHERE l.netsuite_active = true
          AND o.netsuite_active = true
          AND l.item_id IS NOT NULL
        GROUP BY l.item_id, COALESCE(l.location_id, o.outbound_location_id, o.order_location_id)`
    ),
    query(
      `SELECT item_id, source_location_id, destination_location_id,
              SUM(reserved_sales_quantity) AS quantity,
              SUM(reserved_pallets) AS pallets
         FROM scm_smart_inventory_reservations
        WHERE status = 'active'
        GROUP BY item_id, source_location_id, destination_location_id`
    )
  ]);
  const balanceMap = new Map(balances.rows.map((row) => [`${row.item_id}:${row.location_id}`, row]));
  const inboundMap = new Map(inbound.rows.map((row) => [`${row.item_id}:${row.location_id}`, positive(row.quantity)]));
  const backorderMap = new Map(backorders.rows.map((row) => [`${row.item_id}:${row.location_id}`, positive(row.quantity)]));
  const outboundReservationMap = new Map();
  const inboundReservationMap = new Map();
  for (const row of reservations.rows) {
    const outboundKey = `${row.item_id}:${row.source_location_id}`;
    const inboundKey = `${row.item_id}:${row.destination_location_id}`;
    outboundReservationMap.set(outboundKey, positive(outboundReservationMap.get(outboundKey)) + positive(row.quantity));
    inboundReservationMap.set(inboundKey, positive(inboundReservationMap.get(inboundKey)) + positive(row.quantity));
  }
  return { balanceMap, inboundMap, backorderMap, outboundReservationMap, inboundReservationMap };
}

async function latestVendorSupplyMap() {
  const result = await query(
    `SELECT DISTINCT ON (item_id) *
       FROM scm_smart_vendor_supply
      ORDER BY item_id, captured_at DESC, id DESC`
  );
  return new Map(result.rows.map((row) => [String(row.item_id), row]));
}

async function minimumOrderMap(policies = []) {
  const toPltByItem = new Map(policies.map((policy) => [String(policy.item_id), positive(policy.to_plt)]));
  const result = await query(
    `WITH selected_source AS (
       SELECT CASE
         WHEN EXISTS (SELECT 1 FROM scm_smart_sales_facts WHERE source = 'csv') THEN 'csv'
         WHEN EXISTS (SELECT 1 FROM scm_smart_sales_facts WHERE source = 'netsuite') THEN 'netsuite'
         ELSE 'workbook'
       END AS source
     )
     SELECT sf.item_id, sf.location_id, sf.delivery_method, sf.document_ref, SUM(sf.quantity) AS quantity
       FROM scm_smart_sales_facts sf
       CROSS JOIN selected_source selected
      WHERE sf.source = selected.source
        AND sf.quantity > 0
        AND sf.document_ref IS NOT NULL
        AND sf.location_id IS NOT NULL
      GROUP BY sf.item_id, sf.location_id, sf.delivery_method, sf.document_ref`
  );
  const values = new Map();
  for (const row of result.rows) {
    const toPlt = toPltByItem.get(String(row.item_id));
    if (!toPlt) continue;
    const expectedMethod = String(YARD_BY_ID.get(String(row.location_id))?.code) === "12441" ? "delivery" : "pickup";
    if (normalizedDeliveryMethod(row.delivery_method) !== expectedMethod) continue;
    const key = `${row.item_id}:${row.location_id}`;
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(positive(row.quantity) / toPlt);
  }
  return new Map([...values].map(([key, orders]) => [key, robustMinimumOrder(orders)]));
}

function calculatePolicyState(policy, forecast, inventory, minimumOrder, settings = {}) {
  const key = `${policy.item_id}:${policy.location_id}`;
  const toPlt = positive(policy.to_plt);
  const balance = inventory.balanceMap.get(key) || {};
  const onHandSales = positive(balance.quantity_on_hand);
  const availableSales = positive(balance.quantity_available);
  const onOrderSales = positive(inventory.inboundMap.get(key)) + positive(inventory.inboundReservationMap.get(key));
  const backorderedSales = positive(inventory.backorderMap.get(key));
  const reservedOutboundSales = positive(inventory.outboundReservationMap.get(key));
  const positionPallets = toPlt > EPSILON ? (availableSales + onOrderSales - backorderedSales - reservedOutboundSales) / toPlt : 0;
  const availablePallets = toPlt > EPSILON ? Math.max(0, availableSales - reservedOutboundSales) / toPlt : 0;
  const leadWeeks = Math.max(1 / 7, positive(policy.effective_lead_time_days || policy.lead_time_days || policy.purchase_lead_time_days || 7) / 7);
  const weeklyDemand = !forecast || forecast.authoritative_model === "formula"
    ? positive(forecast?.formula_weekly_demand ?? forecast?.baseline_weekly)
    : positive(forecast?.p50_weekly || forecast?.baseline_weekly);
  const estimatedSd = forecast?.formula_weekly_sd === null || forecast?.formula_weekly_sd === undefined
    ? Math.max(0, (positive(forecast?.p90_weekly) - positive(forecast?.p50_weekly)) / 1.282)
    : positive(forecast.formula_weekly_sd);
  const selectedServiceFactor = serviceFactor(policy, settings);
  const formulaSafety = Math.max(
    positive(policy.minimum_safety_pallets),
    estimatedSd * selectedServiceFactor * Math.sqrt(leadWeeks)
  );
  const formulaRop = Math.max(1, Math.round(formulaSafety + (weeklyDemand * leadWeeks)));
  const formulaPreferred = Math.min(positive(policy.capacity_pallets, 25), Math.ceil(formulaRop + (weeklyDemand * leadWeeks)));
  const usePrediction = forecast && forecast.authoritative_model !== "formula";
  const predictedRop = Math.max(1, Math.ceil(forecastQuantileForPolicy(forecast, policy)));
  const predictedReview = policy.service_quantile >= 0.95 ? positive(forecast?.p95_weekly) : positive(forecast?.p90_weekly);
  const predictedPreferred = Math.min(positive(policy.capacity_pallets, 25), Math.ceil(predictedRop + predictedReview));
  const safety = usePrediction ? Math.max(positive(policy.minimum_safety_pallets), predictedRop - (weeklyDemand * leadWeeks)) : formulaSafety;
  const baseRop = usePrediction ? predictedRop : formulaRop;
  const basePreferred = usePrediction ? predictedPreferred : formulaPreferred;
  const coverageApplied = Boolean(forecast?.zero_demand_coverage_applied);
  const coverageFloor = coverageApplied ? positive(forecast?.coverage_floor_pallets) : 0;
  const capacity = positive(policy.capacity_pallets, 25);
  const rop = Math.max(baseRop, coverageFloor);
  const preferred = Math.min(capacity, Math.max(basePreferred, rop));
  const minimumOrderPallets = positive(minimumOrder, 1);
  const capacityGap = Math.max(0, capacity - positionPallets);
  const requested = Math.ceil(Math.max(preferred - positionPallets, minimumOrderPallets));
  const capacityBelowMinimum = positionPallets < rop - EPSILON && capacityGap + EPSILON < minimumOrderPallets;
  const required = positionPallets < rop - EPSILON && !capacityBelowMinimum
    ? Math.max(0, Math.min(requested, Math.floor(capacityGap + EPSILON)))
    : 0;
  const coverageCausedNeed = coverageApplied && coverageFloor > baseRop + EPSILON && positionPallets < rop - EPSILON;
  const coverageLocalSamples = Math.max(0, Math.round(number(forecast?.coverage_local_samples)));
  const priorStrength = Math.max(1, Math.round(number(settings.coverage_prior_strength_orders, 8)));
  const coverageReviewRequired = coverageCausedNeed && coverageLocalSamples < priorStrength;
  const representativeOrderPallets = positive(forecast?.representative_order_pallets);
  const availableCoverageOrders = representativeOrderPallets > EPSILON ? availablePallets / representativeOrderPallets : null;
  const availableCoverageGapPallets = coverageApplied ? Math.max(0, coverageFloor - availablePallets) : 0;
  const coverageCoveredByInbound = coverageApplied && availableCoverageGapPallets > EPSILON && positionPallets >= coverageFloor - EPSILON;
  const weeksOfCover = weeklyDemand > EPSILON ? Math.max(0, positionPallets) / weeklyDemand : Number.POSITIVE_INFINITY;
  const urgent = required > 0 && (positionPallets <= safety + EPSILON || weeksOfCover <= leadWeeks + EPSILON);
  return {
    key,
    policy,
    forecast,
    toPlt,
    manualPlanningRequired: toPlt <= EPSILON || positive(policy.pallet_weight_lbs) <= EPSILON,
    onHandSales,
    availableSales,
    availablePallets,
    onOrderSales,
    backorderedSales,
    reservedOutboundSales,
    positionPallets: round(positionPallets),
    weeklyDemand: round(weeklyDemand),
    weeklyDemandSd: round(estimatedSd),
    serviceFactor: round(selectedServiceFactor),
    baseRop: round(baseRop),
    basePreferred: round(basePreferred),
    coverageApplied,
    representativeOrderPallets: round(representativeOrderPallets),
    coverageOrderCount: Math.max(0, Math.round(number(forecast?.coverage_order_count))),
    coverageFloor: round(coverageFloor),
    coverageSource: forecast?.coverage_source || "none",
    coverageLocalSamples,
    coverageDonorSamples: Math.max(0, Math.round(number(forecast?.coverage_donor_samples))),
    coverageCapacityShortfall: Boolean(forecast?.coverage_capacity_shortfall),
    coverageCausedNeed,
    coverageReviewRequired,
    availableCoverageOrders: availableCoverageOrders === null ? null : round(availableCoverageOrders),
    availableCoverageGapPallets: round(availableCoverageGapPallets),
    coverageCoveredByInbound,
    safety: round(safety),
    rop: round(rop),
    preferred: round(preferred),
    capacity: positive(policy.capacity_pallets, 25),
    minimumOrder: minimumOrderPallets,
    capacityBelowMinimum,
    requiredPallets: required,
    weeksOfCover: Number.isFinite(weeksOfCover) ? round(weeksOfCover) : null,
    leadWeeks: round(leadWeeks),
    inventorySyncedAt: balance.synced_at || null,
    urgent
  };
}

function proposalLine(state, pallets, extraReason = {}) {
  const policy = state.policy;
  const proposedPallets = round(pallets);
  const palletWeight = positive(policy.pallet_weight_lbs);
  return {
    itemId: Number(policy.item_id),
    itemName: policy.item_name,
    itemDescription: policy.item_description,
    unit: policy.stock_unit,
    destinationLocationId: Number(policy.location_id),
    destinationName: policy.yard_code,
    requiredPallets: state.requiredPallets,
    proposedPallets,
    confirmedPallets: 0,
    residualPallets: proposedPallets,
    salesQuantity: round(proposedPallets * state.toPlt),
    palletWeight,
    lineWeight: round(proposedPallets * palletWeight),
    toPlt: positive(policy.to_plt),
    toLyr: positive(policy.to_lyr),
    toSec: positive(policy.to_sec),
    toPcs: positive(policy.to_pcs),
    manualPlanningRequired: state.manualPlanningRequired,
    reason: {
      ...extraReason,
      quantityOnHand: state.onHandSales,
      quantityAvailable: state.availableSales,
      quantityOnOrder: state.onOrderSales,
      quantityBackordered: state.backorderedSales,
      quantityReservedOutbound: state.reservedOutboundSales,
      positionPallets: state.positionPallets,
      availablePallets: state.availablePallets,
      baseReorderPointPallets: state.baseRop,
      basePreferredPallets: state.basePreferred,
      zeroDemandCoverageApplied: state.coverageApplied,
      representativeOrderPallets: state.representativeOrderPallets,
      coverageOrderCount: state.coverageOrderCount,
      coverageFloorPallets: state.coverageFloor,
      coverageSource: state.coverageSource,
      coverageLocalSamples: state.coverageLocalSamples,
      coverageDonorSamples: state.coverageDonorSamples,
      coverageCapacityShortfall: state.coverageCapacityShortfall,
      coverageCausedNeed: state.coverageCausedNeed,
      coverageReviewRequired: state.coverageReviewRequired,
      availableCoverageOrders: state.availableCoverageOrders,
      availableCoverageGapPallets: state.availableCoverageGapPallets,
      coverageCoveredByInbound: state.coverageCoveredByInbound,
      safetyStockPallets: state.safety,
      reorderPointPallets: state.rop,
      preferredPallets: state.preferred,
      minimumOrderPallets: state.minimumOrder,
      weeklyDemandPallets: state.weeklyDemand,
      weeklyDemandSdPallets: state.weeklyDemandSd,
      safetyFactor: state.serviceFactor,
      weeksOfCover: state.weeksOfCover,
      inventorySyncedAt: state.inventorySyncedAt,
      forecastModel: state.forecast?.authoritative_model || "formula",
    }
  };
}

function splitLineByTruck(line, truckCapacity) {
  if (line.manualPlanningRequired || line.palletWeight <= EPSILON) return [line];
  const maxPallets = Math.max(1, Math.floor((truckCapacity + EPSILON) / line.palletWeight));
  const parts = [];
  let remaining = line.proposedPallets;
  while (remaining > EPSILON) {
    const pallets = Math.min(remaining, maxPallets);
    const ratio = pallets / line.proposedPallets;
    parts.push({
      ...line,
      proposedPallets: pallets,
      confirmedPallets: 0,
      residualPallets: pallets,
      salesQuantity: round(line.salesQuantity * ratio),
      lineWeight: round(pallets * line.palletWeight)
    });
    remaining = round(remaining - pallets);
  }
  return parts;
}

function createDraft({ type, phase, sourceKind, sourceLocationId = null, sourceName, destinationLocationId, destinationName, vendor = null, plant = null, urgent = false, provisional = false, line, status = null, keySuffix = "" }, settings) {
  const classifiedLine = {
    ...line,
    urgent: Boolean(urgent),
    provisional: Boolean(provisional),
    reason: { ...(line.reason || {}), urgent: Boolean(urgent), provisional: Boolean(provisional) }
  };
  const weight = positive(classifiedLine.lineWeight);
  const utilization = weight > 0 ? weight / positive(settings.truck_capacity_lbs, 78000) : 0;
  const coverageReviewRequired = Boolean(classifiedLine.reason?.coverageReviewRequired);
  let resolvedStatus = status;
  if (!resolvedStatus) {
    if (type === "PO") resolvedStatus = "held";
    else if (classifiedLine.manualPlanningRequired) resolvedStatus = "attention";
    else if (coverageReviewRequired) resolvedStatus = "held";
    else resolvedStatus = "draft";
  }
  return {
    proposalKey: [phase, sourceKind, sourceLocationId || sourceName || "unknown", destinationLocationId, line.itemId, keySuffix].join(":"),
    proposalType: type,
    phase,
    sourceKind,
    sourceLocationId,
    sourceName,
    destinationLocationId,
    destinationName,
    vendor,
    plant,
    status: resolvedStatus,
    urgent,
    provisional,
    totalPallets: classifiedLine.proposedPallets,
    totalWeight: weight,
    utilization: round(utilization),
    vendorReplyDueAt: null,
    memo: `${phase.replaceAll("_", " ")} · ${classifiedLine.itemName}`,
    routeStops: [{ locationId: Number(classifiedLine.destinationLocationId || destinationLocationId), name: classifiedLine.destinationName || destinationName, sequence: 1 }],
    statusLocked: status !== null || coverageReviewRequired,
    lines: [classifiedLine]
  };
}

function planningKeyHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function palletUnits(draft) {
  const line = draft.lines[0];
  const total = positive(line.proposedPallets);
  if (total <= EPSILON || line.manualPlanningRequired || positive(line.palletWeight) <= EPSILON) {
    return [{ draft, line: { ...line } }];
  }
  const units = [];
  let remaining = total;
  while (remaining > EPSILON) {
    const pallets = Math.min(1, remaining);
    const ratio = pallets / total;
    units.push({
      draft,
      line: {
        ...line,
        requiredPallets: round(positive(line.requiredPallets) * ratio),
        proposedPallets: round(pallets),
        confirmedPallets: 0,
        residualPallets: round(pallets),
        salesQuantity: round(positive(line.salesQuantity) * ratio),
        lineWeight: round(positive(line.lineWeight) * ratio)
      }
    });
    remaining = round(remaining - pallets);
  }
  return units;
}

function combineLoadLine(lines, next) {
  const existing = lines.find((line) => Number(line.itemId) === Number(next.itemId)
    && Number(line.destinationLocationId) === Number(next.destinationLocationId));
  if (!existing) {
    lines.push({ ...next });
    return;
  }
  existing.requiredPallets = round(positive(existing.requiredPallets) + positive(next.requiredPallets));
  existing.proposedPallets = round(positive(existing.proposedPallets) + positive(next.proposedPallets));
  existing.confirmedPallets = round(positive(existing.confirmedPallets) + positive(next.confirmedPallets));
  existing.residualPallets = round(positive(existing.residualPallets) + positive(next.residualPallets));
  existing.salesQuantity = round(positive(existing.salesQuantity) + positive(next.salesQuantity));
  existing.lineWeight = round(positive(existing.lineWeight) + positive(next.lineWeight));
  existing.urgent = Boolean(existing.urgent || next.urgent);
  existing.provisional = Boolean(existing.provisional || next.provisional);
  existing.reason = {
    ...(existing.reason || {}),
    urgent: existing.urgent,
    provisional: existing.provisional,
    ...((existing.reason?.gormleyOriginalDestinations || next.reason?.gormleyOriginalDestinations)
      ? { gormleyOriginalDestinations: [...new Set([
        ...(existing.reason?.gormleyOriginalDestinations || []),
        ...(next.reason?.gormleyOriginalDestinations || [])
      ])] } : {})
  };
}

function compatibleLoadSignature(draft) {
  const destination = draft.proposalType === "PO" ? "multi-drop" : `${draft.destinationLocationId}|${draft.destinationName}`;
  return [
    draft.proposalType, draft.phase, draft.sourceKind, draft.sourceLocationId || "", draft.sourceName || "",
    destination, draft.vendor || "", draft.plant || ""
  ].join("|");
}

function activeRouteRule(sourceName, maxStops, routeRule) {
  const fallback = smartScmBuiltInRouteRule(sourceName);
  const hasConfiguredRule = routeRule !== undefined;
  const selected = routeRule === undefined
    ? fallback
    : routeRule?.enabled === false
      ? smartScmBuiltInRouteRule("")
      : { ...fallback, ...(routeRule || {}) };
  return {
    ...selected,
    maxDrops: Math.max(1, Math.min(2, Number(hasConfiguredRule ? selected.maxDrops : maxStops) || 2)),
    stopOrder: Array.isArray(selected.stopOrder) && selected.stopOrder.length ? selected.stopOrder.map(Number) : [...PO_STOP_PRIORITY.keys()]
  };
}

function routeStopsForLines(lines = [], routeRule = null) {
  const priority = new Map((routeRule?.stopOrder || [...PO_STOP_PRIORITY.keys()]).map((locationId, index) => [Number(locationId), index]));
  const stops = [];
  for (const line of lines) {
    const locationId = Number(line.destinationLocationId);
    if (!Number.isInteger(locationId) || stops.some((stop) => stop.locationId === locationId)) continue;
    stops.push({ locationId, name: line.destinationName || String(locationId), sequence: stops.length + 1 });
  }
  return stops
    .sort((left, right) => (priority.get(left.locationId) ?? 99) - (priority.get(right.locationId) ?? 99))
    .map((stop, index) => ({ ...stop, sequence: index + 1 }));
}

function loadDestinationIds(load) {
  return new Set(load.lines.map((line) => Number(line.destinationLocationId)).filter(Number.isInteger));
}

function proposalUnitSort(left, right) {
  if (Boolean(left.line.urgent) !== Boolean(right.line.urgent)) return left.line.urgent ? -1 : 1;
  return positive(right.line.lineWeight) - positive(left.line.lineWeight);
}

function proposalUnitWeightSort(left, right) {
  const weightDifference = positive(right.line.lineWeight) - positive(left.line.lineWeight);
  if (Math.abs(weightDifference) > EPSILON) return weightDifference;
  if (Boolean(left.line.urgent) !== Boolean(right.line.urgent)) return left.line.urgent ? -1 : 1;
  return 0;
}

function packProposalUnits(units = [], truckCapacity = 0, maxStops = 2) {
  const loads = [];
  for (const unit of units) {
    const destinationId = Number(unit.line.destinationLocationId);
    const fits = (candidate) => candidate.totalWeight + positive(unit.line.lineWeight) <= truckCapacity + EPSILON;
    const sameStop = (candidate) => loadDestinationIds(candidate).has(destinationId);
    const permitsStop = (candidate) => {
      const destinations = loadDestinationIds(candidate);
      return destinations.has(destinationId) || destinations.size < maxStops;
    };
    let load = loads.find((candidate) => fits(candidate) && sameStop(candidate));
    if (!load) load = loads.find((candidate) => fits(candidate) && permitsStop(candidate));
    if (!load) {
      load = { totalWeight: 0, lines: [], units: [] };
      loads.push(load);
    }
    combineLoadLine(load.lines, unit.line);
    load.units.push(unit);
    load.totalWeight = round(load.totalWeight + positive(unit.line.lineWeight));
  }
  return loads;
}

function operationallyFullLoad(load, truckCapacity = 0) {
  const palletWeights = load.units.map((unit) => positive(unit.line.lineWeight)).filter((weight) => weight > EPSILON);
  if (!palletWeights.length) return false;
  return truckCapacity - positive(load.totalWeight) + EPSILON < Math.min(...palletWeights);
}

function destinationFirstProposalLoads(units = [], truckCapacity = 0, maxStops = 2) {
  if (maxStops <= 1 || units.length <= 1) return packProposalUnits(units, truckCapacity, 1);
  const baselineLoads = packProposalUnits(units, truckCapacity, maxStops);
  const unitsByDestination = new Map();
  for (const unit of units) {
    const destinationId = Number(unit.line.destinationLocationId);
    if (!unitsByDestination.has(destinationId)) unitsByDestination.set(destinationId, []);
    unitsByDestination.get(destinationId).push(unit);
  }
  const lockedSingleDestinationLoads = [];
  const residualUnits = [];
  for (const destinationUnits of unitsByDestination.values()) {
    const destinationLoads = packProposalUnits([...destinationUnits].sort(proposalUnitWeightSort), truckCapacity, 1);
    for (const load of destinationLoads) {
      if (operationallyFullLoad(load, truckCapacity)) lockedSingleDestinationLoads.push(load);
      else residualUnits.push(...load.units);
    }
  }
  let residualLoads = packProposalUnits(residualUnits.sort(proposalUnitWeightSort), truckCapacity, maxStops);
  const unlockableLoads = [...lockedSingleDestinationLoads].sort((left, right) => left.totalWeight - right.totalWeight);
  while (lockedSingleDestinationLoads.length + residualLoads.length > baselineLoads.length && unlockableLoads.length) {
    const unlocked = unlockableLoads.shift();
    const index = lockedSingleDestinationLoads.indexOf(unlocked);
    if (index >= 0) lockedSingleDestinationLoads.splice(index, 1);
    residualUnits.push(...unlocked.units);
    residualLoads = packProposalUnits(residualUnits.sort(proposalUnitWeightSort), truckCapacity, maxStops);
  }
  const destinationFirstLoads = [...lockedSingleDestinationLoads, ...residualLoads];
  return destinationFirstLoads.length <= baselineLoads.length ? destinationFirstLoads : baselineLoads;
}

function partialRedirectAdjustedLoads(units = [], truckCapacity = 0, maxStops = 2, routeRule = {}) {
  const directDestinationIds = new Set((routeRule.partialRedirectDestinationIds || []).map(Number));
  const hubLocationId = Number(routeRule.partialRedirectHubLocationId);
  const hub = YARD_BY_ID.get(String(hubLocationId));
  if (!directDestinationIds.size || !hub || directDestinationIds.has(hubLocationId)) {
    return destinationFirstProposalLoads(units, truckCapacity, maxStops);
  }
  const directLoads = [];
  const repackUnits = units.filter((unit) => !directDestinationIds.has(Number(unit.line.destinationLocationId)));
  for (const destinationId of directDestinationIds) {
    const destinationUnits = units.filter((unit) => Number(unit.line.destinationLocationId) === destinationId);
    if (!destinationUnits.length) continue;
    const destinationLoads = packProposalUnits(destinationUnits.sort(proposalUnitWeightSort), truckCapacity, 1);
    for (const load of destinationLoads) {
      if (operationallyFullLoad(load, truckCapacity)) {
        directLoads.push(load);
        continue;
      }
      for (const unit of load.units) {
        const originalDestination = unit.line.destinationName || String(unit.line.destinationLocationId);
        repackUnits.push({
          ...unit,
          line: {
            ...unit.line,
            destinationLocationId: hub.locationId,
            destinationName: hub.code,
            reason: {
              ...(unit.line.reason || {}),
              routeRulePartialRedirected: true,
              routeRuleSource: routeRule.sourceName,
              routeRuleOriginalDestinations: [originalDestination],
              actualDestinationYard: originalDestination,
              ...(smartScmRouteRuleKey(routeRule.sourceName) === "gormley" ? {
                gormleyHubRedirected: true,
                gormleyOriginalDestinations: [originalDestination]
              } : {})
            }
          }
        });
      }
    }
  }
  return [...directLoads, ...destinationFirstProposalLoads(repackUnits.sort(proposalUnitWeightSort), truckCapacity, maxStops)];
}

export function smartScmPackWholePalletLines(lines = [], truckCapacityLbs = 0, { proposalType = "PO", sourceName = "", maxStops = 2, routeRule } = {}) {
  const truckCapacity = positive(truckCapacityLbs);
  if (truckCapacity <= EPSILON) throw new Error("Truck capacity must be greater than zero.");
  if (!lines.length) return [];
  if (lines.some((line) => positive(line.palletWeight) <= EPSILON || positive(line.proposedPallets) <= EPSILON)) {
    throw new Error("Every packed line needs a positive pallet quantity and pallet weight.");
  }
  if (lines.some((line) => Math.abs(positive(line.proposedPallets) - Math.round(positive(line.proposedPallets))) > EPSILON)) {
    throw new Error("PO recalculation requires whole-pallet quantities.");
  }
  const units = lines.flatMap((line) => palletUnits({ proposalType, lines: [{ ...line, proposedPallets: Math.round(positive(line.proposedPallets)) }] }))
    .sort(proposalUnitSort);
  const routing = activeRouteRule(sourceName, maxStops, routeRule);
  const stopLimit = proposalType === "PO" ? routing.maxDrops : 1;
  const routed = proposalType === "PO" && routing.partialRedirectEnabled
    ? partialRedirectAdjustedLoads(units, truckCapacity, stopLimit, routing)
    : proposalType === "PO"
      ? destinationFirstProposalLoads(units, truckCapacity, stopLimit)
      : packProposalUnits(units, truckCapacity, stopLimit);
  return routed.map((load) => ({
    lines: load.lines,
    totalWeight: round(load.totalWeight),
    totalPallets: round(load.lines.reduce((sum, line) => sum + positive(line.proposedPallets), 0)),
    routeStops: routeStopsForLines(load.lines, routing)
  }));
}

export function consolidateCompatibleDrafts(drafts = [], settings = {}, namespace = "plan", routeRules = new Map()) {
  const truckCapacity = positive(settings.truck_capacity_lbs, 78000);
  const groups = new Map();
  const standalone = [];
  for (const draft of drafts) {
    if (draft.lines.some((line) => line.manualPlanningRequired || positive(line.palletWeight) <= EPSILON)) {
      standalone.push(draft);
      continue;
    }
    const signature = compatibleLoadSignature(draft);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(draft);
  }
  const consolidated = [];
  for (const [signature, group] of groups) {
    const base = group[0];
    const routeRule = routeRules.get?.(smartScmRouteRuleKey(base.sourceName));
    const loads = smartScmPackWholePalletLines(group.flatMap((draft) => draft.lines), truckCapacity, {
      proposalType: base.proposalType,
      sourceName: base.sourceName,
      maxStops: base.proposalType === "PO" ? 2 : 1,
      routeRule
    });
    loads.forEach((load, index) => {
      const totalPallets = round(load.lines.reduce((sum, line) => sum + positive(line.proposedPallets), 0));
      const utilization = round(load.totalWeight / truckCapacity);
      const urgent = load.lines.some((line) => Boolean(line.urgent));
      const provisional = load.lines.some((line) => Boolean(line.provisional));
      const coverageReviewRequired = load.lines.some((line) => Boolean(line.reason?.coverageReviewRequired));
      const routeStops = load.routeStops || routeStopsForLines(load.lines, activeRouteRule(base.sourceName, 2, routeRule));
      let status = base.proposalType === "PO" ? "held" : "draft";
      if (base.proposalType !== "PO" && coverageReviewRequired) status = "held";
      else if (base.proposalType !== "PO" && utilization < positive(settings.hold_load_ratio, 0.5)) status = "held";
      consolidated.push({
        ...base,
        proposalKey: `load:${namespace}:${base.phase}:${planningKeyHash(signature)}:${index + 1}`,
        status,
        urgent,
        provisional,
        statusLocked: coverageReviewRequired,
        destinationLocationId: routeStops[0]?.locationId || base.destinationLocationId,
        destinationName: routeStops[0]?.name || base.destinationName,
        routeStops,
        totalPallets,
        totalWeight: load.totalWeight,
        utilization,
        memo: `${base.phase.replaceAll("_", " ")} · load ${index + 1} · ${load.lines.length} item${load.lines.length === 1 ? "" : "s"}`,
        lines: load.lines
      });
    });
  }
  return [...consolidated, ...standalone];
}

function internalTransferDrafts({ state, requestedPallets, stateByKey, settings, provisional = false, keyPrefix = "plan" }) {
  const drafts = [];
  let remaining = positive(requestedPallets);
  const sources = YARDS
    .filter((yard) => yard.locationId !== Number(state.policy.location_id))
    .map((source) => {
      const sourceState = stateByKey.get(`${state.policy.item_id}:${source.locationId}`);
      const limit = sourceState ? smartScmSourceTransferLimit({
        availablePallets: sourceState.availablePallets,
        safetyStockPallets: sourceState.safety,
        reorderPointPallets: sourceState.rop
      }) : { protectedFloorPallets: 0, maximumTransferablePallets: 0 };
      const protectedFloor = limit.protectedFloorPallets;
      const transferable = !sourceState || sourceState.toPlt <= EPSILON ? 0 : limit.maximumTransferablePallets;
      return { source, sourceState, protectedFloor, transferable };
    })
    .filter((candidate) => candidate.transferable > 0)
    .sort((left, right) => {
      const leftCanFulfill = left.transferable + EPSILON >= remaining;
      const rightCanFulfill = right.transferable + EPSILON >= remaining;
      if (leftCanFulfill !== rightCanFulfill) return leftCanFulfill ? -1 : 1;
      return left.source.priority - right.source.priority;
    });
  for (const { source, sourceState, protectedFloor, transferable } of sources) {
    if (remaining <= EPSILON) break;
    const pallets = Math.min(remaining, transferable);
    const baseLine = proposalLine(state, pallets, {
      sourceAvailablePallets: sourceState.availablePallets,
      sourceSafetyStockPallets: sourceState.safety,
      sourceReorderPointPallets: sourceState.rop,
      sourceProtectedFloorPallets: protectedFloor,
      sourceMaximumTransferablePallets: transferable,
      sourceRemainingAvailablePallets: round(sourceState.availablePallets - pallets),
      provisional
    });
    const parts = splitLineByTruck(baseLine, positive(settings.truck_capacity_lbs, 78000));
    parts.forEach((line, index) => drafts.push(createDraft({
      type: "TO",
      phase: "internal_transfer",
      sourceKind: "yard",
      sourceLocationId: source.locationId,
      sourceName: source.code,
      destinationLocationId: Number(state.policy.location_id),
      destinationName: state.policy.yard_code,
      urgent: state.urgent,
      provisional,
      line,
      keySuffix: `${keyPrefix}-${index + 1}`
    }, settings)));
    sourceState.availablePallets = round(sourceState.availablePallets - pallets);
    remaining = round(remaining - pallets);
  }
  return { drafts, remaining };
}

function buildPlanningDrafts({ states, supplyMap, settings }) {
  const drafts = [];
  const stateByKey = new Map(states.map((state) => [state.key, state]));
  const exceptions = [];
  for (const state of states.filter((entry) => entry.requiredPallets > 0)) {
    const supply = supplyMap.get(String(state.policy.item_id));
    const supplyStatus = supply?.status || "unknown";
    const vendorAvailable = positive(supply?.available_pallets);
    const directPallets = supplyStatus === "out_of_stock" || supplyStatus === "credit_hold"
      ? 0
      : supplyStatus === "partial"
        ? Math.min(state.requiredPallets, vendorAvailable)
        : state.requiredPallets;
    if (directPallets > 0) {
      const directLine = proposalLine(state, directPallets, {
        vendorSupplyStatus: supplyStatus,
        importedVendorAvailablePallets: vendorAvailable,
        vendorConfirmationRequired: true
      });
      splitLineByTruck(directLine, positive(settings.truck_capacity_lbs, 78000)).forEach((line, index) => drafts.push(createDraft({
        type: "PO",
        phase: "direct_vendor",
        sourceKind: "vendor",
        sourceName: state.policy.plant || state.policy.vendor || "Vendor confirmation required",
        destinationLocationId: Number(state.policy.location_id),
        destinationName: state.policy.yard_code,
        vendor: state.policy.vendor,
        plant: state.policy.plant,
        urgent: state.urgent,
        line,
        keySuffix: index + 1
      }, settings)));
    }
    let transferNeed = Math.max(0, state.requiredPallets - (supplyStatus === "partial" ? directPallets : 0));
    let provisional = false;
    if (state.urgent && ["unknown", "available", "production_eta"].includes(supplyStatus)) {
      transferNeed = state.requiredPallets;
      provisional = true;
    }
    if (["out_of_stock", "credit_hold"].includes(supplyStatus)) transferNeed = state.requiredPallets;
    if (transferNeed > EPSILON) {
      const internal = internalTransferDrafts({ state, requestedPallets: transferNeed, stateByKey, settings, provisional, keyPrefix: "initial" });
      drafts.push(...internal.drafts);
      if (internal.remaining > EPSILON) {
        const hub = YARDS.find((yard) => yard.code === "12441");
        const vendorHubLine = proposalLine(state, internal.remaining, {
          vendorSupplyStatus: supplyStatus,
          residualAfterInternalTransferPallets: internal.remaining,
          consolidationRequired: true,
          actualDestinationYard: state.policy.yard_code
        });
        vendorHubLine.destinationLocationId = hub.locationId;
        vendorHubLine.destinationName = hub.code;
        splitLineByTruck(vendorHubLine, positive(settings.truck_capacity_lbs, 78000)).forEach((line, index) => drafts.push(createDraft({
          type: "PO",
          phase: "vendor_hub",
          sourceKind: "vendor",
          sourceName: state.policy.plant || state.policy.vendor || "Vendor",
          destinationLocationId: hub.locationId,
          destinationName: hub.code,
          vendor: state.policy.vendor,
          plant: state.policy.plant,
          urgent: state.urgent,
          line,
          status: "held",
          keySuffix: `${state.policy.yard_code}-${index + 1}`
        }, settings)));
      }
    }
    if (state.manualPlanningRequired) exceptions.push({ itemId: Number(state.policy.item_id), yard: state.policy.yard_code, reason: "Missing ToPLT or pallet weight" });
    if (state.capacityBelowMinimum) exceptions.push({
      itemId: Number(state.policy.item_id),
      yard: state.policy.yard_code,
      reason: "Remaining yard capacity is below the SKU minimum order size",
      remainingCapacityPallets: round(Math.max(0, state.capacity - state.positionPallets)),
      minimumOrderPallets: state.minimumOrder
    });
    if (state.coverageApplied && state.coverageCapacityShortfall) exceptions.push({
      itemId: Number(state.policy.item_id),
      yard: state.policy.yard_code,
      reason: "Item-yard capacity is below the configured zero-demand order coverage floor",
      capacityPallets: state.capacity,
      coverageFloorPallets: state.coverageFloor,
      coverageOrderCount: state.coverageOrderCount
    });
  }
  return { drafts, exceptions };
}

async function insertDrafts(runId, drafts = []) {
  for (const draft of drafts) {
    const proposal = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind, source_location_id, source_name,
         destination_location_id, destination_name, vendor, plant, status, urgent, provisional,
         total_pallets, total_weight_lbs, utilization, vendor_reply_due_at, memo, route_stops, manually_grouped
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)
       RETURNING id`,
      [
        runId, draft.proposalKey, draft.proposalType, draft.phase, draft.sourceKind, draft.sourceLocationId,
        draft.sourceName, draft.destinationLocationId, draft.destinationName, draft.vendor, draft.plant,
        draft.status, draft.urgent, draft.provisional, draft.totalPallets, draft.totalWeight, draft.utilization,
        draft.vendorReplyDueAt, draft.memo, JSON.stringify(draft.routeStops || routeStopsForLines(draft.lines)), Boolean(draft.manuallyGrouped)
      ]
    );
    for (const line of draft.lines) {
      await query(
        `INSERT INTO scm_smart_proposal_lines (
           proposal_id, item_id, item_name, item_description, unit, required_pallets, proposed_pallets,
           confirmed_pallets, residual_pallets, sales_quantity, pallet_weight_lbs, line_weight_lbs,
           to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason, destination_location_id, destination_name,
           urgent, provisional
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22)`,
        [
          proposal.rows[0].id, line.itemId, line.itemName, line.itemDescription, line.unit,
          line.requiredPallets, line.proposedPallets, line.confirmedPallets, line.residualPallets,
          line.salesQuantity, line.palletWeight, line.lineWeight, line.toPlt, line.toLyr, line.toSec,
          line.toPcs, line.manualPlanningRequired, JSON.stringify(line.reason || {}),
          line.destinationLocationId || draft.destinationLocationId, line.destinationName || draft.destinationName,
          Boolean(line.urgent), Boolean(line.provisional)
        ]
      );
    }
  }
}

function publicProposalLine(row) {
  return {
    id: Number(row.id),
    proposalId: Number(row.proposal_id),
    itemId: Number(row.item_id),
    itemName: row.item_name,
    itemDescription: row.item_description,
    unit: row.unit,
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name,
    requiredPallets: positive(row.required_pallets),
    proposedPallets: positive(row.proposed_pallets),
    confirmedPallets: positive(row.confirmed_pallets),
    residualPallets: positive(row.residual_pallets),
    salesQuantity: positive(row.sales_quantity),
    palletWeightLbs: row.pallet_weight_lbs === null ? null : positive(row.pallet_weight_lbs),
    lineWeightLbs: positive(row.line_weight_lbs),
    toPlt: positive(row.to_plt),
    toLyr: positive(row.to_lyr),
    toSec: positive(row.to_sec),
    toPcs: positive(row.to_pcs),
    manualPlanningRequired: Boolean(row.manual_planning_required),
    urgent: Boolean(row.urgent),
    provisional: Boolean(row.provisional),
    isAlternative: Boolean(row.is_alternative),
    alternativeForLineId: row.alternative_for_line_id === null ? null : Number(row.alternative_for_line_id),
    addedSource: row.added_source || "planning",
    addedBy: row.added_by || null,
    reason: row.reason || {},
    vendorResponses: row.vendor_responses || []
  };
}

function publicProposal(row) {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    proposalKey: row.proposal_key,
    proposalType: row.proposal_type,
    phase: row.phase,
    sourceKind: row.source_kind,
    sourceLocationId: row.source_location_id === null ? null : Number(row.source_location_id),
    sourceName: row.source_name,
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name,
    vendor: row.vendor,
    plant: row.plant,
    status: row.status,
    urgent: Boolean(row.urgent),
    provisional: Boolean(row.provisional),
    totalPallets: positive(row.total_pallets),
    totalWeightLbs: positive(row.total_weight_lbs),
    utilization: positive(row.utilization),
    routeStops: Array.isArray(row.route_stops) ? row.route_stops : [],
    manuallyGrouped: Boolean(row.manually_grouped),
    vendorReplyDueAt: row.vendor_reply_due_at,
    orderRequestedAt: row.order_requested_at,
    orderRequestedBy: row.order_requested_by,
    vendorRepliedAt: row.vendor_replied_at,
    vendorRepliedBy: row.vendor_replied_by,
    vendorResponseStatus: row.vendor_response_status || "awaiting",
    vendorReadyDate: row.vendor_ready_date,
    vendorReference: row.vendor_reference,
    vendorPackingNumber: row.vendor_packing_number,
    vendorCreditStatus: row.vendor_credit_status,
    vendorRemarks: row.vendor_remarks,
    vendorResponseSource: row.vendor_response_source,
    netsuitePurchaseOrderId: row.netsuite_purchase_order_id === null ? null : Number(row.netsuite_purchase_order_id),
    netsuitePurchaseOrderRef: row.netsuite_purchase_order_ref,
    poExecutionStatus: row.po_execution_status || "idle",
    poExecutionError: row.po_execution_error,
    planningRunCreatedAt: row.planning_run_created_at || null,
    planningRunCompletedAt: row.planning_run_completed_at || null,
    memo: row.memo,
    executionMode: row.execution_mode,
    executionStatus: row.execution_status,
    executionError: row.execution_error,
    netsuiteTransferOrderId: row.netsuite_transfer_order_id === null ? null : Number(row.netsuite_transfer_order_id),
    netsuiteTransferOrderRef: row.netsuite_transfer_order_ref,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: Array.isArray(row.lines) ? row.lines.map(publicProposalLine) : []
  };
}

async function proposalRows({ proposalId = null, runId = null, status = "", statuses = [], type = "", search = "", requestedOnly = false, vendorQueue = false, limit = 500 } = {}) {
  const params = [];
  const clauses = [];
  if (proposalId) {
    params.push(Number(proposalId));
    clauses.push(`p.id = $${params.length}`);
  }
  if (runId) {
    params.push(Number(runId));
    clauses.push(`p.run_id = $${params.length}`);
  }
  if (status) {
    params.push(String(status));
    clauses.push(`p.status = $${params.length}`);
  }
  const statusList = Array.isArray(statuses) ? statuses.map(String).filter(Boolean) : [];
  if (statusList.length) {
    params.push(statusList);
    clauses.push(`p.status = ANY($${params.length}::text[])`);
  }
  if (requestedOnly) clauses.push("p.order_requested_at IS NOT NULL");
  if (type) {
    params.push(String(type).toUpperCase());
    clauses.push(`p.proposal_type = $${params.length}`);
  }
  if (search) {
    params.push(`%${text(search)}%`);
    clauses.push(`(p.id::text ILIKE $${params.length} OR p.source_name ILIKE $${params.length} OR p.destination_name ILIKE $${params.length} OR p.vendor ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM scm_smart_proposal_lines search_line WHERE search_line.proposal_id = p.id
        AND (search_line.item_name ILIKE $${params.length} OR search_line.item_id::text ILIKE $${params.length})
    ))`);
  }
  params.push(Math.min(2000, Math.max(1, Number(limit) || 500)));
  const result = await query(
    `SELECT p.*,
            planning_run.started_at AS planning_run_created_at,
            planning_run.completed_at AS planning_run_completed_at,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('vendor_responses', COALESCE((
                SELECT jsonb_agg(to_jsonb(v) ORDER BY v.revision DESC)
                  FROM scm_smart_vendor_responses v WHERE v.proposal_line_id = l.id
              ), '[]'::jsonb)) ORDER BY l.id)
                FROM scm_smart_proposal_lines l WHERE l.proposal_id = p.id
            ), '[]'::jsonb) AS lines
       FROM scm_smart_proposals p
       LEFT JOIN scm_smart_planning_runs planning_run ON planning_run.id = p.run_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY ${vendorQueue ? "p.order_requested_at DESC NULLS LAST, p.id DESC" : "p.run_id DESC, p.urgent DESC, p.id"}
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function runSmartScmPlan({ triggerSource = "manual", operatorId = null, forecastRunId = null } = {}) {
  const selectedForecastRunId = forecastRunId || await latestSmartScmForecastRunId();
  const [settings, policies, inventory, supplyMap, forecasts, routeRules] = await Promise.all([
    settingsRow(),
    planningPolicies(),
    inventoryState(),
    latestVendorSupplyMap(),
    smartScmForecastMap(selectedForecastRunId),
    smartScmRouteRuleMap()
  ]);
  const minimumOrders = await minimumOrderMap(policies);
  const created = await query(
    `INSERT INTO scm_smart_planning_runs (trigger_source, forecast_run_id, settings_snapshot, created_by)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING *`,
    [triggerSource, selectedForecastRunId, JSON.stringify(settings), operatorId]
  );
  const run = created.rows[0];
  try {
    const states = policies.map((policy) => calculatePolicyState(
      policy,
      forecasts.get(`${policy.item_id}:${policy.location_id}`),
      inventory,
      minimumOrders.get(`${policy.item_id}:${policy.location_id}`),
      settings
    ));
    const calculated = buildPlanningDrafts({ states, supplyMap, settings });
    const drafts = consolidateCompatibleDrafts(calculated.drafts, settings, "initial", routeRules);
    const { exceptions } = calculated;
    await withTransaction(async () => {
      await insertDrafts(run.id, drafts);
      const totals = {
        shortageLines: states.filter((state) => state.requiredPallets > 0).length,
        zeroDemandCoverageLines: states.filter((state) => state.coverageCausedNeed && state.requiredPallets > 0).length,
        zeroDemandReviewLines: states.filter((state) => state.coverageReviewRequired && state.requiredPallets > 0).length,
        proposals: drafts.length,
        poProposals: drafts.filter((draft) => draft.proposalType === "PO").length,
        toProposals: drafts.filter((draft) => draft.proposalType === "TO").length,
        urgent: drafts.filter((draft) => draft.urgent).length,
        held: drafts.filter((draft) => draft.status === "held").length,
        exceptions
      };
      await query(
        `UPDATE scm_smart_planning_runs
            SET status = 'ready', totals = $2::jsonb, completed_at = now()
          WHERE id = $1`,
        [run.id, JSON.stringify(totals)]
      );
    });
    await writeAudit({
      actorType: operatorId ? "operator" : "system",
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.plan.completed",
      details: { runId: Number(run.id), forecastRunId: selectedForecastRunId, triggerSource, proposalCount: drafts.length, exceptions }
    });
    return getSmartScmPlanningRun(run.id);
  } catch (error) {
    await query("UPDATE scm_smart_planning_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1", [run.id, error.message]);
    await writeAudit({
      actorType: operatorId ? "operator" : "system",
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.plan.failed",
      details: { runId: Number(run.id), error: error.message }
    });
    throw error;
  }
}

export async function listSmartScmPlanningRuns({ limit = 30 } = {}) {
  const result = await query(
    `SELECT * FROM scm_smart_planning_runs ORDER BY id DESC LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit) || 30))]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    status: row.status,
    triggerSource: row.trigger_source,
    forecastRunId: row.forecast_run_id === null ? null : Number(row.forecast_run_id),
    revision: Number(row.revision || 1),
    totals: row.totals || {},
    error: row.error,
    createdBy: row.created_by,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }));
}

export async function getSmartScmPlanningRun(id) {
  const result = await query("SELECT * FROM scm_smart_planning_runs WHERE id = $1", [Number(id)]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const proposals = (await proposalRows({ runId: row.id, limit: 2000 })).map(publicProposal);
  const revisions = await query("SELECT * FROM scm_smart_plan_revisions WHERE run_id = $1 ORDER BY revision DESC", [row.id]);
  return {
    id: Number(row.id),
    status: row.status,
    triggerSource: row.trigger_source,
    forecastRunId: row.forecast_run_id === null ? null : Number(row.forecast_run_id),
    revision: Number(row.revision || 1),
    settingsSnapshot: row.settings_snapshot || {},
    totals: row.totals || {},
    error: row.error,
    createdBy: row.created_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    proposals,
    revisions: revisions.rows.map((revision) => ({
      id: Number(revision.id),
      revision: Number(revision.revision),
      reason: revision.reason,
      diff: revision.diff || {},
      createdBy: revision.created_by,
      createdAt: revision.created_at
    }))
  };
}

export async function listSmartScmProposals(filters = {}) {
  return (await proposalRows(filters)).map(publicProposal);
}

export async function getSmartScmProposal(proposalId) {
  const rows = await proposalRows({ proposalId, limit: 1 });
  return rows.length ? publicProposal(rows[0]) : null;
}

export async function updateSmartScmProposal(proposalId, patch = {}, operatorId = null) {
  const currentResult = await query("SELECT * FROM scm_smart_proposals WHERE id = $1", [Number(proposalId)]);
  if (!currentResult.rowCount) throw Object.assign(new Error("Smart SCM proposal was not found."), { status: 404 });
  const current = currentResult.rows[0];
  if (["confirmed", "executing", "completed", "superseded", "cancelled"].includes(current.status)) {
    throw Object.assign(new Error("This proposal is locked and cannot be edited."), { status: 409 });
  }
  const hasExecutionReference = current.netsuite_transfer_order_id || current.netsuite_transfer_order_ref
    || current.netsuite_purchase_order_id || current.netsuite_purchase_order_ref;
  if (hasExecutionReference) {
    throw Object.assign(new Error("This proposal already has an execution reference and cannot be changed."), { status: 409 });
  }
  const nextStatus = patch.status ? String(patch.status) : current.status;
  let result;
  if (current.proposal_type === "PO") {
    const transitions = {
      held: new Set(["held", "order_requested", "cancelled"]),
      order_requested: new Set(["order_requested", "held", "cancelled"]),
      vendor_replied: new Set(["vendor_replied", "cancelled"]),
      attention: new Set(["attention", "vendor_replied", "cancelled"]),
      failed: new Set(["failed", "vendor_replied", "cancelled"])
    };
    if (!transitions[current.status]?.has(nextStatus)) {
      throw Object.assign(new Error(`A PO load cannot move from ${current.status.replaceAll("_", " ")} to ${nextStatus.replaceAll("_", " ")}.`), { status: 409 });
    }
    const settings = await settingsRow();
    result = await query(
      `UPDATE scm_smart_proposals
          SET status = $2,
              memo = NULLIF($3, ''),
              order_requested_at = CASE WHEN $2 = 'order_requested' AND status <> 'order_requested' THEN now() WHEN $2 = 'held' THEN NULL ELSE order_requested_at END,
              order_requested_by = CASE WHEN $2 = 'order_requested' AND status <> 'order_requested' THEN $4 WHEN $2 = 'held' THEN NULL ELSE order_requested_by END,
              vendor_reply_due_at = CASE WHEN $2 = 'order_requested' AND status <> 'order_requested' THEN now() + ($5 * interval '1 hour') WHEN $2 = 'held' THEN NULL ELSE vendor_reply_due_at END,
              po_execution_error = CASE WHEN $2 = 'order_requested' THEN NULL ELSE po_execution_error END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [Number(proposalId), nextStatus, text(patch.memo ?? current.memo), operatorId, positive(settings.vendor_response_sla_hours, 24)]
    );
  } else {
    const allowedStatuses = new Set(["draft", "held", "reviewed", "attention", "cancelled"]);
    if (!allowedStatuses.has(nextStatus)) throw Object.assign(new Error("Invalid editable TO proposal status."), { status: 400 });
    result = await query(
      `UPDATE scm_smart_proposals
          SET status = $2, memo = NULLIF($3, ''), updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [Number(proposalId), nextStatus, text(patch.memo ?? current.memo)]
    );
  }
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: nextStatus === "order_requested" ? "smart_scm.purchase.order_requested" : "smart_scm.proposal.update",
    details: { proposalId: Number(proposalId), beforeStatus: current.status, status: nextStatus, memo: patch.memo }
  });
  return (await proposalRows({ runId: result.rows[0].run_id, limit: 2000 })).map(publicProposal).find((proposal) => proposal.id === Number(proposalId));
}

async function latestResponseRevision(lineId) {
  const result = await query("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM scm_smart_vendor_responses WHERE proposal_line_id = $1", [lineId]);
  return Number(result.rows[0]?.revision || 1);
}

async function runSnapshot(runId) {
  const proposals = await listSmartScmProposals({ runId, limit: 2000 });
  return { proposals: proposals.map((proposal) => ({
    id: proposal.id,
    type: proposal.proposalType,
    phase: proposal.phase,
    status: proposal.status,
    source: proposal.sourceName,
    destination: proposal.destinationName,
    lines: proposal.lines.map((line) => ({ id: line.id, itemId: line.itemId, proposedPallets: line.proposedPallets, confirmedPallets: line.confirmedPallets, residualPallets: line.residualPallets }))
  })) };
}

async function vendorResponseTransferRevision({ runId, line, response, revision, operatorId }) {
  const settings = await settingsRow();
  const locked = await query(
    `SELECT p.id, p.netsuite_transfer_order_id, p.netsuite_transfer_order_ref,
            SUM(l.proposed_pallets) AS item_pallets
       FROM scm_smart_proposals p
       JOIN scm_smart_proposal_lines l ON l.proposal_id = p.id
      WHERE p.run_id = $1
        AND p.proposal_type = 'TO'
        AND p.destination_location_id = $2
        AND l.item_id = $3
        AND p.status IN ('confirmed', 'executing', 'completed')
      GROUP BY p.id, p.netsuite_transfer_order_id, p.netsuite_transfer_order_ref`,
    [runId, line.destination_location_id, line.item_id]
  );
  const unlocked = await query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM scm_smart_proposal_lines all_lines WHERE all_lines.proposal_id = p.id) AS line_count
       FROM scm_smart_proposals p
      WHERE p.run_id = $1
        AND p.proposal_type = 'TO'
        AND p.destination_location_id = $2
        AND p.status IN ('draft', 'held', 'reviewed', 'attention')
        AND EXISTS (
          SELECT 1 FROM scm_smart_proposal_lines target_line
           WHERE target_line.proposal_id = p.id AND target_line.item_id = $3
        )
      FOR UPDATE OF p`,
    [runId, line.destination_location_id, line.item_id]
  );
  let superseded = 0;
  let trimmed = 0;
  for (const proposal of unlocked.rows) {
    if (Number(proposal.line_count) <= 1) {
      await query(
        `UPDATE scm_smart_proposals
            SET status = 'superseded', superseded_at = now(), updated_at = now()
          WHERE id = $1`,
        [proposal.id]
      );
      superseded += 1;
      continue;
    }
    await query("DELETE FROM scm_smart_proposal_lines WHERE proposal_id = $1 AND item_id = $2", [proposal.id, line.item_id]);
    await query(
      `WITH totals AS (
         SELECT COALESCE(SUM(proposed_pallets), 0) AS pallets,
                COALESCE(SUM(line_weight_lbs), 0) AS weight,
                COUNT(*) AS lines
           FROM scm_smart_proposal_lines
          WHERE proposal_id = $1
       )
       UPDATE scm_smart_proposals p
          SET total_pallets = totals.pallets,
              total_weight_lbs = totals.weight,
              utilization = totals.weight / $2,
              urgent = EXISTS (SELECT 1 FROM scm_smart_proposal_lines l WHERE l.proposal_id = p.id AND l.urgent),
              provisional = EXISTS (SELECT 1 FROM scm_smart_proposal_lines l WHERE l.proposal_id = p.id AND l.provisional),
              status = CASE
                WHEN EXISTS (SELECT 1 FROM scm_smart_proposal_lines l WHERE l.proposal_id = p.id AND l.manual_planning_required) THEN 'attention'
                WHEN p.phase = 'hub_store' THEN 'held'
                WHEN totals.weight / $2 < $3 THEN 'held'
                ELSE 'draft'
              END,
              memo = p.phase || ' · revised load · ' || totals.lines || CASE WHEN totals.lines = 1 THEN ' item' ELSE ' items' END,
              updated_at = now()
         FROM totals
        WHERE p.id = $1`,
      [proposal.id, positive(settings.truck_capacity_lbs, 78000), positive(settings.hold_load_ratio, 0.5)]
    );
    trimmed += 1;
  }
  const responseStatus = String(response.responseStatus || response.status || "awaiting");
  const confirmed = positive(response.confirmedPallets);
  const residual = Math.max(0, positive(line.proposed_pallets) - confirmed);
  const lockedPallets = locked.rows.reduce((sum, row) => sum + positive(row.item_pallets), 0);
  const transferResidual = Math.max(0, residual - lockedPallets);
  const readyDate = response.readyDate ? new Date(`${response.readyDate}T00:00:00Z`) : null;
  const withinSevenDays = readyDate && readyDate.getTime() <= Date.now() + (7 * 86400000);
  const shouldTransfer = transferResidual > EPSILON && (
    ["partial", "out_of_stock", "credit_hold", "cancelled"].includes(responseStatus)
    || (responseStatus === "production_eta" && !withinSevenDays)
  );
  let created = 0;
  if (shouldTransfer) {
    const [policies, inventory, forecastMap] = await Promise.all([planningPolicies(), inventoryState(), smartScmForecastMap()]);
    const minimumOrders = await minimumOrderMap(policies);
    const policy = policies.find((candidate) => String(candidate.item_id) === String(line.item_id) && String(candidate.location_id) === String(line.destination_location_id));
    if (policy) {
      const stateByKey = new Map(policies.map((candidate) => {
        const state = calculatePolicyState(candidate, forecastMap.get(`${candidate.item_id}:${candidate.location_id}`), inventory, minimumOrders.get(`${candidate.item_id}:${candidate.location_id}`), settings);
        return [state.key, state];
      }));
      const state = stateByKey.get(`${line.item_id}:${line.destination_location_id}`);
      state.requiredPallets = Math.ceil(transferResidual);
      const transfer = internalTransferDrafts({ state, requestedPallets: transferResidual, stateByKey, settings, provisional: false, keyPrefix: `reply-${line.id}-${revision}` });
      const revisedDrafts = consolidateCompatibleDrafts(transfer.drafts, settings, `reply-${line.id}-${revision}`);
      await insertDrafts(runId, revisedDrafts);
      created = revisedDrafts.length;
    }
  }
  return {
    responseStatus,
    confirmedPallets: confirmed,
    residualPallets: residual,
    lockedCoveragePallets: lockedPallets,
    uncoveredAfterLockedTransfers: transferResidual,
    supersededDraftAlternatives: superseded,
    trimmedDraftLoads: trimmed,
    newTransferAlternatives: created,
    lockedTransferOrders: locked.rows.map((row) => ({ proposalId: Number(row.id), netsuiteTransferOrderId: row.netsuite_transfer_order_id, netsuiteTransferOrderRef: row.netsuite_transfer_order_ref, pallets: positive(row.item_pallets) })),
    attentionRequired: locked.rowCount > 0 && confirmed > EPSILON
  };
}

export async function recordSmartScmVendorResponses(responses = [], operatorId = null) {
  const list = Array.isArray(responses) ? responses : [responses];
  if (!list.length) throw Object.assign(new Error("At least one vendor response is required."), { status: 400 });
  const firstLine = await query(
    `SELECT l.*, p.run_id, p.proposal_type, p.phase, p.destination_location_id, p.status AS proposal_status
       FROM scm_smart_proposal_lines l
       JOIN scm_smart_proposals p ON p.id = l.proposal_id
      WHERE l.id = $1`,
    [Number(list[0].proposalLineId)]
  );
  if (!firstLine.rowCount) throw Object.assign(new Error("Vendor response line was not found."), { status: 404 });
  const runId = Number(firstLine.rows[0].run_id);
  const before = await runSnapshot(runId);
  const diffs = [];
  await withTransaction(async () => {
    for (const response of list) {
      const lineResult = await query(
        `SELECT l.*, p.run_id, p.proposal_type, p.phase, p.destination_location_id, p.status AS proposal_status
           FROM scm_smart_proposal_lines l
           JOIN scm_smart_proposals p ON p.id = l.proposal_id
          WHERE l.id = $1
          FOR UPDATE OF l, p`,
        [Number(response.proposalLineId)]
      );
      if (!lineResult.rowCount) throw Object.assign(new Error("Vendor response line was not found."), { status: 404 });
      const line = lineResult.rows[0];
      if (Number(line.run_id) !== runId || line.proposal_type !== "PO") throw Object.assign(new Error("Vendor replies can only update PO lines in one planning run."), { status: 400 });
      if (!["order_requested", "vendor_replied"].includes(line.proposal_status)) {
        throw Object.assign(new Error("Vendor replies can only be recorded after the PO load is marked Order Requested."), { status: 409 });
      }
      const responseStatus = String(response.responseStatus || response.status || "awaiting");
      const validStatuses = new Set(["awaiting", "confirmed", "partial", "out_of_stock", "production_eta", "credit_hold", "cancelled"]);
      if (!validStatuses.has(responseStatus)) throw Object.assign(new Error("Invalid vendor response status."), { status: 400 });
      const revision = await latestResponseRevision(line.id);
      const proposed = positive(line.proposed_pallets);
      const confirmed = responseStatus === "confirmed"
        ? (response.confirmedPallets === undefined || response.confirmedPallets === "" ? proposed : positive(response.confirmedPallets))
        : positive(response.confirmedPallets);
      if (responseStatus === "partial" && (confirmed <= EPSILON || confirmed >= proposed - EPSILON)) {
        throw Object.assign(new Error("A partial vendor reply requires confirmed pallets greater than zero and below the requested pallets."), { status: 400 });
      }
      if (["out_of_stock", "credit_hold", "cancelled"].includes(responseStatus) && confirmed > EPSILON) {
        throw Object.assign(new Error(`${responseStatus.replaceAll("_", " ")} requires zero confirmed pallets; use partial when some stock is available.`), { status: 400 });
      }
      if (responseStatus === "production_eta") {
        const ready = /^\d{4}-\d{2}-\d{2}$/.test(String(response.readyDate || "")) ? new Date(`${response.readyDate}T00:00:00Z`) : null;
        if (!ready || Number.isNaN(ready.getTime())) throw Object.assign(new Error("Production ETA requires a valid ready date."), { status: 400 });
      }
      const unavailable = response.unavailablePallets === undefined
        ? Math.max(0, proposed - confirmed)
        : Math.min(proposed, positive(response.unavailablePallets));
      await query(
        `INSERT INTO scm_smart_vendor_responses (
           proposal_line_id, revision, response_status, confirmed_pallets, unavailable_pallets,
           ready_date, vendor_reference, netsuite_po_reference, packing_number, credit_status,
           remarks, response_source, responded_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          line.id, revision, responseStatus, confirmed, unavailable, response.readyDate || null,
          text(response.vendorReference) || null, null,
          text(response.packingNumber) || null, text(response.creditStatus) || null,
          text(response.remarks) || null, text(response.responseSource) || "grid", operatorId
        ]
      );
      await query(
        `UPDATE scm_smart_proposal_lines
            SET confirmed_pallets = $2,
                residual_pallets = GREATEST(proposed_pallets - $2, 0),
                updated_at = now()
          WHERE id = $1`,
        [line.id, confirmed]
      );
      await query(
        `UPDATE scm_smart_proposals p
            SET status = 'vendor_replied',
                vendor_replied_at = now(),
                vendor_replied_by = $2,
                updated_at = now()
          WHERE p.id = $1`,
        [line.proposal_id, operatorId]
      );
      diffs.push(await vendorResponseTransferRevision({ runId, line, response: { ...response, responseStatus, confirmedPallets: confirmed }, revision, operatorId }));
    }
    const revisionResult = await query("UPDATE scm_smart_planning_runs SET revision = revision + 1 WHERE id = $1 RETURNING revision", [runId]);
    const nextRevision = Number(revisionResult.rows[0].revision);
    const after = await runSnapshot(runId);
    await query(
      `INSERT INTO scm_smart_plan_revisions (run_id, revision, reason, before_snapshot, after_snapshot, diff, created_by)
       VALUES ($1, $2, 'vendor_response', $3::jsonb, $4::jsonb, $5::jsonb, $6)`,
      [runId, nextRevision, JSON.stringify(before), JSON.stringify(after), JSON.stringify({ vendorResponses: diffs }), operatorId]
    );
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_response.record",
    details: { runId, responseCount: list.length, diffs }
  });
  return getSmartScmPlanningRun(runId);
}

export async function prepareSmartScmTransferExecution(proposalId, operatorId = null) {
  return withTransaction(async () => {
    const result = await query(
      `SELECT p.*,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)
                  FROM scm_smart_proposal_lines l
                 WHERE l.proposal_id = p.id
              ), '[]'::jsonb) AS lines
         FROM scm_smart_proposals p
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [Number(proposalId)]
    );
    if (!result.rowCount) throw Object.assign(new Error("Smart SCM TO proposal was not found."), { status: 404 });
    const proposal = result.rows[0];
    if (proposal.proposal_type !== "TO") throw Object.assign(new Error("Only a TO proposal can be executed."), { status: 400 });
    if (proposal.netsuite_transfer_order_id || proposal.netsuite_transfer_order_ref) {
      throw Object.assign(new Error("This proposal already has an execution reference. Use picking-ticket retry instead of creating another TO."), { status: 409 });
    }
    if (!["draft", "reviewed", "held"].includes(proposal.status)) throw Object.assign(new Error("This TO proposal is not available for confirmation."), { status: 409 });
    if (proposal.phase === "hub_store") {
      throw Object.assign(new Error("This legacy provisional TO depends on stock that has not been received. Run a new plan after the inventory is available at the source yard."), { status: 409 });
    }
    if (proposal.status === "held") throw Object.assign(new Error("Review and release this held load before confirming it."), { status: 409 });
    if (proposal.lines.some((line) => line.manual_planning_required)) throw Object.assign(new Error("Resolve missing conversion or pallet weight before confirming this load."), { status: 409 });
    const settings = await settingsRow();
    const [policies, inventory, forecastMap] = await Promise.all([planningPolicies(), inventoryState(), smartScmForecastMap()]);
    const minimumOrders = await minimumOrderMap(policies);
    const sourceStates = new Map(policies
      .filter((policy) => Number(policy.location_id) === Number(proposal.source_location_id))
      .map((policy) => {
        const state = calculatePolicyState(policy, forecastMap.get(`${policy.item_id}:${policy.location_id}`), inventory, minimumOrders.get(`${policy.item_id}:${policy.location_id}`), settings);
        return [String(policy.item_id), state];
      }));
    for (const line of [...proposal.lines].sort((left, right) => Number(left.item_id) - Number(right.item_id))) {
      const balance = await query(
        `SELECT quantity_available AS available
           FROM inventory_balances
          WHERE item_id = $1 AND location_id = $2
          FOR UPDATE`,
        [line.item_id, proposal.source_location_id]
      );
      const reservations = await query(
        `SELECT COALESCE(SUM(reserved_sales_quantity), 0) AS reserved
           FROM scm_smart_inventory_reservations
          WHERE item_id = $1 AND source_location_id = $2 AND status = 'active'`,
        [line.item_id, proposal.source_location_id]
      );
      const sourceState = sourceStates.get(String(line.item_id));
      if (!sourceState || sourceState.toPlt <= EPSILON) {
        throw Object.assign(new Error(`${line.item_name} has no active source-yard policy or pallet conversion at ${proposal.source_name}. Refresh and replan.`), { status: 409 });
      }
      const availableSales = Math.max(0, positive(balance.rows[0]?.available) - positive(reservations.rows[0]?.reserved));
      const availablePallets = availableSales / sourceState.toPlt;
      const limit = smartScmSourceTransferLimit({
        availablePallets,
        safetyStockPallets: sourceState.safety,
        reorderPointPallets: sourceState.rop
      });
      const { protectedFloorPallets: protectedFloor, maximumTransferablePallets: maximumTransferable } = limit;
      if (positive(line.proposed_pallets) > maximumTransferable + EPSILON) {
        throw Object.assign(new Error(`${line.item_name} can transfer at most ${maximumTransferable} PLT from ${proposal.source_name}: ${round(availablePallets, 2)} available and ${round(protectedFloor, 2)} protected (safety stock / reorder point). Refresh and replan.`), { status: 409 });
      }
    }
    await query(
      `UPDATE scm_smart_proposals
          SET status = 'executing', execution_mode = $2, execution_status = 'creating', execution_error = NULL,
              confirmed_by = $3, confirmed_at = now(), updated_at = now()
        WHERE id = $1`,
      [proposal.id, settings.execution_mode, operatorId]
    );
    for (const line of proposal.lines) {
      await query(
        `INSERT INTO scm_smart_inventory_reservations (
           proposal_line_id, item_id, source_location_id, destination_location_id,
           reserved_sales_quantity, reserved_pallets, status
         ) VALUES ($1,$2,$3,$4,$5,$6,'active')
         ON CONFLICT (proposal_line_id) DO UPDATE SET
           reserved_sales_quantity = EXCLUDED.reserved_sales_quantity,
           reserved_pallets = EXCLUDED.reserved_pallets,
           status = 'active', updated_at = now()`,
        [line.id, line.item_id, proposal.source_location_id, proposal.destination_location_id, line.sales_quantity, line.proposed_pallets]
      );
    }
    return {
      id: Number(proposal.id),
      runId: Number(proposal.run_id),
      mode: settings.execution_mode,
      sourceLocationId: Number(proposal.source_location_id),
      sourceName: proposal.source_name,
      destinationLocationId: Number(proposal.destination_location_id),
      destinationName: proposal.destination_name,
      memo: proposal.memo,
      totalPallets: positive(proposal.total_pallets),
      lines: proposal.lines.map((line) => ({
        id: Number(line.id),
        itemId: Number(line.item_id),
        itemName: line.item_name,
        proposedQuantity: positive(line.sales_quantity),
        palletQty: positive(line.proposed_pallets),
        layerQty: 0,
        sectionQty: 0,
        pieceQty: 0,
        toPlt: positive(line.to_plt),
        toLyr: positive(line.to_lyr),
        toSec: positive(line.to_sec),
        toPcs: positive(line.to_pcs)
      }))
    };
  });
}

export async function completeSmartScmTransferExecution(proposalId, { transferOrderId = null, transferOrderRef = null, mock = false } = {}, operatorId = null) {
  const result = await withTransaction(async () => {
    const updated = await query(
      `UPDATE scm_smart_proposals
          SET status = 'completed', execution_status = $2, execution_error = NULL,
              netsuite_transfer_order_id = $3, netsuite_transfer_order_ref = $4,
              approved_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [Number(proposalId), mock ? "mock_completed" : "approved", transferOrderId, transferOrderRef]
    );
    if (!updated.rowCount) throw Object.assign(new Error("Smart SCM proposal was not found."), { status: 404 });
    await query(
      `UPDATE scm_smart_inventory_reservations
          SET status = 'executed', netsuite_transfer_order_id = $2, updated_at = now()
        WHERE proposal_line_id IN (SELECT id FROM scm_smart_proposal_lines WHERE proposal_id = $1)`,
      [Number(proposalId), transferOrderId]
    );
    return updated.rows[0];
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: mock ? "smart_scm.transfer.mock_completed" : "smart_scm.transfer.completed",
    orderId: transferOrderId,
    details: { proposalId: Number(proposalId), transferOrderId, transferOrderRef, mock }
  });
  return publicProposal({ ...result, lines: [] });
}

export async function failSmartScmTransferExecution(proposalId, error, operatorId = null) {
  await withTransaction(async () => {
    await query(
      `UPDATE scm_smart_proposals
          SET status = 'failed', execution_status = 'failed', execution_error = $2, updated_at = now()
        WHERE id = $1`,
      [Number(proposalId), text(error?.message || error)]
    );
    await query(
      `UPDATE scm_smart_inventory_reservations
          SET status = 'released', updated_at = now()
        WHERE proposal_line_id IN (SELECT id FROM scm_smart_proposal_lines WHERE proposal_id = $1)
          AND status = 'active'`,
      [Number(proposalId)]
    );
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.transfer.failed",
    details: { proposalId: Number(proposalId), error: text(error?.message || error) }
  });
}

export async function markSmartScmTransferAttention(proposalId, { transferOrderId = null, transferOrderRef = null, error } = {}, operatorId = null) {
  const message = text(error?.message || error || "Smart SCM transfer requires attention.");
  await withTransaction(async () => {
    await query(
      `UPDATE scm_smart_proposals
          SET status = 'attention', execution_status = 'attention', execution_error = $2,
              netsuite_transfer_order_id = COALESCE($3, netsuite_transfer_order_id),
              netsuite_transfer_order_ref = COALESCE(NULLIF($4, ''), netsuite_transfer_order_ref),
              updated_at = now()
        WHERE id = $1`,
      [Number(proposalId), message, transferOrderId, transferOrderRef]
    );
    if (transferOrderId) {
      await query(
        `UPDATE scm_smart_inventory_reservations
            SET status = 'executed', netsuite_transfer_order_id = $2, updated_at = now()
          WHERE proposal_line_id IN (SELECT id FROM scm_smart_proposal_lines WHERE proposal_id = $1)`,
        [Number(proposalId), transferOrderId]
      );
    }
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.transfer.attention",
    orderId: transferOrderId,
    details: { proposalId: Number(proposalId), transferOrderId, transferOrderRef, error: message }
  });
}
