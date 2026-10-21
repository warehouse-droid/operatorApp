export const ORDER_PACK_FIELDS = Object.freeze({ palletQty: 'custcol_plt', layerQty: 'custcol_lyr', sectionQty: 'custcol_sec', pieceQty: 'custcol_pcs' });

/** Empty and zero pack counts represent an unspecified quantity.
 * @param {unknown} value @returns {number|null} */
export function normalizePackQuantity(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1_000_000_000) {
    throw Object.assign(new Error('PLT, LYR, SEC and PCS must be non-negative numbers up to 1000000000.'), { status: 400, code: 'SPECIAL_PACK_QUANTITY_INVALID' });
  }
  return Number(value) === 0 ? null : Number(value);
}

/** @param {Record<string,unknown>} line */
export function normalizePackQuantities(line) {
  return Object.fromEntries(Object.keys(ORDER_PACK_FIELDS).map(field => [field, normalizePackQuantity(line[field])]));
}

/** Normalize only SO packing columns; preserve the caller's payload and prices.
 * @param {any} payload @returns {any} */
export function normalizeSalesOrderPackPayload(payload) {
  if (!Array.isArray(payload?.item?.items)) return payload;
  return { ...payload, item: { ...payload.item, items: payload.item.items.map(/** @param {Record<string,unknown>} line */ line => ({
    ...line, ...Object.fromEntries(Object.values(ORDER_PACK_FIELDS).map(field => [field, normalizePackQuantity(line[field])]))
  })) } };
}
