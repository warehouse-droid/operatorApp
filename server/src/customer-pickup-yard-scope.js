// @ts-check
import { outboundYardLocationId } from './outbound-location-domain.js';
import { operatorYardForbidden } from './operator-yard-access.js';
import { deliveryLoadConfirmation } from './operator-load-state.js';

/** @param {Record<string, any>} order @param {Record<string, any>} line */
function lineLocation(order, line) {
  return line.location_id ?? line.location?.id ?? order.outbound_location_id ?? order.source_location_id;
}

/** @param {Record<string, any>} line */
function activePhysicalLine(line) {
  return line.netsuite_active !== false && (!line.item_type || ['InvtPart', 'NonInvtPart'].includes(line.item_type));
}

/** @param {unknown} location */
function requiredYard(location) {
  const yard = outboundYardLocationId(location);
  if (!yard) {
    throw Object.assign(new Error('The pickup inventory location has no active supported parent yard.'), {
      status: 409, code: 'OUTBOUND_LOCATION_UNSUPPORTED'
    });
  }
  return yard;
}

/** @param {Record<string, any>} order @returns {number[]} */
export function customerPickupOrderYards(order) {
  const header = requiredYard(order.outbound_location_id ?? order.source_location_id);
  const lines = (order.lines || []).filter(activePhysicalLine);
  const yards = [...new Set(lines.map((/** @type {Record<string, any>} */ line) => requiredYard(lineLocation(order, line))))];
  // Preserve the stored header's authority when a single-yard order is moved.
  // Multiple-yard pickups require an actual line in the selected yard.
  if (yards.length && !yards.includes(header)) { throw operatorYardForbidden(); }
  return yards.length ? yards.sort((a, b) => a - b) : [header];
}

/** @param {Record<string, any>} order @param {unknown} locationId */
export function scopeCustomerPickupOrderYard(order, locationId) {
  const yard = outboundYardLocationId(locationId);
  if (yard === null || !customerPickupOrderYards(order).includes(yard)) { throw operatorYardForbidden(); }
  const scoped = {
    ...order,
    pickup_location_id: yard,
    lines: (order.lines || []).filter((/** @type {Record<string, any>} */ line) =>
      outboundYardLocationId(lineLocation(order, line)) === yard)
  };
  return { ...scoped, ...(order.confirmationSummary ? { confirmationSummary: deliveryLoadConfirmation(scoped) } : {}) };
}
