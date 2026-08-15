import { rollupReconciliationGroup } from "./scm-reconciliation.js";
import { isNetSuiteOrderClosed } from "./netsuite-closed-order-policy.js";

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

export function isNetSuiteSalesOrderFulfilled(order = {}) {
  if (isNetSuiteSalesOrderBilled(order)) return true;
  if (text(order.status ?? order.statusCode).toUpperCase() === "F") return true;
  const label = normalizedStatusLabel(
    order.statusText
      ?? order.status_text
      ?? order.netsuiteStatusText
  );
  return [
    "fulfilled",
    "sales order:fulfilled",
    "pending billing",
    "sales order:pending billing"
  ].includes(label);
}

export function isNetSuiteSalesOrderClosed(order = {}) {
  return isNetSuiteOrderClosed(order);
}

export function deriveSalesOrderReconciliationState({
  lines = [],
  billed = false,
  fulfilledByHeader = false,
  closed = false
} = {}) {
  const progress = (Array.isArray(lines) ? lines : []).map((line) => {
    const ordered = number(line?.quantity);
    const fulfilled = Math.min(
      fulfilledByHeader ? ordered : number(
        line?.cumulativeProgressQuantity
          ?? line?.netsuite_received_qty
          ?? line?.quantityshiprecv
      ),
      ordered
    );
    return { ordered, fulfilled };
  });
  const ordered = progress.reduce((sum, line) => sum + line.ordered, 0);
  const fulfilled = progress.reduce((sum, line) => sum + line.fulfilled, 0);
  const hasProgress = progress.some((line) => line.fulfilled > 0.000001);
  const complete = progress.length > 0
    && progress.every((line) => line.fulfilled + 0.000001 >= line.ordered);
  const fulfillmentStatus = complete
    ? "fulfilled"
    : hasProgress
      ? "partial_fulfilled"
      : "not_fulfilled";
  const applicationStatus = closed
    ? hasProgress ? "Completed" : "Cancelled"
    : billed || complete
      ? "Completed"
      : hasProgress
        ? "Partially Done"
        : "Queued";
  return {
    applicationStatus,
    fulfillmentStatus,
    quantities: {
      ordered,
      fulfilled,
      abandoned: closed ? Math.max(ordered - fulfilled, 0) : 0,
      remaining: closed ? 0 : Math.max(ordered - fulfilled, 0)
    }
  };
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

function directValueRefs(value = {}) {
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
    ...(Array.isArray(value.order_refs) ? value.order_refs : [])
  ].map(normalizedRef).filter(Boolean);
}

function valueRefs(value = {}) {
  if (typeof value === "string" || typeof value === "number") {
    return directValueRefs(value);
  }
  return [
    ...directValueRefs(value),
    ...(Array.isArray(value.groupedOrderRefs) ? value.groupedOrderRefs : []),
    ...(Array.isArray(value.childOrders) ? value.childOrders : [])
  ].map(normalizedRef).filter(Boolean);
}

function referencesFamily(value, family) {
  return valueRefs(value).some((ref) => family.has(ref));
}

