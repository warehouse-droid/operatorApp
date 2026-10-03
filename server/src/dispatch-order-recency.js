// Arrival recency is independent of logistics update activity.
/** @param {unknown} value */
function validInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T| )/u.test(candidate)) return null;
  const day = candidate.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return null;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** @param {Record<string, any>} order @param {Set<object>} seen @returns {string | null} */
export function dispatchOrderSourceDate(order = {}, seen = new Set()) {
  if (!order || seen.has(order)) return null;
  seen.add(order);
  const own = [order.sourceOrderDate, order.tranDate, order.raw?.source_order_date,
    order.raw?.trandate, order.createdAt, order.created_at, order.raw?.created_at]
    .map(validInstant).find(Boolean) || null;
  const localCo = order.type === "CO" && order.sourceTable === "local_co_orders" && order.sourceOrderId;
  if (localCo) return own;
  const children = (Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [])
    .map(child => dispatchOrderSourceDate(child, seen)).filter(Boolean);
  return children.length ? children.sort().at(-1) || null : own;
}

/** @param {Record<string, any>} order @param {Set<object>} seen @returns {string | null} */
export function dispatchOrderFirstSeenAt(order = {}, seen = new Set()) {
  if (!order || seen.has(order)) return null;
  seen.add(order);
  const own = [order.firstSeenAt, order.raw?.first_seen_at,
    order.createdAt, order.created_at, order.raw?.created_at]
    .map(validInstant).find(Boolean) || null;
  const localCo = order.type === "CO" && order.sourceTable === "local_co_orders" && order.sourceOrderId;
  if (localCo) return own;
  const children = (Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [])
    .map(child => dispatchOrderFirstSeenAt(child, seen)).filter(Boolean);
  return children.length ? children.sort().at(-1) || null : own;
}

/** @param {Record<string, any>} order */
export function dispatchOrderRecency(order = {}) {
  const arrival = dispatchOrderFirstSeenAt(order);
  if (arrival) return arrival;
  const original = dispatchOrderSourceDate(order);
  if (original) return original;
  return validInstant(order.updatedAt || order.updated_at || order.syncedAt
    || order.synced_at || order.scm?.updatedAt) || new Date(0).toISOString();
}
