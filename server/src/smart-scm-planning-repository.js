import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { latestSmartScmForecastRunId, smartScmForecastMap } from "./smart-scm-forecast-repository.js";
import { calculateSmartScmOrderRequirement, calculateSmartScmPolicyLevels } from "./smart-scm-policy-calculation.js";
import { smartScmBuiltInRouteRule, smartScmIsGormleySource, smartScmRouteRuleKey, smartScmRouteRuleMap } from "./smart-scm-route-repository.js";
import { listSmartScmActivePlanningExclusionItemIds } from "./smart-scm-planning-exclusion-repository.js";

const EPSILON = 0.000001;
export const SMART_SCM_MAX_PALLET_OVERRIDE_QUANTITY = 1_000_000;
const MANUAL_CAPACITY_REASON_KEYS = Object.freeze([
  "manualCapacityOverride",
  "manualCapacityOverrideSource",
  "manualCapacityOverrideWeightLbs",
  "manualCapacityOverrideTruckCapacityLbs"
]);
const YARDS = Object.freeze([
  { code: "3445", locationId: 1, priority: 2 },
  { code: "2967", locationId: 28, priority: 3 },
  { code: "12441", locationId: 15, priority: 1 },
  { code: "150", locationId: 26, priority: 4 }
]);
const YARD_BY_ID = new Map(YARDS.map((yard) => [String(yard.locationId), yard]));
const PO_STOP_PRIORITY = new Map([[26, 0], [15, 1], [1, 2], [28, 3]]);
const URGENCY_LEVELS = Object.freeze(["normal", "urgent", "super_urgent", "ultimate_urgent"]);
const URGENCY_RANK = new Map(URGENCY_LEVELS.map((level, index) => [level, index]));

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

export function smartScmEffectiveInboundSales({
  authoritativeOnOrderSales = 0,
  blanketExcludedSales = 0,
  excludedTransferOrderSales = 0,
  reservedBlanketSales = 0,
  pendingTransferReservationSales = 0
} = {}) {
  const authoritative = positive(authoritativeOnOrderSales);
  const blanketExcluded = positive(blanketExcludedSales);
  const transferExcluded = positive(excludedTransferOrderSales);
  const blanketReserved = positive(reservedBlanketSales);
  const transferReserved = positive(pendingTransferReservationSales);
  return {
    authoritativeOnOrderSales: authoritative,
    blanketExcludedSales: blanketExcluded,
    excludedTransferOrderSales: transferExcluded,
    reservedBlanketSales: blanketReserved,
    pendingTransferReservationSales: transferReserved,
    effectiveOnOrderSales: round(
      Math.max(0, authoritative - blanketExcluded - transferExcluded)
        + blanketReserved
        + transferReserved
    )
  };
}

export function smartScmInventoryPositionSales({
  quantityAvailableSales = 0,
  quantityBackorderedSales = 0,
  reservedOutboundSales = 0,
  ...inboundValues
} = {}) {
  const inbound = smartScmEffectiveInboundSales(inboundValues);
  const available = positive(quantityAvailableSales);
  const backordered = positive(quantityBackorderedSales);
  const outboundReserved = positive(reservedOutboundSales);
  return {
    quantityAvailableSales: available,
    ...inbound,
    quantityBackorderedSales: backordered,
    reservedOutboundSales: outboundReserved,
    inventoryPositionSales: round(
      available + inbound.effectiveOnOrderSales - backordered - outboundReserved
    )
  };
}

export function smartScmUrgencyLevel(value, urgent = false) {
  const level = String(value || "").trim().toLowerCase();
  if (URGENCY_RANK.has(level)) return level === "normal" && urgent ? "urgent" : level;
  return urgent ? "urgent" : "normal";
}

export function smartScmUrgencyRank(value, urgent = false) {
  return URGENCY_RANK.get(smartScmUrgencyLevel(value, urgent)) || 0;
}

function urgencyScore(value, urgent = false) {
  return urgent ? round(Math.min(100, Math.max(0, number(value))), 4) : 0;
}

export function smartScmUrgencySummary(lines = []) {
  let level = "normal";
  let score = 0;
  for (const line of lines) {
    const lineUrgent = Boolean(line?.urgent) || smartScmUrgencyRank(line?.urgencyLevel ?? line?.urgency_level) > 0;
    const lineLevel = smartScmUrgencyLevel(line?.urgencyLevel ?? line?.urgency_level, lineUrgent);
    const lineScore = urgencyScore(line?.urgencyScore ?? line?.urgency_score, lineUrgent);
    const rankDifference = smartScmUrgencyRank(lineLevel) - smartScmUrgencyRank(level);
    if (rankDifference > 0 || (rankDifference === 0 && lineScore > score)) {
      level = lineLevel;
      score = lineScore;
    }
  }
  return { urgent: smartScmUrgencyRank(level) > 0, urgencyLevel: level, urgencyScore: score };
}

function empiricalPercentRank(value, sortedValues = []) {
  if (!sortedValues.length || value <= EPSILON) return 0;
  if (sortedValues.length === 1) return 100;
  let first = sortedValues.findIndex((candidate) => candidate >= value - EPSILON);
  if (first < 0) first = sortedValues.length - 1;
  let last = first;
  while (last + 1 < sortedValues.length && Math.abs(sortedValues[last + 1] - value) <= EPSILON) last += 1;
  return round((((first + last) / 2) / (sortedValues.length - 1)) * 100, 4);
}

export function classifySmartScmUrgency(states = []) {
  const demandByYard = new Map();
  for (const state of states) {
    const yardId = Number(state?.policy?.location_id ?? state?.locationId);
    const demand = positive(state?.weeklyDemand);
    if (!Number.isInteger(yardId) || demand <= EPSILON) continue;
    if (!demandByYard.has(yardId)) demandByYard.set(yardId, []);
    demandByYard.get(yardId).push(demand);
  }
  for (const demands of demandByYard.values()) demands.sort((left, right) => left - right);
  for (const state of states) {
    const yardId = Number(state?.policy?.location_id ?? state?.locationId);
    const score = empiricalPercentRank(positive(state?.weeklyDemand), demandByYard.get(yardId) || []);
    const isUrgent = Boolean(state?.urgent);
    let level = "normal";
    if (isUrgent) {
      if (number(state?.rawAvailableSales ?? state?.availableSales) > 0 || score < 50) level = "urgent";
      else if (score < 80) level = "super_urgent";
      else level = "ultimate_urgent";
    }
    state.urgencyLevel = level;
    state.urgencyScore = urgencyScore(score, isUrgent);
  }
  return states;
}

export function smartScmNormalizePalletQuantityOverrides(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const [key, rawQuantity] of Object.entries(value)) {
    if (rawQuantity === null || rawQuantity === undefined
      || (typeof rawQuantity === "string" && rawQuantity.trim() === "")) continue;
    const locationId = Number(key);
    const quantity = Number(rawQuantity);
    const roundedQuantity = round(quantity);
    if (!Number.isInteger(locationId) || locationId <= 0 || !Number.isFinite(quantity) || quantity < 0
      || quantity > SMART_SCM_MAX_PALLET_OVERRIDE_QUANTITY || !Number.isFinite(roundedQuantity)) continue;
    normalized[String(locationId)] = roundedQuantity;
  }
  return normalized;
}

export function smartScmPalletQuantityOverridePatch(values = {}) {
  const reset = values?.reset === true;
  if (reset) return { reset: true, quantity: null };
  const hasQuantity = Object.prototype.hasOwnProperty.call(values || {}, "quantity");
  const rawQuantity = values?.quantity;
  const hasDeliberateQuantity = hasQuantity && rawQuantity !== null && rawQuantity !== undefined
    && !(typeof rawQuantity === "string" && rawQuantity.trim() === "");
  const quantity = Number(rawQuantity);
  const roundedQuantity = round(quantity);
  if (!hasDeliberateQuantity || !Number.isFinite(quantity) || quantity < 0
    || quantity > SMART_SCM_MAX_PALLET_OVERRIDE_QUANTITY || !Number.isFinite(roundedQuantity)) {
    throw Object.assign(new Error(`PALLET quantity must be a non-negative number no greater than ${SMART_SCM_MAX_PALLET_OVERRIDE_QUANTITY}, or reset it to Automatic.`), { status: 400 });
  }
  return { reset: false, quantity: roundedQuantity };
}

export function smartScmPalletQuantityOverride(overrides = {}, destinationLocationId = null) {
  const normalized = smartScmNormalizePalletQuantityOverrides(overrides);
  const key = String(Number(destinationLocationId));
  return Object.prototype.hasOwnProperty.call(normalized, key)
    ? { overridden: true, quantity: normalized[key] }
    : { overridden: false, quantity: null };
}

function physicalPalletUnitWeight(line = {}, fallback = 0) {
  return positive(
    line.physicalPalletWeightLbs
      ?? line.physicalPalletWeight
      ?? line.reason?.physicalPalletWeightLbs,
    fallback
  );
}

export function smartScmPalletLoadWeightLbs(line = {}, physicalPalletWeightLbs = 0) {
  return round(
    positive(line.palletWeight ?? line.pallet_weight_lbs)
      + physicalPalletUnitWeight(line, physicalPalletWeightLbs)
  );
}

export function smartScmProposalLineLoadWeightLbs(line = {}, physicalPalletWeightLbs = 0) {
  const pallets = positive(
    line.proposedPallets
      ?? line.proposed_pallets
      ?? line.confirmedPallets
      ?? line.confirmed_pallets
  );
  const materialWeight = positive(
    line.lineWeight ?? line.line_weight_lbs,
    pallets * positive(line.palletWeight ?? line.pallet_weight_lbs)
  );
  return round(materialWeight + (pallets * physicalPalletUnitWeight(line, physicalPalletWeightLbs)));
}

export function smartScmSourceTransferLimit({ availablePallets = 0, safetyStockPallets = 0, reorderPointPallets = 0 } = {}) {
  const available = positive(availablePallets);
  const safety = positive(safetyStockPallets);
  const reorderPoint = positive(reorderPointPallets);
  const protectedFloorPallets = Math.max(safety, reorderPoint);
  const maximumTransferablePallets = Math.floor(Math.max(0, available - protectedFloorPallets) + EPSILON);
  return { availablePallets: available, safetyStockPallets: safety, reorderPointPallets: reorderPoint, protectedFloorPallets, maximumTransferablePallets };
}

