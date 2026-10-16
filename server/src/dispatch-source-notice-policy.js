// @ts-check
import { isDeepStrictEqual } from 'node:util';

/** @param {any} value */
const text = value => String(value ?? '').trim();
/** @param {any} value */
const number = value => Number(text(value).replaceAll(',', '') || 0);
/** @type {Record<string, string[]>} */
const nativeFields = {
  quantity: ['quantity'], unit: ['unit'], itemId: ['item_id'],
  calculated_item_pallets: ['pallet_qty'], layers: ['layer_qty'], sections: ['section_qty'], pieces: ['piece_qty'],
  destinationLocationId: ['destination_location_id'], destinationYard: ['destination_location'], toLocation: ['destination_location'],
  sourceYard: ['outbound_location', 'source_location', 'vendor'], address: ['dispatch_address'], destinationAddress: ['dispatch_address']
};
const lineFields = new Set(['quantity', 'unit', 'itemId', 'item_added', 'item_removed']);
const totals = new Set(['salesQty', 'calculated_pallets', 'calculated_item_pallets', 'layers', 'sections', 'pieces', 'committedQty']);

/** @param {any} source @param {any} payload */
function receiptCargoMatches(source, payload) {
  if (!Array.isArray(payload.lines)) { return false; }
  const location = text(payload.sourceLocationId ?? payload.locationId);
  const rows = (/** @type {any[]} */ items, webhook = false) => items.filter(item => !webhook || source.type !== 'TO'
    || !location || !text(item.locationId ?? item.location_id) || text(item.locationId ?? item.location_id) === location)
    .map(item => {
      const processed = webhook ? number(source.type === 'PO'
        ? item.quantityReceived ?? item.quantityShipRecv
        : item.quantityFulfilled ?? item.quantityShipRecv) : 0;
      return { id: text(webhook ? item.lineUniqueKey ?? item.line_unique_key ?? item.uniqueKey ?? item.uniquekey ?? item.line_id ?? item.lineId : item.lineId ?? item.line_id),
        item: text(item.itemId ?? item.item_id), quantity: Math.max(Math.abs(number(item.quantity)) - processed, 0), unit: text(item.unit ?? item.unitText) };
    }).filter(item => item.quantity > 0).sort((a, b) => a.id.localeCompare(b.id));
  const current = rows(source.items || []);
  return current.length > 0 && isDeepStrictEqual(current, rows(payload.lines, true));
}

/** @param {any} source @param {any[]} audits @param {any} change */
function auditProvesChange(source, audits, change) {
  const matching = audits.filter(audit => audit.source === 'netsuite' && audit.actor_type === 'system'
    && /^netsuite\.(?:order|line|receiving_order|receiving_line)\.update$/u.test(audit.action)
    && text(audit.order_id) === text(source.netsuiteId)
    && (change.lineId ? text(audit.line_id) === text(change.lineId) : audit.line_id == null));
  return (nativeFields[change.field] || []).some(field => {
    const value = (/** @type {any} */ candidate) => typeof change.before === 'number' || typeof change.after === 'number'
      ? String(number(candidate)) : text(candidate);
    const reachable = new Set([value(change.before)]);
    for (const audit of matching) {
      const values = audit.details?.changes?.[field];
      if (values && reachable.has(value(values.before))) { reachable.add(value(values.after)); }
    }
    return value(change.before) !== value(change.after) && reachable.has(value(change.after));
  });
}

/**
 * Project only changes attributable to NetSuite. Review records and execution
 * reconciliation retain their full diffs independently of this display policy.
 * @param {any} input
 * @returns {any[]}
 */
export function dispatchSourceNoticeChanges({ source = {}, beforeOrder = {}, changes = [], receipt = null, audits = [] } = {}) {
  if (!['SO', 'PO', 'TO'].includes(source.type)) { return []; }
  const payload = receipt?.payload || {};
  const received = receipt?.status === 'succeeded' && Boolean(receipt.completed_at)
    && (!payload.id || text(payload.id) === text(source.netsuiteId));
  const cargo = received && receiptCargoMatches(source, payload);
  const audited = (/** @type {any} */ change) => auditProvesChange(source, audits, change);
  const provenLines = changes.filter((/** @type {any} */ change) => lineFields.has(change.field) && (cargo || audited(change)));
  const destination = changes.some((/** @type {any} */ change) => change.field === 'destinationLocationId' && (audited(change)
    || (received && number(change.after) === number(payload.destinationLocationId ?? payload.transferLocationId ?? (source.type === 'PO' ? payload.locationId : null)))));
  const pickup = changes.some((/** @type {any} */ change) => change.field === 'sourceYard' && !source.transitCo
    && text(source.raw?.pickup_location) !== text(beforeOrder.raw?.pickup_location)
    && text(change.after) === text(source.raw?.pickup_location)
    && (audited(change) || (received && text(change.after) === text(source.type === 'PO'
      ? payload.sourceLocationText ?? payload.entityText : payload.sourceLocationText ?? payload.locationText))));
  return changes.filter((/** @type {any} */ change) => {
    if (lineFields.has(change.field)) { return provenLines.includes(change); }
    if (change.field === 'weight') { return false; }
    if (totals.has(change.field)) { return audited(change) || cargo && provenLines.length > 0; }
    if (change.field === 'sourceYard') { return pickup || !source.transitCo && audited(change); }
    if (change.field === 'sourceAddress') { return pickup && !source.pickupAddressOverride; }
    if (change.field === 'pickupLocations') {
      return pickup && isDeepStrictEqual(change.after, [source.raw?.pickup_location]);
    }
    if (['destinationLocationId', 'destinationYard', 'toLocation'].includes(change.field)) { return destination || audited(change); }
    if (['address', 'destinationAddress', 'dropAddress'].includes(change.field)) {
      return !source.deliveryAddressOverride && (audited(change) || destination
        || received && text(change.after) !== '' && text(change.after) === text(payload.shippingAddress ?? payload.shipAddress));
    }
    return false;
  });
}
