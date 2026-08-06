const EXACT_BILLED_STATUS_CODE = "G";
const INVENTORY_ITEM_TYPES = new Set([
  "assembly",
  "invtpart",
  "inventoryitem",
  "lotnumberedassembly",
  "lotnumberedinventoryitem",
  "serializedassembly",
  "serializedinventoryitem",
  "kit",
  "kitpackage"
]);

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeSalesOrderReconciliationType(value, fallback = "") {
  const normalize = (candidate) => {
    const compact = text(candidate).toLowerCase().replace(/[\s_-]+/g, "");
    if (compact === "delivery") return "delivery";
    if (compact === "pickup") return "pickup";
    if (compact === "all") return "all";
    return "";
  };
  const normalized = normalize(value);
  if (normalized || text(value)) return normalized;
  return normalize(fallback);
}

export function filterDbBackedSalesOrderReconciliationCandidates(
  candidates = [],
  localSources = []
) {
  const localSalesOrderIds = new Set((localSources || [])
    .filter((source) => text(source?.kind).toUpperCase() === "SO")
    .map((source) => positiveId(source?.id))
    .filter(Boolean));
  return (candidates || []).filter((candidate) => {
    if (text(candidate?.kind).toUpperCase() !== "SO") return true;
    const id = positiveId(candidate?.id);
    return Boolean(id && localSalesOrderIds.has(id));
  });
}

