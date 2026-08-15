function text(value) {
  return String(value ?? "").trim();
}

function normalizedStatusLabel(value) {
  return text(value)
    .replace(/\s*:\s*/g, ":")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function normalizeNetSuiteOrderRefs(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => text(value).toUpperCase())
    .filter(Boolean))];
}

function operationalOrderIdentityRefs(value = {}) {
  if (typeof value === "string" || typeof value === "number") {
    return normalizeNetSuiteOrderRefs([value]);
  }
  if (!value || typeof value !== "object") return [];
  return normalizeNetSuiteOrderRefs([
    value.id,
    value.orderId,
    value.order_id,
    value.orderRef,
    value.order_ref,
    value.tranid,
    value.refNumber,
    value.originalOrderId,
    value.original_order_id,
    value.sourceOrderId,
    value.source_order_id,
    value.sourceOrderRef,
    value.source_order_ref
  ]);
}

function directOperationalOrderRefs(value = {}) {
  if (!value || typeof value !== "object") return operationalOrderIdentityRefs(value);
  return normalizeNetSuiteOrderRefs([
    ...operationalOrderIdentityRefs(value),
    ...(Array.isArray(value.orderRefs) ? value.orderRefs : []),
    ...(Array.isArray(value.order_refs) ? value.order_refs : [])
  ]);
}

export function operationalPlanOrderRefs(plan = {}) {
  const refs = new Set();
  const addValue = (value) => {
    for (const ref of directOperationalOrderRefs(value)) refs.add(ref);
    if (!value || typeof value !== "object") return;
    for (const ref of normalizeNetSuiteOrderRefs([
      ...(Array.isArray(value.childOrders) ? value.childOrders : []),
      ...(Array.isArray(value.groupedOrderRefs) ? value.groupedOrderRefs : [])
    ])) refs.add(ref);
    for (const child of value.childOrderDetails || []) addValue(child);
  };
  for (const order of plan.orders || []) addValue(order);
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      for (const order of load.orders || []) addValue(order);
      for (const stop of load.stops || []) addValue(stop);
    }
  }
  return [...refs];
}

function directlyReferencesRemovedOrder(value, removed) {
  return operationalOrderIdentityRefs(value).some((ref) => removed.has(ref));
}

function pruneOperationalOrder(value, removed) {
  if (typeof value === "string" || typeof value === "number") {
    return removed.has(text(value).toUpperCase()) ? null : value;
  }
  if (!value || typeof value !== "object") return value;
  if (directlyReferencesRemovedOrder(value, removed)) return null;

  const hadChildren = Array.isArray(value.childOrders) && value.childOrders.length > 0;
  const childDetails = (Array.isArray(value.childOrderDetails) ? value.childOrderDetails : [])
    .map((child) => pruneOperationalOrder(child, removed))
    .filter(Boolean);
  const originalChildDetailRefs = new Set((Array.isArray(value.childOrderDetails) ? value.childOrderDetails : [])
    .map((child) => text(child?.id).toUpperCase())
    .filter(Boolean));
  const childByRef = new Map(childDetails
    .map((child) => [text(child?.id).toUpperCase(), child])
    .filter(([ref]) => ref));
  const childOrders = (Array.isArray(value.childOrders) ? value.childOrders : [])
    .map((childRef) => {
      const ref = text(childRef).toUpperCase();
      if (!ref || removed.has(ref)) return null;
      const child = childByRef.get(ref);
      if (originalChildDetailRefs.has(ref) && !child) return null;
      return child?.id || childRef;
    })
    .filter(Boolean);
  if (hadChildren && !childOrders.length) return null;

  return {
    ...value,
    ...(Array.isArray(value.childOrders) ? { childOrders } : {}),
    ...(Array.isArray(value.childOrderDetails)
      ? { childOrderDetails: childDetails.filter((child) => childOrders.some((ref) => text(ref).toUpperCase() === text(child?.id).toUpperCase())) }
      : {}),
    ...(Array.isArray(value.groupedOrderRefs)
      ? { groupedOrderRefs: value.groupedOrderRefs.filter((ref) => !removed.has(text(ref).toUpperCase())) }
      : {}),
    ...(Array.isArray(value.orderRefs)
      ? { orderRefs: value.orderRefs.filter((ref) => !removed.has(text(ref).toUpperCase())) }
      : {}),
    ...(Array.isArray(value.order_refs)
      ? { order_refs: value.order_refs.filter((ref) => !removed.has(text(ref).toUpperCase())) }
      : {})
  };
}

function pruneOperationalStop(stop, removed, removedTopLevelRefs) {
  if (!stop || typeof stop !== "object") return stop;
  const blockedRefs = new Set([...removed, ...removedTopLevelRefs]);
  const originalOrderId = stop.orderId ?? stop.order_id ?? stop.orderRef ?? stop.order_ref;
  const orderId = text(originalOrderId).toUpperCase();
  const refs = (Array.isArray(stop.orderRefs)
    ? stop.orderRefs
    : Array.isArray(stop.order_refs)
      ? stop.order_refs
      : [])
    .filter((ref) => !blockedRefs.has(text(ref).toUpperCase()));
  const directOrderRemoved = orderId && (removed.has(orderId) || removedTopLevelRefs.has(orderId));
  if (directOrderRemoved && !refs.length) return null;
  const replacementOrderId = directOrderRemoved ? text(refs[0]) : text(originalOrderId);
  return {
    ...stop,
    ...(originalOrderId !== undefined ? { orderId: replacementOrderId } : {}),
    ...(Array.isArray(stop.orderRefs) || Array.isArray(stop.order_refs) ? { orderRefs: refs } : {}),
    ...(Array.isArray(stop.groupedOrderRefs)
      ? { groupedOrderRefs: stop.groupedOrderRefs.filter((ref) => !blockedRefs.has(text(ref).toUpperCase())) }
      : {})
  };
}