export function smartScmLineOverridesSourceStockFloor(line = {}) {
  const reason = line?.reason;
  if (!reason || typeof reason !== "object" || Array.isArray(reason)) return false;
  return reason.manualSourceFloorOverride === true
    || reason.manuallyAdjusted === true
    || reason.manuallyAdded === true
    || reason.manualLoad === true;
}

export function smartScmConfirmationSourceTransferLimit({
  availablePallets = 0,
  safetyStockPallets = 0,
  reorderPointPallets = 0,
  manualOverride = false
} = {}) {
  const policyLimit = smartScmSourceTransferLimit({
    availablePallets,
    safetyStockPallets,
    reorderPointPallets
  });
  return {
    ...policyLimit,
    manualOverride: manualOverride === true,
    maximumTransferablePallets: manualOverride === true
      ? Math.floor(policyLimit.availablePallets + EPSILON)
      : policyLimit.maximumTransferablePallets
  };
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

async function settingsRow() {
  const result = await query("SELECT * FROM scm_smart_settings WHERE id = 1");
  if (!result.rowCount) throw new Error("Smart SCM settings are missing. Run migrations first.");
  return result.rows[0];
}

export async function smartScmAvailableBlanketBalanceByItem() {
  const result = await query(
    `WITH sales_alloc AS (
       SELECT po_line_id,
              SUM(allocated_pallet_qty) AS pallet_qty,
              SUM(allocated_sales_qty) AS sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY po_line_id
     ), split_alloc AS (
       SELECT split_line.source_line_id,
              SUM(split_line.pallet_qty) AS pallet_qty,
              SUM(split_line.sales_qty) AS sales_qty
         FROM dispatch_scm_po_split_lines split_line
         JOIN dispatch_scm_po_splits split_header
           ON split_header.id = split_line.split_id
          AND split_header.status = 'active'
        GROUP BY split_line.source_line_id
     ), blanket_alloc AS (
       SELECT source_line_id,
              SUM(CASE WHEN status = 'reserved' THEN reserved_pallets ELSE held_pallets END) AS pallet_qty,
              SUM(CASE WHEN status = 'reserved' THEN reserved_sales_qty ELSE held_sales_qty END) AS sales_qty
         FROM scm_smart_blanket_allocations
        WHERE status IN ('reserved', 'held')
        GROUP BY source_line_id
     ), net_lines AS (
       SELECT line.item_id,
              po.tranid AS source_po_ref,
              line.to_plt,
              line.pallet_qty,
              GREATEST(
                COALESCE(line.quantity, 0)
                - COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0)
                - COALESCE(sales.sales_qty, 0)
                - COALESCE(split.sales_qty, 0)
                - COALESCE(blanket.sales_qty, 0),
                0
              ) AS available_sales_qty,
              COALESCE(sales.pallet_qty, 0) + COALESCE(split.pallet_qty, 0) + COALESCE(blanket.pallet_qty, 0) AS allocated_pallets
         FROM purchase_orders po
         JOIN purchase_order_lines line
           ON line.purchase_order_id = po.netsuite_id
          AND line.netsuite_active = true
         LEFT JOIN sales_alloc sales ON sales.po_line_id = line.id
         LEFT JOIN split_alloc split ON split.source_line_id = line.id
         LEFT JOIN blanket_alloc blanket ON blanket.source_line_id = line.id
        WHERE po.netsuite_active = true
          AND po.is_blanket_po = true
          AND line.item_id IS NOT NULL
          AND COALESCE(line.to_plt, 0) > 0
          AND COALESCE(line.item_weight, 0) > 0
          AND (po.status_text ILIKE '%Pending Receipt%' OR po.status_text ILIKE '%Partially Received%')
          AND NOT EXISTS (
            SELECT 1 FROM dispatch_scm_po_splits child_split
             WHERE child_split.split_po_id = po.netsuite_id
          )
     ), item_balance AS (
       SELECT item_id,
              ARRAY_AGG(DISTINCT source_po_ref ORDER BY source_po_ref) AS source_po_refs,
              SUM(available_sales_qty) AS available_sales_qty,
              SUM(GREATEST(LEAST(
                FLOOR((available_sales_qty / to_plt) + 0.000001),
                CASE WHEN COALESCE(pallet_qty, 0) > 0
                  THEN GREATEST(COALESCE(pallet_qty, 0) - allocated_pallets, 0)
                  ELSE FLOOR((available_sales_qty / to_plt) + 0.000001)
                END
              ), 0)) AS available_pallets
         FROM net_lines
        GROUP BY item_id
     )
     SELECT item_id, source_po_refs, available_sales_qty, available_pallets
       FROM item_balance
      WHERE available_pallets > 0`
  );
  return new Map(result.rows.map((row) => [String(row.item_id), {
    availableSalesQty: positive(row.available_sales_qty),
    availablePallets: positive(row.available_pallets),
    sourcePoRefs: Array.isArray(row.source_po_refs) ? row.source_po_refs.filter(Boolean) : []
  }]));
}

export async function listSmartScmBlanketPlanningPauses({ search = "" } = {}) {
  const balances = await smartScmAvailableBlanketBalanceByItem();
  const itemIds = [...balances.keys()].map(Number).filter(Number.isInteger);
  if (!itemIds.length) return [];
  const searchText = text(search);
  const result = await query(
    `SELECT item.item_id,
            item.item_name,
            item.item_description,
            COALESCE(NULLIF(item.vendor, ''), NULLIF(policy.vendor, '')) AS vendor,
            policy.vendor_code
       FROM inventory_items item
       LEFT JOIN scm_smart_item_policies policy ON policy.item_id = item.item_id
      WHERE item.item_id = ANY($1::bigint[])
        AND ($2 = '' OR concat_ws(' ', item.item_id::text, item.item_name,
              item.item_description, item.vendor, policy.vendor, policy.vendor_code) ILIKE '%' || $2 || '%')
      ORDER BY item.item_name, item.item_id`,
    [itemIds, searchText]
  );
  return result.rows.map((row) => {
    const balance = balances.get(String(row.item_id)) || {};
    return {
      itemId: Number(row.item_id),
      itemName: row.item_name || "",
      itemDescription: row.item_description || "",
      vendor: row.vendor || "",
      vendorCode: row.vendor_code || "",
      reason: "Covered by remaining Blanket PO quantity",
      availablePallets: positive(balance.availablePallets),
      availableSalesQty: positive(balance.availableSalesQty),
      sourcePoRefs: Array.isArray(balance.sourcePoRefs) ? balance.sourcePoRefs : [],
      active: true,
      automatic: true,
      pauseKind: "blanket_po"
    };
  });
}

export async function loadSmartScmPlanningPolicies({ includeTemporarilyExcluded = false } = {}) {
  const [result, blanketBalanceByItem] = await Promise.all([query(
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
            COALESCE(
              NULLIF(BTRIM(vy.yard), ''),
              NULLIF(BTRIM(p.vendor_yard), ''),
              NULLIF(BTRIM(p.plant), ''),
              NULLIF(BTRIM(i.vendor), ''),
              NULLIF(BTRIM(p.vendor), '')
            ) AS plant,
            CASE WHEN COALESCE(i.item_weight, 0) > 0 AND COALESCE(i.to_plt, 0) > 0
                 THEN i.item_weight * i.to_plt ELSE p.pallet_weight_lbs END AS pallet_weight_lbs,
            COALESCE((
              SELECT pallet.item_weight
                FROM inventory_items pallet
               WHERE UPPER(BTRIM(COALESCE(pallet.item_name, ''))) = 'PALLET'
               ORDER BY pallet.item_id
               LIMIT 1
            ), 0) AS physical_pallet_weight_lbs,
            y.location_id, y.yard_code, y.eligible, y.capacity_pallets,
            y.service_quantile, y.minimum_safety_pallets, y.lower_stock_policy_enabled,
            (active_exclusion.item_id IS NOT NULL) AS temporarily_excluded
       FROM scm_smart_item_policies p
       JOIN scm_smart_item_yard_policies y ON y.item_id = p.item_id
       LEFT JOIN inventory_items i ON i.item_id = p.item_id
       LEFT JOIN dispatch_vendor_yards vy ON vy.id = p.vendor_yard_id
       LEFT JOIN LATERAL (
         SELECT exclusion.item_id
           FROM scm_smart_planning_exclusions exclusion
          WHERE exclusion.item_id = p.item_id
            AND exclusion.deactivated_at IS NULL
            AND (exclusion.expires_at IS NULL OR exclusion.expires_at > now())
          ORDER BY exclusion.id DESC
          LIMIT 1
       ) active_exclusion ON true
      WHERE y.eligible = true
        AND p.planning_enabled = true
        AND p.inactive = false
        AND p.discontinued = false
        AND ($1::boolean OR active_exclusion.item_id IS NULL)
      ORDER BY p.item_id, y.location_id`,
    [includeTemporarilyExcluded]
  ), smartScmAvailableBlanketBalanceByItem()]);
  return result.rows.map((row) => {
    const blanket = blanketBalanceByItem.get(String(row.item_id)) || {};
    return {
      ...row,
      blanket_available_sales_qty: positive(blanket.availableSalesQty),
      blanket_available_pallets: positive(blanket.availablePallets),
      blanket_po_planning_excluded: positive(blanket.availablePallets) > EPSILON
    };
  });
}

async function inventoryState({ excludeTransferOrderIds = [] } = {}) {
  const excludedTransferOrderIds = [...new Set((excludeTransferOrderIds || [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  const balances = await query(
    `SELECT item_id, location_id, quantity_on_hand, quantity_available,
            quantity_on_order, quantity_backordered, synced_at
       FROM inventory_balances`
  );
  const adjustments = await query(
    `WITH blanket_po AS (
       SELECT line.item_id,
              COALESCE(line.location_id, po.destination_location_id) AS location_id,
              SUM(GREATEST(COALESCE(line.quantity, 0) - COALESCE(line.netsuite_received_qty, 0), 0)) AS quantity
         FROM purchase_order_lines line
         JOIN purchase_orders po ON po.netsuite_id = line.purchase_order_id
        WHERE line.netsuite_active = true
          AND po.netsuite_active = true
          AND po.is_blanket_po = true
          AND NOT COALESCE(line.netsuite_closed, false)
          AND (po.status_text ILIKE '%Pending Receipt%' OR po.status_text ILIKE '%Partially Received%')
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_scm_po_splits child_split
             WHERE child_split.split_po_id = po.netsuite_id
          )
          AND line.item_id IS NOT NULL
          AND COALESCE(line.location_id, po.destination_location_id) IS NOT NULL
        GROUP BY line.item_id, COALESCE(line.location_id, po.destination_location_id)
     ), excluded_transfer AS (
       SELECT line.item_id,
              transfer.to_location_id AS location_id,
              SUM(GREATEST(COALESCE(line.quantity, 0) - COALESCE(line.netsuite_received_qty, 0), 0)) AS quantity
         FROM transfer_order_lines line
         JOIN transfer_orders transfer ON transfer.netsuite_id = line.transfer_order_id
        WHERE line.line_stage = 'receiving'
          AND line.netsuite_active = true
          AND transfer.netsuite_active = true
          AND line.transfer_order_id = ANY($1::bigint[])
          AND line.item_id IS NOT NULL
          AND transfer.to_location_id IS NOT NULL
        GROUP BY line.item_id, transfer.to_location_id
     ), blanket_reservation AS (
       SELECT allocation.item_id,
              allocation.destination_location_id AS location_id,
              SUM(CASE
                WHEN allocation.status = 'reserved' THEN allocation.reserved_sales_qty
                WHEN allocation.status = 'held' THEN allocation.held_sales_qty
                ELSE 0
              END) AS quantity
         FROM scm_smart_blanket_allocations allocation
        WHERE allocation.status IN ('reserved', 'held')
        GROUP BY allocation.item_id, allocation.destination_location_id
     )
     SELECT item_id, location_id,
            SUM(blanket_quantity) AS blanket_quantity,
            SUM(excluded_transfer_quantity) AS excluded_transfer_quantity,
            SUM(reserved_blanket_quantity) AS reserved_blanket_quantity
       FROM (
         SELECT item_id, location_id, quantity AS blanket_quantity,
                0::numeric AS excluded_transfer_quantity, 0::numeric AS reserved_blanket_quantity
           FROM blanket_po
         UNION ALL
         SELECT item_id, location_id, 0::numeric, quantity, 0::numeric FROM excluded_transfer
         UNION ALL
         SELECT item_id, location_id, 0::numeric, 0::numeric, quantity FROM blanket_reservation
       ) adjustment
      GROUP BY item_id, location_id`,
    [excludedTransferOrderIds]
  );
  const reservations = await query(
    `SELECT item_id, source_location_id, destination_location_id,
            SUM(reserved_sales_quantity) AS quantity,
            SUM(reserved_pallets) AS pallets
       FROM scm_smart_inventory_reservations
      WHERE status = 'active'
      GROUP BY item_id, source_location_id, destination_location_id`
  );
  const balanceMap = new Map(balances.rows.map((row) => [`${row.item_id}:${row.location_id}`, row]));
  const blanketExcludedMap = new Map(adjustments.rows.map((row) => [
    `${row.item_id}:${row.location_id}`,
    positive(row.blanket_quantity)
  ]));
  const excludedTransferOrderMap = new Map(adjustments.rows.map((row) => [
    `${row.item_id}:${row.location_id}`,
    positive(row.excluded_transfer_quantity)
  ]));
  const reservedBlanketMap = new Map(adjustments.rows.map((row) => [
    `${row.item_id}:${row.location_id}`,
    positive(row.reserved_blanket_quantity)
  ]));
  const outboundReservationMap = new Map();
  const inboundReservationMap = new Map();
  for (const row of reservations.rows) {
    const outboundKey = `${row.item_id}:${row.source_location_id}`;
    const inboundKey = `${row.item_id}:${row.destination_location_id}`;
    outboundReservationMap.set(outboundKey, positive(outboundReservationMap.get(outboundKey)) + positive(row.quantity));
    inboundReservationMap.set(inboundKey, positive(inboundReservationMap.get(inboundKey)) + positive(row.quantity));
  }
  return {
    balanceMap,
    blanketExcludedMap,
    excludedTransferOrderMap,
    reservedBlanketMap,
    outboundReservationMap,
    inboundReservationMap
  };
}

async function latestVendorSupplyMap() {
  const result = await query(
    `SELECT DISTINCT ON (item_id) *
       FROM scm_smart_vendor_supply
      ORDER BY item_id, captured_at DESC, id DESC`
  );
  return new Map(result.rows.map((row) => [String(row.item_id), row]));
}

export async function smartScmMinimumOrderMap(policies = []) {
  const toPltByItem = new Map(policies.map((policy) => [String(policy.item_id), positive(policy.to_plt)]));
  const itemIds = [...toPltByItem.keys()].map(Number).filter(Number.isInteger);
  if (!itemIds.length) return new Map();
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
        AND sf.item_id = ANY($1::bigint[])
        AND sf.quantity > 0
        AND sf.document_ref IS NOT NULL
        AND sf.location_id IS NOT NULL
      GROUP BY sf.item_id, sf.location_id, sf.delivery_method, sf.document_ref`,
    [itemIds]
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

export function calculatePolicyState(policy, forecast, inventory, minimumOrder, settings = {}) {
  const key = `${policy.item_id}:${policy.location_id}`;
  const toPlt = positive(policy.to_plt);
  const balance = inventory.balanceMap.get(key) || {};
  const onHandSales = positive(balance.quantity_on_hand);
  const rawAvailableSales = number(balance.quantity_available);
  const availableSales = positive(rawAvailableSales);
  const reservedOutboundSales = positive(inventory.outboundReservationMap.get(key));
  const position = smartScmInventoryPositionSales({
    quantityAvailableSales: availableSales,
    authoritativeOnOrderSales: balance.quantity_on_order,
    blanketExcludedSales: inventory.blanketExcludedMap.get(key),
    excludedTransferOrderSales: inventory.excludedTransferOrderMap.get(key),
    reservedBlanketSales: inventory.reservedBlanketMap.get(key),
    pendingTransferReservationSales: inventory.inboundReservationMap.get(key),
    quantityBackorderedSales: balance.quantity_backordered,
    reservedOutboundSales
  });
  const onOrderSales = position.effectiveOnOrderSales;
  const backorderedSales = position.quantityBackorderedSales;
  const positionPallets = toPlt > EPSILON ? position.inventoryPositionSales / toPlt : 0;
  const availablePallets = toPlt > EPSILON ? Math.max(0, availableSales - reservedOutboundSales) / toPlt : 0;
  const levels = calculateSmartScmPolicyLevels(policy, forecast, settings);
  const leadWeeks = levels.leadWeeks;
  const weeklyDemand = levels.weeklyDemandPallets;
  const estimatedSd = levels.weeklyDemandSdPallets;
  const selectedServiceFactor = levels.serviceFactor;
  const safety = levels.safetyStockPallets;
  const baseRop = levels.baseReorderPointPallets;
  const basePreferred = levels.basePreferredPallets;
  const coverageApplied = levels.zeroDemandCoverageApplied;
  const coverageFloor = levels.coverageFloorPallets;
  const capacity = levels.capacityPallets;
  const rop = levels.reorderPointPallets;
  const preferred = levels.preferredPallets;
  const minimumOrderPallets = positive(minimumOrder, 1);
  const requirement = calculateSmartScmOrderRequirement({
    positionPallets,
    reorderPointPallets: rop,
    preferredPallets: preferred,
    capacityPallets: capacity,
    minimumOrderPallets
  });
  const capacityBelowMinimum = requirement.capacityBelowMinimum;
  const required = requirement.requiredPallets;
  const coverageCausedNeed = coverageApplied && coverageFloor > baseRop + EPSILON && positionPallets < rop - EPSILON;
  const coverageLocalSamples = Math.max(0, Math.round(number(forecast?.coverage_local_samples)));
  const priorStrength = Math.max(1, Math.round(number(settings.coverage_prior_strength_orders, 8)));
  const coverageReviewRequired = coverageCausedNeed && coverageLocalSamples < priorStrength;
  const representativeOrderPallets = positive(forecast?.representative_order_pallets);
  const availableCoverageOrders = representativeOrderPallets > EPSILON ? availablePallets / representativeOrderPallets : null;
  const availableCoverageGapPallets = coverageApplied ? Math.max(0, coverageFloor - availablePallets) : 0;
  const coverageCoveredByInbound = coverageApplied && availableCoverageGapPallets > EPSILON && positionPallets >= coverageFloor - EPSILON;
  const weeksOfCover = weeklyDemand > EPSILON ? Math.max(0, positionPallets) / weeklyDemand : Number.POSITIVE_INFINITY;
  const urgent = required > 0 && (
    availablePallets <= EPSILON
    || positionPallets <= safety + EPSILON
    || weeksOfCover <= leadWeeks + EPSILON
  );
  return {
    key,
    policy,
    forecast,
    toPlt,
    manualPlanningRequired: toPlt <= EPSILON || positive(policy.pallet_weight_lbs) <= EPSILON,
    onHandSales,
    rawAvailableSales,
    availableSales,
    availablePallets,
    authoritativeOnOrderSales: position.authoritativeOnOrderSales,
    blanketExcludedSales: position.blanketExcludedSales,
    excludedTransferOrderSales: position.excludedTransferOrderSales,
    reservedBlanketSales: position.reservedBlanketSales,
    pendingTransferReservationSales: position.pendingTransferReservationSales,
    onOrderSales,
    backorderedSales,
    reservedOutboundSales,
    positionPallets: round(positionPallets),
    weeklyDemand: round(weeklyDemand),
    weeklyDemandSd: round(estimatedSd),
    serviceFactor: round(selectedServiceFactor),
    lowerStockPolicyEnabled: levels.lowerStockPolicyEnabled,
    lowerStockPolicyApplied: levels.lowerStockPolicyApplied,
    configuredMinimumSafety: round(levels.configuredMinimumSafetyPallets),
    effectiveMinimumSafety: round(levels.effectiveMinimumSafetyPallets),
    standardSafety: round(levels.standardSafetyStockPallets),
    standardRop: round(levels.standardReorderPointPallets),
    standardPreferred: round(levels.standardPreferredPallets),
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
    urgent,
    urgencyLevel: urgent ? "urgent" : "normal",
    urgencyScore: 0
  };
}

export function smartScmProposalLineForState(state, pallets, extraReason = {}) {
  const policy = state.policy;
  const proposedPallets = round(pallets);
  const palletWeight = positive(policy.pallet_weight_lbs);
  const physicalPalletWeightLbs = positive(policy.physical_pallet_weight_lbs);
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
    physicalPalletWeightLbs,
    lineWeight: round(proposedPallets * palletWeight),
    toPlt: positive(policy.to_plt),
    toLyr: positive(policy.to_lyr),
    toSec: positive(policy.to_sec),
    toPcs: positive(policy.to_pcs),
    manualPlanningRequired: state.manualPlanningRequired,
    urgent: Boolean(state.urgent),
    urgencyLevel: smartScmUrgencyLevel(state.urgencyLevel, state.urgent),
    urgencyScore: urgencyScore(state.urgencyScore, state.urgent),
    reason: {
      ...extraReason,
      quantityOnHand: state.onHandSales,
      quantityAvailable: state.availableSales,
      quantityOnOrder: state.onOrderSales,
      quantityOnOrderAuthoritative: state.authoritativeOnOrderSales,
      quantityBlanketExcluded: state.blanketExcludedSales,
      quantityTransferOrderExcluded: state.excludedTransferOrderSales,
      quantityBlanketReservedInbound: state.reservedBlanketSales,
      quantityPendingTransferReservation: state.pendingTransferReservationSales,
      quantityBackordered: state.backorderedSales,
      quantityReservedOutbound: state.reservedOutboundSales,
      positionPallets: state.positionPallets,
      availablePallets: state.availablePallets,
      expectedAvailablePallets: round(Math.max(0, state.positionPallets)),
      destinationAvailablePallets: state.availablePallets,
      destinationExpectedAvailablePallets: round(Math.max(0, state.positionPallets)),
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
      lowerStockPolicyEnabled: state.lowerStockPolicyEnabled,
      lowerStockPolicyApplied: state.lowerStockPolicyApplied,
      configuredMinimumSafetyPallets: state.configuredMinimumSafety,
      effectiveMinimumSafetyPallets: state.effectiveMinimumSafety,
      standardSafetyStockPallets: state.standardSafety,
      standardReorderPointPallets: state.standardRop,
      standardPreferredPallets: state.standardPreferred,
      minimumOrderPallets: state.minimumOrder,
      weeklyDemandPallets: state.weeklyDemand,
      weeklyDemandSdPallets: state.weeklyDemandSd,
      leadTimeWeeks: state.leadWeeks,
      capacityPallets: state.capacity,
      safetyFactor: state.serviceFactor,
      weeksOfCover: state.weeksOfCover,
      inventorySyncedAt: state.inventorySyncedAt,
      forecastModel: state.forecast?.authoritative_model || "formula",
      stockoutDemandMethod: state.forecast?.stockout_demand_method || "none",
      stockoutDemandConfidence: state.forecast?.stockout_demand_confidence || "none",
      stockoutSnapshotWeeks: Math.max(0, Math.round(number(state.forecast?.stockout_snapshot_weeks))),
      stockoutProxyWeeks: Math.max(0, Math.round(number(state.forecast?.stockout_proxy_weeks))),
      stockoutEvidenceStartWeek: state.forecast?.stockout_evidence_start_week || null,
      stockoutEvidenceEndWeek: state.forecast?.stockout_evidence_end_week || null,
      demandDataCutoff: state.forecast?.demand_data_cutoff || null,
      physicalPalletWeightLbs,
      urgent: Boolean(state.urgent),
      urgencyLevel: smartScmUrgencyLevel(state.urgencyLevel, state.urgent),
      urgencyScore: urgencyScore(state.urgencyScore, state.urgent),
    }
  };
}

function splitLineByTruck(line, truckCapacity) {
  const loadPalletWeight = smartScmPalletLoadWeightLbs(line);
  if (line.manualPlanningRequired || loadPalletWeight <= EPSILON) return [line];
  const maxPallets = Math.max(1, Math.floor((truckCapacity + EPSILON) / loadPalletWeight));
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

function createDraft({
  type,
  phase,
  sourceKind,
  sourceLocationId = null,
  sourceVendorYardId = null,
  sourceName,
  destinationLocationId,
  destinationName,
  vendor = null,
  plant = null,
  urgent = false,
  provisional = false,
  line,
  status = null,
  keySuffix = ""
}, settings) {
  const priority = smartScmUrgencySummary([{ ...line, urgent: Boolean(urgent || line.urgent) }]);
  const classifiedLine = {
    ...line,
    urgent: priority.urgent,
    urgencyLevel: priority.urgencyLevel,
    urgencyScore: priority.urgencyScore,
    provisional: Boolean(provisional),
    reason: {
      ...(line.reason || {}),
      urgent: priority.urgent,
      urgencyLevel: priority.urgencyLevel,
      urgencyScore: priority.urgencyScore,
      provisional: Boolean(provisional)
    }
  };
  const weight = smartScmProposalLineLoadWeightLbs(classifiedLine);
  const utilization = weight > 0 ? weight / positive(settings.truck_capacity_lbs, 78000) : 0;
  const coverageReviewRequired = Boolean(classifiedLine.reason?.coverageReviewRequired);
  let resolvedStatus = status;
  if (!resolvedStatus) {
    if (type === "PO") resolvedStatus = "held";
    else if (classifiedLine.manualPlanningRequired) resolvedStatus = "attention";
    else if (coverageReviewRequired) resolvedStatus = "held";
    else resolvedStatus = "draft";
  }
  const vendorYardId = Number(sourceVendorYardId);
  const sourceIdentity = sourceKind === "vendor" && Number.isInteger(vendorYardId) && vendorYardId > 0
    ? `vendor-yard-${vendorYardId}`
    : sourceLocationId || sourceName || "unknown";
  return {
    proposalKey: [phase, sourceKind, sourceIdentity, destinationLocationId, line.itemId, keySuffix].join(":"),
    proposalType: type,
    phase,
    sourceKind,
    sourceLocationId,
    sourceVendorYardId: Number.isInteger(vendorYardId) && vendorYardId > 0 ? vendorYardId : null,
    sourceName,
    destinationLocationId,
    destinationName,
    vendor,
    plant,
    status: resolvedStatus,
    urgent: priority.urgent,
    urgencyLevel: priority.urgencyLevel,
    urgencyScore: priority.urgencyScore,
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
  if (total <= EPSILON || line.manualPlanningRequired || smartScmPalletLoadWeightLbs(line) <= EPSILON) {
    return [{ draft, line: { ...line } }];
  }
  const savedDestinationAllocations = Array.isArray(line.reason?.destinationAllocations)
    ? line.reason.destinationAllocations
      .map((allocation) => ({
        ...allocation,
        yard: String(allocation?.yard || "").trim(),
        proposedPallets: round(positive(allocation?.proposedPallets))
      }))
      .filter((allocation) => allocation.yard && allocation.proposedPallets > EPSILON)
    : [];
  const savedAllocationTotal = savedDestinationAllocations
    .reduce((sum, allocation) => sum + allocation.proposedPallets, 0);
  if (savedDestinationAllocations.length && Math.abs(savedAllocationTotal - total) > EPSILON) {
    throw new Error("Destination allocation total must match the physical proposal-line quantity before packing.");
  }
  const allocationRemaining = savedDestinationAllocations
    .map((allocation) => ({ ...allocation }));
  let allocationIndex = 0;
  const takeDestinationAllocations = (pallets) => {
    if (!allocationRemaining.length) return null;
    const taken = [];
    let needed = pallets;
    while (needed > EPSILON && allocationIndex < allocationRemaining.length) {
      const allocation = allocationRemaining[allocationIndex];
      const quantity = Math.min(needed, allocation.proposedPallets);
      if (quantity > EPSILON) taken.push({ ...allocation, proposedPallets: round(quantity) });
      allocation.proposedPallets = round(allocation.proposedPallets - quantity);
      needed = round(needed - quantity);
      if (allocation.proposedPallets <= EPSILON) allocationIndex += 1;
    }
    return taken;
  };
  const units = [];
  let remaining = total;
  while (remaining > EPSILON) {
    const pallets = Math.min(1, remaining);
    const ratio = pallets / total;
    const destinationAllocations = takeDestinationAllocations(pallets);
    units.push({
      draft,
      line: {
        ...line,
        requiredPallets: round(positive(line.requiredPallets) * ratio),
        proposedPallets: round(pallets),
        confirmedPallets: 0,
        residualPallets: round(pallets),
        salesQuantity: round(positive(line.salesQuantity) * ratio),
        lineWeight: round(positive(line.lineWeight) * ratio),
        ...(destinationAllocations ? {
          reason: {
            ...(line.reason || {}),
            destinationAllocations,
            actualDestinationYard: destinationAllocations.length === 1
              ? destinationAllocations[0].yard
              : null
          }
        } : {})
      }
    });
    remaining = round(remaining - pallets);
  }
  return units;
}

function lineDemandDestination(line = {}) {
  return String(
    line.reason?.actualDestinationYard
      || line.destinationName
      || line.destinationLocationId
      || ""
  ).trim();
}

function lineDestinationAllocations(line = {}) {
  const physicalYard = String(line.destinationName || "").trim();
  const saved = Array.isArray(line.reason?.destinationAllocations)
    ? line.reason.destinationAllocations
    : [];
  const normalized = saved
    .map((allocation) => ({
      yard: String(allocation?.yard || "").trim(),
      proposedPallets: round(positive(allocation?.proposedPallets)),
      fulfillment: ["vendor_direct", "transfer_later"].includes(allocation?.fulfillment)
        ? allocation.fulfillment
        : String(allocation?.yard || "").trim() === physicalYard
          ? "vendor_direct"
          : "transfer_later"
    }))
    .filter((allocation) => allocation.yard && allocation.proposedPallets > EPSILON);
  if (normalized.length) return normalized;
  const yard = lineDemandDestination(line);
  const proposedPallets = round(positive(line.proposedPallets));
  return yard && proposedPallets > EPSILON ? [{
    yard,
    proposedPallets,
    fulfillment: yard === physicalYard ? "vendor_direct" : "transfer_later"
  }] : [];
}

function mergedLineDestinationAllocations(existing, next) {
  const totals = new Map();
  for (const allocation of [
    ...lineDestinationAllocations(existing),
    ...lineDestinationAllocations(next)
  ]) {
    const key = `${allocation.fulfillment}:${allocation.yard}`;
    const current = totals.get(key) || { ...allocation, proposedPallets: 0 };
    current.proposedPallets = round(current.proposedPallets + allocation.proposedPallets);
    totals.set(key, current);
  }
  return [...totals.values()]
    .sort((left, right) => left.yard.localeCompare(right.yard, undefined, { numeric: true })
      || left.fulfillment.localeCompare(right.fulfillment));
}

function combineLoadLine(lines, next) {
  const existing = lines.find((line) => Number(line.itemId) === Number(next.itemId)
    && Number(line.destinationLocationId) === Number(next.destinationLocationId));
  if (!existing) {
    lines.push({ ...next });
    return;
  }
  const tracksMultipleDestinations = Array.isArray(existing.reason?.destinationAllocations)
    || Array.isArray(next.reason?.destinationAllocations)
    || lineDemandDestination(existing) !== lineDemandDestination(next);
  const destinationAllocations = tracksMultipleDestinations
    ? mergedLineDestinationAllocations(existing, next)
    : null;
  existing.requiredPallets = round(positive(existing.requiredPallets) + positive(next.requiredPallets));
  existing.proposedPallets = round(positive(existing.proposedPallets) + positive(next.proposedPallets));
  existing.confirmedPallets = round(positive(existing.confirmedPallets) + positive(next.confirmedPallets));
  existing.residualPallets = round(positive(existing.residualPallets) + positive(next.residualPallets));
  existing.salesQuantity = round(positive(existing.salesQuantity) + positive(next.salesQuantity));
  existing.lineWeight = round(positive(existing.lineWeight) + positive(next.lineWeight));
  const priority = smartScmUrgencySummary([existing, next]);
  existing.urgent = priority.urgent;
  existing.urgencyLevel = priority.urgencyLevel;
  existing.urgencyScore = priority.urgencyScore;
  existing.provisional = Boolean(existing.provisional || next.provisional);
  existing.reason = {
    ...(existing.reason || {}),
    urgent: existing.urgent,
    urgencyLevel: existing.urgencyLevel,
    urgencyScore: existing.urgencyScore,
    provisional: existing.provisional,
    ...(destinationAllocations ? {
      destinationAllocations,
      actualDestinationYard: destinationAllocations.length === 1 ? destinationAllocations[0].yard : null
    } : {}),
    ...((existing.reason?.gormleyOriginalDestinations || next.reason?.gormleyOriginalDestinations)
      ? { gormleyOriginalDestinations: [...new Set([
        ...(existing.reason?.gormleyOriginalDestinations || []),
        ...(next.reason?.gormleyOriginalDestinations || [])
      ])] } : {})
  };
}

function compatibleLoadSignature(draft) {
  const destination = draft.proposalType === "PO" ? "multi-drop" : `${draft.destinationLocationId}|${draft.destinationName}`;
  const phase = draft.proposalType === "PO" && ["direct_vendor", "vendor_hub"].includes(draft.phase)
    ? "vendor_purchase"
    : draft.phase;
  const vendorYardId = Number(draft.sourceVendorYardId);
  const sourceIdentity = draft.sourceKind === "vendor" && Number.isInteger(vendorYardId) && vendorYardId > 0
    ? `vendor-yard:${vendorYardId}`
    : draft.sourceKind === "vendor"
      ? `legacy-vendor:${text(draft.vendor).toLowerCase().replace(/[^a-z0-9]+/g, "")}:${text(draft.plant || draft.sourceName).toLowerCase().replace(/[^a-z0-9]+/g, "")}`
      : `yard:${draft.sourceLocationId || text(draft.sourceName).toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
  return [
    draft.proposalType, phase, draft.sourceKind, sourceIdentity, destination
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
  const levelDifference = smartScmUrgencyRank(right.line.urgencyLevel, right.line.urgent)
    - smartScmUrgencyRank(left.line.urgencyLevel, left.line.urgent);
  if (levelDifference) return levelDifference;
  const scoreDifference = urgencyScore(right.line.urgencyScore, right.line.urgent)
    - urgencyScore(left.line.urgencyScore, left.line.urgent);
  if (Math.abs(scoreDifference) > EPSILON) return scoreDifference;
  return smartScmProposalLineLoadWeightLbs(right.line) - smartScmProposalLineLoadWeightLbs(left.line);
}

function proposalUnitWeightSort(left, right) {
  const weightDifference = smartScmProposalLineLoadWeightLbs(right.line) - smartScmProposalLineLoadWeightLbs(left.line);
  if (Math.abs(weightDifference) > EPSILON) return weightDifference;
  const levelDifference = smartScmUrgencyRank(right.line.urgencyLevel, right.line.urgent)
    - smartScmUrgencyRank(left.line.urgencyLevel, left.line.urgent);
  if (levelDifference) return levelDifference;
  const scoreDifference = urgencyScore(right.line.urgencyScore, right.line.urgent)
    - urgencyScore(left.line.urgencyScore, left.line.urgent);
  if (Math.abs(scoreDifference) > EPSILON) return scoreDifference;
  return 0;
}

function packProposalUnits(units = [], truckCapacity = 0, maxStops = 2) {
  const loads = [];
  for (const unit of units) {
    const destinationId = Number(unit.line.destinationLocationId);
    const unitWeight = smartScmProposalLineLoadWeightLbs(unit.line);
    const fits = (candidate) => candidate.totalWeight + unitWeight <= truckCapacity + EPSILON;
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
    load.totalWeight = round(load.totalWeight + unitWeight);
  }
  return loads;
}

function operationallyFullLoad(load, truckCapacity = 0) {
  const palletWeights = load.units.map((unit) => smartScmProposalLineLoadWeightLbs(unit.line)).filter((weight) => weight > EPSILON);
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
              ...(smartScmIsGormleySource(routeRule.sourceName) ? {
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

function criticalProposalUnitSort(left, right) {
  const levelDifference = smartScmUrgencyRank(right.line.urgencyLevel, right.line.urgent)
    - smartScmUrgencyRank(left.line.urgencyLevel, left.line.urgent);
  if (levelDifference) return levelDifference;
  const destinationDifference = Number(left.line.destinationLocationId) - Number(right.line.destinationLocationId);
  if (destinationDifference) return destinationDifference;
  const scoreDifference = urgencyScore(right.line.urgencyScore, right.line.urgent)
    - urgencyScore(left.line.urgencyScore, left.line.urgent);
  if (Math.abs(scoreDifference) > EPSILON) return scoreDifference;
  return smartScmProposalLineLoadWeightLbs(right.line) - smartScmProposalLineLoadWeightLbs(left.line);
}

function conservedPackedLines(loads = []) {
  const totals = new Map();
  for (const line of loads.flatMap((load) => load.lines || [])) {
    const key = `${Number(line.itemId)}:${Number(line.destinationLocationId)}`;
    const current = totals.get(key) || { required: 0, proposed: 0, residual: 0, sales: 0, weight: 0 };
    current.required += positive(line.requiredPallets);
    current.proposed += positive(line.proposedPallets);
    current.residual += positive(line.residualPallets);
    current.sales += positive(line.salesQuantity);
    current.weight += positive(line.lineWeight);
    totals.set(key, current);
  }
  return totals;
}

function samePackedLineTotals(leftLoads = [], rightLoads = []) {
  const left = conservedPackedLines(leftLoads);
  const right = conservedPackedLines(rightLoads);
  if (left.size !== right.size) return false;
  for (const [key, expected] of left) {
    const actual = right.get(key);
    if (!actual) return false;
    if (["required", "proposed", "residual", "sales", "weight"]
      .some((field) => Math.abs(expected[field] - actual[field]) > EPSILON)) return false;
  }
  return true;
}

function criticalAffinityProposalLoads(baselineLoads = [], truckCapacity = 0, maxStops = 2, routeRule = {}) {
  const finalizedLines = baselineLoads.flatMap((load) => load.lines || []);
  if (!finalizedLines.some((line) => smartScmUrgencyRank(line.urgencyLevel, line.urgent) >= 2)) return baselineLoads;
  const units = finalizedLines.flatMap((line) => palletUnits({ lines: [line] }));
  const critical = units
    .filter((unit) => smartScmUrgencyRank(unit.line.urgencyLevel, unit.line.urgent) >= 2)
    .sort(criticalProposalUnitSort);
  const lower = units
    .filter((unit) => smartScmUrgencyRank(unit.line.urgencyLevel, unit.line.urgent) < 2)
    .sort(proposalUnitWeightSort);
  const candidate = packProposalUnits([...critical, ...lower], truckCapacity, maxStops);
  if (candidate.length > baselineLoads.length) return baselineLoads;
  if (candidate.some((load) => load.totalWeight > truckCapacity + EPSILON || loadDestinationIds(load).size > maxStops)) {
    return baselineLoads;
  }
  const fullSingleDestinationCount = (loads) => loads.filter((load) =>
    loadDestinationIds(load).size === 1 && operationallyFullLoad(load, truckCapacity)).length;
  if (fullSingleDestinationCount(candidate) < fullSingleDestinationCount(baselineLoads)) {
    return baselineLoads;
  }
  const baselineWeight = baselineLoads.reduce((sum, load) => sum + positive(load.totalWeight), 0);
  const candidateWeight = candidate.reduce((sum, load) => sum + positive(load.totalWeight), 0);
  if (Math.abs(baselineWeight - candidateWeight) > EPSILON || !samePackedLineTotals(baselineLoads, candidate)) {
    return baselineLoads;
  }
  return candidate.map((load) => ({
    ...load,
    routeStops: routeStopsForLines(load.lines, routeRule)
  }));
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
  const baseline = proposalType === "PO" && routing.partialRedirectEnabled
    ? partialRedirectAdjustedLoads(units, truckCapacity, stopLimit, routing)
    : proposalType === "PO"
      ? destinationFirstProposalLoads(units, truckCapacity, stopLimit)
      : packProposalUnits(units, truckCapacity, stopLimit);
  const routed = criticalAffinityProposalLoads(baseline, truckCapacity, stopLimit, routing);
  return routed.map((load) => ({
    lines: load.lines,
    totalWeight: round(load.totalWeight),
    totalPallets: round(load.lines.reduce((sum, line) => sum + positive(line.proposedPallets), 0)),
    routeStops: load.routeStops || routeStopsForLines(load.lines, routing)
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
    const base = group.find((draft) => draft.phase === "direct_vendor") || group[0];
    const phase = group.some((draft) => draft.phase === "direct_vendor")
      ? "direct_vendor"
      : base.phase;
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
      const priority = smartScmUrgencySummary(load.lines);
      const provisional = load.lines.some((line) => Boolean(line.provisional));
      const coverageReviewRequired = load.lines.some((line) => Boolean(line.reason?.coverageReviewRequired));
      const routeStops = load.routeStops || routeStopsForLines(load.lines, activeRouteRule(base.sourceName, 2, routeRule));
      let status = base.proposalType === "PO" ? "held" : "draft";
      if (base.proposalType !== "PO" && coverageReviewRequired) status = "held";
      else if (base.proposalType !== "PO" && utilization < positive(settings.hold_load_ratio, 0.5)) status = "held";
      consolidated.push({
        ...base,
        phase,
        proposalKey: `load:${namespace}:${phase}:${planningKeyHash(signature)}:${index + 1}`,
        status,
        urgent: priority.urgent,
        urgencyLevel: priority.urgencyLevel,
        urgencyScore: priority.urgencyScore,
        provisional,
        statusLocked: coverageReviewRequired,
        destinationLocationId: routeStops[0]?.locationId || base.destinationLocationId,
        destinationName: routeStops[0]?.name || base.destinationName,
        routeStops,
        totalPallets,
        totalWeight: load.totalWeight,
        utilization,
        memo: `${phase.replaceAll("_", " ")} · load ${index + 1} · ${load.lines.length} item${load.lines.length === 1 ? "" : "s"}`,
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
    const baseLine = smartScmProposalLineForState(state, pallets, {
      sourceAvailablePallets: sourceState.availablePallets,
      sourceSafetyStockPallets: sourceState.safety,
      sourceReorderPointPallets: sourceState.rop,
      sourcePreferredPallets: sourceState.preferred,
      sourceLowerStockPolicyEnabled: sourceState.lowerStockPolicyEnabled,
      sourceLowerStockPolicyApplied: sourceState.lowerStockPolicyApplied,
      sourceConfiguredMinimumSafetyPallets: sourceState.configuredMinimumSafety,
      sourceEffectiveMinimumSafetyPallets: sourceState.effectiveMinimumSafety,
      sourceStandardSafetyStockPallets: sourceState.standardSafety,
      sourceStandardReorderPointPallets: sourceState.standardRop,
      sourceStandardPreferredPallets: sourceState.standardPreferred,
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

export function smartScmBuildPlanningDrafts({ states, supplyMap, settings }) {
  const drafts = [];
  const stateByKey = new Map(states.map((state) => [state.key, state]));
  const exceptions = [];
  for (const state of states.filter((entry) => entry.requiredPallets > 0)) {
    const manualPurchasePlanningExcluded = state.policy.temporarily_excluded === true;
    const blanketPurchasePlanningExcluded = state.policy.blanket_po_planning_excluded === true;
    const purchasePlanningExcluded = manualPurchasePlanningExcluded || blanketPurchasePlanningExcluded;
    const supply = supplyMap.get(String(state.policy.item_id));
    const supplyStatus = supply?.status || "unknown";
    const vendorAvailable = positive(supply?.available_pallets);
    const directPallets = purchasePlanningExcluded || supplyStatus === "out_of_stock" || supplyStatus === "credit_hold"
      ? 0
      : supplyStatus === "partial"
        ? Math.min(state.requiredPallets, vendorAvailable)
        : state.requiredPallets;
    if (directPallets > 0) {
      const directLine = smartScmProposalLineForState(state, directPallets, {
        vendorSupplyStatus: supplyStatus,
        importedVendorAvailablePallets: vendorAvailable,
        vendorConfirmationRequired: true
      });
      splitLineByTruck(directLine, positive(settings.truck_capacity_lbs, 78000)).forEach((line, index) => drafts.push(createDraft({
        type: "PO",
        phase: "direct_vendor",
        sourceKind: "vendor",
        sourceVendorYardId: state.policy.vendor_yard_id,
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
    let transferNeed = Math.max(0, state.requiredPallets - directPallets);
    const provisional = false;
    if (["out_of_stock", "credit_hold"].includes(supplyStatus)) transferNeed = state.requiredPallets;
    if (purchasePlanningExcluded) transferNeed = state.requiredPallets;
    if (transferNeed > EPSILON) {
      const internal = internalTransferDrafts({ state, requestedPallets: transferNeed, stateByKey, settings, provisional, keyPrefix: "initial" });
      drafts.push(...internal.drafts);
      const hub = YARDS.find((yard) => yard.code === "12441");
      if (internal.remaining > EPSILON
        && !purchasePlanningExcluded
        && Number(state.policy.location_id) !== hub.locationId) {
        const vendorHubLine = smartScmProposalLineForState(state, internal.remaining, {
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
          sourceVendorYardId: state.policy.vendor_yard_id,
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
      if (internal.remaining > EPSILON && purchasePlanningExcluded) {
        exceptions.push({
          itemId: Number(state.policy.item_id),
          yard: state.policy.yard_code,
          reason: blanketPurchasePlanningExcluded
            ? "Vendor PO planning is paused while this item has available Blanket-order balance; available internal transfers remain planned"
            : "Vendor PO planning is temporarily paused; available internal transfers remain planned",
          blanketAvailablePallets: blanketPurchasePlanningExcluded
            ? round(positive(state.policy.blanket_available_pallets))
            : 0,
          deferredVendorPallets: round(internal.remaining)
        });
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
         run_id, proposal_key, proposal_type, phase, source_kind, source_location_id, source_vendor_yard_id, source_name,
         destination_location_id, destination_name, vendor, plant, status, urgent, urgency_level, urgency_score, provisional,
         total_pallets, total_weight_lbs, utilization, vendor_reply_due_at, memo, route_stops, manually_grouped
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24)
       RETURNING id`,
      [
        runId, draft.proposalKey, draft.proposalType, draft.phase, draft.sourceKind, draft.sourceLocationId,
        draft.sourceVendorYardId, draft.sourceName, draft.destinationLocationId, draft.destinationName, draft.vendor, draft.plant,
        draft.status, draft.urgent, smartScmUrgencyLevel(draft.urgencyLevel, draft.urgent),
        urgencyScore(draft.urgencyScore, draft.urgent), draft.provisional, draft.totalPallets, draft.totalWeight, draft.utilization,
        draft.vendorReplyDueAt, draft.memo, JSON.stringify(draft.routeStops || routeStopsForLines(draft.lines)), Boolean(draft.manuallyGrouped)
      ]
    );
    for (const line of draft.lines) {
      await query(
        `INSERT INTO scm_smart_proposal_lines (
           proposal_id, item_id, item_name, item_description, unit, required_pallets, proposed_pallets,
           confirmed_pallets, residual_pallets, sales_quantity, pallet_weight_lbs, line_weight_lbs,
           to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason, destination_location_id, destination_name,
           urgent, urgency_level, urgency_score, provisional
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24)`,
        [
          proposal.rows[0].id, line.itemId, line.itemName, line.itemDescription, line.unit,
          line.requiredPallets, line.proposedPallets, line.confirmedPallets, line.residualPallets,
          line.salesQuantity, line.palletWeight, line.lineWeight, line.toPlt, line.toLyr, line.toSec,
          line.toPcs, line.manualPlanningRequired, JSON.stringify(line.reason || {}),
          line.destinationLocationId || draft.destinationLocationId, line.destinationName || draft.destinationName,
          Boolean(line.urgent), smartScmUrgencyLevel(line.urgencyLevel, line.urgent),
          urgencyScore(line.urgencyScore, line.urgent), Boolean(line.provisional)
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
    urgencyLevel: smartScmUrgencyLevel(row.urgency_level, row.urgent),
    urgencyScore: urgencyScore(row.urgency_score, row.urgent),
    provisional: Boolean(row.provisional),
    isAlternative: Boolean(row.is_alternative),
    alternativeForLineId: row.alternative_for_line_id === null ? null : Number(row.alternative_for_line_id),
    addedSource: row.added_source || "planning",
    addedBy: row.added_by || null,
    reason: row.reason || {},
    vendorResponses: row.vendor_responses || []
  };
}

export function smartScmPhysicalPalletLines(proposal = {}, palletItem = null) {
  const proposalId = Number(proposal.id);
  const palletItemId = Number(palletItem?.itemId ?? palletItem?.item_id);
  const palletName = text(palletItem?.itemName ?? palletItem?.item_name) || "PALLET";
  const palletUnit = text(palletItem?.unit ?? palletItem?.stock_unit) || "EACH";
  const palletItemWeightLbs = positive(palletItem?.itemWeightLbs ?? palletItem?.item_weight);
  const useConfirmedPallets = proposal.useConfirmedPallets === true;
  const overrides = smartScmNormalizePalletQuantityOverrides(
    proposal.palletQuantityOverrides ?? proposal.pallet_quantity_overrides
  );
  const grouped = new Map();
  for (const line of proposal.lines || []) {
    const itemId = Number(line.itemId ?? line.item_id);
    const itemName = text(line.itemName ?? line.item_name).toUpperCase();
    if ((Number.isInteger(palletItemId) && itemId === palletItemId) || itemName === "PALLET") continue;
    const quantity = useConfirmedPallets
      ? positive(line.confirmedPallets ?? line.confirmed_pallets)
      : positive(line.proposedPallets ?? line.proposed_pallets);
    if (quantity <= EPSILON) continue;
    const destinationLocationId = Number(
      line.destinationLocationId ?? line.destination_location_id
      ?? proposal.destinationLocationId ?? proposal.destination_location_id
    );
    const destinationName = text(
      line.destinationName ?? line.destination_name
      ?? proposal.destinationName ?? proposal.destination_name
    );
    const key = Number.isInteger(destinationLocationId) ? String(destinationLocationId) : destinationName;
    const current = grouped.get(key) || {
      destinationLocationId: Number.isInteger(destinationLocationId) ? destinationLocationId : null,
      destinationName,
      quantity: 0
    };
    current.quantity = round(current.quantity + quantity);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((row, index) => {
    const key = String(Number(row.destinationLocationId));
    const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
    const overrideQuantity = overridden ? overrides[key] : null;
    const quantity = overridden ? overrideQuantity : row.quantity;
    return {
    id: `physical-pallet:${Number.isInteger(proposalId) ? proposalId : "proposal"}:${row.destinationLocationId ?? index}`,
    itemId: Number.isInteger(palletItemId) && palletItemId > 0 ? palletItemId : null,
    itemName: palletName,
    itemDescription: "Official PALLET item derived from material PLT",
    unit: palletUnit,
    destinationLocationId: row.destinationLocationId,
    destinationName: row.destinationName,
    quantity,
    salesQuantity: quantity,
    automaticQuantity: row.quantity,
    overrideQuantity,
    overridden,
    ancillaryPallet: true,
    officialLineItem: true,
    submittedToNetSuite: true,
    itemWeightLbs: palletItemWeightLbs,
    lineWeightLbs: round(quantity * palletItemWeightLbs),
    weightSource: palletItemWeightLbs > EPSILON ? "netsuite_item_master" : "unavailable",
    derived: !overridden,
    includedInLoadPallets: false,
    includedInLoadWeight: palletItemWeightLbs > EPSILON
    };
  });
}

function publicProposal(row) {
  const lines = Array.isArray(row.lines) ? row.lines.map(publicProposalLine) : [];
  const palletQuantityOverrides = smartScmNormalizePalletQuantityOverrides(row.pallet_quantity_overrides);
  const physicalPalletLines = smartScmPhysicalPalletLines({
    id: row.id,
    destinationLocationId: row.destination_location_id,
    destinationName: row.destination_name,
    lines,
    palletQuantityOverrides,
    useConfirmedPallets: row.vendor_resolution_kind === "netsuite_po_review"
  }, row.pallet_item);
  const materialWeightLbs = round(lines.reduce((sum, line) => sum + positive(line.lineWeightLbs), 0));
  const physicalPalletWeightLbs = round(physicalPalletLines.reduce((sum, line) => sum + positive(line.lineWeightLbs), 0));
  const totalWeightLbs = round(materialWeightLbs + physicalPalletWeightLbs);
  const truckCapacityLbs = positive(row.planning_run_settings?.truck_capacity_lbs)
    || (positive(row.utilization) > EPSILON ? positive(row.total_weight_lbs) / positive(row.utilization) : 0)
    || 78000;
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    proposalKey: row.proposal_key,
    proposalType: row.proposal_type,
    proposalOrigin: row.proposal_origin || "inventory",
    blanketSourcePoId: row.blanket_source_po_id === null || row.blanket_source_po_id === undefined
      ? null
      : Number(row.blanket_source_po_id),
    blanketSourcePoRef: row.blanket_source_po_ref || null,
    phase: row.phase,
    sourceKind: row.source_kind,
    sourceLocationId: row.source_location_id === null ? null : Number(row.source_location_id),
    sourceVendorYardId: row.source_vendor_yard_id === null || row.source_vendor_yard_id === undefined
      ? null
      : Number(row.source_vendor_yard_id),
    sourceName: row.source_name,
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name,
    vendor: row.vendor,
    plant: row.plant,
    status: row.status,
    urgent: Boolean(row.urgent),
    urgencyLevel: smartScmUrgencyLevel(row.urgency_level, row.urgent),
    urgencyScore: urgencyScore(row.urgency_score, row.urgent),
    provisional: Boolean(row.provisional),
    totalPallets: positive(row.total_pallets),
    materialWeightLbs,
    physicalPalletWeightLbs,
    totalWeightLbs,
    utilization: round(totalWeightLbs / truckCapacityLbs),
    routeStops: Array.isArray(row.route_stops) ? row.route_stops : [],
    manuallyGrouped: Boolean(row.manually_grouped),
    palletQuantityOverrides,
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
    lines,
    physicalPalletLines
  };
}

async function proposalRows({ proposalId = null, runId = null, status = "", statuses = [], type = "", search = "", requestedOnly = false, vendorQueue = false, limit = 500 } = {}) {
  const params = [];
  const clauses = [];
  if (proposalId) {
    params.push(Number(proposalId));
    clauses.push(`p.id = $${params.length}`);
  } else {
    clauses.push("p.vendor_resolution_kind IS NULL");
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
    clauses.push(`(p.id::text ILIKE $${params.length} OR p.source_name ILIKE $${params.length} OR p.destination_name ILIKE $${params.length} OR p.vendor ILIKE $${params.length} OR p.blanket_source_po_ref ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM scm_smart_proposal_lines search_line WHERE search_line.proposal_id = p.id
        AND (search_line.item_name ILIKE $${params.length} OR search_line.item_id::text ILIKE $${params.length})
    ))`);
  }
  params.push(Math.min(2000, Math.max(1, Number(limit) || 500)));
  const result = await query(
    `SELECT p.*,
            planning_run.started_at AS planning_run_created_at,
            planning_run.completed_at AS planning_run_completed_at,
            planning_run.settings_snapshot AS planning_run_settings,
            (
              SELECT jsonb_build_object(
                'itemId', pallet.item_id,
                'itemName', pallet.item_name,
                'unit', pallet.stock_unit,
                'itemWeightLbs', pallet.item_weight
              )
                FROM inventory_items pallet
               WHERE UPPER(BTRIM(COALESCE(pallet.item_name, ''))) = 'PALLET'
               ORDER BY pallet.item_id
               LIMIT 1
            ) AS pallet_item,
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
      ORDER BY ${vendorQueue ? "p.order_requested_at DESC NULLS LAST, p.id DESC" : `p.run_id DESC,
        CASE p.urgency_level
          WHEN 'ultimate_urgent' THEN 3
          WHEN 'super_urgent' THEN 2
          WHEN 'urgent' THEN 1
          ELSE 0
        END DESC,
        p.urgency_score DESC, p.id`}
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function loadSmartScmPlanningDemandStates({
  forecastRunId = null,
  includeTemporarilyExcluded = true,
  excludeTransferOrderIds = []
} = {}) {
  const selectedForecastRunId = forecastRunId || await latestSmartScmForecastRunId();
  const settings = await settingsRow();
  const policies = await loadSmartScmPlanningPolicies({ includeTemporarilyExcluded });
  const inventory = await inventoryState({ excludeTransferOrderIds });
  const supplyMap = await latestVendorSupplyMap();
  const forecasts = await smartScmForecastMap(selectedForecastRunId);
  const routeRules = await smartScmRouteRuleMap();
  const minimumOrders = await smartScmMinimumOrderMap(policies);
  const states = classifySmartScmUrgency(policies.map((policy) => calculatePolicyState(
    policy,
    forecasts.get(`${policy.item_id}:${policy.location_id}`),
    inventory,
    minimumOrders.get(`${policy.item_id}:${policy.location_id}`),
    settings
  )));
  return {
    forecastRunId: selectedForecastRunId,
    settings,
    policies,
    states,
    supplyMap,
    forecasts,
    routeRules,
    minimumOrders
  };
}

export async function runSmartScmPlan({ triggerSource = "manual", operatorId = null, forecastRunId = null } = {}) {
  const planning = await loadSmartScmPlanningDemandStates({
    forecastRunId,
    includeTemporarilyExcluded: true
  });
  const selectedForecastRunId = planning.forecastRunId;
  const { settings, states, supplyMap, routeRules } = planning;
  const temporarilyExcludedItemIds = await listSmartScmActivePlanningExclusionItemIds();
  const created = await query(
    `INSERT INTO scm_smart_planning_runs (trigger_source, forecast_run_id, settings_snapshot, created_by, plan_kind)
     VALUES ($1, $2, $3::jsonb, $4, 'inventory')
     RETURNING *`,
    [triggerSource, selectedForecastRunId, JSON.stringify(settings), operatorId]
  );
  const run = created.rows[0];
  try {
    const calculated = smartScmBuildPlanningDrafts({ states, supplyMap, settings });
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
        temporarilyExcludedItems: temporarilyExcludedItemIds.length,
        temporarilyExcludedItemIds,
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
      details: {
        runId: Number(run.id),
        forecastRunId: selectedForecastRunId,
        triggerSource,
        proposalCount: drafts.length,
        temporarilyExcludedItems: temporarilyExcludedItemIds.length,
        temporarilyExcludedItemIds,
        exceptions
      }
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

export async function listSmartScmPlanningRuns({ limit = 30, planKind = "inventory" } = {}) {
  const kind = String(planKind || "inventory").trim().toLowerCase();
  const result = await query(
    `SELECT *
       FROM scm_smart_planning_runs
      WHERE ($2 = '' OR plan_kind = $2)
      ORDER BY id DESC
      LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit) || 30)), kind]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    status: row.status,
    triggerSource: row.trigger_source,
    planKind: row.plan_kind || "inventory",
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
    planKind: row.plan_kind || "inventory",
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

export async function setSmartScmPalletQuantityOverride(proposalId, destinationLocationId, values = {}, operatorId = null) {
  const id = Number(proposalId);
  const destinationId = Number(destinationLocationId);
  const { reset, quantity } = smartScmPalletQuantityOverridePatch(values);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("Select a valid Smart SCM proposal."), { status: 400 });
  }
  if (!Number.isInteger(destinationId) || destinationId <= 0) {
    throw Object.assign(new Error("Select a valid PALLET destination."), { status: 400 });
  }
  const outcome = await withTransaction(async () => {
    const currentResult = await query(
      `SELECT p.*, planning_run.settings_snapshot
         FROM scm_smart_proposals p
         LEFT JOIN scm_smart_planning_runs planning_run ON planning_run.id = p.run_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [id]
    );
    if (!currentResult.rowCount) {
      throw Object.assign(new Error("Smart SCM proposal was not found."), { status: 404 });
    }
    const current = currentResult.rows[0];
    const isNetSuitePoReview = current.vendor_resolution_kind === "netsuite_po_review";
    const editableStatuses = isNetSuitePoReview
      ? new Set(["confirmed", "failed"])
      : new Set(["draft", "held", "reviewed", "attention", "order_requested", "vendor_replied", "failed"]);
    if (!editableStatuses.has(current.status)) {
      throw Object.assign(new Error("This proposal is locked and its PALLET quantity cannot be changed."), { status: 409 });
    }
    if (current.netsuite_transfer_order_id || current.netsuite_transfer_order_ref
      || current.netsuite_purchase_order_id || current.netsuite_purchase_order_ref) {
      throw Object.assign(new Error("This proposal already has an execution reference and its PALLET quantity cannot be changed."), { status: 409 });
    }
    const linesResult = await query(
      `SELECT * FROM scm_smart_proposal_lines
        WHERE proposal_id = $1
        ORDER BY id
        FOR UPDATE`,
      [id]
    );
    if (!linesResult.rows.some((line) => Number(line.destination_location_id) === destinationId)) {
      throw Object.assign(new Error("The selected destination is not part of this load."), { status: 409 });
    }
    const overrides = smartScmNormalizePalletQuantityOverrides(current.pallet_quantity_overrides);
    if (reset) delete overrides[String(destinationId)];
    else overrides[String(destinationId)] = round(quantity);
    const palletItemResult = await query(
      `SELECT item_id, item_name, stock_unit, item_weight
         FROM inventory_items
        WHERE UPPER(BTRIM(COALESCE(item_name, ''))) = 'PALLET'
        ORDER BY item_id
        LIMIT 1`
    );
    const useConfirmedPallets = current.vendor_resolution_kind === "netsuite_po_review";
    const palletLines = smartScmPhysicalPalletLines({
      id,
      destinationLocationId: current.destination_location_id,
      destinationName: current.destination_name,
      lines: linesResult.rows,
      palletQuantityOverrides: overrides,
      useConfirmedPallets
    }, palletItemResult.rows[0] || null);
    const materialWeight = round(linesResult.rows.reduce((sum, line) => sum + (useConfirmedPallets
      ? positive(line.confirmed_pallets) * positive(line.pallet_weight_lbs)
      : positive(line.line_weight_lbs)), 0));
    const totalWeight = round(materialWeight + palletLines.reduce((sum, line) => sum + positive(line.lineWeightLbs), 0));
    const settings = await settingsRow();
    const capacity = positive(current.settings_snapshot?.truck_capacity_lbs)
      || positive(settings.truck_capacity_lbs);
    const automaticPalletLines = smartScmPhysicalPalletLines({
      id,
      destinationLocationId: current.destination_location_id,
      destinationName: current.destination_name,
      lines: linesResult.rows,
      palletQuantityOverrides: {},
      useConfirmedPallets
    }, palletItemResult.rows[0] || null);
    const automaticTotalWeight = round(materialWeight
      + automaticPalletLines.reduce((sum, line) => sum + positive(line.lineWeightLbs), 0));
    const overCapacity = current.proposal_type === "TO" && capacity > EPSILON
      && totalWeight > capacity + EPSILON;
    const palletOverrideMakesOverCapacity = overCapacity
      && Object.keys(overrides).length > 0
      && automaticTotalWeight <= capacity + EPSILON;
    await query(
      `UPDATE scm_smart_proposals
          SET pallet_quantity_overrides = $2::jsonb,
              total_weight_lbs = $3,
              utilization = CASE WHEN $4::numeric > 0 THEN $3::numeric / $4::numeric ELSE 0 END,
              updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(overrides), totalWeight, capacity]
    );
    if (totalWeight <= capacity + EPSILON) {
      await query(
        `UPDATE scm_smart_proposal_lines
            SET reason = COALESCE(reason, '{}'::jsonb) - $2::text[], updated_at = now()
          WHERE proposal_id = $1
            AND COALESCE(reason, '{}'::jsonb) ?| $2::text[]`,
        [id, MANUAL_CAPACITY_REASON_KEYS]
      );
    }
    return {
      runId: Number(current.run_id),
      overrides,
      totalWeight,
      capacity,
      automaticTotalWeight,
      overCapacity,
      palletOverrideMakesOverCapacity
    };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: reset ? "smart_scm.pallet_quantity.reset" : "smart_scm.pallet_quantity.override",
    details: {
      proposalId: id,
      destinationLocationId: destinationId,
      quantity: reset ? null : round(quantity),
      reset,
      totalWeightLbs: outcome.totalWeight,
      automaticTotalWeightLbs: outcome.automaticTotalWeight,
      truckCapacityLbs: outcome.capacity,
      overCapacity: outcome.overCapacity,
      palletOverrideMakesOverCapacity: outcome.palletOverrideMakesOverCapacity
    }
  });
  return getSmartScmProposal(id);
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
    const policies = await loadSmartScmPlanningPolicies({ includeTemporarilyExcluded: true });
    const inventory = await inventoryState();
    const forecastMap = await smartScmForecastMap();
    const minimumOrders = await smartScmMinimumOrderMap(policies);
    const policy = policies.find((candidate) => String(candidate.item_id) === String(line.item_id) && String(candidate.location_id) === String(line.destination_location_id));
    if (policy) {
      const refreshedStates = classifySmartScmUrgency(policies.map((candidate) => calculatePolicyState(
        candidate,
        forecastMap.get(`${candidate.item_id}:${candidate.location_id}`),
        inventory,
        minimumOrders.get(`${candidate.item_id}:${candidate.location_id}`),
        settings
      )));
      const stateByKey = new Map(refreshedStates.map((state) => [state.key, state]));
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
    if (proposal.status === "executing") {
      const lastUpdate = new Date(proposal.updated_at || 0).getTime();
      const freshExecution = Number.isFinite(lastUpdate) && lastUpdate > 0
        && Date.now() - lastUpdate < 5 * 60 * 1000;
      if (freshExecution) {
        throw Object.assign(new Error("This TO confirmation is already running. Wait for it to finish before retrying."), { status: 409 });
      }
    } else if (!["draft", "reviewed", "held", "failed", "attention"].includes(proposal.status)) {
      throw Object.assign(new Error("This TO proposal is not available for confirmation."), { status: 409 });
    }
    if (proposal.phase === "hub_store") {
      throw Object.assign(new Error("This legacy provisional TO depends on stock that has not been received. Run a new plan after the inventory is available at the source yard."), { status: 409 });
    }
    if (proposal.status === "held") throw Object.assign(new Error("Review and release this held load before confirming it."), { status: 409 });
    if (proposal.lines.some((line) => line.manual_planning_required)) throw Object.assign(new Error("Resolve missing conversion or pallet weight before confirming this load."), { status: 409 });
    const settings = await settingsRow();
    const palletQuantityOverrides = smartScmNormalizePalletQuantityOverrides(proposal.pallet_quantity_overrides);
    const palletTransferQuantity = round(smartScmPhysicalPalletLines({
      id: proposal.id,
      destinationLocationId: proposal.destination_location_id,
      destinationName: proposal.destination_name,
      lines: proposal.lines,
      palletQuantityOverrides
    }).reduce((sum, line) => sum + positive(line.quantity), 0));
    const automaticPalletTransferQuantity = round(smartScmPhysicalPalletLines({
      id: proposal.id,
      destinationLocationId: proposal.destination_location_id,
      destinationName: proposal.destination_name,
      lines: proposal.lines,
      palletQuantityOverrides: {}
    }).reduce((sum, line) => sum + positive(line.quantity), 0));
    const palletWeightResult = await query(
      `SELECT COALESCE(item_weight, 0) AS item_weight
         FROM inventory_items
        WHERE UPPER(BTRIM(COALESCE(item_name, ''))) = 'PALLET'
        ORDER BY item_id LIMIT 1`
    );
    const physicalPalletWeightLbs = positive(palletWeightResult.rows[0]?.item_weight);
    if (palletTransferQuantity > EPSILON && physicalPalletWeightLbs <= EPSILON) {
      throw Object.assign(
        new Error("The active local PALLET item needs a positive weight before confirming this TO."),
        { status: 409 }
      );
    }
    const materialWeight = round(proposal.lines.reduce((sum, line) => sum + positive(line.line_weight_lbs), 0));
    const grossWeight = round(materialWeight + (palletTransferQuantity * physicalPalletWeightLbs));
    const automaticGrossWeight = round(materialWeight
      + (automaticPalletTransferQuantity * physicalPalletWeightLbs));
    const truckCapacityLbs = positive(settings.truck_capacity_lbs);
    const overCapacity = grossWeight > truckCapacityLbs + EPSILON;
    const manualCapacityOverride = proposal.lines.some((line) => line.reason?.manualCapacityOverride === true);
    const palletOverrideMakesOverCapacity = Object.keys(palletQuantityOverrides).length > 0
      && overCapacity
      && automaticGrossWeight <= truckCapacityLbs + EPSILON;
    if (overCapacity && !manualCapacityOverride && !palletOverrideMakesOverCapacity) {
      throw Object.assign(
        new Error("This TO exceeds truck capacity without an explicit manual capacity override. Save the intended manual quantity before confirming."),
        { status: 409 }
      );
    }
    const [policies, inventory, forecastMap] = await Promise.all([
      loadSmartScmPlanningPolicies({ includeTemporarilyExcluded: true }),
      inventoryState(),
      smartScmForecastMap()
    ]);
    const minimumOrders = await smartScmMinimumOrderMap(policies);
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
      const manualSourceFloorOverride = smartScmLineOverridesSourceStockFloor(line);
      const limit = smartScmConfirmationSourceTransferLimit({
        availablePallets,
        safetyStockPallets: sourceState.safety,
        reorderPointPallets: sourceState.rop,
        manualOverride: manualSourceFloorOverride
      });
      const { protectedFloorPallets: protectedFloor, maximumTransferablePallets: maximumTransferable } = limit;
      if (positive(line.proposed_pallets) > maximumTransferable + EPSILON) {
        const message = manualSourceFloorOverride
          ? `${line.item_name} has only ${round(availablePallets, 2)} unreserved PLT available at ${proposal.source_name}; the user-entered quantity can transfer at most ${maximumTransferable} whole PLT. Refresh inventory or reduce the quantity.`
          : `${line.item_name} can transfer at most ${maximumTransferable} PLT from ${proposal.source_name}: ${round(availablePallets, 2)} available and ${round(protectedFloor, 2)} protected (safety stock / reorder point). Refresh and replan.`;
        throw Object.assign(new Error(message), { status: 409 });
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
      palletTransferQuantity,
      grossWeightLbs: grossWeight,
      automaticGrossWeightLbs: automaticGrossWeight,
      truckCapacityLbs,
      overCapacity,
      manualCapacityOverride: overCapacity && (manualCapacityOverride || palletOverrideMakesOverCapacity),
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