function number(value) {
  const parsed = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedStatusLabel(value) {
  return text(value)
    .toLowerCase()
    .replace(/\s*:\s*/g, ":")
    .replace(/\s+/g, " ");
}

export function isNetSuiteSalesOrderBilled(order = {}) {
  if (text(order.status ?? order.statusCode).toUpperCase() === EXACT_BILLED_STATUS_CODE) {
    return true;
  }
  const label = normalizedStatusLabel(
    order.statusText
      ?? order.status_text
      ?? order.netsuiteStatusText
  );
  return label === "billed" || label === "sales order:billed";
}

export function isSalesOrderInventoryLine(line = {}) {
  const itemType = text(line.itemType ?? line.item_type).toLowerCase().replaceAll(" ", "");
  const itemTypeText = text(line.itemTypeText ?? line.item_type_text).toLowerCase();
  if (INVENTORY_ITEM_TYPES.has(itemType)) return true;
  return /(^|\b)(inventory|assembly)(\b|$)/i.test(itemTypeText)
    && !/non[- ]?inventory/i.test(itemTypeText);
}

export function mapNetSuiteSalesOrderLine(line = {}) {
  const lineKey = text(
    line.sourceLineKey
      ?? line.uniquekey
      ?? line.line_unique_key
      ?? line.lineId
      ?? line.line_id
  );
  if (!/^\d+$/.test(lineKey) || Number(lineKey) <= 0) {
    throw Object.assign(
      new Error("NetSuite did not return a safe unique Sales Order line key."),
      { code: "SO_RECONCILIATION_LINE_IDENTITY", status: 409 }
    );
  }
  const quantity = number(line.quantity);
  const unit = text(line.unit);
  return {
    uniquekey: lineKey,
    line_unique_key: lineKey,
    line_id: lineKey,
    item_id: positiveId(line.itemId ?? line.item_id),
    item_name: text(line.itemName ?? line.item_name),
    item_type: text(line.itemType ?? line.item_type),
    item_type_text: text(line.itemTypeText ?? line.item_type_text),
    item_description: text(line.itemDescription ?? line.item_description),
    sku: text(line.sku ?? line.itemName ?? line.item_name),
    quantity,
    netsuite_received_qty: number(
      line.cumulativeProgressQuantity
        ?? line.netsuite_received_qty
        ?? line.quantityshiprecv
    ),
    unit,
    item_weight: line.itemWeight ?? line.item_weight ?? null,
    location_id: positiveId(line.locationId ?? line.location_id),
    location: text(line.location),
    // SO reconciliation intentionally uses the Sales Quantity and Sales UOM
    // as its one canonical quantity pair. NetSuite PLT/LYR/SEC/PCS columns can
    // describe the same physical demand and must not create a second pickup.
    pallet_qty: 0,
    layer_qty: 0,
    piece_qty: 0,
    section_qty: 0,
    to_plt: null,
    to_lyr: null,
    to_sec: null,
    to_pcs: null,
    pack_quantity_source: "sales_only",
    raw: {
      ...(line.raw && typeof line.raw === "object" ? line.raw : {}),
      sourceLineKey: lineKey,
      reconciliationStage: "outbound",
      authoritativeSalesQuantity: quantity,
      authoritativeSalesUom: unit
    }
  };
}

function normalizedRef(value) {
  return text(value).toUpperCase();
}

function valueRefs(value = {}) {
  if (typeof value === "string" || typeof value === "number") {
    return [normalizedRef(value)].filter(Boolean);
  }
  return [
    value.id,
    value.orderId,
    value.order_id,
    value.tranid,
    value.orderRef,
    value.order_ref,
    value.originalOrderId,
    value.original_order_id,
    value.sourceOrderId,
    value.source_order_id,
    ...(Array.isArray(value.orderRefs) ? value.orderRefs : []),
    ...(Array.isArray(value.order_refs) ? value.order_refs : []),
    ...(Array.isArray(value.childOrders) ? value.childOrders : [])
  ].map(normalizedRef).filter(Boolean);
}

function referencesFamily(value, family) {
  return valueRefs(value).some((ref) => family.has(ref));
}

function stripFamilyFromLoadOrder(value, family) {
  if (typeof value === "string" || typeof value === "number") {
    return family.has(normalizedRef(value)) ? null : value;
  }
  if (!value || typeof value !== "object") return value;
  if (referencesFamily(value, family)) return null;
  return value;
}

function scrubLoad(load = {}, family) {
  const nextOrders = Array.isArray(load.orders)
    ? load.orders.map((order) => stripFamilyFromLoadOrder(order, family)).filter(Boolean)
    : load.orders;
  const nextStops = Array.isArray(load.stops)
    ? load.stops
      .map((stop) => {
        if (!referencesFamily(stop, family)) return stop;
        const refs = (Array.isArray(stop.orderRefs) ? stop.orderRefs : [])
          .filter((ref) => !family.has(normalizedRef(ref)));
        if (refs.length) return { ...stop, orderRefs: refs, orderId: refs[0] };
        return null;
      })
      .filter(Boolean)
    : load.stops;
  return {
    ...load,
    ...(Array.isArray(load.orders) ? { orders: nextOrders } : {}),
    ...(Array.isArray(load.stops) ? { stops: nextStops } : {})
  };
}

export function scrubBilledSalesOrderFamilyFromPlan(plan = {}, {
  canonicalRef = "",
  familyRefs = [],
  inProgressOrderRefs = []
} = {}) {
  const family = new Set([canonicalRef, ...(familyRefs || [])].map(normalizedRef).filter(Boolean));
  const active = new Set((inProgressOrderRefs || []).map(normalizedRef).filter(Boolean));
  if ([...family].some((ref) => active.has(ref))) {
    return { plan, changed: false, deferred: true, removedOrderRefs: [] };
  }
  if (!family.size) return { plan, changed: false, deferred: false, removedOrderRefs: [] };

  const orders = (Array.isArray(plan.orders) ? plan.orders : [])
    .filter((order) => !referencesFamily(order, family));
  const trucks = (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck) => ({
    ...truck,
    loads: (Array.isArray(truck.loads) ? truck.loads : []).map((load) => scrubLoad(load, family))
  }));
  const changed = JSON.stringify(orders) !== JSON.stringify(plan.orders || [])
    || JSON.stringify(trucks) !== JSON.stringify(plan.trucks || []);
  return {
    plan: changed ? {
      ...plan,
      orders,
      trucks,
      summary: {
        ...(plan.summary || {}),
        billedSalesOrderCleanup: {
          canonicalRef: normalizedRef(canonicalRef),
          removedOrderRefs: [...family],
          cleanedAt: new Date().toISOString()
        }
      }
    } : plan,
    changed,
    deferred: false,
    removedOrderRefs: changed ? [...family] : []
  };
}