function directlyReferencesFamily(value, family) {
  return directValueRefs(value).some((ref) => family.has(ref));
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function salesOrderMemberReconciliationState(order = {}) {
  const reconciliationStatus = text(order.reconciliationStatus).toLowerCase();
  const explicitStatus = text(
    order.reconciliationApplicationStatus
      || order.applicationStatus
      || order.scm?.reconciliationApplicationStatus
  );
  if (
    order.reconciliationBlocked === true
    || ["review", "missing", "error"].includes(reconciliationStatus)
    || explicitStatus === "Reconcile Review"
  ) {
    return { status: "Reconcile Review", reconciliationStatus: "review" };
  }
  if (explicitStatus === "Cancelled") {
    return { status: "Cancelled", reconciliationStatus: "ok" };
  }
  const fulfillmentStatus = text(
    order.fulfillmentStatus
      || order.fulfillment_status
      || order.raw?.fulfillment_status
  ).toLowerCase();
  const statusLabel = normalizedStatusLabel(
    order.netsuiteStatusText
      || order.statusText
      || order.status_text
      || order.raw?.status_text
  );
  if (
    ["partial_fulfilled", "partially_fulfilled", "partial", "partially fulfilled"].includes(fulfillmentStatus)
    || statusLabel.includes("partially fulfilled")
  ) {
    return { status: "Partially Done", reconciliationStatus: "ok" };
  }
  if (
    isNetSuiteSalesOrderBilled(order)
    || explicitStatus === "Billed"
    || ["fulfilled", "shipped", "billed"].includes(fulfillmentStatus)
    || statusLabel === "fulfilled"
    || statusLabel === "sales order:fulfilled"
    || statusLabel.includes("pending billing")
  ) {
    return { status: "Completed", reconciliationStatus: "ok" };
  }
  if (/\b(cancelled|canceled|voided|void)\b/.test(statusLabel)) {
    return { status: "Cancelled", reconciliationStatus: "ok" };
  }
  return { status: explicitStatus || "Queued", reconciliationStatus: "ok" };
}

function groupedSalesOrderTotals(children = [], field) {
  return children.reduce((sum, child) => {
    const value = Number(child?.[field] || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

export function rollupGroupedSalesOrderReconciliation(order = {}, childOrderDetails = []) {
  const children = Array.isArray(childOrderDetails) ? childOrderDetails : [];
  const rollup = rollupReconciliationGroup(children.map(salesOrderMemberReconciliationState));
  const fulfillmentStatus = rollup.applicationStatus === "Completed"
    ? "fulfilled"
    : rollup.applicationStatus === "Partially Done"
      ? "partial_fulfilled"
      : "not_fulfilled";
  const reviewReasons = uniqueValues(children
    .filter((child) => salesOrderMemberReconciliationState(child).reconciliationStatus === "review")
    .map((child) => child.reconciliationReason || child.scm?.reconciliationReason));
  return {
    ...order,
    customer: `${children.length} orders grouped`,
    childOrders: children.map((child) => text(child?.id)).filter(Boolean),
    childOrderDetails: children,
    pallets: groupedSalesOrderTotals(children, "pallets"),
    layers: groupedSalesOrderTotals(children, "layers"),
    sections: groupedSalesOrderTotals(children, "sections"),
    pieces: groupedSalesOrderTotals(children, "pieces"),
    salesQty: groupedSalesOrderTotals(children, "salesQty"),
    weight: groupedSalesOrderTotals(children, "weight"),
    unloadMinutes: groupedSalesOrderTotals(children, "unloadMinutes"),
    travelMinutes: children.reduce((max, child) => Math.max(max, Number(child?.travelMinutes || 0)), 0),
    pickupLocations: uniqueValues(children.flatMap((child) => child?.pickupLocations || [])),
    items: children.flatMap((child) => Array.isArray(child?.items) ? child.items : []),
    fulfillmentStatus,
    reconciliationApplicationStatus: rollup.applicationStatus,
    reconciliationStatus: rollup.reconciliationStatus,
    reconciliationBlocked: rollup.reconciliationStatus === "review",
    reconciliationReason: reviewReasons.join(" "),
    netsuiteActive: children.some((child) => child?.netsuiteActive !== false),
    raw: {
      ...(order.raw && typeof order.raw === "object" ? order.raw : {}),
      fulfillment_status: fulfillmentStatus,
      grouped_sales_order: true
    }
  };
}

function snapshotMapValue(snapshots, ref) {
  const key = normalizedRef(ref);
  if (!key) return null;
  if (snapshots instanceof Map) return snapshots.get(key) || snapshots.get(ref) || null;
  return snapshots?.[key] || snapshots?.[ref] || null;
}

function mergeSalesOrderReconciliationSnapshot(order = {}, snapshot = null) {
  if (!snapshot) return order;
  return {
    ...order,
    ...snapshot,
    id: text(order.id || snapshot.id),
    raw: {
      ...(order.raw && typeof order.raw === "object" ? order.raw : {}),
      ...(snapshot.raw && typeof snapshot.raw === "object" ? snapshot.raw : {})
    }
  };
}

function groupedSalesOrderLeafRefs(order = {}) {
  const refs = [];
  const detailById = new Map((order.childOrderDetails || [])
    .map((child) => [text(child?.id), child])
    .filter(([id]) => id));
  for (const childRef of order.childOrders || []) {
    const ref = text(childRef);
    const detail = detailById.get(ref);
    if (detail?.childOrders?.length) refs.push(...groupedSalesOrderLeafRefs(detail));
    else if (ref) refs.push(ref);
  }
  return uniqueValues(refs);
}

function refreshGroupedSalesOrder(order = {}, snapshots) {
  const detailById = new Map((order.childOrderDetails || [])
    .map((child) => [text(child?.id), child])
    .filter(([id]) => id));
  const children = (order.childOrders || []).map((childRef) => {
    const ref = text(childRef);
    const detail = detailById.get(ref) || { id: ref, type: "SO" };
    if (detail.childOrders?.length) return refreshGroupedSalesOrder(detail, snapshots);
    return mergeSalesOrderReconciliationSnapshot(detail, snapshotMapValue(snapshots, ref));
  }).filter((child) => child?.id);
  return rollupGroupedSalesOrderReconciliation(order, children);
}

export function refreshGroupedSalesOrderReconciliationInPlan(plan = {}, {
  childSnapshots = new Map(),
  targetRefs = []
} = {}) {
  const targets = new Set(targetRefs.map(normalizedRef).filter(Boolean));
  const updatedGroupRefs = [];
  const orders = (Array.isArray(plan.orders) ? plan.orders : []).map((order) => {
    if (text(order?.type).toUpperCase() !== "SO" || !order?.childOrders?.length) return order;
    const leafRefs = groupedSalesOrderLeafRefs(order).map(normalizedRef);
    if (targets.size && !leafRefs.some((ref) => targets.has(ref))) return order;
    const refreshed = refreshGroupedSalesOrder(order, childSnapshots);
    if (JSON.stringify(refreshed) !== JSON.stringify(order)) updatedGroupRefs.push(text(order.id));
    return refreshed;
  });
  const changed = updatedGroupRefs.length > 0;
  return {
    plan: changed ? { ...plan, orders } : plan,
    changed,
    updatedGroupRefs
  };
}

function dissolvedGroupedSalesOrder(order, child) {
  return {
    ...child,
    id: text(child.id),
    type: text(child.type || order.type || "SO").toUpperCase(),
    childOrders: Array.isArray(child.childOrders) ? child.childOrders : [],
    childOrderDetails: Array.isArray(child.childOrderDetails) ? child.childOrderDetails : [],
    groupAliases: uniqueValues([
      ...(child.groupAliases || []),
      order.id,
      ...(order.groupAliases || [])
    ]),
    localDispatchStatus: "planned",
    assigned: order.assigned ?? child.assigned,
    dispatchPlanned: order.dispatchPlanned ?? child.dispatchPlanned ?? true,
    groupPlanId: order.groupPlanId || child.groupPlanId,
    groupPlanDate: order.groupPlanDate || child.groupPlanDate,
    transitCo: child.transitCo || order.transitCo
  };
}

function pruneFamilyFromOrder(order, family) {
  if (typeof order === "string" || typeof order === "number") {
    return family.has(normalizedRef(order)) ? null : order;
  }
  if (!order || typeof order !== "object") return order;
  if (!Array.isArray(order.childOrders) || !order.childOrders.length) {
    return directlyReferencesFamily(order, family) ? null : order;
  }
  if (directlyReferencesFamily(order, family)) return null;
  const detailById = new Map((order.childOrderDetails || [])
    .map((child) => [text(child?.id), child])
    .filter(([id]) => id));
  const containsFamily = order.childOrders.some((childRef) => {
    const ref = text(childRef);
    const detail = detailById.get(ref);
    return family.has(normalizedRef(ref))
      || directlyReferencesFamily(detail || {}, family)
      || (detail?.childOrders?.length && referencesFamily(detail, family));
  });
  if (!containsFamily) return order;
  const children = [];
  for (const childRef of order.childOrders) {
    const ref = text(childRef);
    const detail = detailById.get(ref) || { id: ref, type: order.type || "SO" };
    if (family.has(normalizedRef(ref)) || directlyReferencesFamily(detail, family)) continue;
    const pruned = pruneFamilyFromOrder(detail, family);
    if (pruned && typeof pruned === "object" && pruned.id) children.push(pruned);
  }
  if (!children.length) return null;
  if (children.length === 1) return dissolvedGroupedSalesOrder(order, children[0]);
  return rollupGroupedSalesOrderReconciliation(order, children);
}

function stripFamilyFromLoadOrder(value, family, orderReplacements) {
  if (typeof value === "string" || typeof value === "number") {
    const ref = normalizedRef(value);
    if (family.has(ref)) return null;
    if (orderReplacements.has(ref)) return orderReplacements.get(ref)?.id || null;
    return value;
  }
  if (!value || typeof value !== "object") return value;
  const id = normalizedRef(value.id || value.orderId || value.order_id);
  if (id && orderReplacements.has(id)) return orderReplacements.get(id);
  return pruneFamilyFromOrder(value, family);
}

function rewrittenStop(stop, family, orderReplacements) {
  const rewriteRef = (value) => {
    const ref = normalizedRef(value);
    if (!ref || family.has(ref)) return "";
    if (orderReplacements.has(ref)) return text(orderReplacements.get(ref)?.id);
    return text(value);
  };
  const hadRefs = Array.isArray(stop.orderRefs) || Array.isArray(stop.order_refs);
  const originalRefs = Array.isArray(stop.orderRefs)
    ? stop.orderRefs
    : Array.isArray(stop.order_refs)
      ? stop.order_refs
      : [];
  const refs = uniqueValues(originalRefs.map(rewriteRef));
  const originalOrderId = stop.orderId ?? stop.order_id;
  let orderId = rewriteRef(originalOrderId);
  if (!orderId && refs.length) orderId = refs[0];
  if (!orderId && !refs.length && (originalOrderId || referencesFamily(stop, family))) return null;
  const groupedOrderRefs = Array.isArray(stop.groupedOrderRefs)
    ? uniqueValues(stop.groupedOrderRefs.map(rewriteRef))
    : stop.groupedOrderRefs;
  return {
    ...stop,
    ...(originalOrderId !== undefined ? { orderId } : {}),
    ...(hadRefs ? { orderRefs: refs } : {}),
    ...(Array.isArray(groupedOrderRefs) ? { groupedOrderRefs } : {})
  };
}

function scrubLoad(load = {}, family, orderReplacements) {
  const nextOrders = Array.isArray(load.orders)
    ? load.orders.map((order) => stripFamilyFromLoadOrder(order, family, orderReplacements)).filter(Boolean)
    : load.orders;
  const nextStops = Array.isArray(load.stops)
    ? load.stops
      .map((stop) => rewrittenStop(stop, family, orderReplacements))
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

  const orderReplacements = new Map();
  const orders = [];
  for (const order of Array.isArray(plan.orders) ? plan.orders : []) {
    const pruned = pruneFamilyFromOrder(order, family);
    const originalId = normalizedRef(order?.id || order?.orderId || order?.order_id);
    if (originalId && order?.childOrders?.length && pruned !== order) {
      orderReplacements.set(originalId, pruned && typeof pruned === "object" ? pruned : null);
    }
    if (pruned) orders.push(pruned);
  }
  const trucks = (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck) => ({
    ...truck,
    loads: (Array.isArray(truck.loads) ? truck.loads : []).map((load) => scrubLoad(load, family, orderReplacements))
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
