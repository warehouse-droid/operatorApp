import { query } from "./db.js";
import {
  listLatestSalesOrderReattemptItemCorrections,
  projectSalesOrderReattemptLineSnapshot
} from "./sales-order-reattempt-correction-repository.js";

const MAX_REF_LENGTH = 100;
const MAX_LOCATION_LENGTH = 500;
const MAX_DETAILS_LENGTH = 5000;
const MAX_WEIGHT_LBS = 1000000;
const MAX_STOP_MINUTES = 1440;
const SALES_ORDER_REATTEMPT_BILLING_DISPOSITION = "linked_parent_no_charge";
const UNSAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#+-]*$/;

function inputError(message, code = "DISPATCH_CUSTOM_ORDER_INVALID") {
  return Object.assign(new Error(message), { status: 400, code });
}

function conflictError(message, code = "DISPATCH_CUSTOM_ORDER_CONFLICT") {
  return Object.assign(new Error(message), { status: 409, code });
}

async function assertNoActiveTransitCo(refNumber) {
  const result = await query(
    `SELECT co_ref, status
       FROM local_co_orders
      WHERE lower(btrim(source_order_ref)) = lower(btrim($1))
        AND status <> 'cancelled'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [String(refNumber || "").trim()]
  );
  const activeCo = result.rows[0];
  if (!activeCo) return;
  throw conflictError(
    `Cancel ${activeCo.co_ref} before editing or cancelling this Custom Order.`,
    "DISPATCH_CUSTOM_ORDER_ACTIVE_CO"
  );
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw inputError(`${label} is required.`);
  if (text.length > maxLength) throw inputError(`${label} must be ${maxLength} characters or fewer.`);
  if (UNSAFE_TEXT_CONTROL_CHARACTERS.test(text)) {
    throw inputError(`${label} contains an unsupported control character.`);
  }
  return text;
}

function optionalStopMinutes(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_STOP_MINUTES) {
    throw inputError(`Destination stop time must be a whole number from 0 to ${MAX_STOP_MINUTES} minutes.`);
  }
  return minutes;
}

function customOrderInput(input = {}) {
  const refNumber = requiredText(input.refNumber ?? input.ref_number, "Reference number", MAX_REF_LENGTH);
  if (!SAFE_REFERENCE_PATTERN.test(refNumber)) {
    throw inputError(
      "Reference number may contain only letters, numbers, hyphens, underscores, periods, slashes, colons, plus signs, and #."
    );
  }
  const pickupLocation = requiredText(
    input.pickupLocation ?? input.pickup_location,
    "Pickup location/address",
    MAX_LOCATION_LENGTH
  );
  const dropoffLocation = requiredText(
    input.dropoffLocation ?? input.dropoff_location,
    "Drop-off location/address",
    MAX_LOCATION_LENGTH
  );
  const orderDetails = requiredText(
    input.orderDetails ?? input.order_details,
    "Order details",
    MAX_DETAILS_LENGTH
  );
  const weightLbs = Number(input.weightLbs ?? input.weight_lbs);
  if (!Number.isFinite(weightLbs) || weightLbs <= 0) {
    throw inputError("Weight must be greater than zero.");
  }
  if (weightLbs > MAX_WEIGHT_LBS) {
    throw inputError(`Weight must be ${MAX_WEIGHT_LBS.toLocaleString("en-CA")} lb or less.`);
  }
  const stopMinutes = optionalStopMinutes(input.stopMinutes ?? input.stop_minutes);
  return {
    refNumber,
    pickupLocation,
    dropoffLocation,
    orderDetails,
    weightLbs: Math.round(weightLbs * 1000) / 1000,
    stopMinutes
  };
}

function rowToCustomOrder(row = {}, corrections = []) {
  const rawLineSnapshot = Array.isArray(row.line_snapshot) ? row.line_snapshot : [];
  const lineSnapshot = row.order_kind === "sales_order_reattempt"
    ? projectSalesOrderReattemptLineSnapshot(rawLineSnapshot, corrections)
    : rawLineSnapshot;
  const transitCo = row.transit_co_ref ? {
    id: row.transit_co_ref,
    fromYard: row.transit_co_from_yard || row.pickup_location || "",
    toYard: row.transit_co_to_yard || "",
    status: row.transit_co_status || "",
    sourceOrderId: row.ref_number || "",
    source: "local-db"
  } : null;
  return {
    id: String(row.id || ""),
    refNumber: row.ref_number || "",
    pickupLocation: row.pickup_location || "",
    dropoffLocation: row.dropoff_location || "",
    orderDetails: row.order_details || "",
    weightLbs: Number(row.weight_lbs || 0),
    stopMinutes: row.stop_minutes === null || row.stop_minutes === undefined
      ? null
      : Number(row.stop_minutes),
    status: row.status || "open",
    createdBy: row.created_by || "",
    updatedBy: row.updated_by || "",
    cancelledBy: row.cancelled_by || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
    orderKind: row.order_kind || "custom",
    systemManaged: Boolean(row.system_managed),
    parentSalesOrderId: row.parent_sales_order_id === null || row.parent_sales_order_id === undefined
      ? null
      : Number(row.parent_sales_order_id),
    parentOrderRef: row.parent_order_ref || "",
    reloadCycleId: row.reload_cycle_id === null || row.reload_cycle_id === undefined
      ? null
      : Number(row.reload_cycle_id),
    lineSnapshot,
    identityCorrections: corrections,
    palletQty: Number(row.pallet_qty || 0),
    layerQty: Number(row.layer_qty || 0),
    sectionQty: Number(row.section_qty || 0),
    pieceQty: Number(row.piece_qty || 0),
    salesQty: Number(row.sales_qty || 0),
    transitCo,
    billingDisposition: row.order_kind === "sales_order_reattempt"
      ? SALES_ORDER_REATTEMPT_BILLING_DISPOSITION
      : row.billing_disposition || "standard"
  };
}

async function mapCustomOrderRows(rows = []) {
  const corrections = await listLatestSalesOrderReattemptItemCorrections(
    rows.filter((row) => row.order_kind === "sales_order_reattempt").map((row) => row.id)
  );
  const byOrder = new Map();
  for (const correction of corrections) {
    const existing = byOrder.get(correction.childOrderId) || [];
    existing.push(correction);
    byOrder.set(correction.childOrderId, existing);
  }
  return rows.map((row) => rowToCustomOrder(row, byOrder.get(Number(row.id)) || []));
}

async function assertReferenceAvailable(refNumber, { excludeCustomOrderId = null } = {}) {
  const result = await query(
    `WITH known_refs AS (
       SELECT 'Sales Order'::text AS source, tranid AS ref
         FROM sales_orders
       UNION ALL
       SELECT 'Purchase Order', tranid
         FROM purchase_orders
       UNION ALL
       SELECT 'Purchase Order dispatch reference', dispatch_ref
         FROM purchase_orders
        WHERE COALESCE(dispatch_ref, '') <> ''
       UNION ALL
       SELECT 'Transfer Order', tranid
         FROM transfer_orders
       UNION ALL
       SELECT 'Transit Depot Order', co_ref
         FROM co_orders
       UNION ALL
       SELECT 'Legacy Transit Depot Order', co_ref
         FROM local_co_orders
       UNION ALL
       SELECT 'VRMA', vrma_ref
         FROM scm_vrma_orders
       UNION ALL
       SELECT 'Custom Order', ref_number
         FROM dispatch_custom_orders
        WHERE ($2::bigint IS NULL OR id <> $2::bigint)
     )
     SELECT source, ref
       FROM known_refs
      WHERE lower(btrim(COALESCE(ref, ''))) = lower(btrim($1))
      LIMIT 1`,
    [refNumber, excludeCustomOrderId]
  );
  if (!result.rowCount) return;
  throw conflictError(
    `Reference ${refNumber} is already used by a ${result.rows[0].source}. Choose a unique reference number.`,
    "DISPATCH_CUSTOM_ORDER_REF_EXISTS"
  );
}

function translateUniqueViolation(error, refNumber) {
  if (error?.code !== "23505") throw error;
  throw conflictError(
    `Reference ${refNumber} is already used by another Custom Order. Choose a unique reference number.`,
    "DISPATCH_CUSTOM_ORDER_REF_EXISTS"
  );
}

export async function listDispatchCustomOrders({
  includeCancelled = false,
  includeCompleted = true,
  search = "",
  limit = 500
} = {}) {
  const term = String(search || "").trim().slice(0, 120);
  const cleanLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const result = await query(
    `SELECT custom_order.*,
            active_co.co_ref AS transit_co_ref,
            active_co.from_location AS transit_co_from_yard,
            active_co.to_location AS transit_co_to_yard,
            active_co.status AS transit_co_status
       FROM dispatch_custom_orders custom_order
       LEFT JOIN LATERAL (
         SELECT co.co_ref, co.from_location, co.to_location, co.status
           FROM local_co_orders co
          WHERE co.source_order_ref = custom_order.ref_number
            AND co.status <> 'cancelled'
          ORDER BY co.updated_at DESC, co.id DESC
          LIMIT 1
       ) active_co ON true
      WHERE ($1::boolean OR custom_order.status <> 'cancelled')
        AND ($4::boolean OR custom_order.status <> 'completed')
        AND (
          $2::text = ''
          OR custom_order.ref_number ILIKE '%' || $2 || '%'
          OR custom_order.pickup_location ILIKE '%' || $2 || '%'
          OR custom_order.dropoff_location ILIKE '%' || $2 || '%'
          OR custom_order.order_details ILIKE '%' || $2 || '%'
          OR custom_order.created_by ILIKE '%' || $2 || '%'
        )
      ORDER BY custom_order.created_at DESC, custom_order.id DESC
      LIMIT $3`,
    [Boolean(includeCancelled), term, cleanLimit, Boolean(includeCompleted)]
  );
  return mapCustomOrderRows(result.rows);
}

export async function getDispatchCustomOrder(id) {
  const result = await query(
    `SELECT *
       FROM dispatch_custom_orders
      WHERE id = $1`,
    [id]
  );
  return result.rowCount ? (await mapCustomOrderRows(result.rows))[0] : null;
}

export async function getDispatchCustomOrderForUpdate(id) {
  const result = await query(
    `SELECT *
       FROM dispatch_custom_orders
      WHERE id = $1
      FOR UPDATE`,
    [id]
  );
  return result.rowCount ? (await mapCustomOrderRows(result.rows))[0] : null;
}

export async function createDispatchCustomOrder(input = {}, actor = "") {
  const normalized = customOrderInput(input);
  await assertReferenceAvailable(normalized.refNumber);
  try {
    const result = await query(
      `INSERT INTO dispatch_custom_orders (
         ref_number, pickup_location, dropoff_location, order_details,
         weight_lbs, stop_minutes, status, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $7)
       RETURNING *`,
      [
        normalized.refNumber,
        normalized.pickupLocation,
        normalized.dropoffLocation,
        normalized.orderDetails,
        normalized.weightLbs,
        normalized.stopMinutes,
        String(actor || "")
      ]
    );
    return rowToCustomOrder(result.rows[0]);
  } catch (error) {
    translateUniqueViolation(error, normalized.refNumber);
  }
}

export async function updateDispatchCustomOrder(id, input = {}, actor = "") {
  const current = await getDispatchCustomOrder(id);
  if (!current) return null;
  if (current.systemManaged || current.orderKind === "sales_order_reattempt") {
    throw conflictError(
      "Sales Order re-attempt children are system-managed. Change them through the linked re-attempt workflow.",
      "DISPATCH_CUSTOM_ORDER_SYSTEM_MANAGED"
    );
  }
  if (current.status !== "open") {
    throw conflictError("Only open Custom Orders can be edited.", "DISPATCH_CUSTOM_ORDER_NOT_EDITABLE");
  }
  await assertNoActiveTransitCo(current.refNumber);
  const normalized = customOrderInput({
    refNumber: current.refNumber,
    pickupLocation: input.pickupLocation ?? input.pickup_location ?? current.pickupLocation,
    dropoffLocation: input.dropoffLocation ?? input.dropoff_location ?? current.dropoffLocation,
    orderDetails: input.orderDetails ?? input.order_details ?? current.orderDetails,
    weightLbs: input.weightLbs ?? input.weight_lbs ?? current.weightLbs,
    stopMinutes: input.stopMinutes ?? input.stop_minutes ?? current.stopMinutes
  });
  const requestedRef = String(input.refNumber ?? input.ref_number ?? current.refNumber).trim();
  if (requestedRef.toLowerCase() !== current.refNumber.toLowerCase()) {
    throw conflictError(
      "The reference number is locked after creation. Create a new Custom Order if the reference must change.",
      "DISPATCH_CUSTOM_ORDER_REF_LOCKED"
    );
  }
  const result = await query(
    `UPDATE dispatch_custom_orders
        SET pickup_location = $2,
            dropoff_location = $3,
            order_details = $4,
            weight_lbs = $5,
            stop_minutes = $6,
            updated_by = $7,
            updated_at = now()
      WHERE id = $1
        AND status = 'open'
      RETURNING *`,
    [
      id,
      normalized.pickupLocation,
      normalized.dropoffLocation,
      normalized.orderDetails,
      normalized.weightLbs,
      normalized.stopMinutes,
      String(actor || "")
    ]
  );
  if (!result.rowCount) {
    throw conflictError("This Custom Order changed before the update completed. Refresh and try again.");
  }
  return rowToCustomOrder(result.rows[0]);
}

export async function cancelDispatchCustomOrder(id, actor = "") {
  const current = await getDispatchCustomOrder(id);
  if (!current) return null;
  if (current.systemManaged || current.orderKind === "sales_order_reattempt") {
    throw conflictError(
      "Sales Order re-attempt children are system-managed. Cancel them from the linked re-attempt workflow.",
      "DISPATCH_CUSTOM_ORDER_SYSTEM_MANAGED"
    );
  }
  if (current.status === "cancelled") return current;
  await assertNoActiveTransitCo(current.refNumber);
  const result = await query(
    `UPDATE dispatch_custom_orders
        SET status = 'cancelled',
            cancelled_by = $2,
            cancelled_at = now(),
            updated_by = $2,
            updated_at = now()
      WHERE id = $1
        AND status = 'open'
      RETURNING *`,
    [id, String(actor || "")]
  );
  return result.rowCount ? rowToCustomOrder(result.rows[0]) : null;
}

export async function completeDispatchCustomOrders(refNumbers = [], actor = "") {
  const refs = [...new Set(
    (refNumbers || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
  )];
  if (!refs.length) return [];
  const result = await query(
    `UPDATE dispatch_custom_orders
        SET status = 'completed',
            completed_at = COALESCE(completed_at, now()),
            updated_by = $2,
            updated_at = now()
      WHERE lower(btrim(ref_number)) = ANY($1::text[])
        AND status = 'open'
      RETURNING *`,
    [refs, String(actor || "driver")]
  );
  return result.rows.map(rowToCustomOrder);
}

export function dispatchOrderFromCustomOrder(customOrder = {}) {
  const pickupLocation = String(customOrder.pickupLocation || "").trim();
  const transitCo = customOrder.transitCo?.id && customOrder.transitCo?.toYard
    ? {
        ...customOrder.transitCo,
        sourceOrderId: customOrder.refNumber
      }
    : null;
  const effectivePickupLocation = String(transitCo?.toYard || pickupLocation).trim();
  const ownYardPickup = ["3445", "2967", "12441", "150"].includes(effectivePickupLocation);
  const salesOrderReattempt = customOrder.orderKind === "sales_order_reattempt";
  const genericItem = {
    lineRowId: `custom:${customOrder.id}`,
    lineId: 1,
    itemId: null,
    sku: "CUSTOM",
    itemName: "Custom order",
    description: customOrder.orderDetails || "",
    pallets: 0,
    layers: 0,
    sections: 0,
    pieces: 0,
    quantity: 1,
    salesQty: 1,
    unit: "LOAD",
    itemWeight: Number(customOrder.weightLbs || 0),
    lineWeight: Number(customOrder.weightLbs || 0)
  };
  const items = salesOrderReattempt && Array.isArray(customOrder.lineSnapshot)
    ? customOrder.lineSnapshot.map((line, index) => ({
        lineRowId: line.lineRowId || `reattempt:${customOrder.id}:${index}`,
        lineId: line.lineId ?? index + 1,
        itemId: line.itemId ?? null,
        sku: line.sku || line.itemName || "",
        itemName: line.itemName || line.sku || "",
        description: line.description || "",
        pallets: Number(line.pallets || 0),
        layers: Number(line.layers || 0),
        sections: Number(line.sections || 0),
        pieces: Number(line.pieces || 0),
        quantity: Number(line.quantity ?? line.salesQty ?? 0),
        salesQty: Number(line.salesQty ?? line.quantity ?? 0),
        unit: line.unit || "",
        itemWeight: Number(line.itemWeight || 0),
        lineWeight: Number(line.lineWeight || 0),
        reason: line.reason || "",
        historicalSku: line.historicalSku || line.sku || "",
        historicalItemId: line.historicalItemId ?? line.itemId ?? null,
        historicalItemName: line.historicalItemName || line.historicalSku || line.sku || "",
        historicalDescription: line.historicalDescription || "",
        currentSku: line.currentSku || "",
        currentItemId: line.currentItemId ?? null,
        currentItemName: line.currentItemName || line.currentSku || "",
        effectiveSku: line.effectiveSku || line.sku || "",
        effectiveItemId: line.effectiveItemId ?? line.itemId ?? null,
        identityCorrected: Boolean(line.identityCorrected),
        identityCorrectionReason: line.identityCorrectionReason || "",
        identityCorrectedAt: line.identityCorrectedAt || null,
        skuMismatch: Boolean(line.skuMismatch),
        itemMismatch: Boolean(line.itemMismatch)
      }))
    : [genericItem];
  const salesQuantities = [...items.reduce((totals, item) => {
    const unit = String(item.unit || "LOAD");
    totals.set(unit, Number(totals.get(unit) || 0) + Number(item.salesQty || 0));
    return totals;
  }, new Map()).entries()].map(([unit, quantity]) => ({ unit, quantity }));
  return {
    id: customOrder.refNumber,
    customOrderId: String(customOrder.id || ""),
    customOrder: true,
    orderKind: customOrder.orderKind || "custom",
    salesOrderReattempt,
    parentSalesOrderId: customOrder.parentSalesOrderId || null,
    parentOrderRef: customOrder.parentOrderRef || "",
    reloadCycleId: customOrder.reloadCycleId || null,
    billingDisposition: customOrder.billingDisposition || "standard",
    systemManaged: Boolean(customOrder.systemManaged),
    netsuiteId: null,
    type: "CUSTOM",
    sourceTable: "dispatch_custom_orders",
    dispatchRef: customOrder.refNumber,
    customer: salesOrderReattempt
      ? `Sales Order re-attempt · ${customOrder.parentOrderRef || "linked parent"}`
      : "Custom Order",
    address: customOrder.dropoffLocation,
    sourceYard: effectivePickupLocation,
    sourceAddress: effectivePickupLocation,
    defaultSourceAddress: pickupLocation,
    pickupAddressOverride: ownYardPickup ? "" : effectivePickupLocation,
    destinationAddress: customOrder.dropoffLocation,
    destinationYard: customOrder.dropoffLocation,
    expectedDeliveryDate: "",
    windowStart: "",
    windowEnd: "",
    instructions: customOrder.orderDetails,
    notes: customOrder.orderDetails,
    stopMinutes: customOrder.stopMinutes === null || customOrder.stopMinutes === undefined
      ? null
      : Number(customOrder.stopMinutes),
    pickupLocations: [effectivePickupLocation],
    transitOriginalPickupLocations: transitCo ? [pickupLocation] : [],
    transitOriginalSourceYard: transitCo ? pickupLocation : undefined,
    transitCo,
    dropoffs: [],
    pallets: salesOrderReattempt ? Number(customOrder.palletQty || 0) : 0,
    layers: salesOrderReattempt ? Number(customOrder.layerQty || 0) : 0,
    sections: salesOrderReattempt ? Number(customOrder.sectionQty || 0) : 0,
    pieces: salesOrderReattempt ? Number(customOrder.pieceQty || 0) : 0,
    salesQty: salesOrderReattempt ? Number(customOrder.salesQty || 0) : 1,
    salesQuantities: salesOrderReattempt ? salesQuantities : [{ unit: "LOAD", quantity: 1 }],
    packed: { pallets: 0, layers: 0, sections: 0, pieces: 0 },
    weight: Number(customOrder.weightLbs || 0),
    items,
    raw: {
      custom_order_id: String(customOrder.id || ""),
      ref_number: customOrder.refNumber,
      status: customOrder.status,
      order_kind: customOrder.orderKind || "custom",
      parent_sales_order_id: customOrder.parentSalesOrderId || null,
      parent_order_ref: customOrder.parentOrderRef || "",
      reload_cycle_id: customOrder.reloadCycleId || null,
      billing_disposition: customOrder.billingDisposition || "standard",
      line_snapshot: customOrder.lineSnapshot || [],
      stop_minutes: customOrder.stopMinutes === null || customOrder.stopMinutes === undefined
        ? null
        : Number(customOrder.stopMinutes),
      created_at: customOrder.createdAt,
      updated_at: customOrder.updatedAt
    },
    netsuiteStatus: customOrder.status,
    netsuiteStatusText: salesOrderReattempt ? "Sales Order re-attempt" : "Custom Order",
    fulfillmentStatus: "",
    netsuiteActive: true,
    operatorStatus: "",
    localYardOrderStatus: "Open",
    dispatchPlanned: false,
    dispatchPlanDate: "",
    dispatchTruckPlate: "",
    dispatchLoadName: "",
    dispatchParkingSpot: "",
    childOrders: [],
    createdAt: customOrder.createdAt,
    updatedAt: customOrder.updatedAt,
    scm: {
      method: "MBT",
      status: "Queued",
      isSpecialOrder: false,
      groupRef: "",
      packingSlipRef: "",
      etaDate: "",
      etaTime: "",
      driver: "",
      notes: customOrder.orderDetails
    }
  };
}

export class DispatchCustomOrderPlanError extends Error {
  constructor(message, code = "DISPATCH_CUSTOM_ORDER_PLAN_INVALID", details = {}) {
    super(message);
    this.name = "DispatchCustomOrderPlanError";
    this.status = 409;
    this.code = code;
    this.details = details;
  }
}

function isCustomDispatchOrder(order = {}) {
  return String(order?.type || "").trim().toUpperCase() === "CUSTOM"
    || order?.customOrder === true
    || String(order?.sourceTable || "").trim().toLowerCase() === "dispatch_custom_orders"
    || String(order?.customOrderId || "").trim() !== "";
}

function customOrderStableId(order = {}) {
  return String(order?.customOrderId ?? order?.raw?.custom_order_id ?? "").trim();
}

function normalizedRef(value) {
  return String(value || "").trim().toLowerCase();
}

function planStopRows(plan = {}) {
  const rows = [];
  for (const [truckIndex, truck] of (plan.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      for (const [stopIndex, stop] of (load.stops || []).entries()) {
        rows.push({ truck, truckIndex, load, loadIndex, stop, stopIndex });
      }
    }
  }
  return rows;
}

function customWorkSignature(plan = {}, aliases = []) {
  const aliasKeys = new Set((aliases || []).map(normalizedRef).filter(Boolean));
  if (!aliasKeys.size) {
    return {
      assigned: false,
      dropCount: 0,
      pickupCount: 0,
      stopCount: 0,
      routeCount: 0,
      signature: "[]"
    };
  }
  const rows = planStopRows(plan)
    .filter(({ stop }) => aliasKeys.has(normalizedRef(stop?.orderId)))
    .map(({ truck, truckIndex, load, loadIndex, stop, stopIndex }) => ({
      routeKey: `${truckIndex}:${loadIndex}`,
      truck: {
        id: String(truck?.id || truckIndex),
        plate: String(truck?.plate || ""),
        driverLogin: String(truck?.driverLogin || ""),
        driver: String(truck?.driver || "")
      },
      load: {
        id: String(load?.id || loadIndex),
        name: String(load?.name || ""),
        driverLogin: String(load?.driverLogin || ""),
        driverName: String(load?.driverName || ""),
        truckId: String(load?.truckId || ""),
        truckPlate: String(load?.truckPlate || ""),
        parkingSpot: String(load?.parkingSpot || ""),
        driverSequence: Number(load?.driverSequence ?? -1)
      },
      stopIndex,
      stopId: String(stop?.id || ""),
      type: String(stop?.type || ""),
      orderId: "__CUSTOM__"
    }));
  const dropCount = rows.filter((row) => row.type === "drop").length;
  return {
    assigned: dropCount > 0,
    dropCount,
    pickupCount: rows.filter((row) => row.type === "pick").length,
    stopCount: rows.length,
    routeCount: new Set(rows.map((row) => row.routeKey)).size,
    signature: JSON.stringify(rows)
  };
}

function canonicalCustomOrderSnapshot(customOrder, clientOrder = {}, assigned = false) {
  const canonical = dispatchOrderFromCustomOrder(customOrder);
  const snapshot = {
    ...canonical,
    localDispatchStatus: assigned ? "planned" : "open",
    originalOrderId: "",
    childOrders: [],
    childOrderDetails: [],
    groupAliases: [],
    groupKey: ""
  };
  if (Number.isFinite(Number(clientOrder?.unloadMinutes))) snapshot.unloadMinutes = Number(clientOrder.unloadMinutes);
  if (Number.isFinite(Number(clientOrder?.travelMinutes))) snapshot.travelMinutes = Number(clientOrder.travelMinutes);
  return snapshot;
}

function customOrderDispatchPickupLocation(customOrder = {}) {
  return String(customOrder.transitCo?.toYard || customOrder.pickupLocation || "").trim();
}

function customStopError(customOrder, message, code = "DISPATCH_CUSTOM_ORDER_STRUCTURE_INVALID") {
  return new DispatchCustomOrderPlanError(message, code, {
    customOrderId: String(customOrder?.id || ""),
    refNumber: customOrder?.refNumber || ""
  });
}

function canonicalizeCustomStops(plan = {}, customMappings = []) {
  const mappingsByAlias = new Map();
  for (const mapping of customMappings) {
    for (const alias of mapping.aliases) mappingsByAlias.set(normalizedRef(alias), mapping);
    mappingsByAlias.set(normalizedRef(mapping.customOrder.refNumber), mapping);
  }

  const trucks = (plan.trucks || []).map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load) => {
      let stops = (load.stops || []).map((stop) => {
        const mapping = mappingsByAlias.get(normalizedRef(stop?.orderId));
        if (!mapping) return { ...stop };
        const { customOrder } = mapping;
        if (!["pick", "drop"].includes(String(stop?.type || ""))) {
          throw customStopError(
            customOrder,
            `${customOrder.refNumber} has an unsupported ${stop?.type || "unknown"} stop in the dispatch plan.`
          );
        }
        if (stop.type === "pick") {
          const next = {
            ...stop,
            loadId: load.id || "",
            orderId: customOrder.refNumber,
            location: customOrderDispatchPickupLocation(customOrder)
          };
          delete next.dropLocation;
          delete next.drop_location;
          delete next.dropAddress;
          delete next.drop_address;
          delete next.dropoffKey;
          delete next.dropoff_key;
          delete next.destinationLocationId;
          delete next.destination_location_id;
          delete next.lineRowIds;
          delete next.line_row_ids;
          delete next.destinationYard;
          delete next.destination_yard;
          delete next.destinationAddress;
          delete next.destination_address;
          return next;
        }
        const next = {
          ...stop,
          loadId: load.id || "",
          orderId: customOrder.refNumber,
          location: customOrder.dropoffLocation
        };
        delete next.dropLocation;
        delete next.drop_location;
        delete next.dropAddress;
        delete next.drop_address;
        delete next.dropoffKey;
        delete next.dropoff_key;
        delete next.destinationLocationId;
        delete next.destination_location_id;
        delete next.lineRowIds;
        delete next.line_row_ids;
        delete next.destinationYard;
        delete next.destination_yard;
        delete next.destinationAddress;
        delete next.destination_address;
        return next;
      });

      const mappingsInDropOrder = customMappings
        .map((mapping) => ({
          mapping,
          dropIndex: stops.findIndex((stop) =>
            stop?.type === "drop"
            && normalizedRef(stop.orderId) === normalizedRef(mapping.customOrder.refNumber)
          )
        }))
        .filter(({ dropIndex }) => dropIndex >= 0)
        .sort((left, right) => left.dropIndex - right.dropIndex);
      for (const { mapping } of mappingsInDropOrder) {
        const { customOrder } = mapping;
        const customRef = normalizedRef(customOrder.refNumber);
        const pickupLocation = customOrderDispatchPickupLocation(customOrder);
        const drop = stops.find((stop) =>
          stop?.type === "drop" && normalizedRef(stop.orderId) === customRef
        );
        let dropIndex = stops.indexOf(drop);
        const sharedPickupIndex = stops.findIndex((stop, index) =>
          index < dropIndex
          && stop?.type === "pick"
          && normalizedRef(stop.location) === normalizedRef(pickupLocation)
        );
        const ownedPickupIndex = stops.findIndex((stop) =>
          stop?.type === "pick" && normalizedRef(stop.orderId) === customRef
        );
        if (sharedPickupIndex >= 0) {
          if (ownedPickupIndex >= 0 && ownedPickupIndex !== sharedPickupIndex) {
            stops.splice(ownedPickupIndex, 1);
          }
          continue;
        }
        if (ownedPickupIndex >= 0) {
          const [pickup] = stops.splice(ownedPickupIndex, 1);
          dropIndex = stops.indexOf(drop);
          stops.splice(dropIndex, 0, pickup);
          continue;
        }
        const baseId = `${load.id || "load"}-custom-${customOrder.id}-pick`;
        let stopId = baseId;
        let suffix = 1;
        while (stops.some((stop) => String(stop?.id || "") === stopId)) {
          stopId = `${baseId}-${suffix}`;
          suffix += 1;
        }
        stops.splice(dropIndex, 0, {
          id: stopId,
          loadId: load.id || "",
          orderId: customOrder.refNumber,
          type: "pick",
          location: pickupLocation
        });
      }
      return { ...load, stops };
    })
  }));
  return { ...plan, trucks };
}

/**
 * Resolve every Custom Order snapshot through its stable local ID before a plan
 * is validated or persisted. Unassigned stale catalog rows are pruned because
 * Dispatch Planning submits the entire order catalog, not only planned work.
 */
export async function canonicalizeDispatchCustomOrdersInPlan(plan = {}, {
  previousPlan = null,
  lockRows = false
} = {}) {
  const nextOrders = Array.isArray(plan?.orders) ? plan.orders : [];
  const previousOrders = Array.isArray(previousPlan?.orders) ? previousPlan.orders : [];
  const nextStops = planStopRows(plan);
  const previousStops = planStopRows(previousPlan || {});
  const explicitOrders = [...nextOrders, ...previousOrders].filter(isCustomDispatchOrder);
  const candidateIds = [...new Set(
    explicitOrders.map(customOrderStableId).filter((id) => /^\d+$/.test(id))
  )];
  const candidateRefs = [...new Set([
    ...nextOrders.map((order) => order?.id),
    ...previousOrders.map((order) => order?.id),
    ...nextStops.map(({ stop }) => stop?.orderId),
    ...previousStops.map(({ stop }) => stop?.orderId)
  ].map(normalizedRef).filter(Boolean))];

  if (!candidateIds.length && !candidateRefs.length) {
    return {
      ...plan,
      orders: nextOrders.map((order) => isCustomDispatchOrder(order)
        ? canonicalCustomOrderSnapshot({}, order, false)
        : order)
    };
  }

  const result = await query(
    `SELECT custom_order.*,
            active_co.co_ref AS transit_co_ref,
            active_co.from_location AS transit_co_from_yard,
            active_co.to_location AS transit_co_to_yard,
            active_co.status AS transit_co_status
       FROM dispatch_custom_orders custom_order
       LEFT JOIN LATERAL (
         SELECT co.co_ref, co.from_location, co.to_location, co.status
           FROM local_co_orders co
          WHERE co.source_order_ref = custom_order.ref_number
            AND co.status <> 'cancelled'
          ORDER BY co.updated_at DESC, co.id DESC
          LIMIT 1
       ) active_co ON true
      WHERE custom_order.id::text = ANY($1::text[])
         OR lower(btrim(custom_order.ref_number)) = ANY($2::text[])
      ${lockRows ? "FOR UPDATE OF custom_order" : ""}`,
    [candidateIds, candidateRefs]
  );
  const customOrders = await mapCustomOrderRows(result.rows);
  const byId = new Map(customOrders.map((order) => [String(order.id), order]));
  const byRef = new Map(customOrders.map((order) => [normalizedRef(order.refNumber), order]));
  const previousById = new Map(
    previousOrders
      .filter(isCustomDispatchOrder)
      .map((order) => [customOrderStableId(order), order])
      .filter(([id]) => /^\d+$/.test(id))
  );
  const nextMappings = [];
  const prunedIndexes = new Set();
  const claimedIds = new Set();

  for (const [index, order] of nextOrders.entries()) {
    const refMatch = byRef.get(normalizedRef(order?.id));
    if (!isCustomDispatchOrder(order) && !refMatch) continue;
    const submittedStableId = customOrderStableId(order);
    // Older compact/recovery snapshots can retain the immutable Custom Order
    // reference while losing its local ID. The reference is unique in the
    // canonical table, so it is safe to restore that ID before validation.
    // A submitted ID still wins here so the mismatch guards below can reject
    // an attempted ref/ID substitution instead of silently repairing it.
    const stableId = /^\d+$/.test(submittedStableId)
      ? submittedStableId
      : String(refMatch?.id || "");
    const aliases = [order?.id].map(String).filter(Boolean);
    const rawWork = customWorkSignature(plan, aliases);
    if (!/^\d+$/.test(stableId)) {
      if (rawWork.assigned) {
        throw new DispatchCustomOrderPlanError(
          `${order?.id || "Custom Order"} is missing its stable Custom Order ID. Refresh Dispatch Planning and try again.`,
          "DISPATCH_CUSTOM_ORDER_PLAN_ID_REQUIRED",
          { refNumber: String(order?.id || "") }
        );
      }
      prunedIndexes.add(index);
      continue;
    }
    const customOrder = byId.get(stableId);
    const canonicalAliases = [...new Set([...aliases, customOrder?.refNumber].filter(Boolean))];
    const nextWork = customWorkSignature(plan, canonicalAliases);
    if (!customOrder) {
      if (nextWork.assigned) {
        throw new DispatchCustomOrderPlanError(
          `${order?.id || "Custom Order"} no longer exists. Remove it from the load and refresh Dispatch Planning.`,
          "DISPATCH_CUSTOM_ORDER_PLAN_MISSING",
          { customOrderId: stableId, refNumber: String(order?.id || "") }
        );
      }
      prunedIndexes.add(index);
      continue;
    }
    if (normalizedRef(order?.id) !== normalizedRef(customOrder.refNumber)) {
      throw customStopError(
        customOrder,
        `${order?.id || "Custom Order"} does not match Custom Order ${customOrder.refNumber}. Refresh Dispatch Planning and try again.`,
        "DISPATCH_CUSTOM_ORDER_PLAN_ID_MISMATCH"
      );
    }
    if (order?.dispatchRef && normalizedRef(order.dispatchRef) !== normalizedRef(customOrder.refNumber)) {
      throw customStopError(
        customOrder,
        `Dispatch reference ${order.dispatchRef} does not match Custom Order ${customOrder.refNumber}. Refresh Dispatch Planning and try again.`,
        "DISPATCH_CUSTOM_ORDER_PLAN_ID_MISMATCH"
      );
    }
    if (refMatch && String(refMatch.id) !== stableId) {
      throw customStopError(
        customOrder,
        `${order.id} points to a different Custom Order than customOrderId ${stableId}.`,
        "DISPATCH_CUSTOM_ORDER_PLAN_ID_MISMATCH"
      );
    }
    if (nextWork.dropCount > 1) {
      throw customStopError(
        customOrder,
        `${customOrder.refNumber} appears in more than one drop stop. A Custom Order can be assigned only once.`
      );
    }
    if (nextWork.dropCount === 0 && nextWork.stopCount > 0) {
      throw customStopError(
        customOrder,
        `${customOrder.refNumber} has a pickup stop without a matching drop stop. Remove the orphan pickup or assign the Custom Order.`
      );
    }
    if (nextWork.pickupCount > 1 || nextWork.routeCount > 1) {
      throw customStopError(
        customOrder,
        `${customOrder.refNumber} has stops in more than one load or more than one owned pickup stop. A Custom Order must use one load.`
      );
    }
    if (claimedIds.has(stableId)) {
      throw customStopError(
        customOrder,
        `${customOrder.refNumber} appears more than once in the dispatch order snapshot.`
      );
    }
    claimedIds.add(stableId);

    const previousOrder = previousById.get(stableId);
    const previousAliases = [previousOrder?.id, customOrder.refNumber].filter(Boolean);
    const previousWork = customWorkSignature(previousPlan || {}, previousAliases);
    if (customOrder.status === "cancelled") {
      if (nextWork.assigned) {
        throw customStopError(
          customOrder,
          `${customOrder.refNumber} was cancelled before this dispatch plan was saved.`,
          "DISPATCH_CUSTOM_ORDER_PLAN_CANCELLED"
        );
      }
      prunedIndexes.add(index);
      continue;
    }
    if (customOrder.status === "completed") {
      const unchangedExistingWork = Boolean(
        previousOrder
        && previousWork.assigned
        && nextWork.assigned
        && previousWork.signature === nextWork.signature
      );
      if (!unchangedExistingWork) {
        if (nextWork.assigned || previousWork.assigned) {
          throw customStopError(
            customOrder,
            `${customOrder.refNumber} is completed and its existing dispatch work cannot be added, removed, or changed.`,
            "DISPATCH_CUSTOM_ORDER_PLAN_COMPLETED"
          );
        }
        prunedIndexes.add(index);
        continue;
      }
    }

    nextMappings.push({
      index,
      aliases: canonicalAliases,
      assigned: nextWork.assigned,
      customOrder
    });
  }

  const mappedAliases = new Set(nextMappings.flatMap((mapping) =>
    mapping.aliases.map(normalizedRef)
  ));
  for (const { stop } of nextStops) {
    const refKey = normalizedRef(stop?.orderId);
    const customOrder = byRef.get(refKey);
    if (!customOrder || mappedAliases.has(refKey)) continue;
    throw customStopError(
      customOrder,
      `${customOrder.refNumber} is referenced by a load but its matching Custom Order snapshot is missing.`,
      "DISPATCH_CUSTOM_ORDER_PLAN_SNAPSHOT_REQUIRED"
    );
  }

  for (const [stableId, previousOrder] of previousById.entries()) {
    if (claimedIds.has(stableId)) continue;
    const customOrder = byId.get(stableId);
    if (customOrder?.status !== "completed") continue;
    const previousWork = customWorkSignature(previousPlan || {}, [
      previousOrder?.id,
      customOrder.refNumber
    ]);
    if (previousWork.assigned) {
      throw customStopError(
        customOrder,
        `${customOrder.refNumber} is completed and cannot be removed from its existing dispatch plan.`,
        "DISPATCH_CUSTOM_ORDER_PLAN_COMPLETED"
      );
    }
  }

  const canonicalOrders = nextOrders
    .map((order, index) => ({ order, index }))
    .filter(({ index }) => !prunedIndexes.has(index))
    .map(({ order, index }) => {
      const mapping = nextMappings.find((entry) => entry.index === index);
      return mapping
        ? canonicalCustomOrderSnapshot(mapping.customOrder, order, mapping.assigned)
        : order;
    });
  return canonicalizeCustomStops({
    ...plan,
    orders: canonicalOrders
  }, nextMappings);
}
