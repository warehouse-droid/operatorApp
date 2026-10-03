// @ts-check
import { normalizeOperatorNetSuiteLocationId } from './operator-netsuite-posting-policy.js';
import { operatorYardForbidden } from './operator-yard-access.js';

/** @param {Record<string, any>} order @param {Record<string, any>} line */
function lineYard(order, line) {
  return normalizeOperatorNetSuiteLocationId(order.destination_override)
    ?? normalizeOperatorNetSuiteLocationId(line.location_id ?? order.destination_location_id);
}

/** @param {Record<string, any>} line */
function visibleLine(line) {
  return line.netsuite_active !== false || Boolean(line.sync_exception);
}

/** @param {Record<string, any>} order @returns {number[]} */
export function receivingOrderYards(order) {
  if (order.order_type === 'purchase_order' && Array.isArray(order.receiving_yard_location_ids)) {
    return order.receiving_yard_location_ids;
  }
  const lines = (order.lines || []).filter(visibleLine);
  const locations = order.order_type === 'purchase_order' && lines.length
    ? lines.map((/** @type {Record<string, any>} */ line) => lineYard(order, line))
    : [normalizeOperatorNetSuiteLocationId(order.destination_override)
      ?? normalizeOperatorNetSuiteLocationId(order.destination_location_id)];
  return [...new Set(locations)].filter((/** @type {number|null} */ yard) => yard !== null);
}

/** @param {Record<string, any>} order @param {unknown} locationId
 * @param {{keepAllLines?: boolean}} [options] */
export function scopeReceivingOrderYard(order, locationId, { keepAllLines = false } = {}) {
  const yard = normalizeOperatorNetSuiteLocationId(locationId);
  if (yard === null || !receivingOrderYards(order).includes(yard)) {
    throw operatorYardForbidden();
  }
  if (order.order_type !== 'purchase_order') {return order;}
  const selected = (/** @type {Record<string, any>} */ line) => visibleLine(line) && lineYard(order, line) === yard;
  return {
    ...order,
    destination_location_id: yard,
    destination_location: /** @type {Record<number, string>} */ ({ 1: '3445', 28: '2967', 15: '12441', 26: '150' })[yard],
    lines: keepAllLines ? (order.lines || []).map((/** @type {Record<string, any>} */ line) => line.location_id === null || line.location_id === undefined
      ? { ...line, location_id: lineYard(order, line) } : line) : (order.lines || []).filter(selected),
    ...(order.receivableLines ? { receivableLines: order.receivableLines.filter(selected) } : {})
  };
}
