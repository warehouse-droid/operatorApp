// @ts-check
const PACKED_FIELDS = ['packed_sales_qty', 'packed_pallet_qty', 'packed_layer_qty', 'packed_section_qty', 'packed_piece_qty'];
/** @param {any} value */
function positive(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
/** @param {any} line */
function requiredQuantity(line) {
  if (positive(line.quantity)) return positive(line.quantity);
  const units = [['pallet_qty','to_plt'],['layer_qty','to_lyr'],['section_qty','to_sec'],['piece_qty','to_pcs']];
  if (units.some(([, conversion]) => positive(line[conversion]))) {
    return units.reduce((total, [field, conversion]) => total + positive(line[field]) * positive(line[conversion]), 0);
  }
  return positive(line.piece_qty) || positive(line.section_qty) || positive(line.layer_qty) || positive(line.pallet_qty);
}
/** @param {any} line */
function outstandingLoadLine(line) {
  return ['InvtPart','NonInvtPart'].includes(line.item_type)
    && !/^(?:DELIVERY CHARGE|SALES CREDIT)/i.test(String(line.sku || line.item_name || '').trim())
    && line.netsuite_active !== false && !line.netsuite_closed && !line.sync_exception
    && !line.no_yard_load_required && !line.linked_quantity_blocked
    && requiredQuantity(line) - positive(line.loaded_qty) > 0.000001;
}
/** @param {any} order */
export function deliveryLoadConfirmation(order) {
  const outstanding = (order?.lines || []).filter(outstandingLoadLine);
  const missing = outstanding.filter((/** @type {any} */ line) => !PACKED_FIELDS.some(field => positive(line[field]) > 0));
  return { orderId: String(order?.netsuite_id || ''), orderRef: String(order?.tranid || ''),
    total: outstanding.length, confirmed: outstanding.length - missing.length,
    missing: missing.map((/** @type {any} */ line) => ({ id: String(line.id), sku: String(line.sku || line.item_name || 'Item') })) };
}
/** @param {any} order @returns {string[]} */
export function postingOrderKeys(order) {
  if (!order) return [];
  const id = String(order.netsuite_id || ''), type = String(order.order_type || '');
  const keys = ['customer_pickup', 'delivery_prep'].map(kind => `${kind}:${type}:${id}`);
  const source = { sales_order: 'SO', transfer_order: 'TO' }[type];
  if (source && /^[1-9]\d*$/.test(id)) keys.push(`source:IF:${source}:${id}`);
  return [...new Set([...keys, ...(order.child_orders || []).flatMap(postingOrderKeys)])];
}
