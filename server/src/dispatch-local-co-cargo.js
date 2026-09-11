/**
 * @typedef {number|string|null} CargoNumber
 * @typedef {{line_id: CargoNumber, item_id: CargoNumber, raw?: Record<string, unknown>,
 * sku?: string, item_name?: string, item_type?: string, item_type_text?: string,
 * item_description?: string, unit?: string, quantity?: CargoNumber, pallet_qty?: CargoNumber,
 * layer_qty?: CargoNumber, section_qty?: CargoNumber, piece_qty?: CargoNumber, item_weight?: CargoNumber}} CargoLine
 */
/**
 * A local CO owns a manifest; its source children are detail, not CO members.
 * @param {Record<string, unknown> & {id?: string, sourceOrderType?: string}} order
 * @param {{cargoLocked?: boolean, coRef?: string, cargoLines?: CargoLine[], details?: {
 * sourceOrderType?: string, childOrderIds?: string[], childOrderDetails?: unknown[]}}} record
 */
export function applyLocalCoCargo(order = {}, record = {}) {
  if (record.cargoLocked || !Array.isArray(record.cargoLines) || !record.cargoLines.length) return order;
  if (String(order.id || "").toLowerCase() !== String(record.coRef || "").toLowerCase()) return order;
  const items = record.cargoLines.map((line) => ({
    // Allocations belong to the source SO, not this CO's independent manifest.
    ...Object.fromEntries(Object.entries(line.raw || {}).filter(([key]) => !key.startsWith("poAllocated"))),
    lineId: Number(line.line_id),
    itemId: line.item_id === null ? null : Number(line.item_id),
    sku: line.sku || line.item_name || "",
    itemName: line.item_name || line.sku || "",
    itemType: line.item_type || "InvtPart",
    itemTypeText: line.item_type_text || "Inventory Item",
    description: line.item_description || "",
    unit: line.unit || "",
    quantity: Number(line.quantity || 0),
    pallets: Number(line.pallet_qty || 0),
    layers: Number(line.layer_qty || 0),
    sections: Number(line.section_qty || 0),
    pieces: Number(line.piece_qty || 0),
    itemWeight: Number(line.item_weight || 0),
    lineWeight: Number(line.quantity || 0) * Number(line.item_weight || 0)
  }));
  /** @param {"pallets"|"layers"|"sections"|"pieces"|"quantity"|"lineWeight"} field */
  const sum = (field) => Number(items.reduce((total, item) => total + Number(item[field] || 0), 0).toFixed(6));
  const details = record.details || {};
  return {
    ...order,
    type: "CO",
    sourceTable: "local_co_orders",
    sourceOrderType: details.sourceOrderType || order.sourceOrderType || "",
    items,
    pallets: sum("pallets"),
    layers: sum("layers"),
    sections: sum("sections"),
    pieces: sum("pieces"),
    salesQty: sum("quantity"),
    weight: sum("lineWeight"),
    ...(Array.isArray(details.childOrderIds) ? { childOrders: structuredClone(details.childOrderIds) } : {}),
    ...(Array.isArray(details.childOrderDetails) ? { childOrderDetails: structuredClone(details.childOrderDetails) } : {}),
    globalGroupDefinition: false,
    isGrouped: false,
    catalogHydrated: true
  };
}
