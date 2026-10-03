import { dependencyQuantityConversionDisplay } from "./order-dependency-quantity.js";

const FIELDS = ["pallets", "layers", "sections", "pieces"];
const DISPLAY_FIELDS = ["palletQty", "layerQty", "sectionQty", "pieceQty"];
const number = value => Math.max(0, Number(value) || 0);
const round = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const itemKey = item => String(item.itemId ?? item.item_id ?? item.sku ?? item.itemName ?? "");

/** Keep source cargo intact; only the unallocated native quantity belongs to the TO route. */
export function projectDirectTransferResidual(order = {}, dependency = {}) {
  if (order.type !== "TO" || dependency.mode !== "direct_to_customer" || dependency.status === "cancelled") {return order;}
  const remaining = new Map();
  for (const line of dependency.lines || []) {
    const key = itemKey(line);
    remaining.set(key, (remaining.get(key) || 0) + number(line.effectiveAllocatedQuantity ?? line.allocatedQuantity));
  }
  const items = (order.items || []).map(item => {
    const key = itemKey(item);
    const total = number(item.quantity ?? item.salesQty);
    const allocated = Math.min(total, remaining.get(key) || 0);
    remaining.set(key, Math.max(0, (remaining.get(key) || 0) - allocated));
    const quantity = round(total - allocated);
    const ratio = total > 0 ? quantity / total : 1;
    const hasConversion = total > 0 && [item.toPlt ?? item.to_plt, item.toLyr ?? item.to_lyr,
      item.toSec ?? item.to_sec, item.toPcs ?? item.to_pcs].some(value => number(value) > 0);
    const display = hasConversion ? dependencyQuantityConversionDisplay(quantity, item) : null;
    return { ...item, quantity, salesQty: quantity,
      ...Object.fromEntries(FIELDS.map((field, index) => [field, display ? display[DISPLAY_FIELDS[index]]
        : round(number(item[field] ?? item[`${field.slice(0, -1)}_qty`]) * ratio)])),
      lineWeight: round(number(item.lineWeight ?? total * number(item.itemWeight)) * ratio) };
  }).filter(item => item.quantity > 0.000001 || FIELDS.some(field => item[field] > 0.000001));
  const totals = Object.fromEntries(FIELDS.map(field => [field, round(items.reduce((sum, item) => sum + item[field], 0))]));
  const salesQty = round(items.reduce((sum, item) => sum + item.quantity, 0));
  const weight = round(items.reduce((sum, item) => sum + item.lineWeight, 0));
  return { ...order, toRouteProjection: { version: 1, hasResidual: items.length > 0,
    targetRefs: [dependency.salesOrderRef], items, ...totals, salesQty, weight,
    dropoffs: items.length ? [{ key: `to:${order.id}`, destinationYard: order.destinationYard || order.address || "",
      destinationLocationId: order.destinationLocationId ?? null, address: order.destinationAddress || order.address || order.destinationYard || "",
      lineRowIds: items.map(item => String(item.lineRowId ?? item.id ?? "")).filter(Boolean), ...totals, salesQty, weight }] : [] } };
}
