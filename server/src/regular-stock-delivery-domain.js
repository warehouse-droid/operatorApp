// @ts-check
import {STOCK_REQUEST_YARDS,STOCK_REQUEST_MAX_QUANTITY} from './stock-request-domain.js';
import {regularError} from './regular-stock-domain.js';
/** @typedef {import('./regular-stock-domain.js').MaterialLine & {backorderedQuantity:number|null,itemName?:string}} DeliveryLine */
/** @typedef {Omit<import('./regular-stock-domain.js').SalesOrder,'lines'> & {lines:DeliveryLine[]}} DeliveryOrder */

/** @param {unknown} value */
function yard(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value).trim())) return undefined;
  return STOCK_REQUEST_YARDS.find(entry => entry.locationId === Number(value));
}

/** @param {unknown} source @param {unknown} destination */
export function deliveryRoute(source, destination) {
  const from = yard(source), to = yard(destination);
  if (!from || !to || from.locationId === to.locationId) {
    throw regularError('Choose different supported Base Yard and Target Yard values.', 'REGULAR_DELIVERY_ROUTE_INVALID', 400);
  }
  return {sourceLocationId:from.locationId,sourceName:from.yardCode,destinationLocationId:to.locationId,destinationName:to.yardCode,
    automatic:(from.locationId === 1 && to.locationId === 28) || (from.locationId === 28 && to.locationId === 1)};
}

/** @param {DeliveryOrder} order */
export function deliveryBaseYard(order) {
  const locations = new Set(order?.lines?.filter(line => !line.ancillary).map(line => line.locationId));
  const base = yard([...locations][0]);
  if (locations.size !== 1 || !base) throw regularError('All SO material line locations must match one supported Base Yard.', 'REGULAR_SO_MISMATCH');
  return base;
}

/** @param {DeliveryOrder} order @param {number} destination */
export function deliveryMaterials(order, destination) {
  const lines = order?.lines?.filter(line => !line.ancillary) || [];
  for (const line of lines.filter(line => line.itemType === 'Kit')) {
    if (line.backorderedQuantity !== 0 || !line.kitComponents?.length
        || line.kitComponents.some(component => ['InvtPart','Assembly'].includes(component.itemType)
          && component.backorderedQuantity !== 0)) {
      throw regularError(`Kit ${line.itemName || line.itemId} needs component replenishment review before a Delivery transfer can be created.`, 'REGULAR_DELIVERY_KIT_BACKORDER');
    }
  }
  if (!Number.isSafeInteger(order?.id) || Number(order.id) <= 0 || !lines.length || lines.length > 100
      || new Set(lines.map(line => line.remoteLineId)).size !== lines.length
      || lines.some(line => !Number.isSafeInteger(line.remoteLineId) || line.remoteLineId <= 0
        || !Number.isSafeInteger(line.itemId) || line.itemId <= 0 || line.locationId !== destination
        || typeof line.backorderedQuantity !== 'number' || !Number.isFinite(line.backorderedQuantity)
        || line.backorderedQuantity < 0 || line.backorderedQuantity > line.quantity
        || (line.backorderedQuantity > 0 && line.open !== true)
        || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > STOCK_REQUEST_MAX_QUANTITY
        || (line.itemType !== 'Kit' && !String(line.uom || '').trim()))) {
    throw regularError('SO material lines must match Base Yard and have valid quantities, backorders and units. Backordered lines must be open and unfulfilled.', 'REGULAR_SO_MISMATCH');
  }
  const selected = lines.filter(line => Number(line.backorderedQuantity) > 0);
  if (!selected.length) throw regularError('This SO has no backordered material lines at Base Yard. No transfer is needed.', 'REGULAR_DELIVERY_NO_BACKORDER');
  return selected;
}

/** @param {DeliveryLine[]} materials @param {{itemId:number,requestableAvailable:number}[]} availability */
export function deliveryQuantities(materials, availability) {
  const remaining = new Map(availability.map(row => [row.itemId,row.requestableAvailable]));
  const minimums = new Map();
  for (const line of materials) minimums.set(line.itemId,(minimums.get(line.itemId)||0)+Number(line.backorderedQuantity));
  for (const [itemId,minimum] of minimums) {
    const available = remaining.get(itemId);
    if (available === undefined || !Number.isFinite(available) || available < minimum) {
      const item = materials.find(line=>line.itemId===itemId);
      throw regularError(`Target Yard shortage for ${item?.itemName || itemId}: ${minimum} ${item?.uom || 'units'} backordered; ${available ?? 0} available.`, 'REGULAR_DELIVERY_STOCK_SHORTAGE');
    }
    remaining.set(itemId,available-minimum);
  }
  // Preserve enough stock for every selected line's backorder before upgrading
  // individual lines to their full SO quantity, in SO line order.
  return materials.map(line => {
    const extra = line.quantity-Number(line.backorderedQuantity);
    const full = Number(remaining.get(line.itemId)) >= extra;
    if (full) remaining.set(line.itemId,Number(remaining.get(line.itemId))-extra);
    return {...line,soQuantity:line.quantity,quantity:full?line.quantity:Number(line.backorderedQuantity),quantityBasis:full?'whole_line':'backorder'};
  });
}
