// @ts-check
import { getOutboundLocationHierarchy } from './outbound-location-domain.js';
/** @param {any} item */
const selected = item => item.itemReceive !== false && item.itemreceive !== false && Number(item.quantity) > 0;
/** @param {any} value */
const id = value => Number(value?.id ?? value);
/** @param {any} payload */
export function fulfillmentInventoryLocations(payload) {
  const items = /** @type {any[]} */ (payload?.item?.items || []);
  return [...new Set(items.filter(selected).map(item => id(item.location)))]
    .filter(value => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b);
}

/** @param {any[]} items */
function validateLines(items) {
  const seen = new Set();
  for (const item of items) {
    if (!Number.isSafeInteger(Number(item.orderLine)) || Number(item.orderLine) <= 0 || seen.has(Number(item.orderLine))) {
      throw new Error('A fulfillment requires unique canonical REST order lines.');
    }
    seen.add(Number(item.orderLine));
    if (selected(item) && (!Number.isSafeInteger(id(item.location)) || id(item.location) <= 0)) {
      throw new Error('Every selected fulfillment line requires an exact inventory location.');
    }
  }
}

/** @param {any} payload */
export function splitItemFulfillmentPayload(payload) {
  const items = /** @type {any[]} */ (payload?.item?.items || []);
  validateLines(items);
  if (!/^[A-Za-z0-9_-]+$/.test(String(payload?.externalId || ''))) {throw new Error('A fulfillment external ID is required.');}
  return fulfillmentInventoryLocations(payload).map(locationId => {
    const externalId = `${payload.externalId}-L${locationId}`;
    return {
      locationId, externalId,
      payload: {
        ...payload, externalId, inventoryLocation: { id: String(locationId) },
        item: { ...payload.item, items: items.map(item => {
          if (selected(item) && id(item.location) === locationId) {return { ...item };}
          const { quantity: _quantity, itemreceive: _itemreceive, ...rest } = item;
          return { ...rest, itemReceive: false };
        }) }
      }
    };
  });
}

// Only explicit native validation sentences qualify. A generic USER_ERROR or a
// mention of a location is insufficient; unknown account scripts need review.
const LOCATION_REJECTIONS = [
  /^all (?:fulfilled )?(?:items|lines|line items) must (?:have|use|be (?:fulfilled )?from) the same (?:inventory )?location[.!]?$/i,
  /^you (?:can|may) only fulfill (?:items|lines|an order) from (?:a single|one) (?:inventory )?location(?: at a time)?[.!]?$/i,
  /^an item fulfillment (?:can only contain|cannot contain items from more than) (?:a single|one) (?:inventory )?location[.!]?$/i
];
/** @param {any} error */
export function isMixedLocationRejection(error) {
  if (error?.status !== 400 || error.netsuiteResponseReceived !== true || error.ambiguous === true) {return false;}
  const details = error.netsuiteErrorDetails;
  return Array.isArray(details) && details.length > 0 && details.every(detail =>
    ['USER_ERROR', 'INVALID_FLD_VALUE'].includes(detail?.['o:errorCode'])
      && LOCATION_REJECTIONS.some(pattern => pattern.test(String(detail.detail || '').trim())));
}

/** @param {any} step */
export function fulfillmentTransactions(step) {
  const shared = { transactionType: step.transactionType, sourceOrderKind: step.sourceOrderKind,
    sourceNetSuiteId: step.sourceNetSuiteId, sourceOrderRef: step.sourceOrderRef, stepIndex: step.stepIndex };
  const parts = step.response?.fulfillmentParts;
  const transactions = Array.isArray(parts) && parts.length ? parts.map(part => ({ ...shared, ...part }))
    : [{ ...shared, externalId: step.externalId, transactionId: step.netSuiteTransactionId,
      transactionRef: step.netSuiteTransactionRef, inventoryLocationIds: fulfillmentInventoryLocations(step.payload) }];
  return transactions.map(transaction => ({ ...transaction, inventoryLocationNames: (transaction.inventoryLocationIds || [])
    .map((/** @type {number} */ locationId) => getOutboundLocationHierarchy().nameFor(locationId)) }));
}