export function scrubOrderRefsFromOperationalPlan(plan = {}, {
  orderRefs = [],
  cleanedAt = new Date().toISOString()
} = {}) {
  const removed = new Set(normalizeNetSuiteOrderRefs(orderRefs));
  if (!removed.size) return { plan, changed: false, removedOrderRefs: [] };

  const originalOrders = Array.isArray(plan.orders) ? plan.orders : [];
  const orders = originalOrders.map((order) => pruneOperationalOrder(order, removed)).filter(Boolean);
  const retainedTopLevelRefs = new Set(orders
    .flatMap((order) => directOperationalOrderRefs(order)));
  const removedTopLevelRefs = new Set(originalOrders
    .flatMap((order) => directOperationalOrderRefs(order))
    .filter((ref) => !retainedTopLevelRefs.has(ref)));
  const removedLoadOrderRefs = new Set([...removed, ...removedTopLevelRefs]);
  const trucks = (Array.isArray(plan.trucks) ? plan.trucks : []).map((truck) => ({
    ...truck,
    loads: (Array.isArray(truck.loads) ? truck.loads : []).map((load) => ({
      ...load,
      ...(Array.isArray(load.orders)
        ? { orders: load.orders.map((order) => pruneOperationalOrder(order, removedLoadOrderRefs)).filter(Boolean) }
        : {}),
      ...(Array.isArray(load.stops)
        ? { stops: load.stops.map((stop) => pruneOperationalStop(stop, removed, removedTopLevelRefs)).filter(Boolean) }
        : {})
    }))
  }));
  const changed = JSON.stringify(orders) !== JSON.stringify(originalOrders)
    || JSON.stringify(trucks) !== JSON.stringify(plan.trucks || []);
  return {
    plan: changed ? {
      ...plan,
      orders,
      trucks,
      summary: {
        ...(plan.summary || {}),
        closedNetSuiteOrderCleanup: {
          removedOrderCount: removed.size,
          cleanedAt
        }
      }
    } : plan,
    changed,
    removedOrderRefs: changed ? [...removed] : []
  };
}

export function isNetSuiteOrderClosed(order = {}) {
  if (text(order.status ?? order.statusCode).toUpperCase() === "H") return true;
  return [
    "CLOSED",
    "SALES ORDER:CLOSED",
    "PURCHASE ORDER:CLOSED",
    "TRANSFER ORDER:CLOSED"
  ].includes(normalizedStatusLabel(
    order.statusText
      ?? order.status_text
      ?? order.netsuiteStatusText
  ));
}

export function exactNetSuiteClosedSql(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(alias || ""))) {
    throw new TypeError("A safe SQL table alias is required.");
  }
  return `(
    UPPER(BTRIM(COALESCE(${alias}.status, ''))) = 'H'
    OR UPPER(REGEXP_REPLACE(
         REGEXP_REPLACE(BTRIM(COALESCE(${alias}.status_text, '')), '\\s*:\\s*', ':', 'g'),
         '\\s+', ' ', 'g'
       )) IN (
         'CLOSED',
         'SALES ORDER:CLOSED',
         'PURCHASE ORDER:CLOSED',
         'TRANSFER ORDER:CLOSED'
       )
  )`;
}

export function netSuiteClosedOrderFamilySql(alias, kind) {
  const orderKind = text(kind).toUpperCase();
  const definitions = {
    SO: {
      ledger: "dispatch_scm_so_splits",
      table: "sales_orders",
      sourceId: "source_so_id",
      splitId: "split_so_id"
    },
    PO: {
      ledger: "dispatch_scm_po_splits",
      table: "purchase_orders",
      sourceId: "source_po_id",
      splitId: "split_po_id"
    },
    TO: {
      ledger: "dispatch_scm_to_splits",
      table: "transfer_orders",
      sourceId: "source_to_id",
      splitId: "split_to_id"
    }
  };
  const definition = definitions[orderKind];
  if (!definition) throw new TypeError("SO, PO, or TO is required for a Closed-order family predicate.");
  // exactNetSuiteClosedSql validates aliases before any identifier is interpolated.
  exactNetSuiteClosedSql(alias);
  return `(
    ${exactNetSuiteClosedSql(alias)}
    OR EXISTS (
      SELECT 1
        FROM ${definition.ledger} closed_family
        JOIN ${definition.table} closed_source
          ON closed_source.netsuite_id = closed_family.${definition.sourceId}
       WHERE (
         closed_family.${definition.sourceId} = ${alias}.netsuite_id
         OR closed_family.${definition.splitId} = ${alias}.netsuite_id
       )
         AND ${exactNetSuiteClosedSql("closed_source")}
    )
    OR EXISTS (
      SELECT 1
        FROM ${definition.ledger} closed_family
        JOIN ${definition.ledger} closed_membership
          ON closed_membership.${definition.sourceId} = closed_family.${definition.sourceId}
        JOIN ${definition.table} closed_split
          ON closed_split.netsuite_id = closed_membership.${definition.splitId}
       WHERE (
         closed_family.${definition.sourceId} = ${alias}.netsuite_id
         OR closed_family.${definition.splitId} = ${alias}.netsuite_id
       )
         AND ${exactNetSuiteClosedSql("closed_split")}
    )
  )`;
}
